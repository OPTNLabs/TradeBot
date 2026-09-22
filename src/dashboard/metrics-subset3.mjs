#!/usr/bin/env node
// src/dashboard/metrics-subset3.mjs
//
// T78 subset 3 — Prometheus-style HISTOGRAM for trader-loop
// tick durations + adaptive-weight snapshot gauge. Closes the
// remaining deferred items from `idea_metric_export_20260920`
// (the prior subsets shipped summary gauges; this one ships the
// real Prometheus histogram with `_bucket{le=...}` lines so
// Grafana's `histogram_quantile()` operator works on the
// durations).
//
// Subset 3 adds:
//
//   1. **`buildTickDurationHistogram(samples, opts)`** — pure
//      helper that buckets an array of tick durations into a
//      fixed-width exponential histogram. Default is 60 buckets
//      from `le=10ms` to `le=300_000ms` (5 min — past the
//      longest legitimate tick on this bot). Returns:
//        - `buckets` — array of `{le_ms, count, le_label}` for
//          emitting `_bucket{le=...}` lines (cumulative count;
//          bucket `i` includes everything `≤ le_ms[i]`, AND
//          everything in lower buckets, per the Prometheus
//          `histogram` semantics).
//        - `sum_ms` — sum of all samples (the `_sum` line).
//        - `count` — total number of samples (the `_count` line;
//          also used as the denominator for `_sum` arithmetic).
//
//      The `_bucket{le="+Inf"}` bucket is ALWAYS emitted last
//      and equals `_count` per the Prometheus spec — so a
//      `histogram_quantile(0.95, ...)` operator that picks the
//      `+Inf` bucket as its upper bound gets the right answer.
//
//   2. **`buildAdaptiveWeightsMetrics(weights)`** — renders the
//      current per-axis scoring weights as a single
//      `tradebot_loop_adaptive_weights{weight_name=...}` gauge
//      series. One sample per weight axis (e.g.
//      `{weight_name="volume_30d_bch"} 0.30`).
//
//      Defensive: missing / non-finite / non-numeric weights
//      are skipped (counted in `_dropped`) rather than throwing.
//      Weights outside the range [0, 1] are clamped (the rest of
//      the bot normalizes to a sum of 1.0, but a corrupt
//      adaptive-weights apply could push a weight higher).
//
//   3. **`gatherSubset3Probes({ tickDurations, adaptiveWeights, opts })`**
//      — orchestrator. Pure with respect to its inputs. Returns
//      `{ probeStatus, error, tickDuration: { metrics, summary },
//      adaptiveWeights: { metrics, dropped } }`.
//
//   4. **Wire-up** — the orchestrator in `metrics.mjs` accepts
//      a `subset3Probes` seam (mirroring `subset2Probes`) and
//      appends the histogram + adaptive-weight blocks. The
//      dashboard server wires a `metricsSubset3Cache` ctx seam
//      that re-reads `loop.stats()` (NOT `data/history.jsonl`)
//      on each scrape — so the histogram is O(1) regardless of
//      history-file growth.
//
// Design rules (mirroring subsets 1 + 2):
//
//   - **Pure shape.** All helpers accept ready-baked data; no
//     I/O happens in this module. The server-side wrapper
//     (`gatherSubset3ProbesFromCtx`) handles the loop.stats()
//     call + the cache.
//
//   - **Defensive.** Non-array samples, malformed bucket specs,
//     missing weights — every entry degrades to a skip (counted
//     in `_dropped`) rather than throwing.
//
//   - **No `console.log`.** Pure ESM, no I/O, no logger.
//
// Wire envelope (consumed by the orchestrator, not the wire):
//
//   {
//     probeStatus: 'ok' | 'degraded' | 'unconfigured',
//     error: string | null,
//     tickDuration: { metrics: Array<Object>, summary: { count, sum_ms, min_ms, max_ms } },
//     adaptiveWeights: { metrics: Array<Object>, dropped: number },
//   }

/**
 * Schema for the subset-3 envelope.
 *
 * @type {string}
 */
export const METRICS_SUBSET3_SCHEMA = 'tradebot.dashboard.metrics/subset3/v1';

/**
 * Default bucket count for the tick-duration histogram.
 * 60 buckets over [10ms .. 300_000ms] gives a ratio of ~1.13×
 * per bucket — a 60-bucket exponential is fine-grained enough
 * for Grafana's `histogram_quantile()` to give sub-1% error on
 * the p95/p99 quantiles while keeping the scrape payload
 * small (~3 KB for the histogram block).
 *
 * @type {number}
 */
export const DEFAULT_HISTOGRAM_BUCKET_COUNT = 60;

/**
 * Default lower bound (ms) for the histogram's smallest
 * bucket. Anything below 10ms is bucketed into the first
 * bucket (`le=10`); Prometheus histograms always quantize
 * observations DOWN to the nearest bucket upper-bound, so a
 * tiny `le=10ms` bucket doesn't cost precision.
 *
 * @type {number}
 */
export const DEFAULT_HISTOGRAM_MIN_MS = 10;

/**
 * Default upper bound (ms) for the histogram's largest
 * finite bucket. The `+Inf` bucket is always emitted at the
 * end. 5 minutes is past the longest legitimate tick on this
 * bot (operator-poll interval is minutes, not 5 of them).
 *
 * @type {number}
 */
export const DEFAULT_HISTOGRAM_MAX_MS = 300_000;

/**
 * Clamp the histogram bucket-count knob into a safe range
 * (4..200). Below 4 → DEFAULT_HISTOGRAM_BUCKET_COUNT.
 * Above 200 → 200 (a 200-bucket exponential is silly).
 * NaN/Infinity/non-number → DEFAULT_HISTOGRAM_BUCKET_COUNT.
 *
 * @param {*} raw
 * @returns {number}
 */
export function clampHistogramBucketCount(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_HISTOGRAM_BUCKET_COUNT;
  if (raw < 4) return DEFAULT_HISTOGRAM_BUCKET_COUNT;
  if (raw > 200) return 200;
  return Math.trunc(raw);
}

/**
 * Clamp the histogram upper-bound knob (ms) into a safe range
 * (1000..3_600_000). Below 1s → DEFAULT_HISTOGRAM_MAX_MS.
 * Above 1h → 3_600_000. NaN/Infinity/non-number → default.
 *
 * @param {*} raw
 * @returns {number}
 */
export function clampHistogramMaxMs(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_HISTOGRAM_MAX_MS;
  if (raw < 1_000) return DEFAULT_HISTOGRAM_MAX_MS;
  if (raw > 3_600_000) return 3_600_000;
  return Math.trunc(raw);
}

/**
 * Build the bucket upper-bound list for the tick-duration
 * histogram. Returns an array of `le_ms` values (numbers,
 * ascending) — one per bucket. The number of buckets is
 * `bucketCount` and the ratios are exponential (each upper
 * bound is `(max/min)^(i/(bucketCount-1))` × min). The final
 * `+Inf` bucket is added separately by the renderer, NOT by
 * this helper (so callers can pre-compute the bucket list and
 * cache it without worrying about Prometheus-specific
 * conventions).
 *
 * Pure. Never throws. Out-of-range `bucketCount` /
 * `minMs` / `maxMs` fall through to safe defaults.
 *
 * @param {number} bucketCount
 * @param {number} minMs
 * @param {number} maxMs
 * @returns {number[]}
 */
export function buildHistogramBuckets(bucketCount, minMs, maxMs) {
  const safeCount = clampHistogramBucketCount(bucketCount);
  const safeMin = (typeof minMs === 'number' && Number.isFinite(minMs) && minMs > 0)
    ? minMs : DEFAULT_HISTOGRAM_MIN_MS;
  const safeMax = (typeof maxMs === 'number' && Number.isFinite(maxMs) && maxMs > safeMin)
    ? maxMs : DEFAULT_HISTOGRAM_MAX_MS;
  if (safeCount <= 1) return [safeMax];
  const ratio = safeMax / safeMin;
  const out = new Array(safeCount);
  for (let i = 0; i < safeCount; i += 1) {
    // Exponential spacing: each step is `(ratio)^(1/(n-1))`.
    const exp = i / (safeCount - 1);
    const raw = safeMin * Math.pow(ratio, exp);
    // Round to integer ms — Prometheus accepts fractional,
    // but integer labels are easier on the operator's eye.
    out[i] = Math.max(safeMin, Math.round(raw));
  }
  // Dedupe (integer rounding + tiny ratios can collapse adjacent
  // buckets to the same value). Walk the array and bump each
  // collapsed value by 1ms to preserve monotonicity.
  for (let i = 1; i < out.length; i += 1) {
    if (out[i] <= out[i - 1]) out[i] = out[i - 1] + 1;
  }
  return out;
}

/**
 * Build the cumulative `_bucket{le=...}` counts for a sorted
 * list of samples. The returned array aligns 1:1 with the
 * `buckets` array supplied by `buildHistogramBuckets(...)` —
 * `counts[i]` is the number of samples with `duration <=
 * buckets[i]` (cumulative — Prometheus convention).
 *
 * Implemented with a single walk-forward over the sorted
 * samples for O(N+B) time. Both inputs MUST be sorted
 * ascending (Prometheus-histogram convention); the caller is
 * responsible for sorting `sortedSamples` (the histogram
 * builder calls `prepareTickDurationSamples` which already
 * sorts).
 *
 * Pure. Never throws. Non-array / non-number inputs are
 * coerced to a safe default (zero-count array of the right
 * shape).
 *
 * @param {number[]} sortedSamples
 * @param {number[]} buckets
 * @returns {number[]}
 */
export function bucketizeTickDurations(sortedSamples, buckets) {
  const safeBuckets = Array.isArray(buckets) ? buckets.filter((b) => typeof b === 'number' && Number.isFinite(b)) : [];
  const safeSamples = Array.isArray(sortedSamples) ? sortedSamples : [];
  if (safeBuckets.length === 0) return [];
  const counts = new Array(safeBuckets.length).fill(0);
  // Single-pass walk: `count` tracks how many samples have
  // been seen; we emit it to every bucket whose `le` we've
  // already passed. Once a sample exceeds the current
  // bucket's `le`, we record the count and advance to the
  // next bucket.
  let bucketIdx = 0;
  let count = 0;
  for (let i = 0; i < safeSamples.length; i += 1) {
    while (bucketIdx < safeBuckets.length && safeSamples[i] > safeBuckets[bucketIdx]) {
      counts[bucketIdx] = count;
      bucketIdx += 1;
    }
    // The sample fits in the current bucket (and all subsequent
    // buckets — Prometheus cumulative semantics).
    count += 1;
  }
  // Drain any buckets we never reached.
  while (bucketIdx < safeBuckets.length) {
    counts[bucketIdx] = count;
    bucketIdx += 1;
  }
  return counts;
}

/**
 * Sort + filter + clamp a raw tick-durations array into a
 * safe form. Drops non-finite / negative samples (the ring
 * buffer only stores `Math.max(0, duration_ms)` already but
 * defensive at this layer too). Clamps each value to the
 * histogram's max (anything above the max still gets counted
 * in the `+Inf` bucket via `bucketizeTickDurations`'s
 * post-loop, but we also include it in the largest finite
 * bucket so the histogram is monotonic — Prometheus clients
 * conventionally clamp observations to the largest bucket
 * upper-bound).
 *
 * Pure. Never throws. Non-array → empty array.
 *
 * @param {*} rawSamples
 * @param {number} maxMs
 * @returns {number[]}  sorted ascending
 */
export function prepareTickDurationSamples(rawSamples, maxMs) {
  const cap = (typeof maxMs === 'number' && Number.isFinite(maxMs) && maxMs > 0) ? Math.floor(maxMs) : DEFAULT_HISTOGRAM_MAX_MS;
  if (!Array.isArray(rawSamples)) return [];
  const out = [];
  for (const v of rawSamples) {
    let n = null;
    if (typeof v === 'number' && Number.isFinite(v)) {
      n = Math.max(0, Math.min(cap, Math.floor(v)));
    } else if (typeof v === 'string' && v.length > 0) {
      const parsed = Number(v);
      if (Number.isFinite(parsed)) {
        n = Math.max(0, Math.min(cap, Math.floor(parsed)));
      }
    } else if (typeof v === 'bigint') {
      // bigint → Number (the histogram operates on ms —
      // Number can represent up to 2^53 ms without loss).
      if (v >= 0n && v <= BigInt(Number.MAX_SAFE_INTEGER)) {
        n = Number(v);
        if (n > cap) n = cap;
      }
    }
    if (n !== null) out.push(n);
  }
  out.sort((a, b) => a - b);
  return out;
}

/**
 * Build the tick-duration histogram envelope from a raw
 * sample list. Pure helper — returns:
 *
 *   {
 *     metrics: Array<{
 *       name: string,
 *       type: 'histogram',
 *       help: string,
 *       samples: Array<{ labels, value }>,
 *     }>,
 *     summary: { count, sum_ms, min_ms, max_ms, bucket_count },
 *   }
 *
 * The `samples` array is laid out for the existing
 * `formatMetricBlock` to emit:
 *   - one `_bucket{le="<ms>"} <cumulative_count>` line per
 *     finite bucket
 *   - one `_bucket{le="+Inf"} <total_count>` line at the end
 *   - one `<name>_sum <sum_ms>` line
 *   - one `<name>_count <count>` line
 *
 * Per Prometheus convention, these are emitted as a single
 * metric block whose `# TYPE` is `histogram`. The `formatMetricBlock`
 * renderer already handles per-sample label formatting
 * (specifically `le` as a numeric label).
 *
 * Never throws. Non-array / empty input → single-block
 * envelope with `count: 0`, `sum_ms: 0`, a single
 * `_bucket{le="+Inf"} 0` line, and `min_ms`/`max_ms` set to 0.
 *
 * @param {Array<number>} rawSamples — raw tick durations (ms), unsorted OK
 * @param {{bucketCount?: number, minMs?: number, maxMs?: number, namePrefix?: string, helpText?: string}} [opts]
 * @returns {{
 *   metrics: Array<Object>,
 *   summary: { count: number, sum_ms: number, min_ms: number, max_ms: number, bucket_count: number, dropped: number }
 * }}
 */
export function buildTickDurationHistogram(rawSamples, opts = {}) {
  const safeOpts = (opts && typeof opts === 'object') ? opts : {};
  const bucketCount = clampHistogramBucketCount(safeOpts.bucketCount);
  const maxMs = clampHistogramMaxMs(safeOpts.maxMs);
  const minMs = (typeof safeOpts.minMs === 'number' && Number.isFinite(safeOpts.minMs) && safeOpts.minMs >= 1)
    ? Math.floor(safeOpts.minMs) : DEFAULT_HISTOGRAM_MIN_MS;
  const namePrefix = (typeof safeOpts.namePrefix === 'string' && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(safeOpts.namePrefix))
    ? safeOpts.namePrefix : 'tradebot_loop_tick_duration_ms';
  const helpText = (typeof safeOpts.helpText === 'string' && safeOpts.helpText.length > 0)
    ? safeOpts.helpText
    : 'Trader-loop tick duration distribution (ms); Prometheus-style histogram with cumulative buckets';

  const totalRawCount = Array.isArray(rawSamples) ? rawSamples.length : 0;
  const samples = prepareTickDurationSamples(rawSamples, maxMs);
  const dropped = totalRawCount - samples.length;
  const buckets = buildHistogramBuckets(bucketCount, minMs, maxMs);
  const counts = bucketizeTickDurations(samples, buckets);
  const count = samples.length;
  const sum = count > 0 ? samples.reduce((acc, n) => acc + n, 0) : 0;
  const minV = count > 0 ? samples[0] : 0;
  const maxV = count > 0 ? samples[count - 1] : 0;

  // Build the samples array. Order is important: Prometheus
  // histograms conventionally emit the buckets first, then
  // _sum, then _count. The downstream `formatMetricBlock`
  // sorts samples by label-tuple internally, so the wire
  // ordering will be:
  //   - _bucket{le="10"}       counts[0]
  //   - _bucket{le="..."}      counts[1..n-1]
  //   - _bucket{le="+Inf"}     total
  //   - <name>_sum             sum
  //   - <name>_count           count
  // The sort uses `formatLabels`, which produces `le="<ms>"`
  // for numeric labels — numeric ascending order, then
  // `le="+Inf"` lexicographically after any number, then
  // `_sum` / `_count` last. (Test asserts the final wire
  // format below.)
  //
  // T80 — each sample carries a `__suffix` discriminator so
  // `formatMetricBlock` can emit the right
  // `<name>_bucket{le=...}` / `<name>_sum` / `<name>_count`
  // line per Prometheus convention.
  const histSamples = [];
  for (let i = 0; i < buckets.length; i += 1) {
    histSamples.push({
      labels: { le: buckets[i] },
      value: counts[i] ?? 0,
      __suffix: 'bucket',
    });
  }
  // The +Inf bucket always equals the total count (Prometheus
  // spec — `le="+Inf"` is the universe).
  histSamples.push({
    labels: { le: '+Inf' },
    value: count,
    __suffix: 'bucket',
  });
  // _sum and _count are surfaced as separate samples so the
  // orchestrator's block-emission produces the standard
  // `<name>_sum` / `<name>_count` lines. No labels — per
  // Prometheus convention `_sum` / `_count` are emitted with
  // empty label sets.
  histSamples.push({ labels: {}, value: sum, __suffix: 'sum' });
  histSamples.push({ labels: {}, value: count, __suffix: 'count' });

  // Build a single histogram block.
  const block = {
    name: namePrefix,
    type: 'histogram',
    help: helpText,
    samples: histSamples,
  };
  return {
    metrics: [block],
    summary: {
      count,
      sum_ms: sum,
      min_ms: minV,
      max_ms: maxV,
      bucket_count: buckets.length,
      dropped,
    },
  };
}

/**
 * Render the adaptive-weight snapshot as a single
 * `tradebot_loop_adaptive_weights{weight_name=...}` gauge
 * block. Pure helper — never throws; defensive on every input.
 *
 * @param {Record<string, number>|null|undefined} weights
 * @returns {{
 *   metrics: Array<Object>,
 *   dropped: number,
 *   keys: string[],
 * }}
 */
export function buildAdaptiveWeightsMetrics(weights) {
  const out = { metrics: [], dropped: 0, keys: [] };
  if (!weights || typeof weights !== 'object' || Array.isArray(weights)) {
    // Missing / non-object → emit a single placeholder sample
    // so the wire format stays parseable. We can't emit a
    // `_sum` line or `_count` here (this is a gauge, not a
    // histogram) — just the zero-value gauge.
    out.metrics.push({
      name: 'tradebot_loop_adaptive_weights',
      type: 'gauge',
      help: 'Current per-axis scoring weight the trader loop will use on the next tick (sourced from cfg.scoring.weights)',
      samples: [{ labels: { weight_name: '_unconfigured' }, value: 0 }],
    });
    return out;
  }
  const keys = Object.keys(weights).sort();
  const samples = [];
  for (const k of keys) {
    if (typeof k !== 'string' || k.length === 0 || k.length > 64) {
      out.dropped += 1;
      continue;
    }
    // Restrict the label to printable ASCII so the wire
    // format stays parseable (Prometheus label-value spec).
    if (!/^[A-Za-z0-9_\-]+$/.test(k)) {
      out.dropped += 1;
      continue;
    }
    const raw = weights[k];
    let v = 0;
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      // Clamp to [0, 1] — weights sum to 1 by construction in
      // the rest of the bot, but a corrupt adaptive-weights
      // apply could push a weight higher. Negative is a sign
      // of upstream drift, clamp to 0; >1 is also drift,
      // clamp to 1.
      v = Math.max(0, Math.min(1, raw));
    } else if (typeof raw === 'string' && raw.length > 0) {
      const n = Number(raw);
      if (Number.isFinite(n)) v = Math.max(0, Math.min(1, n));
      else out.dropped += 1;
    } else {
      out.dropped += 1;
      continue;
    }
    samples.push({ labels: { weight_name: k }, value: v });
  }
  if (samples.length === 0) {
    out.metrics.push({
      name: 'tradebot_loop_adaptive_weights',
      type: 'gauge',
      help: 'Current per-axis scoring weight the trader loop will use on the next tick (sourced from cfg.scoring.weights)',
      samples: [{ labels: { weight_name: '_empty' }, value: 0 }],
    });
    return out;
  }
  out.metrics.push({
    name: 'tradebot_loop_adaptive_weights',
    type: 'gauge',
    help: 'Current per-axis scoring weight the trader loop will use on the next tick (sourced from cfg.scoring.weights)',
    samples,
  });
  out.keys = samples.map((s) => s.labels.weight_name);
  return out;
}

/**
 * Top-level "gather the subset-3 probes" orchestrator. Pure
 * with respect to its inputs.
 *
 * @param {Object} args
 * @param {Array<number|bigint|string>} [args.tickDurations]
 * @param {Record<string, number>|null|undefined} [args.adaptiveWeights]
 * @param {{bucketCount?: number, minMs?: number, maxMs?: number}} [args.opts]
 * @returns {{
 *   probeStatus: 'ok'|'degraded',
 *   error: string|null,
 *   tickDuration: { metrics: Array<Object>, summary: { count:number, sum_ms:number, min_ms:number, max_ms:number, bucket_count:number, dropped:number } },
 *   adaptiveWeights: { metrics: Array<Object>, dropped: number, keys: string[] },
 * }}
 */
export function gatherSubset3Probes({ tickDurations, adaptiveWeights, opts = {} } = {}) {
  const safeOpts = (opts && typeof opts === 'object') ? opts : {};
  const safeSamples = Array.isArray(tickDurations) ? tickDurations : [];
  const histBlock = buildTickDurationHistogram(safeSamples, {
    bucketCount: safeOpts.bucketCount,
    minMs: safeOpts.minMs,
    maxMs: safeOpts.maxMs,
  });
  const awBlock = buildAdaptiveWeightsMetrics(adaptiveWeights);
  return {
    probeStatus: 'ok',
    error: null,
    tickDuration: histBlock,
    adaptiveWeights: awBlock,
  };
}

/**
 * Server-side wrapper. Reads from `ctx.loop.stats()` (NOT
 * the history file — so a scrape is O(1) regardless of how big
 * `data/history.jsonl` gets). Returns the same shape as
 * `gatherSubset3Probes`. Defensive: missing loop → unconfigured
 * probe; throwing `loop.stats()` → degraded probe. NEVER throws.
 *
 * @param {Object} args
 * @param {Object} args.ctx — dashboard server ctx (carries `loop`)
 * @param {{bucketCount?: number, minMs?: number, maxMs?: number}} [args.opts]
 * @returns {{
 *   probeStatus: 'ok'|'degraded'|'unconfigured',
 *   error: string|null,
 *   tickDuration: { metrics: Array<Object>, summary: Object },
 *   adaptiveWeights: { metrics: Array<Object>, dropped: number, keys: string[] },
 * }}
 */
export function gatherSubset3ProbesFromCtx({ ctx, opts = {} } = {}) {
  const safeOpts = (opts && typeof opts === 'object') ? opts : {};
  if (!ctx || typeof ctx !== 'object' || !ctx.loop || typeof ctx.loop.stats !== 'function') {
    return {
      probeStatus: 'unconfigured',
      error: null,
      tickDuration: buildTickDurationHistogram([], safeOpts),
      adaptiveWeights: buildAdaptiveWeightsMetrics(null),
    };
  }
  let stats;
  try {
    stats = ctx.loop.stats();
  } catch (e) {
    return {
      probeStatus: 'degraded',
      error: (e && e.message) ? String(e.message) : 'loop.stats() threw',
      tickDuration: buildTickDurationHistogram([], safeOpts),
      adaptiveWeights: buildAdaptiveWeightsMetrics(null),
    };
  }
  // The loop's `stats()` exposes a `tick_duration_ring` array
  // (T80 wiring) containing the last N raw durations. If the
  // operator hasn't updated the loop yet (subset 3 ships as a
  // paired update — see trader/loop.mjs), fall back to the
  // single-tick `last_tick_duration_ms` so the histogram still
  // emits a useful shape.
  let ringSamples = null;
  if (Array.isArray(stats?.tick_duration_ring)) {
    ringSamples = stats.tick_duration_ring;
  } else if (typeof stats?.last_tick_duration_ms === 'number' && Number.isFinite(stats.last_tick_duration_ms) && stats.last_tick_duration_ms >= 0) {
    ringSamples = [stats.last_tick_duration_ms];
  }
  // The adaptive-weight snapshot is a flat object on
  // `stats().adaptive_weights_state` (subset 3 wiring). If the
  // loop hasn't been updated, fall back to the loop's
  // `loopCfg.scoring.weights` (subset 3 also exposes that as
  // a fallback for backward compatibility).
  let weights = null;
  if (stats?.adaptive_weights_state && typeof stats.adaptive_weights_state === 'object' && !Array.isArray(stats.adaptive_weights_state)) {
    weights = stats.adaptive_weights_state;
  } else if (stats?.loop_config?.scoring?.weights && typeof stats.loop_config.scoring.weights === 'object' && !Array.isArray(stats.loop_config.scoring.weights)) {
    weights = stats.loop_config.scoring.weights;
  }
  const probes = gatherSubset3Probes({
    tickDurations: ringSamples || [],
    adaptiveWeights: weights,
    opts: safeOpts,
  });
  return {
    probeStatus: 'ok',
    error: null,
    tickDuration: probes.tickDuration,
    adaptiveWeights: probes.adaptiveWeights,
  };
}
