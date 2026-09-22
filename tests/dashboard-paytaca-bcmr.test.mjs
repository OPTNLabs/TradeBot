#!/usr/bin/env node
/**
 * tests/dashboard-paytaca-bcmr.test.mjs
 *
 * Unit tests for `src/dashboard/paytacaBcmr.mjs` (T26c). Covers
 * the few pure helpers (URL builder, validator, normalizer) + the
 * client behavior end-to-end via an injected `fetchImpl` stub.
 *
 * The HTTP layer is fully stubbed — these tests never touch the
 * real Paytaca BCMR endpoint, which keeps them fast and
 * deterministic.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPaytacaBcmrClient,
  normalizePaytacaBcmr,
  buildBcmrUrl,
  isValidTokenId,
  normalizeBcmrBaseUrl,
} from '../src/dashboard/paytacaBcmr.mjs';

const PUSD_ID = '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544';

test('paytacaBcmr: buildBcmrUrl always emits a trailing slash (skips the 301 redirect)', () => {
  assert.equal(
    buildBcmrUrl('https://bcmr.paytaca.com/api', PUSD_ID),
    `https://bcmr.paytaca.com/api/tokens/${PUSD_ID}/`,
  );
  assert.equal(
    buildBcmrUrl('https://bcmr.paytaca.com/api/', PUSD_ID),
    `https://bcmr.paytaca.com/api/tokens/${PUSD_ID}/`,
  );
  // Token id is lower-cased.
  assert.equal(
    buildBcmrUrl('https://bcmr.paytaca.com/api', PUSD_ID.toUpperCase()),
    `https://bcmr.paytaca.com/api/tokens/${PUSD_ID}/`,
  );
});

test('paytacaBcmr: isValidTokenId rejects anything that is not 64 lowercase hex chars', () => {
  assert.equal(isValidTokenId(PUSD_ID), true);
  assert.equal(isValidTokenId(PUSD_ID.toUpperCase()), false, 'uppercase hex rejected');
  assert.equal(isValidTokenId(''), false);
  assert.equal(isValidTokenId('abc'), false);
  assert.equal(isValidTokenId(PUSD_ID.slice(0, 63)), false, 'too short');
  assert.equal(isValidTokenId(PUSD_ID + 'a'), false, 'too long');
  assert.equal(isValidTokenId(null), false);
  assert.equal(isValidTokenId(undefined), false);
  assert.equal(isValidTokenId(42), false);
  // 64 chars but contains non-hex
  assert.equal(isValidTokenId('z'.repeat(64)), false);
});

test('paytacaBcmr: normalizePaytacaBcmr flattens the raw response', () => {
  const raw = {
    name: 'ParyonUSD',
    description: 'A dollar pegged stablecoin on Bitcoin Cash.',
    uris: {
      icon: 'https://paryonusd.com/logo.svg',
      web: 'https://paryonusd.com',
      x: 'https://x.com/ParyonUSD',
    },
    token: {
      category: PUSD_ID,
      symbol: 'PUSD',
      decimals: 2,
    },
    nfts: { parse: { types: {} } },
  };
  const out = normalizePaytacaBcmr(PUSD_ID, raw);
  assert.equal(out.token_id, PUSD_ID);
  assert.equal(out.name, 'ParyonUSD');
  assert.equal(out.symbol, 'PUSD');
  assert.equal(out.decimals, 2);
  assert.equal(out.icon_url, 'https://paryonusd.com/logo.svg');
  assert.equal(out.web_url, 'https://paryonusd.com');
  assert.equal(out.description, 'A dollar pegged stablecoin on Bitcoin Cash.');
  assert.equal(out.source, 'paytaca-bcmr');
  // fetched_at is filled by the caller (we don't fake the clock).
  assert.equal(out.fetched_at, '');
});

test('paytacaBcmr: normalizePaytacaBcmr tolerates missing fields (null everywhere)', () => {
  const out = normalizePaytacaBcmr(PUSD_ID, {});
  assert.equal(out.token_id, PUSD_ID);
  assert.equal(out.name, null);
  assert.equal(out.symbol, null);
  assert.equal(out.description, null);
  assert.equal(out.decimals, null);
  assert.equal(out.icon_url, null);
  assert.equal(out.web_url, null);
});

test('paytacaBcmr: normalizePaytacaBcmr handles null / non-object input', () => {
  const out = normalizePaytacaBcmr(PUSD_ID, null);
  assert.equal(out.token_id, PUSD_ID);
  assert.equal(out.name, null);
});

test('paytacaBcmr: normalizePaytacaBcmr falls back to top-level symbol if token.symbol is missing', () => {
  const out = normalizePaytacaBcmr(PUSD_ID, { name: 'X', symbol: 'XB' });
  assert.equal(out.symbol, 'XB');
});

test('paytacaBcmr: normalizeBcmrBaseUrl validates + strips trailing slashes', () => {
  assert.equal(normalizeBcmrBaseUrl('https://bcmr.paytaca.com/api'), 'https://bcmr.paytaca.com/api');
  assert.equal(normalizeBcmrBaseUrl('https://bcmr.paytaca.com/api/'), 'https://bcmr.paytaca.com/api');
  assert.equal(normalizeBcmrBaseUrl('https://bcmr.paytaca.com/api///'), 'https://bcmr.paytaca.com/api');
  assert.equal(normalizeBcmrBaseUrl('http://localhost:9000'), 'http://localhost:9000');
  // Reject non-http(s) protocols.
  assert.equal(normalizeBcmrBaseUrl('file:///etc/passwd'), null);
  // Reject non-string / garbage.
  assert.equal(normalizeBcmrBaseUrl(null), null);
  assert.equal(normalizeBcmrBaseUrl(42), null);
  assert.equal(normalizeBcmrBaseUrl(''), null);
  assert.equal(normalizeBcmrBaseUrl('   '), null);
});

/** Helper: build a fake fetch that returns a canned body. */
function fakeFetchImpl(responseFor) {
  return async (url, init) => {
    const id = url.split('/').filter(Boolean).pop().replace(/\/$/, '');
    const r = responseFor(id);
    if (r === null) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => r,
    };
  };
}

test('paytacaBcmr: lookup() hits the network once, then serves from cache', async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        name: 'ParyonUSD',
        token: { symbol: 'PUSD', decimals: 2 },
        uris: { icon: 'https://example/x.svg' },
      }),
    };
  };
  const c = createPaytacaBcmrClient({ fetchImpl, now: () => 0 });
  const r1 = await c.lookup(PUSD_ID);
  assert.equal(r1.ok, true);
  assert.equal(r1.record.name, 'ParyonUSD');
  assert.equal(calls, 1);
  assert.equal(c.stats().misses, 1);
  assert.equal(c.stats().hits, 0);
  const r2 = await c.lookup(PUSD_ID);
  assert.equal(r2.ok, true);
  assert.equal(calls, 1, 'second call must hit cache');
  assert.equal(c.stats().hits, 1);
  assert.equal(c.cacheSize(), 1);
});

test('paytacaBcmr: lookup() de-dupes concurrent requests for the same id', async () => {
  let calls = 0;
  let resolveFetch;
  const fetchImpl = (url, init) => new Promise((resolve) => {
    calls += 1;
    resolveFetch = () => resolve({
      ok: true,
      status: 200,
      json: async () => ({ name: 'X', token: { symbol: 'X' } }),
    });
  });
  const c = createPaytacaBcmrClient({ fetchImpl });
  const p1 = c.lookup(PUSD_ID);
  const p2 = c.lookup(PUSD_ID);
  // Resolve the underlying fetch after both have started.
  setTimeout(() => resolveFetch(), 5);
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(calls, 1, 'concurrent lookups must share the network call');
});

test('paytacaBcmr: lookup() returns typed errors on 404 + 502', async () => {
  const c404 = createPaytacaBcmrClient({
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  });
  const r404 = await c404.lookup(PUSD_ID);
  assert.equal(r404.ok, false);
  assert.equal(r404.error, 'not_found');
  assert.equal(r404.status, 404);

  const c502 = createPaytacaBcmrClient({
    fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({}) }),
  });
  const r502 = await c502.lookup(PUSD_ID);
  assert.equal(r502.ok, false);
  assert.equal(r502.error, 'upstream_502');
  assert.equal(r502.status, 502);
});

test('paytacaBcmr: lookup() retries on transient network failure (maxRetries=1 → 2 attempts)', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error('ECONNRESET');
  };
  const c = createPaytacaBcmrClient({ fetchImpl, maxRetries: 1, timeoutMs: 1000 });
  const r = await c.lookup(PUSD_ID);
  assert.equal(r.ok, false);
  assert.match(r.error, /ECONNRESET/);
  assert.equal(calls, 2, 'one initial + one retry');
});

test('paytacaBcmr: lookup() rejects an invalid token_id without a network call', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, status: 200, json: async () => ({}) }; };
  const c = createPaytacaBcmrClient({ fetchImpl });
  const r = await c.lookup('not-a-token-id');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_token_id');
  assert.equal(calls, 0);
});

test('paytacaBcmr: cache expires after ttlMs', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ name: 'X', token: { symbol: 'X' } }) };
  };
  let nowMs = 0;
  const c = createPaytacaBcmrClient({ fetchImpl, ttlMs: 1000, now: () => nowMs });
  await c.lookup(PUSD_ID);
  assert.equal(calls, 1);
  // Advance 500 ms — still cached.
  nowMs += 500;
  await c.lookup(PUSD_ID);
  assert.equal(calls, 1);
  // Advance past TTL — cache miss.
  nowMs += 600;
  await c.lookup(PUSD_ID);
  assert.equal(calls, 2);
});

test('paytacaBcmr: cached() returns the record without doing a network call', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ name: 'ParyonUSD', token: { symbol: 'PUSD' } }) };
  };
  const c = createPaytacaBcmrClient({ fetchImpl });
  await c.lookup(PUSD_ID);
  assert.equal(calls, 1);
  const cached = c.cached(PUSD_ID);
  assert.ok(cached);
  assert.equal(cached.name, 'ParyonUSD');
  assert.equal(calls, 1);
});

test('paytacaBcmr: stats counter increments errors on network failure', async () => {
  const fetchImpl = async () => { throw new Error('boom'); };
  const c = createPaytacaBcmrClient({ fetchImpl, maxRetries: 0 });
  await c.lookup(PUSD_ID);
  assert.equal(c.stats().errors, 1);
});
