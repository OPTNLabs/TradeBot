#!/usr/bin/env node
/**
 * scripts/init-wallet.mjs
 *
 * Generate (or import) the TradeBot bot wallet.
 *
 * The bot's wallet is a SINGLE BCH key derived from a BIP39 mnemonic at
 * `m/44'/145'/0'/0/0`. The mnemonic + WIF are written to
 * `config/user.json` (chmod 600, gitignored). The bot signs every
 * trade via libauth + the cached Electrum provider — `paytaca-cli`
 * is NEVER touched.
 *
 * Three modes:
 *
 *   --generate    Generate a fresh 12-word English BIP39 mnemonic,
 *                 derive the BIP44 path, write mnemonic + WIF to
 *                 user.json. (DEFAULT when --import is not given.)
 *
 *   --import      Restore from a BIP39 mnemonic supplied on the
 *                 command line (or from MNEMONIC env var, or from
 *                 a file passed via --mnemonic-file=PATH). Refuses
 *                 to overwrite an existing user.json unless
 *                 --force is also given.
 *
 *   --wif         Restore from a raw mainnet WIF (no mnemonic stored).
 *                 Operator-supplied. Refuses to overwrite an
 *                 existing user.json unless --force is also given.
 *
 * The script NEVER:
 *   - Imports the WIF into paytaca-cli's wallet slot (the user's
 *     paytaca wallet stays untouched).
 *   - Logs the raw mnemonic or WIF. The structured logger sees a
 *     `redact()`'d version only.
 *   - Broadcasts anything on-chain.
 *
 * Usage:
 *   node scripts/init-wallet.mjs                       # --generate
 *   node scripts/init-wallet.mjs --generate
 *   node scripts/init-wallet.mjs --generate --force    # overwrite existing user.json
 *   node scripts/init-wallet.mjs --import "<12 words>"
 *   node scripts/init-wallet.mjs --import --mnemonic-file=path/to/words.txt
 *   node scripts/init-wallet.mjs --wif "L1..<wif>.."
 *   node scripts/init-wallet.mjs --network=chipnet     # chipnet testnet
 *   node scripts/init-wallet.mjs --no-write            # print to stdout, don't write to disk
 *   node scripts/init-wallet.mjs --dry-run             # generate, print, don't write
 *   node scripts/init-wallet.mjs --help
 *
 * Exit codes:
 *   0  success
 *   1  config / user.json IO error
 *   2  bad CLI args
 *   3  generation / derivation failed
 *   4  user.json already exists (and --force was not passed)
 */

import process from 'node:process';
import { readFile } from 'node:fs/promises';

import { createLogger } from '../src/util/logger.mjs';
import { loadConfig, DEFAULT_CONFIG_PATHS } from '../src/util/config-loader.mjs';
import { atomicWriteJson } from '../src/util/atomic-write.mjs';
import { pathExists } from '../src/util/fs-helpers.mjs';
import {
  generateMainnetWallet,
  importFromMnemonic,
  importFromWif,
  redactWif,
  redactMnemonic,
  parseBip44Path,
  BIP39_DEFAULT_ENTROPY_BYTES,
} from '../src/wallet/init-helpers.mjs';

// ─── Logger ────────────────────────────────────────────────────────────────

const log = createLogger({ component: 'init-wallet', sink: process.stderr });

// ─── CLI ────────────────────────────────────────────────────────────────────

const HELP = `
TradeBot wallet init — generate or import the bot's mainnet WIF.

Usage:
  node scripts/init-wallet.mjs                        # --generate (default)
  node scripts/init-wallet.mjs --generate              # fresh BIP39 mnemonic
  node scripts/init-wallet.mjs --import "<12 words>"   # restore from mnemonic
  node scripts/init-wallet.mjs --import --mnemonic-file=PATH
  node scripts/init-wallet.mjs --wif "L..."            # restore from raw WIF
  node scripts/init-wallet.mjs --generate --force      # overwrite existing user.json
  node scripts/init-wallet.mjs --network=chipnet       # test network
  node scripts/init-wallet.mjs --dry-run               # don't write user.json
  node scripts/init-wallet.mjs --config-default=PATH   # override config path
  node scripts/init-wallet.mjs --config-user=PATH      # override user.json path
  node scripts/init-wallet.mjs --bip44-path="m/44'/145'/0'/0/1"  # override derivation
  node scripts/init-wallet.mjs --help

Exit codes:
  0  success
  1  config / IO error
  2  bad CLI args
  3  generation / derivation failed
  4  user.json already exists (and --force was not passed)

This script NEVER imports the WIF into paytaca-cli. The bot signs
directly via libauth + the cashscript Electrum provider.
`.trim();

/**
 * Parse CLI args. Boolean flags (`--generate`, `--import`, `--force`,
 * `--dry-run`) are set to `true`. String flags take an `=value` form.
 *
 * @param {string[]} argv
 * @returns {{ flags: Record<string, string|true>, positional: string[] }}
 */
export function parseInitArgs(argv) {
  const flags = {};
  const positional = [];
  for (const arg of argv.slice(2)) {
    if (arg === '--') continue;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq >= 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        flags[arg.slice(2)] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

/**
 * Resolve the mode (generate / import / wif) from parsed flags. Pure.
 *
 * @param {{ flags: Record<string, string|true>, positional: string[] }} parsed
 * @returns {'generate'|'import'|'wif'}
 */
export function resolveInitMode(parsed) {
  if (parsed.flags['wif'] === true || typeof parsed.flags['wif'] === 'string') return 'wif';
  if (parsed.flags.import === true) return 'import';
  if (parsed.flags.generate === true) return 'generate';
  return 'generate';
}

/**
 * Pull the mnemonic string out of the parsed args, env, or file.
 * Order: positional[0] (when --import) → MNEMONIC env →
 * --mnemonic-file=PATH.
 *
 * @param {{ flags: Record<string, string|true>, positional: string[] }} parsed
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<string>}
 */
export async function resolveMnemonicInput(parsed, env = process.env) {
  if (parsed.positional.length > 0 && parsed.flags.import === true) {
    return parsed.positional[0].trim();
  }
  if (typeof parsed.flags['mnemonic-file'] === 'string') {
    const raw = await readFile(parsed.flags['mnemonic-file'], 'utf8');
    // Mnemonic lines can be space- or newline-separated; both are
    // valid BIP39. Trim each token, drop empties.
    const tokens = raw.split(/\s+/).map((s) => s.trim()).filter(Boolean);
    if (tokens.length === 0) {
      throw new Error(`init-wallet: --mnemonic-file=${parsed.flags['mnemonic-file']} is empty`);
    }
    return tokens.join(' ');
  }
  if (typeof env.MNEMONIC === 'string' && env.MNEMONIC.trim().length > 0) {
    return env.MNEMONIC.trim();
  }
  throw new Error('init-wallet: --import requires a mnemonic on the command line, '
    + '--mnemonic-file=PATH, or MNEMONIC env var');
}

/**
 * Pull the WIF string out of the parsed args.
 * Order: --wif=<wif> → positional[0] (when --wif) → WIF_PRIVKEY env.
 *
 * @param {{ flags: Record<string, string|true>, positional: string[] }} parsed
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveWifInput(parsed, env = process.env) {
  if (typeof parsed.flags.wif === 'string') return parsed.flags.wif.trim();
  if (parsed.flags.wif === true && parsed.positional.length > 0) return parsed.positional[0].trim();
  if (typeof env.WIF_PRIVKEY === 'string' && env.WIF_PRIVKEY.trim().length > 0) {
    return env.WIF_PRIVKEY.trim();
  }
  throw new Error('init-wallet: --wif requires a WIF on the command line or WIF_PRIVKEY env var');
}

/**
 * Build the user.json record we're about to write. Pure — exported so
 * tests can pin the shape.
 *
 * @param {Object} args
 * @param {Object} args.derived       { address, network, bip44Path, wif, mnemonic?, mnemonicWordCount? }
 * @param {Object} args.cfg           loaded config (for any default fields)
 * @param {string} [args.wifSource]   human-readable origin (file path, env var name, etc.)
 * @returns {Object}
 */
export function buildUserJson({ derived, cfg, wifSource }) {
  if (!derived || typeof derived !== 'object') throw new Error('buildUserJson: derived required');
  if (!cfg || typeof cfg !== 'object') throw new Error('buildUserJson: cfg required');
  const w = cfg.wallet ?? {};
  const ds = cfg.data_sources ?? {};
  /** @type {Object} */
  const out = {
    version: 1,
    generated_at: new Date().toISOString(),
    wallet: {
      backend: 'external_wif',
      bip44_path: derived.bip44Path,
      network: derived.network,
      address: derived.address,
      cashaddr: derived.address,
      wif: derived.wif,
      wif_source: wifSource ?? null,
    },
  };
  if (typeof derived.mnemonic === 'string') {
    out.wallet.mnemonic = derived.mnemonic;
    out.wallet.mnemonic_word_count = derived.mnemonicWordCount ?? derived.mnemonic.split(/\s+/).filter(Boolean).length;
  }
  // Carry the original default.json wallet-network override through, so
  // a subsequent `run-bot.mjs` can resolve the wallet without ambiguity.
  if (w.network && w.network !== derived.network) {
    out.wallet.network = derived.network;
  }
  if (ds.electrum_host) out.wallet.electrum_host = ds.electrum_host;
  if (ds.electrum_port) out.wallet.electrum_port = ds.electrum_port;
  return out;
}

// ─── Wire up ────────────────────────────────────────────────────────────────

/**
 * Main entry. Returns an `{ ok, mode, written, derived }` summary.
 *
 * @param {string[]} argv
 * @returns {Promise<{ ok: boolean, mode: string, written: boolean, derived: Object, error?: string }>}
 */
export async function main(argv = process.argv) {
  const parsed = parseInitArgs(argv);
  if (parsed.flags.help === true || parsed.flags['?'] === true || parsed.flags.h === true) {
    process.stdout.write(HELP + '\n');
    return { ok: true, mode: 'help', written: false, derived: {} };
  }

  const mode = resolveInitMode(parsed);
  const cfgDefaultPath = typeof parsed.flags['config-default'] === 'string'
    ? parsed.flags['config-default']
    : DEFAULT_CONFIG_PATHS.default;
  const cfgUserPath = typeof parsed.flags['config-user'] === 'string'
    ? parsed.flags['config-user']
    : DEFAULT_CONFIG_PATHS.user;
  const cfg = await loadConfig({ defaultPath: cfgDefaultPath, userPath: cfgUserPath });
  const network = typeof parsed.flags.network === 'string'
    ? parsed.flags.network
    : (cfg.wallet?.network ?? 'mainnet');
  const bip44Path = typeof parsed.flags['bip44-path'] === 'string'
    ? parsed.flags['bip44-path']
    : (cfg.wallet?.bip44_path ?? "m/44'/145'/0'/0/0");

  const force = parsed.flags.force === true;
  const dryRun = parsed.flags['dry-run'] === true || parsed.flags['no-write'] === true;

  // Resolve user.json path (the merged config has `paths.user` from the loader).
  const userPath = (cfg.paths?.user && typeof cfg.paths.user === 'string')
    ? cfg.paths.user
    : cfgUserPath;
  /** @type {boolean} */
  let userJsonExists = false;
  try {
    userJsonExists = await pathExists(userPath);
  } catch (e) {
    log.error('init-wallet.exists-check-failed', {
      user_path: userPath,
      err_name: e?.name ?? 'Error',
      err_message: e?.message ?? String(e),
    });
    return { ok: false, mode, written: false, derived: {}, error: `exists-check: ${e?.message ?? e}` };
  }

  if (userJsonExists && !force && !dryRun) {
    const msg = `init-wallet: ${userPath} already exists. Re-run with --force to overwrite, `
      + `or use --import/--wif to load the existing key into memory without writing.`;
    log.warn('init-wallet.refusing-overwrite', { user_path: userPath });
    process.stderr.write(msg + '\n');
    return { ok: false, mode, written: false, derived: {}, error: msg };
  }

  /** @type {Object} */
  let derived;
  let wifSource = null;
  try {
    if (mode === 'generate') {
      // Verify the BIP44 path string parses before we generate entropy
      // (cheap fail-fast on a typo like `m/44'/145'/0/0/0`).
      parseBip44Path(bip44Path);
      derived = await generateMainnetWallet({ bip44Path, network });
      wifSource = `generated by init-wallet.mjs (network=${network}, bip44_path=${bip44Path})`;
    } else if (mode === 'import') {
      const mnemonic = await resolveMnemonicInput(parsed);
      parseBip44Path(bip44Path);
      derived = await importFromMnemonic({ mnemonic, bip44Path, network });
      wifSource = parsed.positional.length > 0
        ? 'init-wallet --import (command-line mnemonic)'
        : (typeof parsed.flags['mnemonic-file'] === 'string'
            ? `init-wallet --import (file: ${parsed.flags['mnemonic-file']})`
            : 'init-wallet --import (MNEMONIC env var)');
    } else if (mode === 'wif') {
      const wif = resolveWifInput(parsed);
      derived = await importFromWif({ wif, network });
      wifSource = parsed.positional.length > 0
        ? 'init-wallet --wif (command-line WIF)'
        : 'init-wallet --wif (WIF_PRIVKEY env var)';
    } else {
      throw new Error(`init-wallet: unknown mode ${mode}`);
    }
  } catch (e) {
    log.error('init-wallet.derive.failed', {
      mode,
      network,
      bip44_path: bip44Path,
      err_name: e?.name ?? 'Error',
      err_message: e?.message ?? String(e),
    });
    return { ok: false, mode, written: false, derived: {}, error: `derive: ${e?.message ?? e}` };
  }

  // Build the user.json record. ALWAYS use the cashaddr that matches
  // the actual on-chain derivation — never the operator-claimed one.
  const userJson = buildUserJson({ derived, cfg, wifSource });

  // Output. Dry-run prints to stdout + does NOT write. Otherwise we
  // also write to disk (atomic).
  const redactedSummary = {
    ok: true,
    mode,
    network: derived.network,
    bip44_path: derived.bip44Path,
    address: derived.address,
    cashaddr: derived.address,
    wif: redactWif(derived.wif),
    mnemonic: derived.mnemonic ? redactMnemonic(derived.mnemonic) : null,
    mnemonic_word_count: userJson.wallet.mnemonic_word_count ?? null,
    user_json_path: userPath,
    written: false,
  };

  if (dryRun) {
    log.info('init-wallet.dry_run', {
      mode,
      network: derived.network,
      address: derived.address,
      bip44_path: derived.bip44Path,
      wif: redactWif(derived.wif),
      mnemonic: derived.mnemonic ? redactMnemonic(derived.mnemonic) : null,
    });
    process.stdout.write(JSON.stringify({ ...redactedSummary, user_json: userJson }, null, 2) + '\n');
    return { ok: true, mode, written: false, derived };
  }

  try {
    await atomicWriteJson(userPath, userJson);
    log.info('init-wallet.wrote', {
      mode,
      user_path: userPath,
      network: derived.network,
      address: derived.address,
      bip44_path: derived.bip44Path,
      wif: redactWif(derived.wif),
    });
    process.stdout.write(JSON.stringify({ ...redactedSummary, written: true }, null, 2) + '\n');
    return { ok: true, mode, written: true, derived };
  } catch (e) {
    log.error('init-wallet.write.failed', {
      user_path: userPath,
      err_name: e?.name ?? 'Error',
      err_message: e?.message ?? String(e),
    });
    return { ok: false, mode, written: false, derived, error: `write: ${e?.message ?? e}` };
  }
}

// ─── Entry ──────────────────────────────────────────────────────────────────

// Direct invocation
const isDirect = import.meta.url === `file://${process.argv[1]}` ||
                 process.argv[1]?.endsWith('init-wallet.mjs');
if (isDirect) {
  main(process.argv).then((r) => {
    if (!r.ok && r.error) {
      // Re-throw so process exits non-zero. The error message has
      // already been logged via the structured logger.
      process.exit(1);
    }
    process.exit(0);
  });
}

// Suppress unused-import warning for BIP39_DEFAULT_ENTROPY_BYTES
// (imported for the test suite + future callers who want a
// different entropy length).
void BIP39_DEFAULT_ENTROPY_BYTES;