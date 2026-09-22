#!/usr/bin/env node
// scripts/reconcile-stuck-position.mjs
//
// B05: Operator tool to reconcile a position that the bot has wedged
// into `data/positions.json` but whose on-chain reality doesn't match
// the local record. Specifically: positions whose entry was recorded
// by the bot BUT whose swap was never broadcast (a pre-flight slippage
// refusal — see B04) — the bot now retries every tick against a
// position the wallet never actually holds.
//
// The fix has 3 shapes depending on what the wallet's UTXO set looks
// like for the position's token category:
//
//   1. **on_disk_only** (the entry never landed): delete the position
//      record entirely. There's no exit to fabricate, no on-chain
//      receipt to chase — just a phantom record the bot keeps
//      retrying. `Positions.delete()` removes it from `open[]`
//      WITHOUT moving it to `closed[]` (so P&L isn't inflated by a
//      fake "completed" trade) and bumps `meta.total_deleted`.
//
//   2. **on_chain_only** (the entry landed but the record was lost —
//      recovery scenario): recreate the position record from the
//      on-chain NFT receipt, then close it normally with a real
//      exit. Mirror of T28 orphan path.
//
//   3. **consensus** (on_disk + on_chain agree): the entry actually
//      landed, the B04 fix now lets pre-flight pass, the next tick
//      will exit the position normally — operator can also force
//      the close here via `--action close_only` if they want it
//      done immediately rather than waiting for the next tick.
//
// The CLI takes a `--position-id` (required) and prints the 3-way
// diff in dry-run mode so the operator can see what the wallet says
// before committing. The actual action runs with `--action <mode>`
// (close_only | delete_only | recreate) and no `--dry-run`.
//
// SAFETY:
//   - Read-only against the chain. The script NEVER broadcasts.
//   - Idempotent for the read-only path: re-running with
//     `--dry-run` produces the same diff.
//   - `close_only` and `delete_only` are idempotent at the
//     positions-store level: `Positions.close()` of an already-
//     closed position throws `PositionsNotFoundError`; `Positions.
//     delete()` of an already-deleted position throws the same.
//   - `--dry-run` prints the planned action without touching disk.
//   - The script writes `data/positions.json` atomically (the
//     `Positions` class uses `atomicWriteJson` for every mutation).
//
// Usage:
//   node scripts/reconcile-stuck-position.mjs --help
//   node scripts/reconcile-stuck-position.mjs --position-id pos_xxx --dry-run
//   node scripts/reconcile-stuck-position.mjs --position-id pos_xxx --action close_only --exit-txid <hex> --bch-received-sats <n>
//   node scripts/reconcile-stuck-position.mjs --position-id pos_xxx --action delete_only --reason 'B05 OLA never landed'
//   node scripts/reconcile-stuck-position.mjs --position-id pos_xxx --action recreate

import process from 'node:process';

import { ElectrumNetworkProvider } from 'cashscript';

import { loadConfig } from '../src/util/config-loader.mjs';
import { createLogger } from '../src/util/logger.mjs';
import { Positions } from '../src/portfolio/positions.mjs';
import { LibAuthBchWallet, walletConfigFrom } from '../src/wallet/libauth.mjs';
import { atomicAppendNdjson } from '../src/util/atomic-write.mjs';

// ── arg parsing ──────────────────────────────────────────────────────────

// B05: exported so tests/scripts.test.mjs can cover the parser in isolation
// (no UTXO traversal, no WIF exposure). Mirrors the parseReconcilePositionArgs
// / parseSyncWalletHoldingsArgs shape so the test patterns line up.
export function parseReconcileStuckArgs(argv) {
  const flags = {};
  const positional = [];
  // argv.slice(2): skip the implicit `node` + script-path entries so callers
  // can pass either a full `process.argv` (script body) or a synthetic
  // argv like `['node', 'reconcile-stuck-position.mjs', '--position-id',
  // 'pos_xxx']` (tests).
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue;
    if (typeof a !== 'string') continue;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      // Space-separated value: consume the next argv if it doesn't
      // look like another flag.
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

const VALID_ACTIONS = new Set(['close_only', 'delete_only', 'recreate']);

/**
 * Resolve + validate the parsed flags into a typed `ReconcileStuckArgs`
 * object. Pure — no I/O. Throws on missing/invalid inputs so the
 * script body can short-circuit cleanly.
 *
 * @param {Record<string, unknown>} flags
 * @returns {{
 *   positionId: string,
 *   action: 'close_only'|'delete_only'|'recreate'|null,
 *   exitTxid: string|null,
 *   bchReceivedSats: bigint,
 *   feeSats: bigint,
 *   reason: string,
 *   positionsFile: string,
 *   dryRun: boolean,
 * }}
 */
export function resolveReconcileStuckArgs(flags, opts = {}) {
  // --positions-file: optional override, falls back to opts-passed
  // value (script body fills from cfg.paths.positions_file), then
  // to the hard-coded default.
  const flagPositionsFile = (typeof flags['positions-file'] === 'string')
    ? flags['positions-file'].trim()
    : '';
  const positionsFile = flagPositionsFile.length > 0
    ? flagPositionsFile
    : (typeof opts.positionsFile === 'string' && opts.positionsFile.length > 0)
      ? opts.positionsFile
      : 'data/positions.json';

  const positionId = (typeof flags['position-id'] === 'string') ? flags['position-id'].trim() : '';
  if (positionId.length === 0) {
    throw new Error('--position-id is required (e.g. --position-id pos_xxxxxxxx_0004)');
  }

  // --action: optional in dry-run mode (we just print the diff),
  // required for any live mutation. Default null = dry-run-only.
  let action = null;
  if (typeof flags.action === 'string') {
    const trimmed = flags.action.trim();
    if (trimmed.length > 0) {
      if (!VALID_ACTIONS.has(trimmed)) {
        throw new Error(`--action must be one of ${[...VALID_ACTIONS].join(' | ')}; got "${trimmed}"`);
      }
      action = trimmed;
    }
  }

  // --exit-txid: optional, only meaningful for close_only. Same 64-hex
  // shape as the T29 reconcile-position tool.
  const rawExitTxid = (typeof flags['exit-txid'] === 'string') ? flags['exit-txid'].trim() : '';
  if (rawExitTxid.length > 0 && !/^[0-9a-fA-F]{64}$/.test(rawExitTxid)) {
    throw new Error(`--exit-txid must be a 64-char hex string; got "${rawExitTxid}"`);
  }

  // --bch-received-sats: optional, default 0. Signed sat delta
  // (can be negative on a slippage-loss close).
  let bchReceivedSats = 0n;
  if (typeof flags['bch-received-sats'] === 'string' && flags['bch-received-sats'].length > 0) {
    try {
      bchReceivedSats = BigInt(flags['bch-received-sats']);
    } catch {
      throw new Error(`--bch-received-sats must be a bigint-coercible string; got "${flags['bch-received-sats']}"`);
    }
    if (bchReceivedSats < -1_000_000_000_000n) {
      // Same sanity guard as T29: refuse -10M BCH or worse.
      throw new Error(`--bch-received-sats=${bchReceivedSats} is implausibly negative — refusing to commit`);
    }
  }

  // --fee-sats: optional, default 0. Must be non-negative.
  let feeSats = 0n;
  if (typeof flags['fee-sats'] === 'string' && flags['fee-sats'].length > 0) {
    try {
      feeSats = BigInt(flags['fee-sats']);
    } catch {
      throw new Error(`--fee-sats must be a bigint-coercible string; got "${flags['fee-sats']}"`);
    }
    if (feeSats < 0n) {
      throw new Error(`--fee-sats must be >= 0; got ${feeSats}`);
    }
  }

  const reason = (typeof flags.reason === 'string' && flags.reason.trim().length > 0)
    ? flags.reason.trim()
    : 'B05 stuck-position reconciliation';

  const dryRun = flags['dry-run'] === true;

  return {
    positionId,
    action,
    exitTxid: rawExitTxid.length > 0 ? rawExitTxid : null,
    bchReceivedSats,
    feeSats,
    reason,
    positionsFile,
    dryRun,
  };
}

// ── pure diff helper ─────────────────────────────────────────────────────

/**
 * Pure helper: compute the 3-way diff between the on-disk position
 * and the wallet's UTXO set for the same token category.
 *
 * Exported so tests can pin the diff logic independently of the
 * script body (no I/O, no Electrum).
 *
 * The wallet's `Utxo[]` shape (per cashscript) is
 * `{ txid, vout, satoshis: bigint, token?: { category, amount, nft? } }`.
 * We match on `token.category` (lowercased 64-hex) — same matcher
 * `scripts/sync-wallet-holdings.mjs` uses.
 *
 * @param {Object|null} position         the row from `data/positions.json`
 * @param {Array<{txid: string, vout: number, satoshis: bigint, token?: Object}>} walletUtxos
 * @returns {{
 *   status: 'on_disk_only' | 'on_chain_only' | 'consensus' | 'no_position' | 'malformed_position',
 *   on_disk: boolean,
 *   on_chain: boolean,
 *   on_chain_token_amount_base: bigint,
 *   on_chain_nft_count: number,
 *   on_chain_ft_utxo_count: number,
 *   token_id: string|null,
 *   wallet_address: string|null,
 *   reason: string,
 * }}
 */
export function buildStuckDiff(position, walletUtxos, opts = {}) {
  const walletAddress = (typeof opts.walletAddress === 'string') ? opts.walletAddress : null;
  const walletErr = opts.walletErr ?? null;

  // Even when the position is missing, we still scan the wallet so
  // the operator can see if the on-chain tokens are real — that's
  // the whole point of the recovery scenario (`on_chain_only`).
  // The scan is also cheap (just a category filter over UTXOs
  // already loaded into memory).
  const filteredUtxos = Array.isArray(walletUtxos) ? walletUtxos : [];
  const targetCategoryFromPosition = (position && typeof position.token_id === 'string' && position.token_id.length > 0)
    ? position.token_id.toLowerCase()
    : null;

  if (!position || typeof position !== 'object') {
    // No on-disk record. Aggregate ALL FT UTXOs at the wallet
    // (we don't know the target category yet) so the operator can
    // see if there's a likely-recovery candidate.
    let totalAmount = 0n;
    let ftCount = 0;
    let nftCount = 0;
    const sampleCats = new Set();
    for (const u of filteredUtxos) {
      if (!u || typeof u !== 'object') continue;
      const t = u.token;
      if (!t || typeof t !== 'object') continue;
      ftCount += 1;
      const cat = (typeof t.category === 'string') ? t.category.toLowerCase() : '';
      if (cat.length > 0) sampleCats.add(cat);
      const amt = (typeof t.amount === 'bigint') ? t.amount : BigInt(t.amount ?? 0);
      totalAmount += amt;
      if (t.nft !== undefined && t.nft !== null) nftCount += 1;
    }
    const onChain = ftCount > 0;
    return {
      status: onChain ? 'on_chain_only' : 'no_position',
      on_disk: false,
      on_chain: onChain,
      on_chain_token_amount_base: totalAmount,
      on_chain_nft_count: nftCount,
      on_chain_ft_utxo_count: ftCount,
      token_id: targetCategoryFromPosition,
      wallet_address: walletAddress,
      reason: walletErr
        ? `no on-disk position + wallet query failed: ${String(walletErr)}`
        : (onChain
          ? `wallet holds ${ftCount} FT UTXO(s) but no on-disk position — record lost (recovery scenario)`
          : 'no on-disk position AND wallet has no FT UTXOs'),
    };
  }
  if (typeof position.token_id !== 'string' || position.token_id.length === 0) {
    return {
      status: 'malformed_position',
      on_disk: true,
      on_chain: false,
      on_chain_token_amount_base: 0n,
      on_chain_nft_count: 0,
      on_chain_ft_utxo_count: 0,
      token_id: null,
      wallet_address: walletAddress,
      reason: 'position missing token_id — cannot match against wallet UTXOs',
    };
  }

  const targetCategory = position.token_id.toLowerCase();
  let tokenAmountBase = 0n;
  let nftCount = 0;
  let ftUtxoCount = 0;
  for (const u of filteredUtxos) {
    if (!u || typeof u !== 'object') continue;
    const t = u.token;
    if (!t || typeof t !== 'object') continue;
    const cat = (typeof t.category === 'string') ? t.category.toLowerCase() : '';
    if (cat !== targetCategory) continue;
    ftUtxoCount += 1;
    const amt = (typeof t.amount === 'bigint') ? t.amount : BigInt(t.amount ?? 0);
    tokenAmountBase += amt;
    if (t.nft !== undefined && t.nft !== null) nftCount += 1;
  }

  const onDisk = position.status !== 'closed';
  const onChain = tokenAmountBase > 0n;

  let status;
  let reason;
  if (onDisk && onChain) {
    status = 'consensus';
    reason = 'position exists on disk AND wallet holds the token — entry actually landed';
  } else if (onDisk && !onChain) {
    status = 'on_disk_only';
    reason = 'position exists on disk but wallet has NO matching UTXO — entry never landed';
  } else if (!onDisk && onChain) {
    status = 'on_chain_only';
    reason = 'wallet holds the token but NO on-disk position — record lost (recovery scenario)';
  } else {
    status = 'no_position';
    reason = 'no on-disk position AND no on-chain balance';
  }

  return {
    status,
    on_disk: onDisk,
    on_chain: onChain,
    on_chain_token_amount_base: tokenAmountBase,
    on_chain_nft_count: nftCount,
    on_chain_ft_utxo_count: ftUtxoCount,
    token_id: targetCategory,
    wallet_address: walletAddress,
    reason,
  };
}

/**
 * Pure helper: pick the recommended action for a given diff. The
 * operator can override via `--action`. Exported for test pinning.
 *
 * @param {{ status: string }} diff
 * @returns {'close_only' | 'delete_only' | 'recreate' | null}
 */
export function recommendStuckAction(diff) {
  if (!diff || typeof diff !== 'object') return null;
  switch (diff.status) {
    case 'consensus': return 'close_only';
    case 'on_disk_only': return 'delete_only';
    case 'on_chain_only': return 'recreate';
    default: return null;
  }
}

// ── script wiring ────────────────────────────────────────────────────────

// B05: only run when invoked directly — when imported by
// tests/scripts.test.mjs the body is skipped so the test suite
// can pull `parseReconcileStuckArgs` / `resolveReconcileStuckArgs`
// / `buildStuckDiff` / `recommendStuckAction` without the script
// trying to talk to Electrum / mutate positions.json.
const isDirect = import.meta.url === `file://${process.argv[1]}` ||
                 process.argv[1]?.endsWith('reconcile-stuck-position.mjs');

// Shape-parity `main` for tests; ESM requires `export` at top
// level, so we always declare it and the body short-circuits
// when the script is imported (not directly invoked).
async function reconcileStuckPositionMain() { return { ok: false, error: 'not_direct_invocation' }; }
export { reconcileStuckPositionMain as main };

const log = createLogger({ sink: process.stderr, component: 'reconcile-stuck' });
if (!isDirect) {
  log.info('reconcile-stuck.imported-skip', { reason: 'not_direct_invocation' });
}
if (isDirect) {

const { flags } = parseReconcileStuckArgs(process.argv);

if (flags.help === true || flags.h === true) {
  process.stderr.write(
    'Usage: node scripts/reconcile-stuck-position.mjs ' +
    '--position-id <id> [--action close_only|delete_only|recreate] ' +
    '[--exit-txid <hex>] [--bch-received-sats <n>] [--fee-sats <n>] ' +
    '[--reason <text>] [--positions-file <path>] [--dry-run]\n',
  );
  process.exit(0);
}

log.info('reconcile-stuck.boot', { flags });

let args;
try {
  args = resolveReconcileStuckArgs(flags);
} catch (e) {
  log.error('reconcile-stuck.bad-args', { error: e?.message ?? String(e) });
  process.stderr.write(`\n${e?.message ?? e}\n\nUsage: node scripts/reconcile-stuck-position.mjs --position-id <id> [--dry-run | --action close_only|delete_only|recreate]\n`);
  process.exit(2);
}
log.info('reconcile-stuck.args', {
  position_id: args.positionId,
  action: args.action,
  exit_txid: args.exitTxid,
  bch_received_sats: args.bchReceivedSats.toString(),
  fee_sats: args.feeSats.toString(),
  reason: args.reason,
  dry_run: args.dryRun,
});

// Load merged config (default + user). The script needs the WIF
// to talk to Electrum + derive the wallet address.
const cfg = await loadConfig();
if (typeof cfg.paths?.positions_file === 'string' && cfg.paths.positions_file.length > 0) {
  if (!(typeof flags['positions-file'] === 'string' && flags['positions-file'].length > 0)) {
    args.positionsFile = cfg.paths.positions_file;
  }
}
const userCfg = (cfg.user?.wallet && typeof cfg.user.wallet === 'object') ? cfg.user.wallet : {};
const wif = userCfg.wif ?? null;
if (!wif) {
  log.error('reconcile-stuck.no-wif');
  process.stderr.write(`\nNo WIF found in config/user.json — the script needs it to talk to Electrum.\n`);
  process.exit(2);
}

const walletCfg = walletConfigFrom(cfg);
const wallet = new LibAuthBchWallet({ cfg: walletCfg, wif, logger: log.child('wallet') });
await wallet.init();
const walletAddr = wallet.getAddress();
log.info('reconcile-stuck.wallet', { address: walletAddr });

// Read the position.
const positions = new Positions({ file: args.positionsFile, logger: log.child('positions') });
await positions.load();
const position = await positions.findById(args.positionId);
if (!position) {
  log.error('reconcile-stuck.position-not-found', { position_id: args.positionId, file: args.positionsFile });
  process.stderr.write(`\nPosition ${args.positionId} not found in ${args.positionsFile}.\n`);
  process.exit(3);
}
log.info('reconcile-stuck.position', {
  position_id: position.id,
  token_id: position.token_id,
  token_symbol: position.token_symbol ?? null,
  status: position.status,
  entry_txid: position.entry?.txid ?? null,
  entry_bch_spent_sats: position.entry?.bch_spent_sats ?? null,
  entry_ts: position.entry?.ts ?? null,
});

// Query the wallet's UTXO set filtered by token_category.
const ds = (cfg.data_sources ?? {});
const provider = new ElectrumNetworkProvider(walletCfg.network || 'mainnet', {
  hostname: ds.electrum_host ?? 'electrum.imaginary.cash',
  port: Number(ds.electrum_port) || 50004,
  protocol: 'tls',
});
const tokenCategory = (typeof position.token_id === 'string') ? position.token_id.toLowerCase() : '';
let walletUtxos = [];
let walletErr = null;
try {
  const allUtxos = await provider.getUtxos(walletAddr);
  if (!Array.isArray(allUtxos)) {
    throw new Error(`electrum returned non-array (${typeof allUtxos})`);
  }
  walletUtxos = allUtxos.filter((u) => {
    if (!u || typeof u !== 'object') return false;
    if (!u.token || typeof u.token !== 'object') return false;
    const cat = (typeof u.token.category === 'string') ? u.token.category.toLowerCase() : '';
    return cat === tokenCategory;
  });
  log.info('reconcile-stuck.wallet-scan', {
    total_utxos: allUtxos.length,
    matching_utxos: walletUtxos.length,
    token_category: tokenCategory,
  });
} catch (e) {
  walletErr = e?.message ?? String(e);
  log.error('reconcile-stuck.wallet-scan-failed', {
    err_name: e?.name ?? 'Error',
    err_message: walletErr,
    address: walletAddr,
  });
  process.stderr.write(`\nElectrum UTXO query failed: ${walletErr}\nRefusing to commit a blind action — re-run with a working Electrum host, or use --action delete_only if the entry never landed and you trust the on-disk record is bogus.\n`);
  process.exit(4);
}

// Compute the 3-way diff.
const diff = buildStuckDiff(position, walletUtxos, { walletAddress: walletAddr, walletErr });
const recommended = recommendStuckAction(diff);
log.info('reconcile-stuck.diff', {
  status: diff.status,
  on_disk: diff.on_disk,
  on_chain: diff.on_chain,
  on_chain_token_amount_base: diff.on_chain_token_amount_base.toString(),
  on_chain_nft_count: diff.on_chain_nft_count,
  on_chain_ft_utxo_count: diff.on_chain_ft_utxo_count,
  recommended_action: recommended,
  reason: diff.reason,
});

// ── dry-run path ─────────────────────────────────────────────────────────

if (args.dryRun) {
  log.info('reconcile-stuck.dry-run.complete', {
    position_id: args.positionId,
    diff,
    recommended_action: recommended,
    message: 'no disk writes (--dry-run); run with --action close_only|delete_only|recreate to commit',
  });
  const summary = {
    ok: true,
    dry_run: true,
    position_id: args.positionId,
    position_token_id: position.token_id ?? null,
    position_status: position.status,
    diff,
    recommended_action: recommended,
    positions_file: args.positionsFile,
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  process.exit(0);
}

// ── live path ────────────────────────────────────────────────────────────

// No --action given → just print the recommendation and exit. The
// operator can then re-run with --action close_only|delete_only|recreate
// to actually commit. This avoids the "script did something I didn't
// expect" failure mode for a destructive operation.
if (args.action === null) {
  log.info('reconcile-stuck.no-action', {
    position_id: args.positionId,
    diff_status: diff.status,
    recommended_action: recommended,
    message: 'no --action given — re-run with --action close_only|delete_only|recreate to commit',
  });
  process.stderr.write(
    `\nNo --action specified. Recommended action based on diff: ${recommended ?? '(none)'}\n` +
    `Re-run with: --action close_only | delete_only | recreate\n`,
  );
  process.exit(0);
}

let historyEvent = null;

if (args.action === 'close_only') {
  // Close the position with the operator's exit block (same shape
  // as `scripts/reconcile-position.mjs` — T29). Refuses if the
  // wallet says `on_disk_only` because the entry never landed,
  // there's no BCH to receive, and we don't want to fabricate a
  // exit block for a phantom entry.
  if (diff.status !== 'consensus') {
    log.error('reconcile-stuck.bad-action-for-diff', {
      requested_action: 'close_only',
      diff_status: diff.status,
      message: 'close_only requires diff.status === consensus — use delete_only for on_disk_only',
    });
    process.stderr.write(`\nCannot close_only: diff status is "${diff.status}", expected "consensus". Use --action delete_only for an entry that never landed.\n`);
    process.exit(5);
  }
  const exit = {
    txid: args.exitTxid ?? '',
    price_sats_per_token: 0,
    bch_received_sats: Number(args.bchReceivedSats < 0n ? 0n : args.bchReceivedSats),
    fee_sats: Number(args.feeSats),
    ts: new Date().toISOString(),
    reason: args.reason,
    source: 'manual-reconcile-stuck',
    slippage_bps: null,
  };
  // Pure P&L math (signed) — mirror of buildReconcileExit in T29.
  const entrySpent = BigInt(position.entry?.bch_spent_sats ?? 0);
  const entryFee = BigInt(position.entry?.fee_sats ?? 0);
  const exitFee = args.feeSats;
  const gross = args.bchReceivedSats - entrySpent;
  const net = gross - entryFee - exitFee;
  const realizedForStore = net < 0n ? 0 : Number(net);
  log.info('reconcile-stuck.close-plan', {
    position_id: position.id,
    token_id: position.token_id,
    exit_txid: exit.txid || null,
    exit_reason: exit.reason,
    exit_source: exit.source,
    bch_received_sats: exit.bch_received_sats,
    fee_sats: exit.fee_sats,
    realized_pnl_sats: realizedForStore,
  });
  const closed = await positions.close(args.positionId, exit, realizedForStore);
  log.info('reconcile-stuck.closed', {
    position_id: closed.id,
    token_id: closed.token_id,
    realized_pnl_sats: closed.exit?.realized_pnl_sats ?? null,
    closed_at: closed.closed_at,
  });
  historyEvent = {
    ts: closed.closed_at,
    kind: 'manual_exit_stuck',
    source: 'scripts/reconcile-stuck-position.mjs',
    dry_run: false,
    action: 'close_only',
    diff_status: diff.status,
    position_id: closed.id,
    token_id: closed.token_id,
    entry_txid: closed.entry?.txid ?? null,
    exit_txid: closed.exit?.txid ?? null,
    bch_received_sats: Number(args.bchReceivedSats),
    fee_sats: Number(args.feeSats),
    realized_pnl_sats: realizedForStore,
    reason: closed.exit?.reason ?? null,
    positions_file: args.positionsFile,
  };
} else if (args.action === 'delete_only') {
  // Refuses if the wallet says `on_chain_only` — the on-chain
  // tokens are real, deleting the record would orphan them.
  if (diff.status === 'on_chain_only') {
    log.error('reconcile-stuck.bad-action-for-diff', {
      requested_action: 'delete_only',
      diff_status: diff.status,
      message: 'delete_only requires diff.status !== on_chain_only — wallet holds real tokens',
    });
    process.stderr.write(`\nCannot delete_only: diff status is "on_chain_only" — the wallet holds the token. Use --action recreate to recover the position, or --action close_only if you have the exit txid.\n`);
    process.exit(5);
  }
  const { removed, file } = await positions.delete(args.positionId, args.reason);
  log.info('reconcile-stuck.deleted', {
    position_id: removed.id,
    token_id: removed.token_id,
    reason: args.reason,
    open_count_after: file.open.length,
    meta_total_deleted: file.meta?.total_deleted ?? null,
  });
  historyEvent = {
    ts: new Date().toISOString(),
    kind: 'manual_delete',
    source: 'scripts/reconcile-stuck-position.mjs',
    dry_run: false,
    action: 'delete_only',
    diff_status: diff.status,
    position_id: removed.id,
    token_id: removed.token_id,
    entry_txid: removed.entry?.txid ?? null,
    reason: args.reason,
    positions_file: args.positionsFile,
  };
} else if (args.action === 'recreate') {
  // Refuses if the wallet says `on_disk_only` — there's nothing
  // on-chain to recreate from.
  if (diff.status !== 'on_chain_only') {
    log.error('reconcile-stuck.bad-action-for-diff', {
      requested_action: 'recreate',
      diff_status: diff.status,
      message: 'recreate requires diff.status === on_chain_only — use delete_only for on_disk_only or close_only for consensus',
    });
    process.stderr.write(`\nCannot recreate: diff status is "${diff.status}", expected "on_chain_only". Use --action delete_only for on_disk_only, or --action close_only for consensus.\n`);
    process.exit(5);
  }
  // Reconstruct a minimal PositionEntry from the on-chain state.
  // We use the first FT UTXO as the entry txid + token_amount_base
  // (the dominant UTXO by amount); operator can override the entry
  // via --exit-txid / --bch-received-sats later if needed.
  let primary = walletUtxos[0];
  for (const u of walletUtxos) {
    const a = (typeof u.token?.amount === 'bigint') ? u.token.amount : BigInt(u.token?.amount ?? 0);
    const p = (typeof primary.token?.amount === 'bigint') ? primary.token.amount : BigInt(primary.token?.amount ?? 0);
    if (a > p) primary = u;
  }
  const entryTs = new Date().toISOString();
  const openArgs = {
    tokenId: position.token_id,
    tokenSymbol: position.token_symbol ?? null,
    tokenDecimals: position.token_decimals ?? null,
    entry: {
      txid: primary.txid,
      vout: primary.vout,
      price_sats_per_token: 0, // unknown — operator can re-derive from indexer
      bch_spent_sats: 0,       // unknown — recorded as 0 so P&L math doesn't fabricate a number
      token_amount_base: (typeof primary.token.amount === 'bigint') ? primary.token.amount.toString() : String(primary.token.amount ?? 0),
      fee_sats: 0,
      broadcast_ms: 0,
      ts: entryTs,
      slippage_bps: '0',
      source: 'reconcile-stuck-recreate',
    },
    reasoning: {
      ts: Date.now(),
      ts_iso: entryTs,
      token_id: position.token_id,
      decision: { kind: 'recover', source: 'manual-reconcile-stuck', reason: args.reason },
      notes: ['recreated via scripts/reconcile-stuck-position.mjs --action recreate'],
    },
    initialStatus: 'open',
  };
  const recreated = await positions.open(openArgs);
  log.info('reconcile-stuck.recreated', {
    new_position_id: recreated.id,
    token_id: recreated.token_id,
    entry_txid: recreated.entry?.txid ?? null,
    token_amount_base: recreated.entry?.token_amount_base ?? null,
  });
  // Then immediately close it with the operator's exit block.
  const closeExit = {
    txid: args.exitTxid ?? '',
    price_sats_per_token: 0,
    bch_received_sats: Number(args.bchReceivedSats < 0n ? 0n : args.bchReceivedSats),
    fee_sats: Number(args.feeSats),
    ts: new Date().toISOString(),
    reason: args.reason,
    source: 'manual-reconcile-stuck',
    slippage_bps: null,
  };
  const entrySpent2 = BigInt(recreated.entry?.bch_spent_sats ?? 0);
  const entryFee2 = BigInt(recreated.entry?.fee_sats ?? 0);
  const exitFee2 = args.feeSats;
  const gross2 = args.bchReceivedSats - entrySpent2;
  const net2 = gross2 - entryFee2 - exitFee2;
  const realizedForStore2 = net2 < 0n ? 0 : Number(net2);
  const closed = await positions.close(recreated.id, closeExit, realizedForStore2);
  log.info('reconcile-stuck.recreated-closed', {
    position_id: closed.id,
    token_id: closed.token_id,
    realized_pnl_sats: closed.exit?.realized_pnl_sats ?? null,
    closed_at: closed.closed_at,
  });
  historyEvent = {
    ts: closed.closed_at,
    kind: 'manual_recreate_stuck',
    source: 'scripts/reconcile-stuck-position.mjs',
    dry_run: false,
    action: 'recreate',
    diff_status: diff.status,
    position_id: closed.id,
    token_id: closed.token_id,
    entry_txid: closed.entry?.txid ?? null,
    exit_txid: closed.exit?.txid ?? null,
    bch_received_sats: Number(args.bchReceivedSats),
    fee_sats: Number(args.feeSats),
    realized_pnl_sats: realizedForStore2,
    reason: closed.exit?.reason ?? null,
    positions_file: args.positionsFile,
  };
}

// Append the history event. Same pattern as T29 — log loudly but
// don't unwind if it fails (the position mutation already happened
// via atomic write; the operator can append a manual line themselves).
const historyPath = (cfg.paths?.history_file && typeof cfg.paths.history_file === 'string')
  ? cfg.paths.history_file
  : 'data/history.ndjson';
if (historyEvent) {
  try {
    await atomicAppendNdjson(historyPath, JSON.stringify(historyEvent));
    log.info('reconcile-stuck.history-appended', { file: historyPath, position_id: historyEvent.position_id });
  } catch (e) {
    log.error('reconcile-stuck.history-append-failed', {
      file: historyPath,
      err_name: e?.name ?? 'Error',
      err_message: e?.message ?? String(e),
      position_id: historyEvent.position_id,
    });
  }
}

const summary = {
  ok: true,
  dry_run: false,
  position_id: args.positionId,
  action: args.action,
  diff_status: diff.status,
  positions_file: args.positionsFile,
  history_file: historyPath,
};
process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
process.exit(0);

} // end isDirect block