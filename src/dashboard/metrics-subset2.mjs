#!/usr/bin/env node
// src/dashboard/metrics-subset2.mjs
//
// T79 subset 2 — per-token counters + scoring-gate hit counters
// + rolling tick-duration summary for the Prometheus `/metrics`
// endpoint.
//
// Subset 1 of T78 shipped the metric-collection primitives
// (`formatPrometheusText`, `asCounter`, `asGauge`,
// `escapeLabelValue`, etc.) and four per-probe gatherers
// (loop / wallet / positions / breaker). Subset 2 adds:
//
//   1. **`gatherPerTokenMetrics`** — re-reads `data/history.jsonl`
//      via the dashboard's existing `historyReader` adapter and
//      emits three per-token counter series:
//
//        - `tradebot_token_entry_count_total{token_id, symbol}`
//          — number of successful `kind:'entry'` events per
//          token.
//
//        - `tradebot_token_exit_count_total{token_id, symbol, outcome}`
//          — number of `kind:'exit'` events per token + outcome
//          label (`time_stop` / `take_profit` / `stop_loss` /
//          `rug_pattern` / `manual` / `breakeven` / etc.),
//          bucketed by realized-PnL sign when the `exit_kind`
//          itself doesn't carry an outcome (`win` for net gain,
//          `loss` for net loss, `breakeven` for ≈0).
//
//        - `tradebot_token_realized_pnl_sats_total{token_id, symbol}`
//          — sum of `realized_pnl_sats` from `kind:'exit'` events
//          per token (cumulative in time order — realized PnL
//          can go negative).
//
//      The reader call is bounded by `history_max_events:5_000`
//      (mirrors `/api/tokens/summary`) so a single scrape
//      doesn't accidentally slurp the full file. The result is
//      cached for `dashboard.metrics_per_token_cache_ms`
//      (default 30 000 ms) keyed on the same history mtime
//      semantic — the dashboard's `historyReader` already
//      enforces its own 1.5s TTL so this is a layered cache
//      keyed on top.
//
//   2. **`gatherScoringGateMetrics`** — emits a single counter
//      series `tradebot_scoring_gate_skipped_total{kind, reason}`
//      counting entries/exits that were blocked by a scoring
//      gate. Sourced from `kind:'entry_skipped' | 'entry_rejected'
//      | 'exit_skipped' | 'exit_blocked_by_profit_target' |
//      'exit_failed'` events in the history file, where the
//      label `kind` is the event kind and `reason` is a
//      bucketed classification (`already_open` /
//      `rug_pattern_detected` / `too_close_to_high` /
//      `no_exit_condition` / `below_min_amm_depth` /
//      `indexer_vs_amm_divergence` / `no_price_evidence` /
//      `unknown`). Helps the operator spot which scoring
//      gate is gating the most candidates — and whether
//      something silently changed.
//
//   3. **`gatherTickDurationSummary`** — rolling mean / p50 /
//      p95 / max of the last 60 tick durations sourced from the
//      same history file's `kind:'tick'` events (each tick
//      row carries `duration_ms`). Slightly different from a
//      proper Prometheus histogram (no `_bucket{le=...}` lines)
//      but it's the operator-facing summary view and the rest
//      of the suite already reads `duration_ms` from tick rows
//      so this is FREE in the sense that the data is already
//      on disk. The full histogram ships in a future tick.
//
//   4. **Wire-up in `buildMetricsEnvelope`** — subset 2 hooks
//      into the existing `buildMetricsEnvelope` orchestrator via
//      the `subset2Probes` seam so subset 1 + subset 2 can ship
//      in either order without breaking the other. Subset 2
//      ships with the seam wired in `metrics.mjs` (the
//      orchestrator now looks up `ctx.metricsSubset2Probes` and,
//      if absent, calls our `gatherSubset2Probes` default).
//
// Design rules (mirroring subset 1):
//
//   - **Pure shape.** `gatherPerTokenMetrics({ events, opts, nowMs })`
//     accepts the same `events` array the rest of the
//     dashboard reads. No I/O happens in this module.
//
//   - **Defensive.** Non-array events, malformed JSON, missing
//     fields, non-finite numbers, NaN/Infinity — every entry
//     degrades to a skip (counted in `_dropped` so tests can
//     assert the defensive path) rather than throwing.
//
//   - **Bounded.** We honour `opts.historyLimit` (default 5000
//     — same as `/api/tokens/summary`) so a Prometheus scrape
//     can't accidentally regress to "read the whole file".
//
//   - **No `console.log`.** Pure ESM, no I/O, no logger.
//
// Wire envelope (consumed by the orchestrator, not the wire):
//
//   {
//     probeStatus: 'ok' | 'degraded' | 'unconfigured',
//     error: string | null,
//     metrics: Array<PrometheusMetricBlock>,
//   }

/**
 * Schema for the per-token / scoring-gate envelope.
 *
 * @type {string}
 */
export const METRICS_SUBSET2_SCHEMA = 'tradebot.dashboard.metrics/subset2/v1';

/**
 * Default per-token cache TTL (ms). Mirrors the `dashboard.metrics_per_token_cache_ms`
 * knob contract: a Prometheus scraper polling every 15s should
 * hit the cache on 14/15 polls.
 *
 * @type {number}
 */
export const DEFAULT_METRICS_PER_TOKEN_CACHE_MS = 30_000;

/**
 * Default bound on history events per scrape. Mirrors
 * `dashboard.history_max_events: 5_000` so subset 2 doesn't
 * quietly do more work than the rest of the dashboard does.
 *
 * @type {number}
 */
export const DEFAULT_METRICS_HISTORY_LIMIT = 5_000;

/**
 * Clamp the `dashboard.metrics_per_token_cache_ms` knob into
 * a safe range (0..600_000 ms). Out-of-range / non-number /
 * NaN / Infinity / negative → safe default
 * (`DEFAULT_METRICS_PER_TOKEN_CACHE_MS`). `0` is honoured (means
 * "always-fresh, never cache").
 *
 * @param {*} raw
 * @returns {number}
 */
export function clampMetricsPerTokenCacheMs(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_METRICS_PER_TOKEN_CACHE_MS;
  if (raw < 0) return DEFAULT_METRICS_PER_TOKEN_CACHE_MS;
  if (raw > 600_000) return 600_000;
  return Math.trunc(raw);
}

/**
 * Clamp the `dashboard.history_max_events` knob into a safe
 * range (0..50_000). Out-of-range / non-number / NaN /
 * Infinity / negative → safe default
 * (`DEFAULT_METRICS_HISTORY_LIMIT`). `0` is honoured but
 * degrades to "no events" — the probe still emits the
 * empty-but-valid envelope.
 *
 * @param {*} raw
 * @returns {number}
 */
export function clampMetricsHistoryLimit(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_METRICS_HISTORY_LIMIT;
  if (raw < 0) return DEFAULT_METRICS_HISTORY_LIMIT;
  if (raw > 50_000) return 50_000;
  return Math.trunc(raw);
}

/**
 * Bucketed outcome label for exit events when `exit_kind` is
 * present but doesn't classify as win / loss / breakeven on
 * its own. Returns one of `'win' | 'loss' | 'breakeven'` based
 * on the realized-PnL sign with a 100-sat breakeven window
 * (mirrors the existing per-token-trade-log epsilon).
 *
 * Pure helper — never throws; non-finite PnL returns
 * `'breakeven'` (the conservative default).
 *
 * @param {number|string|bigint|null|undefined} realizedPnlSats
 * @returns {'win'|'loss'|'breakeven'}
 */
export function classifyExitOutcome(realizedPnlSats) {
  if (realizedPnlSats === null || realizedPnlSats === undefined) return 'breakeven';
  // bigint → bigint math (safer for large sat totals).
  let n;
  if (typeof realizedPnlSats === 'bigint') n = realizedPnlSats;
  else if (typeof realizedPnlSats === 'string' && realizedPnlSats.length > 0) {
    try { n = BigInt(realizedPnlSats); } catch (_e) { return 'breakeven'; }
  } else if (typeof realizedPnlSats === 'number' && Number.isFinite(realizedPnlSats)) {
    // Floor to integer sats before coercing to BigInt so a
    // float like 1.0000001 doesn't trip a non-integer error.
    n = BigInt(Math.trunc(realizedPnlSats));
  } else {
    return 'breakeven';
  }
  if (n > 100n) return 'win';
  if (n < -100n) return 'loss';
  return 'breakeven';
}

/**
 * Safe coercion to BigInt. Mirrors the existing pattern in
 * `src/portfolio/per-token-trade-log.mjs#satsToBch` etc.:
 * string / bigint / finite number pass; everything else
 * returns `null` (so callers can skip without crashing).
 *
 * @param {*} v
 * @returns {bigint|null}
 */
function safeBigIntSats(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === 'string' && v.length > 0) {
    try { return BigInt(v); } catch (_e) { return null; }
  }
  return null;
}

/**
 * Normalize a token-id field to a lowercase string. Returns
 * `null` for non-string / empty / too-long input (token IDs
 * are exactly 64 hex chars in this codebase, but we tolerate
 * slightly wider inputs so a future schema change doesn't
 * silently drop metrics).
 *
 * @param {*} v
 * @returns {string|null}
 */
function normalizeTokenIdForMetric(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim().toLowerCase();
  if (t.length === 0 || t.length > 128) return null;
  return t;
}

/**
 * Normalize a symbol field. Returns the trimmed input as-is
 * (case-preserved — operators may want to see uppercase symbols
 * in dashboards) or `null` for non-string / empty / oversized
 * input. We deliberately do NOT lowercase the symbol because
 * `BCH` and `bch` are different display strings.
 *
 * @param {*} v
 * @returns {string|null}
 */
function normalizeSymbolForMetric(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t.length === 0 || t.length > 32) return null;
  return t;
}

/**
 * Normalize a `kind` field — non-string / non-printable / too
 * long → `null`. Used for the `kind` label on
 * `tradebot_scoring_gate_skipped_total{kind, reason}` so an
 * adversarial event can't poison the wire format.
 *
 * @param {*} v
 * @returns {string|null}
 */
function normalizeKindLabel(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t.length === 0 || t.length > 64) return null;
  // Restrict to printable ASCII so the label is well-formed
  // per the Prometheus spec.
  if (!/^[A-Za-z0-9_\-]+$/.test(t)) return null;
  return t;
}

/**
 * Normalize a `reason` field the same way. Operators see this
 * as a free-form string ("no price evidence (oracle missing)"
 * etc.) so we apply a soft clamp (length) but otherwise trust
 * the producer. Non-conforming input → `'_other'`.
 *
 * @param {*} v
 * @returns {string}
 */
function normalizeReasonLabel(v) {
  if (typeof v !== 'string') return 'unknown';
  const t = v.trim();
  if (t.length === 0) return 'unknown';
  if (t.length > 96) return t.slice(0, 96);
  // Escape newlines so a stray \n in `reason` can't break the
  // Prometheus text format.
  return t.replace(/[\r\n]+/g, ' ');
}

/**
 * Walk the events array and partition entries into the four
 * collections we care about. Defensive: drops events whose
 * `kind` is missing / non-string / not in our allowlist; never
 * throws.
 *
 * @param {Array<Object>} events
 * @returns {{
 *   entries: Array<Object>,
 *   exits: Array<Object>,
 *   entrySkipped: Array<Object>,
 *   entryRejected: Array<Object>,
 *   exitSkipped: Array<Object>,
 *   exitBlockedByProfitTarget: Array<Object>,
 *   ticks: Array<Object>,
 *   _dropped: number,
 * }}
 */
export function partitionEventsForMetrics(events) {
  const out = {
    entries: [],
    exits: [],
    entrySkipped: [],
    entryRejected: [],
    exitSkipped: [],
    exitBlockedByProfitTarget: [],
    ticks: [],
    _dropped: 0,
  };
  if (!Array.isArray(events)) return out;
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') { out._dropped += 1; continue; }
    const k = normalizeKindLabel(ev.kind);
    if (k === null) { out._dropped += 1; continue; }
    switch (k) {
      case 'entry': out.entries.push(ev); break;
      case 'exit': out.exits.push(ev); break;
      case 'entry_skipped': out.entrySkipped.push(ev); break;
      case 'entry_rejected': out.entryRejected.push(ev); break;
      case 'exit_skipped': out.exitSkipped.push(ev); break;
      case 'exit_blocked_by_profit_target': out.exitBlockedByProfitTarget.push(ev); break;
      case 'tick': out.ticks.push(ev); break;
      default:
        // Other kinds (config_hot_reload etc.) are not
        // interesting for these counters; don't count as
        // dropped — we just skip them.
        break;
    }
  }
  return out;
}

/**
 * Aggregate per-token entry counts + realized-PnL sums from
 * `kind:'entry'` and `kind:'exit'` events. Pure helper; never
 * throws; defensive on every field.
 *
 * @param {Object} partitioned — output of `partitionEventsForMetrics`
 * @returns {{
 *   byTokenId: Map<string, {
 *     entryCount: number,
 *     exitCountsByOutcome: Map<string, number>,
 *     realizedPnlSats: bigint,
 *     symbol: string|null,
 *   }>,
 *   _dropped: number,
 * }}
 */
export function aggregatePerTokenCounts(partitioned) {
  /** @type {Map<string, any>} */
  const byTokenId = new Map();
  let dropped = 0;
  const ensure = (tokenId) => {
    let rec = byTokenId.get(tokenId);
    if (!rec) {
      rec = {
        entryCount: 0,
        exitCountsByOutcome: new Map(),
        realizedPnlSats: 0n,
        symbol: null,
      };
      byTokenId.set(tokenId, rec);
    }
    return rec;
  };
  for (const ev of partitioned.entries) {
    const tid = normalizeTokenIdForMetric(ev.token_id);
    if (tid === null) { dropped += 1; continue; }
    const rec = ensure(tid);
    rec.entryCount += 1;
    const sym = normalizeSymbolForMetric(ev.symbol);
    if (sym !== null && rec.symbol === null) rec.symbol = sym;
  }
  for (const ev of partitioned.exits) {
    const tid = normalizeTokenIdForMetric(ev.token_id);
    if (tid === null) { dropped += 1; continue; }
    const rec = ensure(tid);
    const sym = normalizeSymbolForMetric(ev.symbol);
    if (sym !== null && rec.symbol === null) rec.symbol = sym;
    const pnl = safeBigIntSats(ev.realized_pnl_sats);
    if (pnl !== null) rec.realizedPnlSats += pnl;
    // Outcome label: prefer `exit_kind` (time_stop / take_profit
    // / stop_loss / etc.) when it exists; otherwise bucket by
    // realized-PnL sign (win / loss / breakeven).
    const exitKind = normalizeKindLabel(ev.exit_kind) ?? classifyExitOutcome(pnl);
    rec.exitCountsByOutcome.set(exitKind, (rec.exitCountsByOutcome.get(exitKind) ?? 0) + 1);
  }
  return { byTokenId, _dropped: dropped };
}

/**
 * Aggregate scoring-gate hit counts from the four skip / reject
 * / block event kinds. Pure helper; never throws; defensive on
 * every field. The `reason` label is bucketed to a printable
 * ASCII form so a free-form `reason` text in the underlying
 * event can't break the Prometheus wire format.
 *
 * @param {Object} partitioned — output of `partitionEventsForMetrics`
 * @returns {{
 *   byKind: Map<string, Map<string, number>>,
 *   totals: number,
 *   _dropped: number,
 * }}
 */
export function aggregateScoringGateCounts(partitioned) {
  /** @type {Map<string, Map<string, number>>} */
  const byKind = new Map();
  let total = 0;
  let dropped = 0;

  const bump = (kind, reason) => {
    let m = byKind.get(kind);
    if (!m) { m = new Map(); byKind.set(kind, m); }
    m.set(reason, (m.get(reason) ?? 0) + 1);
    total += 1;
  };

  const reasonOf = (ev, fallback) => {
    const r = (typeof ev.reason === 'string') ? ev.reason
            : (typeof ev.skip_kind === 'string') ? ev.skip_kind
            : (typeof ev.reject_kind === 'string') ? ev.reject_kind
            : fallback;
    return normalizeReasonLabel(r);
  };

  for (const ev of partitioned.entrySkipped) {
    bump('entry_skipped', reasonOf(ev, 'unknown'));
  }
  for (const ev of partitioned.entryRejected) {
    bump('entry_rejected', reasonOf(ev, 'unknown'));
  }
  for (const ev of partitioned.exitSkipped) {
    bump('exit_skipped', reasonOf(ev, 'no_exit_condition'));
  }
  for (const ev of partitioned.exitBlockedByProfitTarget) {
    bump('exit_blocked_by_profit_target', reasonOf(ev, 'profit_target_block'));
  }
  return { byKind, totals: total, _dropped: dropped };
}

/**
 * Summary statistics for tick durations. Returns `{ count,
 * mean_ms, max_ms, last_ms, p50_ms, p95_ms }` (all numbers;
 * never throws). The percentile is computed via the same
 * "nearest-rank" estimator that the rest of the dashboard
 * uses (`p` ∈ [0,1]).
 *
 * @param {Array<{duration_ms?: number|string|null}>} ticks
 * @param {{percentile?: number}} [opts]
 * @returns {{count:number, mean_ms:number, max_ms:number, last_ms:number, p50_ms:number, p95_ms:number}}
 */
export function summarizeTickDurations(ticks, opts = {}) {
  const empty = { count: 0, mean_ms: 0, max_ms: 0, last_ms: 0, p50_ms: 0, p95_ms: 0 };
  if (!Array.isArray(ticks) || ticks.length === 0) return empty;
  const durations = [];
  let last = 0;
  for (const t of ticks) {
    if (!t || typeof t !== 'object') continue;
    let d = null;
    if (typeof t.duration_ms === 'number' && Number.isFinite(t.duration_ms)) {
      d = Math.max(0, Math.trunc(t.duration_ms));
    } else if (typeof t.duration_ms === 'string' && t.duration_ms.length > 0) {
      const n = Number(t.duration_ms);
      d = Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : null;
    }
    if (d === null) continue;
    durations.push(d);
    last = d;
  }
  if (durations.length === 0) return { ...empty, last_ms: last };
  durations.sort((a, b) => a - b);
  const pct = (p) => {
    if (p <= 0) return durations[0];
    if (p >= 1) return durations[durations.length - 1];
    const idx = Math.min(durations.length - 1, Math.max(0, Math.floor(p * durations.length)));
    return durations[idx];
  };
  const sum = durations.reduce((acc, n) => acc + n, 0);
  return {
    count: durations.length,
    mean_ms: Math.round(sum / durations.length),
    max_ms: durations[durations.length - 1],
    last_ms: last,
    p50_ms: pct(0.5),
    p95_ms: pct(0.95),
  };
}

/**
 * Render the per-token metrics envelope as Prometheus
 * metric-blocks. Pure helper — never throws; defensive on
 * every field; produces a STABLE ordering of samples within
 * a block (sorted by label-tuple) so the wire format is
 * byte-stable across scrapes.
 *
 * @param {{byTokenId: Map, _dropped?: number}} agg
 * @returns {Array<Object>} — array of metric blocks
 */
export function renderPerTokenMetricBlocks(agg) {
  const blocks = [];
  const entrySamples = [];
  const exitSamples = [];
  const pnlSamples = [];
  const tokenIds = Array.from(agg.byTokenId.keys()).sort();
  for (const tid of tokenIds) {
    const rec = agg.byTokenId.get(tid);
    if (!rec) continue;
    const sym = rec.symbol ?? '';
    const baseLabels = { token_id: tid, symbol: sym };
    entrySamples.push({ labels: { ...baseLabels }, value: rec.entryCount });
    // For exits: one sample per (token_id, outcome). Sorted
    // by outcome so the output is deterministic.
    const outcomes = Array.from(rec.exitCountsByOutcome.keys()).sort();
    for (const o of outcomes) {
      const n = rec.exitCountsByOutcome.get(o);
      exitSamples.push({
        labels: { token_id: tid, symbol: sym, outcome: o },
        value: n,
      });
    }
    // Realized PnL is a stringified BigInt in Prometheus text
    // format (no scientific notation, no loss). The
    // orchestrator's `formatMetricBlock` accepts numeric
    // values directly, so we coerce to a regular string here
    // (Number can't represent sats beyond 2^53).
    pnlSamples.push({
      labels: { ...baseLabels },
      value: rec.realizedPnlSats.toString(),
    });
  }
  blocks.push({
    name: 'tradebot_token_entry_count_total',
    type: 'counter',
    help: 'Total successful entry events per token since the history file was first written',
    samples: entrySamples.length > 0
      ? entrySamples
      : [{ labels: { token_id: '', symbol: '' }, value: 0 }],
  });
  blocks.push({
    name: 'tradebot_token_exit_count_total',
    type: 'counter',
    help: 'Total exit events per token bucketed by outcome (win|loss|breakeven|time_stop|take_profit|stop_loss|...) since the history file was first written',
    samples: exitSamples.length > 0
      ? exitSamples
      : [{ labels: { token_id: '', symbol: '', outcome: '' }, value: 0 }],
  });
  blocks.push({
    name: 'tradebot_token_realized_pnl_sats_total',
    type: 'counter',
    help: 'Cumulative realized PnL in sats per token (sum of realized_pnl_sats across all exit events)',
    samples: pnlSamples.length > 0
      ? pnlSamples
      : [{ labels: { token_id: '', symbol: '' }, value: '0' }],
  });
  return blocks;
}

/**
 * Render the scoring-gate metrics envelope. Pure helper.
 *
 * @param {{byKind: Map, totals?: number, _dropped?: number}} agg
 * @returns {Array<Object>}
 */
export function renderScoringGateMetricBlocks(agg) {
  const samples = [];
  const safeAgg = (agg && typeof agg === 'object') ? agg : {};
  const byKind = (safeAgg.byKind instanceof Map) ? safeAgg.byKind : new Map();
  const kinds = Array.from(byKind.keys()).sort();
  for (const k of kinds) {
    const reasons = byKind.get(k);
    if (!reasons) continue;
    const rs = Array.from(reasons.keys()).sort();
    for (const r of rs) {
      samples.push({
        labels: { kind: k, reason: r },
        value: reasons.get(r),
      });
    }
  }
  return [{
    name: 'tradebot_scoring_gate_skipped_total',
    type: 'counter',
    help: 'Total entry/exit events blocked by a scoring gate (per kind + per reason bucket) since the history file was first written',
    samples: samples.length > 0
      ? samples
      : [{ labels: { kind: '', reason: '' }, value: 0 }],
  }];
}

/**
 * Render the tick-duration summary as Prometheus metric blocks.
 * Pure helper. The five gauges (count / mean_ms / max_ms /
 * last_ms / p50_ms / p95_ms) are always emitted (even when
 * count=0) so the dashboard tile doesn't have to handle a
 * "metric missing" case.
 *
 * @param {ReturnType<typeof summarizeTickDurations>} summary
 * @returns {Array<Object>}
 */
export function renderTickDurationMetricBlocks(summary) {
  const s = (summary && typeof summary === 'object') ? summary : {};
  const safeNum = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : 0;
  return [
    {
      name: 'tradebot_loop_tick_duration_last_ms',
      type: 'gauge',
      help: 'Duration of the most recent trader-loop tick (ms)',
      samples: [{ labels: {}, value: safeNum(s.last_ms) }],
    },
    {
      name: 'tradebot_loop_tick_duration_mean_ms',
      type: 'gauge',
      help: 'Mean tick duration across the most recent history events (ms)',
      samples: [{ labels: {}, value: safeNum(s.mean_ms) }],
    },
    {
      name: 'tradebot_loop_tick_duration_p50_ms',
      type: 'gauge',
      help: '50th-percentile tick duration across the most recent history events (ms)',
      samples: [{ labels: {}, value: safeNum(s.p50_ms) }],
    },
    {
      name: 'tradebot_loop_tick_duration_p95_ms',
      type: 'gauge',
      help: '95th-percentile tick duration across the most recent history events (ms)',
      samples: [{ labels: {}, value: safeNum(s.p95_ms) }],
    },
    {
      name: 'tradebot_loop_tick_duration_max_ms',
      type: 'gauge',
      help: 'Maximum tick duration across the most recent history events (ms)',
      samples: [{ labels: {}, value: safeNum(s.max_ms) }],
    },
    {
      name: 'tradebot_loop_tick_duration_observed_total',
      type: 'counter',
      help: 'Number of tick rows used to compute the tick-duration summary',
      samples: [{ labels: {}, value: safeNum(s.count) }],
    },
  ];
}

/**
 * Top-level "gather the subset-2 probes" orchestrator. Reads
 * from the dashboard's existing `historyReader` (or accepts a
 * pre-fetched `events` array) and returns three envelopes
 * (per-token, scoring-gate, tick-duration). Pure with respect
 * to the events array — no I/O happens in this function. The
 * server-side wrapper (`gatherSubset2ProbesFromCtx`) handles
 * the `historyReader.read()` call + the cache.
 *
 * @param {Object} args
 * @param {Array<Object>} args.events
 * @param {{historyLimit?: number}} [args.opts]
 * @returns {{
 *   probeStatus: 'ok'|'degraded',
 *   error: string|null,
 *   perToken: { metrics: Array<Object>, totals: { tokens:number, dropped:number } },
 *   scoringGate: { metrics: Array<Object>, totals: number, dropped: number },
 *   tickDuration: { metrics: Array<Object>, summary: ReturnType<typeof summarizeTickDurations> },
 * }}
 */
export function gatherSubset2Probes({ events, opts = {} } = {}) {
  const _safeEvents = Array.isArray(events) ? events : [];
  const partitioned = partitionEventsForMetrics(_safeEvents);
  const perTokenAgg = aggregatePerTokenCounts(partitioned);
  const scoringAgg = aggregateScoringGateCounts(partitioned);
  const tickSummary = summarizeTickDurations(partitioned.ticks);
  return {
    probeStatus: 'ok',
    error: null,
    perToken: {
      metrics: renderPerTokenMetricBlocks(perTokenAgg),
      totals: {
        tokens: perTokenAgg.byTokenId.size,
        dropped: perTokenAgg._dropped,
      },
    },
    scoringGate: {
      metrics: renderScoringGateMetricBlocks(scoringAgg),
      totals: scoringAgg.totals,
      dropped: scoringAgg._dropped,
    },
    tickDuration: {
      metrics: renderTickDurationMetricBlocks(tickSummary),
      summary: tickSummary,
    },
  };
}

/**
 * Server-side wrapper that reads from `ctx.historyReader` and
 * returns the same shape as `gatherSubset2Probes`. Bounded by
 * `opts.historyLimit` (default 5 000).
 *
 * Defensive contract: missing `historyReader` or any thrown
 * error → `probeStatus:'degraded'` with `error` set and an
 * empty-but-valid metrics envelope. NEVER throws.
 *
 * @param {Object} args
 * @param {Object} args.ctx — dashboard server ctx (carries `historyReader`)
 * @param {{historyLimit?: number}} [args.opts]
 * @returns {Promise<{
 *   probeStatus: 'ok'|'degraded'|'unconfigured',
 *   error: string|null,
 *   perToken: { metrics: Array<Object>, totals: { tokens:number, dropped:number } },
 *   scoringGate: { metrics: Array<Object>, totals: number, dropped: number },
 *   tickDuration: { metrics: Array<Object>, summary: ReturnType<typeof summarizeTickDurations> },
 * }>}
 */
export async function gatherSubset2ProbesFromCtx({ ctx, opts = {} } = {}) {
  if (!ctx || typeof ctx !== 'object' || !ctx.historyReader || typeof ctx.historyReader.read !== 'function') {
    // No history reader → still return the empty-but-valid
    // envelope so the Prometheus text format stays parseable.
    return {
      probeStatus: 'unconfigured',
      error: null,
      perToken: { metrics: renderPerTokenMetricBlocks({ byTokenId: new Map(), _dropped: 0 }), totals: { tokens: 0, dropped: 0 } },
      scoringGate: { metrics: renderScoringGateMetricBlocks({ byKind: new Map(), totals: 0, _dropped: 0 }), totals: 0, dropped: 0 },
      tickDuration: { metrics: renderTickDurationMetricBlocks(summarizeTickDurations([])), summary: summarizeTickDurations([]) },
    };
  }
  const limit = (typeof opts.historyLimit === 'number' && Number.isFinite(opts.historyLimit))
    ? Math.max(0, Math.trunc(opts.historyLimit))
    : DEFAULT_METRICS_HISTORY_LIMIT;
  let events = [];
  try {
    const read = await ctx.historyReader.read({ limit });
    if (read && Array.isArray(read.events)) events = read.events;
  } catch (e) {
    return {
      probeStatus: 'degraded',
      error: (e && e.message) ? String(e.message) : 'historyReader.read() threw',
      perToken: { metrics: renderPerTokenMetricBlocks({ byTokenId: new Map(), _dropped: 0 }), totals: { tokens: 0, dropped: 0 } },
      scoringGate: { metrics: renderScoringGateMetricBlocks({ byKind: new Map(), totals: 0, _dropped: 0 }), totals: 0, dropped: 0 },
      tickDuration: { metrics: renderTickDurationMetricBlocks(summarizeTickDurations([])), summary: summarizeTickDurations([]) },
    };
  }
  return gatherSubset2Probes({ events, opts });
}

/**
 * Simple in-process TTL cache wrapper around
 * `gatherSubset2ProbesFromCtx`. Keyed on the cache TTL window
 * so a Prometheus scrape that's polling faster than the TTL
 * sees the same data. Mirrors the existing
 * `SnapshotAggregator` cache pattern from T64.
 *
 * @param {Object} opts
 * @param {Object} opts.ctx
 * @param {number} [opts.cacheMs] — cache TTL (default 30s)
 * @param {number} [opts.historyLimit] — events cap (default 5 000)
 * @param {() => number} [opts.nowMs]
 * @returns {{
 *   gather: () => Promise<ReturnType<typeof gatherSubset2ProbesFromCtx>>,
 *   invalidate: () => void,
 *   stats: () => { cached_at_ms: number|null, cache_age_ms: number, cache_hits: number, cache_misses: number },
 * }}
 */
export function createSubset2ProbeCache({ ctx, cacheMs, historyLimit, nowMs } = {}) {
  const _cacheMs = (typeof cacheMs === 'number' && Number.isFinite(cacheMs)) ? Math.max(0, Math.trunc(cacheMs)) : DEFAULT_METRICS_PER_TOKEN_CACHE_MS;
  const _limit = (typeof historyLimit === 'number' && Number.isFinite(historyLimit)) ? Math.max(0, Math.trunc(historyLimit)) : DEFAULT_METRICS_HISTORY_LIMIT;
  const _nowMs = (typeof nowMs === 'function') ? nowMs : (() => Date.now());
  /** @type {ReturnType<typeof gatherSubset2ProbesFromCtx>|null} */
  let cached = null;
  let cachedAtMs = 0;
  let hits = 0;
  let misses = 0;
  return {
    async gather() {
      const now = _nowMs();
      if (cached !== null && (now - cachedAtMs) < _cacheMs) {
        hits += 1;
        return cached;
      }
      misses += 1;
      const fresh = await gatherSubset2ProbesFromCtx({ ctx, opts: { historyLimit: _limit } });
      cached = fresh;
      cachedAtMs = now;
      return fresh;
    },
    invalidate() {
      cached = null;
      cachedAtMs = 0;
    },
    stats() {
      return {
        cached_at_ms: cached === null ? null : cachedAtMs,
        cache_age_ms: cached === null ? 0 : Math.max(0, _nowMs() - cachedAtMs),
        cache_hits: hits,
        cache_misses: misses,
      };
    },
  };
}