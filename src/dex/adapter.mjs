#!/usr/bin/env node
// src/dex/adapter.mjs
//
// Pure DEX-adapter abstraction for TradeBot.
//
// The T57 plan ("Add second DEX") is to make cauldron just one of N
// interchangeable DEX adapters. The actual guanaco DEX integration
// lands in a future tick; this module ships the scaffold every
// future adapter will plug into.
//
// Adapter contract — every adapter exposes:
//
//   {
//     id:            string,           // stable identifier ('cauldron', 'cauldron_safe_mode', ...)
//     displayName:   string,           // human-readable ('Cauldron', 'Cauldron (Safe Mode)', ...)
//     safeMode:      boolean,          // true ⇒ adapter is a known-good offline backup
//     indexerUrl:    string,           // base URL the adapter talks to (logs + diagnostics)
//     isReady:       async () => bool,
//     getPoolsAndMeta:   async (opts) => poolsAndMeta,
//     getTokenStats:     async (opts) => stats|null,
//     listPools:         async (opts) => pools[],
//     getBcmr:           async (opts) => bcmr|null,
//     prepareAndBuildSwap: async (opts) => { txHex, ... },
//     broadcastTx:       async (opts) => { txid },
//     verifyTrade:       async (opts) => { ok, ... },
//     constants:         object,       // PUBLIC_CONSTANTS (DUST_SATS, BASE_TX_OVERHEAD_SATS, SATS_PER_BYTE, POOL_BYTES)
//   }
//
// The factory `createDexAdapter({ id, config, deps })` is the single
// seam: pass an id, get an adapter back. Unknown id ⇒ DexAdapterError.
//
// The registry `DEX_REGISTRY` enumerates every adapter id the bot
// knows about (whether or not it's enabled in `dex.active`).
//
// Config knobs (config/default.json `dex.*`):
//
//   active:                   string[]  — adapter ids that are live
//   safe_mode_active:         boolean   — whether to also boot cauldron_safe_mode
//   safe_mode_pool_cache_file: string   — path to a JSON map {tokenId: poolsAndMeta}
//   safe_mode_indexer_url:     string   — indexer URL safe-mode was frozen from
//
// All knobs are typed and defaulted via `resolveDexConfig(cfg)`. The
// `resolveDexConfig` shape mirrors the rest of the config layer
// (typed result, `ok:false` on bad input, no throw).
//
// What this module does NOT do:
//   - Wire adapters into src/trader/swap.mjs (deferred — the adapter
//     is consumed by the trader loop's multi-DEX routing layer; that
//     lands in the next T57 subset).
//   - Add the Settings UI toggle (deferred — the dashboard settings
//     editor surfaces this in a follow-up).
//   - Integrate the actual guanaco DEX (deferred — that's the
//     `feat(T57-2)` follow-up once the scaffold lands).

import { createCauldronAdapter } from './cauldron.mjs';
import { createCauldronSafeModeAdapter } from './cauldron-safe-mode.mjs';
import { createGuanacoAdapter } from './guanaco.mjs';
import { DexAdapterError } from './errors.mjs';

// Re-export DexAdapterError from the shared errors module so every
// existing `import { DexAdapterError } from '../dex/adapter.mjs'`
// (e.g. tests/dex-adapter.test.mjs) keeps working. The canonical
// home is `./errors.mjs` to avoid the circular dependency that
// happens when guanaco.mjs subclasses DexAdapterError and is in
// turn imported by adapter.mjs to register the factory.

export { DexAdapterError };

// ─────────────────────────────────────────────────────────────────────
//  Registry
// ─────────────────────────────────────────────────────────────────────

/**
 * Every adapter id the bot knows about. Frozen so consumers can't
 * mutate the registry at runtime. Adding a new adapter = adding an
 * entry here + writing a factory under src/dex/<id>.mjs.
 *
 * @type {Readonly<Record<string, { displayName: string, safeMode: boolean, factory: (config: object, deps: object) => object }>>}
 */
export const DEX_REGISTRY = Object.freeze({
  cauldron: Object.freeze({
    displayName: 'Cauldron',
    safeMode: false,
    factory: createCauldronAdapter,
  }),
  cauldron_safe_mode: Object.freeze({
    displayName: 'Cauldron (Safe Mode)',
    safeMode: true,
    factory: createCauldronSafeModeAdapter,
  }),
  guanaco: Object.freeze({
    displayName: 'Guanaco',
    safeMode: false,
    factory: createGuanacoAdapter,
  }),
});

/**
 * List every known adapter id. Useful for the Settings view to render
 * the toggle list (the operator can see what's installed but only
 * `dex.active` ids get wired into the trader loop).
 *
 * @returns {string[]}
 */
export function listKnownDexIds() {
  return Object.freeze(Object.keys(DEX_REGISTRY));
}

/**
 * Type-guard: is `id` a known adapter id?
 *
 * @param {unknown} id
 * @returns {boolean}
 */
export function isKnownDexId(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(DEX_REGISTRY, id);
}

/**
 * Look up a registry entry by id. Returns null when the id isn't
 * registered — callers (createDexAdapter, settings view) can decide
 * how to handle the miss.
 *
 * @param {unknown} id
 * @returns {{ displayName: string, safeMode: boolean, factory: Function } | null}
 */
export function lookupDexRegistryEntry(id) {
  if (!isKnownDexId(id)) return null;
  const entry = DEX_REGISTRY[/** @type {string} */ (id)];
  return {
    displayName: entry.displayName,
    safeMode: entry.safeMode,
    factory: entry.factory,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Factory
// ─────────────────────────────────────────────────────────────────────

/**
 * Instantiate a DEX adapter by id.
 *
 * Typed Result envelope: returns either `{ ok:true, adapter }` or
 * `{ ok:false, error: { message, code } }`. Never throws on bad
 * input — bad input is a typed `ok:false` so the trader loop can log
 * + continue without crashing the tick.
 *
 * @param {{ id: string, config?: object, deps?: object }} args
 * @returns {{ ok: true, adapter: object } | { ok: false, error: { message: string, code: string } }}
 */
export function createDexAdapter({ id, config = {}, deps = {} } = {}) {
  if (typeof id !== 'string' || id.length === 0) {
    return {
      ok: false,
      error: { message: 'createDexAdapter: id must be a non-empty string', code: 'bad_id' },
    };
  }
  const entry = lookupDexRegistryEntry(id);
  if (entry === null) {
    return {
      ok: false,
      error: {
        message: `createDexAdapter: unknown dex id "${id}" (known: ${listKnownDexIds().join(', ')})`,
        code: 'unknown_id',
      },
    };
  }
  try {
    const adapter = entry.factory(config, deps);
    return { ok: true, adapter };
  } catch (err) {
    return {
      ok: false,
      error: {
        message: `createDexAdapter: factory for "${id}" threw: ${err && err.message ? err.message : String(err)}`,
        code: 'factory_threw',
      },
    };
  }
}

/**
 * Boot every adapter in `dex.active`. Returns a typed `{ ok,
 * adapters }` envelope — adapters that failed to boot are returned
 * in `failed` (so the trader loop can log + skip them without
 * aborting the whole tick).
 *
 * Order: `dex.active` order is preserved. `safe_mode_active:true`
 * additionally appends `cauldron_safe_mode` if it's not already in
 * `active` (idempotent — duplicates are filtered).
 *
 * @param {{ active: string[], safeModeActive: boolean }} resolveResult  — output of resolveDexConfig
 * @param {{ config: object, deps: object }} [bootOpts]
 * @returns {{
 *   ok: boolean,
 *   adapters: object[],
 *   failed: Array<{ id: string, message: string, code: string }>,
 * }}
 */
export function bootDexAdapters(resolveResult, bootOpts = {}) {
  const config = bootOpts.config ?? {};
  const deps = bootOpts.deps ?? {};
  const requested = new Set(resolveResult.active);
  if (resolveResult.safeModeActive) requested.add('cauldron_safe_mode');
  const adapters = [];
  const failed = [];
  for (const id of resolveResult.active) {
    if (!requested.has(id)) continue;
    requested.delete(id);
    const result = createDexAdapter({ id, config, deps });
    if (result.ok) {
      adapters.push(result.adapter);
    } else {
      failed.push({ id, message: result.error.message, code: result.error.code });
    }
  }
  // Any leftover ids (added by safeModeActive) get booted too.
  for (const id of requested) {
    const result = createDexAdapter({ id, config, deps });
    if (result.ok) {
      adapters.push(result.adapter);
    } else {
      failed.push({ id, message: result.error.message, code: result.error.code });
    }
  }
  return { ok: failed.length === 0, adapters, failed };
}

// ─────────────────────────────────────────────────────────────────────
//  Config resolution
// ─────────────────────────────────────────────────────────────────────

export const DEFAULT_DEX_CONFIG = Object.freeze({
  active: Object.freeze(['cauldron']),
  safeModeActive: false,
  safeModePoolCacheFile: 'data/dex-safe-mode-pools.json',
  safeModeIndexerUrl: 'https://indexer.riften.net/cauldron',
});

/**
 * Validate + normalize a `dex.*` config block. Pure. Returns a
 * typed `{ ok, normalized }` envelope (or `{ ok:false, error }`).
 *
 * @param {unknown} cfg
 * @returns {{ ok: true, normalized: { active: string[], safeModeActive: boolean, safeModePoolCacheFile: string, safeModeIndexerUrl: string } } | { ok: false, error: { message: string, code: string, path?: string } }}
 */
export function resolveDexConfig(cfg) {
  if (cfg === undefined || cfg === null) {
    return {
      ok: true,
      normalized: {
        active: [...DEFAULT_DEX_CONFIG.active],
        safeModeActive: DEFAULT_DEX_CONFIG.safeModeActive,
        safeModePoolCacheFile: DEFAULT_DEX_CONFIG.safeModePoolCacheFile,
        safeModeIndexerUrl: DEFAULT_DEX_CONFIG.safeModeIndexerUrl,
      },
    };
  }
  if (typeof cfg !== 'object') {
    return { ok: false, error: { message: 'dex config must be an object', code: 'wrong_type', path: 'dex' } };
  }
  const o = /** @type {Record<string, unknown>} */ (cfg);
  const out = {
    active: [...DEFAULT_DEX_CONFIG.active],
    safeModeActive: DEFAULT_DEX_CONFIG.safeModeActive,
    safeModePoolCacheFile: DEFAULT_DEX_CONFIG.safeModePoolCacheFile,
    safeModeIndexerUrl: DEFAULT_DEX_CONFIG.safeModeIndexerUrl,
  };

  if (o.active !== undefined) {
    if (!Array.isArray(o.active)) {
      return { ok: false, error: { message: 'dex.active must be an array of strings', code: 'wrong_type', path: 'dex.active' } };
    }
    const cleaned = [];
    for (const [idx, v] of o.active.entries()) {
      if (typeof v !== 'string' || v.length === 0) {
        return {
          ok: false,
          error: { message: `dex.active[${idx}] must be a non-empty string`, code: 'wrong_type', path: `dex.active[${idx}]` },
        };
      }
      if (!isKnownDexId(v)) {
        return {
          ok: false,
          error: {
            message: `dex.active[${idx}] = "${v}" is not a known dex id (known: ${listKnownDexIds().join(', ')})`,
            code: 'unknown_id',
            path: `dex.active[${idx}]`,
          },
        };
      }
      cleaned.push(v);
    }
    if (cleaned.length === 0) {
      return { ok: false, error: { message: 'dex.active must contain at least one dex id', code: 'empty_array', path: 'dex.active' } };
    }
    out.active = cleaned;
  }

  if (o.safe_mode_active !== undefined) {
    if (typeof o.safe_mode_active !== 'boolean') {
      return {
        ok: false,
        error: { message: 'dex.safe_mode_active must be a boolean', code: 'wrong_type', path: 'dex.safe_mode_active' },
      };
    }
    out.safeModeActive = o.safe_mode_active;
  }

  if (o.safe_mode_pool_cache_file !== undefined) {
    if (typeof o.safe_mode_pool_cache_file !== 'string' || o.safe_mode_pool_cache_file.length === 0) {
      return {
        ok: false,
        error: { message: 'dex.safe_mode_pool_cache_file must be a non-empty string', code: 'wrong_type', path: 'dex.safe_mode_pool_cache_file' },
      };
    }
    out.safeModePoolCacheFile = o.safe_mode_pool_cache_file;
  }

  if (o.safe_mode_indexer_url !== undefined) {
    if (typeof o.safe_mode_indexer_url !== 'string' || o.safe_mode_indexer_url.length === 0) {
      return {
        ok: false,
        error: { message: 'dex.safe_mode_indexer_url must be a non-empty string', code: 'wrong_type', path: 'dex.safe_mode_indexer_url' },
      };
    }
    out.safeModeIndexerUrl = o.safe_mode_indexer_url;
  }

  return { ok: true, normalized: out };
}
