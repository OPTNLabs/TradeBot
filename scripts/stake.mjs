#!/usr/bin/env node
// scripts/stake.mjs
//
// T58 subset 2 — BadgerCoin staking CLI (lock + unlock, sign + broadcast).
//
// Operator-facing write path: builds + signs + broadcasts BadgerStake
// lock / unlock transactions. Wraps `src/staking/badger-stake-tx.mjs`
// (subset 2) on top of subset 1's read-only surface
// (`src/staking/badger-stake.mjs`).
//
// The CLI never holds a WIF outside the wallet object — every signing
// call routes through `LibAuthBchWallet.signHash` (or the cashscript
// SignatureTemplate bound to the wallet's WIF). The wallet reads its
// WIF from `config/user.json`; this CLI just hands the wallet the WIF
// it already has.
//
// Usage:
//   node scripts/stake.mjs --lock --amount=500000 --blocks=1440 --dry-run
//   node scripts/stake.mjs --lock --amount=500000 --blocks=1440 --json
//   node scripts/stake.mjs --lock --amount=500000 --blocks=1440 --fee-sat-per-byte=1.0
//   node scripts/stake.mjs --lock --amount=500000 --blocks=1440 --chipnet
//   node scripts/stake.mjs --unlock --lock-commitment=<hex> --lock-txid=<hex> --lock-vout=0 --dry-run
//   node scripts/stake.mjs --unlock --lock-commitment=<hex> --lock-txid=<hex> --lock-vout=0
//   node scripts/stake.mjs --quiet --lock --amount=500000 --blocks=1440
//   node scripts/stake.mjs --help
//
// Exit codes:
//   0 — operation succeeded (txid returned).
//   1 — invalid CLI args (unknown flag, missing required knob, bad shape).
//   2 — config / network error (config missing, watchtower unreachable, Electrum throw).
//   3 — simulation / pre-build rejection (below min balance, stale lock, bad params, no master, no userPkh).
//   4 — broadcast / sign error (Electrum rejected, signature failed).
//
// Auto-mode + dashboard tile + unlock-cron are deferred to T58-3 / T58-4 / T58-5.

import process from 'node:process';

import {
  executeLock,
  executeUnlock,
} from '../src/staking/badger-stake-tx.mjs';

import {
  DEFAULT_STAKING_CONFIG,
  MAX_STAKE_BLOCKS,
  resolveStakingConfig,
} from '../src/staking/badger-stake.mjs';

const KNOWN_FLAGS = new Set([
  'lock',
  'unlock',
  'amount',
  'blocks',
  'user-pkh',
  'lock-commitment',
  'lock-txid',
  'lock-vout',
  'fee-sat-per-byte',
  'chipnet',
  'json',
  'quiet',
  'dry-run',
  'help',
]);

/**
 * Parse argv into a flat `flags` map + `positional` array.
 * Mirrors the parser used by `scripts/stake-inspect.mjs` + the rest
 * of the TradeBot CLIs. Exported so `tests/scripts.test.mjs` can
 * drive it without spawning a child process.
 *
 * @param {string[]} argv
 * @returns {{ flags: Record<string, string|boolean>, positional: string[] }}
 */
export function parseStakeArgs(argv) {
  const flags = {};
  const positional = [];
  if (!Array.isArray(argv)) argv = ['node', 'stake.mjs'];
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (typeof a !== 'string') continue;
    if (a === '--') continue;
    if (a.startsWith('--')) {
      const body = a.slice(2);
      const eq = body.indexOf('=');
      let key;
      let val;
      if (eq >= 0) {
        key = body.slice(0, eq);
        val = body.slice(eq + 1);
      } else {
        key = body;
        const next = argv[i + 1];
        if (typeof next === 'string' && !next.startsWith('--')) {
          val = next;
          i += 1;
        } else {
          val = true;
        }
      }
      if (typeof key === 'string' && key.length > 0) flags[key] = val;
      continue;
    }
    positional.push(a);
  }
  return { flags, positional };
}

/**
 * Normalize raw flags into a typed options object. Rejects unknown
 * flags + validates ranges + enforces cross-flag requirements. Pure.
 *
 * @param {Record<string, string|boolean>} flags
 * @returns {{ ok: true, opts: Object } | { ok: false, error: string, field: string }}
 */
export function normalizeStakeFlags(flags) {
  const out = {
    lock: false,
    unlock: false,
    amountSats: null,
    stakeBlocks: null,
    userPkh: null,
    lockCommitment: null,
    lockTxid: null,
    lockVout: null,
    feeSatPerByte: null,
    network: null,
    chipnet: false,
    json: false,
    quiet: false,
    dryRun: false,
    help: false,
  };

  const requireNumber = (k, raw, { min = 0, max = Number.POSITIVE_INFINITY, integer = false } = {}) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || (integer && !Number.isInteger(n)) || n > max) {
      const shape = integer ? 'integer' : 'number';
      const range = (max === Number.POSITIVE_INFINITY) ? `>= ${min}` : `${min}..${max}`;
      return { ok: false, error: `flag --${k} requires a ${shape} ${range} (got "${raw}")`, field: k };
    }
    return { ok: true, value: n };
  };

  for (const k of Object.keys(flags)) {
    if (!KNOWN_FLAGS.has(k)) {
      return { ok: false, error: `unknown flag --${k}`, field: k };
    }
    const v = flags[k];
    const isTrue = (x) => x === true || x === 'true';
    if (k === 'lock') out.lock = isTrue(v);
    else if (k === 'unlock') out.unlock = isTrue(v);
    else if (k === 'chipnet') out.chipnet = isTrue(v);
    else if (k === 'json') out.json = isTrue(v);
    else if (k === 'quiet') out.quiet = isTrue(v);
    else if (k === 'dry-run') out.dryRun = isTrue(v);
    else if (k === 'help') out.help = isTrue(v);
    else if (k === 'amount') {
      const r = requireNumber(k, v, { min: 0 });
      if (!r.ok) return r;
      out.amountSats = BigInt(Math.floor(r.value));
    } else if (k === 'blocks') {
      const r = requireNumber(k, v, { min: 0, max: MAX_STAKE_BLOCKS, integer: true });
      if (!r.ok) return r;
      out.stakeBlocks = r.value;
    } else if (k === 'user-pkh') {
      if (typeof v !== 'string') return { ok: false, error: `--user-pkh requires a hex value`, field: k };
      out.userPkh = v;
    } else if (k === 'lock-commitment') {
      if (typeof v !== 'string') return { ok: false, error: `--lock-commitment requires a hex value`, field: k };
      out.lockCommitment = v;
    } else if (k === 'lock-txid') {
      if (typeof v !== 'string') return { ok: false, error: `--lock-txid requires a hex value`, field: k };
      out.lockTxid = v;
    } else if (k === 'lock-vout') {
      const r = requireNumber(k, v, { min: 0, integer: true });
      if (!r.ok) return r;
      out.lockVout = r.value;
    } else if (k === 'fee-sat-per-byte') {
      const r = requireNumber(k, v, { min: 0 });
      if (!r.ok) return r;
      out.feeSatPerByte = r.value;
    }
  }

  // Cross-flag validation.
  if (out.lock && out.unlock) {
    return { ok: false, error: '--lock and --unlock are mutually exclusive', field: 'lock' };
  }
  if (!out.lock && !out.unlock && !out.help) {
    return { ok: false, error: 'must specify --lock or --unlock (or --help)', field: 'lock' };
  }
  if (out.lock && out.amountSats === null) {
    return { ok: false, error: '--lock requires --amount=<sats>', field: 'amount' };
  }
  if (out.lock && out.stakeBlocks === null) {
    return { ok: false, error: '--lock requires --blocks=<blocks>', field: 'blocks' };
  }
  if (out.unlock && (out.lockCommitment === null || out.lockTxid === null || out.lockVout === null)) {
    return {
      ok: false,
      error: '--unlock requires --lock-commitment=<hex> --lock-txid=<hex> --lock-vout=<n>',
      field: 'unlock',
    };
  }

  return { ok: true, opts: out };
}

/** Pure: render the canonical help text. */
export function formatStakeHelp() {
  return [
    'Usage: node scripts/stake.mjs [options]',
    '',
    'Lock action (build + sign + broadcast a BadgerStake lock tx):',
    '  --lock                           Engage the lock path.',
    '    --amount=<sats>                  Amount to lock in sats (must be >= 5000).',
    '    --blocks=<blocks>                Stake length in blocks (0..65536).',
    '    --user-pkh=<hex20>               Override the user pubkey-hash (default: derived from wallet).',
    '',
    'Unlock action (build + sign + broadcast a BadgerStake unlock tx):',
    '  --unlock                         Engage the unlock path.',
    '    --lock-commitment=<hex>           The 40-byte lockNFT commitment (the operator saw it via',
    '                                       scripts/stake-inspect.mjs --decode-commitment).',
    '    --lock-txid=<hex>                 The lock txid (the UTXO ref).',
    '    --lock-vout=<n>                   The lock vout.',
    '',
    'Flags:',
    '  --fee-sat-per-byte=<n>           Fee rate (default: cfg.staking.fee_sat_per_byte, default 1).',
    '  --chipnet                        Switch the network to chipnet (testnet).',
    '  --dry-run                        Build the tx + simulate, but do NOT broadcast.',
    '  --json                           Emit machine-readable JSON instead of human-readable text.',
    '  --quiet                          Suppress the success line (still emits JSON when --json).',
    '  --help                           Print this message and exit.',
    '',
    'Exit codes: 0=ok, 1=bad-args, 2=config/network, 3=simulate-refusal, 4=sign/broadcast.',
  ].join('\n');
}

/**
 * Run the lock action. Pure-shape: takes pre-resolved config + a
 * lazy `deps.bootWallet` so tests can inject a stub wallet without
 * touching the real Electrum provider.
 *
 * @param {Object} args
 * @param {Object} args.cfg                  resolved config (must contain `cfg.staking`)
 * @param {Object} args.opts                 normalized CLI flags (from normalizeStakeFlags)
 * @param {Object} [args.deps]               { bootWallet, provider, logger, nowMs }
 * @returns {Promise<{ ok: boolean, text: string, exitCode: 0|2|3|4 }>}
 */
export async function runLockAction({ cfg, opts, deps = {} }) {
  const cfgResolved = resolveStakingConfig(cfg?.staking ?? {});
  const logger = deps.logger ?? { info: () => {}, warn: () => {}, error: () => {} };

  if (opts.dryRun) {
    // Dry-run: skip wallet boot + broadcast, just confirm we WOULD act.
    const preview = {
      ok: true,
      dryRun: true,
      action: 'lock',
      amount_sats: opts.amountSats?.toString(),
      stake_blocks: opts.stakeBlocks,
      network: opts.chipnet ? 'chipnet' : (opts.network ?? cfgResolved.network),
      contract_address: cfgResolved.contract_address,
      fee_sat_per_byte: opts.feeSatPerByte ?? cfgResolved.fee_sat_per_byte ?? 1,
      lock_min_balance_bch: cfgResolved.lock_min_balance_bch,
      note: 'dry-run: no wallet boot, no broadcast. Re-run without --dry-run to actually sign + broadcast.',
    };
    return { ok: true, text: opts.json ? JSON.stringify(preview, null, 2) : renderDryRunPreview(preview), exitCode: 0 };
  }

  let wallet;
  try {
    const bootWallet = deps.bootWallet ?? (await import('../src/wallet/libauth.mjs')).bootLibAuthBchWallet;
    wallet = await bootWallet({ config: cfg });
  } catch (e) {
    return {
      ok: false,
      text: JSON.stringify({ ok: false, code: 'WALLET_BOOT', error: `wallet boot threw: ${e.message}`, cause: e.message }),
      exitCode: 2,
    };
  }
  if (!wallet || (typeof wallet.getWif !== 'function' && typeof wallet.wif !== 'string')) {
    return {
      ok: false,
      text: JSON.stringify({ ok: false, code: 'WIF_MISSING', error: 'wallet has no WIF — run scripts/init-wallet.mjs first' }),
      exitCode: 2,
    };
  }

  let provider;
  try {
    const providerFactory = deps.providerFactory ?? (() => null);
    provider = providerFactory(cfg);
  } catch (e) {
    return {
      ok: false,
      text: JSON.stringify({ ok: false, code: 'ELECTRUM_URL', error: `provider factory threw: ${e.message}` }),
      exitCode: 2,
    };
  }
  if (!provider) {
    return {
      ok: false,
      text: JSON.stringify({ ok: false, code: 'ELECTRUM_URL', error: 'no Electrum provider — set wallet.electrum_url in config' }),
      exitCode: 2,
    };
  }

  const result = await executeLock({
    cfg: cfgResolved,
    wallet,
    provider,
    amountSats: opts.amountSats,
    stakeBlocks: opts.stakeBlocks,
    userPkhHex: opts.userPkh ?? wallet.getPkh?.() ?? null,
    logger,
    deps: {
      fetchMasterState: deps.fetchMasterState,
      cashscript: deps.cashscript,
      SignatureTemplate: deps.SignatureTemplate,
      artifact: deps.artifact,
      simulateLock: deps.simulateLock,
      nowMs: deps.nowMs,
    },
  });

  if (!result || result.ok !== true) {
    const code = result?.code ?? 'UNKNOWN';
    const exitCode = code === 'BROADCAST' ? 4 : 3;
    return {
      ok: false,
      text: opts.json ? JSON.stringify({ ok: false, code, ...result }, null, 2) : renderFailure(code, result),
      exitCode,
    };
  }

  const summary = {
    ok: true,
    action: 'lock',
    txid: result.txid,
    amount_sats: result.amountSats,
    stake_blocks: result.stakeBlocks,
    fee_sats: result.fee,
    note: 'lock broadcast — confirm with stake-inspect --inspect-master + watch the lockNFT appear in your wallet.',
  };
  return {
    ok: true,
    text: opts.json ? JSON.stringify(summary, null, 2) : renderLockSuccess(summary),
    exitCode: 0,
  };
}

/**
 * Run the unlock action. Pure-shape: lazy wallet boot + injected deps.
 *
 * @param {Object} args
 * @param {Object} args.cfg
 * @param {Object} args.opts
 * @param {Object} [args.deps]
 * @returns {Promise<{ ok: boolean, text: string, exitCode: 0|2|3|4 }>}
 */
export async function runUnlockAction({ cfg, opts, deps = {} }) {
  const cfgResolved = resolveStakingConfig(cfg?.staking ?? {});
  const logger = deps.logger ?? { info: () => {}, warn: () => {}, error: () => {} };

  if (opts.dryRun) {
    const preview = {
      ok: true,
      dryRun: true,
      action: 'unlock',
      lock_commitment: opts.lockCommitment,
      lock_txid: opts.lockTxid,
      lock_vout: opts.lockVout,
      network: opts.chipnet ? 'chipnet' : (opts.network ?? cfgResolved.network),
      contract_address: cfgResolved.contract_address,
      fee_sat_per_byte: opts.feeSatPerByte ?? cfgResolved.fee_sat_per_byte ?? 1,
      note: 'dry-run: no wallet boot, no broadcast. Re-run without --dry-run to actually sign + broadcast.',
    };
    return { ok: true, text: opts.json ? JSON.stringify(preview, null, 2) : renderDryRunPreview(preview), exitCode: 0 };
  }

  let wallet;
  try {
    const bootWallet = deps.bootWallet ?? (await import('../src/wallet/libauth.mjs')).bootLibAuthBchWallet;
    wallet = await bootWallet({ config: cfg });
  } catch (e) {
    return {
      ok: false,
      text: JSON.stringify({ ok: false, code: 'WALLET_BOOT', error: `wallet boot threw: ${e.message}`, cause: e.message }),
      exitCode: 2,
    };
  }

  let provider;
  try {
    const providerFactory = deps.providerFactory ?? (() => null);
    provider = providerFactory(cfg);
  } catch (e) {
    return {
      ok: false,
      text: JSON.stringify({ ok: false, code: 'ELECTRUM_URL', error: `provider factory threw: ${e.message}` }),
      exitCode: 2,
    };
  }
  if (!provider) {
    return {
      ok: false,
      text: JSON.stringify({ ok: false, code: 'ELECTRUM_URL', error: 'no Electrum provider — set wallet.electrum_url in config' }),
      exitCode: 2,
    };
  }

  // Pull the lock UTXO from the wallet's UTXO set (by txid+vout).
  // The wallet MUST already hold the lockNFT for the unlock to be
  // signable — `executeUnlock` rejects if it can't find the UTXO.
  let utxos;
  try {
    utxos = await wallet.listUtxos();
  } catch (e) {
    return {
      ok: false,
      text: JSON.stringify({ ok: false, code: 'PROVIDER', error: `wallet.listUtxos threw: ${e.message}` }),
      exitCode: 2,
    };
  }
  if (!Array.isArray(utxos)) {
    return {
      ok: false,
      text: JSON.stringify({ ok: false, code: 'WALLET_BOOT', error: 'wallet.listUtxos returned non-array' }),
      exitCode: 2,
    };
  }
  const lockUtxo = utxos.find((u) => u && u.txid === opts.lockTxid && u.vout === opts.lockVout);
  if (!lockUtxo) {
    return {
      ok: false,
      text: JSON.stringify({ ok: false, code: 'NO_LOCK_UTXO', error: `no UTXO at ${opts.lockTxid}:${opts.lockVout} in wallet's UTXO set` }),
      exitCode: 3,
    };
  }

  const result = await executeUnlock({
    cfg: cfgResolved,
    wallet,
    provider,
    lockUtxo,
    userPkh: opts.userPkh ?? wallet.getPkh?.() ?? null,
    logger,
    deps: {
      cashscript: deps.cashscript,
      SignatureTemplate: deps.SignatureTemplate,
      artifact: deps.artifact,
      simulateUnlock: deps.simulateUnlock,
      nowMs: deps.nowMs,
    },
  });

  if (!result || result.ok !== true) {
    const code = result?.code ?? 'UNKNOWN';
    const exitCode = code === 'BROADCAST' ? 4 : 3;
    return {
      ok: false,
      text: opts.json ? JSON.stringify({ ok: false, code, ...result }, null, 2) : renderFailure(code, result),
      exitCode,
    };
  }

  const summary = {
    ok: true,
    action: 'unlock',
    txid: result.txid,
    unlocked_sats: result.unlockedSats,
    badger_coin_amount: result.badgerCoinAmount,
    fee_sats: result.fee,
    note: 'unlock broadcast — the lockNFT is spent; the BCH + BadgerCoin returns to your wallet.',
  };
  return {
    ok: true,
    text: opts.json ? JSON.stringify(summary, null, 2) : renderUnlockSuccess(summary),
    exitCode: 0,
  };
}

function renderDryRunPreview(p) {
  const lines = [
    `Dry-run: would ${p.action} — no broadcast.`,
    `  network:               ${p.network}`,
    `  contract_address:      ${p.contract_address}`,
    `  fee_sat_per_byte:      ${p.fee_sat_per_byte}`,
    `  lock_min_balance_bch:  ${p.lock_min_balance_bch}`,
  ];
  if (p.action === 'lock') {
    lines.push(`  amount_sats:           ${p.amount_sats}`);
    lines.push(`  stake_blocks:          ${p.stake_blocks}`);
  } else {
    lines.push(`  lock_commitment:       ${p.lock_commitment}`);
    lines.push(`  lock_txid:             ${p.lock_txid}`);
    lines.push(`  lock_vout:             ${p.lock_vout}`);
  }
  lines.push('');
  lines.push(p.note);
  return lines.join('\n');
}

function renderFailure(code, result) {
  const lines = [
    `Stake operation FAILED (${code}).`,
    `  error: ${result?.error ?? '(none)'}`,
  ];
  if (result?.wallet_balance_sats) lines.push(`  wallet_balance_sats: ${result.wallet_balance_sats}`);
  if (result?.min_balance_bch !== undefined) lines.push(`  min_balance_bch:     ${result.min_balance_bch}`);
  if (result?.lock_nft_count !== undefined) lines.push(`  lock_nft_count:      ${result.lock_nft_count}`);
  if (result?.violations && result.violations.length > 0) {
    lines.push(`  violations:`);
    for (const v of result.violations) lines.push(`    - ${v}`);
  }
  return lines.join('\n');
}

function renderLockSuccess(s) {
  return [
    `Lock broadcast OK.`,
    `  txid:           ${s.txid}`,
    `  amount_sats:    ${s.amount_sats}`,
    `  stake_blocks:   ${s.stake_blocks}`,
    `  fee_sats:       ${s.fee_sats}`,
    '',
    s.note,
  ].join('\n');
}

function renderUnlockSuccess(s) {
  return [
    `Unlock broadcast OK.`,
    `  txid:                  ${s.txid}`,
    `  unlocked_sats:         ${s.unlocked_sats}`,
    `  badger_coin_amount:    ${s.badger_coin_amount}`,
    `  fee_sats:              ${s.fee_sats}`,
    '',
    s.note,
  ].join('\n');
}

/**
 * Pure main. Loads + normalizes args, dispatches to the right handler.
 * `cfg` is the full TradeBot config (so `cfg.staking` + `cfg.wallet`
 * both flow in); `deps` are the injectable seams.
 *
 * @param {Object} args
 * @param {string[]} args.argv
 * @param {Object}   [args.cfg]
 * @param {Object}   [args.deps]               { loadConfig, bootWallet, providerFactory, ... }
 * @returns {Promise<{ ok: boolean, text: string, exitCode: 0|1|2|3|4 }>}
 */
export async function main({ argv, cfg, deps = {} } = {}) {
  const args = Array.isArray(argv) ? argv : ['node', 'stake.mjs'];
  const parsed = parseStakeArgs(args);
  const norm = normalizeStakeFlags(parsed.flags);
  if (!norm.ok) {
    return { ok: false, text: JSON.stringify({ ok: false, error: norm.error, field: norm.field }), exitCode: 1 };
  }
  const opts = norm.opts;
  if (opts.help) {
    return { ok: true, text: formatStakeHelp(), exitCode: 0 };
  }

  let cfgResolved = cfg;
  if (!cfgResolved) {
    if (typeof deps.loadConfig !== 'function') {
      return {
        ok: false,
        text: JSON.stringify({ ok: false, code: 'CONFIG_LOAD', error: 'no cfg provided and deps.loadConfig missing' }),
        exitCode: 2,
      };
    }
    try {
      cfgResolved = await deps.loadConfig();
    } catch (e) {
      return {
        ok: false,
        text: JSON.stringify({ ok: false, code: 'CONFIG_LOAD', error: `loadConfig threw: ${e.message}` }),
        exitCode: 2,
      };
    }
  }

  if (opts.chipnet && cfgResolved?.staking) {
    cfgResolved = {
      ...cfgResolved,
      staking: {
        ...(cfgResolved.staking ?? {}),
        network: 'chipnet',
      },
    };
  }

  if (opts.lock) return runLockAction({ cfg: cfgResolved, opts, deps });
  if (opts.unlock) return runUnlockAction({ cfg: cfgResolved, opts, deps });
  return { ok: false, text: JSON.stringify({ ok: false, error: 'no operation specified (try --lock, --unlock, or --help)' }), exitCode: 1 };
}

// ─────────────────────────────────────────────────────────────────────
// CLI dispatch (only when invoked directly, NOT when imported)
// ─────────────────────────────────────────────────────────────────────

const isDirect = (() => {
  try {
    const url = new URL(import.meta.url);
    return url.pathname === process.argv[1] || url.pathname.endsWith(process.argv[1] ?? '');
  } catch (_e) {
    return false;
  }
})();

if (isDirect) {
  let cfg;
  try {
    const { loadConfig } = await import('../src/util/config-loader.mjs');
    cfg = await loadConfig();
  } catch (e) {
    process.stderr.write(JSON.stringify({ ok: false, code: 'CONFIG_LOAD', error: `loadConfig threw: ${e.message}` }) + '\n');
    process.exit(2);
  }
  const { ok, text, exitCode } = await main({ argv: process.argv, cfg });
  if (exitCode === 0 && !process.argv.includes('--quiet')) {
    process.stdout.write(text + '\n');
  } else if (exitCode === 0 && process.argv.includes('--quiet')) {
    // quiet success: still emit if --json was requested (the JSON
    // is the structured output; suppressing it would defeat the
    // purpose of --quiet for piping).
    if (process.argv.includes('--json')) process.stdout.write(text + '\n');
  } else {
    process.stderr.write(text + '\n');
  }
  process.exit(exitCode);
}
