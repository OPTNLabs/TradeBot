#!/usr/bin/env node
// src/util/config-loader.mjs
//
// Tiny, dependency-free config loader for TradeBot.
//
// Reads `config/default.json` (the source of truth for every knob),
// merges `config/user.json` (operator overrides + the WIF) on top,
// and returns the merged object. No CLI, no validation (the merged
// shape is validated by the consumers — `walletConfigFrom`,
// `resolveLoopConfig`, etc.), no caching.
//
// Why a tiny loader and not a full config library?
//   - Two files, no schema enforcement, no env interpolation.
//   - ~80 lines beats `npm i config` for this use case.
//   - The merged shape is the `cfg` object every module already
//     consumes — same structure, no surprises.
//
// Design rules (also see docs/ARCHITECTURE.md §2.1):
//
//   1. **`config/default.json` is canonical.** Every knob the bot
//      reads comes from there (or the operator override in
//      `user.json`). The bot NEVER reads a config value from the
//      loader — it reads `cfg.X` from whatever was passed in.
//
//   2. **`config/user.json` is gitignored + chmod 600.** It can hold
//      the WIF + mnemonic (T03a). The loader never logs its
//      contents; only the merged shape (which carries the WIF) ever
//      crosses the loader → caller boundary.
//
//   3. **Deep-merge, not shallow-merge.** `default.json` has nested
//      blocks (`scoring`, `entry`, `risk`, `wallet`, `loop`,
//      `data_sources`); `user.json` overrides individual fields.
//      A shallow merge would replace the whole block.
//
//   4. **Path overrides for tests.** The loader accepts
//      `{ defaultPath, userPath }` so the test suite can use
//      throwaway fixtures (no monkey-patching of `process.cwd`).
//
//   5. **Never throws on missing `user.json`.** The user file is
//      optional. The loader returns the default config verbatim if
//      `user.json` is absent. It DOES throw if `default.json` is
//      missing — that's a fatal config error.
//
//   6. **Never mutates the inputs.** `JSON.parse` already returns a
//      fresh object; deep-merge constructs NEW objects for every
//      nested block so callers can mutate the result safely.
//
// Origin: original code for TradeBot. Lives in `src/util/` so
// both `scripts/*` and any future dashboard server can share the
// same loader.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Default on-disk locations. The TradeBot repo convention:
 *   <repo>/config/default.json
 *   <repo>/config/user.json    (gitignored + chmod 600)
 *
 * Callers can override via `opts.defaultPath` / `opts.userPath`
 * (the test suite does this — see tests/util-config-loader.test.mjs).
 */
export const DEFAULT_CONFIG_PATHS = Object.freeze({
  default: 'config/default.json',
  user: 'config/user.json',
});

// ─────────────────────────────────────────────────────────────────────
//  Errors
// ─────────────────────────────────────────────────────────────────────

export class ConfigLoaderError extends Error {
  /**
   * @param {string} message
   * @param {Object} [opts]
   * @param {string} [opts.path]
   * @param {Error} [opts.cause]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = 'ConfigLoaderError';
    if (opts.path) this.path = opts.path;
    if (opts.cause) this.cause = opts.cause;
  }
}

export class ConfigMissingError extends ConfigLoaderError {
  constructor(path, { cause } = {}) {
    super(`ConfigLoader: required config file missing: ${path}`, { path, cause });
    this.name = 'ConfigMissingError';
    this.code = 'CONFIG_MISSING';
  }
}

export class ConfigParseError extends ConfigLoaderError {
  constructor(path, { cause } = {}) {
    super(`ConfigLoader: failed to parse ${path}: ${cause?.message ?? cause}`, { path, cause });
    this.name = 'ConfigParseError';
    this.code = 'CONFIG_PARSE';
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Pure helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Deep-merge two plain objects. `b` wins for primitive fields; for
 * nested plain objects (and arrays of plain objects) the merge
 * recurses. The function NEVER mutates either input — every nested
 * block is copied via spread.
 *
 * Pure. Exported for tests + for any future config-tooling code.
 *
 * Notes:
 *   - Arrays are treated as opaque values: the array from `b` wins.
 *     This matches the convention that arrays in `config/*.json`
 *     are not "merged" (no concat / dedup).
 *   - `null` is treated as a valid primitive value — `b: null` wins
 *     over `a: { ... }`. This matches how `JSON.stringify` /
 *     `JSON.parse` round-trip nulls.
 *   - Non-plain-object values (Date, Buffer, class instances) are
 *     copied by `b` winning — we don't try to deep-merge those.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {unknown}
 */
export function deepMerge(a, b) {
  // Base case: `b` undefined → keep `a`.
  if (b === undefined) return a;
  // `b` is not a plain object → it wins outright.
  if (b === null || typeof b !== 'object' || Array.isArray(b)) return b;
  // `a` is not a plain object → `b` wins (we don't try to graft
  // a non-object into a struct).
  if (a === null || typeof a !== 'object' || Array.isArray(a)) return b;
  // Both plain objects → recurse field-by-field.
  /** @type {Record<string, unknown>} */
  const out = {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    /** @type {unknown} */
    const av = /** @type {any} */ (a)[k];
    /** @type {unknown} */
    const bv = /** @type {any} */ (b)[k];
    out[k] = deepMerge(av, bv);
  }
  return out;
}

/**
 * Resolve the default + user config paths. Accepts overrides so
 * tests can point at fixtures; defaults to the TradeBot repo
 * convention.
 *
 * Pure.
 *
 * @param {Object} [opts]
 * @param {string} [opts.defaultPath]
 * @param {string} [opts.userPath]
 * @param {string} [opts.cwd]
 * @returns {{ defaultPath: string, userPath: string|null }}
 */
export function resolveConfigPaths(opts = {}) {
  const cwd = (typeof opts.cwd === 'string' && opts.cwd.length > 0) ? opts.cwd : process.cwd();
  const def = (typeof opts.defaultPath === 'string' && opts.defaultPath.length > 0)
    ? path.resolve(cwd, opts.defaultPath)
    : path.resolve(cwd, DEFAULT_CONFIG_PATHS.default);
  const userDefault = (typeof opts.userPath === 'string' && opts.userPath.length > 0)
    ? path.resolve(cwd, opts.userPath)
    : path.resolve(cwd, DEFAULT_CONFIG_PATHS.user);
  return { defaultPath: def, userPath: userDefault };
}

// ─────────────────────────────────────────────────────────────────────
//  File reads
// ─────────────────────────────────────────────────────────────────────

/**
 * Read + parse a JSON config file. Returns `null` when the file is
 * missing AND `required === false`. Throws on parse errors (a
 * malformed config is a fatal startup error — better than booting
 * with hallucinated defaults).
 *
 * @param {Object} args
 * @param {string} args.path                absolute path
 * @param {boolean} [args.required=false]   throw on ENOENT?
 * @param {typeof import('node:fs/promises')} [args.fs]
 * @returns {Promise<Object|null>}
 */
export async function readConfigFile({ path: filePath, required = false, fs } = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new ConfigLoaderError(`readConfigFile: path required; got ${JSON.stringify(filePath)}`);
  }
  const fsImpl = fs ?? null;
  const read = (p) => (fsImpl ? fsImpl.readFile(p, 'utf8') : readFile(p, 'utf8'));
  let raw;
  try {
    raw = await read(filePath);
  } catch (e) {
    if (e && typeof e === 'object' && /** @type {any} */ (e).code === 'ENOENT') {
      if (required) throw new ConfigMissingError(filePath, { cause: e });
      return null;
    }
    throw e;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ConfigParseError(filePath, {
        cause: new Error(`expected JSON object; got ${parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed}`),
      });
    }
    return /** @type {Object} */ (parsed);
  } catch (e) {
    if (e instanceof ConfigParseError) throw e;
    throw new ConfigParseError(filePath, { cause: e });
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Public loader
// ─────────────────────────────────────────────────────────────────────

/**
 * Load + merge the TradeBot config.
 *
 * Semantics:
 *
 *   - `default.json` is the canonical source of truth.
 *   - `user.json` is the operator override. Two kinds of overrides
 *     are supported:
 *
 *       (1) **Per-knob overrides** — fields at any depth (e.g.
 *           `entry.max_position_bch: 0.05`) are deep-merged into
 *           the default config. Most operator knobs land here.
 *
 *       (2) **Wallet block** — the `wallet` sub-object from
 *           `user.json` is ALSO exposed under `cfg.user.wallet` so
 *           the existing `wallet/libauth.mjs` code (which expects
 *           `cfg.user?.wallet?.cashaddr`, `cfg.user?.wallet?.wif`,
 *           etc.) keeps working without a second migration step.
 *           This is a back-compat surface; nothing in the trader
 *           loop reads the raw WIF from here — it goes through
 *           `wallet/libauth.mjs::resolveWif`.
 *
 *   The user.json file is OPTIONAL. When absent, the loader returns
 *   the default config verbatim (with `cfg.user = null` so consumers
 *   that key on `cfg.user?.wallet` see the empty path).
 *
 * @param {Object} [opts]
 * @param {string} [opts.defaultPath]      override default.json location
 * @param {string} [opts.userPath]         override user.json location
 * @param {string} [opts.cwd]              cwd to resolve relative paths
 *                                         (defaults to `process.cwd()`)
 * @param {typeof import('node:fs/promises')} [opts.fs]
 * @returns {Promise<Object>}  merged config (default + user)
 */
export async function loadConfig(opts = {}) {
  const paths = resolveConfigPaths(opts);
  const fsImpl = opts.fs ?? null;
  const base = await readConfigFile({
    path: paths.defaultPath,
    required: true,
    fs: fsImpl ?? undefined,
  });
  if (base === null) {
    // readConfigFile with required=true always throws on missing;
    // this branch is unreachable but keeps the type narrow.
    throw new ConfigMissingError(paths.defaultPath);
  }
  const user = await readConfigFile({
    path: paths.userPath,
    required: false,
    fs: fsImpl ?? undefined,
  });
  // If user.json is absent, expose `cfg.user = null` so consumers
  // that probe `cfg.user?.wallet` see the empty path.
  if (user === null) {
    return {
      ...base,
      user: null,
      paths: {
        default: paths.defaultPath,
        user: null,
      },
    };
  }
  // Step 1: deep-merge user.json ON TOP of default.json. This gives
  //   `cfg.entry.max_position_bch` (or whatever the operator overrode)
  //   wins for any per-knob override.
  const merged = /** @type {Object} */ (deepMerge(base, user));
  // Step 2: expose the raw user.json contents at `cfg.user` (so the
  //   wallet module + the dashboard's "operator overrides" view can
  //   see the user-block without parsing it again). Only do this if
  //   the operator didn't already declare a top-level `user` block
  //   in default.json (they shouldn't).
  if (!('user' in merged) || merged.user === null) {
    merged.user = user;
  }
  // Step 3: stamp the on-disk paths so scripts can log them.
  merged.paths = {
    default: paths.defaultPath,
    user: paths.userPath,
  };
  return merged;
}

/**
 * Build a CLI-friendly summary of the loaded config. Useful for
 * the `--help` output of `run-bot.mjs` / `snapshot.mjs` /
 * `init-wallet.mjs` so operators can confirm the loaded preset.
 *
 * Pure. Does NOT redact the WIF — caller is responsible for passing
 * `redact: true` when rendering to stdout in a shared log channel.
 *
 * @param {Object} cfg
 * @param {Object} [opts]
 * @param {boolean} [opts.redact=true]
 * @returns {Object}
 */
export function summarizeConfig(cfg, opts = {}) {
  const redact = opts.redact !== false;
  if (!cfg || typeof cfg !== 'object') return { ok: false };
  /** @type {Object} */
  const out = {
      ok: true,
      tuning_preset: cfg.tuning_preset ?? null,
      version: cfg.version ?? null,
      notes: cfg.notes ?? null,
      network: cfg.wallet?.network ?? null,
      bip44_path: cfg.wallet?.bip44_path ?? null,
      cashaddr: cfg.wallet?.address ?? cfg.user?.wallet?.cashaddr ?? null,
      max_position_bch: cfg.entry?.max_position_bch ?? null,
      max_total_exposure_bch: cfg.entry?.max_total_exposure_bch ?? null,
      max_daily_loss_bch: cfg.risk?.max_daily_loss_bch ?? null,
      min_wallet_balance_bch: cfg.risk?.min_wallet_balance_bch ?? null,
      loss_cooldown_minutes: cfg.risk?.loss_cooldown_minutes ?? null,
      slippage_tolerance_bps: cfg.entry?.slippage_tolerance_bps ?? null,
      volatility_sizing_target_pct: cfg.entry?.volatility_sizing_target_pct ?? null,
      correlation_skip_threshold: cfg.entry?.correlation_skip_threshold ?? null,
      min_pool_age_days: cfg.entry?.min_pool_age_days ?? null,
      // T38: dynamic TP/SL from 7d realized volatility.
      tp_vol_multiplier: cfg.exit?.tp_vol_multiplier ?? null,
      sl_vol_multiplier: cfg.exit?.sl_vol_multiplier ?? null,
      tp_vol_floor_pct: cfg.exit?.tp_vol_floor_pct ?? null,
      tp_vol_ceiling_pct: cfg.exit?.tp_vol_ceiling_pct ?? null,
      sl_vol_floor_pct: cfg.exit?.sl_vol_floor_pct ?? null,
      sl_vol_ceiling_pct: cfg.exit?.sl_vol_ceiling_pct ?? null,
      poll_interval_seconds: cfg.loop?.poll_interval_seconds ?? null,
      snapshot_interval_seconds: cfg.loop?.snapshot_interval_seconds ?? null,
      has_user_json: !!cfg.user,
      wif_present: typeof cfg.user?.wallet?.wif === 'string' && cfg.user.wallet.wif.length > 0,
    };
  if (redact && out.wif_present) {
    out.wif_present = true; // bool, not the WIF itself
  }
  return out;
}

export const _internals = { deepMerge, resolveConfigPaths, readConfigFile };