#!/usr/bin/env node
// src/data/fetcher.mjs
//
// Cauldron indexer adapter. One read-only client for everything the
// strategy / portfolio layers need from the third-party indexer:
//
//   - listPools(tokenId)         → Pool[]          (active pools for one token)
//   - listTopTokens({...})      → RawIndexerEntry[]  (discovery: top-N by tvl/volume/...)
//   - getTokenStats(tokenId)     → PoolStats       (normalized)
//   - getTokenStatsBySymbol(sym) → PoolStats       (normalized)
//   - getBcmr(tokenId)           → Token | null    (BCMR metadata; null = no authchain)
//
// Design rules (see docs/ARCHITECTURE.md §5):
//   1. Read-only. NEVER signs. NEVER broadcasts. NEVER touches the WIF.
//      The trader layer (T11) wraps `check_and_swap.mjs` for writes.
//   2. The fetcher returns the indexer's RAW shape for `listTopTokens`
//      and a NORMALIZED shape for `getTokenStats` (so the scoring
//      engine has ONE shape to consume, regardless of which indexer
//      is queried). The raw shape is preserved for callers that
//      need it (dashboard, debug).
//   3. Every async op has a timeout (AbortController). Every op
//      retries transient failures with exp-backoff + jitter. Every
//      non-retryable error is rethrown as a typed `IndexerError`
//      so callers can `instanceof`-match and log without parsing
//      string messages.
//   4. Per-token caching with TTL. Two TTLs:
//        - `poolCacheTtlMs`   for `listPools(tokenId)`   (default 30s)
//        - `statsCacheTtlMs`  for `getTokenStats`        (default 60s)
//      `invalidate(tokenId)` and `invalidateAll()` are exposed
//      so the strategy layer can bust the cache after a trade
//      (post-trade re-quote).
//   5. Rate-limit via a tiny token-bucket: `rateLimitPerSec` ops/sec
//      across all endpoints. Cheap to test, no dependency on a
//      third-party limiter.
//   6. Injectable `fetchImpl` so tests can mock without monkey-
//      patching `globalThis`. Default is the global `fetch` (Node 18+).
//   7. NEVER logs raw WIFs / tx hex. The fetcher has no secrets to
//      leak by design, but the rule applies to every module.
//
// Original code for TradeBot. Mirrors the public surfaces of
// AI_Skills/skills/cauldron/scripts/{list_pools,get_token_stats,get_bcmr}.mjs
// but is engineered for repeated in-process calls (caching, retry,
// rate-limit) rather than one-shot CLI use.

import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

import {
  isValidPool,
  isValidPoolStats,
  isValidTokenId,
  normalizeTokenId,
  bchFromSats,
} from './types.mjs';

// ─────────────────────────────────────────────────────────────────────
//  Errors
// ─────────────────────────────────────────────────────────────────────

/**
 * Base class for every error the fetcher raises. Callers should
 * match on `instanceof IndexerError` to distinguish indexer-side
 * failures from local bugs (TypeError, etc.).
 */
export class IndexerError extends Error {
  /**
   * @param {string} message
   * @param {string} url
   * @param {Object} [opts]
   * @param {Error} [opts.cause]
   */
  constructor(message, url, opts = {}) {
    super(message);
    this.name = 'IndexerError';
    this.url = url;
    if (opts.cause) this.cause = opts.cause;
  }
}

/** HTTP-level failure (4xx / 5xx from the indexer). */
export class IndexerHttpError extends IndexerError {
  /**
   * @param {number} status
   * @param {string} url
   * @param {string} body
   */
  constructor(status, url, body) {
    super(`indexer HTTP ${status}: ${body.slice(0, 200)}`, url);
    this.name = 'IndexerHttpError';
    this.status = status;
    this.body = body;
  }
  /** 4xx → caller error (don't retry). 5xx → transient (retry). */
  get retryable() { return this.status >= 500; }
}

/** Request timed out (AbortError from the timeout AbortController). */
export class IndexerTimeoutError extends IndexerError {
  /** @param {number} timeoutMs @param {string} url */
  constructor(timeoutMs, url) {
    super(`indexer timeout after ${timeoutMs}ms`, url);
    this.name = 'IndexerTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** Response wasn't JSON or didn't match the expected shape. */
export class IndexerShapeError extends IndexerError {
  /**
   * @param {string} message
   * @param {string} url
   * @param {Object} [opts]
   * @param {unknown} [opts.body]
   */
  constructor(message, url, opts = {}) {
    super(message, url);
    this.name = 'IndexerShapeError';
    if ('body' in opts) this.body = opts.body;
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Pure helpers (exported for tests)
// ─────────────────────────────────────────────────────────────────────

/**
 * Validate a token_id and return it canonicalized. Throws a
 * `TypeError` (not `IndexerError`) on bad input — bad input is a
 * caller bug, not an indexer-side failure.
 *
 * @param {string} raw
 * @returns {string}
 */
export function requireValidTokenId(raw) {
  if (!isValidTokenId(raw)) {
    throw new TypeError(`fetcher: bad token_id (${String(raw).slice(0, 16)}…)`);
  }
  return normalizeTokenId(raw);
}

/**
 * Pick the URL search params for `list_cached`. Pure.
 *
 * @param {{ by?: string, order?: 'asc'|'desc', limit?: number }} opts
 * @returns {string}
 */
export function buildDiscoveryUrl(baseUrl, { by = 'tvl', order = 'desc', limit = 200 } = {}) {
  // `Number.isFinite` is required so `limit: 0` doesn't get coerced to
  // the default 200 by the `||` fallback (0 is falsy). NaN / undefined
  // / non-number inputs all fall back to 200; finite numbers are
  // clamped to [1, 1000].
  const raw = Number(limit);
  const limitNum = Number.isFinite(raw) ? raw : 200;
  const safeLimit = Math.max(1, Math.min(limitNum, 1000));
  const safeBy = String(by || 'tvl');
  const safeOrder = String(order || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
  return `${baseUrl}/tokens/list_cached?limit=${safeLimit}&by=${encodeURIComponent(safeBy)}&order=${safeOrder}`;
}

/**
 * Build the cache key for a `listTopTokens(opts)` invocation. Pure.
 *
 * T46: the cache for `listTopTokens` is keyed on the SAME normalized
 * triple the URL builder uses, so two callers passing
 * `{order: 'DESC'}` and `{order: 'desc'}` (or `{limit: 200.0}` vs
 * `{limit: 200}`) share the same entry. Without the normalization,
 * case-only or numeric-vs-string variants would silently miss each
 * other's cache and re-fetch.
 *
 * Exported for tests.
 *
 * @param {{ by?: string, order?: 'asc'|'desc', limit?: number }} opts
 * @returns {string}
 */
export function discoveryCacheKey(opts = {}) {
  const raw = Number(opts.limit);
  const limitNum = Number.isFinite(raw) ? raw : 200;
  const safeLimit = Math.max(1, Math.min(limitNum, 1000));
  const safeBy = String(opts.by || 'tvl');
  const safeOrder = String(opts.order || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
  return `discovery:${safeBy}:${safeOrder}:${safeLimit}`;
}

/**
 * Build the active-pools URL for a given token_id.
 *
 * @param {string} baseUrl
 * @param {string} tokenId
 * @returns {string}
 */
export function buildActivePoolsUrl(baseUrl, tokenId) {
  return `${baseUrl}/pool/active?token=${encodeURIComponent(tokenId)}`;
}

/**
 * Build the BCMR URL for a token_id. Note: the BCMR endpoint lives
 * at the indexer ROOT (NOT under `/cauldron/...`). The bot uses
 * `indexer.cauldron.quest` (the SDK's default) for BCMR per
 * AI_Skills/skills/cauldron/SKILL.md "Path quirk" note.
 *
 * @param {string} bcmrBaseUrl
 * @param {string} tokenId
 * @returns {string}
 */
export function buildBcmrUrl(bcmrBaseUrl, tokenId) {
  return `${bcmrBaseUrl}/bcmr/token/${encodeURIComponent(tokenId)}`;
}

/**
 * Normalize a raw `list_cached` entry into the canonical `PoolStats`
 * shape. Pure — exported for tests. Mirrors `buildStatsRecord` in
 * AI_Skills/skills/cauldron/scripts/get_token_stats.mjs but stays
 * in `src/data/` so the fetcher owns its output contract.
 *
 * @param {Record<string, unknown>} entry
 * @returns {import('./types.mjs').PoolStats}
 */
export function buildStatsRecord(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new IndexerShapeError('buildStatsRecord: entry is not an object', '<memory>');
  }
  const e = /** @type {Record<string, unknown>} */ (entry);
  const bcmr = /** @type {Record<string, any>} */ (e.bcmr ?? {});
  const tok = /** @type {Record<string, any>} */ (bcmr.token ?? {});
  const decimals = (typeof tok.decimals === 'number' && Number.isFinite(tok.decimals))
    ? tok.decimals
    : null;
  // T23e: accept BOTH the raw Cauldron indexer shape (price_now,
  // trade_volume) AND the canonical PoolStats shape (price_now_sats,
  // trade_volume_sats). The function is idempotent — you can call it
  // on its own output. This lets the trading loop's `_fetchStats()`
  // normalize once via buildStatsRecord() without breaking tests
  // that pass already-normalized records.
  const firstFinite = (...candidates) => {
    for (const c of candidates) {
      const n = asNumberOrNull(c);
      if (n !== null) return n;
    }
    return null;
  };
  return {
    token_id: String(e.token_id ?? '').toLowerCase(),
    name: /** @type {string|undefined} */ (e.display_name ?? bcmr.name) ?? undefined,
    symbol: /** @type {string|undefined} */ (e.display_symbol ?? tok.symbol) ?? undefined,
    decimals,
    decimals_warn: decimals === null ? 'no BCMR decimals — price_now_sats is per display unit' : null,
    price_now_sats: firstFinite(e.price_now_sats, e.price_now),
    price_now_usd: asNumberOrNull(e.price_now_usd),
    price_24h_sats: firstFinite(e.price_24h_sats, e.price_24h),
    price_7d_sats: firstFinite(e.price_7d_sats, e.price_7d),
    change_24h_bp: asNumberOrNull(e.change_24h_bp),
    change_24h_usd_bp: asNumberOrNull(e.change_24h_usd_bp),
    change_7d_bp: asNumberOrNull(e.change_7d_bp),
    change_7d_usd_bp: asNumberOrNull(e.change_7d_usd_bp),
    trade_count: asNumberOrNull(e.trade_count),
    trade_volume_sats: firstFinite(e.trade_volume_sats, e.trade_volume, e.volume_24h_sats),
    tvl_sats: firstFinite(e.tvl_sats_bch, e.tvl_sats),
    tvl_tokens: asNumberOrNull(e.tvl_tokens),
    apy_30d_bp: asNumberOrNull(e.apy_30d_bp),
    score: asNumberOrNull(e.score),
    score_rank: asNumberOrNull(e.score_rank),
    // T37: ms-since-epoch of the token's oldest active pool. The
    // indexer's `list_cached` endpoint exposes this as
    // `first_pool_ts` (UNIX seconds) — translate to ms so the ranker's
    // `filterByMaxAge` and the entry-strategy gate's
    // `min_pool_age_days` knob can read it without unit juggling.
    // Null when the indexer doesn't surface this field (newer indexer
    // versions might rename it; tests pass synthetic records without
    // timestamps all the time).
    first_seen_ts_ms: asNumberOrNull(e.first_pool_ts) !== null
      ? Math.trunc(Number(asNumberOrNull(e.first_pool_ts)) * 1000)
      : null,
    // T28c: 29-point normalized 7-day price series (Cauldron indexer
    // returns `price_series_7d: number[]` where 1.0 = max in window,
    // 0+ = fraction of max). Pass through as-is — the scoring layer
    // interprets it directly. Null when the indexer doesn't surface
    // a series for this token.
    price_series_7d: Array.isArray(e.price_series_7d)
      ? e.price_series_7d.map((n) => Number(n)).filter((n) => Number.isFinite(n))
      : null,
  };
}

/** Coerce a value to a finite number, or `null`. Never throws. */
function asNumberOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Compute the AMM-implied marginal buy rate (sats per token) for a
 * list of pools. Returns `null` when no pool has positive token
 * reserves (i.e. effectively zero liquidity).
 *
 * Algorithm mirrors `@mr-zwets/cauldron-swap-sdk`'s
 * `bestMarginalBuyRate(pools)` but is inlined here so the fetcher
 * doesn't depend on the SDK (kept out of the indexer HTTP layer to
 * avoid pulling in the cashscript + libauth transitive deps just
 * for a one-line reduction).
 *
 * Pure — exported for tests. Tolerates `string | number | bigint`
 * `tokens` reserves (the indexer sometimes returns strings for very
 * large reserves; the fetcher's `listPools` output already coerces
 * to the same union).
 *
 * @param {Array<{ sats: number|string, tokens: string|number|bigint|null|undefined }>} pools
 * @returns {number|null}  sats per token, or `null` if no liquid pool exists
 */
export function bestAmmSpotSats(pools) {
  if (!Array.isArray(pools) || pools.length === 0) return null;
  let best = Number.POSITIVE_INFINITY;
  for (const p of pools) {
    if (!p || typeof p !== 'object') continue;
    const sats = Number(p.sats);
    const tokensRaw = p.tokens;
    // `BigInt(str)` for string reserves; numeric for number reserves.
    let tokens;
    try {
      if (typeof tokensRaw === 'bigint') tokens = tokensRaw;
      else if (typeof tokensRaw === 'string') tokens = tokensRaw.length > 0 ? BigInt(tokensRaw) : null;
      else if (typeof tokensRaw === 'number') tokens = Number.isFinite(tokensRaw) ? BigInt(Math.round(tokensRaw)) : null;
      else tokens = null;
    } catch { tokens = null; }
    if (tokens === null) continue;
    if (tokens <= 0n) continue;
    if (!Number.isFinite(sats) || sats <= 0) continue;
    // sats / tokens — tokens are base units (decimals applied), so
    // the result is sats per BASE UNIT, identical to what the SDK's
    // `bestMarginalBuyRate` returns. The entry-side check is
    // indexer-vs-AMM ratio; both sides must be in the same units.
    // See `src/trader/loop.mjs#_evaluateEntry` for the alignment
    // (the indexer's `price_now_sats` is per DISPLAY unit; the loop
    // multiplies by 10^decimals so it can be compared apples-to-apples
    // to the AMM's per-base-unit rate).
    const rate = sats / Number(tokens);
    if (rate < best) best = rate;
  }
  return Number.isFinite(best) ? best : null;
}

/**
 * Sum the BCH-side (sats) reserves across every active pool for a
 * token. Returns `null` when the pool list is empty / non-array /
 * zero / malformed. Returns `0n`-equivalent (i.e. `0`) when every
 * pool exists but has zero or negative sats (all pools drained —
 * the swap layer would also fail at broadcast).
 *
 * Algorithm: reduce `sum(sats_i)` over the list. Tolerates
 * `string | number | bigint` sats reserves (mirroring
 * `bestAmmSpotSats`); pool entries that fail to coerce, are
 * non-objects, or have non-finite sats are simply skipped (the
 * indexer occasionally surfaces malformed entries — we don't want
 * one bad row to zero out the whole total).
 *
 * Used by the trading loop's pre-entry illiquidity guard (T32):
 * the indexer's `tvl_bch` can be stale or based on a different
 * pool set than the one `prepareAndBuildSwap` actually routes
 * through, so the loop now demands a minimum combined-sats
 * threshold computed from the LIVE active-pools list, not from
 * the cached `stats.tvl_sats` field.
 *
 * Pure — exported for tests. BigInt-typed so very large reserves
 * (the active-pool list for a high-cap token can easily exceed
 * `Number.MAX_SAFE_INTEGER` sats) don't silently lose precision.
 *
 * @param {Array<{ sats: number|string|bigint|null|undefined }>} pools
 * @returns {bigint|null}  total sats across all valid pools, or `null` for empty/invalid input
 */
export function totalAmmSats(pools) {
  if (!Array.isArray(pools) || pools.length === 0) return null;
  let total = 0n;
  let any = false;
  for (const p of pools) {
    if (!p || typeof p !== 'object') continue;
    const raw = p.sats;
    let sats;
    try {
      if (typeof raw === 'bigint') sats = raw;
      else if (typeof raw === 'string') sats = raw.length > 0 ? BigInt(raw) : null;
      else if (typeof raw === 'number') sats = Number.isFinite(raw) ? BigInt(Math.trunc(raw)) : null;
      else sats = null;
    } catch { sats = null; }
    if (sats === null) continue;
    if (sats < 0n) continue;
    total += sats;
    any = true;
  }
  if (!any) return null;
  return total;
}

/** Find an entry in the discovery list by exact token_id. */
export function findByTokenId(records, tokenId) {
  if (!Array.isArray(records) || !tokenId) return null;
  const target = String(tokenId).toLowerCase();
  return records.find((r) => r && String(r.token_id ?? '').toLowerCase() === target) ?? null;
}

/** Find an entry by case-insensitive symbol match. */
export function findBySymbol(records, symbol) {
  if (!Array.isArray(records) || !symbol) return null;
  const upper = String(symbol).toUpperCase();
  return records.find((r) => {
    if (!r) return false;
    const disp = (r.display_symbol != null ? String(r.display_symbol) : '').toUpperCase();
    const bcmrSym = (r?.bcmr?.token?.symbol != null ? String(r.bcmr.token.symbol) : '').toUpperCase();
    return disp === upper || bcmrSym === upper;
  }) ?? null;
}

// ─────────────────────────────────────────────────────────────────────
//  Rate limiter (token bucket) + retry (exp-backoff with jitter)
// ─────────────────────────────────────────────────────────────────────

/**
 * Tiny in-process token-bucket rate limiter. NOT thread-safe (single
 * event loop), but tested with `delay(0)` between calls so concurrent
 * test code can saturate it deterministically.
 */
export class TokenBucket {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.ratePerSec=5]
   * @param {number} [opts.burst=5]
   */
  constructor({ ratePerSec = 5, burst = 5 } = {}) {
    if (!(ratePerSec > 0)) throw new TypeError('TokenBucket: ratePerSec must be > 0');
    this.ratePerSec = ratePerSec;
    this.burst = Math.max(1, Math.floor(burst));
    this.tokens = this.burst;
    this.lastRefill = Date.now();
  }
  /** @returns {Promise<void>} */
  async acquire() {
    while (true) {
      const now = Date.now();
      const elapsedSec = (now - this.lastRefill) / 1000;
      if (elapsedSec > 0) {
        this.tokens = Math.min(this.burst, this.tokens + elapsedSec * this.ratePerSec);
        this.lastRefill = now;
      }
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.max(1, Math.ceil(((1 - this.tokens) / this.ratePerSec) * 1000));
      await delay(waitMs);
    }
  }
}

/**
 * Sleep helper for retry backoff: `baseMs * 2^attempt` capped at
 * `capMs`, plus up to `±jitterPct` jitter. Pure (no I/O); exported
 * for tests.
 *
 * @param {Object} args
 * @param {number} args.attempt      0-indexed attempt that JUST FAILED.
 * @param {number} [args.baseMs=250]
 * @param {number} [args.capMs=4000]
 * @param {number} [args.jitterPct=0.3] 0..1, fraction of jitter.
 * @param {() => number} [args.random=Math.random]
 * @returns {Promise<number>} the actual delay waited (ms).
 */
export async function backoffDelay({ attempt, baseMs = 250, capMs = 4000, jitterPct = 0.3, random = Math.random } = {}) {
  const exp = Math.min(capMs, baseMs * Math.pow(2, Math.max(0, attempt)));
  const jitter = exp * jitterPct * (random() * 2 - 1);
  const ms = Math.max(0, Math.round(exp + jitter));
  await delay(ms);
  return ms;
}

/**
 * Decide whether an error is retryable. Network errors + 5xx are
 * retryable; 4xx (incl. 429) and shape errors are NOT.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isRetryable(err) {
  if (err instanceof IndexerTimeoutError) return true;
  if (err instanceof IndexerHttpError) return err.retryable;
  if (err instanceof IndexerShapeError) return false;
  if (err instanceof TypeError) {
    // `fetch` throws TypeError on DNS / connection refused / aborted.
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────
//  Fetcher
// ─────────────────────────────────────────────────────────────────────

/** @typedef {import('./types.mjs').Pool} Pool */
/** @typedef {import('./types.mjs').PoolStats} PoolStats */
/** @typedef {import('./types.mjs').Token} Token */
/** @typedef {import('./types.mjs').RawIndexerEntry} RawIndexerEntry */

/**
 * Default config for the fetcher. Anything NOT explicitly passed to
 * the constructor falls back to one of these.
 */
/**
 * T77 — pure helper that trims a raw Cauldron indexer
 * `RawIndexerEntry` to ONLY the fields the bot's downstream code
 * (currently `buildStatsRecord` + `findBySymbol` + `projectPoolOption`)
 * actually reads. The Cauldron indexer's `list_cached` endpoint
 * returns a richer object — `bcmr.description`, `bcmr.icon_url`,
 * `bcmr.social`, `bcmr.uris`, plus top-level extras like
 * `description`, `uris`, `social`, `image_url` — none of which the
 * bot consumes. Carrying them costs:
 *   - payload bytes (the response is ~5KB/token × 200 tokens ≈ 1 MB
 *     per discovery refresh)
 *   - parse cost (`JSON.parse` + the recursive `buildStatsRecord`
 *     property reads walk every key)
 *   - cache footprint (the T46 30s-TTL discovery cache holds the
 *     same array in memory for ~30s; trimming cuts the heap by the
 *     same ~50%)
 *
 * Returns the input object reference UNCHANGED when `entry` is not
 * a non-null plain object (defensive — the caller decides what to
 * do with the non-object case). When `entry` IS a plain object,
 * returns a NEW object with only the whitelisted top-level keys,
 * and recursively rebuilds the `bcmr` sub-object to drop its
 * unused fields (the bot only reads `bcmr.name`, `bcmr.token.symbol`,
 * and `bcmr.token.decimals`).
 *
 * The whitelist is the union of every property accessed by
 * `buildStatsRecord`, `findBySymbol`, and the dashboard's
 * `projectPoolOption` (the three consumers of `listTopTokens`
 * results). Adding a new consumer? Audit the whitelist.
 *
 * Pure — no I/O. Exported for tests. NEVER throws.
 *
 * @param {unknown} entry
 * @returns {object|null}
 */
export function trimRawIndexerEntry(entry) {
  if (entry === null || entry === undefined) return undefined;
  if (typeof entry !== 'object') return undefined;
  if (Array.isArray(entry)) return undefined;
  const e = /** @type {Record<string, any>} */ (entry);
  /** @type {Record<string, any>} */
  const out = {};
  // Whitelisted top-level fields. Order matches the `RawIndexerEntry`
  // typedef in src/data/types.mjs so a casual reader can compare.
  if ('token_id' in e) out.token_id = e.token_id;
  if ('display_name' in e) out.display_name = e.display_name;
  if ('display_symbol' in e) out.display_symbol = e.display_symbol;
  // Whitelisted BCMR sub-fields. We rebuild `bcmr` from scratch so
  // the operator can see exactly what the bot consumes (and any
  // future audit can grep for the three keys below).
  const bcmrRaw = e.bcmr;
  if (bcmrRaw && typeof bcmrRaw === 'object' && !Array.isArray(bcmrRaw)) {
    /** @type {Record<string, any>} */
    const bcmrOut = {};
    if (typeof bcmrRaw.name === 'string') {
      bcmrOut.name = bcmrRaw.name;
    }
    const tok = bcmrRaw.token;
    if (tok && typeof tok === 'object' && !Array.isArray(tok)) {
      /** @type {Record<string, any>} */
      const tokOut = {};
      if ('symbol' in tok) tokOut.symbol = tok.symbol;
      if ('decimals' in tok) tokOut.decimals = tok.decimals;
      // Only emit the nested token object if it survived the
      // whitelist; otherwise skip it so the trimmed entry
      // matches `buildStatsRecord`'s `bcmr.token ?? {}` fallback.
      if (Object.keys(tokOut).length > 0) {
        bcmrOut.token = tokOut;
      }
    }
    // Drop the bcmr object entirely if nothing survived the
    // whitelist — same fallback semantics as `buildStatsRecord`.
    if (Object.keys(bcmrOut).length > 0) {
      out.bcmr = bcmrOut;
    }
  }
  // Price + change fields. Both legacy (`price_now`) and canonical
  // (`price_now_sats`) shapes — `buildStatsRecord#firstFinite`
  // handles either, so the trim keeps both.
  if ('price_now_sats' in e) out.price_now_sats = e.price_now_sats;
  if ('price_now' in e) out.price_now = e.price_now;
  if ('price_now_usd' in e) out.price_now_usd = e.price_now_usd;
  if ('price_24h_sats' in e) out.price_24h_sats = e.price_24h_sats;
  if ('price_24h' in e) out.price_24h = e.price_24h;
  if ('price_7d_sats' in e) out.price_7d_sats = e.price_7d_sats;
  if ('price_7d' in e) out.price_7d = e.price_7d;
  if ('change_24h_bp' in e) out.change_24h_bp = e.change_24h_bp;
  if ('change_24h_usd_bp' in e) out.change_24h_usd_bp = e.change_24h_usd_bp;
  if ('change_7d_bp' in e) out.change_7d_bp = e.change_7d_bp;
  if ('change_7d_usd_bp' in e) out.change_7d_usd_bp = e.change_7d_usd_bp;
  if ('trade_count' in e) out.trade_count = e.trade_count;
  if ('trade_volume_sats' in e) out.trade_volume_sats = e.trade_volume_sats;
  if ('trade_volume' in e) out.trade_volume = e.trade_volume;
  if ('volume_24h_sats' in e) out.volume_24h_sats = e.volume_24h_sats;
  if ('tvl_sats_bch' in e) out.tvl_sats_bch = e.tvl_sats_bch;
  if ('tvl_sats' in e) out.tvl_sats = e.tvl_sats;
  if ('tvl_tokens' in e) out.tvl_tokens = e.tvl_tokens;
  if ('apy_30d_bp' in e) out.apy_30d_bp = e.apy_30d_bp;
  if ('score' in e) out.score = e.score;
  if ('score_rank' in e) out.score_rank = e.score_rank;
  if ('first_pool_ts' in e) out.first_pool_ts = e.first_pool_ts;
  if ('price_series_7d' in e) out.price_series_7d = e.price_series_7d;
  return out;
}

/**
 * T77 — convenience wrapper that trims every entry in a raw
 * `RawIndexerEntry[]`. Tolerates non-array input (returns `[]`)
 * and never throws on per-entry errors. Designed for the
 * `listTopTokens` post-parse step: the caller has already validated
 * the array shape; this helper just walks it.
 *
 * Pure — no I/O. Exported for tests.
 *
 * @param {unknown} resp
 * @returns {Array<object>}
 */
export function trimRawIndexerResponse(resp) {
  if (!Array.isArray(resp)) return [];
  const out = new Array(resp.length);
  for (let i = 0; i < resp.length; i += 1) {
    const trimmed = trimRawIndexerEntry(resp[i]);
    // Defensive: trimRawIndexerEntry returns `undefined` for
    // non-objects. Keep the array 1:1 so positional indices in the
    // trim result match the original — downstream callers (the
    // ranker's `_fetchStats`) iterate by index and rely on the
    // alignment. A bad entry becomes an empty object (the `null`
    // sentinel downstream already handles missing token_id).
    out[i] = (trimmed && typeof trimmed === 'object') ? trimmed : {};
  }
  return out;
}

export const DEFAULT_FETCHER_CONFIG = Object.freeze({
  indexerBaseUrl: 'https://indexer.riften.net/cauldron',
  bcmrBaseUrl: 'https://indexer.cauldron.quest',
  userAgent: 'TradeBot/0.1 (LifestoneLabs)',
  poolCacheTtlMs: 30_000,
  statsCacheTtlMs: 60_000,
  bcmrCacheTtlMs: 5 * 60_000,
  discoveryCacheTtlMs: 30_000,
  timeoutMs: 10_000,
  maxRetries: 3,
  retryBaseMs: 250,
  retryCapMs: 4_000,
  retryJitterPct: 0.3,
  rateLimitPerSec: 5,
  rateLimitBurst: 5,
});

/**
 * Tiny per-key TTL cache. Keys are whatever the caller chooses; we
 * do not enforce key shape — just `{ value, expiresAt }`. Eviction
 * is lazy (every read checks expiry; expired entries drop on read).
 *
 * Exported for tests.
 */
export class TtlCache {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.ttlMs=30000]
   * @param {number} [opts.maxEntries=10000]
   * @param {() => number} [opts.now=Date.now]
   */
  constructor({ ttlMs = 30_000, maxEntries = 10_000, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    /** @type {Map<string, { value: unknown, expiresAt: number }>} */
    this.store = new Map();
  }
  /** @returns {unknown | undefined} */
  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }
  /** @param {string} key @param {unknown} value */
  set(key, value) {
    if (this.store.size >= this.maxEntries && !this.store.has(key)) {
      // Evict the oldest insertion. Map preserves insertion order.
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }
  /** @param {string} key */
  delete(key) { this.store.delete(key); }
  clear() { this.store.clear(); }
  get size() { return this.store.size; }
}

/**
 * Cauldron indexer client. See module header for the full contract.
 *
 * @example
 *   const log = createLogger({ component: 'fetcher' });
 *   const fetcher = new Fetcher({ logger: log });
 *   const stats = await fetcher.getTokenStats('<token_id>');
 *   const pools = await fetcher.listPools('<token_id>');
 */
export class Fetcher {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.indexerBaseUrl]
   * @param {string} [opts.bcmrBaseUrl]
   * @param {string} [opts.userAgent]
   * @param {number} [opts.poolCacheTtlMs]
   * @param {number} [opts.statsCacheTtlMs]
   * @param {number} [opts.bcmrCacheTtlMs]
   * @param {number} [opts.discoveryCacheTtlMs]
   * @param {number} [opts.timeoutMs]
   * @param {number} [opts.maxRetries]
   * @param {number} [opts.retryBaseMs]
   * @param {number} [opts.retryCapMs]
   * @param {number} [opts.retryJitterPct]
   * @param {number} [opts.rateLimitPerSec]
   * @param {number} [opts.rateLimitBurst]
   * @param {(url: string, init: RequestInit) => Promise<Response>} [opts.fetchImpl]
   * @param {import('../util/logger.mjs').Logger} [opts.logger]
   * @param {TokenBucket} [opts.bucket]
   * @param {TtlCache} [opts.poolsCache]
   * @param {TtlCache} [opts.statsCache]
   * @param {TtlCache} [opts.bcmrCache]
   * @param {TtlCache} [opts.discoveryCache]
   * @param {() => number} [opts.random=Math.random]
   * @param {Date} [opts.nowFn=Date.now]
   */
  constructor(opts = {}) {
    const cfg = { ...DEFAULT_FETCHER_CONFIG, ...opts };
    this.indexerBaseUrl = cfg.indexerBaseUrl;
    this.bcmrBaseUrl = cfg.bcmrBaseUrl;
    this.userAgent = cfg.userAgent;
    this.timeoutMs = cfg.timeoutMs;
    this.maxRetries = cfg.maxRetries;
    this.retryBaseMs = cfg.retryBaseMs;
    this.retryCapMs = cfg.retryCapMs;
    this.retryJitterPct = cfg.retryJitterPct;
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.logger = opts.logger ?? null;
    this.random = opts.random ?? Math.random;
    this.now = opts.nowFn ?? Date.now;
    this.bucket = opts.bucket ?? new TokenBucket({
      ratePerSec: cfg.rateLimitPerSec,
      burst: cfg.rateLimitBurst,
    });
    // Thread the fetcher's clock into every TtlCache so test seams
    // (opts.nowFn) drive cache expiry, not just the constructor-time
    // wall clock. Without this, a `fakeNow` test that calls
    // `listTopTokens` at t=0 and t=40s would still see the cache as
    // fresh because TtlCache.get() defaulted to Date.now() internally.
    const cacheNow = opts.nowFn ?? Date.now;
    this.poolsCache = opts.poolsCache ?? new TtlCache({ ttlMs: cfg.poolCacheTtlMs, now: cacheNow });
    this.statsCache = opts.statsCache ?? new TtlCache({ ttlMs: cfg.statsCacheTtlMs, now: cacheNow });
    this.bcmrCache = opts.bcmrCache ?? new TtlCache({ ttlMs: cfg.bcmrCacheTtlMs, now: cacheNow });
    // T46: discovery cache — covers `listTopTokens({by,order,limit})`.
    // The trading loop calls `listTopTokens(by:'tvl', order:'desc', limit:200)`
    // once per tick via `_fetchStats()`, then AGAIN N times inside
    // `getTokenStats(tokenId)` (one per candidate) with the same triple.
    // A 30s TTL collapses those N+1 fetches into 1 per tick, which is
    // roughly 60x less indexer load at the cost of seeing at most
    // 30s-stale discovery data — well within the bot's 60s poll cadence.
    this.discoveryCache = opts.discoveryCache ?? new TtlCache({ ttlMs: cfg.discoveryCacheTtlMs, now: cacheNow });

    // Tiny in-process counters for observability.
    this.metrics = {
      requests: 0,
      cacheHits: 0,
      cacheMisses: 0,
      discoveryCacheHits: 0,
      discoveryCacheMisses: 0,
      retries: 0,
      errors: 0,
      lastFetchAt: 0,
      lastError: null,
    };
  }

  // ─── diagnostics ─────────────────────────────────────────────────

  /** Snapshot of internal counters. */
  stats() {
    return { ...this.metrics };
  }

  /**
   * Invalidate a single token's cached entries. Pass `undefined` to
   * bust the discovery cache only.
   *
   * @param {string} [tokenId]
   */
  invalidate(tokenId) {
    if (!tokenId) return;
    const key = tokenId.toLowerCase();
    this.poolsCache.delete(key);
    this.statsCache.delete(key);
    this.bcmrCache.delete(key);
  }

  /** Drop every cache entry. Useful after a config reload. */
  invalidateAll() {
    this.poolsCache.clear();
    this.statsCache.clear();
    this.bcmrCache.clear();
    this.discoveryCache.clear();
  }

  // ─── public API ──────────────────────────────────────────────────

  /**
   * List active pools for one token. Returns a `Pool[]`. Cached.
   *
   * @param {string} tokenIdRaw
   * @returns {Promise<Pool[]>}
   */
  async listPools(tokenIdRaw) {
    const tokenId = requireValidTokenId(tokenIdRaw);
    const cached = this.poolsCache.get(tokenId);
    if (cached !== undefined) {
      this.metrics.cacheHits += 1;
      return /** @type {Pool[]} */ (cached);
    }
    this.metrics.cacheMisses += 1;
    const url = buildActivePoolsUrl(this.indexerBaseUrl, tokenId);
    const resp = await this.requestJson(url);
    const list = Array.isArray(resp) ? resp : (resp && Array.isArray(resp.active) ? resp.active : null);
    if (!Array.isArray(list)) {
      throw new IndexerShapeError(
        'listPools: response is not an array (and no .active field)',
        url,
        { body: resp },
      );
    }
    /** @type {Pool[]} */
    const pools = list.filter(isValidPool).map((p) => ({
      pool_id: String(p.pool_id),
      token_id: String(p.token_id).toLowerCase(),
      sats: Number(p.sats),
      tokens: /** @type {string|number|bigint} */ (p.tokens),
      owner_p2pkh_addr: String(p.owner_p2pkh_addr),
      txid: String(p.txid),
      tx_pos: Number(p.tx_pos),
    }));
    this.poolsCache.set(tokenId, pools);
    return pools;
  }

  /**
   * Compute the AMM-implied marginal buy rate (sats per BASE unit)
   * for a token. Cached via `listPools` — second call within the
   * pool-cache TTL is free.
   *
   * Used by the trading loop's pre-entry sanity check (T31) to
   * compare the indexer's reference price (`stats.price_now_sats`,
   * per DISPLAY unit) against the actual AMM-implied rate (per
   * BASE unit). The loop aligns the indexer price by multiplying
   * by 10^decimals before the ratio check; see
   * `src/trader/loop.mjs#_evaluateEntry` for that alignment.
   *
   * Returns `null` when:
   *   - the token has no active pools (truly illiquid — the swap
   *     layer would also fail), OR
   *   - every pool has zero token reserves (drained), OR
   *   - the pool list fetch fails (caller logs + proceeds without
   *     the AMM-spot guard; the exit-side guard in T28d still
   *     catches the bogus-price case after the trade).
   *
   * @param {string} tokenIdRaw
   * @returns {Promise<number|null>}
   */
  async getAmmSpotSats(tokenIdRaw) {
    // Re-validate before touching the indexer. We want a bad token_id
    // to throw UP so callers see the validation error — silently
    // returning null on a malformed id would mask programming bugs.
    // Real fetch / network errors, by contrast, return null so the
    // divergence guard can skip the candidate without blocking the
    // rest of the loop.
    const tokenId = requireValidTokenId(tokenIdRaw);
    let poolsList;
    try {
      poolsList = await this.listPools(tokenId);
    } catch (_e) {
      // Caller decides whether null is acceptable — see T31. Don't
      // mask the original error here; let the caller log structured
      // data via the loop logger. We just return null so the
      // strategy layer knows to skip the divergence check.
      return null;
    }
    return bestAmmSpotSats(poolsList);
  }

  /**
   * Compute the total BCH-side (sats) reserves across every active
   * pool for a token. Cached via `listPools` — second call within
   * the pool-cache TTL is free.
   *
   * Used by the trading loop's pre-entry illiquidity guard (T32)
   * to compare the LIVE active-pools depth against
   * `entry.min_amm_total_depth_sats`. Returns BigInt because pool
   * totals on a high-cap token can exceed `Number.MAX_SAFE_INTEGER`
   * sats; callers that need a JS number should coerce via
   * `Number(...)` after reading the result.
   *
   * Returns `null` when:
   *   - the token has no active pools (truly illiquid — the swap
   *     layer would also fail), OR
   *   - every pool entry is malformed (zero sats, negative sats,
   *     non-numeric sats — caller treats as "no depth info"
   *     and skips the guard), OR
   *   - the pool list fetch fails (caller proceeds without the
   *     depth guard; the existing `min_tvl_bch` ranker floor
   *     still screens obvious cases).
   *
   * @param {string} tokenIdRaw
   * @returns {Promise<bigint|null>}
   */
  async getAmmTotalDepthSats(tokenIdRaw) {
    // Same policy as `getAmmSpotSats`: re-validate to surface bad
    // token_ids (programmer error), swallow network errors to
    // null (the strategy layer treats null as "skip guard").
    const tokenId = requireValidTokenId(tokenIdRaw);
    let poolsList;
    try {
      poolsList = await this.listPools(tokenId);
    } catch (_e) {
      return null;
    }
    return totalAmmSats(poolsList);
  }

  /**
   * Fetch the discovery list. Returns the RAW indexer records
   * (the shape used by `getTokenStats` / `getTokenStatsBySymbol`)
   * — callers that want normalized stats should call `getTokenStats`.
   *
   * T46: result is cached for `discoveryCacheTtlMs` keyed by the
   * `{by,order,limit}` triple. A second call with the same triple
   * inside the TTL window returns the cached array without
   * touching the network. The trading loop's `_fetchStats` +
   * per-candidate `getTokenStats` calls share one entry per tick
   * (all use `by:'tvl', order:'desc', limit:200` by default).
   *
   * @param {{ by?: string, order?: 'asc'|'desc', limit?: number }} [opts]
   * @returns {Promise<RawIndexerEntry[]>}
   */
  async listTopTokens(opts = {}) {
    // Mirror `buildDiscoveryUrl`'s normalization so the cache key
    // matches the URL the indexer actually sees — otherwise a caller
    // passing `order:'DESC'` and another passing `order:'desc'`
    // would silently miss each other's cache entry.
    const key = discoveryCacheKey(opts);
    const cached = this.discoveryCache.get(key);
    if (cached !== undefined) {
      this.metrics.discoveryCacheHits += 1;
      return /** @type {RawIndexerEntry[]} */ (cached);
    }
    this.metrics.discoveryCacheMisses += 1;
    const url = buildDiscoveryUrl(this.indexerBaseUrl, opts);
    const resp = await this.requestJson(url);
    if (!Array.isArray(resp)) {
      throw new IndexerShapeError(
        `listTopTokens: response is not an array (got ${typeof resp})`,
        url,
        { body: resp },
      );
    }
    // T77: trim each entry to the bot's actually-consumed field
    // set BEFORE the cache write. Caches the trimmed array (so
    // subsequent cache hits serve the smaller object too) and
    // surfaces the same trimmed array to all downstream callers
    // (the trader loop's `_fetchStats`, the dashboard's
    // `getPoolsTop`, `findBySymbol`, etc.). Whitelisted in
    // `trimRawIndexerEntry`; audited against `buildStatsRecord`,
    // `findBySymbol`, and `projectPoolOption` — the three known
    // consumers of `listTopTokens` results.
    const trimmed = trimRawIndexerResponse(resp);
    this.discoveryCache.set(key, trimmed);
    return /** @type {RawIndexerEntry[]} */ (trimmed);
  }

  /**
   * Resolve a token_id → normalized `PoolStats`. Cached.
   *
   * @param {string} tokenIdRaw
   * @returns {Promise<PoolStats>}
   */
  async getTokenStats(tokenIdRaw) {
    const tokenId = requireValidTokenId(tokenIdRaw);
    const cached = this.statsCache.get(tokenId);
    if (cached !== undefined) {
      this.metrics.cacheHits += 1;
      return /** @type {PoolStats} */ (cached);
    }
    this.metrics.cacheMisses += 1;
    const records = await this.listTopTokens({ by: 'tvl', order: 'desc', limit: 200 });
    const entry = findByTokenId(records, tokenId);
    if (!entry) {
      throw new IndexerShapeError(
        `getTokenStats: token_id ${tokenId} not found in top-200 by TVL`,
        this.indexerBaseUrl + '/tokens/list_cached',
        { body: records.length },
      );
    }
    const stats = buildStatsRecord(entry);
    if (!isValidPoolStats(stats)) {
      throw new IndexerShapeError(
        'getTokenStats: normalized record missing token_id',
        this.indexerBaseUrl + '/tokens/list_cached',
        { body: stats },
      );
    }
    this.statsCache.set(tokenId, stats);
    return stats;
  }

  /**
   * Resolve a token symbol (e.g. "PUSD") → normalized `PoolStats`.
   *
   * @param {string} symbol
   * @returns {Promise<PoolStats>}
   */
  async getTokenStatsBySymbol(symbol) {
    if (typeof symbol !== 'string' || !symbol.trim()) {
      throw new TypeError(`getTokenStatsBySymbol: bad symbol (${String(symbol).slice(0, 16)}…)`);
    }
    const records = await this.listTopTokens({ by: 'tvl', order: 'desc', limit: 200 });
    const entry = findBySymbol(records, symbol);
    if (!entry) {
      throw new IndexerShapeError(
        `getTokenStatsBySymbol: symbol "${symbol}" not found in top-200 by TVL`,
        this.indexerBaseUrl + '/tokens/list_cached',
        { body: records.length },
      );
    }
    return buildStatsRecord(entry);
  }

  /**
   * Resolve a token_id → BCMR metadata (`Token`). Cached. Returns
   * `null` for tokens without an authchain commitment (the indexer
   * returns HTTP 200 with body `null` for those — see the SKILL.md
   * "Path quirk" note).
   *
   * @param {string} tokenIdRaw
   * @returns {Promise<Token | null>}
   */
  async getBcmr(tokenIdRaw) {
    const tokenId = requireValidTokenId(tokenIdRaw);
    const cached = this.bcmrCache.get(tokenId);
    if (cached !== undefined) {
      this.metrics.cacheHits += 1;
      return /** @type {Token | null} */ (cached);
    }
    this.metrics.cacheMisses += 1;
    const url = buildBcmrUrl(this.bcmrBaseUrl, tokenId);
    let resp;
    try {
      resp = await this.requestJson(url);
    } catch (e) {
      if (e instanceof IndexerHttpError && e.status === 404) {
        // 404 on BCMR is "no authchain", not "indexer broken".
        this.bcmrCache.set(tokenId, null);
        return null;
      }
      throw e;
    }
    if (resp === null) {
      this.bcmrCache.set(tokenId, null);
      return null;
    }
    if (!resp || typeof resp !== 'object') {
      throw new IndexerShapeError(
        `getBcmr: unexpected BCMR body shape (${typeof resp})`,
        url,
        { body: resp },
      );
    }
    const token = /** @type {Record<string, any>} */ (resp).token ?? {};
    const out = /** @type {Token} */ ({
      token_id: tokenId,
      name: token.name ?? undefined,
      symbol: token.symbol ?? undefined,
      decimals: typeof token.decimals === 'number' ? token.decimals : undefined,
      description: token.description ?? undefined,
      uris: Array.isArray(token.uris) ? token.uris : undefined,
    });
    this.bcmrCache.set(tokenId, out);
    return out;
  }

  // ─── internal HTTP plumbing ──────────────────────────────────────

  /**
   * Fetch + parse JSON with timeout, retry, and rate-limit. The
   * single chokepoint for every indexer call.
   *
   * @param {string} url
   * @returns {Promise<unknown>}
   */
  async requestJson(url) {
    await this.bucket.acquire();
    this.metrics.requests += 1;
    let lastErr = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error('timeout')), this.timeoutMs);
      try {
        const resp = await this.fetchImpl(url, {
          method: 'GET',
          signal: ac.signal,
          headers: { 'user-agent': this.userAgent, 'accept': 'application/json' },
        });
        const status = resp.status;
        const text = await resp.text();
        if (status >= 200 && status < 300) {
          try { return JSON.parse(text); }
          catch (e) {
            throw new IndexerShapeError(
              `requestJson: invalid JSON body (${e.message})`,
              url,
              { body: text.slice(0, 500) },
            );
          }
        }
        throw new IndexerHttpError(status, url, text);
      } catch (e) {
        lastErr = e;
        this.metrics.errors += 1;
        this.metrics.lastError = { name: e?.name ?? 'Error', message: e?.message ?? String(e) };
        // Distinguish timeout vs shape vs http vs network.
        const wrapped = (e instanceof IndexerError)
          ? e
          : (e?.name === 'AbortError' || /aborted|abort/i.test(String(e?.message)))
            ? new IndexerTimeoutError(this.timeoutMs, url)
            : new IndexerError(`requestJson: ${e?.message ?? e}`, url, { cause: e });
        if (attempt < this.maxRetries && isRetryable(wrapped)) {
          this.metrics.retries += 1;
          this.logRetry(url, attempt, wrapped);
          await backoffDelay({
            attempt,
            baseMs: this.retryBaseMs,
            capMs: this.retryCapMs,
            jitterPct: this.retryJitterPct,
            random: this.random,
          });
          continue;
        }
        throw wrapped;
      } finally {
        clearTimeout(timer);
      }
    }
    // Defensive — the loop always returns or throws.
    /* c8 ignore next 3 */
    throw /** @type {IndexerError} */ (lastErr);
  }

  /** @param {string} url @param {number} attempt @param {Error} err */
  logRetry(url, attempt, err) {
    if (!this.logger) return;
    this.logger.warn('indexer retry', {
      url,
      attempt: attempt + 1,
      err_name: err.name,
      err_message: err.message,
    });
  }
}

/**
 * Default fetcher config — used when the bot's main loop wants
 * "sane defaults" without importing `DEFAULT_FETCHER_CONFIG`.
 *
 * @param {Object} [overrides]
 * @returns {Fetcher}
 */
export function createFetcher(overrides = {}) {
  return new Fetcher(overrides);
}

// Re-export the sats → BCH helper so callers can pull both helpers
// from the same module without a second import.
export { bchFromSats };
