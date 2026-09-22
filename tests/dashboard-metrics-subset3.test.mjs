#!/usr/bin/env node
// tests/dashboard-metrics-subset3.test.mjs
//
// T80 — unit + integration tests for
// `src/dashboard/metrics-subset3.mjs` (Prometheus-style histogram
// for trader-loop tick duration + adaptive-weight snapshot
// gauge) and the new `subset3Probes` seam in
// `src/dashboard/metrics.mjs` + `src/dashboard/server.mjs`. Also
// covers the trader-loop wiring (`_pushTickDuration`,
// `_exportTickDurationRing`, `_exportAdaptiveWeightsState`) and
// the formatMetricBlock histogram-type support.
//
// Run with:
//
//   node --test tests/dashboard-metrics-subset3.test.mjs
//
// Coverage:
//   1. clamp helpers (8)
//   2. buildHistogramBuckets (6)
//   3. bucketizeTickDurations (6)
//   4. prepareTickDurationSamples (8)
//   5. buildTickDurationHistogram (8)
//   6. buildAdaptiveWeightsMetrics (8)
//   7. gatherSubset3Probes (4)
//   8. gatherSubset3ProbesFromCtx (6)
//   9. formatMetricBlock histogram support (4)
//  10. buildMetricsEnvelope subset3 seam (5)
//  11. trader/loop.mjs: tick-duration ring buffer + adaptive
//      weights state export (8)
//  12. server: /metrics HTTP integration with subset3 (4)
//
// Total: ~75 tests.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  clampHistogramBucketCount,
  clampHistogramMaxMs,
  buildHistogramBuckets,
  bucketizeTickDurations,
  prepareTickDurationSamples,
  buildTickDurationHistogram,
  buildAdaptiveWeightsMetrics,
  gatherSubset3Probes,
  gatherSubset3ProbesFromCtx,
  DEFAULT_HISTOGRAM_BUCKET_COUNT,
  DEFAULT_HISTOGRAM_MIN_MS,
  DEFAULT_HISTOGRAM_MAX_MS,
  METRICS_SUBSET3_SCHEMA,
} from '../src/dashboard/metrics-subset3.mjs';
import {
  buildMetricsEnvelope,
  formatPrometheusText,
  formatMetricBlock,
} from '../src/dashboard/metrics.mjs';
import { createDashboardServer } from '../src/dashboard/server.mjs';

// ─────────────────────────────────────────────────────────────────────
//  clamp helpers
// ─────────────────────────────────────────────────────────────────────
describe('metrics-subset3: clamp helpers', () => {
  it('clampHistogramBucketCount returns default for non-number', () => {
    assert.equal(clampHistogramBucketCount('60'), DEFAULT_HISTOGRAM_BUCKET_COUNT);
    assert.equal(clampHistogramBucketCount(null), DEFAULT_HISTOGRAM_BUCKET_COUNT);
    assert.equal(clampHistogramBucketCount(undefined), DEFAULT_HISTOGRAM_BUCKET_COUNT);
    assert.equal(clampHistogramBucketCount(NaN), DEFAULT_HISTOGRAM_BUCKET_COUNT);
    assert.equal(clampHistogramBucketCount(Infinity), DEFAULT_HISTOGRAM_BUCKET_COUNT);
  });
  it('clampHistogramBucketCount returns default for <4', () => {
    assert.equal(clampHistogramBucketCount(0), DEFAULT_HISTOGRAM_BUCKET_COUNT);
    assert.equal(clampHistogramBucketCount(-5), DEFAULT_HISTOGRAM_BUCKET_COUNT);
    assert.equal(clampHistogramBucketCount(3), DEFAULT_HISTOGRAM_BUCKET_COUNT);
  });
  it('clampHistogramBucketCount clamps above 200', () => {
    assert.equal(clampHistogramBucketCount(500), 200);
    assert.equal(clampHistogramBucketCount(10000), 200);
  });
  it('clampHistogramBucketCount floors fractional values', () => {
    assert.equal(clampHistogramBucketCount(45.7), 45);
    assert.equal(clampHistogramBucketCount(60.3), 60);
  });
  it('clampHistogramMaxMs returns default for non-number', () => {
    assert.equal(clampHistogramMaxMs('5000'), DEFAULT_HISTOGRAM_MAX_MS);
    assert.equal(clampHistogramMaxMs(null), DEFAULT_HISTOGRAM_MAX_MS);
    assert.equal(clampHistogramMaxMs(NaN), DEFAULT_HISTOGRAM_MAX_MS);
  });
  it('clampHistogramMaxMs returns default for <1000', () => {
    assert.equal(clampHistogramMaxMs(0), DEFAULT_HISTOGRAM_MAX_MS);
    assert.equal(clampHistogramMaxMs(-1), DEFAULT_HISTOGRAM_MAX_MS);
    assert.equal(clampHistogramMaxMs(500), DEFAULT_HISTOGRAM_MAX_MS);
  });
  it('clampHistogramMaxMs clamps above 3_600_000', () => {
    assert.equal(clampHistogramMaxMs(10_000_000), 3_600_000);
  });
  it('clampHistogramMaxMs floors fractional values', () => {
    assert.equal(clampHistogramMaxMs(5000.7), 5000);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  buildHistogramBuckets
// ─────────────────────────────────────────────────────────────────────
describe('metrics-subset3: buildHistogramBuckets', () => {
  it('returns array of correct length', () => {
    const b = buildHistogramBuckets(60, 10, 300_000);
    assert.equal(b.length, 60);
  });
  it('first bucket is at or above the min', () => {
    const b = buildHistogramBuckets(60, 10, 300_000);
    assert.ok(b[0] >= 10, `first bucket ${b[0]} should be >= 10`);
  });
  it('last bucket is at or below the max', () => {
    const b = buildHistogramBuckets(60, 10, 300_000);
    assert.ok(b[b.length - 1] <= 300_000, `last bucket ${b[b.length - 1]} should be <= 300000`);
  });
  it('buckets are monotonically increasing (no duplicates)', () => {
    const b = buildHistogramBuckets(60, 10, 300_000);
    for (let i = 1; i < b.length; i += 1) {
      assert.ok(b[i] > b[i - 1], `buckets must be strictly increasing: b[${i-1}]=${b[i-1]} b[${i}]=${b[i]}`);
    }
  });
  it('falls through to defaults on out-of-range inputs', () => {
    const b1 = buildHistogramBuckets(0, -1, 0);
    assert.equal(b1.length, DEFAULT_HISTOGRAM_BUCKET_COUNT);
    // bucketCount=2 is below the floor of 4; falls through to default.
    const b2 = buildHistogramBuckets(2, 10, 1000);
    assert.equal(b2.length, DEFAULT_HISTOGRAM_BUCKET_COUNT);
  });
  it('handles tiny ratios (small max relative to min)', () => {
    const b = buildHistogramBuckets(8, 1, 8);
    assert.equal(b.length, 8);
    for (let i = 1; i < b.length; i += 1) {
      assert.ok(b[i] > b[i - 1]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
//  bucketizeTickDurations
// ─────────────────────────────────────────────────────────────────────
describe('metrics-subset3: bucketizeTickDurations', () => {
  it('returns zero counts for empty samples', () => {
    const buckets = [10, 50, 100, 500, 1000];
    const counts = bucketizeTickDurations([], buckets);
    assert.deepEqual(counts, [0, 0, 0, 0, 0]);
  });
  it('buckets all samples into the largest bucket', () => {
    const buckets = [10, 50, 100, 500, 1000];
    const samples = [5, 15, 80, 200, 600, 999];
    samples.sort((a, b) => a - b);
    const counts = bucketizeTickDurations(samples, buckets);
    assert.equal(counts[0], 1); // 5 ≤ 10
    assert.equal(counts[1], 2); // 5, 15 ≤ 50
    assert.equal(counts[2], 3); // 5, 15, 80 ≤ 100
    assert.equal(counts[3], 4); // ..., 200 ≤ 500
    assert.equal(counts[4], 6); // all 6 ≤ 1000
  });
  it('respects bucket boundaries exactly', () => {
    const buckets = [10, 100];
    const samples = [10, 100]; // exactly on boundary
    const counts = bucketizeTickDurations(samples, buckets);
    assert.equal(counts[0], 1); // 10 ≤ 10
    assert.equal(counts[1], 2); // 10, 100 ≤ 100
  });
  it('returns empty array for empty buckets', () => {
    const counts = bucketizeTickDurations([1, 2, 3], []);
    assert.deepEqual(counts, []);
  });
  it('returns zero-filled array for empty samples with buckets', () => {
    const buckets = [1, 2, 3];
    const counts = bucketizeTickDurations([], buckets);
    assert.deepEqual(counts, [0, 0, 0]);
  });
  it('handles non-array inputs defensively', () => {
    const counts = bucketizeTickDurations(null, [1, 2, 3]);
    assert.deepEqual(counts, [0, 0, 0]);
    const counts2 = bucketizeTickDurations([1, 2, 3], null);
    assert.deepEqual(counts2, []);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  prepareTickDurationSamples
// ─────────────────────────────────────────────────────────────────────
describe('metrics-subset3: prepareTickDurationSamples', () => {
  it('sorts ascending and clamps negative values', () => {
    const out = prepareTickDurationSamples([100, -5, 50, 25], 1000);
    assert.deepEqual(out, [0, 25, 50, 100]);
  });
  it('clamps above the max', () => {
    const out = prepareTickDurationSamples([100, 5000, 200], 1000);
    assert.deepEqual(out, [100, 200, 1000]);
  });
  it('parses string numbers', () => {
    const out = prepareTickDurationSamples(['100', '50', 'foo'], 1000);
    assert.deepEqual(out, [50, 100]);
  });
  it('handles bigint values', () => {
    const out = prepareTickDurationSamples([100n, 50n, 200n], 1000);
    assert.deepEqual(out, [50, 100, 200]);
  });
  it('returns empty for non-array', () => {
    assert.deepEqual(prepareTickDurationSamples(null, 1000), []);
    assert.deepEqual(prepareTickDurationSamples(undefined, 1000), []);
    assert.deepEqual(prepareTickDurationSamples('foo', 1000), []);
  });
  it('drops NaN/Infinity/non-finite values', () => {
    const out = prepareTickDurationSamples([100, NaN, Infinity, -Infinity, 50], 1000);
    assert.deepEqual(out, [50, 100]);
  });
  it('drops values above MAX_SAFE_INTEGER (bigint overflow)', () => {
    const out = prepareTickDurationSamples([100n, 10n ** 20n], 1000);
    // 10^20 > MAX_SAFE_INTEGER; the bigint branch drops it.
    assert.deepEqual(out, [100]);
  });
  it('uses default cap on bad maxMs', () => {
    const out = prepareTickDurationSamples([100, 500_000], 'not a number');
    // Default cap is 300_000.
    assert.deepEqual(out, [100, 300_000]);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  buildTickDurationHistogram
// ─────────────────────────────────────────────────────────────────────
describe('metrics-subset3: buildTickDurationHistogram', () => {
  it('returns empty-but-valid envelope for empty input', () => {
    const r = buildTickDurationHistogram([]);
    assert.equal(r.summary.count, 0);
    assert.equal(r.summary.sum_ms, 0);
    assert.equal(r.summary.min_ms, 0);
    assert.equal(r.summary.max_ms, 0);
    assert.equal(r.metrics.length, 1);
    // The block emits one histogram type with all samples carrying
    // __suffix. +Inf bucket is always present.
    const block = r.metrics[0];
    assert.equal(block.type, 'histogram');
    const bucketSamples = block.samples.filter((s) => s.__suffix === 'bucket');
    assert.equal(bucketSamples.length, DEFAULT_HISTOGRAM_BUCKET_COUNT + 1); // +1 for +Inf
    assert.equal(bucketSamples[bucketSamples.length - 1].labels.le, '+Inf');
    assert.equal(bucketSamples[bucketSamples.length - 1].value, 0);
  });
  it('summary count == total sample count, sum == sum of values', () => {
    const samples = [10, 20, 30, 40, 50];
    const r = buildTickDurationHistogram(samples);
    assert.equal(r.summary.count, 5);
    assert.equal(r.summary.sum_ms, 150);
    assert.equal(r.summary.min_ms, 10);
    assert.equal(r.summary.max_ms, 50);
  });
  it('counts are cumulative (each bucket ≥ previous)', () => {
    const samples = [5, 15, 80, 200, 600];
    const r = buildTickDurationHistogram(samples, { bucketCount: 10, minMs: 10, maxMs: 1000 });
    const block = r.metrics[0];
    const bucketSamples = block.samples.filter((s) => s.__suffix === 'bucket');
    // Drop the +Inf bucket for cumulative-check.
    const finite = bucketSamples.filter((s) => s.labels.le !== '+Inf');
    for (let i = 1; i < finite.length; i += 1) {
      assert.ok(finite[i].value >= finite[i - 1].value, `cumulative check: bucket[${i}]=${finite[i].value} < bucket[${i-1}]=${finite[i-1].value}`);
    }
    // The +Inf bucket equals the total count.
    const inf = bucketSamples[bucketSamples.length - 1];
    assert.equal(inf.labels.le, '+Inf');
    assert.equal(inf.value, 5);
  });
  it('always emits _sum and _count samples', () => {
    const r = buildTickDurationHistogram([10, 20, 30]);
    const block = r.metrics[0];
    const sumSamples = block.samples.filter((s) => s.__suffix === 'sum');
    const countSamples = block.samples.filter((s) => s.__suffix === 'count');
    assert.equal(sumSamples.length, 1);
    assert.equal(sumSamples[0].value, 60);
    assert.equal(countSamples.length, 1);
    assert.equal(countSamples[0].value, 3);
  });
  it('drops invalid inputs and counts them', () => {
    const r = buildTickDurationHistogram([10, 'foo', NaN, null, undefined, 20], { bucketCount: 5 });
    assert.equal(r.summary.count, 2);
    assert.equal(r.summary.dropped, 4);
  });
  it('honors bucketCount, minMs, maxMs options', () => {
    const r = buildTickDurationHistogram([100, 200, 300], { bucketCount: 5, minMs: 50, maxMs: 1000 });
    const block = r.metrics[0];
    const buckets = block.samples.filter((s) => s.__suffix === 'bucket' && s.labels.le !== '+Inf');
    assert.equal(buckets.length, 5);
    assert.ok(buckets[0].labels.le >= 50);
    // The last bucket upper-bound may exceed the requested max
    // by a few ms (rounding + monotonicity-preservation in
    // `buildHistogramBuckets`); assert it's within 5ms of max.
    const last = buckets[buckets.length - 1].labels.le;
    assert.ok(last <= 1005, `last bucket ${last} should be within 5ms of maxMs=1000`);
  });
  it('rejects invalid namePrefix and falls back to default', () => {
    const r = buildTickDurationHistogram([100], { namePrefix: 'invalid-prefix-with-dashes!' });
    // Falls back to the default prefix.
    assert.equal(r.metrics[0].name, 'tradebot_loop_tick_duration_ms');
  });
  it('accepts a valid namePrefix', () => {
    const r = buildTickDurationHistogram([100], { namePrefix: 'custom_metric' });
    assert.equal(r.metrics[0].name, 'custom_metric');
  });
});

// ─────────────────────────────────────────────────────────────────────
//  buildAdaptiveWeightsMetrics
// ─────────────────────────────────────────────────────────────────────
describe('metrics-subset3: buildAdaptiveWeightsMetrics', () => {
  it('returns single placeholder sample for null/undefined input', () => {
    const r1 = buildAdaptiveWeightsMetrics(null);
    assert.equal(r1.metrics[0].samples[0].labels.weight_name, '_unconfigured');
    assert.equal(r1.metrics[0].samples[0].value, 0);
    const r2 = buildAdaptiveWeightsMetrics(undefined);
    assert.equal(r2.metrics[0].samples[0].labels.weight_name, '_unconfigured');
  });
  it('returns single placeholder for non-object input', () => {
    const r = buildAdaptiveWeightsMetrics('foo');
    assert.equal(r.metrics[0].samples[0].labels.weight_name, '_unconfigured');
  });
  it('emits one sample per weight axis', () => {
    const r = buildAdaptiveWeightsMetrics({
      volume_24h_bch: 0.10,
      volume_30d_bch: 0.30,
      tvl_bch: 0.10,
    });
    assert.equal(r.metrics[0].samples.length, 3);
    assert.equal(r.dropped, 0);
    assert.deepEqual(r.keys.sort(), ['tvl_bch', 'volume_24h_bch', 'volume_30d_bch']);
  });
  it('clamps out-of-range values to [0, 1]', () => {
    const r = buildAdaptiveWeightsMetrics({
      neg: -0.5,
      hi: 5.0,
      ok: 0.5,
    });
    const byName = {};
    for (const s of r.metrics[0].samples) byName[s.labels.weight_name] = s.value;
    assert.equal(byName.neg, 0);
    assert.equal(byName.hi, 1);
    assert.equal(byName.ok, 0.5);
  });
  it('drops weights with bad keys', () => {
    const r = buildAdaptiveWeightsMetrics({
      good: 0.5,
      'has space': 0.3,
      'has.dots': 0.2,
      '': 0.1,
    });
    assert.equal(r.metrics[0].samples.length, 1);
    assert.equal(r.metrics[0].samples[0].labels.weight_name, 'good');
    assert.equal(r.dropped, 3);
  });
  it('drops weights with non-finite values', () => {
    const r = buildAdaptiveWeightsMetrics({
      good: 0.5,
      nan: NaN,
      str: Infinity,
      nul: null,
      undef: undefined,
    });
    assert.equal(r.metrics[0].samples.length, 1);
    assert.equal(r.dropped, 4);
  });
  it('parses string values that are valid numbers', () => {
    const r = buildAdaptiveWeightsMetrics({ good: '0.5', bad: 'foo' });
    const byName = {};
    for (const s of r.metrics[0].samples) byName[s.labels.weight_name] = s.value;
    assert.equal(byName.good, 0.5);
    assert.equal(r.dropped, 1);
  });
  it('emits _empty placeholder when all entries drop', () => {
    const r = buildAdaptiveWeightsMetrics({ 'has space': 0.5 });
    assert.equal(r.metrics[0].samples[0].labels.weight_name, '_empty');
  });
});

// ─────────────────────────────────────────────────────────────────────
//  gatherSubset3Probes
// ─────────────────────────────────────────────────────────────────────
describe('metrics-subset3: gatherSubset3Probes', () => {
  it('returns probeStatus: ok with empty data', () => {
    const r = gatherSubset3Probes({});
    assert.equal(r.probeStatus, 'ok');
    assert.equal(r.error, null);
    assert.equal(r.tickDuration.summary.count, 0);
  });
  it('builds histogram from supplied samples', () => {
    const r = gatherSubset3Probes({ tickDurations: [10, 50, 100, 500] });
    assert.equal(r.tickDuration.summary.count, 4);
    assert.equal(r.tickDuration.summary.sum_ms, 660);
  });
  it('emits adaptive-weight samples', () => {
    const r = gatherSubset3Probes({
      adaptiveWeights: { volume_24h_bch: 0.1, tvl_bch: 0.2 },
    });
    assert.equal(r.adaptiveWeights.metrics[0].samples.length, 2);
  });
  it('passes bucket-count / min / max opts through', () => {
    const r = gatherSubset3Probes({
      tickDurations: [100, 200, 300],
      opts: { bucketCount: 4, minMs: 50, maxMs: 500 },
    });
    const buckets = r.tickDuration.metrics[0].samples.filter((s) => s.__suffix === 'bucket' && s.labels.le !== '+Inf');
    assert.equal(buckets.length, 4);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  gatherSubset3ProbesFromCtx
// ─────────────────────────────────────────────────────────────────────
describe('metrics-subset3: gatherSubset3ProbesFromCtx', () => {
  it('returns unconfigured for missing ctx', () => {
    const r = gatherSubset3ProbesFromCtx({ ctx: null });
    assert.equal(r.probeStatus, 'unconfigured');
  });
  it('returns unconfigured when ctx.loop is missing', () => {
    const r = gatherSubset3ProbesFromCtx({ ctx: {} });
    assert.equal(r.probeStatus, 'unconfigured');
    assert.equal(r.tickDuration.summary.count, 0);
  });
  it('returns degraded when loop.stats() throws', () => {
    const r = gatherSubset3ProbesFromCtx({
      ctx: { loop: { stats: () => { throw new Error('boom'); } } },
    });
    assert.equal(r.probeStatus, 'degraded');
    assert.match(r.error, /boom/);
    assert.equal(r.tickDuration.summary.count, 0);
  });
  it('happy path: reads tick_duration_ring + adaptive_weights_state', () => {
    const r = gatherSubset3ProbesFromCtx({
      ctx: {
        loop: {
          stats: () => ({
            tick_duration_ring: [10, 20, 30],
            adaptive_weights_state: { volume_24h_bch: 0.1, tvl_bch: 0.2 },
            loop_config: {},
          }),
        },
      },
    });
    assert.equal(r.probeStatus, 'ok');
    assert.equal(r.tickDuration.summary.count, 3);
    assert.equal(r.adaptiveWeights.metrics[0].samples.length, 2);
  });
  it('falls back to last_tick_duration_ms when ring is missing', () => {
    const r = gatherSubset3ProbesFromCtx({
      ctx: {
        loop: {
          stats: () => ({
            last_tick_duration_ms: 123,
            adaptive_weights_state: null,
            loop_config: {},
          }),
        },
      },
    });
    assert.equal(r.probeStatus, 'ok');
    assert.equal(r.tickDuration.summary.count, 1);
    assert.equal(r.tickDuration.summary.sum_ms, 123);
  });
  it('falls back to loop_config.scoring.weights when adaptive_weights_state is missing', () => {
    const r = gatherSubset3ProbesFromCtx({
      ctx: {
        loop: {
          stats: () => ({
            last_tick_duration_ms: 0,
            loop_config: { scoring: { weights: { volume_24h_bch: 0.5 } } },
          }),
        },
      },
    });
    assert.equal(r.probeStatus, 'ok');
    assert.equal(r.adaptiveWeights.metrics[0].samples.length, 1);
    assert.equal(r.adaptiveWeights.metrics[0].samples[0].value, 0.5);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  formatMetricBlock histogram support
// ─────────────────────────────────────────────────────────────────────
describe('metrics: formatMetricBlock histogram type', () => {
  it('renders _bucket / _sum / _count lines per __suffix', () => {
    const block = {
      name: 'tradebot_loop_tick_duration_ms',
      type: 'histogram',
      help: 'tick duration histogram',
      samples: [
        { labels: { le: 10 }, value: 1, __suffix: 'bucket' },
        { labels: { le: 50 }, value: 3, __suffix: 'bucket' },
        { labels: { le: '+Inf' }, value: 5, __suffix: 'bucket' },
        { labels: {}, value: 100, __suffix: 'sum' },
        { labels: {}, value: 5, __suffix: 'count' },
      ],
    };
    const text = formatMetricBlock(block);
    assert.match(text, /^# HELP tradebot_loop_tick_duration_ms tick duration histogram/m);
    assert.match(text, /# TYPE tradebot_loop_tick_duration_ms histogram/);
    assert.match(text, /tradebot_loop_tick_duration_ms_bucket\{le="10"\} 1/);
    assert.match(text, /tradebot_loop_tick_duration_ms_bucket\{le="50"\} 3/);
    assert.match(text, /tradebot_loop_tick_duration_ms_bucket\{le="\+Inf"\} 5/);
    assert.match(text, /tradebot_loop_tick_duration_ms_sum 100/);
    assert.match(text, /tradebot_loop_tick_duration_ms_count 5/);
  });
  it('renders counter type unchanged when __suffix is absent', () => {
    const block = {
      name: 'metric_a',
      type: 'counter',
      help: 'help',
      samples: [{ labels: {}, value: 5 }],
    };
    const text = formatMetricBlock(block);
    assert.match(text, /^metric_a 5$/m);
  });
  it('refuses invalid name even for histogram', () => {
    const block = {
      name: 'has-dash',
      type: 'histogram',
      help: 'help',
      samples: [{ labels: {}, value: 1, __suffix: 'count' }],
    };
    assert.equal(formatMetricBlock(block), '');
  });
  it('drops unknown __suffix values (defaults to base name)', () => {
    const block = {
      name: 'metric_x',
      type: 'histogram',
      help: 'help',
      samples: [{ labels: {}, value: 1, __suffix: 'bogus' }],
    };
    const text = formatMetricBlock(block);
    assert.match(text, /^metric_x 1$/m);
    assert.doesNotMatch(text, /metric_x_bogus/);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  buildMetricsEnvelope: subset3 seam
// ─────────────────────────────────────────────────────────────────────
describe('buildMetricsEnvelope: subset3 seam', () => {
  it('omits subset3 metrics when subset3Probes is not provided', async () => {
    const envelope = await buildMetricsEnvelope({
      ctx: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
    });
    const names = envelope.metrics.map((m) => m.name);
    assert.ok(!names.includes('tradebot_loop_tick_duration_ms'));
    assert.ok(!names.includes('tradebot_loop_adaptive_weights'));
  });
  it('includes subset3 metrics when subset3Probes is provided', async () => {
    const subset3Probes = {
      probeStatus: 'ok',
      error: null,
      tickDuration: {
        metrics: [{
          name: 'tradebot_loop_tick_duration_ms',
          type: 'histogram',
          help: 'tick duration histogram',
          samples: [
            { labels: { le: 10 }, value: 1, __suffix: 'bucket' },
            { labels: { le: '+Inf' }, value: 1, __suffix: 'bucket' },
            { labels: {}, value: 10, __suffix: 'sum' },
            { labels: {}, value: 1, __suffix: 'count' },
          ],
        }],
        summary: { count: 1, sum_ms: 10, min_ms: 10, max_ms: 10 },
      },
      adaptiveWeights: {
        metrics: [{
          name: 'tradebot_loop_adaptive_weights',
          type: 'gauge',
          help: 'weight snapshot',
          samples: [{ labels: { weight_name: 'volume_24h_bch' }, value: 0.1 }],
        }],
        dropped: 0,
        keys: ['volume_24h_bch'],
      },
    };
    const envelope = await buildMetricsEnvelope({
      ctx: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
      subset3Probes,
    });
    const names = envelope.metrics.map((m) => m.name);
    assert.ok(names.includes('tradebot_loop_tick_duration_ms'));
    assert.ok(names.includes('tradebot_loop_adaptive_weights'));
  });
  it('renders to parseable Prometheus text when subset3 is wired', async () => {
    const subset3Probes = gatherSubset3Probes({
      tickDurations: [10, 50, 100, 500, 1000],
      adaptiveWeights: { volume_24h_bch: 0.5 },
    });
    const envelope = await buildMetricsEnvelope({
      ctx: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
      subset3Probes,
    });
    const text = formatPrometheusText(envelope);
    assert.match(text, /# TYPE tradebot_loop_tick_duration_ms histogram/);
    assert.match(text, /tradebot_loop_tick_duration_ms_bucket\{le="10"\}/);
    assert.match(text, /tradebot_loop_tick_duration_ms_bucket\{le="\+Inf"\}/);
    assert.match(text, /tradebot_loop_tick_duration_ms_sum/);
    assert.match(text, /tradebot_loop_tick_duration_ms_count/);
    assert.match(text, /tradebot_loop_adaptive_weights\{weight_name="volume_24h_bch"\} 0\.5/);
  });
  it('falls back to ctx.metricsSubset3Probes when subset3Probes is absent', async () => {
    const subset3Probes = {
      probeStatus: 'ok',
      error: null,
      tickDuration: { metrics: [] },
      adaptiveWeights: { metrics: [], dropped: 0, keys: [] },
    };
    const envelope = await buildMetricsEnvelope({
      ctx: {
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        metricsSubset3Probes: subset3Probes,
      },
    });
    assert.ok(envelope);
    // Empty arrays mean no subset3 lines, but the orchestrator
    // doesn't crash. Verify the metrics field is still an array.
    assert.ok(Array.isArray(envelope.metrics));
  });
  it('logs a structured warn when subset3 is degraded', async () => {
    const warnings = [];
    const subset3Probes = {
      probeStatus: 'degraded',
      error: 'simulated failure',
      tickDuration: { metrics: [] },
      adaptiveWeights: { metrics: [], dropped: 0, keys: [] },
    };
    await buildMetricsEnvelope({
      ctx: {
        logger: {
          info() {}, error() {}, debug() {},
          warn: (event, payload) => warnings.push({ event, payload }),
        },
      },
      subset3Probes,
    });
    const found = warnings.find((w) => w.event === 'dashboard.metrics.subset3.degraded');
    assert.ok(found, `expected dashboard.metrics.subset3.degraded warn; got: ${JSON.stringify(warnings.map((w) => w.event))}`);
    assert.equal(found.payload.error, 'simulated failure');
  });
});

// ─────────────────────────────────────────────────────────────────────
//  trader/loop.mjs: tick-duration ring buffer + adaptive weights state
// ─────────────────────────────────────────────────────────────────────
describe('trader/loop.mjs: T80 ring buffer + adaptive weights state export', () => {
  function buildMinLoop(overrides = {}) {
    const { TradingLoop } = overrides.TradingLoop
      ?? require('../src/trader/loop.mjs');
    return new TradingLoop({
      cfg: { scoring: { weights: { volume_24h_bch: 0.5 } } },
      fetcher: {},
      wallet: { close: () => Promise.resolve() },
      swap: {},
      positions: { list: () => [] },
      snapshots: {},
      breaker: {},
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      ...overrides.opts,
    });
  }
  it('initialises an empty ring buffer in the constructor', async () => {
    const { TradingLoop } = await import('../src/trader/loop.mjs');
    const loop = new TradingLoop({
      cfg: { scoring: { weights: { volume_24h_bch: 0.5 } } },
      fetcher: {},
      wallet: { close: () => Promise.resolve() },
      swap: {},
      positions: { list: () => [] },
      snapshots: {},
      breaker: {},
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
    const stats = loop.stats();
    assert.ok(Array.isArray(stats.tick_duration_ring));
    assert.equal(stats.tick_duration_ring.length, 0);
    assert.ok(stats.adaptive_weights_state);
    assert.equal(stats.adaptive_weights_state.volume_24h_bch, 0.5);
  });
  it('pushTickDuration extends the ring up to its capacity', async () => {
    const { TradingLoop } = await import('../src/trader/loop.mjs');
    const loop = new TradingLoop({
      cfg: { scoring: { weights: {} } },
      fetcher: {},
      wallet: { close: () => Promise.resolve() },
      swap: {},
      positions: { list: () => [] },
      snapshots: {},
      breaker: {},
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
    for (let i = 0; i < 5; i += 1) loop._pushTickDuration(i * 10);
    const out = loop._exportTickDurationRing();
    assert.deepEqual(out, [0, 10, 20, 30, 40]);
  });
  it('pushTickDuration wraps the ring when capacity is exceeded', async () => {
    const { TradingLoop } = await import('../src/trader/loop.mjs');
    const loop = new TradingLoop({
      cfg: { scoring: { weights: {} } },
      fetcher: {},
      wallet: { close: () => Promise.resolve() },
      swap: {},
      positions: { list: () => [] },
      snapshots: {},
      breaker: {},
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
    // Push 1025 observations; the ring should wrap and only
    // hold the last 1024.
    for (let i = 0; i < 1025; i += 1) loop._pushTickDuration(i);
    const out = loop._exportTickDurationRing();
    assert.equal(out.length, 1024);
    assert.equal(out[0], 1); // first sample is `1` (since 0 was evicted)
    assert.equal(out[1023], 1024); // last sample is the 1024th
  });
  it('pushTickDuration ignores negative and non-finite values', async () => {
    const { TradingLoop } = await import('../src/trader/loop.mjs');
    const loop = new TradingLoop({
      cfg: { scoring: { weights: {} } },
      fetcher: {},
      wallet: { close: () => Promise.resolve() },
      swap: {},
      positions: { list: () => [] },
      snapshots: {},
      breaker: {},
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
    loop._pushTickDuration(-100); // clamped to 0
    loop._pushTickDuration(NaN);  // dropped
    loop._pushTickDuration(Infinity); // dropped
    loop._pushTickDuration('foo'); // dropped
    loop._pushTickDuration(50);
    const out = loop._exportTickDurationRing();
    assert.deepEqual(out, [0, 50]);
  });
  it('exportTickDurationRing returns sorted ascending', async () => {
    const { TradingLoop } = await import('../src/trader/loop.mjs');
    const loop = new TradingLoop({
      cfg: { scoring: { weights: {} } },
      fetcher: {},
      wallet: { close: () => Promise.resolve() },
      swap: {},
      positions: { list: () => [] },
      snapshots: {},
      breaker: {},
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
    [50, 10, 30, 20].forEach((v) => loop._pushTickDuration(v));
    const out = loop._exportTickDurationRing();
    assert.deepEqual(out, [10, 20, 30, 50]);
  });
  it('exportAdaptiveWeightsState returns null when no weights configured', async () => {
    const { TradingLoop } = await import('../src/trader/loop.mjs');
    const loop = new TradingLoop({
      cfg: {},
      fetcher: {},
      wallet: { close: () => Promise.resolve() },
      swap: {},
      positions: { list: () => [] },
      snapshots: {},
      breaker: {},
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
    assert.equal(loop._exportAdaptiveWeightsState(), null);
  });
  it('exportAdaptiveWeightsState clamps values to [0, 1]', async () => {
    const { TradingLoop } = await import('../src/trader/loop.mjs');
    const loop = new TradingLoop({
      cfg: { scoring: { weights: { neg: -1, hi: 5, ok: 0.5, nan: NaN } } },
      fetcher: {},
      wallet: { close: () => Promise.resolve() },
      swap: {},
      positions: { list: () => [] },
      snapshots: {},
      breaker: {},
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
    const out = loop._exportAdaptiveWeightsState();
    assert.equal(out.neg, 0);
    assert.equal(out.hi, 1);
    assert.equal(out.ok, 0.5);
    assert.equal(out.nan, undefined);
  });
  it('stats() exposes tick_duration_ring + adaptive_weights_state', async () => {
    const { TradingLoop } = await import('../src/trader/loop.mjs');
    const loop = new TradingLoop({
      cfg: { scoring: { weights: { volume_24h_bch: 0.3, tvl_bch: 0.2 } } },
      fetcher: {},
      wallet: { close: () => Promise.resolve() },
      swap: {},
      positions: { list: () => [] },
      snapshots: {},
      breaker: {},
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
    loop._pushTickDuration(100);
    loop._pushTickDuration(50);
    const stats = loop.stats();
    assert.deepEqual(stats.tick_duration_ring, [50, 100]);
    assert.deepEqual(stats.adaptive_weights_state, { volume_24h_bch: 0.3, tvl_bch: 0.2 });
  });
});

// ─────────────────────────────────────────────────────────────────────
//  server: /metrics HTTP integration with subset3
// ─────────────────────────────────────────────────────────────────────
describe('server: /metrics HTTP integration with subset3', () => {
  function buildTestServer({ tickDurations, weights } = {}) {
    const cfg = {
      paths: {},
      scoring: {},
      dashboard: { bind_host: '127.0.0.1', bind_port: 0 },
    };
    const positions = { list: () => [] };
    const snapshots = { readBack: () => [] };
    const historyReader = { async read() { return { events: [], errors: [] }; } };
    // Pre-compute subset3 probes so the route doesn't need to
    // touch loop.stats() — simpler than booting a TradingLoop
    // for a HTTP integration test.
    const subset3Probes = gatherSubset3Probes({
      tickDurations: tickDurations || [],
      adaptiveWeights: weights || null,
    });
    return createDashboardServer({
      cfg,
      positions,
      snapshots,
      historyReader,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      metricsSubset3Probes: subset3Probes,
    });
  }
  it('returns 200 with histogram lines in the body', async () => {
    const server = buildTestServer({
      tickDurations: [10, 20, 30, 40, 50],
      weights: { volume_24h_bch: 0.5, tvl_bch: 0.3 },
    });
    await server.start();
    const { port } = server.server.address();
    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /# TYPE tradebot_loop_tick_duration_ms histogram/);
    assert.match(text, /tradebot_loop_tick_duration_ms_bucket\{le="\+Inf"\}/);
    assert.match(text, /tradebot_loop_tick_duration_ms_sum/);
    assert.match(text, /tradebot_loop_tick_duration_ms_count/);
    assert.match(text, /tradebot_loop_adaptive_weights\{weight_name="volume_24h_bch"\} 0\.5/);
    assert.match(text, /tradebot_loop_adaptive_weights\{weight_name="tvl_bch"\} 0\.3/);
    server.server.close();
  });
  it('returns 200 with empty-but-valid histogram when no samples', async () => {
    const server = buildTestServer({ tickDurations: [], weights: null });
    await server.start();
    const { port } = server.server.address();
    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /tradebot_loop_tick_duration_ms/);
    assert.match(text, /tradebot_loop_adaptive_weights\{weight_name="_unconfigured"\} 0/);
    server.server.close();
  });
  it('does NOT break when loop.stats() throws (degraded subset3 probe)', async () => {
    const cfg = {
      paths: {},
      scoring: {},
      dashboard: { bind_host: '127.0.0.1', bind_port: 0 },
    };
    const positions = { list: () => [] };
    const snapshots = { readBack: () => [] };
    const historyReader = { async read() { return { events: [], errors: [] }; } };
    const server = createDashboardServer({
      cfg,
      positions,
      snapshots,
      historyReader,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      loop: {
        stats: () => {
          throw new Error('simulated loop failure');
        },
      },
    });
    await server.start();
    const { port } = server.server.address();
    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    assert.equal(res.status, 200);
    const text = await res.text();
    // Empty-but-valid envelope: histogram block still emits,
    // adaptive-weights emit _unconfigured.
    assert.match(text, /tradebot_loop_tick_duration_ms_bucket/);
    assert.match(text, /tradebot_loop_adaptive_weights\{weight_name="_unconfigured"\}/);
    server.server.close();
  });
  it('falls back gracefully when subset3Probes absent + loop missing', async () => {
    const cfg = {
      paths: {},
      scoring: {},
      dashboard: { bind_host: '127.0.0.1', bind_port: 0 },
    };
    const positions = { list: () => [] };
    const snapshots = { readBack: () => [] };
    const historyReader = { async read() { return { events: [], errors: [] }; } };
    const server = createDashboardServer({
      cfg,
      positions,
      snapshots,
      historyReader,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
    await server.start();
    const { port } = server.server.address();
    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    assert.equal(res.status, 200);
    const text = await res.text();
    // Empty-but-valid envelope: unconfigured histogram emits a
    // single _bucket{le="+Inf"} 0 + _sum 0 + _count 0.
    assert.match(text, /tradebot_loop_tick_duration_ms_bucket\{le="\+Inf"\} 0/);
    assert.match(text, /tradebot_loop_adaptive_weights\{weight_name="_unconfigured"\}/);
    server.server.close();
  });
});
