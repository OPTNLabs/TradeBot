#!/usr/bin/env node
/**
 * dashboard/tests/token-summary-view.test.mjs
 *
 * T68 — unit tests for the pure formatting helpers in
 * `dashboard/src/views/token-summary-helpers.mjs`.
 *
 * Coverage targets (matches the snapshot-stats test pattern):
 *   1. safeSats — bigint / number / string / null / unparseable / negative
 *   2. satsToBchNumber — bigint / string / number / null / unparseable
 *   3. formatBch — null / undefined / NaN / number / string / 0 / dust
 *   4. pnlSeverity — gain / loss / breakeven / null / epsilon window
 *   5. pnlClass — all severity values + null
 *   6. formatHoldMs — null / negative / seconds / minutes / hours / days
 *   7. formatWinRate — null / out-of-range / 0 / 1 / 0.5 / NaN
 *   8. shortSymbol — null / short / long / empty
 *   9. shortTokenId — null / 64-hex / short / arbitrary
 *  10. isRollupEmpty — missing tokens / empty / non-array / null
 *  11. isDetailUnavailable — missing token_id / error / null
 *  12. buildRollupRow — full / partial / null / string numerics
 *  13. buildClosedTradeRow — gain / loss / breakeven / missing fields
 *  14. buildOpenPositionRow — full / partial / null
 *  15. buildRollupTotals — empty / single / mixed / breakeven-only
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  safeSats,
  satsToBchNumber,
  formatBch,
  pnlSeverity,
  pnlClass,
  formatHoldMs,
  formatWinRate,
  shortSymbol,
  shortTokenId,
  isRollupEmpty,
  isDetailUnavailable,
  buildRollupRow,
  buildClosedTradeRow,
  buildOpenPositionRow,
  buildRollupTotals,
} from '../src/views/token-summary-helpers.mjs';

// ─── safeSats ──────────────────────────────────────────────────────

test('token-summary-helpers: safeSats returns null for null/undefined/non-numeric', () => {
  assert.equal(safeSats(null), null);
  assert.equal(safeSats(undefined), null);
  assert.equal(safeSats(''), null);
  assert.equal(safeSats('abc'), null);
  assert.equal(safeSats({}), null);
  assert.equal(safeSats([]), null);
});

test('token-summary-helpers: safeSats handles bigint / number / numeric string', () => {
  assert.equal(safeSats(0n), 0n);
  assert.equal(safeSats(12345n), 12345n);
  assert.equal(safeSats(0), 0n);
  assert.equal(safeSats(12345), 12345n);
  assert.equal(safeSats('12345'), 12345n);
  assert.equal(safeSats('  42  '), 42n);
});

test('token-summary-helpers: safeSats rejects NaN / Infinity but allows negative', () => {
  assert.equal(safeSats(NaN), null);
  assert.equal(safeSats(Infinity), null);
  assert.equal(safeSats(-Infinity), null);
  // Negative values are preserved for P&L fields (realized P&L can
  // legitimately be negative on a losing trade).
  assert.equal(safeSats(-1n), -1n);
  assert.equal(safeSats(-100), -100n);
  assert.equal(safeSats('-1'), -1n);
});

// ─── satsToBchNumber ───────────────────────────────────────────────

test('token-summary-helpers: satsToBchNumber converts bigint / string / number', () => {
  assert.equal(satsToBchNumber(100_000_000n), 1);
  assert.equal(satsToBchNumber(50_000_000n), 0.5);
  assert.equal(satsToBchNumber('100000000'), 1);
  assert.equal(satsToBchNumber(100_000_000), 1);
  assert.equal(satsToBchNumber(0n), 0);
});

test('token-summary-helpers: satsToBchNumber returns null for missing/unparseable', () => {
  assert.equal(satsToBchNumber(null), null);
  assert.equal(satsToBchNumber(undefined), null);
  assert.equal(satsToBchNumber('not-a-number'), null);
  assert.equal(satsToBchNumber(NaN), null);
});

// ─── formatBch ─────────────────────────────────────────────────────

test('token-summary-helpers: formatBch returns em dash for null / NaN / undefined / empty', () => {
  assert.equal(formatBch(null), '—');
  assert.equal(formatBch(undefined), '—');
  assert.equal(formatBch(NaN), '—');
  assert.equal(formatBch(''), '—');
  assert.equal(formatBch('   '), '—');
  assert.equal(formatBch('not-a-number'), '—');
});

test('token-summary-helpers: formatBch returns fixed-precision number string', () => {
  assert.equal(formatBch(0), '0.000000');
  assert.equal(formatBch(0.001234), '0.001234');
  assert.equal(formatBch('0.005'), '0.005000');
  assert.equal(formatBch(1.5, 3), '1.500');
});

// ─── pnlSeverity ───────────────────────────────────────────────────

test('token-summary-helpers: pnlSeverity classifies positive / negative / zero', () => {
  assert.equal(pnlSeverity(1000n), 'gain');
  assert.equal(pnlSeverity(-1000n), 'loss');
  assert.equal(pnlSeverity(0n), 'breakeven');
  assert.equal(pnlSeverity(null), null);
  assert.equal(pnlSeverity(undefined), null);
});

test('token-summary-helpers: pnlSeverity respects epsilon window', () => {
  assert.equal(pnlSeverity(50n, { epsilon: 100n }), 'breakeven');
  assert.equal(pnlSeverity(-50n, { epsilon: 100n }), 'breakeven');
  assert.equal(pnlSeverity(150n, { epsilon: 100n }), 'gain');
  assert.equal(pnlSeverity(-150n, { epsilon: 100n }), 'loss');
});

test('token-summary-helpers: pnlSeverity tolerates number / string sat values', () => {
  assert.equal(pnlSeverity(100), 'gain');
  assert.equal(pnlSeverity('-100'), 'loss');
  assert.equal(pnlSeverity('0'), 'breakeven');
});

// ─── pnlClass ──────────────────────────────────────────────────────

test('token-summary-helpers: pnlClass maps severity to Tailwind text color', () => {
  assert.equal(pnlClass('gain'), 'text-emerald-400');
  assert.equal(pnlClass('loss'), 'text-rose-400');
  assert.equal(pnlClass('breakeven'), 'text-ash-400');
  assert.equal(pnlClass(null), 'text-ash-400');
});

// ─── formatHoldMs ─────────────────────────────────────────────────

test('token-summary-helpers: formatHoldMs handles seconds / minutes / hours / days', () => {
  assert.equal(formatHoldMs(null), '—');
  assert.equal(formatHoldMs(undefined), '—');
  assert.equal(formatHoldMs(NaN), '—');
  assert.equal(formatHoldMs(-1), '—');
  assert.equal(formatHoldMs(0), '0s');
  assert.equal(formatHoldMs(45_000), '45s');
  assert.equal(formatHoldMs(12 * 60_000), '12m');
  assert.equal(formatHoldMs(60 * 60_000), '1h');
  assert.equal(formatHoldMs(3 * 60 * 60_000 + 15 * 60_000), '3h 15m');
  assert.equal(formatHoldMs(24 * 60 * 60_000), '1d');
  assert.equal(formatHoldMs(2 * 24 * 60 * 60_000 + 4 * 60 * 60_000), '2d 4h');
});

// ─── formatWinRate ─────────────────────────────────────────────────

test('token-summary-helpers: formatWinRate formats fraction as percent string', () => {
  assert.equal(formatWinRate(null), '—');
  assert.equal(formatWinRate(undefined), '—');
  assert.equal(formatWinRate(NaN), '—');
  assert.equal(formatWinRate(0), '0.0%');
  assert.equal(formatWinRate(1), '100.0%');
  assert.equal(formatWinRate(0.5), '50.0%');
  assert.equal(formatWinRate(0.789), '78.9%');
});

test('token-summary-helpers: formatWinRate returns em dash for out-of-range', () => {
  assert.equal(formatWinRate(-0.1), '—');
  assert.equal(formatWinRate(1.1), '—');
});

// ─── shortSymbol ───────────────────────────────────────────────────

test('token-summary-helpers: shortSymbol returns em dash for null / empty / non-string', () => {
  assert.equal(shortSymbol(null), '—');
  assert.equal(shortSymbol(undefined), '—');
  assert.equal(shortSymbol(''), '—');
  assert.equal(shortSymbol(123), '—');
});

test('token-summary-helpers: shortSymbol returns verbatim when short enough', () => {
  assert.equal(shortSymbol('FOO'), 'FOO');
  assert.equal(shortSymbol('ABCDEFGH'), 'ABCDEFGH');
  assert.equal(shortSymbol('PUSD', 6), 'PUSD');
});

test('token-summary-helpers: shortSymbol truncates with ellipsis when long', () => {
  assert.equal(shortSymbol('ABCDEFGHIJ', 5), 'ABCD…');
  assert.equal(shortSymbol('ABCDEFGHIJ', 8), 'ABCDEFG…');
});

// ─── shortTokenId ──────────────────────────────────────────────────

test('token-summary-helpers: shortTokenId returns em dash for null / non-string', () => {
  assert.equal(shortTokenId(null), '—');
  assert.equal(shortTokenId(undefined), '—');
  assert.equal(shortTokenId(123), '—');
});

test('token-summary-helpers: shortTokenId returns 64-hex as prefix + suffix', () => {
  const hex = '0'.repeat(64);
  assert.equal(shortTokenId(hex), '000000…0000');
  const real = '7860a1632607f6354d01a0d638914011f92cae14db78b11c58511d72d002f42f';
  assert.equal(shortTokenId(real), '7860a1…f42f');
});

test('token-summary-helpers: shortTokenId returns short token verbatim', () => {
  assert.equal(shortTokenId('short'), 'short');
  assert.equal(shortTokenId('abcdefghijkl'), 'abcdefghijkl');
  // > 12 chars → prefix + suffix truncation
  assert.equal(shortTokenId('abcdefghijklm'), 'abcdef…jklm');
});

// ─── isRollupEmpty ─────────────────────────────────────────────────

test('token-summary-helpers: isRollupEmpty detects missing / empty / null', () => {
  assert.equal(isRollupEmpty(null), true);
  assert.equal(isRollupEmpty(undefined), true);
  assert.equal(isRollupEmpty({}), true);
  assert.equal(isRollupEmpty({ tokens: [] }), true);
  assert.equal(isRollupEmpty({ tokens: 'nope' }), true);
  assert.equal(isRollupEmpty({ count: 0 }), true);
  assert.equal(isRollupEmpty({ tokens: [{}] }), false);
});

// ─── isDetailUnavailable ──────────────────────────────────────────

test('token-summary-helpers: isDetailUnavailable detects error / missing token_id', () => {
  assert.equal(isDetailUnavailable(null), true);
  assert.equal(isDetailUnavailable({}), true);
  assert.equal(isDetailUnavailable({ error: 'not found' }), true);
  assert.equal(isDetailUnavailable({ token_id: '' }), true);
  assert.equal(isDetailUnavailable({ token_id: 'abc' }), false);
});

// ─── buildRollupRow ────────────────────────────────────────────────

test('token-summary-helpers: buildRollupRow projects full rollup token', () => {
  const tok = {
    token_id: '7860a1632607f6354d01a0d638914011f92cae14db78b11c58511d72d002f42f',
    symbol: 'PUSD',
    decimals: 2,
    entry_count: 3,
    exit_count: 3,
    closed_trade_count: 3,
    open_position_count: 1,
    total_bch_in_sats: '750000',
    total_bch_out_sats: '752000',
    total_fees_sats: '5000',
    realized_pnl_sats: '2000',
    realized_pnl_bch: 0.00002,
    win_count: 2,
    loss_count: 1,
    breakeven_count: 0,
    unknown_count: 0,
    win_rate: 0.6667,
    mean_hold_ms: 86400000,
    first_event_ts: '2026-09-10T00:00:00.000Z',
    last_event_ts: '2026-09-17T00:00:00.000Z',
  };
  const r = buildRollupRow(tok);
  assert.equal(r.token_id, tok.token_id);
  assert.equal(r.symbol, 'PUSD');
  assert.equal(r.shortSymbol, 'PUSD');
  assert.equal(r.shortTokenId, '7860a1…f42f');
  assert.equal(r.closed_trade_count, 3);
  assert.equal(r.open_position_count, 1);
  assert.equal(r.pnl_sats, 2000n);
  assert.equal(r.severity, 'gain');
  assert.equal(r.severityClass, 'text-emerald-400');
  assert.equal(r.pnl_bch_display, '0.000020');
  assert.equal(r.win_count, 2);
  assert.equal(r.loss_count, 1);
  assert.equal(r.mean_hold_display, '1d');
});

test('token-summary-helpers: buildRollupRow handles loss / breakeven / null', () => {
  const loss = buildRollupRow({
    token_id: 'a'.repeat(64),
    symbol: 'L',
    realized_pnl_sats: '-5000',
  });
  assert.equal(loss.severity, 'loss');
  assert.equal(loss.severityClass, 'text-rose-400');

  const be = buildRollupRow({
    token_id: 'a'.repeat(64),
    symbol: 'B',
    realized_pnl_sats: '0',
  });
  assert.equal(be.severity, 'breakeven');
  assert.equal(be.severityClass, 'text-ash-400');

  const nullish = buildRollupRow({
    token_id: 'a'.repeat(64),
    symbol: 'X',
    realized_pnl_sats: null,
  });
  assert.equal(nullish.severity, null);
  assert.equal(nullish.pnl_sats, null);
  assert.equal(nullish.pnl_bch_display, '—');
});

test('token-summary-helpers: buildRollupRow defensively handles malformed entry', () => {
  const r = buildRollupRow(null);
  assert.equal(r.token_id, null);
  assert.equal(r.shortSymbol, '—');
  assert.equal(r.pnl_sats, null);
  assert.equal(r.severity, null);

  const partial = buildRollupRow({});
  assert.equal(partial.token_id, null);
  assert.equal(partial.symbol, null);
  assert.equal(partial.entry_count, 0);
  assert.equal(partial.closed_trade_count, 0);
  assert.equal(partial.open_position_count, 0);
});

// ─── buildClosedTradeRow ──────────────────────────────────────────

test('token-summary-helpers: buildClosedTradeRow projects gain trade', () => {
  const t = {
    position_id: 'pos_abc_001',
    entry_ts: '2026-09-10T00:00:00.000Z',
    exit_ts: '2026-09-11T00:00:00.000Z',
    exit_kind: 'take_profit',
    outcome: 'gain',
    cost_basis_sats: '500000',
    exit_value_sats: '510000',
    fees_sats_total: '1500',
    net_pnl_sats: '8500',
    net_pnl_bch: 0.000085,
    net_pnl_pct_of_cost: 0.017,
    hold_ms: 86400000,
  };
  const r = buildClosedTradeRow(t);
  assert.equal(r.position_id, 'pos_abc_001');
  assert.equal(r.exit_kind, 'take_profit');
  assert.equal(r.outcome, 'gain');
  assert.equal(r.pnl_sats, 8500n);
  assert.equal(r.severity, 'gain');
  assert.equal(r.severityClass, 'text-emerald-400');
  assert.equal(r.pnl_bch_display, '0.000085');
  assert.equal(r.hold_display, '1d');
  assert.equal(r.pnl_pct_display, '1.70%');
});

test('token-summary-helpers: buildClosedTradeRow handles loss + breakeven + missing fields', () => {
  const loss = buildClosedTradeRow({
    position_id: 'p1', net_pnl_sats: '-100', hold_ms: 3600000,
  });
  assert.equal(loss.severity, 'loss');
  assert.equal(loss.hold_display, '1h');

  const be = buildClosedTradeRow({
    position_id: 'p2', net_pnl_sats: '0', hold_ms: null,
  });
  assert.equal(be.severity, 'breakeven');
  assert.equal(be.hold_display, '—');

  const partial = buildClosedTradeRow({});
  assert.equal(partial.position_id, null);
  assert.equal(partial.pnl_sats, null);
  assert.equal(partial.severity, null);

  const nul = buildClosedTradeRow(null);
  assert.equal(nul.position_id, null);
  assert.equal(nul.exit_kind, null);
});

// ─── buildOpenPositionRow ──────────────────────────────────────────

test('token-summary-helpers: buildOpenPositionRow projects open position', () => {
  const o = {
    position_id: 'pos_open_1',
    entry_ts: '2026-09-17T00:00:00.000Z',
    age_ms: 7200000,
    side: 'buy',
    size_bch: 0.005,
    cost_basis_sats: '500000',
    fee_sats: '1500',
  };
  const r = buildOpenPositionRow(o);
  assert.equal(r.position_id, 'pos_open_1');
  assert.equal(r.entry_ts, '2026-09-17T00:00:00.000Z');
  assert.equal(r.age_display, '2h');
  assert.equal(r.side, 'buy');
  assert.equal(r.size_bch, 0.005);
  assert.equal(r.size_bch_display, '0.005000');
  assert.equal(r.cost_basis_sats, 500000n);
  assert.equal(r.fee_sats, 1500n);
});

test('token-summary-helpers: buildOpenPositionRow handles missing age / null entry', () => {
  const r1 = buildOpenPositionRow({ position_id: 'p1' });
  assert.equal(r1.age_display, '—');
  assert.equal(r1.size_bch, null);
  assert.equal(r1.size_bch_display, '—');

  const r2 = buildOpenPositionRow(null);
  assert.equal(r2.position_id, null);
  assert.equal(r2.age_display, '—');
});

// ─── buildRollupTotals ─────────────────────────────────────────────

test('token-summary-helpers: buildRollupTotals sums empty input to zeros', () => {
  const t = buildRollupTotals([]);
  assert.equal(t.token_count, 0);
  assert.equal(t.total_closed, 0);
  assert.equal(t.total_open, 0);
  assert.equal(t.total_pnl_sats, 0n);
  assert.equal(t.total_pnl_bch_display, '0.000000');
  assert.equal(t.win_count, 0);
  assert.equal(t.loss_count, 0);
  assert.equal(t.breakeven_count, 0);
  assert.equal(t.win_rate, null);
});

test('token-summary-helpers: buildRollupTotals aggregates across multiple tokens', () => {
  const rows = [
    buildRollupRow({
      token_id: 'a'.repeat(64), symbol: 'A',
      closed_trade_count: 3, open_position_count: 1,
      realized_pnl_sats: '1000', win_count: 2, loss_count: 1, breakeven_count: 0,
    }),
    buildRollupRow({
      token_id: 'b'.repeat(64), symbol: 'B',
      closed_trade_count: 2, open_position_count: 0,
      realized_pnl_sats: '-500', win_count: 0, loss_count: 2, breakeven_count: 0,
    }),
    buildRollupRow({
      token_id: 'c'.repeat(64), symbol: 'C',
      closed_trade_count: 1, open_position_count: 2,
      realized_pnl_sats: '200', win_count: 1, loss_count: 0, breakeven_count: 0,
    }),
  ];
  const t = buildRollupTotals(rows);
  assert.equal(t.token_count, 3);
  assert.equal(t.total_closed, 6);
  assert.equal(t.total_open, 3);
  // 1000 + (-500) + 200 = 700
  assert.equal(t.total_pnl_sats, 700n);
  assert.equal(t.win_count, 3);
  assert.equal(t.loss_count, 3);
  assert.equal(t.breakeven_count, 0);
  assert.equal(t.win_rate, 0.5);
  assert.equal(t.win_rate_display, '50.0%');
});

test('token-summary-helpers: buildRollupTotals ignores malformed rows', () => {
  const rows = [
    null,
    undefined,
    {},
    buildRollupRow({
      token_id: 'a'.repeat(64), symbol: 'A',
      closed_trade_count: 1, realized_pnl_sats: '100',
      win_count: 1, loss_count: 0, breakeven_count: 0,
    }),
  ];
  const t = buildRollupTotals(rows);
  // `null` + `undefined` are skipped; `{}` is a structurally-valid
  // (if data-less) row so it counts as a token with no contribution;
  // only the 4th entry contributes to the numeric totals.
  assert.equal(t.token_count, 2);
  assert.equal(t.total_closed, 1);
  assert.equal(t.total_pnl_sats, 100n);
});

test('token-summary-helpers: buildRollupTotals returns null win_rate when no decided trades', () => {
  const t = buildRollupTotals([
    buildRollupRow({
      token_id: 'a'.repeat(64), symbol: 'A',
      closed_trade_count: 0, realized_pnl_sats: '0',
      win_count: 0, loss_count: 0, breakeven_count: 0,
    }),
  ]);
  assert.equal(t.win_rate, null);
  assert.equal(t.win_rate_display, '—');
});
