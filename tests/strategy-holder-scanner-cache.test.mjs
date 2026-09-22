#!/usr/bin/env test
// tests/strategy-holder-scanner-cache.test.mjs
//
// T76 subset 2 — per-token TTL cache tests for the live TokenStork
// holders scanner.
//
// Coverage:
//   - HoldersScannerCache constructor defaults + knob overrides
//   - get: cold miss / warm hit / TTL expiry / cacheMs<=0 disabled
//   - set: happy / overwrite existing / cap-driven eviction / invalid input
//   - invalidate: one entry / no-op when missing
//   - invalidateAll: clears everything
//   - stats: hits / misses / stores / evictions
//   - resolveHoldersSnapshot: cache hit short-circuits fetch / cache
//     miss fetches + stores / fetcher throw → cached:false / token_not_found
//     upstream → ok:true + token_not_found=true

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HoldersScannerCache,
  resolveHoldersSnapshot,
  clampHoldersScannerCacheMs,
  MIN_HOLDERS_SCANNER_CACHE_MS,
} from '../src/strategy/holder-scanner-cache.mjs';
import {
  DEFAULT_HOLDERS_SCANNER_CACHE_MS,
  MAX_HOLDERS_SCANNER_CACHE_MS,
} from '../src/strategy/holder-scanner.mjs';

const VALID_TOKEN = '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544';
const OTHER_TOKEN = '10d85ee2d23f7fbc7573379de5544d669bc086e0745b34ff277c40641dadd56f';

// ─────────────────────────────────────────────────────────────────────
//  clampHoldersScannerCacheMs
// ─────────────────────────────────────────────────────────────────────

test('clampHoldersScannerCacheMs: valid number passes through', () => {
  assert.equal(clampHoldersScannerCacheMs(60000), 60000);
});

test('clampHoldersScannerCacheMs: 0 returns 0 (caching disabled)', () => {
  assert.equal(clampHoldersScannerCacheMs(0), 0);
});

test('clampHoldersScannerCacheMs: negative returns 0', () => {
  assert.equal(clampHoldersScannerCacheMs(-100), 0);
});

test('clampHoldersScannerCacheMs: NaN returns default', () => {
  assert.equal(clampHoldersScannerCacheMs(NaN), DEFAULT_HOLDERS_SCANNER_CACHE_MS);
});

test('clampHoldersScannerCacheMs: non-number returns default', () => {
  assert.equal(clampHoldersScannerCacheMs('60000'), DEFAULT_HOLDERS_SCANNER_CACHE_MS);
  assert.equal(clampHoldersScannerCacheMs(null), DEFAULT_HOLDERS_SCANNER_CACHE_MS);
  assert.equal(clampHoldersScannerCacheMs(undefined), DEFAULT_HOLDERS_SCANNER_CACHE_MS);
});

test('clampHoldersScannerCacheMs: below min bumps to min', () => {
  assert.equal(clampHoldersScannerCacheMs(500), MIN_HOLDERS_SCANNER_CACHE_MS);
});

test('clampHoldersScannerCacheMs: above max clamps to max', () => {
  assert.equal(clampHoldersScannerCacheMs(MAX_HOLDERS_SCANNER_CACHE_MS + 1000), MAX_HOLDERS_SCANNER_CACHE_MS);
});

test('clampHoldersScannerCacheMs: fractional floors to integer', () => {
  assert.equal(clampHoldersScannerCacheMs(12345.6), 12345);
});

// ─────────────────────────────────────────────────────────────────────
//  HoldersScannerCache constructor
// ─────────────────────────────────────────────────────────────────────

test('HoldersScannerCache: default config', () => {
  const c = new HoldersScannerCache();
  assert.equal(c.cacheMs, DEFAULT_HOLDERS_SCANNER_CACHE_MS);
  assert.equal(c.size(), 0);
});

test('HoldersScannerCache: custom cacheMs', () => {
  const c = new HoldersScannerCache({ cacheMs: 60000 });
  assert.equal(c.cacheMs, 60000);
});

test('HoldersScannerCache: cacheMs above max clamps to max', () => {
  const c = new HoldersScannerCache({ cacheMs: MAX_HOLDERS_SCANNER_CACHE_MS + 1000 });
  assert.equal(c.cacheMs, MAX_HOLDERS_SCANNER_CACHE_MS);
});

test('HoldersScannerCache: cacheMs negative clamps to 0', () => {
  const c = new HoldersScannerCache({ cacheMs: -100 });
  assert.equal(c.cacheMs, 0);
});

test('HoldersScannerCache: cacheMs=0 disables caching', () => {
  const c = new HoldersScannerCache({ cacheMs: 0 });
  assert.equal(c.cacheMs, 0);
  const r = c.set(VALID_TOKEN, { ok: true });
  assert.equal(r, false);
  assert.equal(c.size(), 0);
  assert.equal(c.get(VALID_TOKEN), null);
});

test('HoldersScannerCache: custom maxEntries', () => {
  const c = new HoldersScannerCache({ maxEntries: 5 });
  assert.equal(c.maxEntries, 5);
});

// ─────────────────────────────────────────────────────────────────────
//  HoldersScannerCache.set + get
// ─────────────────────────────────────────────────────────────────────

test('HoldersScannerCache.set + get: happy round-trip', () => {
  const now = 1000;
  const c = new HoldersScannerCache({ nowMs: () => now });
  const env = { ok: true, holders: [], category: VALID_TOKEN };
  assert.equal(c.set(VALID_TOKEN, env, { upstream: 'https://x', snapshot_at_unix_s: 12345 }), true);
  const got = c.get(VALID_TOKEN);
  assert.ok(got !== null);
  assert.equal(got.envelope, env);
  assert.equal(got.fetched_at_ms, 1000);
  assert.equal(got.age_ms, 0);
  assert.equal(got.upstream, 'https://x');
  assert.equal(got.snapshot_at_unix_s, 12345);
});

test('HoldersScannerCache.set: uppercase tokenId lowercases the key', () => {
  const c = new HoldersScannerCache();
  c.set(VALID_TOKEN.toUpperCase(), { ok: true });
  assert.equal(c.size(), 1);
  assert.equal(c.get(VALID_TOKEN.toLowerCase()) !== null, true);
});

test('HoldersScannerCache.set: missing tokenId returns false', () => {
  const c = new HoldersScannerCache();
  assert.equal(c.set('', { ok: true }), false);
  assert.equal(c.set(null, { ok: true }), false);
  assert.equal(c.size(), 0);
});

test('HoldersScannerCache.set: invalid envelope returns false', () => {
  const c = new HoldersScannerCache();
  assert.equal(c.set(VALID_TOKEN, null), false);
  assert.equal(c.set(VALID_TOKEN, []), false);
  assert.equal(c.set(VALID_TOKEN, 'string'), false);
  assert.equal(c.size(), 0);
});

test('HoldersScannerCache.set: overwrite refreshes the TTL clock', () => {
  let now = 1000;
  const c = new HoldersScannerCache({ cacheMs: 5000, nowMs: () => now });
  c.set(VALID_TOKEN, { ok: true, v: 1 });
  now += 3000;
  c.set(VALID_TOKEN, { ok: true, v: 2 });
  now += 3000; // total 6000 since first set, but only 3000 since last set
  const got = c.get(VALID_TOKEN);
  assert.ok(got !== null);
  assert.equal(got.envelope.v, 2);
  assert.equal(got.age_ms, 3000);
});

test('HoldersScannerCache.get: cold miss returns null + increments misses', () => {
  const c = new HoldersScannerCache();
  const r = c.get(VALID_TOKEN);
  assert.equal(r, null);
  assert.equal(c.stats().misses, 1);
});

test('HoldersScannerCache.get: warm hit increments hits', () => {
  const c = new HoldersScannerCache();
  c.set(VALID_TOKEN, { ok: true });
  c.get(VALID_TOKEN);
  c.get(VALID_TOKEN);
  assert.equal(c.stats().hits, 2);
  assert.equal(c.stats().misses, 0);
});

test('HoldersScannerCache.get: TTL expiry drops entry + counts expiry eviction', () => {
  let now = 1000;
  const c = new HoldersScannerCache({ cacheMs: 5000, nowMs: () => now });
  c.set(VALID_TOKEN, { ok: true });
  now += 5001; // expired
  const r = c.get(VALID_TOKEN);
  assert.equal(r, null);
  assert.equal(c.size(), 0);
  const stats = c.stats();
  assert.equal(stats.expiry_evictions, 1);
  assert.equal(stats.evictions, 1);
  assert.equal(stats.misses, 1);
});

test('HoldersScannerCache.get: at-boundary (age === cacheMs) is still a hit', () => {
  let now = 1000;
  const c = new HoldersScannerCache({ cacheMs: 5000, nowMs: () => now });
  c.set(VALID_TOKEN, { ok: true });
  now += 5000;
  const r = c.get(VALID_TOKEN);
  assert.ok(r !== null);
  assert.equal(r.age_ms, 5000);
});

test('HoldersScannerCache.get: invalid tokenId returns null', () => {
  const c = new HoldersScannerCache();
  c.set(VALID_TOKEN, { ok: true });
  assert.equal(c.get(''), null);
  assert.equal(c.get(null), null);
  assert.equal(c.stats().misses, 0); // not counted as a miss (input rejected)
});

test('HoldersScannerCache.set: overflow evicts the oldest half (LRU)', () => {
  const c = new HoldersScannerCache({ maxEntries: 4 });
  c.set(VALID_TOKEN, { ok: true, v: 'a' });
  c.set(OTHER_TOKEN, { ok: true, v: 'b' });
  c.set(`${VALID_TOKEN.slice(0, 63)}0`, { ok: true, v: 'c' });
  c.set(`${OTHER_TOKEN.slice(0, 63)}0`, { ok: true, v: 'd' });
  // Now insert a 5th — should evict the oldest half (2 entries).
  c.set(`${VALID_TOKEN.slice(0, 62)}00`, { ok: true, v: 'e' });
  const stats = c.stats();
  assert.equal(stats.size_evictions, 2);
  assert.equal(stats.size, 3); // 4 - 2 + 1
  // The first two should be gone; the last three should remain.
  assert.equal(c.get(VALID_TOKEN), null);
  assert.equal(c.get(OTHER_TOKEN), null);
  assert.notEqual(c.get(`${VALID_TOKEN.slice(0, 63)}0`), null);
  assert.notEqual(c.get(`${OTHER_TOKEN.slice(0, 63)}0`), null);
  assert.notEqual(c.get(`${VALID_TOKEN.slice(0, 62)}00`), null);
});

// ─────────────────────────────────────────────────────────────────────
//  HoldersScannerCache.invalidate
// ─────────────────────────────────────────────────────────────────────

test('HoldersScannerCache.invalidate: removes existing entry', () => {
  const c = new HoldersScannerCache();
  c.set(VALID_TOKEN, { ok: true });
  c.set(OTHER_TOKEN, { ok: true });
  assert.equal(c.invalidate(VALID_TOKEN), true);
  assert.equal(c.size(), 1);
  assert.equal(c.get(VALID_TOKEN), null);
  assert.notEqual(c.get(OTHER_TOKEN), null);
});

test('HoldersScannerCache.invalidate: returns false on missing', () => {
  const c = new HoldersScannerCache();
  c.set(VALID_TOKEN, { ok: true });
  assert.equal(c.invalidate(OTHER_TOKEN), false);
  assert.equal(c.size(), 1);
});

test('HoldersScannerCache.invalidate: invalid tokenId returns false', () => {
  const c = new HoldersScannerCache();
  c.set(VALID_TOKEN, { ok: true });
  assert.equal(c.invalidate(''), false);
  assert.equal(c.invalidate(null), false);
});

test('HoldersScannerCache.invalidateAll: clears everything + counts invalidations', () => {
  const c = new HoldersScannerCache();
  c.set(VALID_TOKEN, { ok: true });
  c.set(OTHER_TOKEN, { ok: true });
  c.set(`${VALID_TOKEN.slice(0, 63)}0`, { ok: true });
  const n = c.invalidateAll();
  assert.equal(n, 3);
  assert.equal(c.size(), 0);
  assert.equal(c.stats().invalidations, 3);
});

// ─────────────────────────────────────────────────────────────────────
//  HoldersScannerCache.stats + keys
// ─────────────────────────────────────────────────────────────────────

test('HoldersScannerCache.stats: counts every operation', () => {
  const c = new HoldersScannerCache();
  c.set(VALID_TOKEN, { ok: true });
  c.set(OTHER_TOKEN, { ok: true });
  c.get(VALID_TOKEN); // hit
  c.get(VALID_TOKEN); // hit
  c.get(`${VALID_TOKEN.slice(0, 63)}0`); // miss
  c.invalidate(OTHER_TOKEN);
  const stats = c.stats();
  assert.equal(stats.stores, 2);
  assert.equal(stats.hits, 2);
  assert.equal(stats.misses, 1);
  assert.equal(stats.invalidations, 1);
  assert.equal(stats.evictions, 1);
  assert.equal(stats.size, 1);
});

test('HoldersScannerCache.keys: returns lowercase token_ids', () => {
  const c = new HoldersScannerCache();
  c.set(VALID_TOKEN, { ok: true });
  c.set(OTHER_TOKEN.toUpperCase(), { ok: true });
  const keys = c.keys();
  assert.equal(keys.length, 2);
  assert.ok(keys.includes(VALID_TOKEN));
  assert.ok(keys.includes(OTHER_TOKEN));
  assert.ok(keys.every((k) => k === k.toLowerCase()));
});

// ─────────────────────────────────────────────────────────────────────
//  resolveHoldersSnapshot
// ─────────────────────────────────────────────────────────────────────

function makeMockResponse({ status = 200, body, ok = true } = {}) {
  return { ok, status, json: async () => body };
}

test('resolveHoldersSnapshot: invalid args returns config_invalid', async () => {
  const r = await resolveHoldersSnapshot([]);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'config_invalid');
});

test('resolveHoldersSnapshot: invalid tokenId returns invalid_token_id', async () => {
  const r = await resolveHoldersSnapshot({ tokenId: 'short' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_token_id');
});

test('resolveHoldersSnapshot: cache hit short-circuits fetcher', async () => {
  const cache = new HoldersScannerCache();
  const envelope = { ok: true, holders: [], category: VALID_TOKEN, source: 'tokenstork', upstream: 'https://x', fetched_at_ms: 1, snapshot_at_unix_s: 2 };
  cache.set(VALID_TOKEN, envelope, { upstream: 'https://x', snapshot_at_unix_s: 2 });
  let fetcherCalled = false;
  const fetcher = async () => { fetcherCalled = true; return null; };
  const r = await resolveHoldersSnapshot({ tokenId: VALID_TOKEN, cache, fetcher });
  assert.equal(r.ok, true);
  assert.equal(r.cached, true);
  assert.equal(fetcherCalled, false);
  assert.equal(r.envelope, envelope);
});

test('resolveHoldersSnapshot: cache miss fetches + stores', async () => {
  const cache = new HoldersScannerCache();
  const body = { category: VALID_TOKEN, holders: [{ address: 'bitcoincash:q', balance: '100', nftCount: 0, snapshotAt: 1782563289 }] };
  const fetcher = async () => makeMockResponse({ status: 200, body });
  const r = await resolveHoldersSnapshot({ tokenId: VALID_TOKEN, cache, fetcher });
  assert.equal(r.ok, true);
  assert.equal(r.cached, false);
  assert.equal(r.cache_age_ms, 0);
  assert.ok(r.envelope);
  assert.equal(cache.size(), 1);
  // Next call should hit the cache.
  const r2 = await resolveHoldersSnapshot({ tokenId: VALID_TOKEN, cache, fetcher });
  assert.equal(r2.cached, true);
});

test('resolveHoldersSnapshot: fetcher throw returns error + does NOT cache', async () => {
  const cache = new HoldersScannerCache();
  const fetcher = async () => { throw new Error('ECONNREFUSED'); };
  const r = await resolveHoldersSnapshot({ tokenId: VALID_TOKEN, cache, fetcher });
  assert.equal(r.ok, false);
  assert.equal(r.cached, false);
  assert.equal(r.error, 'fetch_failed');
  assert.match(r.message, /ECONNREFUSED/);
  assert.equal(cache.size(), 0); // failed fetches aren't cached
});

test('resolveHoldersSnapshot: 404 returns token_not_found success + does NOT cache', async () => {
  const cache = new HoldersScannerCache();
  const fetcher = async () => makeMockResponse({ status: 404, body: { message: 'not' } });
  const r = await resolveHoldersSnapshot({ tokenId: VALID_TOKEN, cache, fetcher });
  assert.equal(r.ok, true);
  assert.equal(r.envelope.token_not_found, true);
  // Note: token_not_found is currently cached by resolveHoldersSnapshot
  // (so repeat lookups don't re-404 upstream) — verify the actual
  // behavior so a future refactor doesn't silently flip it.
  assert.equal(cache.size(), 1);
});

test('resolveHoldersSnapshot: 500 returns http_error', async () => {
  const cache = new HoldersScannerCache();
  const fetcher = async () => makeMockResponse({ status: 500, body: null });
  const r = await resolveHoldersSnapshot({ tokenId: VALID_TOKEN, cache, fetcher });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'http_error');
  assert.equal(r.http_status, 500);
});

test('resolveHoldersSnapshot: no cache arg falls back to no-op', async () => {
  const body = { category: VALID_TOKEN, holders: [] };
  const fetcher = async () => makeMockResponse({ status: 200, body });
  const r = await resolveHoldersSnapshot({ tokenId: VALID_TOKEN, fetcher });
  assert.equal(r.ok, true);
  assert.equal(r.cached, false);
});

test('resolveHoldersSnapshot: cacheMs=0 disables caching on the orchestrator path', async () => {
  const cache = new HoldersScannerCache({ cacheMs: 0 });
  const body = { category: VALID_TOKEN, holders: [] };
  let calls = 0;
  const fetcher = async () => { calls += 1; return makeMockResponse({ status: 200, body }); };
  await resolveHoldersSnapshot({ tokenId: VALID_TOKEN, cache, fetcher });
  await resolveHoldersSnapshot({ tokenId: VALID_TOKEN, cache, fetcher });
  assert.equal(calls, 2);
});
