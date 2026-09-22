#!/usr/bin/env node
// src/dashboard/setup.mjs
//
// First-run setup wizard backend.
//
// Sits behind two routes the dashboard server wires in:
//
//   GET  /api/setup/status   returns {setup_required, missing:[...],
//                                  network, cashaddr} so the React
//                                  app can decide whether to redirect
//                                  to /setup on first launch.
//
//   POST /api/setup          writes the wizard's payload to
//                            config/user.json atomically. Validates:
//                              - network ∈ SUPPORTED_NETWORKS
//                              - max_position_bch / max_total_exposure_bch
//                                / take_profit_pct / stop_loss_pct are
//                                finite + bounded
//                              - slippage_tolerance_bps is integer 0..1000
//                              - api_token (optional) is hex 8..256 chars
//                              - wallet mode is one of:
//                                  'generate' | 'import_mnemonic' | 'import_wif'
//                                  and the matching payload (mnemonic /
//                                  wif) parses successfully
//
// The handler is INTENTIONALLY independent of `scripts/init-wallet.mjs`
// (the CLI script is a separate code path). Both paths share the same
// `src/wallet/init-helpers.mjs` validation primitives so the WIF
// checksum / BIP39 wordlist checks are identical.
//
// Audit: every successful POST writes one NDJSON line to
// `logs/setup-audit.jsonl` (created on demand, gitignored) with
// `{ts, mode, network, cashaddr_prefix}` — `cashaddr_prefix` is
// `bitcoincash:qpr...` truncated to the first 12 chars after the
// colon so the audit trail proves WHICH wallet was initialized
// without leaking the full address. WIF + mnemonic are NEVER
// logged, even redacted.

import { randomBytes } from 'node:crypto';
import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';

import {
  SUPPORTED_NETWORKS,
  DEFAULT_BIP44_PATH,
  generateMainnetWallet,
  importFromMnemonic,
  importFromWif,
} from '../wallet/init-helpers.mjs';

// ─────────────────────────────────────────────────────────────────────
//  Pure helpers (exported for tests)
// ─────────────────────────────────────────────────────────────────────

/**
 * Field bounds for the wizard payload. Anything outside these
 * ranges is rejected before reaching `user.json`. Tuned for the
 * small-balance preset — wide enough to cover all reasonable
 * operator choices, tight enough to catch fat-finger typos
 * (the wizard also has client-side validation; this is the
 * server-side floor).
 */
export const SETUP_BOUNDS = Object.freeze({
  max_position_bch: { min: 0.0001, max: 1.0, step: 'any' },
  max_total_exposure_bch: { min: 0.0005, max: 5.0, step: 'any' },
  take_profit_pct: { min: 0.5, max: 50.0, step: 'any' },
  stop_loss_pct: { min: 0.1, max: 30.0, step: 'any' },
  slippage_tolerance_bps: { min: 5, max: 1000, step: 1 },
  time_stop_hours: { min: 1, max: 720, step: 1 },
});

/**
 * Wallet input modes the wizard accepts. Each maps to one
 * `src/wallet/init-helpers.mjs` import path.
 */
export const WALLET_MODES = Object.freeze([
  'generate',
  'import_mnemonic',
  'import_wif',
]);

/**
 * Decide whether the merged cfg + user.json currently have the
 * minimum fields the bot needs to start. Used by both
 * `GET /api/setup/status` and the dashboard's auto-redirect.
 *
 * `setup_required=true` is returned when ANY of:
 *   - `cfg.wallet?.cashaddr` is missing or empty
 *   - `cfg.wallet?.wif` is missing or empty
 *   - `cfg.wallet?.network` is missing or unsupported
 *   - `cfg.dashboard?.api_token` is missing or empty
 *     (the dashboard's write endpoints would refuse with
 *      AUTH_NOT_CONFIGURED; that's the same condition)
 *
 * Returns `{setup_required, missing:[...], network, cashaddr}`.
 * `cashaddr` is truncated to first 12 chars after the `:` prefix
 * (or null) so callers can surface "the bot is configured for
 * wallet qpr…fgh3" without revealing the full address.
 *
 * Pure. Exported for tests.
 *
 * @param {Object} cfg  the merged default+user config
 * @returns {{setup_required:boolean, missing:string[], network:(string|null), cashaddr:(string|null)}}
 */
export function inspectSetupStatus(cfg) {
  const missing = [];
  const wallet = (cfg && typeof cfg === 'object' && cfg.wallet && typeof cfg.wallet === 'object')
    ? cfg.wallet
    : null;
  const dashboard = (cfg && typeof cfg === 'object' && cfg.dashboard && typeof cfg.dashboard === 'object')
    ? cfg.dashboard
    : null;

  const network = (wallet && typeof wallet.network === 'string') ? wallet.network : null;
  if (!network || !SUPPORTED_NETWORKS.includes(network)) {
    missing.push('network');
  }

  const wif = (wallet && typeof wallet.wif === 'string') ? wallet.wif.trim() : '';
  if (!wif) {
    missing.push('wallet.wif');
  }

  const cashaddr = (wallet && typeof wallet.cashaddr === 'string') ? wallet.cashaddr : null;
  if (!cashaddr) {
    missing.push('wallet.cashaddr');
  }

  const apiToken = (dashboard && typeof dashboard.api_token === 'string') ? dashboard.api_token.trim() : '';
  if (!apiToken) {
    missing.push('dashboard.api_token');
  }

  return {
    setup_required: missing.length > 0,
    missing,
    network: network && SUPPORTED_NETWORKS.includes(network) ? network : null,
    cashaddr: cashaddr ? truncateCashaddrForDisplay(cashaddr) : null,
  };
}

/**
 * Truncate a cashaddr to the first 4 + last 4 visible characters
 * for UI display. Keeps enough entropy to disambiguate two
 * wallets at a glance, hides the rest.
 *
 * Pure. Exported for tests.
 *
 * @param {string} cashaddr
 * @returns {string}
 */
export function truncateCashaddrForDisplay(cashaddr) {
  if (typeof cashaddr !== 'string' || cashaddr.length === 0) return '';
  // cashaddr format: bitcoincash:q<base32>. Strip the prefix so the
  // "q…xyz3" display is short.
  const colon = cashaddr.indexOf(':');
  const body = colon >= 0 ? cashaddr.slice(colon + 1) : cashaddr;
  if (body.length <= 12) return body;
  return `${body.slice(0, 6)}…${body.slice(-4)}`;
}

/**
 * Validate the wizard payload BEFORE we touch the wallet helpers.
 * Catches malformed payloads (wrong types, missing required
 * fields, out-of-bounds knobs). Does NOT verify the mnemonic /
 * WIF — that's `validateWalletInput` below, which can fail with
 * a checksum error.
 *
 * Returns `{ok:true}` or `{ok:false, errors:[{field, message}]}`.
 *
 * Pure. Exported for tests.
 *
 * @param {unknown} payload
 * @returns {{ok:true}|{ok:false, errors:Array<{field:string, message:string}>}}
 */
export function validateSetupPayload(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, errors: [{ field: '_root', message: 'body must be a JSON object' }] };
  }
  const p = /** @type {any} */ (payload);

  // network
  if (typeof p.network !== 'string') {
    errors.push({ field: 'network', message: 'network is required' });
  } else if (!SUPPORTED_NETWORKS.includes(p.network)) {
    errors.push({ field: 'network', message: `network must be one of ${SUPPORTED_NETWORKS.join(', ')}` });
  }

  // wallet mode
  if (typeof p.wallet_mode !== 'string') {
    errors.push({ field: 'wallet_mode', message: 'wallet_mode is required' });
  } else if (!WALLET_MODES.includes(p.wallet_mode)) {
    errors.push({ field: 'wallet_mode', message: `wallet_mode must be one of ${WALLET_MODES.join(', ')}` });
  } else {
    // Mode-specific required fields (the actual values are
    // validated by `validateWalletInput` after the WIF/mnemonic
    // parsers run).
    if (p.wallet_mode === 'import_mnemonic') {
      if (typeof p.mnemonic !== 'string' || p.mnemonic.trim().length === 0) {
        errors.push({ field: 'mnemonic', message: 'mnemonic is required for import_mnemonic mode' });
      }
    }
    if (p.wallet_mode === 'import_wif') {
      if (typeof p.wif !== 'string' || p.wif.trim().length === 0) {
        errors.push({ field: 'wif', message: 'wif is required for import_wif mode' });
      }
    }
  }

  // trading knobs — all required, all bounded
  const boundedChecks = /** @type {Array<[string, keyof typeof SETUP_BOUNDS, 'int'|'float']>} */ ([
    ['max_position_bch', 'max_position_bch', 'float'],
    ['max_total_exposure_bch', 'max_total_exposure_bch', 'float'],
    ['take_profit_pct', 'take_profit_pct', 'float'],
    ['stop_loss_pct', 'stop_loss_pct', 'float'],
    ['slippage_tolerance_bps', 'slippage_tolerance_bps', 'int'],
    ['time_stop_hours', 'time_stop_hours', 'int'],
  ]);
  for (const [field, key, kind] of boundedChecks) {
    const v = p[field];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      errors.push({ field, message: `${field} must be a finite number` });
      continue;
    }
    const bounds = SETUP_BOUNDS[key];
    if (kind === 'int' && !Number.isInteger(v)) {
      errors.push({ field, message: `${field} must be an integer` });
      continue;
    }
    if (v < bounds.min || v > bounds.max) {
      errors.push({ field, message: `${field} must be between ${bounds.min} and ${bounds.max}` });
    }
  }

  // api_token (optional). If provided, must be hex 8..256 chars.
  if (p.api_token !== undefined && p.api_token !== null && p.api_token !== '') {
    if (typeof p.api_token !== 'string') {
      errors.push({ field: 'api_token', message: 'api_token must be a string' });
    } else if (!/^[0-9a-fA-F]{8,256}$/.test(p.api_token)) {
      errors.push({ field: 'api_token', message: 'api_token must be 8-256 hex characters' });
    }
  }

  // sanity: max_total_exposure_bch must be >= max_position_bch
  if (typeof p.max_position_bch === 'number' && typeof p.max_total_exposure_bch === 'number'
      && Number.isFinite(p.max_position_bch) && Number.isFinite(p.max_total_exposure_bch)
      && p.max_total_exposure_bch < p.max_position_bch) {
    errors.push({ field: 'max_total_exposure_bch', message: 'max_total_exposure_bch must be >= max_position_bch' });
  }

  // sanity: take_profit > stop_loss
  if (typeof p.take_profit_pct === 'number' && typeof p.stop_loss_pct === 'number'
      && Number.isFinite(p.take_profit_pct) && Number.isFinite(p.stop_loss_pct)
      && p.take_profit_pct <= p.stop_loss_pct) {
    errors.push({ field: 'take_profit_pct', message: 'take_profit_pct must be greater than stop_loss_pct' });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true };
}

/**
 * Validate the wallet-specific input. Runs the BIP39 wordlist
 * check (for mnemonic mode) or the WIF base58+checksum check
 * (for wif mode), and returns the derived `{cashaddr, wif, network}`
 * block that will be merged into user.json.
 *
 * For `generate` mode, calls `generateMainnetWallet()` — fresh
 * entropy from libauth's `randomBytes(16)` source. The mnemonic
 * is returned to the caller so the wizard can show it ONCE before
 * the user clicks "I've saved it" — same UX as the
 * `init-wallet.mjs --generate` CLI path.
 *
 * Returns `{ok:true, wallet:{cashaddr, wif, mnemonic?, network, bip44_path}, generated_mnemonic?}`
 * or `{ok:false, error:'', code:'', field:''}`.
 *
 * Async (the libauth helpers do crypto work). Exported for tests.
 *
 * @param {Object} args
 * @param {string} args.network
 * @param {string} args.wallet_mode
 * @param {string} [args.mnemonic]
 * @param {string} [args.wif]
 * @returns {Promise<Object>}
 */
export async function validateWalletInput(args) {
  const { network, wallet_mode } = args || {};
  if (!SUPPORTED_NETWORKS.includes(network)) {
    return { ok: false, code: 'NETWORK_UNSUPPORTED', error: `unsupported network: ${network}` };
  }
  if (!WALLET_MODES.includes(wallet_mode)) {
    return { ok: false, code: 'WALLET_MODE_INVALID', error: `unsupported wallet_mode: ${wallet_mode}` };
  }

  try {
    if (wallet_mode === 'generate') {
      const out = await generateMainnetWallet({ network });
      // generateMainnetWallet returns the BIP39 mnemonic in
      // `out.mnemonic`; persist it to user.json too so the
      // operator can recover the wallet from a backup.
      // Note: the init-helpers return `address` (cashaddr),
      // `wif`, `mnemonic`, `mnemonicWordCount`, `network`,
      // `bip44Path` — we rename `address`→`cashaddr` and
      // `mnemonicWordCount`→`mnemonic_word_count` so the
      // downstream JSON shape uses snake_case consistently.
      return {
        ok: true,
        wallet: {
          cashaddr: out.address,
          wif: out.wif,
          mnemonic: out.mnemonic,
          mnemonic_word_count: out.mnemonicWordCount,
          network,
          bip44_path: DEFAULT_BIP44_PATH,
        },
        generated_mnemonic: out.mnemonic,
      };
    }

    if (wallet_mode === 'import_mnemonic') {
      const out = await importFromMnemonic({
        network,
        mnemonic: args.mnemonic,
      });
      return {
        ok: true,
        wallet: {
          cashaddr: out.address,
          wif: out.wif,
          mnemonic: out.mnemonic,
          mnemonic_word_count: out.mnemonicWordCount,
          network,
          bip44_path: DEFAULT_BIP44_PATH,
        },
      };
    }

    if (wallet_mode === 'import_wif') {
      const out = await importFromWif({
        network,
        wif: args.wif,
      });
      return {
        ok: true,
        wallet: {
          cashaddr: out.address,
          wif: out.wif,
          network,
          bip44_path: DEFAULT_BIP44_PATH,
        },
      };
    }
  } catch (e) {
    // Map common init-helpers error names to a UI-friendly code.
    const name = (e && /** @type {any} */ (e).name) || 'Error';
    let code = 'WALLET_VALIDATION_FAILED';
    let field = 'wallet';
    if (name === 'InitWalletBip39Error' || /BIP39|wordlist|mnemonic/i.test(name + ' ' + (e?.message ?? ''))) {
      code = 'MNEMONIC_INVALID';
      field = 'mnemonic';
    } else if (name === 'InitWalletWifError' || /wif|base58|checksum/i.test(name + ' ' + (e?.message ?? ''))) {
      code = 'WIF_INVALID';
      field = 'wif';
    } else if (name === 'InitWalletNetworkError') {
      code = 'NETWORK_MISMATCH';
      field = 'network';
    }
    return { ok: false, code, field, error: (e && e.message) || String(e) };
  }

  // Unreachable — WALLET_MODES check above catches everything.
  return { ok: false, code: 'WALLET_MODE_INVALID', error: 'unreachable' };
}

// ─────────────────────────────────────────────────────────────────────
//  Handlers wired into buildRouteTable
// ─────────────────────────────────────────────────────────────────────

/**
 * Build the `user.json` patch from a validated wizard payload.
 * Pure — no I/O. The handler below applies the patch via
 * `atomicWriteJson`.
 *
 * Note: WIF + mnemonic land in the `wallet` block as-is (already
 * validated by `validateWalletInput`). They're NOT redacted on
 * write — they need to be readable by the bot loop at boot. The
 * dashboard server's `redactConfig()` strips them from any
 * outbound response, and `walkAndReject()` blocks them from any
 * other write endpoint.
 *
 * @param {Object} args
 * @param {Object} args.wallet            `{cashaddr, wif, mnemonic?, network, bip44_path}`
 * @param {number} args.max_position_bch
 * @param {number} args.max_total_exposure_bch
 * @param {number} args.take_profit_pct
 * @param {number} args.stop_loss_pct
 * @param {number} args.slippage_tolerance_bps
 * @param {number} args.time_stop_hours
 * @param {string} [args.api_token]
 * @returns {Object}
 */
export function buildSetupPatch(args) {
  const patch = {
    wallet: {
      ...args.wallet,
      wallet_mode: args.wallet_mode ?? null,
      last_setup_at: new Date().toISOString(),
    },
    entry: {
      max_position_bch: args.max_position_bch,
      max_total_exposure_bch: args.max_total_exposure_bch,
      slippage_tolerance_bps: args.slippage_tolerance_bps,
    },
    exit: {
      take_profit_pct: args.take_profit_pct,
      stop_loss_pct: args.stop_loss_pct,
      time_stop_hours: args.time_stop_hours,
    },
  };
  if (args.api_token) {
    patch.dashboard = { api_token: args.api_token };
  }
  return patch;
}

/**
 * `GET /api/setup/status` handler. No auth required — the
 * operator has nothing to protect until the wizard completes, and
 * the wizard itself needs to know whether to show itself.
 *
 * @param {Object} ctx
 * @returns {Promise<Object>}
 */
export async function getSetupStatus(ctx) {
  if (!ctx || typeof ctx !== 'object' || !ctx.cfg) {
    return { status: 503, body: { error: 'ctx_unavailable', code: 'CTX_UNAVAILABLE' } };
  }
  return inspectSetupStatus(ctx.cfg);
}

/**
 * `POST /api/setup` handler. Validates, derives the wallet block,
 * builds the user.json patch, writes it atomically. Writes one
 * line to `logs/setup-audit.jsonl` with the mode + a truncated
 * cashaddr — never the WIF / mnemonic.
 *
 * @param {Object} ctx
 * @param {Object} body
 * @returns {Promise<Object>}
 */
export async function postSetup(ctx, body) {
  if (!ctx || typeof ctx !== 'object' || !ctx.cfg) {
    return { error: 'ctx_unavailable', code: 'CTX_UNAVAILABLE' };
  }
  const validation = validateSetupPayload(body);
  if (!validation.ok) {
    return { error: 'invalid setup payload', code: 'BAD_PAYLOAD', errors: validation.errors };
  }
  const b = /** @type {any} */ (body);

  const walletResult = await validateWalletInput({
    network: b.network,
    wallet_mode: b.wallet_mode,
    mnemonic: b.mnemonic,
    wif: b.wif,
  });
  if (!walletResult.ok) {
    return {
      error: walletResult.error,
      code: walletResult.code,
      field: walletResult.field,
    };
  }

  // Pick the API token: caller-supplied, or a fresh 64-hex string
  // (32 random bytes). Auto-filling means a fresh operator never
  // gets stuck behind AUTH_NOT_CONFIGURED.
  const apiToken = (typeof b.api_token === 'string' && b.api_token.length > 0)
    ? b.api_token
    : randomBytes(32).toString('hex');

  const patch = buildSetupPatch({
    wallet_mode: b.wallet_mode,
    wallet: walletResult.wallet,
    max_position_bch: b.max_position_bch,
    max_total_exposure_bch: b.max_total_exposure_bch,
    take_profit_pct: b.take_profit_pct,
    stop_loss_pct: b.stop_loss_pct,
    slippage_tolerance_bps: b.slippage_tolerance_bps,
    time_stop_hours: b.time_stop_hours,
    api_token: apiToken,
  });

  // Atomic merge onto the existing user.json (if any).
  const userPath = ctx.cfg.paths?.user ?? 'config/user.json';
  /** @type {Object} */
  let existing = {};
  try {
    if (typeof ctx.readUserJson === 'function') {
      existing = await ctx.readUserJson(userPath);
    }
  } catch (_) {
    // No user.json yet — fine.
  }
  const merged = deepMerge(existing ?? {}, patch);

  try {
    const fsImpl = ctx.fs ?? undefined;
    const { atomicWriteJson, ensureDirForFile } = await import('../util/atomic-write.mjs');
    await ensureDirForFile(userPath, fsImpl);
    await atomicWriteJson(userPath, merged, fsImpl);
  } catch (e) {
    return { error: `failed to write user.json: ${e?.message ?? e}`, code: 'USER_JSON_WRITE_FAILED' };
  }

  // Mutate the in-memory cfg so subsequent reads (including the
  // post-write /api/setup/status call the wizard will fire) reflect
  // the new state. Mirrors updateConfig's same-line pattern.
  ctx.cfg = deepMerge(ctx.cfg, merged);
  if (ctx.cfg && (!('user' in ctx.cfg) || ctx.cfg.user === null)) {
    ctx.cfg.user = merged;
  }

  // Audit trail (best-effort; never blocks the response).
  try {
    const defaultConfigPath = (ctx.cfg && ctx.cfg.paths && typeof ctx.cfg.paths.default === 'string')
      ? ctx.cfg.paths.default
      : null;
    let repoRoot = process.cwd();
    if (defaultConfigPath) {
      // config/default.json → walk up two parents → repo root.
      // Fall back to cwd if the derived root is '/' (sentinel for
      // bogus absolute paths like '/nonexistent.json').
      const candidate = path.dirname(path.dirname(path.resolve(defaultConfigPath)));
      if (candidate && candidate !== '/' && candidate.length > 1) {
        repoRoot = candidate;
      }
    }
    const auditPath = path.join(repoRoot, 'logs', 'setup-audit.jsonl');
    const fsImpl = ctx.fs ?? (await import('node:fs/promises'));
    await fsImpl.mkdir(path.dirname(auditPath), { recursive: true });
    await fsImpl.appendFile(auditPath, JSON.stringify({
      schema: 'tradebot.setup.audit/v1',
      ts: new Date().toISOString(),
      mode: b.wallet_mode,
      network: b.network,
      cashaddr_prefix: truncateCashaddrForDisplay(walletResult.wallet.cashaddr),
      wallet_mode_requested: b.wallet_mode,
      // Note: WIF + mnemonic are NEVER logged, even redacted.
    }) + '\n');
  } catch (_) {
    // Best-effort. The write succeeded; the audit is bonus.
  }

  if (ctx.logger && typeof ctx.logger.info === 'function') {
    ctx.logger.info('dashboard.setup.applied', {
      mode: b.wallet_mode,
      network: b.network,
      cashaddr_prefix: truncateCashaddrForDisplay(walletResult.wallet.cashaddr),
    });
  }

  return {
    schema: 'tradebot.dashboard.setup.apply/v1',
    ts: new Date().toISOString(),
    user_path: userPath,
    network: b.network,
    cashaddr: walletResult.wallet.cashaddr,
    cashaddr_display: truncateCashaddrForDisplay(walletResult.wallet.cashaddr),
    api_token: apiToken,
    api_token_auto_generated: !(typeof b.api_token === 'string' && b.api_token.length > 0),
    generated_mnemonic: walletResult.generated_mnemonic ?? null,
    next_steps: [
      'config/user.json has been written (chmod 600, gitignored).',
      'Start the trading loop: `npm start` (or `node scripts/run-bot.mjs`).',
      'The dashboard now requires ?token=<api_token> to edit Settings or run manual trades.',
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Small utilities
// ─────────────────────────────────────────────────────────────────────

/**
 * Local deep-merge. Duplicated from the dashboard server's
 * `deepMerge` to keep this module independent (single-
 * responsibility for the wizard seam). Same semantics: scalars
 * from `b` win; nested plain objects recurse; arrays are opaque.
 */
function deepMerge(a, b) {
  if (b === undefined) return a;
  if (b === null || typeof b !== 'object' || Array.isArray(b)) return b;
  if (a === null || typeof a !== 'object' || Array.isArray(a)) return b;
  const out = {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    out[k] = deepMerge(/** @type {any} */ (a)[k], /** @type {any} */ (b)[k]);
  }
  return out;
}