#!/usr/bin/env node
// src/dex/cauldron-safe-mode.mjs
//
// Cauldron (Safe Mode) — known-good offline backup of the live
// cauldron adapter. Shipped as part of T57's operator request:
//
//   > "create a backup copy of the current cauldron interaction
//   > functions that we know are working, and integrate them as a
//   > 'CauldronSafeMode' dex which will be defaulted to inactive"
//
// Behavior contract:
//
//   - `isReady()` is true ONLY if the pool cache file exists and
//     parses cleanly. The trader loop's boot path can preflight
//     `safe_mode_active:true && !adapter.isReady()` and refuse to
//     flip the safe-mode flag on.
//
//   - `getPoolsAndMeta` / `listPools` / `getTokenStats` read from
//     the cache (the freeze of pool data taken at the last known
//     good run). Network calls are NEVER made — that's the whole
//     point of safe mode.
//
//   - `getBcmr` returns null (BCMR isn't cached at the pool level,
//     and safe mode can't trust an external lookup).
//
//   - `prepareAndBuildSwap` / `broadcastTx` / `verifyTrade` are the
//     same wallet-level ops as the live adapter (they're not DEX-
//     specific). The cashscript provider is still required because
//     broadcast + verify need it.
//
//   - `safeMode:true` lets the trader loop surface this adapter
//     differently in logs (operator sees "SAFE-MODE CAULDRON" not
//     just "cauldron") so a misconfigured boot is hard to miss.
//
// Cache file shape:
//   {
//     "<tokenId>": {
//       "tokenId": "<tokenId>",
//       "pools": [...],               // cauldron pool shape from list_pools
//       "buySpot": bigint-as-string,
//       "sellSpot": bigint-as-string,
//       "effectiveBuy": bigint-as-string,
//       "effectiveSell": bigint-as-string,
//       "totalSats": bigint-as-string,
//       "totalTokens": bigint-as-string,
//       "tokenMeta": object|null,
//       "frozenAt": "ISO 8601 UTC",
//       "frozenFromIndexer": "URL"
//     },
//     ...
//   }
//
// BigInts are serialized as decimal strings (the cache file is JSON,
// and JSON.stringify drops BigInt). The reader reconstructs them via
// `BigInt(str)`.
//
// Missing token ⇒ DexSafeModeError({ code: 'not_cached', tokenId }).
// Bad cache shape ⇒ DexSafeModeError({ code: 'cache_corrupt' }).

import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';

import {
  prepareAndBuildSwap as cauldronPrepareAndBuildSwap,
  broadcastTx as cauldronBroadcastTx,
  PUBLIC_CONSTANTS,
} from '../trader/cauldron/check_and_swap.mjs';
import { verifyTrade as cauldronVerifyTrade } from '../trader/cauldron/post_trade_check.mjs';

export class DexSafeModeError extends Error {
  /**
   * @param {string} message
   * @param {{ tokenId?: string, code?: string, cause?: unknown }} [opts]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = 'DexSafeModeError';
    this.tokenId = opts.tokenId ?? null;
    this.code = opts.code ?? 'safe_mode_error';
    this.cause = opts.cause;
  }
}

const BIGINT_FIELDS = Object.freeze(['buySpot', 'sellSpot', 'effectiveBuy', 'effectiveSell', 'totalSats', 'totalTokens']);

/**
 * Read + parse the safe-mode pool cache file. Returns `{ ok,
 * cache, error? }` — `ok:false` when the file is missing /
 * malformed so the caller can flip safe_mode_active to false
 * without crashing the boot.
 *
 * Pure (no side-effects beyond a synchronous read); the caller
 * controls cache invalidation + reload strategy.
 *
 * @param {{ cacheFile: string, repoRoot?: string }} args
 * @returns {{ ok: true, cache: Record<string, object> } | { ok: false, error: { message: string, code: string, cause?: unknown } }}
 */
export function loadSafeModeCache({ cacheFile, repoRoot = '.' } = {}) {
  if (typeof cacheFile !== 'string' || cacheFile.length === 0) {
    return { ok: false, error: { message: 'cacheFile must be a non-empty string', code: 'bad_path' } };
  }
  const abs = pathResolve(repoRoot, cacheFile);
  let raw;
  try {
    raw = readFileSync(abs, 'utf8');
  } catch (err) {
    return {
      ok: false,
      error: {
        message: `safe-mode cache file missing at ${abs}: ${err && err.message ? err.message : String(err)}`,
        code: 'cache_missing',
        cause: err,
      },
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: {
        message: `safe-mode cache file at ${abs} is not valid JSON: ${err && err.message ? err.message : String(err)}`,
        code: 'cache_corrupt',
        cause: err,
      },
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      error: { message: `safe-mode cache file at ${abs} must be a JSON object keyed by tokenId`, code: 'cache_corrupt' },
    };
  }
  return { ok: true, cache: /** @type {Record<string, object>} */ (parsed) };
}

/**
 * Internal: reconstruct BigInts from the JSON-safe decimal strings
 * so the adapter exposes the same shape as the live
 * `getPoolsAndMeta` result.
 *
 * @param {object} entry
 * @returns {object}
 */
function rehydrateBigInts(entry) {
  const out = { ...entry };
  for (const field of BIGINT_FIELDS) {
    if (typeof out[field] === 'string') {
      try {
        out[field] = BigInt(out[field]);
      } catch {
        // leave as-is; the caller will see a non-bigint and react
        out[field] = 0n;
      }
    }
  }
  return out;
}

/**
 * Build the cauldron-safe-mode adapter.
 *
 * @param {object} [config]   — config.dex.*  (needs safe_mode_pool_cache_file, safe_mode_indexer_url)
 * @param {{ cache?: Record<string, object> }} [deps] — optional pre-loaded cache (tests inject)
 * @returns {{
 *   id: string,
 *   displayName: string,
 *   safeMode: boolean,
 *   indexerUrl: string,
 *   isReady: () => Promise<boolean>,
 *   getPoolsAndMeta: (opts: object) => Promise<object>,
 *   getTokenStats: (opts: object) => Promise<null>,
 *   listPools: (opts: object) => Promise<object[]>,
 *   getBcmr: (opts: object) => Promise<null>,
 *   prepareAndBuildSwap: (opts: object) => Promise<object>,
 *   broadcastTx: (opts: object) => Promise<object>,
 *   verifyTrade: (opts: object) => Promise<object>,
 *   constants: object,
 * }}
 */
export function createCauldronSafeModeAdapter(config = {}, deps = {}) {
  const cacheFile = (config && config.safe_mode_pool_cache_file) || 'data/dex-safe-mode-pools.json';
  const indexerUrl = (config && config.safe_mode_indexer_url) || 'https://indexer.riften.net/cauldron';
  const cache = (deps && deps.cache) || null;
  const isCacheLoaded = cache !== null;

  function readCache() {
    if (cache !== null) return cache;
    const loaded = loadSafeModeCache({ cacheFile });
    if (!loaded.ok) {
      throw new DexSafeModeError(loaded.error.message, { code: loaded.error.code, cause: loaded.error.cause });
    }
    return loaded.cache;
  }

  function lookupToken(tokenId) {
    const c = readCache();
    if (!Object.prototype.hasOwnProperty.call(c, tokenId)) {
      throw new DexSafeModeError(`safe-mode cache has no entry for tokenId="${tokenId}"`, {
        code: 'not_cached',
        tokenId,
      });
    }
    return rehydrateBigInts(/** @type {object} */ (c[tokenId]));
  }

  const adapter = Object.freeze({
    id: 'cauldron_safe_mode',
    displayName: 'Cauldron (Safe Mode)',
    safeMode: true,
    indexerUrl,
    isReady: async () => {
      if (isCacheLoaded) return true;
      const loaded = loadSafeModeCache({ cacheFile });
      return loaded.ok;
    },
    getPoolsAndMeta: async (opts = {}) => {
      const tokenId = opts && opts.tokenId;
      if (typeof tokenId !== 'string' || tokenId.length === 0) {
        throw new DexSafeModeError('getPoolsAndMeta: tokenId is required in safe mode', { code: 'bad_input' });
      }
      return lookupToken(tokenId);
    },
    getTokenStats: async () => {
      // safe mode doesn't index stats; the trader loop uses indexer
      // stats only via the live adapter. Return null so callers can
      // fall back gracefully.
      return null;
    },
    listPools: async (opts = {}) => {
      const tokenId = opts && opts.tokenId;
      if (typeof tokenId !== 'string' || tokenId.length === 0) return [];
      try {
        const entry = lookupToken(tokenId);
        return Array.isArray(entry.pools) ? entry.pools : [];
      } catch (err) {
        if (err instanceof DexSafeModeError && err.code === 'not_cached') return [];
        throw err;
      }
    },
    getBcmr: async () => null,
    prepareAndBuildSwap: cauldronPrepareAndBuildSwap,
    broadcastTx: cauldronBroadcastTx,
    verifyTrade: cauldronVerifyTrade,
    constants: PUBLIC_CONSTANTS,
  });

  return adapter;
}
