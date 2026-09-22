#!/usr/bin/env node
// scripts/check-stale-stakes.mjs
//
// T58 subset 5 — BadgerCoin Staking unlock-cron fallback.
//
// Why this exists
// ───────────────
// The trader loop fires `executeUnlock` for any mature lockNFT on
// every tick when `cfg.staking.auto_unlock_enabled === true` (T58
// subset 3). That's the happy path — but if the loop is PAUSED,
// CRASHED, RESTARTED, or never started in the first place, the
// auto-unlock doesn't fire. A user-initiated stake can sit past
// its maturity forever, with no one watching the wallet for the
// right moment to unlock.
//
// This CLI is the cron-friendly fallback. It boots the wallet,
// reads the live UTXO set, scans for mature lockNFTs, and fires
// `executeUnlock` for ONE lock per invocation (deterministic
// drain; the next cron tick picks up the next stale lock). Each
// dispatch routes through the existing `dispatchStakeAlert` seam
// so the operator gets a row in `data/alerts.jsonl` + (optionally)
// a Telegram notification — identical to the trader loop's
// auto-wire surface, just driven by cron instead of the tick.
//
// Exit codes (chosen so cron / systemd can route on them):
//   0  clean tick (no mature locks; nothing to do).
//   1  at least one `executeUnlock` dispatched (success OR failure).
//   2  wallet / config / Electrum error. The scan didn't run, or
//      ran against a stale UTXO set. Treat as "reconciliation
//      skipped" — surface to the operator.
//   3  bad CLI args (unknown flag, missing required arg, ...).
//
// Usage:
//   node scripts/check-stale-stakes.mjs --help
//   node scripts/check-stale-stakes.mjs                                # human-friendly
//   node scripts/check-stale-stakes.mjs --json                         # machine-readable JSON
//   node scripts/check-stale-stakes.mjs --dry-run                      # scan only, no broadcast
//   node scripts/check-stale-stakes.mjs --quiet                        # exit-code only
//   node scripts/check-stale-stakes.mjs --max-unlocks=1                # drain one per run (default)
//
// SAFETY: when run WITHOUT `--dry-run`, the script boots the real
// Electrum-backed wallet via LibAuthBchWallet (read-only
// `listUtxos()` + `getBlockHeight()` calls) AND, when a mature
// lock exists, signs + broadcasts a real `unlock` tx via the
// same `executeUnlock` orchestrator the trader loop uses. It does
// NOT broadcast lock txs (the cron only drains matures, never
// creates new locks). Telegram channel send is gated by the
// operator's `alerts.channels` config (default = `['console']`
// only).

import { promises as fsp } from 'node:fs';
import process from 'node:process';

import { loadConfig } from '../src/util/config-loader.mjs';
import { createLogger } from '../src/util/logger.mjs';
import {
  LibAuthBchWallet,
  walletConfigFrom,
  resolveWif,
} from '../src/wallet/libauth.mjs';
import {
  findMatureLockNfts,
  graceSecondsToBlocks,
  DEFAULT_MAX_UNLOCKS_PER_RUN,
  DEFAULT_LOCK_BLOCK_HEIGHT,
} from '../src/staking/find-mature-lock-nfts.mjs';
import { countLockNfts } from '../src/staking/badger-stake.mjs';
import { executeUnlock } from '../src/staking/badger-stake-tx.mjs';
import { dispatchStakeAlert } from '../src/staking/stake-alert-dispatch.mjs';
import { createAlertsAppender } from '../src/alerts/persist.mjs';

// ── arg parsing ──────────────────────────────────────────────────────────

/**
 * Parse argv into a `flags` object + `positional` array. Mirrors
 * the `parseCheckOrphanArgs` shape used by the other operator
 * scripts (one shared parser pattern across the operator CLIs).
 * Exported so `tests/staking-check-stale-stakes.test.mjs` can
 * exercise the parser without booting a wallet.
 *
 * @param {string[]} argv
 * @returns {{ flags: Record<string, string|boolean>, positional: string[] }}
 */
export function parseCheckStaleStakesArgs(argv) {
  const flags = {};
  const positional = [];
  let afterSeparator = false;
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (typeof a !== 'string') continue;
    if (!afterSeparator && a === '--') {
      afterSeparator = true;
      continue;
    }
    if (afterSeparator || !a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq >= 0) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      flags[a.slice(2)] = true;
    }
  }
  return { flags, positional };
}

/**
 * Validate parsed flags + apply defaults. Throws a typed error on
 * unsupported / unknown flags so the operator sees a one-liner
 * pointing at `--help` rather than a confusing crash later.
 *
 * @param {Record<string, string|boolean>} flags
 * @returns {{
 *   json: boolean,
 *   quiet: boolean,
 *   dryRun: boolean,
 *   noDispatch: boolean,
 *   maxUnlocks: number,
 *   force: boolean,
 *   tipHeightOverride: number|null,
 *   help: boolean,
 * }}
 */
export function resolveCheckStaleStakesArgs(flags) {
  const allowed = new Set([
    'json',
    'quiet',
    'dry-run',
    'no-dispatch',
    'max-unlocks',
    'force',
    'tip-height',
    'help',
  ]);
  for (const k of Object.keys(flags)) {
    if (!allowed.has(k)) {
      const err = new Error(`unknown flag --${k} (supported: --json, --quiet, --dry-run, --no-dispatch, --max-unlocks=N, --force, --tip-height=N, --help)`);
      err.code = 'STALE_STAKES_BAD_FLAG';
      throw err;
    }
  }
  let maxUnlocks = DEFAULT_MAX_UNLOCKS_PER_RUN;
  if (typeof flags['max-unlocks'] === 'string') {
    const parsed = Number.parseInt(flags['max-unlocks'], 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) {
      const err = new Error(`--max-unlocks must be an integer 1..100; got ${flags['max-unlocks']}`);
      err.code = 'STALE_STAKES_BAD_FLAG';
      throw err;
    }
    maxUnlocks = parsed;
  }
  let tipHeightOverride = null;
  if (typeof flags['tip-height'] === 'string') {
    const parsed = Number.parseInt(flags['tip-height'], 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      const err = new Error(`--tip-height must be a non-negative integer; got ${flags['tip-height']}`);
      err.code = 'STALE_STAKES_BAD_FLAG';
      throw err;
    }
    tipHeightOverride = parsed;
  }
  return {
    json: flags['json'] === true,
    quiet: flags['quiet'] === true,
    dryRun: flags['dry-run'] === true,
    noDispatch: flags['no-dispatch'] === true,
    maxUnlocks,
    force: flags['force'] === true,
    tipHeightOverride,
    help: flags['help'] === true,
  };
}

/**
 * Print the help banner. Mirrors the style of the other operator
 * scripts. Pure: writes to stdout when invoked directly.
 */
export function printCheckStaleStakesHelp() {
  const lines = [
    'check-stale-stakes — T58 subset 5',
    '',
    'Scans the wallet for lockNFTs (BadgerCoin Staking) whose',
    'timelock has elapsed, and fires `executeUnlock` for ONE per',
    'invocation (deterministic drain). Designed to be wired into a',
    'cron / systemd timer so the unlock happens even when the',
    'trader loop is paused / crashed / restarted.',
    '',
    'USAGE:',
    '  node scripts/check-stale-stakes.mjs [--json] [--quiet] [--dry-run]',
    '                                     [--no-dispatch]',
    '                                     [--max-unlocks=N]',
    '                                     [--force]',
    '                                     [--tip-height=N]',
    '',
    'OPTIONS:',
    '  --json                  Emit a structured JSON envelope on stdout.',
    '  --quiet                 Suppress the human-readable summary;',
    '                          exit-code only.',
    '  --dry-run               Scan the wallet + Electrum for mature',
    '                          locks but do NOT broadcast an unlock tx.',
    '  --no-dispatch           Scan + broadcast but skip the alert',
    '                          pipeline (persistence + Telegram). Useful',
    '                          when validating the dispatch shape alone.',
    '  --max-unlocks=N         How many mature locks to drain per run',
    '                          (default 1; matches the trader loop\'s',
    '                          "drain over multiple ticks" contract).',
    '  --force                 Bypass the `staking.unlock_cron_enabled`',
    '                          config gate (useful for one-off manual',
    '                          runs when the cron knob is off).',
    '  --tip-height=N          Override the on-chain tip height (tests +',
    '                          manual debugging; the production path',
    '                          calls `wallet.getBlockHeight()`).',
    '  --help, -h              Show this banner.',
    '',
    'EXIT CODES:',
    '  0  clean tick (no mature locks).',
    '  1  at least one `executeUnlock` dispatched (success OR failure).',
    '  2  wallet / config / Electrum error.',
    '  3  bad CLI args.',
    '',
  ];
  // eslint-disable-next-line no-console
  if (!process.env.STALE_STAKES_HELP_QUIET) console.log(lines.join('\n'));
}

// ── main orchestrator ────────────────────────────────────────────────────

/**
 * The pure orchestrator. Exported for the test suite so
 * `tests/staking-check-stale-stakes.test.mjs` can exercise every
 * code path with stubbed deps (no wallet boot, no network, no
 * disk writes).
 *
 * @param {Object} opts
 * @param {string[]} [opts.argv=process.argv]
 * @param {Object} [opts.deps]
 * @param {typeof loadConfig} [opts.deps.loadConfig]
 * @param {{getUtxos: Function, getBlockHeight: Function, getWif?: Function, getPkh?: Function}|null} [opts.deps.wallet]
 * @param {{sendRawTransaction: Function}} [opts.deps.provider]
 * @param {Function} [opts.deps.executeUnlock]
 * @param {Function} [opts.deps.dispatch]
 * @param {Function} [opts.deps.appender]
 * @param {Object} [opts.deps.logger]
 * @param {() => number} [opts.deps.nowMs]
 * @returns {Promise<{
 *   ok: boolean,
 *   code: number,
 *   args?: Object,
 *   help?: string,
 *   error?: string,
 *   report?: {
 *     version: number,
 *     generated_at: string|null,
 *     tip_height: number|null,
 *     lock_nft_count: number,
 *     mature: Array,
 *     premature: Array,
 *     undecodable: Array,
 *     skipped_cap: number,
 *     max_unlocks: number,
 *     unlocked: Array,
 *     failed: Array,
 *     alerts_dispatched: number,
 *     alerts_persisted: number,
 *     alerts_failed: number,
 *     dispatch_errors: Array,
 *     dry_run: boolean,
 *     no_dispatch: boolean,
 *     config_disabled: boolean,
 *     forced: boolean,
 *   },
 * }>}
 */
export async function main(opts = {}) {
  const argv = Array.isArray(opts.argv) ? opts.argv : process.argv;
  const { flags } = parseCheckStaleStakesArgs(argv);
  let args;
  try {
    args = resolveCheckStaleStakesArgs(flags);
  } catch (e) {
    return { ok: false, code: 3, help: printCheckStaleStakesHelp.toString().slice(0, 256), error: e?.message ?? String(e) };
  }
  if (args.help) {
    printCheckStaleStakesHelp();
    return { ok: true, code: 0, args };
  }

  const deps = (opts && typeof opts === 'object' && opts.deps && typeof opts.deps === 'object')
    ? opts.deps
    : {};
  const now = (typeof deps.nowMs === 'function') ? deps.nowMs() : Date.now();
  const logger = (deps.logger && typeof deps.logger === 'object')
    ? deps.logger
    : createLogger({ sink: process.stderr, component: 'check-stale-stakes' });

  // 1. Load config (needed for the master gate + grace-seconds).
  let cfg;
  try {
    const loader = (typeof deps.loadConfig === 'function') ? deps.loadConfig : loadConfig;
    cfg = await loader({ repoRoot: process.cwd() });
  } catch (e) {
    const msg = e?.message ?? String(e);
    logger.error('check_stale_stakes.config_load.failed', {
      event: 'check_stale_stakes.config_load',
      error: msg,
    });
    return { ok: false, code: 2, args, error: `config load failed: ${msg}` };
  }
  const stakeCfg = (cfg && cfg.staking) ? cfg.staking : {};
  const unlockCronEnabled = stakeCfg.unlock_cron_enabled === true;
  if (!unlockCronEnabled && !args.force) {
    logger.info('check_stale_stakes.disabled_via_config', {
      event: 'check_stale_stakes.disabled',
      knob: 'staking.unlock_cron_enabled',
    });
    return {
      ok: true,
      code: 0,
      args,
      report: {
        version: 1,
        generated_at: new Date(now).toISOString(),
        tip_height: null,
        lock_nft_count: 0,
        mature: [],
        premature: [],
        undecodable: [],
        skipped_cap: 0,
        max_unlocks: args.maxUnlocks,
        unlocked: [],
        failed: [],
        alerts_dispatched: 0,
        alerts_persisted: 0,
        alerts_failed: 0,
        dispatch_errors: [],
        dry_run: !!args.dryRun,
        no_dispatch: !!args.noDispatch,
        config_disabled: true,
        forced: false,
      },
    };
  }
  // Operator can dial in any cadence via the cron wrapper; the
  // knob is documentation. Validate it here as a sanity check so
  // a typo in `config/user.json` surfaces immediately rather than
  // silently disabling the cron.
  const configuredMinutes = Number(stakeCfg.unlock_cron_minutes ?? 15);
  if (!Number.isFinite(configuredMinutes) || configuredMinutes < 1 || configuredMinutes > 1440) {
    logger.warn('check_stale_stakes.cron_minutes.out_of_range', {
      event: 'check_stale_stakes.cron_minutes',
      knob: 'staking.unlock_cron_minutes',
      value: stakeCfg.unlock_cron_minutes,
    });
  }

  // 2. Fetch UTXOs + tip height. In dry-run mode the wallet seam
  //    is required for the scan (otherwise we have nothing to
  //    scan). The `--no-wallet` path is intentional: dry-run with
  //    a stub wallet that returns an empty UTXO set exercises the
  //    "no mature locks" branch deterministically.
  let utxos = [];
  let walletError = null;
  let tipHeight = null;

  if (deps.wallet && typeof deps.wallet.getUtxos === 'function') {
    // Test seam — caller injected a fake wallet.
    try {
      utxos = await deps.wallet.getUtxos();
    } catch (e) {
      walletError = e?.message ?? String(e);
      logger.error('check_stale_stakes.wallet.listUtxos.failed', {
        event: 'check_stale_stakes.wallet',
        error: walletError,
      });
    }
    if (walletError && !args.dryRun) {
      return { ok: false, code: 2, args, error: `wallet error: ${walletError}` };
    }
    if (args.tipHeightOverride !== null) {
      tipHeight = args.tipHeightOverride;
    } else if (typeof deps.wallet.getBlockHeight === 'function') {
      try {
        tipHeight = await deps.wallet.getBlockHeight();
      } catch (e) {
        walletError = e?.message ?? String(e);
        logger.error('check_stale_stakes.wallet.getBlockHeight.failed', {
          event: 'check_stale_stakes.wallet',
          error: walletError,
        });
        if (!args.dryRun) {
          return { ok: false, code: 2, args, error: `wallet error: ${walletError}` };
        }
      }
    }
  } else {
    // Production path — boot LibAuthBchWallet via the same wiring
    // the trader loop uses. Lazy-imported so test mocks don't pay
    // the boot cost.
    let walletCfg;
    let wif;
    let wallet;
    try {
      walletCfg = walletConfigFrom(cfg);
      wif = resolveWif(cfg);
      wallet = new LibAuthBchWallet({
        cfg: walletCfg,
        wif,
        logger: (record) => logger.info(record?.event ?? 'wallet', record),
      });
      await wallet.init();
      utxos = await wallet.listUtxos();
      tipHeight = args.tipHeightOverride !== null
        ? args.tipHeightOverride
        : await wallet.getBlockHeight();
    } catch (e) {
      walletError = e?.message ?? String(e);
      logger.error('check_stale_stakes.wallet.boot.failed', {
        event: 'check_stale_stakes.wallet',
        error: walletError,
      });
      if (!args.dryRun) {
        return { ok: false, code: 2, args, error: `wallet error: ${walletError}` };
      }
    }
  }

  // 3. Run the pure maturity scan.
  const graceBlocks = graceSecondsToBlocks(stakeCfg.lock_unlock_grace_seconds);
  const scan = findMatureLockNfts(utxos, {
    tipHeight: tipHeight ?? 0,
    graceBlocks,
    maxPerRun: args.maxUnlocks,
  });
  // Drop the `_maturity` envelope from the public report (operators
  // see `txid + vout + amounts`, not the internal seam).
  const publicMature = scan.mature.map((u) => ({
    txid: u?.txid ?? null,
    vout: u?.vout ?? null,
    satoshis: u?.satoshis != null ? u.satoshis.toString() : null,
    lock_block_height: u?._maturity?.lockBlockHeight ?? null,
    stake_blocks: u?._maturity?.stakeBlocks ?? null,
    blocks_elapsed: u?._maturity?.blocksElapsed ?? null,
  }));
  const publicPremature = scan.premature.map((u) => ({
    txid: u?.txid ?? null,
    vout: u?.vout ?? null,
    satoshis: u?.satoshis != null ? u.satoshis.toString() : null,
    lock_block_height: u?._maturity?.lockBlockHeight ?? null,
    stake_blocks: u?._maturity?.stakeBlocks ?? null,
    blocks_elapsed: u?._maturity?.blocksElapsed ?? null,
    blocks_required: u?._maturity?.blocksRequired ?? null,
    reason: u?._maturity?.reason ?? 'unknown',
  }));
  const publicUndecodable = scan.undecodable.map((entry) => ({
    txid: entry?.utxo?.txid ?? null,
    vout: entry?.utxo?.vout ?? null,
    error: entry?.error ?? 'unknown',
  }));

  logger.info('check_stale_stakes.scan.done', {
    event: 'check_stale_stakes.scan',
    tip_height: tipHeight,
    lock_nft_count: scan.totalLockNftCount,
    mature: scan.mature.length,
    premature: scan.premature.length,
    undecodable: scan.undecodable.length,
    skipped_cap: scan.skippedCap,
  });

  // 4. Early exit — no mature locks OR dry-run with no
  //    dispatch to perform.
  const mustDispatch = scan.mature.length > 0;
  if (!mustDispatch || args.dryRun) {
    return {
      ok: true,
      code: 0,
      args,
      report: {
        version: 1,
        generated_at: new Date(now).toISOString(),
        tip_height: tipHeight,
        lock_nft_count: scan.totalLockNftCount,
        mature: publicMature,
        premature: publicPremature,
        undecodable: publicUndecodable,
        skipped_cap: scan.skippedCap,
        max_unlocks: args.maxUnlocks,
        unlocked: [],
        failed: [],
        alerts_dispatched: 0,
        alerts_persisted: 0,
        alerts_failed: 0,
        dispatch_errors: [],
        dry_run: !!args.dryRun,
        no_dispatch: !!args.noDispatch,
        config_disabled: false,
        forced: !!args.force,
        reason_counts: scan.reasonCounts,
        grace_blocks: graceBlocks,
      },
    };
  }

  // 5. Fire `executeUnlock` for each mature lock (one at a time;
  //    cap is `args.maxUnlocks`). The orchestrator returns the
  //    same typed envelope the trader loop auto-wire handles, so
  //    `dispatchStakeAlert` doesn't need to know whether the
  //    caller is the loop or the cron.
  const executor = (typeof deps.executeUnlock === 'function')
    ? deps.executeUnlock
    : executeUnlock;
  const provider = deps.provider ?? null;
  const unlocked = [];
  const failed = [];
  const dispatchResults = [];
  let hitFailure = false;
  for (const lockUtxo of scan.mature) {
    if (!lockUtxo) continue;
    let result;
    try {
      result = await executor({
        cfg,
        wallet: deps.wallet ?? null,
        provider,
        lockUtxo,
        logger,
        deps: { nowMs: now },
      });
    } catch (e) {
      result = {
        ok: false,
        code: 'EXECUTE_THREW',
        error: e?.message ?? String(e),
        txid: null,
      };
      logger.warn('check_stale_stakes.execute_unlock.threw', {
        event: 'check_stale_stakes.execute_unlock',
        txid: lockUtxo?.txid ?? null,
        vout: lockUtxo?.vout ?? null,
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
      });
    }
    // Tag every envelope with `kind: 'unlock'` so
    // `dispatchStakeAlert` routes it through the unlock path.
    if (result && typeof result === 'object') result.kind = 'unlock';
    dispatchResults.push(result);
    if (result && result.ok === true) {
      unlocked.push({
        txid: lockUtxo?.txid ?? null,
        vout: lockUtxo?.vout ?? null,
        dispatch_txid: result.txid ?? null,
        fee: result.fee ?? null,
        amountSats: result.amountSats ?? null,
      });
    } else {
      failed.push({
        txid: lockUtxo?.txid ?? null,
        vout: lockUtxo?.vout ?? null,
        code: result?.code ?? 'UNKNOWN',
        error: result?.error ?? null,
      });
      logger.warn('check_stale_stakes.execute_unlock.failed', {
        event: 'check_stale_stakes.execute_unlock',
        txid: lockUtxo?.txid ?? null,
        vout: lockUtxo?.vout ?? null,
        code: result?.code ?? 'UNKNOWN',
        error: result?.error ?? null,
      });
      // Stop on first failure (deterministic drain — mirror the
      // trader loop's "fail-fast per lock; next tick handles the
      // next lock" contract). Operator can re-run with
      // --max-unlocks=N to override.
      hitFailure = true;
      break;
    }
  }
  // Silence the unused-var linter when the loop never hits a
  // failure; the variable documents the drain-stop contract for
  // future maintainers.
  if (hitFailure && false) { /* keep `hitFailure` semantically meaningful */ }
  void hitFailure;

  // 6. Dispatch every result through `dispatchStakeAlert` so the
  //    operator gets a row in `data/alerts.jsonl` + (optionally)
  //    a Telegram notification. Same surface as the trader loop.
  let alertsDispatched = 0;
  let alertsPersisted = 0;
  let alertsFailed = 0;
  let dispatchErrors = [];
  if (!args.noDispatch) {
    let router = (typeof deps.dispatch === 'function') ? { dispatch: deps.dispatch } : null;
    let appender = deps.appender ?? null;
    if (typeof appender !== 'function') {
      try {
        appender = createAlertsAppender({ logger: (record) => logger.warn(record?.event ?? 'alerts', record) });
      } catch (e) {
        logger.warn('check_stale_stakes.appender_init.failed', {
          event: 'check_stale_stakes.appender_init',
          error: e?.message ?? String(e),
        });
        appender = null;
      }
    }
    const dispatchFn = (typeof deps.dispatch === 'function' && typeof router?.dispatch === 'function')
      ? deps.dispatch
      : null;
    if (dispatchFn || appender) {
      const dispatchImpl = (typeof deps.dispatchStakeAlert === 'function')
        ? deps.dispatchStakeAlert
        : dispatchStakeAlert;
      try {
        const dispatchResult = await dispatchImpl({
          router: typeof dispatchFn === 'function' ? { dispatch: dispatchFn } : null,
          appender,
          results: dispatchResults,
          nowMs: now,
          logger,
        });
        alertsDispatched = dispatchResult.dispatched ?? 0;
        alertsPersisted = dispatchResult.persisted ?? 0;
        alertsFailed = dispatchResult.failed ?? 0;
        dispatchErrors = dispatchResult.errors ?? [];
      } catch (e) {
        // dispatchStakeAlert NEVER throws by contract; belt-and-
        // suspenders so a future refactor can't kill the cron tick.
        logger.error('check_stale_stakes.dispatch.unexpected_throw', {
          event: 'check_stale_stakes.dispatch',
          err_name: e?.name ?? 'Error',
          err_message: e?.message ?? String(e),
        });
      }
    }
  }

  // 7. Cleanup. Disconnect the Electrum provider so the process
  //    exits cleanly (cron wrappers expect zero-leak forks).
  if (deps.wallet && typeof deps.wallet.disconnect === 'function') {
    try { await deps.wallet.disconnect(); } catch (_e) { /* ignore */ }
  }

  logger.info('check_stale_stakes.done', {
    event: 'check_stale_stakes.done',
    tip_height: tipHeight,
    lock_nft_count: scan.totalLockNftCount,
    unlocked: unlocked.length,
    failed: failed.length,
    alerts_dispatched: alertsDispatched,
    alerts_persisted: alertsPersisted,
    alerts_failed: alertsFailed,
    dry_run: !!args.dryRun,
    no_dispatch: !!args.noDispatch,
    forced: !!args.force,
  });

  const code = (unlocked.length + failed.length) > 0 ? 1 : 0;
  return {
    ok: code === 0,
    code,
    args,
    report: {
      version: 1,
      generated_at: new Date(now).toISOString(),
      tip_height: tipHeight,
      lock_nft_count: scan.totalLockNftCount,
      mature: publicMature,
      premature: publicPremature,
      undecodable: publicUndecodable,
      skipped_cap: scan.skippedCap,
      max_unlocks: args.maxUnlocks,
      unlocked,
      failed,
      alerts_dispatched: alertsDispatched,
      alerts_persisted: alertsPersisted,
      alerts_failed: alertsFailed,
      dispatch_errors: dispatchErrors,
      dry_run: !!args.dryRun,
      no_dispatch: !!args.noDispatch,
      config_disabled: false,
      forced: !!args.force,
      reason_counts: scan.reasonCounts,
      grace_blocks: graceBlocks,
    },
  };
}

// ── CLI entry ────────────────────────────────────────────────────────────

// Only run when invoked directly. When imported by
// `tests/staking-check-stale-stakes.test.mjs`, the body
// short-circuits so the test suite can call `main(...)` without a
// real wallet boot.
const isDirect = import.meta.url === `file://${process.argv[1]}` ||
                 process.argv[1]?.endsWith('check-stale-stakes.mjs');

if (isDirect) {
  main().then((result) => {
    if (!result || typeof result !== 'object') {
      // eslint-disable-next-line no-console
      console.error('check-stale-stakes: no result returned');
      process.exit(2);
    }
    if (result.code === 3 && result.error) {
      // eslint-disable-next-line no-console
      console.error(`check-stale-stakes: ${result.error}`);
      // eslint-disable-next-line no-console
      console.error('Run with --help for usage.');
      process.exit(3);
    }
    if (result.code === 2 && result.error) {
      // eslint-disable-next-line no-console
      console.error(`check-stale-stakes: ${result.error}`);
      process.exit(2);
    }
    const args = result.args || {};
    const report = result.report;
    if (args.json && report) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(report, null, 2));
    } else if (!args.quiet && report) {
      const lines = [
        `stale-stakes scan @ ${report.generated_at}`,
        `tip height: ${report.tip_height ?? '?'}`,
        `lock NFT count: ${report.lock_nft_count}`,
        `mature: ${report.mature.length}`,
        `premature: ${report.premature.length}`,
        `undecodable: ${report.undecodable.length}`,
        `unlocked: ${report.unlocked.length}`,
        `failed: ${report.failed.length}`,
        `alerts dispatched: ${report.alerts_dispatched}`,
        `alerts persisted: ${report.alerts_persisted}`,
        `alerts failed: ${report.alerts_failed}`,
        `dry_run: ${report.dry_run}`,
        `forced: ${report.forced}`,
      ];
      if (report.mature.length > 0) {
        lines.push('');
        lines.push('Mature locks (drained in order):');
        for (const m of report.mature) {
          lines.push(`  - ${m.txid}:${m.vout}  blocks_elapsed=${m.blocks_elapsed} stake_blocks=${m.stake_blocks}`);
        }
      }
      if (report.failed.length > 0) {
        lines.push('');
        lines.push('Failed dispatches:');
        for (const f of report.failed) {
          lines.push(`  - ${f.txid}:${f.vout}  code=${f.code}  error=${f.error ?? '<none>'}`);
        }
      }
      // eslint-disable-next-line no-console
      console.log(lines.join('\n'));
    }
    process.exit(result.code ?? 0);
  }).catch((e) => {
    // eslint-disable-next-line no-console
    console.error('check-stale-stakes: unexpected error:', e?.message ?? String(e));
    if (process.env.DEBUG) {
      // eslint-disable-next-line no-console
      console.error(e?.stack ?? '');
    }
    process.exit(2);
  });
}
