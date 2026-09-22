#!/usr/bin/env test
// tests/strategy-holder-scanner.test.mjs
//
// T76 subset 2 — pure-helper + I/O-wrapper tests for the live
// TokenStork holders scanner.
//
// Coverage:
//   - validateTokenStorkHoldersResponse (happy / message-envelope /
//     missing fields / wrong types / null / non-object / array)
//   - validateTokenStorkHolderRow (happy string-balance / happy
//     number-balance / bigint-balance / missing / non-integer nftCount /
//     non-string address / scientific-notation balance)
//   - mapTokenStorkHoldersToHoldersInput (happy / empty / dropped audit /
//     non-array)
//   - buildHoldersScannerUrl (default baseUrl / trailing-slash trim /
//     custom baseUrl)
//   - resolveHoldersScannerConfig (defaults / full config / bad URL /
//     bad timeoutMs / bad cacheMs / clamp at max)
//   - fetchTokenHoldersFromTokenStork (happy / 404 / 500 / parse fail /
//     shape invalid / timeout / token-not-found message / fetcher null /
//     fetcher throw / malformed response / non-2xx / non-object body /
//     invalid tokenId)
//   - fetchAndComputeHolderConcentration (happy rug / happy non-rug /
//     token_not_found upstream / fetch failure / validation failed /
//     invalid tokenId)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateTokenStorkHoldersResponse,
  validateTokenStorkHolderRow,
  mapTokenStorkHoldersToHoldersInput,
  buildHoldersScannerUrl,
  resolveHoldersScannerConfig,
  fetchTokenHoldersFromTokenStork,
  fetchAndComputeHolderConcentration,
  DEFAULT_HOLDERS_SCANNER_BASE_URL,
  DEFAULT_HOLDERS_SCANNER_TIMEOUT_MS,
  DEFAULT_HOLDERS_SCANNER_CACHE_MS,
  MAX_HOLDERS_SCANNER_CACHE_MS,
  MAX_HOLDERS_SCANNER_TIMEOUT_MS,
  HOLDERS_SCANNER_SCHEMA,
  HOLDERS_SCANNER_SOURCE_TOKENSTORK,
} from '../src/strategy/holder-scanner.mjs';

const VALID_TOKEN = '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544';
const OTHER_TOKEN = '10d85ee2d23f7fbc7573379de5544d669bc086e0745b34ff277c40641dadd56f';

// ─────────────────────────────────────────────────────────────────────
//  validateTokenStorkHoldersResponse
// ─────────────────────────────────────────────────────────────────────

test('validateTokenStorkHoldersResponse: happy holders envelope', () => {
  const body = {
    category: VALID_TOKEN,
    holders: [{ address: 'bitcoincash:qxxx', balance: '1000' }],
  };
  const r = validateTokenStorkHoldersResponse(body);
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'holders_envelope');
  assert.equal(r.category, VALID_TOKEN);
  assert.equal(r.holders.length, 1);
});

test('validateTokenStorkHoldersResponse: case-folds category to lowercase', () => {
  const body = {
    category: VALID_TOKEN.toUpperCase(),
    holders: [],
  };
  const r = validateTokenStorkHoldersResponse(body);
  assert.equal(r.ok, true);
  assert.equal(r.category, VALID_TOKEN);
});

test('validateTokenStorkHoldersResponse: message envelope (token not found)', () => {
  const body = { message: 'This token is not available.' };
  const r = validateTokenStorkHoldersResponse(body);
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'token_not_found');
  assert.match(r.message, /not available/i);
});

test('validateTokenStorkHoldersResponse: rejects null body', () => {
  const r = validateTokenStorkHoldersResponse(null);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'shape_invalid');
});

test('validateTokenStorkHoldersResponse: rejects undefined body', () => {
  const r = validateTokenStorkHoldersResponse(undefined);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'shape_invalid');
});

test('validateTokenStorkHoldersResponse: rejects array body', () => {
  const r = validateTokenStorkHoldersResponse([VALID_TOKEN]);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'shape_invalid');
});

test('validateTokenStorkHoldersResponse: rejects missing category', () => {
  const r = validateTokenStorkHoldersResponse({ holders: [] });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'shape_invalid');
  assert.match(r.message, /category/);
});

test('validateTokenStorkHoldersResponse: rejects non-hex category', () => {
  const r = validateTokenStorkHoldersResponse({
    category: 'not-a-hex-id-at-all-just-some-text',
    holders: [],
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'shape_invalid');
  assert.match(r.message, /64-hex/);
});

test('validateTokenStorkHoldersResponse: rejects holders non-array', () => {
  const r = validateTokenStorkHoldersResponse({
    category: VALID_TOKEN,
    holders: 'not-an-array',
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'shape_invalid');
  assert.match(r.message, /array/);
});

// ─────────────────────────────────────────────────────────────────────
//  validateTokenStorkHolderRow
// ─────────────────────────────────────────────────────────────────────

test('validateTokenStorkHolderRow: happy string balance', () => {
  const r = validateTokenStorkHolderRow({
    address: 'bitcoincash:qxxx',
    balance: '1000000',
    nftCount: 3,
    snapshotAt: 1782563289,
  });
  assert.equal(r.ok, true);
  assert.equal(r.address, 'bitcoincash:qxxx');
  assert.equal(r.balance, '1000000');
  assert.equal(r.nftCount, 3);
  assert.equal(r.snapshotAt, 1782563289);
});

test('validateTokenStorkHolderRow: happy number balance (coerced to string)', () => {
  const r = validateTokenStorkHolderRow({
    address: 'bitcoincash:qxxx',
    balance: 500,
  });
  assert.equal(r.ok, true);
  assert.equal(r.balance, '500');
});

test('validateTokenStorkHolderRow: happy bigint balance', () => {
  const r = validateTokenStorkHolderRow({
    address: 'bitcoincash:qxxx',
    balance: 9223372036854775807n,
  });
  assert.equal(r.ok, true);
  assert.equal(r.balance, '9223372036854775807');
});

test('validateTokenStorkHolderRow: missing balance drops the row', () => {
  const r = validateTokenStorkHolderRow({ address: 'bitcoincash:qxxx' });
  assert.equal(r.ok, false);
  assert.equal(r.dropped, true);
  assert.match(r.reason, /balance/);
});

test('validateTokenStorkHolderRow: NaN balance drops the row', () => {
  const r = validateTokenStorkHolderRow({
    address: 'bitcoincash:qxxx',
    balance: NaN,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /balance/);
});

test('validateTokenStorkHolderRow: negative balance drops the row', () => {
  const r = validateTokenStorkHolderRow({
    address: 'bitcoincash:qxxx',
    balance: -100,
  });
  assert.equal(r.ok, false);
  // Negative number fails the `>= 0` check in the number branch,
  // so we fall through to `balance_missing_or_invalid`.
  assert.match(r.reason, /balance/);
});

test('validateTokenStorkHolderRow: scientific-notation string balance drops the row', () => {
  const r = validateTokenStorkHolderRow({
    address: 'bitcoincash:qxxx',
    balance: '1e6',
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /unsigned/);
});

test('validateTokenStorkHolderRow: missing address drops the row', () => {
  const r = validateTokenStorkHolderRow({ balance: '100' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /address/);
});

test('validateTokenStorkHolderRow: empty-string address drops the row', () => {
  const r = validateTokenStorkHolderRow({ address: '', balance: '100' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /address/);
});

test('validateTokenStorkHolderRow: non-integer nftCount falls through to 0', () => {
  const r = validateTokenStorkHolderRow({
    address: 'bitcoincash:qxxx',
    balance: '100',
    nftCount: 1.5,
  });
  assert.equal(r.ok, true);
  assert.equal(r.nftCount, 0);
});

test('validateTokenStorkHolderRow: missing nftCount defaults to 0', () => {
  const r = validateTokenStorkHolderRow({
    address: 'bitcoincash:qxxx',
    balance: '100',
  });
  assert.equal(r.ok, true);
  assert.equal(r.nftCount, 0);
});

test('validateTokenStorkHolderRow: missing snapshotAt is null', () => {
  const r = validateTokenStorkHolderRow({
    address: 'bitcoincash:qxxx',
    balance: '100',
  });
  assert.equal(r.ok, true);
  assert.equal(r.snapshotAt, null);
});

test('validateTokenStorkHolderRow: rejects non-object row', () => {
  const r = validateTokenStorkHolderRow('string-row');
  assert.equal(r.ok, false);
  assert.match(r.reason, /object/);
});

test('validateTokenStorkHolderRow: rejects null row', () => {
  const r = validateTokenStorkHolderRow(null);
  assert.equal(r.ok, false);
});

// ─────────────────────────────────────────────────────────────────────
//  mapTokenStorkHoldersToHoldersInput
// ─────────────────────────────────────────────────────────────────────

test('mapTokenStorkHoldersToHoldersInput: happy multi-row projection', () => {
  const r = mapTokenStorkHoldersToHoldersInput([
    { address: 'bitcoincash:qa', balance: '100' },
    { address: 'bitcoincash:qb', balance: '200' },
    { address: 'bitcoincash:qc', balance: '300' },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.holders.length, 3);
  assert.deepEqual(r.holders[0], { address: 'bitcoincash:qa', balance_base: '100' });
  assert.equal(r._dropped.length, 0);
});

test('mapTokenStorkHoldersToHoldersInput: empty upstream', () => {
  const r = mapTokenStorkHoldersToHoldersInput([]);
  assert.equal(r.ok, true);
  assert.equal(r.holders.length, 0);
  assert.equal(r._dropped.length, 0);
});

test('mapTokenStorkHoldersToHoldersInput: drops malformed rows + audits them', () => {
  const r = mapTokenStorkHoldersToHoldersInput([
    { address: 'bitcoincash:qa', balance: '100' },
    { address: '', balance: '200' },
    { address: 'bitcoincash:qc' },
    { address: 'bitcoincash:qd', balance: 'NaN' },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.holders.length, 1);
  assert.equal(r._dropped.length, 3);
  assert.equal(r._dropped[0].row_index, 1);
  assert.equal(r._dropped[2].row_index, 3);
});

test('mapTokenStorkHoldersToHoldersInput: non-array upstream returns empty + audit', () => {
  const r = mapTokenStorkHoldersToHoldersInput(null);
  assert.equal(r.ok, true);
  assert.equal(r.holders.length, 0);
  assert.equal(r._dropped.length, 1);
});

// ─────────────────────────────────────────────────────────────────────
//  buildHoldersScannerUrl
// ─────────────────────────────────────────────────────────────────────

test('buildHoldersScannerUrl: default baseUrl', () => {
  assert.equal(
    buildHoldersScannerUrl(VALID_TOKEN),
    `${DEFAULT_HOLDERS_SCANNER_BASE_URL}/api/tokens/${VALID_TOKEN}/holders`,
  );
});

test('buildHoldersScannerUrl: custom baseUrl', () => {
  assert.equal(
    buildHoldersScannerUrl(VALID_TOKEN, 'https://mirror.example.com'),
    `https://mirror.example.com/api/tokens/${VALID_TOKEN}/holders`,
  );
});

test('buildHoldersScannerUrl: trims trailing slashes from baseUrl', () => {
  assert.equal(
    buildHoldersScannerUrl(VALID_TOKEN, 'https://mirror.example.com/'),
    `https://mirror.example.com/api/tokens/${VALID_TOKEN}/holders`,
  );
  assert.equal(
    buildHoldersScannerUrl(VALID_TOKEN, 'https://mirror.example.com///'),
    `https://mirror.example.com/api/tokens/${VALID_TOKEN}/holders`,
  );
});

test('buildHoldersScannerUrl: empty baseUrl falls back to default', () => {
  assert.equal(
    buildHoldersScannerUrl(VALID_TOKEN, ''),
    `${DEFAULT_HOLDERS_SCANNER_BASE_URL}/api/tokens/${VALID_TOKEN}/holders`,
  );
});

// ─────────────────────────────────────────────────────────────────────
//  resolveHoldersScannerConfig
// ─────────────────────────────────────────────────────────────────────

test('resolveHoldersScannerConfig: all defaults when cfg is empty', () => {
  const r = resolveHoldersScannerConfig({});
  assert.equal(r.baseUrl, DEFAULT_HOLDERS_SCANNER_BASE_URL);
  assert.equal(r.timeoutMs, DEFAULT_HOLDERS_SCANNER_TIMEOUT_MS);
  assert.equal(r.cacheMs, DEFAULT_HOLDERS_SCANNER_CACHE_MS);
  assert.equal(r.applied.baseUrl_source, 'default');
  assert.equal(r.applied.timeoutMs_source, 'default');
  assert.equal(r.applied.cacheMs_source, 'default');
});

test('resolveHoldersScannerConfig: full config overrides all defaults', () => {
  const r = resolveHoldersScannerConfig({
    scoring: {
      concentration_rug_provider_url: 'https://mirror.example.com/',
      concentration_rug_timeout_ms: 12345,
      concentration_rug_cache_ms: 60000,
    },
  });
  assert.equal(r.baseUrl, 'https://mirror.example.com');
  assert.equal(r.timeoutMs, 12345);
  assert.equal(r.cacheMs, 60000);
  assert.equal(r.applied.baseUrl_source, 'config');
  assert.equal(r.applied.timeoutMs_source, 'config');
  assert.equal(r.applied.cacheMs_source, 'config');
});

test('resolveHoldersScannerConfig: bad URL falls back to default', () => {
  const r = resolveHoldersScannerConfig({
    scoring: { concentration_rug_provider_url: 'not a valid url' },
  });
  assert.equal(r.baseUrl, DEFAULT_HOLDERS_SCANNER_BASE_URL);
  assert.equal(r.applied.baseUrl_source, 'default');
});

test('resolveHoldersScannerConfig: non-https URL falls back to default', () => {
  const r = resolveHoldersScannerConfig({
    scoring: { concentration_rug_provider_url: 'ftp://mirror.example.com/' },
  });
  assert.equal(r.baseUrl, DEFAULT_HOLDERS_SCANNER_BASE_URL);
});

test('resolveHoldersScannerConfig: clamps cacheMs to MAX', () => {
  const r = resolveHoldersScannerConfig({
    scoring: { concentration_rug_cache_ms: MAX_HOLDERS_SCANNER_CACHE_MS + 1000 },
  });
  assert.equal(r.cacheMs, MAX_HOLDERS_SCANNER_CACHE_MS);
});

test('resolveHoldersScannerConfig: clamps timeoutMs to MAX', () => {
  const r = resolveHoldersScannerConfig({
    scoring: { concentration_rug_timeout_ms: MAX_HOLDERS_SCANNER_TIMEOUT_MS + 1000 },
  });
  assert.equal(r.timeoutMs, MAX_HOLDERS_SCANNER_TIMEOUT_MS);
});

test('resolveHoldersScannerConfig: negative cacheMs falls back to default', () => {
  const r = resolveHoldersScannerConfig({
    scoring: { concentration_rug_cache_ms: -100 },
  });
  // Negative fails the `cacheMs >= 0` guard, falls through to default.
  assert.equal(r.cacheMs, DEFAULT_HOLDERS_SCANNER_CACHE_MS);
  assert.equal(r.applied.cacheMs_source, 'default');
});

test('resolveHoldersScannerConfig: invalid (NaN) timeoutMs falls back to default', () => {
  const r = resolveHoldersScannerConfig({
    scoring: { concentration_rug_timeout_ms: NaN },
  });
  assert.equal(r.timeoutMs, DEFAULT_HOLDERS_SCANNER_TIMEOUT_MS);
});

test('resolveHoldersScannerConfig: invalid (string) cacheMs falls back to default', () => {
  const r = resolveHoldersScannerConfig({
    scoring: { concentration_rug_cache_ms: '60000' },
  });
  assert.equal(r.cacheMs, DEFAULT_HOLDERS_SCANNER_CACHE_MS);
});

// ─────────────────────────────────────────────────────────────────────
//  fetchTokenHoldersFromTokenStork
// ─────────────────────────────────────────────────────────────────────

function makeMockResponse({ status = 200, body, ok = true } = {}) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

test('fetchTokenHoldersFromTokenStork: invalid tokenId returns config_invalid', async () => {
  const r = await fetchTokenHoldersFromTokenStork({ tokenId: 'not-hex' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'config_invalid');
});

test('fetchTokenHoldersFromTokenStork: missing tokenId returns config_invalid', async () => {
  const r = await fetchTokenHoldersFromTokenStork({});
  assert.equal(r.ok, false);
  assert.equal(r.error, 'config_invalid');
});

test('fetchTokenHoldersFromTokenStork: args-as-array returns config_invalid', async () => {
  const r = await fetchTokenHoldersFromTokenStork([]);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'config_invalid');
});

test('fetchTokenHoldersFromTokenStork: happy path returns holders envelope', async () => {
  const body = {
    category: VALID_TOKEN,
    holders: [
      { address: 'bitcoincash:qa', balance: '5000000', nftCount: 2, snapshotAt: 1782563289 },
      { address: 'bitcoincash:qb', balance: '1000000', nftCount: 0, snapshotAt: 1782563289 },
    ],
  };
  let calledWithUrl = null;
  const fetcher = async (url, init) => {
    calledWithUrl = url;
    return makeMockResponse({ status: 200, body });
  };
  const r = await fetchTokenHoldersFromTokenStork({
    tokenId: VALID_TOKEN,
    fetcher,
  });
  assert.equal(r.ok, true);
  assert.equal(r.source, HOLDERS_SCANNER_SOURCE_TOKENSTORK);
  assert.equal(r.category, VALID_TOKEN);
  assert.equal(r.holders.length, 2);
  assert.equal(r.holders[0].balance_base, '5000000');
  assert.equal(r.holders[0].nft_count, 2);
  assert.equal(r.snapshot_at_unix_s, 1782563289);
  assert.equal(r.upstream, DEFAULT_HOLDERS_SCANNER_BASE_URL);
  assert.ok(typeof r.fetched_at_ms === 'number');
  assert.match(calledWithUrl, /\/api\/tokens\/2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544\/holders$/);
  assert.match(calledWithUrl, new RegExp(`^${DEFAULT_HOLDERS_SCANNER_BASE_URL.replace(/\//g, '\\/')}`));
});

test('fetchTokenHoldersFromTokenStork: 404 returns token_not_found envelope', async () => {
  const fetcher = async () => makeMockResponse({ status: 404, body: { message: 'not found' } });
  const r = await fetchTokenHoldersFromTokenStork({ tokenId: VALID_TOKEN, fetcher });
  assert.equal(r.ok, true);
  assert.equal(r.token_not_found, true);
  assert.equal(r.http_status, 404);
  assert.equal(r.holders.length, 0);
});

test('fetchTokenHoldersFromTokenStork: 500 returns http_error envelope', async () => {
  const fetcher = async () => makeMockResponse({ status: 500, body: { error: 'upstream-down' } });
  const r = await fetchTokenHoldersFromTokenStork({ tokenId: VALID_TOKEN, fetcher });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'http_error');
  assert.equal(r.http_status, 500);
});

test('fetchTokenHoldersFromTokenStork: 503 returns http_error envelope', async () => {
  const fetcher = async () => makeMockResponse({ status: 503, body: null });
  const r = await fetchTokenHoldersFromTokenStork({ tokenId: VALID_TOKEN, fetcher });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'http_error');
  assert.equal(r.http_status, 503);
});

test('fetchTokenHoldersFromTokenStork: parse failure returns parse_failed', async () => {
  const fetcher = async () => ({
    ok: true,
    status: 200,
    json: async () => { throw new Error('unexpected token'); },
  });
  const r = await fetchTokenHoldersFromTokenStork({ tokenId: VALID_TOKEN, fetcher });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'parse_failed');
});

test('fetchTokenHoldersFromTokenStork: shape-invalid (missing category) returns shape_invalid', async () => {
  const fetcher = async () => makeMockResponse({ status: 200, body: { holders: [] } });
  const r = await fetchTokenHoldersFromTokenStork({ tokenId: VALID_TOKEN, fetcher });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'shape_invalid');
});

test('fetchTokenHoldersFromTokenStork: message envelope returns token_not_found', async () => {
  const fetcher = async () => makeMockResponse({ status: 200, body: { message: 'This token is not available.' } });
  const r = await fetchTokenHoldersFromTokenStork({ tokenId: VALID_TOKEN, fetcher });
  assert.equal(r.ok, true);
  assert.equal(r.token_not_found, true);
  assert.equal(r.holders.length, 0);
  assert.match(r.message, /not available/i);
});

test('fetchTokenHoldersFromTokenStork: fetcher throw returns fetch_failed', async () => {
  const fetcher = async () => { throw new Error('ECONNREFUSED'); };
  const r = await fetchTokenHoldersFromTokenStork({ tokenId: VALID_TOKEN, fetcher });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'fetch_failed');
  assert.match(r.message, /ECONNREFUSED/);
});

test('fetchTokenHoldersFromTokenStork: fetcher returns null returns fetch_failed', async () => {
  const fetcher = async () => null;
  const r = await fetchTokenHoldersFromTokenStork({ tokenId: VALID_TOKEN, fetcher });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'fetch_failed');
});

test('fetchTokenHoldersFromTokenStork: timeout returns timeout envelope', async () => {
  const fetcher = async (url, init) => {
    return await new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      });
    });
  };
  const r = await fetchTokenHoldersFromTokenStork({
    tokenId: VALID_TOKEN,
    fetcher,
    timeoutMs: 50,
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'timeout');
});

test('fetchTokenHoldersFromTokenStork: malformed body (holders as string) returns shape_invalid', async () => {
  const fetcher = async () => makeMockResponse({
    status: 200,
    body: { category: VALID_TOKEN, holders: 'not-an-array' },
  });
  const r = await fetchTokenHoldersFromTokenStork({ tokenId: VALID_TOKEN, fetcher });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'shape_invalid');
});

test('fetchTokenHoldersFromTokenStork: dropped malformed rows audit', async () => {
  const body = {
    category: VALID_TOKEN,
    holders: [
      { address: 'bitcoincash:qa', balance: '100' },
      { address: '', balance: '100' }, // dropped
      { address: 'bitcoincash:qc', balance: 'NaN' }, // dropped
    ],
  };
  const fetcher = async () => makeMockResponse({ status: 200, body });
  const r = await fetchTokenHoldersFromTokenStork({ tokenId: VALID_TOKEN, fetcher });
  assert.equal(r.ok, true);
  assert.equal(r.holders.length, 1);
  assert.ok(Array.isArray(r.dropped_rows));
  assert.equal(r.dropped_rows.length, 2);
});

test('fetchTokenHoldersFromTokenStork: custom baseUrl is honored', async () => {
  const body = { category: VALID_TOKEN, holders: [] };
  let calledWithUrl = null;
  const fetcher = async (url) => {
    calledWithUrl = url;
    return makeMockResponse({ status: 200, body });
  };
  const r = await fetchTokenHoldersFromTokenStork({
    tokenId: VALID_TOKEN,
    baseUrl: 'https://mirror.example.com/',
    fetcher,
  });
  assert.equal(r.ok, true);
  assert.match(calledWithUrl, /^https:\/\/mirror\.example\.com\/api\/tokens\//);
  assert.equal(r.upstream, 'https://mirror.example.com');
});

test('fetchTokenHoldersFromTokenStork: nowMs is honored', async () => {
  const body = { category: VALID_TOKEN, holders: [] };
  const fetcher = async () => makeMockResponse({ status: 200, body });
  const r = await fetchTokenHoldersFromTokenStork({
    tokenId: VALID_TOKEN,
    fetcher,
    nowMs: () => 1234567890,
  });
  assert.equal(r.fetched_at_ms, 1234567890);
});

test('fetchTokenHoldersFromTokenStork: uppercase tokenId is normalized to lowercase in URL', async () => {
  const body = { category: VALID_TOKEN, holders: [] };
  let calledWithUrl = null;
  const fetcher = async (url) => {
    calledWithUrl = url;
    return makeMockResponse({ status: 200, body });
  };
  await fetchTokenHoldersFromTokenStork({ tokenId: VALID_TOKEN.toUpperCase(), fetcher });
  assert.ok(calledWithUrl.includes(VALID_TOKEN));
  assert.ok(!calledWithUrl.includes(VALID_TOKEN.toUpperCase()));
});

// ─────────────────────────────────────────────────────────────────────
//  fetchAndComputeHolderConcentration
// ─────────────────────────────────────────────────────────────────────

test('fetchAndComputeHolderConcentration: invalid tokenId returns invalid_token_id', async () => {
  const r = await fetchAndComputeHolderConcentration({ tokenId: 'short' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_token_id');
  assert.equal(r.schema, HOLDERS_SCANNER_SCHEMA);
});

test('fetchAndComputeHolderConcentration: missing tokenId returns invalid_token_id', async () => {
  const r = await fetchAndComputeHolderConcentration({});
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_token_id');
});

test('fetchAndComputeHolderConcentration: happy rug pattern detected', async () => {
  // 5 holders; top-1 holds 100% → rug pattern by the default thresholds.
  const body = {
    category: VALID_TOKEN,
    holders: [
      { address: 'bitcoincash:qa', balance: '1000000', nftCount: 0, snapshotAt: 1782563289 },
      { address: 'bitcoincash:qb', balance: '100', nftCount: 0, snapshotAt: 1782563289 },
      { address: 'bitcoincash:qc', balance: '100', nftCount: 0, snapshotAt: 1782563289 },
      { address: 'bitcoincash:qd', balance: '100', nftCount: 0, snapshotAt: 1782563289 },
      { address: 'bitcoincash:qe', balance: '100', nftCount: 0, snapshotAt: 1782563289 },
    ],
  };
  const fetcher = async () => makeMockResponse({ status: 200, body });
  const r = await fetchAndComputeHolderConcentration({
    tokenId: VALID_TOKEN,
    scannerOpts: { fetcher },
  });
  assert.equal(r.ok, true);
  assert.equal(r.schema, HOLDERS_SCANNER_SCHEMA);
  assert.equal(r.is_rug_pattern, true);
  assert.equal(r.holders_count, 5);
  assert.ok(typeof r.top_n_pct_of_supply === 'number');
  assert.ok(r.top_n_pct_of_supply >= 80);
});

test('fetchAndComputeHolderConcentration: happy non-rug (broad distribution)', async () => {
  // 10 holders each holding 10% of supply; default top_n=5 holds
  // 50% which is below the 80% threshold → NOT a rug pattern.
  const body = {
    category: VALID_TOKEN,
    holders: [
      { address: 'bitcoincash:qa', balance: '10', nftCount: 0, snapshotAt: 1782563289 },
      { address: 'bitcoincash:qb', balance: '10', nftCount: 0, snapshotAt: 1782563289 },
      { address: 'bitcoincash:qc', balance: '10', nftCount: 0, snapshotAt: 1782563289 },
      { address: 'bitcoincash:qd', balance: '10', nftCount: 0, snapshotAt: 1782563289 },
      { address: 'bitcoincash:qe', balance: '10', nftCount: 0, snapshotAt: 1782563289 },
      { address: 'bitcoincash:qf', balance: '10', nftCount: 0, snapshotAt: 1782563289 },
      { address: 'bitcoincash:qg', balance: '10', nftCount: 0, snapshotAt: 1782563289 },
      { address: 'bitcoincash:qh', balance: '10', nftCount: 0, snapshotAt: 1782563289 },
      { address: 'bitcoincash:qi', balance: '10', nftCount: 0, snapshotAt: 1782563289 },
      { address: 'bitcoincash:qj', balance: '10', nftCount: 0, snapshotAt: 1782563289 },
    ],
  };
  const fetcher = async () => makeMockResponse({ status: 200, body });
  const r = await fetchAndComputeHolderConcentration({
    tokenId: VALID_TOKEN,
    scannerOpts: { fetcher },
  });
  assert.equal(r.ok, true);
  assert.equal(r.is_rug_pattern, false);
  assert.ok(typeof r.top_n_pct_of_supply === 'number');
  assert.ok(r.top_n_pct_of_supply < 80);
});

test('fetchAndComputeHolderConcentration: token_not_found upstream returns token_not_found', async () => {
  const fetcher = async () => makeMockResponse({ status: 200, body: { message: 'This token is not available.' } });
  const r = await fetchAndComputeHolderConcentration({ tokenId: VALID_TOKEN, scannerOpts: { fetcher } });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'token_not_found');
  assert.equal(r.holders_count, 0);
});

test('fetchAndComputeHolderConcentration: 404 upstream returns token_not_found', async () => {
  const fetcher = async () => makeMockResponse({ status: 404, body: null });
  const r = await fetchAndComputeHolderConcentration({ tokenId: VALID_TOKEN, scannerOpts: { fetcher } });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'token_not_found');
});

test('fetchAndComputeHolderConcentration: 500 upstream returns http_error', async () => {
  const fetcher = async () => makeMockResponse({ status: 500, body: { error: 'down' } });
  const r = await fetchAndComputeHolderConcentration({ tokenId: VALID_TOKEN, scannerOpts: { fetcher } });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'http_error');
  assert.equal(r.http_status, 500);
});

test('fetchAndComputeHolderConcentration: fetcher throws returns fetch_failed', async () => {
  const fetcher = async () => { throw new Error('ECONNREFUSED'); };
  const r = await fetchAndComputeHolderConcentration({ tokenId: VALID_TOKEN, scannerOpts: { fetcher } });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'fetch_failed');
});

test('fetchAndComputeHolderConcentration: parse fail returns parse_failed', async () => {
  const fetcher = async () => ({
    ok: true,
    status: 200,
    json: async () => { throw new Error('bad'); },
  });
  const r = await fetchAndComputeHolderConcentration({ tokenId: VALID_TOKEN, scannerOpts: { fetcher } });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'parse_failed');
});

test('fetchAndComputeHolderConcentration: shape invalid returns shape_invalid', async () => {
  const fetcher = async () => makeMockResponse({ status: 200, body: { holders: 'bad' } });
  const r = await fetchAndComputeHolderConcentration({ tokenId: VALID_TOKEN, scannerOpts: { fetcher } });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'shape_invalid');
});

test('fetchAndComputeHolderConcentration: custom concentrationOpts honored', async () => {
  // 4 holders; top-1 holds 60% — NOT a rug by default (80% threshold)
  // BUT is a rug under threshold=50.
  const body = {
    category: VALID_TOKEN,
    holders: [
      { address: 'bitcoincash:qa', balance: '60', nftCount: 0, snapshotAt: 1782563289 },
      { address: 'bitcoincash:qb', balance: '20', nftCount: 0, snapshotAt: 1782563289 },
      { address: 'bitcoincash:qc', balance: '10', nftCount: 0, snapshotAt: 1782563289 },
      { address: 'bitcoincash:qd', balance: '10', nftCount: 0, snapshotAt: 1782563289 },
    ],
  };
  const fetcher = async () => makeMockResponse({ status: 200, body });
  const r1 = await fetchAndComputeHolderConcentration({
    tokenId: VALID_TOKEN,
    scannerOpts: { fetcher },
    concentrationOpts: { rug_threshold_pct: 50, rug_top_n: 1 },
  });
  assert.equal(r1.ok, true);
  assert.equal(r1.is_rug_pattern, true);
  const r2 = await fetchAndComputeHolderConcentration({
    tokenId: VALID_TOKEN,
    scannerOpts: { fetcher },
    concentrationOpts: { rug_threshold_pct: 80, rug_top_n: 1 },
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.is_rug_pattern, false);
});

test('fetchAndComputeHolderConcentration: args-as-array returns config_invalid', async () => {
  const r = await fetchAndComputeHolderConcentration([]);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'config_invalid');
});

test('fetchAndComputeHolderConcentration: empty holders array', async () => {
  const body = { category: VALID_TOKEN, holders: [] };
  const fetcher = async () => makeMockResponse({ status: 200, body });
  const r = await fetchAndComputeHolderConcentration({ tokenId: VALID_TOKEN, scannerOpts: { fetcher } });
  // Empty holders → rug predicate should be `false` (not a rug, but
  // also probably not a viable token — surface as `ok:true` with
  // `is_rug_pattern:false` so the trader loop treats it as "no data,
  // pass through to other gates").
  assert.equal(r.ok, true);
  assert.equal(r.holders_count, 0);
  assert.equal(r.is_rug_pattern, false);
});
