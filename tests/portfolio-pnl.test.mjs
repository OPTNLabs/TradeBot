#!/usr/bin/env node
/**
 * Unit tests for src/portfolio/pnl.mjs.
 *
 * Pure-function tests. No I/O. The position fixtures mirror the
 * shape produced by `src/portfolio/positions.mjs` so a position
 * recorded by the trader loop flows through P&L unchanged.
 *
 * Run via:
 *   node --test tests/portfolio-pnl.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  toSats,
  toPriceSats,
  realizedPnlSats,
  unrealizedPnlSats,
  realizedPnlSatsFromSettlement,
  holdTimeMs,
  summarize,
  summarizeByToken,
  bestAndWorst,
  DEFAULT_MAX_PRICE_RATIO,
  PnlConfigError,
} from '../src/portfolio/pnl.mjs';

// ─────────────────────────────────────────────────────────────────────
//  Fixtures
// ─────────────────────────────────────────────────────────────────────

/** A long_token position with 1M base units bought at 100 sats/unit. */
function longPosition(overrides = {}) {
  return {
    id: 'pos_test_0001',
    token_id: 'a'.repeat(64),
    token_symbol: 'FOO',
    side: 'long_token',
    entry: {
      txid: '11'.repeat(32),
      price_sats_per_token: 100,
      bch_spent_sats: 100_000_000, // 1 BCH
      token_amount_base: 1_000_000,
      fee_sats: 1_000,
      ts: '2026-09-10T00:00:00.000Z',
    },
    opened_at: '2026-09-10T00:00:00.000Z',
    status: 'open',
    ...overrides,
  };
}

// ============================================================
// toSats
// ============================================================

test('toSats: accepts bigint / number / string', () => {
  assert.equal(toSats(100n), 100n);
  assert.equal(toSats(100), 100n);
  assert.equal(toSats('100'), 100n);
  assert.equal(toSats(0), 0n);
});

test('toSats: rounds float to nearest integer', () => {
  assert.equal(toSats(100.4), 100n);
  assert.equal(toSats(100.6), 101n);
});

test('toSats: returns null for missing / non-numeric', () => {
  assert.equal(toSats(null), null);
  assert.equal(toSats(undefined), null);
  assert.equal(toSats(NaN), null);
  assert.equal(toSats(Infinity), null);
  assert.equal(toSats(-Infinity), null);
  assert.equal(toSats(''), null);
  assert.equal(toSats('not a number'), null);
  assert.equal(toSats({}), null);
  assert.equal(toSats([]), null);
});

test('toSats: negative values return null (defensive — not a real sats amount)', () => {
  assert.equal(toSats(-1), null);
  assert.equal(toSats(-1n), null);
  assert.equal(toSats('-1'), null);
});

// ============================================================
// toPriceSats — same policy as toSats
// ============================================================

test('toPriceSats: passes through bigint', () => {
  assert.equal(toPriceSats(50n), 50n);
});

test('toPriceSats: returns null for negatives (price is never negative)', () => {
  assert.equal(toPriceSats(-10), null);
});

// ============================================================
// realizedPnlSats
// ============================================================

test('realizedPnlSats: profit on exit (BCH received > BCH spent)', () => {
  const pos = longPosition();
  const exit = { bch_received_sats: 110_000_000, fee_sats: 1_500 };
  const { gross, net, entry_fee_sats, exit_fee_sats } = realizedPnlSats(pos, exit);
  assert.equal(gross, 10_000_000n);
  assert.equal(net, 10_000_000n - 1_000n - 1_500n);
  assert.equal(entry_fee_sats, 1_000n);
  assert.equal(exit_fee_sats, 1_500n);
});

test('realizedPnlSats: loss on exit (BCH received < BCH spent)', () => {
  const pos = longPosition();
  const exit = { bch_received_sats: 95_000_000, fee_sats: 500 };
  const { gross, net } = realizedPnlSats(pos, exit);
  assert.equal(gross, -5_000_000n);
  assert.equal(net, -5_000_000n - 1_000n - 500n);
});

test('realizedPnlSats: breakeven (BCH received == BCH spent, fees exactly eat profit)', () => {
  const pos = longPosition();
  const exit = { bch_received_sats: 100_000_000, fee_sats: 1_000 };
  const { gross, net } = realizedPnlSats(pos, exit);
  assert.equal(gross, 0n);
  assert.equal(net, -2_000n);
});

test('realizedPnlSats: returns null on missing entry cost', () => {
  const pos = { entry: {}, opened_at: '2026-09-10T00:00:00.000Z' };
  const exit = { bch_received_sats: 100n };
  const { gross, net } = realizedPnlSats(pos, exit);
  assert.equal(gross, null);
  assert.equal(net, null);
});

test('realizedPnlSats: returns null on missing exit received', () => {
  const pos = longPosition();
  const exit = {};
  const { gross, net } = realizedPnlSats(pos, exit);
  assert.equal(gross, null);
  assert.equal(net, null);
});

test('realizedPnlSats: tolerates bch_spent / bch_received field aliases', () => {
  const pos = { entry: { bch_spent: 100n, fee_sats: 1n }, opened_at: '2026-09-10T00:00:00.000Z' };
  const exit = { bch_received: 200n, fee_sats: 1n };
  const { gross, net } = realizedPnlSats(pos, exit);
  assert.equal(gross, 100n);
  assert.equal(net, 98n);
});

test('realizedPnlSats: throws PnlConfigError on missing args', () => {
  assert.throws(() => realizedPnlSats(null, {}), PnlConfigError);
  assert.throws(() => realizedPnlSats({}, null), PnlConfigError);
});

// ============================================================
// unrealizedPnlSats
// ============================================================

test('unrealizedPnlSats: profit when market price > entry price', () => {
  const pos = longPosition();
  // 1M base units * 110 sats/unit = 110M sats. Entry spent 100M. Gross = +10M.
  const { gross, net, pct } = unrealizedPnlSats(pos, 110n, 500n);
  assert.equal(gross, 10_000_000n);
  assert.equal(net, 10_000_000n - 1_000n - 500n);
  // Net / entrySpent = (10M - 1500) / 100M = 0.099985 → pct ≈ 9.9985%
  assert.ok(pct !== null);
  assert.ok(Math.abs(pct - 0.099985) < 1e-9, `pct was ${pct}`);
});

test('unrealizedPnlSats: loss when market price < entry price', () => {
  const pos = longPosition();
  const { gross, net, pct } = unrealizedPnlSats(pos, 90n);
  assert.equal(gross, -10_000_000n);
  assert.equal(net, -10_000_000n - 1_000n);
  assert.ok(pct !== null);
  assert.ok(pct < 0);
});

test('unrealizedPnlSats: null on missing market price', () => {
  const pos = longPosition();
  const { gross, net, pct } = unrealizedPnlSats(pos, null);
  assert.equal(gross, null);
  assert.equal(net, null);
  assert.equal(pct, null);
});

test('unrealizedPnlSats: null on missing entry cost', () => {
  const pos = { entry: { token_amount_base: 1_000_000 }, opened_at: '2026-09-10T00:00:00.000Z' };
  const { gross, net, pct } = unrealizedPnlSats(pos, 100n);
  assert.equal(gross, null);
  assert.equal(net, null);
  assert.equal(pct, null);
});

test('unrealizedPnlSats: pct is null when entrySpent is 0', () => {
  const pos = longPosition({ entry: { ...longPosition().entry, bch_spent_sats: 0 } });
  const { gross, pct } = unrealizedPnlSats(pos, 100n);
  assert.equal(gross, 100_000_000n);
  assert.equal(pct, null);
});

test('unrealizedPnlSats: tolerates bigint / number price input', () => {
  const pos = longPosition();
  const r1 = unrealizedPnlSats(pos, 110);
  const r2 = unrealizedPnlSats(pos, 110n);
  assert.equal(r1.gross, r2.gross);
  assert.equal(r1.net, r2.net);
});

test('unrealizedPnlSats: throws PnlConfigError on missing position', () => {
  assert.throws(() => unrealizedPnlSats(null, 100n), PnlConfigError);
});

// ============================================================
// realizedPnlSatsFromSettlement
// ============================================================

test('realizedPnlSatsFromSettlement: profit on settlement', () => {
  const r = realizedPnlSatsFromSettlement({
    entryBchSpentSats: 100_000_000n,
    exitBchReceivedSats: 110_000_000n,
    totalFeeSats: 2_000n,
  });
  assert.equal(r, 9_998_000n);
});

test('realizedPnlSatsFromSettlement: loss on settlement', () => {
  const r = realizedPnlSatsFromSettlement({
    entryBchSpentSats: 100_000_000n,
    exitBchReceivedSats: 95_000_000n,
    totalFeeSats: 1_500n,
  });
  assert.equal(r, -5_001_500n);
});

test('realizedPnlSatsFromSettlement: returns null on missing fields', () => {
  assert.equal(realizedPnlSatsFromSettlement({ entryBchSpentSats: 100n }), null);
  assert.equal(realizedPnlSatsFromSettlement({ exitBchReceivedSats: 100n }), null);
  assert.equal(realizedPnlSatsFromSettlement({ entryBchSpentSats: 100n, exitBchReceivedSats: null }), null);
});

test('realizedPnlSatsFromSettlement: coerces number / string to bigint', () => {
  const r = realizedPnlSatsFromSettlement({
    entryBchSpentSats: 100,
    exitBchReceivedSats: '200',
    totalFeeSats: 10,
  });
  assert.equal(r, 90n);
});

// ============================================================
// holdTimeMs
// ============================================================

test('holdTimeMs: closed position — closedAt - openedAt', () => {
  const pos = {
    opened_at: '2026-09-10T00:00:00.000Z',
    closed_at: '2026-09-11T00:00:00.000Z',
  };
  assert.equal(holdTimeMs(pos), 86_400_000);
});

test('holdTimeMs: open position — nowMs - openedAt', () => {
  const opened = '2026-09-10T00:00:00.000Z';
  const pos = { opened_at: opened };
  const nowMs = Date.parse('2026-09-10T12:00:00.000Z');
  assert.equal(holdTimeMs(pos, nowMs), 43_200_000);
});

test('holdTimeMs: returns null when opened_at is missing / unparseable', () => {
  assert.equal(holdTimeMs({}), null);
  assert.equal(holdTimeMs({ opened_at: 'not a date' }), null);
  assert.equal(holdTimeMs(null), null);
});

test('holdTimeMs: returns null when closed_at is earlier than opened_at', () => {
  const pos = {
    opened_at: '2026-09-11T00:00:00.000Z',
    closed_at: '2026-09-10T00:00:00.000Z',
  };
  assert.equal(holdTimeMs(pos), null);
});

// ============================================================
// summarize
// ============================================================

test('summarize: empty input returns zeros', () => {
  const s = summarize([]);
  assert.equal(s.count, 0);
  assert.equal(s.wins, 0);
  assert.equal(s.losses, 0);
  assert.equal(s.breakeven, 0);
  assert.equal(s.win_rate_pct, 0);
  assert.equal(s.realized_pnl_sats, 0n);
  assert.equal(s.realized_pnl_bch, 0);
  assert.equal(s.total_fees_sats, 0n);
  assert.equal(s.total_fees_bch, 0);
  assert.equal(s.mean_hold_ms, null);
  assert.equal(s.best_trade_sats, null);
  assert.equal(s.worst_trade_sats, null);
  assert.equal(s.pct_return, null);
});

test('summarize: rolls up wins / losses / breakeven / fees / hold time', () => {
  const closed = [
    {
      opened_at: '2026-09-10T00:00:00.000Z',
      closed_at: '2026-09-11T00:00:00.000Z', // 86_400_000 ms
      entry: { bch_spent_sats: 100_000_000, fee_sats: 1_000 },
      exit: { bch_received_sats: 110_000_000, fee_sats: 2_000 }, // +9_997_000 net
    },
    {
      opened_at: '2026-09-10T00:00:00.000Z',
      closed_at: '2026-09-10T06:00:00.000Z', // 21_600_000 ms
      entry: { bch_spent_sats: 50_000_000, fee_sats: 500 },
      exit: { bch_received_sats: 45_000_000, fee_sats: 1_000 }, // -5_001_500 net
    },
    {
      opened_at: '2026-09-10T00:00:00.000Z',
      closed_at: '2026-09-10T12:00:00.000Z', // 43_200_000 ms
      entry: { bch_spent_sats: 200_000_000, fee_sats: 0 },
      exit: { bch_received_sats: 200_000_000, fee_sats: 0 }, // 0 net
    },
  ];
  const s = summarize(closed);
  assert.equal(s.count, 3);
  assert.equal(s.wins, 1);
  assert.equal(s.losses, 1);
  assert.equal(s.breakeven, 1);
  assert.equal(s.win_rate_pct, (1 / 3) * 100);
  assert.equal(s.realized_pnl_sats, 9_997_000n - 5_001_500n + 0n);
  assert.equal(s.total_fees_sats, 1_000n + 2_000n + 500n + 1_000n + 0n + 0n);
  // Mean hold time across 3 trades = (86.4M + 21.6M + 43.2M) / 3
  assert.equal(s.mean_hold_ms, (86_400_000 + 21_600_000 + 43_200_000) / 3);
  assert.equal(s.best_trade_sats, 9_997_000n);
  assert.equal(s.worst_trade_sats, -5_001_500n);
  // pct_return = (net / totalEntrySpent). Total entry spent = 100M + 50M + 200M = 350M.
  // net = 4_995_500. pct = 4_995_500 / 350_000_000 * 100 ≈ 1.4272857142857143%
  assert.ok(s.pct_return !== null);
  assert.ok(Math.abs(s.pct_return - 1.4272857142857143) < 1e-6);
});

test('summarize: realized_pnl_bch matches sats / SATS_PER_BCH', () => {
  const closed = [
    {
      opened_at: '2026-09-10T00:00:00.000Z',
      closed_at: '2026-09-10T01:00:00.000Z',
      entry: { bch_spent_sats: 100_000_000, fee_sats: 0 },
      exit: { bch_received_sats: 100_500_000, fee_sats: 0 },
    },
  ];
  const s = summarize(closed);
  assert.equal(s.realized_pnl_sats, 500_000n);
  assert.equal(s.realized_pnl_bch, 0.005);
});

test('summarize: skips positions with null P&L without crashing', () => {
  const closed = [
    { opened_at: '2026-09-10T00:00:00.000Z', entry: {}, exit: {} },
    longPosition(), // open — won't be included anyway
  ];
  const s = summarize(closed);
  assert.equal(s.count, 0);
});

test('summarize: tolerates non-array input', () => {
  const s = summarize(null);
  assert.equal(s.count, 0);
});

// ============================================================
// summarizeByToken
// ============================================================

test('summarizeByToken: groups by token_id', () => {
  const closed = [
    {
      token_id: 'a'.repeat(64),
      opened_at: '2026-09-10T00:00:00.000Z',
      closed_at: '2026-09-10T01:00:00.000Z',
      entry: { bch_spent_sats: 100_000_000, fee_sats: 0 },
      exit: { bch_received_sats: 110_000_000, fee_sats: 0 },
    },
    {
      token_id: 'a'.repeat(64),
      opened_at: '2026-09-10T00:00:00.000Z',
      closed_at: '2026-09-10T02:00:00.000Z',
      entry: { bch_spent_sats: 50_000_000, fee_sats: 0 },
      exit: { bch_received_sats: 40_000_000, fee_sats: 0 },
    },
    {
      token_id: 'b'.repeat(64),
      opened_at: '2026-09-10T00:00:00.000Z',
      closed_at: '2026-09-10T03:00:00.000Z',
      entry: { bch_spent_sats: 25_000_000, fee_sats: 0 },
      exit: { bch_received_sats: 30_000_000, fee_sats: 0 },
    },
  ];
  const byTok = summarizeByToken(closed);
  const aId = 'a'.repeat(64);
  const bId = 'b'.repeat(64);
  assert.equal(byTok[aId].count, 2);
  assert.equal(byTok[aId].wins, 1);
  assert.equal(byTok[aId].losses, 1);
  assert.equal(byTok[aId].realized_pnl_sats, 10_000_000n - 10_000_000n);
  assert.equal(byTok[bId].count, 1);
  assert.equal(byTok[bId].wins, 1);
  assert.equal(byTok[bId].realized_pnl_sats, 5_000_000n);
});

test('summarizeByToken: empty input → empty map', () => {
  assert.deepEqual(summarizeByToken([]), {});
  assert.deepEqual(summarizeByToken(null), {});
});

// ============================================================
// bestAndWorst
// ============================================================

test('bestAndWorst: returns the highest / lowest net P&L positions', () => {
  const win = {
    id: 'pos_win',
    opened_at: '2026-09-10T00:00:00.000Z',
    closed_at: '2026-09-10T01:00:00.000Z',
    entry: { bch_spent_sats: 100_000_000, fee_sats: 0 },
    exit: { bch_received_sats: 120_000_000, fee_sats: 0 },
  };
  const loss = {
    id: 'pos_loss',
    opened_at: '2026-09-10T00:00:00.000Z',
    closed_at: '2026-09-10T01:00:00.000Z',
    entry: { bch_spent_sats: 100_000_000, fee_sats: 0 },
    exit: { bch_received_sats: 90_000_000, fee_sats: 0 },
  };
  const { best, worst } = bestAndWorst([win, loss]);
  assert.equal(best.position.id, 'pos_win');
  assert.equal(best.pnl_sats, 20_000_000n);
  assert.equal(worst.position.id, 'pos_loss');
  assert.equal(worst.pnl_sats, -10_000_000n);
});

test('bestAndWorst: prefers computed pnl over stored fake-zero (orphan recovery)', () => {
  // The FEW orphan recovery set realized_pnl_sats=0 on disk to
  // unstick the bot. The helper must compute the true pnl from
  // raw values (-25192 sats loss) so the dashboard highlights the
  // FEW position as worst, not BADGER with -1811 sats.
  const fakeZero = {
    id: 'pos_few',
    token_symbol: 'FEW',
    closed_at: '2026-09-13T21:13:15.963Z',
    entry: { bch_spent_sats: 752_083, fee_sats: 6_600 },
    exit: { bch_received_sats: 740_091, fee_sats: 6_600, realized_pnl_sats: 0 },
  };
  const smallLoss = {
    id: 'pos_badger',
    token_symbol: 'BADGER',
    closed_at: '2026-09-14T06:18:08.953Z',
    entry: { bch_spent_sats: 205_215, fee_sats: 0 },
    exit: { bch_received_sats: 205_215, fee_sats: 1_811, realized_pnl_sats: -1_811 },
  };
  const { best, worst } = bestAndWorst([fakeZero, smallLoss]);
  // FEW (-25192) is the actual worst, BADGER (-1811) is the actual best.
  assert.equal(worst.position.id, 'pos_few');
  assert.equal(worst.pnl_sats, -25_192n);
  assert.equal(best.position.id, 'pos_badger');
  assert.equal(best.pnl_sats, -1_811n);
});

test('bestAndWorst: empty input → both null', () => {
  const { best, worst } = bestAndWorst([]);
  assert.equal(best, null);
  assert.equal(worst, null);
});

test('bestAndWorst: handles a single position', () => {
  const only = {
    id: 'pos_only',
    opened_at: '2026-09-10T00:00:00.000Z',
    closed_at: '2026-09-10T01:00:00.000Z',
    entry: { bch_spent_sats: 100_000_000, fee_sats: 0 },
    exit: { bch_received_sats: 100_000_000, fee_sats: 0 },
  };
  const { best, worst } = bestAndWorst([only]);
  assert.equal(best.position.id, 'pos_only');
  assert.equal(best.pnl_sats, 0n);
  assert.equal(worst.position.id, 'pos_only');
  assert.equal(worst.pnl_sats, 0n);
});

// ============================================================
// T28e: price-vs-entry sanity guard on unrealizedPnlSats
// ============================================================

test('T28e: unrealizedPnlSats rejects price > maxPriceRatioX × entry price (returns null fields)', () => {
  // Real-world QBTC case: entry=327 sats/token, indexer price
  // 32,668,282,406 sats/token (100,000,000x off the actual AMM
  // spot rate). Without T28e, the dashboard reports $20M+ of
  // "unrealized gains" every snapshot.
  const pos = longPosition({
    entry: {
      ...longPosition().entry,
      price_sats_per_token: 327,
      bch_spent_sats: 495_669,
      token_amount_base: 1513,
      fee_sats: 3_071,
    },
  });
  const { gross, net, pct } = unrealizedPnlSats(pos, 32_668_282_406, null, { maxPriceRatioX: 1000 });
  assert.equal(gross, null, 'gross must be null when indexer price is wildly off');
  assert.equal(net, null, 'net must be null when indexer price is wildly off');
  assert.equal(pct, null, 'pct must be null when indexer price is wildly off');
});

test('T28e: unrealizedPnlSats rejects price < entry/maxPriceRatioX (returns null fields)', () => {
  // Symmetric case: indexer reports a price far LOWER than entry.
  // With entry_price = 100,000,000 sats and maxRatioX = 1000,
  // the lower bound is 100,000. Market price = 1 sat is 100,000x
  // below the floor — safely rejected. (Note: integer sats means
  // the floor is 100,000; 1 is unambiguously below it.)
  const pos = longPosition({
    entry: {
      ...longPosition().entry,
      price_sats_per_token: 100_000_000, // 1 BCH per token
      bch_spent_sats: 100_000_000,       // 1 BCH spent → 1 token
    },
  });
  // Market price = 1 sat is 100,000x below the 100,000-sats floor.
  const { gross, net, pct } = unrealizedPnlSats(pos, 1n, null, { maxPriceRatioX: 1000 });
  assert.equal(gross, null, 'gross must be null when indexer price is wildly below entry');
  assert.equal(net, null, 'net must be null when indexer price is wildly below entry');
  assert.equal(pct, null, 'pct must be null when indexer price is wildly below entry');
});

test('T28e: unrealizedPnlSats accepts price within ratio window (computes normally)', () => {
  // 100 → 150 is +50%, well within 1000x window.
  const pos = longPosition();
  const { gross, net, pct } = unrealizedPnlSats(pos, 150n, null, { maxPriceRatioX: 1000 });
  assert.equal(gross, 50_000_000n);
  assert.equal(net, 50_000_000n - 1_000n);
  assert.ok(pct !== null && pct > 0);
});

test('T28e: unrealizedPnlSats: boundary case — exactly entry × ratio (passes)', () => {
  // 100 × 1000 = 100,000 — at the upper bound, must still pass
  // (>=, not >).
  const pos = longPosition();
  const { gross } = unrealizedPnlSats(pos, 100_000n, null, { maxPriceRatioX: 1000 });
  // 1M * 100_000 - 100M = 100_000_000_000 - 100_000_000 = 99_900_000_000
  assert.equal(gross, 99_900_000_000n);
});

test('T28e: unrealizedPnlSats: omitting opts.maxPriceRatioX preserves legacy behavior (no check)', () => {
  // Backward compat: callers that pass null/undefined for opts
  // (the original signature) get the old behavior — a wildly-
  // wrong price computes to a huge P&L. Tests relying on this
  // contract continue to work.
  const pos = longPosition();
  const { gross } = unrealizedPnlSats(pos, 32_668_282_406n, null);
  assert.ok(gross !== null && gross > 0n, 'legacy callers get the old (unchecked) result');
});

test('T28e: unrealizedPnlSats: opts.maxPriceRatioX=0 or negative means "no check"', () => {
  // Defensive: maxPriceRatioX=0 / -1 / NaN / Infinity should not
  // make every position look "plausible". We treat these as
  // "guard disabled" (same as omitting the option).
  const pos = longPosition();
  const { gross: g0 } = unrealizedPnlSats(pos, 32_668_282_406n, null, { maxPriceRatioX: 0 });
  const { gross: gNeg } = unrealizedPnlSats(pos, 32_668_282_406n, null, { maxPriceRatioX: -1 });
  const { gross: gNaN } = unrealizedPnlSats(pos, 32_668_282_406n, null, { maxPriceRatioX: NaN });
  assert.ok(g0 !== null);
  assert.ok(gNeg !== null);
  assert.ok(gNaN !== null);
});

test('T28e: unrealizedPnlSats: missing entry price → no rejection (fall through to existing null path)', () => {
  // Chain-synced positions have entry.price_sats_per_token=0.
  // isPricePlausibleVsEntry returns true on missing entry (don't
  // reject — let the caller's null-handling do the work), so the
  // function still returns null because the underlying null checks
  // fire first.
  const pos = {
    id: 'pos_chain_synced',
    token_id: 'b'.repeat(64),
    side: 'long_token',
    entry: {
      bch_spent_sats: 495_669,
      token_amount_base: 1513,
      fee_sats: 3_071,
      // intentionally NO price_sats_per_token
    },
    opened_at: '2026-09-14T00:00:00.000Z',
    status: 'open',
  };
  const { gross, net, pct } = unrealizedPnlSats(pos, 500n, null, { maxPriceRatioX: 1000 });
  // computeOpenExposureBch would still get a value, but tokenAmount
  // is 1513 and price is 500 — net should be 1513*500 - 495669 - 3071.
  assert.equal(gross, 1513n * 500n - 495_669n);
  assert.equal(net, 1513n * 500n - 495_669n - 3_071n);
  assert.ok(pct !== null);
});

test('T28e: unrealizedPnlSats: tolerates bigint / string / number maxPriceRatioX', () => {
  const pos = longPosition();
  const { gross: gN } = unrealizedPnlSats(pos, 32_668_282_406n, null, { maxPriceRatioX: 1000 });
  const { gross: gS } = unrealizedPnlSats(pos, 32_668_282_406n, null, { maxPriceRatioX: '1000' });
  const { gross: gB } = unrealizedPnlSats(pos, 32_668_282_406n, null, { maxPriceRatioX: 1000n });
  assert.equal(gN, null);
  assert.equal(gS, null);
  assert.equal(gB, null);
});

test('T28e: DEFAULT_MAX_PRICE_RATIO is 1000', () => {
  // Re-exported constant parity with DEFAULT_EXIT_CONFIG.
  assert.equal(DEFAULT_MAX_PRICE_RATIO, 1000);
});
