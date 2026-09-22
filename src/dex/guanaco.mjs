#!/usr/bin/env node
// src/dex/guanaco.mjs
//
// Guanaco DEX adapter — the second adapter the operator filed in
// `data/feature-ideas.json#idea_operator_add-second-dex_20260917`.
//
// Status (T57-2, 2026-09-18): SCAFFOLD ONLY. The guanaco team
// publishes:
//   - High-level CashScript source at
//     https://github.com/guanaco-fi/docs/blob/main/contract/GuanacoV1.cash
//   - A symbolic CashAssembly listing at
//     https://github.com/guanaco-fi/docs/blob/main/contract/GuanacoV1-CashAssembly.md
//     (with explicit warning that "CashScript compiler output is
//     not byte-for-byte identical to the optimized production
//     redeem script and must not be used to calculate production
//     contract addresses")
//   - A fixed V1 buyback-and-burn P2PKH destination
//     (bitcoincash:qp6gu00lmsdtwfhg6lvd8q09vq6gw8lxyvgnr3603l,
//      PKH 748e3dffdc1ab726e8d7d8d381e56034871fe623)
//   - Four fee tiers (0.01% / 0.05% / 0.3% / 1%) baked into each
//     pool's redeem script.
//
// What's MISSING (and the reason this is a scaffold, not a
// working adapter):
//   - NO public indexer URL. guanaco.fi exposes a consumer UI but
//     there is no `indexer.guanaco.fi` or analogous REST API
//     documented, so the bot cannot enumerate pool UTXOs.
//   - NO published JS/TS SDK. Without one, the bot has no way to
//     build a swap transaction that produces the correct
//     production redeem script. The docs explicitly forbid
//     using the cashscript compiler output to compute production
//     pool addresses.
//
// When both land, the operator sets:
//
//   dex.guanaco.indexer_url = "https://indexer.guanaco.fi/v1"
//   dex.guanaco.default_fee_tier = 1
//   dex.active = ["cauldron", "guanaco"]
//
// and T57-2.2 (a future tick) wires `getPoolsAndMeta` +
// `prepareAndBuildSwap` + `broadcastTx` + `verifyTrade` against
// the SDK.
//
// In the meantime: `isReady()` returns true only when
// `dex.guanaco.indexer_url` AND `dex.guanaco.sdk_module` are
// both configured. Every other method throws
// `GuanacoNotImplementedError('pending_public_indexer_and_sdk')`
// — typed, no silent swallow, the trader loop's `bootDexAdapters`
// surfaces the failure cleanly via the `failed[]` array.
//
// Adapter contract (mirrors `src/dex/adapter.mjs`):
//
//   {
//     id:            'guanaco',
//     displayName:   'Guanaco',
//     safeMode:      false,
//     indexerUrl:    string|null,
//     isReady:       async () => bool,
//     getPoolsAndMeta:     async (opts) => throws GuanacoNotImplementedError,
//     getTokenStats:       async (opts) => throws GuanacoNotImplementedError,
//     listPools:           async (opts) => throws GuanacoNotImplementedError,
//     getBcmr:             async (opts) => throws GuanacoNotImplementedError,
//     prepareAndBuildSwap: async (opts) => throws GuanacoNotImplementedError,
//     broadcastTx:         async (opts) => throws GuanacoNotImplementedError,
//     verifyTrade:         async (opts) => throws GuanacoNotImplementedError,
//     constants:           { FEE_TIERS, BUYBACK_PKH, BUYBACK_LOCKING_BYTECODE },
//   }

import { DexAdapterError } from './errors.mjs';

// ─────────────────────────────────────────────────────────────────────
//  Errors
// ─────────────────────────────────────────────────────────────────────

/**
 * The operator flipped `dex.active` to include "guanaco" but did
 * not configure `dex.guanaco.indexer_url` (or `dex.guanaco.sdk_module`).
 * Distinct from `GuanacoNotImplementedError` so the trader loop can
 * log "missing config" separately from "feature pending external work".
 */
export class GuanacoNotConfiguredError extends DexAdapterError {
  /**
   * @param {string} message
   * @param {{ id?: string, cause?: unknown, code?: string, missing?: string[] }} [opts]
   */
  constructor(message, opts = {}) {
    super(message, { ...opts, code: opts.code ?? 'guanaco_not_configured' });
    this.name = 'GuanacoNotConfiguredError';
    this.missing = opts.missing ?? [];
  }
}

/**
 * A method that needs a public guanaco indexer + JS SDK (neither
 * of which the team has shipped) was called. The adapter exists
 * so the registry / Settings UI can render + future SDK work has
 * a typed surface to plug into; the bot will never actually call
 * these methods because `isReady()` returns false until both
 * dependencies land.
 */
export class GuanacoNotImplementedError extends DexAdapterError {
  /**
   * @param {string} message
   * @param {{ id?: string, cause?: unknown, code?: string }} [opts]
   */
  constructor(message, opts = {}) {
    super(message, { ...opts, code: opts.code ?? 'guanaco_not_implemented' });
    this.name = 'GuanacoNotImplementedError';
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Constants — fixed by the V1 covenant, NOT operator-tunable
// ─────────────────────────────────────────────────────────────────────

/**
 * Fixed V1 buyback-and-burn destination PKH from
 * https://github.com/guanaco-fi/docs/blob/main/contract (the
 * "Address / Public-key hash" section). The covenant enforces
 * this as the only valid allocation locking bytecode.
 *
 * Note: this is the PAY TO PUBKEY HASH (20 bytes, hex). The
 * full `bitcoincash:qp6gu00lmsdtwfhg6lvd8q09vq6gw8lxyvgnr3603l`
 * cashaddr resolves to this PKH.
 *
 * @type {Readonly<string>}
 */
export const GUANACO_BUYBACK_PKH = Object.freeze('748e3dffdc1ab726e8d7d8d381e56034871fe623');

/**
 * The fixed P2PKH locking bytecode the V1 covenant enforces for
 * the allocation output (per the V1 CashAssembly doc):
 *   76a914 748e3dffdc1ab726e8d7d8d381e56034871fe623 88ac
 *
 * @type {Readonly<string>}
 */
export const GUANACO_BUYBACK_LOCKING_BYTECODE = Object.freeze(
  '76a914748e3dffdc1ab726e8d7d8d381e56034871fe62388ac'
);

/**
 * The four V1 fee tiers. Frozen — the redeem script size depends
 * on which tier the pool was created at, and the operator can
 * only select among these four. The fee tier is a per-pool
 * property set at pool creation; this table is just the catalog
 * of valid values the `default_fee_tier` knob accepts.
 *
 * @type {Readonly<Array<{ level: number, feePct: number, numerator: number, denominator: number, redeemScriptBytes: number }>>}
 */
export const GUANACO_FEE_TIERS = Object.freeze([
  Object.freeze({ level: 0, feePct: 0.01, numerator: 1, denominator: 10_000, redeemScriptBytes: 109 }),
  Object.freeze({ level: 1, feePct: 0.05, numerator: 5, denominator: 10_000, redeemScriptBytes: 111 }),
  Object.freeze({ level: 2, feePct: 0.30, numerator: 3, denominator: 1_000, redeemScriptBytes: 111 }),
  Object.freeze({ level: 3, feePct: 1.00, numerator: 1, denominator: 100, redeemScriptBytes: 108 }),
]);

/**
 * Look up a fee tier by `level` (0..3). Returns null on miss so
 * callers can fall back to a default without try/catch noise.
 *
 * @param {unknown} level
 * @returns {{ level: number, feePct: number, numerator: number, denominator: number, redeemScriptBytes: number } | null}
 */
export function lookupGuanacoFeeTier(level) {
  if (typeof level !== 'number' || !Number.isInteger(level) || level < 0 || level > 3) return null;
  return GUANACO_FEE_TIERS[level] ?? null;
}

// ─────────────────────────────────────────────────────────────────────
//  Defaults + config resolution
// ─────────────────────────────────────────────────────────────────────

/**
 * Default guanaco adapter config. `indexer_url` and `sdk_module`
 * are intentionally null — neither has been published by the
 * guanaco team. The operator sets these when the team ships.
 *
 * `default_fee_tier` defaults to 1 (0.05%, the canonical tier
 * most pools ship with per the docs); can be 0..3.
 *
 * @type {Readonly<{
 *   indexerUrl: string|null,
 *   sdkModule: string|null,
 *   defaultFeeTier: number,
 *   buybackPkh: string,
 *   requestTimeoutMs: number,
 * }>}
 */
export const DEFAULT_GUANACO_CONFIG = Object.freeze({
  indexerUrl: null,
  sdkModule: null,
  defaultFeeTier: 1,
  buybackPkh: GUANACO_BUYBACK_PKH,
  requestTimeoutMs: 10_000,
});

/**
 * Validate + normalize a `dex.guanaco.*` config block. Pure.
 * Returns a typed `{ ok, normalized }` envelope (or `{ ok:false,
 * error }`). Mirrors the `resolveDexConfig` shape in
 * `src/dex/adapter.mjs` so the trader loop can chain both
 * resolvers without branching.
 *
 * Accepted shape:
 *   {
 *     indexer_url:       string|null,         // default null
 *     sdk_module:        string|null,         // default null (path to a JS module exporting the guanaco SDK)
 *     default_fee_tier:  number 0..3,         // default 1
 *     buyback_pkh:       string (hex 40),     // default frozen V1 constant
 *     request_timeout_ms:number > 0,          // default 10000
 *   }
 *
 * @param {unknown} cfg
 * @returns {{
 *   ok: true,
 *   normalized: { indexerUrl: string|null, sdkModule: string|null, defaultFeeTier: number, buybackPkh: string, requestTimeoutMs: number },
 * } | {
 *   ok: false,
 *   error: { message: string, code: string, path?: string },
 * }}
 */
export function resolveGuanacoConfig(cfg) {
  if (cfg === undefined || cfg === null) {
    return {
      ok: true,
      normalized: {
        indexerUrl: DEFAULT_GUANACO_CONFIG.indexerUrl,
        sdkModule: DEFAULT_GUANACO_CONFIG.sdkModule,
        defaultFeeTier: DEFAULT_GUANACO_CONFIG.defaultFeeTier,
        buybackPkh: DEFAULT_GUANACO_CONFIG.buybackPkh,
        requestTimeoutMs: DEFAULT_GUANACO_CONFIG.requestTimeoutMs,
      },
    };
  }
  if (typeof cfg !== 'object') {
    return {
      ok: false,
      error: { message: 'dex.guanaco config must be an object', code: 'wrong_type', path: 'dex.guanaco' },
    };
  }
  const o = /** @type {Record<string, unknown>} */ (cfg);
  const out = {
    indexerUrl: DEFAULT_GUANACO_CONFIG.indexerUrl,
    sdkModule: DEFAULT_GUANACO_CONFIG.sdkModule,
    defaultFeeTier: DEFAULT_GUANACO_CONFIG.defaultFeeTier,
    buybackPkh: DEFAULT_GUANACO_CONFIG.buybackPkh,
    requestTimeoutMs: DEFAULT_GUANACO_CONFIG.requestTimeoutMs,
  };

  if (o.indexer_url !== undefined && o.indexer_url !== null) {
    if (typeof o.indexer_url !== 'string' || o.indexer_url.length === 0) {
      return {
        ok: false,
        error: { message: 'dex.guanaco.indexer_url must be a non-empty string when set', code: 'wrong_type', path: 'dex.guanaco.indexer_url' },
      };
    }
    try {
      const u = new URL(o.indexer_url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return {
          ok: false,
          error: { message: `dex.guanaco.indexer_url protocol must be http(s) (got "${u.protocol}")`, code: 'wrong_protocol', path: 'dex.guanaco.indexer_url' },
        };
      }
    } catch {
      return {
        ok: false,
        error: { message: `dex.guanaco.indexer_url is not a valid URL: "${o.indexer_url}"`, code: 'bad_url', path: 'dex.guanaco.indexer_url' },
      };
    }
    out.indexerUrl = o.indexer_url;
  }

  if (o.sdk_module !== undefined && o.sdk_module !== null) {
    if (typeof o.sdk_module !== 'string' || o.sdk_module.length === 0) {
      return {
        ok: false,
        error: { message: 'dex.guanaco.sdk_module must be a non-empty string when set', code: 'wrong_type', path: 'dex.guanaco.sdk_module' },
      };
    }
    out.sdkModule = o.sdk_module;
  }

  if (o.default_fee_tier !== undefined) {
    if (typeof o.default_fee_tier !== 'number' || !Number.isInteger(o.default_fee_tier) || o.default_fee_tier < 0 || o.default_fee_tier > 3) {
      return {
        ok: false,
        error: {
          message: `dex.guanaco.default_fee_tier must be an integer 0..3 (got ${JSON.stringify(o.default_fee_tier)})`,
          code: 'wrong_type',
          path: 'dex.guanaco.default_fee_tier',
        },
      };
    }
    out.defaultFeeTier = o.default_fee_tier;
  }

  if (o.buyback_pkh !== undefined) {
    if (typeof o.buyback_pkh !== 'string' || !/^[0-9a-f]{40}$/i.test(o.buyback_pkh)) {
      return {
        ok: false,
        error: {
          message: 'dex.guanaco.buyback_pkh must be a hex-encoded 20-byte public-key hash (40 hex chars)',
          code: 'wrong_type',
          path: 'dex.guanaco.buyback_pkh',
        },
      };
    }
    out.buybackPkh = o.buyback_pkh.toLowerCase();
  }

  if (o.request_timeout_ms !== undefined) {
    if (typeof o.request_timeout_ms !== 'number' || !Number.isFinite(o.request_timeout_ms) || o.request_timeout_ms <= 0) {
      return {
        ok: false,
        error: {
          message: 'dex.guanaco.request_timeout_ms must be a positive finite number (ms)',
          code: 'wrong_type',
          path: 'dex.guanaco.request_timeout_ms',
        },
      };
    }
    out.requestTimeoutMs = o.request_timeout_ms;
  }

  return { ok: true, normalized: out };
}

// ─────────────────────────────────────────────────────────────────────
//  Factory
// ─────────────────────────────────────────────────────────────────────

/**
 * Build the guanaco adapter. Returns the typed `DexAdapter` shape
 * every adapter conforms to. Today every method except `isReady`
 * throws `GuanacoNotImplementedError('pending_public_indexer_and_sdk')`
 * because the guanaco team hasn't shipped a public indexer or
 * JS SDK — see module docstring for the full dependency list.
 *
 * Behavior:
 *   - `isReady()` returns true iff BOTH `indexer_url` AND
 *     `sdk_module` are configured. Today both default to null,
 *     so `isReady()` is always false and the trader loop's
 *     `bootDexAdapters` surfaces the adapter as `not_implemented`
 *     in the `failed[]` array (see the catch branch in
 *     `createDexAdapter` — though in practice the not-implemented
 *     methods are only called post-boot when isReady gates the
 *     routing layer).
 *   - All swap-path methods throw `GuanacoNotImplementedError`
 *     with code `guanaco_not_implemented` and a stable
 *     `pending_public_indexer_and_sdk` reason the operator can
 *     grep for in `logs/supervisor.log`.
 *   - `constants` exposes the V1 fee tiers + fixed buyback
 *     destination so the dashboard / future SDK wiring can read
 *     them without re-importing this module's individual exports.
 *
 * @param {object} [_config]   — guanaco config block (indexer_url, sdk_module, ...)
 * @param {object} [_deps]     — reserved for future SDK injection
 * @returns {{
 *   id: 'guanaco',
 *   displayName: 'Guanaco',
 *   safeMode: false,
 *   indexerUrl: string|null,
 *   isReady: () => Promise<boolean>,
 *   getPoolsAndMeta: (opts: object) => Promise<never>,
 *   getTokenStats:   (opts: object) => Promise<never>,
 *   listPools:       (opts: object) => Promise<never>,
 *   getBcmr:         (opts: object) => Promise<never>,
 *   prepareAndBuildSwap: (opts: object) => Promise<never>,
 *   broadcastTx:         (opts: object) => Promise<never>,
 *   verifyTrade:         (opts: object) => Promise<never>,
 *   constants: { FEE_TIERS: ReadonlyArray<object>, BUYBACK_PKH: string, BUYBACK_LOCKING_BYTECODE: string, INDEXER_DISCOVERY_DOCS: string },
 * }}
 */
export function createGuanacoAdapter(_config = {}, _deps = {}) {
  const resolved = resolveGuanacoConfig(_config && _config.guanaco ? _config.guanaco : _config);
  // The factory contract: throw typed GuanacoNotConfiguredError on
  // hard config rejection (so bootDexAdapters surfaces it as a
  // typed failure rather than a silent skip). Soft defaults (null
  // indexer_url / sdk_module) are tolerated — isReady() then
  // returns false and the trader loop routes around the adapter.
  if (!resolved.ok) {
    throw new GuanacoNotConfiguredError(resolved.error.message, {
      code: resolved.error.code,
      cause: resolved.error,
    });
  }
  const cfg = resolved.normalized;
  const notReady = cfg.indexerUrl === null || cfg.sdkModule === null;

  function notImplemented(method) {
    return new GuanacoNotImplementedError(
      `guanaco.${method} is not implemented yet (pending_public_indexer_and_sdk — see src/dex/guanaco.mjs docstring)`,
      { id: 'guanaco' },
    );
  }

  function gate(method) {
    return async () => {
      throw notImplemented(method);
    };
  }

  const adapter = Object.freeze({
    id: /** @type {const} */ ('guanaco'),
    displayName: /** @type {const} */ ('Guanaco'),
    safeMode: false,
    indexerUrl: cfg.indexerUrl,
    isReady: async () => !notReady,
    getPoolsAndMeta: gate('getPoolsAndMeta'),
    getTokenStats: gate('getTokenStats'),
    listPools: gate('listPools'),
    getBcmr: gate('getBcmr'),
    prepareAndBuildSwap: gate('prepareAndBuildSwap'),
    broadcastTx: gate('broadcastTx'),
    verifyTrade: gate('verifyTrade'),
    constants: Object.freeze({
      FEE_TIERS: GUANACO_FEE_TIERS,
      BUYBACK_PKH: GUANACO_BUYBACK_PKH,
      BUYBACK_LOCKING_BYTECODE: GUANACO_BUYBACK_LOCKING_BYTECODE,
      DEFAULT_FEE_TIER: cfg.defaultFeeTier,
      REQUEST_TIMEOUT_MS: cfg.requestTimeoutMs,
      // Pointing at the docs (NOT an indexer URL — we don't have one).
      // Exposed so `resolveDexConfig` / future Settings-view diagnostic
      // surfaces can show "where to look for the real indexer."
      INDEXER_DISCOVERY_DOCS: 'https://github.com/guanaco-fi/docs',
    }),
  });

  return adapter;
}
