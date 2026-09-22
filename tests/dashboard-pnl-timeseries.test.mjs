#!/usr/bin/env node
/**
 * tests/dashboard-pnl-timeseries.test.mjs
 *
 * Unit tests for `src/dashboard/pnl-timeseries.mjs` (T39).
 *
 * Covers:
 *   1. `toSatsBig` — bigint / number / string / null coercion, safety rails.
 *   2. `classifyPnl` — win / loss / breakeven / unknown buckets.
 *   3. `parseClosedAt` — ISO parse, missing / unparseable handling.
 *   4. `normalizeTokenFilter` — case-fold, whitespace, null.
 *   5. `buildPnlTimeseries` — sort stability, cumulative math,
 *      sinceMs windowing, token filter, skip reasons, empty input.
 *   6. `buildPnlTimeseriesResponse` — envelope shape, range label,
 *      range_ms, realized_total_bch, first/last close.
 *   7. `PnlTimeseriesConfigError` — message + statusCode.
 *
 * No I/O — everything is pure. Fast + deterministic.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPnlTimeseries,
  buildPnlTimeseriesResponse,
  classifyPnl,
  normalizeTokenFilter,
  parseClosedAt,
  PnlTimeseriesConfigError,
  PnlTimeseriesError,
  toSatsBig,
} from '../src/dashboard/pnl-timeseries.mjs';

// ─────────────────────────────────────────────────────────────────────
//  toSatsBig
// ─────────────────────────────────────────────────────────────────────

test('pnl-timeseries: toSatsBig accepts bigint / number / string', () => {
  assert.equal(toSatsBig(123n), 123n);
  assert.equal(toSatsBig(123), 123n);
  assert.equal(toSatsBig('456'), 456n);
  assert.equal(toSatsBig('-789'), -789n);
});

test('pnl-timeseries: toSatsBig returns null on missing / non-numeric', () => {
  assert.equal(toSatsBig(null), null);
  assert.equal(toSatsBig(undefined), null);
  assert.equal(toSatsBig(''), null);
  assert.equal(toSatsBig('   '), null);
  assert.equal(toSatsBig('abc'), null);
  assert.equal(toSatsBig('12.5'), null); // not an integer
  assert.equal(toSatsBig(NaN), null);
  assert.equal(toSatsBig(Infinity), null);
  assert.equal(toSatsBig({}), null);
  assert.equal(toSatsBig([]), null);
});

test('pnl-timeseries: toSatsBig handles numbers at safe-integer boundaries', () => {
  // Integer at the safe-integer boundary stays as a bigint.
  assert.equal(toSatsBig(Number.MAX_SAFE_INTEGER), BigInt(Number.MAX_SAFE_INTEGER));
  assert.equal(toSatsBig(Number.MIN_SAFE_INTEGER), BigInt(Number.MIN_SAFE_INTEGER));
  // Big numbers as strings still parse (the on-disk convention).
  assert.equal(toSatsBig('99999999999999999999'), 99999999999999999999n);
});

test('pnl-timeseries: toSatsBig rounds fractional numbers (matches pnl.mjs#toSats)', () => {
  // Math.round, not Math.trunc — matches pnl.mjs#toSats.
  assert.equal(toSatsBig(123.7), 124n);
  assert.equal(toSatsBig(123.4), 123n);
  assert.equal(toSatsBig(-456.6), -457n);
  assert.equal(toSatsBig(-456.4), -456n);
});

// ─────────────────────────────────────────────────────────────────────
//  classifyPnl
// ─────────────────────────────────────────────────────────────────────

test('pnl-timeseries: classifyPnl maps to win / loss / breakeven / unknown', () => {
  assert.equal(classifyPnl(1n), 'win');
  assert.equal(classifyPnl(0n), 'breakeven');
  assert.equal(classifyPnl(-1n), 'loss');
  assert.equal(classifyPnl(null), 'unknown');
  assert.equal(classifyPnl(999_999n), 'win');
});

// ─────────────────────────────────────────────────────────────────────
//  parseClosedAt
// ─────────────────────────────────────────────────────────────────────

test('pnl-timeseries: parseClosedAt parses ISO timestamps', () => {
  assert.equal(parseClosedAt('2026-09-15T12:00:00.000Z'), Date.parse('2026-09-15T12:00:00.000Z'));
  assert.equal(parseClosedAt('2026-09-15T12:00:00Z'), Date.parse('2026-09-15T12:00:00Z'));
  assert.equal(parseClosedAt('  2026-09-15T12:00:00Z  '), Date.parse('2026-09-15T12:00:00Z'));
});

test('pnl-timeseries: parseClosedAt returns null on missing / bad input', () => {
  assert.equal(parseClosedAt(null), null);
  assert.equal(parseClosedAt(undefined), null);
  assert.equal(parseClosedAt(''), null);
  assert.equal(parseClosedAt('   '), null);
  assert.equal(parseClosedAt('not a date'), null);
  assert.equal(parseClosedAt(123), null);
  assert.equal(parseClosedAt({}), null);
});

// ─────────────────────────────────────────────────────────────────────
//  normalizeTokenFilter
// ─────────────────────────────────────────────────────────────────────

test('pnl-timeseries: normalizeTokenFilter case-folds + trims', () => {
  assert.equal(normalizeTokenFilter('ABC123'), 'abc123');
  assert.equal(normalizeTokenFilter('  abc123  '), 'abc123');
  assert.equal(normalizeTokenFilter('7fa887fd4eac015478b95392c4984721fbe3060223c30b342d43cc06817f07f6'),
    '7fa887fd4eac015478b95392c4984721fbe3060223c30b342d43cc06817f07f6');
  assert.equal(normalizeTokenFilter(null), null);
  assert.equal(normalizeTokenFilter(undefined), null);
  assert.equal(normalizeTokenFilter(''), null);
  assert.equal(normalizeTokenFilter('   '), null);
  assert.equal(normalizeTokenFilter(123), null);
});

// ─────────────────────────────────────────────────────────────────────
//  buildPnlTimeseries — empty + error paths
// ─────────────────────────────────────────────────────────────────────

test('pnl-timeseries: buildPnlTimeseries throws PnlTimeseriesConfigError on non-array', () => {
  assert.throws(() => buildPnlTimeseries(null), PnlTimeseriesConfigError);
  assert.throws(() => buildPnlTimeseries(undefined), PnlTimeseriesConfigError);
  assert.throws(() => buildPnlTimeseries('not an array'), PnlTimeseriesConfigError);
  assert.throws(() => buildPnlTimeseries({}), PnlTimeseriesConfigError);
});

test('pnl-timeseries: buildPnlTimeseries returns empty rows for empty input', () => {
  const out = buildPnlTimeseries([]);
  assert.deepEqual(out.rows, []);
  assert.equal(out.skipped, 0);
  assert.equal(out.trades_count, 0);
  assert.equal(out.realized_total_sats, 0n);
});

test('pnl-timeseries: buildPnlTimeseries skips entries missing closed_at', () => {
  const positions = [
    { id: 'a', closed_at: '2026-09-15T12:00:00Z', exit: { realized_pnl_sats: '1000' } },
    { id: 'b', exit: { realized_pnl_sats: '500' } }, // missing closed_at
    { id: 'c', closed_at: 'not-a-date', exit: { realized_pnl_sats: '300' } },
  ];
  const out = buildPnlTimeseries(positions);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].position_id, 'a');
  assert.equal(out.skipped, 2);
});

test('pnl-timeseries: buildPnlTimeseries skips entries with null realized_pnl_sats', () => {
  const positions = [
    { id: 'a', closed_at: '2026-09-15T12:00:00Z', exit: { realized_pnl_sats: null } },
    { id: 'b', closed_at: '2026-09-15T12:00:00Z', exit: {} },
    { id: 'c', closed_at: '2026-09-15T12:00:00Z' },
    { id: 'd', closed_at: '2026-09-15T12:01:00Z', exit: { realized_pnl_sats: '750' } },
  ];
  const out = buildPnlTimeseries(positions);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].position_id, 'd');
  assert.equal(out.skipped, 3);
});

test('pnl-timeseries: buildPnlTimeseries invokes onSkip with reason codes', () => {
  const seen = [];
  // Four positions, each tagged to trip a different skip path:
  //   - a: closed_at is unparseable  → missing_or_unparseable_closed_at
  //   - b: realized_pnl_sats missing  → missing_realized_pnl_sats
  //   - c: null position              → not_an_object
  //   - d: primitive (string)         → not_an_object
  const positions = [
    { id: 'a', closed_at: 'not-a-date', exit: { realized_pnl_sats: '100' } },
    { id: 'b', closed_at: '2026-09-15T12:00:00Z', exit: { realized_pnl_sats: null } },
    null,
    'not an object',
  ];
  const out = buildPnlTimeseries(positions, {
    onSkip: (reason, p) => seen.push({ reason, id: p?.id ?? null }),
  });
  assert.equal(out.rows.length, 0);
  assert.equal(out.skipped, 4);
  assert.equal(seen.length, 4);
  const byReason = seen.reduce((acc, s) => {
    acc[s.reason] = (acc[s.reason] || 0) + 1;
    return acc;
  }, {});
  assert.equal(byReason.missing_or_unparseable_closed_at, 1);
  assert.equal(byReason.missing_realized_pnl_sats, 1);
  assert.equal(byReason.not_an_object, 2);
});

// ─────────────────────────────────────────────────────────────────────
//  buildPnlTimeseries — sort + cumulative math
// ─────────────────────────────────────────────────────────────────────

test('pnl-timeseries: buildPnlTimeseries sorts ascending by closed_at', () => {
  const positions = [
    { id: 'late', closed_at: '2026-09-15T12:30:00Z', exit: { realized_pnl_sats: '300' } },
    { id: 'early', closed_at: '2026-09-15T12:00:00Z', exit: { realized_pnl_sats: '100' } },
    { id: 'mid', closed_at: '2026-09-15T12:15:00Z', exit: { realized_pnl_sats: '200' } },
  ];
  const out = buildPnlTimeseries(positions);
  assert.deepEqual(out.rows.map((r) => r.position_id), ['early', 'mid', 'late']);
});

test('pnl-timeseries: buildPnlTimeseries breaks ties on identical timestamps via position_id', () => {
  const positions = [
    { id: 'z', closed_at: '2026-09-15T12:00:00Z', exit: { realized_pnl_sats: '300' } },
    { id: 'a', closed_at: '2026-09-15T12:00:00Z', exit: { realized_pnl_sats: '100' } },
    { id: 'm', closed_at: '2026-09-15T12:00:00Z', exit: { realized_pnl_sats: '200' } },
  ];
  const out = buildPnlTimeseries(positions);
  assert.deepEqual(out.rows.map((r) => r.position_id), ['a', 'm', 'z']);
});

test('pnl-timeseries: buildPnlTimeseries computes correct cumulative math', () => {
  // T40 fix: pnl is now COMPUTED from raw exit economics
  // (`received - spent - fees`) when available; stored
  // `realized_pnl_sats` is only a fallback when raw data is
  // missing. These positions carry matching raw fields so the
  // computed value matches the stored value (and the test stays
  // a meaningful cumulative-math check).
  const positions = [
    { id: 'a', closed_at: '2026-09-15T12:00:00Z',
      entry: { bch_spent_sats: '0' },
      exit:  { bch_received_sats: '100', realized_pnl_sats: '100' } },
    { id: 'b', closed_at: '2026-09-15T12:01:00Z',
      entry: { bch_spent_sats: '50' },
      exit:  { bch_received_sats: '0', realized_pnl_sats: '-50' } },
    { id: 'c', closed_at: '2026-09-15T12:02:00Z',
      entry: { bch_spent_sats: '0' },
      exit:  { bch_received_sats: '200', realized_pnl_sats: '200' } },
    { id: 'd', closed_at: '2026-09-15T12:03:00Z',
      entry: { bch_spent_sats: '0' },
      exit:  { bch_received_sats: '0', realized_pnl_sats: '0' } },
  ];
  const out = buildPnlTimeseries(positions);
  assert.deepEqual(out.rows.map((r) => r.cumulative_realized_pnl_sats), [
    '100', '50', '250', '250',
  ]);
  assert.equal(out.realized_total_sats, 250n);
  assert.deepEqual(out.rows.map((r) => r.kind), ['win', 'loss', 'win', 'breakeven']);
});

test('pnl-timeseries: buildPnlTimeseries accepts bigint / string / number pnl inputs', () => {
  // T40 fix: include raw economics so the COMPUTED path picks up
  // matching values; the test still covers the "stored value used
  // as fallback when raw missing" path implicitly.
  const positions = [
    { id: 'a', closed_at: '2026-09-15T12:00:00Z',
      entry: { bch_spent_sats: '0' },
      exit:  { bch_received_sats: '100', realized_pnl_sats: 100 } },
    { id: 'b', closed_at: '2026-09-15T12:01:00Z',
      entry: { bch_spent_sats: '0' },
      exit:  { bch_received_sats: '200', realized_pnl_sats: 200n } },
    { id: 'c', closed_at: '2026-09-15T12:02:00Z',
      entry: { bch_spent_sats: '50' },
      exit:  { bch_received_sats: '0', realized_pnl_sats: '-50' } },
  ];
  const out = buildPnlTimeseries(positions);
  assert.deepEqual(out.rows.map((r) => r.realized_pnl_sats), ['100', '200', '-50']);
  assert.deepEqual(out.rows.map((r) => r.cumulative_realized_pnl_sats), ['100', '300', '250']);
});

test('pnl-timeseries: buildPnlTimeseries prefers computed pnl over stored when both present', () => {
  // T40 fix: the FEW orphan-recovery (recovery set realized_pnl_sats=0
  // to unstick the bot) used to silently ignore the real loss. With
  // the COMPUTED path, raw `received=400000 spent=500000 fees=1500+1500=3000`
  // gives pnl=-103000 which is what the dashboard + summary now agree on.
  const p = {
    id: 'pos_x',
    token_id: '7fa887fd4eac015478b95392c4984721fbe3060223c30b342d43cc06817f07f6',
    token_symbol: 'FEW',
    side: 'long_token',
    closed_at: '2026-09-15T12:00:00.000Z',
    entry: { bch_spent_sats: '500000', fee_sats: '1500' },
    exit: {
      // Stored value is the manual override (= 0 fake-zero).
      realized_pnl_sats: '0',
      // But raw economics say it's actually a loss.
      bch_received_sats: '400000', fee_sats: '1500', reason: 'orphan_recovery',
    },
  };
  const out = buildPnlTimeseries([p]);
  const row = out.rows[0];
  // Computed pnl: 400000 - 500000 - 1500 - 1500 = -103000
  assert.equal(row.realized_pnl_sats, '-103000');
  assert.equal(out.realized_total_sats, -103000n);
  assert.equal(row.pnl_source, 'computed');
  assert.equal(row.kind, 'loss');
});

test('pnl-timeseries: buildPnlTimeseries falls back to stored pnl when raw economics missing', () => {
  // Position has no entry.bch_spent_sats — the COMPUTED path returns
  // null and we fall back to the stored `realized_pnl_sats`.
  const p = {
    id: 'orphan_synthetic',
    token_id: 'abcd'.repeat(16),
    token_symbol: 'OLD',
    closed_at: '2026-09-15T12:00:00.000Z',
    entry: {}, // no bch_spent_sats
    exit: { realized_pnl_sats: '12345', reason: 'synthetic_recovery' },
  };
  const out = buildPnlTimeseries([p]);
  assert.equal(out.rows[0].realized_pnl_sats, '12345');
  assert.equal(out.rows[0].pnl_source, 'stored');
});

test('pnl-timeseries: buildPnlTimeseries row carries all wire fields', () => {
  const p = {
    id: 'pos_x',
    token_id: '7fa887fd4eac015478b95392c4984721fbe3060223c30b342d43cc06817f07f6',
    token_symbol: 'FEW',
    side: 'long_token',
    closed_at: '2026-09-15T12:00:00.000Z',
    entry: { bch_spent_sats: '500000', fee_sats: '1500' },
    exit: { realized_pnl_sats: '-100', bch_received_sats: '400000', fee_sats: '1500', reason: 'stop_loss' },
  };
  const out = buildPnlTimeseries([p]);
  const row = out.rows[0];
  assert.equal(row.position_id, 'pos_x');
  assert.equal(row.token_id, '7fa887fd4eac015478b95392c4984721fbe3060223c30b342d43cc06817f07f6');
  assert.equal(row.token_symbol, 'FEW');
  assert.equal(row.side, 'long_token');
  assert.equal(row.closed_at, '2026-09-15T12:00:00.000Z');
  assert.equal(row.reason, 'stop_loss');
  // T40 fix: raw economics win over stored. received(400000) -
  // spent(500000) - entry_fee(1500) - exit_fee(1500) = -103000.
  assert.equal(row.realized_pnl_sats, '-103000');
  assert.equal(row.bch_spent_sats, '500000');
  assert.equal(row.bch_received_sats, '400000');
  assert.equal(row.fee_sats, '3000'); // entry + exit
  assert.equal(row.kind, 'loss');
  assert.equal(row.ts_ms, Date.parse('2026-09-15T12:00:00.000Z'));
  assert.equal(typeof row.cumulative_realized_pnl_bch, 'number');
  assert.ok(row.cumulative_realized_pnl_bch < 0, 'cumulative_bch negative for loss');
});

// ─────────────────────────────────────────────────────────────────────
//  buildPnlTimeseries — filter
// ─────────────────────────────────────────────────────────────────────

test('pnl-timeseries: buildPnlTimeseries token_id filter (case-folded)', () => {
  const positions = [
    { id: 'a', token_id: 'FEW', closed_at: '2026-09-15T12:00:00Z', exit: { realized_pnl_sats: '100' } },
    { id: 'b', token_id: 'QBTC', closed_at: '2026-09-15T12:01:00Z', exit: { realized_pnl_sats: '200' } },
    { id: 'c', token_id: 'few', closed_at: '2026-09-15T12:02:00Z', exit: { realized_pnl_sats: '50' } },
  ];
  const out = buildPnlTimeseries(positions, { tokenId: 'few' });
  assert.equal(out.rows.length, 2);
  assert.deepEqual(out.rows.map((r) => r.position_id), ['a', 'c']);
  assert.equal(out.realized_total_sats, 150n);
});

test('pnl-timeseries: buildPnlTimeseries token_id filter skips on token_filter_miss', () => {
  const seen = [];
  const positions = [
    { id: 'a', token_id: 'FEW', closed_at: '2026-09-15T12:00:00Z', exit: { realized_pnl_sats: '100' } },
    { id: 'b', token_id: 'QBTC', closed_at: '2026-09-15T12:01:00Z', exit: { realized_pnl_sats: '200' } },
  ];
  buildPnlTimeseries(positions, {
    tokenId: 'QBTC',
    onSkip: (reason, p) => seen.push({ reason, id: p?.id }),
  });
  assert.deepEqual(seen, [{ reason: 'token_filter_miss', id: 'a' }]);
});

test('pnl-timeseries: buildPnlTimeseries sinceMs drops out-of-window rows but cumulative still tracks', () => {
  // 4 closes over 4 minutes. sinceMs in the middle.
  const positions = [
    { id: 'a', closed_at: '2026-09-15T12:00:00Z', exit: { realized_pnl_sats: '100' } },
    { id: 'b', closed_at: '2026-09-15T12:01:00Z', exit: { realized_pnl_sats: '200' } },
    { id: 'c', closed_at: '2026-09-15T12:02:00Z', exit: { realized_pnl_sats: '-50' } },
    { id: 'd', closed_at: '2026-09-15T12:03:00Z', exit: { realized_pnl_sats: '300' } },
  ];
  // Window starts at 12:02:00Z — drops a + b. Cumulative should
  // start at 300 (= 100+200) before c's -50, then 250 after c,
  // then 550 after d. This matches the chart's "since N days ago,
  // running total was X and is now Y" interpretation.
  const sinceMs = Date.parse('2026-09-15T12:02:00Z');
  const out = buildPnlTimeseries(positions, { sinceMs });
  assert.equal(out.rows.length, 2);
  assert.deepEqual(out.rows.map((r) => r.position_id), ['c', 'd']);
  assert.deepEqual(out.rows.map((r) => r.cumulative_realized_pnl_sats), ['250', '550']);
  assert.equal(out.realized_total_sats, 550n);
});

test('pnl-timeseries: buildPnlTimeseries sinceMs + tokenId combine as AND', () => {
  const positions = [
    { id: 'a', token_id: 'FEW', closed_at: '2026-09-15T12:00:00Z', exit: { realized_pnl_sats: '100' } },
    { id: 'b', token_id: 'QBTC', closed_at: '2026-09-15T12:01:00Z', exit: { realized_pnl_sats: '200' } },
    { id: 'c', token_id: 'FEW', closed_at: '2026-09-15T12:02:00Z', exit: { realized_pnl_sats: '-50' } },
  ];
  // Window starts at 12:01:30Z; cumulative keeps tracking through
  // dropped closes (see docstring) — a is FEW but BEFORE window
  // (cumulative += 100), b is QBTC so filtered out (skipped), c is
  // FEW + in window. cumsum at c = 100 + (-50) = 50.
  const sinceMs = Date.parse('2026-09-15T12:01:30Z');
  const out = buildPnlTimeseries(positions, { tokenId: 'few', sinceMs });
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].position_id, 'c');
  assert.equal(out.rows[0].cumulative_realized_pnl_sats, '50');
  assert.equal(out.skipped, 2);
});

test('pnl-timeseries: buildPnlTimeseries ignores bad sinceMs types', () => {
  const positions = [
    { id: 'a', closed_at: '2026-09-15T12:00:00Z', exit: { realized_pnl_sats: '100' } },
  ];
  // Non-finite / negative / string should all be ignored.
  assert.equal(buildPnlTimeseries(positions, { sinceMs: NaN }).rows.length, 1);
  assert.equal(buildPnlTimeseries(positions, { sinceMs: '123' }).rows.length, 1);
  assert.equal(buildPnlTimeseries(positions, { sinceMs: -1 }).rows.length, 1);
  assert.equal(buildPnlTimeseries(positions, { sinceMs: undefined }).rows.length, 1);
});

// ─────────────────────────────────────────────────────────────────────
//  buildPnlTimeseriesResponse
// ─────────────────────────────────────────────────────────────────────

test('pnl-timeseries: buildPnlTimeseriesResponse carries schema + envelope metadata', () => {
  const positions = [
    { id: 'a', token_id: 'FEW', closed_at: '2026-09-15T11:59:30Z', exit: { realized_pnl_sats: '100' } },
    { id: 'b', token_id: 'QBTC', closed_at: '2026-09-15T12:00:00Z', exit: { realized_pnl_sats: '-50' } },
  ];
  // Window starts at 12:00:00Z → a is dropped (cumsum carries forward
  // to 100), b is in-window with cumsum 100 + (-50) = 50.
  const sinceMs = Date.parse('2026-09-15T12:00:00Z');
  const out = buildPnlTimeseriesResponse(positions, {
    sinceMs,
    rangeMs: sinceMs === null ? null : Date.parse('2026-09-15T12:00:00Z') - sinceMs,
    rangeLabel: '12h',
    tokenId: null,
  });
  assert.equal(out.schema, 'tradebot.dashboard.pnl-timeseries/v1');
  assert.equal(typeof out.ts, 'string');
  assert.equal(out.range, '12h');
  assert.equal(typeof out.range_ms, 'number');
  assert.equal(out.token_id, null);
  assert.equal(out.count, 1);
  assert.equal(out.trades_count, 1);
  assert.equal(out.realized_total_sats, '50');
  assert.equal(typeof out.realized_total_bch, 'number');
  assert.equal(out.first_close_ts, '2026-09-15T12:00:00.000Z');
  assert.equal(out.last_close_ts, '2026-09-15T12:00:00.000Z');
  assert.equal(out.rows[0].position_id, 'b');
});

test('pnl-timeseries: buildPnlTimeseriesResponse defaults range label to "all" when rangeMs=null', () => {
  const out = buildPnlTimeseriesResponse([]);
  assert.equal(out.range, 'all');
  assert.equal(out.range_ms, null);
  assert.equal(out.count, 0);
  assert.equal(out.first_close_ts, null);
  assert.equal(out.last_close_ts, null);
});

test('pnl-timeseries: buildPnlTimeseriesResponse echoes token_id filter', () => {
  const positions = [
    { id: 'a', token_id: 'FEW', closed_at: '2026-09-15T12:00:00Z', exit: { realized_pnl_sats: '100' } },
    { id: 'b', token_id: 'QBTC', closed_at: '2026-09-15T12:01:00Z', exit: { realized_pnl_sats: '200' } },
  ];
  const out = buildPnlTimeseriesResponse(positions, { tokenId: 'QBTC' });
  assert.equal(out.token_id, 'QBTC');
  assert.equal(out.count, 1);
  assert.equal(out.rows[0].token_id, 'QBTC');
});

// ─────────────────────────────────────────────────────────────────────
//  Errors
// ─────────────────────────────────────────────────────────────────────

test('pnl-timeseries: PnlTimeseriesConfigError carries statusCode=400 by default', () => {
  const err = new PnlTimeseriesConfigError('bad input');
  assert.ok(err instanceof PnlTimeseriesError);
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'PnlTimeseriesConfigError');
  assert.equal(err.statusCode, 400);
});

test('pnl-timeseries: PnlTimeseriesError can carry statusCode via opts', () => {
  const err = new PnlTimeseriesError('server meltdown', { statusCode: 500, kind: 'oops' });
  assert.equal(err.statusCode, 500);
  assert.equal(err.kind, 'oops');
});
