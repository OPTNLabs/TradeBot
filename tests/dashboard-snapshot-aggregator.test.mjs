#!/usr/bin/env node
/**
 * tests/dashboard-snapshot-aggregator.test.mjs
 *
 * T64 — unit + HTTP integration tests for the snapshot
 * aggregator (`src/dashboard/snapshot-aggregator.mjs` +
 * `GET /api/snapshots/aggregate`).
 *
 * Covers:
 *   1. Constants + errors — schema pinned, defaults sane,
 *      SnapshotAggregatorError / SnapshotAggregatorConfigError
 *      statusCode contract.
 *   2. `safeBigIntFromString` — bigint / number / string / null /
 *      whitespace / non-numeric / Number-with-decimals / very-large
 *      integers / negative numbers.
 *   3. `parseSnapshotTs` — ISO parse, missing / unparseable.
 *   4. `normalizeTokenFilter` — case-fold, whitespace, null.
 *   5. `satsToBchNumber` — null / bigint / Number-coerced /
 *      zero / negative.
 *   6. `satsStats` — empty / single / multiple / all-null /
 *      mixed / drawdown.
 *   7. `buildSatsField` — nulls / stringified bigints / bch sidecar.
 *   8. `buildIntField` — nulls / numbers / NaN / Infinity.
 *   9. `aggregateSnapshots` — empty / single / mixed / sinceMs
 *      windowing / token filter / unparseable ts / NaN sats /
 *      drawdown delta / first/last record / skipped counter.
 *  10. `formatRangeLabel` — null / sinceMs only / nowMs+sinceMs.
 *  11. `buildAggregateResponse` — envelope shape, source/cacheAge.
 *  12. `SnapshotAggregator` class — cold cache / hot cache / mtime
 *      invalidation / TTL expiry / cacheMs<=0 / explicit invalidate.
 *  13. `clampSnapshotAggregateCacheMs` — clamps to safe range.
 *  14. HTTP integration via supertest — `/api/snapshots/aggregate`
 *      returns the envelope with cache metadata; repeat calls hit
 *      the cache; missing dir returns empty envelope; bad range
 *      returns 400; bad tokenId is ignored.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';

import {
  SNAPSHOTS_AGGREGATE_SCHEMA,
  DEFAULT_SNAPSHOT_AGGREGATE_CACHE_MS,
  MIN_SNAPSHOT_AGGREGATE_CACHE_MS,
  MAX_SNAPSHOT_AGGREGATE_CACHE_MS,
  SnapshotAggregatorError,
  SnapshotAggregatorConfigError,
  safeBigIntFromString,
  parseSnapshotTs,
  normalizeTokenFilter,
  satsToBchNumber,
  satsStats,
  drawdownSats,
  buildSatsField,
  buildIntField,
  aggregateSnapshots,
  formatRangeLabel,
  buildAggregateResponse,
  SnapshotAggregator,
  clampSnapshotAggregateCacheMs,
  defaultSnapshotAggregatorConfig,
} from '../src/dashboard/snapshot-aggregator.mjs';
import { createDashboardServer } from '../src/dashboard/server.mjs';
import { createLogger, createMemorySink } from '../src/util/logger.mjs';
import { Positions } from '../src/portfolio/positions.mjs';
import { Snapshots } from '../src/portfolio/snapshots.mjs';

// ─── Constants ───────────────────────────────────────────────────────

test('snapshot-aggregator: schema constant is pinned for downstream consumers', () => {
  assert.equal(SNAPSHOTS_AGGREGATE_SCHEMA, 'tradebot.dashboard.snapshots-aggregate/v1');
});

test('snapshot-aggregator: cache TTL defaults are sane', () => {
  assert.equal(DEFAULT_SNAPSHOT_AGGREGATE_CACHE_MS, 30_000);
  assert.equal(MIN_SNAPSHOT_AGGREGATE_CACHE_MS, 100);
  assert.equal(MAX_SNAPSHOT_AGGREGATE_CACHE_MS, 300_000);
});

test('snapshot-aggregator: error classes carry the right statusCode', () => {
  const c = new SnapshotAggregatorConfigError('bad input');
  assert.equal(c.name, 'SnapshotAggregatorConfigError');
  assert.equal(c.statusCode, 400);
  assert.ok(c instanceof SnapshotAggregatorError);
  assert.ok(c instanceof Error);

  const e = new SnapshotAggregatorError('compute failed');
  assert.equal(e.name, 'SnapshotAggregatorError');
  assert.ok(e instanceof Error);
});

test('snapshot-aggregator: default config exposes cache_ms', () => {
  const cfg = defaultSnapshotAggregatorConfig();
  assert.equal(cfg.cache_ms, DEFAULT_SNAPSHOT_AGGREGATE_CACHE_MS);
  assert.ok(Object.isFrozen(cfg));
});

// ─── safeBigIntFromString ─────────────────────────────────────────────

test('snapshot-aggregator: safeBigIntFromString accepts bigint / number / string / negative', () => {
  assert.equal(safeBigIntFromString(123n), 123n);
  assert.equal(safeBigIntFromString(456), 456n);
  assert.equal(safeBigIntFromString('789'), 789n);
  assert.equal(safeBigIntFromString('-1000'), -1000n);
  assert.equal(safeBigIntFromString('  42  '), 42n);
});

test('snapshot-aggregator: safeBigIntFromString returns null for bad input', () => {
  assert.equal(safeBigIntFromString(null), null);
  assert.equal(safeBigIntFromString(undefined), null);
  assert.equal(safeBigIntFromString(''), null);
  assert.equal(safeBigIntFromString('   '), null);
  assert.equal(safeBigIntFromString('abc'), null);
  assert.equal(safeBigIntFromString('1.5'), null);
  assert.equal(safeBigIntFromString(NaN), null);
  assert.equal(safeBigIntFromString(Infinity), null);
  assert.equal(safeBigIntFromString({}), null);
  assert.equal(safeBigIntFromString([]), null);
});

// ─── parseSnapshotTs ──────────────────────────────────────────────────

test('snapshot-aggregator: parseSnapshotTs handles ISO strings', () => {
  const ms = parseSnapshotTs('2026-09-19T12:34:56.789Z');
  assert.ok(Number.isFinite(ms));
  // Re-parse to avoid TZ drift in the assertion
  assert.equal(new Date(ms).toISOString(), '2026-09-19T12:34:56.789Z');
});

test('snapshot-aggregator: parseSnapshotTs returns null for bad input', () => {
  assert.equal(parseSnapshotTs(null), null);
  assert.equal(parseSnapshotTs(undefined), null);
  assert.equal(parseSnapshotTs(''), null);
  assert.equal(parseSnapshotTs('   '), null);
  assert.equal(parseSnapshotTs('not-a-date'), null);
  assert.equal(parseSnapshotTs(123), null);
  assert.equal(parseSnapshotTs({}), null);
});

// ─── normalizeTokenFilter ─────────────────────────────────────────────

test('snapshot-aggregator: normalizeTokenFilter case-folds 64-hex tokens', () => {
  assert.equal(normalizeTokenFilter('ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890'),
    'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890');
  assert.equal(normalizeTokenFilter('  abc  '), 'abc');
});

test('snapshot-aggregator: normalizeTokenFilter returns null for empty / non-string', () => {
  assert.equal(normalizeTokenFilter(null), null);
  assert.equal(normalizeTokenFilter(undefined), null);
  assert.equal(normalizeTokenFilter(''), null);
  assert.equal(normalizeTokenFilter('   '), null);
  assert.equal(normalizeTokenFilter(123), null);
  assert.equal(normalizeTokenFilter({}), null);
});

// ─── satsToBchNumber ──────────────────────────────────────────────────

test('snapshot-aggregator: satsToBchNumber converts sats → BCH', () => {
  assert.equal(satsToBchNumber(100_000_000n), 1.0);
  assert.equal(satsToBchNumber(50_000_000n), 0.5);
  assert.equal(satsToBchNumber(1n), 1e-8);
});

test('snapshot-aggregator: satsToBchNumber returns null for null inputs', () => {
  assert.equal(satsToBchNumber(null), null);
  assert.equal(satsToBchNumber(undefined), null);
});

// ─── satsStats ────────────────────────────────────────────────────────

test('snapshot-aggregator: satsStats handles empty list', () => {
  const s = satsStats([]);
  assert.equal(s.min, null);
  assert.equal(s.max, null);
  assert.equal(s.mean, null);
  assert.equal(s.latest, null);
  assert.equal(s.count, 0);
});

test('snapshot-aggregator: satsStats handles single value', () => {
  const s = satsStats([1000n]);
  assert.equal(s.min, 1000n);
  assert.equal(s.max, 1000n);
  assert.equal(s.mean, 1000n);
  assert.equal(s.latest, 1000n);
  assert.equal(s.count, 1);
});

test('snapshot-aggregator: satsStats handles mixed values + nulls', () => {
  const s = satsStats([100n, 200n, null, 50n, 'bad']);
  assert.equal(s.min, 50n);
  assert.equal(s.max, 200n);
  assert.equal(s.mean, ((100n + 200n + 50n) / 3n));
  assert.equal(s.latest, null); // last entry was 'bad' → null
  assert.equal(s.count, 3);
  assert.equal(s.skipped, 2);
});

test('snapshot-aggregator: satsStats handles all-null list', () => {
  const s = satsStats([null, null, 'bad']);
  assert.equal(s.min, null);
  assert.equal(s.max, null);
  assert.equal(s.mean, null);
  assert.equal(s.count, 0);
  assert.equal(s.skipped, 3);
});

test('snapshot-aggregator: satsStats coerces string sats', () => {
  const s = satsStats(['100', '200', '50']);
  assert.equal(s.min, 50n);
  assert.equal(s.max, 200n);
  assert.equal(s.count, 3);
});

// ─── drawdownSats ─────────────────────────────────────────────────────

test('snapshot-aggregator: drawdownSats computes first - last', () => {
  assert.equal(drawdownSats([1000n, 1100n, 900n, 800n]), 1000n - 800n);
  assert.equal(drawdownSats([500n, 500n, 500n]), 0n);
});

test('snapshot-aggregator: drawdownSats returns null for empty / all-null', () => {
  assert.equal(drawdownSats([]), null);
  assert.equal(drawdownSats([null, 'bad']), null);
  assert.equal(drawdownSats(null), null);
});

// ─── buildSatsField ───────────────────────────────────────────────────

test('snapshot-aggregator: buildSatsField returns all-nulls envelope for empty', () => {
  const f = buildSatsField([]);
  assert.equal(f.min, null);
  assert.equal(f.max, null);
  assert.equal(f.mean, null);
  assert.equal(f.latest, null);
  assert.equal(f.count, 0);
  assert.equal(f.min_bch, null);
  assert.equal(f.max_bch, null);
});

test('snapshot-aggregator: buildSatsField stringifies bigints + adds bch sidecar', () => {
  const f = buildSatsField(['100000', '200000', '300000']);
  assert.equal(f.min, '100000');
  assert.equal(f.max, '300000');
  assert.equal(f.mean, '200000');
  assert.equal(f.latest, '300000');
  assert.equal(f.count, 3);
  assert.equal(typeof f.min_bch, 'number');
  assert.equal(f.min_bch, 0.001);
  assert.equal(f.max_bch, 0.003);
});

// ─── buildIntField ────────────────────────────────────────────────────

test('snapshot-aggregator: buildIntField handles integer values', () => {
  const f = buildIntField([1, 5, 3, 8, 2]);
  assert.equal(f.min, 1);
  assert.equal(f.max, 8);
  assert.equal(f.mean, (1 + 5 + 3 + 8 + 2) / 5);
  assert.equal(f.latest, 2);
  assert.equal(f.count, 5);
});

test('snapshot-aggregator: buildIntField skips NaN / Infinity / null', () => {
  const f = buildIntField([1, null, NaN, Infinity, 5]);
  assert.equal(f.min, 1);
  assert.equal(f.max, 5);
  assert.equal(f.count, 2);
  assert.equal(f.skipped, 3);
});

test('snapshot-aggregator: buildIntField handles empty / non-array', () => {
  const e = buildIntField([]);
  assert.equal(e.count, 0);
  assert.equal(e.min, null);
  const n = buildIntField(null);
  assert.equal(n.count, 0);
});

// ─── aggregateSnapshots ───────────────────────────────────────────────

test('snapshot-aggregator: aggregateSnapshots throws on non-array', () => {
  assert.throws(() => aggregateSnapshots(null), SnapshotAggregatorConfigError);
  assert.throws(() => aggregateSnapshots('not-array'), SnapshotAggregatorConfigError);
  assert.throws(() => aggregateSnapshots(undefined), SnapshotAggregatorConfigError);
});

test('snapshot-aggregator: aggregateSnapshots returns empty envelope on empty list', () => {
  const r = aggregateSnapshots([], { nowMs: 1_700_000_000_000 });
  assert.equal(r.schema, SNAPSHOTS_AGGREGATE_SCHEMA);
  assert.equal(r.bucket_count, 0);
  assert.equal(r.bucket_skipped, 0);
  assert.equal(r.first_record, null);
  assert.equal(r.last_record, null);
  assert.equal(r.first_ts, null);
  assert.equal(r.last_ts, null);
  assert.equal(r.drawdown_sats, null);
  assert.equal(r.drawdown_bch, null);
  assert.equal(r.balance_sats.min, null);
  assert.equal(r.balance_sats.count, 0);
  assert.equal(r.open_position_count.min, null);
});

test('snapshot-aggregator: aggregateSnapshots rolls up a single record', () => {
  const records = [{
    v: 1, ts: '2026-09-19T12:00:00.000Z',
    bch_balance_sats: '100000', total_exposure_sats: '20000',
    unrealized_pnl_sats: '5000', open_position_count: 3,
  }];
  const r = aggregateSnapshots(records, { nowMs: Date.parse('2026-09-19T12:00:00.000Z') });
  assert.equal(r.bucket_count, 1);
  assert.equal(r.first_ts, '2026-09-19T12:00:00.000Z');
  assert.equal(r.last_ts, '2026-09-19T12:00:00.000Z');
  assert.equal(r.balance_sats.min, '100000');
  assert.equal(r.balance_sats.max, '100000');
  assert.equal(r.balance_sats.latest, '100000');
  assert.equal(r.open_position_count.latest, 3);
  assert.equal(r.open_position_count.mean, 3);
  assert.equal(r.drawdown_sats, '0');
  assert.equal(r.drawdown_bch, 0);
});

test('snapshot-aggregator: aggregateSnapshots rolls up multiple records', () => {
  const records = [
    { v: 1, ts: '2026-09-19T10:00:00.000Z', bch_balance_sats: '100000', total_exposure_sats: '50000', unrealized_pnl_sats: '1000', open_position_count: 5 },
    { v: 1, ts: '2026-09-19T11:00:00.000Z', bch_balance_sats: '200000', total_exposure_sats: '40000', unrealized_pnl_sats: '-2000', open_position_count: 3 },
    { v: 1, ts: '2026-09-19T12:00:00.000Z', bch_balance_sats: '150000', total_exposure_sats: '60000', unrealized_pnl_sats: '3000', open_position_count: 4 },
  ];
  const r = aggregateSnapshots(records, { nowMs: Date.parse('2026-09-19T13:00:00.000Z') });
  assert.equal(r.bucket_count, 3);
  assert.equal(r.balance_sats.min, '100000');
  assert.equal(r.balance_sats.max, '200000');
  assert.equal(r.balance_sats.mean, '150000');
  assert.equal(r.balance_sats.latest, '150000');
  // drawdown = first - last = 100000 - 150000 = -50000 (balance GREW → negative drawdown).
  assert.equal(r.drawdown_sats, '-50000');
  assert.equal(r.unrealized_pnl_sats.min, '-2000');
  assert.equal(r.unrealized_pnl_sats.max, '3000');
  assert.equal(r.open_position_count.min, 3);
  assert.equal(r.open_position_count.max, 5);
});

test('snapshot-aggregator: aggregateSnapshots sorts out-of-order records by ts', () => {
  const records = [
    { v: 1, ts: '2026-09-19T12:00:00.000Z', bch_balance_sats: '150000' },
    { v: 1, ts: '2026-09-19T10:00:00.000Z', bch_balance_sats: '100000' },
    { v: 1, ts: '2026-09-19T11:00:00.000Z', bch_balance_sats: '200000' },
  ];
  const r = aggregateSnapshots(records, { nowMs: Date.parse('2026-09-19T13:00:00.000Z') });
  assert.equal(r.first_ts, '2026-09-19T10:00:00.000Z');
  assert.equal(r.last_ts, '2026-09-19T12:00:00.000Z');
  assert.equal(r.balance_sats.min, '100000');
  assert.equal(r.balance_sats.max, '200000');
});

test('snapshot-aggregator: aggregateSnapshots applies sinceMs window', () => {
  const records = [
    { v: 1, ts: '2026-09-18T10:00:00.000Z', bch_balance_sats: '100000' },
    { v: 1, ts: '2026-09-19T10:00:00.000Z', bch_balance_sats: '200000' },
    { v: 1, ts: '2026-09-19T12:00:00.000Z', bch_balance_sats: '300000' },
  ];
  const nowMs = Date.parse('2026-09-19T13:00:00.000Z');
  const sinceMs = Date.parse('2026-09-19T00:00:00.000Z'); // 13h window
  const r = aggregateSnapshots(records, { nowMs, sinceMs });
  assert.equal(r.bucket_count, 2);
  assert.equal(r.bucket_skipped, 1); // the 2026-09-18 record
  assert.equal(r.first_ts, '2026-09-19T10:00:00.000Z');
  assert.equal(r.last_ts, '2026-09-19T12:00:00.000Z');
  // drawdown = first - last = 200000 - 300000 = -100000 (balance GREW).
  assert.equal(r.drawdown_sats, '-100000');
});

test('snapshot-aggregator: aggregateSnapshots applies tokenId filter (case-fold)', () => {
  const records = [
    { v: 1, ts: '2026-09-19T10:00:00.000Z', token_id: 'aaaaaaaa', bch_balance_sats: '100000' },
    { v: 1, ts: '2026-09-19T11:00:00.000Z', token_id: 'bbbbbbbb', bch_balance_sats: '200000' },
    { v: 1, ts: '2026-09-19T12:00:00.000Z', token_id: 'AAAAAAAA', bch_balance_sats: '300000' }, // same as aaaaaaaa, uppercase
  ];
  const r = aggregateSnapshots(records, {
    nowMs: Date.parse('2026-09-19T13:00:00.000Z'),
    tokenId: 'AAAAAAAA',
  });
  assert.equal(r.bucket_count, 2);
  assert.equal(r.bucket_skipped, 1);
  assert.equal(r.token_id, 'aaaaaaaa');
});

test('snapshot-aggregator: aggregateSnapshots skips records with unparseable ts', () => {
  const records = [
    { v: 1, ts: 'not-a-date', bch_balance_sats: '100000' },
    { v: 1, ts: '2026-09-19T12:00:00.000Z', bch_balance_sats: '200000' },
    { ts: '2026-09-19T13:00:00.000Z', bch_balance_sats: '300000' }, // missing v, but ts is valid
  ];
  const r = aggregateSnapshots(records, { nowMs: Date.parse('2026-09-19T14:00:00.000Z') });
  assert.equal(r.bucket_count, 2);
  assert.equal(r.bucket_skipped, 1);
});

test('snapshot-aggregator: aggregateSnapshots calls onSkip for skipped records', () => {
  const records = [
    null,
    { v: 1, ts: 'not-a-date' },
    { v: 1, ts: '2026-09-19T12:00:00.000Z', bch_balance_sats: '200000' },
  ];
  const skips = [];
  const r = aggregateSnapshots(records, {
    nowMs: Date.parse('2026-09-19T14:00:00.000Z'),
    onSkip: (reason, record) => skips.push({ reason, record }),
  });
  assert.equal(r.bucket_count, 1);
  assert.equal(skips.length, 2);
  assert.equal(skips[0].reason, 'not_an_object');
  assert.equal(skips[1].reason, 'missing_or_unparseable_ts');
});

// ─── formatRangeLabel ─────────────────────────────────────────────────

test('snapshot-aggregator: formatRangeLabel returns "all" for null sinceMs', () => {
  assert.equal(formatRangeLabel(null, 1_700_000_000_000), 'all');
});

test('snapshot-aggregator: formatRangeLabel formats seconds / minutes / hours / days', () => {
  const now = 1_700_000_000_000;
  assert.equal(formatRangeLabel(now - 30_000, now), '30s');
  assert.equal(formatRangeLabel(now - 5 * 60_000, now), '5m');
  assert.equal(formatRangeLabel(now - 3 * 3600_000, now), '3h');
  assert.equal(formatRangeLabel(now - 7 * 86400_000, now), '7d');
});

test('snapshot-aggregator: formatRangeLabel falls back to seconds when nowMs is missing', () => {
  assert.equal(formatRangeLabel(60_000, null), '60s');
});

// ─── buildAggregateResponse ───────────────────────────────────────────

test('snapshot-aggregator: buildAggregateResponse wraps the aggregate with cache metadata', () => {
  const agg = aggregateSnapshots([], { nowMs: 1_700_000_000_000 });
  const r = buildAggregateResponse(agg, { source: 'cache', cacheAgeMs: 1234, mtimeMs: 1_700_000_000_000 });
  assert.equal(r.schema, SNAPSHOTS_AGGREGATE_SCHEMA);
  assert.equal(r.source, 'cache');
  assert.equal(r.cache_age_ms, 1234);
  assert.equal(r.mtime_ms, 1_700_000_000_000);
  assert.equal(r.bucket_count, 0);
});

test('snapshot-aggregator: buildAggregateResponse defaults source to fresh', () => {
  const agg = aggregateSnapshots([], { nowMs: 1_700_000_000_000 });
  const r = buildAggregateResponse(agg);
  assert.equal(r.source, 'fresh');
  assert.equal(r.cache_age_ms, 0);
  assert.equal(r.mtime_ms, null);
});

test('snapshot-aggregator: buildAggregateResponse throws on missing aggregate', () => {
  assert.throws(() => buildAggregateResponse(null), SnapshotAggregatorConfigError);
});

// ─── SnapshotAggregator class ─────────────────────────────────────────

test('snapshot-aggregator: SnapshotAggregator.compute is a miss on cold cache', () => {
  const agg = new SnapshotAggregator({ cacheMs: 30_000, nowMs: () => 1_700_000_000_000 });
  const r = agg.compute({
    records: [{ v: 1, ts: '2026-09-19T12:00:00.000Z', bch_balance_sats: '100000' }],
    dir: '/tmp/snap',
    mtimeMs: 1_700_000_000_000,
    rangeMs: null,
    tokenId: null,
  });
  assert.equal(r.cached, false);
  assert.equal(r.cacheAgeMs, 0);
  assert.equal(r.mtimeMs, 1_700_000_000_000);
  assert.equal(r.value.bucket_count, 1);
});

test('snapshot-aggregator: SnapshotAggregator.compute is a hit on second call within TTL', () => {
  let nowMs = 1_700_000_000_000;
  const agg = new SnapshotAggregator({ cacheMs: 30_000, nowMs: () => nowMs });
  const args = {
    records: [{ v: 1, ts: '2026-09-19T12:00:00.000Z', bch_balance_sats: '100000' }],
    dir: '/tmp/snap',
    mtimeMs: 1_700_000_000_000,
    rangeMs: null,
    tokenId: null,
  };
  const r1 = agg.compute(args);
  nowMs += 1000;
  const r2 = agg.compute(args);
  assert.equal(r1.cached, false);
  assert.equal(r2.cached, true);
  assert.equal(r2.cacheAgeMs, 1000);
});

test('snapshot-aggregator: SnapshotAggregator invalidates on mtime change', () => {
  let nowMs = 1_700_000_000_000;
  const agg = new SnapshotAggregator({ cacheMs: 30_000, nowMs: () => nowMs });
  const baseArgs = {
    records: [{ v: 1, ts: '2026-09-19T12:00:00.000Z', bch_balance_sats: '100000' }],
    dir: '/tmp/snap',
    mtimeMs: 1_700_000_000_000,
    rangeMs: null,
    tokenId: null,
  };
  agg.compute(baseArgs);
  nowMs += 1000;
  const r2 = agg.compute({ ...baseArgs, mtimeMs: 1_700_000_001_000 });
  assert.equal(r2.cached, false, 'mtime change must invalidate the cache');
});

test('snapshot-aggregator: SnapshotAggregator invalidates on TTL expiry', () => {
  let nowMs = 1_700_000_000_000;
  const agg = new SnapshotAggregator({ cacheMs: 30_000, nowMs: () => nowMs });
  const args = {
    records: [{ v: 1, ts: '2026-09-19T12:00:00.000Z', bch_balance_sats: '100000' }],
    dir: '/tmp/snap',
    mtimeMs: 1_700_000_000_000,
    rangeMs: null,
    tokenId: null,
  };
  agg.compute(args);
  nowMs += 30_001; // 1 ms past TTL
  const r2 = agg.compute(args);
  assert.equal(r2.cached, false);
});

test('snapshot-aggregator: SnapshotAggregator with cacheMs=0 disables caching', () => {
  let nowMs = 1_700_000_000_000;
  const agg = new SnapshotAggregator({ cacheMs: 0, nowMs: () => nowMs });
  const args = {
    records: [{ v: 1, ts: '2026-09-19T12:00:00.000Z', bch_balance_sats: '100000' }],
    dir: '/tmp/snap',
    mtimeMs: 1_700_000_000_000,
    rangeMs: null,
    tokenId: null,
  };
  const r1 = agg.compute(args);
  nowMs += 1000;
  const r2 = agg.compute(args);
  assert.equal(r1.cached, false);
  assert.equal(r2.cached, false);
});

test('snapshot-aggregator: SnapshotAggregator caches per (dir, mtimeMs, rangeMs, tokenId)', () => {
  let nowMs = 1_700_000_000_000;
  const agg = new SnapshotAggregator({ cacheMs: 30_000, nowMs: () => nowMs });
  const argsA = {
    records: [{ v: 1, ts: '2026-09-19T12:00:00.000Z', bch_balance_sats: '100000' }],
    dir: '/tmp/snap-a', mtimeMs: 1_700_000_000_000, rangeMs: null, tokenId: null,
  };
  const argsB = {
    records: [{ v: 1, ts: '2026-09-19T12:00:00.000Z', bch_balance_sats: '100000' }],
    dir: '/tmp/snap-b', mtimeMs: 1_700_000_000_000, rangeMs: null, tokenId: null,
  };
  agg.compute(argsA);
  nowMs += 1000;
  const rA = agg.compute(argsA);
  const rB = agg.compute(argsB);
  assert.equal(rA.cached, true);
  assert.equal(rB.cached, false);
});

test('snapshot-aggregator: SnapshotAggregator.invalidate clears the cache', () => {
  let nowMs = 1_700_000_000_000;
  const agg = new SnapshotAggregator({ cacheMs: 30_000, nowMs: () => nowMs });
  const args = {
    records: [{ v: 1, ts: '2026-09-19T12:00:00.000Z', bch_balance_sats: '100000' }],
    dir: '/tmp/snap', mtimeMs: 1_700_000_000_000, rangeMs: null, tokenId: null,
  };
  agg.compute(args);
  agg.invalidate();
  nowMs += 1000;
  const r = agg.compute(args);
  assert.equal(r.cached, false);
});

test('snapshot-aggregator: SnapshotAggregator.compute throws on missing args', () => {
  const agg = new SnapshotAggregator({ cacheMs: 30_000 });
  assert.throws(() => agg.compute(null), SnapshotAggregatorConfigError);
  assert.throws(() => agg.compute({ records: 'not-array' }), SnapshotAggregatorConfigError);
});

test('snapshot-aggregator: SnapshotAggregator clamps cacheMs to safe range', () => {
  const a1 = new SnapshotAggregator({ cacheMs: -5 });
  assert.equal(a1.cacheMs, 0);
  const a2 = new SnapshotAggregator({ cacheMs: 999_999_999 });
  assert.equal(a2.cacheMs, MAX_SNAPSHOT_AGGREGATE_CACHE_MS);
  const a3 = new SnapshotAggregator({ cacheMs: 30_000 });
  assert.equal(a3.cacheMs, 30_000);
});

// ─── clampSnapshotAggregateCacheMs ────────────────────────────────────

test('snapshot-aggregator: clampSnapshotAggregateCacheMs clamps + defaults', () => {
  assert.equal(clampSnapshotAggregateCacheMs(30_000), 30_000);
  // 0 means "disable caching" — preserved, NOT bumped to MIN.
  assert.equal(clampSnapshotAggregateCacheMs(0), 0);
  assert.equal(clampSnapshotAggregateCacheMs(-1), 0);
  // 1..MIN-1 gets floored to MIN to prevent pathological values
  // (e.g. 1ms TTL on a 200ms handler defeats the cache).
  assert.equal(clampSnapshotAggregateCacheMs(1), MIN_SNAPSHOT_AGGREGATE_CACHE_MS);
  assert.equal(clampSnapshotAggregateCacheMs(MIN_SNAPSHOT_AGGREGATE_CACHE_MS - 1), MIN_SNAPSHOT_AGGREGATE_CACHE_MS);
  assert.equal(clampSnapshotAggregateCacheMs(999_999), MAX_SNAPSHOT_AGGREGATE_CACHE_MS);
  assert.equal(clampSnapshotAggregateCacheMs(null), DEFAULT_SNAPSHOT_AGGREGATE_CACHE_MS);
  assert.equal(clampSnapshotAggregateCacheMs(undefined), DEFAULT_SNAPSHOT_AGGREGATE_CACHE_MS);
  assert.equal(clampSnapshotAggregateCacheMs('30000'), DEFAULT_SNAPSHOT_AGGREGATE_CACHE_MS);
  assert.equal(clampSnapshotAggregateCacheMs(NaN), DEFAULT_SNAPSHOT_AGGREGATE_CACHE_MS);
  assert.equal(clampSnapshotAggregateCacheMs(123.7), 123); // floor
});

// ─── HTTP integration via supertest ──────────────────────────────────

async function importSupertest(t) {
  const supertest = await import('supertest').catch(() => null);
  if (!supertest) {
    t.skip('supertest not installed — skipping HTTP integration');
    return null;
  }
  return supertest.default ?? supertest;
}

async function bootDashboardServer({ cfg = {}, clock = null, snapshotsDir } = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'snap-agg-'));
  const positions = new Positions({ file: path.join(tmp, 'positions.json') });
  await positions.load();
  const snapshots = new Snapshots({ dir: snapshotsDir ?? path.join(tmp, 'snapshots') });
  await snapshots.load();
  const sink = createMemorySink();
  const logger = createLogger({
    component: 'test',
    sink: sink.stream,
    level: 'debug',
  });
  const server = createDashboardServer({
    cfg,
    positions,
    snapshots,
    historyReader: { read: async () => ({ events: [], errors: [] }) },
    staticRoot: null,
    logger,
    clock: clock ?? (() => Date.now()),
  });
  return { server, tmp, snapshots, sink };
}

test('snapshot-aggregator: GET /api/snapshots/aggregate returns the envelope on empty dir', async (t) => {
  const supertest = await importSupertest(t);
  if (!supertest) return;
  const { server, tmp } = await bootDashboardServer({});
  try {
    const res = await supertest(server.handler).get('/api/snapshots/aggregate').expect(200);
    assert.equal(res.body.schema, SNAPSHOTS_AGGREGATE_SCHEMA);
    assert.equal(res.body.source, 'fresh');
    assert.equal(res.body.cache_age_ms, 0);
    assert.equal(res.body.bucket_count, 0);
    assert.equal(res.body.bucket_skipped, 0);
    assert.equal(res.body.first_ts, null);
    assert.equal(res.body.last_ts, null);
    assert.equal(res.body.balance_sats.min, null);
    assert.equal(res.body.balance_sats.count, 0);
    assert.equal(res.body.drawdown_sats, null);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('snapshot-aggregator: GET /api/snapshots/aggregate rolls up records + serves cache on second hit', async (t) => {
  const supertest = await importSupertest(t);
  if (!supertest) return;
  const nowMs = 1_726_240_800_000; // 2024-09-19T12:00:00.000Z (well after fixtures)
  const { server, tmp } = await bootDashboardServer({
    clock: () => nowMs,
  });
  try {
    // Write 3 snapshot records to a fresh daily file
    const today = new Date(nowMs).toISOString().slice(0, 10);
    const file = path.join(tmp, 'snapshots', `${today}.jsonl`);
    await writeFile(file, [
      JSON.stringify({ v: 1, ts: '2026-09-19T10:00:00.000Z', bch_balance_sats: '100000', total_exposure_sats: '50000', unrealized_pnl_sats: '1000', open_position_count: 5 }),
      JSON.stringify({ v: 1, ts: '2026-09-19T11:00:00.000Z', bch_balance_sats: '200000', total_exposure_sats: '40000', unrealized_pnl_sats: '-2000', open_position_count: 3 }),
      JSON.stringify({ v: 1, ts: '2026-09-19T12:00:00.000Z', bch_balance_sats: '150000', total_exposure_sats: '60000', unrealized_pnl_sats: '3000', open_position_count: 4 }),
    ].join('\n') + '\n', 'utf8');

    const r1 = await supertest(server.handler).get('/api/snapshots/aggregate?range=24h').expect(200);
    assert.equal(r1.body.bucket_count, 3);
    assert.equal(r1.body.first_ts, '2026-09-19T10:00:00.000Z');
    assert.equal(r1.body.last_ts, '2026-09-19T12:00:00.000Z');
    assert.equal(r1.body.balance_sats.min, '100000');
    assert.equal(r1.body.balance_sats.max, '200000');
    assert.equal(r1.body.balance_sats.latest, '150000');
    assert.equal(r1.body.drawdown_sats, '-50000'); // balance grew from 100000 → 150000
    assert.equal(r1.body.source, 'fresh');
    assert.equal(r1.body.cache_age_ms, 0);

    // Second hit: same dir, same range → cache hit
    const r2 = await supertest(server.handler).get('/api/snapshots/aggregate?range=24h').expect(200);
    assert.equal(r2.body.source, 'cache');
    assert.ok(r2.body.cache_age_ms >= 0);
    assert.equal(r2.body.bucket_count, 3);
    assert.equal(r2.body.balance_sats.min, '100000');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('snapshot-aggregator: GET /api/snapshots/aggregate returns 400 on bad range', async (t) => {
  const supertest = await importSupertest(t);
  if (!supertest) return;
  const { server, tmp } = await bootDashboardServer({});
  try {
    // bad-range surfaces as HTTP 400 (the DashboardConfigError thrown
    // by rangeToMs bubbles up via the handler's `statusCode` mapping).
    const res = await supertest(server.handler).get('/api/snapshots/aggregate?range=garbage').expect(400);
    assert.ok(typeof res.body.error === 'string');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('snapshot-aggregator: GET /api/snapshots/aggregate ignores malformed tokenId gracefully', async (t) => {
  const supertest = await importSupertest(t);
  if (!supertest) return;
  const { server, tmp } = await bootDashboardServer({});
  try {
    const res = await supertest(server.handler).get('/api/snapshots/aggregate?token_id=garbage').expect(200);
    // The malformed token filter is passed through (case-folded) — it just
    // matches zero records. The endpoint stays 200 with bucket_count:0.
    assert.equal(res.body.bucket_count, 0);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('snapshot-aggregator: GET /api/snapshots/aggregate applies cache_ms knob = 0 (always fresh)', async (t) => {
  const supertest = await importSupertest(t);
  if (!supertest) return;
  const { server, tmp } = await bootDashboardServer({
    cfg: { dashboard: { snapshot_aggregate_cache_ms: 0 } },
  });
  try {
    const r1 = await supertest(server.handler).get('/api/snapshots/aggregate').expect(200);
    const r2 = await supertest(server.handler).get('/api/snapshots/aggregate').expect(200);
    assert.equal(r1.body.source, 'fresh');
    assert.equal(r2.body.source, 'fresh');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('snapshot-aggregator: GET /api/snapshots/aggregate applies sinceMs window', async (t) => {
  const supertest = await importSupertest(t);
  if (!supertest) return;
  const nowMs = 1_726_240_800_000; // ~2024-09-19 noon UTC
  const { server, tmp } = await bootDashboardServer({
    clock: () => nowMs,
  });
  try {
    // Records are placed RELATIVE to nowMs so the sinceMs window
    // actually has something to filter. ts1 = now-2h, ts2 = now-1h,
    // ts3 = now-15m. A 30m range from now = [now-30m, now] → only
    // the ts3 record matches.
    const ts1 = new Date(nowMs - 2 * 60 * 60 * 1000).toISOString();
    const ts2 = new Date(nowMs - 60 * 60 * 1000).toISOString();
    const ts3 = new Date(nowMs - 15 * 60 * 1000).toISOString();
    const today = new Date(nowMs).toISOString().slice(0, 10);
    const file = path.join(tmp, 'snapshots', `${today}.jsonl`);
    await writeFile(file, [
      JSON.stringify({ v: 1, ts: ts1, bch_balance_sats: '100000', open_position_count: 1 }),
      JSON.stringify({ v: 1, ts: ts2, bch_balance_sats: '200000', open_position_count: 2 }),
      JSON.stringify({ v: 1, ts: ts3, bch_balance_sats: '300000', open_position_count: 3 }),
    ].join('\n') + '\n', 'utf8');

    const r = await supertest(server.handler).get('/api/snapshots/aggregate?range=30m').expect(200);
    assert.equal(r.body.bucket_count, 1);
    assert.equal(r.body.first_ts, ts3);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});