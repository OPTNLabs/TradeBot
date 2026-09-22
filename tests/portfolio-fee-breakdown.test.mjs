#!/usr/bin/env node
// tests/portfolio-fee-breakdown.test.mjs
//
// Unit + integration tests for `src/portfolio/fee-breakdown.mjs`.
// The module ships with T71 (per-token fee breakdown with LP /
// tx / slippage split). Tests run under `node --test` so they
// slot into the repo's existing test runner without new
// devDependencies.
//
// Coverage groups:
//   1. Constants — schema, default LP-fee rate, severity thresholds
//   2. Conversion helpers — toSatsBigInt + safeBigFloat
//   3. Per-position helpers — txFeesForPosition, lpFeesForPosition,
//      slippageCostForPosition, signedSlippageBpsForPosition,
//      feesTotalForPosition
//   4. Per-trade attribution — attributionForPositionWithFees
//   5. By-kind + rollups — pickByKind, sharesFromTotals,
//      aggregateFeeTotals
//   6. Per-token summary — breakdownFeesForToken
//   7. Cross-token rollup — breakdownFeesAcrossTokens
//   8. Error paths — FeeBreakdownArgError on bad input
//   9. Real-data fixture check — pulls `data/history.jsonl` +
//      `data/positions.json` (when available) and runs the
//      rollup end-to-end to guard against data-shape regressions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FEE_BREAKDOWN_SCHEMA,
  DEFAULT_LP_FEE_RATE_BPS,
  SLIPPAGE_RED_THRESHOLD,
  SLIPPAGE_AMBER_THRESHOLD,
  FeeBreakdownArgError,
  toSatsBigInt,
  safeBigFloat,
  txFeesForPosition,
  lpFeesForPosition,
  slippageCostForPosition,
  signedSlippageBpsForPosition,
  feesTotalForPosition,
  attributionForPositionWithFees,
  pickByKind,
  sharesFromTotals,
  aggregateFeeTotals,
  breakdownFeesForToken,
  breakdownFeesAcrossTokens,
} from '../src/portfolio/fee-breakdown.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

// ─────────────────────────────────────────────────────────────────────
// 1. Constants
// ─────────────────────────────────────────────────────────────────────

test('fee-breakdown: FEE_BREAKDOWN_SCHEMA is the v1 envelope string', () => {
  assert.equal(FEE_BREAKDOWN_SCHEMA, 'tradebot.dashboard.fees-breakdown/v1');
});

test('fee-breakdown: DEFAULT_LP_FEE_RATE_BPS = 30 (cauldron typical)', () => {
  assert.equal(DEFAULT_LP_FEE_RATE_BPS, 30);
});

test('fee-breakdown: severity thresholds are ordered red > amber > 0', () => {
  assert.equal(SLIPPAGE_RED_THRESHOLD, 0.5);
  assert.equal(SLIPPAGE_AMBER_THRESHOLD, 0.25);
  assert.ok(SLIPPAGE_RED_THRESHOLD > SLIPPAGE_AMBER_THRESHOLD);
  assert.ok(SLIPPAGE_AMBER_THRESHOLD > 0);
});

test('fee-breakdown: FeeBreakdownArgError carries kind + value', () => {
  const e = new FeeBreakdownArgError('test message', { kind: 'events_not_array', value: 'string' });
  assert.equal(e.name, 'FeeBreakdownArgError');
  assert.equal(e.kind, 'events_not_array');
  assert.equal(e.value, 'string');
  assert.ok(e instanceof Error);
});

// ─────────────────────────────────────────────────────────────────────
// 2. Conversion helpers
// ─────────────────────────────────────────────────────────────────────

test('fee-breakdown: toSatsBigInt handles null / undefined / strings / numbers / floats / NaN / Infinity', () => {
  assert.equal(toSatsBigInt(null), null);
  assert.equal(toSatsBigInt(undefined), null);
  assert.equal(toSatsBigInt(0), 0n);
  assert.equal(toSatsBigInt(100), 100n);
  assert.equal(toSatsBigInt('500000'), 500000n);
  assert.equal(toSatsBigInt(NaN), null);
  assert.equal(toSatsBigInt(Infinity), null);
  assert.equal(toSatsBigInt(-Infinity), null);
  assert.equal(toSatsBigInt('abc'), null);
  assert.equal(toSatsBigInt('500000.5'), null);
  assert.equal(toSatsBigInt(500000.5), null);
  assert.equal(toSatsBigInt(100.5), null);
  assert.equal(toSatsBigInt('  -42  '), -42n);
  assert.equal(toSatsBigInt({}), null);
  assert.equal(toSatsBigInt([]), null);
});

test('fee-breakdown: safeBigFloat handles null / overflow / valid', () => {
  assert.equal(safeBigFloat(null), null);
  assert.equal(safeBigFloat(undefined), null);
  assert.equal(safeBigFloat(0n), 0);
  assert.equal(safeBigFloat(100n), 100);
  assert.equal(safeBigFloat(1_500_000n), 1_500_000);
  assert.equal(safeBigFloat(BigInt(Number.MAX_SAFE_INTEGER) - 1n), Number.MAX_SAFE_INTEGER - 1);
  assert.equal(safeBigFloat(BigInt(Number.MAX_SAFE_INTEGER) + 100n), null);
  assert.equal(safeBigFloat(-(BigInt(Number.MAX_SAFE_INTEGER) + 1n)), null);
});

// ─────────────────────────────────────────────────────────────────────
// 3. Per-position helpers
// ─────────────────────────────────────────────────────────────────────

test('fee-breakdown: txFeesForPosition sums entry + exit fee_sats', () => {
  assert.equal(txFeesForPosition({ entry: { fee_sats: 2285 } }, null), 2285n);
  assert.equal(txFeesForPosition({ entry: { fee_sats: 2285 } }, { fee_sats: 2705 }), 4990n);
  assert.equal(txFeesForPosition({ entry: { fee_sats: '2285' } }, { fee_sats: '2705' }), 4990n);
  assert.equal(txFeesForPosition({ entry: {} }, null), null);
  assert.equal(txFeesForPosition(null, null), null);
  assert.equal(txFeesForPosition({ entry: { fee_sats: null } }, { fee_sats: null }), null);
  // Missing exit on an open position → entry only.
  assert.equal(txFeesForPosition({ entry: { fee_sats: 1000 } }), 1000n);
});

test('fee-breakdown: lpFeesForPosition computes fee_rate_bps × amount / 10000', () => {
  // 30 bps × 496939 sats = 1490.817 → 1490
  assert.equal(
    lpFeesForPosition({ entry: { bch_spent_sats: 496939 } }, null, { fee_rate_bps: 30 }),
    1490n,
  );
  // 30 bps × 502231 sats = 1506.693 → 1506
  const res = lpFeesForPosition(
    { entry: { bch_spent_sats: 496939 } },
    { bch_received_sats: 502231 },
    { fee_rate_bps: 30 },
  );
  assert.equal(res, 2996n);
  // Custom fee rate override. 100 bps × 100_000_000 sats = 1_000_000.
  assert.equal(
    lpFeesForPosition({ entry: { bch_spent_sats: 100_000_000 } }, null, { fee_rate_bps: 100 }),
    1_000_000n,
  );
});

test('fee-breakdown: lpFeesForPosition returns null when amount missing', () => {
  // No entry / no exit amount → null (no position to attribute fees to).
  assert.equal(lpFeesForPosition({ entry: {} }, null), null);
  assert.equal(lpFeesForPosition(null, null), null);
});

test('fee-breakdown: lpFeesForPosition clamps negative fee_rate_bps to 0', () => {
  // Negative fee rate clamps to 0n (defensive — negative fees make no economic sense).
  assert.equal(
    lpFeesForPosition({ entry: { bch_spent_sats: 100_000 } }, null, { fee_rate_bps: -10 }),
    0n,
  );
});

test('fee-breakdown: lpFeesForPosition falls back to default when fee_rate_bps is garbage', () => {
  // Garbage fee rate falls back to default 30.
  assert.equal(
    lpFeesForPosition({ entry: { bch_spent_sats: 100_000 } }, null, { fee_rate_bps: 'abc' }),
    300n,
  );
  // null fee rate falls back to default 30.
  assert.equal(
    lpFeesForPosition({ entry: { bch_spent_sats: 100_000 } }, null, { fee_rate_bps: null }),
    300n,
  );
});

test('fee-breakdown: slippageCostForPosition uses |slippage_bps| × amount / 10000', () => {
  // 33 bps × 496939 sats = 1639.9 → 1639
  assert.equal(
    slippageCostForPosition({ entry: { bch_spent_sats: 496939, slippage_bps: '33' } }, null),
    1639n,
  );
  // Favorable (negative) still counts.
  assert.equal(
    slippageCostForPosition({ entry: { bch_spent_sats: 100_000, slippage_bps: '-50' } }, null),
    500n,
  );
  // No slippage data → 0n
  assert.equal(slippageCostForPosition({ entry: { bch_spent_sats: 100_000 } }, null), 0n);
  // Both legs.
  assert.equal(
    slippageCostForPosition(
      { entry: { bch_spent_sats: 100_000, slippage_bps: '20' } },
      { bch_received_sats: 50_000, slippage_bps: '40' },
    ),
    400n,
  );
});

test('fee-breakdown: slippageCostForPosition treats -9999 / -10000 / >=9999 as sentinels (returns 0n)', () => {
  // -9999 sentinel: cauldron-swap-sdk "no data".
  assert.equal(
    slippageCostForPosition({ entry: { bch_spent_sats: 100_000, slippage_bps: '-9999' } }, null),
    0n,
  );
  // -10000 sentinel: degenerate rate=0 case.
  assert.equal(
    slippageCostForPosition({ entry: { bch_spent_sats: 100_000, slippage_bps: '-10000' } }, null),
    0n,
  );
  // Positive 9999 also sentinel (shouldn't happen but defensive).
  assert.equal(
    slippageCostForPosition({ entry: { bch_spent_sats: 100_000, slippage_bps: '9999' } }, null),
    0n,
  );
  // Real high slippage like 500 bps still works.
  assert.equal(
    slippageCostForPosition({ entry: { bch_spent_sats: 100_000, slippage_bps: '500' } }, null),
    5000n,
  );
});

test('fee-breakdown: signedSlippageBpsForPosition returns the SIGNED sum', () => {
  assert.equal(
    signedSlippageBpsForPosition({ entry: { slippage_bps: '33' } }, null),
    33n,
  );
  assert.equal(
    signedSlippageBpsForPosition({ entry: { slippage_bps: '-5' } }, { slippage_bps: '12' }),
    7n,
  );
  // Sentinels normalize to 0n (still signed, just 0).
  assert.equal(
    signedSlippageBpsForPosition({ entry: { slippage_bps: '-9999' } }, null),
    0n,
  );
  // No data → null.
  assert.equal(signedSlippageBpsForPosition({ entry: {} }, null), null);
});

test('fee-breakdown: feesTotalForPosition sums tx + lp + slip', () => {
  const pos = { entry: { fee_sats: 2285, bch_spent_sats: 496939, slippage_bps: '33' } };
  const exit = { fee_sats: 2705, bch_received_sats: 502231, slippage_bps: '12' };
  // tx = 2285 + 2705 = 4990
  // lp = 30 × 496939 / 10000 + 30 × 502231 / 10000 = 1490 + 1506 = 2996
  // slip = 33 × 496939 / 10000 + 12 × 502231 / 10000 = 1639 + 602 = 2241
  // total = 4990 + 2996 + 2241 = 10227
  assert.equal(feesTotalForPosition(pos, exit, { fee_rate_bps: 30 }), 10227n);
});

test('fee-breakdown: feesTotalForPosition returns null when all three are null', () => {
  // Position with no fee data → null.
  assert.equal(feesTotalForPosition({}, null), null);
  assert.equal(feesTotalForPosition(null, null), null);
});

test('fee-breakdown: per-position helpers do NOT throw on null inputs', () => {
  // The dashboard calls these on every position — never throw.
  assert.doesNotThrow(() => txFeesForPosition(null, null));
  assert.doesNotThrow(() => lpFeesForPosition(null, null));
  assert.doesNotThrow(() => slippageCostForPosition(null, null));
  assert.doesNotThrow(() => feesTotalForPosition(null, null));
  assert.doesNotThrow(() => signedSlippageBpsForPosition(null, null));
});

// ─────────────────────────────────────────────────────────────────────
// 4. Per-trade attribution
// ─────────────────────────────────────────────────────────────────────

test('fee-breakdown: attributionForPositionWithFees emits the full envelope', () => {
  const pos = { id: 'pos_x', token_id: 'tok_y', entry: { ts: '2026-09-18T00:00:00Z', fee_sats: 2285, bch_spent_sats: 496939, slippage_bps: '33' } };
  const exit = { ts: '2026-09-19T00:00:00Z', exit_kind: 'time_stop', fee_sats: 2705, bch_received_sats: 502231, slippage_bps: '12' };
  const a = attributionForPositionWithFees(pos, exit, { fee_rate_bps: 30 });
  assert.equal(a.position_id, 'pos_x');
  assert.equal(a.token_id, 'tok_y');
  assert.equal(a.exit_kind, 'time_stop');
  assert.equal(a.is_open, false);
  assert.equal(a.fee_rate_bps, 30n);
  assert.equal(a.tx_fees_sats_entry, 2285n);
  assert.equal(a.tx_fees_sats_exit, 2705n);
  assert.equal(a.tx_fees_sats_total, 4990n);
  assert.equal(a.lp_fees_sats_entry, 1490n);
  assert.equal(a.lp_fees_sats_exit, 1506n);
  assert.equal(a.lp_fees_sats_total, 2996n);
  assert.equal(a.slippage_cost_sats_entry, 1639n);
  assert.equal(a.slippage_cost_sats_exit, 602n);
  assert.equal(a.slippage_cost_sats_total, 2241n);
  assert.equal(a.fees_paid_sats_total, 10227n);
  assert.equal(a.entry_amount_sats, 496939n);
  assert.equal(a.exit_amount_sats, 502231n);
  assert.equal(a.entry_slippage_bps, 33n);
  assert.equal(a.exit_slippage_bps, 12n);
  assert.equal(a.slippage_signed_bps, 45n);
});

test('fee-breakdown: attributionForPositionWithFees is_open=true when no exit event', () => {
  const pos = { id: 'pos_o', token_id: 'tok_o', entry: { ts: '2026-09-18T00:00:00Z', fee_sats: 2285, bch_spent_sats: 496939 } };
  const a = attributionForPositionWithFees(pos, null);
  assert.equal(a.is_open, true);
  assert.equal(a.exit_ts, null);
  assert.equal(a.exit_kind, null);
  assert.equal(a.tx_fees_sats_exit, null);
  assert.equal(a.tx_fees_sats_total, 2285n);
  assert.equal(a.exit_amount_sats, null);
  assert.equal(a.exit_slippage_bps, null);
});

test('fee-breakdown: attributionForPositionWithFees falls back to fee_rate_bps default when opts missing', () => {
  const pos = { id: 'pos_d', token_id: 'tok_d', entry: { ts: '2026-09-18T00:00:00Z', fee_sats: 0, bch_spent_sats: 100_000_000 } };
  const a = attributionForPositionWithFees(pos, null); // no opts → default 30
  assert.equal(a.fee_rate_bps, 30n);
  assert.equal(a.lp_fees_sats_entry, 300_000n); // 30 bps × 1 BCH
  assert.equal(a.lp_fees_sats_total, 300_000n);
});

// ─────────────────────────────────────────────────────────────────────
// 5. By-kind + rollups
// ─────────────────────────────────────────────────────────────────────

test('fee-breakdown: pickByKind separates entry vs exit legs', () => {
  const attributions = [
    {
      tx_fees_sats_entry: 2285n, tx_fees_sats_exit: 2705n, tx_fees_sats_total: 4990n,
      lp_fees_sats_entry: 1490n, lp_fees_sats_exit: 1506n, lp_fees_sats_total: 2996n,
      slippage_cost_sats_entry: 1639n, slippage_cost_sats_exit: 602n, slippage_cost_sats_total: 2241n,
      fees_paid_sats_total: 10227n,
      entry_amount_sats: 496939n, exit_amount_sats: 502231n,
      entry_slippage_bps: 33n, exit_slippage_bps: 12n,
      is_open: false,
    },
    {
      tx_fees_sats_entry: 3000n, tx_fees_sats_exit: null, tx_fees_sats_total: 3000n,
      lp_fees_sats_entry: 2000n, lp_fees_sats_exit: null, lp_fees_sats_total: 2000n,
      slippage_cost_sats_entry: 1000n, slippage_cost_sats_exit: null, slippage_cost_sats_total: 1000n,
      fees_paid_sats_total: 6000n,
      entry_amount_sats: 500_000n, exit_amount_sats: null,
      entry_slippage_bps: 20n, exit_slippage_bps: null,
      is_open: true,
    },
  ];
  const { entry, exit } = pickByKind(attributions);
  // Entry: 2285+3000=5285 tx; 1490+2000=3490 lp; 1639+1000=2639 slip.
  assert.equal(entry.tx_fees_sats, 5285n);
  assert.equal(entry.lp_fees_sats, 3490n);
  assert.equal(entry.slippage_cost_sats, 2639n);
  assert.equal(entry.amount_sats, 996939n);
  assert.equal(entry.slippage_signed_bps, 53n);
  assert.equal(entry.trade_count, 2);
  // Exit: only the closed position contributes.
  assert.equal(exit.tx_fees_sats, 2705n);
  assert.equal(exit.lp_fees_sats, 1506n);
  assert.equal(exit.slippage_cost_sats, 602n);
  assert.equal(exit.amount_sats, 502231n);
  assert.equal(exit.slippage_signed_bps, 12n);
  assert.equal(exit.trade_count, 1);
});

test('fee-breakdown: sharesFromTotals normalizes 0/1/3-component shares to sum=1', () => {
  assert.deepEqual(
    sharesFromTotals({ lp_fees_sats_total: 1500n, tx_fees_sats_total: 5000n, slippage_cost_sats_total: 3500n }),
    { lp_share: 0.15, tx_share: 0.5, slippage_share: 0.35 },
  );
  assert.deepEqual(
    sharesFromTotals({ lp_fees_sats_total: 0n, tx_fees_sats_total: 0n, slippage_cost_sats_total: 0n }),
    { lp_share: 0, tx_share: 0, slippage_share: 0 },
  );
  // Single component: 100% share.
  assert.deepEqual(
    sharesFromTotals({ lp_fees_sats_total: 0n, tx_fees_sats_total: 1000n, slippage_cost_sats_total: 0n }),
    { lp_share: 0, tx_share: 1, slippage_share: 0 },
  );
});

test('fee-breakdown: aggregateFeeTotals sums across the per-trade attributions', () => {
  const attributions = [
    { lp_fees_sats_total: 100n, tx_fees_sats_total: 200n, slippage_cost_sats_total: 300n, fees_paid_sats_total: 600n },
    { lp_fees_sats_total: 50n, tx_fees_sats_total: 75n, slippage_cost_sats_total: 125n, fees_paid_sats_total: 250n },
  ];
  const t = aggregateFeeTotals(attributions);
  assert.equal(t.trade_count, 2);
  assert.equal(t.lp_fees_sats_total, 150n);
  assert.equal(t.tx_fees_sats_total, 275n);
  assert.equal(t.slippage_cost_sats_total, 425n);
  assert.equal(t.fees_paid_sats_total, 850n);
});

test('fee-breakdown: aggregateFeeTotals handles empty + non-array input', () => {
  const t1 = aggregateFeeTotals([]);
  assert.equal(t1.trade_count, 0);
  assert.equal(t1.fees_paid_sats_total, 0n);
  const t2 = aggregateFeeTotals(null);
  assert.equal(t2.trade_count, 0);
});

// ─────────────────────────────────────────────────────────────────────
// 6. Per-token summary
// ─────────────────────────────────────────────────────────────────────

test('fee-breakdown: breakdownFeesForToken returns the full per-token envelope', () => {
  const events = [
    { kind: 'entry', ts: '2026-09-15T00:00:00Z', token_id: 'tok1', position_id: 'p1', fee_sats: 2285, bch_spent_sats: 496939, slippage_bps: '33' },
    { kind: 'exit', ts: '2026-09-16T00:00:00Z', token_id: 'tok1', position_id: 'p1', fee_sats: 2705, bch_received_sats: 502231, slippage_bps: '12' },
    { kind: 'entry', ts: '2026-09-17T00:00:00Z', token_id: 'tok2', position_id: 'p2', fee_sats: 1000, bch_spent_sats: 100_000 },
  ];
  const positions = [
    { id: 'p1', token_id: 'tok1', token_symbol: 'ABC', token_decimals: 2, entry: { ts: '2026-09-15T00:00:00Z', fee_sats: 2285, bch_spent_sats: 496939, slippage_bps: '33' }, exit: { ts: '2026-09-16T00:00:00Z', fee_sats: 2705, bch_received_sats: 502231, slippage_bps: '12' } },
    { id: 'p2', token_id: 'tok2', token_symbol: 'XYZ', entry: { ts: '2026-09-17T00:00:00Z', fee_sats: 1000, bch_spent_sats: 100_000 } },
  ];
  const s = breakdownFeesForToken({ events, positions, tokenId: 'tok1' });
  assert.equal(s.schema, FEE_BREAKDOWN_SCHEMA);
  assert.equal(s.token_id, 'tok1');
  assert.equal(s.symbol, 'ABC');
  assert.equal(s.decimals, 2);
  assert.equal(s.trade_count, 1);
  assert.equal(s.fee_rate_bps, 30n);
  assert.equal(s.tx_fees_sats_total, 4990n);
  assert.equal(s.lp_fees_sats_total, 2996n);
  assert.equal(s.slippage_cost_sats_total, 2241n);
  assert.equal(s.fees_paid_sats_total, 10227n);
  // Shares sum to ~1.
  assert.ok(Math.abs(s.lp_share + s.tx_share + s.slippage_share - 1.0) < 1e-5);
  // by_kind split: entry-only side has the tx_fees_sats_entry from p1.
  assert.equal(s.by_kind.entry.tx_fees_sats, 2285n);
  assert.equal(s.by_kind.entry.trade_count, 1);
  assert.equal(s.by_kind.exit.tx_fees_sats, 2705n);
  assert.equal(s.by_kind.exit.trade_count, 1);
  // trades[] has one attribution (the closed position).
  assert.equal(s.trades.length, 1);
  assert.equal(s.trades[0].position_id, 'p1');
  assert.equal(s.trades[0].is_open, false);
});

test('fee-breakdown: breakdownFeesForToken handles open-only positions', () => {
  const positions = [
    { id: 'p3', token_id: 'tok3', token_symbol: 'DEF', entry: { ts: '2026-09-18T00:00:00Z', fee_sats: 1500, bch_spent_sats: 200_000 } },
  ];
  const s = breakdownFeesForToken({ events: [], positions, tokenId: 'tok3' });
  assert.equal(s.trade_count, 1);
  assert.equal(s.symbol, 'DEF');
  assert.equal(s.tx_fees_sats_total, 1500n);
  // LP fees: 30 bps × 200_000 = 600.
  assert.equal(s.lp_fees_sats_total, 600n);
  assert.equal(s.slippage_cost_sats_total, 0n);
  // Open positions have no exit side.
  assert.equal(s.by_kind.exit.trade_count, 0);
  assert.equal(s.by_kind.entry.trade_count, 1);
});

test('fee-breakdown: breakdownFeesForToken throws FeeBreakdownArgError on bad input', () => {
  assert.throws(() => breakdownFeesForToken({ events: 'not-an-array', positions: [], tokenId: 't' }), FeeBreakdownArgError);
  assert.throws(() => breakdownFeesForToken({ events: [], positions: 'oops', tokenId: 't' }), FeeBreakdownArgError);
  assert.throws(() => breakdownFeesForToken({ events: [], positions: [], tokenId: '' }), FeeBreakdownArgError);
  assert.throws(() => breakdownFeesForToken({ events: [], positions: [], tokenId: null }), FeeBreakdownArgError);
});

// ─────────────────────────────────────────────────────────────────────
// 7. Cross-token rollup
// ─────────────────────────────────────────────────────────────────────

test('fee-breakdown: breakdownFeesAcrossTokens sorts by fees_paid_sats_total DESC', () => {
  const events = [
    { kind: 'entry', ts: '2026-09-15T00:00:00Z', token_id: 'tok_a', position_id: 'pa', fee_sats: 5000, bch_spent_sats: 100_000 },
    { kind: 'entry', ts: '2026-09-16T00:00:00Z', token_id: 'tok_b', position_id: 'pb', fee_sats: 1000, bch_spent_sats: 10_000 },
  ];
  const positions = [
    { id: 'pa', token_id: 'tok_a', token_symbol: 'AAA', entry: { ts: '2026-09-15T00:00:00Z', fee_sats: 5000, bch_spent_sats: 100_000 } },
    { id: 'pb', token_id: 'tok_b', token_symbol: 'BBB', entry: { ts: '2026-09-16T00:00:00Z', fee_sats: 1000, bch_spent_sats: 10_000 } },
  ];
  const rollup = breakdownFeesAcrossTokens({ events, positions });
  assert.equal(rollup.count, 2);
  // tok_a has higher fees → first.
  assert.equal(rollup.tokens[0].token_id, 'tok_a');
  assert.equal(rollup.tokens[1].token_id, 'tok_b');
  // Rollup rows have no `trades[]` (kept off the wire).
  assert.equal(rollup.tokens[0].trades, undefined);
  // Cross-token totals: aggregate.
  assert.ok(rollup.totals.trade_count === 2);
  assert.equal(rollup.totals.tx_fees_sats_total, 6000n);
  assert.equal(rollup.totals.lp_fees_sats_total, 330n); // 300 + 30
});

test('fee-breakdown: breakdownFeesAcrossTokens returns empty rollup when no tokens', () => {
  const rollup = breakdownFeesAcrossTokens({ events: [], positions: [] });
  assert.equal(rollup.count, 0);
  assert.deepEqual(rollup.tokens, []);
  assert.equal(rollup.totals.trade_count, 0);
  assert.equal(rollup.totals.fees_paid_sats_total, 0n);
});

test('fee-breakdown: breakdownFeesAcrossTokens throws on bad input', () => {
  assert.throws(() => breakdownFeesAcrossTokens({ events: 'no', positions: [] }), FeeBreakdownArgError);
  assert.throws(() => breakdownFeesAcrossTokens({ events: [], positions: {} }), FeeBreakdownArgError);
});

// ─────────────────────────────────────────────────────────────────────
// 8. Real-data fixture check (integration)
// ─────────────────────────────────────────────────────────────────────

test('fee-breakdown: real-data rollup (data/history.jsonl + data/positions.json)', () => {
  const histPath = path.join(REPO_ROOT, 'data', 'history.jsonl');
  const posPath = path.join(REPO_ROOT, 'data', 'positions.json');
  if (!fs.existsSync(histPath) || !fs.existsSync(posPath)) {
    // Skip on CI without the live data fixture.
    return;
  }
  const events = fs.readFileSync(histPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const pos = JSON.parse(fs.readFileSync(posPath, 'utf8'));
  const all = [...(pos.open ?? []), ...(pos.closed ?? [])];
  const rollup = breakdownFeesAcrossTokens({ events, positions: all });
  assert.ok(rollup.count >= 1, 'should have at least one token');
  // Every row has the schema, valid bigint totals, and shares summing to ~1.
  for (const row of rollup.tokens) {
    assert.equal(row.fee_rate_bps, 30n);
    assert.ok(typeof row.fees_paid_sats_total === 'bigint');
    assert.ok(row.fees_paid_sats_total >= 0n);
    const sumShares = row.lp_share + row.tx_share + row.slippage_share;
    assert.ok(Math.abs(sumShares - 1.0) < 1e-3 || sumShares === 0, `row ${row.token_id} shares sum=${sumShares}`);
  }
  // Per-token detail endpoint smoke.
  if (rollup.tokens.length > 0) {
    const tid = rollup.tokens[0].token_id;
    const detail = breakdownFeesForToken({ events, positions: all, tokenId: tid });
    assert.equal(detail.token_id, tid);
    assert.ok(detail.trades.length >= 1);
  }
});
