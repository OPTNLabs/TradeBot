#!/usr/bin/env node
// src/strategy/holder-scanner-cache.mjs
//
// T76 subset 2 — Per-token TTL cache wrapping the live TokenStork
// holders scanner.
//
// Mirrors the pattern `src/dashboard/snapshot-aggregator.mjs#SnapshotAggregator`
// established (mtime-keyed TTL + defensive invalidate) but keyed on
// `token_id` only — the upstream snapshots its holders list at one
// timestamp per fetch, so there's no separate "mtime" dimension to
// track. Instead the cache tracks `fetched_at_ms` per entry and
// expires after `cacheMs` ms.
//
// Pure in the sense that the underlying fetch + map is pure-shape;
// the cache itself is a thin memoization layer with no I/O.

import {
  DEFAULT_HOLDERS_SCANNER_CACHE_MS,
  MAX_HOLDERS_SCANNER_CACHE_MS,
} from './holder-scanner.mjs';

/**
 * Min permitted cache TTL (sanity clamp). 0 disables caching entirely;
 * the smallest non-zero value is 1000ms (1s) so a typo'd 1 doesn't
 * produce a useless "always-expired" cache.
 */
export const MIN_HOLDERS_SCANNER_CACHE_MS = 1000;

// ─────────────────────────────────────────────────────────────────────
//  Cache class
// ─────────────────────────────────────────────────────────────────────

/**
 * Per-token TTL cache for holders scanner envelopes. Used by both
 * the dashboard endpoint (so repeated calls within the cacheMs
 * window don't re-fetch the upstream) AND the trader loop (so the
 * per-tick eligibility check is cheap once a token has been scanned
 * once).
 *
 * `cacheMs <= 0` disables caching entirely (every call returns
 * `{cached:false}` and the entry isn't stored). Default
 * `cacheMs = DEFAULT_HOLDERS_SCANNER_CACHE_MS` (5 minutes).
 *
 * In-memory only — no disk persistence. Holder distribution
 * changes between process restarts anyway, so re-fetching on
 * boot is the right behavior.
 */
export class HoldersScannerCache {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.cacheMs]            TTL in ms (default DEFAULT_HOLDERS_SCANNER_CACHE_MS)
   * @param {Function|null} [opts.nowMs]       injectable clock returning ms-since-epoch (default Date.now)
   * @param {number} [opts.maxEntries]         hard cap on the per-token map size (default 1000)
   */
  constructor(opts = {}) {
    const raw = (opts && typeof opts === 'object' && !Array.isArray(opts)) ? opts : {};
    let cacheMs = (typeof raw.cacheMs === 'number' && Number.isFinite(raw.cacheMs))
      ? raw.cacheMs
      : DEFAULT_HOLDERS_SCANNER_CACHE_MS;
    if (cacheMs > MAX_HOLDERS_SCANNER_CACHE_MS) cacheMs = MAX_HOLDERS_SCANNER_CACHE_MS;
    if (cacheMs < 0) cacheMs = 0;
    this.cacheMs = cacheMs;
    this.nowMs = (typeof raw.nowMs === 'function') ? raw.nowMs : null;
    this.maxEntries = (typeof raw.maxEntries === 'number' && Number.isFinite(raw.maxEntries) && raw.maxEntries > 0)
      ? Math.floor(raw.maxEntries)
      : 1000;
    /** @type {Map<string, {envelope: Object, fetched_at_ms: number, upstream: string|null, snapshot_at_unix_s: number|null}>} */
    this._entries = new Map();
    /** @type {{hits: number, misses: number, stores: number, evictions: number, expiry_evictions: number, size_evictions: number, invalidations: number}} */
    this._stats = {
      hits: 0,
      misses: 0,
      stores: 0,
      evictions: 0,
      expiry_evictions: 0,
      size_evictions: 0,
      invalidations: 0,
    };
  }

  /** @returns {number} the current time in ms */
  _now() {
    if (this.nowMs !== null) return this.nowMs();
    return Date.now();
  }

  /**
   * Snapshot the cache stats (hits / misses / stores / evictions).
   * Pure read — does not reset the counters.
   * @returns {{hits: number, misses: number, stores: number, evictions: number, expiry_evictions: number, size_evictions: number, invalidations: number, size: number, cacheMs: number}}
   */
  stats() {
    return {
      ...this._stats,
      size: this._entries.size,
      cacheMs: this.cacheMs,
    };
  }

  /**
   * Look up a cached envelope for `tokenId`. Returns `null` on
   * cache miss (no entry OR TTL expired OR cache disabled).
   *
   * @param {string} tokenId
   * @returns {{envelope: Object, fetched_at_ms: number, age_ms: number, upstream: string|null, snapshot_at_unix_s: number|null} | null}
   */
  get(tokenId) {
    if (this.cacheMs <= 0) return null;
    if (typeof tokenId !== 'string' || tokenId.length === 0) return null;
    const key = tokenId.toLowerCase();
    const entry = this._entries.get(key);
    if (!entry) {
      this._stats.misses += 1;
      return null;
    }
    const now = this._now();
    const age = now - entry.fetched_at_ms;
    if (age < 0 || age > this.cacheMs) {
      this._entries.delete(key);
      this._stats.expiry_evictions += 1;
      this._stats.evictions += 1;
      this._stats.misses += 1;
      return null;
    }
    this._stats.hits += 1;
    return {
      envelope: entry.envelope,
      fetched_at_ms: entry.fetched_at_ms,
      age_ms: age,
      upstream: entry.upstream,
      snapshot_at_unix_s: entry.snapshot_at_unix_s,
    };
  }

  /**
   * Store an envelope for `tokenId`. If the entry already exists
   * it's REPLACED (resetting the TTL clock). Returns `true` if
   * stored, `false` if cache is disabled or input is invalid.
   *
   * Trims the LRU half of the cache when `maxEntries` is exceeded
   * — defensive cap so a misbehaving operator enumerating tokens
   * can't blow out memory.
   *
   * @param {string} tokenId
   * @param {Object} envelope
   * @param {Object} [opts]
   * @param {string|null} [opts.upstream]
   * @param {number|null} [opts.snapshot_at_unix_s]
   * @returns {boolean}
   */
  set(tokenId, envelope, opts = {}) {
    if (this.cacheMs <= 0) return false;
    if (typeof tokenId !== 'string' || tokenId.length === 0) return false;
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return false;
    const key = tokenId.toLowerCase();
    const upstream = (opts && typeof opts.upstream === 'string') ? opts.upstream : null;
    const snapshotAt = (opts && typeof opts.snapshot_at_unix_s === 'number' && Number.isFinite(opts.snapshot_at_unix_s))
      ? opts.snapshot_at_unix_s
      : null;
    // LRU refresh: delete + re-insert moves to the end (Map preserves
    // insertion order; we use this for LRU semantics).
    if (this._entries.has(key)) {
      this._entries.delete(key);
    } else if (this._entries.size >= this.maxEntries) {
      // Trim the OLDEST half of the cache (insertion order = LRU).
      const dropCount = Math.max(1, Math.floor(this.maxEntries / 2));
      const iter = this._entries.keys();
      for (let i = 0; i < dropCount; i++) {
        const k = iter.next().value;
        if (k === undefined) break;
        this._entries.delete(k);
        this._stats.size_evictions += 1;
        this._stats.evictions += 1;
      }
    }
    this._entries.set(key, {
      envelope,
      fetched_at_ms: this._now(),
      upstream,
      snapshot_at_unix_s: snapshotAt,
    });
    this._stats.stores += 1;
    return true;
  }

  /**
   * Invalidate one token's cached entry. No-op if not present.
   * @param {string} tokenId
   * @returns {boolean} true if a cached entry was removed
   */
  invalidate(tokenId) {
    if (typeof tokenId !== 'string' || tokenId.length === 0) return false;
    const key = tokenId.toLowerCase();
    const had = this._entries.delete(key);
    if (had) {
      this._stats.invalidations += 1;
      this._stats.evictions += 1;
    }
    return had;
  }

  /**
   * Clear ALL cached entries (operator-triggered flush via admin
   * endpoint or test teardown).
   * @returns {number} the number of entries removed
   */
  invalidateAll() {
    const n = this._entries.size;
    this._entries.clear();
    if (n > 0) {
      this._stats.invalidations += n;
      this._stats.evictions += n;
    }
    return n;
  }

  /**
   * @returns {number} the current number of cached entries
   */
  size() {
    return this._entries.size;
  }

  /**
   * List the cached token_ids (lowercase). Pure read.
   * @returns {Array<string>}
   */
  keys() {
    return [...this._entries.keys()];
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Orchestrator: cache + scanner in one call
// ─────────────────────────────────────────────────────────────────────

/**
 * Resolve the holders snapshot for a token via the cache + scanner
 * pipeline. Pure-shape: takes injected `cache` + `fetcher` + `nowMs`
 * seams so tests can verify the cache-miss / cache-hit / error
 * paths without touching the network.
 *
 * Behavior:
 *   1. If cache hit → return `{cached:true, ...envelope, cache_age_ms}`.
 *   2. Else call `fetchTokenHoldersFromTokenStork(args)` via the
 *      injected `fetcher` + `nowMs`.
 *   3. On fetch success → store in cache + return
 *      `{cached:false, ...envelope, cache_age_ms:0}`.
 *   4. On fetch failure → return the typed error envelope (NOT
 *      stored in cache so the next tick retries).
 *
 * @param {Object} args
 * @param {string} args.tokenId
 * @param {HoldersScannerCache} [args.cache]
 * @param {Object} [args.scannerOpts]              forwarded to fetchTokenHoldersFromTokenStork
 * @param {Function} [args.fetcher]                test seam (default globalThis.fetch)
 * @returns {Promise<
 *   | {ok: true, cached: boolean, cache_age_ms: number, envelope: Object, fetched_at_ms: number, snapshot_at_unix_s: number|null, upstream: string|null}
 *   | {ok: false, error: string, message: string, cached: false, cache_age_ms: 0, http_status: number|null, upstream: string|null}
 * >}
 */
export async function resolveHoldersSnapshot(args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return {
      ok: false,
      error: 'config_invalid',
      message: 'resolveHoldersSnapshot: args object required',
      cached: false,
      cache_age_ms: 0,
      http_status: null,
      upstream: null,
    };
  }
  const tokenId = typeof args.tokenId === 'string' ? args.tokenId.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(tokenId)) {
    return {
      ok: false,
      error: 'invalid_token_id',
      message: 'tokenId must be a 64-char lowercase hex string',
      cached: false,
      cache_age_ms: 0,
      http_status: null,
      upstream: null,
    };
  }
  const cache = (args.cache && typeof args.cache.get === 'function') ? args.cache : null;
  // Cache lookup
  if (cache !== null) {
    const hit = cache.get(tokenId);
    if (hit !== null) {
      return {
        ok: true,
        cached: true,
        cache_age_ms: hit.age_ms,
        envelope: hit.envelope,
        fetched_at_ms: hit.fetched_at_ms,
        snapshot_at_unix_s: hit.snapshot_at_unix_s,
        upstream: hit.upstream,
      };
    }
  }
  // Cache miss — fetch via the scanner module (dynamic import to
  // avoid a circular-dep hazard with the cache module's imports).
  const { fetchTokenHoldersFromTokenStork } = await import('./holder-scanner.mjs');
  const scannerOpts = (args.scannerOpts && typeof args.scannerOpts === 'object' && !Array.isArray(args.scannerOpts))
    ? args.scannerOpts
    : {};
  // Allow top-level `fetcher` shortcut (for tests / simple callers).
  const fetcher = (typeof args.fetcher === 'function') ? args.fetcher : null;
  const fetched = await fetchTokenHoldersFromTokenStork({
    tokenId,
    ...scannerOpts,
    ...(fetcher !== null ? { fetcher } : {}),
  });
  if (!fetched.ok) {
    return {
      ok: false,
      error: fetched.error,
      message: fetched.message,
      cached: false,
      cache_age_ms: 0,
      http_status: fetched.http_status ?? null,
      upstream: fetched.upstream ?? null,
    };
  }
  // Store in cache. Only cache successful (non-error) envelopes;
  // failures should be retried on the next call (operators can
  // flip cacheMs<=0 to bypass if needed).
  if (cache !== null) {
    cache.set(tokenId, fetched, {
      upstream: fetched.upstream ?? null,
      snapshot_at_unix_s: fetched.snapshot_at_unix_s ?? null,
    });
  }
  return {
    ok: true,
    cached: false,
    cache_age_ms: 0,
    envelope: fetched,
    fetched_at_ms: fetched.fetched_at_ms,
    snapshot_at_unix_s: fetched.snapshot_at_unix_s ?? null,
    upstream: fetched.upstream ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Clamp helper
// ─────────────────────────────────────────────────────────────────────

/**
 * Clamp a raw `cacheMs` knob value into the permitted range. Used
 * by the dashboard server's `CreateDashboardServerOpts` constructor
 * + the knob-catalog range validator. 0 is allowed (= caching
 * disabled); negative / non-finite / non-numeric → default.
 *
 * @param {unknown} v
 * @returns {number}
 */
export function clampHoldersScannerCacheMs(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_HOLDERS_SCANNER_CACHE_MS;
  const n = Math.floor(v);
  if (n <= 0) return 0;
  if (n < MIN_HOLDERS_SCANNER_CACHE_MS) return MIN_HOLDERS_SCANNER_CACHE_MS;
  if (n > MAX_HOLDERS_SCANNER_CACHE_MS) return MAX_HOLDERS_SCANNER_CACHE_MS;
  return n;
}
