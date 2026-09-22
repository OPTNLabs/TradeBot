#!/usr/bin/env node
/**
 * Unit tests for src/dashboard/token-holders.mjs.
 *
 * Covers the T76 subset 1 stub endpoint + the operator-testing
 * `?holders=` fixture affordance + the pure-math re-exports.
 *
 * Pure-function tests. The handlers don't perform any I/O — they
 * just validate + delegate to `src/strategy/holder-concentration.mjs`.
 *
 * Run via:
 *   npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateTokenIdForHolders,
  buildScannerNotImplementedEnvelope,
  buildHoldersEnvelopeFromFixture,
  buildTokenHoldersLiveEnvelope,
  getTokenHolders,
  isConcentrationRugEnabled,
  concentrationRugProviderUrl,
  concentrationRugTimeoutMs,
  computeHolderConcentration,
  isRugPatternByHolders,
  isTruthyString,
  DEFAULT_HOLDER_CONCENTRATION_CONFIG,
} from '../src/dashboard/token-holders.mjs';
import { HoldersScannerCache } from '../src/strategy/holder-scanner-cache.mjs';

// ─────────────────────────────────────────────────────────────────────
//  validateTokenIdForHolders
// ─────────────────────────────────────────────────────────────────────

test('validateTokenIdForHolders: 64-char lowercase hex accepted', () => {
  assert.equal(
    validateTokenIdForHolders('a'.repeat(64)),
    'a'.repeat(64),
  );
  assert.equal(
    validateTokenIdForHolders('0123456789abcdef'.repeat(4)),
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  );
});

test('validateTokenIdForHolders: 64-char mixed-case hex normalized to lowercase', () => {
  const mixed = 'ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890';
  assert.equal(validateTokenIdForHolders(mixed), mixed.toLowerCase());
});

test('validateTokenIdForHolders: 64-char with leading/trailing whitespace trimmed', () => {
  const id = 'a'.repeat(64);
  assert.equal(validateTokenIdForHolders(`  ${id}  `), id);
});

test('validateTokenIdForHolders: short id rejected', () => {
  assert.equal(validateTokenIdForHolders('a'.repeat(63)), null);
  assert.equal(validateTokenIdForHolders('a'.repeat(65)), null);
  assert.equal(validateTokenIdForHolders('abc'), null);
});

test('validateTokenIdForHolders: non-hex rejected', () => {
  assert.equal(validateTokenIdForHolders('z'.repeat(64)), null);
  assert.equal(validateTokenIdForHolders('g'.repeat(64)), null);
});

test('validateTokenIdForHolders: non-string rejected', () => {
  assert.equal(validateTokenIdForHolders(null), null);
  assert.equal(validateTokenIdForHolders(undefined), null);
  assert.equal(validateTokenIdForHolders(42), null);
  assert.equal(validateTokenIdForHolders({}), null);
});

test('validateTokenIdForHolders: empty string rejected', () => {
  assert.equal(validateTokenIdForHolders(''), null);
  assert.equal(validateTokenIdForHolders('   '), null);
});

// ─────────────────────────────────────────────────────────────────────
//  buildScannerNotImplementedEnvelope
// ─────────────────────────────────────────────────────────────────────

test('buildScannerNotImplementedEnvelope: shape', () => {
  const id = 'a'.repeat(64);
  const env = buildScannerNotImplementedEnvelope(id, {});
  assert.equal(env.ok, false);
  assert.equal(env.schema, 'tradebot.dashboard.token-holders/v1');
  assert.equal(env.token_id, id);
  assert.equal(env.error, 'scanner_not_implemented');
  assert.equal(env.subset, 'T76/1');
  assert.equal(env.available_in, 'T76/2');
  assert.equal(typeof env.message, 'string');
  assert.equal(env.message.includes('T76 subset 2'), true);
  assert.equal(env.message.includes('excluded_concentration_tokens'), true);
  assert.equal(typeof env.ts, 'number');
});

test('buildScannerNotImplementedEnvelope: ts is finite number', () => {
  const env = buildScannerNotImplementedEnvelope('a'.repeat(64), {});
  assert.equal(Number.isFinite(env.ts), true);
});

// ─────────────────────────────────────────────────────────────────────
//  buildHoldersEnvelopeFromFixture
// ─────────────────────────────────────────────────────────────────────

test('buildHoldersEnvelopeFromFixture: happy path delegates to computeHolderConcentration', () => {
  const id = 'a'.repeat(64);
  const json = JSON.stringify([
    { address: 'bitcoincash:qpa', balance_base: '800' },
    { address: 'bitcoincash:qpb', balance_base: '100' },
    { address: 'bitcoincash:qpc', balance_base: '100' },
  ]);
  const env = buildHoldersEnvelopeFromFixture(id, json);
  assert.equal(env.ok, true);
  assert.equal(env.fixture, true);
  assert.equal(env.schema, 'tradebot.dashboard.token-holders/v1');
  assert.equal(env.token_id, id);
  assert.equal(env.total_holders, 3);
  // top-5 of total is 100% (3 holders, top-5 captures all of them)
  assert.equal(env.top_n_pct, 100);
  assert.equal(env.rug_pattern, true);
});

test('buildHoldersEnvelopeFromFixture: bad JSON returns typed envelope', () => {
  const id = 'a'.repeat(64);
  const env = buildHoldersEnvelopeFromFixture(id, '{not-json}');
  assert.equal(env.ok, false);
  assert.equal(env.fixture, true);
  assert.equal(env.error, 'fixture_parse_failed');
  assert.equal(typeof env.message, 'string');
});

test('buildHoldersEnvelopeFromFixture: empty array is valid (no holders)', () => {
  const id = 'a'.repeat(64);
  const env = buildHoldersEnvelopeFromFixture(id, '[]');
  assert.equal(env.ok, true);
  assert.equal(env.total_holders, 0);
  assert.equal(env.top_n_pct, 0);
  assert.equal(env.rug_pattern, false);
});

test('buildHoldersEnvelopeFromFixture: opts override defaults', () => {
  const id = 'a'.repeat(64);
  const json = JSON.stringify([
    { address: 'bitcoincash:qpa', balance_base: '50' },
    { address: 'bitcoincash:qpb', balance_base: '30' },
    { address: 'bitcoincash:qpc', balance_base: '20' },
  ]);
  const env = buildHoldersEnvelopeFromFixture(id, json, {
    rug_top_n: 2,
    rug_threshold_pct: 50,
  });
  assert.equal(env.ok, true);
  // top-2 = 50+30 = 80, 80/100 = 80%
  assert.equal(env.top_n_pct, 80);
  assert.equal(env.rug_pattern, true);
});

test('buildHoldersEnvelopeFromFixture: decimals propagation', () => {
  const id = 'a'.repeat(64);
  // 150 base units with decimals=2 = 1.5 human (matches the math
  // established in strategy-holder-concentration.test.mjs:
  // `baseToHumanString(150n, 2)` → '1.5')
  const env = buildHoldersEnvelopeFromFixture(
    id,
    JSON.stringify([{ address: 'bitcoincash:qpa', balance_base: '150' }]),
    { decimals: 2 },
  );
  assert.equal(env.total_supply_human, '1.5');
});

// ─────────────────────────────────────────────────────────────────────
//  getTokenHolders (handler entry point)
// ─────────────────────────────────────────────────────────────────────

test('getTokenHolders: invalid token_id → invalid_token_id', async () => {
  const env = await getTokenHolders({}, 'not-hex', new URL('http://x.invalid/'));
  assert.equal(env.ok, false);
  assert.equal(env.error, 'invalid_token_id');
});

test('getTokenHolders: missing token_id → invalid_token_id', async () => {
  const env = await getTokenHolders({}, undefined, new URL('http://x.invalid/'));
  assert.equal(env.ok, false);
  assert.equal(env.error, 'invalid_token_id');
});

test('getTokenHolders: stub envelope when no fixture', async () => {
  const id = 'a'.repeat(64);
  const env = await getTokenHolders({}, id, new URL(`http://x.invalid/api/token/${id}/holders`));
  assert.equal(env.ok, false);
  assert.equal(env.error, 'scanner_not_implemented');
  assert.equal(env.subset, 'T76/1');
});

test('getTokenHolders: ?holders= fixture branch runs the math', async () => {
  const id = 'a'.repeat(64);
  const fixture = encodeURIComponent(JSON.stringify([
    { address: 'bitcoincash:qpa', balance_base: '800' },
    { address: 'bitcoincash:qpb', balance_base: '100' },
    { address: 'bitcoincash:qpc', balance_base: '100' },
  ]));
  const url = new URL(`http://x.invalid/api/token/${id}/holders?holders=${fixture}`);
  const env = await getTokenHolders({}, id, url);
  assert.equal(env.ok, true);
  assert.equal(env.fixture, true);
  assert.equal(env.token_id, id);
  // top-5 of total is 100% (3 holders, top-5 captures all of them)
  assert.equal(env.top_n_pct, 100);
  assert.equal(env.rug_pattern, true);
});

test('getTokenHolders: ?holders= with bad JSON → fixture_parse_failed', async () => {
  const id = 'a'.repeat(64);
  const url = new URL(`http://x.invalid/api/token/${id}/holders?holders=${encodeURIComponent('{not-json}')}`);
  const env = await getTokenHolders({}, id, url);
  assert.equal(env.ok, false);
  assert.equal(env.error, 'fixture_parse_failed');
});

test('getTokenHolders: ?holders= + ?decimals= propagate', async () => {
  const id = 'a'.repeat(64);
  const fixture = encodeURIComponent(JSON.stringify([{ address: 'bitcoincash:qpa', balance_base: '150' }]));
  // decimals=2: 150 base units → 1.5 human
  const url = new URL(`http://x.invalid/api/token/${id}/holders?holders=${fixture}&decimals=2`);
  const env = await getTokenHolders({}, id, url);
  assert.equal(env.ok, true);
  assert.equal(env.total_supply_human, '1.5');
});

test('getTokenHolders: ?holders= + ?top_n= override', async () => {
  const id = 'a'.repeat(64);
  const fixture = encodeURIComponent(JSON.stringify([
    { address: 'bitcoincash:qpa', balance_base: '50' },
    { address: 'bitcoincash:qpb', balance_base: '30' },
    { address: 'bitcoincash:qpc', balance_base: '20' },
  ]));
  const url = new URL(`http://x.invalid/api/token/${id}/holders?holders=${fixture}&top_n=2`);
  const env = await getTokenHolders({}, id, url);
  // top_n=2, top-2 = 50+30 = 80, 80/100 = 80%
  assert.equal(env.top_n, 2);
  assert.equal(env.top_n_pct, 80);
});

test('getTokenHolders: accepts URL string fallback', async () => {
  const id = 'a'.repeat(64);
  // Pass a string URL — handler normalizes via new URL(...)
  const env = await getTokenHolders({}, id, `http://x.invalid/api/token/${id}/holders`);
  assert.equal(env.ok, false);
  assert.equal(env.error, 'scanner_not_implemented');
});

test('getTokenHolders: accepts non-URL/non-string → safe stub', async () => {
  const id = 'a'.repeat(64);
  const env = await getTokenHolders({}, id, null);
  assert.equal(env.ok, false);
  assert.equal(env.error, 'scanner_not_implemented');
});

test('getTokenHolders: token_id case-folded to lowercase', async () => {
  const id = 'A'.repeat(64);
  const env = await getTokenHolders({}, id, new URL(`http://x.invalid/api/token/${id}/holders`));
  assert.equal(env.token_id, 'a'.repeat(64));
});

// ─────────────────────────────────────────────────────────────────────
//  Re-exports
// ─────────────────────────────────────────────────────────────────────

test('re-exports: computeHolderConcentration is the pure module\'s function', () => {
  assert.equal(typeof computeHolderConcentration, 'function');
  const env = computeHolderConcentration({
    token_id: 'a'.repeat(64),
    holders: [{ address: 'bitcoincash:qpa', balance_base: 100n }],
  });
  assert.equal(env.ok, true);
});

test('re-exports: isRugPatternByHolders works', () => {
  assert.equal(typeof isRugPatternByHolders, 'function');
  assert.equal(isRugPatternByHolders([
    { address: 'bitcoincash:qpa', balance_base: '900' },
    { address: 'bitcoincash:qpb', balance_base: '100' },
  ]), true);
});

test('re-exports: DEFAULT_HOLDER_CONCENTRATION_CONFIG is the same frozen object', () => {
  assert.equal(DEFAULT_HOLDER_CONCENTRATION_CONFIG.rug_top_n, 5);
  assert.equal(DEFAULT_HOLDER_CONCENTRATION_CONFIG.rug_threshold_pct, 80);
  assert.equal(Object.isFrozen(DEFAULT_HOLDER_CONCENTRATION_CONFIG), true);
});

// ─────────────────────────────────────────────────────────────────────
//  T76 subset 2a — Live scanner wire-up
// ─────────────────────────────────────────────────────────────────────

const VALID_TOKEN_64 = '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544';

/** Build a mock `resolveHoldersSnapshot` result envelope. */
function makeMockResolverResult({
  ok = true,
  cached = false,
  cache_age_ms = 0,
  upstream = 'https://tokenstork.com',
  snapshot_at_unix_s = null,
  envelope = null,
  error = null,
  message = null,
  http_status = null,
} = {}) {
  return {
    ok,
    cached,
    cache_age_ms,
    upstream,
    snapshot_at_unix_s,
    envelope,
    error,
    message,
    http_status,
  };
}

/** Build a mock upstream holders envelope (the shape `resolveHoldersSnapshot` produces inside `envelope`). */
function makeMockUpstreamEnvelope({ holders = [], source = 'tokenstork' } = {}) {
  return {
    ok: true,
    source,
    category: VALID_TOKEN_64,
    holders,
    snapshot_at_unix_s: holders.length > 0 ? holders[0].snapshot_at_unix_s ?? null : null,
    fetched_at_ms: Date.now(),
    upstream: 'https://tokenstork.com',
  };
}

//  isConcentrationRugEnabled
// ───────────────────────────────────────────────────────────

test('isConcentrationRugEnabled: missing ctx returns false', () => {
  assert.equal(isConcentrationRugEnabled(undefined), false);
  assert.equal(isConcentrationRugEnabled(null), false);
  assert.equal(isConcentrationRugEnabled({}), false);
});

test('isConcentrationRugEnabled: missing cfg returns false', () => {
  assert.equal(isConcentrationRugEnabled({ cfg: null }), false);
  assert.equal(isConcentrationRugEnabled({ cfg: {} }), false);
});

test('isConcentrationRugEnabled: missing scoring section returns false', () => {
  assert.equal(isConcentrationRugEnabled({ cfg: { scoring: null } }), false);
  assert.equal(isConcentrationRugEnabled({ cfg: { scoring: {} } }), false);
});

test('isConcentrationRugEnabled: false / non-boolean returns false', () => {
  assert.equal(isConcentrationRugEnabled({ cfg: { scoring: { concentration_rug_enabled: false } } }), false);
  assert.equal(isConcentrationRugEnabled({ cfg: { scoring: { concentration_rug_enabled: 'true' } } }), false);
  assert.equal(isConcentrationRugEnabled({ cfg: { scoring: { concentration_rug_enabled: 1 } } }), false);
});

test('isConcentrationRugEnabled: true → true', () => {
  assert.equal(isConcentrationRugEnabled({ cfg: { scoring: { concentration_rug_enabled: true } } }), true);
});

//  concentrationRugProviderUrl
// ───────────────────────────────────────────────────────────

test('concentrationRugProviderUrl: missing ctx returns null', () => {
  assert.equal(concentrationRugProviderUrl(null), null);
  assert.equal(concentrationRugProviderUrl({}), null);
  assert.equal(concentrationRugProviderUrl({ cfg: null }), null);
  assert.equal(concentrationRugProviderUrl({ cfg: { scoring: null } }), null);
  assert.equal(concentrationRugProviderUrl({ cfg: { scoring: {} } }), null);
});

test('concentrationRugProviderUrl: non-string returns null', () => {
  assert.equal(concentrationRugProviderUrl({ cfg: { scoring: { concentration_rug_provider_url: 42 } } }), null);
  assert.equal(concentrationRugProviderUrl({ cfg: { scoring: { concentration_rug_provider_url: '' } } }), null);
});

test('concentrationRugProviderUrl: valid string passes through', () => {
  assert.equal(
    concentrationRugProviderUrl({ cfg: { scoring: { concentration_rug_provider_url: 'https://mirror.example.com' } } }),
    'https://mirror.example.com',
  );
});

//  concentrationRugTimeoutMs
// ───────────────────────────────────────────────────────────

test('concentrationRugTimeoutMs: missing ctx returns null', () => {
  assert.equal(concentrationRugTimeoutMs(null), null);
  assert.equal(concentrationRugTimeoutMs({}), null);
  assert.equal(concentrationRugTimeoutMs({ cfg: { scoring: null } }), null);
});

test('concentrationRugTimeoutMs: non-number returns null', () => {
  assert.equal(concentrationRugTimeoutMs({ cfg: { scoring: { concentration_rug_timeout_ms: '5000' } } }), null);
  assert.equal(concentrationRugTimeoutMs({ cfg: { scoring: { concentration_rug_timeout_ms: NaN } } }), null);
});

test('concentrationRugTimeoutMs: finite positive number passes through', () => {
  assert.equal(
    concentrationRugTimeoutMs({ cfg: { scoring: { concentration_rug_timeout_ms: 3000 } } }),
    3000,
  );
});

//  buildTokenHoldersLiveEnvelope
// ───────────────────────────────────────────────────────────

test('buildTokenHoldersLiveEnvelope: null resolver envelope → resolver_invalid', () => {
  const env = buildTokenHoldersLiveEnvelope(VALID_TOKEN_64, null);
  assert.equal(env.ok, false);
  assert.equal(env.error, 'resolver_invalid');
});

test('buildTokenHoldersLiveEnvelope: resolver ok:false surfaces the error', () => {
  const r = makeMockResolverResult({ ok: false, error: 'fetch_failed', message: 'ECONNREFUSED', http_status: null });
  const env = buildTokenHoldersLiveEnvelope(VALID_TOKEN_64, r);
  assert.equal(env.ok, false);
  assert.equal(env.error, 'fetch_failed');
  assert.equal(env.message, 'ECONNREFUSED');
  assert.equal(env.http_status, null);
  assert.equal(env.cached, false);
});

test('buildTokenHoldersLiveEnvelope: happy rug pattern', () => {
  // top-2 of 5 holders hold 90% — a rug under default 80% threshold.
  // (5 holders so the default top_n=5 captures all of them; but the
  // top-2 subset still holds 90% so the rug predicate fires.)
  const upstream = makeMockUpstreamEnvelope({
    holders: [
      { address: 'bitcoincash:qpa', balance_base: '70', nft_count: 0, snapshot_at_unix_s: 1700000000 },
      { address: 'bitcoincash:qpb', balance_base: '20', nft_count: 1, snapshot_at_unix_s: 1700000000 },
      { address: 'bitcoincash:qpc', balance_base: '4',  nft_count: 0, snapshot_at_unix_s: 1700000000 },
      { address: 'bitcoincash:qpd', balance_base: '3',  nft_count: 0, snapshot_at_unix_s: 1700000000 },
      { address: 'bitcoincash:qpe', balance_base: '3',  nft_count: 0, snapshot_at_unix_s: 1700000000 },
    ],
  });
  const r = makeMockResolverResult({
    ok: true,
    cached: false,
    cache_age_ms: 0,
    upstream: 'https://tokenstork.com',
    snapshot_at_unix_s: 1700000000,
    envelope: upstream,
  });
  const env = buildTokenHoldersLiveEnvelope(VALID_TOKEN_64, r);
  assert.equal(env.ok, true);
  assert.equal(env.schema, 'tradebot.dashboard.token-holders/v1');
  assert.equal(env.fixture, false);
  assert.equal(env.source, 'tokenstork');
  assert.equal(env.holders_count, 5);
  assert.equal(env.is_rug_pattern, true);
  assert.equal(env.rug_pattern, true);
  assert.equal(env.top_n_pct, 100);
  assert.equal(env.total_supply_base, '100');
  assert.equal(env.cached, false);
  assert.equal(env.cache_age_ms, 0);
  assert.equal(env.upstream, 'https://tokenstork.com');
  assert.equal(env.snapshot_at_unix_s, 1700000000);
  assert.equal(Array.isArray(env.holders), true);
  assert.equal(Array.isArray(env.top_n_holders), true);
  assert.equal(env.top_n_holders.length, 5);
  // nft_count + snapshot_at_unix_s propagated from the upstream row
  assert.equal(env.holders[1].nft_count, 1);
  assert.equal(env.holders[0].snapshot_at_unix_s, 1700000000);
});

test('buildTokenHoldersLiveEnvelope: happy non-rug pattern', () => {
  // 7 holders; sorted by balance DESC the order is [16, 14, 14, 14,
  // 14, 14, 14]. top-5 = 16+14+14+14+14 = 72% of total 100. Under
  // default top_n=5 + threshold=80% this is NOT a rug pattern
  // (top-5 holds 72% < 80%-1% epsilon floor).
  const upstream = makeMockUpstreamEnvelope({
    holders: [
      { address: 'bitcoincash:qpa', balance_base: '14', nft_count: 0, snapshot_at_unix_s: 1700000000 },
      { address: 'bitcoincash:qpb', balance_base: '14', nft_count: 0, snapshot_at_unix_s: 1700000000 },
      { address: 'bitcoincash:qpc', balance_base: '14', nft_count: 0, snapshot_at_unix_s: 1700000000 },
      { address: 'bitcoincash:qpd', balance_base: '14', nft_count: 0, snapshot_at_unix_s: 1700000000 },
      { address: 'bitcoincash:qpe', balance_base: '14', nft_count: 0, snapshot_at_unix_s: 1700000000 },
      { address: 'bitcoincash:qpf', balance_base: '14', nft_count: 0, snapshot_at_unix_s: 1700000000 },
      { address: 'bitcoincash:qpg', balance_base: '16', nft_count: 0, snapshot_at_unix_s: 1700000000 },
    ],
  });
  const r = makeMockResolverResult({ ok: true, envelope: upstream });
  const env = buildTokenHoldersLiveEnvelope(VALID_TOKEN_64, r);
  assert.equal(env.ok, true);
  assert.equal(env.is_rug_pattern, false);
  assert.equal(env.rug_pattern, false);
  assert.equal(env.holders_count, 7);
  assert.equal(env.top_n_pct, 72);
});

test('buildTokenHoldersLiveEnvelope: cached=true surfaces on the wire', () => {
  const upstream = makeMockUpstreamEnvelope({
    holders: [
      { address: 'bitcoincash:qpa', balance_base: '100', nft_count: 0, snapshot_at_unix_s: 1700000000 },
    ],
  });
  const r = makeMockResolverResult({
    ok: true,
    cached: true,
    cache_age_ms: 12345,
    envelope: upstream,
    fetched_at_ms: Date.now() - 12345,
  });
  const env = buildTokenHoldersLiveEnvelope(VALID_TOKEN_64, r);
  assert.equal(env.cached, true);
  assert.equal(env.cache_age_ms, 12345);
});

test('buildTokenHoldersLiveEnvelope: opts override threshold + top_n', () => {
  // 6 holders; sorted DESC [60, 10, 10, 10, 5, 5] sum to 100. top-5
  // = 95. Under default threshold 80% this IS a rug. Under
  // threshold 99% it is NOT. Under top_n=1, top-1 = 60 → 60% — NOT
  // a rug.
  const upstream = makeMockUpstreamEnvelope({
    holders: [
      { address: 'bitcoincash:qpa', balance_base: '60', nft_count: 0, snapshot_at_unix_s: 1700000000 },
      { address: 'bitcoincash:qpb', balance_base: '10', nft_count: 0, snapshot_at_unix_s: 1700000000 },
      { address: 'bitcoincash:qpc', balance_base: '10', nft_count: 0, snapshot_at_unix_s: 1700000000 },
      { address: 'bitcoincash:qpd', balance_base: '10', nft_count: 0, snapshot_at_unix_s: 1700000000 },
      { address: 'bitcoincash:qpe', balance_base: '5',  nft_count: 0, snapshot_at_unix_s: 1700000000 },
      { address: 'bitcoincash:qpf', balance_base: '5',  nft_count: 0, snapshot_at_unix_s: 1700000000 },
    ],
  });
  const r = makeMockResolverResult({ ok: true, envelope: upstream });
  const envDefault = buildTokenHoldersLiveEnvelope(VALID_TOKEN_64, r);
  assert.equal(envDefault.is_rug_pattern, true);
  assert.equal(envDefault.top_n_pct, 95);
  const envLenient = buildTokenHoldersLiveEnvelope(VALID_TOKEN_64, r, { rug_threshold_pct: 99 });
  assert.equal(envLenient.is_rug_pattern, false);
  const envTop1 = buildTokenHoldersLiveEnvelope(VALID_TOKEN_64, r, { rug_top_n: 1 });
  // top-1 = 60, 60/100 = 60% — NOT a rug under default 80%.
  assert.equal(envTop1.is_rug_pattern, false);
});

test('buildTokenHoldersLiveEnvelope: empty holders → ok:true with is_rug_pattern:false', () => {
  const upstream = makeMockUpstreamEnvelope({ holders: [] });
  const r = makeMockResolverResult({ ok: true, envelope: upstream });
  const env = buildTokenHoldersLiveEnvelope(VALID_TOKEN_64, r);
  assert.equal(env.ok, true);
  assert.equal(env.holders_count, 0);
  assert.equal(env.is_rug_pattern, false);
});

test('buildTokenHoldersLiveEnvelope: token_not_found upstream surface as ok:false', () => {
  // The resolver converts token_not_found into ok:false (see
  // src/strategy/holder-scanner-cache.mjs#resolveHoldersSnapshot)
  // — so the dashboard gets a typed error envelope.
  const r = makeMockResolverResult({ ok: false, error: 'token_not_found', message: 'upstream has not indexed this token yet' });
  const env = buildTokenHoldersLiveEnvelope(VALID_TOKEN_64, r);
  assert.equal(env.ok, false);
  assert.equal(env.error, 'token_not_found');
});

//  getTokenHolders — live wire-up branches
// ───────────────────────────────────────────────────────────

test('getTokenHolders: enabled but no cache → scanner_cache_not_wired', async () => {
  const id = 'a'.repeat(64);
  const url = new URL(`http://x.invalid/api/token/${id}/holders`);
  const ctx = { cfg: { scoring: { concentration_rug_enabled: true } } };
  const env = await getTokenHolders(ctx, id, url);
  assert.equal(env.ok, false);
  assert.equal(env.error, 'scanner_cache_not_wired');
});

test('getTokenHolders: enabled + cache + fetcher → live wire-up happy rug', async () => {
  const id = VALID_TOKEN_64;
  const url = new URL(`http://x.invalid/api/token/${id}/holders`);
  const cache = new HoldersScannerCache({ cacheMs: 60000 });
  const body = {
    category: id,
    holders: [
      { address: 'bitcoincash:qpa', balance: '90', nftCount: 0, snapshotAt: 1700000000 },
      { address: 'bitcoincash:qpb', balance: '10', nftCount: 0, snapshotAt: 1700000000 },
    ],
  };
  const fetcher = async () => ({
    ok: true, status: 200,
    json: async () => body,
  });
  const ctx = {
    cfg: { scoring: { concentration_rug_enabled: true } },
    holdersScannerCache: cache,
    fetcher,
  };
  const env = await getTokenHolders(ctx, id, url);
  assert.equal(env.ok, true);
  assert.equal(env.fixture, false);
  assert.equal(env.source, 'tokenstork');
  assert.equal(env.holders_count, 2);
  assert.equal(env.is_rug_pattern, true);
  assert.equal(env.top_n_pct, 100);
  assert.equal(env.cached, false);
  // The fetched result should now be in the cache
  assert.equal(cache.size(), 1);
});

test('getTokenHolders: enabled + cache hit → cached:true + cache_age_ms', async () => {
  const id = VALID_TOKEN_64;
  const url = new URL(`http://x.invalid/api/token/${id}/holders`);
  const cache = new HoldersScannerCache({ cacheMs: 60000 });
  const body = {
    category: id,
    holders: [
      { address: 'bitcoincash:qpa', balance: '100', nftCount: 0, snapshotAt: 1700000000 },
    ],
  };
  const fetcher = async () => ({
    ok: true, status: 200,
    json: async () => body,
  });
  const ctx = {
    cfg: { scoring: { concentration_rug_enabled: true } },
    holdersScannerCache: cache,
    fetcher,
  };
  // First call: cache miss → cached:false
  const first = await getTokenHolders(ctx, id, url);
  assert.equal(first.cached, false);
  // Second call: cache hit → cached:true + cache_age_ms > 0
  const second = await getTokenHolders(ctx, id, url);
  assert.equal(second.cached, true);
  assert.ok(second.cache_age_ms >= 0);
  assert.ok(second.cache_age_ms < 60000);
});

test('getTokenHolders: enabled + fetch failure → upstream error envelope', async () => {
  const id = VALID_TOKEN_64;
  const url = new URL(`http://x.invalid/api/token/${id}/holders`);
  const cache = new HoldersScannerCache({ cacheMs: 60000 });
  const fetcher = async () => {
    throw new Error('ECONNREFUSED');
  };
  const ctx = {
    cfg: { scoring: { concentration_rug_enabled: true } },
    holdersScannerCache: cache,
    fetcher,
  };
  const env = await getTokenHolders(ctx, id, url);
  assert.equal(env.ok, false);
  assert.equal(env.error, 'fetch_failed');
  assert.match(env.message, /ECONNREFUSED/);
});

test('getTokenHolders: enabled + token_not_found → ok:false token_not_found', async () => {
  const id = VALID_TOKEN_64;
  const url = new URL(`http://x.invalid/api/token/${id}/holders`);
  const cache = new HoldersScannerCache({ cacheMs: 60000 });
  const fetcher = async () => ({
    ok: true, status: 200,
    json: async () => ({ message: 'This token is not available.' }),
  });
  const ctx = {
    cfg: { scoring: { concentration_rug_enabled: true } },
    holdersScannerCache: cache,
    fetcher,
  };
  const env = await getTokenHolders(ctx, id, url);
  assert.equal(env.ok, false);
  assert.equal(env.error, 'token_not_found');
});

test('getTokenHolders: provider_url + timeout_ms propagate to scanner', async () => {
  const id = VALID_TOKEN_64;
  const url = new URL(`http://x.invalid/api/token/${id}/holders`);
  const cache = new HoldersScannerCache({ cacheMs: 60000 });
  let capturedUrl = null;
  let capturedInit = null;
  const fetcher = async (u, init) => {
    capturedUrl = u;
    capturedInit = init;
    return {
      ok: true, status: 200,
      json: async () => ({
        category: id,
        holders: [
          { address: 'bitcoincash:qpa', balance: '100', nftCount: 0, snapshotAt: 1700000000 },
        ],
      }),
    };
  };
  const ctx = {
    cfg: {
      scoring: {
        concentration_rug_enabled: true,
        concentration_rug_provider_url: 'https://mirror.example.com',
        concentration_rug_timeout_ms: 8000,
      },
    },
    holdersScannerCache: cache,
    fetcher,
  };
  const env = await getTokenHolders(ctx, id, url);
  assert.equal(env.ok, true);
  assert.equal(env.upstream, 'https://mirror.example.com');
  // The fetch URL should hit the override base URL
  assert.match(String(capturedUrl), /^https:\/\/mirror\.example\.com\/api\/tokens\//);
  // The abort-controller pattern uses an init object — verify it's
  // a GET with the json accept header
  assert.equal(capturedInit.method, 'GET');
});

test('getTokenHolders: ?holders= fixture wins over enabled scanner', async () => {
  const id = VALID_TOKEN_64;
  const fixture = encodeURIComponent(JSON.stringify([
    { address: 'bitcoincash:qpa', balance_base: '100' },
  ]));
  const url = new URL(`http://x.invalid/api/token/${id}/holders?holders=${fixture}`);
  // The fetcher would throw if called — confirming the fixture
  // short-circuits before any upstream work.
  const fetcher = async () => { throw new Error('should-not-be-called'); };
  const cache = new HoldersScannerCache({ cacheMs: 60000 });
  const ctx = {
    cfg: { scoring: { concentration_rug_enabled: true } },
    holdersScannerCache: cache,
    fetcher,
  };
  const env = await getTokenHolders(ctx, id, url);
  assert.equal(env.ok, true);
  assert.equal(env.fixture, true);
  // Cache wasn't touched — fixture wins before the scanner branch.
  assert.equal(cache.size(), 0);
});

test('getTokenHolders: case-folded token_id propagates through live wire-up', async () => {
  const idUpper = VALID_TOKEN_64.toUpperCase();
  const url = new URL(`http://x.invalid/api/token/${idUpper}/holders`);
  const cache = new HoldersScannerCache({ cacheMs: 60000 });
  const fetcher = async () => ({
    ok: true, status: 200,
    json: async () => ({
      category: VALID_TOKEN_64,
      holders: [
        { address: 'bitcoincash:qpa', balance: '100', nftCount: 0, snapshotAt: 1700000000 },
      ],
    }),
  });
  const ctx = {
    cfg: { scoring: { concentration_rug_enabled: true } },
    holdersScannerCache: cache,
    fetcher,
  };
  const env = await getTokenHolders(ctx, idUpper, url);
  assert.equal(env.ok, true);
  assert.equal(env.token_id, VALID_TOKEN_64);
});
// ─────────────────────────────────────────────────────────────────────
// T76 subset 2c — `?refresh=true` cache-flush + isTruthyString helper
// ─────────────────────────────────────────────────────────────────────

test('isTruthyString: canonical truthy strings return true', () => {
  assert.equal(isTruthyString('true'), true);
  assert.equal(isTruthyString('TRUE'), true);
  assert.equal(isTruthyString('True'), true);
  assert.equal(isTruthyString('1'), true);
  assert.equal(isTruthyString('yes'), true);
  assert.equal(isTruthyString('YES'), true);
  assert.equal(isTruthyString('Yes'), true);
  assert.equal(isTruthyString('on'), true);
  assert.equal(isTruthyString('ON'), true);
  assert.equal(isTruthyString('On'), true);
  assert.equal(isTruthyString('  true  '), true);
  assert.equal(isTruthyString('  on  '), true);
});

test('isTruthyString: non-truthy values return false', () => {
  assert.equal(isTruthyString('0'), false);
  assert.equal(isTruthyString('false'), false);
  assert.equal(isTruthyString('FALSE'), false);
  assert.equal(isTruthyString('no'), false);
  assert.equal(isTruthyString('off'), false);
  assert.equal(isTruthyString('maybe'), false);
  assert.equal(isTruthyString('refresh'), false);
  assert.equal(isTruthyString(''), false);
  assert.equal(isTruthyString('  '), false);
  assert.equal(isTruthyString(null), false);
  assert.equal(isTruthyString(undefined), false);
  assert.equal(isTruthyString(1), false);
  assert.equal(isTruthyString(true), false);
  assert.equal(isTruthyString([]), false);
  assert.equal(isTruthyString({}), false);
});

test('getTokenHolders: ?refresh=true flushes the cache before resolve', async () => {
  const id = VALID_TOKEN_64;
  const cache = new HoldersScannerCache({ cacheMs: 60000 });
  // Pre-populate the cache so we can prove the flush wiped it.
  cache.set(id, { source: 'tokenstork', holders: [], token_not_found: true }, { upstream: 'tokenstork', snapshot_at_unix_s: 100 });
  assert.equal(cache.size(), 1, 'cache should have the pre-populated entry');
  let invalidateCalls = 0;
  const originalInvalidate = cache.invalidate.bind(cache);
  cache.invalidate = (tokenId) => {
    invalidateCalls += 1;
    return originalInvalidate(tokenId);
  };
  const url = new URL(`http://x.invalid/api/token/${id}/holders?refresh=true`);
  const fetcher = async () => ({
    ok: true, status: 200,
    json: async () => ({ category: id, holders: [{ address: 'bitcoincash:qpa', balance: '100', nftCount: 0, snapshotAt: 1700000000 }] }),
  });
  const ctx = {
    cfg: { scoring: { concentration_rug_enabled: true } },
    holdersScannerCache: cache,
    fetcher,
  };
  const env = await getTokenHolders(ctx, id, url);
  assert.equal(invalidateCalls, 1, 'cache.invalidate() must be called exactly once');
  assert.equal(env.ok, true);
  assert.equal(env.cache_flushed, true, 'cache_flushed must be true on the response envelope');
  assert.equal(env.cached, false, 'post-flush resolve must be a fresh fetch (not a cache hit)');
});

test('getTokenHolders: ?refresh=false (invalid value) does NOT flush the cache', async () => {
  const id = VALID_TOKEN_64;
  // No pre-population — the resolver fetches from upstream and we
  // can verify the cache.invalidate() hook was never invoked.
  const cache = new HoldersScannerCache({ cacheMs: 60000 });
  let invalidateCalls = 0;
  const originalInvalidate = cache.invalidate.bind(cache);
  cache.invalidate = (tokenId) => {
    invalidateCalls += 1;
    return originalInvalidate(tokenId);
  };
  const url = new URL(`http://x.invalid/api/token/${id}/holders?refresh=false`);
  const fetcher = async () => ({
    ok: true, status: 200,
    json: async () => ({ category: id, holders: [{ address: 'bitcoincash:qpa', balance: '100', nftCount: 0, snapshotAt: 1700000000 }] }),
  });
  const ctx = {
    cfg: { scoring: { concentration_rug_enabled: true } },
    holdersScannerCache: cache,
    fetcher,
  };
  const env = await getTokenHolders(ctx, id, url);
  assert.equal(invalidateCalls, 0, 'cache.invalidate() must NOT be called when refresh= is a non-truthy string');
  assert.equal(env.ok, true);
  assert.equal(env.cache_flushed, false);
});

test('getTokenHolders: gate-OFF + ?refresh=true is a no-op (no flush)', async () => {
  const id = VALID_TOKEN_64;
  const cache = new HoldersScannerCache({ cacheMs: 60000 });
  cache.set(id, { source: 'tokenstork', holders: [], token_not_found: true }, { upstream: 'tokenstork', snapshot_at_unix_s: 100 });
  let invalidateCalls = 0;
  const originalInvalidate = cache.invalidate.bind(cache);
  cache.invalidate = (tokenId) => {
    invalidateCalls += 1;
    return originalInvalidate(tokenId);
  };
  const url = new URL(`http://x.invalid/api/token/${id}/holders?refresh=true`);
  // Gate OFF: no live scanner, no flush.
  const ctx = { cfg: { scoring: { concentration_rug_enabled: false } } };
  const env = await getTokenHolders(ctx, id, url);
  assert.equal(invalidateCalls, 0, 'cache.invalidate() must NOT be called when the gate is OFF');
  assert.equal(env.ok, false);
  assert.equal(env.error, 'scanner_not_implemented');
});

test('getTokenHolders: ?holders= fixture wins over ?refresh=true (operator-testing wins)', async () => {
  const id = VALID_TOKEN_64;
  // Empty cache — the fixture branch must short-circuit BEFORE the
  // resolver runs, so a populated cache would be irrelevant for
  // this test (and would also trigger token_not_found -> ok:false).
  const cache = new HoldersScannerCache({ cacheMs: 60000 });
  let invalidateCalls = 0;
  const originalInvalidate = cache.invalidate.bind(cache);
  cache.invalidate = (tokenId) => {
    invalidateCalls += 1;
    return originalInvalidate(tokenId);
  };
  const fixtureJson = JSON.stringify([
    { address: 'bitcoincash:qpa', balance: '100' },
    { address: 'bitcoincash:qpb', balance: '50' },
  ]);
  const url = new URL(`http://x.invalid/api/token/${id}/holders?refresh=true&holders=${encodeURIComponent(fixtureJson)}`);
  const ctx = {
    cfg: { scoring: { concentration_rug_enabled: true } },
    holdersScannerCache: cache,
  };
  const env = await getTokenHolders(ctx, id, url);
  assert.equal(invalidateCalls, 0, 'cache.invalidate() must NOT be called on the fixture path');
  assert.equal(env.ok, true);
  assert.equal(env.fixture, true, 'fixture path returns ok:true with fixture:true');
  assert.equal(env.total_holders, 2, 'fixture envelope carries total_holders from the math layer');
  assert.equal(env.holders_count, undefined, 'fixture envelope does not add holders_count (only the LIVE envelope does)');
  assert.equal(env.cache_flushed, undefined, 'fixture envelope does NOT carry cache_flushed (the field only applies to the live branch)');
});

test('getTokenHolders: cache.invalidate() throw is swallowed (no 500)', async () => {
  const id = VALID_TOKEN_64;
  const cache = {
    get: () => null,
    set: () => true,
    invalidate: () => { throw new Error('invalidate exploded'); },
  };
  const url = new URL(`http://x.invalid/api/token/${id}/holders?refresh=true`);
  const fetcher = async () => ({
    ok: true, status: 200,
    json: async () => ({ category: id, holders: [{ address: 'bitcoincash:qpa', balance: '100', nftCount: 0, snapshotAt: 1700000000 }] }),
  });
  const ctx = {
    cfg: { scoring: { concentration_rug_enabled: true } },
    holdersScannerCache: cache,
    fetcher,
  };
  const env = await getTokenHolders(ctx, id, url);
  assert.equal(env.ok, true);
  assert.equal(env.cache_flushed, true, 'cache_flushed stays true even when invalidate() throws — the throw is defensive-swallowed');
});

test('getTokenHolders: cache-not-wired + ?refresh=true returns scanner_cache_not_wired (flush never fires)', async () => {
  const id = VALID_TOKEN_64;
  const url = new URL(`http://x.invalid/api/token/${id}/holders?refresh=true`);
  const ctx = {
    cfg: { scoring: { concentration_rug_enabled: true } },
    // No holdersScannerCache wired.
  };
  const env = await getTokenHolders(ctx, id, url);
  assert.equal(env.ok, false);
  assert.equal(env.error, 'scanner_cache_not_wired');
  assert.equal(env.cache_flushed, undefined, 'cache-not-wired path never enters the flush branch');
});

test('getTokenHolders: live wire (no refresh) carries cache_flushed=false on the response', async () => {
  const id = VALID_TOKEN_64;
  const cache = new HoldersScannerCache({ cacheMs: 60000 });
  const url = new URL(`http://x.invalid/api/token/${id}/holders`);
  const fetcher = async () => ({
    ok: true, status: 200,
    json: async () => ({ category: id, holders: [{ address: 'bitcoincash:qpa', balance: '100', nftCount: 0, snapshotAt: 1700000000 }] }),
  });
  const ctx = {
    cfg: { scoring: { concentration_rug_enabled: true } },
    holdersScannerCache: cache,
    fetcher,
  };
  const env = await getTokenHolders(ctx, id, url);
  assert.equal(env.ok, true);
  assert.equal(env.cache_flushed, false, 'default cache_flushed=false when no ?refresh= was supplied');
});

test('getTokenHolders: ?refresh=1 and ?refresh=yes and ?refresh=on all flush', async () => {
  for (const refreshVal of ['1', 'yes', 'on', 'TRUE', 'Yes', 'ON']) {
    const id = VALID_TOKEN_64;
    const cache = new HoldersScannerCache({ cacheMs: 60000 });
    cache.set(id, { source: 'tokenstork', holders: [], token_not_found: true }, { upstream: 'tokenstork', snapshot_at_unix_s: 100 });
    const url = new URL(`http://x.invalid/api/token/${id}/holders?refresh=${encodeURIComponent(refreshVal)}`);
    const fetcher = async () => ({
      ok: true, status: 200,
      json: async () => ({ category: id, holders: [{ address: 'bitcoincash:qpa', balance: '100', nftCount: 0, snapshotAt: 1700000000 }] }),
    });
    const ctx = {
      cfg: { scoring: { concentration_rug_enabled: true } },
      holdersScannerCache: cache,
      fetcher,
    };
    const env = await getTokenHolders(ctx, id, url);
    assert.equal(env.ok, true, `refresh=${refreshVal} should return ok:true`);
    assert.equal(env.cache_flushed, true, `refresh=${refreshVal} should flush`);
    assert.equal(cache.size(), 1, `refresh=${refreshVal} should re-populate the cache after flush`);
  }
});

test('getTokenHolders: ?refresh= (no value) is treated as false (no flush)', async () => {
  const id = VALID_TOKEN_64;
  // Empty cache — the fetcher is the source of truth, the cache
  // ends up populated after this resolve but the entry was inserted
  // by the resolver's normal store path, not by a flush.
  const cache = new HoldersScannerCache({ cacheMs: 60000 });
  const url = new URL(`http://x.invalid/api/token/${id}/holders?refresh=`);
  const fetcher = async () => ({
    ok: true, status: 200,
    json: async () => ({ category: id, holders: [{ address: 'bitcoincash:qpa', balance: '100', nftCount: 0, snapshotAt: 1700000000 }] }),
  });
  const ctx = {
    cfg: { scoring: { concentration_rug_enabled: true } },
    holdersScannerCache: cache,
    fetcher,
  };
  const env = await getTokenHolders(ctx, id, url);
  assert.equal(env.ok, true);
  assert.equal(env.cache_flushed, false);
});
