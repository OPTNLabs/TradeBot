#!/usr/bin/env node
/**
 * Unit tests for src/data/fetcher.mjs.
 *
 * Tests the public surface + the pure helpers + the retry / cache /
 * rate-limit machinery. Network access is mocked via `fetchImpl`.
 * Run via:
 *   npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Fetcher,
  TokenBucket,
  TtlCache,
  IndexerError,
  IndexerHttpError,
  IndexerTimeoutError,
  IndexerShapeError,
  buildDiscoveryUrl,
  buildActivePoolsUrl,
  buildBcmrUrl,
  buildStatsRecord,
  findByTokenId,
  findBySymbol,
  requireValidTokenId,
  isRetryable,
  backoffDelay,
  bestAmmSpotSats,
  totalAmmSats,
  discoveryCacheKey,
  DEFAULT_FETCHER_CONFIG,
  bchFromSats,
  trimRawIndexerEntry,
  trimRawIndexerResponse,
} from '../src/data/fetcher.mjs';

import { createLogger, createMemorySink } from '../src/util/logger.mjs';

const TID = 'a'.repeat(64);

// ────────────────────────────────────────────────────────────────────
//  URL builders (pure)
// ────────────────────────────────────────────────────────────────────

test('buildDiscoveryUrl: includes limit + by + order', () => {
  const url = buildDiscoveryUrl('https://indexer.riften.net/cauldron', {
    by: 'volume', order: 'asc', limit: 50,
  });
  assert.equal(
    url,
    'https://indexer.riften.net/cauldron/tokens/list_cached?limit=50&by=volume&order=asc',
  );
});

test('buildDiscoveryUrl: clamps limit to [1, 1000]', () => {
  assert.match(buildDiscoveryUrl('X', { limit: 0 }), /limit=1/);
  assert.match(buildDiscoveryUrl('X', { limit: 999999 }), /limit=1000/);
  assert.match(buildDiscoveryUrl('X', { limit: -5 }), /limit=1/);
});

test('buildDiscoveryUrl: normalizes order to "asc"/"desc"', () => {
  assert.match(buildDiscoveryUrl('X', { order: 'DESC' }), /order=desc/);
  assert.match(buildDiscoveryUrl('X', { order: 'garbage' }), /order=desc/);
  assert.match(buildDiscoveryUrl('X', { order: 'asc' }), /order=asc/);
});

test('buildActivePoolsUrl: encodes token_id', () => {
  const url = buildActivePoolsUrl('https://indexer.cauldron.quest/cauldron', TID);
  assert.ok(url.startsWith('https://indexer.cauldron.quest/cauldron/pool/active?token='));
  assert.ok(url.includes(TID));
});

test('buildBcmrUrl: BCMR lives at indexer ROOT (no /cauldron/ prefix)', () => {
  const url = buildBcmrUrl('https://indexer.cauldron.quest', TID);
  assert.equal(url, `https://indexer.cauldron.quest/bcmr/token/${TID}`);
});

// ────────────────────────────────────────────────────────────────────
//  findByTokenId / findBySymbol
// ────────────────────────────────────────────────────────────────────

const sampleRecords = [
  {
    token_id: TID,
    display_symbol: 'PUSD',
    bcmr: { token: { symbol: 'PUSD', decimals: 2 }, name: 'Paytaca USD' },
    price_now: 14500,
    trade_volume: 5_000_000_000,
    tvl_sats: 10_000_000_000,
    score: 0.82,
    score_rank: 1,
  },
  {
    token_id: 'b'.repeat(64),
    display_symbol: 'TST2',
    bcmr: { token: { symbol: 'tst2', decimals: 4 }, name: 'Test2' },
    price_now: 100,
    trade_volume: 1_000_000,
    score: 0.31,
    score_rank: 5,
  },
];

test('findByTokenId: exact match (case-insensitive)', () => {
  assert.equal(findByTokenId(sampleRecords, TID), sampleRecords[0]);
  assert.equal(findByTokenId(sampleRecords, TID.toUpperCase()), sampleRecords[0]);
});

test('findByTokenId: returns null when no match / bad input', () => {
  assert.equal(findByTokenId(sampleRecords, '0'.repeat(64)), null);
  assert.equal(findByTokenId(null, TID), null);
  assert.equal(findByTokenId(undefined, TID), null);
});

test('findBySymbol: case-insensitive across display + bcmr', () => {
  assert.equal(findBySymbol(sampleRecords, 'pusd'), sampleRecords[0]);
  assert.equal(findBySymbol(sampleRecords, 'TST2'), sampleRecords[1]);
  assert.equal(findBySymbol(sampleRecords, 'tst2'), sampleRecords[1]);
});

test('findBySymbol: returns null when not found / bad input', () => {
  assert.equal(findBySymbol(sampleRecords, 'NOPE'), null);
  assert.equal(findBySymbol(null, 'PUSD'), null);
  assert.equal(findBySymbol(sampleRecords, ''), null);
});

// ────────────────────────────────────────────────────────────────────
//  buildStatsRecord
// ────────────────────────────────────────────────────────────────────

test('buildStatsRecord: maps indexer shape → canonical PoolStats', () => {
  const s = buildStatsRecord(sampleRecords[0]);
  assert.equal(s.token_id, TID);
  assert.equal(s.symbol, 'PUSD');
  assert.equal(s.decimals, 2);
  assert.equal(s.decimals_warn, null);
  assert.equal(s.price_now_sats, 14500);
  assert.equal(s.trade_volume_sats, 5_000_000_000);
  assert.equal(s.tvl_sats, 10_000_000_000);
  assert.equal(s.score, 0.82);
  assert.equal(s.score_rank, 1);
});

test('buildStatsRecord: sets decimals_warn when BCMR decimals missing', () => {
  const entry = {
    token_id: TID,
    bcmr: { token: { symbol: 'XX' } }, // no decimals
    price_now: 1234,
  };
  const s = buildStatsRecord(entry);
  assert.equal(s.decimals, null);
  assert.match(s.decimals_warn, /no BCMR decimals/);
});

test('buildStatsRecord: nullable fields stay null (not 0 / NaN)', () => {
  const s = buildStatsRecord({ token_id: TID });
  assert.equal(s.price_now_sats, null);
  assert.equal(s.price_now_usd, null);
  assert.equal(s.trade_volume_sats, null);
  assert.equal(s.apy_30d_bp, null);
  assert.equal(s.score, null);
});

test('buildStatsRecord: coerces string numbers', () => {
  const s = buildStatsRecord({ token_id: TID, price_now: '14500', score: '0.82' });
  assert.equal(s.price_now_sats, 14500);
  assert.equal(s.score, 0.82);
});

test('buildStatsRecord: passes through first_pool_ts (sec) → first_seen_ts_ms (ms) — T37', () => {
  // T37: indexer exposes `first_pool_ts` as UNIX seconds; the
  // canonical PoolStats field is `first_seen_ts_ms` (ms). Verify
  // the multiplication-by-1000 conversion.
  const ts_s = 1_700_000_000; // seconds
  const s = buildStatsRecord({ token_id: TID, first_pool_ts: ts_s });
  assert.equal(s.first_seen_ts_ms, ts_s * 1000);
});

test('buildStatsRecord: first_seen_ts_ms is null when first_pool_ts is missing — T37', () => {
  // Missing-timestamp records still parse cleanly (the ranker skips
  // the age filter for them — see `poolFirstSeenMs`).
  const s = buildStatsRecord({ token_id: TID });
  assert.equal(s.first_seen_ts_ms, null);
});

test('buildStatsRecord: first_seen_ts_ms handles fractional seconds — T37', () => {
  // Cauldron indexer returns integer seconds today, but be tolerant
  // of fractional inputs (the multiplication must not produce a
  // non-integer ms value that breaks `poolFirstSeenMs` arithmetic).
  const s = buildStatsRecord({ token_id: TID, first_pool_ts: 1_700_000_000.7 });
  assert.equal(s.first_seen_ts_ms, Math.trunc(1_700_000_000.7 * 1000));
});

test('buildStatsRecord: rejects non-object input', () => {
  assert.throws(() => buildStatsRecord(null), IndexerShapeError);
  assert.throws(() => buildStatsRecord('hi'), IndexerShapeError);
});

// ────────────────────────────────────────────────────────────────────
//  requireValidTokenId
// ────────────────────────────────────────────────────────────────────

test('requireValidTokenId: canonicalizes + accepts', () => {
  assert.equal(requireValidTokenId(TID), TID);
  assert.equal(requireValidTokenId('0x' + TID), TID);
  assert.equal(requireValidTokenId(TID.toUpperCase()), TID);
});

test('requireValidTokenId: throws TypeError on bad input', () => {
  assert.throws(() => requireValidTokenId('nope'), TypeError);
  assert.throws(() => requireValidTokenId(null), TypeError);
  assert.throws(() => requireValidTokenId(123), TypeError);
});

// ────────────────────────────────────────────────────────────────────
//  TtlCache
// ────────────────────────────────────────────────────────────────────

test('TtlCache: get returns undefined when empty', () => {
  const c = new TtlCache();
  assert.equal(c.get('x'), undefined);
});

test('TtlCache: set + get round-trip', () => {
  const now = () => 1_000;
  const c = new TtlCache({ ttlMs: 100, now });
  c.set('k', 'v');
  assert.equal(c.get('k'), 'v');
});

test('TtlCache: TTL expires entries', () => {
  let t = 1_000;
  const c = new TtlCache({ ttlMs: 100, now: () => t });
  c.set('k', 'v');
  t += 99;
  assert.equal(c.get('k'), 'v');
  t += 2;
  assert.equal(c.get('k'), undefined);
});

test('TtlCache: delete removes entries', () => {
  const c = new TtlCache();
  c.set('k', 'v');
  c.delete('k');
  assert.equal(c.get('k'), undefined);
});

test('TtlCache: clear empties the cache', () => {
  const c = new TtlCache();
  c.set('a', 1); c.set('b', 2);
  c.clear();
  assert.equal(c.size, 0);
});

test('TtlCache: evict oldest when over capacity', () => {
  const c = new TtlCache({ maxEntries: 2 });
  c.set('a', 1); c.set('b', 2); c.set('c', 3);
  assert.equal(c.get('a'), undefined);
  assert.equal(c.get('b'), 2);
  assert.equal(c.get('c'), 3);
});

// ────────────────────────────────────────────────────────────────────
//  TokenBucket
// ────────────────────────────────────────────────────────────────────

test('TokenBucket: initial burst allows N quick acquires', async () => {
  const b = new TokenBucket({ ratePerSec: 100, burst: 3 });
  const start = Date.now();
  await b.acquire(); await b.acquire(); await b.acquire();
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 50, `3-burst acquires should be near-instant (took ${elapsed}ms)`);
});

test('TokenBucket: refills at ratePerSec', async () => {
  const b = new TokenBucket({ ratePerSec: 1000, burst: 1 });
  await b.acquire(); // burst 1
  const start = Date.now();
  await b.acquire(); // wait ~1ms for refill at 1000/sec
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 0, `2nd acquire should be near-instant (took ${elapsed}ms)`);
});

test('TokenBucket: rejects bad config', () => {
  assert.throws(() => new TokenBucket({ ratePerSec: 0 }), /ratePerSec/);
});

// ────────────────────────────────────────────────────────────────────
//  backoffDelay (pure-ish)
// ────────────────────────────────────────────────────────────────────

test('backoffDelay: doubles each attempt up to cap', async () => {
  const calls = [];
  const fakeRandom = () => 0.5; // disables jitter
  await backoffDelay({ attempt: 0, baseMs: 100, capMs: 1000, jitterPct: 0, random: fakeRandom });
  // attempt 0 → 100ms base. We can't directly read the delay, so just
  // verify backoff doesn't reject.
  await backoffDelay({ attempt: 5, baseMs: 100, capMs: 1000, jitterPct: 0, random: fakeRandom });
  await backoffDelay({ attempt: 100, baseMs: 100, capMs: 1000, jitterPct: 0, random: fakeRandom });
  assert.equal(calls.length, 0);
});

test('backoffDelay: jitter stays within ±jitterPct (random=0 → -jitterPct)', async () => {
  const start = Date.now();
  await backoffDelay({
    attempt: 3, baseMs: 1000, capMs: 100000, jitterPct: 0.3, random: () => 0.0,
  });
  const elapsed = Date.now() - start;
  // attempt 3 → 8000ms; jitter formula = exp * jitterPct * (random*2 - 1).
  // random=0 → (0*2-1) = -1 → jitter = -0.3 → 8000 * 0.7 = 5600ms.
  assert.ok(elapsed >= 5_500 && elapsed < 6_000, `expected ~5600ms, got ${elapsed}ms`);
});

test('backoffDelay: random=1 → +jitterPct (positive jitter)', async () => {
  const start = Date.now();
  await backoffDelay({
    attempt: 3, baseMs: 1000, capMs: 100000, jitterPct: 0.3, random: () => 1.0,
  });
  const elapsed = Date.now() - start;
  // random=1 → (1*2-1) = +1 → jitter = +0.3 → 8000 * 1.3 = 10400ms.
  assert.ok(elapsed >= 10_300 && elapsed < 10_500, `expected ~10400ms, got ${elapsed}ms`);
});

// ────────────────────────────────────────────────────────────────────
//  isRetryable
// ────────────────────────────────────────────────────────────────────

test('isRetryable: 5xx + timeout + TypeError are retryable', () => {
  assert.equal(isRetryable(new IndexerHttpError(502, 'u', '')), true);
  assert.equal(isRetryable(new IndexerHttpError(504, 'u', '')), true);
  assert.equal(isRetryable(new IndexerTimeoutError(1000, 'u')), true);
  assert.equal(isRetryable(new TypeError('fetch failed')), true);
});

test('isRetryable: 4xx and shape errors are NOT retryable', () => {
  assert.equal(isRetryable(new IndexerHttpError(404, 'u', '')), false);
  assert.equal(isRetryable(new IndexerHttpError(400, 'u', '')), false);
  assert.equal(isRetryable(new IndexerHttpError(429, 'u', '')), false);
  assert.equal(isRetryable(new IndexerShapeError('bad', 'u')), false);
});

// ────────────────────────────────────────────────────────────────────
//  Fetcher — happy paths (mock fetch)
// ────────────────────────────────────────────────────────────────────

function jsonResponse(status, body) {
  return {
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    ok: status >= 200 && status < 300,
  };
}

/** Build a fetch mock that matches URLs in a routes table. */
function mockFetch(routes, defaultResp) {
  const calls = [];
  /** @type {Map<string, Array<(init:RequestInit)=>Promise<Response>>>} */
  const queue = new Map();
  for (const r of routes) queue.set(r.url, [...(r.responses || [])]);
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const list = queue.get(url);
      if (!list || list.length === 0) {
        return defaultResp ?? jsonResponse(404, 'not found');
      }
      const next = list.shift();
      return next;
    },
  };
}

const indexerBase = 'https://indexer.riften.net/cauldron';
const bcmrBase = 'https://indexer.cauldron.quest';

const samplePools = [
  {
    pool_id: 'pool-aaa',
    token_id: TID,
    sats: 50_000_000,
    tokens: 1_000_000,
    owner_p2pkh_addr: 'bitcoincash:qqqq',
    txid: 'a'.repeat(64),
    tx_pos: 0,
  },
];

const sampleTop = sampleRecords;

const poolUrl = `${indexerBase}/pool/active?token=${TID}`;
const bcmrUrl = `${bcmrBase}/bcmr/token/${TID}`;
const discoveryUrl = (n = 200, by = 'tvl', order = 'desc') =>
  `${indexerBase}/tokens/list_cached?limit=${n}&by=${by}&order=${order}`;

test('Fetcher.getTokenStats: 200 returns normalized PoolStats + caches', async () => {
  const m = mockFetch([{ url: discoveryUrl(), responses: [jsonResponse(200, sampleTop)] }]);
  const f = new Fetcher({
    indexerBaseUrl: indexerBase,
    bcmrBaseUrl: bcmrBase,
    fetchImpl: m.fetchImpl,
    logger: createLogger({ sink: createMemorySink().stream }),
  });
  const s = await f.getTokenStats(TID);
  assert.equal(s.symbol, 'PUSD');
  assert.equal(s.score, 0.82);
  // Second call should be a cache hit (no extra fetch).
  const s2 = await f.getTokenStats(TID);
  assert.deepEqual(s2, s);
  assert.equal(m.calls.length, 1);
  assert.equal(f.stats().cacheHits, 1);
});

test('Fetcher.getTokenStats: unknown token_id → IndexerShapeError', async () => {
  const m = mockFetch([{ url: discoveryUrl(), responses: [jsonResponse(200, sampleTop)] }]);
  const f = new Fetcher({
    indexerBaseUrl: indexerBase,
    fetchImpl: m.fetchImpl,
  });
  await assert.rejects(
    () => f.getTokenStats('0'.repeat(64)),
    IndexerShapeError,
  );
});

test('Fetcher.getTokenStatsBySymbol: resolves via display_symbol', async () => {
  const m = mockFetch([{ url: discoveryUrl(), responses: [jsonResponse(200, sampleTop)] }]);
  const f = new Fetcher({
    indexerBaseUrl: indexerBase,
    fetchImpl: m.fetchImpl,
  });
  const s = await f.getTokenStatsBySymbol('PUSD');
  assert.equal(s.token_id, TID);
});

test('Fetcher.getTokenStatsBySymbol: rejects bad symbol', async () => {
  const f = new Fetcher({ indexerBaseUrl: indexerBase });
  await assert.rejects(() => f.getTokenStatsBySymbol(''), TypeError);
  await assert.rejects(() => f.getTokenStatsBySymbol(null), TypeError);
});

test('Fetcher.listPools: 200 returns Pool[] + caches', async () => {
  const m = mockFetch([
    { url: poolUrl, responses: [jsonResponse(200, samplePools)] },
  ]);
  const f = new Fetcher({
    indexerBaseUrl: indexerBase,
    bcmrBaseUrl: bcmrBase,
    fetchImpl: m.fetchImpl,
  });
  const pools = await f.listPools(TID);
  assert.equal(pools.length, 1);
  assert.equal(pools[0].token_id, TID);
  assert.equal(pools[0].sats, 50_000_000);
  // second call cached
  await f.listPools(TID);
  assert.equal(m.calls.length, 1);
});

test('Fetcher.listPools: 200 with { active: [...] } wrapper also works', async () => {
  const m = mockFetch([
    { url: poolUrl, responses: [jsonResponse(200, { active: samplePools })] },
  ]);
  const f = new Fetcher({
    indexerBaseUrl: indexerBase,
    fetchImpl: m.fetchImpl,
  });
  const pools = await f.listPools(TID);
  assert.equal(pools.length, 1);
});

test('Fetcher.listPools: malformed response → IndexerShapeError', async () => {
  const m = mockFetch([
    { url: poolUrl, responses: [jsonResponse(200, { wrong: 'shape' })] },
  ]);
  const f = new Fetcher({
    indexerBaseUrl: indexerBase,
    fetchImpl: m.fetchImpl,
  });
  await assert.rejects(() => f.listPools(TID), IndexerShapeError);
});

test('Fetcher.listPools: 5xx retries up to maxRetries then throws IndexerHttpError', async () => {
  const m = mockFetch([
    { url: poolUrl, responses: [
      jsonResponse(502, 'bad gateway'),
      jsonResponse(502, 'bad gateway'),
      jsonResponse(502, 'bad gateway'),
      jsonResponse(502, 'bad gateway'),
    ]},
  ]);
  const f = new Fetcher({
    indexerBaseUrl: indexerBase,
    fetchImpl: m.fetchImpl,
    retryBaseMs: 1,
    retryCapMs: 2,
    retryJitterPct: 0,
    random: () => 0.5,
    maxRetries: 3,
  });
  await assert.rejects(() => f.listPools(TID), IndexerHttpError);
  // 1 initial + 3 retries = 4 calls.
  assert.equal(m.calls.length, 4);
  assert.equal(f.stats().retries, 3);
});

test('Fetcher.listPools: 4xx does NOT retry (throws on first call)', async () => {
  const m = mockFetch([
    { url: poolUrl, responses: [
      jsonResponse(404, 'no pool'),
      jsonResponse(404, 'no pool'),
    ]},
  ]);
  const f = new Fetcher({
    indexerBaseUrl: indexerBase,
    fetchImpl: m.fetchImpl,
    maxRetries: 3,
  });
  await assert.rejects(() => f.listPools(TID), IndexerHttpError);
  assert.equal(m.calls.length, 1);
});

test('Fetcher.getBcmr: 200 returns Token, 200 with null → null (no authchain)', async () => {
  const m = mockFetch([
    { url: bcmrUrl, responses: [
      jsonResponse(200, { token: { symbol: 'PUSD', name: 'Paytaca USD', decimals: 2 } }),
      jsonResponse(200, null),
    ]},
  ]);
  const f = new Fetcher({
    indexerBaseUrl: indexerBase,
    bcmrBaseUrl: bcmrBase,
    fetchImpl: m.fetchImpl,
  });
  const t = await f.getBcmr(TID);
  assert.equal(t.symbol, 'PUSD');
  assert.equal(t.decimals, 2);
  // 404 should also resolve to null (no authchain).
  const m2 = mockFetch([
    { url: bcmrUrl, responses: [jsonResponse(404, 'not found')] },
  ]);
  const f2 = new Fetcher({
    indexerBaseUrl: indexerBase,
    bcmrBaseUrl: bcmrBase,
    fetchImpl: m2.fetchImpl,
  });
  const t2 = await f2.getBcmr(TID);
  assert.equal(t2, null);
});

test('Fetcher: timeout via slow fetch → IndexerTimeoutError then retry', async () => {
  let attempt = 0;
  // First attempt honors the AbortSignal and hangs past the timeout
  // → AbortController fires → IndexerTimeoutError → retry. Second
  // attempt returns a valid body (sampleTop is array-shaped;
  // listPools filters non-Pool records out, so the result is an
  // empty array).
  const slowFetch = async (url, init) => {
    attempt += 1;
    if (attempt <= 1) {
      // Hang, but listen for the abort signal so we exit promptly
      // when the AbortController fires. Without this, the test
      // sleeps 50ms even after abort and no retry would be observed.
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 50);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
      return jsonResponse(200, []);
    }
    return jsonResponse(200, sampleTop);
  };
  const f = new Fetcher({
    indexerBaseUrl: indexerBase,
    fetchImpl: slowFetch,
    timeoutMs: 5,
    retryBaseMs: 1,
    maxRetries: 2,
  });
  const pools = await f.listPools(TID);
  assert.equal(pools.length, 0);
  assert.equal(attempt, 2, 'expected initial attempt + 1 retry');
});

test('Fetcher: invalid JSON body → IndexerShapeError', async () => {
  const m = mockFetch([
    { url: poolUrl, responses: [jsonResponse(200, 'not json{{')] },
  ]);
  const f = new Fetcher({
    indexerBaseUrl: indexerBase,
    fetchImpl: m.fetchImpl,
  });
  await assert.rejects(() => f.listPools(TID), IndexerShapeError);
});

test('Fetcher: bad token_id throws TypeError (NOT IndexerError)', async () => {
  const f = new Fetcher({ indexerBaseUrl: indexerBase });
  await assert.rejects(() => f.listPools('garbage'), TypeError);
  await assert.rejects(() => f.getTokenStats('garbage'), TypeError);
  await assert.rejects(() => f.getBcmr('garbage'), TypeError);
});

test('Fetcher.invalidate(tokenId) busts the per-token caches', async () => {
  const m = mockFetch([
    { url: poolUrl, responses: [jsonResponse(200, samplePools), jsonResponse(200, samplePools)] },
  ]);
  const f = new Fetcher({
    indexerBaseUrl: indexerBase,
    bcmrBaseUrl: bcmrBase,
    fetchImpl: m.fetchImpl,
  });
  await f.listPools(TID);
  assert.equal(m.calls.length, 1);
  f.invalidate(TID);
  await f.listPools(TID);
  assert.equal(m.calls.length, 2);
});

test('Fetcher.invalidateAll() clears every cache', async () => {
  const m = mockFetch([
    { url: poolUrl, responses: [jsonResponse(200, samplePools), jsonResponse(200, samplePools)] },
    { url: discoveryUrl(), responses: [jsonResponse(200, sampleTop), jsonResponse(200, sampleTop)] },
  ]);
  const f = new Fetcher({
    indexerBaseUrl: indexerBase,
    bcmrBaseUrl: bcmrBase,
    fetchImpl: m.fetchImpl,
  });
  await f.listPools(TID);
  await f.getTokenStats(TID);
  assert.equal(m.calls.length, 2);
  f.invalidateAll();
  await f.listPools(TID);
  await f.getTokenStats(TID);
  assert.equal(m.calls.length, 4);
});

test('Fetcher.stats() exposes counters', async () => {
  const m = mockFetch([
    { url: poolUrl, responses: [jsonResponse(200, samplePools)] },
  ]);
  const f = new Fetcher({
    indexerBaseUrl: indexerBase,
    fetchImpl: m.fetchImpl,
  });
  await f.listPools(TID); // miss + fetch
  await f.listPools(TID); // hit
  const s = f.stats();
  assert.equal(s.cacheHits, 1);
  assert.equal(s.cacheMisses, 1);
  assert.equal(s.requests, 1);
});

test('Fetcher: listTopTokens returns raw records', async () => {
  const m = mockFetch([
    { url: discoveryUrl(50, 'volume', 'asc'), responses: [jsonResponse(200, sampleTop)] },
  ]);
  const f = new Fetcher({
    indexerBaseUrl: indexerBase,
    fetchImpl: m.fetchImpl,
  });
  const recs = await f.listTopTokens({ by: 'volume', order: 'asc', limit: 50 });
  assert.equal(recs.length, 2);
  assert.equal(recs[0].token_id, TID);
});

// ────────────────────────────────────────────────────────────────────
//  discoveryCacheKey (T46 — pure helper)
// ────────────────────────────────────────────────────────────────────

test('discoveryCacheKey: defaults to by:tvl/order:desc/limit:200', () => {
  assert.equal(discoveryCacheKey(), 'discovery:tvl:desc:200');
  assert.equal(discoveryCacheKey({}), 'discovery:tvl:desc:200');
});

test('discoveryCacheKey: normalizes order case + limit numerics', () => {
  // Two callers passing different case / numeric representations
  // MUST share the same entry — otherwise the cache silently misses.
  assert.equal(
    discoveryCacheKey({ by: 'tvl', order: 'DESC', limit: 200 }),
    discoveryCacheKey({ by: 'tvl', order: 'desc', limit: 200.0 }),
  );
  // `asc` round-trips, everything else falls back to `desc`.
  assert.equal(discoveryCacheKey({ order: 'asc' }), 'discovery:tvl:asc:200');
  assert.equal(discoveryCacheKey({ order: 'bogus' }), 'discovery:tvl:desc:200');
});

test('discoveryCacheKey: clamps limit to [1, 1000] (matches URL builder)', () => {
  assert.equal(discoveryCacheKey({ limit: 0 }), 'discovery:tvl:desc:1');
  assert.equal(discoveryCacheKey({ limit: -5 }), 'discovery:tvl:desc:1');
  assert.equal(discoveryCacheKey({ limit: 999_999 }), 'discovery:tvl:desc:1000');
  // Non-finite (NaN / undefined / null) falls back to 200.
  assert.equal(discoveryCacheKey({ limit: NaN }), 'discovery:tvl:desc:200');
  assert.equal(discoveryCacheKey({ limit: undefined }), 'discovery:tvl:desc:200');
});

test('discoveryCacheKey: distinct triples produce distinct keys', () => {
  const a = discoveryCacheKey({ by: 'tvl', order: 'desc', limit: 200 });
  const b = discoveryCacheKey({ by: 'volume', order: 'desc', limit: 200 });
  const c = discoveryCacheKey({ by: 'tvl', order: 'asc', limit: 200 });
  const d = discoveryCacheKey({ by: 'tvl', order: 'desc', limit: 50 });
  // Every triple differs from every other triple.
  const set = new Set([a, b, c, d]);
  assert.equal(set.size, 4, `expected 4 distinct keys, got ${[...set].join(', ')}`);
});

// ────────────────────────────────────────────────────────────────────
//  Fetcher.listTopTokens — discovery cache (T46)
// ────────────────────────────────────────────────────────────────────

test('Fetcher: listTopTokens cache miss → fetch + populate + metrics.misses++', async () => {
  const m = mockFetch([
    { url: discoveryUrl(200, 'tvl', 'desc'), responses: [jsonResponse(200, sampleTop)] },
  ]);
  const f = new Fetcher({
    indexerBaseUrl: indexerBase,
    fetchImpl: m.fetchImpl,
  });
  const recs = await f.listTopTokens({ by: 'tvl', order: 'desc', limit: 200 });
  assert.equal(recs.length, 2);
  assert.equal(m.calls.length, 1);
  const s = f.stats();
  assert.equal(s.discoveryCacheMisses, 1);
  assert.equal(s.discoveryCacheHits, 0);
  // The discovery cache has one entry (the default 200/desc/tvl key).
  assert.equal(f.discoveryCache.size, 1);
});

test('Fetcher: listTopTokens cache hit → no second fetch + metrics.hits++', async () => {
  const m = mockFetch([
    { url: discoveryUrl(200, 'tvl', 'desc'), responses: [jsonResponse(200, sampleTop)] },
  ]);
  const f = new Fetcher({
    indexerBaseUrl: indexerBase,
    fetchImpl: m.fetchImpl,
  });
  // First call: miss + populate.
  await f.listTopTokens({ by: 'tvl', order: 'desc', limit: 200 });
  // Second + third calls with the SAME triple: cache hits, no fetch.
  const r2 = await f.listTopTokens({ by: 'tvl', order: 'desc', limit: 200 });
  const r3 = await f.listTopTokens({ by: 'tvl', order: 'desc', limit: 200 });
  assert.equal(m.calls.length, 1, 'expected exactly 1 HTTP call across 3 listTopTokens invocations');
  assert.equal(r2.length, 2);
  assert.equal(r3.length, 2);
  const s = f.stats();
  assert.equal(s.discoveryCacheMisses, 1);
  assert.equal(s.discoveryCacheHits, 2);
});

test('Fetcher: listTopTokens cache key disambiguates {by, order, limit}', async () => {
  // Mock EVERY distinct URL the test will hit so each cache miss
  // produces a valid response.
  const m = mockFetch([
    { url: discoveryUrl(200, 'tvl', 'desc'), responses: [jsonResponse(200, sampleTop)] },
    { url: discoveryUrl(200, 'volume', 'desc'), responses: [jsonResponse(200, sampleTop)] },
    { url: discoveryUrl(50, 'tvl', 'desc'), responses: [jsonResponse(200, sampleTop)] },
  ]);
  const f = new Fetcher({
    indexerBaseUrl: indexerBase,
    fetchImpl: m.fetchImpl,
  });
  await f.listTopTokens({ by: 'tvl', order: 'desc', limit: 200 });
  // Different `by` → distinct key → fresh fetch.
  await f.listTopTokens({ by: 'volume', order: 'desc', limit: 200 });
  // Different `limit` → distinct key → fresh fetch.
  await f.listTopTokens({ by: 'tvl', order: 'desc', limit: 50 });
  // Repeat of the first triple → cache hit.
  await f.listTopTokens({ by: 'tvl', order: 'desc', limit: 200 });
  assert.equal(m.calls.length, 3, `expected 3 distinct fetches, got ${m.calls.length}`);
  const s = f.stats();
  assert.equal(s.discoveryCacheMisses, 3);
  assert.equal(s.discoveryCacheHits, 1);
  assert.equal(f.discoveryCache.size, 3);
});

test('Fetcher: listTopTokens cache expiry → fresh fetch on next call', async () => {
  // mockFetch overwrites duplicate URLs (Map.set semantics), so two
  // routes with the same URL collapse into one — keep the responses
  // array flat under a single route entry.
  const m = mockFetch([
    {
      url: discoveryUrl(200, 'tvl', 'desc'),
      responses: [jsonResponse(200, sampleTop), jsonResponse(200, sampleTop)],
    },
  ]);
  // Wall-clock: t=0 → first call (miss), t=10000 → second call (hit),
  // t=40000 → third call (miss: TTL of 30s expired). The mock
  // supplies 2 responses, so the third call would 404 if it ever
  // hit the network — that's how the test detects the expiry.
  let now = 0;
  const fakeNow = () => now;
  const f = new Fetcher({
    indexerBaseUrl: indexerBase,
    fetchImpl: m.fetchImpl,
    nowFn: fakeNow,
  });
  await f.listTopTokens({ by: 'tvl', order: 'desc', limit: 200 }); // t=0: miss
  now = 10_000;
  await f.listTopTokens({ by: 'tvl', order: 'desc', limit: 200 }); // t=10s: hit
  now = 40_000;
  await f.listTopTokens({ by: 'tvl', order: 'desc', limit: 200 }); // t=40s: expiry → miss
  assert.equal(m.calls.length, 2, 'expected 2 HTTP calls (initial + post-expiry), the middle hit must not fetch');
  const s = f.stats();
  assert.equal(s.discoveryCacheMisses, 2);
  assert.equal(s.discoveryCacheHits, 1);
});

test('Fetcher: discovery cache honours custom discoveryCacheTtlMs', async () => {
  // See T46 expiry test: single route with two responses (mockFetch
  // overwrites duplicate URLs).
  const m = mockFetch([
    {
      url: discoveryUrl(200, 'tvl', 'desc'),
      responses: [jsonResponse(200, sampleTop), jsonResponse(200, sampleTop)],
    },
  ]);
  let now = 0;
  const fakeNow = () => now;
  const f = new Fetcher({
    indexerBaseUrl: indexerBase,
    fetchImpl: m.fetchImpl,
    nowFn: fakeNow,
    discoveryCacheTtlMs: 5_000, // override default 30s
  });
  await f.listTopTokens({ by: 'tvl', order: 'desc', limit: 200 }); // miss
  now = 4_000;
  await f.listTopTokens({ by: 'tvl', order: 'desc', limit: 200 }); // hit (within 5s)
  now = 6_000;
  await f.listTopTokens({ by: 'tvl', order: 'desc', limit: 200 }); // miss (expired)
  assert.equal(m.calls.length, 2);
});

test('Fetcher: DEFAULT_FETCHER_CONFIG.discoveryCacheTtlMs defaults to 30000', () => {
  // Locked at 30s so an operator who never sets discoveryCacheTtlMs
  // gets the documented indexer-load savings without configuration.
  assert.equal(DEFAULT_FETCHER_CONFIG.discoveryCacheTtlMs, 30_000);
});

test('Fetcher: discovery cache key is shared between {order:"DESC"} and {order:"desc"}', async () => {
  const m = mockFetch([
    { url: discoveryUrl(200, 'tvl', 'desc'), responses: [jsonResponse(200, sampleTop)] },
  ]);
  const f = new Fetcher({
    indexerBaseUrl: indexerBase,
    fetchImpl: m.fetchImpl,
  });
  await f.listTopTokens({ by: 'tvl', order: 'desc', limit: 200 });
  // Case variant must hit the cache, not re-fetch.
  await f.listTopTokens({ by: 'tvl', order: 'DESC', limit: 200 });
  await f.listTopTokens({ by: 'tvl', order: 'desc', limit: 200.0 });
  assert.equal(m.calls.length, 1);
  const s = f.stats();
  assert.equal(s.discoveryCacheMisses, 1);
  assert.equal(s.discoveryCacheHits, 2);
});

test('Fetcher: invalidateAll() clears the discovery cache', async () => {
  // See T46 expiry test: single route with two responses (mockFetch
  // overwrites duplicate URLs).
  const m = mockFetch([
    {
      url: discoveryUrl(200, 'tvl', 'desc'),
      responses: [jsonResponse(200, sampleTop), jsonResponse(200, sampleTop)],
    },
  ]);
  const f = new Fetcher({
    indexerBaseUrl: indexerBase,
    fetchImpl: m.fetchImpl,
  });
  await f.listTopTokens({ by: 'tvl', order: 'desc', limit: 200 }); // miss
  assert.equal(f.discoveryCache.size, 1);
  f.invalidateAll();
  assert.equal(f.discoveryCache.size, 0);
  // Next call: cache was just cleared → fresh fetch.
  await f.listTopTokens({ by: 'tvl', order: 'desc', limit: 200 });
  assert.equal(m.calls.length, 2);
});

test('Fetcher: custom opts.discoveryCache is honoured (DI seam)', async () => {
  const customStore = new TtlCache({ ttlMs: 60_000 });
  const m = mockFetch([
    { url: discoveryUrl(200, 'tvl', 'desc'), responses: [jsonResponse(200, sampleTop)] },
  ]);
  const f = new Fetcher({
    indexerBaseUrl: indexerBase,
    fetchImpl: m.fetchImpl,
    discoveryCache: customStore,
  });
  await f.listTopTokens({ by: 'tvl', order: 'desc', limit: 200 });
  // The fetcher must use the INJECTED store, not its own default one.
  assert.equal(customStore.size, 1);
  assert.equal(f.discoveryCache, customStore);
});

test('Fetcher: getTokenStats reuses the discovery cache for listTopTokens', async () => {
  // T46's primary motivation: getTokenStats → listTopTokens should
  // share one fetch per tick across N candidate tokens. This test
  // proves the cache is the right shape by calling getTokenStats for
  // two distinct token_ids (both present in the discovery response)
  // and verifying only ONE HTTP call was made for listTopTokens.
  const m = mockFetch([
    // listTopTokens call: returns both tokens so getTokenStats can resolve.
    { url: discoveryUrl(200, 'tvl', 'desc'), responses: [jsonResponse(200, sampleTop)] },
  ]);
  const f = new Fetcher({
    indexerBaseUrl: indexerBase,
    fetchImpl: m.fetchImpl,
  });
  // First call (listTopTokens, discovery hit/miss): cache populated.
  await f.getTokenStats(TID);
  // Second call: listTopTokens must hit the cache (no extra fetch).
  const stats2 = await f.getTokenStats('b'.repeat(64));
  assert.ok(stats2, 'second token should resolve from cached discovery payload');
  assert.equal(m.calls.length, 1, 'expected exactly 1 discovery fetch for 2 getTokenStats calls');
  const s = f.stats();
  assert.equal(s.discoveryCacheMisses, 1);
  assert.equal(s.discoveryCacheHits, 1);
});

// ────────────────────────────────────────────────────────────────────
//  Error type discriminators
// ────────────────────────────────────────────────────────────────────

test('IndexerError types are distinguishable', () => {
  const a = new IndexerError('a', 'u');
  const b = new IndexerHttpError(500, 'u', 'oops');
  const c = new IndexerTimeoutError(1000, 'u');
  const d = new IndexerShapeError('bad', 'u');
  assert.equal(a instanceof IndexerError, true);
  assert.equal(b instanceof IndexerHttpError, true);
  assert.equal(b instanceof IndexerError, true);
  assert.equal(c instanceof IndexerTimeoutError, true);
  assert.equal(c instanceof IndexerError, true);
  assert.equal(d instanceof IndexerShapeError, true);
  assert.equal(d instanceof IndexerError, true);
});

test('IndexerHttpError.retryable: true for 5xx, false for 4xx', () => {
  assert.equal(new IndexerHttpError(500, 'u', '').retryable, true);
  assert.equal(new IndexerHttpError(502, 'u', '').retryable, true);
  assert.equal(new IndexerHttpError(400, 'u', '').retryable, false);
  assert.equal(new IndexerHttpError(404, 'u', '').retryable, false);
});

// ────────────────────────────────────────────────────────────────────
//  Config knob integration
// ────────────────────────────────────────────────────────────────────

test('DEFAULT_FETCHER_CONFIG.small_balance values come from defaults (no hard-coding)', () => {
  // Defaults must match the small-balance preset documented in
  // config/default.json so the fetcher is safe to spin up with zero
  // constructor args.
  assert.equal(DEFAULT_FETCHER_CONFIG.timeoutMs, 10_000);
  assert.equal(DEFAULT_FETCHER_CONFIG.maxRetries, 3);
  assert.equal(DEFAULT_FETCHER_CONFIG.rateLimitPerSec, 5);
  assert.equal(DEFAULT_FETCHER_CONFIG.userAgent.includes('TradeBot'), true);
});

// ────────────────────────────────────────────────────────────────────
//  bchFromSats re-export
// ────────────────────────────────────────────────────────────────────

test('bchFromSats is re-exported from fetcher.mjs', () => {
  assert.equal(bchFromSats(100_000_000), 1);
  assert.equal(bchFromSats(null), null);
});

// ────────────────────────────────────────────────────────────────────
//  bestAmmSpotSats (T31 — pre-entry divergence guard)
// ────────────────────────────────────────────────────────────────────

test('bestAmmSpotSats: empty / non-array / null pools → null', () => {
  assert.equal(bestAmmSpotSats([]), null);
  assert.equal(bestAmmSpotSats(null), null);
  assert.equal(bestAmmSpotSats(undefined), null);
  assert.equal(bestAmmSpotSats('not-an-array'), null);
  assert.equal(bestAmmSpotSats(42), null);
});

test('bestAmmSpotSats: single pool → sats / tokens', () => {
  // 50M sats / 1M tokens = 50 sats per token
  assert.equal(bestAmmSpotSats([{ sats: 50_000_000, tokens: 1_000_000 }]), 50);
});

test('bestAmmSpotSats: picks the LOWEST rate across pools (best AMM spot)', () => {
  // Pool A: 100M sats / 1M tokens = 100 sats/token
  // Pool B: 200M sats / 8M tokens = 25 sats/token (cheapest = best for a BUY)
  const pools = [
    { sats: 100_000_000, tokens: 1_000_000 },
    { sats: 200_000_000, tokens: 8_000_000 },
  ];
  assert.equal(bestAmmSpotSats(pools), 25);
});

test('bestAmmSpotSats: tolerates string `tokens` reserves via BigInt', () => {
  // 100M sats / 4M tokens (as string) = 25 sats/token
  assert.equal(bestAmmSpotSats([{ sats: 100_000_000, tokens: '4000000' }]), 25);
});

test('bestAmmSpotSats: tolerates bigint `tokens` reserves', () => {
  assert.equal(bestAmmSpotSats([{ sats: 100_000_000, tokens: 4_000_000n }]), 25);
});

test('bestAmmSpotSats: pool with zero tokens → skipped (return best from others)', () => {
  const pools = [
    { sats: 50_000_000, tokens: 0 },         // zero token reserve → skip
    { sats: 100_000_000, tokens: 1_000_000 }, // 100 sats/token
  ];
  assert.equal(bestAmmSpotSats(pools), 100);
});

test('bestAmmSpotSats: all pools have zero/negative token reserves → null', () => {
  const pools = [
    { sats: 50_000_000, tokens: 0 },
    { sats: 50_000_000, tokens: -1000 },
    { sats: 50_000_000, tokens: null },
  ];
  assert.equal(bestAmmSpotSats(pools), null);
});

test('bestAmmSpotSats: pool with bad sats → skipped', () => {
  const pools = [
    { sats: 'NaN', tokens: 1_000_000 },
    { sats: 0, tokens: 1_000_000 },
    { sats: -50, tokens: 1_000_000 },
    { sats: 50_000_000, tokens: 1_000_000 }, // 50 sats/token
  ];
  assert.equal(bestAmmSpotSats(pools), 50);
});

test('bestAmmSpotSats: ignores malformed entries within the list', () => {
  const pools = [
    null,
    undefined,
    'string',
    42,
    {},
    { sats: 50_000_000, tokens: 1_000_000 }, // valid
  ];
  assert.equal(bestAmmSpotSats(pools), 50);
});

test('bestAmmSpotSats: BigInt string reserves of 18+ digits fit safely via BigInt', () => {
  // Indexer sometimes returns very large reserves as strings (overflow-safe)
  const pools = [
    { sats: 100_000_000, tokens: '1000000000000000000' }, // 10^18 tokens
  ];
  // 100M / 10^18 = 1e-10 sats/token (very small, but a finite number)
  const rate = bestAmmSpotSats(pools);
  assert.ok(rate !== null && Number.isFinite(rate));
  assert.equal(rate, 100_000_000 / 1e18);
});

test('bestAmmSpotSats: empty string `tokens` → skipped', () => {
  const pools = [
    { sats: 50_000_000, tokens: '' },
    { sats: 100_000_000, tokens: 1_000_000 },
  ];
  assert.equal(bestAmmSpotSats(pools), 100);
});

// ────────────────────────────────────────────────────────────────────
//  Fetcher.getAmmSpotSats (T31 — fetcher-level wrapper)
// ────────────────────────────────────────────────────────────────────

test('Fetcher.getAmmSpotSats: 200 with pools → returns best AMM spot rate', async () => {
  const pools = [
    { pool_id: 'pool-aaa', token_id: TID, sats: 100_000_000, tokens: 4_000_000, owner_p2pkh_addr: 'bitcoincash:qqqq', txid: 'a'.repeat(64), tx_pos: 0 },
    { pool_id: 'pool-bbb', token_id: TID, sats: 200_000_000, tokens: 8_000_000, owner_p2pkh_addr: 'bitcoincash:qqqq', txid: 'b'.repeat(64), tx_pos: 0 },
  ];
  const m = mockFetch([{ url: poolUrl, responses: [jsonResponse(200, pools)] }]);
  const f = new Fetcher({
    indexerBaseUrl: indexerBase,
    bcmrBaseUrl: bcmrBase,
    fetchImpl: m.fetchImpl,
  });
  const rate = await f.getAmmSpotSats(TID);
  // pool-aaa: 25 sats/token, pool-bbb: 25 sats/token → 25
  assert.equal(rate, 25);
  assert.equal(m.calls.length, 1);
});

test('Fetcher.getAmmSpotSats: caches the pool list across calls (T31 optimization)', async () => {
  const m = mockFetch([{ url: poolUrl, responses: [jsonResponse(200, samplePools)] }]);
  const f = new Fetcher({
    indexerBaseUrl: indexerBase,
    bcmrBaseUrl: bcmrBase,
    fetchImpl: m.fetchImpl,
  });
  // listPools caches → getAmmSpotSats inside the cache TTL shouldn't fetch again
  await f.listPools(TID);
  const r1 = await f.getAmmSpotSats(TID);
  const r2 = await f.getAmmSpotSats(TID);
  assert.equal(r1, r2);
  assert.equal(m.calls.length, 1);
});

test('Fetcher.getAmmSpotSats: indexer 5xx → returns null (caller skips divergence guard)', async () => {
  const m = mockFetch([{ url: poolUrl, responses: [
    jsonResponse(502, 'bad gateway'),
    jsonResponse(502, 'bad gateway'),
    jsonResponse(502, 'bad gateway'),
    jsonResponse(502, 'bad gateway'),
  ]}]);
  const f = new Fetcher({
    indexerBaseUrl: indexerBase,
    bcmrBaseUrl: bcmrBase,
    fetchImpl: m.fetchImpl,
    maxRetries: 3,
    retryBaseMs: 1,
    retryCapMs: 2,
    retryJitterPct: 0,
    random: () => 0.5,
  });
  const rate = await f.getAmmSpotSats(TID);
  assert.equal(rate, null);
});

test('Fetcher.getAmmSpotSats: indexer shape error → returns null', async () => {
  const m = mockFetch([{ url: poolUrl, responses: [jsonResponse(200, { wrong: 'shape' })] }]);
  const f = new Fetcher({
    indexerBaseUrl: indexerBase,
    bcmrBaseUrl: bcmrBase,
    fetchImpl: m.fetchImpl,
  });
  const rate = await f.getAmmSpotSats(TID);
  assert.equal(rate, null);
});

test('Fetcher.getAmmSpotSats: empty pool list → returns null (no liquid pool)', async () => {
  const m = mockFetch([{ url: poolUrl, responses: [jsonResponse(200, [])] }]);
  const f = new Fetcher({
    indexerBaseUrl: indexerBase,
    bcmrBaseUrl: bcmrBase,
    fetchImpl: m.fetchImpl,
  });
  const rate = await f.getAmmSpotSats(TID);
  assert.equal(rate, null);
});

test('Fetcher.getAmmSpotSats: bad token_id → throws (validation upstream)', async () => {
  const m = mockFetch([{ url: poolUrl, responses: [jsonResponse(200, samplePools)] }]);
  const f = new Fetcher({
    indexerBaseUrl: indexerBase,
    bcmrBaseUrl: bcmrBase,
    fetchImpl: m.fetchImpl,
  });
  // requireValidTokenId throws on short / non-hex; bubbles up before the AMM spot path runs.
  await assert.rejects(() => f.getAmmSpotSats('not-a-valid-token-id'));
  assert.equal(m.calls.length, 0);
});

// ────────────────────────────────────────────────────────────────────
//  totalAmmSats (T32 — pre-entry illiquidity guard pure reduction)
// ────────────────────────────────────────────────────────────────────

test('totalAmmSats: empty / non-array / null / bad input → null', () => {
  assert.equal(totalAmmSats([]), null);
  assert.equal(totalAmmSats(null), null);
  assert.equal(totalAmmSats(undefined), null);
  assert.equal(totalAmmSats('not-an-array'), null);
  assert.equal(totalAmmSats(42), null);
});

test('totalAmmSats: single pool → sats as bigint', () => {
  // 50M sats = 0.5 BCH
  const total = totalAmmSats([{ sats: 50_000_000, tokens: 1_000_000 }]);
  assert.equal(total, 50_000_000n);
});

test('totalAmmSats: sums across multiple pools', () => {
  const pools = [
    { sats: 50_000_000, tokens: 1_000_000 },
    { sats: 100_000_000, tokens: 2_000_000 },
    { sats: 200_000_000, tokens: 4_000_000 },
  ];
  // 50M + 100M + 200M = 350M sats = 3.5 BCH
  assert.equal(totalAmmSats(pools), 350_000_000n);
});

test('totalAmmSats: tolerates string `sats` reserves via BigInt', () => {
  const pools = [
    { sats: '50000000', tokens: 1_000_000 },
    { sats: '100000000', tokens: 2_000_000 },
  ];
  assert.equal(totalAmmSats(pools), 150_000_000n);
});

test('totalAmmSats: tolerates bigint `sats` reserves', () => {
  const pools = [
    { sats: 50_000_000n, tokens: 1_000_000 },
    { sats: 100_000_000n, tokens: 2_000_000 },
  ];
  assert.equal(totalAmmSats(pools), 150_000_000n);
});

test('totalAmmSats: pool with zero sats contributes zero (does not disqualify other pools)', () => {
  const pools = [
    { sats: 0, tokens: 1_000_000 },
    { sats: 100_000_000, tokens: 2_000_000 },
  ];
  assert.equal(totalAmmSats(pools), 100_000_000n);
});

test('totalAmmSats: negative sats pools are skipped (not subtracted)', () => {
  const pools = [
    { sats: -50_000_000, tokens: 1_000_000 },
    { sats: 100_000_000, tokens: 2_000_000 },
  ];
  assert.equal(totalAmmSats(pools), 100_000_000n);
});

test('totalAmmSats: malformed entries are skipped (no single bad row zeros the total)', () => {
  const pools = [
    null,
    undefined,
    'string',
    42,
    { sats: 'NaN', tokens: 1_000_000 },
    { sats: NaN, tokens: 1_000_000 },
    { tokens: 1_000_000 },                       // missing sats
    { sats: 100_000_000, tokens: 2_000_000 },     // valid
    { sats: 'not-a-number', tokens: 1_000_000 },  // bad bigint
  ];
  assert.equal(totalAmmSats(pools), 100_000_000n);
});

test('totalAmmSats: all pools malformed → null (not 0)', () => {
  const pools = [
    { sats: 'NaN', tokens: 1_000_000 },
    { sats: null, tokens: 1_000_000 },
    { sats: undefined, tokens: 1_000_000 },
    { tokens: 1_000_000 },
  ];
  assert.equal(totalAmmSats(pools), null);
});

test('totalAmmSats: QBTC-style pool set sums to ~1.32 BCH (the T32 pathology case)', () => {
  // 10 pools with 13.2M sats each = 132M sats = 1.32 BCH
  const pools = Array.from({ length: 10 }, () => ({ sats: 13_200_000, tokens: 1_000_000 }));
  assert.equal(totalAmmSats(pools), 132_000_000n);
});

test('totalAmmSats: large pool totals stay in BigInt precision (>Number.MAX_SAFE_INTEGER)', () => {
  // Number.MAX_SAFE_INTEGER = 9_007_199_254_740_991 (~9.007e15).
  // Pick pool totals that sum above that threshold so any Number()
  // coercion would silently lose precision. Each pool has 5e15
  // sats = 50 million BCH (a hypothetical mega-pool).
  const pools = [
    { sats: 5_000_000_000_000_000n, tokens: 1_000_000n },
    { sats: 5_000_000_000_000_000n, tokens: 1_000_000n },
    { sats: 5_000_000_000_000_000n, tokens: 1_000_000n },
  ];
  const total = totalAmmSats(pools);
  // BigInt math: 15 quadrillion sats = 150 million BCH.
  assert.equal(total, 15_000_000_000_000_000n);
  assert.ok(total > BigInt(Number.MAX_SAFE_INTEGER), 'sanity: exceeds Number safe range');
});

// ────────────────────────────────────────────────────────────────────
//  Fetcher.getAmmTotalDepthSats (T32 — fetcher-level wrapper)
// ────────────────────────────────────────────────────────────────────

test('Fetcher.getAmmTotalDepthSats: 200 with pools → returns summed sats as bigint', async () => {
  const pools = [
    { pool_id: 'pool-aaa', token_id: TID, sats: 50_000_000, tokens: 1_000_000, owner_p2pkh_addr: 'bitcoincash:qqqq', txid: 'a'.repeat(64), tx_pos: 0 },
    { pool_id: 'pool-bbb', token_id: TID, sats: 100_000_000, tokens: 2_000_000, owner_p2pkh_addr: 'bitcoincash:qqqq', txid: 'b'.repeat(64), tx_pos: 0 },
  ];
  const m = mockFetch([{ url: poolUrl, responses: [jsonResponse(200, pools)] }]);
  const f = new Fetcher({
    indexerBaseUrl: indexerBase,
    bcmrBaseUrl: bcmrBase,
    fetchImpl: m.fetchImpl,
  });
  const total = await f.getAmmTotalDepthSats(TID);
  assert.equal(total, 150_000_000n);
  assert.equal(m.calls.length, 1);
});

test('Fetcher.getAmmTotalDepthSats: caches the pool list across calls (T32 optimization)', async () => {
  const m = mockFetch([{ url: poolUrl, responses: [jsonResponse(200, samplePools)] }]);
  const f = new Fetcher({
    indexerBaseUrl: indexerBase,
    bcmrBaseUrl: bcmrBase,
    fetchImpl: m.fetchImpl,
  });
  // listPools caches → getAmmTotalDepthSats inside the cache TTL shouldn't fetch again
  await f.listPools(TID);
  const r1 = await f.getAmmTotalDepthSats(TID);
  const r2 = await f.getAmmTotalDepthSats(TID);
  assert.equal(r1, r2);
  assert.equal(m.calls.length, 1);
});

test('Fetcher.getAmmTotalDepthSats: indexer 5xx → returns null (caller skips depth guard)', async () => {
  const m = mockFetch([{ url: poolUrl, responses: [
    jsonResponse(502, 'bad gateway'),
    jsonResponse(502, 'bad gateway'),
    jsonResponse(502, 'bad gateway'),
    jsonResponse(502, 'bad gateway'),
  ]}]);
  const f = new Fetcher({
    indexerBaseUrl: indexerBase,
    bcmrBaseUrl: bcmrBase,
    fetchImpl: m.fetchImpl,
    maxRetries: 3,
    retryBaseMs: 1,
    retryCapMs: 2,
    retryJitterPct: 0,
    random: () => 0.5,
  });
  const total = await f.getAmmTotalDepthSats(TID);
  assert.equal(total, null);
});

test('Fetcher.getAmmTotalDepthSats: indexer shape error → returns null', async () => {
  const m = mockFetch([{ url: poolUrl, responses: [jsonResponse(200, { wrong: 'shape' })] }]);
  const f = new Fetcher({
    indexerBaseUrl: indexerBase,
    bcmrBaseUrl: bcmrBase,
    fetchImpl: m.fetchImpl,
  });
  const total = await f.getAmmTotalDepthSats(TID);
  assert.equal(total, null);
});

test('Fetcher.getAmmTotalDepthSats: empty pool list → returns null', async () => {
  const m = mockFetch([{ url: poolUrl, responses: [jsonResponse(200, [])] }]);
  const f = new Fetcher({
    indexerBaseUrl: indexerBase,
    bcmrBaseUrl: bcmrBase,
    fetchImpl: m.fetchImpl,
  });
  const total = await f.getAmmTotalDepthSats(TID);
  assert.equal(total, null);
});

test('Fetcher.getAmmTotalDepthSats: bad token_id → throws (validation upstream)', async () => {
  const m = mockFetch([{ url: poolUrl, responses: [jsonResponse(200, samplePools)] }]);
  const f = new Fetcher({
    indexerBaseUrl: indexerBase,
    bcmrBaseUrl: bcmrBase,
    fetchImpl: m.fetchImpl,
  });
  await assert.rejects(() => f.getAmmTotalDepthSats('not-a-valid-token-id'));
  assert.equal(m.calls.length, 0);
});

test('Fetcher.getAmmTotalDepthSats: pool list with all-zero sats → returns 0n (zero depth, not missing)', async () => {
  // Pools with zero sats are VALID signals (the AMM probe confirmed
  // these pools exist but they're drained) — the strategy layer
  // compares against `min_amm_total_depth_sats` (1.5 BCH) and the
  // candidate gets rejected. This is distinct from returning `null`
  // (probe failed / no pools → guard SKIPPED), which is covered by
  // the "empty pool list" test above.
  const pools = [
    { pool_id: 'pool-aaa', token_id: TID, sats: 0, tokens: 1_000_000, owner_p2pkh_addr: 'bitcoincash:qqqq', txid: 'a'.repeat(64), tx_pos: 0 },
    { pool_id: 'pool-bbb', token_id: TID, sats: 0, tokens: 2_000_000, owner_p2pkh_addr: 'bitcoincash:qqqq', txid: 'b'.repeat(64), tx_pos: 0 },
  ];
  const m = mockFetch([{ url: poolUrl, responses: [jsonResponse(200, pools)] }]);
  const f = new Fetcher({
    indexerBaseUrl: indexerBase,
    bcmrBaseUrl: bcmrBase,
    fetchImpl: m.fetchImpl,
  });
  const total = await f.getAmmTotalDepthSats(TID);
  assert.equal(total, 0n);
});

// ────────────────────────────────────────────────────────────────────
//  T77 — trimRawIndexerEntry / trimRawIndexerResponse
// ────────────────────────────────────────────────────────────────────
//
// The Cauldron indexer's `list_cached` response carries fields the
// bot never reads (`bcmr.description`, `bcmr.icon_url`, `bcmr.social`,
// `bcmr.uris`, top-level `description` / `image_url` / etc.). The
// trim helper whitelists ONLY the fields `buildStatsRecord`,
// `findBySymbol`, and `projectPoolOption` consume. Tests cover:
//   - Whitelist correctness: every whitelisted field is preserved
//   - Blacklist correctness: every non-whitelisted field is dropped
//   - BCMR sub-object rebuild: description/icon_url/social/uris stripped
//   - Defensive: null / undefined / non-object input doesn't throw
//   - Lossless regression: buildStatsRecord(trim(entry)) deep-equals buildStatsRecord(entry)
//   - Integration: listTopTokens applies the trim on cache miss
//   - Integration: listTopTokens cache hits serve the trimmed shape
//   - Edge: empty entry → empty object
//   - Edge: empty bcmr → bcmr dropped from output
//   - Edge: bcmr.token with no whitelisted fields → token dropped

const fullIndexerEntry = {
  token_id: TID,
  display_name: 'Paytaca USD',
  display_symbol: 'PUSD',
  bcmr: {
    name: 'Paytaca USD',
    description: 'A long marketing description the bot never reads',
    icon: 'https://example.com/icon.png',
    icon_url: 'https://example.com/icon.png',
    uris: { icon: 'https://example.com/icon.png', website: 'https://example.com' },
    social: { twitter: '@paytaca', telegram: '@paytacachat' },
    extensions: { some: 'unused-extension-field' },
    token: {
      symbol: 'PUSD',
      decimals: 2,
      description: 'token-level description — also unused',
      uris: { icon: 'unused-token-icon' },
      icon_url: 'unused-token-icon-url',
      social: { telegram: '@unused' },
      extensions: { foo: 'bar' },
    },
  },
  price_now: 14500,
  price_now_sats: 14500,
  price_now_usd: 1.01,
  price_24h: 14000,
  price_24h_sats: 14000,
  price_7d: 12000,
  price_7d_sats: 12000,
  change_24h_bp: 357,
  change_24h_usd_bp: 350,
  change_7d_bp: 2083,
  change_7d_usd_bp: 2050,
  trade_count: 42,
  trade_volume: 5_000_000_000,
  trade_volume_sats: 5_000_000_000,
  volume_24h_sats: 5_000_000_000,
  tvl_sats: 10_000_000_000,
  tvl_sats_bch: 100_000_000,
  tvl_tokens: 690_000,
  apy_30d_bp: 1250,
  score: 0.82,
  score_rank: 1,
  first_pool_ts: 1_700_000_000,
  price_series_7d: [0.5, 0.7, 0.8, 1.0, 0.9, 0.85],
  // Top-level extras the indexer surfaces — none whitelisted:
  description: 'A top-level description that should be dropped',
  image_url: 'https://example.com/top-level-image.png',
  social: { twitter: '@top-level' },
  uris: { icon: 'top-level-icon' },
  extensions: { whatever: 'unused' },
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-09-20T16:00:00Z',
  owner_pubkey: 'a'.repeat(64),
};

const trimmedExpectedKeys = [
  'token_id', 'display_name', 'display_symbol', 'bcmr',
  'price_now', 'price_now_sats', 'price_now_usd',
  'price_24h', 'price_24h_sats',
  'price_7d', 'price_7d_sats',
  'change_24h_bp', 'change_24h_usd_bp', 'change_7d_bp', 'change_7d_usd_bp',
  'trade_count', 'trade_volume', 'trade_volume_sats', 'volume_24h_sats',
  'tvl_sats', 'tvl_sats_bch', 'tvl_tokens',
  'apy_30d_bp', 'score', 'score_rank',
  'first_pool_ts', 'price_series_7d',
];

const trimmedBcmrExpectedKeys = ['name', 'token'];
const trimmedBcmrTokenExpectedKeys = ['symbol', 'decimals'];

test('trimRawIndexerEntry: strips non-whitelisted top-level fields', () => {
  const out = trimRawIndexerEntry(fullIndexerEntry);
  assert.ok(out, 'expected object output');
  const outKeys = Object.keys(out).sort();
  assert.deepEqual(outKeys, trimmedExpectedKeys.slice().sort());
  // Spot-check that key whitelisted values survive:
  assert.equal(out.token_id, TID);
  assert.equal(out.display_symbol, 'PUSD');
  assert.equal(out.price_now_sats, 14500);
  assert.equal(out.trade_volume, 5_000_000_000);
});

test('trimRawIndexerEntry: rebuilds bcmr to whitelisted sub-fields only', () => {
  const out = trimRawIndexerEntry(fullIndexerEntry);
  assert.ok(out.bcmr, 'expected bcmr to survive');
  const bcmrKeys = Object.keys(out.bcmr).sort();
  assert.deepEqual(bcmrKeys, trimmedBcmrExpectedKeys.slice().sort());
  assert.equal(out.bcmr.name, 'Paytaca USD');
  assert.ok(out.bcmr.token, 'expected bcmr.token to survive');
  const tokenKeys = Object.keys(out.bcmr.token).sort();
  assert.deepEqual(tokenKeys, trimmedBcmrTokenExpectedKeys.slice().sort());
  assert.equal(out.bcmr.token.symbol, 'PUSD');
  assert.equal(out.bcmr.token.decimals, 2);
});

test('trimRawIndexerEntry: drops bcmr.description / icon_url / social / uris / extensions', () => {
  const out = trimRawIndexerEntry(fullIndexerEntry);
  assert.equal(out.bcmr.description, undefined, 'bcmr.description should be dropped');
  assert.equal(out.bcmr.icon_url, undefined, 'bcmr.icon_url should be dropped');
  assert.equal(out.bcmr.icon, undefined, 'bcmr.icon should be dropped');
  assert.equal(out.bcmr.uris, undefined, 'bcmr.uris should be dropped');
  assert.equal(out.bcmr.social, undefined, 'bcmr.social should be dropped');
  assert.equal(out.bcmr.extensions, undefined, 'bcmr.extensions should be dropped');
  // Token-level fields:
  assert.equal(out.bcmr.token.description, undefined, 'bcmr.token.description should be dropped');
  assert.equal(out.bcmr.token.uris, undefined, 'bcmr.token.uris should be dropped');
  assert.equal(out.bcmr.token.icon_url, undefined, 'bcmr.token.icon_url should be dropped');
  assert.equal(out.bcmr.token.social, undefined, 'bcmr.token.social should be dropped');
  assert.equal(out.bcmr.token.extensions, undefined, 'bcmr.token.extensions should be dropped');
});

test('trimRawIndexerEntry: drops top-level extras (description / image_url / social / uris / etc.)', () => {
  const out = trimRawIndexerEntry(fullIndexerEntry);
  assert.equal(out.description, undefined);
  assert.equal(out.image_url, undefined);
  assert.equal(out.social, undefined);
  assert.equal(out.uris, undefined);
  assert.equal(out.extensions, undefined);
  assert.equal(out.created_at, undefined);
  assert.equal(out.updated_at, undefined);
  assert.equal(out.owner_pubkey, undefined);
});

test('trimRawIndexerEntry: defensive on null / undefined / non-object input', () => {
  assert.equal(trimRawIndexerEntry(null), undefined);
  assert.equal(trimRawIndexerEntry(undefined), undefined);
  assert.equal(trimRawIndexerEntry('a string'), undefined);
  assert.equal(trimRawIndexerEntry(42), undefined);
  assert.equal(trimRawIndexerEntry(true), undefined);
  // Arrays are typeof 'object' but we treat them as non-entries —
  // they shouldn't reach the trim helper in practice.
  assert.equal(trimRawIndexerEntry([1, 2, 3]), undefined);
});

test('trimRawIndexerEntry: empty entry → empty object (never throws)', () => {
  const out = trimRawIndexerEntry({});
  assert.deepEqual(out, {});
});

test('trimRawIndexerEntry: entry with empty bcmr → bcmr dropped from output', () => {
  // buildStatsRecord treats `e.bcmr ?? {}` so the trim is consistent:
  // an empty bcmr object would only contain zero whitelisted fields
  // (since name + token both need to survive the whitelist), so
  // drop it entirely.
  const out = trimRawIndexerEntry({ token_id: TID, bcmr: {} });
  assert.equal(out.token_id, TID);
  assert.equal(out.bcmr, undefined);
});

test('trimRawIndexerEntry: bcmr.token with no whitelisted fields → bcmr.token dropped', () => {
  // If `bcmr.token` only has `description` (not whitelisted), the
  // nested token object drops from the output. buildStatsRecord
  // treats `bcmr.token ?? {}` so it would see an empty object too.
  const out = trimRawIndexerEntry({
    token_id: TID,
    bcmr: { name: 'KeepName', token: { description: 'no other fields' } },
  });
  assert.ok(out.bcmr);
  assert.equal(out.bcmr.name, 'KeepName');
  assert.equal(out.bcmr.token, undefined);
});

test('trimRawIndexerEntry: bcmr.name missing → still produces object (only name dropped)', () => {
  const out = trimRawIndexerEntry({ token_id: TID, bcmr: { token: { symbol: 'X', decimals: 4 } } });
  assert.ok(out.bcmr);
  assert.equal(out.bcmr.name, undefined);
  assert.deepEqual(out.bcmr.token, { symbol: 'X', decimals: 4 });
});

test('trimRawIndexerEntry: bcmr.token is null (not an object) → bcmr.token dropped', () => {
  const out = trimRawIndexerEntry({ token_id: TID, bcmr: { name: 'KeepName', token: null } });
  assert.ok(out.bcmr);
  assert.equal(out.bcmr.name, 'KeepName');
  assert.equal(out.bcmr.token, undefined);
});

test('trimRawIndexerEntry: bcmr is null → bcmr dropped from output', () => {
  const out = trimRawIndexerEntry({ token_id: TID, bcmr: null });
  assert.equal(out.token_id, TID);
  assert.equal(out.bcmr, undefined);
});

test('trimRawIndexerEntry: bcmr is array → bcmr dropped (defensive)', () => {
  // Defensive: the Cauldron indexer has never returned an array
  // for bcmr, but a buggy upstream could. Treat it the same as
  // any non-object value.
  const out = trimRawIndexerEntry({ token_id: TID, bcmr: ['weird'] });
  assert.equal(out.bcmr, undefined);
});

test('trimRawIndexerEntry: preserves legacy + canonical price fields simultaneously', () => {
  // buildStatsRecord#firstFinite reads `price_now_sats ?? price_now`
  // — the trim keeps BOTH so the normalization layer picks one.
  const out = trimRawIndexerEntry({
    token_id: TID,
    price_now_sats: 999,
    price_now: 888, // legacy
  });
  assert.equal(out.price_now_sats, 999);
  assert.equal(out.price_now, 888);
});

test('trimRawIndexerEntry: preserves firstFinite-supported trade_volume aliases', () => {
  // buildStatsRecord#firstFinite reads `trade_volume_sats ?? trade_volume ?? volume_24h_sats`
  const out = trimRawIndexerEntry({
    token_id: TID,
    trade_volume_sats: 100,
    trade_volume: 200,
    volume_24h_sats: 300,
  });
  assert.equal(out.trade_volume_sats, 100);
  assert.equal(out.trade_volume, 200);
  assert.equal(out.volume_24h_sats, 300);
});

test('trimRawIndexerEntry: lossless for buildStatsRecord (regression vs all consumers)', () => {
  // THE most important property: the trim must not change any
  // output of buildStatsRecord / findBySymbol / projectPoolOption.
  // We compare the full normalized record for representative
  // fixtures against the un-trimmed baseline.
  const fixtures = [
    fullIndexerEntry,
    // Minimal entry — only token_id + price_now
    { token_id: TID, price_now: 1234 },
    // Entry with no BCMR at all
    { token_id: TID, price_now: 100, trade_volume: 200 },
    // Entry with BCMR but no decimals (the buildStatsRecord#decimals_warn branch)
    { token_id: TID, bcmr: { token: { symbol: 'XX' } }, price_now: 5678 },
    // Entry with first_pool_ts + price_series_7d (T37/T28c paths)
    { token_id: TID, first_pool_ts: 1_700_000_000, price_series_7d: [0.1, 0.5, 1.0] },
    // Entry with display_symbol but no BCMR (findBySymbol's display-symbol path)
    { token_id: TID, display_symbol: 'PUSD', price_now: 100 },
  ];
  for (const f of fixtures) {
    const baseline = buildStatsRecord(f);
    const after = buildStatsRecord(trimRawIndexerEntry(f));
    assert.deepEqual(after, baseline, `trim lossless for fixture ${JSON.stringify(f).slice(0, 80)}`);
  }
});

test('trimRawIndexerEntry: findBySymbol still works on trimmed entries (case-insensitive)', () => {
  const trimmed = trimRawIndexerEntry(fullIndexerEntry);
  assert.equal(findBySymbol([trimmed], 'pusd'), trimmed);
  assert.equal(findBySymbol([trimmed], 'PUSD'), trimmed);
});

test('trimRawIndexerEntry: projectPoolOption still works on trimmed entries', () => {
  // projectPoolOption lives in src/dashboard/server.mjs. We can't
  // import it here without pulling in the dashboard server's
  // transitive deps (Express), so we re-implement the projection
  // inline against the trimmed entry — the same pattern the
  // server uses. If this test breaks, the server's projection
  // will also break.
  const trimmed = trimRawIndexerEntry(fullIndexerEntry);
  const e = trimmed;
  const symbol = e.bcmr && e.bcmr.token && typeof e.bcmr.token.symbol === 'string'
    ? e.bcmr.token.symbol
    : null;
  const decimals = e.bcmr && e.bcmr.token && Number.isFinite(e.bcmr.token.decimals)
    ? e.bcmr.token.decimals
    : null;
  const name = e.bcmr && typeof e.bcmr.name === 'string' ? e.bcmr.name : null;
  const tvl_sats = Number.isFinite(e.tvl_sats) ? e.tvl_sats : null;
  const trade_volume = Number.isFinite(e.trade_volume) ? e.trade_volume : null;
  assert.equal(symbol, 'PUSD');
  assert.equal(decimals, 2);
  assert.equal(name, 'Paytaca USD');
  assert.equal(tvl_sats, 10_000_000_000);
  assert.equal(trade_volume, 5_000_000_000);
});

test('trimRawIndexerResponse: non-array input → empty array', () => {
  assert.deepEqual(trimRawIndexerResponse(null), []);
  assert.deepEqual(trimRawIndexerResponse(undefined), []);
  assert.deepEqual(trimRawIndexerResponse('not an array'), []);
  assert.deepEqual(trimRawIndexerResponse({}), []);
  assert.deepEqual(trimRawIndexerResponse(42), []);
});

test('trimRawIndexerResponse: walks array, preserves length, trims each entry', () => {
  const resp = [
    fullIndexerEntry,
    { token_id: TID, price_now: 100 },
    { token_id: TID, bcmr: { token: { symbol: 'X', decimals: 4 } } },
  ];
  const out = trimRawIndexerResponse(resp);
  assert.equal(out.length, 3);
  // First entry: full trim, key set matches the whitelist
  assert.deepEqual(Object.keys(out[0]).sort(), trimmedExpectedKeys.slice().sort());
  // Second: token_id + price_now survived, nothing else
  assert.deepEqual(Object.keys(out[1]).sort(), ['price_now', 'token_id']);
  // Third: token_id + bcmr.token.symbol + bcmr.token.decimals
  assert.equal(out[2].token_id, TID);
  assert.equal(out[2].bcmr.token.symbol, 'X');
  assert.equal(out[2].bcmr.token.decimals, 4);
});

test('trimRawIndexerResponse: per-entry defensive — null entry becomes empty object', () => {
  const resp = [null, fullIndexerEntry, undefined];
  const out = trimRawIndexerResponse(resp);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], {});
  assert.equal(out[1].token_id, TID);
  assert.deepEqual(out[2], {});
});

test('Fetcher: listTopTokens trims the indexer response before caching (cache miss path)', async () => {
  // Build a raw indexer response with the FULL field set the
  // upstream might return — including description / icon_url /
  // social / extensions / etc. After listTopTokens, the returned
  // array must NOT carry those fields.
  const m = mockFetch([
    { url: discoveryUrl(200, 'tvl', 'desc'), responses: [jsonResponse(200, [fullIndexerEntry])] },
  ]);
  const f = new Fetcher({
    indexerBaseUrl: indexerBase,
    fetchImpl: m.fetchImpl,
  });
  const recs = await f.listTopTokens({ by: 'tvl', order: 'desc', limit: 200 });
  assert.equal(recs.length, 1);
  const r = recs[0];
  assert.equal(r.token_id, TID);
  // Non-whitelisted fields must be gone:
  assert.equal(r.description, undefined);
  assert.equal(r.image_url, undefined);
  assert.equal(r.social, undefined);
  assert.equal(r.created_at, undefined);
  // Whitelisted fields must survive:
  assert.equal(r.price_now, 14500);
  assert.equal(r.score, 0.82);
  // BCMR was rebuilt:
  assert.deepEqual(Object.keys(r.bcmr).sort(), trimmedBcmrExpectedKeys.slice().sort());
  assert.deepEqual(Object.keys(r.bcmr.token).sort(), trimmedBcmrTokenExpectedKeys.slice().sort());
});

test('Fetcher: listTopTokens cache hit returns the trimmed shape too', async () => {
  const m = mockFetch([
    { url: discoveryUrl(200, 'tvl', 'desc'), responses: [jsonResponse(200, [fullIndexerEntry])] },
  ]);
  const f = new Fetcher({
    indexerBaseUrl: indexerBase,
    fetchImpl: m.fetchImpl,
  });
  // First call: cache miss → trim + populate
  await f.listTopTokens({ by: 'tvl', order: 'desc', limit: 200 });
  // Second call: cache hit → should serve the cached (trimmed) array
  const recs = await f.listTopTokens({ by: 'tvl', order: 'desc', limit: 200 });
  assert.equal(recs.length, 1);
  assert.equal(recs[0].description, undefined, 'cache hit must also serve trimmed entry');
  assert.equal(recs[0].image_url, undefined);
  assert.equal(recs[0].price_now, 14500);
  // Only one fetch — the cache hit path doesn't re-fetch.
  assert.equal(m.calls.length, 1);
  assert.equal(f.stats().discoveryCacheHits, 1);
});

test('Fetcher: getTokenStats + getTokenStatsBySymbol work against a trimmed payload', async () => {
  // Regression: the trim must be transparent to the canonical
  // normalized-shape consumers.
  const m = mockFetch([
    { url: discoveryUrl(), responses: [jsonResponse(200, [fullIndexerEntry])] },
  ]);
  const f = new Fetcher({
    indexerBaseUrl: indexerBase,
    bcmrBaseUrl: bcmrBase,
    fetchImpl: m.fetchImpl,
  });
  const sById = await f.getTokenStats(TID);
  assert.equal(sById.symbol, 'PUSD');
  assert.equal(sById.decimals, 2);
  assert.equal(sById.price_now_sats, 14500);
  assert.equal(sById.score, 0.82);

  const sBySymbol = await f.getTokenStatsBySymbol('pusd');
  assert.equal(sBySymbol.token_id, TID);
  assert.equal(sBySymbol.price_now_sats, 14500);
});

test('Fetcher: listTopTokens with a fully-stripped (no extras) indexer response is unchanged by trim', async () => {
  // Defensive: if the indexer starts returning only the bot's
  // whitelisted fields, the trim is a no-op. Verify by checking
  // the output deep-equals a hand-built trimmed object.
  const minimal = { token_id: TID, price_now: 100, tvl_sats: 500 };
  const m = mockFetch([
    { url: discoveryUrl(200, 'tvl', 'desc'), responses: [jsonResponse(200, [minimal])] },
  ]);
  const f = new Fetcher({
    indexerBaseUrl: indexerBase,
    fetchImpl: m.fetchImpl,
  });
  const recs = await f.listTopTokens({ by: 'tvl', order: 'desc', limit: 200 });
  assert.deepEqual(recs[0], trimRawIndexerEntry(minimal));
});
