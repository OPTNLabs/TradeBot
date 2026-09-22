#!/usr/bin/env node
// src/dashboard/server.mjs
//
// Read-only HTTP backend for the TradeBot dashboard (T16).
//
// Three views live on top of this server:
//
//   - DASHBOARD  → historical performance, P&L charts, win rate, fees
//                  paid, balance over time.
//   - PORTFOLIO  → current open positions + the ENTRY REASONING /
//                  strategy rationale the bot stamped at open time.
//   - SETTINGS   → every knob that influences the bot.
//
// The server is intentionally:
//
//   - **Read-only by default.** The only write endpoints are
//     `PUT /api/config` and `POST /api/risk/reset`. Both are gated
//     by `cfg.dashboard.api_token` (a `user.json`-only knob). If
//     the token is unset, the write endpoints refuse with HTTP 503
//     "auth not configured" rather than 401 — surfacing the misconfig
//     instead of pretending the dashboard is locked.
//
//   - **Zero new dependencies.** Built on Node 20's `node:http`
//     module only. Routing, JSON parsing, and bearer-token auth are
//     implemented inline (~250 lines). The test suite uses
//     `supertest` (already in devDependencies) to drive an in-process
//     handler.
//
//   - **All knobs read from `cfg`.** Bind host/port, CORS origin,
//     request timeout, log level, max events returned, default
//     ranges — every behavioural knob lives in `config/default.json`
//     (or `config/user.json` for the `api_token` override).
//
//   - **WIF never crosses the boundary.** `redactConfig()` walks the
//     effective config and replaces every `wif` / `mnemonic` / `xprv` /
//     `seed` field with `'[REDACTED]'` before serializing to the
//     dashboard. The dashboard backend itself never holds a `wallet`
//     instance by default — balance comes from the latest snapshot
//     record on disk.
//
//   - **Dependency-injected end-to-end.** `createDashboardServer({...})`
//     accepts `cfg`, `positions`, `snapshots`, `historyReader`,
//     `risk` (optional), and `wallet` (optional). Tests inject
//     mocks; production wires the real ones in
//     `scripts/start-dashboard.mjs`.
//
// Design rules (also see docs/ARCHITECTURE.md §3 + §6):
//
//   1. **Pure helpers stay pure.** `redactConfig`, `parseRange`,
//      `rangeToMs`, `buildSummary`, `filterHistory`, `filterSnapshots`,
//      `matchRoute`, `isAuthed` — every helper exported here has no
//      I/O and is exported so the test suite can pin its behaviour
//      without booting a server.
//
//   2. **Every async op has a timeout.** `request_timeout_ms`
//      guards the whole request handler; a stuck portfolio read
//      returns 504 instead of hanging the socket.
//
//   3. **No `console.log`.** Every request emits one NDJSON line
//      through the structured logger (`info` for 2xx, `warn` for
//      4xx, `error` for 5xx).
//
//   4. **Atomic state writes.** `PUT /api/config` deep-merges the
//      body onto `config/user.json` via `atomicWriteJson`. A
//      SIGKILL mid-write cannot leave `user.json` half-written.
//
//   5. **The WIF stays inside the host.** The dashboard never
//      imports `wallet/libauth.mjs`. The host-process wallet is
//      owned by the trader loop; the dashboard is read-only.
//
// Origin: original code for TradeBot. Mirrors docs/ARCHITECTURE.md
// §5 (data model) + §6 (config flow).

import http from 'node:http';
import { URL } from 'node:url';
import process from 'node:process';
import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';

import { SATS_PER_BCH } from '../data/types.mjs';
import { createLogger } from '../util/logger.mjs';
import { atomicWriteJson, ensureDirForFile, readNdjsonFile } from '../util/atomic-write.mjs';
import {
  createPaytacaBcmrClient,
  normalizeBcmrBaseUrl,
} from './paytacaBcmr.mjs';
import {
  getTokenHolders,
} from './token-holders.mjs';
// First-run setup wizard backend. The dashboard auto-redirects to
// `/setup` when `GET /api/setup/status` reports `setup_required=true`
// (operator has not yet provided a network + wallet + API token).
// The wizard's POST lands at `/api/setup`, which atomically writes
// the validated payload onto `config/user.json` via the same
// atomic-write helper `PUT /api/config` uses.
import {
  getSetupStatus as getSetupStatusHandler,
  postSetup as postSetupHandler,
} from './setup.mjs';
import {
  DEFAULT_POSITIONS_FILE,
} from '../portfolio/positions.mjs';
import {
  DEFAULT_SNAPSHOTS_DIR,
} from '../portfolio/snapshots.mjs';
import {
  summarize,
  summarizeByToken,
  bestAndWorst,
  unrealizedPnlSats,
} from '../portfolio/pnl.mjs';
import { DEFAULT_HISTORY_FILE } from '../trader/loop.mjs';
// T61: extended `/healthz` builder. Defensive per-probe
// envelope (loop / positions / wallet / breaker) with stale-loop
// classification + UTXO timeout + structured logs on probe
// failure. Keeps the existing static `{ok:true}` contract for
// downstream monitors while exposing enough state to detect
// stuck-bot conditions without scraping the dashboard.
import {
  buildExtendedHealthz,
  HEALTH_SCHEMA,
} from './health.mjs';
// T78 subset 1 — Prometheus-style `/metrics` exporter. The
// route handler delegates to `buildMetricsEnvelope` (in
// `src/dashboard/metrics.mjs`) which assembles per-probe
// counter + gauge samples and renders them as Prometheus text
// format (version 0.0.4). Same per-probe defensive contract as
// `/healthz`: a broken probe surfaces `probe_status:degraded`
// on the wire instead of failing the scrape.
import {
  buildMetricsEnvelope,
  METRICS_SCHEMA,
  PROMETHEUS_CONTENT_TYPE,
  formatPrometheusText,
} from './metrics.mjs';
// T79 subset 2 — per-token counters, scoring-gate hit
// counters, and a rolling tick-duration summary. The
// orchestrator in `metrics.mjs` accepts an injected probe
// seam so subset 1 (already shipped) + subset 2 (this
// commit) compose without breaking either side.
import {
  createSubset2ProbeCache as createSubset2ProbeCacheImpl,
  METRICS_SUBSET2_SCHEMA,
  DEFAULT_METRICS_PER_TOKEN_CACHE_MS,
  gatherSubset2ProbesFromCtx as gatherSubset2ProbesFromCtxImpl,
} from './metrics-subset2.mjs';
// T80 — Prometheus-style histogram for tick duration +
// adaptive-weight snapshot gauge. Reads from `loop.stats()`
// (NOT history re-read) so a scrape is O(1) regardless of how
// big `data/history.jsonl` gets.
import {
  gatherSubset3ProbesFromCtx as gatherSubset3ProbesFromCtxImpl,
  METRICS_SUBSET3_SCHEMA,
} from './metrics-subset3.mjs';
// T43c-server: the per-knob restart endpoint (T43c-server
// completion) consumes the catalog directly. `lookupKnobByKey`
// validates the URL `:path` parameter against `KNOBS`;
// `validateKnobValueForServer` enforces the per-knob kind/min/max
// contract. Both are pure and exported for tests.
import { lookupKnobByKey, validateKnobValueForServer } from '../util/knob-catalog.mjs';
import { buildFeatureIdeaRoutes as buildFeatureIdeaRoutesImpl } from '../feature-ideas/routes.mjs';
import { buildBugRoutes as buildBugRoutesImpl } from '../bugs/routes.mjs';
// T53.1: alerts subsystem — the /api/alerts/recent endpoint. The
// alerts router + channels live under `src/alerts/`. This handler
// only reads the alerts subsystem's recent-dedupe snapshot for
// the dashboard; dispatching events into the router happens at the
// trader loop decision points (T53.2 — deferred).
import { listRecentAlerts as listRecentAlertsImpl } from './alerts-recent.mjs';
import { buildStakingStatus as buildStakingStatusImpl, StakingStatusError, StakingStatusConfigError, DEFAULT_STAKING_ALERTS_FILE, DEFAULT_STAKING_ALERTS_MAX } from './staking-status.mjs';
import { buildStakingLogResponse } from './stake-log.mjs';
import { buildDustPositionsResponse } from './dust-positions.mjs';
import {
  buildPnlTimeseriesResponse,
  PnlTimeseriesConfigError,
} from './pnl-timeseries.mjs';
import {
  buildRiskPanel as buildRiskPanelImpl,
  RiskPanelError,
  RiskPanelConfigError,
} from './risk-panel.mjs';
// T47: positions-vs-chain reconciliation — pure diff helper that
// the new `/api/reconcile/positions-vs-chain` endpoint + the matching
// operator CLI both consume. Re-exports the report-version constant
// for test assertions on the response envelope shape.
import {
  diffPositionsVsChain as diffPositionsVsChainImpl,
  RECONCILE_REPORT_VERSION,
} from '../reconcile/positions-vs-chain.mjs';
// T63: per-token trade-log aggregator. Pure helper that rolls
// up `data/history.jsonl` + `data/positions.json` into one
// row per token_id with closed-trade attribution + an
// open-position list. Backs the `/api/tokens/summary` endpoint
// (subset 1 — backend ships in this commit; the React tile +
// drill-down ship in subset 2).
import {
  buildPerTokenSummary,
  listPerTokenSummaries,
  TOKENS_SUMMARY_SCHEMA as PER_TOKEN_SUMMARY_SCHEMA,
  TradeLogArgError,
} from '../portfolio/per-token-trade-log.mjs';
// T71: per-token fee breakdown with LP / tx / slippage split.
// Pure helper that classifies each position's fees into the
// three categories so the operator can finally answer "is my
// slippage cost eating my LP fees?". Backs the new
// `/api/fees/breakdown` endpoint so a React tile can render
// the per-token composition + drill-down into the per-trade
// attribution.
import {
  breakdownFeesForToken,
  breakdownFeesAcrossTokens,
  FEE_BREAKDOWN_SCHEMA as FEE_BREAKDOWN_SCHEMA_CONST,
  FeeBreakdownArgError,
} from '../portfolio/fee-breakdown.mjs';
// T64: snapshot aggregator with in-memory mtime-keyed TTL cache.
// Backs the new `/api/snapshots/aggregate` endpoint so the dashboard
// can poll high-frequency without re-paying the per-refresh parse
// cost (~50-200ms on a ~1800-record history).
import {
  aggregateSnapshots as aggregateSnapshotsImpl,
  buildAggregateResponse as buildAggregateResponseImpl,
  clampSnapshotAggregateCacheMs,
  SnapshotAggregator,
  SnapshotAggregatorError,
  SnapshotAggregatorConfigError,
  DEFAULT_SNAPSHOT_AGGREGATE_CACHE_MS,
} from './snapshot-aggregator.mjs';
import {
  HoldersScannerCache,
  clampHoldersScannerCacheMs,
} from '../strategy/holder-scanner-cache.mjs';
import { DEFAULT_HOLDERS_SCANNER_CACHE_MS } from '../strategy/holder-scanner.mjs';
// T79 subset 2 — knobs for the subset-2 metrics probe cache
// (per-token cache TTL + history cap). Both clamp helpers
// return safe defaults when the config knob is missing or
// out-of-range.
import {
  clampMetricsPerTokenCacheMs as clampMetricsPerTokenCacheMsImpl,
  clampMetricsHistoryLimit as clampMetricsHistoryLimitImpl,
  DEFAULT_METRICS_HISTORY_LIMIT,
  DEFAULT_METRICS_PER_TOKEN_CACHE_MS as DEFAULT_METRICS_PER_TOKEN_CACHE_MS_IMPORT,
} from './metrics-subset2.mjs';

// Local aliases so the rest of the file can refer to the
// canonical name without the `_Impl` suffix.
const clampMetricsPerTokenCacheMs = clampMetricsPerTokenCacheMsImpl;
const clampMetricsHistoryLimit = clampMetricsHistoryLimitImpl;

// ─────────────────────────────────────────────────────────────────────
//  Errors
// ─────────────────────────────────────────────────────────────────────

/**
 * Base class for every error `dashboard/server.mjs` raises. Callers
 * should match on `instanceof DashboardServerError` to distinguish
 * dashboard-side failures from local bugs (TypeError, ENOENT, etc.).
 */
export class DashboardServerError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'DashboardServerError';
    if (opts.kind) this.kind = opts.kind;
    if (opts.cause) this.cause = opts.cause;
  }
}

/** Config / wiring problem (programmer error — fail fast). */
export class DashboardConfigError extends DashboardServerError {
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = 'DashboardConfigError';
  }
}

/** Raised on lifecycle calls (`start`/`stop`) when out-of-state. */
export class DashboardLifecycleError extends DashboardServerError {
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = 'DashboardLifecycleError';
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Defaults + shape
// ─────────────────────────────────────────────────────────────────────

/**
 * Defaults that mirror `config/default.json → dashboard` for the
 * `small_balance_startup` preset. The real config wins when present.
 *
 * `api_token: null` is the SAFE default: every write endpoint
 * refuses to operate. Set `dashboard.api_token` in `user.json` to
 * activate writes.
 *
 * `static_root` points at the built SPA directory (relative to
 * `cwd` — i.e. the TradeBot repo root). The dashboard backend
 * serves files from this root for every GET / HEAD request that
 * does NOT match an `/api/*` or `/healthz` route. For paths that
 * don't resolve to a real file AND have `Accept: text/html`, the
 * backend falls back to `static_index` (React Router's
 * historyApiFallback). Set `static_root: null` to disable and fall
 * through to the JSON route matcher for every non-API URL.
 */
export const DEFAULT_DASHBOARD_CONFIG = Object.freeze({
  bind_host: '127.0.0.1',
  bind_port: 8787,
  request_timeout_ms: 10_000,
  cors_origin: null,
  log_level: 'info',
  api_token: null,
  history_max_events: 5_000,
  snapshots_max_records: 2_000,
  snapshot_default_range: '30d',
  history_default_range: '7d',
  positions_default_status: 'open',
  auth_header_name: 'authorization',
  static_root: 'dashboard/dist',
  static_index: 'index.html',
  // T25b: per-tick decision tree view (REASONING page). Caps how
  // many ticks of `entry_*` / `exit_*` decisions to surface; each
  // tick bundles 0-3 candidates × 3-5 events, so 5 ticks = ~25
  // decision rows max. Default is a deliberate sweet spot for a
  // 10-second auto-refresh view; raise it via config if you want
  // longer history.
  reasoning_max_ticks: 5,
  reasoning_decisions_per_tick: 20,
  // T30c: research-cron-run history view. Caps how many
  // `kind:'research_cron_run'` events `/api/research-runs` will
  // surface. Default 50 covers ~5-6 days at the 12h rate-limit.
  research_runs_max_events: 50,
  // T39: cumulative P&L timeseries view. `pnl_timeseries_default_range`
  // is the default `?range=` for the new `/api/pnl-timeseries`
  // endpoint (30d mirrors the balance-over-time chart's default).
  // `pnl_timeseries_max_rows` caps how many rows the chart will
  // render — default 500 covers ~1 trade per 5 minutes for 42
  // hours; the cumsum still anchors to the full close history
  // regardless of this cap, so a longer cap never lies.
  pnl_timeseries_default_range: '30d',
  pnl_timeseries_max_rows: 500,
  // T42: dedicated trade-history view. `trade_history_default_range`
  // is the default `?range=` for `/api/trade-history` (30d so the
  // table shows a useful default window). `trade_history_max_events`
  // caps how many entry+exit rows the server will return in one
  // response — 2000 is roughly 500 closed positions worth of
  // events, which dwarfs the operator's current trading cadence but
  // leaves plenty of headroom.
  trade_history_default_range: '30d',
  trade_history_max_events: 2_000,
  // T61 — extended `/healthz` builder bounds the `wallet.listUtxos()`
  // call so a slow Electrum provider can't block a 200ms healthcheck.
  // Default 5s covers a typical PIES-style UTXO scan on first boot;
  // tune DOWN (e.g. 1500ms) on slow networks, UP (e.g. 10s) on
  // wallets with hundreds of dust UTXOs.
  health_utxo_timeout_ms: 5_000,
  // T64 — `/api/snapshots/aggregate` cache TTL. The aggregator keys
  // its cache on `(dir, fileMtimeMs, rangeMs, tokenId)` so a new
  // snapshot-record write from the trader loop invalidates the cache
  // instantly without an explicit flush. The TTL is a hard ceiling
  // that protects against very-fresh records not yet on disk + gives
  // operators a knob to force-fresh on demand (set to 0 to disable
  // caching). Default 30s mirrors the dashboard's auto-refresh cadence.
  snapshot_aggregate_cache_ms: 30_000,
  // T79 subset 2 — `GET /metrics` per-token / scoring-gate
  // probe cache TTL. Bounded by `history_max_events: 5_000`
  // (the existing knob — subset 2 re-uses it so the wire format
  // stays consistent with `/api/tokens/summary`). Default 30s
  // means a 15s Prometheus scrape interval hits the cache on
  // 14/15 polls. Set to 0 to disable caching (every scrape
  // re-reads `data/history.jsonl`).
  metrics_per_token_cache_ms: 30_000,
});

/**
 * Resolve the effective `dashboard` config block, falling back to
 * `DEFAULT_DASHBOARD_CONFIG` for any missing / bad / non-object
 * input. Pure — exported for tests + the CLI launcher.
 *
 * @param {unknown} cfgDashboard
 * @returns {Readonly<typeof DEFAULT_DASHBOARD_CONFIG>}
 */
export function resolveDashboardConfig(cfgDashboard) {
  const base = DEFAULT_DASHBOARD_CONFIG;
  if (!cfgDashboard || typeof cfgDashboard !== 'object' || Array.isArray(cfgDashboard)) return base;
  /** @type {Record<string, unknown>} */
  const out = { ...base };
  for (const k of Object.keys(base)) {
    const v = /** @type {any} */ (cfgDashboard)[k];
    if (v === undefined) continue;
    out[k] = v;
  }
  return Object.freeze(out);
}

/**
 * Default history file location. Mirrors `DEFAULT_HISTORY_FILE` from
 * `trader/loop.mjs`. Duplicated here so the dashboard never has to
 * import the trading loop (single-responsibility for the read-only
 * surface).
 */
export const DEFAULT_DASHBOARD_HISTORY_FILE = DEFAULT_HISTORY_FILE;

// ─────────────────────────────────────────────────────────────────────
//  Route table
// ─────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} RouteSpec
 * @property {'GET'|'POST'|'PUT'|'DELETE'} method
 * @property {string} path          literal path (no params) for docs/tests
 * @property {RegExp} pattern       captures path params into groups
 * @property {string[]} paramNames  e.g. ['id']
 * @property {boolean} auth         true → require `Authorization: Bearer <api_token>`
 * @property {(ctx, params, url) => Promise<Object|string>} handler
 */

/**
 * Build the canonical route table. Each entry is matched in order —
 * first match wins. Order matters: list `GET /healthz` BEFORE
 * `GET /api/config` only if you want literal `/healthz` to short-
 * circuit before the API block; otherwise it doesn't matter because
 * the patterns are anchored with `^`.
 *
 * The `path` field is a documentation string; `pattern` is what the
 * matcher actually runs. Every route carries both so tests can assert
 * "the table contains a GET /healthz" without depending on regex
 * `String()` interpolation.
 *
 * Pure. Exported for tests.
 *
 * @returns {RouteSpec[]}
 */
export function buildRouteTable() {
  return [
    {
      // T61 — extended `/healthz` envelope. The handler delegates
      // to `buildExtendedHealthz` (in `src/dashboard/health.mjs`)
      // which assembles four per-probe summaries:
      //   - `loop`        — last_tick_age_ms, tick_count, running
      //   - `positions`   — open_count (from `ctx.positions.list('open')`)
      //   - `wallet`      — utxo_count (from `ctx.wallet.listUtxos()`,
      //                      bounded by `dashboard.health_utxo_timeout_ms`)
      //   - `breaker`     — is_tripped, trip_kind, recent_daily_pnl_bch,
      //                     consecutive_losses
      // Each probe reports `'ok' | 'degraded' | 'unconfigured'` so
      // monitors can branch on the top-level `probes` map without
      // inspecting each object. The endpoint is NEVER auth-gated
      // (it's a probe) and NEVER throws — every I/O is wrapped with
      // its own try/catch so the dashboard always responds even
      // when the wallet/loop/breaker is misbehaving.
      method: 'GET',
      path: '/healthz',
      pattern: /^\/healthz\/?$/,
      paramNames: [],
      auth: false,
      handler: async (ctx) => {
        try {
          return await buildExtendedHealthz({ ctx });
        } catch (e) {
          // Defensive: even if `buildExtendedHealthz` ever throws
          // (the I/O wrappers catch their own), the endpoint must
          // still respond with a 200-shape envelope so monitors
          // don't interpret a malformed envelope as a missed probe.
          const logger = ctx?.logger;
          if (logger && typeof logger.warn === 'function') {
            logger.warn('dashboard.healthz.builder-failed', {
              err_name: e?.name ?? 'Error',
              err_message: e?.message ?? String(e),
            });
          }
          return {
            schema: HEALTH_SCHEMA,
            ok: true,
            ts: new Date().toISOString(),
            uptime_s: Math.max(0, Math.floor(process.uptime())),
            loop: { status: 'degraded', error: 'builder failed', tick_count: null, last_tick_at_ms: null, last_tick_age_ms: null, last_tick_duration_ms: null, loop_running: null },
            positions: { status: 'degraded', error: 'builder failed', open_count: null },
            wallet: { status: 'degraded', error: 'builder failed', utxo_count: null, utxo_timeout_ms: 5000 },
            breaker: { status: 'degraded', error: 'builder failed', is_tripped: null, trip_kind: null, consecutive_losses: null, recent_daily_pnl_bch: null, loss_cooldown_remaining_ms: null, max_daily_loss_bch: null },
            probes: { loop: 'degraded', positions: 'degraded', wallet: 'degraded', breaker: 'degraded' },
          };
        }
      },
    },
    {
      // T78 subset 1 — Prometheus-style `/metrics` endpoint.
      // Delegates to `buildMetricsEnvelope` (in
      // `src/dashboard/metrics.mjs`) which assembles the same
      // per-probe signals `/healthz` exposes plus a few process-
      // level signals (uptime, cumulative entry/exit/error
      // counters, rug-pattern check counters). The handler
      // renders the envelope as Prometheus text format (version
      // 0.0.4) and returns a `{__text_response:true, ...}` envelope
      // so the dispatcher's `sendText` path emits the right
      // `Content-Type: text/plain; version=0.0.4; charset=utf-8`
      // header. The endpoint is NEVER auth-gated (it's a scrape
      // target) and NEVER throws — every I/O is wrapped with its
      // own try/catch so the scraper always gets a parseable
      // response even when the bot is half-broken (each broken
      // probe surfaces as `probe_status:degraded` on the wire).
      method: 'GET',
      path: '/metrics',
      pattern: /^\/metrics\/?$/,
      paramNames: [],
      auth: false,
      handler: async (ctx) => {
        try {
          // T79 subset 2 — wire the per-token / scoring-gate /
          // tick-duration probes into the metrics envelope via
          // the `subset2Probes` seam. The cache (created at
          // boot) re-reads `data/history.jsonl` through the
          // dashboard's `historyReader` adapter on each cache
          // miss and re-uses the cached envelope on every
          // Prometheus scrape inside the TTL window. Default
          // TTL is 30s — a 15s scrape interval hits the cache
          // on 14/15 polls.
          let subset2Probes = null;
          const cache = ctx?.metricsSubset2Cache;
          if (cache && typeof cache.gather === 'function') {
            try {
              subset2Probes = await cache.gather();
            } catch (subset2Err) {
              const logger = ctx?.logger;
              if (logger && typeof logger.warn === 'function') {
                logger.warn('dashboard.metrics.subset2.cache-threw', {
                  err_name: subset2Err?.name ?? 'Error',
                  err_message: subset2Err?.message ?? String(subset2Err),
                });
              }
              // Fall through with subset2Probes=null so the
              // route still serves subset-1 metrics (never
              // fails the scrape on subset-2 trouble).
            }
          }
          // T80 — subset 3 probes (Prometheus histogram for
          // tick duration + adaptive-weight snapshot). Read
          // from `ctx.metricsSubset3Probes` if pre-computed at
          // boot (the cache pattern from subset 2 is overkill
          // here because the source is `loop.stats()` which
          // is O(1) and never throws on a happy path). The
          // gather helper is the single defensive net — a
          // missing ctx / throwing loop surfaces as an
          // `unconfigured` / `degraded` probe and the wire
          // format stays parseable.
          let subset3Probes = null;
          if (ctx?.metricsSubset3Probes && typeof ctx.metricsSubset3Probes === 'object') {
            subset3Probes = ctx.metricsSubset3Probes;
          } else {
            try {
              subset3Probes = gatherSubset3ProbesFromCtxImpl({ ctx, opts: { } });
            } catch (subset3Err) {
              const logger = ctx?.logger;
              if (logger && typeof logger.warn === 'function') {
                logger.warn('dashboard.metrics.subset3.gather-threw', {
                  err_name: subset3Err?.name ?? 'Error',
                  err_message: subset3Err?.message ?? String(subset3Err),
                });
              }
              subset3Probes = null;
            }
          }
          const envelope = await buildMetricsEnvelope({ ctx, subset2Probes, subset3Probes });
          const body = formatPrometheusText(envelope);
          return {
            __text_response: true,
            content_type: PROMETHEUS_CONTENT_TYPE,
            body,
            schema: METRICS_SCHEMA,
          };
        } catch (e) {
          // Defensive: even if `buildMetricsEnvelope` ever throws
          // (the per-probe wrappers catch their own), the scrape
          // endpoint MUST respond with a parseable text body so
          // Prometheus doesn't interpret a malformed scrape as a
          // missed poll. Emit a minimal envelope with all probes
          // marked `degraded` and the underlying error in a
          // `# ERROR` comment line.
          const logger = ctx?.logger;
          if (logger && typeof logger.warn === 'function') {
            logger.warn('dashboard.metrics.builder-failed', {
              err_name: e?.name ?? 'Error',
              err_message: e?.message ?? String(e),
            });
          }
          const errMsg = (e && e.message) ? String(e.message) : 'builder failed';
          const body = [
            '# HELP tradebot_up Process is responsive (1=responding to /metrics, 0=not)',
            '# TYPE tradebot_up gauge',
            'tradebot_up{probe_status="degraded"} 0',
            `# ERROR builder_failed: ${errMsg.replace(/[\r\n]+/g, ' ')}`,
            '',
          ].join('\n');
          return {
            __text_response: true,
            content_type: PROMETHEUS_CONTENT_TYPE,
            body,
            schema: METRICS_SCHEMA,
          };
        }
      },
    },
    {
      method: 'GET',
      path: '/api/summary',
      pattern: /^\/api\/summary\/?$/,
      paramNames: [],
      auth: false,
      handler: async (ctx) => buildSummary(ctx),
    },
    {
      // T41: live risk panel — current exposure vs limit, daily
      // loss vs limit, drawdown vs peak, top-concentration open
      // positions, and circuit-breaker pass-through. Drives the
      // DASHBOARD's "live risk" widget.
      method: 'GET',
      path: '/api/risk-panel',
      pattern: /^\/api\/risk-panel\/?$/,
      paramNames: [],
      auth: false,
      handler: async (ctx) => buildRiskPanelImpl(ctx),
    },
    {
      method: 'GET',
      path: '/api/positions',
      pattern: /^\/api\/positions\/?$/,
      paramNames: [],
      auth: false,
      handler: async (ctx, _params, url) => listPositions(ctx, url),
    },
    {
      // T88: per-position dust-flag preview. Consumes
      // `src/dashboard/dust-positions.mjs#buildDustPositionsResponse`,
      // which runs the same `findDustPositions` math the trader
      // loop uses on every tick. The dashboard tile surfaces
      // (a) which open positions the bot WOULD auto-close if the
      // knob is on, (b) which were SKIPPED because of the
      // operator prevent_stop_loss override, on-chain-sync
      // source, or no live AMM price. No auth required (read-only,
      // mirrors `/api/positions` shape).
      method: 'GET',
      path: '/api/positions/dust',
      pattern: /^\/api\/positions\/dust\/?$/,
      paramNames: [],
      auth: false,
      handler: async (ctx, _params, url) => listDustPositions(ctx, url),
    },
    {
      // O03 (idea_operator_position-prevent-stop-loss-with-profit-target_20260917):
      // operator-set exit override per position. Body:
      //   { prevent_stop_loss: <bool>, profit_target_pct: <number|null>, set_by?: <string> }.
      // Validation lives in `src/portfolio/positions.mjs#applyOverrides`;
      // the handler just delegates. Auth-gated (same token as
      // PUT /api/config) — the operator toggle changes live bot
      // behavior, so an unauthenticated toggle would be a footgun.
      method: 'PUT',
      path: '/api/positions/:id/overrides',
      // :id is the position id (e.g. `pos_tlgxyvaq_0007`). Allow
      // underscores + alphanumerics (no slashes / dots in the id).
      pattern: /^\/api\/positions\/([A-Za-z0-9_-]+)\/overrides\/?$/,
      paramNames: ['id'],
      auth: true,
      handler: async (ctx, params, _url, body) => updatePositionOverrides(ctx, params.id, body),
    },
    {
      // T42: dedicated trade-history view (the TRADE HISTORY tab).
      // Flattened entry/exit events pulled from open+closed
      // positions, with filter query params:
      //   ?range=24h|7d|30d|all  — default 30d, applied to event.ts
      //   ?until=24h|7d|...      — explicit ceiling; useful for
      //                            "show me trades ending yesterday"
      //   ?event_kind=entry|exit|any   (default any)
      //   ?token_id=<64-hex>     — filter to one token
      //   ?side=long_token|...   — filter by position side
      //   ?pnl=gain|loss|flat|any  (default any; only matches exits)
      //   ?limit=N               — cap row count (newest-first)
      auth: false,
      method: 'GET',
      path: '/api/trade-history',
      pattern: /^\/api\/trade-history\/?$/,
      paramNames: [],
      handler: async (ctx, _params, url) => listTradeHistory(ctx, url),
    },
    {
      method: 'GET',
      path: '/api/history',
      pattern: /^\/api\/history\/?$/,
      paramNames: [],
      auth: false,
      handler: async (ctx, _params, url) => listHistory(ctx, url),
    },
    {
      // T30c: research-cron-run history. Mirrors `/api/history`
      // but pre-filters to `kind:'research_cron_run'`.
      method: 'GET',
      path: '/api/research-runs',
      pattern: /^\/api\/research-runs\/?$/,
      paramNames: [],
      auth: false,
      handler: async (ctx, _params, url) => listResearchRuns(ctx, url),
    },
    {
      method: 'GET',
      path: '/api/snapshots',
      pattern: /^\/api\/snapshots\/?$/,
      paramNames: [],
      auth: false,
      handler: async (ctx, _params, url) => listSnapshots(ctx, url),
    },
    {
      // T64: pre-aggregated snapshot rollups. The dashboard
      // polls this endpoint at auto-refresh cadence; the response
      // is much smaller than `/api/snapshots` (one envelope, not
      // 1800 rows) and is served from an mtime-keyed TTL cache so
      // repeat polls are O(1). Query string: `?range=...` (reuses
      // the existing range parser — `7d` / `30m` / `24h` / `all`),
      // `?token_id=<64-hex>` (optional per-token scope). No auth.
      method: 'GET',
      path: '/api/snapshots/aggregate',
      pattern: /^\/api\/snapshots\/aggregate\/?$/,
      paramNames: [],
      auth: false,
      handler: async (ctx, _params, url) => listSnapshotsAggregate(ctx, url),
    },
    {
      // T39: cumulative realized P&L over time, sourced from
      // `positions.json#closed[]`. Drives the DASHBOARD's
      // "cumulative P&L" chart. Supports `?range=...`,
      // `?token_id=...`, `?limit=...` (the limit caps rows but
      // does NOT affect the cumulative sum — see
      // pnl-timeseries.mjs for the sinceMs semantics).
      method: 'GET',
      path: '/api/pnl-timeseries',
      pattern: /^\/api\/pnl-timeseries\/?$/,
      paramNames: [],
      auth: false,
      handler: async (ctx, _params, url) => listPnlTimeseries(ctx, url),
    },
    {
      method: 'GET',
      path: '/api/config',
      pattern: /^\/api\/config\/?$/,
      paramNames: [],
      auth: false,
      handler: async (ctx) => ({ config: redactConfig(ctx.cfg) }),
    },
    {
      method: 'GET',
      // T43c: returns the RAW `config/default.json` object (no
      // user.json merge). The Settings view's per-knob reset-to-
      // default link + help popover baseline field need the
      // pristine baseline — the merged `cfg` would mask any
      // operator override and the reset would be a no-op. Reads
      // via the same fs seam the rest of the server uses, so
      // tests can inject a fixture without touching the on-disk
      // file. Returns `{ defaults, path }`; `path` lets the UI
      // show "baseline = config/default.json" so the operator
      // knows exactly where the value came from.
      path: '/api/config/defaults',
      pattern: /^\/api\/config\/defaults\/?$/,
      paramNames: [],
      auth: false,
      handler: async (ctx) => readConfigDefaults(ctx),
    },
    {
      method: 'GET',
      path: '/api/risk',
      pattern: /^\/api\/risk\/?$/,
      paramNames: [],
      auth: false,
      handler: async (ctx) => readRisk(ctx),
    },
    {
      method: 'GET',
      path: '/api/activity',
      pattern: /^\/api\/activity\/?$/,
      paramNames: [],
      auth: false,
      handler: async (ctx, _params, url) => readActivity(ctx, url),
    },
    {
      method: 'GET',
      path: '/api/reasoning',
      pattern: /^\/api\/reasoning\/?$/,
      paramNames: [],
      auth: false,
      handler: async (ctx, _params, url) => listReasoning(ctx, url),
    },
    {
      method: 'GET',
      // T27e: live on-chain wallet state. Independent of the
      // positions store — surfaces anything the wallet actually
      // holds at the moment of the request, including manual
      // trades that bypassed `positions.open()`. Reads through
      // the wallet adapter (libauth + Electrum) so the same
      // getUtxos / getBalanceSats pipeline the trader loop uses.
      path: '/api/wallet/balance',
      pattern: /^\/api\/wallet\/balance\/?$/,
      paramNames: [],
      auth: false,
      handler: async (ctx) => getWalletBalance(ctx),
    },
    {
      method: 'GET',
      // T47: positions-vs-chain reconciliation report. Reads the
      // bot's open positions and the wallet's live UTXO set, runs
      // the pure diff helper, and returns a structured report with
      // `summary` + `findings[]` (consensus / on_disk_only /
      // on_chain_only / quantity_mismatch / note). Read-only —
      // never writes to `data/positions.json`. The operator uses
      // the `recommended_action` field on each finding to choose
      // which existing remediation script (reconcile-position.mjs,
      // sync-wallet-holdings.mjs, reconcile-stuck-position.mjs) to
      // run. No auth required because the response carries no
      // secrets and never mutates state.
      path: '/api/reconcile/positions-vs-chain',
      pattern: /^\/api\/reconcile\/positions-vs-chain\/?$/,
      paramNames: [],
      auth: false,
      handler: async (ctx) => getReconcilePositionsVsChain(ctx),
    },
    {
      // T53.1: alerts subsystem — recent emitted alerts. Backed
      // by `data/alerts.jsonl` (NDJSON; same atomic-write pattern
      // as `data/history.jsonl`). Filters:
      //   ?range=24h|7d|30d|all         (default 24h; applied to event.ts)
      //   ?severity=info|warn|error|critical
      //   ?kind=risk_threshold|slippage_spike|amm_divergence|breaker_trip|wallet_floor|stall|custom
      //   ?limit=N                      (capped at alerts_max; default 200)
      // No auth required (read-only, mirrors `/api/trade-history`).
      method: 'GET',
      path: '/api/alerts/recent',
      pattern: /^\/api\/alerts\/recent\/?$/,
      paramNames: [],
      auth: false,
      handler: async (ctx, _params, url) => listRecentAlertsImpl(ctx, url),
    },
    {
      // T58 subset 4: BadgerCoin Staking status tile.
      // Powers `dashboard/src/components/StakingStatusCard.jsx`.
      // Returns the wallet's current lockNFT state (count + total
      // BCH + per-lock decoded commitment) + the last 10 stake
      // alerts from `data/alerts.jsonl` + the four operator-
      // facing staking knobs. No auth (read-only, mirrors
      // `/api/risk-panel`).
      //
      // The knob-toggle flip is NOT handled here — that goes
      // through the existing `PUT /api/config` endpoint so the
      // dashboard's existing validation + restart-banner plumbing
      // continues to work. This endpoint is strictly read.
      //
      // Graceful degrade: when `ctx.wallet === null` the response
      // carries `lockNfts.error: 'wallet_not_configured'` rather
      // than 503, so the React tile can render a single "wallet
      // unavailable" pill without blanking the whole card.
      method: 'GET',
      path: '/api/staking/status',
      pattern: /^\/api\/staking\/status\/?$/,
      paramNames: [],
      auth: false,
      handler: async (ctx) => buildStakingStatusImpl(ctx),
    },
    {
      method: 'GET',
      // T70-3: stake-attempt audit log (every lock/unlock attempt
      // the bot made + result + error). Powers the Dashboard's
      // collapsible "Status" div at the bottom of the BadgerCoin
      // Staking card so the operator can see exactly what the bot
      // tried and why it's failing without grepping the run-bot log.
      //
      // Query string: ?limit=N (default 50, max 500) and
      // ?file=<path> (default cfg.staking.attempt_log_file or
      // data/stake-attempts.jsonl). No auth — same shape as
      // /api/staking/status.
      path: '/api/staking/log',
      pattern: /^\/api\/staking\/log\/?$/,
      paramNames: [],
      auth: false,
      handler: async (ctx) => buildStakingLogResponse(ctx),
    },
    {
      method: 'GET',
      // T26c: Paytaca BCMR lookup for a single token_id. Cache
      // TTL is owned by the bcmrClient (default 1h). The token_id
      // is the 32-byte hex category id; we validate it before any
      // network work.
      path: '/api/token/:tokenId',
      pattern: /^\/api\/token\/([0-9a-f]{64})\/?$/,
      paramNames: ['tokenId'],
      auth: false,
      handler: async (ctx, params) => getTokenMetadata(ctx, params.tokenId),
    },
    {
      method: 'GET',
      // T76 subset 1: stub holders endpoint. Today returns
      // `{ok:false, error:'scanner_not_implemented'}` because
      // neither the Cauldron indexer nor the standard Electrum
      // providers expose a token-holders endpoint (T76 idea
      // background, verified 2026-09-20). Subset 2 wires the
      // real BCH chain-state scanner. The wire shape is
      // stable so the dashboard React layer can already be
      // wired against this endpoint — it just surfaces a
      // "scanner not yet implemented" pill until subset 2 lands.
      //
      // Operator-testing affordance: `?holders=<urlencoded-json>`
      // + optional `?decimals=N&top_n=N&threshold_pct=N&epsilon_pct=N`
      // runs the T76 math against a hand-built fixture and returns
      // the real concentration envelope. Same pattern as the
      // `?since=` affordance on `/api/tokens/summary`.
      //
      // Pattern is the same 64-hex capture as `/api/token/:tokenId`
      // — case-folded to lowercase so the indexer's mixed-case
      // tokens normalize cleanly. URL is parsed by the handler
      // for the fixture branch.
      path: '/api/token/:tokenId/holders',
      pattern: /^\/api\/token\/([0-9a-f]{64})\/holders\/?$/,
      paramNames: ['tokenId'],
      auth: false,
      handler: async (ctx, params, url) => getTokenHolders(ctx, params.tokenId, url),
    },
    {
      method: 'GET',
      // T45b: discovery-list endpoint that powers the manual-trade
      // UI's token autocomplete. Returns the indexer's top-N
      // pools (the same shape `Fetcher.listTopTokens({...})`
      // surfaces to the trader loop) with a normalized
      // `{token_id, symbol, decimals, tvl_sats, ...}` projection
      // so the React component doesn't need to know about BCMR
      // nesting (`bcmr.token.symbol` vs `display_symbol`).
      //
      // No auth required because the response carries no secrets
      // and never mutates state — it mirrors the read-only
      // `GET /api/wallet/balance` pattern.
      //
      // Returns 503 `fetcher_not_configured` when the dashboard
      // boots without `opts.fetcher` wired (e.g. a stripped-down
      // dashboard used purely for settings editing); the UI
      // surfaces a "no pool list available" pill rather than a
      // broken autocomplete.
      path: '/api/pools/top',
      pattern: /^\/api\/pools\/top\/?$/,
      paramNames: [],
      auth: false,
      handler: async (ctx, _params, url) => getPoolsTop(ctx, url),
    },
    {
      // First-run setup wizard — GET status. Not auth-gated: the
      // operator has nothing to protect until the wizard completes,
      // and the dashboard needs this to decide whether to redirect
      // to /setup on first launch. Returns `{setup_required,
      // missing[], cashaddr_display, network}`. WIF/mnemonic are
      // never present in this envelope (only the truncated
      // cashaddr display string).
      method: 'GET',
      path: '/api/setup/status',
      pattern: /^\/api\/setup\/status\/?$/,
      paramNames: [],
      auth: false,
      handler: async (ctx) => getSetupStatusHandler(ctx),
    },
    {
      // First-run setup wizard — POST apply. Not auth-gated for
      // the same reason as the status check: there's no token yet.
      // Validation lives in `src/dashboard/setup.mjs` (network +
      // wallet + trading-knob bounds). The handler returns the
      // generated API token once so the wizard can store it in
      // sessionStorage and reload into a write-enabled Settings
      // view.
      method: 'POST',
      path: '/api/setup',
      pattern: /^\/api\/setup\/?$/,
      paramNames: [],
      auth: false,
      handler: async (ctx, _params, _url, body) => postSetupHandler(ctx, body),
    },
    {
      method: 'PUT',
      path: '/api/config',
      pattern: /^\/api\/config\/?$/,
      paramNames: [],
      auth: true,
      handler: async (ctx, _params, _url, body) => updateConfig(ctx, body),
    },
    {
      // T43c-server: per-knob restart-aware patch endpoint.
      //
      // URL shape: `/api/config/:path` where `:path` is the
      // dotted-key form from the catalog (e.g.
      // `entry.max_position_bch`). The :path segment is URL-
      // decoded (`%2E` → `.`).
      //
      // Validation pipeline:
      //   1. `lookupKnobByKey(path)` → `KnobMeta|null`.
      //   2. If unknown → 404 KNOB_NOT_IN_CATALOG.
      //   3. If the knob is `restart: false` AND the caller did
      //      NOT pass `?require_restart=true` → 400 RESTART_NOT_NEEDED
      //      (live knobs go through the bulk `PUT /api/config`).
      //   4. `validateKnobValueForServer(meta, body.value)` →
      //      `{ok, normalized, reason, message, ...}`.
      //   5. If invalid → 400 KNOB_VALUE_INVALID.
      //
      // On success: deep-merge `setPath(merged, path, normalized)`
      // onto the existing user.json via the same atomic write the
      // bulk endpoint uses, then send SIGUSR1 to the PID in
      // `data/run.pid` (read via `readRunPidFile`).
      method: 'POST',
      path: '/api/config/:path',
      // Allow dots in the :path segment (URL-decoded %2E for safety).
      // Cap the depth at 4 segments (matches the deepest catalog entry
      // — `scoring.weights.volume_30d_bch` is 4 segments) so a
      // runaway payload can't bypass the catalog gate.
      pattern: /^\/api\/config\/([A-Za-z0-9._%]{1,200})\/?$/,
      paramNames: ['path'],
      auth: true,
      handler: async (ctx, params, url, body) => patchConfigKnob(ctx, params.path, url, body),
    },
    {
      method: 'POST',
      path: '/api/risk/reset',
      pattern: /^\/api\/risk\/reset\/?$/,
      paramNames: [],
      auth: true,
      handler: async (ctx, _params, _url, body) => resetRisk(ctx, body),
    },
    {
      // T45: manual BUY/SELL trigger (subset 1 — backend only; the
      // dashboard UI lands in T45b). Goes through the same
      // `SwapExecutor.execute()` pipeline the trader loop uses, so
      // every pre-flight / slippage / fee check applies — the
      // operator can intervene on tokens the bot's scoring layer
      // would skip without bypassing the risk gates. Auth-gated
      // (same `dashboard.api_token` knob as PUT /api/config).
      //
      // Body shape:
      //   { token_id: <64-hex>,
      //     side: 'buy'|'sell',
      //     amount_bch: <positive finite number>,
      //     dry_run?: <bool>,
      //     expected_rate_sats_per_token?: <positive finite number> }
      method: 'POST',
      path: '/api/trade/manual',
      pattern: /^\/api\/trade\/manual\/?$/,
      paramNames: [],
      auth: true,
      handler: async (ctx, _params, _url, body) => executeManualTrade(ctx, body),
    },
    {
      // T63: per-token trade log with P&L attribution. The
      // operator-observability affordance the FURU cascade
      // surfaced on 2026-09-17 — before this endpoint the only
      // way to answer "what did the bot do with token X" was
      // to grep `data/history.jsonl` by hand. Subset 1 (this
      // commit) ships the backend only; subset 2 will mount a
      // React tile in DASHBOARD.
      //
      // Query string:
      //   ?token_id=<64-hex>      → single-token detail (full
      //                              closed_trades[] + open_positions[])
      //   (omit)                  → rollup list (one row per token
      //                              with summary totals + win-rate
      //                              + first/last ts + open-position
      //                              count). Heavy attribution arrays
      //                              are stripped from rollup rows so
      //                              the wire payload stays small.
      //
      // Schema: `tradebot.dashboard.tokens-summary/v1` (carried
      // on every envelope so a future React migration can branch
      // cleanly).
      //
      // Defensive: missing token_id → rollup; unknown token_id
      // for the detail endpoint → 404 TOKEN_NOT_FOUND (so the
      // dashboard can render "no history for this token"); malformed
      // token_id (not 64-hex) → 400 BAD_TOKEN_ID. The
      // `TradeLogArgError` thrown on non-array inputs surfaces as
      // 400 BAD_QUERY.
      //
      // No auth required (read-only, mirrors `/api/trade-history`
      // + `/api/alerts/recent`).
      method: 'GET',
      path: '/api/tokens/summary',
      pattern: /^\/api\/tokens\/summary\/?$/,
      paramNames: [],
      auth: false,
      handler: async (ctx, _params, url) => listTokensSummary(ctx, url),
    },
    {
      // T71: per-token fee breakdown with LP / tx / slippage
      // split. Closes the operator-observability gap that T63
      // surfaced: today's per-position P&L is net of fees but the
      // operator couldn't see fee composition, so they couldn't
      // answer "is my slippage cost eating my LP fees?". This
      // endpoint backs the `FeeBreakdownCard` React tile.
      //
      // Query string:
      //   ?token_id=<64-hex>      → single-token detail (full
      //                              per-trade attribution array)
      //   (omit)                  → cross-token rollup (one row
      //                              per token, sorted by
      //                              fees_paid_sats_total DESC,
      //                              heavy `trades[]` array
      //                              stripped to keep payload
      //                              small). The cross-token
      //                              envelope ALSO carries a
      //                              `totals` aggregate so the
      //                              dashboard's rollup header
      //                              shows the all-bot fees
      //                              composition.
      //
      // Schema: `tradebot.dashboard.fees-breakdown/v1` (carried
      // on every envelope).
      //
      // Defensive: missing token_id → rollup; unknown token_id
      // for the detail endpoint → 404 TOKEN_NOT_FOUND; malformed
      // token_id (not 64-hex) → 400 BAD_TOKEN_ID. The
      // `FeeBreakdownArgError` thrown on non-array inputs
      // surfaces as 400 BAD_QUERY. The breakdown reads the
      // SAME `cfg.scoring.fee_rate_bps` knob the scoring layer
      // uses (default 30 bps) so the operator can tweak the LP
      // fee assumption without restarting.
      //
      // No auth required (read-only, mirrors `/api/tokens/summary`).
      method: 'GET',
      path: '/api/fees/breakdown',
      pattern: /^\/api\/fees\/breakdown\/?$/,
      paramNames: [],
      auth: false,
      handler: async (ctx, _params, url) => listFeesBreakdown(ctx, url),
    },
  ];
}

/**
 * Try to match `method + pathname` against the route table. Returns
 * `{ route, params }` on hit; `null` on miss. Pure — exported for tests.
 *
 * @param {RouteSpec[]} routes
 * @param {string} method
 * @param {string} pathname
 * @returns {{ route: RouteSpec, params: Record<string, string> }|null}
 */
export function matchRoute(routes, method, pathname) {
  if (!Array.isArray(routes) || routes.length === 0) return null;
  if (typeof method !== 'string' || typeof pathname !== 'string') return null;
  for (const route of routes) {
    if (route.method !== method) continue;
    const m = route.pattern.exec(pathname);
    if (!m) continue;
    /** @type {Record<string, string>} */
    const params = {};
    for (let i = 0; i < route.paramNames.length; i += 1) {
      params[route.paramNames[i]] = decodeURIComponent(m[i + 1] ?? '');
    }
    return { route, params };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
//  Pure helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Field names that must NEVER leave the dashboard. Match is
 * case-insensitive and matches anywhere in the key (so `wif`,
 * `userWif`, `wif_base58`, `mnemonic_phrase` all redacted).
 *
 * Exported for tests.
 */
export const REDACTED_FIELD_NAMES = Object.freeze([
  'wif',
  'private_key',
  'privatekey',
  'seed',
  'entropy',
  'mnemonic',
  'bip39',
  'xprv',
  'xpriv',
  'passphrase',
]);

/**
 * Walk an object (and any nested plain objects / arrays of plain
 * objects) and replace the value of every redactable field with
 * `'[REDACTED]'`. Returns a NEW object — never mutates the input.
 *
 * Pure. Exported for tests.
 *
 * @param {unknown} value
 * @param {WeakSet<object>} [seen]
 * @returns {unknown}
 */
export function redactConfig(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((v) => redactConfig(v, seen));
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const k of Object.keys(value)) {
    if (isRedactedKey(k)) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = redactConfig(/** @type {any} */ (value)[k], seen);
    }
  }
  return out;
}

// ─── T43c: raw config/default.json reader ────────────────────────
//
// The Settings view's per-knob reset-to-default + help popover
// baseline need the pristine defaults — not the merged `cfg` the
// server holds today (which would mask any operator override).
//
// The reader mirrors `readUserJson` (test seam, ENOENT tolerance,
// redaction). It reads the on-disk file the loader recorded at
// boot (`ctx.cfg.paths.default`) so a `--config-default` CLI
// override is honored — the operator sees the exact file the bot
// booted from.

/**
 * Read the raw `config/default.json` file the dashboard server was
 * booted with. Returns an empty object on ENOENT (so the Settings
 * view's reset-to-default buttons degrade gracefully when the
 * operator started the server with a missing file). Throws on parse
 * errors — a malformed default is a fatal startup condition.
 *
 * @param {Object} ctx
 * @returns {Promise<Object>}
 */
async function readConfigDefaults(ctx) {
  if (!ctx || typeof ctx !== 'object') {
    return { defaults: {}, path: null, reason: 'no_ctx' };
  }
  const cfgPath = (ctx.cfg && ctx.cfg.paths && typeof ctx.cfg.paths.default === 'string')
    ? ctx.cfg.paths.default
    : null;
  if (!cfgPath) {
    return { defaults: {}, path: null, reason: 'no_default_path' };
  }
  let raw;
  try {
    raw = ctx.fs
      ? await ctx.fs.readFile(cfgPath, 'utf8')
      : await (await import('node:fs/promises')).readFile(cfgPath, 'utf8');
  } catch (e) {
    if (e && typeof e === 'object' && /** @type {any} */ (e).code === 'ENOENT') {
      return { defaults: {}, path: cfgPath, reason: 'missing' };
    }
    throw e;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    // Surface as a 4xx (not a 5xx) so the dashboard can render
    // a "default.json is malformed" warning instead of a crash.
    const err = new Error(`failed to parse ${cfgPath}: ${e?.message ?? e}`);
    err.statusCode = 400;
    err.code = 'CONFIG_DEFAULTS_PARSE_INVALID';
    throw err;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { defaults: {}, path: cfgPath, reason: 'not_an_object' };
  }
  // Defensive: even though default.json doesn't carry secrets,
  // run redaction so a future config refactor that adds a WIF
  // field to default.json doesn't accidentally leak it.
  return {
    defaults: /** @type {Object} */ (redactConfig(parsed)),
    path: cfgPath,
    reason: null,
  };
}

/**
 * Decide whether a single object key should be redacted.
 *
 * Matches in three shapes (case-insensitive, separator is `_` or `.`):
 *
 *   1. **Exact equality.** `wif`, `mnemonic`, `seed` …
 *   2. **Separator-suffix.** `user_wif`, `bip39_seed`,
 *      `trader.mnemonic` — name at the END of the key preceded by a
 *      separator.
 *   3. **Separator-prefix.** `wif_local`, `seed_phrase`,
 *      `mnemonic.phrase` — name at the START of the key followed by
 *      a separator.
 *
 * Plain substring matches (e.g. `wifey`, `seedling`, `public_stuff`)
 * are NOT redacted: a camelCase boundary alone is ambiguous between
 * `traderMnemonic` (intentional) and `wifey` (false positive), so we
 * require a separator. False negatives are cheaper than false
 * positives — an operator can spot a stray `wif` field that wasn't
 * redacted, but cannot un-redact a non-secret field that got mangled.
 *
 * IMPORTANT: the suffix rule first asserts `norm.endsWith(name)`
 * before checking the previous character, otherwise `public_stuff`
 * would be matched against `seed` because the character before the
 * non-existent `seed` substring happens to be `_`.
 *
 * Pure. Exposed indirectly via REDACTED_FIELD_NAMES.
 *
 * @param {string} k
 */
function isRedactedKey(k) {
  if (typeof k !== 'string' || k.length === 0) return false;
  const norm = k.toLowerCase();
  for (const name of REDACTED_FIELD_NAMES) {
    if (norm === name) return true;
    if (norm.length <= name.length) continue;
    // (2) separator-suffix: `user_wif`, `bip39_seed`, `trader.mnemonic`
    if (norm.endsWith(name)) {
      const prevChar = norm.charAt(norm.length - name.length - 1);
      if (prevChar === '_' || prevChar === '.') return true;
    }
    // (3) separator-prefix: `wif_local`, `seed_phrase`, `mnemonic.phrase`
    if (norm.startsWith(name + '_') || norm.startsWith(name + '.')) return true;
  }
  return false;
}

/**
 * Parse a human-friendly duration string into milliseconds. Accepts:
 *
 *   - '30s', '5m', '2h', '1d', '7d'       (suffix required)
 *   - 'all'                               (returns null — no time filter)
 *   - '' or 'NaN'                         (returns null)
 *
 * Throws `DashboardConfigError` on bad input. Pure.
 *
 * @param {string} range
 * @returns {number|null} milliseconds, or null for "no filter"
 */
export function rangeToMs(range) {
  if (typeof range !== 'string') {
    throw new DashboardConfigError(`rangeToMs: range must be a string; got ${typeof range}`);
  }
  const t = range.trim();
  if (t.length === 0 || t.toLowerCase() === 'all') return null;
  const m = /^(\d+)\s*([smhdw])$/i.exec(t);
  if (!m) {
    throw new DashboardConfigError(`rangeToMs: invalid range ${JSON.stringify(range)} (expected e.g. "7d", "30m", "1h", "all")`);
  }
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new DashboardConfigError(`rangeToMs: invalid range numeric ${m[1]}`);
  }
  const unit = m[2].toLowerCase();
  const mult =
    unit === 's' ? 1000 :
    unit === 'm' ? 60 * 1000 :
    unit === 'h' ? 60 * 60 * 1000 :
    unit === 'd' ? 24 * 60 * 60 * 1000 :
    /* 'w' */     7 * 24 * 60 * 60 * 1000;
  return n * mult;
}

/**
 * Parse the dashboard's `?range=` query string. Falls back to the
 * dashboard's configured `default_range`. Returns `null` for `'all'`.
 *
 * Pure. Exported for tests.
 *
 * @param {URLSearchParams|Object} qs
 * @param {string} defaultRange
 * @returns {number|null}
 */
export function parseRange(qs, defaultRange) {
  const raw = (qs instanceof URLSearchParams) ? qs.get('range') : (qs?.range ?? null);
  const range = raw != null && String(raw).length > 0 ? String(raw) : defaultRange;
  return rangeToMs(range);
}

/**
 * Coerce a limit query string to a positive integer capped at `max`.
 * Falls back to `max` when `qs.limit` is missing or unparseable.
 *
 * Pure. Exported for tests.
 *
 * @param {URLSearchParams|Object} qs
 * @param {number} max
 * @returns {number}
 */
export function parseLimit(qs, max) {
  const raw = (qs instanceof URLSearchParams) ? qs.get('limit') : (qs?.limit ?? null);
  if (raw === null || raw === undefined || String(raw).length === 0) return max;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) return max;
  return Math.min(n, max);
}

/**
 * Filter a list of NDJSON history events by `kind`, `sinceMs`, and
 * `limit`. Pure — exported for tests + reusable by future callers.
 *
 * @param {Array<Object>} events
 * @param {Object} [opts]
 * @param {string} [opts.kind]               e.g. 'entry', 'exit'
 * @param {number} [opts.sinceMs]            drop events with ts older than now-sinceMs
 * @param {number} [opts.limit=Infinity]
 * @returns {Array<Object>}
 */
export function filterHistory(events, opts = {}) {
  if (!Array.isArray(events)) return [];
  const sinceMs = Number.isFinite(opts.sinceMs) ? opts.sinceMs : null;
  const kind = typeof opts.kind === 'string' && opts.kind.length > 0 ? opts.kind : null;
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : Infinity;
  const out = [];
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    if (kind !== null) {
      const k = typeof e.kind === 'string' ? e.kind : null;
      if (k !== kind) continue;
    }
    if (sinceMs !== null) {
      const ts = Date.parse(typeof e.ts === 'string' ? e.ts : '');
      if (Number.isFinite(ts) && ts < sinceMs) continue;
      if (!Number.isFinite(ts)) continue;
    }
    out.push(e);
  }
  if (out.length > limit) {
    return out.slice(out.length - limit);
  }
  return out;
}

/**
 * Filter a list of snapshot records by `sinceMs` and `limit`.
 * Pure — exported for tests.
 *
 * @param {Array<Object>} records
 * @param {Object} [opts]
 * @param {number} [opts.sinceMs]
 * @param {number} [opts.limit=Infinity]
 * @param {string} [opts.tokenId]   scope to a single token
 * @returns {Array<Object>}
 */
export function filterSnapshots(records, opts = {}) {
  if (!Array.isArray(records)) return [];
  const sinceMs = Number.isFinite(opts.sinceMs) ? opts.sinceMs : null;
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : Infinity;
  const tokenId = typeof opts.tokenId === 'string' && opts.tokenId.length > 0 ? opts.tokenId : null;
  const out = [];
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    if (tokenId !== null) {
      const tid = typeof r.token_id === 'string' ? r.token_id : null;
      if (tid !== tokenId) continue;
    }
    if (sinceMs !== null) {
      const ts = Date.parse(typeof r.ts === 'string' ? r.ts : '');
      if (!Number.isFinite(ts)) continue;
      if (ts < sinceMs) continue;
    }
    out.push(r);
  }
  if (out.length > limit) {
    return out.slice(out.length - limit);
  }
  return out;
}

/**
 * Compute the dashboard's `/api/summary` body. Pulls together
 * positions, pnl, and the most-recent snapshot into one shape the
 * React UI can drop straight onto the DASHBOARD view.
 *
 * Pure in the sense that it never mutates inputs and never writes
 * — but it DOES call `ctx.positions.load()` (an async I/O) which
 * is fine for the handler but not for unit tests. Tests should
 * inject a pre-loaded `positions` mock OR call `summarize()` /
 * `computeUnrealized()` directly.
 *
 * @param {Object} ctx
 * @returns {Promise<Object>}
 */
export async function buildSummary(ctx) {
  if (!ctx || typeof ctx !== 'object') throw new DashboardConfigError('buildSummary: ctx required');
  const cfg = ctx.cfg ?? {};
  const positionsList = await ctx.positions.list('open');
  const pendingList = await ctx.positions.list('pending');
  const closingList = await ctx.positions.list('closing');
  const closedList = await ctx.positions.list('closed');
  /** @type {Array<Object>} */
  const allOpen = [...positionsList, ...pendingList, ...closingList];

  // Latest snapshot for live balance + unrealized P&L.
  let lastSnapshot = null;
  try {
    lastSnapshot = await ctx.snapshots.last();
  } catch (e) {
    // Soft fail — snapshot dir missing is normal on first run.
    if (!e || typeof e !== 'object' || /** @type {any} */ (e).code !== 'ENOENT') {
      throw e;
    }
  }

  // Live balance (optional — the wallet lives in the trader loop).
  // If `ctx.wallet` is wired, prefer its `getBalanceSats()` over the
  // last snapshot (it reflects right-now, not last-tick).
  let balanceSats = null;
  let balanceSource = null;
  if (ctx.wallet && typeof ctx.wallet.getBalanceSats === 'function') {
    try {
      balanceSats = await ctx.wallet.getBalanceSats();
      balanceSource = 'wallet';
    } catch (e) {
      ctx.logger.warn('dashboard.summary.balance.failed', {
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
      });
    }
  }
  if (balanceSats === null && lastSnapshot && lastSnapshot.bch_balance_sats !== null && lastSnapshot.bch_balance_sats !== undefined) {
    balanceSats = lastSnapshot.bch_balance_sats;
    balanceSource = 'snapshot';
  }

  const realizedSummary = summarize(closedList);
  const byToken = summarizeByToken(closedList);
  const bw = bestAndWorst(closedList);

  // Unrealized P&L via latest snapshot's market prices (best
  // approximation we have without round-tripping to the indexer).
  /** @type {Record<string, number|null>} */
  const marketPricesSats = {};
  let lastEntryPriceByPosition = null;
  if (lastSnapshot && Array.isArray(lastSnapshot.meta?.market_prices_sats)) {
    for (const row of lastSnapshot.meta.market_prices_sats) {
      if (row && typeof row === 'object' && typeof row.token_id === 'string') {
        marketPricesSats[row.token_id] = typeof row.price_sats_per_token === 'number' ? row.price_sats_per_token : null;
      }
    }
  } else {
    // Fallback: use entry.price_sats_per_token as the current price.
    // Not ideal, but it's what the snapshot CLI does and avoids a
    // 5s indexer roundtrip on every dashboard refresh.
    lastEntryPriceByPosition = 'entry';
  }

  // T28e: share the price-vs-entry ratio guard with the snapshot
  // path so the dashboard's summary endpoint doesn't silently emit
  // $20M+ of "unrealized gains" on tokens with a wildly-wrong
  // indexer price. Mirrors the T28d `shouldExit` fix.
  const maxPriceRatioX = (cfg.exit
    && Number.isFinite(Number(cfg.exit.max_price_vs_entry_ratio_x))
    && Number(cfg.exit.max_price_vs_entry_ratio_x) > 0)
    ? Number(cfg.exit.max_price_vs_entry_ratio_x)
    : null;
  const ratioOpt = maxPriceRatioX !== null ? { maxPriceRatioX } : null;

  let totalUnrealizedSats = 0n;
  let anyPriced = false;
  /** @type {Array<{ position_id: string, token_id: string, unrealized_pnl_sats: bigint|null, pct_return: number|null }>} */
  const perPositionUnrealized = [];
  for (const p of positionsList) {
    if (!p || typeof p !== 'object') continue;
    const tid = typeof p.token_id === 'string' ? p.token_id : null;
    const entryPrice = (typeof p?.entry?.price_sats_per_token === 'number' && Number.isFinite(p.entry.price_sats_per_token))
      ? p.entry.price_sats_per_token : null;
    const price = tid && Object.prototype.hasOwnProperty.call(marketPricesSats, tid)
      ? marketPricesSats[tid]
      : (lastEntryPriceByPosition === 'entry' ? entryPrice : null);
    if (price === null || price === undefined) {
      perPositionUnrealized.push({
        position_id: p?.id ?? null,
        token_id: tid,
        unrealized_pnl_sats: null,
        pct_return: null,
      });
      continue;
    }
    const u = unrealizedPnlSats(p, price, null, ratioOpt);
    if (u === null || u.net === null || u.net === undefined) {
      perPositionUnrealized.push({
        position_id: p?.id ?? null,
        token_id: tid,
        unrealized_pnl_sats: null,
        pct_return: null,
      });
      continue;
    }
    const net = typeof u.net === 'bigint' ? u.net : BigInt(u.net);
    totalUnrealizedSats += net;
    anyPriced = true;
    perPositionUnrealized.push({
      position_id: p?.id ?? null,
      token_id: tid,
      unrealized_pnl_sats: net,
      pct_return: typeof u.pct === 'number' ? u.pct * 100 : null,
    });
  }

  return {
    schema: 'tradebot.dashboard.summary/v1',
    ts: new Date().toISOString(),
    config: {
      tuning_preset: cfg.tuning_preset ?? null,
      network: cfg.wallet?.network ?? null,
      cashaddr: cfg.user?.wallet?.cashaddr ?? cfg.wallet?.address ?? null,
      max_position_bch: cfg.entry?.max_position_bch ?? null,
      max_total_exposure_bch: cfg.entry?.max_total_exposure_bch ?? null,
      min_wallet_balance_bch: cfg.risk?.min_wallet_balance_bch ?? null,
      loss_cooldown_minutes: cfg.risk?.loss_cooldown_minutes ?? null,
      slippage_tolerance_bps: cfg.entry?.slippage_tolerance_bps ?? null,
      volatility_sizing_target_pct: cfg.entry?.volatility_sizing_target_pct ?? null,
      correlation_skip_threshold: cfg.entry?.correlation_skip_threshold ?? null,
      min_pool_age_days: cfg.entry?.min_pool_age_days ?? null,
      // T38: dynamic TP/SL from 7d realized volatility.
      tp_vol_multiplier: cfg.exit?.tp_vol_multiplier ?? null,
      sl_vol_multiplier: cfg.exit?.sl_vol_multiplier ?? null,
      tp_vol_floor_pct: cfg.exit?.tp_vol_floor_pct ?? null,
      tp_vol_ceiling_pct: cfg.exit?.tp_vol_ceiling_pct ?? null,
      sl_vol_floor_pct: cfg.exit?.sl_vol_floor_pct ?? null,
      sl_vol_ceiling_pct: cfg.exit?.sl_vol_ceiling_pct ?? null,
      // T43: profit-floor gate.
      min_realized_pnl_sats: cfg.exit?.min_realized_pnl_sats ?? null,
      time_stop_extension_hours: cfg.exit?.time_stop_extension_hours ?? null,
      min_realized_pnl_enabled: cfg.exit?.min_realized_pnl_enabled ?? null,
      poll_interval_seconds: cfg.loop?.poll_interval_seconds ?? null,
    },
    balance: {
      bch_balance_sats: balanceSats === null ? null : String(balanceSats),
      bch_balance: balanceSats === null ? null : Number(balanceSats) / SATS_PER_BCH,
      source: balanceSource,
      last_snapshot_ts: lastSnapshot?.ts ?? null,
    },
    realized: {
      count: realizedSummary.count,
      wins: realizedSummary.wins,
      losses: realizedSummary.losses,
      breakeven: realizedSummary.breakeven,
      win_rate_pct: realizedSummary.win_rate_pct,
      realized_pnl_sats: realizedSummary.realized_pnl_sats.toString(),
      realized_pnl_bch: realizedSummary.realized_pnl_bch,
      total_fees_sats: realizedSummary.total_fees_sats.toString(),
      total_fees_bch: realizedSummary.total_fees_bch,
      mean_hold_ms: realizedSummary.mean_hold_ms,
      best_trade_sats: realizedSummary.best_trade_sats === null ? null : realizedSummary.best_trade_sats.toString(),
      worst_trade_sats: realizedSummary.worst_trade_sats === null ? null : realizedSummary.worst_trade_sats.toString(),
      pct_return: realizedSummary.pct_return,
    },
    unrealized: {
      open_position_count: positionsList.length,
      pending_count: pendingList.length,
      closing_count: closingList.length,
      total_unrealized_sats: anyPriced ? totalUnrealizedSats.toString() : null,
      total_unrealized_bch: anyPriced ? Number(totalUnrealizedSats) / SATS_PER_BCH : null,
      per_position: perPositionUnrealized,
    },
    by_token: Object.fromEntries(
      Object.entries(byToken).map(([tid, s]) => [
        tid,
        {
          count: s.count,
          wins: s.wins,
          losses: s.losses,
          win_rate_pct: s.win_rate_pct,
          realized_pnl_sats: s.realized_pnl_sats.toString(),
          realized_pnl_bch: s.realized_pnl_bch,
        },
      ]),
    ),
    best_trade: bw.best ? {
      position_id: bw.best.position?.id ?? null,
      token_id: bw.best.position?.token_id ?? null,
      token_symbol: typeof bw.best.position?.token_symbol === 'string' ? bw.best.position.token_symbol : null,
      closed_at: typeof bw.best.position?.closed_at === 'string' ? bw.best.position.closed_at : null,
      pnl_sats: bw.best.pnl_sats.toString(),
    } : null,
    worst_trade: bw.worst ? {
      position_id: bw.worst.position?.id ?? null,
      token_id: bw.worst.position?.token_id ?? null,
      token_symbol: typeof bw.worst.position?.token_symbol === 'string' ? bw.worst.position.token_symbol : null,
      closed_at: typeof bw.worst.position?.closed_at === 'string' ? bw.worst.position.closed_at : null,
      pnl_sats: bw.worst.pnl_sats.toString(),
    } : null,
  };
}

/**
 * List positions for the PORTFOLIO view. Supports `?status=open|all|
 * pending|closing|closed`. Pure-ish — delegates I/O to ctx.positions.
 *
 * @param {Object} ctx
 * @param {URL} url
 * @returns {Promise<Object>}
 */
async function listPositions(ctx, url) {
  const statusRaw = url.searchParams.get('status');
  const status = (statusRaw && statusRaw.length > 0) ? statusRaw : ctx.dashboardCfg.positions_default_status;
  /** @type {Array<Object>} */
  let positions;
  if (status === 'all') {
    const open = await ctx.positions.list('open');
    const pending = await ctx.positions.list('pending');
    const closing = await ctx.positions.list('closing');
    const closed = await ctx.positions.list('closed');
    positions = [...open, ...pending, ...closing, ...closed];
  } else if (status === 'open' || status === 'pending' || status === 'closing' || status === 'closed') {
    positions = await ctx.positions.list(/** @type {'open'|'pending'|'closing'|'closed'} */ (status));
  } else {
    return {
      schema: 'tradebot.dashboard.positions/v1',
      ts: new Date().toISOString(),
      error: `unknown status '${status}'`,
      valid: ['open', 'pending', 'closing', 'closed', 'all'],
      status,
      count: 0,
      positions: [],
    };
  }
  // O03 (idea_operator_position-prevent-stop-loss-with-profit-target_20260917):
  // enrich each open position with live BCH worth + % change vs
  // entry. Source the live price from the most-recent snapshot's
  // `meta.market_prices_sats` (same source `buildSummary` uses);
  // fall back to the entry price when no fresh snapshot exists
  // (which would make worth == spent and pct_change == 0 — a
  // safe fallback that the dashboard renders as '—' for the
  // green/red badge instead of a misleading number).
  /** @type {Record<string, number|null>} */
  const marketPricesSats = {};
  let lastSnapshot = null;
  try {
    lastSnapshot = await ctx.snapshots.last();
  } catch (_) { /* tolerate snapshot I/O failure */ }
  if (lastSnapshot && Array.isArray(lastSnapshot.meta?.market_prices_sats)) {
    for (const row of lastSnapshot.meta.market_prices_sats) {
      if (row && typeof row === 'object' && typeof row.token_id === 'string') {
        marketPricesSats[row.token_id] = typeof row.price_sats_per_token === 'number'
          ? row.price_sats_per_token
          : null;
      }
    }
  }
  const enriched = positions.map((p) => {
    const summary = summarizePosition(p);
    if (!summary) return null;
    // Only enrich open/pending/closing positions (closed ones have
    // a `realized_pnl_sats` field; adding a synthetic current_worth
    // on a closed position would be misleading).
    if (status === 'closed') return summary;
    const tokenId = summary.token_id;
    const entryBchSpentSats = summary.entry?.bch_spent_sats ?? null;
    const tokenAmountBase = summary.entry?.token_amount_base ?? null;
    const entryPriceSats = summary.entry?.price_sats_per_token ?? null;
    const currentPrice = (tokenId && Object.prototype.hasOwnProperty.call(marketPricesSats, tokenId))
      ? marketPricesSats[tokenId]
      : (entryPriceSats ?? null);
    const worthBch = computeCurrentWorthBch(currentPrice, tokenAmountBase);
    const pctChange = computePctChangeVsEntry(worthBch, entryBchSpentSats);
    // Wire field is `current_worth_sats` (string-encoded sat amount)
    // so it lines up with every other BCH amount on the wire
    // (entry.bch_spent_sats, fee_sats, bch_balance_sats, etc.) —
    // the dashboard's formatBch(sats) helper handles the sat→BCH
    // render. Previously this returned `current_worth_bch` as a
    // float and the dashboard passed it straight through
    // formatBch, which divides by 1e8 a SECOND time and renders
    // "0.00000000 BCH" for every position. See bug
    // bug-both-graphs-on-the-dashboard-dont-seem-to-reflect-positions-20260918.
    return {
      ...summary,
      current_worth_sats: (worthBch === null) ? null : Math.round(worthBch * SATS_PER_BCH).toString(),
      current_pct_change: pctChange,
      current_price_sats_per_token: currentPrice,
    };
  }).filter((p) => p !== null);

  return {
    schema: 'tradebot.dashboard.positions/v1',
    ts: new Date().toISOString(),
    status,
    count: enriched.length,
    positions: enriched,
  };
}

/**
 * O03: compute the current BCH worth of an open position from the
 * live per-base-unit price × the entry's base-unit token amount.
 * Returns `null` when any input is missing or non-positive (the
 * dashboard renders null as '—' instead of a misleading 0).
 *
 * Pure — exported for unit tests.
 *
 * @param {number|null|undefined} currentPriceSatsPerBase   sats per BASE unit
 * @param {string|number|null|undefined} tokenAmountBase     base-unit token amount
 * @returns {number|null}                                  BCH worth (float)
 */
export function computeCurrentWorthBch(currentPriceSatsPerBase, tokenAmountBase) {
  if (!Number.isFinite(currentPriceSatsPerBase) || currentPriceSatsPerBase <= 0) return null;
  // token_amount_base arrives as a string-encoded BigInt from the
  // positions store (positions.json serializes bigints as strings
  // to preserve precision). Coerce via Number() for the dashboard's
  // display layer; the per-token sats math is small enough that we
  // don't hit the float-precision wall (FURU max 16k tokens ×
  // ~500 sats/token ≈ 8M sats = 0.08 BCH — well within Number
  // precision).
  let amount;
  if (typeof tokenAmountBase === 'string' && tokenAmountBase.length > 0) {
    const n = Number(tokenAmountBase);
    amount = Number.isFinite(n) ? n : null;
  } else if (typeof tokenAmountBase === 'number' && Number.isFinite(tokenAmountBase)) {
    amount = tokenAmountBase;
  } else if (typeof tokenAmountBase === 'bigint') {
    amount = Number(tokenAmountBase);
  } else {
    amount = null;
  }
  if (amount === null || amount <= 0) return null;
  const worthSats = amount * currentPriceSatsPerBase;
  return worthSats / 100_000_000; // SATS_PER_BCH = 1e8
}

/**
 * O03: compute the % change of an open position's current BCH
 * worth vs the entry BCH spent. Returns null when either input is
 * missing (dashboard renders '—' for null pct_change).
 *
 * Pure — exported for unit tests.
 *
 * @param {number|null|undefined} currentWorthBch
 * @param {string|number|null|undefined} entryBchSpentSats   entry bch_spent_sats (string-encoded bigint)
 * @returns {number|null}                                   pct change vs entry (e.g. -10 = -10%)
 */
export function computePctChangeVsEntry(currentWorthBch, entryBchSpentSats) {
  if (!Number.isFinite(currentWorthBch)) return null;
  let spent;
  if (typeof entryBchSpentSats === 'string' && entryBchSpentSats.length > 0) {
    const n = Number(entryBchSpentSats);
    spent = Number.isFinite(n) ? n : null;
  } else if (typeof entryBchSpentSats === 'number' && Number.isFinite(entryBchSpentSats)) {
    spent = entryBchSpentSats;
  } else if (typeof entryBchSpentSats === 'bigint') {
    spent = Number(entryBchSpentSats);
  } else {
    spent = null;
  }
  if (spent === null || spent <= 0) return null;
  const entryBch = spent / 100_000_000; // SATS_PER_BCH = 1e8
  if (entryBch <= 0) return null;
  return ((currentWorthBch - entryBch) / entryBch) * 100;
}

/**
 * Project a position record to the dashboard's wire shape. Pulls
 * every field the PORTFOLIO view renders (entry reasoning included)
 * so the React UI doesn't have to know about the on-disk schema.
 *
 * Pure.
 *
 * @param {Object} p
 * @returns {Object}
 */
export function summarizePosition(p) {
  if (!p || typeof p !== 'object') return null;
  return {
    id: p.id ?? null,
    token_id: p.token_id ?? null,
    token_symbol: p.token_symbol ?? null,
    token_decimals: p.token_decimals ?? null,
    side: p.side ?? null,
    status: p.status ?? null,
    opened_at: p.opened_at ?? null,
    updated_at: p.updated_at ?? null,
    closed_at: p.closed_at ?? null,
    entry: p.entry && typeof p.entry === 'object' ? {
      txid: p.entry.txid ?? null,
      price_sats_per_token: p.entry.price_sats_per_token ?? null,
      bch_spent_sats: p.entry.bch_spent_sats ?? null,
      token_amount_base: p.entry.token_amount_base ?? null,
      fee_sats: p.entry.fee_sats ?? null,
      ts: p.entry.ts ?? null,
      broadcast_ms: p.entry.broadcast_ms ?? null,
    } : null,
    exit: p.exit && typeof p.exit === 'object' ? {
      txid: p.exit.txid ?? null,
      price_sats_per_token: p.exit.price_sats_per_token ?? null,
      bch_received_sats: p.exit.bch_received_sats ?? null,
      fee_sats: p.exit.fee_sats ?? null,
      ts: p.exit.ts ?? null,
      reason: p.exit.reason ?? null,
      realized_pnl_sats: p.exit.realized_pnl_sats ?? null,
    } : null,
    high_water_mark_sats_per_token: p.high_water_mark_sats_per_token ?? null,
    reasoning: p.reasoning ?? null,
    // O03 (idea_operator_position-prevent-stop-loss-with-profit-target_20260917):
    // expose the operator-set exit overrides on the wire so the
    // PORTFOLIO view can render the toggle + %-profit field from
    // the same payload it already loads.
    exit_overrides: (p.exit_overrides && typeof p.exit_overrides === 'object')
      ? {
          prevent_stop_loss: p.exit_overrides.prevent_stop_loss === true,
          profit_target_pct: Number.isFinite(Number(p.exit_overrides.profit_target_pct))
            ? Number(p.exit_overrides.profit_target_pct)
            : null,
          set_at: typeof p.exit_overrides.set_at === 'string' ? p.exit_overrides.set_at : null,
          cleared_at: typeof p.exit_overrides.cleared_at === 'string' ? p.exit_overrides.cleared_at : null,
          set_by: typeof p.exit_overrides.set_by === 'string' ? p.exit_overrides.set_by : null,
          cleared_by: typeof p.exit_overrides.cleared_by === 'string' ? p.exit_overrides.cleared_by : null,
        }
      : null,
  };
}

/**
 * O03 (idea_operator_position-prevent-stop-loss-with-profit-target_20260917):
 * PUT /api/positions/:id/overrides handler. Updates the
 * `prevent_stop_loss` toggle + `profit_target_pct` field on an
 * OPEN position. Closed positions are rejected (the override
 * would be meaningless after the position already exited).
 *
 * Body shape:
 *   { prevent_stop_loss: <bool>,
 *     profit_target_pct: <number|null>,
 *     set_by?: <string> }   // optional attribution for the audit log
 *
 * Response shape (200):
 *   { schema, ts, ok: true, position: <summarized position after write> }
 *
 * Error shapes:
 *   - 400 INVALID_BODY when `prevent_stop_loss` is not a bool or
 *     `profit_target_pct` is out of range.
 *   - 404 POSITION_NOT_FOUND when the id doesn't match any open position.
 *   - 409 POSITION_CLOSED when the id lives in closed[] (overrides
 *     only make sense on live positions).
 *
 * Validation rules delegate to
 * `src/portfolio/positions.mjs#applyOverrides` (the source of
 * truth for override-shape validation).
 *
 * @param {Object} ctx
 * @param {string} positionId
 * @param {Object} body
 * @returns {Promise<Object>}
 */
async function updatePositionOverrides(ctx, positionId, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {
      schema: 'tradebot.dashboard.position.overrides/v1',
      ts: new Date().toISOString(),
      ok: false,
      error: 'INVALID_BODY',
      message: 'request body must be a JSON object',
    };
  }
  if (typeof body.prevent_stop_loss !== 'boolean') {
    return {
      schema: 'tradebot.dashboard.position.overrides/v1',
      ts: new Date().toISOString(),
      ok: false,
      error: 'INVALID_BODY',
      message: 'prevent_stop_loss must be a boolean',
    };
  }
  // Defer range validation to applyOverrides (the canonical
  // source of truth). The class surfaces a typed PositionsConfigError
  // on bad values; we convert to INVALID_BODY here.
  let updated;
  try {
    updated = await ctx.positions.updateOverrides(positionId, {
      prevent_stop_loss: body.prevent_stop_loss,
      profit_target_pct: (body.profit_target_pct === null || body.profit_target_pct === undefined)
        ? body.profit_target_pct
        : Number(body.profit_target_pct),
      set_by: typeof body.set_by === 'string' ? body.set_by : 'dashboard',
    });
  } catch (e) {
    // PositionsNotFoundError / PositionsStateError / PositionsConfigError
    // — all subclass PositionsError. Map to the right HTTP status.
    if (e && e.name === 'PositionsNotFoundError') {
      return {
        schema: 'tradebot.dashboard.position.overrides/v1',
        ts: new Date().toISOString(),
        ok: false,
        error: 'POSITION_NOT_FOUND',
        message: e.message,
      };
    }
    if (e && e.name === 'PositionsStateError') {
      return {
        schema: 'tradebot.dashboard.position.overrides/v1',
        ts: new Date().toISOString(),
        ok: false,
        error: 'POSITION_CLOSED',
        message: e.message,
      };
    }
    if (e && e.name === 'PositionsConfigError') {
      return {
        schema: 'tradebot.dashboard.position.overrides/v1',
        ts: new Date().toISOString(),
        ok: false,
        error: 'INVALID_BODY',
        message: e.message,
      };
    }
    throw e; // unknown error — bubble to the server's 500 handler
  }
  return {
    schema: 'tradebot.dashboard.position.overrides/v1',
    ts: new Date().toISOString(),
    ok: true,
    position: summarizePosition(updated),
  };
}

/**
 * List history events for the DASHBOARD view. Supports
 * `?range=7d|30d|all` and `?kind=entry|exit|entry_failed|exit_failed|tick`
 * and `?limit=N`.
 *
 * @param {Object} ctx
 * @param {URL} url
 * @returns {Promise<Object>}
 */
async function listHistory(ctx, url) {
  const rangeMs = parseRange(url.searchParams, ctx.dashboardCfg.history_default_range);
  // parseRange returns a DURATION (e.g. 7d in ms); filterHistory
  // expects a TIMESTAMP (ms since epoch) — subtract from now.
  // Use the injected clock (defaults to Date.now) so tests can freeze
  // time and keep `?range=7d` assertions deterministic.
  const sinceMs = rangeMs === null ? null : ctx.clock() - rangeMs;
  const kind = url.searchParams.get('kind');
  const limit = parseLimit(url.searchParams, ctx.dashboardCfg.history_max_events);
  const out = await ctx.historyReader.read({
    sinceMs,
    kind: kind && kind.length > 0 ? kind : null,
    limit,
  });
  return {
    schema: 'tradebot.dashboard.history/v1',
    ts: new Date().toISOString(),
    range: rangeMs === null ? 'all' : `${Math.round(rangeMs / 1000)}s`,
    kind: kind && kind.length > 0 ? kind : null,
    limit,
    count: out.events.length,
    errors: out.errors ?? [],
    events: out.events,
  };
}

/**
 * T30c — research-cron-run history. Reuses the same NDJSON history
 * reader as `/api/history`, filtered to `kind:'research_cron_run'`.
 * Supports `?range=7d|30d|all` and `?limit=N`. Surfaces the last N
 * cron runs so the dashboard can show "last 5 cron runs" + "since
 * last research" without reading the script logs.
 *
 * @param {Object} ctx
 * @param {URL} url
 * @returns {Promise<Object>}
 */
async function listResearchRuns(ctx, url) {
  const rangeMs = parseRange(url.searchParams, 'all');
  // Same clock-injection pattern as listHistory — subtract the
  // duration from the injected clock so tests can freeze time.
  const sinceMs = rangeMs === null ? null : ctx.clock() - rangeMs;
  const limit = parseLimit(url.searchParams, ctx.dashboardCfg.research_runs_max_events);
  const out = await ctx.historyReader.read({
    sinceMs,
    kind: 'research_cron_run',
    limit,
  });
  return {
    schema: 'tradebot.dashboard.research-runs/v1',
    ts: new Date().toISOString(),
    range: rangeMs === null ? 'all' : `${Math.round(rangeMs / 1000)}s`,
    limit,
    count: out.events.length,
    errors: out.errors ?? [],
    events: out.events,
  };
}

/**
 * T42: flatten a list of positions (open + closed) into a stream
 * of "trade events" the dashboard can render in a flat table.
 *
 * Each closed position produces TWO events:
 *   - `kind:'entry'` stamped at `entry.ts`
 *   - `kind:'exit'`  stamped at `exit.ts`
 * Each open/pending/closing position produces ONE event:
 *   - `kind:'entry'` stamped at `entry.ts` (the position is still live
 *     so there is no exit to surface yet — same shape, exit fields
 *     are null, status carries `'open'|'pending'|'closing'` so the
 *     operator can filter on "live" if needed)
 *
 * Pure. Exported for tests.
 *
 * Output event shape:
 *   { kind, ts, token_id, token_symbol, side, position_id,
 *     status,           // 'open'|'pending'|'closing'|'closed'
 *     pnl_sign,         // 'gain'|'loss'|'flat'|null  (null for entry events)
 *     txid: { entry, exit } | null,
 *     amounts: {
 *       bch_spent_sats, bch_received_sats,
 *       token_amount_base, price_sats_per_token,
 *       entry_fee_sats, exit_fee_sats,
 *     },
 *     pnl: {
 *       realized_pnl_sats | null,
 *     },
 *     exit_reason: string | null,
 *   }
 *
 * The shape is intentionally flat (no nesting past `amounts` /
 * `pnl`) — the React table renders each field directly.
 *
 * @param {Array<Object>} positions
 * @returns {Array<Object>}
 */
export function flattenPositionsToTradeEvents(positions) {
  if (!Array.isArray(positions)) return [];
  /** @type {Array<Object>} */
  const events = [];
  for (const p of positions) {
    if (!p || typeof p !== 'object') continue;
    const id = typeof p.id === 'string' ? p.id : null;
    const tokenId = typeof p.token_id === 'string' ? p.token_id : null;
    const tokenSymbol = typeof p.token_symbol === 'string' ? p.token_symbol : null;
    const side = typeof p.side === 'string' ? p.side : null;
    const status = typeof p.status === 'string' ? p.status : null;
    const entry = (p.entry && typeof p.entry === 'object') ? p.entry : null;
    const exit = (p.exit && typeof p.exit === 'object') ? p.exit : null;

    if (entry) {
      const entryTs = typeof entry.ts === 'string' ? entry.ts : null;
      /** @type {Object} */
      const entryEvent = {
        kind: 'entry',
        ts: entryTs,
        token_id: tokenId,
        token_symbol: tokenSymbol,
        side,
        position_id: id,
        status,
        pnl_sign: null,
        txid: { entry: typeof entry.txid === 'string' ? entry.txid : null, exit: null },
        amounts: {
          bch_spent_sats: typeof entry.bch_spent_sats === 'number' ? entry.bch_spent_sats : null,
          bch_received_sats: null,
          token_amount_base: typeof entry.token_amount_base === 'string' || typeof entry.token_amount_base === 'number'
            ? String(entry.token_amount_base) : null,
          price_sats_per_token: typeof entry.price_sats_per_token === 'number' ? entry.price_sats_per_token : null,
          entry_fee_sats: typeof entry.fee_sats === 'number' ? entry.fee_sats : null,
          exit_fee_sats: null,
        },
        pnl: { realized_pnl_sats: null },
        exit_reason: null,
      };
      events.push(entryEvent);
    }

    if (exit) {
      const exitTs = typeof exit.ts === 'string' ? exit.ts : null;
      const realized = typeof exit.realized_pnl_sats === 'number' ? exit.realized_pnl_sats : null;
      /** @type {'gain'|'loss'|'flat'|null} */
      let pnlSign = null;
      if (typeof realized === 'number' && Number.isFinite(realized)) {
        if (realized > 0) pnlSign = 'gain';
        else if (realized < 0) pnlSign = 'loss';
        else pnlSign = 'flat';
      }
      /** @type {Object} */
      const exitEvent = {
        kind: 'exit',
        ts: exitTs,
        token_id: tokenId,
        token_symbol: tokenSymbol,
        side,
        position_id: id,
        status: 'closed',
        pnl_sign: pnlSign,
        txid: {
          entry: entry && typeof entry.txid === 'string' ? entry.txid : null,
          exit: typeof exit.txid === 'string' ? exit.txid : null,
        },
        amounts: {
          bch_spent_sats: entry && typeof entry.bch_spent_sats === 'number' ? entry.bch_spent_sats : null,
          bch_received_sats: typeof exit.bch_received_sats === 'number' ? exit.bch_received_sats : null,
          token_amount_base: entry && (typeof entry.token_amount_base === 'string' || typeof entry.token_amount_base === 'number')
            ? String(entry.token_amount_base) : null,
          price_sats_per_token: typeof exit.price_sats_per_token === 'number' ? exit.price_sats_per_token : null,
          entry_fee_sats: entry && typeof entry.fee_sats === 'number' ? entry.fee_sats : null,
          exit_fee_sats: typeof exit.fee_sats === 'number' ? exit.fee_sats : null,
        },
        pnl: { realized_pnl_sats: realized },
        exit_reason: typeof exit.reason === 'string' ? exit.reason : null,
      };
      events.push(exitEvent);
    }
  }
  // Stable sort by ts desc, with entry before exit at the same ts
  // (so a position's lifecycle is readable top-to-bottom in the
  // table even when both events land in the same ms).
  events.sort((a, b) => {
    const ta = Date.parse(typeof a.ts === 'string' ? a.ts : '');
    const tb = Date.parse(typeof b.ts === 'string' ? b.ts : '');
    const va = Number.isFinite(ta) ? ta : 0;
    const vb = Number.isFinite(tb) ? tb : 0;
    if (va !== vb) return vb - va;
    if (a.kind === b.kind) return 0;
    return a.kind === 'entry' ? -1 : 1;
  });
  return events;
}

/**
 * T42: filter a flat list of trade events by `event_kind`, `token_id`,
 * `side`, `since`/`until`, and `pnl` (sign of realized_pnl_sats on
 * exit events). Pure.
 *
 * `since` / `until` are MILLISECONDS-SINCE-EPOCH numbers (caller
 * pre-parses the ISO strings from the URL). Invalid `ts` on an event
 * drops it from the result when a time bound is in play; when no
 * time bound is active, events with bad `ts` are KEPT so a bug in
 * one record doesn't poison the whole table.
 *
 * @param {Array<Object>} events
 * @param {Object} [opts]
 * @param {string} [opts.eventKind]    'entry' | 'exit' | 'any' (default 'any')
 * @param {string} [opts.tokenId]      64-hex token id
 * @param {string} [opts.side]         'long_token' | ...
 * @param {number} [opts.sinceMs]
 * @param {number} [opts.untilMs]
 * @param {string} [opts.pnl]          'gain' | 'loss' | 'flat' | 'any' (default 'any')
 * @param {number} [opts.limit]        cap result size; keep newest-first
 * @returns {Array<Object>}
 */
export function filterTradeEvents(events, opts = {}) {
  if (!Array.isArray(events)) return [];
  const eventKind = typeof opts.eventKind === 'string' && opts.eventKind.length > 0 ? opts.eventKind : 'any';
  const tokenId = typeof opts.tokenId === 'string' && opts.tokenId.length > 0 ? opts.tokenId : null;
  const side = typeof opts.side === 'string' && opts.side.length > 0 ? opts.side : null;
  const pnl = typeof opts.pnl === 'string' && opts.pnl.length > 0 ? opts.pnl : 'any';
  const sinceMs = Number.isFinite(opts.sinceMs) ? opts.sinceMs : null;
  const untilMs = Number.isFinite(opts.untilMs) ? opts.untilMs : null;
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : Infinity;
  const timeBoundActive = sinceMs !== null || untilMs !== null;
  const out = [];
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    if (eventKind !== 'any' && e.kind !== eventKind) continue;
    if (tokenId !== null && e.token_id !== tokenId) continue;
    if (side !== null && e.side !== side) continue;
    if (pnl !== 'any') {
      // PNL filter only applies to exit events — entry events have
      // no realized P&L. The dashboard treats "pnl=gain" + an entry
      // event as a no-match (the entry itself doesn't tell you
      // whether the trade will profit).
      if (e.kind !== 'exit') continue;
      if (e.pnl_sign !== pnl) continue;
    }
    if (timeBoundActive) {
      const ts = Date.parse(typeof e.ts === 'string' ? e.ts : '');
      if (!Number.isFinite(ts)) continue;
      if (sinceMs !== null && ts < sinceMs) continue;
      if (untilMs !== null && ts > untilMs) continue;
    }
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * T42: parse the `/api/trade-history` query string into a
 * normalised filter object. Defaults are supplied by the caller
 * (typically `ctx.dashboardCfg.trade_history_default_range` and
 * `ctx.dashboardCfg.trade_history_max_events`).
 *
 * `?since` / `?until` accept the same `<int><s|m|h|d|w>` shape as
 * `?range=`. The URL schema is documented inline in the React view.
 *
 * Pure. Exported for tests.
 *
 * @param {URLSearchParams|Object} qs
 * @param {Object} [defaults]
 * @param {string} [defaults.defaultRange]   e.g. '30d'
 * @param {number} [defaults.maxEvents]
 * @returns {{
 *   range: string,         // echoed back in the response envelope
 *   sinceMs: number|null,  // ms-since-epoch floor (or null for unbounded)
 *   untilMs: number|null,  // ms-since-epoch ceiling (or null)
 *   tokenId: string|null,
 *   side: string|null,
 *   eventKind: 'entry'|'exit'|'any',
 *   pnl: 'gain'|'loss'|'flat'|'any',
 *   limit: number,
 * }}
 */
export function parseTradeHistoryFilters(qs, defaults = {}) {
  const get = (key) => (qs instanceof URLSearchParams ? qs.get(key) : (qs?.[key] ?? null));
  const defaultRange = typeof defaults.defaultRange === 'string' && defaults.defaultRange.length > 0
    ? defaults.defaultRange
    : '30d';
  const maxEvents = Number.isFinite(defaults.maxEvents) && defaults.maxEvents > 0
    ? Math.floor(defaults.maxEvents)
    : 2_000;

  // Range → sinceMs (NOT untilMs). `until` is a separate explicit
  // param so the operator can say "last 7d ending yesterday".
  // `parseRange` throws on invalid input — we catch and fall back
  // to the default range so a typo (?range=banana) never crashes
  // the route. The returned `range` field reflects the EFFECTIVE
  // range (after fall-through), not the raw input.
  const rawRange = get('range');
  const candidateRange = (typeof rawRange === 'string' && rawRange.length > 0) ? rawRange : defaultRange;
  let sinceDurationMs;
  let effectiveRange;
  try {
    sinceDurationMs = parseRange(qs instanceof URLSearchParams ? qs : { range: candidateRange }, defaultRange);
    effectiveRange = candidateRange;
  } catch (_e) {
    sinceDurationMs = parseRange({ range: defaultRange }, defaultRange);
    effectiveRange = defaultRange;
  }
  const clockNow = (defaults && typeof defaults.clock === 'function') ? defaults.clock() : Date.now();
  const sinceEpochMs = (sinceDurationMs === null) ? null : clockNow - sinceDurationMs;
  const rawUntil = get('until');
  let untilMs = null;
  if (typeof rawUntil === 'string' && rawUntil.length > 0) {
    let untilDur = null;
    try {
      untilDur = rangeToMs(rawUntil);
    } catch (_e) {
      untilDur = null;
    }
    untilMs = (untilDur === null) ? null : clockNow - untilDur;
  }

  const eventKindRaw = get('event_kind');
  let eventKind = 'any';
  if (eventKindRaw === 'entry' || eventKindRaw === 'exit' || eventKindRaw === 'any') {
    eventKind = eventKindRaw;
  }

  const pnlRaw = get('pnl');
  let pnl = 'any';
  if (pnlRaw === 'gain' || pnlRaw === 'loss' || pnlRaw === 'flat' || pnlRaw === 'any') {
    pnl = pnlRaw;
  }

  const tokenIdRaw = get('token_id');
  const tokenId = (typeof tokenIdRaw === 'string' && tokenIdRaw.length > 0) ? tokenIdRaw : null;

  const sideRaw = get('side');
  const side = (typeof sideRaw === 'string' && sideRaw.length > 0) ? sideRaw : null;

  const limit = parseLimit(qs, maxEvents);

  return {
    range: sinceDurationMs === null ? 'all' : effectiveRange,
    sinceMs: sinceEpochMs,
    untilMs,
    tokenId,
    side,
    eventKind,
    pnl,
    limit,
  };
}

/**
 * T88: list positions flagged as dust (or skipped from dust
 * evaluation) for the DustPositionsCard React tile. Delegates to
 * `src/dashboard/dust-positions.mjs#buildDustPositionsResponse`,
 * which threads the same `findDustPositions` pure helper the
 * trader loop uses on every tick. The dashboard math is therefore
 * byte-identical to the loop math — the operator can audit the
 * wire envelope against the `dust_position_auto_close` history
 * rows in `data/history.jsonl`.
 *
 * Optional query params:
 *   ?knob=<true|false>   override the configured knob for THIS
 *                        response only (operator preview affordance)
 *                        — does NOT mutate ctx.cfg.
 *
 * @param {Object} ctx
 * @param {URL} url
 * @returns {Promise<Object>}
 */
async function listDustPositions(ctx, url) {
  // Optional knob override (pure preview — never mutates ctx.cfg).
  let workingCtx = ctx;
  try {
    if (url && url.searchParams && url.searchParams.get('knob') === 'true'
        && ctx && ctx.cfg && typeof ctx.cfg === 'object') {
      const clonedCfg = JSON.parse(JSON.stringify(ctx.cfg));
      if (!clonedCfg.risk || typeof clonedCfg.risk !== 'object') clonedCfg.risk = {};
      clonedCfg.risk.dust_position_auto_close_enabled = true;
      workingCtx = { ...ctx, cfg: clonedCfg };
    }
  } catch {
    /* fall through — knob override is best-effort */
  }
  return buildDustPositionsResponse(workingCtx, { url });
}

/**
 * T42: list trade events for the dedicated TRADE HISTORY view.
 * Reads all open + closed positions, flattens them to entry/exit
 * events, then applies the URL-supplied filter set.
 *
 * @param {Object} ctx
 * @param {URL} url
 * @returns {Promise<Object>}
 */
async function listTradeHistory(ctx, url) {
  const filters = parseTradeHistoryFilters(url.searchParams, {
    defaultRange: ctx.dashboardCfg.trade_history_default_range,
    maxEvents: ctx.dashboardCfg.trade_history_max_events,
    clock: ctx.clock,
  });
  const [open, closed] = await Promise.all([
    ctx.positions.list('open'),
    ctx.positions.list('closed'),
  ]);
  const positions = [...open, ...closed];
  const events = flattenPositionsToTradeEvents(positions);
  const filtered = filterTradeEvents(events, {
    eventKind: filters.eventKind,
    tokenId: filters.tokenId,
    side: filters.side,
    sinceMs: filters.sinceMs,
    untilMs: filters.untilMs,
    pnl: filters.pnl,
    limit: filters.limit,
  });
  return {
    schema: 'tradebot.dashboard.trade-history/v1',
    ts: new Date().toISOString(),
    range: filters.range,
    since_ms: filters.sinceMs,
    until_ms: filters.untilMs,
    token_id: filters.tokenId,
    side: filters.side,
    event_kind: filters.eventKind,
    pnl: filters.pnl,
    limit: filters.limit,
    count: filtered.length,
    total_count: events.length,
    events: filtered,
  };
}

/**
 * T63: per-token trade log with P&L attribution. The operator-
 * observability affordance — before this endpoint the only way to
 * answer "what did the bot do with token X" was to grep
 * `data/history.jsonl` by hand. Subset 1 (this commit) ships the
 * per-token rollup list + single-token detail. Subset 2 (deferred)
 * will mount the React tile + drill-down.
 *
 * Query string:
 *   ?token_id=<64-hex>      → single-token detail (full
 *                              closed_trades[] + open_positions[])
 *   (omit)                  → rollup list (one row per token with
 *                              summary totals + win-rate + first/
 *                              last ts + open-position count).
 *                              Heavy attribution arrays are stripped
 *                              from rollup rows so the wire payload
 *                              stays small.
 *
 * Defensive contract:
 *   - missing token_id             → rollup list (200, even when empty)
 *   - malformed token_id (not 64-hex) → throws with statusCode=400
 *   - unknown token_id (no history, no positions) → throws with statusCode=404
 *   - non-array events / positions → throws TradeLogArgError →
 *     statusCode=400 BAD_QUERY
 *
 * The endpoint NEVER mutates state. Read-only — same auth model
 * as `/api/trade-history` + `/api/alerts/recent`.
 *
 * @param {Object} ctx
 * @param {URL} url
 * @returns {Promise<Object>}
 */
async function listTokensSummary(ctx, url) {
  const rawTokenId = url.searchParams.get('token_id');
  const tokenId = (typeof rawTokenId === 'string' && rawTokenId.length > 0) ? rawTokenId : null;
  if (tokenId !== null && !/^[0-9a-f]{64}$/i.test(tokenId)) {
    const e = new Error('token_id must be a 64-character hex string');
    e.statusCode = 400;
    e.code = 'BAD_TOKEN_ID';
    throw e;
  }
  const [open, closed, historyRes] = await Promise.all([
    ctx.positions.list('open'),
    ctx.positions.list('closed'),
    ctx.historyReader.read({ limit: 5_000 }).catch((err) => {
      // History read failures shouldn't blank the dashboard —
      // surface as an empty list with the error attached so the
      // UI can render a "history unavailable" pill.
      return { events: [], errors: [err?.message ?? String(err)] };
    }),
  ]);
  const positions = [...open, ...closed];
  const events = Array.isArray(historyRes?.events) ? historyRes.events : [];
  let payload;
  try {
    if (tokenId !== null) {
      const sum = buildPerTokenSummary({ events, positions, tokenId });
      if (sum.entry_count === 0 && sum.exit_count === 0 && sum.closed_trade_count === 0 && sum.open_position_count === 0) {
        const e = new Error(`no history found for token_id=${tokenId}`);
        e.statusCode = 404;
        e.code = 'TOKEN_NOT_FOUND';
        throw e;
      }
      payload = sum;
    } else {
      payload = listPerTokenSummaries({ events, positions });
    }
  } catch (err) {
    if (err instanceof TradeLogArgError) {
      const wrapped = new Error(`bad query: ${err.message}`);
      wrapped.statusCode = 400;
      wrapped.code = 'BAD_QUERY';
      wrapped.cause = err;
      throw wrapped;
    }
    throw err;
  }
  return {
    ts: new Date().toISOString(),
    token_id: tokenId,
    history_errors: historyRes?.errors ?? [],
    ...payload,
  };
}

/**
 * Per-token fee breakdown handler (T71).
 *
 * Mirrors the `listTokensSummary` shape but returns the
 * LP / tx / slippage split per token so the dashboard's
 * FeeBreakdownCard can render the fee composition + drill
 * into per-trade attribution.
 *
 * Query string:
 *   ?token_id=<64-hex>      → single-token detail (full
 *                              per-trade attribution array).
 *   (omit)                  → cross-token rollup (one row per
 *                              token with summary totals +
 *                              shares; heavy `trades[]` array
 *                              stripped). The cross-token
 *                              envelope ALSO carries a `totals`
 *                              aggregate so the dashboard's
 *                              rollup header shows the all-bot
 *                              fee composition.
 *
 * Defensive contract:
 *   - missing token_id             → rollup list (200, even when empty)
 *   - malformed token_id (not 64-hex) → throws with statusCode=400
 *   - unknown token_id (no positions + no events for that token)
 *                                    → throws with statusCode=404
 *   - non-array events / positions → throws FeeBreakdownArgError →
 *     statusCode=400 BAD_QUERY
 *
 * The endpoint NEVER mutates state. Read-only — same auth model
 * as `/api/tokens/summary` + `/api/trade-history` + `/api/alerts/recent`.
 *
 * Reads `ctx.cfg.scoring.fee_rate_bps` (default 30) so the
 * operator can tweak the LP fee assumption per-bot via the
 * scoring config without restarting.
 *
 * @param {Object} ctx
 * @param {URL} url
 * @returns {Promise<Object>}
 */
async function listFeesBreakdown(ctx, url) {
  const rawTokenId = url.searchParams.get('token_id');
  const tokenId = (typeof rawTokenId === 'string' && rawTokenId.length > 0) ? rawTokenId : null;
  if (tokenId !== null && !/^[0-9a-f]{64}$/i.test(tokenId)) {
    const e = new Error('token_id must be a 64-character hex string');
    e.statusCode = 400;
    e.code = 'BAD_TOKEN_ID';
    throw e;
  }
  const feeRateBps = ctx.cfg?.scoring?.fee_rate_bps ?? 30;
  const opts = { fee_rate_bps: feeRateBps };
  const [open, closed, historyRes] = await Promise.all([
    ctx.positions.list('open'),
    ctx.positions.list('closed'),
    ctx.historyReader.read({ limit: 5_000 }).catch((err) => {
      // History read failures shouldn't blank the dashboard —
      // surface as an empty list with the error attached so the
      // UI can render a "history unavailable" pill.
      return { events: [], errors: [err?.message ?? String(err)] };
    }),
  ]);
  const positions = [...open, ...closed];
  const events = Array.isArray(historyRes?.events) ? historyRes.events : [];
  let payload;
  try {
    if (tokenId !== null) {
      const sum = breakdownFeesForToken({ events, positions, tokenId, opts });
      if (sum.trade_count === 0) {
        const e = new Error(`no fees found for token_id=${tokenId}`);
        e.statusCode = 404;
        e.code = 'TOKEN_NOT_FOUND';
        throw e;
      }
      payload = sum;
    } else {
      payload = breakdownFeesAcrossTokens({ events, positions, opts });
    }
  } catch (err) {
    if (err instanceof FeeBreakdownArgError) {
      const wrapped = new Error(`bad query: ${err.message}`);
      wrapped.statusCode = 400;
      wrapped.code = 'BAD_QUERY';
      wrapped.cause = err;
      throw wrapped;
    }
    throw err;
  }
  return {
    ts: new Date().toISOString(),
    token_id: tokenId,
    fee_rate_bps: feeRateBps,
    history_errors: historyRes?.errors ?? [],
    ...payload,
  };
}

/**
 * List snapshot records for the DASHBOARD balance-over-time chart.
 * Supports `?range=30d|7d|all` and `?limit=N` and `?token_id=...`.
 *
 * @param {Object} ctx
 * @param {URL} url
 * @returns {Promise<Object>}
 */
async function listSnapshots(ctx, url) {
  const rangeMs = parseRange(url.searchParams, ctx.dashboardCfg.snapshot_default_range);
  // parseRange returns a DURATION (e.g. 30d in ms); filterSnapshots
  // expects a TIMESTAMP (ms since epoch) — subtract from the
  // injected clock (defaults to Date.now).
  const sinceMs = rangeMs === null ? null : ctx.clock() - rangeMs;
  const limit = parseLimit(url.searchParams, ctx.dashboardCfg.snapshots_max_records);
  const tokenId = url.searchParams.get('token_id');
  const out = await ctx.snapshots.readBack({ limit: ctx.dashboardCfg.snapshots_max_records });
  const records = filterSnapshots(out.records, {
    sinceMs,
    limit,
    tokenId: tokenId && tokenId.length > 0 ? tokenId : null,
  });
  return {
    schema: 'tradebot.dashboard.snapshots/v1',
    ts: new Date().toISOString(),
    range: rangeMs === null ? 'all' : `${Math.round(rangeMs / 1000)}s`,
    token_id: tokenId && tokenId.length > 0 ? tokenId : null,
    limit,
    count: records.length,
    errors: out.errors ?? [],
    records,
  };
}

/**
 * T64: read the pre-aggregated snapshot rollup envelope. Mirrors
 * `listSnapshots` for query-string shape (`?range=`, `?token_id=`)
 * but returns one envelope rather than the full record list. The
 * `SnapshotAggregator` cache (per-server-instance) keys on file
 * mtime so a fresh `data/snapshots/YYYY-MM-DD.jsonl` write from
 * the trader loop invalidates the cache on the next poll.
 *
 * Defensive: rangeMs is clamped to `rangeToMs`'s contract;
 * `sinceMs` falls back to `null` for `"all"`; token filter is
 * case-folded and only applied when 64-hex-shaped. Errors from
 * the aggregator bubble as HTTP 400 (config) or 500 (compute) —
 * both surface a typed envelope so the dashboard can render an
 * "aggregate failed" pill without crashing.
 *
 * @param {Object} ctx
 * @param {URL} url
 * @returns {Promise<Object>}
 */
async function listSnapshotsAggregate(ctx, url) {
  let rangeMs;
  try {
    rangeMs = parseRange(url.searchParams, ctx.dashboardCfg.snapshot_default_range);
  } catch (e) {
    // parseRange throws DashboardConfigError on bad input. Wrap
    // it in a SnapshotAggregatorConfigError so the route handler's
    // catch block maps it to HTTP 400 instead of 500.
    const msg = (e && typeof e === 'object' && typeof e.message === 'string')
      ? e.message
      : 'invalid range';
    throw new SnapshotAggregatorConfigError(msg, { kind: 'bad_range', cause: e });
  }
  const tokenIdRaw = url.searchParams.get('token_id');
  const tokenId = tokenIdRaw && tokenIdRaw.length > 0 ? tokenIdRaw : null;

  // Read once per call; the aggregator cache handles the case
  // where multiple auto-refreshes hit this endpoint inside the TTL.
  const out = await ctx.snapshots.readBack({ limit: ctx.dashboardCfg.snapshots_max_records });
  const records = Array.isArray(out.records) ? out.records : [];

  // Pull the directory mtime so the cache invalidates the moment
  // the trader loop writes a fresh snapshot-record file. The
  // Snapshots class doesn't expose a `dirMtimeMs` seam yet, so
  // thread `Date.now()` as a defensive placeholder — the cache
  // still works (TTL-based) but won't auto-invalidate on file
  // rollover. A future patch will add `dirMtimeMs()` to the
  // Snapshots class; the route handler stays unchanged.
  const aggregator = ctx.snapshotAggregator;
  if (!(aggregator instanceof SnapshotAggregator)) {
    return {
      schema: 'tradebot.dashboard.snapshots-aggregate/v1',
      ts: new Date().toISOString(),
      source: 'fresh',
      cache_age_ms: 0,
      mtime_ms: null,
      error: 'aggregator_unconfigured',
      message: 'SnapshotAggregator is not wired into ctx',
      range_ms: rangeMs,
      range_label: null,
      token_id: tokenId,
      bucket_count: 0,
      bucket_skipped: 0,
      balance_sats: { min: null, max: null, mean: null, latest: null, count: 0, skipped: 0, min_bch: null, max_bch: null, mean_bch: null, latest_bch: null },
      total_exposure_sats: { min: null, max: null, mean: null, latest: null, count: 0, skipped: 0, min_bch: null, max_bch: null, mean_bch: null, latest_bch: null },
      unrealized_pnl_sats: { min: null, max: null, mean: null, latest: null, count: 0, skipped: 0, min_bch: null, max_bch: null, mean_bch: null, latest_bch: null },
      open_position_count: { min: null, max: null, mean: null, latest: null, count: 0, skipped: 0 },
      drawdown_sats: null,
      drawdown_bch: null,
    };
  }

  const result = aggregator.compute({
    records,
    dir: ctx.snapshotsDir,
    mtimeMs: null,
    rangeMs,
    tokenId,
  });

  return buildAggregateResponseImpl(result.value, {
    source: result.cached ? 'cache' : 'fresh',
    cacheAgeMs: result.cacheAgeMs,
    mtimeMs: result.mtimeMs,
  });
}

/**
 * Read the circuit-breaker state for the SETTINGS view. If no
 * breaker is wired (the dashboard is independent of the trader
 * loop), return 503 instead of pretending we know the state.
 *
 * @param {Object} ctx
 * @returns {{ error: string }|Object}
 */
function readRisk(ctx) {
  if (!ctx.risk || typeof ctx.risk.state !== 'function') {
    return { error: 'risk state not available — circuit breaker is owned by the trader loop', code: 'NO_BREAKER' };
  }
  return {
    schema: 'tradebot.dashboard.risk/v1',
    ts: new Date().toISOString(),
    state: ctx.risk.state(),
  };
}

/**
 * T39: cumulative realized P&L over time, for the DASHBOARD's
 * "cumulative P&L" chart. Pulls every entry from
 * `positions.json#closed[]` and feeds it through
 * `buildPnlTimeseriesResponse` from `pnl-timeseries.mjs`. The
 * injected clock drives `?range=` windowing so the test suite can
 * freeze time.
 *
 * The `?limit=N` cap applies AFTER the cumulative computation so
 * the chart's first row always reflects the truthful "running
 * total at this close" — if you cap to N rows, you may be hiding
 * older rows from view but the cumulative sum is still anchored
 * to the operator-visible trades.
 *
 * @param {Object} ctx
 * @param {URL} url
 * @returns {Promise<Object>}
 */
async function listPnlTimeseries(ctx, url) {
  const rangeMs = parseRange(url.searchParams, ctx.dashboardCfg.pnl_timeseries_default_range);
  const sinceMs = rangeMs === null ? null : ctx.clock() - rangeMs;
  const limit = parseLimit(url.searchParams, ctx.dashboardCfg.pnl_timeseries_max_rows);
  const tokenRaw = url.searchParams.get('token_id');
  const tokenId = (tokenRaw && tokenRaw.length > 0) ? tokenRaw : null;
  const closedAll = await ctx.positions.list('closed');
  // Prefer `exit.ts` over `closed_at` for the chart's time axis:
  //   - `exit.ts`      is the recorded trade-broadcast timestamp
  //                     (what the operator actually cares about for
  //                     "when did this trade land").
  //   - `closed_at`    is the moment `positions.close()` wrote the
  //                     bookkeeping record — usually a few hundred ms
  //                     AFTER the actual on-chain close. For chart
  //                     time-axis accuracy we want exit.ts when set.
  // `positions.close()` overwrites `closed_at` with `new Date()` and
  // faithfully stores `exit.ts`, so the projection is always safe.
  const closed = closedAll.map((p) => {
    if (!p || typeof p !== 'object') return p;
    const exitTs = p?.exit?.ts;
    if (typeof exitTs === 'string' && exitTs.length > 0) {
      return { ...p, closed_at: exitTs };
    }
    return p;
  });
  const rangeLabel = (() => {
    const raw = url.searchParams.get('range');
    if (raw && raw.length > 0) return raw;
    return ctx.dashboardCfg.pnl_timeseries_default_range;
  })();
  /** @type {Array<any>} */
  const skipReasons = [];
  const skipLogger = (reason, p) => skipReasons.push({ reason, position_id: p?.id ?? null });
  const out = buildPnlTimeseriesResponse(closed, {
    sinceMs,
    rangeMs,
    rangeLabel,
    tokenId,
    onSkip: skipLogger,
  });
  // Apply the row limit only after the cumsum is anchored. Oldest
  // rows drop first so the operator sees the most recent trades.
  if (out.rows.length > limit) {
    out.rows = out.rows.slice(-limit);
  }
  out.limit = limit;
  out.skip_breakdown = skipReasons.reduce((acc, s) => {
    acc[s.reason] = (acc[s.reason] || 0) + 1;
    return acc;
  }, {});
  return out;
}

/**
 * Tail the most-recent history events + last snapshot for the
 * "live activity" indicator on the DASHBOARD view.
 *
 * @param {Object} ctx
 * @param {URL} url
 * @returns {Promise<Object>}
 */
async function readActivity(ctx, url) {
  const limit = parseLimit(url.searchParams, 25);
  const hist = await ctx.historyReader.read({ limit });
  let snap = null;
  try {
    snap = await ctx.snapshots.last();
  } catch { /* soft fail */ }
  return {
    schema: 'tradebot.dashboard.activity/v1',
    ts: new Date().toISOString(),
    last_snapshot: snap,
    last_events: hist.events.slice(-limit).reverse(),
  };
}

/**
 * T26c — single-token Paytaca BCMR lookup.
 *
 * The router has already validated `tokenId` (must be 64 hex
 * chars). We:
 *   1. surface a cache hit as `{ ok:true, record, cached:true }`
 *   2. on miss, ask the bcmrClient (handles network + retry +
 *      cache write)
 *   3. on `not_found` / network error, return a typed error so
 *      the React `TokenBadge` can show a graceful fallback.
 *
 * The bcmrClient is OPTIONAL — if the operator didn't wire one
 * up (e.g. running the dashboard in an air-gapped env), we return
 * `503 bcmr_not_configured` rather than crash.
 *
 * @param {Object} ctx
 * @param {string} tokenId
 * @returns {Promise<Object>}
 */
async function getTokenMetadata(ctx, tokenId) {
  if (!ctx.bcmrClient) {
    return { ok: false, error: 'bcmr_not_configured', status: 503 };
  }
  const cached = ctx.bcmrClient.cached(tokenId);
  if (cached) {
    return { ok: true, record: cached, cached: true };
  }
  const r = await ctx.bcmrClient.lookup(tokenId);
  if (!r.ok) {
    return { ok: false, error: r.error, status: r.status || 502 };
  }
  return { ok: true, record: r.record, cached: false };
}

/**
 * T45b: project a raw indexer discovery entry onto the shape the
 * manual-trade autocomplete wants. Pure — exported for tests so a
 * future change to `RawIndexerEntry` doesn't silently break the
 * UI.
 *
 * Indexer records carry their symbol/decimals inside a nested
 * `bcmr.token.{symbol,decimals}` object — but some pools don't
 * have an authchain commit (a missing `bcmr`), and a few carry a
 * top-level `display_symbol` / `display_name` for backwards-compat
 * with the older Paytaca-cached endpoint. The manual-trade UI
 * only needs `{token_id, symbol, decimals, name, tvl_sats,
 * volume_24h_bch}` so we collapse both shapes into one.
 *
 * `tvl_sats` / `trade_volume` come from the raw indexer record as
 * plain Numbers (sats) — we surface them as-is so the UI can
 * show "tvl: 12,345 sat" next to each option.
 *
 * @param {Object} entry  raw `RawIndexerEntry` from indexer
 * @returns {{ token_id: string, symbol: string|null, decimals: number|null, name: string|null, tvl_sats: number|null, trade_volume: number|null }}
 */
export function projectPoolOption(entry) {
  if (!entry || typeof entry !== 'object') {
    return { token_id: '', symbol: null, decimals: null, name: null, tvl_sats: null, trade_volume: null };
  }
  /** @type {any} */
  const e = entry;
  const tokenId = (typeof e.token_id === 'string') ? e.token_id : '';
  // Symbol priority: nested BCMR > top-level display_symbol > null.
  let symbol = null;
  if (e.bcmr && typeof e.bcmr === 'object' && e.bcmr.token && typeof e.bcmr.token.symbol === 'string') {
    symbol = e.bcmr.token.symbol;
  } else if (typeof e.display_symbol === 'string' && e.display_symbol.length > 0) {
    symbol = e.display_symbol;
  }
  let decimals = null;
  if (e.bcmr && typeof e.bcmr === 'object' && e.bcmr.token && Number.isFinite(e.bcmr.token.decimals)) {
    decimals = /** @type {number} */ (e.bcmr.token.decimals);
  }
  let name = null;
  if (e.bcmr && typeof e.bcmr === 'object' && typeof e.bcmr.name === 'string' && e.bcmr.name.length > 0) {
    name = e.bcmr.name;
  } else if (typeof e.display_name === 'string' && e.display_name.length > 0) {
    name = e.display_name;
  }
  return {
    token_id: tokenId,
    symbol,
    decimals,
    name,
    tvl_sats: Number.isFinite(e.tvl_sats) ? /** @type {number} */ (e.tvl_sats) : null,
    trade_volume: Number.isFinite(e.trade_volume) ? /** @type {number} */ (e.trade_volume) : null,
  };
}

/**
 * T45b: handler for `GET /api/pools/top`. Wraps the indexer
 * discovery list with the same `Fetcher.listTopTokens({...})`
 * cache the trader loop uses, then projects each raw entry onto
 * the autocomplete-friendly `{token_id, symbol, decimals, ...}`
 * shape via `projectPoolOption`.
 *
 * Query parameters:
 *   - `limit`  number in [1, 200] (default 50). Clamped server-
 *              side so a runaway client can't blow the indexer
 *              cache or the response size.
 *
 * Error model:
 *   - 503 `fetcher_not_configured`        no `ctx.fetcher` wired
 *   - 502 `fetcher_lookup_failed`         indexer threw / shape
 *                                          mismatch
 *
 * Response envelope:
 *   `{ schema, ts, limit, count, pools: [{token_id, symbol, ...}] }`
 *
 * @param {Object} ctx
 * @param {URL} url
 * @returns {Promise<Object>}
 */
async function getPoolsTop(ctx, url) {
  if (!ctx.fetcher || typeof ctx.fetcher.listTopTokens !== 'function') {
    return { ok: false, error: 'fetcher_not_configured', status: 503 };
  }
  const rawLimit = url.searchParams.get('limit');
  let limit = 50;
  if (rawLimit !== null && rawLimit.length > 0) {
    const parsed = Number(rawLimit);
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 200) {
      limit = Math.floor(parsed);
    } else {
      return { ok: false, error: 'limit must be an integer in [1, 200]', status: 400, code: 'BAD_LIMIT' };
    }
  }
  /** @type {any[]} */
  let rawList;
  try {
    rawList = await ctx.fetcher.listTopTokens({ by: 'tvl', order: 'desc', limit });
  } catch (e) {
    ctx.logger.warn('dashboard.pools.top.failed', {
      err_name: e?.name ?? 'Error',
      err_message: e?.message ?? String(e),
      limit,
    });
    return { ok: false, error: `indexer lookup failed: ${e?.message ?? String(e)}`, status: 502, code: 'FETCHER_LOOKUP_FAILED' };
  }
  if (!Array.isArray(rawList)) {
    return { ok: false, error: 'indexer returned a non-array response', status: 502, code: 'FETCHER_SHAPE_INVALID' };
  }
  const pools = rawList.map(projectPoolOption).filter((p) => p.token_id.length === 64);
  return {
    schema: 'tradebot.dashboard.pools.top/v1',
    ts: new Date().toISOString(),
    limit,
    count: pools.length,
    pools,
  };
}

/**
 * T27e: live on-chain wallet state.
 *
 * Reads:
 *   - BCH balance via `ctx.wallet.getBalanceSats()`
 *   - UTXO set via `ctx.wallet.listUtxos()`
 * Aggregates fungible-token UTXOs by category so the frontend
 * can show one badge per held token, regardless of how many dust
 * UTXOs back it.
 *
 * Returns 503 if no wallet is wired (e.g. operator launched the
 * dashboard with `--no-wallet`). Soft-fails to a typed error on
 * any Electrum connectivity issue — the frontend falls back to a
 * small "unavailable" pill rather than blanking the whole page.
 *
 * @param {Object} ctx
 * @returns {Promise<Object>}
 */
/**
 * T47: positions-vs-chain reconciliation handler.
 *
 * Reads the bot's open positions via `ctx.positions.list('open')`
 * and the wallet's live UTXO set via `ctx.wallet.listUtxos()`,
 * runs the pure diff helper, and returns the report. NEVER writes
 * to `data/positions.json` — the operator inspects the findings
 * and runs the recommended remediation script manually.
 *
 * Error model:
 *   - `wallet_not_configured`     → 503 (no `ctx.wallet` wired)
 *   - `positions_not_configured`  → 503 (no `ctx.positions` wired)
 *   - `wallet_utxo_lookup_failed` → 502 (Electrum failure)
 *   - `positions_read_failed`     → 502 (positions.json malformed)
 *
 * The response envelope is `schema: 'tradebot.dashboard.reconcile.pvc/v1'`
 * so the frontend (and any future cron consumer) can version-check
 * before parsing.
 *
 * @param {Object} ctx
 * @returns {Promise<Object>}
 */
async function getReconcilePositionsVsChain(ctx) {
  if (!ctx.wallet || typeof ctx.wallet.listUtxos !== 'function') {
    return { ok: false, error: 'wallet_not_configured', status: 503 };
  }
  if (!ctx.positions || typeof ctx.positions.list !== 'function') {
    return { ok: false, error: 'positions_not_configured', status: 503 };
  }
  let openPositions;
  try {
    openPositions = await ctx.positions.list('open');
  } catch (e) {
    ctx.logger.warn('dashboard.reconcile.pvc.positions.failed', {
      err_name: e?.name ?? 'Error',
      err_message: e?.message ?? String(e),
    });
    return { ok: false, error: 'positions_read_failed', status: 502 };
  }
  let utxos;
  try {
    utxos = await ctx.wallet.listUtxos();
  } catch (e) {
    ctx.logger.warn('dashboard.reconcile.pvc.wallet.failed', {
      err_name: e?.name ?? 'Error',
      err_message: e?.message ?? String(e),
    });
    return { ok: false, error: 'wallet_utxo_lookup_failed', status: 502 };
  }
  const report = diffPositionsVsChainImpl(openPositions, utxos, {
    generatedAt: new Date().toISOString(),
  });
  ctx.logger.info('dashboard.reconcile.pvc.done', {
    open_positions: report.summary.open_positions,
    on_chain_tokens: report.summary.on_chain_tokens,
    findings: report.summary.findings,
    high: report.summary.high,
    medium: report.summary.medium,
    low: report.summary.low,
  });
  return {
    schema: 'tradebot.dashboard.reconcile.pvc/v1',
    version: RECONCILE_REPORT_VERSION,
    ts: report.generated_at,
    ok: true,
    summary: report.summary,
    findings: report.findings,
  };
}

async function getWalletBalance(ctx) {
  if (!ctx.wallet || typeof ctx.wallet.getAddress !== 'function') {
    return { ok: false, error: 'wallet_not_configured', status: 503 };
  }
  const address = ctx.wallet.getAddress();
  let bchBalanceSats = null;
  let utxos = [];
  try {
    bchBalanceSats = await ctx.wallet.getBalanceSats();
  } catch (e) {
    ctx.logger.warn('dashboard.wallet.balance.failed', {
      err_name: e?.name ?? 'Error',
      err_message: e?.message ?? String(e),
    });
    return { ok: false, error: 'balance_lookup_failed', status: 502 };
  }
  try {
    utxos = await ctx.wallet.listUtxos();
  } catch (e) {
    ctx.logger.warn('dashboard.wallet.listUtxos.failed', {
      err_name: e?.name ?? 'Error',
      err_message: e?.message ?? String(e),
    });
    // BCH balance succeeded; return what we have with an empty token list.
  }
  // Aggregate fungible-token UTXOs by category.
  const byCategory = new Map();
  for (const u of utxos) {
    if (!u || !u.token || typeof u.token.category !== 'string') continue;
    const cat = String(u.token.category).toLowerCase();
    if (cat.length !== 64) continue;
    const amt = (typeof u.token.amount === 'bigint')
      ? u.token.amount
      : (typeof u.token.amount === 'string' ? BigInt(u.token.amount) : (typeof u.token.amount === 'number' ? BigInt(u.token.amount) : 0n));
    if (!byCategory.has(cat)) {
      byCategory.set(cat, { token_id: cat, total_amount: 0n, utxo_count: 0 });
    }
    const e = byCategory.get(cat);
    e.total_amount += amt;
    e.utxo_count += 1;
  }
  // Enrich each held token with its BCMR metadata (symbol /
  // name / decimals) so the frontend can render amounts in
  // human-readable units (e.g. "5,070.44 OLA" instead of raw
  // "507044" base units). The bcmrClient has a 1h in-memory cache
  // so a refresh from the UI doesn't re-hit the registry for
  // already-seen tokens.
  //
  // Failure handling: a BCMR miss / network error on a single
  // token must NOT blank the whole balance response — degrade to
  // `decimals: null, symbol: null, name: null` so the frontend can
  // still render the raw base-unit fallback. Each lookup is
  // wrapped in try/catch so an unexpected exception (e.g. cache
  // corruption) doesn't bubble up and 500 the request.
  const aggregated = [...byCategory.values()];
  const enrichedTokens = await Promise.all(aggregated.map(async (t) => {
    const base = {
      token_id: t.token_id,
      total_amount: t.total_amount.toString(),
      utxo_count: t.utxo_count,
      decimals: null,
      symbol: null,
      name: null,
    };
    if (!ctx.bcmrClient || typeof ctx.bcmrClient.cached !== 'function') return base;
    try {
      let record = ctx.bcmrClient.cached(t.token_id);
      if (!record) {
        const r = await ctx.bcmrClient.lookup(t.token_id);
        if (r && r.ok && r.record) record = r.record;
      }
      if (record && typeof record === 'object') {
        base.decimals = (typeof record.decimals === 'number' && Number.isFinite(record.decimals))
          ? record.decimals
          : null;
        base.symbol = (typeof record.symbol === 'string' && record.symbol.length > 0) ? record.symbol : null;
        base.name = (typeof record.name === 'string' && record.name.length > 0) ? record.name : null;
      }
    } catch (_e) {
      // Swallow — base values already default to null. The
      // operator gets the raw base-unit amount and a degraded
      // (token_id-only) badge, not a 500.
    }
    return base;
  }));
  return {
    schema: 'tradebot.dashboard.wallet.balance/v1',
    ts: new Date().toISOString(),
    ok: true,
    address,
    network: ctx.cfg?.wallet?.network ?? 'mainnet',
    bch_balance_sats: bchBalanceSats.toString(),
    bch_utxo_count: utxos.filter((u) => !u?.token).length,
    tokens: enrichedTokens,
  };
}

/**
 * T25b: build the per-tick decision tree for the REASONING view.
 *
 * Reads the last N tick events from history.jsonl, then attaches
 * every per-candidate event (`entry_*` / `exit_*`) that occurred
 * between that tick and the previous one. Output is a list of
 * `ticks`, each holding its `tick` summary + a flat `decisions`
 * array sorted by rank (then by ts).
 *
 * Pure-ish (only depends on `ctx.historyReader`); the heavy work is
 * delegated to `groupReasoningEvents`, which is exported for tests.
 *
 * @param {Object} ctx
 * @param {URL} url
 * @returns {Promise<Object>}
 */
async function listReasoning(ctx, url) {
  const maxTicks = parseLimit(url.searchParams, ctx.dashboardCfg.reasoning_max_ticks);
  const maxDecisions = parseLimit(url.searchParams, ctx.dashboardCfg.reasoning_decisions_per_tick);
  // Over-fetch so the per-tick grouping has enough candidates.
  // ~30 events per tick in the worst case (3 candidates × 10 each);
  // multiply by maxTicks and add headroom for the tick events themselves.
  const fetchLimit = Math.max(maxDecisions * maxTicks + maxTicks * 2, 200);
  const hist = await ctx.historyReader.read({ limit: fetchLimit });
  const ticks = groupReasoningEvents(hist.events, {
    maxTicks,
    maxDecisionsPerTick: maxDecisions,
  });
  return {
    schema: 'tradebot.dashboard.reasoning/v1',
    ts: new Date().toISOString(),
    limit: maxTicks,
    decisions_per_tick: maxDecisions,
    count: ticks.length,
    ticks,
    errors: hist.errors ?? [],
  };
}

/**
 * Group raw history events into per-tick decision trees.
 *
 * The trading loop emits a `tick` summary plus N per-candidate
 * events (entry_skipped, entry_rejected, entry_executed,
 * exit_executed, etc.) inside a tight time window (~1s). We group
 * deterministically by timestamp: every decision event whose `ts`
 * falls in `[tickTs, nextTickTs)` is attached to that tick,
 * newest-first.
 *
 * Time-based bucketing (not array-index based) — robust against
 * out-of-order writes from concurrent loops + clock skew. Pure,
 * exported for tests.
 *
 * @param {Array<Object>} events
 * @param {Object} [opts]
 * @param {number} [opts.maxTicks=5]
 * @param {number} [opts.maxDecisionsPerTick=20]
 * @returns {Array<{ ts: string, tick: Object, decisions: Array<Object> }>}
 */
export function groupReasoningEvents(events, opts = {}) {
  if (!Array.isArray(events)) return [];
  const maxTicks = Number.isFinite(opts.maxTicks) && opts.maxTicks > 0 ? Math.floor(opts.maxTicks) : 5;
  const maxDecisionsPerTick = Number.isFinite(opts.maxDecisionsPerTick) && opts.maxDecisionsPerTick > 0
    ? Math.floor(opts.maxDecisionsPerTick)
    : 20;
  // Index every event by parseable ts (NaN => dropped). We do this
  // once so each tick's bucket lookup is O(N) total across all
  // ticks, not O(N²).
  const enriched = [];
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    const ts = typeof e.ts === 'string' ? e.ts : null;
    const tsMs = ts !== null ? Date.parse(ts) : NaN;
    enriched.push({ e, ts, tsMs });
  }
  // Find all tick events, newest first (by ts).
  const tickRows = enriched.filter((r) => r.e.kind === 'tick');
  tickRows.sort((a, b) => {
    const aMs = Number.isFinite(a.tsMs) ? a.tsMs : 0;
    const bMs = Number.isFinite(b.tsMs) ? b.tsMs : 0;
    return bMs - aMs;
  });
  if (tickRows.length === 0) return [];
  const picked = tickRows.slice(0, maxTicks);
  // All candidate events, sorted by ts asc (oldest first) so we
  // can stop scanning once we cross into the next tick's bucket.
  const decisionRows = enriched
    .filter((r) => {
      const k = typeof r.e.kind === 'string' ? r.e.kind : '';
      return k.startsWith('entry_') || k.startsWith('exit_');
    })
    .sort((a, b) => {
      const aMs = Number.isFinite(a.tsMs) ? a.tsMs : 0;
      const bMs = Number.isFinite(b.tsMs) ? b.tsMs : 0;
      return aMs - bMs;
    });
  // For each picked tick, bucket decisions whose ts falls in
  // `[tickTsMs, newerTickTsMs)`. `picked` is sorted newest first, so
  // the upper bound for `picked[t]` is `picked[t - 1].tsMs` (the
  // next-newer tick) — or `+∞` for `t = 0` (no newer tick exists).
  const out = [];
  for (let t = 0; t < picked.length; t++) {
    const tickRow = picked[t];
    const tickTsMs = tickRow.tsMs;
    const newerTickMs = t > 0 ? picked[t - 1].tsMs : Infinity;
    const decisions = [];
    for (const r of decisionRows) {
      // Only count decisions whose ts is parseable — unparseable
      // ts can't be bucketed, so we drop them.
      if (!Number.isFinite(r.tsMs)) continue;
      if (r.tsMs < tickTsMs) continue;        // older than this tick
      if (r.tsMs >= newerTickMs) break;        // crossed into newer tick (decisionRows is ts-asc)
      decisions.push(r.e);
      if (decisions.length >= maxDecisionsPerTick) break;
    }
    // Sort decisions by rank asc (best first), then ts asc, then kind.
    decisions.sort((a, b) => {
      const ar = Number.isFinite(a.rank) ? a.rank : Number.POSITIVE_INFINITY;
      const br = Number.isFinite(b.rank) ? b.rank : Number.POSITIVE_INFINITY;
      if (ar !== br) return ar - br;
      const at = typeof a.ts === 'string' ? Date.parse(a.ts) : 0;
      const bt = typeof b.ts === 'string' ? Date.parse(b.ts) : 0;
      if (at !== bt) return at - bt;
      return String(a.kind ?? '').localeCompare(String(b.kind ?? ''));
    });
    out.push({ ts: tickRow.ts, tick: tickRow.e, decisions });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
//  Write endpoints
// ─────────────────────────────────────────────────────────────────────

/**
 * `PUT /api/config` — merge the JSON body onto `config/user.json`
 * atomically. Refuses with 503 if `cfg.dashboard.api_token` is not
 * configured (the safe default — see DEFAULT_DASHBOARD_CONFIG).
 *
 * Body shape: any subset of `config/default.json`'s keys. We
 * deep-merge onto the existing `user.json` so the operator's
 * other overrides (WIF, mnemonic, custom indexer URL, etc.) are
 * preserved.
 *
 * @param {Object} ctx
 * @param {Object} body
 * @returns {Promise<Object>}
 */
async function updateConfig(ctx, body) {
  if (!ctx.dashboardCfg.api_token || typeof ctx.dashboardCfg.api_token !== 'string' || ctx.dashboardCfg.api_token.length === 0) {
    return { error: 'dashboard write endpoints are disabled — set dashboard.api_token in user.json to enable', code: 'AUTH_NOT_CONFIGURED' };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'body must be a JSON object', code: 'BAD_BODY' };
  }
  // Belt-and-braces: refuse any field that looks like a redaction
  // target, even if the token is valid. Settings edits should never
  // carry secrets in their body.
  const result = walkAndReject(body, ctx.logger);
  if (result.rejected.length > 0) {
    return {
      error: `refusing to persist secret-looking fields: ${result.rejected.join(', ')}`,
      code: 'SECRETS_NOT_ALLOWED',
    };
  }
  // Read the existing user.json (might be absent — that's fine).
  /** @type {Object} */
  let existing = {};
  try {
    if (ctx.cfg.paths && ctx.cfg.paths.user) {
      existing = await ctx.readUserJson(ctx.cfg.paths.user);
    }
  } catch (e) {
    return {
      error: `failed to read user.json: ${e?.message ?? e}`,
      code: 'USER_JSON_READ_FAILED',
    };
  }
  const merged = deepMerge(existing ?? {}, body);
  const userPath = ctx.cfg.paths?.user ?? DEFAULT_DASHBOARD_USER_JSON;
  try {
    // Coerce null → undefined so atomic-write helpers fall back to
    // the default `node:fs/promises` (their `fs = fsp` parameter
    // only triggers when `fs === undefined`, not when it's `null`).
    const fsImpl = ctx.fs ?? undefined;
    await ensureDirForFile(userPath, fsImpl);
    await atomicWriteJson(userPath, merged, fsImpl);
  } catch (e) {
    return {
      error: `failed to write user.json: ${e?.message ?? e}`,
      code: 'USER_JSON_WRITE_FAILED',
    };
  }
  // Surface the FULL set of leaf knobs the operator touched, so
    // the audit log + dashboard UI can show exactly which settings
    // changed. A top-level `dashboard: { bind_port: 9999 }` patch
    // reports `bind_port`, not the parent `dashboard` branch.
  const keysWritten = flattenKeys(body);

  // Bug fix: ctx.cfg was loaded ONCE at boot from default+user.json,
  // and the per-endpoint readers (`/api/staking/status`,
  // `/api/config`, etc.) consume `ctx.cfg.*` directly. Without this
  // merge, a successful PUT would persist to disk but `ctx.cfg` would
  // keep returning the old values — so the React toggle flow would
  // show "→ true" (success toast) and then `refresh()` would re-fetch
  // the stale `ctx.cfg.staking.*` and the UI would appear unchanged.
  // Merge the patch into ctx.cfg so the next read reflects the new
  // state immediately (no restart needed). We also re-stamp the
  // `user` block so `cfg.user.staking.auto_lock_enabled` reads stay
  // in lockstep with the on-disk user.json (this matters for any
  // consumer that walks `cfg.user` rather than `cfg` directly).
  ctx.cfg = deepMerge(ctx.cfg, merged);
  if (ctx.cfg && (!('user' in ctx.cfg) || ctx.cfg.user === null)) {
    ctx.cfg.user = merged;
  }

  ctx.logger.info('dashboard.config.updated', {
    user_path: userPath,
    keys_written: keysWritten,
    rejected: result.rejected,
  });
  return {
    schema: 'tradebot.dashboard.config.update/v1',
    ts: new Date().toISOString(),
    user_path: userPath,
    merged: redactConfig(merged),
    keys_written: keysWritten,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  T43c-server: per-knob restart-aware patch endpoint
// ─────────────────────────────────────────────────────────────────────

/**
 * T43c-server: default on-disk location for the bot PID file
 * (where `scripts/run-bot.mjs` writes `process.pid` on boot).
 * Mirrors `DEFAULT_RUN_PID_FILE` in `scripts/run-bot.mjs`; both
 * files export the constant independently so neither side needs
 * to import from the other (the dashboard is a generic HTTP
 * service, not bot-specific).
 */
export const DEFAULT_DASHBOARD_PID_FILE = 'data/run.pid';

/**
 * T43c-server: read the value at dotted `path` inside `obj`.
 * Returns `undefined` when any intermediate branch is missing.
 * Pure — exported for tests + `patchConfigKnob`.
 *
 * @param {unknown} obj
 * @param {string} path
 * @returns {unknown}
 */
export function readPathValue(obj, path) {
  if (!obj || typeof obj !== 'object') return undefined;
  const segs = String(path).split('.').filter((s) => s.length > 0);
  let cur = obj;
  for (const seg of segs) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = /** @type {any} */ (cur)[seg];
  }
  return cur;
}

/**
 * T43c-server: set the value at dotted `path` inside `obj`,
 * creating intermediate branches as plain objects. Mutates `obj`
 * in place AND returns it. Throws when an intermediate branch is
 * a non-object (e.g. the operator tries to set
 * `entry.max_position_bch.x` but `max_position_bch` is a number).
 * Pure helper modulo the mutation — exported for tests.
 *
 * @param {Object} obj
 * @param {string} path
 * @param {unknown} value
 * @returns {Object}
 */
export function setPathValue(obj, path, value) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new DashboardConfigError(`setPathValue: obj must be a plain object; got ${typeof obj}`);
  }
  const segs = String(path).split('.').filter((s) => s.length > 0);
  if (segs.length === 0) {
    throw new DashboardConfigError(`setPathValue: empty path`);
  }
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    const next = /** @type {any} */ (cur)[seg];
    if (next === null || next === undefined) {
      const fresh = /** @type {any} */ ({});
      cur[seg] = fresh;
      cur = fresh;
    } else if (typeof next !== 'object' || Array.isArray(next)) {
      throw new DashboardConfigError(
        `setPathValue: cannot traverse ${path} — segment "${seg}" is ${typeof next === 'object' ? (Array.isArray(next) ? 'array' : typeof next) : typeof next}`,
      );
    } else {
      cur = next;
    }
  }
  cur[segs[segs.length - 1]] = value;
  return obj;
}

/**
 * T43c-server: send `signalName` to `pid` via `process.kill`.
 * Returns `{ok:true, signal, pid}` on success or
 * `{ok:false, error, code}` on failure. Never throws — the
 * endpoint needs a typed failure, not an exception, so the
 * dashboard can show the operator WHY the signal failed
 * (e.g. bot isn't running, wrong PID, no perms).
 *
 * Pure-ish: calls `process.kill(pid, 0)` to probe liveness BEFORE
 * sending the real signal. If the probe says the process is
 * gone, the real signal is skipped (kill returns ESRCH and the
 * caller gets a clearer "bot not running" message).
 *
 * @param {Object} args
 * @param {number} args.pid
 * @param {string} [args.signal='SIGUSR1']
 * @param {Function} [args.kill=process.kill]   test seam
 * @returns {{ ok: boolean, pid: number, signal: string, error?: string, code?: string }}
 */
export function signalBotPid({ pid, signal = 'SIGUSR1', kill = process.kill } = {}) {
  if (!Number.isFinite(pid) || pid <= 0 || !Number.isInteger(pid)) {
    return { ok: false, pid, signal, error: 'pid must be a positive integer', code: 'BAD_PID' };
  }
  if (typeof signal !== 'string' || signal.length === 0) {
    return { ok: false, pid, signal, error: 'signal must be a non-empty string', code: 'BAD_SIGNAL' };
  }
  // Liveness probe — same signal family, just `0` (no-op check).
  try {
    kill(pid, 0);
  } catch (e) {
    const code = e && typeof e === 'object' ? /** @type {any} */ (e).code : null;
    if (code === 'ESRCH') {
      return { ok: false, pid, signal, error: 'process not running', code: 'PID_NOT_RUNNING' };
    }
    if (code === 'EPERM') {
      return { ok: false, pid, signal, error: 'no permission to signal process', code: 'PID_NO_PERMISSION' };
    }
    return { ok: false, pid, signal, error: e?.message ?? String(e), code: code ?? 'SIGNAL_PROBE_FAILED' };
  }
  try {
    kill(pid, signal);
    return { ok: true, pid, signal };
  } catch (e) {
    const code = e && typeof e === 'object' ? /** @type {any} */ (e).code : null;
    return { ok: false, pid, signal, error: e?.message ?? String(e), code: code ?? 'SIGNAL_SEND_FAILED' };
  }
}

/**
 * T43c-server: parse the URL `:path` segment. URL-decodes +
 * rejects path-traversal + rejects more than 4 segments (matches
 * the deepest catalog entry).
 *
 * Pure — exported for tests.
 *
 * @param {string} raw
 * @returns {{ ok: true, path: string } | { ok: false, error: string, code: string }}
 */
export function parseConfigKnobPath(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, error: 'path must be a non-empty string', code: 'BAD_PATH' };
  }
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch (e) {
    return { ok: false, error: `path is not valid URI: ${e?.message ?? e}`, code: 'BAD_PATH' };
  }
  if (decoded.includes('..') || decoded.includes('/') || decoded.includes('\\')) {
    return { ok: false, error: 'path must not contain "..", "/" or "\\"', code: 'BAD_PATH' };
  }
  const segs = decoded.split('.').filter((s) => s.length > 0);
  if (segs.length === 0 || segs.length > 4) {
    return { ok: false, error: `path must have 1..4 segments; got ${segs.length}`, code: 'BAD_PATH' };
  }
  for (const seg of segs) {
    if (!/^[A-Za-z0-9_-]+$/.test(seg)) {
      return { ok: false, error: `path segment "${seg}" has illegal characters (only A-Z a-z 0-9 _ - allowed)`, code: 'BAD_PATH' };
    }
  }
  return { ok: true, path: decoded };
}

/**
 * T43c-server: handler for `POST /api/config/:path`.
 *
 * Body shape: `{ "value": <proposed value> }` (single-knob
 * payload; the bulk endpoint already accepts nested objects).
 *
 * Response shape (200): `{schema: 'tradebot.dashboard.config.knob/v1',
 *   path, old_value, new_value, normalized, applied:true,
 *   pid_signaled, pid_file, restart_required, ts, user_path}`.
 *
 * Failure shapes:
 *   - 400 BAD_PATH — path is malformed
 *   - 400 BAD_BODY — body shape is wrong
 *   - 404 KNOB_NOT_IN_CATALOG — path isn't in the catalog
 *   - 400 KNOB_VALUE_INVALID — value fails catalog validation
 *   - 400 RESTART_NOT_NEEDED — knob is `restart: false` and the
 *     caller didn't pass `?require_restart=true`
 *   - 503 AUTH_NOT_CONFIGURED — `cfg.dashboard.api_token` is unset
 *   - 200 with `pid_signaled:false` — write succeeded but no bot
 *     PID was found (operator will need a manual restart OR
 *     `scripts/run-bot.mjs` needs to be started again).
 *
 * @param {Object} ctx
 * @param {string} rawPath  from URL `:path`
 * @param {URL} [url]       parsed query string (used for `?require_restart`)
 * @param {Object} body     the JSON body
 * @returns {Promise<Object>}
 */
async function patchConfigKnob(ctx, rawPath, url, body) {
  if (!ctx.dashboardCfg.api_token || typeof ctx.dashboardCfg.api_token !== 'string' || ctx.dashboardCfg.api_token.length === 0) {
    return { error: 'dashboard write endpoints are disabled — set dashboard.api_token in user.json to enable', code: 'AUTH_NOT_CONFIGURED' };
  }
  // Parse + validate the URL path. The route regex already
  // accepted only A-Za-z0-9._% — decode + walk the rest here.
  const parsedPath = parseConfigKnobPath(rawPath);
  if (parsedPath.ok === false) {
    return { error: parsedPath.error, code: parsedPath.code };
  }
  const knobPath = parsedPath.path;
  // Catalog lookup. `lookupKnobByKey` rejects `..`, `/`, `\`
  // — defense in depth even though `parseConfigKnobPath` already
  // stripped them.
  const meta = lookupKnobByKey(knobPath);
  if (meta === null) {
    return {
      error: `unknown config knob "${knobPath}" — not in the catalog`,
      code: 'KNOB_NOT_IN_CATALOG',
    };
  }
  // Restart gate. When the catalog says restart=false the knob is
  // live-tunable; live knobs go through the bulk PUT endpoint
  // (no SIGUSR1, no hot-reload seam). The operator can override
  // the gate via `?require_restart=true` for symmetric one-knob-
  // at-a-time UX on the Settings view.
  const queryParams = (url && typeof url.searchParams?.get === 'function')
    ? url.searchParams
    : null;
  const requireRestart = queryParams?.get('require_restart') === 'true';
  if (meta.restart === false && requireRestart === false) {
    return {
      error: `knob "${knobPath}" is live-tunable (no restart needed) — use PUT /api/config or pass ?require_restart=true to force a hot-reload signal`,
      code: 'RESTART_NOT_NEEDED',
      knob: knobPath,
      restart: false,
    };
  }
  // Body shape: `{ value: <proposed value> }`. A bare value (no
  // `{value:…}` wrapper) is also accepted for symmetric one-knob
  // UX — the operator's intent is "this knob → this value".
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'body must be a JSON object {value:…}', code: 'BAD_BODY' };
  }
  const hasValueWrapper = Object.prototype.hasOwnProperty.call(body, 'value');
  if (!hasValueWrapper) {
    return { error: 'body must include a "value" field', code: 'BAD_BODY' };
  }
  const proposed = body.value;
  // Validate against the catalog kind/min/max contract. This is
  // the same helper the UI uses, so a value the UI accepts is
  // always accepted here too (single source of truth).
  const validated = validateKnobValueForServer(meta, proposed);
  if (validated.ok !== true) {
    return {
      error: validated.message,
      code: 'KNOB_VALUE_INVALID',
      knob: knobPath,
      reason: validated.reason,
      kind: validated.kind,
      min: validated.min,
      max: validated.max,
    };
  }
  const normalized = validated.normalized;
  // Read the existing user.json (might be absent — that's fine).
  /** @type {Object} */
  let existing = {};
  const userPath = ctx.cfg.paths?.user ?? DEFAULT_DASHBOARD_USER_JSON;
  try {
    if (ctx.cfg.paths && ctx.cfg.paths.user) {
      existing = await ctx.readUserJson(ctx.cfg.paths.user);
    }
  } catch (e) {
    return {
      error: `failed to read user.json: ${e?.message ?? e}`,
      code: 'USER_JSON_READ_FAILED',
    };
  }
  const oldValue = readPathValue(existing ?? {}, knobPath);
  // Apply the patch via setPathValue so we can deep-merge a single
  // dotted-key without overwriting sibling knobs at the same depth.
  setPathValue(existing, knobPath, normalized);
  try {
    const fsImpl = ctx.fs ?? undefined;
    await ensureDirForFile(userPath, fsImpl);
    await atomicWriteJson(userPath, existing, fsImpl);
  } catch (e) {
    return {
      error: `failed to write user.json: ${e?.message ?? e}`,
      code: 'USER_JSON_WRITE_FAILED',
    };
  }
  // Read the bot PID file. When the bot isn't running (no PID
  // file, stale PID, malformed PID) the endpoint succeeds (the
  // user.json write landed) but reports `pid_signaled: false` so
  // the operator can decide to restart manually.
  const pidFile = (typeof ctx.pidFile === 'string' && ctx.pidFile.length > 0)
    ? ctx.pidFile
    : DEFAULT_DASHBOARD_PID_FILE;
  const pidResult = await readRunPidFileSafe(pidFile, ctx.fs ?? null);
  let signalResult = { ok: false, pid: null, signal: 'SIGUSR1', error: 'pid_file_unreadable', code: 'PID_FILE_UNREADABLE' };
  if (pidResult.ok && pidResult.pid !== null) {
    signalResult = signalBotPid({ pid: pidResult.pid, signal: 'SIGUSR1' });
  } else if (!pidResult.ok) {
    // No PID file → surface that failure code so the operator sees
    // `pid_error_code: 'PID_FILE_MISSING'` (or MALFORMED) rather than
    // the generic UNREADABLE sentinel.
    signalResult = { ok: false, pid: null, signal: 'SIGUSR1', error: pidResult.error, code: pidResult.code };
  }
  ctx.logger.info('dashboard.config.knob.patched', {
    knob: knobPath,
    old_value: oldValue,
    new_value: normalized,
    restart_required: meta.restart === true,
    pid_signaled: signalResult.ok === true,
    pid_error: signalResult.ok === true ? null : signalResult.error,
    pid_error_code: signalResult.ok === true ? null : signalResult.code,
    user_path: userPath,
  });
  return {
    schema: 'tradebot.dashboard.config.knob/v1',
    ts: new Date().toISOString(),
    knob: knobPath,
    old_value: oldValue,
    new_value: normalized,
    applied: true,
    restart_required: meta.restart === true,
    pid_signaled: signalResult.ok === true,
    pid_file: pidResult.filePath,
    pid_error: signalResult.ok === true ? null : signalResult.error,
    pid_error_code: signalResult.ok === true ? null : signalResult.code,
    user_path: userPath,
  };
}

/**
 * T43c-server: read the PID file with graceful failure. Wraps
 * `readRunPidFile` so the endpoint doesn't need to know about the
 * script-side helper. Returns `{ok:true, pid, filePath}` on hit
 * or `{ok:false, error, code}` on miss / malformed.
 *
 * Pure I/O — exported for tests + `patchConfigKnob`.
 *
 * @param {string} filePath
 * @param {typeof import('node:fs/promises')|null} fsImpl
 * @returns {Promise<
 *   { ok: true, pid: number, filePath: string }
 *   | { ok: false, error: string, code: string, filePath: string }
 * }
 */
export async function readRunPidFileSafe(filePath, fsImpl = null) {
  // Lazy-import so the dashboard server doesn't pull the
  // bot-side module at boot time (the dashboard is generic and
  // should boot in environments where the bot isn't on disk).
  let readRunPidFile;
  try {
    const mod = await import('../../scripts/run-bot.mjs');
    readRunPidFile = mod.readRunPidFile;
  } catch (e) {
    return {
      ok: false,
      error: `failed to import run-bot helpers: ${e?.message ?? e}`,
      code: 'IMPORT_FAILED',
      filePath,
    };
  }
  try {
    const result = await readRunPidFile({ filePath, fs: fsImpl });
    if (result === null) {
      return { ok: false, error: 'pid file not found', code: 'PID_FILE_MISSING', filePath };
    }
    return { ok: true, pid: result.pid, filePath: result.filePath };
  } catch (e) {
    return {
      ok: false,
      error: e?.message ?? String(e),
      code: 'PID_FILE_MALFORMED',
      filePath,
    };
  }
}

/**
 * T43c-server: map a route handler's structured `{error, code}`
 * envelope to an HTTP status code. Pure — exported for tests.
 *
 * The dispatcher's contract is: handlers return `{error, code,
 * ...rest}` on failure, with the convention that `code` carries a
 * machine-readable identifier and `error` is human-readable. The
 * dispatcher must translate `code` → HTTP status so the operator's
 * tools can branch on the status without parsing the message.
 *
 * Mapping (conservative — unknown codes default to 200 so a future
 * handler that surfaces a new error code doesn't silently change
 * HTTP semantics):
 *   - AUTH_NOT_CONFIGURED           → 503  (dashboard write disabled)
 *   - BAD_PATH / BAD_BODY           → 400  (caller shape error)
 *   - KNOB_NOT_IN_CATALOG           → 404  (catalog drift)
 *   - KNOB_VALUE_INVALID            → 400  (kind/min/max violation)
 *   - RESTART_NOT_NEEDED            → 400  (live knob — wrong endpoint)
 *   - USER_JSON_READ_FAILED         → 500  (disk / parse failure)
 *   - USER_JSON_WRITE_FAILED        → 500  (disk / atomic-write failure)
 *   - IMPORT_FAILED                 → 500  (script-side import failure)
 *   - SECRETS_NOT_ALLOWED           → 200  (bulk endpoint convention; tests pin 200)
 *   - T45 manual-trade:
 *     - SWAP_NOT_CONFIGURED          → 503  (swap executor not wired)
 *     - WALLET_NOT_CONFIGURED        → 503  (wallet not wired)
 *     - SWAP_THREW                   → 500  (swap executor threw)
 *   - anything else (incl. success) → 200
 *
 * @param {Object|undefined|null} result
 * @returns {number}
 */
export function statusForResult(result) {
  if (!result || typeof result !== 'object') return 200;
  const code = /** @type {any} */ (result).code;
  if (typeof code !== 'string') return 200;
  switch (code) {
    case 'AUTH_NOT_CONFIGURED':
    case 'SWAP_NOT_CONFIGURED':
    case 'WALLET_NOT_CONFIGURED': return 503;
    case 'CTX_UNAVAILABLE': return 503;
    case 'BAD_PATH':
    case 'BAD_BODY':
    case 'BAD_PAYLOAD':
    case 'KNOB_VALUE_INVALID':
    case 'RESTART_NOT_NEEDED':
    case 'WIF_INVALID':
    case 'MNEMONIC_INVALID':
    case 'NETWORK_UNSUPPORTED':
    case 'NETWORK_MISMATCH':
    case 'WALLET_MODE_INVALID':
    case 'WALLET_VALIDATION_FAILED': return 400;
    case 'KNOB_NOT_IN_CATALOG': return 404;
    case 'USER_JSON_READ_FAILED':
    case 'USER_JSON_WRITE_FAILED':
    case 'IMPORT_FAILED':
    case 'SWAP_THREW': return 500;
    default: return 200;
  }
}

/**
 * Flatten an object to its leaf key names. Walks every nested
 * plain-object branch and emits the leaf key only — intermediate
 * branch names (e.g. `dashboard`) are NOT emitted when their
 * children carry real values. This keeps the audit log focused on
 * the operator's actual knobs (`bind_port`, `log_level`) rather than
 * every nesting level.
 *
 * The `seen` set protects against cycles: do NOT pre-mark the child
 * as seen, or the recursion will refuse to descend into it. Only
 * mark a node when we ENCOUNTER it (top-down), not before recursing.
 *
 * Pure — exported for tests.
 *
 * @param {unknown} value
 * @param {WeakSet<object>} [seen]
 * @returns {string[]}
 */
export function flattenKeys(value, seen = new WeakSet()) {
  const out = [];
  if (value === null || value === undefined) return out;
  if (typeof value !== 'object' || Array.isArray(value)) return out;
  if (seen.has(value)) return out;
  seen.add(value);
  for (const k of Object.keys(value)) {
    const child = /** @type {any} */ (value)[k];
    if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
      out.push(...flattenKeys(child, seen));
    } else {
      out.push(k);
    }
  }
  return out;
}

/**
 * `POST /api/risk/reset` — manually clear the circuit breaker.
 * Optional body: `{ reason: "free-text" }` for audit purposes.
 *
 * @param {Object} ctx
 * @param {Object} body
 * @returns {Promise<Object>}
 */
async function resetRisk(ctx, body) {
  if (!ctx.dashboardCfg.api_token || typeof ctx.dashboardCfg.api_token !== 'string' || ctx.dashboardCfg.api_token.length === 0) {
    return { error: 'dashboard write endpoints are disabled — set dashboard.api_token in user.json to enable', code: 'AUTH_NOT_CONFIGURED' };
  }
  if (!ctx.risk || typeof ctx.risk.reset !== 'function') {
    return { error: 'risk state not available — circuit breaker is owned by the trader loop', code: 'NO_BREAKER' };
  }
  const reason = (body && typeof body === 'object' && typeof body.reason === 'string') ? body.reason.trim() : null;
  await ctx.risk.reset({ reason: reason ?? 'dashboard manual reset' });
  ctx.logger.info('dashboard.risk.reset', { reason: reason ?? 'dashboard manual reset' });
  return {
    schema: 'tradebot.dashboard.risk.reset/v1',
    ts: new Date().toISOString(),
    state: ctx.risk.state(),
    reason: reason ?? 'dashboard manual reset',
  };
}

// ─────────────────────────────────────────────────────────────────────
//  T45: manual BUY/SELL trigger (subset 1 — backend)
// ─────────────────────────────────────────────────────────────────────

/**
 * Validate + coerce the body for `POST /api/trade/manual`. Pure —
 * exported for tests. Returns a typed result so the HTTP handler
 * can short-circuit on shape errors without re-implementing the
 * validation logic.
 *
 * Required fields:
 *   - `token_id`   64-hex string (lower or upper case; lowercased
 *                   before forwarding to the swap executor)
 *   - `side`       'buy' or 'sell'
 *   - `amount_bch` positive finite number
 *
 * Optional fields:
 *   - `dry_run`                    boolean (default false) — when
 *                                   true, `SwapExecutor.execute()`
 *                                   runs the plan + pre-flight only
 *                                   (no broadcast), exactly like the
 *                                   trader loop's T24 dry-run path.
 *   - `expected_rate_sats_per_token` finite number — passed through
 *                                   to `execute({expectedRateSats})`
 *                                   so the slippage check uses the
 *                                   operator's reference price rather
 *                                   than the indexer's.
 *
 * @param {unknown} body
 * @returns {{ok: true, value: {token_id: string, side: 'buy'|'sell', amount_bch: number, dry_run: boolean, expected_rate_sats_per_token: number|null}} | {ok: false, error: string, code: string}}
 */
export function parseManualTradeRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object', code: 'BAD_BODY' };
  }
  const b = /** @type {any} */ (body);
  // token_id: 64-hex (lower or upper case; trim; reject empty / wrong length / non-hex).
  if (typeof b.token_id !== 'string') {
    return { ok: false, error: 'token_id must be a string', code: 'BAD_BODY' };
  }
  const tidRaw = b.token_id.trim();
  if (tidRaw.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(tidRaw)) {
    return { ok: false, error: 'token_id must be a 64-hex string', code: 'BAD_BODY' };
  }
  // side: 'buy' | 'sell'
  if (b.side !== 'buy' && b.side !== 'sell') {
    return { ok: false, error: `side must be 'buy' or 'sell'; got ${JSON.stringify(b.side)}`, code: 'BAD_BODY' };
  }
  // amount_bch: positive finite number. Reject string/null/bool/object.
  if (typeof b.amount_bch !== 'number' || !Number.isFinite(b.amount_bch) || b.amount_bch <= 0) {
    return { ok: false, error: 'amount_bch must be a positive finite number', code: 'BAD_BODY' };
  }
  // Optional dry_run: must be a real boolean when present.
  let dryRun = false;
  if (b.dry_run !== undefined) {
    if (typeof b.dry_run !== 'boolean') {
      return { ok: false, error: 'dry_run must be a boolean when present', code: 'BAD_BODY' };
    }
    dryRun = b.dry_run;
  }
  // Optional expected_rate_sats_per_token: positive finite number.
  let expectedRateSatsPerToken = null;
  if (b.expected_rate_sats_per_token !== undefined && b.expected_rate_sats_per_token !== null) {
    if (typeof b.expected_rate_sats_per_token !== 'number' || !Number.isFinite(b.expected_rate_sats_per_token) || b.expected_rate_sats_per_token <= 0) {
      return { ok: false, error: 'expected_rate_sats_per_token must be a positive finite number when present', code: 'BAD_BODY' };
    }
    expectedRateSatsPerToken = b.expected_rate_sats_per_token;
  }
  return {
    ok: true,
    value: {
      token_id: tidRaw.toLowerCase(),
      side: b.side,
      amount_bch: b.amount_bch,
      dry_run: dryRun,
      expected_rate_sats_per_token: expectedRateSatsPerToken,
    },
  };
}

/**
 * T45: handler for `POST /api/trade/manual`. Runs a single BUY or
 * SELL through the same `SwapExecutor.execute()` pipeline the trader
 * loop uses — every pre-flight / slippage / fee check applies — so
 * the operator can intervene on tokens the bot's scoring layer would
 * skip (e.g. research-driven buys / force-exits of an unwanted
 * position) without bypassing the risk gates.
 *
 * Errors:
 *   - 503 AUTH_NOT_CONFIGURED   api_token not set
 *   - 503 SWAP_NOT_CONFIGURED   ctx.swap not wired (caller didn't
 *                                boot `SwapExecutor`)
 *   - 503 WALLET_NOT_CONFIGURED ctx.wallet missing `getTokenAddress()`
 *                                (call the route from a dashboard
 *                                that's wired to a real wallet)
 *   - 400 BAD_BODY              shape / type / range violation
 *
 * Success returns the swap envelope + a `kind:'manual_trade'` history
 * event so the audit trail captures every operator override.
 *
 * @param {Object} ctx
 * @param {Object} body
 * @returns {Promise<Object>}
 */
async function executeManualTrade(ctx, body) {
  if (!ctx.dashboardCfg.api_token || typeof ctx.dashboardCfg.api_token !== 'string' || ctx.dashboardCfg.api_token.length === 0) {
    return { error: 'dashboard write endpoints are disabled — set dashboard.api_token in user.json to enable', code: 'AUTH_NOT_CONFIGURED' };
  }
  if (!ctx.swap || typeof ctx.swap.execute !== 'function') {
    return { error: 'swap executor not wired into the dashboard context — boot the dashboard with `scripts/start-dashboard.mjs`', code: 'SWAP_NOT_CONFIGURED' };
  }
  if (!ctx.wallet || typeof ctx.wallet.getTokenAddress !== 'function') {
    return { error: 'wallet not wired into the dashboard context — cannot derive a token-aware destination address', code: 'WALLET_NOT_CONFIGURED' };
  }
  const parsed = parseManualTradeRequest(body);
  if (parsed.ok === false) {
    return { error: parsed.error, code: parsed.code };
  }
  const req = parsed.value;
  // BCH sats — same convention the trader loop uses for BUY (T28:
  // the executor translates BCH sats → token base units internally
  // for BUY via `maxTokensForBudget`). For SELL, the body is
  // expected to be token base units — but the operator-facing API
  // exposes BCH-denominated sizing only, so we reject SELL here
  // unless a future extension adds a token-amount sibling. Today
  // the dashboard UI drives SELL through the close-position flow,
  // not the manual-trade endpoint.
  const amountBaseSats = BigInt(Math.round(req.amount_bch * Number(SATS_PER_BCH)));
  const destination = ctx.wallet.getTokenAddress();
  const swapRequest = {
    tokenId: req.token_id,
    side: req.side,
    amountBase: amountBaseSats,
    destination,
    dryRun: req.dry_run,
  };
  if (req.expected_rate_sats_per_token !== null) {
    swapRequest.expectedRateSats = BigInt(Math.round(req.expected_rate_sats_per_token));
  }
  ctx.logger.info('dashboard.trade.manual.start', {
    token_id: req.token_id.slice(0, 16) + '…',
    side: req.side,
    amount_bch: req.amount_bch,
    dry_run: req.dry_run,
  });
  let swapResult;
  try {
    swapResult = await ctx.swap.execute(swapRequest);
  } catch (e) {
    const errName = e?.name ?? 'Error';
    const errMsg = e?.message ?? String(e);
    ctx.logger.error('dashboard.trade.manual.swap_threw', {
      err_name: errName, err_message: errMsg,
      token_id: req.token_id.slice(0, 16) + '…', side: req.side,
    });
    return {
      error: `swap executor threw: ${errMsg}`,
      code: 'SWAP_THREW',
      error_name: errName,
    };
  }
  // History event so the audit trail / ActivityFeed surfaces every
  // manual trade. T45 subset 2 (dashboard UI) ties the operator's
  // click to this event so they can verify the swap landed.
  if (typeof ctx.historyAppend === 'function') {
    try {
      await ctx.historyAppend({
        kind: 'manual_trade',
        schema: 'tradebot.history.manual_trade/v1',
        ts: new Date().toISOString(),
        source: 'dashboard',
        token_id: req.token_id,
        side: req.side,
        amount_bch: req.amount_bch,
        dry_run: req.dry_run,
        ok: !!swapResult?.ok,
        txid: swapResult?.txid ?? null,
        error_kind: swapResult?.errorKind ?? null,
        error: swapResult?.error ?? null,
      });
    } catch (e) {
      ctx.logger.warn('dashboard.trade.manual.history_append_failed', {
        err_name: e?.name ?? 'Error', err_message: e?.message ?? String(e),
      });
    }
  }
  ctx.logger.info('dashboard.trade.manual.done', {
    token_id: req.token_id.slice(0, 16) + '…',
    side: req.side,
    ok: !!swapResult?.ok,
    txid: swapResult?.txid ?? null,
    error_kind: swapResult?.errorKind ?? null,
  });
  return {
    schema: 'tradebot.dashboard.trade.manual/v1',
    ts: new Date().toISOString(),
    ok: !!swapResult?.ok,
    side: req.side,
    token_id: req.token_id,
    amount_bch: req.amount_bch,
    dry_run: req.dry_run,
    // The full SwapResult envelope — the dashboard UI surfaces the
    // fields it needs (txid, slippage, lp/network fees, balance
    // after) and the rest is preserved verbatim for the audit log.
    swap: swapResult && typeof swapResult === 'object'
      ? {
          ok: !!swapResult.ok,
          side: swapResult.side,
          tokenId: swapResult.tokenId,
          amountBase: typeof swapResult.amountBase === 'bigint' ? swapResult.amountBase.toString() : null,
          effectiveRateSats: typeof swapResult.effectiveRateSats === 'bigint' ? swapResult.effectiveRateSats.toString() : null,
          expectedRateSats: typeof swapResult.expectedRateSats === 'bigint' ? swapResult.expectedRateSats.toString() : null,
          slippageBps: typeof swapResult.slippageBps === 'bigint' ? swapResult.slippageBps.toString() : null,
          totalSatsInOrOut: typeof swapResult.totalSatsInOrOut === 'bigint' ? swapResult.totalSatsInOrOut.toString() : null,
          lpFeeSats: typeof swapResult.lpFeeSats === 'bigint' ? swapResult.lpFeeSats.toString() : null,
          estNetworkFeeSats: typeof swapResult.estNetworkFeeSats === 'bigint' ? swapResult.estNetworkFeeSats.toString() : null,
          txid: swapResult.txid ?? null,
          error: swapResult.error ?? null,
          errorKind: swapResult.errorKind ?? null,
        }
      : null,
  };
}

/**
 * Walk `body` and report every redactable key. Used by PUT /api/config
 * to refuse secret-looking payloads. Pure — exported for tests.
 *
 * @param {unknown} value
 * @param {Object} [logger]
 * @param {WeakSet<object>} [seen]
 * @returns {{ rejected: string[] }}
 */
export function walkAndReject(value, logger, seen = new WeakSet()) {
  const rejected = [];
  function walk(v) {
    if (v === null || v === undefined) return;
    if (typeof v !== 'object') return;
    if (seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    for (const k of Object.keys(v)) {
      if (isRedactedKey(k)) {
        rejected.push(k);
        if (logger && typeof logger.warn === 'function') {
          logger.warn('dashboard.config.reject.secret_field', { field: k });
        }
      } else {
        walk(/** @type {any} */ (v)[k]);
      }
    }
  }
  walk(value);
  return { rejected };
}

/**
 * Deep-merge `b` onto `a`. Mirrors `src/util/config-loader.mjs`'s
 * `deepMerge` — duplicated here so the dashboard server has no
 * dependency on the config loader (single-responsibility for the
 * read-only HTTP surface).
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {unknown}
 */
function deepMerge(a, b) {
  if (b === undefined) return a;
  if (b === null || typeof b !== 'object' || Array.isArray(b)) return b;
  if (a === null || typeof a !== 'object' || Array.isArray(a)) return b;
  const out = {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    out[k] = deepMerge(/** @type {any} */ (a)[k], /** @type {any} */ (b)[k]);
  }
  return out;
}

/**
 * Default on-disk location for `user.json`. Used when the loaded
 * config didn't carry `paths.user` (e.g. a test that constructed
 * `cfg` by hand).
 */
export const DEFAULT_DASHBOARD_USER_JSON = 'config/user.json';

// ─────────────────────────────────────────────────────────────────────
//  Auth
// ─────────────────────────────────────────────────────────────────────

/**
 * Constant-time bearer-token comparison. Returns `true` on match,
 * `false` on mismatch. Both inputs are coerced to Buffer of the same
 * length (timingSafeEqual throws otherwise); on length mismatch we
 * still do a dummy compare so the timing stays even.
 *
 * Pure. Exported for tests.
 *
 * @param {string} provided     raw header value (e.g. "Bearer xyz")
 * @param {string} expected     expected token (plaintext)
 * @returns {boolean}
 */
export function isAuthed(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  if (expected.length === 0) return false;
  // Accept either "Bearer <token>" or "<token>" (raw). Strip the
  // scheme prefix if present.
  let raw = provided;
  const m = /^Bearer\s+(.+)$/i.exec(provided);
  if (m) raw = m[1];
  raw = raw.trim();
  if (raw.length === 0) return false;
  const a = Buffer.from(raw, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    // Dummy compare — same-shape buffer to keep timing constant.
    const dummy = Buffer.from(randomBytes(a.length));
    timingSafeEqual(dummy, a);
    return false;
  }
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Static serving
// ─────────────────────────────────────

/**
 * Small `ext → Content-Type` table. Deliberately not exhaustive —
 * anything missing gets `application/octet-stream` and the browser
 * can sniff. Exported so tests can assert the mapping without
 * duplicating the literal list.
 *
 * Kept inline to honour the "zero new dependencies" rule (see
 * ARCHITECTURE.md §3). Add entries as the SPA accumulates new
 * asset types.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const STATIC_CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm':  'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':   'font/ttf',
  '.otf':   'font/otf',
  '.eot':   'application/vnd.ms-fontobject',
  '.mp4':   'video/mp4',
  '.webm':  'video/webm',
  '.txt':   'text/plain; charset=utf-8',
  '.map':   'application/json; charset=utf-8',
});

/** Fallback Content-Type when no extension or unknown extension. */
export const DEFAULT_STATIC_CONTENT_TYPE = 'application/octet-stream';

/**
 * Look up the Content-Type for a file path. Returns
 * `DEFAULT_STATIC_CONTENT_TYPE` for unknown extensions.
 *
 * @param {string} filePath
 * @returns {string}
 */
export function contentTypeFor(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return DEFAULT_STATIC_CONTENT_TYPE;
  const ext = path.extname(filePath).toLowerCase();
  return STATIC_CONTENT_TYPES[ext] ?? DEFAULT_STATIC_CONTENT_TYPE;
}

/**
 * Map an incoming URL pathname to an absolute on-disk path inside
 * `staticRoot`, with a hard guarantee that the result does NOT
 * escape the root. Returns `null` for any path that fails the
 * escape check (the caller falls through to the route matcher).
 *
 * Three checks, in order:
 *
 *   1. Null-byte in raw or percent-decoded path → blocked
 *      (a common path-traversal payload on less-careful parsers).
 *   2. Percent-decode and POSIX-normalize. If the normalized
 *      result is absolute or starts with `..` → blocked.
 *   3. `path.resolve(staticRoot, normalized)` must equal
 *      `staticRoot` OR start with `staticRoot + path.sep`.
 *
 * Bare `/` is mapped to `<staticRoot>/<staticIndex>` so the SPA
 * home page resolves directly. Pass `staticIndex` as a separate
 * parameter so tests can exercise the mapping independently.
 *
 * Why not just `path.resolve(staticRoot, urlPath)` directly? Two
 * reasons:
 *   - It doesn't catch percent-encoded `..` (%2E%2E%2F) reliably;
 *     we decode first, normalize second.
 *   - It doesn't catch the rare Windows backslash trick on a
 *     POSIX root; the trailing-separator check covers it.
 *
 * Pure. Exported for tests.
 *
 * @param {string} staticRoot   absolute, normalized path
 * @param {string} urlPath      e.g. "/portfolio", "/assets/index-AbCd.js"
 * @param {string} [staticIndex="index.html"]
 * @returns {string|null}
 */
export function resolveSafeStaticPath(staticRoot, urlPath, staticIndex = 'index.html') {
  if (typeof staticRoot !== 'string' || staticRoot.length === 0) return null;
  if (typeof urlPath !== 'string' || urlPath.length === 0) return null;
  if (urlPath.indexOf('\0') >= 0) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.indexOf('\0') >= 0) return null;
  // Strip any leading `/` (or `\\`) so the path becomes relative,
  // then normalize. URLs always start with `/`, which would
  // otherwise make `path.posix.join` produce an absolute path and
  // trigger our escape-prevention reject below.
  let stripped = decoded;
  while (stripped.length > 0 && (stripped.charCodeAt(0) === 0x2f /* / */ || stripped.charCodeAt(0) === 0x5c /* \\ */)) {
    stripped = stripped.slice(1);
  }
  if (stripped === '') stripped = staticIndex;
  const joined = path.posix.join(stripped);
  if (joined.startsWith('..') || path.isAbsolute(joined)) return null;
  // After join, backslashes have been normalized to forward slashes;
  // a `\` that survives means the input wasn't UTF-8-text — reject.
  if (joined.includes('\\')) return null;
  const resolved = path.resolve(staticRoot, joined);
  if (resolved === staticRoot) return null;
  const rootWithSep = staticRoot.endsWith(path.sep) ? staticRoot : staticRoot + path.sep;
  return resolved.startsWith(rootWithSep) ? resolved : null;
}

/**
 * Decide whether a path should bypass the API matcher and try
 * static serving. Conservative — anything that LOOKS like an API
 * URL falls through, and POST/PUT/DELETE always fall through.
 *
 * `/` IS eligible (it maps to `static_index` via resolveSafeStaticPath).
 *
 * @param {string} pathname
 * @param {string} method
 * @returns {boolean}
 */
export function shouldServeStatic(pathname, method) {
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (typeof pathname !== 'string' || pathname.length === 0) return false;
  if (pathname.startsWith('/api') || pathname === '/healthz' || pathname.startsWith('/healthz/')) {
    return false;
  }
  return true;
}

/**
 * Try to serve a request from the static root. Returns `true` if
 * it sent a response (the handler must NOT respond again),
 * `false` if the request should fall through to the route matcher.
 *
 * Only GET / HEAD requests that pass `shouldServeStatic()` reach
 * here (the handler gates first). On success, the request is
 * logged via `routeName = 'static'` so the access log shows
 * `GET / <route> static` for SPA / asset hits.
 *
 * Behavior:
 *   - File exists on disk → 200 with Content-Type + no-cache.
 *   - Requested path is a directory containing `<static_index>` →
 *     200, serve the index (Vite preview parity).
 *   - File does NOT exist + Accept includes `text/html` → serve
 *     `static_index` (SPA fallback for React Router routes like
 *     `/portfolio` and `/settings`).
 *   - Anything else → `false` (route matcher returns 404 JSON).
 *
 * Errors that are NOT ENOENT bubble up; they're a real I/O
 * problem the operator should see in the logs.
 *
 * @param {Object} ctx         dashboard ctx
 * @param {Object} req         `node:http` IncomingMessage
 * @param {Object} res         `node:http` ServerResponse
 * @param {string} urlPath     pathname from the URL (already parsed)
 * @returns {Promise<boolean>}
 */
export async function tryServeStatic(ctx, req, res, urlPath) {
  if (!ctx || ctx.staticEnabled !== true) return false;
  if (!shouldServeStatic(urlPath, /** @type {any} */ (req.method ?? 'GET'))) return false;
  const safe = resolveSafeStaticPath(ctx.staticRoot, urlPath, ctx.staticIndex);
  if (safe === null) return false;
  /** @type {any} */
  const fsImpl = ctx.fs ?? null;
  /** @type {any} */
  const fsp = fsImpl ?? (await import('node:fs/promises'));
  let stat;
  try {
    stat = await fsp.stat(safe);
  } catch (e) {
    if (e && typeof e === 'object' && /** @type {any} */ (e).code === 'ENOENT') {
      // SPA fallback: only for HTML accept.
      const accept = (req.headers && typeof req.headers.accept === 'string') ? req.headers.accept : '';
      if (!/text\/html/.test(accept)) return false;
      const indexPath = path.join(ctx.staticRoot, ctx.staticIndex);
      try {
        const idxStat = await fsp.stat(indexPath);
        if (!idxStat.isFile()) return false;
        const data = await fsp.readFile(indexPath);
        sendStatic(res, 200, 'text/html; charset=utf-8', data, req);
        return true;
      } catch {
        return false;
      }
    }
    throw e;
  }
  if (stat.isDirectory()) {
    const indexInDir = path.join(safe, ctx.staticIndex);
    try {
      const idxStat = await fsp.stat(indexInDir);
      if (!idxStat.isFile()) return false;
      const data = await fsp.readFile(indexInDir);
      sendStatic(res, 200, 'text/html; charset=utf-8', data, req);
      return true;
    } catch {
      return false;
    }
  }
  if (!stat.isFile()) return false;
  const data = await fsp.readFile(safe);
  sendStatic(res, 200, contentTypeFor(safe), data, req);
  return true;
}

/**
 * Write a static-file response. HEAD requests get the same headers
 * but no body.
 *
 * @param {Object} res
 * @param {number} status
 * @param {string} contentType
 * @param {Buffer} data
 * @param {Object} req
 */
function sendStatic(res, status, contentType, data, req) {
  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Length', Buffer.byteLength(data));
  if (req.method === 'HEAD') {
    res.end();
  } else {
    res.end(data);
  }
}

/**
 * @typedef {Object} CreateDashboardServerOpts
 * @property {Object} cfg                  merged default+user config
 * @property {Object} positions            `Positions` (portfolio/positions.mjs)
 * @property {Object} snapshots            `Snapshots` (portfolio/snapshots.mjs)
 * @property {Object} historyReader        `{ read(opts) → Promise<{ events, errors }> }`
 * @property {Object} [risk]               `CircuitBreaker` (optional — `/api/risk` returns 503 if absent)
 * @property {Object} [wallet]             `LibAuthBchWallet` (optional — used for live balance)
 * @property {Object} [loop]               `TradingLoop` (optional — surfaces `last_tick_age_ms`,
 *                                          `tick_count`, `loop_running` on `/healthz` so external
 *                                          monitors can detect stuck-bot conditions without
 *                                          scraping the dashboard. T61.)
 * @property {Object} [logger]             structured logger
 * @property {Function} [fs]               fs/promises — test seam
 * @property {Function} [readUserJson]     `(path) => Promise<Object>` — defaults to fs.readFile+JSON.parse
 * @property {string} [positionsFile]      override for `ctx.positions.file` (defaults to cfg.paths?.positions_file)
 * @property {string} [snapshotsDir]       override for `ctx.snapshots.dir` (defaults to cfg.paths?.snapshots_dir)
 * @property {string} [historyFile]        override for the history NDJSON file
 * @property {string[]} [routes]           optional route-table override (advanced testing)
 * @property {string} [staticRoot]         override for `cfg.dashboard.static_root` (string path);
 *                                          `null` disables static serving even if config enables it.
 * @property {string} [staticIndex]        override for `cfg.dashboard.static_index` (default
 *                                          `'index.html'`); the file served on SPA-route fallback.
 * @property {() => number} [clock]       test seam for time-windowed listers
 *                                          (`/api/history`, `/api/snapshots`).
 *                                          Returns ms-since-epoch. Defaults to
 *                                          `() => Date.now()`. Inject a frozen clock in
 *                                          tests to keep `?range=7d` assertions
 *                                          deterministic against wall-clock drift.
 */

/**
 * Build a fresh dashboard-server instance. Returns an object with:
 *
 *   - `handler(req, res)`     — the underlying Node `http` handler.
 *                                Tests can call this with a
 *                                `MockRequest` + `MockResponse`.
 *   - `server`                — the bound `http.Server` (only set
 *                                after `start()`).
 *   - `start()`               — bind to `dashboardCfg.bind_host:
 *                                bind_port` and start listening.
 *                                Resolves once the socket is bound.
 *   - `stop()`                — close the listening socket. Safe
 *                                to call repeatedly (idempotent).
 *   - `ctx`                   — the resolved context (DI surface).
 *   - `routes`                — the matched route table.
 *
 * @param {CreateDashboardServerOpts} opts
 */
export function createDashboardServer(opts = {}) {
  if (!opts || typeof opts !== 'object') {
    throw new DashboardConfigError('createDashboardServer: opts required');
  }
  if (!opts.cfg || typeof opts.cfg !== 'object') {
    throw new DashboardConfigError('createDashboardServer: cfg required');
  }
  if (!opts.positions || typeof opts.positions.list !== 'function') {
    throw new DashboardConfigError('createDashboardServer: positions (with .list) required');
  }
  if (!opts.snapshots || typeof opts.snapshots.readBack !== 'function') {
    throw new DashboardConfigError('createDashboardServer: snapshots (with .readBack) required');
  }
  if (!opts.historyReader || typeof opts.historyReader.read !== 'function') {
    throw new DashboardConfigError('createDashboardServer: historyReader (with .read) required');
  }
  const logger = opts.logger ?? createLogger({ component: 'dashboard', sink: process.stderr });
  const dashboardCfg = resolveDashboardConfig(opts.cfg.dashboard);
  /** @type {RouteSpec[]} */
  let routes = Array.isArray(opts.routes) && opts.routes.length > 0 ? opts.routes : buildRouteTable();
  // Feature-ideas routes: appended when the caller wires the store
  // + TODO.md path via opts. Skipped when `opts.routes` is supplied
  // (caller takes full control of the route table). The store is
  // lazy-imported so the dashboard server can boot in environments
  // where the feature-ideas module isn't on disk (e.g. older
  // deploys).
  if (Array.isArray(opts.routes) === false || opts.routes.length === 0) {
    if (opts.featureIdeasStore && typeof opts.featureIdeasTodoPath === 'string') {
      try {
        const extraRoutes = buildFeatureIdeaRoutesImpl({
          featureIdeasStore: opts.featureIdeasStore,
          todoPath: opts.featureIdeasTodoPath,
          logger: logger.child('feature-ideas'),
        });
        routes = [...routes, ...extraRoutes];
        logger.info('dashboard.feature-ideas.mounted', {
          routes: extraRoutes.length,
          todoPath: opts.featureIdeasTodoPath,
        });
      } catch (e) {
        logger.error('dashboard.feature-ideas.mount-failed', {
          err_name: e?.name ?? 'Error',
          err_message: e?.message ?? String(e),
        });
      }
    }
    // T44: bugs tab. Same registration pattern as feature-ideas,
    // except bugs don't need the TODO.md path (the supervisor-bridge
    // handles that on the cron side; the dashboard only exposes
    // the CRUD surface). The bugsStore gate follows the same
    // pattern as featureIdeasStore — when it's wired in, the
    // route table expands; otherwise the dashboard boots cleanly
    // without the bugs tab.
    if (opts.bugsStore) {
      try {
        const bugRoutes = buildBugRoutesImpl({
          bugsStore: opts.bugsStore,
          logger: logger.child('bugs'),
        });
        routes = [...routes, ...bugRoutes];
        logger.info('dashboard.bugs.mounted', {
          routes: bugRoutes.length,
        });
      } catch (e) {
        logger.error('dashboard.bugs.mount-failed', {
          err_name: e?.name ?? 'Error',
          err_message: e?.message ?? String(e),
        });
      }
    }
  }

  // Static-serving resolution (sync at construction — the on-disk
  // check is cheap, and the answer doesn't change at request time).
  // `opts.staticRoot === null` is a hard disable; otherwise use it
  // as an override for `cfg.dashboard.static_root`. Resolution
  // result: `staticEnabled` (boolean) + `staticRoot` (absolute
  // string or null) + `staticIndex` (filename).
  const staticIndexRaw = (typeof opts.staticIndex === 'string' && opts.staticIndex.length > 0)
    ? opts.staticIndex
    : (typeof dashboardCfg.static_index === 'string' && dashboardCfg.static_index.length > 0)
      ? dashboardCfg.static_index
      : 'index.html';
  let staticRootResolved = null;
  let staticEnabledFlag = false;
  if (opts.staticRoot !== null) {
    const configured = (typeof opts.staticRoot === 'string' && opts.staticRoot.length > 0)
      ? opts.staticRoot
      : (typeof dashboardCfg.static_root === 'string' && dashboardCfg.static_root.length > 0)
        ? dashboardCfg.static_root
        : null;
    if (configured !== null) {
      const abs = path.resolve(configured);
      try {
        if (existsSync(abs) && statSync(abs).isDirectory()) {
          staticRootResolved = abs;
          staticEnabledFlag = true;
        }
      } catch {
        // path.resolve/statSync shouldn't throw on a plain string,
        // but if the platform surprises us, fall through to disabled.
      }
    }
  }
  logger.info('dashboard.static.configured', {
    configured_root: opts.staticRoot === null
      ? null
      : (opts.staticRoot ?? dashboardCfg.static_root ?? null),
    resolved_root: staticRootResolved,
    enabled: staticEnabledFlag,
    index: staticIndexRaw,
  });

  // Default clock — `Date.now` in production; injectable via `opts.clock`
  // so time-windowed listers (`listHistory`, `listSnapshots`) can run
  // against a frozen clock in tests. Without this, `?range=7d`
  // windowing drifts with wall-clock and a test that was green on
  // day one silently fails months later.
  if (opts.clock != null && typeof opts.clock !== 'function') {
    // `!= null` (loose) covers both null AND undefined as "use default".
    throw new DashboardConfigError('createDashboardServer: opts.clock must be a function');
  }
  const clock = (typeof opts.clock === 'function') ? opts.clock : () => Date.now();

  // Default readUserJson — uses the injected fs (test seam).
  const fsImpl = opts.fs ?? null;
  const readUserJson = opts.readUserJson ?? (async (p) => {
    if (typeof p !== 'string' || p.length === 0) return {};
    let raw;
    try {
      raw = fsImpl ? await fsImpl.readFile(p, 'utf8') : await (await import('node:fs/promises')).readFile(p, 'utf8');
    } catch (e) {
      if (e && typeof e === 'object' && /** @type {any} */ (e).code === 'ENOENT') return {};
      throw e;
    }
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  });

  /** @type {Object} */
  const ctx = {
    cfg: opts.cfg,
    dashboardCfg,
    positions: opts.positions,
    snapshots: opts.snapshots,
    historyReader: opts.historyReader,
    risk: opts.risk ?? null,
    wallet: opts.wallet ?? null,
    // T61: optional `TradingLoop` seam. When wired, the extended
    // `/healthz` envelope surfaces last_tick_age_ms + tick_count +
    // loop_running. When absent (e.g. dashboard started standalone
    // for read-only ops), the probe reports `status:'unconfigured'`
    // and the endpoint still responds 200.
    loop: (opts.loop && typeof opts.loop.stats === 'function') ? opts.loop : null,
    logger,
    fs: fsImpl,
    readUserJson,
    positionsFile: opts.positionsFile ?? (opts.cfg.paths?.positions_file ?? DEFAULT_POSITIONS_FILE),
    snapshotsDir: opts.snapshotsDir ?? (opts.cfg.paths?.snapshots_dir ?? DEFAULT_SNAPSHOTS_DIR),
    historyFile: opts.historyFile ?? DEFAULT_DASHBOARD_HISTORY_FILE,
    staticRoot: staticRootResolved,
    staticEnabled: staticEnabledFlag,
    staticIndex: staticIndexRaw,
    clock,
    bcmrClient: opts.bcmrClient ?? null,
    // T43c-server: where the bot writes its own PID at boot.
    // Defaults to `data/run.pid`; tests inject a fixture.
    pidFile: (typeof opts.pidFile === 'string' && opts.pidFile.length > 0)
      ? opts.pidFile
      : DEFAULT_DASHBOARD_PID_FILE,
    // T45: manual-trade endpoint dependencies. Optional — the
    // endpoint returns SWAP_NOT_CONFIGURED / WALLET_NOT_CONFIGURED
    // when these are missing, so callers (and tests) can boot the
    // dashboard without the full trading pipeline.
    swap: opts.swap ?? null,
    historyAppend: typeof opts.historyAppend === 'function' ? opts.historyAppend : null,
    // T45b: indexer fetcher. Optional — when wired in, the
    // `/api/pools/top` route serves a normalized discovery list
    // (the same shape the trader loop uses internally). When
    // missing, the route returns `503 fetcher_not_configured` and
    // the manual-trade UI surfaces a "no pool list" pill instead
    // of crashing.
    fetcher: opts.fetcher ?? null,
    // T58 subset 4: where to read the alerts log for the staking
    // status tile. Optional — when missing, the route uses
    // `DEFAULT_STAKING_ALERTS_FILE` (`data/alerts.jsonl`). Tests
    // inject a tmpfile via `opts.alertsFile` so they don't
    // accidentally read the live `data/alerts.jsonl` while
    // running in CI.
    alertsFile: (typeof opts.alertsFile === 'string' && opts.alertsFile.length > 0)
      ? opts.alertsFile
      : DEFAULT_STAKING_ALERTS_FILE,
    alertsMax: (Number.isFinite(opts.alertsMax) && opts.alertsMax > 0)
      ? opts.alertsMax
      : DEFAULT_STAKING_ALERTS_MAX,
    // T64: per-server snapshot-aggregator instance. Cache is
    // mtime-keyed so a fresh trader-loop snapshot write auto-
    // invalidates the next poll. `cacheMs` knob read from
    // `dashboardCfg.snapshot_aggregate_cache_ms` (default 30000);
    // set to 0 to disable caching (always-fresh). The
    // dashboard's `clock()` is threaded so the `?range=` windowing
    // matches the rest of the dashboard endpoints under frozen time.
    snapshotAggregator: new SnapshotAggregator({
        cacheMs: clampSnapshotAggregateCacheMs(dashboardCfg.snapshot_aggregate_cache_ms),
        nowMs: clock,
      }),
    // T76 subset 2a: per-server holders-scanner cache. TTL-keyed on
    // `fetched_at_ms` per token (not mtime — there's no chain-state
    // file to key against; the upstream snapshot is per-call). The
    // dashboard's `clock()` is threaded so the `cacheMs` window
    // stays deterministic under frozen time in tests. Set
    // `scoring.concentration_rug_enabled=true` in user.json to opt
    // in; until then `getTokenHolders` short-circuits to the
    // subset-1 stub envelope and this cache sits idle.
    holdersScannerCache: new HoldersScannerCache({
        cacheMs: clampHoldersScannerCacheMs(
          (dashboardCfg && typeof dashboardCfg.scoring === 'object' && dashboardCfg.scoring !== null)
            ? dashboardCfg.scoring.concentration_rug_cache_ms
            : DEFAULT_HOLDERS_SCANNER_CACHE_MS,
        ),
        nowMs: clock,
      }),
    // T79 subset 2: subset-2 metrics probe cache (per-token
    // counters + scoring-gate hit counters + tick-duration
    // summary). Bounded by `history_max_events: 5_000` so a
    // Prometheus scrape never accidentally slurps the whole
    // `data/history.jsonl`. Cache TTL knob
    // `dashboard.metrics_per_token_cache_ms` (default 30000)
    // so a 15s scrape interval hits the cache on 14/15 polls.
    // Test seam: callers can pass `opts.metricsSubset2Cache` to
    // override (used by `tests/dashboard-metrics-subset2.test.mjs`).
    // Late-bound ctx: the cache is constructed first with a
    // thin shim that reads from `opts.historyReader`; once the
    // full `ctx` is built below we re-point the shim so the
    // cache sees the canonical ctx.historyReader (including
    // the `clock()` seam if a future test wants it).
    metricsSubset2Cache: (opts.metricsSubset2Cache && typeof opts.metricsSubset2Cache.gather === 'function')
      ? opts.metricsSubset2Cache
      : createSubset2ProbeCacheImpl({
          ctx: { historyReader: opts.historyReader },
          cacheMs: clampMetricsPerTokenCacheMs(dashboardCfg.metrics_per_token_cache_ms),
          historyLimit: clampMetricsHistoryLimit(dashboardCfg.history_max_events),
          nowMs: clock,
        }),
    // T80: subset-3 metrics probes (Prometheus histogram for
    // tick duration + adaptive-weight snapshot). Sourced from
    // `loop.stats()` (NOT history re-read) so a scrape is O(1).
    // No cache layer needed — `loop.stats()` is cheap. Pre-
    // compute at boot; the route handler reads
    // `ctx.metricsSubset3Probes`. Test seam: callers can pass
    // `opts.metricsSubset3Probes` to override (used by
    // `tests/dashboard-metrics-subset3.test.mjs`).
    metricsSubset3Probes: (opts.metricsSubset3Probes && typeof opts.metricsSubset3Probes === 'object')
      ? opts.metricsSubset3Probes
      : (opts.loop && typeof opts.loop === 'object')
        ? gatherSubset3ProbesFromCtxImpl({ ctx: { loop: opts.loop }, opts: { } })
        : null,
  };

  /** @type {import('node:http').Server|null} */
  let server = null;

  async function handler(req, res) {
    if (!req || !res) return;
    const startMs = Date.now();
    let status = 200;
    /** @type {string} */
    let routeName = 'unknown';
    /** @type {Object|string|undefined} */
    let body = undefined;
    /** @type {string} */
    let requestId = randomBytes(6).toString('hex');
    if (req.headers && typeof req.headers['x-request-id'] === 'string' && /** @type {string} */ (req.headers['x-request-id']).length > 0) {
      requestId = /** @type {string} */ (req.headers['x-request-id']);
    }
    try {
      // CORS preflight — short-circuit before route matching.
      if (req.method === 'OPTIONS') {
        applyCors(res, dashboardCfg.cors_origin, req);
        status = 204;
        sendEmpty(res, status);
        routeName = 'OPTIONS';
        return;
      }
      const url = new URL(req.url ?? '/', `http://${req.headers?.host ?? 'localhost'}`);
      // Static file serving: try BEFORE the route matcher so a
      // hashed asset like `/assets/index-AbCd.js` short-circuits
      // and a SPA route like `/portfolio` falls back to `index.html`.
      // `tryServeStatic` is a no-op when `ctx.staticEnabled` is false,
      // when the path looks like an API URL, or when the method is
      // not GET/HEAD. Anything it can't serve falls through.
      if (ctx.staticEnabled && (req.method === 'GET' || req.method === 'HEAD')) {
        const served = await tryServeStatic(ctx, req, res, url.pathname);
        if (served) {
          status = res.statusCode ?? 200;
          routeName = 'static';
          return;
        }
      }
      const matched = matchRoute(routes, req.method ?? 'GET', url.pathname);
      if (!matched) {
        status = 404;
        sendJson(res, status, { error: `no route for ${req.method} ${url.pathname}`, request_id: requestId });
        routeName = 'not_found';
        return;
      }
      routeName = `${matched.route.method} ${url.pathname}`;
      // Auth gate.
      if (matched.route.auth) {
        const headerName = (typeof dashboardCfg.auth_header_name === 'string' && dashboardCfg.auth_header_name.length > 0)
          ? dashboardCfg.auth_header_name.toLowerCase() : 'authorization';
        const provided = req.headers && typeof req.headers[headerName] === 'string'
          ? /** @type {string} */ (req.headers[headerName]) : null;
        if (!isAuthed(provided ?? '', dashboardCfg.api_token ?? '')) {
          status = 503;
          sendJson(res, status, {
            error: 'dashboard auth not configured or token mismatch — set dashboard.api_token in user.json to enable writes',
            code: 'AUTH_NOT_CONFIGURED',
            request_id: requestId,
          });
          routeName = `${routeName} (auth-rejected)`;
          return;
        }
      }
      // Body parsing for write methods (PUT / POST).
      if (matched.route.method === 'PUT' || matched.route.method === 'POST') {
        body = await readBody(req, dashboardCfg.request_timeout_ms);
        if (body && typeof body === 'object' && body.__parseError) {
          status = 400;
          sendJson(res, status, {
            error: body.message ?? 'invalid JSON body',
            code: 'BAD_BODY',
            request_id: requestId,
          });
          return;
        }
      }
      applyCors(res, dashboardCfg.cors_origin, req);
      const result = await matched.route.handler(ctx, matched.params, url, body ?? null);
      status = statusForResult(result);
      // T78 subset 1 — text-response dispatch path. A handler
      // can opt into a non-JSON response by returning
      // `{__text_response:true, content_type, body, ...}`. The
      // dispatcher emits the body verbatim with the requested
      // content type so the Prometheus scraper sees the right
      // `text/plain; version=0.0.4; charset=utf-8` header.
      if (result && typeof result === 'object' && result.__text_response === true) {
        const contentType = (typeof result.content_type === 'string' && result.content_type.length > 0)
          ? result.content_type
          : 'text/plain; charset=utf-8';
        sendText(res, status, result.body ?? '', contentType);
      } else {
        sendJson(res, status, result);
      }
    } catch (err) {
      // Allow route handlers to surface 4xx errors by throwing with
      // a numeric `statusCode` field (e.g. 404 for "not found",
      // 400 for "bad body"). Default to 500 for everything else.
      const explicitStatus = (err && typeof err === 'object' && typeof /** @type {any} */ (err).statusCode === 'number')
        ? /** @type {number} */ (/** @type {any} */ (err).statusCode)
        : null;
      status = explicitStatus !== null && explicitStatus >= 400 && explicitStatus < 600 ? explicitStatus : 500;
      const isClientError = status >= 400 && status < 500;
      if (isClientError) {
        logger.warn('dashboard.request.client-error', {
          request_id: requestId,
          route: routeName,
          status,
          err_name: err?.name ?? 'Error',
          err_message: err?.message ?? String(err),
        });
        sendJson(res, status, {
          error: err?.message ?? 'client error',
          code: /** @type {any} */ (err)?.code ?? 'CLIENT_ERROR',
          request_id: requestId,
        });
      } else {
        logger.error('dashboard.request.error', {
          request_id: requestId,
          route: routeName,
          err_name: err?.name ?? 'Error',
          err_message: err?.message ?? String(err),
          err_stack: err?.stack ?? null,
        });
        sendJson(res, status, {
          error: 'internal server error',
          code: 'INTERNAL',
          request_id: requestId,
        });
      }
    } finally {
      logger.info('dashboard.request', {
        request_id: requestId,
        route: routeName,
        method: req.method ?? 'UNKNOWN',
        url: req.url ?? '/',
        status,
        duration_ms: Date.now() - startMs,
      });
    }
  }

  return {
    handler,
    ctx,
    routes,
    get server() { return server; },
    isRunning() { return server !== null && server.listening; },
    async start() {
      if (server !== null) {
        throw new DashboardLifecycleError('start: server is already running');
      }
      const host = dashboardCfg.bind_host;
      const port = dashboardCfg.bind_port;
      server = http.createServer(handler);
      await new Promise((resolve, reject) => {
        const onError = (e) => {
          server.removeListener('listening', onListening);
          reject(e);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        try {
          server.listen(port, host);
        } catch (e) {
          reject(e);
        }
      });
      logger.info('dashboard.started', {
        host,
        port,
        bind_host: host,
        bind_port: port,
        auth_configured: !!(dashboardCfg.api_token && dashboardCfg.api_token.length > 0),
      });
      return server;
    },
    async stop() {
      if (server === null) return;
      const s = server;
      server = null;
      await new Promise((resolve, reject) => {
        s.close((err) => {
          if (err) reject(err); else resolve();
        });
      });
      logger.info('dashboard.stopped', {});
    },
  };
}

/**
 * Apply CORS headers. `cors_origin` of `'*'` enables wildcard;
 * `null` (= default) sets no Access-Control-Allow-Origin header
 * (same-origin only). Anything else is echoed back verbatim.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {string|null} corsOrigin
 * @param {import('node:http').IncomingMessage} req
 */
function applyCors(res, corsOrigin, req) {
  if (typeof corsOrigin !== 'string' || corsOrigin.length === 0) return;
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  const requested = (req && req.headers && typeof req.headers['access-control-request-headers'] === 'string')
    ? /** @type {string} */ (req.headers['access-control-request-headers']) : 'authorization, content-type';
  res.setHeader('Access-Control-Allow-Headers', requested);
  res.setHeader('Access-Control-Max-Age', '600');
}

/**
 * Read the request body up to `maxBytes` (default 64 KB; the dashboard
 * only ever accepts small config patches). Returns `{ __parseError,
 * message }` on bad JSON (the caller maps this to HTTP 400).
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} timeoutMs
 * @param {number} [maxBytes=65536]
 * @returns {Promise<any>}
 */
function readBody(req, timeoutMs, maxBytes = 65_536) {
  return new Promise((resolve) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let total = 0;
    let resolved = false;
    const finish = (v) => {
      if (resolved) return;
      resolved = true;
      resolve(v);
    };
    const timer = setTimeout(() => finish({ __parseError: true, message: 'request body read timed out' }), Math.max(1, timeoutMs));
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        clearTimeout(timer);
        finish({ __parseError: true, message: `request body exceeds ${maxBytes} bytes` });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      clearTimeout(timer);
      const buf = Buffer.concat(chunks);
      if (buf.length === 0) {
        finish({});
        return;
      }
      try {
        const parsed = JSON.parse(buf.toString('utf8'));
        finish(parsed);
      } catch (e) {
        finish({ __parseError: true, message: e?.message ?? 'JSON parse error' });
      }
    });
    req.on('error', (e) => {
      clearTimeout(timer);
      finish({ __parseError: true, message: e?.message ?? 'request stream error' });
    });
  });
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {Object} body
 */
function sendJson(res, status, body) {
  const data = JSON.stringify(body, (_k, v) => {
    if (typeof v === 'bigint') return v.toString();
    return v;
  });
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', Buffer.byteLength(data));
  res.end(data);
}

/**
 * T78 subset 1 — emit a verbatim text body with a caller-
 * supplied content type. Used by the `/metrics` route handler
 * to serve Prometheus text format (`text/plain;
 * version=0.0.4; charset=utf-8`). Mirrors `sendJson`'s shape
 * (sets status, content-length, cache-control) so a scraper
 * sees the same headers the rest of the dashboard emits.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} body
 * @param {string} contentType
 */
function sendText(res, status, body, contentType) {
  const data = (typeof body === 'string') ? body : String(body ?? '');
  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', Buffer.byteLength(data, 'utf8'));
  res.end(data);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 */
function sendEmpty(res, status) {
  res.statusCode = status;
  res.setHeader('Content-Length', '0');
  res.end();
}

// ─────────────────────────────────────────────────────────────────────
//  Default history reader
// ─────────────────────────────────────────────────────────────────────

/**
 * Build a default `historyReader` adapter that reads the on-disk
 * NDJSON file once and lets the dashboard filter / window in
 * memory. Caching for the life of one request is the safe play —
 * the file is append-only and small (sub-MB even after a year of
 * 1-min ticks), so we can just slurp it on every read.
 *
 * The reader is intentionally separate from `trader/loop.mjs`'s
 * `createHistoryAppender` so the dashboard backend never has to
 * import the trading loop.
 *
 * @param {Object} opts
 * @param {string} opts.file
 * @param {Function} [opts.fs]
 * @returns {{ read: (opts: { sinceMs?: number|null, kind?: string|null, limit?: number }) => Promise<{ events: Object[], errors: Array<{ file: string, line: number, error: string }> }> }}
 */
export function createHistoryReader({ file, fs } = {}) {
  if (typeof file !== 'string' || file.length === 0) {
    throw new DashboardConfigError(`createHistoryReader: file required; got ${JSON.stringify(file)}`);
  }
  const fsImpl = fs ?? null;
  /** @type {Array<Object>} */
  let cache = null;
  /** @type {Array<{ file: string, line: number, error: string }>} */
  let cacheErrors = [];
  /** @type {number} */
  let cachedAt = 0;
  const CACHE_TTL_MS = 1500; // cheap rate-limiter; <loop poll cadence
  async function load() {
    try {
      const { lines, errors } = await readNdjsonFile(file, { fs: fsImpl ?? undefined });
      cache = lines;
      cacheErrors = errors;
      cachedAt = Date.now();
    } catch (e) {
      if (e && typeof e === 'object' && /** @type {any} */ (e).code === 'ENOENT') {
        cache = [];
        cacheErrors = [];
        cachedAt = Date.now();
      } else {
        throw e;
      }
    }
  }
  return {
    async read({ sinceMs = null, kind = null, limit = Infinity } = {}) {
      if (cache === null || (Date.now() - cachedAt) > CACHE_TTL_MS) {
        await load();
      }
      const events = filterHistory(cache ?? [], { sinceMs, kind, limit });
      return { events, errors: cacheErrors };
    },
    /** Test seam: force a fresh load on the next read. */
    invalidate() {
      cache = null;
      cachedAt = 0;
    },
  };
}

export const _internals = {
  readBody,
  sendJson,
  sendEmpty,
  applyCors,
  deepMerge,
  // T45: export the manual-trade handler for direct unit testing.
  // The route table itself is exercised via supertest; exposing
  // this lets tests call the handler with a hand-rolled ctx without
  // mounting the full HTTP surface (faster + isolates the swap-result
  // envelope shaping).
  executeManualTrade,
};
