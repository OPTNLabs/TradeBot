#!/usr/bin/env node
/**
 * Unit tests for dashboard/src/views/dust-positions-helpers.mjs (T88).
 *
 * Covers every pure helper exhaustively: shortTokenId,
 * satsToBch, formatSats, dustRatioFormat, dustBchFormat,
 * dustSeverity, dustSeverityClass, dustPillClass,
 * dustBlockedReasonClass, dustBlockedReasonLabel, dustKindLabel,
 * dustKindClass, buildDustPositionsHeader, buildDustRow,
 * dustPositionsTableRows, dustPositionsSkippedRows,
 * positionsAreEmptyMessage, dustEmptyMessage, knobOffMessage,
 * dustAutoCloseConfigSnippet, dustCardHasDust, dustCardHasSkipped,
 * buildDustPositionsCardProps.
 *
 * Pure-function tests. No DOM, no React, no I/O. Imports from the
 * helpers module (Node can parse .mjs without a loader).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  shortTokenId,
  satsToBch,
  formatSats,
  dustRatioFormat,
  dustBchFormat,
  dustSeverity,
  dustSeverityClass,
  dustPillClass,
  dustBlockedReasonClass,
  dustBlockedReasonLabel,
  dustKindLabel,
  dustKindClass,
  buildDustPositionsHeader,
  buildDustRow,
  dustPositionsTableRows,
  dustPositionsSkippedRows,
  positionsAreEmptyMessage,
  dustEmptyMessage,
  knobOffMessage,
  dustAutoCloseConfigSnippet,
  dustCardHasDust,
  dustCardHasSkipped,
  buildDustPositionsCardProps,
} from '../src/views/dust-positions-helpers.mjs';

// ─────────────────────────────────────────────────────────────────────
//  Test fixtures
// ─────────────────────────────────────────────────────────────────────

const DUST_ENVELOPE = {
  schema: 'tradebot.dashboard.dust-positions/v1',
  ts: '2026-09-21T17:00:00.000Z',
  generated_at_ms: 1700000000000,
  ok: true,
  dust_position_auto_close_enabled: true,
  config: {
    tx_fee_sats: 1500,
    slippage_bps: 100,
    margin_bps: 50,
    budget_multiplier: 1.5,
    min_token_amount: null,
  },
  open_position_count: 3,
  checked_count: 2,
  dust_count: 1,
  skipped_count: 2,
  skipped_overrides: 1,
  skipped_no_price: 1,
  dust: [
    {
      position_id: 'pos_test_001',
      token_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      token_symbol: 'DUST',
      token_decimals: 2,
      entry_ts: '2026-09-20T00:00:00.000Z',
      entry_bch_spent_sats: 200_000,
      entry_price_sats_per_token: 200,
      current_value_sats: 500,
      proceeds_sats: 500,
      slippage_cost_sats: 5,
      tx_fee_sats: 1500,
      total_cost_sats: 1505,
      net_recoverable_sats: -1005,
      ratio_cost_to_proceeds: 3.01,
      budget_threshold_sats: 2257,
      reasons: ['cost_ratio_exceeds_budget:3.0100>=1.5'],
      dust_kind: 'below_cost',
      blocked_reason: null,
    },
  ],
  skipped: [
    {
      position_id: 'pos_test_002',
      token_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      token_symbol: null,
      blocked_reason: 'prevent_stop_loss',
      reasons: ['operator_set_prevent_stop_loss'],
    },
    {
      position_id: 'pos_test_003',
      token_id: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      token_symbol: 'NPR',
      blocked_reason: 'no_price',
      reasons: ['no_price'],
    },
  ],
};

const KNOB_OFF_ENVELOPE = {
  ...DUST_ENVELOPE,
  dust_position_auto_close_enabled: false,
  dust: [],
  skipped: [],
  dust_count: 0,
  skipped_count: 0,
  open_position_count: 0,
};

// ─────────────────────────────────────────────────────────────────────
//  shortTokenId
// ─────────────────────────────────────────────────────────────────────

test('shortTokenId: 64-char → 8 + ellipsis', () => {
  assert.equal(shortTokenId('a'.repeat(64)), `${'a'.repeat(8)}…`);
});

test('shortTokenId: short input → unchanged', () => {
  assert.equal(shortTokenId('abcdefgh'), 'abcdefgh');
  assert.equal(shortTokenId('abc'), 'abc');
});

test('shortTokenId: null / non-string → em-dash', () => {
  assert.equal(shortTokenId(null), '—');
  assert.equal(shortTokenId(undefined), '—');
  assert.equal(shortTokenId(''), '—');
  assert.equal(shortTokenId(42), '—');
  assert.equal(shortTokenId({}), '—');
});

// ─────────────────────────────────────────────────────────────────────
//  satsToBch
// ─────────────────────────────────────────────────────────────────────

test('satsToBch: number / string / bigint → BCH string', () => {
  assert.equal(satsToBch(100_000_000), '1.000000');
  assert.equal(satsToBch(50_000_000), '0.500000');
  assert.equal(satsToBch('1234567'), '0.012346');
  assert.equal(satsToBch(1234567n), '0.012346');
});

test('satsToBch: null / NaN / unparseable → em-dash', () => {
  assert.equal(satsToBch(null), '—');
  assert.equal(satsToBch(undefined), '—');
  assert.equal(satsToBch(''), '—');
  assert.equal(satsToBch('not a number'), '—');
  assert.equal(satsToBch(NaN), '—');
});

test('satsToBch: decimals parameter honored', () => {
  assert.equal(satsToBch(1234567, 2), '0.01');
  assert.equal(satsToBch(1234567, 8), '0.01234567');
});

// ─────────────────────────────────────────────────────────────────────
//  formatSats
// ─────────────────────────────────────────────────────────────────────

test('formatSats: number → thousands-separated integer string', () => {
  assert.equal(formatSats(1500), '1,500');
  assert.equal(formatSats(1500000), '1,500,000');
});

test('formatSats: null / undefined / unparseable → em-dash', () => {
  assert.equal(formatSats(null), '—');
  assert.equal(formatSats(undefined), '—');
  assert.equal(formatSats('not a number'), '—');
});

// ─────────────────────────────────────────────────────────────────────
//  dustRatioFormat
// ─────────────────────────────────────────────────────────────────────

test('dustRatioFormat: finite → 4-decimal string', () => {
  assert.equal(dustRatioFormat(0.5), '0.5000');
  assert.equal(dustRatioFormat(1.5), '1.5000');
  assert.equal(dustRatioFormat(3.01), '3.0100');
});

test('dustRatioFormat: Infinity → ∞', () => {
  assert.equal(dustRatioFormat(Infinity), '∞');
});

test('dustRatioFormat: null / NaN / undefined → em-dash', () => {
  assert.equal(dustRatioFormat(null), '—');
  assert.equal(dustRatioFormat(undefined), '—');
  assert.equal(dustRatioFormat(NaN), '—');
});

test('dustRatioFormat: 0 → "0.0000"', () => {
  assert.equal(dustRatioFormat(0), '0.0000');
});

test('dustRatioFormat: non-number → em-dash', () => {
  assert.equal(dustRatioFormat('1.5'), '—');
  assert.equal(dustRatioFormat({}), '—');
});

// ─────────────────────────────────────────────────────────────────────
//  dustBchFormat
// ─────────────────────────────────────────────────────────────────────

test('dustBchFormat: small value (< 1000 sats) → 8 decimals', () => {
  assert.equal(dustBchFormat(500), '0.00000500 BCH');
  assert.equal(dustBchFormat(999), '0.00000999 BCH');
});

test('dustBchFormat: medium value (< 1M sats) → 6 decimals', () => {
  assert.equal(dustBchFormat(50_000), '0.000500 BCH');
  assert.equal(dustBchFormat(999_999), '0.010000 BCH');
});

test('dustBchFormat: large value (>= 1M sats) → 4 decimals', () => {
  assert.equal(dustBchFormat(1_000_000), '0.0100 BCH');
  assert.equal(dustBchFormat(100_000_000), '1.0000 BCH');
});

test('dustBchFormat: null / NaN / unparseable → em-dash', () => {
  assert.equal(dustBchFormat(null), '—');
  assert.equal(dustBchFormat(undefined), '—');
  assert.equal(dustBchFormat(NaN), '—');
  assert.equal(dustBchFormat('not a number'), '—');
});

// ─────────────────────────────────────────────────────────────────────
//  dustSeverity
// ─────────────────────────────────────────────────────────────────────

test('dustSeverity: ratio thresholds', () => {
  assert.equal(dustSeverity(0), 'none');
  assert.equal(dustSeverity(0.0001), 'low');
  assert.equal(dustSeverity(0.5), 'medium');
  assert.equal(dustSeverity(1.0), 'high');
  assert.equal(dustSeverity(1.5), 'critical');
  assert.equal(dustSeverity(100), 'critical');
});

test('dustSeverity: Infinity → critical', () => {
  assert.equal(dustSeverity(Infinity), 'critical');
});

test('dustSeverity: null / NaN / undefined → unknown', () => {
  assert.equal(dustSeverity(null), 'unknown');
  assert.equal(dustSeverity(undefined), 'unknown');
  assert.equal(dustSeverity(NaN), 'unknown');
});

// ─────────────────────────────────────────────────────────────────────
//  dustSeverityClass / dustPillClass
// ─────────────────────────────────────────────────────────────────────

test('dustSeverityClass: every severity has a class', () => {
  assert.equal(typeof dustSeverityClass('critical'), 'string');
  assert.equal(typeof dustSeverityClass('high'), 'string');
  assert.equal(typeof dustSeverityClass('medium'), 'string');
  assert.equal(typeof dustSeverityClass('low'), 'string');
  assert.equal(typeof dustSeverityClass('none'), 'string');
  assert.equal(typeof dustSeverityClass('unknown'), 'string');
});

test('dustSeverityClass: unknown severity → fallback class', () => {
  assert.equal(dustSeverityClass('bogus'), dustSeverityClass('unknown'));
});

test('dustPillClass: every severity has a class', () => {
  for (const sev of ['critical', 'high', 'medium', 'low', 'none', 'unknown']) {
    assert.equal(typeof dustPillClass(sev), 'string');
  }
});

// ─────────────────────────────────────────────────────────────────────
//  dustBlockedReasonClass / dustBlockedReasonLabel
// ─────────────────────────────────────────────────────────────────────

test('dustBlockedReasonClass: every documented reason has a class', () => {
  for (const reason of ['prevent_stop_loss', 'on_chain_sync', 'no_price',
                        'no_price_in_index', 'positions_unavailable',
                        'find_failed', 'knob_off', 'invalid_input']) {
    assert.equal(typeof dustBlockedReasonClass(reason), 'string');
  }
});

test('dustBlockedReasonClass: unknown reason → fallback class', () => {
  const fallback = dustBlockedReasonClass('unknown');
  assert.equal(typeof fallback, 'string');
  assert.equal(dustBlockedReasonClass('bogus'), fallback);
});

test('dustBlockedReasonLabel: documented reasons have human labels', () => {
  assert.equal(dustBlockedReasonLabel('prevent_stop_loss'), 'operator hold');
  assert.equal(dustBlockedReasonLabel('on_chain_sync'), 'on-chain sync');
  assert.equal(dustBlockedReasonLabel('no_price'), 'no price');
  assert.equal(dustBlockedReasonLabel('no_price_in_index'), 'no price');
  assert.equal(dustBlockedReasonLabel('positions_unavailable'), 'positions I/O');
  assert.equal(dustBlockedReasonLabel('find_failed'), 'math error');
  assert.equal(dustBlockedReasonLabel('knob_off'), 'knob off (preview)');
  assert.equal(dustBlockedReasonLabel('invalid_input'), 'invalid input');
});

test('dustBlockedReasonLabel: unknown reason → the reason itself', () => {
  assert.equal(dustBlockedReasonLabel('something_else'), 'something_else');
});

test('dustBlockedReasonLabel: null / undefined / empty → "unknown"', () => {
  assert.equal(dustBlockedReasonLabel(null), 'unknown');
  assert.equal(dustBlockedReasonLabel(undefined), 'unknown');
  assert.equal(dustBlockedReasonLabel(''), 'unknown');
});

// ─────────────────────────────────────────────────────────────────────
//  dustKindLabel / dustKindClass
// ─────────────────────────────────────────────────────────────────────

test('dustKindLabel: documented kinds have labels', () => {
  assert.equal(dustKindLabel('below_cost'), 'cost eats proceeds');
  assert.equal(dustKindLabel('below_min_token_amount'), 'below min token amount');
  assert.equal(dustKindLabel('below_cost_and_min'), 'cost + min amount');
});

test('dustKindLabel: unknown kind → "unknown"', () => {
  assert.equal(dustKindLabel('something_else'), 'something_else');
  assert.equal(dustKindLabel(null), 'unknown');
  assert.equal(dustKindLabel(undefined), 'unknown');
});

test('dustKindClass: every documented kind has a class', () => {
  for (const kind of ['below_cost', 'below_min_token_amount', 'below_cost_and_min']) {
    assert.equal(typeof dustKindClass(kind), 'string');
  }
});

test('dustKindClass: unknown kind → fallback class', () => {
  const fallback = dustKindClass('unknown');
  assert.equal(typeof fallback, 'string');
  assert.equal(dustKindClass('bogus'), fallback);
});

// ─────────────────────────────────────────────────────────────────────
//  buildDustPositionsHeader
// ─────────────────────────────────────────────────────────────────────

test('buildDustPositionsHeader: knob on + 1 dust of 3 open', () => {
  const header = buildDustPositionsHeader(DUST_ENVELOPE);
  assert.equal(header.headline, '1 dust');
  assert.equal(header.subline, 'of 3 open');
  assert.equal(header.knobLabel, 'auto-close on');
  assert.equal(typeof header.knobClass, 'string');
});

test('buildDustPositionsHeader: knob off + 0 dust', () => {
  const header = buildDustPositionsHeader(KNOB_OFF_ENVELOPE);
  assert.equal(header.headline, '0 dust');
  assert.equal(header.subline, 'of 0 open');
  assert.equal(header.knobLabel, 'off');
});

test('buildDustPositionsHeader: knob off + non-zero dust → "off (preview)"', () => {
  const header = buildDustPositionsHeader({
    ...KNOB_OFF_ENVELOPE,
    open_position_count: 5,
    dust_count: 3,
    dust: DUST_ENVELOPE.dust,
  });
  assert.equal(header.knobLabel, 'off (preview)');
});

test('buildDustPositionsHeader: null / undefined env → em-dash headline', () => {
  const header = buildDustPositionsHeader(null);
  assert.equal(header.headline, '— dust');
  assert.equal(header.subline, '— open positions');
  assert.equal(header.knobLabel, 'unknown');
});

// ─────────────────────────────────────────────────────────────────────
//  buildDustRow
// ─────────────────────────────────────────────────────────────────────

test('buildDustRow: happy path projects every display field', () => {
  const row = buildDustRow(DUST_ENVELOPE.dust[0]);
  assert.equal(row.position_id, 'pos_test_001');
  assert.equal(row.token_id.length, 64);
  assert.equal(row.token_id_short, `${'a'.repeat(8)}…`);
  assert.equal(row.token_symbol, 'DUST');
  assert.equal(row.token_decimals, 2);
  assert.equal(row.current_value_bch, '0.00000500 BCH');
  assert.equal(row.total_cost_bch, '0.000015 BCH');
  assert.equal(row.ratio, 3.01);
  assert.equal(row.ratio_display, '3.0100');
  assert.equal(row.severity, 'critical');
  assert.equal(typeof row.severity_class, 'string');
  assert.equal(typeof row.pill_class, 'string');
  assert.equal(row.kind, 'below_cost');
  assert.equal(row.kind_label, 'cost eats proceeds');
  assert.equal(typeof row.kind_class, 'string');
  assert.deepEqual(row.reasons, ['cost_ratio_exceeds_budget:3.0100>=1.5']);
});

test('buildDustRow: null / non-object → null', () => {
  assert.equal(buildDustRow(null), null);
  assert.equal(buildDustRow(undefined), null);
  assert.equal(buildDustRow('not an object'), null);
});

test('buildDustRow: missing fields → em-dash defaults', () => {
  const row = buildDustRow({});
  assert.equal(row.token_symbol, null);
  assert.equal(row.token_decimals, null);
  assert.equal(row.current_value_bch, '—');
  assert.equal(row.total_cost_bch, '—');
  assert.equal(row.ratio, null);
  assert.equal(row.ratio_display, '—');
  assert.equal(row.severity, 'unknown');
  assert.equal(row.kind, 'unknown');
});

test('buildDustRow: reasons missing → empty array', () => {
  const row = buildDustRow({
    position_id: 'pos_x',
    token_id: 'a'.repeat(64),
    ratio_cost_to_proceeds: 0.5,
  });
  assert.deepEqual(row.reasons, []);
});

// ─────────────────────────────────────────────────────────────────────
//  dustPositionsTableRows
// ─────────────────────────────────────────────────────────────────────

test('dustPositionsTableRows: array → mapped rows (nulls filtered)', () => {
  const env = {
    ...DUST_ENVELOPE,
    dust: [
      DUST_ENVELOPE.dust[0],
      null,  // filtered out
      { ...DUST_ENVELOPE.dust[0], position_id: 'pos_test_999' },
    ],
  };
  const rows = dustPositionsTableRows(env);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].position_id, 'pos_test_001');
  assert.equal(rows[1].position_id, 'pos_test_999');
});

test('dustPositionsTableRows: missing env / missing dust → empty', () => {
  assert.deepEqual(dustPositionsTableRows(null), []);
  assert.deepEqual(dustPositionsTableRows({}), []);
  assert.deepEqual(dustPositionsTableRows({ dust: 'not an array' }), []);
});

// ─────────────────────────────────────────────────────────────────────
//  dustPositionsSkippedRows
// ─────────────────────────────────────────────────────────────────────

test('dustPositionsSkippedRows: projects blocked_reason + label + class', () => {
  const rows = dustPositionsSkippedRows(DUST_ENVELOPE);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].blocked_reason, 'prevent_stop_loss');
  assert.equal(rows[0].blocked_reason_label, 'operator hold');
  assert.equal(typeof rows[0].blocked_reason_class, 'string');
  assert.equal(rows[0].token_id_short, `${'b'.repeat(8)}…`);
  assert.equal(rows[1].blocked_reason, 'no_price');
  assert.equal(rows[1].blocked_reason_label, 'no price');
});

test('dustPositionsSkippedRows: missing env → empty', () => {
  assert.deepEqual(dustPositionsSkippedRows(null), []);
  assert.deepEqual(dustPositionsSkippedRows({}), []);
});

test('dustPositionsSkippedRows: filters non-object rows', () => {
  const rows = dustPositionsSkippedRows({
    skipped: [
      DUST_ENVELOPE.skipped[0],
      null,
      'string-not-object',
      { position_id: 'pos_extra', blocked_reason: 'no_price' },
    ],
  });
  assert.equal(rows.length, 2);
});

// ─────────────────────────────────────────────────────────────────────
//  Empty / knob-off messages
// ─────────────────────────────────────────────────────────────────────

test('positionsAreEmptyMessage: static', () => {
  assert.equal(typeof positionsAreEmptyMessage(), 'string');
  assert.match(positionsAreEmptyMessage(), /open positions/);
});

test('dustEmptyMessage: includes the open position count', () => {
  assert.match(dustEmptyMessage({ open_position_count: 5 }), /5 open/);
  assert.match(dustEmptyMessage(null), /0 open/);
  assert.match(dustEmptyMessage({}), /0 open/);
});

test('knobOffMessage: explains the off state + points at the knob', () => {
  const msg = knobOffMessage();
  assert.match(msg, /OFF/i);
  assert.match(msg, /dust_position_auto_close_enabled/);
});

// ─────────────────────────────────────────────────────────────────────
//  dustAutoCloseConfigSnippet
// ─────────────────────────────────────────────────────────────────────

test('dustAutoCloseConfigSnippet: valid JSON, risk.dust_position_auto_close_enabled=true', () => {
  const snippet = dustAutoCloseConfigSnippet();
  const parsed = JSON.parse(snippet);
  assert.equal(parsed.risk.dust_position_auto_close_enabled, true);
});

// ─────────────────────────────────────────────────────────────────────
//  dustCardHasDust / dustCardHasSkipped
// ─────────────────────────────────────────────────────────────────────

test('dustCardHasDust: true when dust[] non-empty', () => {
  assert.equal(dustCardHasDust(DUST_ENVELOPE), true);
  assert.equal(dustCardHasDust(KNOB_OFF_ENVELOPE), false);
  assert.equal(dustCardHasDust(null), false);
  assert.equal(dustCardHasDust({}), false);
  assert.equal(dustCardHasDust({ dust: 'not array' }), false);
});

test('dustCardHasSkipped: true when skipped[] non-empty', () => {
  assert.equal(dustCardHasSkipped(DUST_ENVELOPE), true);
  assert.equal(dustCardHasSkipped(KNOB_OFF_ENVELOPE), false);
  assert.equal(dustCardHasSkipped(null), false);
});

// ─────────────────────────────────────────────────────────────────────
//  buildDustPositionsCardProps (the aggregator)
// ─────────────────────────────────────────────────────────────────────

test('buildDustPositionsCardProps: happy-path envelope → all aggregations correct', () => {
  const props = buildDustPositionsCardProps(DUST_ENVELOPE);
  assert.equal(props.error, null);
  assert.equal(props.isKnobOn, true);
  assert.equal(props.header.headline, '1 dust');
  assert.equal(props.rows.length, 1);
  assert.equal(props.skipped.length, 2);
  assert.equal(props.hasDust, true);
  assert.equal(props.hasSkipped, true);
  assert.equal(props.configSnippet.length > 0, true);
  assert.equal(props.open_position_count, 3);
  assert.equal(props.dust_count, 1);
  assert.equal(props.skipped_count, 2);
  assert.equal(props.skipped_overrides, 1);
  assert.equal(props.skipped_no_price, 1);
  assert.equal(props.ts, DUST_ENVELOPE.ts);
  assert.equal(props.generated_at_ms, DUST_ENVELOPE.generated_at_ms);
});

test('buildDustPositionsCardProps: knob-off envelope → isKnobOn=false + knobOffText populated', () => {
  const props = buildDustPositionsCardProps(KNOB_OFF_ENVELOPE);
  assert.equal(props.isKnobOn, false);
  assert.equal(props.hasDust, false);
  assert.equal(props.hasSkipped, false);
  assert.match(props.knobOffText, /OFF/);
});

test('buildDustPositionsCardProps: error string is preserved verbatim', () => {
  const props = buildDustPositionsCardProps(null, { error: 'request failed' });
  assert.equal(props.error, 'request failed');
});

test('buildDustPositionsCardProps: null env → safe defaults', () => {
  const props = buildDustPositionsCardProps(null);
  assert.equal(props.error, null);
  assert.equal(props.isKnobOn, false);
  assert.equal(props.hasDust, false);
  assert.equal(props.hasSkipped, false);
  assert.equal(props.rows.length, 0);
  assert.equal(props.skipped.length, 0);
  assert.equal(props.open_position_count, 0);
  assert.equal(props.dust_count, 0);
  assert.equal(props.skipped_count, 0);
  assert.equal(props.skipped_overrides, 0);
  assert.equal(props.skipped_no_price, 0);
});

test('buildDustPositionsCardProps: clearText reflects open count from env', () => {
  const props = buildDustPositionsCardProps({ open_position_count: 7, dust: [], skipped: [] });
  assert.match(props.clearText, /7 open/);
});
