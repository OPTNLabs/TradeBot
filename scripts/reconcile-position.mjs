#!/usr/bin/env node
// scripts/reconcile-position.mjs
//
// T29: Operator tool to MANUALLY CLOSE a position in `data/positions.json`
// after an off-band exit (a swap that was broadcast by something other
// than the bot's normal trading loop). The bot's normal `Positions.close()`
// path is only reachable via `TradingLoop._evaluateExit()` → `swap.execute()`
// → `positions.close()`, and that pipeline refuses to commit a swap whose
// slippage exceeds `cfg.entry.slippage_tolerance_bps` / `cfg.risk.slippage_tolerance_bps`.
// If a position is so far underwater that the slippage blows past that
// tolerance — for example, an orphan position left over from a bot bug —
// the bot can't exit it through its own pipeline and gets stuck
// re-attempting every tick.
//
// This script breaks that loop. The operator:
//
//   1. Bails the position out via `scripts/manual-test-trade.mjs` or a
//      direct SDK call (the broadcast happens off-band; pre-flight is
//      bypassed because the operator accepted the slippage explicitly).
//   2. Reads the resulting txid + bch-received from the chain.
//   3. Runs this script:
//        node scripts/reconcile-position.mjs \
//             --position-id pos_xxxxxxxx_0002 \
//             --exit-txid  a0976a62035f2b1948ffb7add8a0158f5049d3b2c85a793987f68b0ac12ed784 \
//             --bch-received-sats 740091 \
//             --fee-sats 6600 \
//             --reason 'orphan recovery after T28 fix'
//
//      This calls the SAME `Positions.close()` API the bot's loop uses
//      (no special manual path), with the operator's exit block as the
//      audit-trail data. `data/positions.json` moves the position from
//      `open` → `closed` atomically; the next bot tick stops trying to
//      exit it. A `kind:'manual_exit'` history event is appended to
//      `data/history.ndjson` so the dashboard / P&L show the manual
//      close with the operator's reason in the audit trail.
//
// SAFETY:
//   - Idempotent: re-running on an already-closed position surfaces a
//     `PositionsNotFoundError` from the `Positions.close()` path
//     (because the position is no longer in the `open` bucket).
//   - Read-only against the chain. The script NEVER broadcasts —
//     pairing it with `manual-test-trade.mjs` / `sweep-funds.mjs` /
//     a manual SDK call is the operator's job.
//   - The script writes `data/positions.json` atomically (the
//     `Positions` class uses `atomicWriteJson` for every mutation).
//   - `--dry-run` prints the planned close without touching disk.
//
// Usage:
//   node scripts/reconcile-position.mjs --help
//   node scripts/reconcile-position.mjs --position-id pos_xxx --exit-txid <hex> --bch-received-sats <n> --dry-run
//   node scripts/reconcile-position.mjs --position-id pos_xxx --exit-txid <hex> --bch-received-sats <n>

import process from 'node:process';

import { loadConfig } from '../src/util/config-loader.mjs';
import { createLogger } from '../src/util/logger.mjs';
import { Positions } from '../src/portfolio/positions.mjs';
import { atomicAppendNdjson } from '../src/util/atomic-write.mjs';

// ── arg parsing ──────────────────────────────────────────────────────────

// T29: exported so tests/scripts.test.mjs can cover the parser in isolation
// (no `data/positions.json` writes, no on-chain queries). The script body
// uses the default `process.argv`; tests pass a synthetic argv in.
//
// Two flag forms supported:
//   --position-id=hex → flags['position-id'] = 'hex'
//   --position-id hex → flags['position-id'] = 'hex'  (space-separated value)
//   --dry-run         → flags['dry-run'] = true
export function parseReconcilePositionArgs(argv) {
  const flags = {};
  const positional = [];
  // `argv.slice(2)` matches parseRunBotArgs/parseInitArgs/parseSnapshotArgs/
  // parseSweepArgs/parseManualTestArgs/parseSyncWalletHoldingsArgs: skip the
  // implicit `node` + script-path entries so callers can pass either a full
  // `process.argv` (script body) or a synthetic argv like
  // `['node', 'reconcile-position.mjs', '--position-id', 'pos_xxx']` (tests).
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

/**
 * Resolve + validate the parsed flags into a typed `ReconcileArgs`
 * object. Pure — no I/O. Throws on missing/invalid inputs so the
 * script body can short-circuit cleanly.
 *
 * @param {Record<string, unknown>} flags
 * @returns {{
 *   positionId: string,
 *   exitTxid: string|null,
 *   bchReceivedSats: bigint,
 *   feeSats: bigint,
 *   reason: string,
 *   dryRun: boolean,
 *   positionsFile: string,
 * }}
 */
export function resolveReconcileArgs(flags, opts = {}) {
  // --positions-file is an optional CLI override; if absent, fall back
  // to the opts-passed value (which the script body fills from
  // cfg.paths.positions_file when no explicit override was given),
  // then to the hard-coded default.
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
    throw new Error('--position-id is required (e.g. --position-id pos_xxxxxxxx_0002)');
  }

  // --exit-txid is technically optional (operator can record a position
  // close that has no on-chain trace, e.g. a token burn or a manual
  // airdrop receipt). Default to empty string; Positions.close() accepts
  // an empty txid so long as the operator set the other fields.
  const rawExitTxid = (typeof flags['exit-txid'] === 'string') ? flags['exit-txid'].trim() : '';
  if (rawExitTxid.length > 0 && !/^[0-9a-fA-F]{64}$/.test(rawExitTxid)) {
    throw new Error(`--exit-txid must be a 64-char hex string; got "${rawExitTxid}"`);
  }

  // --bch-received-sats: signed sat delta. Required. Can be negative
  // (slippage loss on a bad manual exit) but must be finite.
  if (typeof flags['bch-received-sats'] !== 'string' || flags['bch-received-sats'].length === 0) {
    throw new Error('--bch-received-sats is required (the BCH the swap returned; can be negative for a slippage-loss exit)');
  }
  let bchReceivedSats;
  try {
    bchReceivedSats = BigInt(flags['bch-received-sats']);
  } catch {
    throw new Error(`--bch-received-sats must be a bigint-coercible string; got "${flags['bch-received-sats']}"`);
  }
  if (bchReceivedSats < -1_000_000_000_000n) {
    // Sanity guard: a single exit shouldn't lose more than 10M BCH. The
    // bot's wallet is sub-1 BCH today; this is just a tripwire against
    // a fat-fingered value getting persisted.
    throw new Error(`--bch-received-sats=${bchReceivedSats} is implausibly negative — refusing to close`);
  }

  // --fee-sats: optional, default 0.
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
    : 'operator manual reconciliation';

  const dryRun = flags['dry-run'] === true;

  return {
    positionId,
    exitTxid: rawExitTxid.length > 0 ? rawExitTxid : null,
    bchReceivedSats,
    feeSats,
    reason,
    dryRun,
    positionsFile,
  };
}

/**
 * Pure helper: compute the exit-block + realized P&L for a given
 * (position, args) pair. Exported so tests can pin the math
 * independently of the `Positions.close()` I/O.
 *
 * Note: `pnl.mjs#realizedPnlSats` uses `toSats()` which collapses
 * negative values to `null` (sats are supposed to be non-negative
 * amounts). A manual reconciliation might legitimately come back
 * negative (catastrophic slippage, partial loss, etc.) — for that
 * case we compute the math ourselves with signed bigints and pass
 * the non-negative ABS to `Positions.close()` (which only stores
 * what `realizedPnlSats()` returns; for the rare negative case we
 * still write a 0 to the store and capture the true net in the
 * manual history event).
 *
 * @param {Object} position   a `PositionEntry` from data/positions.json
 * @param {{ exitTxid: string|null, bchReceivedSats: bigint, feeSats: bigint, reason: string }} args
 * @returns {{ exit: Object, realizedPnlSats: number, pnlBreakdown: Object }}
 */
export function buildReconcileExit(position, args) {
  const ts = new Date().toISOString();
  // `Positions.close()` stores the realized P&L as `exit.realized_pnl_sats`
  // — it expects a NON-NEGATIVE number per `pnl.mjs#realizedPnlSats` math.
  // For negative reconciliations we record the actual loss in the manual
  // history event but write 0 to positions.json (so downstream consumers
  // see "no realized gain" rather than misinterpreting a negative as a
  // signed P&L category that doesn't exist yet). The OPERATOR is
  // expected to review the history event for the true net.
  const bchReceivedForStore = args.bchReceivedSats < 0n ? 0n : args.bchReceivedSats;
  const exit = {
    txid: args.exitTxid ?? '',
    price_sats_per_token: 0, // not derivable from a manual reconciliation
    bch_received_sats: Number(bchReceivedForStore),
    fee_sats: Number(args.feeSats),
    ts,
    reason: args.reason,
    source: 'manual-reconcile', // distinguishes from bot-driven 'exit' reasons
    slippage_bps: null,
  };
  // Pure P&L math (signed) — uses BigInt directly, not the toSats-coerced
  // helper, so negative exits produce negative numbers.
  const entrySpent = BigInt(position?.entry?.bch_spent_sats ?? 0);
  const entryFee = BigInt(position?.entry?.fee_sats ?? 0);
  const exitFee = BigInt(args.feeSats);
  const gross = args.bchReceivedSats - entrySpent;
  const net = gross - entryFee - exitFee;
  const pnlBreakdown = {
    gross,
    net,
    entry_fee_sats: entryFee,
    exit_fee_sats: exitFee,
  };
  // What we write to the positions store: 0 for negative exits (loss
  // is captured in the history event), actual number otherwise.
  const realizedForStore = net < 0n ? 0 : Number(net);
  // What we return for the manual history event: the actual signed net.
  const realizedActual = Number(net);
  return { exit, realizedPnlSats: realizedForStore, pnlBreakdown, realizedActual };
}

// T29: only run when invoked directly — when imported by
// tests/scripts.test.mjs the body is skipped so the test suite can
// pull `parseReconcilePositionArgs` / `resolveReconcileArgs` /
// `buildReconcileExit` without the script trying to read
// config/user.json / mutate data/positions.json / append to history.
const isDirect = import.meta.url === `file://${process.argv[1]}` ||
                 process.argv[1]?.endsWith('reconcile-position.mjs');

// Shape-parity `main` for tests; ESM requires `export` at top
// level, so we always declare it and the body short-circuits
// when the script is imported (not directly invoked).
async function reconcilePositionMain() { return { ok: false, error: 'not_direct_invocation' }; }
export { reconcilePositionMain as main };

const log = createLogger({ sink: process.stderr, component: 'reconcile' });
if (!isDirect) {
  log.info('reconcile.imported-skip', { reason: 'not_direct_invocation' });
}
if (isDirect) {

const { flags } = parseReconcilePositionArgs(process.argv);

if (flags.help === true || flags.h === true) {
  process.stderr.write(
    'Usage: node scripts/reconcile-position.mjs ' +
    '--position-id <id> [--exit-txid <hex>] --bch-received-sats <n> ' +
    '[--fee-sats <n>] [--reason <text>] [--positions-file <path>] [--dry-run]\n',
  );
  process.exit(0);
}

log.info('reconcile.boot', { flags });

let args;
try {
  args = resolveReconcileArgs(flags);
} catch (e) {
  log.error('reconcile.bad-args', { error: e?.message ?? String(e) });
  process.stderr.write(`\n${e?.message ?? e}\n\nUsage: node scripts/reconcile-position.mjs --position-id <id> --bch-received-sats <n>\n`);
  process.exit(2);
}
log.info('reconcile.args', {
  position_id: args.positionId,
  exit_txid: args.exitTxid,
  bch_received_sats: args.bchReceivedSats.toString(),
  fee_sats: args.feeSats.toString(),
  reason: args.reason,
  dry_run: args.dryRun,
});

// Load merged config (default + user). The script doesn't need the WIF
// — it touches positions.json only — but `loadConfig()` is the standard
// entry point and validates the on-disk schema.
const cfg = await loadConfig();
if (typeof cfg.paths?.positions_file === 'string' && cfg.paths.positions_file.length > 0) {
  // Honor a config-default override if no explicit --positions-file was given.
  if (!(typeof flags['positions-file'] === 'string' && flags['positions-file'].length > 0)) {
    args.positionsFile = cfg.paths.positions_file;
  }
}
const positions = new Positions({ file: args.positionsFile, logger: log.child('positions') });
await positions.load();

const position = await positions.findById(args.positionId);
if (!position) {
  log.error('reconcile.position-not-found', { position_id: args.positionId, file: args.positionsFile });
  process.stderr.write(`\nPosition ${args.positionId} not found in ${args.positionsFile}.\n`);
  process.exit(3);
}
if (position.status === 'closed') {
  log.error('reconcile.already-closed', { position_id: args.positionId, closed_at: position.closed_at });
  process.stderr.write(`\nPosition ${args.positionId} is already closed (closed_at=${position.closed_at}). Nothing to do.\n`);
  process.exit(3);
}
if (position.status !== 'open' && position.status !== 'pending') {
  log.error('reconcile.bad-status', { position_id: args.positionId, status: position.status });
  process.stderr.write(`\nPosition ${args.positionId} has status "${position.status}" — refusing to close (only 'open' / 'pending' / 'closed' are handled).\n`);
  process.exit(3);
}

const { exit, realizedPnlSats: realized, pnlBreakdown, realizedActual } = buildReconcileExit(position, args);
log.info('reconcile.plan', {
  position_id: position.id,
  token_id: position.token_id,
  entry_txid: position.entry?.txid ?? null,
  exit_txid: exit.txid || null,
  exit_reason: exit.reason,
  exit_source: exit.source,
  bch_received_sats: exit.bch_received_sats,
  fee_sats: exit.fee_sats,
  realized_pnl_sats: realized,
  pnl_breakdown: {
    gross: pnlBreakdown.gross === null ? null : pnlBreakdown.gross.toString(),
    net: pnlBreakdown.net === null ? null : pnlBreakdown.net.toString(),
    entry_fee_sats: pnlBreakdown.entry_fee_sats === null ? null : pnlBreakdown.entry_fee_sats.toString(),
    exit_fee_sats: pnlBreakdown.exit_fee_sats === null ? null : pnlBreakdown.exit_fee_sats.toString(),
  },
});

if (args.dryRun) {
  log.info('reconcile.dry-run.complete', {
    position_id: position.id,
    would_close_with: exit,
    realized_pnl_sats: realized,
    positions_file: args.positionsFile,
    message: 'no disk writes (--dry-run); run without --dry-run to commit',
  });
  const summary = {
    ok: true,
    dry_run: true,
    position_id: position.id,
    token_id: position.token_id,
    exit_block: exit,
    realized_pnl_sats: realized,
    positions_file: args.positionsFile,
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  process.exit(0);
}

// Live path: close the position via the same API the bot uses.
const closed = await positions.close(args.positionId, exit, realized);
log.info('reconcile.closed', {
  position_id: closed.id,
  token_id: closed.token_id,
  exit_txid: closed.exit?.txid ?? null,
  exit_reason: closed.exit?.reason ?? null,
  realized_pnl_sats: closed.exit?.realized_pnl_sats ?? null,
  realized_pnl_sats_actual: realizedActual, // signed (negative on loss)
  closed_at: closed.closed_at,
});

// Append a structured history event so the dashboard / P&L surfaces
// the manual close. The kind='manual_exit' tag is the same shape the
// bot uses for `entry_dry_run` / `exit_dry_run` (T24) — operators
// can grep for it.
const historyPath = (cfg.paths?.history_file && typeof cfg.paths.history_file === 'string')
  ? cfg.paths.history_file
  : 'data/history.ndjson';
const historyEvent = {
  ts: closed.closed_at,
  kind: 'manual_exit',
  source: 'scripts/reconcile-position.mjs',
  dry_run: false,
  position_id: closed.id,
  token_id: closed.token_id,
  entry_txid: closed.entry?.txid ?? null,
  exit_txid: closed.exit?.txid ?? null,
  bch_received_sats: Number(args.bchReceivedSats), // signed (true value)
  fee_sats: Number(args.feeSats),
  realized_pnl_sats: realizedActual, // signed (true net)
  realized_pnl_sats_stored: closed.exit?.realized_pnl_sats ?? null, // non-negative (store copy)
  reason: closed.exit?.reason ?? null,
  positions_file: args.positionsFile,
};
try {
  await atomicAppendNdjson(historyPath, JSON.stringify(historyEvent));
  log.info('reconcile.history-appended', { file: historyPath, position_id: closed.id });
} catch (e) {
  // The position is already closed in positions.json at this point.
  // Log the failure loudly but don't unwind — the operator can append
  // a manual history line themselves if the dashboard looks wrong.
  log.error('reconcile.history-append-failed', {
    file: historyPath,
    err_name: e?.name ?? 'Error',
    err_message: e?.message ?? String(e),
    position_id: closed.id,
  });
}

const summary = {
  ok: true,
  dry_run: false,
  position_id: closed.id,
  token_id: closed.token_id,
  exit_block: closed.exit,
  realized_pnl_sats: closed.exit?.realized_pnl_sats ?? 0,
  closed_at: closed.closed_at,
  positions_file: args.positionsFile,
  history_file: historyPath,
};
process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
process.exit(0);

} // end isDirect block