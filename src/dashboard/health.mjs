#!/usr/bin/env node
// src/dashboard/health.mjs
//
// T61 — extended `/healthz` builder.
//
// The dashboard's `/healthz` route used to return a static
// `{ok:true, ts:..., uptime_s:...}` envelope. That's not enough
// for an external monitor (Prometheus, uptime checker, Nagios)
// to distinguish "the bot is alive but the trader loop is stuck"
// from "the bot is dead". The fix: surface every per-probe
// signal the process already has in memory:
//
//   - `loop` — `last_tick_age_ms`, `loop_running`, `tick_count`
//              (from `TradingLoop.stats()`).
//   - `positions` — `open_count` (from `ctx.positions.list('open')`).
//   - `wallet` — `utxo_count` (from `ctx.wallet.listUtxos()`).
//   - `breaker` — full state envelope (from `ctx.risk.state()`)
//                 — `is_tripped`, `trip_kind`, `consecutive_losses`,
//                 `recent_daily_pnl_bch`.
//
// Every probe is **optional and defensive**:
//
//   - When the underlying dependency (`loop`, `wallet`, `breaker`,
//     `positions`) isn't wired, the probe reports
//     `status:'unconfigured'` with a `null` value.
//   - When the dependency is wired but throws, the probe reports
//     `status:'degraded'` with a `null` value + a structured log
//     line so the operator can chase the failure without the
//     endpoint returning an error (monitors MUST be able to poll
//     `/healthz` even when the bot is half-broken).
//   - The endpoint is never auth-gated (so a probe scraping without
//     a token still gets the envelope).
//
// All entry points are PURE except for the bottom-level I/O wrapper
// `buildExtendedHealthz` which is a thin async wrapper (it awaits
// `positions.list`, `wallet.listUtxos`, etc.). Pure helpers are
// exported below so tests + the dashboard layer can assert on the
// shape without touching a live wallet.
//
// Wire shape (consumed by the existing `GET /healthz` route in
// `src/dashboard/server.mjs` and by external monitors):
//
//   {
//     schema: 'tradebot.dashboard.health/v1',
//     ok: true,
//     ts: <iso>,
//     uptime_s: <number>,
//     loop: { tick_count, last_tick_at_ms, last_tick_age_ms,
//             loop_running, last_tick_duration_ms,
//             status: 'ok'|'degraded'|'unconfigured',
//             error: <string|null> },
//     positions: { open_count,
//                  status: 'ok'|'degraded'|'unconfigured',
//                  error: <string|null> },
//     wallet: { utxo_count,
//               utxo_timeout_ms,
//               status: 'ok'|'degraded'|'unconfigured',
//               error: <string|null> },
//     breaker: { is_tripped, trip_kind,
//                consecutive_losses, recent_daily_pnl_bch,
//                loss_cooldown_remaining_ms,
//                status: 'ok'|'degraded'|'unconfigured',
//                error: <string|null> },
//     probes: { loop: 'ok'|'degraded'|'unconfigured',
//               positions: ..., wallet: ..., breaker: ... },
//   }
//
// OK is ALWAYS `true` from this builder — the route surfaces "the
// process is responsive" rather than "every probe is healthy".
// Monitors that want a single boolean probe every signal rolls up
// to use `probes.*` and treat any `'degraded'` probe as
// "investigate". The endpoint also reports `breaker.trip_kind`
// specifically so a tripped circuit breaker shows up without
// failing the route.

/**
 * Schema constant — exported so tests + the dashboard can pin
 * the envelope shape without depending on the literal string.
 *
 * @type {string}
 */
export const HEALTH_SCHEMA = 'tradebot.dashboard.health/v1';

/**
 * Per-probe statuses. Mirror of the wire shape — `ok` / `degraded` /
 * `unconfigured`. We export them as constants so a downstream
 * alert rule can compare literally (no string typos).
 */
export const PROBE_STATUS_OK = 'ok';
export const PROBE_STATUS_DEGRADED = 'degraded';
export const PROBE_STATUS_UNCONFIGURED = 'unconfigured';

/** @type {number} default UTXO scan timeout (ms). Mirror of `dashboard.health_utxo_timeout_ms`. */
export const DEFAULT_HEALTH_UTXO_TIMEOUT_MS = 5000;

/** @type {number} bound on stale-loop classification (ms). Above this we treat the loop as degraded. */
export const DEFAULT_STALE_LOOP_AGE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Coerce a value to a non-negative integer. Defensive against
 * NaN / Infinity / float / non-numeric. Pure.
 *
 * @param {unknown} v
 * @returns {number}
 */
export function asCount(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.floor(v) === v) {
    return v;
  }
  return 0;
}

/**
 * Coerce a value to a `>= 100` integer timeout. Returns
 * `DEFAULT_HEALTH_UTXO_TIMEOUT_MS` for missing / invalid
 * inputs so callers never accidentally pass `0` (which would
 * resolve instantly and return `utxo_count:0`).
 *
 * @param {unknown} v
 * @returns {number}
 */
export function asTimeoutMs(v) {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : NaN;
  if (!Number.isFinite(n) || n < 100 || n > 60_000) {
    return DEFAULT_HEALTH_UTXO_TIMEOUT_MS;
  }
  return n;
}

/**
 * Pull a loop's `stats()` envelope into the health shape, defaulting
 * to `null` fields when the loop isn't wired. Never throws.
 *
 * @param {{ stats: () => Object } | null | undefined} loop
 * @param {number} nowMs
 * @param {number} [staleLoopAgeMs]
 * @returns {{
 *   tick_count: number|null,
 *   last_tick_at_ms: number|null,
 *   last_tick_age_ms: number|null,
 *   last_tick_duration_ms: number|null,
 *   loop_running: boolean|null,
 *   status: 'ok'|'degraded'|'unconfigured',
 *   error: string|null,
 * }}
 */
export function buildLoopProbe(loop, nowMs, staleLoopAgeMs = DEFAULT_STALE_LOOP_AGE_MS) {
  if (!loop || typeof loop.stats !== 'function') {
    return {
      tick_count: null,
      last_tick_at_ms: null,
      last_tick_age_ms: null,
      last_tick_duration_ms: null,
      loop_running: null,
      status: PROBE_STATUS_UNCONFIGURED,
      error: null,
    };
  }
  let stats;
  try {
    stats = loop.stats();
  } catch (e) {
    return {
      tick_count: null,
      last_tick_at_ms: null,
      last_tick_age_ms: null,
      last_tick_duration_ms: null,
      loop_running: null,
      status: PROBE_STATUS_DEGRADED,
      error: (e && e.message) ? String(e.message) : 'loop.stats() threw',
    };
  }
  const tickCount = asCount(stats?.tick_count);
  const lastTickAtMs = (typeof stats?.last_tick_at_ms === 'number' && Number.isFinite(stats.last_tick_at_ms))
    ? stats.last_tick_at_ms
    : 0;
  const lastTickAgeMs = lastTickAtMs > 0 ? Math.max(0, nowMs - lastTickAtMs) : null;
  const lastTickDurationMs = (typeof stats?.last_tick_duration_ms === 'number' && Number.isFinite(stats.last_tick_duration_ms))
    ? Math.max(0, stats.last_tick_duration_ms)
    : null;
  // Classify the loop as `degraded` when it's supposed to be running
  // (tick_count > 0) but hasn't ticked in `staleLoopAgeMs`. This
  // turns the existing "stuck-bot" detection into a single field
  // a monitor can alert on without scraping the dashboard.
  let status = PROBE_STATUS_OK;
  let error = null;
  if (lastTickAtMs === 0) {
    // The bot hasn't ticked yet — could be mid-boot OR could be a
    // dry-run that's paused. Surface as `ok` with `null` age so the
    // monitor doesn't fire before the first tick lands.
  } else if (lastTickAgeMs > staleLoopAgeMs) {
    status = PROBE_STATUS_DEGRADED;
    error = `last_tick_age_ms=${lastTickAgeMs} exceeds stale_loop_age_ms=${staleLoopAgeMs}`;
  }
  return {
    tick_count: tickCount,
    last_tick_at_ms: lastTickAtMs,
    last_tick_age_ms: lastTickAgeMs,
    last_tick_duration_ms: lastTickDurationMs,
    loop_running: stats?.running === true,
    status,
    error,
  };
}

/**
 * Pull positions.open count. Pure-ish — only the `await
 * positions.list('open')` is I/O. The caller passes the result in.
 *
 * @param {Array<unknown> | null | undefined} openPositions
 * @param {{ message?: string } | null | undefined} thrownOnList
 * @returns {{
 *   open_count: number|null,
 *   status: 'ok'|'degraded'|'unconfigured',
 *   error: string|null,
 * }}
 */
export function buildPositionsProbe(openPositions, thrownOnList = null) {
  if (thrownOnList) {
    return {
      open_count: null,
      status: PROBE_STATUS_DEGRADED,
      error: thrownOnList.message ? String(thrownOnList.message) : 'positions.list threw',
    };
  }
  if (openPositions === null || openPositions === undefined) {
    return {
      open_count: null,
      status: PROBE_STATUS_UNCONFIGURED,
      error: null,
    };
  }
  if (!Array.isArray(openPositions)) {
    return {
      open_count: null,
      status: PROBE_STATUS_DEGRADED,
      error: 'positions.list returned non-array',
    };
  }
  return {
    open_count: openPositions.length,
    status: PROBE_STATUS_OK,
    error: null,
  };
}

/**
 * Pull UTXO count with a timeout-bounded `await listUtxos()`. The
 * timeout is critical: a slow Electrum provider shouldn't block a
 * 200ms healthcheck, and a PIES-style UTXO scan on a busy wallet
 * can take 10+ seconds on first boot. We race the call against a
 * timeout and surface `status:'degraded'` (with `null` count) when
 * the timeout wins — never block the monitor.
 *
 * @param {{ listUtxos: () => Promise<Array<unknown>> } | null | undefined} wallet
 * @param {number} [timeoutMs]
 * @returns {Promise<{
 *   utxo_count: number|null,
 *   utxo_timeout_ms: number,
 *   status: 'ok'|'degraded'|'unconfigured',
 *   error: string|null,
 * }>}
 */
export async function buildWalletProbe(wallet, timeoutMs = DEFAULT_HEALTH_UTXO_TIMEOUT_MS) {
  const budget = asTimeoutMs(timeoutMs);
  if (!wallet || typeof wallet.listUtxos !== 'function') {
    return {
      utxo_count: null,
      utxo_timeout_ms: budget,
      status: PROBE_STATUS_UNCONFIGURED,
      error: null,
    };
  }
  let timer;
  try {
    const utxos = await Promise.race([
      wallet.listUtxos(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`wallet.listUtxos timed out after ${budget}ms`)), budget);
      }),
    ]);
    if (!Array.isArray(utxos)) {
      return {
        utxo_count: null,
        utxo_timeout_ms: budget,
        status: PROBE_STATUS_DEGRADED,
        error: 'wallet.listUtxos returned non-array',
      };
    }
    return {
      utxo_count: utxos.length,
      utxo_timeout_ms: budget,
      status: PROBE_STATUS_OK,
      error: null,
    };
  } catch (e) {
    return {
      utxo_count: null,
      utxo_timeout_ms: budget,
      status: PROBE_STATUS_DEGRADED,
      error: (e && e.message) ? String(e.message) : 'wallet.listUtxos threw',
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Pull breaker state from `ctx.risk` (the wrapper the dashboard
 * context provides). The breaker enforces circuit-breaker trips +
 * loss cooldowns across the bot's lifetime; a tripped breaker is
 * operational data, not a `/healthz` failure — we surface
 * `is_tripped: true` + `trip_kind` so a monitor can alert on
 * "breaker is currently sidelined" specifically.
 *
 * @param {{ state: () => Object } | null | undefined} risk
 * @returns {{
 *   is_tripped: boolean|null,
 *   trip_kind: string|null,
 *   consecutive_losses: number|null,
 *   recent_daily_pnl_bch: number|null,
 *   loss_cooldown_remaining_ms: number|null,
 *   max_daily_loss_bch: number|null,
 *   status: 'ok'|'degraded'|'unconfigured',
 *   error: string|null,
 * }}
 */
export function buildBreakerProbe(risk) {
  if (!risk || typeof risk.state !== 'function') {
    return {
      is_tripped: null,
      trip_kind: null,
      consecutive_losses: null,
      recent_daily_pnl_bch: null,
      loss_cooldown_remaining_ms: null,
      max_daily_loss_bch: null,
      status: PROBE_STATUS_UNCONFIGURED,
      error: null,
    };
  }
  let st;
  try {
    st = risk.state();
  } catch (e) {
    return {
      is_tripped: null,
      trip_kind: null,
      consecutive_losses: null,
      recent_daily_pnl_bch: null,
      loss_cooldown_remaining_ms: null,
      max_daily_loss_bch: null,
      status: PROBE_STATUS_DEGRADED,
      error: (e && e.message) ? String(e.message) : 'risk.state() threw',
    };
  }
  // `recent_daily_pnl_bch` is converted from sats. Pure math; the
  // underlying breaker reports sats so the daily-loss / position-size
  // rounding doesn't muddy the wire.
  const pnlSats = (typeof st?.recentDailyPnlSats === 'number' && Number.isFinite(st.recentDailyPnlSats))
    ? st.recentDailyPnlSats
    : 0;
  return {
    is_tripped: st?.isTripped === true,
    trip_kind: (typeof st?.tripKind === 'string') ? st.tripKind : null,
    consecutive_losses: asCount(st?.consecutiveLosses),
    recent_daily_pnl_bch: pnlSats / 1e8,
    loss_cooldown_remaining_ms: (typeof st?.lossCooldownRemainingMs === 'number' && Number.isFinite(st.lossCooldownRemainingMs))
      ? Math.max(0, st.lossCooldownRemainingMs)
      : null,
    max_daily_loss_bch: (typeof st?.maxDailyLossBch === 'number' && Number.isFinite(st.maxDailyLossBch))
      ? st.maxDailyLossBch
      : null,
    status: PROBE_STATUS_OK,
    error: null,
  };
}

/**
 * Build the wire envelope. Aggregates the four probes, the schema
 * + ts + uptime, and a top-level `probes` map so monitors can
 * branch on a single field (`probes.breaker === 'ok'`) without
 * digging into the per-probe object.
 *
 * Pure-ish: awaits wallet.listUtxos (with a timeout) + positions.list;
 * everything else is synchronous. Never throws — every I/O is wrapped.
 *
 * @param {{
 *   ctx: { loop?: any, risk?: any, wallet?: any, positions?: { list: Function }, logger?: any, dashboardCfg?: Object, cfg?: Object },
 *   nowMs?: number,
 *   clock?: () => number,
 * }} args
 * @returns {Promise<Object>}
 */
export async function buildExtendedHealthz({ ctx, nowMs, clock } = {}) {
  if (!ctx || typeof ctx !== 'object') {
    throw new TypeError('buildExtendedHealthz: ctx required');
  }
  const wallClock = (typeof clock === 'function')
    ? clock
    : (typeof ctx.clock === 'function' ? ctx.clock : () => Date.now());
  const _nowMs = (typeof nowMs === 'number' && Number.isFinite(nowMs)) ? nowMs : wallClock();

  // 1. Loop probe — synchronous. The builder captures its own
  //    throws internally; we additionally log a warn if the probe
  //    comes back degraded so operators have a single audit-trail
  //    entry per failing probe on every healthcheck.
  const loopProbe = buildLoopProbe(ctx.loop, _nowMs);
  if (loopProbe.status === PROBE_STATUS_DEGRADED && ctx.logger && typeof ctx.logger.warn === 'function') {
    ctx.logger.warn('dashboard.health.loop.degraded', { error: loopProbe.error });
  }

  // 2. Positions probe — `positions.list('open')` is async; wrap.
  let openPositions = null;
  let positionsError = null;
  if (ctx.positions && typeof ctx.positions.list === 'function') {
    try {
      const r = await ctx.positions.list('open');
      openPositions = Array.isArray(r) ? r : [];
    } catch (e) {
      positionsError = e;
      if (ctx.logger && typeof ctx.logger.warn === 'function') {
        ctx.logger.warn('dashboard.health.positions.failed', {
          err_name: e?.name ?? 'Error',
          err_message: e?.message ?? String(e),
        });
      }
    }
  }
  const positionsProbe = buildPositionsProbe(openPositions, positionsError);

  // 3. Wallet probe — async + timeout.
  const utxoTimeoutMs = asTimeoutMs(ctx.dashboardCfg?.health_utxo_timeout_ms);
  let walletProbe;
  try {
    walletProbe = await buildWalletProbe(ctx.wallet, utxoTimeoutMs);
  } catch (e) {
    // Defensive: `buildWalletProbe` never throws, but if a future
    // refactor breaks that contract we still want the endpoint
    // to respond (just with a `degraded` probe + a logged error).
    if (ctx.logger && typeof ctx.logger.warn === 'function') {
      ctx.logger.warn('dashboard.health.wallet.failed', {
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
      });
    }
    walletProbe = {
      utxo_count: null,
      utxo_timeout_ms: utxoTimeoutMs,
      status: PROBE_STATUS_DEGRADED,
      error: (e && e.message) ? String(e.message) : 'wallet probe threw',
    };
  }
  // Surface wallet probe failure via structured logger for
  // operators monitoring the audit trail (the probe already
  // captures the error on the wire envelope too).
  if (walletProbe.status === PROBE_STATUS_DEGRADED && ctx.logger && typeof ctx.logger.warn === 'function') {
    ctx.logger.warn('dashboard.health.wallet.degraded', {
      error: walletProbe.error,
      utxo_timeout_ms: walletProbe.utxo_timeout_ms,
    });
  }

  // 4. Breaker probe — synchronous.
  const breakerProbe = buildBreakerProbe(ctx.risk);
  if (breakerProbe.status === PROBE_STATUS_DEGRADED && ctx.logger && typeof ctx.logger.warn === 'function') {
    ctx.logger.warn('dashboard.health.breaker.degraded', { error: breakerProbe.error });
  }

  return {
    schema: HEALTH_SCHEMA,
    ok: true,
    ts: new Date(_nowMs).toISOString(),
    uptime_s: Math.max(0, Math.floor(process.uptime())),
    loop: loopProbe,
    positions: positionsProbe,
    wallet: walletProbe,
    breaker: breakerProbe,
    probes: {
      loop: loopProbe.status,
      positions: positionsProbe.status,
      wallet: walletProbe.status,
      breaker: breakerProbe.status,
    },
  };
}
