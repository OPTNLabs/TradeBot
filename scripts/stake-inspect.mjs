#!/usr/bin/env node
// scripts/stake-inspect.mjs
//
// T58 subset 1 — BadgerCoin staking CLI (inspection + simulation).
//
// Read-only operator tool: never signs, never broadcasts, never
// touches a private key. Wraps `src/staking/badger-stake.mjs` so the
// operator can:
//   1. Inspect the masterBadger UTXO at the BadgersStake contract
//      address (network-aware: mainnet default, --chipnet for testnet).
//   2. Inspect an existing lockNFT UTXO by commitment hex.
//   3. Simulate a proposed `lock(amount, stakeBlocks, pubkeyhash)` call
//      without signing — surfaces the expected reward + the contract's
//      required-input/output layout + every violation found.
//   4. Simulate a proposed `unlock()` call given a lockUTXO shape.
//
// Subset 2 (T58-2, deferred) wires the actual sign + broadcast + the
// trader-loop auto-stake + the dashboard tile. Subset 1 deliberately
// ships ONLY the read-only surface so the operator can validate the
// contract math + economics before any real BCH moves.
//
// Usage:
//   node scripts/stake-inspect.mjs --inspect-master
//   node scripts/stake-inspect.mjs --inspect-master --chipnet
//   node scripts/stake-inspect.mjs --inspect-master --json
//   node scripts/stake-inspect.mjs --decode-commitment=<hex>
//   node scripts/stake-inspect.mjs --simulate-lock --amount=500000 --blocks=1440
//   node scripts/stake-inspect.mjs --simulate-unlock --lock-commitment=<hex> --amount=<sats> --badger=<amount>
//   node scripts/stake-inspect.mjs --quiet --inspect-master
//   node scripts/stake-inspect.mjs --help
//
// Exit codes (chosen so cron / systemd can route on them):
//   0 — operation succeeded (master found / decode ok / simulation valid).
//   1 — invalid CLI args (unknown flag, missing required knob, bad shape).
//   2 — read / config error (config missing, network error, watchtower unreachable).
//   3 — simulation invalid (violations found).

import process from 'node:process';

import {
  DEFAULT_STAKING_CONFIG,
  MASTER_CAT,
  MAX_STAKE_BLOCKS,
  COMMITMENT_LEN_HEX,
  CONTRACT_ADDRESS,
  WATCHTOWER_BASE,
  validateLockParams,
  resolveStakingConfig,
  decodeCommitmentAuto,
  buildLockNftCommitment,
  simulateLock,
  simulateUnlock,
  fetchMasterState,
  bigOrZero,
  computeStakeAllocation,
} from '../src/staking/badger-stake.mjs';

// ─────────────────────────────────────────────────────────────────────
// Arg parsing
// ─────────────────────────────────────────────────────────────────────

const KNOWN_FLAGS = new Set([
  'inspect-master',
  'decode-commitment',
  'simulate-lock',
  'simulate-unlock',
  'simulate-allocate',
  'amount',
  'blocks',
  'badger',
  'lock-commitment',
  'user-pkh',
  'inactive-balance',
  'open-exposure',
  'min-reserve',
  'chipnet',
  'json',
  'quiet',
  'help',
]);

/**
 * Parse argv into a flat `flags` map + `positional` array. Mirrors
 * the parser pattern used by every other TradeBot CLI. Exported so
 * `tests/scripts.test.mjs` can drive it without spawning a child.
 *
 * @param {string[]} argv
 * @returns {{ flags: Record<string, string|boolean>, positional: string[] }}
 */
export function parseStakeInspectArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (typeof a !== 'string') continue;
    if (a === '--') continue;
    if (a.startsWith('--')) {
      const body = a.slice(2);
      const eq = body.indexOf('=');
      let key, val;
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
 * flags + validates numeric ranges. Pure.
 *
 * @param {Record<string, string|boolean>} flags
 * @param {Object} [cfg] optional pre-loaded staking config (the `main()`
 *   function passes the resolved config; tests pass an explicit object).
 * @returns {{ ok: true, opts: Object } | { ok: false, error: string, field: string }}
 */
export function normalizeStakeInspectFlags(flags, cfg) {
  const cfgResolved = resolveStakingConfig(cfg || {});
  const out = {
    inspectMaster: false,
    decodeCommitment: null,
    simulateLock: false,
    simulateUnlock: false,
    simulateAllocate: false,
    amountSats: null,
    stakeBlocks: cfgResolved.stake_blocks,
    badgerCoinAmount: null,
    lockCommitment: null,
    userPkh: null,
    inactiveBalance: null,
    openExposure: null,
    minReserve: null,
    network: cfgResolved.network,
    contractAddress: cfgResolved.contract_address,
    watchtowerBase: cfgResolved.watchtower_base,
    requestTimeoutMs: cfgResolved.request_timeout_ms,
    json: false,
    quiet: false,
    help: false,
  };

  const requireNumber = (k, raw) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      return { ok: false, error: `flag --${k} requires a non-negative number (got "${raw}")`, field: k };
    }
    return { ok: true, value: n };
  };

  for (const k of Object.keys(flags)) {
    if (!KNOWN_FLAGS.has(k)) {
      return { ok: false, error: `unknown flag --${k}`, field: k };
    }
    const v = flags[k];
    if (k === 'inspect-master') out.inspectMaster = (v === true || v === 'true');
    else if (k === 'simulate-lock') out.simulateLock = (v === true || v === 'true');
    else if (k === 'simulate-unlock') out.simulateUnlock = (v === true || v === 'true');
    else if (k === 'simulate-allocate') out.simulateAllocate = (v === true || v === 'true');
    else if (k === 'chipnet') {
      if (v === true || v === 'true') {
        out.network = 'chipnet';
        out.contractAddress = CONTRACT_ADDRESS.chipnet;
      }
    } else if (k === 'json') out.json = (v === true || v === 'true');
    else if (k === 'quiet') out.quiet = (v === true || v === 'true');
    else if (k === 'help') out.help = (v === true || v === 'true');
    else if (k === 'decode-commitment') {
      if (typeof v !== 'string') return { ok: false, error: `--decode-commitment requires a hex value`, field: k };
      out.decodeCommitment = v;
    } else if (k === 'amount') {
      const r = requireNumber(k, v);
      if (!r.ok) return r;
      out.amountSats = r.value;
    } else if (k === 'blocks') {
      const r = requireNumber(k, v);
      if (!r.ok) return r;
      if (!Number.isInteger(r.value) || r.value < 0 || r.value > MAX_STAKE_BLOCKS) {
        return { ok: false, error: `--blocks must be an integer 0..${MAX_STAKE_BLOCKS} (got "${v}")`, field: k };
      }
      out.stakeBlocks = r.value;
    } else if (k === 'badger') {
      const r = requireNumber(k, v);
      if (!r.ok) return r;
      out.badgerCoinAmount = r.value;
    } else if (k === 'lock-commitment') {
      if (typeof v !== 'string') return { ok: false, error: `--lock-commitment requires a hex value`, field: k };
      out.lockCommitment = v;
    } else if (k === 'user-pkh') {
      if (typeof v !== 'string') return { ok: false, error: `--user-pkh requires a hex value`, field: k };
      out.userPkh = v;
    } else if (k === 'inactive-balance') {
      const r = requireNumber(k, v);
      if (!r.ok) return r;
      out.inactiveBalance = r.value;
    } else if (k === 'open-exposure') {
      const r = requireNumber(k, v);
      if (!r.ok) return r;
      out.openExposure = r.value;
    } else if (k === 'min-reserve') {
      const r = requireNumber(k, v);
      if (!r.ok) return r;
      out.minReserve = r.value;
    }
  }

  // Sanity cross-checks.
  if (out.simulateLock && (out.amountSats === null || out.stakeBlocks === null)) {
    return {
      ok: false,
      error: '--simulate-lock requires --amount=<sats> --blocks=<blocks>',
      field: 'simulate-lock',
    };
  }
  if (out.simulateUnlock && !out.lockCommitment) {
    return {
      ok: false,
      error: '--simulate-unlock requires --lock-commitment=<hex>',
      field: 'simulate-unlock',
    };
  }
  if (out.simulateAllocate && (
    out.inactiveBalance === null || out.openExposure === null || out.minReserve === null
  )) {
    return {
      ok: false,
      error: '--simulate-allocate requires --inactive-balance=<sats> --open-exposure=<sats> --min-reserve=<sats>',
      field: 'simulate-allocate',
    };
  }

  return { ok: true, opts: out };
}

/** Pure: render the canonical help text. */
export function formatStakeInspectHelp() {
  return [
    'Usage: node scripts/stake-inspect.mjs [options]',
    '',
    'Inspection:',
    '  --inspect-master                  Fetch + decode the masterBadger UTXO at the contract address.',
    '  --decode-commitment=<hex>         Decode a 40-byte commitment as master OR lock (auto-detect).',
    '',
    'Simulation (no signing):',
    '  --simulate-lock                   Simulate a lock(amount, stakeBlocks, pubkeyhash) call.',
    '    --amount=<sats>                   Amount to lock in sats (must be >= 5000).',
    '    --blocks=<blocks>                 Stake length in blocks (0..65536).',
    '    --user-pkh=<hex>                  (optional) 20-byte P2PKH pubkeyhash; defaults to a placeholder.',
    '  --simulate-unlock                 Simulate an unlock() call given a lockNFT commitment.',
    '    --lock-commitment=<hex>           40-byte lockNFT commitment to validate.',
    '    --amount=<sats>                   (optional) BCH value of the lockUTXO (defaults to 1000).',
    '    --badger=<amount>                 (optional) BadgerCoin FT amount on the lockUTXO (defaults to 0).',
    '    --user-pkh=<hex>                  (optional) 20-byte P2PKH pubkeyhash for the unlock outputs.',
    '  --simulate-allocate               Compute the stake size for the given wallet state.',
    '    --inactive-balance=<sats>         Total wallet BCH balance.',
    '    --open-exposure=<sats>            Sum of open-position BCH exposure.',
    '    --min-reserve=<sats>              From risk.min_wallet_balance_bch.',
    '',
    'Network:',
    '  --chipnet                         Use the chipnet (BCH testnet) contract + watchtower.',
    '  --json                            Emit machine-readable JSON instead of a human-friendly table.',
    '  --quiet                           Minimal output (just the headline number).',
    '  --help                            Print this help text and exit 0.',
    '',
    'Exit codes: 0=ok, 1=bad args, 2=read/config error, 3=simulation invalid.',
    '',
    'See src/staking/badger-stake.mjs for the engine contract.',
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────
// Operation handlers (pure or near-pure; one per subcommand)
// ─────────────────────────────────────────────────────────────────────

/**
 * Run --decode-commitment. Pure.
 *
 * @param {string} commitmentHex
 * @param {boolean} asJson
 * @returns {{ ok: true, text: string, exitCode: 0 }}
 */
export function runDecodeCommitment(commitmentHex, asJson) {
  const hex = commitmentHex.startsWith('0x') || commitmentHex.startsWith('\\x')
    ? commitmentHex.slice(2)
    : commitmentHex;
  if (hex.length !== COMMITMENT_LEN_HEX) {
    const err = `commitment must be ${COMMITMENT_LEN_HEX} hex chars (${COMMITMENT_LEN_HEX / 2} bytes); got ${hex.length}`;
    return { ok: false, text: JSON.stringify({ ok: false, error: err, code: 'BAD_LENGTH' }), exitCode: 1 };
  }
  let detected;
  try {
    detected = decodeCommitmentAuto(hex);
  } catch (e) {
    return { ok: false, text: JSON.stringify({ ok: false, error: e.message, code: 'DECODE_ERROR' }), exitCode: 1 };
  }
  if (asJson) {
    return { ok: true, text: JSON.stringify({ ok: true, ...detected }, null, 2), exitCode: 0 };
  }
  const d = detected.decoded;
  const lines = [`kind: ${detected.kind}`];
  if (detected.kind === 'master') {
    lines.push(`stakeFee: ${d.stakeFee} sats`);
    lines.push(`reserved: ${d.reserved}`);
    lines.push(`adminAddressHex: ${d.adminAddressHex}`);
  } else {
    lines.push(`userPkhHex: ${d.userPkhHex}`);
    lines.push(`reservedIsZero: ${d.reservedIsZero}`);
    lines.push(`reserved: ${d.reserved}`);
    lines.push(`stakeBlocks: ${d.stakeBlocks} (~${(d.stakeBlocks / 144).toFixed(2)} days)`);
  }
  lines.push(`commitmentHex: ${d.commitmentHex}`);
  return { ok: true, text: lines.join('\n'), exitCode: 0 };
}

/**
 * Run --simulate-lock. Pure: builds the layout from the supplied
 * args, never touches the network.
 *
 * @param {Object} opts          normalized options
 * @param {Object} masterUtxo    (optional) a known masterBadger UTXO to validate against
 * @param {Object[]} userUtxos   (optional) the user's BCH UTXOs
 * @returns {{ ok: boolean, text: string, exitCode: 0|1|3 }}
 */
export function runSimulateLock(opts, masterUtxo, userUtxos) {
  const userPkh = opts.userPkh
    ? opts.userPkh.startsWith('0x') ? opts.userPkh.slice(2) : opts.userPkh
    : '00'.repeat(20);
  const v = validateLockParams({ amountSats: opts.amountSats, stakeBlocks: opts.stakeBlocks });
  if (!v.ok) {
    return {
      ok: false,
      text: JSON.stringify({ ok: false, error: v.error, code: v.code }),
      exitCode: 1,
    };
  }
  // If the caller supplied a master + user UTXOs, run the full layout builder.
  let layout = null;
  if (masterUtxo && Array.isArray(userUtxos) && userUtxos.length > 0) {
    layout = simulateLock({
      amountSats: v.amountSats,
      stakeBlocks: v.stakeBlocks,
      userPkh,
      masterUtxo,
      userUtxos,
    });
    if (!layout.ok) {
      return {
        ok: false,
        text: JSON.stringify({
          ok: false,
          error: layout.error,
          code: layout.code,
          violations: layout.violations,
          params: { amountSats: v.amountSats.toString(), stakeBlocks: v.stakeBlocks, userPkh },
        }, null, 2),
        exitCode: 3,
      };
    }
  }
  const result = {
    ok: true,
    params: {
      amountSats: v.amountSats.toString(),
      amountBch: v.amountBch,
      stakeBlocks: v.stakeBlocks,
      stakeDays: Math.round(v.stakeDays * 100) / 100,
    },
    reward: {
      badgerCoin: v.reward.toString(),
      formula: `${v.amountSats.toString()} sats * ${v.stakeBlocks} blocks / 1e8 = ${v.reward.toString()} BadgerCoin`,
    },
    lockNftCommitment: buildLockNftCommitment(userPkh, v.stakeBlocks).reduce(
      (acc, b) => acc + b.toString(16).padStart(2, '0'),
      '',
    ),
    layout: layout && layout.ok ? {
      outputs: layout.outputs.map((o) => ({
        valueSats: o.value?.toString?.() ?? String(o.value),
        tokenAmount: o.tokenAmount?.toString?.() ?? String(o.tokenAmount ?? 0),
        tokenCategory: o.tokenCategory,
        nftCommitment: o.nftCommitment,
      })),
      spentSats: layout.spentSats.toString(),
      changeSats: layout.changeSats.toString(),
      estimatedFeeSats: layout.estimatedFeeSats.toString(),
    } : null,
  };
  return { ok: true, text: JSON.stringify(result, null, 2), exitCode: 0 };
}

/**
 * Run --simulate-unlock. Pure.
 */
export function runSimulateUnlock(opts) {
  const userPkh = opts.userPkh
    ? opts.userPkh.startsWith('0x') ? opts.userPkh.slice(2) : opts.userPkh
    : '00'.repeat(20);
  const lockCommitment = opts.lockCommitment.startsWith('0x') || opts.lockCommitment.startsWith('\\x')
    ? opts.lockCommitment.slice(2)
    : opts.lockCommitment;
  const lockUtxo = {
    token: {
      tokenId: MASTER_CAT + '01', // mutable + 0x01
      capability: '0x01',
      commitment: lockCommitment,
      amount: opts.badgerCoinAmount ?? 0,
    },
    value: opts.amountSats ?? 1000,
  };
  const r = simulateUnlock({ lockUtxo, userPkh });
  if (!r.ok) {
    return {
      ok: false,
      text: JSON.stringify({
        ok: false,
        error: r.error,
        code: r.code,
        violations: r.violations,
      }, null, 2),
      exitCode: 3,
    };
  }
  const result = {
    ok: true,
    outputs: r.outputs.map((o) => ({
      valueSats: o.value?.toString?.() ?? String(o.value),
      tokenAmount: o.tokenAmount?.toString?.() ?? String(o.tokenAmount ?? 0),
      tokenCategory: o.tokenCategory,
    })),
    unlockedBchSats: r.unlockedBchSats.toString(),
    badgerCoinAmount: r.badgerCoinAmount.toString(),
    spentSats: r.spentSats.toString(),
    estimatedFeeSats: r.estimatedFeeSats.toString(),
    stakeBlocks: r.stakeBlocks,
  };
  return { ok: true, text: JSON.stringify(result, null, 2), exitCode: 0 };
}

/**
 * Compute the stake allocation from a synthetic wallet state.
 * Pure: no network.
 */
export function runSimulateAllocate(opts, cfg) {
  const cfgResolved = resolveStakingConfig(cfg || {});
  // The operator passes the TOTAL wallet balance via --inactive-balance
  // (semantically: "what does my wallet look like, in BCH sats, ignoring
  // active positions / reserve"). computeStakeAllocation() then derives
  // the truly-inactive amount internally as `wallet - exposure - reserve`.
  const walletBalanceSats = bigOrZero(opts.inactiveBalance ?? 0);
  const r = computeStakeAllocation({
    walletBalanceSats,
    openExposureSats: opts.openExposure ?? 0,
    minReserveSats: opts.minReserve ?? 0,
    cfg: cfgResolved,
  });
  const result = {
    ok: r.ok,
    stakeableSats: (r.stakeableSats ?? 0n).toString(),
    stakeAmountSats: r.ok ? r.stakeAmountSats.toString() : '0',
    stakeAmountBch: r.ok ? r.stakeAmountBch : 0,
    inactiveBalanceSats: (r.inactiveBalanceSats ?? 0n).toString(),
    skipReason: r.ok ? undefined : r.skipReason,
    inputs: {
      walletBalanceSats: walletBalanceSats.toString(),
      openExposureSats: (opts.openExposure ?? 0).toString(),
      minReserveSats: (opts.minReserve ?? 0).toString(),
      inactiveFractionToStake: cfgResolved.inactive_fraction_to_stake,
    },
  };
  return { ok: r.ok, text: JSON.stringify(result, null, 2), exitCode: 0 };
}

/**
 * Fetch the master state from the contract address via Electrum + summarize.
 * Async. T70-2: electrum-only path (the watchtower.cash dependency has
 * been removed from the BadgerCoin staking process per operator spec).
 *
 * @param {Object} opts
 * @param {Object} [deps]
 * @param {{getUtxos: Function}} [deps.provider]  cashscript ElectrumNetworkProvider
 * @returns {Promise<{ ok: boolean, text: string, exitCode: 0|2 }>}
 */
export async function runInspectMaster(opts, { provider } = {}) {
  const cfg = {
    network: opts.network,
    contract_address: opts.contractAddress,
    request_timeout_ms: opts.requestTimeoutMs,
  };
  const r = await fetchMasterState({ cfg, provider });
  if (!r.ok) {
    return { ok: false, text: JSON.stringify({ ok: false, error: r.error, code: r.code }), exitCode: 2 };
  }
  const result = {
    ok: true,
    network: opts.network,
    contractAddress: opts.contractAddress,
    master: r.master.found ? {
      found: true,
      txid: r.master.txid,
      vout: r.master.vout,
      valueSats: (r.master.value ?? 0n).toString(),
      tokenAmount: (r.master.tokenAmount ?? 0n).toString(),
      stakeFee: r.master.stakeFee,
      adminPkhHex: r.master.adminPkhHex,
      commitment: r.master.commitment,
    } : { found: false, reason: r.master.reason },
    lockNftCount: r.lockNftCount,
    lockNftBchTotalSats: r.lockNftBchTotal.toString(),
    rawUtxoCount: r.rawUtxoCount,
  };
  return { ok: true, text: JSON.stringify(result, null, 2), exitCode: 0 };
}

// ─────────────────────────────────────────────────────────────────────
// Pure main() — entry point for both CLI + tests
// ─────────────────────────────────────────────────────────────────────

/**
 * Pure main. Loads + normalizes args, dispatches to the right
 * handler, returns a typed exit envelope.
 *
 * @param {Object} args
 * @param {string[]} args.argv
 * @param {Object}   [args.cfg]               staking config (defaults to DEFAULT_STAKING_CONFIG)
 * @param {Object}   [args.deps]              { fetchImpl, masterUtxo, userUtxos }
 * @returns {Promise<{ ok: boolean, text: string, exitCode: 0|1|2|3 }>}
 */
export async function main({ argv, cfg, deps } = {}) {
  const args = Array.isArray(argv) ? argv : ['node', 'stake-inspect.mjs'];
  const cfgResolved = resolveStakingConfig(cfg || {});
  const d = deps || {};
  const parsed = parseStakeInspectArgs(args);
  const norm = normalizeStakeInspectFlags(parsed.flags, cfgResolved);
  if (!norm.ok) {
    return { ok: false, text: JSON.stringify({ ok: false, error: norm.error, field: norm.field }), exitCode: 1 };
  }
  const opts = norm.opts;
  if (opts.help) {
    return { ok: true, text: formatStakeInspectHelp(), exitCode: 0 };
  }
  if (opts.decodeCommitment) {
    return runDecodeCommitment(opts.decodeCommitment, opts.json);
  }
  if (opts.simulateLock) {
    return runSimulateLock(opts, d.masterUtxo, d.userUtxos);
  }
  if (opts.simulateUnlock) {
    return runSimulateUnlock(opts);
  }
  if (opts.simulateAllocate) {
    return runSimulateAllocate(opts, cfgResolved);
  }
  if (opts.inspectMaster) {
    return runInspectMaster(opts, { provider: d.provider });
  }
  return { ok: false, text: JSON.stringify({ ok: false, error: 'no operation specified (try --inspect-master, --decode-commitment, --simulate-lock, --simulate-unlock, --simulate-allocate, or --help)' }), exitCode: 1 };
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
  // Lazy-load the config so the import graph stays clean for tests.
  let cfg;
  try {
    const { loadConfig } = await import('../src/util/config-loader.mjs');
    cfg = (await loadConfig()).staking ?? {};
  } catch (e) {
    // No config / parse error → fall back to defaults so the help path
    // keeps working. Defer fatal config errors to the operation that needs them.
    cfg = {};
  }
  const { ok, text, exitCode } = await main({ argv: process.argv, cfg });
  // Print to stdout/stderr for human consumption.
  if (exitCode === 0) {
    process.stdout.write(text + '\n');
  } else {
    process.stderr.write(text + '\n');
  }
  process.exit(exitCode);
}
