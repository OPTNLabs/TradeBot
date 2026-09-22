#!/usr/bin/env node
// dashboard/tests/fee-breakdown-view.test.mjs
//
// Unit tests for the T71 dashboard view helpers. Mirrors the
// T63 / T68 dashboard test patterns: every pure helper gets
// a fixture-driven test that confirms the projected display
// row matches the expected shape. The React tile itself is
// exercised by the dashboard build (which catches import-time
// JSX errors) — these tests focus on the dependency-free
// projection layer.
//
// Coverage groups:
//   1. Numeric coercion — safeSats
//   2. BCH formatting — satsToBchNumber, formatSats
//   3. Share severity — shareSeverity, shareClass
//   4. Identity helpers — shortTokenId, shortSymbol
//   5. Rollup builders — buildBreakdownRow, buildBreakdownTotals
//   6. Detail builder — buildTradeFeeRow
//   7. Empty / unavailable — isRollupEmpty, isDetailUnavailable

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  safeSats,
  satsToBchNumber,
  formatSats,
  shareSeverity,
  shareClass,
  shortTokenId,
  shortSymbol,
  buildBreakdownRow,
  buildBreakdownTotals,
  buildTradeFeeRow,
  isRollupEmpty,
  isDetailUnavailable,
} from '../src/views/fee-breakdown-helpers.mjs';

// ─────────────────────────────────────────────────────────────────────
// 1. Numeric coercion
// ─────────────────────────────────────────────────────────────────────

test('fee-breakdown-view: safeSats handles null / undefined / strings / numbers / floats / NaN / Infinity', () => {
  assert.equal(safeSats(null), null);
  assert.equal(safeSats(undefined), null);
  assert.equal(safeSats(0), 0n);
  assert.equal(safeSats(100), 100n);
  assert.equal(safeSats('500000'), 500000n);
  assert.equal(safeSats(NaN), null);
  assert.equal(safeSats(Infinity), null);
  assert.equal(safeSats(-Infinity), null);
  assert.equal(safeSats('abc'), null);
  assert.equal(safeSats('500000.5'), null);
  assert.equal(safeSats(500000.5), null);
  assert.equal(safeSats(100.5), null);
  assert.equal(safeSats('  -42  '), -42n);
  // bigint pass-through.
  assert.equal(safeSats(123n), 123n);
  assert.equal(safeSats({}), null);
  assert.equal(safeSats([]), null);
});

// ─────────────────────────────────────────────────────────────────────
// 2. BCH formatting
// ─────────────────────────────────────────────────────────────────────

test('fee-breakdown-view: satsToBchNumber rounds to a finite JS number', () => {
  assert.equal(satsToBchNumber(null), null);
  assert.equal(satsToBchNumber(undefined), null);
  assert.equal(satsToBchNumber('abc'), null);
  assert.equal(satsToBchNumber(100_000_000n), 1);
  assert.equal(satsToBchNumber(50_000_000n), 0.5);
  assert.equal(satsToBchNumber(-100_000_000n), -1);
  assert.equal(satsToBchNumber(123_456n), 0.00123456);
  assert.equal(satsToBchNumber(0n), 0);
});

test('fee-breakdown-view: formatSats scales to sats / K / BCH', () => {
  assert.equal(formatSats(null), '—');
  assert.equal(formatSats(undefined), '—');
  assert.equal(formatSats('garbage'), '—');
  assert.equal(formatSats(0n), '0 sats');
  assert.equal(formatSats(123n), '123 sats');
  assert.equal(formatSats(2500n), '2.5K sats');
  // Anything at or above 100K sats (0.001 BCH) renders as BCH.
  assert.equal(formatSats(100_000n), '0.001000 BCH');
  assert.equal(formatSats(100_000_000n), '1.000000 BCH');
  assert.equal(formatSats(50_000_000n), '0.500000 BCH');
  assert.equal(formatSats(1_500_000n), '0.015000 BCH');
  // Negative values render with a leading minus.
  assert.equal(formatSats(-2_500n), '-2.5K sats');
  assert.equal(formatSats(-50_000_000n), '-0.500000 BCH');
});

// ─────────────────────────────────────────────────────────────────────
// 3. Share severity
// ─────────────────────────────────────────────────────────────────────

test('fee-breakdown-view: shareSeverity classifies high/medium/low/none', () => {
  assert.equal(shareSeverity(0.6), 'high');
  assert.equal(shareSeverity(0.5), 'medium'); // edge: exactly 0.5 is medium (not >)
  assert.equal(shareSeverity(0.4), 'medium');
  assert.equal(shareSeverity(0.25), 'low'); // edge: exactly 0.25 is low (not >)
  assert.equal(shareSeverity(0.1), 'low');
  assert.equal(shareSeverity(0), 'low');
  assert.equal(shareSeverity(null), 'none');
  assert.equal(shareSeverity(undefined), 'none');
  assert.equal(shareSeverity('abc'), 'none');
  assert.equal(shareSeverity(-0.1), 'none');
  assert.equal(shareSeverity(NaN), 'none');
  // Infinity is not finite → none (NOT high).
  assert.equal(shareSeverity(Infinity), 'none');
});

test('fee-breakdown-view: shareClass maps severity to Tailwind palette', () => {
  assert.equal(shareClass('high'), 'bg-red-100 text-red-700 border-red-300');
  assert.equal(shareClass('medium'), 'bg-amber-100 text-amber-700 border-amber-300');
  assert.equal(shareClass('low'), 'bg-emerald-100 text-emerald-700 border-emerald-300');
  assert.equal(shareClass('none'), 'bg-gray-100 text-gray-500 border-gray-300');
  // Unknown severity → gray.
  assert.equal(shareClass('garbage'), 'bg-gray-100 text-gray-500 border-gray-300');
});

// ─────────────────────────────────────────────────────────────────────
// 4. Identity helpers
// ─────────────────────────────────────────────────────────────────────

test('fee-breakdown-view: shortTokenId truncates 64-hex to 9…3', () => {
  const hex64 = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
  assert.equal(shortTokenId(hex64), 'abcdef012…789');
  // Short / wrong-length passes through.
  assert.equal(shortTokenId('abc'), 'abc');
  assert.equal(shortTokenId('abcdef0'), 'abcdef0');
  assert.equal(shortTokenId(null), '');
  assert.equal(shortTokenId(undefined), '');
  assert.equal(shortTokenId(''), '');
});

test('fee-breakdown-view: shortSymbol prefers symbol over token_id', () => {
  assert.equal(shortSymbol('FURU', 'abcdef0…789'), 'FURU');
  assert.equal(shortSymbol(null, 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'), 'abcdef012…789');
  assert.equal(shortSymbol('', 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'), 'abcdef012…789');
  assert.equal(shortSymbol(undefined, ''), '');
});

// ─────────────────────────────────────────────────────────────────────
// 5. Rollup builders
// ─────────────────────────────────────────────────────────────────────

test('fee-breakdown-view: buildBreakdownRow projects a rollup entry to display row', () => {
  const row = {
    token_id: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
    symbol: 'FURU',
    decimals: 0,
    trade_count: 3,
    fee_rate_bps: 30,
    lp_fees_sats_total: '13566',
    tx_fees_sats_total: '21920',
    slippage_cost_sats_total: '19016',
    fees_paid_sats_total: '54502',
    lp_share: 0.25,
    tx_share: 0.4,
    slippage_share: 0.35,
  };
  const display = buildBreakdownRow(row);
  assert.equal(display.token_id, row.token_id);
  assert.equal(display.token_label, 'FURU');
  assert.equal(display.trade_count, 3);
  assert.equal(display.lp_fees_sats, 13566n);
  assert.equal(display.tx_fees_sats, 21920n);
  assert.equal(display.slippage_cost_sats, 19016n);
  assert.equal(display.fees_paid_sats, 54502n);
  assert.equal(display.lp_share, 0.25);
  assert.equal(display.tx_share, 0.4);
  assert.equal(display.slippage_share, 0.35);
  assert.equal(display.lp_severity, 'low');     // exactly 0.25 → low (not >)
  assert.equal(display.tx_severity, 'medium'); // 0.4 → medium (> 0.25)
  assert.equal(display.slippage_severity, 'medium');
  // Formatted strings are present.
  assert.equal(typeof display.format_lp_fees, 'string');
  assert.equal(typeof display.format_tx_fees, 'string');
  assert.equal(typeof display.format_slippage_cost, 'string');
  assert.equal(typeof display.format_fees_paid, 'string');
});

test('fee-breakdown-view: buildBreakdownRow handles null / missing fields defensively', () => {
  const display = buildBreakdownRow(null);
  assert.equal(display.token_id, '');
  assert.equal(display.token_label, '');
  assert.equal(display.trade_count, 0);
  assert.equal(display.lp_fees_sats, null);
  assert.equal(display.tx_fees_sats, null);
  assert.equal(display.slippage_cost_sats, null);
  assert.equal(display.fees_paid_sats, null);
  assert.equal(display.lp_share, 0);
  assert.equal(display.lp_severity, 'low');
  assert.equal(display.format_lp_fees, '—');
  assert.equal(display.format_fees_paid, '—');
});

test('fee-breakdown-view: buildBreakdownTotals projects the cross-token aggregate', () => {
  const totals = {
    trade_count: 15,
    lp_fees_sats_total: '29523',
    tx_fees_sats_total: '56333',
    slippage_cost_sats_total: '26696',
    fees_paid_sats_total: '112552',
    lp_share: 0.262,
    tx_share: 0.501,
    slippage_share: 0.237,
  };
  const t = buildBreakdownTotals(totals);
  assert.equal(t.trade_count, 15);
  assert.equal(t.lp_fees_sats, 29523n);
  assert.equal(t.tx_fees_sats, 56333n);
  assert.equal(t.slippage_cost_sats, 26696n);
  assert.equal(t.fees_paid_sats, 112552n);
  assert.equal(t.lp_share, 0.262);
  assert.equal(t.lp_severity, 'medium');
  assert.equal(t.tx_severity, 'high');
  assert.equal(t.slippage_severity, 'low');
});

test('fee-breakdown-view: buildBreakdownTotals handles null totals', () => {
  const t = buildBreakdownTotals(null);
  assert.equal(t.trade_count, 0);
  assert.equal(t.lp_fees_sats, null);
  assert.equal(t.lp_share, 0);
  assert.equal(t.format_fees_paid, '—');
});

// ─────────────────────────────────────────────────────────────────────
// 6. Detail builder
// ─────────────────────────────────────────────────────────────────────

test('fee-breakdown-view: buildTradeFeeRow projects a per-trade attribution', () => {
  const trade = {
    position_id: 'pos_x',
    token_id: 'tok_x',
    entry_ts: '2026-09-18T00:00:00Z',
    exit_ts: '2026-09-19T00:00:00Z',
    exit_kind: 'time_stop',
    is_open: false,
    fee_rate_bps: 30,
    tx_fees_sats_entry: '2285',
    tx_fees_sats_exit: '2705',
    tx_fees_sats_total: '4990',
    lp_fees_sats_entry: '1490',
    lp_fees_sats_exit: '1506',
    lp_fees_sats_total: '2996',
    slippage_cost_sats_entry: '1639',
    slippage_cost_sats_exit: '602',
    slippage_cost_sats_total: '2241',
    fees_paid_sats_total: '10227',
    slippage_signed_bps: '45',
  };
  const row = buildTradeFeeRow(trade);
  assert.equal(row.position_id, 'pos_x');
  assert.equal(row.exit_kind, 'time_stop');
  assert.equal(row.is_open, false);
  assert.equal(row.fee_rate_bps, 30);
  assert.equal(row.format_tx_fees_entry, '2.3K sats');
  assert.equal(row.format_lp_fees_total, undefined); // not exposed — use format_lp_total
  // The buildTradeFeeRow only exposes format_lp_total, not format_lp_fees_total.
  // We don't assert that — it's a build decision.
  // But format_lp_total IS exposed.
  // Actually, looking at the source — only format_lp_fees_entry / _exit are exposed.
  // Open-position handling verified below.
});

test('fee-breakdown-view: buildTradeFeeRow handles open positions (no exit)', () => {
  const openTrade = {
    position_id: 'pos_o',
    token_id: 'tok_o',
    entry_ts: '2026-09-18T00:00:00Z',
    exit_ts: null,
    exit_kind: null,
    is_open: true,
    fee_rate_bps: 30,
    tx_fees_sats_entry: '2285',
    tx_fees_sats_exit: null,
    tx_fees_sats_total: '2285',
    lp_fees_sats_entry: '1490',
    lp_fees_sats_exit: null,
    lp_fees_sats_total: '1490',
    slippage_cost_sats_entry: null,
    slippage_cost_sats_exit: null,
    slippage_cost_sats_total: null,
    fees_paid_sats_total: '3775',
    slippage_signed_bps: null,
  };
  const row = buildTradeFeeRow(openTrade);
  assert.equal(row.is_open, true);
  assert.equal(row.exit_ts, null);
  assert.equal(row.exit_kind, null);
  assert.equal(row.format_tx_fees_entry, '2.3K sats');
  assert.equal(row.format_tx_fees_exit, '—');
  assert.equal(row.format_lp_fees_exit, '—');
  assert.equal(row.format_slippage_entry, '—');
  assert.equal(row.format_slippage_exit, '—');
  assert.equal(row.slippage_signed_bps, null);
});

test('fee-breakdown-view: buildTradeFeeRow handles null / missing fields', () => {
  const row = buildTradeFeeRow(null);
  assert.equal(row.position_id, '');
  assert.equal(row.token_id, '');
  assert.equal(row.entry_ts, null);
  assert.equal(row.exit_ts, null);
  assert.equal(row.exit_kind, null);
  assert.equal(row.is_open, false);
  assert.equal(row.format_tx_total, '—');
  assert.equal(row.format_fees_total, '—');
});

// ─────────────────────────────────────────────────────────────────────
// 7. Empty / unavailable state helpers
// ─────────────────────────────────────────────────────────────────────

test('fee-breakdown-view: isRollupEmpty classifies empty / null / missing', () => {
  assert.equal(isRollupEmpty(null), true);
  assert.equal(isRollupEmpty(undefined), true);
  assert.equal(isRollupEmpty({}), true);
  assert.equal(isRollupEmpty({ tokens: [] }), true);
  assert.equal(isRollupEmpty({ tokens: null }), true);
  assert.equal(isRollupEmpty({ tokens: [{}] }), false);
  assert.equal(isRollupEmpty({ tokens: [{}, {}] }), false);
  assert.equal(isRollupEmpty('not-an-object'), true);
  assert.equal(isRollupEmpty(42), true);
});

test('fee-breakdown-view: isDetailUnavailable classifies malformed envelopes', () => {
  assert.equal(isDetailUnavailable(null), true);
  assert.equal(isDetailUnavailable(undefined), true);
  assert.equal(isDetailUnavailable({}), true);
  assert.equal(isDetailUnavailable({ token_id: 'abc' }), true); // no trades[]
  assert.equal(isDetailUnavailable({ token_id: 'abc', trades: null }), true);
  assert.equal(isDetailUnavailable({ token_id: '', trades: [] }), true); // empty token_id
  assert.equal(isDetailUnavailable({ token_id: 'abc', trades: [] }), false); // valid empty
  assert.equal(isDetailUnavailable({ token_id: 'abc', trades: [{}] }), false);
});
