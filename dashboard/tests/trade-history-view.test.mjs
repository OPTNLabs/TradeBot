// dashboard/tests/trade-history-view.test.mjs
//
// Tests for the T42 Trade History view helpers. Pure helpers
// (filter shape, validation, classification, params builder,
// token-option derivation) — same pattern as
// proposals-view.test.mjs / bugs-view.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RANGE_OPTIONS, EVENT_KIND_OPTIONS, PNL_OPTIONS, SIDE_OPTIONS,
  emptyTradeHistoryFilters,
  validateTradeHistoryFilters,
  TradeHistoryValidationError,
  eventKindClass, pnlSignClass,
  formatSignedSats, statusLabel, classifyPnl,
  tokenOptionsFromEvents, tradeHistoryParamsFromFilters,
} from '../src/views/trade-history-helpers.mjs';

// ─────────────────────────────────────────────────────────────────────
//  Static option lists
// ─────────────────────────────────────────────────────────────────────

test('RANGE_OPTIONS: covers the common presets + an explicit "all"', () => {
  const values = RANGE_OPTIONS.map((o) => o.value);
  assert.ok(values.includes('24h'));
  assert.ok(values.includes('7d'));
  assert.ok(values.includes('30d'));
  assert.ok(values.includes('all'));
});

test('EVENT_KIND_OPTIONS: any/entry/exit exactly', () => {
  assert.deepEqual(
    EVENT_KIND_OPTIONS.map((o) => o.value),
    ['any', 'entry', 'exit'],
  );
});

test('PNL_OPTIONS: covers any/gain/loss/flat', () => {
  const values = PNL_OPTIONS.map((o) => o.value);
  assert.deepEqual(values, ['any', 'gain', 'loss', 'flat']);
});

test('SIDE_OPTIONS: ships with an empty-string "any" + the two known sides', () => {
  assert.equal(SIDE_OPTIONS[0].value, '');
  assert.ok(SIDE_OPTIONS.some((s) => s.value === 'long_token'));
  assert.ok(SIDE_OPTIONS.some((s) => s.value === 'short_token'));
});

// ─────────────────────────────────────────────────────────────────────
//  emptyTradeHistoryFilters
// ─────────────────────────────────────────────────────────────────────

test('emptyTradeHistoryFilters: returns a defensive shape', () => {
  const f = emptyTradeHistoryFilters();
  assert.equal(f.range, '30d');
  assert.equal(f.eventKind, 'any');
  assert.equal(f.side, '');
  assert.equal(f.tokenId, '');
  assert.equal(f.pnl, 'any');
  assert.equal(f.limit, 500);
});

// ─────────────────────────────────────────────────────────────────────
//  validateTradeHistoryFilters
// ─────────────────────────────────────────────────────────────────────

test('validateTradeHistoryFilters: passes the empty default', () => {
  const f = validateTradeHistoryFilters(emptyTradeHistoryFilters());
  assert.equal(f.range, '30d');
});

test('validateTradeHistoryFilters: accepts a custom range string', () => {
  const f = validateTradeHistoryFilters({ ...emptyTradeHistoryFilters(), range: '12h' });
  assert.equal(f.range, '12h');
});

test('validateTradeHistoryFilters: rejects unknown range', () => {
  assert.throws(
    () => validateTradeHistoryFilters({ ...emptyTradeHistoryFilters(), range: 'banana' }),
    (e) => e instanceof TradeHistoryValidationError,
  );
});

test('validateTradeHistoryFilters: rejects unknown eventKind', () => {
  assert.throws(
    () => validateTradeHistoryFilters({ ...emptyTradeHistoryFilters(), eventKind: 'banana' }),
    (e) => e instanceof TradeHistoryValidationError,
  );
});

test('validateTradeHistoryFilters: rejects unknown side', () => {
  assert.throws(
    () => validateTradeHistoryFilters({ ...emptyTradeHistoryFilters(), side: 'banana' }),
    (e) => e instanceof TradeHistoryValidationError,
  );
});

test('validateTradeHistoryFilters: rejects unknown pnl', () => {
  assert.throws(
    () => validateTradeHistoryFilters({ ...emptyTradeHistoryFilters(), pnl: 'banana' }),
    (e) => e instanceof TradeHistoryValidationError,
  );
});

test('validateTradeHistoryFilters: rejects malformed tokenId', () => {
  assert.throws(
    () => validateTradeHistoryFilters({ ...emptyTradeHistoryFilters(), tokenId: 'nope' }),
    (e) => e instanceof TradeHistoryValidationError,
  );
  assert.throws(
    () => validateTradeHistoryFilters({ ...emptyTradeHistoryFilters(), tokenId: 'a'.repeat(63) }),
    (e) => e instanceof TradeHistoryValidationError,
  );
});

test('validateTradeHistoryFilters: accepts a 64-hex tokenId', () => {
  const id = 'a'.repeat(64);
  const f = validateTradeHistoryFilters({ ...emptyTradeHistoryFilters(), tokenId: id });
  assert.equal(f.tokenId, id);
});

test('validateTradeHistoryFilters: rejects non-object', () => {
  assert.throws(
    () => validateTradeHistoryFilters(null),
    (e) => e instanceof TradeHistoryValidationError,
  );
  assert.throws(
    () => validateTradeHistoryFilters('hello'),
    (e) => e instanceof TradeHistoryValidationError,
  );
});

test('validateTradeHistoryFilters: defaults invalid limit to 500', () => {
  const f = validateTradeHistoryFilters({ ...emptyTradeHistoryFilters(), limit: 0 });
  assert.equal(f.limit, 500);
  const f2 = validateTradeHistoryFilters({ ...emptyTradeHistoryFilters(), limit: -3 });
  assert.equal(f2.limit, 500);
});

test('validateTradeHistoryFilters: floors fractional limits', () => {
  const f = validateTradeHistoryFilters({ ...emptyTradeHistoryFilters(), limit: 100.9 });
  assert.equal(f.limit, 100);
});

// ─────────────────────────────────────────────────────────────────────
//  Pill classifiers
// ─────────────────────────────────────────────────────────────────────

test('eventKindClass: maps entry/exit/other', () => {
  assert.match(eventKindClass('entry'), /bch-/);
  assert.match(eventKindClass('exit'), /pnl-pos/);
  assert.match(eventKindClass('banana'), /ash-/);
});

test('pnlSignClass: maps gain/loss/flat/null', () => {
  assert.match(pnlSignClass('gain'), /pnl-pos/);
  assert.match(pnlSignClass('loss'), /pnl-neg/);
  assert.match(pnlSignClass('flat'), /ash-/);
  assert.match(pnlSignClass(null), /ash-/);
  assert.match(pnlSignClass(undefined), /ash-/);
});

// ─────────────────────────────────────────────────────────────────────
//  formatSignedSats
// ─────────────────────────────────────────────────────────────────────

test('formatSignedSats: positive → "+N,NNN"', () => {
  assert.equal(formatSignedSats(12345), '+12,345');
  assert.equal(formatSignedSats(0), '0');
  assert.equal(formatSignedSats(-12345), '-12,345');
});

test('formatSignedSats: null/undefined/NaN → "—"', () => {
  assert.equal(formatSignedSats(null), '—');
  assert.equal(formatSignedSats(undefined), '—');
  assert.equal(formatSignedSats(Number.NaN), '—');
  assert.equal(formatSignedSats('hello'), '—');
});

test('formatSignedSats: handles fractional sats by truncating', () => {
  assert.equal(formatSignedSats(1.9), '+1');
  assert.equal(formatSignedSats(-1.9), '-1');
});

// ─────────────────────────────────────────────────────────────────────
//  statusLabel
// ─────────────────────────────────────────────────────────────────────

test('statusLabel: returns canonical label or "—"', () => {
  assert.equal(statusLabel('open'), 'open');
  assert.equal(statusLabel('pending'), 'pending');
  assert.equal(statusLabel('closing'), 'closing');
  assert.equal(statusLabel('closed'), 'closed');
  assert.equal(statusLabel(null), '—');
  assert.equal(statusLabel('banana'), '—');
});

// ─────────────────────────────────────────────────────────────────────
//  classifyPnl
// ─────────────────────────────────────────────────────────────────────

test('classifyPnl: derives gain/loss/flat/null', () => {
  assert.equal(classifyPnl(100), 'gain');
  assert.equal(classifyPnl(-100), 'loss');
  assert.equal(classifyPnl(0), 'flat');
  assert.equal(classifyPnl(null), null);
  assert.equal(classifyPnl(Number.NaN), null);
  assert.equal(classifyPnl('100'), null);
});

// ─────────────────────────────────────────────────────────────────────
//  tokenOptionsFromEvents
// ─────────────────────────────────────────────────────────────────────

test('tokenOptionsFromEvents: always starts with the "any token" sentinel', () => {
  const opts = tokenOptionsFromEvents([], '');
  assert.equal(opts.length, 1);
  assert.equal(opts[0].value, '');
  assert.equal(opts[0].label, 'any token');
});

test('tokenOptionsFromEvents: derives one option per distinct token_id', () => {
  const opts = tokenOptionsFromEvents([
    { token_id: 'aa'.padEnd(64, 'a'), token_symbol: 'AAA' },
    { token_id: 'aa'.padEnd(64, 'a'), token_symbol: 'AAA' }, // duplicate
    { token_id: 'bb'.padEnd(64, 'b'), token_symbol: 'BBB' },
  ], '');
  assert.equal(opts.length, 3); // any + 2
  assert.equal(opts[1].label, 'AAA');
  assert.equal(opts[2].label, 'BBB');
});

test('tokenOptionsFromEvents: truncates token_id when symbol is missing', () => {
  const id = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
  const opts = tokenOptionsFromEvents([{ token_id: id }], '');
  // 123456…cdef truncated to 123456…cdef (6+…+4)
  assert.match(opts[1].label, /^123456…cdef$/);
});

test('tokenOptionsFromEvents: keeps an active filter token in the list', () => {
  const id = 'cc'.padEnd(64, 'c');
  const opts = tokenOptionsFromEvents([], id);
  assert.equal(opts.length, 2); // any + active
  assert.equal(opts[1].value, id);
});

// ─────────────────────────────────────────────────────────────────────
//  tradeHistoryParamsFromFilters
// ─────────────────────────────────────────────────────────────────────

test('tradeHistoryParamsFromFilters: empty defaults produce an empty params (all omitted)', () => {
  const p = tradeHistoryParamsFromFilters(emptyTradeHistoryFilters());
  assert.equal(p.toString(), '');
});

test('tradeHistoryParamsFromFilters: range=30d is also omitted (it is the default)', () => {
  const p = tradeHistoryParamsFromFilters({ ...emptyTradeHistoryFilters(), range: '30d' });
  assert.equal(p.toString(), '');
});

test('tradeHistoryParamsFromFilters: custom range, eventKind, side, tokenId, pnl, limit', () => {
  const id = 'a'.repeat(64);
  const p = tradeHistoryParamsFromFilters({
    range: '7d',
    eventKind: 'exit',
    side: 'long_token',
    tokenId: id,
    pnl: 'gain',
    limit: 100,
  });
  const params = Object.fromEntries(p.entries());
  assert.equal(params.range, '7d');
  assert.equal(params.event_kind, 'exit');
  assert.equal(params.side, 'long_token');
  assert.equal(params.token_id, id);
  assert.equal(params.pnl, 'gain');
  assert.equal(params.limit, '100');
});

test('tradeHistoryParamsFromFilters: invalid draft throws', () => {
  assert.throws(
    () => tradeHistoryParamsFromFilters({ ...emptyTradeHistoryFilters(), range: 'banana' }),
    (e) => e instanceof TradeHistoryValidationError,
  );
});

test('tradeHistoryParamsFromFilters: limit=500 is omitted (default)', () => {
  const p = tradeHistoryParamsFromFilters({ ...emptyTradeHistoryFilters(), limit: 500 });
  assert.equal(p.toString(), '');
});
