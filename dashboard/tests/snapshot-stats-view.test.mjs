#!/usr/bin/env node
/**
 * dashboard/tests/snapshot-stats-view.test.mjs
 *
 * T65 — unit tests for the pure formatting helpers in
 * `dashboard/src/views/snapshot-stats-helpers.mjs`.
 *
 * These tests cover:
 *   1. formatBch — null / undefined / NaN / number / string / 0
 *   2. satsToBchNumber — bigint / string / number / null / unparseable
 *   3. satsToBch — null / string / bigint / NaN
 *   4. drawdownSeverity — positive / negative / zero / null
 *   5. drawdownClass — all severity values
 *   6. formatDrawdownBch — positive / negative / zero / null
 *   7. buildStatsBarLines — full agg / null / empty / single /
 *      error envelope / missing fields
 *   8. buildSparklinePoints — full agg / null / empty / missing fields
 *   9. cacheSourceLabel — cache / fresh / null / unknown source
 *  10. isAggregateUnavailable — ok envelope / error envelope / null
 *  11. aggregateErrorMessage — error + message / error only / null
 *  12. bucketCountLabel — 0 / 1 / many / null / NaN
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatBch,
  satsToBchNumber,
  satsToBch,
  drawdownSeverity,
  drawdownClass,
  formatDrawdownBch,
  buildStatsBarLines,
  buildSparklinePoints,
  cacheSourceLabel,
  isAggregateUnavailable,
  aggregateErrorMessage,
  bucketCountLabel,
} from '../src/views/snapshot-stats-helpers.mjs';

// ─── formatBch ──────────────────────────────────────────────────────

test('snapshot-stats-helpers: formatBch with null/undefined/NaN returns em dash', () => {
  assert.equal(formatBch(null), '—');
  assert.equal(formatBch(undefined), '—');
  assert.equal(formatBch(NaN), '—');
  assert.equal(formatBch(''), '—');
});

test('snapshot-stats-helpers: formatBch with number returns fixed decimal', () => {
  assert.equal(formatBch(1.23456789, 6), '1.234568');
  assert.equal(formatBch(0, 6), '0.000000');
  assert.equal(formatBch(-0.5, 4), '-0.5000');
  assert.equal(formatBch(0.000001, 6), '0.000001');
});

test('snapshot-stats-helpers: formatBch with string parses and formats', () => {
  assert.equal(formatBch('1.234567', 6), '1.234567');
  assert.equal(formatBch('  2.5  ', 4), '2.5000');
  assert.equal(formatBch('not-a-number', 4), '—');
});

test('snapshot-stats-helpers: formatBch defaults to 6 decimals', () => {
  assert.equal(formatBch(1.123456789), '1.123457');
});

// ─── satsToBchNumber ────────────────────────────────────────────────

test('snapshot-stats-helpers: satsToBchNumber with bigint', () => {
  assert.equal(satsToBchNumber(100000000n), 1.0);
  assert.equal(satsToBchNumber(1n), 0.00000001);
});

test('snapshot-stats-helpers: satsToBchNumber with number', () => {
  assert.equal(satsToBchNumber(100000000), 1.0);
  assert.equal(satsToBchNumber(0), 0.0);
});

test('snapshot-stats-helpers: satsToBchNumber with string', () => {
  assert.equal(satsToBchNumber('100000000'), 1.0);
  assert.equal(satsToBchNumber('  50000000  '), 0.5);
  assert.equal(satsToBchNumber(''), null);
  assert.equal(satsToBchNumber('garbage'), null);
});

test('snapshot-stats-helpers: satsToBchNumber with null/undefined/NaN returns null', () => {
  assert.equal(satsToBchNumber(null), null);
  assert.equal(satsToBchNumber(undefined), null);
  assert.equal(satsToBchNumber(NaN), null);
});

// ─── satsToBch ──────────────────────────────────────────────────────

test('snapshot-stats-helpers: satsToBch with valid sat string', () => {
  assert.equal(satsToBch('100000000'), '1.000000');
  assert.equal(satsToBch('50000000'), '0.500000');
});

test('snapshot-stats-helpers: satsToBch with null/undefined/unparseable returns em dash', () => {
  assert.equal(satsToBch(null), '—');
  assert.equal(satsToBch(undefined), '—');
  assert.equal(satsToBch('garbage'), '—');
  assert.equal(satsToBch(NaN), '—');
});

test('snapshot-stats-helpers: satsToBch respects decimals param', () => {
  assert.equal(satsToBch('100000000', 4), '1.0000');
  assert.equal(satsToBch('123456', 2), '0.00');
});

// ─── drawdownSeverity ────────────────────────────────────────────────

test('snapshot-stats-helpers: drawdownSeverity positive (balance grew)', () => {
  assert.equal(drawdownSeverity('100000'), 'positive');  // bigint string
  assert.equal(drawdownSeverity(100000), 'positive');    // number
  assert.equal(drawdownSeverity(0.001), 'positive');     // BCH number
});

test('snapshot-stats-helpers: drawdownSeverity negative (balance shrank)', () => {
  assert.equal(drawdownSeverity('-50000'), 'negative');
  assert.equal(drawdownSeverity(-50000), 'negative');
  assert.equal(drawdownSeverity(-0.001), 'negative');
});

test('snapshot-stats-helpers: drawdownSeverity zero', () => {
  assert.equal(drawdownSeverity('0'), 'neutral');
  assert.equal(drawdownSeverity(0), 'neutral');
});

test('snapshot-stats-helpers: drawdownSeverity null/undefined/NaN returns unknown', () => {
  assert.equal(drawdownSeverity(null), 'unknown');
  assert.equal(drawdownSeverity(undefined), 'unknown');
  assert.equal(drawdownSeverity(NaN), 'unknown');
  assert.equal(drawdownSeverity(''), 'unknown');
});

// ─── drawdownClass ──────────────────────────────────────────────────

test('snapshot-stats-helpers: drawdownClass returns correct Tailwind classes', () => {
  assert.equal(drawdownClass('positive'), 'text-emerald-400');
  assert.equal(drawdownClass('negative'), 'text-red-400');
  assert.equal(drawdownClass('neutral'), 'text-ash-400');
  assert.equal(drawdownClass('unknown'), 'text-ash-500');
});

// ─── formatDrawdownBch ──────────────────────────────────────────────

test('snapshot-stats-helpers: formatDrawdownBch positive shows signed + BCH', () => {
  assert.equal(formatDrawdownBch('100000'), '+0.001000 BCH');
  assert.equal(formatDrawdownBch(50000000), '+0.500000 BCH');
});

test('snapshot-stats-helpers: formatDrawdownBch negative shows signed BCH', () => {
  assert.equal(formatDrawdownBch('-50000'), '-0.000500 BCH');
  assert.equal(formatDrawdownBch('-100000'), '-0.001000 BCH');
});

test('snapshot-stats-helpers: formatDrawdownBch zero shows +0.000000', () => {
  assert.equal(formatDrawdownBch('0'), '+0.000000 BCH');
});

test('snapshot-stats-helpers: formatDrawdownBch null/undefined returns em dash', () => {
  assert.equal(formatDrawdownBch(null), '—');
  assert.equal(formatDrawdownBch(undefined), '—');
});

// ─── buildStatsBarLines ─────────────────────────────────────────────

function makeAgg(overrides = {}) {
  return {
    schema: 'tradebot.dashboard.snapshots-aggregate/v1',
    ts: new Date().toISOString(),
    source: 'fresh',
    cache_age_ms: 0,
    range_ms: 86400000,
    range_label: '24h',
    token_id: null,
    bucket_count: 100,
    bucket_skipped: 0,
    balance_sats: { min: '100000000', max: '200000000', mean: '150000000', latest: '180000000', count: 100, skipped: 0, min_bch: 1.0, max_bch: 2.0, mean_bch: 1.5, latest_bch: 1.8 },
    total_exposure_sats: { min: '0', max: '40000000', mean: '20000000', latest: '30000000', count: 100, skipped: 0, min_bch: 0.0, max_bch: 0.4, mean_bch: 0.2, latest_bch: 0.3 },
    unrealized_pnl_sats: { min: '-5000', max: '10000', mean: '2500', latest: '3000', count: 100, skipped: 0, min_bch: -0.00005, max_bch: 0.0001, mean_bch: 0.000025, latest_bch: 0.00003 },
    open_position_count: { min: 0, max: 5, mean: 2.5, latest: 3, count: 100, skipped: 0 },
    drawdown_sats: '-1000000', // -0.01 BCH
    drawdown_bch: -0.01,
    first_ts: '2026-09-18T12:00:00.000Z',
    last_ts: '2026-09-19T12:00:00.000Z',
    ...overrides,
  };
}

test('snapshot-stats-helpers: buildStatsBarLines full agg returns 6 lines', () => {
  const agg = makeAgg();
  const lines = buildStatsBarLines(agg);
  assert.equal(lines.length, 6);
  assert.equal(lines[0].label, 'balance min');
  assert.equal(lines[0].value, '1.000000');
  assert.equal(lines[3].label, 'balance latest');
  assert.equal(lines[3].highlight, true);
  assert.equal(lines[3].value, '1.800000');
  assert.equal(lines[4].label, 'drawdown');
  assert.equal(lines[4].value, '-0.010000 BCH');
  assert.equal(lines[4].severity, 'negative');
  assert.equal(lines[5].label, 'open positions');
  assert.equal(lines[5].value, '3');
});

test('snapshot-stats-helpers: buildStatsBarLines null agg returns all em dashes', () => {
  const lines = buildStatsBarLines(null);
  assert.equal(lines.length, 6);
  for (const line of lines) {
    assert.equal(line.value, '—', `${line.label} should be em dash`);
  }
});

test('snapshot-stats-helpers: buildStatsBarLines empty object returns em dashes', () => {
  const lines = buildStatsBarLines({});
  assert.equal(lines.length, 6);
  for (const line of lines) {
    assert.equal(line.value, '—', `${line.label} should be em dash`);
  }
});

test('snapshot-stats-helpers: buildStatsBarLines positive drawdown is green', () => {
  const agg = makeAgg({ drawdown_sats: '5000000', drawdown_bch: 0.05 });
  const lines = buildStatsBarLines(agg);
  const dd = lines.find((l) => l.label === 'drawdown');
  assert.equal(dd.severity, 'positive');
  assert.equal(dd.value, '+0.050000 BCH');
  assert.equal(dd.valueClass, 'text-emerald-400');
});

test('snapshot-stats-helpers: buildStatsBarLines neutral drawdown', () => {
  const agg = makeAgg({ drawdown_sats: '0', drawdown_bch: 0 });
  const lines = buildStatsBarLines(agg);
  const dd = lines.find((l) => l.label === 'drawdown');
  assert.equal(dd.severity, 'neutral');
  assert.equal(dd.value, '+0.000000 BCH');
  assert.equal(dd.valueClass, 'text-ash-400');
});

test('snapshot-stats-helpers: buildStatsBarLines respects decimals param', () => {
  const agg = makeAgg();
  const lines = buildStatsBarLines(agg, { decimals: 4 });
  const min = lines.find((l) => l.label === 'balance min');
  assert.equal(min.value, '1.0000');
});

test('snapshot-stats-helpers: buildStatsBarLines missing balance_sats gracefully', () => {
  // When balance_sats is null, the balance lines should all be em dash.
  // But drawdown_sats is still present in the agg, so the drawdown
  // line renders the real value (not em dash).
  const agg = makeAgg({ balance_sats: null, drawdown_sats: '-1000000', drawdown_bch: -0.01 });
  const lines = buildStatsBarLines(agg);
  // Balance lines are all em dashes
  const balanceLines = lines.filter((l) => l.label.startsWith('balance'));
  for (const line of balanceLines) {
    assert.equal(line.value, '—', `${line.label} should be em dash when balance_sats is null`);
  }
  // Drawdown still renders (it's independent of balance_sats)
  const dd = lines.find((l) => l.label === 'drawdown');
  assert.equal(dd.value, '-0.010000 BCH');
  assert.equal(dd.severity, 'negative');
  // Open positions still renders
  const pos = lines.find((l) => l.label === 'open positions');
  assert.equal(pos.value, '3');
});

test('snapshot-stats-helpers: buildStatsBarLines with error envelope', () => {
  const agg = { error: 'aggregator_unconfigured', message: 'SnapshotAggregator is not wired' };
  const lines = buildStatsBarLines(agg);
  assert.equal(lines.length, 6);
  for (const line of lines) {
    assert.equal(line.value, '—', `${line.label} should be em dash`);
  }
});

// ─── buildSparklinePoints ────────────────────────────────────────────

test('snapshot-stats-helpers: buildSparklinePoints with full agg returns one point', () => {
  const agg = makeAgg();
  const points = buildSparklinePoints(agg);
  assert.equal(points.length, 1);
  assert.equal(points[0].value, 1.8); // latest_bch
  assert.ok(Number.isFinite(points[0].ts));
});

test('snapshot-stats-helpers: buildSparklinePoints null returns empty array', () => {
  assert.deepEqual(buildSparklinePoints(null), []);
  assert.deepEqual(buildSparklinePoints(undefined), []);
});

test('snapshot-stats-helpers: buildSparklinePoints missing balance_sats returns empty', () => {
  assert.deepEqual(buildSparklinePoints({}), []);
  assert.deepEqual(buildSparklinePoints({ balance_sats: null }), []);
});

test('snapshot-stats-helpers: buildSparklinePoints null latest_bch returns empty', () => {
  const agg = makeAgg({ balance_sats: { latest_bch: null, min_bch: 1.0 } });
  assert.deepEqual(buildSparklinePoints(agg), []);
});

test('snapshot-stats-helpers: buildSparklinePoints null last_ts returns empty', () => {
  const agg = makeAgg({ last_ts: null });
  assert.deepEqual(buildSparklinePoints(agg), []);
});

// ─── cacheSourceLabel ────────────────────────────────────────────────

test('snapshot-stats-helpers: cacheSourceLabel cache shows seconds', () => {
  assert.equal(cacheSourceLabel({ source: 'cache', cache_age_ms: 5000 }), 'cached 5s ago');
  assert.equal(cacheSourceLabel({ source: 'cache', cache_age_ms: 65000 }), 'cached 1m ago');
  assert.equal(cacheSourceLabel({ source: 'cache', cache_age_ms: 0 }), 'cached 0s ago');
});

test('snapshot-stats-helpers: cacheSourceLabel fresh returns fresh', () => {
  assert.equal(cacheSourceLabel({ source: 'fresh' }), 'fresh');
});

test('snapshot-stats-helpers: cacheSourceLabel null/undefined returns em dash', () => {
  assert.equal(cacheSourceLabel(null), '—');
  assert.equal(cacheSourceLabel({}), '—');
  assert.equal(cacheSourceLabel({ source: 'unknown' }), '—');
});

// ─── isAggregateUnavailable ──────────────────────────────────────────

test('snapshot-stats-helpers: isAggregateUnavailable true on error string', () => {
  assert.equal(isAggregateUnavailable({ error: 'aggregator_unconfigured' }), true);
  assert.equal(isAggregateUnavailable({ error: 'aggregate_failed' }), true);
});

test('snapshot-stats-helpers: isAggregateUnavailable false on ok envelope', () => {
  assert.equal(isAggregateUnavailable({ bucket_count: 100, balance_sats: {} }), false);
});

test('snapshot-stats-helpers: isAggregateUnavailable true on null/undefined', () => {
  assert.equal(isAggregateUnavailable(null), true);
  assert.equal(isAggregateUnavailable(undefined), true);
});

// ─── aggregateErrorMessage ───────────────────────────────────────────

test('snapshot-stats-helpers: aggregateErrorMessage prefers message over error', () => {
  assert.equal(
    aggregateErrorMessage({ error: 'aggregate_failed', message: 'SnapshotAggregator is not wired' }),
    'SnapshotAggregator is not wired',
  );
});

test('snapshot-stats-helpers: aggregateErrorMessage falls back to error', () => {
  assert.equal(aggregateErrorMessage({ error: 'aggregator_unconfigured' }), 'aggregator_unconfigured');
});

test('snapshot-stats-helpers: aggregateErrorMessage defaults for null/empty', () => {
  assert.equal(aggregateErrorMessage(null), 'stats unavailable');
  assert.equal(aggregateErrorMessage({}), 'stats unavailable');
});

// ─── bucketCountLabel ────────────────────────────────────────────────

test('snapshot-stats-helpers: bucketCountLabel 0 snapshots', () => {
  assert.equal(bucketCountLabel({ bucket_count: 0 }), '0 snapshots');
});

test('snapshot-stats-helpers: bucketCountLabel 1 snapshot (singular)', () => {
  assert.equal(bucketCountLabel({ bucket_count: 1 }), '1 snapshot');
});

test('snapshot-stats-helpers: bucketCountLabel many snapshots', () => {
  assert.equal(bucketCountLabel({ bucket_count: 100 }), '100 snapshots');
});

test('snapshot-stats-helpers: bucketCountLabel null/NaN/non-number returns 0 snapshots', () => {
  assert.equal(bucketCountLabel({ bucket_count: null }), '0 snapshots');
  assert.equal(bucketCountLabel({ bucket_count: NaN }), '0 snapshots');
  assert.equal(bucketCountLabel({}), '0 snapshots');
});
