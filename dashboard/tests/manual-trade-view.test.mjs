// dashboard/tests/manual-trade-view.test.mjs
//
// Tests for `dashboard/src/views/manual-trade-helpers.mjs` — the
// pure helpers backing the T45b manual-trade panel. Mirrors the
// `proposals-view.test.mjs` / `bugs-view.test.mjs` /
// `risk-panel-view.test.mjs` pattern: every helper is imported
// here directly + exercised under `node --test` without React.
//
// Coverage:
//   - emptyManualDraft shape contract
//   - normalizeManualTokenId (valid / invalid / non-hex / wrong length / non-string / case normalization)
//   - validateManualDraft (each field's happy + reject paths)
//   - buildManualTradeBody (matches `parseManualTradeRequest` wire shape)
//   - filterPoolOptions (empty / substring / multi-field match / case-insensitive / truncation)
//   - poolOptionLabel / poolOptionHint (symbol-only / name-only / id-only fallbacks)
//   - formatManualQuote (null / full envelope / partial envelope / field types)
//   - canExecuteManualTrade (validation gate)
//   - formatSatsShort (large / medium / small / non-finite)
//
// Run via `npm test` (the `node --test tests/**` glob in package.json).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  emptyManualDraft,
  normalizeManualTokenId,
  validateManualDraft,
  buildManualTradeBody,
  filterPoolOptions,
  poolOptionLabel,
  poolOptionHint,
  formatManualQuote,
  canExecuteManualTrade,
  formatSatsShort,
} from '../src/views/manual-trade-helpers.mjs';

// ─────────────────────────────────────────────────────────────────────
//  emptyManualDraft
// ─────────────────────────────────────────────────────────────────────

test('emptyManualDraft: returns a fresh, valid-shape draft', () => {
  const a = emptyManualDraft();
  assert.equal(typeof a, 'object');
  assert.equal(a.side, 'buy');
  assert.equal(a.tokenIdInput, '');
  assert.equal(a.selectedPool, null);
  assert.equal(a.amountBch, '');
  assert.equal(a.expectedRate, '');
  assert.equal(a.dryRun, true);
});

test('emptyManualDraft: each call returns a new object (no shared state)', () => {
  const a = emptyManualDraft();
  const b = emptyManualDraft();
  assert.notEqual(a, b);
  a.side = 'sell';
  assert.equal(b.side, 'buy');
});

// ─────────────────────────────────────────────────────────────────────
//  normalizeManualTokenId
// ─────────────────────────────────────────────────────────────────────

const VALID_HEX = '9a4b5f6e8c1d2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b';

test('normalizeManualTokenId: lower-cases + trims a valid 64-hex', () => {
  assert.equal(normalizeManualTokenId(VALID_HEX.toUpperCase()), VALID_HEX);
  assert.equal(normalizeManualTokenId('  ' + VALID_HEX + '  '), VALID_HEX);
});

test('normalizeManualTokenId: rejects non-string', () => {
  assert.equal(normalizeManualTokenId(null), null);
  assert.equal(normalizeManualTokenId(undefined), null);
  assert.equal(normalizeManualTokenId(123), null);
  assert.equal(normalizeManualTokenId({}), null);
  assert.equal(normalizeManualTokenId([]), null);
});

test('normalizeManualTokenId: rejects wrong length', () => {
  assert.equal(normalizeManualTokenId(''), null);
  assert.equal(normalizeManualTokenId('abcd'), null);
  assert.equal(normalizeManualTokenId('a'.repeat(63)), null);
  assert.equal(normalizeManualTokenId('a'.repeat(65)), null);
});

test('normalizeManualTokenId: rejects non-hex characters', () => {
  assert.equal(normalizeManualTokenId('g'.repeat(64)), null);
  assert.equal(normalizeManualTokenId('z'.repeat(64)), null);
  assert.equal(normalizeManualTokenId(' '.repeat(63) + 'a'), null);
});

test('normalizeManualTokenId: idempotent on already-normalized input', () => {
  assert.equal(normalizeManualTokenId(VALID_HEX), VALID_HEX);
  assert.equal(normalizeManualTokenId(normalizeManualTokenId(VALID_HEX)), VALID_HEX);
});

// ─────────────────────────────────────────────────────────────────────
//  validateManualDraft
// ─────────────────────────────────────────────────────────────────────

const validDraft = () => ({
  side: 'buy',
  tokenIdInput: VALID_HEX,
  selectedPool: null,
  amountBch: '0.005',
  expectedRate: '',
  dryRun: true,
});

test('validateManualDraft: empty draft returns multiple errors', () => {
  const errs = validateManualDraft({});
  assert.ok(Array.isArray(errs));
  assert.ok(errs.length >= 3);
  assert.ok(errs.some((e) => /side/.test(e)));
  assert.ok(errs.some((e) => /token/.test(e)));
  assert.ok(errs.some((e) => /amount/.test(e)));
});

test('validateManualDraft: non-object draft returns the guard error', () => {
  assert.deepEqual(validateManualDraft(null), ['draft must be an object']);
  assert.deepEqual(validateManualDraft('foo'), ['draft must be an object']);
  assert.deepEqual(validateManualDraft(42), ['draft must be an object']);
});

test('validateManualDraft: side enum', () => {
  const draft = validDraft();
  draft.side = 'BUY';
  assert.ok(validateManualDraft(draft).some((e) => /side/.test(e)));
  draft.side = 'hold';
  assert.ok(validateManualDraft(draft).some((e) => /side/.test(e)));
  draft.side = 'buy';
  assert.equal(validateManualDraft(draft).length, 0);
  draft.side = 'sell';
  assert.equal(validateManualDraft(draft).length, 0);
});

test('validateManualDraft: token accepts a paste OR a selected pool', () => {
  const draft = validDraft();
  // Paste path is the default — should validate.
  assert.equal(validateManualDraft(draft).length, 0);
  // Empty paste + selected pool → validates.
  draft.tokenIdInput = '';
  draft.selectedPool = { token_id: VALID_HEX, symbol: 'X', decimals: 0, name: null, tvl_sats: null, trade_volume: null };
  assert.equal(validateManualDraft(draft).length, 0);
  // Mismatched paste vs pool → rejects.
  draft.tokenIdInput = 'a'.repeat(64);
  assert.ok(validateManualDraft(draft).some((e) => /does not match/.test(e)));
});

test('validateManualDraft: token rejects non-hex / wrong-length paste', () => {
  const draft = validDraft();
  draft.tokenIdInput = 'abcd';
  assert.ok(validateManualDraft(draft).some((e) => /64-hex/.test(e)));
  draft.tokenIdInput = 'g'.repeat(64);
  assert.ok(validateManualDraft(draft).some((e) => /64-hex/.test(e)));
  // Empty paste + no pool → rejects.
  draft.selectedPool = null;
  draft.tokenIdInput = '';
  assert.ok(validateManualDraft(draft).some((e) => /64-hex/.test(e)));
});

test('validateManualDraft: amount must be a positive finite number', () => {
  const draft = validDraft();
  draft.amountBch = '0';
  assert.ok(validateManualDraft(draft).some((e) => /amount_bch/.test(e)));
  draft.amountBch = '-1';
  assert.ok(validateManualDraft(draft).some((e) => /amount_bch/.test(e)));
  draft.amountBch = 'abc';
  assert.ok(validateManualDraft(draft).some((e) => /amount_bch/.test(e)));
  draft.amountBch = '';
  assert.ok(validateManualDraft(draft).some((e) => /amount_bch/.test(e)));
  draft.amountBch = '0.005';
  assert.equal(validateManualDraft(draft).length, 0);
});

test('validateManualDraft: expected rate is optional but must be positive when present', () => {
  const draft = validDraft();
  draft.expectedRate = '0';
  assert.ok(validateManualDraft(draft).some((e) => /expected_rate/.test(e)));
  draft.expectedRate = '-5';
  assert.ok(validateManualDraft(draft).some((e) => /expected_rate/.test(e)));
  draft.expectedRate = 'abc';
  assert.ok(validateManualDraft(draft).some((e) => /expected_rate/.test(e)));
  draft.expectedRate = '100';
  assert.equal(validateManualDraft(draft).length, 0);
  // Empty / null / undefined is fine (the field is optional).
  draft.expectedRate = '';
  assert.equal(validateManualDraft(draft).length, 0);
  draft.expectedRate = null;
  assert.equal(validateManualDraft(draft).length, 0);
  draft.expectedRate = undefined;
  assert.equal(validateManualDraft(draft).length, 0);
});

// ─────────────────────────────────────────────────────────────────────
//  buildManualTradeBody
// ─────────────────────────────────────────────────────────────────────

test('buildManualTradeBody: returns null on invalid draft', () => {
  assert.equal(buildManualTradeBody({}), null);
  assert.equal(buildManualTradeBody(null), null);
  // Invalid side — must reject.
  assert.equal(buildManualTradeBody({ side: 'hold', amountBch: '0.005', tokenIdInput: VALID_HEX }), null);
  // Invalid amount — must reject.
  assert.equal(buildManualTradeBody({ side: 'buy', amountBch: '0', tokenIdInput: VALID_HEX }), null);
  // Invalid token — must reject.
  assert.equal(buildManualTradeBody({ side: 'buy', amountBch: '0.005', tokenIdInput: 'abcd' }), null);
});

test('buildManualTradeBody: maps fields to the wire shape', () => {
  const body = buildManualTradeBody({
    side: 'sell',
    tokenIdInput: VALID_HEX.toUpperCase(),
    selectedPool: null,
    amountBch: '0.003',
    expectedRate: '99',
    dryRun: true,
  });
  assert.deepEqual(body, {
    token_id: VALID_HEX,
    side: 'sell',
    amount_bch: 0.003,
    dry_run: true,
    expected_rate_sats_per_token: 99,
  });
});

test('buildManualTradeBody: omits expected_rate when blank', () => {
  const body = buildManualTradeBody({
    side: 'buy',
    tokenIdInput: VALID_HEX,
    selectedPool: null,
    amountBch: '0.001',
    expectedRate: '',
    dryRun: false,
  });
  assert.equal(body.dry_run, false);
  assert.equal(body.expected_rate_sats_per_token, undefined);
  assert.ok(!Object.keys(body).includes('expected_rate_sats_per_token'));
});

test('buildManualTradeBody: lowercases pool token_id when picked from autocomplete', () => {
  const body = buildManualTradeBody({
    side: 'buy',
    tokenIdInput: VALID_HEX.toUpperCase(),
    selectedPool: { token_id: VALID_HEX.toUpperCase(), symbol: 'X', decimals: 0, name: null, tvl_sats: null, trade_volume: null },
    amountBch: '0.005',
    expectedRate: '',
    dryRun: true,
  });
  assert.equal(body.token_id, VALID_HEX);
});

// ─────────────────────────────────────────────────────────────────────
//  filterPoolOptions
// ─────────────────────────────────────────────────────────────────────

const SAMPLE_POOLS = [
  { token_id: VALID_HEX, symbol: 'NWB', name: 'NewB', tvl_sats: 1_000_000_000, trade_volume: 50_000, decimals: 2 },
  { token_id: 'a'.repeat(64), symbol: 'OLA', name: 'Olive', tvl_sats: 500_000, trade_volume: 12_345, decimals: 0 },
  { token_id: 'b'.repeat(64), symbol: 'HONEY', name: 'Honeycoin', tvl_sats: 0, trade_volume: null, decimals: 4 },
  { token_id: 'c'.repeat(64), symbol: null, name: null, tvl_sats: null, trade_volume: null, decimals: null },
];

test('filterPoolOptions: empty query returns up to 50 options', () => {
  const out = filterPoolOptions(SAMPLE_POOLS, '');
  assert.equal(out.length, SAMPLE_POOLS.length);
});

test('filterPoolOptions: query trims + lowercases', () => {
  assert.equal(filterPoolOptions(SAMPLE_POOLS, '  NWB  ').length, 1);
  assert.equal(filterPoolOptions(SAMPLE_POOLS, 'nwb').length, 1);
  assert.equal(filterPoolOptions(SAMPLE_POOLS, 'honey').length, 1);
  assert.equal(filterPoolOptions(SAMPLE_POOLS, 'no-match').length, 0);
});

test('filterPoolOptions: matches token_id substring', () => {
  // First char of VALID_HEX is '9' — search by '9a4b' should hit.
  assert.equal(filterPoolOptions(SAMPLE_POOLS, '9a4b').length, 1);
  // Token without symbol/name can still be found by id.
  assert.equal(filterPoolOptions(SAMPLE_POOLS, 'cccc').length, 1);
});

test('filterPoolOptions: non-array input returns empty list', () => {
  assert.deepEqual(filterPoolOptions(null, ''), []);
  assert.deepEqual(filterPoolOptions(undefined, ''), []);
  assert.deepEqual(filterPoolOptions('garbage', ''), []);
});

test('filterPoolOptions: non-string query is treated as empty', () => {
  assert.equal(filterPoolOptions(SAMPLE_POOLS, null).length, SAMPLE_POOLS.length);
  assert.equal(filterPoolOptions(SAMPLE_POOLS, 42).length, SAMPLE_POOLS.length);
});

test('filterPoolOptions: caps result at 50', () => {
  const big = Array.from({ length: 100 }, (_, i) => ({
    token_id: i.toString(16).padStart(64, '0'),
    symbol: `T${i}`,
    name: null,
    tvl_sats: null,
    trade_volume: null,
    decimals: 0,
  }));
  const out = filterPoolOptions(big, '');
  assert.equal(out.length, 50);
});

// ─────────────────────────────────────────────────────────────────────
//  poolOptionLabel / poolOptionHint
// ─────────────────────────────────────────────────────────────────────

test('poolOptionLabel: prefers symbol · name over symbol alone', () => {
  assert.equal(poolOptionLabel({ token_id: VALID_HEX, symbol: 'NWB', name: 'NewB', tvl_sats: 1 }), 'NWB · NewB');
});

test('poolOptionLabel: falls back to symbol when no name', () => {
  assert.equal(poolOptionLabel({ token_id: VALID_HEX, symbol: 'NWB', name: null, tvl_sats: 1 }), 'NWB');
});

test('poolOptionLabel: falls back to name when no symbol', () => {
  assert.equal(poolOptionLabel({ token_id: VALID_HEX, symbol: null, name: 'NewB', tvl_sats: 1 }), 'NewB');
});

test('poolOptionLabel: falls back to truncated id when both missing', () => {
  const out = poolOptionLabel({ token_id: VALID_HEX, symbol: null, name: null, tvl_sats: null });
  assert.equal(out, VALID_HEX.slice(0, 10) + '…');
});

test('poolOptionLabel: handles garbage input gracefully', () => {
  assert.equal(poolOptionLabel(null), '');
  assert.equal(poolOptionLabel(undefined), '');
  assert.equal(poolOptionLabel({}), '');
});

test('poolOptionHint: tvl + vol + truncated id', () => {
  const out = poolOptionHint({
    token_id: VALID_HEX, symbol: 'X', name: null, tvl_sats: 2_500_000_000, trade_volume: 1_200_000, decimals: 0,
  });
  assert.match(out, /tvl 25\.00 BCH/);
  assert.match(out, /vol 1\.20 M sat/);
  assert.match(out, new RegExp(VALID_HEX.slice(0, 12)));
});

test('poolOptionHint: skips null tvl/vol', () => {
  const out = poolOptionHint({
    token_id: VALID_HEX, symbol: 'X', name: null, tvl_sats: null, trade_volume: null, decimals: 0,
  });
  // Should be just the truncated id with no tvl/vol prefixes.
  assert.equal(out, VALID_HEX.slice(0, 12) + '…');
});

test('poolOptionHint: handles garbage input gracefully', () => {
  assert.equal(poolOptionHint(null), '');
  assert.equal(poolOptionHint({}), '');
});

// ─────────────────────────────────────────────────────────────────────
//  formatManualQuote
// ─────────────────────────────────────────────────────────────────────

test('formatManualQuote: null / non-object result returns the "no result" envelope', () => {
  const empty = formatManualQuote(null, 'buy');
  assert.deepEqual(empty, {
    ok: false,
    errorKind: null,
    errorMessage: 'no result',
    rateLabel: null,
    amountLabel: null,
    slippageLabel: null,
    lpFeeLabel: null,
    networkFeeLabel: null,
    balanceAfterLabel: null,
    txid: null,
    isDryRun: false,
  });
  assert.equal(formatManualQuote(undefined, 'sell').errorMessage, 'no result');
});

test('formatManualQuote: full envelope (stringified bigints from backend)', () => {
  const q = formatManualQuote({
    ok: true,
    side: 'buy',
    tokenId: VALID_HEX,
    effectiveRateSats: '97.5',
    expectedRateSats: '97',
    slippageBps: '50',
    totalSatsInOrOut: '500000',
    lpFeeSats: '1500',
    estNetworkFeeSats: '1200',
    txid: 'a'.repeat(64),
    error: null,
    errorKind: null,
  }, 'buy');
  assert.equal(q.ok, true);
  assert.equal(q.txid, 'a'.repeat(64));
  assert.match(q.rateLabel, /97\.50 sat\/token/);
  assert.match(q.slippageLabel, /^50 bps$/);
  assert.match(q.amountLabel, /spent/);
  // 500000 sats = 500.0 k sat (compact formatter, not raw integer).
  assert.match(q.amountLabel, /500\.0 k sat/);
  assert.match(q.lpFeeLabel, /1\.5 k sat/);
  assert.match(q.networkFeeLabel, /1\.2 k sat/);
});

test('formatManualQuote: failed envelope surfaces errorKind + error', () => {
  const q = formatManualQuote({
    ok: false,
    error: 'swap executor threw: insufficient balance',
    errorKind: 'INSUFFICIENT_BALANCE',
  }, 'sell');
  assert.equal(q.ok, false);
  assert.equal(q.errorKind, 'INSUFFICIENT_BALANCE');
  assert.match(q.errorMessage, /insufficient balance/);
  assert.equal(q.txid, null);
});

test('formatManualQuote: tolerates numeric bigints (not just strings)', () => {
  const q = formatManualQuote({
    ok: true,
    effectiveRateSats: 97,
    slippageBps: 0,
    totalSatsInOrOut: 100000,
    lpFeeSats: 1500,
    estNetworkFeeSats: 1200,
    walletBalanceAfterSats: 50000000,
  }, 'buy');
  assert.equal(q.ok, true);
  assert.match(q.rateLabel, /97\.00 sat\/token/);
  assert.match(q.slippageLabel, /^0 bps$/);
  // 50,000,000 sats = 50.00 M sat (compact formatter).
  assert.match(q.balanceAfterLabel, /50\.00 M sat/);
});

test('formatManualQuote: missing fields render as null (not NaN)', () => {
  const q = formatManualQuote({ ok: true }, 'buy');
  assert.equal(q.rateLabel, null);
  assert.equal(q.slippageLabel, null);
  assert.equal(q.lpFeeLabel, null);
});

// ─────────────────────────────────────────────────────────────────────
//  canExecuteManualTrade
// ─────────────────────────────────────────────────────────────────────

test('canExecuteManualTrade: mirrors validateManualDraft gate', () => {
  assert.equal(canExecuteManualTrade({}), false);
  assert.equal(canExecuteManualTrade(validDraft()), true);
  const d = validDraft();
  d.amountBch = '0';
  assert.equal(canExecuteManualTrade(d), false);
});

// ─────────────────────────────────────────────────────────────────────
//  formatSatsShort
// ─────────────────────────────────────────────────────────────────────

test('formatSatsShort: large values render as BCH', () => {
  assert.equal(formatSatsShort(100_000_000), '1.00 BCH');
  assert.equal(formatSatsShort(250_000_000), '2.50 BCH');
});

test('formatSatsShort: mid values render as M sat', () => {
  assert.equal(formatSatsShort(1_500_000), '1.50 M sat');
  assert.equal(formatSatsShort(99_000_000), '99.00 M sat');
});

test('formatSatsShort: small values render as k sat / sat', () => {
  assert.equal(formatSatsShort(1500), '1.5 k sat');
  assert.equal(formatSatsShort(500), '500 sat');
});

test('formatSatsShort: non-finite returns placeholder', () => {
  assert.equal(formatSatsShort(NaN), '—');
  assert.equal(formatSatsShort(Infinity), '—');
  assert.equal(formatSatsShort(null), '—');
  assert.equal(formatSatsShort('garbage'), '—');
});

test('formatSatsShort: bigints are coerced', () => {
  assert.equal(formatSatsShort(100_000_000n), '1.00 BCH');
});
