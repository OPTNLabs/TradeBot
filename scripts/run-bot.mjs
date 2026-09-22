#!/usr/bin/env node
/**
 * scripts/run-bot.mjs
 *
 * TradeBot main entry point. Boots the trading loop and runs it
 * until SIGINT / SIGTERM. All side-effects are routed through the
 * existing, tested modules:
 *
 *   - `src/data/fetcher.mjs`         — Cauldron indexer adapter
 *   - `src/wallet/libauth.mjs`       — WIF signer + Electrum provider
 *   - `src/trader/swap.mjs`          — SwapExecutor (delegates to
 *                                       the trimmed cauldron CLIs)
 *   - `src/trader/loop.mjs`          — TradingLoop (the orchestrator)
 *   - `src/portfolio/positions.mjs`  — crash-safe position store
 *   - `src/portfolio/snapshots.mjs`  — periodic NDJSON balance snapshots
 *   - `src/risk/circuit-breaker.mjs` — daily-loss + consecutive-loss trips
 *
 * No business logic lives in this file — it's pure wiring + signal
 * handling.
 *
 * Usage:
 *   node scripts/run-bot.mjs                         # run forever (poll loop)
 *   node scripts/run-bot.mjs --once                  # run ONE tick then exit
 *   node scripts/run-bot.mjs --dry-run               # same as --once but never broadcast
 *   node scripts/run-bot.mjs --config-default=PATH
 *   node scripts/run-bot.mjs --config-user=PATH
 *   node scripts/run-bot.mjs --no-snapshot-record    # skip periodic snapshots
 *   node scripts/run-bot.mjs --help
 *
 * Exit codes:
 *   0  clean shutdown (SIGINT/SIGTERM after at least one tick)
 *   1  configuration / wiring error
 *   2  fatal startup error (missing WIF, unreachable indexer)
 *   130 SIGINT received with no ticks yet
 *   143 SIGTERM received with no ticks yet
 *
 * The bot is restart-safe: on SIGINT/SIGTERM the in-flight tick is
 * allowed to complete, then the process exits with code 0. State
 * writes are atomic (tmp + rename). The user can re-run with
 * `--once` to manually drive a single tick after a config change.
 */

import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

import { createLogger } from '../src/util/logger.mjs';
import { loadConfig, DEFAULT_CONFIG_PATHS, summarizeConfig } from '../src/util/config-loader.mjs';
import { createFetcher } from '../src/data/fetcher.mjs';
import { SwapExecutor } from '../src/trader/swap.mjs';
import { Positions, DEFAULT_POSITIONS_FILE } from '../src/portfolio/positions.mjs';
import { Snapshots, DEFAULT_SNAPSHOTS_DIR } from '../src/portfolio/snapshots.mjs';
import { CircuitBreaker } from '../src/risk/circuit-breaker.mjs';
import { TradingLoop, DEFAULT_HISTORY_FILE, createHistoryAppender } from '../src/trader/loop.mjs';
// T76 subset 2b: wire the live holders scanner into the trader
// loop's eligibility gate. The same cache instance the dashboard
// ships (subset 2a) gets re-used here so a per-tick eligibility
// check is cheap once a token has been scanned once.
import {
  HoldersScannerCache,
  clampHoldersScannerCacheMs,
} from '../src/strategy/holder-scanner-cache.mjs';
// T75 (BadgerCoin staking live wire) — the auto-lock / auto-unlock
// orchestrators + the alert-dispatch wrapper that turns
// executeLock/executeUnlock envelopes into `kind:'stake_locked'` /
// `kind:'stake_unlock'` rows in `data/alerts.jsonl`. The loop
// already has sensible defaults for these (the imported symbols)
// but we pass them explicitly below so the wiring reads as one
// self-contained block.
import { executeLock, executeUnlock } from '../src/staking/badger-stake-tx.mjs';
import { dispatchStakeAlert } from '../src/staking/stake-alert-dispatch.mjs';
// T53.2 — alerts subsystem wiring. The trader loop + swap executor
// + circuit breaker each accept an optional `safeAlertDispatch`
// (channel router) and `alertsAppend` (NDJSON writer). When
// `cfg.alerts.enabled === true` the boot layer wires these seams
// in; when disabled (the default), the seam stays null and the
// hooks are silent (legacy behavior). Tests inject mocks via the
// matching `opts.*` seams.
import {
  createConfiguredAlertRouter,
  createAlertsAppender,
  DEFAULT_ALERTS_LOG_FILE,
} from '../src/alerts/index.mjs';
// T57-3: DEX adapter registry + boot helper. The loop's multi-DEX
// router (`src/trader/dex-router.mjs`) needs an array of booted
// adapters to pick the best rate per (token, side, size); this
// layer resolves `cfg.dex.*` and boots every active adapter
// (live cauldron, cauldron_safe_mode, guanaco scaffold, ...).
import { bootDexAdapters, resolveDexConfig } from '../src/dex/adapter.mjs';
import { createWallet, LibAuthBchWallet, redactWif, resolveWif } from '../src/wallet/libauth.mjs';

// ─── Logger ────────────────────────────────────────────────────────────────

const log = createLogger({ component: 'run-bot', sink: process.stderr });

// ─── CLI helpers ────────────────────────────────────────────────────────────

const HELP = `
TradeBot main entry — boots the trading loop and runs it.

Usage:
  node scripts/run-bot.mjs                       # run forever (poll loop)
  node scripts/run-bot.mjs --once                # run ONE tick then exit
  node scripts/run-bot.mjs --dry-run             # single tick, no swaps (read-only)
  node scripts/run-bot.mjs --config-default=PATH
  node scripts/run-bot.mjs --config-user=PATH
  node scripts/run-bot.mjs --no-snapshot-record  # skip periodic snapshots
  node scripts/run-bot.mjs --help

Exit codes:
  0  clean shutdown
  1  configuration / wiring error
  2  fatal startup error
  130 / 143  SIGINT / SIGTERM before first tick
`.trim();

/**
 * Minimal arg parser — same shape as the other scripts.
 *
 * @param {string[]} argv
 * @returns {{ flags: Record<string, string|true>, positional: string[] }}
 */
/**
 * T43c-server: the on-disk path the bot writes its own PID into
 * at boot time. The dashboard's `POST /api/config/:path` endpoint
 * reads this file to know which process to SIGUSR1 for a config
 * hot-reload. Default lives next to the rest of the runtime state.
 */
export const DEFAULT_RUN_PID_FILE = 'data/run.pid';

/**
 * T43c-server: write the current process PID to `filePath`. Atomic
 * via write-tmp + rename so a SIGKILL mid-write can't leave a
 * half-written PID file (the dashboard would otherwise send
 * SIGUSR1 to garbage and the bot would never wake up).
 *
 * Pure I/O — exported for tests + boot orchestration.
 *
 * @param {Object} [opts]
 * @param {string} [opts.filePath]    default: `data/run.pid`
 * @param {number} [opts.pid]         default: `process.pid`
 * @param {typeof import('node:fs/promises')} [opts.fs]
 * @returns {Promise<{ filePath: string, pid: number }>}
 */
export async function writeRunPidFile(opts = {}) {
  const filePath = (typeof opts.filePath === 'string' && opts.filePath.length > 0)
    ? opts.filePath
    : DEFAULT_RUN_PID_FILE;
  // Strict validation when opts.pid was explicitly provided (so a
  // caller passing a garbage pid fails loudly instead of silently
  // writing `process.pid` and leaving the dashboard unable to
  // signal the bot). When opts.pid is omitted, default to process.pid.
  let pid;
  if (opts.pid === undefined || opts.pid === null) {
    pid = process.pid;
  } else {
    if (typeof opts.pid !== 'number' || !Number.isFinite(opts.pid) || !Number.isInteger(opts.pid) || opts.pid <= 0) {
      throw new Error(`writeRunPidFile: pid must be a positive integer; got ${JSON.stringify(opts.pid)}`);
    }
    pid = opts.pid;
  }
  const fsImpl = opts.fs ?? null;
  const fsp = fsImpl ?? (await import('node:fs/promises'));
  const path = (await import('node:path'));
  const tmpPath = `${filePath}.tmp.${pid.toString(16).padStart(8, '0')}`;
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(tmpPath, `${pid}\n`, 'utf8');
  await fsp.rename(tmpPath, filePath);
  return { filePath, pid };
}

/**
 * T43c-server: read the bot's PID from `filePath`. Returns `null`
 * when the file is missing or unreadable — the endpoint then
 * responds with `pid_signaled: false` + a `pid_file_missing` note
 * rather than crashing. Throws on malformed PID content (a string
 * that isn't a positive integer is a fatal config error — better
 * to refuse the SIGUSR1 than to signal the wrong process).
 *
 * @param {Object} [opts]
 * @param {string} [opts.filePath]    default: `data/run.pid`
 * @param {typeof import('node:fs/promises')} [opts.fs]
 * @returns {Promise<{ pid: number, filePath: string }|null>}
 */
export async function readRunPidFile(opts = {}) {
  const filePath = (typeof opts.filePath === 'string' && opts.filePath.length > 0)
    ? opts.filePath
    : DEFAULT_RUN_PID_FILE;
  const fsImpl = opts.fs ?? null;
  const fsp = fsImpl ?? (await import('node:fs/promises'));
  let raw;
  try {
    raw = await fsp.readFile(filePath, 'utf8');
  } catch (e) {
    if (e && typeof e === 'object' && /** @type {any} */ (e).code === 'ENOENT') return null;
    throw e;
  }
  const trimmed = String(raw ?? '').trim();
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    throw new Error(`readRunPidFile: malformed PID file at ${filePath}: ${JSON.stringify(trimmed)}`);
  }
  return { pid: parsed, filePath };
}

/**
 * T43c-server: delete the PID file on shutdown. Idempotent — a
 * missing file is treated as success so a stale process can't
 * break a fresh boot.
 *
 * @param {Object} [opts]
 * @param {string} [opts.filePath]
 * @param {typeof import('node:fs/promises')} [opts.fs]
 * @returns {Promise<boolean>}  true if a file was removed; false if there was nothing to remove.
 */
export async function removeRunPidFile(opts = {}) {
  const filePath = (typeof opts.filePath === 'string' && opts.filePath.length > 0)
    ? opts.filePath
    : DEFAULT_RUN_PID_FILE;
  const fsImpl = opts.fs ?? null;
  const fsp = fsImpl ?? (await import('node:fs/promises'));
  try {
    await fsp.unlink(filePath);
    return true;
  } catch (e) {
    if (e && typeof e === 'object' && /** @type {any} */ (e).code === 'ENOENT') return false;
    throw e;
  }
}

export function parseRunBotArgs(argv) {
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
 * Resolve the position-sizing + risk knobs that the SwapExecutor
 * needs at boot. Pulls them from the merged config, with safe
 * fallbacks if the operator forgot to set one.
 *
 * @param {Object} cfg
 * @returns {{
 *   max_position_bch: number,
 *   max_total_exposure_bch: number,
 *   min_wallet_balance_bch: number,
 *   slippage_tolerance_bps: number,
 *   min_trade_size_bch: number,
 *   max_indexer_vs_amm_ratio_x: number,
 *   min_amm_total_depth_sats: number,
 *   max_position_concentration_pct: number,
 *   loss_cooldown_minutes: number,
 *   volatility_sizing_target_pct: number,
 *   correlation_skip_threshold: number,
 *   min_pool_age_days: number,
 *   tp_vol_multiplier: number,
 *   sl_vol_multiplier: number,
 *   tp_vol_floor_pct: number,
 *   tp_vol_ceiling_pct: number,
 *   sl_vol_floor_pct: number,
 *   sl_vol_ceiling_pct: number,
 * }}
 */
export function resolveTradingKnobs(cfg) {
  const e = (cfg && cfg.entry) ? cfg.entry : {};
  const r = (cfg && cfg.risk) ? cfg.risk : {};
  return {
    max_position_bch: Number.isFinite(Number(e.max_position_bch))
      ? Number(e.max_position_bch) : 0.005,
    max_total_exposure_bch: Number.isFinite(Number(e.max_total_exposure_bch))
      ? Number(e.max_total_exposure_bch) : 0.04,
    min_wallet_balance_bch: Number.isFinite(Number(r.min_wallet_balance_bch))
      ? Number(r.min_wallet_balance_bch) : 0.005,
    slippage_tolerance_bps: Number.isFinite(Number(e.slippage_tolerance_bps))
      ? Number(e.slippage_tolerance_bps) : 100,
    min_trade_size_bch: Number.isFinite(Number(e.min_trade_size_bch))
      ? Number(e.min_trade_size_bch) : 0.0005,
    max_indexer_vs_amm_ratio_x: Number.isFinite(Number(e.max_indexer_vs_amm_ratio_x))
      ? Number(e.max_indexer_vs_amm_ratio_x) : 1000,
    min_amm_total_depth_sats: Number.isFinite(Number(e.min_amm_total_depth_sats))
      ? Number(e.min_amm_total_depth_sats) : 150_000_000,
    // T33 — wallet-relative position concentration cap. `null` here
    // would propagate into the dashboard / loop; pass through the
    // raw config value verbatim so the downstream entry sizer can
    // apply its own -1 sentinel for "guard disabled". Default 25.0
    // matches DEFAULT_ENTRY_CONFIG.max_position_concentration_pct.
    max_position_concentration_pct: Number.isFinite(Number(e.max_position_concentration_pct))
      ? Number(e.max_position_concentration_pct) : 25.0,
    // T34 — loss cooldown. After a stop-loss exit, the circuit
    // breaker pauses new entries for this many minutes. Operators
    // who explicitly set this to 0 (or a negative value) in
    // `config/user.json` get the verbatim opt-out value reflected
    // here (the breaker refuses to cooldown on a non-positive
    // number). For nullish / non-numeric junk we substitute the
    // default — but note `Number(null) === 0`, so we can't use
    // `Number.isFinite(Number(...))` alone; we must first check
    // the raw value is a real number AND finite.
    loss_cooldown_minutes: (typeof r.loss_cooldown_minutes === 'number' && Number.isFinite(r.loss_cooldown_minutes))
      ? r.loss_cooldown_minutes
      : (r.loss_cooldown_minutes != null && Number.isFinite(Number(r.loss_cooldown_minutes)))
        ? Number(r.loss_cooldown_minutes)
        : 30,
    // T35 — Kelly-lite volatility-adjusted sizing target. Operators
    // who explicitly set this to 0 / negative / > 100 in
    // `config/user.json` get the verbatim opt-out value reflected
    // here (the entry sizer refuses to scale on a non-positive or
    // out-of-range number). For nullish / non-numeric junk we
    // substitute the default — but note `Number(null) === 0`, so we
    // can't use `Number.isFinite(Number(...))` alone; we must first
    // check the raw value is a real number AND finite.
    volatility_sizing_target_pct: (typeof e.volatility_sizing_target_pct === 'number' && Number.isFinite(e.volatility_sizing_target_pct))
      ? e.volatility_sizing_target_pct
      : (e.volatility_sizing_target_pct != null && Number.isFinite(Number(e.volatility_sizing_target_pct)))
        ? Number(e.volatility_sizing_target_pct)
        : 5.0,
    // T36 — correlation-skip threshold. Operators who explicitly set
    // this to 0 / negative / > 1 in `config/user.json` get the
    // verbatim opt-out value reflected here (the entry strategy
    // refuses to apply the guard on a non-positive or out-of-range
    // number). For nullish / non-numeric junk we substitute the
    // default -1 (guard disabled). Same opt-in pattern as T33/T35.
    correlation_skip_threshold: (typeof e.correlation_skip_threshold === 'number' && Number.isFinite(e.correlation_skip_threshold))
      ? e.correlation_skip_threshold
      : (e.correlation_skip_threshold != null && Number.isFinite(Number(e.correlation_skip_threshold)))
        ? Number(e.correlation_skip_threshold)
        : -1,
    // T37 — minimum pool age. Tokens whose oldest active pool is
    // younger than this are dropped at entry (wash-trade / seed-swap
    // risk on freshly-launched tokens). Same opt-in pattern as
    // T33/T35/T36: 0 / negative / > 365 passes through verbatim as
    // the opt-out signal; non-numeric junk falls back to the default.
    min_pool_age_days: (typeof e.min_pool_age_days === 'number' && Number.isFinite(e.min_pool_age_days))
      ? e.min_pool_age_days
      : (e.min_pool_age_days != null && Number.isFinite(Number(e.min_pool_age_days)))
        ? Number(e.min_pool_age_days)
        : 7,
    // T38 — dynamic TP/SL based on 7d realized volatility. Same
    // null-safe pattern as the other knobs: explicit 0 / negative
    // / non-finite opt-out values pass through verbatim so the
    // exit decision can short-circuit dynamic TP/SL and fall back
    // to the fixed `take_profit_pct` / `stop_loss_pct`. Non-numeric
    // junk falls back to the DEFAULT_EXIT_CONFIG defaults.
    tp_vol_multiplier: (typeof (cfg && cfg.exit && cfg.exit.tp_vol_multiplier) === 'number' && Number.isFinite(cfg.exit.tp_vol_multiplier))
      ? cfg.exit.tp_vol_multiplier
      : ((cfg && cfg.exit && cfg.exit.tp_vol_multiplier != null && Number.isFinite(Number(cfg.exit.tp_vol_multiplier)))
        ? Number(cfg.exit.tp_vol_multiplier)
        : 2.0),
    sl_vol_multiplier: (typeof (cfg && cfg.exit && cfg.exit.sl_vol_multiplier) === 'number' && Number.isFinite(cfg.exit.sl_vol_multiplier))
      ? cfg.exit.sl_vol_multiplier
      : ((cfg && cfg.exit && cfg.exit.sl_vol_multiplier != null && Number.isFinite(Number(cfg.exit.sl_vol_multiplier)))
        ? Number(cfg.exit.sl_vol_multiplier)
        : 1.0),
    tp_vol_floor_pct: (typeof (cfg && cfg.exit && cfg.exit.tp_vol_floor_pct) === 'number' && Number.isFinite(cfg.exit.tp_vol_floor_pct))
      ? cfg.exit.tp_vol_floor_pct
      : ((cfg && cfg.exit && cfg.exit.tp_vol_floor_pct != null && Number.isFinite(Number(cfg.exit.tp_vol_floor_pct)))
        ? Number(cfg.exit.tp_vol_floor_pct)
        : 2.0),
    tp_vol_ceiling_pct: (typeof (cfg && cfg.exit && cfg.exit.tp_vol_ceiling_pct) === 'number' && Number.isFinite(cfg.exit.tp_vol_ceiling_pct))
      ? cfg.exit.tp_vol_ceiling_pct
      : ((cfg && cfg.exit && cfg.exit.tp_vol_ceiling_pct != null && Number.isFinite(Number(cfg.exit.tp_vol_ceiling_pct)))
        ? Number(cfg.exit.tp_vol_ceiling_pct)
        : 80.0),
    sl_vol_floor_pct: (typeof (cfg && cfg.exit && cfg.exit.sl_vol_floor_pct) === 'number' && Number.isFinite(cfg.exit.sl_vol_floor_pct))
      ? cfg.exit.sl_vol_floor_pct
      : ((cfg && cfg.exit && cfg.exit.sl_vol_floor_pct != null && Number.isFinite(Number(cfg.exit.sl_vol_floor_pct)))
        ? Number(cfg.exit.sl_vol_floor_pct)
        : 1.0),
    sl_vol_ceiling_pct: (typeof (cfg && cfg.exit && cfg.exit.sl_vol_ceiling_pct) === 'number' && Number.isFinite(cfg.exit.sl_vol_ceiling_pct))
      ? cfg.exit.sl_vol_ceiling_pct
      : ((cfg && cfg.exit && cfg.exit.sl_vol_ceiling_pct != null && Number.isFinite(Number(cfg.exit.sl_vol_ceiling_pct)))
        ? Number(cfg.exit.sl_vol_ceiling_pct)
        : 50.0),
  };
}

// ─── Wire up ────────────────────────────────────────────────────────────────

/**
 * Boot the bot. Wires every dependency, calls `wallet.init()`,
 * returns a `{ loop, wallet, fetcher, swap, positions, snapshots,
 * breaker, logger }` bundle that the caller can drive via `start()`
 * + `stop()` or `tick()`.
 *
 * Throws on any wiring error. Every external surface (fetcher,
 * swap, positions, snapshots, breaker, wallet, historyAppend,
 * logger, clock, scheduler) is overridable via `opts` — the test
 * suite can swap any of them without monkey-patching globals.
 *
 * @param {Object} [opts]
 * @param {Object} [opts.cfg]              merged config (defaults to loadConfig)
 * @param {Object} [opts.logger]
 * @param {Object} [opts.fetcher]
 * @param {Object} [opts.swap]
 * @param {Object} [opts.positions]
 * @param {Object} [opts.snapshots]
 * @param {Object} [opts.breaker]
 * @param {Object} [opts.wallet]
 * @param {string} [opts.positionsFile]
 * @param {string} [opts.snapshotsDir]
 * @param {string} [opts.historyFile]
 * @param {Function} [opts.historyAppend]
 * @param {Function} [opts.clock]
 * @param {Function} [opts.scheduler]
 * @param {boolean}   [opts.dryRun=false]    wired by `--dry-run`: skip swap broadcast, skip
 *                                            positions.open/confirm/close/HWM, skip
 *                                            breaker.recordResult.
 * @param {boolean}   [opts.skipWalletInit]  test seam — skip wallet.init() (mocks handle it)
 * @param {Function} [opts.safeAlertDispatch]  T53.2 test seam — dispatch function injected into
 *                                              breaker/swap/loop. When omitted, the boot layer
 *                                              builds one from `cfg.alerts` via
 *                                              `createConfiguredAlertRouter(cfg)`.
 * @param {Function} [opts.alertsAppend]       T53.2 test seam — NDJSON writer injected into
 *                                              breaker/swap/loop. When omitted, the boot layer
 *                                              builds one from `cfg.alerts` via
 *                                              `createAlertsAppender({...})`.
 * @param {Array<Object>} [opts.dexAdapters]  T57-3 test seam — pre-booted DEX adapters (skips the
 *                                              `bootDexAdapters(cfg.dex)` boot step). When omitted,
 *                                              `bootBot` calls `resolveDexConfig(cfg.dex)` +
 *                                              `bootDexAdapters(...)` and threads the result into
 *                                              `TradingLoop` as `dexAdapters`. Default = boot from
 *                                              cfg.
 */

/**
 * T53.2 — wire the alerts subsystem into the boot path.
 *
 * Returns a `{ safeAlertDispatch, alertsAppend, alertsLogFile,
 * alertsEnabled }` envelope so `bootBot` can inject the seams
 * into the breaker / swap / loop constructors. Each seam is
 * `null` when the operator hasn't opted in (`cfg.alerts.enabled
 * === false` or undefined); the receiving classes treat `null`
 * as "no alerts" and skip dispatch silently — the legacy
 * behavior T53.1 preserved.
 *
 * Test seams:
 *   - `opts.safeAlertDispatch` / `opts.alertsAppend` override the
 *     built-from-cfg version so unit tests can inject mocks
 *     without touching disk.
 *   - `opts.alertsLogFile` overrides the on-disk path
 *     (default: `cfg.alerts.log_file` ?? `DEFAULT_ALERTS_LOG_FILE`).
 *
 * @param {Object} cfg          merged config
 * @param {Object} [opts]
 * @param {Function} [opts.safeAlertDispatch]
 * @param {Function} [opts.alertsAppend]
 * @param {string} [opts.alertsLogFile]
 * @param {Object} [opts.logger]
 * @returns {{
 *   safeAlertDispatch: Function|null,
 *   alertsAppend: Function|null,
 *   alertsLogFile: string,
 *   alertsEnabled: boolean,
 * }}
 */
export function resolveAlertSeams(cfg, opts = {}) {
  const alertsCfg = (cfg && typeof cfg === 'object' && cfg.alerts && typeof cfg.alerts === 'object')
    ? cfg.alerts
    : {};
  const enabled = alertsCfg.enabled === true;
  const logFile = (typeof opts.alertsLogFile === 'string' && opts.alertsLogFile.length > 0)
    ? opts.alertsLogFile
    : (typeof alertsCfg.log_file === 'string' && alertsCfg.log_file.length > 0)
      ? alertsCfg.log_file
      : DEFAULT_ALERTS_LOG_FILE;
  const safeAlertDispatch = (typeof opts.safeAlertDispatch === 'function')
    ? opts.safeAlertDispatch
    : (enabled ? createConfiguredAlertRouter(cfg) : null);
  const alertsAppend = (typeof opts.alertsAppend === 'function')
    ? opts.alertsAppend
    : (enabled ? createAlertsAppender({ file: logFile, logger: opts.logger ?? null }) : null);
  return {
    safeAlertDispatch,
    alertsAppend,
    alertsLogFile: logFile,
    alertsEnabled: enabled,
  };
}

export async function bootBot(opts = {}) {
  const logger = opts.logger ?? log;
  const cfg = (opts.cfg && typeof opts.cfg === 'object')
    ? opts.cfg
    : await loadConfig({
      defaultPath: opts.configDefault,
      userPath: opts.configUser,
    });

  const knobs = resolveTradingKnobs(cfg);
  // Surface the effective knobs in the boot log so the operator can
  // spot a wrong preset (e.g. "max_position_bch=10" on a $20 wallet).
  logger.info('run-bot.boot', {
    ...summarizeConfig(cfg),
    knobs,
    preset_match: cfg.tuning_preset === 'small_balance_startup',
    dry_run: opts.dryRun === true,
  });
  if (knobs.max_position_bch > 0.1) {
    logger.warn('run-bot.boot.large-position', {
      max_position_bch: knobs.max_position_bch,
      message: 'max_position_bch > 0.1 BCH — this is NOT the small_balance_startup preset',
    });
  }

  const positionsFile = opts.positionsFile ?? DEFAULT_POSITIONS_FILE;
  const snapshotsDir = opts.snapshotsDir ?? DEFAULT_SNAPSHOTS_DIR;
  const historyFile = opts.historyFile ?? DEFAULT_HISTORY_FILE;
  // T43c-server: PID file path + configReader for hot-reload.
  // Default to `data/run.pid` next to the rest of the runtime state.
  // `cfg.paths.user` is what the dashboard reads to know which
  // `user.json` the bot is using; the endpoint re-uses the same path.
  const runPidFile = (typeof opts.runPidFile === 'string' && opts.runPidFile.length > 0)
    ? opts.runPidFile
    : DEFAULT_RUN_PID_FILE;
  // Build the configReader only when the caller opts in (default:
  // false). Production wires `opts.configReader` at `main()` time.
  const configReader = (typeof opts.configReader === 'function')
    ? opts.configReader
    : null;

  // 1. Fetcher — reads from cfg.data_sources.cauldron_indexer_base_url.
  const fetcher = opts.fetcher ?? createFetcher({
    indexerBaseUrl: cfg.data_sources?.cauldron_indexer_base_url,
    bcmrBaseUrl: cfg.data_sources?.bcmr_base_url,
    userAgent: cfg.data_sources?.user_agent,
  });

  // 2. Wallet — must be init()'d before SwapExecutor uses it.
  //    `cfg.user?.wallet?.wif` or `cfg.user?.wallet?.wif_file` (per the
  //    wallet module's resolution order). The wallet module reads those
  //    directly from cfg; we just hand it the merged config.
  let wallet = opts.wallet;
  if (!wallet) {
    wallet = new LibAuthBchWallet({ cfg, logger });
    if (!opts.skipWalletInit) {
      await wallet.init();
    }
  } else if (typeof wallet.init === 'function' && !opts.skipWalletInit) {
    await wallet.init();
  }
  logger.info('run-bot.wallet.ready', {
    address: wallet.getAddress ? wallet.getAddress() : null,
    network: wallet.getNetwork ? wallet.getNetwork() : null,
    electrum_url: wallet.getElectrumUrl ? wallet.getElectrumUrl() : null,
  });

  // 3. SwapExecutor — wraps the cauldron-swap-sdk. It reads
  //    `cfg.entry` + `cfg.risk` for slippage / position-size gates.
  // 3b. T53.2: wire the optional alerts seams (router + NDJSON writer)
  //    into every class that fires dispatch hooks.
  const { safeAlertDispatch, alertsAppend, alertsLogFile, alertsEnabled } =
    resolveAlertSeams(cfg, {
      safeAlertDispatch: opts.safeAlertDispatch,
      alertsAppend: opts.alertsAppend,
      alertsLogFile: opts.alertsLogFile,
      logger,
    });
  if (alertsEnabled) {
    logger.info('run-bot.alerts.enabled', { log_file: alertsLogFile });
  }
  const swap = opts.swap ?? new SwapExecutor({
    cfg, wallet, logger,
    safeAlertDispatch,
    alertsAppend,
  });

  // 4. Positions + Snapshots — crash-safe state stores.
  const positions = opts.positions ?? new Positions({ file: positionsFile, logger });
  const snapshots = opts.snapshots ?? new Snapshots({ dir: snapshotsDir, logger });

  // 5. Circuit breaker — reads `cfg.risk` for thresholds.
  const breaker = opts.breaker ?? new CircuitBreaker({
    cfg, logger,
    safeAlertDispatch,
    alertsAppend,
  });

  // 6. History appender — atomic NDJSON. Either injected for tests
  //    or built fresh from the configured file path.
  const historyAppend = opts.historyAppend ?? createHistoryAppender({
    file: historyFile,
  });

  // 6b. T57-3: boot DEX adapters from `cfg.dex.*`. The loop's
  //     multi-DEX router needs the booted adapters to pick the
  //     best rate per (token, side, size). `resolveDexConfig`
  //     validates + normalizes the cfg shape (typed envelope),
  //     `bootDexAdapters` materializes the live objects. Failed
  //     boots (e.g. guanaco before its indexer ships) get
  //     logged but do NOT abort the tick — the loop's router
  //     falls back to whatever did boot. When the operator
  //     opts out via `opts.dexAdapters` (tests), we skip the
  //     boot step entirely and let the loop use the injected
  //     array (or the empty default for legacy single-DEX).
  let dexAdapters = [];
  if (opts.dexAdapters === undefined) {
    const dexConfigResult = resolveDexConfig(cfg.dex);
    if (!dexConfigResult.ok) {
      // Bad dex config is a config error, not a fatal boot error:
      // we log it and fall back to the legacy single-DEX path
      // (loop with no adapters wired). The operator can fix the
      // config and re-launch. Same recovery path the rest of
      // `bootBot` uses for missing optional blocks.
      logger.warn('run-bot.dex.config-invalid', {
        error: dexConfigResult.error,
        recovery: 'continuing with no dex adapters (legacy single-DEX path)',
      });
    } else {
      const bootResult = bootDexAdapters({
        active: dexConfigResult.normalized.active,
        safeModeActive: dexConfigResult.normalized.safeModeActive,
      }, {
        config: cfg,
        deps: {},
      });
      dexAdapters = bootResult.adapters;
      if (bootResult.failed.length > 0) {
        // Each failed adapter gets its own log line so the operator
        // can see exactly which DEXes couldn't boot and why.
        for (const f of bootResult.failed) {
          logger.warn('run-bot.dex.adapter-failed', {
            adapter_id: f.id,
            code: f.code,
            message: f.message,
          });
        }
      }
      logger.info('run-bot.dex.boot', {
        active_requested: dexConfigResult.normalized.active,
        safe_mode_active: dexConfigResult.normalized.safeModeActive,
        booted_ids: dexAdapters.map((a) => a?.id ?? '<unknown>'),
        failed_ids: bootResult.failed.map((f) => f.id),
      });
    }
  } else if (Array.isArray(opts.dexAdapters)) {
    dexAdapters = opts.dexAdapters;
  }

  // 7. TradingLoop — the orchestrator.
  // T70: wire the auto-consolidation broadcast + WIF seams so the
  // loop's `risk.utxo_consolidation_auto_enabled:true` knob can
  // actually fire a real on-chain tx (when the operator opts in).
  // Both seams are deliberately OPT-IN via `opts.utxoConsolidation*`
  // overrides — the default wiring reads from the booted wallet's
  // provider (broadcast) + the resolved WIF (so the loop never
  // reaches into wallet private fields).
  const utxoConsolidationBroadcast = (typeof opts.utxoConsolidationBroadcast === 'function')
    ? opts.utxoConsolidationBroadcast
    : (async ({ hex }) => {
      // Production wiring: route through the wallet's existing
      // Electrum provider (`wallet._resolveDeps()` returns the
      // cached `{cashscript, libauth, provider}` triple on a
      // booted wallet). The provider's `sendRawTransaction(hex)`
      // is what `scripts/sweep-funds.mjs` already uses for
      // broadcast, so the consolidation tx lands on the same
      // Electrum server the bot is already connected to.
      if (!wallet || typeof wallet._resolveDeps !== 'function') {
        throw new Error('run-bot: wallet._resolveDeps missing — cannot broadcast consolidation tx');
      }
      const deps = await wallet._resolveDeps();
      const provider = deps?.provider;
      if (!provider || typeof provider.sendRawTransaction !== 'function') {
        throw new Error('run-bot: wallet provider.sendRawTransaction missing — cannot broadcast consolidation tx');
      }
      return provider.sendRawTransaction(hex);
    });

  // T75 (BadgerCoin staking live wire) — five seams the loop's
  // step-11 auto-stake path needs. T58 subset 3 (d62e81e)
  // introduced the seams in the loop, but run-bot.mjs never wired
  // them — so even with all four knobs flipped live the bot
  // short-circuited with `loop.stake.provider.missing`. The
  // operator's spec (operator-approved at 2026-09-19 22:58 PDT):
  //
  //   - Single position max (already enforced by `max_active_stakes: 1`
  //     in config + the `STALE_LOCK_EXISTS` guard inside
  //     `executeLock` + the `lockNftCount !== 0` short-circuit in
  //     `_maybeAutoLock`).
  //   - Lock amount = half of wallet's available BCH (changed in
  //     `_maybeAutoLock`; the `lock_amount_sats` knob is now ignored).
  //   - Open trading positions do NOT factor in (the
  //     `allow_when_positions_open` guard is removed).
  //
  // Seams (each accept an `opts.*` override so tests inject stubs):
  //
  //   `stakingProvider`        — the Electrum provider with
  //                              `sendRawTransaction(hex)`. Same
  //                              provider the consolidation path
  //                              uses; resolved via the wallet's
  //                              `_resolveDeps()`.
  //   `stakingLockExecute`     — bound `executeLock` from
  //                              `src/staking/badger-stake-tx.mjs`.
  //   `stakingUnlockExecute`   — bound `executeUnlock` from same.
  //   `stakingDispatch`        — bound `dispatchStakeAlert` from
  //                              `src/staking/stake-alert-dispatch.mjs`.
  //   `stakingGetBlockHeight`  — a function that returns the
  //                              current chain tip. Wired to
  //                              `wallet.getBlockHeight()` so the
  //                              auto-unlock path can compute
  //                              `tip - lockBlockHeight >= stakeBlocks + grace`.

  const stakingProvider = (typeof opts.stakingProvider === 'object' && opts.stakingProvider !== null)
    ? opts.stakingProvider
    : (async () => {
      if (!wallet || typeof wallet._resolveDeps !== 'function') {
        throw new Error('run-bot: wallet._resolveDeps missing — cannot resolve stakingProvider');
      }
      const deps = await wallet._resolveDeps();
      const provider = deps?.provider;
      if (!provider || typeof provider.sendRawTransaction !== 'function') {
        throw new Error('run-bot: wallet provider.sendRawTransaction missing — cannot broadcast stake tx');
      }
      return provider;
    })();

  // Resolve the provider once at boot so the first auto-stake tick
  // doesn't pay the `_resolveDeps()` round-trip + Electrum handshake
  // every cycle. `await` here is safe: the loop hasn't started yet,
  // and the operator pays this cost exactly once during boot.
  let stakingProviderResolved = null;
  try {
    stakingProviderResolved = await stakingProvider;
    if (!stakingProviderResolved || typeof stakingProviderResolved.sendRawTransaction !== 'function') {
      throw new Error('run-bot: resolved stakingProvider is missing sendRawTransaction');
    }
  } catch (e) {
    logger.warn('run-bot.staking.provider.resolve_failed', {
      err_name: e?.name ?? 'Error',
      err_message: e?.message ?? String(e),
    });
    stakingProviderResolved = null;
  }

  const stakingLockExecute = (typeof opts.stakingLockExecute === 'function')
    ? opts.stakingLockExecute
    : executeLock;
  const stakingUnlockExecute = (typeof opts.stakingUnlockExecute === 'function')
    ? opts.stakingUnlockExecute
    : executeUnlock;
  const stakingDispatch = (typeof opts.stakingDispatch === 'function')
    ? opts.stakingDispatch
    : dispatchStakeAlert;
  const stakingGetBlockHeight = (typeof opts.stakingGetBlockHeight === 'function')
    ? opts.stakingGetBlockHeight
    : async () => {
      if (!wallet || typeof wallet.getBlockHeight !== 'function') {
        throw new Error('run-bot: wallet.getBlockHeight missing — cannot derive current chain tip');
      }
      const h = await wallet.getBlockHeight();
      if (typeof h !== 'number' || !Number.isFinite(h) || h <= 0) {
        throw new Error(`run-bot: wallet.getBlockHeight returned invalid height: ${h}`);
      }
      return h;
    };

  // T75: explicit WIF seam for the staking paths. The libauth wallet
  // (`LibAuthBchWallet`) keeps the WIF in a private field; the safety
  // test in `tests/wallet-libauth.test.mjs` forbids a public
  // `getWif()` method. So `executeLock` / `executeUnlock` need the WIF
  // plumbed in via the `deps.wif` argument, which we resolve once
  // here via `resolveWif(...)` (the same helper the consolidation
  // path uses) and pass in. Tests inject a stub via `opts.stakingWif`.
  const stakingWif = (typeof opts.stakingWif === 'string' && opts.stakingWif.length > 0)
    ? opts.stakingWif
    : await resolveWif({
      wif: cfg.wallet?.wif,
      wifFile: cfg.wallet?.wif_file,
      env: process.env,
    }).catch((e) => {
      // Don't crash boot if WIF can't be resolved at boot time —
      // the auto-stake path will surface the missing seam
      // if/when the operator opts in. Mirrors the consolidation-WIF
      // resolve-failure pattern.
      logger.warn('run-bot.staking.wif.resolve_failed', {
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
      });
      return null;
    });

  logger.info('run-bot.staking.seams.wired', {
    provider_wired: stakingProviderResolved !== null,
    lock_execute: typeof stakingLockExecute === 'function',
    unlock_execute: typeof stakingUnlockExecute === 'function',
    dispatch: typeof stakingDispatch === 'function',
    get_block_height: typeof stakingGetBlockHeight === 'function',
    wif_resolved: typeof stakingWif === 'string' && stakingWif.length > 0,
  });
  const utxoConsolidationWif = (typeof opts.utxoConsolidationWif === 'string' && opts.utxoConsolidationWif.length >= 40)
    ? opts.utxoConsolidationWif
    : await resolveWif({
      wif: cfg.wallet?.wif,
      wifFile: cfg.wallet?.wif_file,
      env: process.env,
    }).catch((e) => {
      // Don't crash boot if WIF can't be resolved at boot time —
      // the auto-consolidation path will surface the missing seam
      // if/when the operator opts in. Production runs typically
      // resolve cleanly; this is a defensive belt-and-suspenders.
      logger.warn('run-bot.utxo_consolidation.wif.resolve_failed', {
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
      });
      return null;
    });

  const loop = new TradingLoop({
    cfg,
    fetcher,
    wallet,
    swap,
    positions,
    snapshots,
    breaker,
    historyAppend,
    logger,
    clock: opts.clock,
    scheduler: opts.scheduler,
    dryRun: opts.dryRun === true,
    // T57-3: pass the booted DEX adapters into the loop. When
    // empty, the loop uses `this.swap` as-is (legacy path) so
    // every existing call site keeps working without the dex.*
    // knobs in cfg. The router only kicks in when there's more
    // than one adapter wired.
    dexAdapters,
    // T43c-server: wire the hot-reload seam when the caller opted in.
    configReader: configReader ?? undefined,
    // T53.2: wire the alerts seams into the loop. The loop fires
    // dispatch hooks at entry_refused, exit_refused, breaker_skipped,
    // wallet_floor, and amm_divergence decision points.
    safeAlertDispatch,
    alertsAppend,
    // T70: wire the auto-consolidation seams. When
    // `risk.utxo_consolidation_auto_enabled:true` AND the
    // fragmentation gate fires, the loop calls
    // `executeConsolidationTx` itself with these seams so the
    // real on-chain broadcast goes through the same wallet the
    // rest of the bot uses. Without these wires the loop
    // short-circuits with `kind:'utxo_consolidation_seam_missing'`
    // so a partial operator config can never fire a half-built
    // tx.
    utxoConsolidationBroadcast,
    utxoConsolidationWif,
    // T75 (BadgerCoin staking live wire) — auto-lock / auto-unlock
    // seams. When `cfg.staking.enabled:true` AND
    // `cfg.staking.simulation_only:false`, the loop's tick step 11
    // calls `_maybeAutoStake(now, nowMs)` which dispatches via
    // these seams. Without `stakingProvider` wired, the loop logs
    // `loop.stake.provider.missing` and short-circuits every tick.
    stakingProvider: stakingProviderResolved,
    stakingLockExecute,
    stakingUnlockExecute,
    stakingDispatch,
    stakingGetBlockHeight,
    stakingWif,
    // T76 subset 2b: wire the holders scanner cache + provider URL
    // + timeout into the trader-loop eligibility gate. The cache
    // is shared per-bot (NOT per-server) — one instance shared
    // across every candidate in every tick. `cacheMs` reads
    // `cfg.scoring.concentration_rug_cache_ms` (the same knob the
    // dashboard wires), so the operator's hot-edit of user.json
    // propagates to the loop on the NEXT tick without a restart.
    // `holdersScannerFetcher` is intentionally left to the loop
    // default (= `globalThis.fetch`) so test overrides still work;
    // production runs the real TokenStork upstream.
    holdersScannerCache: new HoldersScannerCache({
      cacheMs: clampHoldersScannerCacheMs(
        (cfg && typeof cfg.scoring === 'object' && cfg.scoring !== null)
          ? cfg.scoring.concentration_rug_cache_ms
          : undefined,
      ),
    }),
    holdersScannerProviderUrl: (cfg && typeof cfg.scoring === 'object'
        && cfg.scoring !== null && typeof cfg.scoring.concentration_rug_provider_url === 'string'
        && cfg.scoring.concentration_rug_provider_url.length > 0)
      ? cfg.scoring.concentration_rug_provider_url
      : null,
    holdersScannerTimeoutMs: (cfg && typeof cfg.scoring === 'object'
        && cfg.scoring !== null && Number.isFinite(cfg.scoring.concentration_rug_timeout_ms))
      ? Number(cfg.scoring.concentration_rug_timeout_ms)
      : null,
  });

  return {
    cfg, knobs, loop, wallet, fetcher, swap, positions, snapshots, breaker, logger,
    runPidFile, dexAdapters,
    // T53.2: surface the alerts wiring so tests can assert on it.
    alertsLogFile, alertsEnabled,
    // T75: surface the staking seams so tests can assert on them.
    stakingProvider: stakingProviderResolved,
    stakingLockExecute,
    stakingUnlockExecute,
    stakingDispatch,
    stakingGetBlockHeight,
    stakingWif,
  };
}

// ─── Signal handling ────────────────────────────────────────────────────────

/**
 * Install SIGINT + SIGTERM handlers on the given loop. The handlers
 * are idempotent: a second SIGINT/SIGTERM will force-exit with the
 * standard code (130 / 143) so an operator can always kill a stuck
 * bot.
 *
 * @param {TradingLoop} loop
 * @param {Object} [opts]
 * @param {Object} [opts.logger]
 * @param {boolean} [opts.gracefulShutdownMs=15000]
 * @returns {{ uninstall: () => void }}
 */
export function installSignalHandlers(loop, opts = {}) {
  const logger = opts.logger ?? log;
  const gracefulShutdownMs = Number.isFinite(opts.gracefulShutdownMs)
    ? Number(opts.gracefulShutdownMs)
    : 15_000;
  let triggered = false;
  /** @type {null|'SIGINT'|'SIGTERM'} */
  let signalName = null;

  /** @param {'SIGINT'|'SIGTERM'} sig */
  const onSignal = async (sig) => {
    if (triggered) {
      logger.warn('run-bot.signal.force-exit', { signal: sig });
      process.exit(sig === 'SIGINT' ? 130 : 143);
    }
    triggered = true;
    signalName = sig;
    logger.info('run-bot.signal.received', { signal: sig, graceful_shutdown_ms: gracefulShutdownMs });
    try {
      // Race the loop's `stop()` against the grace timer.
      await Promise.race([
        loop.stop(),
        delay(gracefulShutdownMs).then(() => 'timeout'),
      ]);
      logger.info('run-bot.signal.stopped', { signal: sig });
      // Allow the structured logger to flush before exit. 100ms is
      // enough for a single stderr write; the logger is non-blocking
      // so a longer drain isn't necessary.
      await delay(50);
      process.exit(0);
    } catch (e) {
      logger.error('run-bot.signal.stop-failed', {
        signal: sig,
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
      });
      process.exit(1);
    }
  };

  const sigintHandler = () => { void onSignal('SIGINT'); };
  const sigtermHandler = () => { void onSignal('SIGTERM'); };
  process.on('SIGINT', sigintHandler);
  process.on('SIGTERM', sigtermHandler);

  return {
    uninstall() {
      process.removeListener('SIGINT', sigintHandler);
      process.removeListener('SIGTERM', sigtermHandler);
      triggered = false;
      signalName = null;
    },
    // Exposed for tests / instrumentation.
    isTriggered: () => triggered,
    signal: () => signalName,
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

/**
 * Run the bot. Returns an object describing the exit condition.
 *
 * @param {string[]} argv
 * @param {Object} [env=process.env]
 * @returns {Promise<{ ok: boolean, mode: 'forever'|'once'|'dry-run'|'help', ticks_run: number, last_result: Object|null, error?: string }>}
 */
export async function main(argv = process.argv, env = process.env) {
  const parsed = parseRunBotArgs(argv);
  if (parsed.flags.help === true || parsed.flags['?'] === true || parsed.flags.h === true) {
    process.stdout.write(HELP + '\n');
    return { ok: true, mode: 'help', ticks_run: 0, last_result: null };
  }
  const mode = parsed.flags['dry-run'] === true ? 'dry-run'
             : parsed.flags.once === true ? 'once'
             : 'forever';

  // T43c-server: build the SIGUSR1 hot-reload configReader. The
  // closure captures the configDefault / configUser paths so a
  // hot-reload picks up exactly the same files the bot booted
  // with (no path drift between the dashboard and the loop).
  // Only wired for `forever` mode — once/dry-run boot+exit so a
  // SIGUSR1 would be wasted.
  const hotReloadPaths = {
    configDefault: typeof parsed.flags['config-default'] === 'string' ? parsed.flags['config-default'] : undefined,
    configUser: typeof parsed.flags['config-user'] === 'string' ? parsed.flags['config-user'] : undefined,
  };
  const configReader = mode === 'forever'
    ? async () => {
        const loaded = await loadConfig(hotReloadPaths);
        return { cfg: loaded, knobs: resolveTradingKnobs(loaded) };
      }
    : null;

  let bundle;
  try {
    bundle = await bootBot({
      configDefault: hotReloadPaths.configDefault,
      configUser: hotReloadPaths.configUser,
      dryRun: mode === 'dry-run',
      configReader,
    });
  } catch (e) {
    log.error('run-bot.boot-failed', {
      err_name: e?.name ?? 'Error',
      err_message: e?.message ?? String(e),
      err_stack: e?.stack ?? null,
    });
    process.stderr.write(`Failed to boot: ${e?.message ?? e}\n`);
    return { ok: false, mode, ticks_run: 0, last_result: null, error: `boot: ${e?.message ?? e}` };
  }

  // T43c-server: write the PID file in forever mode so the
  // dashboard's `POST /api/config/:path` endpoint knows which
  // process to SIGUSR1. Once/dry-run don't get a PID file (the
  // process exits after the tick, so signaling it would race).
  if (mode === 'forever') {
    try {
      await writeRunPidFile({ filePath: bundle.runPidFile });
      log.info('run-bot.pidfile.written', { file: bundle.runPidFile, pid: process.pid });
    } catch (e) {
      log.warn('run-bot.pidfile.write-failed', {
        file: bundle.runPidFile,
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
      });
    }
  }

  const { loop } = bundle;

  if (mode === 'once' || mode === 'dry-run') {
    try {
      const result = await loop.tick();
      log.info('run-bot.tick.complete', {
        duration_ms: result.durationMs,
        candidates: result.candidates.length,
        entries: result.entries.length,
        exits: result.exits.length,
        snapshot_taken: result.snapshotTaken,
        breaker_tripped: result.breakerTripped,
        breaker_kind: result.breakerKind,
        fatal_error: result.fatalError ?? null,
      });
      // Print a compact summary to stdout so cron callers can grep.
      process.stdout.write(JSON.stringify({
        ok: true,
        mode,
        ticks: 1,
        last_result: {
          ts: result.ts,
          duration_ms: result.durationMs,
          candidates: result.candidates.length,
          entries: result.entries.length,
          exits: result.exits.length,
          snapshot_taken: result.snapshotTaken,
          breaker_tripped: result.breakerTripped,
          breaker_kind: result.breakerKind,
        },
      }) + '\n');
      return { ok: true, mode, ticks_run: 1, last_result: result };
    } catch (e) {
      log.error('run-bot.tick-failed', {
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
      });
      return { ok: false, mode, ticks_run: 0, last_result: null, error: `tick: ${e?.message ?? e}` };
    } finally {
      try { await bundle.wallet.close(); } catch { /* best effort */ }
      try { await removeRunPidFile({ filePath: bundle.runPidFile }); } catch { /* best effort */ }
    }
  }

  // Forever mode. Install signal handlers + start the loop.
  const handlers = installSignalHandlers(loop);
  try {
    await loop.start();
    // T43c-server: if a stale PID file was lying around (previous
    // bot crashed without cleanup), the fresh boot just overwrote
    // it. Nothing to do here — writeRunPidFile is atomic + idempotent.
    // `start()` resolves once the first tick is scheduled. We block
    // here until SIGINT/SIGTERM. The handlers are responsible for
    // calling `process.exit()` after `loop.stop()` returns.
    // The "idle wait" below is the program's main thread waiting for
    // a signal — without it, the event loop would have nothing to
    // keep the process alive (Node exits when there's no scheduled
    // work + no open handles). The TradingLoop schedules its own
    // ticks via `setTimeout`, so the event loop has work — but we
    // still need a sentinel so `main()` doesn't return.
    //
    // Approach: an unhandled promise that resolves when the loop
    // stops. The signal handlers call `loop.stop()` (via the
    // installer above) and then `process.exit(0)`, so this
    // `await` is a backstop in case the loop somehow stops
    // without a signal (e.g. an unhandled exception in a tick).
    await new Promise((resolve) => {
      // Hook into `loop._stopRequested` via the public stats() so we
      // can resolve when the loop stops without exporting internal
      // flags. The check interval is small (250ms) — the operator
      // gets near-instant feedback on SIGINT/SIGTERM via the
      // signal handler, so this is just the backstop path.
      const check = setInterval(() => {
        if (!loop.stats().running) {
          clearInterval(check);
          resolve(undefined);
        }
      }, 250);
    });
    handlers.uninstall();
    return { ok: true, mode, ticks_run: loop.stats().tick_count, last_result: loop.stats() };
  } catch (e) {
    log.error('run-bot.run-failed', {
      err_name: e?.name ?? 'Error',
      err_message: e?.message ?? String(e),
    });
    handlers.uninstall();
    return { ok: false, mode, ticks_run: 0, last_result: null, error: `run: ${e?.message ?? e}` };
  } finally {
    try { await bundle.wallet.close(); } catch { /* best effort */ }
    // T43c-server: clean up the PID file so the next bot boot
    // doesn't see a stale PID. Best-effort — a stale file at
    // most makes the dashboard signal the wrong PID (which will
    // be a different running process or no process at all).
    try { await removeRunPidFile({ filePath: bundle.runPidFile }); } catch { /* best effort */ }
  }
}

// Direct invocation
const isDirect = import.meta.url === `file://${process.argv[1]}` ||
                 process.argv[1]?.endsWith('run-bot.mjs');
if (isDirect) {
  main(process.argv).then((r) => {
    if (r.ok) {
      process.exit(0);
    }
    // Failure path. The error has already been logged + printed to
    // stderr; just exit non-zero so systemd / cron notices.
    process.exit(r.mode === 'help' ? 0 : 1);
  });
}

// Suppress unused-import warning for `createWallet` (kept for the
// future "operator imports wallet from a one-line script" path).
void createWallet;
void redactWif;