#!/usr/bin/env node
// src/dashboard/metrics.mjs
//
// T78 subset 1 — Prometheus-style `/metrics` exporter.
//
// External monitoring systems (Grafana, Datadog, the operator's
// existing Prometheus stack) want Prometheus text-format
// (https://prometheus.io/docs/instrumenting/exposition_formats/).
// This module is the canonical producer: it gathers the same
// in-process signals `/healthz` already exposes (loop stats,
// wallet balance, UTXO count, open-position count, breaker state)
// plus a few process-level signals the operator asked for in
// `idea_metric_export_20260920` (cumulative entry / exit / error
// counters, rug-pattern check counters, uptime), then renders
// them as a Prometheus text-format blob for the `GET /metrics`
// endpoint in `src/dashboard/server.mjs`.
//
// Design rules:
//
//   1. **Pure shape.** `buildMetricsEnvelope(ctx, nowMs)` accepts
//      the same `ctx` shape `/healthz` uses (loop, wallet,
//      positions, risk) + the new cumulative counters on the
//      loop. Each probe is gathered inside its own try/catch so a
//      single broken probe (e.g. wallet down) surfaces as an
//      `unconfigured`/`degraded` sample instead of failing the
//      whole endpoint. A Prometheus scraper MUST be able to poll
//      `/metrics` even when the bot is half-broken — otherwise the
//      monitor's "no data" alarm fires instead of a real one.
//
//   2. **Defensive coercions.** `asCounter` / `asGauge` /
//      `asTimestampMs` clamp invalid input (NaN, Infinity, string,
//      null, undefined, non-finite) to a safe fallback so a typo
//      or schema drift in any one probe can't poison the wire
//      format. Counter coercions floor at 0 (negative counts are
//      nonsensical for Prometheus); gauge coercions preserve sign
//      (BCH balance can legitimately be 0 but not negative).
//
//   3. **Label escaping.** Prometheus text format requires
//      `\\`, `\"`, `\n` escapes inside label values. We do that
//      in one helper (`escapeLabelValue`) so callers can't
//      accidentally produce unparseable text.
//
//   4. **Deterministic output.** `formatPrometheusText` always
//      emits metric blocks in the order the caller supplied +
//      sorts samples within a block by label-tuple (so repeated
//      scrapes produce identical text — Prometheus dedup uses
//      line hash, byte-identical scrapes are the fastest path).
//
//   5. **No `console.log`.** Pure ESM, no I/O, no logger — the
//      caller (route handler) is the one place that catches
//      failures and emits structured logs.
//
// Wire envelope (consumed by the route handler, not the wire —
// the wire is the Prometheus text format):
//
//   {
//     schema: 'tradebot.dashboard.metrics/v1',
//     ok: true,
//     ts: <iso>,
//     uptime_s: <number>,
//     metrics: [
//       {
//         name: 'tradebot_loop_tick_count_total',
//         type: 'counter',
//         help: 'Total number of trader loop ticks since process start',
//         samples: [{ labels: {}, value: '42' }],
//       },
//       ...
//     ],
//   }
//
// Prometheus text format example:
//
//   # HELP tradebot_up Process is responsive (1) or not (0)
//   # TYPE tradebot_up gauge
//   tradebot_up 1
//   # HELP tradebot_loop_tick_count_total Total number of trader loop ticks since process start
//   # TYPE tradebot_loop_tick_count_total counter
//   tradebot_loop_tick_count_total 42
//   ...

/**
 * Schema constant — exported so tests + the dashboard can pin
 * the envelope shape without depending on the literal string.
 *
 * @type {string}
 */
export const METRICS_SCHEMA = 'tradebot.dashboard.metrics/v1';

/**
 * Prometheus content-type. The standard text format version is
 * `0.0.4`. Per the Prometheus spec, this header is what a
 * scraper parses to decide format.
 *
 * @type {string}
 */
export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/**
 * Default timeout (ms) for the wallet UTXO probe. Mirrors the
 * `/healthz` UTXO timeout so a slow Electrum provider can't
 * block a 200ms scrape.
 *
 * @type {number}
 */
export const DEFAULT_METRICS_UTXO_TIMEOUT_MS = 5000;

/**
 * Defensive integer coercion for Prometheus **counters**.
 * Counters monotonically increase (or stay flat); negative
 * values are nonsensical and a sign of upstream drift, so
 * we clamp to 0. NaN / Infinity / string / null / undefined
 * / non-finite all degrade to 0.
 *
 * @param {unknown} v
 * @returns {number}
 */
export function asCounter(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.floor(v) === v) {
    return v;
  }
  return 0;
}

/**
 * Defensive numeric coercion for Prometheus **gauges**. Gauges
 * CAN be negative (BCH P&L can be negative, daily-loss
 * counterbalance can be negative) so we preserve sign here —
 * only NaN / Infinity / non-number coerce to 0.
 *
 * @param {unknown} v
 * @returns {number}
 */
export function asGauge(v) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v;
  }
  return 0;
}

/**
 * Defensive coercion for a millisecond timestamp. Returns 0
 * when input is missing / non-finite (Prometheus timestamps
 * before 1970 are nonsensical; we treat un-wired probes as
 * "epoch" so the line is still emitted, just stale-looking).
 *
 * @param {unknown} v
 * @returns {number}
 */
export function asTimestampMs(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
    return v;
  }
  return 0;
}

/**
 * Escape a label value for the Prometheus text format.
 * Per the spec, label values MUST escape `\\`, `\"`, and `\n`
 * (in that order — escaping the backslash first prevents
 * double-escaping the escape chars introduced by the later
 * passes). Everything else passes through verbatim.
 *
 * Pure. Never throws. Always returns a string (empty for
 * non-string input).
 *
 * @param {unknown} v
 * @returns {string}
 */
export function escapeLabelValue(v) {
  if (typeof v !== 'string') return '';
  return v
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

/**
 * Render a single label set as the trailing `{k="v",k2="v2"}`
 * portion of a Prometheus line. Returns `''` for an empty/null
 * label set so un-labelled samples stay clean.
 *
 * Pure.
 *
 * @param {Record<string, string|number|undefined>|null|undefined} labels
 * @returns {string}
 */
export function formatLabels(labels) {
  if (!labels || typeof labels !== 'object') return '';
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  const parts = [];
  for (const k of keys) {
    // Drop undefined / null values — Prometheus spec forbids
    // them and the line would otherwise emit `{k="undefined"}`.
    const raw = labels[k];
    if (raw === undefined || raw === null) continue;
    parts.push(`${k}="${escapeLabelValue(String(raw))}"`);
  }
  if (parts.length === 0) return '';
  return `{${parts.join(',')}}`;
}

/**
 * Build a single metric block — the `# HELP` / `# TYPE` /
 * sample-lines trio a Prometheus scraper expects.
 *
 * Pure. Caller supplies an already-gathered array of samples;
 * this function only handles text formatting.
 *
 * T80 — histogram blocks are supported via the `'histogram'`
 * type. Each histogram sample carries an optional `__suffix`
 * field that, if present and equal to `'bucket' | 'sum' |
 * 'count'`, is appended to the metric name (so a histogram
 * block emits `<name>_bucket{le="..."}`, `<name>_sum`,
 * `<name>_count` lines per Prometheus convention). Samples
 * without a `__suffix` are rendered as `<name> ...` (treated
 * as buckets for backward compatibility).
 *
 * @param {{
 *   name: string,
 *   type: 'counter'|'gauge'|'untyped'|'histogram',
 *   help: string,
 *   samples: Array<{ labels?: Record<string,string|number|undefined>, value: number|string, __suffix?: 'bucket'|'sum'|'count' }>,
 * }} spec
 * @returns {string}
 */
export function formatMetricBlock(spec) {
  if (!spec || typeof spec !== 'object') return '';
  const name = (typeof spec.name === 'string' && /^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(spec.name))
    ? spec.name
    : '';
  if (!name) return ''; // Refuse to emit a metric with an invalid name.
  const type = (spec.type === 'counter' || spec.type === 'gauge' || spec.type === 'untyped' || spec.type === 'histogram')
    ? spec.type
    : 'untyped';
  const help = (typeof spec.help === 'string') ? spec.help.replace(/[\r\n]+/g, ' ').trim() : '';
  const samples = Array.isArray(spec.samples) ? spec.samples : [];
  const lines = [];
  if (help) {
    // Per the spec, HELP is escaped: backslash + newline.
    lines.push(`# HELP ${name} ${help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}`);
  }
  lines.push(`# TYPE ${name} ${type}`);
  for (const s of samples) {
    const labelsStr = formatLabels(s?.labels);
    // Values are stringified verbatim — Prometheus accepts ints
    // and floats but a `value.toString()` is always safe.
    const v = (typeof s?.value === 'number' && Number.isFinite(s.value))
      ? s.value.toString()
      : (typeof s?.value === 'string' ? s.value : '0');
    // T80 — histogram per-sample suffix. The block name is the
    // BASE name (e.g. `tradebot_loop_tick_duration_ms`); each
    // sample's `__suffix` (`'bucket'` / `'sum'` / `'count'`)
    // gets appended so the wire format is `_bucket{le=...}` /
    // `_sum` / `_count`. Unknown suffixes are silently dropped
    // (the sample is rendered as `<base_name>` only) so a
    // future schema drift doesn't crash the renderer.
    let lineName = name;
    if (type === 'histogram' && s && typeof s === 'object') {
      const suf = s.__suffix;
      if (suf === 'bucket' || suf === 'sum' || suf === 'count') {
        lineName = `${name}_${suf}`;
      }
    }
    if (labelsStr) {
      lines.push(`${lineName}${labelsStr} ${v}`);
    } else {
      lines.push(`${lineName} ${v}`);
    }
  }
  return lines.join('\n');
}

/**
 * Format a metrics envelope as Prometheus text-format. Blocks
 * are emitted in the order supplied (deterministic — same
 * caller ordering → same wire bytes); samples within a block
 * are sorted by label-tuple so repeated scrapes produce
 * byte-identical text (Prometheus dedup is line-hash-based;
 * byte-identical lines are the fastest path).
 *
 * Pure. Returns a string with a trailing newline so the
 * response body parses cleanly.
 *
 * @param {{
 *   schema?: string,
 *   ok?: boolean,
 *   ts?: string,
 *   uptime_s?: number,
 *   metrics: Array<{
 *     name: string,
 *     type: 'counter'|'gauge'|'untyped',
 *     help: string,
 *     samples: Array<{ labels?: Record<string,string|number|undefined>, value: number|string }>,
 *   }>,
 * }} envelope
 * @returns {string}
 */
export function formatPrometheusText(envelope) {
  if (!envelope || typeof envelope !== 'object') return '';
  const blocks = Array.isArray(envelope.metrics) ? envelope.metrics : [];
  const out = [];
  for (const spec of blocks) {
    // T80 — histogram blocks preserve insertion order
    // (buckets ascending by `le`, then `_sum`, then `_count`)
    // so the wire format follows Prometheus convention. Other
    // block types still get the label-tuple sort for byte-
    // stable scrapes.
    const isHistogram = spec && spec.type === 'histogram';
    const sortedSpec = isHistogram
      ? { ...spec, samples: Array.isArray(spec.samples) ? [...spec.samples] : [] }
      : {
          ...spec,
          samples: Array.isArray(spec.samples)
            ? [...spec.samples].sort((a, b) => {
                const la = formatLabels(a?.labels);
                const lb = formatLabels(b?.labels);
                if (la < lb) return -1;
                if (la > lb) return 1;
                return 0;
              })
            : [],
        };
    const block = formatMetricBlock(sortedSpec);
    if (block) out.push(block);
  }
  return out.length === 0 ? '' : `${out.join('\n\n')}\n`;
}

/**
 * Pull the loop's `stats()` envelope into per-counter / per-
 * gauge samples. Returns an array of metric-block specs. Defensive
 * against a missing / throwing loop — surfaces `unconfigured`
 * gauges (with `0` values + an explicit `probe_status="unconfigured"`
 * label) so the scrape still parses.
 *
 * Pure — only the `ctx.loop.stats()` call has a side effect
 * (and that's a read).
 *
 * @param {any} ctx
 * @returns {{
 *   metrics: Array<{
 *     name: string,
 *     type: 'counter'|'gauge'|'untyped',
 *     help: string,
 *     samples: Array<{ labels?: Record<string,string|number|undefined>, value: number|string }>,
 *   }>,
 *   probeStatus: 'ok'|'degraded'|'unconfigured',
 *   error: string|null,
 * }}
 */
export function gatherLoopMetrics(ctx) {
  const loop = ctx?.loop;
  if (!loop || typeof loop.stats !== 'function') {
    return {
      probeStatus: 'unconfigured',
      error: null,
      metrics: [
        {
          name: 'tradebot_loop_running',
          type: 'gauge',
          help: 'Whether the trader loop is currently running (1=yes, 0=no)',
          samples: [{ labels: { probe_status: 'unconfigured' }, value: 0 }],
        },
        {
          name: 'tradebot_loop_tick_count_total',
          type: 'counter',
          help: 'Total number of trader loop ticks since process start',
          samples: [{ labels: { probe_status: 'unconfigured' }, value: 0 }],
        },
      ],
    };
  }
  let stats;
  try {
    stats = loop.stats();
  } catch (e) {
    return {
      probeStatus: 'degraded',
      error: (e && e.message) ? String(e.message) : 'loop.stats() threw',
      metrics: [
        {
          name: 'tradebot_loop_running',
          type: 'gauge',
          help: 'Whether the trader loop is currently running (1=yes, 0=no)',
          samples: [{ labels: { probe_status: 'degraded' }, value: 0 }],
        },
        {
          name: 'tradebot_loop_tick_count_total',
          type: 'counter',
          help: 'Total number of trader loop ticks since process start',
          samples: [{ labels: { probe_status: 'degraded' }, value: 0 }],
        },
      ],
    };
  }
  const tickCount = asCounter(stats?.tick_count);
  const entryAttemptCount = asCounter(stats?.entry_attempt_count);
  const exitAttemptCount = asCounter(stats?.exit_attempt_count);
  const errorCount = asCounter(stats?.error_count);
  const lastTickAtMs = asTimestampMs(stats?.last_tick_at_ms);
  const lastTickDurationMs = asTimestampMs(stats?.last_tick_duration_ms);
  const running = stats?.running === true ? 1 : 0;
  // Rug-pattern gate per-tick counters — these are per-TICK
  // (reset every tick) so we emit them with an `outcome=`
  // label. They're not cumulative across process lifetime.
  const rug = (stats?.rug_pattern_gate?.last_tick && typeof stats.rug_pattern_gate.last_tick === 'object')
    ? stats.rug_pattern_gate.last_tick
    : {};
  const rugOutcomes = [
    ['checked', asCounter(rug.checked_count)],
    ['cache_hit', asCounter(rug.cache_hit_count)],
    ['detected', asCounter(rug.detected_count)],
    ['error', asCounter(rug.error_count)],
    ['token_not_found', asCounter(rug.token_not_found_count)],
    ['skipped_unwired', asCounter(rug.skipped_unwired_count)],
  ];
  return {
    probeStatus: 'ok',
    error: null,
    metrics: [
      {
        name: 'tradebot_loop_running',
        type: 'gauge',
        help: 'Whether the trader loop is currently running (1=yes, 0=no)',
        samples: [{ labels: { probe_status: 'ok' }, value: running }],
      },
      {
        name: 'tradebot_loop_tick_count_total',
        type: 'counter',
        help: 'Total number of trader loop ticks since process start',
        samples: [{ labels: { probe_status: 'ok' }, value: tickCount }],
      },
      {
        name: 'tradebot_loop_entry_attempt_count_total',
        type: 'counter',
        help: 'Cumulative count of entry attempts (positions.open invocations) since process start',
        samples: [{ labels: { probe_status: 'ok' }, value: entryAttemptCount }],
      },
      {
        name: 'tradebot_loop_exit_attempt_count_total',
        type: 'counter',
        help: 'Cumulative count of exit attempts (positions.close invocations) since process start',
        samples: [{ labels: { probe_status: 'ok' }, value: exitAttemptCount }],
      },
      {
        name: 'tradebot_loop_error_count_total',
        type: 'counter',
        help: 'Cumulative count of per-tick errors since process start',
        samples: [{ labels: { probe_status: 'ok' }, value: errorCount }],
      },
      {
        name: 'tradebot_loop_last_tick_age_seconds',
        type: 'gauge',
        help: 'Age of the last trader loop tick in seconds (0 if the loop has not ticked yet)',
        samples: [{
          labels: { probe_status: 'ok' },
          value: lastTickAtMs > 0 ? (Math.max(0, Date.now() - lastTickAtMs) / 1000) : 0,
        }],
      },
      {
        name: 'tradebot_loop_last_tick_duration_ms',
        type: 'gauge',
        help: 'Duration of the last trader loop tick in milliseconds',
        samples: [{ labels: { probe_status: 'ok' }, value: lastTickDurationMs }],
      },
      {
        name: 'tradebot_loop_rug_pattern_checked_total',
        type: 'counter',
        help: 'Per-tick count of rug-pattern checks performed by outcome label',
        samples: rugOutcomes.map(([outcome, value]) => ({
          labels: { outcome, probe_status: 'ok' },
          value,
        })),
      },
    ],
  };
}

/**
 * Pull the wallet's balance + UTXO count into gauge samples.
 * Defensive — missing wallet / throwing `getBalanceSats` /
 * throwing `listUtxos` all degrade to `unconfigured` or
 * `degraded` probes (with a `probe_status` label) so the
 * scrape still parses.
 *
 * Async — `getBalanceSats()` and `listUtxos()` are async I/O.
 * The UTXO list call is wrapped with the same timeout race the
 * `/healthz` builder uses so a slow Electrum provider can't
 * block a 200ms scrape.
 *
 * @param {any} ctx
 * @param {number} [utxoTimeoutMs]
 * @returns {Promise<{
 *   metrics: Array<{
 *     name: string,
 *     type: 'counter'|'gauge'|'untyped',
 *     help: string,
 *     samples: Array<{ labels?: Record<string,string|number|undefined>, value: number|string }>,
 *   }>,
 *   probeStatus: 'ok'|'degraded'|'unconfigured',
 *   error: string|null,
 * }>}
 */
export async function gatherWalletMetrics(ctx, utxoTimeoutMs = DEFAULT_METRICS_UTXO_TIMEOUT_MS) {
  const budget = (typeof utxoTimeoutMs === 'number' && Number.isFinite(utxoTimeoutMs) && utxoTimeoutMs >= 100 && utxoTimeoutMs <= 60000)
    ? Math.floor(utxoTimeoutMs)
    : DEFAULT_METRICS_UTXO_TIMEOUT_MS;
  const wallet = ctx?.wallet;
  if (!wallet) {
    return {
      probeStatus: 'unconfigured',
      error: null,
      metrics: [
        {
          name: 'tradebot_wallet_balance_bch',
          type: 'gauge',
          help: 'Current wallet balance in BCH (excluding dust UTXOs below the dust limit)',
          samples: [{ labels: { probe_status: 'unconfigured' }, value: 0 }],
        },
        {
          name: 'tradebot_wallet_utxo_count',
          type: 'gauge',
          help: 'Current UTXO count in the wallet (excluding dust + token-bearing UTXOs)',
          samples: [{ labels: { probe_status: 'unconfigured' }, value: 0 }],
        },
      ],
    };
  }

  // Balance probe.
  let balanceBch = 0;
  let balanceStatus = 'ok';
  let balanceError = null;
  if (typeof wallet.getBalanceSats === 'function') {
    try {
      const sats = await wallet.getBalanceSats();
      // sats are bigint per the rest of the bot — coerce to Number
      // for the wire (Prometheus doesn't speak bigint). If the
      // value would overflow Number.MAX_SAFE_INTEGER, fall back
      // to the bigint-as-string and let the scraper parse it
      // (Prometheus actually accepts string-valued samples).
      if (typeof sats === 'bigint') {
        const asNumber = Number(sats);
        if (Number.isFinite(asNumber)) {
          balanceBch = asNumber / 1e8;
        } else {
          // Saturate at a high-but-finite BCH value rather than
          // emit Infinity — keeps the scrape parseable.
          balanceBch = 1e9;
        }
      } else if (typeof sats === 'number' && Number.isFinite(sats)) {
        balanceBch = sats / 1e8;
      } else {
        balanceBch = 0;
      }
    } catch (e) {
      balanceStatus = 'degraded';
      balanceError = (e && e.message) ? String(e.message) : 'wallet.getBalanceSats threw';
    }
  } else {
    balanceStatus = 'unconfigured';
  }

  // UTXO probe (timeout-bounded).
  let utxoCount = 0;
  let utxoStatus = 'ok';
  let utxoError = null;
  if (typeof wallet.listUtxos === 'function') {
    let timer;
    try {
      const utxos = await Promise.race([
        wallet.listUtxos(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`wallet.listUtxos timed out after ${budget}ms`)), budget);
        }),
      ]);
      if (Array.isArray(utxos)) {
        utxoCount = utxos.length;
      } else {
        utxoStatus = 'degraded';
        utxoError = 'wallet.listUtxos returned non-array';
      }
    } catch (e) {
      utxoStatus = 'degraded';
      utxoError = (e && e.message) ? String(e.message) : 'wallet.listUtxos threw';
    } finally {
      if (timer) clearTimeout(timer);
    }
  } else {
    utxoStatus = 'unconfigured';
  }

  return {
    probeStatus: (balanceStatus === 'ok' && utxoStatus === 'ok') ? 'ok'
      : (balanceStatus === 'unconfigured' && utxoStatus === 'unconfigured') ? 'unconfigured'
      : 'degraded',
    error: balanceError || utxoError,
    metrics: [
      {
        name: 'tradebot_wallet_balance_bch',
        type: 'gauge',
        help: 'Current wallet balance in BCH (excluding dust UTXOs below the dust limit)',
        samples: [{ labels: { probe_status: balanceStatus }, value: balanceBch }],
      },
      {
        name: 'tradebot_wallet_utxo_count',
        type: 'gauge',
        help: 'Current UTXO count in the wallet (excluding dust + token-bearing UTXOs)',
        samples: [{ labels: { probe_status: utxoStatus }, value: utxoCount }],
      },
    ],
  };
}

/**
 * Pull the open-position count. Defensive against missing /
 * throwing positions.list('open'). The list call is async.
 *
 * @param {any} ctx
 * @returns {Promise<{
 *   metrics: Array<{
 *     name: string,
 *     type: 'counter'|'gauge'|'untyped',
 *     help: string,
 *     samples: Array<{ labels?: Record<string,string|number|undefined>, value: number|string }>,
 *   }>,
 *   probeStatus: 'ok'|'degraded'|'unconfigured',
 *   error: string|null,
 * }>}
 */
export async function gatherPositionsMetrics(ctx) {
  if (!ctx?.positions || typeof ctx.positions.list !== 'function') {
    return {
      probeStatus: 'unconfigured',
      error: null,
      metrics: [
        {
          name: 'tradebot_positions_open_count',
          type: 'gauge',
          help: 'Number of currently open positions (status:"open" in positions.json)',
          samples: [{ labels: { probe_status: 'unconfigured' }, value: 0 }],
        },
      ],
    };
  }
  try {
    const list = await ctx.positions.list('open');
    if (!Array.isArray(list)) {
      return {
        probeStatus: 'degraded',
        error: 'positions.list("open") returned non-array',
        metrics: [
          {
            name: 'tradebot_positions_open_count',
            type: 'gauge',
            help: 'Number of currently open positions (status:"open" in positions.json)',
            samples: [{ labels: { probe_status: 'degraded' }, value: 0 }],
          },
        ],
      };
    }
    return {
      probeStatus: 'ok',
      error: null,
      metrics: [
        {
          name: 'tradebot_positions_open_count',
          type: 'gauge',
          help: 'Number of currently open positions (status:"open" in positions.json)',
          samples: [{ labels: { probe_status: 'ok' }, value: list.length }],
        },
      ],
    };
  } catch (e) {
    return {
      probeStatus: 'degraded',
      error: (e && e.message) ? String(e.message) : 'positions.list("open") threw',
      metrics: [
        {
          name: 'tradebot_positions_open_count',
          type: 'gauge',
          help: 'Number of currently open positions (status:"open" in positions.json)',
          samples: [{ labels: { probe_status: 'degraded' }, value: 0 }],
        },
      ],
    };
  }
}

/**
 * Pull the circuit-breaker state into gauges. The breaker
 * enforces circuit-breaker trips + loss cooldowns across the
 * bot's lifetime; a tripped breaker is operational data, not
 * a metrics failure. Defensive against missing / throwing
 * `ctx.risk.state()`.
 *
 * Pure — `ctx.risk.state()` is synchronous.
 *
 * @param {any} ctx
 * @returns {{
 *   metrics: Array<{
 *     name: string,
 *     type: 'counter'|'gauge'|'untyped',
 *     help: string,
 *     samples: Array<{ labels?: Record<string,string|number|undefined>, value: number|string }>,
 *   }>,
 *   probeStatus: 'ok'|'degraded'|'unconfigured',
 *   error: string|null,
 * }}
 */
export function gatherBreakerMetrics(ctx) {
  if (!ctx?.risk || typeof ctx.risk.state !== 'function') {
    return {
      probeStatus: 'unconfigured',
      error: null,
      metrics: [
        {
          name: 'tradebot_breaker_is_tripped',
          type: 'gauge',
          help: 'Whether the circuit breaker is currently tripped (1=tripped, 0=armed)',
          samples: [{ labels: { probe_status: 'unconfigured' }, value: 0 }],
        },
        {
          name: 'tradebot_breaker_consecutive_losses',
          type: 'gauge',
          help: 'Consecutive loss count tracked by the circuit breaker',
          samples: [{ labels: { probe_status: 'unconfigured' }, value: 0 }],
        },
        {
          name: 'tradebot_breaker_recent_daily_pnl_bch',
          type: 'gauge',
          help: 'Recent daily realized P&L in BCH (positive=profit, negative=loss)',
          samples: [{ labels: { probe_status: 'unconfigured' }, value: 0 }],
        },
        {
          name: 'tradebot_breaker_loss_cooldown_remaining_ms',
          type: 'gauge',
          help: 'Remaining loss-cooldown in milliseconds (0 if no cooldown is active)',
          samples: [{ labels: { probe_status: 'unconfigured' }, value: 0 }],
        },
      ],
    };
  }
  let st;
  try {
    st = ctx.risk.state();
  } catch (e) {
    return {
      probeStatus: 'degraded',
      error: (e && e.message) ? String(e.message) : 'risk.state() threw',
      metrics: [
        {
          name: 'tradebot_breaker_is_tripped',
          type: 'gauge',
          help: 'Whether the circuit breaker is currently tripped (1=tripped, 0=armed)',
          samples: [{ labels: { probe_status: 'degraded' }, value: 0 }],
        },
        {
          name: 'tradebot_breaker_consecutive_losses',
          type: 'gauge',
          help: 'Consecutive loss count tracked by the circuit breaker',
          samples: [{ labels: { probe_status: 'degraded' }, value: 0 }],
        },
        {
          name: 'tradebot_breaker_recent_daily_pnl_bch',
          type: 'gauge',
          help: 'Recent daily realized P&L in BCH (positive=profit, negative=loss)',
          samples: [{ labels: { probe_status: 'degraded' }, value: 0 }],
        },
        {
          name: 'tradebot_breaker_loss_cooldown_remaining_ms',
          type: 'gauge',
          help: 'Remaining loss-cooldown in milliseconds (0 if no cooldown is active)',
          samples: [{ labels: { probe_status: 'degraded' }, value: 0 }],
        },
      ],
    };
  }
  const isTripped = st?.isTripped === true ? 1 : 0;
  const consecutiveLosses = asCounter(st?.consecutiveLosses);
  const pnlSats = (typeof st?.recentDailyPnlSats === 'number' && Number.isFinite(st.recentDailyPnlSats))
    ? st.recentDailyPnlSats
    : 0;
  const cooldownMs = (typeof st?.lossCooldownRemainingMs === 'number' && Number.isFinite(st.lossCooldownRemainingMs))
    ? Math.max(0, st.lossCooldownRemainingMs)
    : 0;
  return {
    probeStatus: 'ok',
    error: null,
    metrics: [
      {
        name: 'tradebot_breaker_is_tripped',
        type: 'gauge',
        help: 'Whether the circuit breaker is currently tripped (1=tripped, 0=armed)',
        samples: [{ labels: { probe_status: 'ok' }, value: isTripped }],
      },
      {
        name: 'tradebot_breaker_consecutive_losses',
        type: 'gauge',
        help: 'Consecutive loss count tracked by the circuit breaker',
        samples: [{ labels: { probe_status: 'ok' }, value: consecutiveLosses }],
      },
      {
        name: 'tradebot_breaker_recent_daily_pnl_bch',
        type: 'gauge',
        help: 'Recent daily realized P&L in BCH (positive=profit, negative=loss)',
        samples: [{ labels: { probe_status: 'ok' }, value: pnlSats / 1e8 }],
      },
      {
        name: 'tradebot_breaker_loss_cooldown_remaining_ms',
        type: 'gauge',
        help: 'Remaining loss-cooldown in milliseconds (0 if no cooldown is active)',
        samples: [{ labels: { probe_status: 'ok' }, value: cooldownMs }],
      },
    ],
  };
}

/**
 * Build the wire envelope. Aggregates all four probes (loop,
 * wallet, positions, breaker) + the process-level signals
 * (up, uptime) into a single deterministic envelope. Async —
 * awaits the wallet + positions I/O. Never throws — every I/O
 * is wrapped.
 *
 * T79 subset 2 — accepts an optional `subset2Probes` seam so
 * the per-token / scoring-gate / tick-duration probes can be
 * injected. If absent, only the subset-1 probes are emitted
 * (preserves the subset-1 wire format byte-for-byte when the
 * dashboard hasn't yet wired subset 2 into its ctx).
 *
 * @param {{
 *   ctx: { loop?: any, risk?: any, wallet?: any, positions?: { list: Function }, logger?: any, dashboardCfg?: Object, cfg?: Object, historyReader?: { read: Function } },
 *   nowMs?: number,
 *   clock?: () => number,
 *   utxoTimeoutMs?: number,
 *   subset2Probes?: { probeStatus: string, error: string|null, perToken?: { metrics: Array<Object> }, scoringGate?: { metrics: Array<Object> }, tickDuration?: { metrics: Array<Object> } } | null,
 *   subset3Probes?: { probeStatus: string, error: string|null, tickDuration?: { metrics: Array<Object>, summary?: Object }, adaptiveWeights?: { metrics: Array<Object>, dropped?: number, keys?: string[] } } | null,
 * }} args
 * @returns {Promise<Object>}
 */
export async function buildMetricsEnvelope({ ctx, nowMs, clock, utxoTimeoutMs, subset2Probes, subset3Probes } = {}) {
  if (!ctx || typeof ctx !== 'object') {
    throw new TypeError('buildMetricsEnvelope: ctx required');
  }
  const wallClock = (typeof clock === 'function')
    ? clock
    : (typeof ctx.clock === 'function' ? ctx.clock : () => Date.now());
  const _nowMs = (typeof nowMs === 'number' && Number.isFinite(nowMs)) ? nowMs : wallClock();

  const loopBlock = gatherLoopMetrics(ctx);
  const walletBlock = await gatherWalletMetrics(ctx, utxoTimeoutMs);
  const positionsBlock = await gatherPositionsMetrics(ctx);
  const breakerBlock = gatherBreakerMetrics(ctx);

  // Aggregate process-level signals.
  const processMetrics = [
    {
      name: 'tradebot_up',
      type: 'gauge',
      help: 'Process is responsive (1=responding to /metrics, 0=not)',
      samples: [{ labels: {}, value: 1 }],
    },
    {
      name: 'tradebot_uptime_seconds',
      type: 'counter',
      help: 'Process uptime in seconds since the dashboard server started',
      samples: [{ labels: {}, value: Math.max(0, Math.floor(process.uptime())) }],
    },
  ];

  // Concatenate in a stable order. The route handler doesn't
  // care; the Prometheus scraper doesn't care; tests do (so
  // they can assert "the i-th metric is X").
  const metrics = [
    ...processMetrics,
    ...loopBlock.metrics,
    ...walletBlock.metrics,
    ...positionsBlock.metrics,
    ...breakerBlock.metrics,
  ];

  // T79 subset 2 — per-token / scoring-gate / tick-duration
  // probes. Only added to the wire envelope when the seam
  // returns a structured envelope (so subset-1 dashboards
  // emit the same wire format byte-for-byte).
  let subset2Block = null;
  if (subset2Probes && typeof subset2Probes === 'object') {
    subset2Block = subset2Probes;
    if (Array.isArray(subset2Block.perToken?.metrics)) {
      metrics.push(...subset2Block.perToken.metrics);
    }
    if (Array.isArray(subset2Block.scoringGate?.metrics)) {
      metrics.push(...subset2Block.scoringGate.metrics);
    }
    if (Array.isArray(subset2Block.tickDuration?.metrics)) {
      metrics.push(...subset2Block.tickDuration.metrics);
    }
  }

  // T80 — subset 3: Prometheus-style histogram for tick
  // duration + adaptive-weight snapshot. Sourced from
  // `loop.stats()` (NOT history re-read) so a scrape is O(1).
  // When the seam is absent the orchestrator falls back to
  // `ctx.metricsSubset3Probes` so the server can pre-compute
  // once per cache-TTL window.
  let subset3Block = null;
  if (subset3Probes && typeof subset3Probes === 'object') {
    subset3Block = subset3Probes;
    if (Array.isArray(subset3Block.tickDuration?.metrics)) {
      metrics.push(...subset3Block.tickDuration.metrics);
    }
    if (Array.isArray(subset3Block.adaptiveWeights?.metrics)) {
      metrics.push(...subset3Block.adaptiveWeights.metrics);
    }
  } else if (ctx.metricsSubset3Probes && typeof ctx.metricsSubset3Probes === 'object') {
    subset3Block = ctx.metricsSubset3Probes;
    if (Array.isArray(subset3Block.tickDuration?.metrics)) {
      metrics.push(...subset3Block.tickDuration.metrics);
    }
    if (Array.isArray(subset3Block.adaptiveWeights?.metrics)) {
      metrics.push(...subset3Block.adaptiveWeights.metrics);
    }
  }

  // Surface a single `dashboard.metrics.<probe>.degraded` warn
  // per failing probe per scrape — operators monitoring the
  // audit trail will see exactly which subsystem was broken at
  // scrape time, and the probe label on the wire still lets the
  // scraper parse the (partial) response.
  if (ctx.logger && typeof ctx.logger.warn === 'function') {
    for (const [name, block] of [
      ['loop', loopBlock],
      ['wallet', walletBlock],
      ['positions', positionsBlock],
      ['breaker', breakerBlock],
    ]) {
      if (block.probeStatus === 'degraded') {
        ctx.logger.warn(`dashboard.metrics.${name}.degraded`, { error: block.error });
      }
    }
    if (subset2Block && subset2Block.probeStatus === 'degraded') {
      ctx.logger.warn('dashboard.metrics.subset2.degraded', { error: subset2Block.error });
    }
    if (subset3Block && subset3Block.probeStatus === 'degraded') {
      ctx.logger.warn('dashboard.metrics.subset3.degraded', { error: subset3Block.error });
    }
  }

  return {
    schema: METRICS_SCHEMA,
    ok: true,
    ts: new Date(_nowMs).toISOString(),
    uptime_s: Math.max(0, Math.floor(process.uptime())),
    metrics,
  };
}
