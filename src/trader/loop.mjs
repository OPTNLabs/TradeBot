#!/usr/bin/env node
// src/trader/loop.mjs
//
// Main trading loop for TradeBot.
//
// Every `cfg.loop.poll_interval_seconds` the loop runs ONE tick that
// wires the whole pipeline together:
//
//   1. fetcher.listTopTokens() + per-token stats        → market state
//   2. rankPools(stats, cfg)                             → top-K candidates
//   3. wallet.getBalanceSats() + positions.list(...)     → portfolio state
//   4. breaker.evaluate(...)                             → risk gate
//   5. for each candidate: shouldEnter → canOpen → swap.execute
//                                                            → positions.open
//                                                            → history.append
//   6. for each open position: shouldExit → swap.execute
//                                                            → positions.close
//                                                            → breaker.recordResult
//                                                            → history.append
//   7. snapshots.maybeRecord(...)                       → periodic NDJSON line
//   8. history.append "tick"                            → one NDJSON line
//
// The loop is restart-safe. State lives in `data/` files; the
// in-memory side rebuilds from disk on each tick. The class holds
// no mutable business state between ticks — only the lifecycle
// flags (`_running`, `_stopRequested`) used by start()/stop().
//
// Design rules (also see docs/ARCHITECTURE.md §4.1 + §5.2):
//
//   1. **All knobs read from `cfg`.** The defaults that exist here
//      (`DEFAULT_LOOP_CONFIG`) only fire when the caller hands us
//      a null/garbage `cfg.loop` — never in production. The trader
//      loop is the consumer the size limits were enforced for.
//
//   2. **Every external surface is DI.** The constructor accepts
//      `fetcher`, `swap`, `positions`, `snapshots`, `breaker`,
//      `wallet`, `historyAppend`, and `clock`. Tests inject mocks;
//      production wires the real ones. This is what keeps `node --test`
//      fast (no indexer, no Electrum, no on-chain tx) and what makes
//      the bot safe to restart (state reads happen lazily inside
//      `tick()`, not at construction).
//
//   3. **One bad pool ≠ tick abort.** Per-candidate catches are
//      caught and logged; the loop continues with the remaining
//      candidates. The user might have 5 candidate pools; an
//      exception in one should not poison the other 4.
//
//   4. **Every async op is timeout-bounded.** The fetcher, swap,
//      and wallet all carry their own `timeoutMs`. The loop never
//      awaits an unbounded future.
//
//   5. **State writes are atomic.** `positions` writes through
//      `atomicWriteJson`; `snapshots` and `history` through
//      `atomicAppendNdjson`. The bot is killable at any moment;
//      see `src/util/atomic-write.mjs`.
//
//   6. **Audit events on every state change.** Every entry/exit
//      attempts `history.append(...)` regardless of outcome (success,
//      rejected, failed). The dashboard's history view reads this.
//
//   7. **No `console.log`.** All logs go through the structured
//      logger; `process.stderr` is the default sink.
//
// Origin: original code for TradeBot. Mirrors docs/ARCHITECTURE.md
// §4.1 (sequence diagram for the poll cycle).

import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

import { rankPools } from '../strategy/ranker.mjs';
import { buildStatsRecord } from '../data/fetcher.mjs';
import { shouldEnter } from '../strategy/entry.mjs';
import { shouldExit, evaluateProfitFloor } from '../strategy/exit.mjs';
// T57-3: DEX-routing layer. When multiple adapters are wired into
// the loop (cauldron + cauldron_safe_mode + guanaco, etc.), the
// loop picks the best per (token, side, size) before calling
// `swap.execute({ dexAdapter })`. Single-adapter mode keeps the
// legacy fast-path so existing call sites (run-bot.mjs without
// `bootDexAdapters`) pay zero overhead.
import { pickBestAdapter } from './dex-router.mjs';
import { canOpen } from '../risk/limits.mjs';
import { computeOpenExposureBch } from '../portfolio/positions.mjs';
import { realizedPnlSats } from '../portfolio/pnl.mjs';
import {
  atomicAppendNdjson,
  ensureDirForFile,
} from '../util/atomic-write.mjs';
import { createLogger } from '../util/logger.mjs';
import { SATS_PER_BCH } from '../data/types.mjs';
import { baseRateToDisplayRate, displayRateToBaseRate } from './rate-units.mjs';
// T59-2: orphan-position alert auto-wire. The pure diff lives in
// `src/reconcile/positions-vs-chain.mjs`; the dispatch wrapper
// (`src/alerts/orphan-position.mjs`) routes high-severity findings
// through the same T53.2 alert seams the rest of the loop uses
// (channel router + NDJSON appender). Both modules are pure / DI;
// we only consume their public surfaces here.
import { diffPositionsVsChain } from '../reconcile/positions-vs-chain.mjs';
import { dispatchOrphanAlerts } from '../alerts/orphan-position.mjs';
// T62: orphan auto-reconcile. The pure helper + I/O wrapper live in
// `src/reconcile/orphan-auto-close.mjs`. The loop wires
// `_maybeAutoReconcileOrphans(...)` as new step 9.5 (after the
// orphan-position alert check + before the adaptive-weights
// self-tune). Default OFF (`alerts.orphan_auto_reconcile_enabled:false`)
// + min-age gate (`alerts.orphan_auto_reconcile_min_age_minutes`,
// default 60) so a UTXO-scan race can't close a freshly-detected
// orphan. The synthetic close uses the SAME `Positions.close()`
// API the rest of the loop uses — no special manual path.
import {
  ageGateMsFromMinutes,
  pickOrphanAutoCloseableFindings,
  buildOrphanAutoClosePlan,
  executeOrphanAutoClose,
  buildOrphanAutoCloseAuditRecord,
} from '../reconcile/orphan-auto-close.mjs';
// T87: dust-position auto-close. The pure helper
// (`src/positions/dust-close.mjs`) defines the cost-ratio math
// + the operator-override guards. The loop's
// `_maybeAutoCloseDustPositions(...)` end-of-tick method (step
// 9.6, between T62 orphan-reconcile and T56-2 adaptive-weights)
// runs the helper against every open position when the operator
// has opted in via `risk.dust_position_auto_close_enabled:true`.
// Every close routes through `Positions.close()` (the same API the
// rest of the bot uses) so the dashboard / P&L rollups see the
// synthetic close immediately.
import {
  resolveDustConfig,
  findDustPositions,
  buildDustCloseExitBlock,
  DUST_CLOSE_REASON,
} from '../positions/dust-close.mjs';
// T58 subset 3: BadgerCoin Staking auto-wire. The pure
// dispatch wrapper (`src/staking/stake-alert-dispatch.mjs`) and
// the lock + unlock orchestrators
// (`src/staking/badger-stake-tx.mjs`) are wired into the loop's
// end-of-tick dispatch point (step 11, after the orphan-position
// check + the adaptive-weights self-tune). The pure helper
// `countLockNfts` / `findLockNftUtxo` from `src/staking/badger-stake.mjs`
// tells the auto-wire whether the wallet is already locked +
// which UTXO to unlock. All five entry points are DI-friendly so
// the loop's test suite exercises every code path with injected
// seams (no real chain calls).
import { executeLock, executeUnlock } from '../staking/badger-stake-tx.mjs';
import { dispatchStakeAlert } from '../staking/stake-alert-dispatch.mjs';
import {
  appendStakeAttempt,
  buildStakeAttemptEvent,
} from '../staking/stake-attempt-log.mjs';
import {
  countLockNfts,
  findLockNftUtxo,
  decodeLockNftCommitment,
  decodeCommitmentAuto,
  getCapability,
  getCommitment,
  getTokenId,
  CAPABILITY_MUTABLE,
  MASTER_CAT,
  StakingParamError,
} from '../staking/badger-stake.mjs';
// T56-2: adaptive scoring-weights auto-wire. The loop hot-reads
// the `scoring.adaptive_weights_enabled` knob at the end of every
// tick (after the orphan-position check) and, when enabled, runs
// `runAdaptiveWeightsSuggestion(...)` against `data/history.jsonl`,
// calls `applyAdaptiveWeightsToUserJson(...)` on the live
// `config/user.json` shape (deep-merge — WIF/mnemonic untouched),
// and appends an NDJSON audit record to
// `data/adaptive-weights.jsonl` whenever the engine reports a
// real shift. Both helpers are pure + DI-friendly; the loop's
// test suite exercises every code path with injected seams.
import {
  runAdaptiveWeightsSuggestion,
  applyAdaptiveWeightsToUserJson,
  buildAdaptiveWeightsAuditRecord,
} from '../strategy/adaptive-weights.mjs';
// T60: pre-trade UTXO fragmentation detection. The pure helper in
// `src/wallet/utxo-consolidation.mjs` classifies the wallet's live
// UTXO set against a candidate trade size; when the largest
// above-dust UTXO can't cover `entry.max_position_bch` + fee AND
// the total balance can, the loop skips the entry with
// `kind:'utxo_fragmented'` so the operator can see the gap in
// REASONING + history. Auto-consolidation is deferred to T60-2;
// subset 1 only DETECTS + logs.
import { analyzeUtxoFragmentation } from '../wallet/utxo-consolidation.mjs';
// T70: pre-trade UTXO fragmentation auto-consolidation (subset 2
// of T69 / deferred from commit 53609b1). The exportable
// orchestrator `executeConsolidationTx` from
// `scripts/consolidate-utxos.mjs` builds + signs + broadcasts a
// P2PKH consolidation tx; the loop wires it into the entry path
// so a fragmented wallet (one where no single above-dust UTXO +
// fee can fund the candidate trade) can SELF-HEAL when the
// operator opts in via `risk.utxo_consolidation_auto_enabled`.
// Default OFF — the operator flips the knob after a fresh
// `scripts/consolidate-utxos.mjs --dry-run` confirms the wallet
// looks sane. The loop also takes a `consolidationBroadcast` test
// seam (the wallet's existing Electrum provider's
// `sendRawTransaction`) and a `consolidationWif` test seam (the
// resolved WIF string) so the loop NEVER reaches into private
// wallet fields. See knob-catalog.mjs#risk.utxo_consolidation_auto_enabled.
import { executeConsolidationTx } from '../../scripts/consolidate-utxos.mjs';
// T76 subset 2b: live holders-based rug-pattern eligibility gate.
// The pure predicate lives in
// `src/strategy/holder-concentration.mjs#isRugPatternByHolders` and the
// cache + scanner orchestrator lives in
// `src/strategy/holder-scanner-cache.mjs#resolveHoldersSnapshot`. The
// loop wires the eligibility gate as a new step 9.5: for every
// candidate that survives `_excludedTokenSet()` +
// `applyEligibilityGates()`, the loop calls `resolveHoldersSnapshot`
// against the per-server TTL cache + the TokenStork upstream, runs the
// rug-pattern predicate via `extractRugPatternAuditFromResolver`, and
// emits `entry_skipped` with `kind:'rug_pattern_detected'` on a hit.
// Default OFF (the existing `scoring.concentration_rug_enabled` knob
// is shared with the dashboard's subset 2a endpoint) so the operator
// can audit the upstream before opting in.
import {
  isRugPatternByHolders as _isRugPatternByHolders,
  extractRugPatternAuditFromResolver,
} from '../strategy/holder-concentration.mjs';
import { resolveHoldersSnapshot } from '../strategy/holder-scanner-cache.mjs';

// ─────────────────────────────────────────────────────────────────────
//  Errors
// ─────────────────────────────────────────────────────────────────────

/**
 * Base class for every error `loop.mjs` raises. Callers should match
 * on `instanceof LoopError` to distinguish loop-side failures from
 * local bugs (TypeError on bad input, etc.).
 */
export class LoopError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'LoopError';
    if (opts.kind) this.kind = opts.kind;
    if (opts.cause) this.cause = opts.cause;
  }
}

/** Config / wiring problem (programmer error — fail fast). */
export class LoopConfigError extends LoopError {
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = 'LoopConfigError';
  }
}

/** Raised on lifecycle calls (`start`/`stop`) when out-of-state. */
export class LoopLifecycleError extends LoopError {
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = 'LoopLifecycleError';
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Defaults + shape
// ─────────────────────────────────────────────────────────────────────

/**
 * Defaults that mirror `config/default.json` → `loop` for the
 * `small_balance_startup` preset. The real config always wins when
 * present; these only fire on missing/garbage input (programmer
 * bug). Tests reference these values so the literal numbers in
 * `src/trader/loop.mjs` stay at zero.
 */
export const DEFAULT_LOOP_CONFIG = Object.freeze({
  poll_interval_seconds: 60,
  snapshot_interval_seconds: 300,
  history_retention_days: 365,
});

/** Default on-disk path for the append-only history NDJSON. */
export const DEFAULT_HISTORY_FILE = 'data/history.jsonl';

/** Default on-disk path for the append-only adaptive-weights audit NDJSON (T56-2). */
export const DEFAULT_ADAPTIVE_WEIGHTS_LOG_FILE = 'data/adaptive-weights.jsonl';

/** Default on-disk path for the user config JSON (T56-2 reads + writes here on adaptive-weights apply). */
export const DEFAULT_USER_CONFIG_FILE = 'config/user.json';

/**
 * Coerce an input to a valid `LoopConfig`. Same pattern as
 * `resolveEntryConfig` / `resolveExitConfig` — missing / bad values
 * fall back to defaults.
 *
 * @param {Object|undefined|null} input
 * @returns {{
 *   poll_interval_seconds: number,
 *   snapshot_interval_seconds: number,
 *   history_retention_days: number,
 * }}
 */
export function resolveLoopConfig(input) {
  const base = DEFAULT_LOOP_CONFIG;
  if (!input || typeof input !== 'object') return { ...base };
  /** @type {ReturnType<typeof resolveLoopConfig>} */
  const out = { ...base };
  const num = (k) => {
    const v = input[k];
    if (v === undefined || v === null) return;
    const n = Number(v);
    if (Number.isFinite(n)) out[k] = n;
  };
  num('poll_interval_seconds');
  num('snapshot_interval_seconds');
  num('history_retention_days');
  for (const k of Object.keys(out)) {
    if (!Number.isFinite(out[k]) || out[k] <= 0) out[k] = base[k];
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
//  Pure helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Build the per-tick budget (ms) the loop should wait for one
 * `tick()` to complete. Defaults to 90% of the poll interval so a
 * slow tick leaves a small idle window before the next poll. Pure.
 *
 * @param {number} pollIntervalSeconds
 * @param {number} [ratio=0.9]
 * @returns {number}
 */
export function tickBudgetMs(pollIntervalSeconds, ratio = 0.9) {
  if (!Number.isFinite(pollIntervalSeconds) || pollIntervalSeconds <= 0) return 1000;
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1) ratio = 0.9;
  const computed = Math.round(pollIntervalSeconds * 1000 * ratio);
  // Floor at 100ms so tiny poll intervals (≤ 1s) don't generate
  // negative or sub-tick budgets. Tests pin this contract.
  return Math.max(100, computed);
}

/**
 * Index `statsList` by lowercase `token_id` for O(1) per-position
 * market lookup. Pure — exported for tests.
 *
 * @param {Array<{ token_id: string }>} statsList
 * @returns {Map<string, Object>}
 */
export function indexStatsByTokenId(statsList) {
  /** @type {Map<string, Object>} */
  const out = new Map();
  if (!Array.isArray(statsList)) return out;
  for (const s of statsList) {
    if (s && typeof s === 'object' && typeof s.token_id === 'string') {
      out.set(s.token_id.toLowerCase(), s);
    }
  }
  return out;
}

/**
 * Sum the BCH-denominated fees on a swap result. The result has
 * `lpFeeSats` (the LP fee) + `estNetworkFeeSats` (cashscript's
 * pre-broadcast estimate); both are non-negative bigint. Returns a
 * non-negative integer in sats. Pure.
 *
 * @param {{ lpFeeSats?: bigint, estNetworkFeeSats?: bigint }} swapResult
 * @returns {number}
 */
export function totalSwapFeeSats(swapResult) {
  if (!swapResult || typeof swapResult !== 'object') return 0;
  const lp = swapResult.lpFeeSats;
  const net = swapResult.estNetworkFeeSats;
  const lpN = typeof lp === 'bigint' ? lp : 0n;
  const netN = typeof net === 'bigint' ? net : 0n;
  return Number(lpN + netN);
}

/**
 * Build the `portfolioState` object `shouldEnter()` consumes. Pure.
 * Aggregates `walletBalanceBch` (from `getBalanceSats()`) and
 * `openExposureBch` (from `positions.list('open')`).
 *
 * @param {Object} args
 * @param {bigint} args.walletBalanceSats
 * @param {Array<Object>} args.openPositions   status === 'open' (strict)
 * @param {Array<Object>} [args.pendingPositions]
 * @param {Array<Object>} [args.closingPositions]
 * @param {string} [args.nowIso]
 * @returns {{
 *   openPositions: Array<Object>,
 *   pendingPositions: Array<Object>,
 *   closingPositions: Array<Object>,
 *   openExposureBch: number,
 *   walletBalanceBch: number,
 *   nowIso: string,
 * }}
 */
export function buildPortfolioState({
  walletBalanceSats,
  openPositions,
  pendingPositions = [],
  closingPositions = [],
  nowIso,
  heldSeriesByTokenId,
}) {
  // Filter the inputs down to truly-open positions (status === 'open').
  // Callers may hand us a mixed bucket (the loop reads `positions.list('open')`
  // but tests pass arbitrary arrays); the state object only carries open rows.
  const openOnly = (Array.isArray(openPositions) ? openPositions : []).filter(
    (p) => p && typeof p === 'object' && p.status === 'open'
  );
  const pendingOnly = (Array.isArray(pendingPositions) ? pendingPositions : []).filter(
    (p) => p && typeof p === 'object' && p.status === 'pending'
  );
  const closingOnly = (Array.isArray(closingPositions) ? closingPositions : []).filter(
    (p) => p && typeof p === 'object' && p.status === 'closing'
  );
  const openExposureBch = computeOpenExposureBch(openOnly);
  // T36: held-token price-series map for correlation-aware entries.
  // The trading loop populates this from the cached fetcher before
  // the candidate loop runs, then `shouldEnter` reads it via
  // `portfolioState.heldSeriesByTokenId`. Map<lowercaseTokenId,
  // number[]> — missing entries are tolerated (the entry layer
  // treats a missing series as "skip the correlation guard").
  const held = (heldSeriesByTokenId
    && (typeof heldSeriesByTokenId.get === 'function'
      || typeof heldSeriesByTokenId === 'object'))
    ? heldSeriesByTokenId
    : new Map();
  return {
    openPositions: openOnly,
    pendingPositions: pendingOnly,
    closingPositions: closingOnly,
    openExposureBch,
    walletBalanceBch: Number(walletBalanceSats) / SATS_PER_BCH,
    nowIso: typeof nowIso === 'string' && nowIso.length > 0
      ? nowIso
      : new Date().toISOString(),
    heldSeriesByTokenId: held,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  history appender (atomic NDJSON)
// ─────────────────────────────────────────────────────────────────────

/**
 * Build the default history appender — atomic NDJSON writes via
 * `src/util/atomic-write.mjs`. Tests can replace this with a memory
 * array via `opts.historyAppend`.
 *
 * The `file` argument is REQUIRED — callers (production + tests) must
 * always pass an explicit path. A default would let a forgotten
 * argument silently leak to `data/history.jsonl` in production, or
 * pass a default-fallback test that masks wiring bugs.
 *
 * @param {Object} opts
 * @param {string} opts.file                   non-empty on-disk path
 * @param {typeof import('node:fs/promises')} [opts.fs]
 * @returns {(line: string) => Promise<void>}
 */
export function createHistoryAppender({ file, fs } = {}) {
  if (typeof file !== 'string' || file.length === 0) {
    throw new LoopConfigError(
      `createHistoryAppender: file must be a non-empty string; got ${JSON.stringify(file)}`,
    );
  }
  const fsImpl = fs ?? null; // null = default to atomicAppendNdjson's default
  return async (line) => {
    if (typeof line !== 'string' || line.length === 0) {
      throw new LoopConfigError(`historyAppend: expected a non-empty JSON string; got ${typeof line}`);
    }
    await ensureDirForFile(file, fsImpl ?? undefined);
    await atomicAppendNdjson(file, line, fsImpl ?? undefined);
  };
}

// ─────────────────────────────────────────────────────────────────────
//  TradingLoop class
// ─────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} TradingLoopOpts
 * @property {Object} cfg               merged default+user config
 * @property {Object} fetcher           a `Fetcher` (data/fetcher.mjs)
 * @property {Object} wallet            a `LibAuthBchWallet` (wallet/libauth.mjs) — must be init()'d
 * @property {Object} swap              a `SwapExecutor` (trader/swap.mjs)
 * @property {Object} positions         a `Positions` (portfolio/positions.mjs)
 * @property {Object} snapshots         a `Snapshots` (portfolio/snapshots.mjs)
 * @property {Object} breaker           a `CircuitBreaker` (risk/circuit-breaker.mjs)
 * @property {Function} [historyAppend] `(line: string) => Promise<void>` (default: NDJSON append)
 * @property {Object} [logger]          structured logger (default: stderr)
 * @property {Function} [clock]         `() => Date` (test seam; default: `() => new Date()`)
 * @property {Function} [scheduler]     `setTimeout` (test seam; default: global setTimeout)
 * @property {Function} [ranker]        `(statsList, cfg) => ranked` (default: `rankPools` from strategy/ranker.mjs)
 * @property {boolean}   [dryRun=false] when true, the loop NEVER broadcasts a swap, NEVER writes
 *                                       to the positions store, and NEVER touches the circuit
 *                                       breaker. Read-only mode wired from
 *                                       `node scripts/run-bot.mjs --dry-run`. History lines still
 *                                       fire — they carry a `dry_run:true` marker so the
 *                                       operator can filter them out.
 * @property {Function} [configReader] `(opts?) => Promise<{cfg: Object}>` — test seam / hot-reload
 *                                       seam. When provided, the SIGUSR1 handler (T43c-server)
 *                                       calls it instead of re-loading `config/default.json` from
 *                                       disk. Default = `null` (no hot-reload).
 * @property {Function} [signalHandler] `() => () => void` — test seam / SIGUSR1 installer. When
 *                                       provided, called once at `start()` time. The returned
 *                                       function is the uninstall hook. Default = `null` (no
 *                                       signal handling).
 * @property {Array<Object>} [dexAdapters]   T57-3: list of booted DEX adapters (output of
 *                                          `bootDexAdapters()`). When non-empty, the loop picks
 *                                          the best per (token, side, size) for each candidate
 *                                          and threads it into `swap.execute({ dexAdapter })`.
 *                                          When empty (the legacy single-DEX case), the loop
 *                                          uses `swap` as-is (no per-call override).
 *                                          Default = `[]`.
 * @property {Function} [pickBestAdapter]    T57-3 test seam: injected router for unit tests
 *                                          that want to bypass `src/trader/dex-router.mjs`.
 *                                          Default = the imported `pickBestAdapter`.
 * @property {Function} [safeAlertDispatch]  T53.2 test seam: dispatch event through channels.
 *                                          `(event: AlertEvent) => Promise<{ok, ...}>`. Default = null (no alerts).
 * @property {Function} [alertsAppend]       T53.2 test seam: append event to `data/alerts.jsonl`.
 *                                          `(event: AlertEvent) => Promise<{ok, ...}>`. Default = null.
 * @property {Function} [orphanPositionDispatch] T59-2 test seam: the end-of-tick orphan-position
 *                                          check dispatcher. Signature:
 *                                          `(opts: {router, appender, findings, nowMs, logger, positionIndex}) => Promise<{ok, dispatched, persisted, failed, errors, events}>`
 *                                          Default = the imported `dispatchOrphanAlerts`. Tests inject a stub
 *                                          to assert call shape + to simulate failures without touching the
 *                                          real alerts subsystem.
 * @property {Function} [orphanAutoCloseExecute] T62 test seam: the end-of-tick orphan auto-close
 *                                          executor. Signature:
 *                                          `(opts: {plan, positions, nowMs, logger}) => Promise<{ok, positionId, error}>`
 *                                          Default = the imported `executeOrphanAutoClose`. Tests inject a stub
 *                                          to assert call shape + to simulate per-position close failures
 *                                          without touching the real `Positions.close()` surface.
 * @property {Function} [stakingLockExecute]   T58 subset 3 test seam: the auto-lock orchestrator.
 *                                          Signature: `(opts: {cfg, wallet, provider, amountSats, stakeBlocks, logger, deps}) => Promise<{ok, txid, code, error, ...}>`
 *                                          Default = the imported `executeLock`. Tests inject a stub returning a
 *                                          hand-crafted `{ok:true, txid:...}` envelope so the auto-wire can be
 *                                          exercised without a real chain call.
 * @property {Function} [stakingUnlockExecute] T58 subset 3 test seam: the auto-unlock orchestrator.
 *                                          Signature: `(opts: {cfg, wallet, provider, lockUtxo, logger, deps}) => Promise<{ok, txid, code, error, ...}>`
 *                                          Default = the imported `executeUnlock`. Tests inject a stub returning
 *                                          a hand-crafted envelope.
 * @property {Function} [stakingDispatch]      T58 subset 3 test seam: the dispatch wrapper that turns
 *                                          executeLock/executeUnlock envelopes into AlertEvents.
 *                                          Signature: `(opts: {router, appender, results, nowMs, logger}) => Promise<{ok, dispatched, persisted, failed, errors, events}>`
 *                                          Default = the imported `dispatchStakeAlert`. Tests inject a stub.
 * @property {Object} [stakingProvider]       T58 subset 3 Electrum provider seam. `executeLock` /
 *                                          `executeUnlock` need a `{sendRawTransaction}` surface; the
 *                                          wallet already wraps one but the loop doesn't have direct
 *                                          access. Operators wire this from `scripts/run-bot.mjs`;
 *                                          tests inject a stub. Default `null` \u2014 when staking is
 *                                          enabled but the provider seam is absent, the auto-wire
 *                                          short-circuits to a warn and skips the dispatch.
 * @property {Function} [stakingGetBlockHeight] T58 subset 3 tip-height seam. The auto-unlock path needs
 *                                          `(currentTipHeight - lockUtxo.lockBlockHeight) >= stakeBlocks + grace`.
 *                                          Signature: `() => Promise<number>`. Default returns 0 (safe fallback:
 *                                          "never mature" \u2014 the auto-unlock path skips the dispatch).
 * @property {Function} [utxoConsolidationExecute] T70 test seam: the auto-consolidation orchestrator.
 *                                          Signature: `async ({inputs, outputAddress, feeSatPerByte, wif, network,
 *                                          broadcast, providerFactory, logger, nowMs}) => Promise<{ok, txid?,
 *                                          fee_sats, output_sats, total_in_sats, input_count, output_count,
 *                                          broadcast_ms, source, error?}>`. Default = the imported
 *                                          `executeConsolidationTx` from `scripts/consolidate-utxos.mjs`.
 *                                          Tests inject a stub returning a hand-crafted envelope so the loop's
 *                                          auto-wire path can be exercised without touching libauth / Electrum.
 * @property {Function} [utxoConsolidationBroadcast] T70 broadcast seam. `async ({hex, providerFactory}) => Promise<txid>`.
 *                                          Default = `null`. When `risk.utxo_consolidation_auto_enabled:true` but this seam
 *                                          is missing, the loop short-circuits with `kind:'utxo_consolidation_seam_missing'`
 *                                          so a partial operator wiring can't fire a half-built tx. Production wires
 *                                          `({hex}) => wallet._resolveDeps().then(({provider}) => provider.sendRawTransaction(hex))`
 *                                          in `scripts/run-bot.mjs`.
 * @property {string}   [utxoConsolidationWif] T70 WIF seam. The resolved WIF string for signing the consolidation tx.
 *                                          Default = `this.cfg.wallet?.wif ?? null`. When auto-consolidation is enabled
 *                                          but the seam is missing, the loop short-circuits with
 *                                          `kind:'utxo_consolidation_no_wif'`. Production wires the resolved WIF
 *                                          from `resolveWif(...)` in `scripts/run-bot.mjs`.
 */

/**
 * @typedef {Object} TickResult
 * @property {string} ts                 ISO start timestamp
 * @property {number} startedAtMs
 * @property {number} endedAtMs
 * @property {number} durationMs
 * @property {Array<Object>} candidates          what the ranker surfaced
 * @property {Array<Object>} entries             entry attempts (success + fail + reject)
 * @property {Array<Object>} exits               exit attempts (success + fail + skip)
 * @property {boolean} snapshotTaken
 * @property {boolean} breakerTripped
 * @property {string|null} breakerKind
 * @property {Array<Object>} errors              per-candidate errors (logged + captured)
 * @property {Object|null} fatalError            null on a clean tick; populated on a top-level failure
 */

/**
 * Stateful wrapper around the per-tick pipeline. Construction is
 * cheap (no I/O); the first `tick()` call (or `start()`) opens the
 * fetcher / wallet / swap / positions / snapshots / breaker.
 *
 * Lifecycle:
 *   - `tick()`    — run one tick, return a `TickResult`. Safe to call
 *                   repeatedly; never throws on per-candidate failures.
 *   - `start()`   — schedule `tick()` on a `setTimeout` chain every
 *                   `poll_interval_seconds`. Idempotent: calling twice
 *                   is a no-op.
 *   - `stop()`    — request the scheduled tick chain to exit after
 *                   the in-flight tick completes. Returns the last
 *                   `TickResult` if any.
 *   - `stats()`   — snapshot of internal counters (tick count, last
 *                   ts, last duration, breaker state).
 */
export class TradingLoop {
  /**
   * @param {TradingLoopOpts} opts
   */
  constructor(opts = {}) {
    if (opts === undefined || opts === null) {
      throw new LoopConfigError('TradingLoop: opts is required');
    }
    if (typeof opts !== 'object') {
      throw new LoopConfigError(`TradingLoop: opts must be an object; got ${typeof opts}`);
    }
    if (!opts.cfg || typeof opts.cfg !== 'object') {
      throw new LoopConfigError('TradingLoop: cfg is required');
    }
    if (!opts.fetcher) {
      throw new LoopConfigError('TradingLoop: fetcher is required');
    }
    if (!opts.wallet) {
      throw new LoopConfigError('TradingLoop: wallet is required');
    }
    if (!opts.swap) {
      throw new LoopConfigError('TradingLoop: swap is required');
    }
    if (!opts.positions) {
      throw new LoopConfigError('TradingLoop: positions is required');
    }
    if (!opts.snapshots) {
      throw new LoopConfigError('TradingLoop: snapshots is required');
    }
    if (!opts.breaker) {
      throw new LoopConfigError('TradingLoop: breaker is required');
    }
    if (opts.dryRun !== undefined && typeof opts.dryRun !== 'boolean') {
      throw new LoopConfigError(`TradingLoop: dryRun must be a boolean when provided; got ${typeof opts.dryRun}`);
    }

    this.cfg = opts.cfg;
    this.loopCfg = resolveLoopConfig(opts.cfg.loop);
    this.fetcher = opts.fetcher;
    this.wallet = opts.wallet;
    this.swap = opts.swap;
    this.positions = opts.positions;
    this.snapshots = opts.snapshots;
    this.breaker = opts.breaker;
    this.logger = opts.logger ?? createLogger({ sink: process.stderr, component: 'loop' });
    this.clock = (typeof opts.clock === 'function') ? opts.clock : (() => new Date());
    this.scheduler = opts.scheduler ?? globalThis.setTimeout;
    this.ranker = opts.ranker ?? rankPools;
    this.historyAppend = opts.historyAppend ?? createHistoryAppender({ file: DEFAULT_HISTORY_FILE });
    /**
     * T53.2: optional AlertRouter seam. When provided, the loop
     * dispatches events at the major decision points: entry
     * refused, exit refused, breaker tripped, AMM divergence,
     * wallet floor breach. Dispatch is fire-and-forget and NEVER
     * throws — a Telegram outage cannot kill a live bot. Default
     * = `null` (no alerts; legacy behavior).
     * @private
     */
    this._safeAlertDispatch = (typeof opts.safeAlertDispatch === 'function')
      ? opts.safeAlertDispatch
      : null;
    /**
     * T53.2: optional alerts NDJSON writer seam. Independent from
     * `_safeAlertDispatch` so operators can disable channel routing
     * without losing the audit trail. Default = `null`.
     * @private
     */
    this._alertsAppend = (typeof opts.alertsAppend === 'function')
      ? opts.alertsAppend
      : null;
    /** @private — when true, this loop is in read-only mode: no broadcast, no on-disk state writes,
     *              no breaker mutation. History events still fire with `dry_run:true`. */
    this.dryRun = opts.dryRun === true;
    /** @private — T43c-server: hot-reload seam. When set, the SIGUSR1 handler invokes it. */
    this._configReader = (typeof opts.configReader === 'function') ? opts.configReader : null;
    /** @private — T43c-server: SIGUSR1 uninstall hook. Set at start() time. */
    this._signalUninstall = null;
    // T57-3: DEX adapters wired into the loop. When empty (the
    // legacy single-DEX case), the loop uses `this.swap` as-is
    // (no per-call override). When non-empty, the loop calls
    // `_selectDexAdapter(tokenId, side, amountBase)` once per
    // candidate and threads the chosen adapter into
    // `swap.execute({ dexAdapter })`. Both shapes are tested.
    if (opts.dexAdapters !== undefined && opts.dexAdapters !== null) {
      if (!Array.isArray(opts.dexAdapters)) {
        throw new LoopConfigError(`TradingLoop: dexAdapters must be an array when provided; got ${typeof opts.dexAdapters}`);
      }
      this.dexAdapters = Object.freeze([...opts.dexAdapters]);
    } else {
      this.dexAdapters = Object.freeze([]);
    }
    /** @private — T57-3 test seam: injected `pickBestAdapter` for
     *              unit tests that want to bypass the real router.
     *              Defaults to the imported `pickBestAdapter`. */
    this._pickBestAdapter = (typeof opts.pickBestAdapter === 'function')
      ? opts.pickBestAdapter
      : pickBestAdapter;
    /**
     * T59-2: end-of-tick orphan-position check dispatcher. Defaults
     * to the imported `dispatchOrphanAlerts`. Tests can inject a
     * stub to lock the call shape without going through the real
     * alerts subsystem. The dispatcher is invoked with the
     * existing T53.2 seams (`safeAlertDispatch` + `alertsAppend`)
     * so an injected stub can be observed in lockstep with the
     * other dispatch points.
     * @private
     */
    this._orphanPositionDispatch = (typeof opts.orphanPositionDispatch === 'function')
      ? opts.orphanPositionDispatch
      : dispatchOrphanAlerts;
    /**
     * T62: end-of-tick orphan auto-close executor. Defaults to the
     * imported `executeOrphanAutoClose`. Tests can inject a stub
     * to lock the call shape + to simulate per-position close
     * failures without going through the real `Positions.close()`
     * surface. The seam is invoked with the existing
     * `this.positions` instance so the stub can either call
     * through (default path) or short-circuit with an envelope of
     * its own (test path).
     * @private
     */
    this._orphanAutoCloseExecute = (typeof opts.orphanAutoCloseExecute === 'function')
      ? opts.orphanAutoCloseExecute
      : executeOrphanAutoClose;
    /**
     * T56-2: optional seam for the adaptive-weights suggestion
     * engine. When the trader loop's per-tick self-tune fires
     * (after step 9 orphan check), it calls this seam to compute
     * a `suggestAdaptiveWeights` envelope from the loaded history.
     * Defaults to the imported `runAdaptiveWeightsSuggestion` so
     * the loop reads `data/history.jsonl` in production; tests
     * inject a stub that returns a hand-crafted envelope so the
     * apply path + audit-write path can be exercised without
     * touching disk.
     * @private
     */
    this._adaptiveWeightsSuggest = (typeof opts.adaptiveWeightsSuggest === 'function')
      ? opts.adaptiveWeightsSuggest
      : runAdaptiveWeightsSuggestion;
    /**
     * T56-2: optional seam for the pure apply helper. The loop
     * calls this with the parsed `user.json` shape + the engine
     * suggestion; the helper returns the next shape (deep-merge)
     * + `mutated` / `reason` flags. Defaults to the imported
     * `applyAdaptiveWeightsToUserJson`; tests inject a stub when
     * they want to verify the WIF-preservation contract without
     * going through the real deep-merge.
     * @private
     */
    this._adaptiveWeightsApply = (typeof opts.adaptiveWeightsApply === 'function')
      ? opts.adaptiveWeightsApply
      : applyAdaptiveWeightsToUserJson;
    /**
     * T56-2: optional seam for the audit-record builder. Defaults
     * to the imported `buildAdaptiveWeightsAuditRecord`; tests
     * can inject to capture / observe the shape without going
     * through the NDJSON writer.
     * @private
     */
    this._adaptiveWeightsAuditBuilder = (typeof opts.adaptiveWeightsAuditBuilder === 'function')
      ? opts.adaptiveWeightsAuditBuilder
      : buildAdaptiveWeightsAuditRecord;
    /**
     * T56-2: on-disk paths for the auto-wire. The loop reads
     * `userJsonPath` (default `config/user.json`) and writes the
     * audit NDJSON to `auditLogPath` (default
     * `data/adaptive-weights.jsonl`). Both are configurable so
     * tests can point at fixtures without disturbing the real
     * config. The loop NEVER reads `user.json` via
     * `loadConfig()` — it parses the file directly so the
     * apply path stays decoupled from the config loader.
     * @private
     */
    this._userJsonPath = (typeof opts.userJsonPath === 'string' && opts.userJsonPath.length > 0)
      ? opts.userJsonPath
      : DEFAULT_USER_CONFIG_FILE;
    this._adaptiveWeightsLogPath = (typeof opts.adaptiveWeightsLogPath === 'string'
      && opts.adaptiveWeightsLogPath.length > 0)
      ? opts.adaptiveWeightsLogPath
      : DEFAULT_ADAPTIVE_WEIGHTS_LOG_FILE;
    /**
     * T56-2: optional seam for the history-loader. Defaults to
     * a thin wrapper that reads `userJsonPath`-adjacent history
     * (`data/history.jsonl`); tests inject a stub returning a
     * hand-crafted lines array so the engine can be exercised
     * without disk I/O. The seam signature is `async () => string[]`.
     * @private
     */
    this._adaptiveWeightsLoadHistory = (typeof opts.adaptiveWeightsLoadHistory === 'function')
      ? opts.adaptiveWeightsLoadHistory
      : null; // populated lazily by _maybeApplyAdaptiveWeights
    /**
     * T56-2: optional seam for the user.json loader. Defaults to
     * a thin wrapper that reads `this._userJsonPath`; tests inject
     * a stub returning a hand-crafted object. The seam signature
     * is `async () => { exists: boolean, data: Object }`. Returning
     * `exists:false` is the legitimate case where the operator
     * has not yet created `config/user.json` — the loop writes
     * a fresh file from the suggestion (deep-merged with `{}`).
     * @private
     */
    this._adaptiveWeightsLoadUserJson = (typeof opts.adaptiveWeightsLoadUserJson === 'function')
      ? opts.adaptiveWeightsLoadUserJson
      : null; // populated lazily by _maybeApplyAdaptiveWeights
    /**
     * T56-2: optional seam for the audit-NDJSON writer. Defaults
     * to `atomicAppendNdjson` against `this._adaptiveWeightsLogPath`;
     * tests inject a stub that captures the line for shape checks.
     * @private
     */
    this._adaptiveWeightsAuditAppend = (typeof opts.adaptiveWeightsAuditAppend === 'function')
      ? opts.adaptiveWeightsAuditAppend
      : null; // populated lazily by _maybeApplyAdaptiveWeights
    /**
     * T56-2: optional seam for the user.json writer. Defaults to
     * `atomicWriteJson` against `this._userJsonPath`; tests inject
     * a stub that captures the next-shape for round-trip checks.
     * @private
     */
    this._adaptiveWeightsWriteUserJson = (typeof opts.adaptiveWeightsWriteUserJson === 'function')
      ? opts.adaptiveWeightsWriteUserJson
      : null; // populated lazily by _maybeApplyAdaptiveWeights

    /**
     * T58 subset 3: end-of-tick staking auto-wire seams. The loop
     * hot-reads `cfg.staking` every tick; when the master switch
     * (`enabled` + `simulation_only`) AND the per-path sub-mode
     * (`auto_lock_enabled` / `auto_unlock_enabled`) are flipped
     * on, the loop calls the corresponding orchestrator at step 11
     * of `_runTick` (after the orphan-position check + the
     * adaptive-weights self-tune). Every seam is DI-friendly so
     * the loop's test suite exercises every code path with
     * injected stubs \u2014 no real chain calls in the test path.
     * @private
     */
    this._stakingLockExecute = (typeof opts.stakingLockExecute === 'function')
      ? opts.stakingLockExecute
      : executeLock;
    this._stakingUnlockExecute = (typeof opts.stakingUnlockExecute === 'function')
      ? opts.stakingUnlockExecute
      : executeUnlock;
    this._stakingDispatch = (typeof opts.stakingDispatch === 'function')
      ? opts.stakingDispatch
      : dispatchStakeAlert;
    /**
     * T58 subset 3: Electrum provider seam. `executeLock` /
     * `executeUnlock` need a `{sendRawTransaction}` surface; the
     * wallet already wraps one internally, but the loop doesn't
     * have direct access. Operators wire this from the run-bot
     * entry point (`scripts/run-bot.mjs`); tests inject a stub.
     * Default `null` is fine \u2014 when staking is enabled but the
     * provider seam is absent, the auto-wire short-circuits to a
     * warn (and skips the dispatch) so a stale config can never
     * crash the tick.
     * @private
     */
    this._stakingProvider = (typeof opts.stakingProvider === 'object' && opts.stakingProvider !== null)
      ? opts.stakingProvider
      : null;
    /**
     * T58 subset 3: tip-height seam. The auto-unlock path needs
     * `(currentTipHeight - lockUtxo.lockBlockHeight) >=
     * lockUtxo.stakeBlocks + graceBlocks` to decide whether a
     * lockNFT is mature enough to unlock. The wallet caches its
     * last tip on every `getBalanceSats()` call, but doesn't
     * expose a public getter yet; operators wire this seam from
     * the run-bot entry point; tests inject a stub returning a
     * deterministic height. Default returns `Promise.resolve(0)`
     * which is the safe fallback ("never mature" \u2014 the
     * auto-unlock path skips the dispatch and the audit trail
     * shows why).
     * @private
     */
    this._stakingGetBlockHeight = (typeof opts.stakingGetBlockHeight === 'function')
      ? opts.stakingGetBlockHeight
      : (async () => 0);
    /**
     * T75 (BadgerCoin staking live wire) — explicit WIF seam. The
     * libauth wallet (`LibAuthBchWallet`) keeps its WIF in a
     * private `_wif` field; the safety test in
     * `tests/wallet-libauth.test.mjs` forbids a public `getWif()`
     * method. So executeLock needs the WIF plumbed in via the
     * `deps.wif` argument. This seam lets the boot path
     * (`scripts/run-bot.mjs`) resolve the WIF once (via
     * `resolveWif(...)`) and inject it. `null` default means the
     * auto-wire can still call executeLock but it will short-circuit
     * with `code:'WIF_MISSING'` if the boot path didn't wire it —
     * which is the right loud failure for a missing seam.
     *
     * @private
     * @type {string|null}
     */
    this._stakingWif = (typeof opts.stakingWif === 'string' && opts.stakingWif.length > 0)
      ? opts.stakingWif
      : null;
    /**
     * T70: auto-consolidation orchestrator seam. Defaults to the
     * imported `executeConsolidationTx` from `scripts/consolidate-utxos.mjs`.
     * Tests inject a stub returning a hand-crafted envelope so the
     * loop's auto-wire path can be exercised without touching libauth
     * or Electrum. Production callers may also inject a wrapper that
     * injects the resolved WIF + a real broadcast callback.
     * @private
     */
    this._utxoConsolidationExecute = (typeof opts.utxoConsolidationExecute === 'function')
      ? opts.utxoConsolidationExecute
      : executeConsolidationTx;
    /**
     * T70: broadcast seam for the auto-consolidation tx.
     * `async ({hex, providerFactory}) => Promise<txid>`. Default
     * `null` — when `risk.utxo_consolidation_auto_enabled:true` but
     * this seam is missing, the loop short-circuits with
     * `kind:'utxo_consolidation_seam_missing'` so a partial operator
     * wiring can never fire a half-built tx. Production wires
     * `({hex}) => wallet._resolveDeps().then(({provider}) => provider.sendRawTransaction(hex))`
     * in `scripts/run-bot.mjs`.
     * @private
     */
    this._utxoConsolidationBroadcast = (typeof opts.utxoConsolidationBroadcast === 'function')
      ? opts.utxoConsolidationBroadcast
      : null;
    /**
     * T70: resolved WIF for signing the consolidation tx. Default
     * `this.cfg?.wallet?.wif ?? null` — when the config has no
     * embedded WIF the loop falls back to the seam-or-missing
     * path. Production overrides the seam in `scripts/run-bot.mjs`
     * with the value from `resolveWif(...)` so the loop NEVER
     * reaches into the wallet's private fields.
     * @private
     */
    this._utxoConsolidationWif = (typeof opts.utxoConsolidationWif === 'string' && opts.utxoConsolidationWif.length >= 40)
      ? opts.utxoConsolidationWif
      : (() => {
        const cfgW = (this.cfg && typeof this.cfg === 'object' && this.cfg.wallet && typeof this.cfg.wallet === 'object')
          ? this.cfg.wallet.wif
          : null;
        return (typeof cfgW === 'string' && cfgW.length >= 40) ? cfgW : null;
      })();
    /**
     * T70: per-tick guard so we don't consolidate more than once
     * even if multiple candidates hit the fragmentation gate in
     * the same tick. Reset at the top of `_runTick()`.
     * @private
     */
    this._utxoConsolidationFiredThisTick = false;

    // ─── T76 subset 2b: Live holders-based rug-pattern gate ───
    /**
     * Per-server holders scanner cache. Mirrors the dashboard's
     * `holdersScannerCache` ctx wiring (subset 2a): one
     * `HoldersScannerCache` instance shared across the bot's
     * entry pipeline so repeat candidates within the cacheMs
     * window don't re-fetch the upstream. Default `null` —
     * when the operator has not wired a cache AND the
     * `scoring.concentration_rug_enabled` knob is ON, the loop
     * short-circuits the live check with
     * `kind:'rug_pattern_check_unwired'` (subset 1 fallback
     * behavior preserved). When the knob is OFF, the cache
     * seam is unused.
     * @private
     */
    this._holdersScannerCache = (opts.holdersScannerCache !== null
        && opts.holdersScannerCache !== undefined
        && typeof opts.holdersScannerCache.get === 'function'
        && typeof opts.holdersScannerCache.set === 'function')
      ? opts.holdersScannerCache
      : null;
    /**
     * Injectable fetcher seam for the holders scanner. Mirrors the
     * dashboard's `ctx.fetcher` (subset 2a); production wires
     * `globalThis.fetch` (the default); tests inject a stub.
     * @private
     */
    this._holdersScannerFetcher = (typeof opts.holdersScannerFetcher === 'function')
      ? opts.holdersScannerFetcher
      : null;
    /**
     * Override for the upstream base URL. Default `null` →
     * `resolveHoldersSnapshot` falls back to the
     * `DEFAULT_HOLDERS_SCANNER_BASE_URL` shipped in
     * `holder-scanner.mjs`. Production wires this from
     * `cfg.scoring.concentration_rug_provider_url` so an operator
     * flipping the knob hot-reloads to a corp-proxy mirror without
     * a process restart.
     * @private
     */
    this._holdersScannerProviderUrl = (typeof opts.holdersScannerProviderUrl === 'string'
        && opts.holdersScannerProviderUrl.length > 0)
      ? opts.holdersScannerProviderUrl
      : null;
    /**
     * Override for the upstream per-request timeout (ms). Default
     * `null` → `resolveHoldersSnapshot` falls back to
     * `DEFAULT_HOLDERS_SCANNER_TIMEOUT_MS` (5000). Production
     * wires this from `cfg.scoring.concentration_rug_timeout_ms`.
     * @private
     */
    this._holdersScannerTimeoutMs = (typeof opts.holdersScannerTimeoutMs === 'number'
        && Number.isFinite(opts.holdersScannerTimeoutMs))
      ? opts.holdersScannerTimeoutMs
      : null;
    /**
     * Per-tick metrics so the operator can see how often the live
     * rug-pattern gate fires (or refuses) without grepping
     * `data/history.jsonl`. Reset at the top of `_runTick()`
     * alongside `_utxoConsolidationFiredThisTick`.
     * @private
     */
    this._rugPatternCheckThisTick = {
      enabled: false,
      candidate_count: 0,
      checked_count: 0,
      cache_hit_count: 0,
      detected_count: 0,
      error_count: 0,
      token_not_found_count: 0,
      skipped_unwired_count: 0,
    };

    /** @private — lifecycle flags. */
    this._running = false;
    this._stopRequested = false;
    /** @private — metrics. */
    this._tickCount = 0;
    // T78 subset 1 — cumulative counters surfaced via `stats()` so
    // the `/metrics` endpoint can expose them as Prometheus counters.
    // Mirrors the `entry_attempts` / `exit_attempts` / per-stage
    // `errors[]` we already log to `data/history.jsonl` per tick,
    // but at a process-lifetime granularity so a scraper can compute
    // rates (entries/sec) without grepping the NDJSON.
    this._entryAttemptCount = 0;
    this._exitAttemptCount = 0;
    this._errorCount = 0;
    this._lastTickAtMs = 0;
    this._lastTickDurationMs = 0;
    this._lastTickResult = null;
    this._lastError = null;
    // T80 — rolling ring buffer of the last N tick durations
    // (default 1024) so the Prometheus `/metrics` endpoint can
    // emit a real `histogram` with `_bucket{le=...}` lines from
    // `loop.stats()` instead of re-reading `data/history.jsonl`
    // on every scrape. The ring is a fixed-size Float64Array
    // with a monotonically-increasing write index that wraps;
    // `stats()` exports a plain sorted JS array on demand so
    // the metrics module never has to know about ring-buffer
    // internals.
    this._tickDurationRing = new Float64Array(1024);
    this._tickDurationRingWriteIdx = 0;
    this._tickDurationRingCount = 0;
  }

  /**
   * Snapshot of internal counters. Useful for the dashboard's
   * "loop health" panel.
   */
  stats() {
    return {
      running: this._running,
      stopRequested: this._stopRequested,
      tick_count: this._tickCount,
      last_tick_at_ms: this._lastTickAtMs,
      last_tick_duration_ms: this._lastTickDurationMs,
      // T78 subset 1 — cumulative counters surfaced for the
      // `/metrics` Prometheus endpoint. Counts the same shape as
      // `result.entries.length` / `result.exits.length` /
      // `result.errors.length` does per-tick (already logged to
      // `data/history.jsonl`) but aggregated at process lifetime.
      entry_attempt_count: this._entryAttemptCount,
      exit_attempt_count: this._exitAttemptCount,
      error_count: this._errorCount,
      last_error: this._lastError,
      loop_config: { ...this.loopCfg },
      // T80 — rolling ring buffer of the last 1024 tick durations,
      // exported as a sorted plain-JS array so the metrics module
      // can bucket it into a Prometheus histogram with
      // `_bucket{le=...}` lines. Exposed as a sorted array (NOT a
      // Float64Array) so callers don't have to know about the
      // ring-buffer internals. Empty when the loop has not yet
      // ticked.
      tick_duration_ring: this._exportTickDurationRing(),
      // T80 — current per-axis scoring weight the loop will use on
      // the next tick. Sourced from `cfg.scoring.weights` (or the
      // user-supplied `user.json` overlay) — the same value the
      // ranker reads. Updated on every `_adaptiveWeightsApply` call
      // so a hot-reload or a successful adaptive-weights shift
      // surfaces on the next scrape.
      adaptive_weights_state: this._exportAdaptiveWeightsState(),
      // T76 subset 2b: per-tick rug-pattern gate metrics + cache
      // stats. Mirrors `loop.utxo_consolidation` stats so the
      // dashboard's `/healthz` tile can render the same shape for
      // both gates without branching.
      rug_pattern_gate: {
        last_tick: { ...(this._rugPatternCheckThisTick || {}) },
        cache: (this._holdersScannerCache && typeof this._holdersScannerCache.stats === 'function')
          ? this._holdersScannerCache.stats()
          : null,
      },
    };
  }

  /**
   * @private — push a single tick-duration observation into the
   * rolling ring buffer. Fixed-size Float64Array of `1024`
   * slots; writes wrap via `_tickDurationRingWriteIdx % 1024`.
   * A non-finite or negative value is clamped to 0 so a clock
   * drift can never poison the histogram. NEVER throws.
   *
   * @param {number} ms
   */
  _pushTickDuration(ms) {
    if (!this._tickDurationRing || typeof this._tickDurationRing.length !== 'number') return;
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return;
    const clamped = Math.max(0, Math.floor(ms));
    const cap = this._tickDurationRing.length;
    const idx = (this._tickDurationRingWriteIdx | 0) % cap;
    this._tickDurationRing[idx] = clamped;
    this._tickDurationRingWriteIdx = (idx + 1) | 0;
    if (this._tickDurationRingCount < cap) this._tickDurationRingCount += 1;
  }

  /**
   * @private — export the rolling ring buffer as a sorted
   * plain-JS array. Defensive: returns `[]` when the ring isn't
   * initialized (e.g. the loop was constructed without going
   * through `tick()` yet — which is the normal pre-warmup state).
   *
   * Sorted ascending so the metrics module's `bucketize` walk
   * can early-exit on the first sample > `le_ms`.
   *
   * @returns {number[]}
   */
  _exportTickDurationRing() {
    if (!this._tickDurationRing || typeof this._tickDurationRing.length !== 'number') return [];
    const cap = this._tickDurationRing.length;
    const count = Math.min(this._tickDurationRingCount | 0, cap);
    if (count <= 0) return [];
    const out = new Array(count);
    for (let i = 0; i < count; i += 1) out[i] = this._tickDurationRing[i];
    out.sort((a, b) => a - b);
    return out;
  }

  /**
   * @private — export the current per-axis scoring weight the
   * loop will use on the next tick. Sourced from
   * `cfg.scoring.weights` (or the user-supplied `user.json`
   * overlay) — the same value the ranker reads on each tick.
   * Defensive: returns `null` when no weights are configured
   * so the metrics module can render an `_unconfigured`
   * placeholder.
   *
   * @returns {Object<string, number>|null}
   */
  _exportAdaptiveWeightsState() {
    const sc = (this.cfg && typeof this.cfg === 'object' && this.cfg.scoring
      && typeof this.cfg.scoring === 'object') ? this.cfg.scoring : null;
    const w = (sc && sc.weights && typeof sc.weights === 'object'
      && !Array.isArray(sc.weights)) ? sc.weights : null;
    if (!w) return null;
    /** @type {Record<string, number>} */
    const out = {};
    for (const k of Object.keys(w)) {
      const v = w[k];
      if (typeof v === 'number' && Number.isFinite(v)) {
        out[k] = Math.max(0, Math.min(1, v));
      }
    }
    return Object.keys(out).length > 0 ? out : null;
  }

  /**
   * Run ONE tick of the trading loop. Safe to call repeatedly.
   * Returns a typed `TickResult`. Never throws on per-candidate
   * failures (those come back as `errors[]` and logged events).
   * Throws ONLY on input bugs / configuration problems.
   *
   * @returns {Promise<TickResult>}
   */
  async tick() {
    const startedAt = this.clock();
    const startedAtMs = startedAt.getTime();
    const startedIso = startedAt.toISOString();
    /** @type {TickResult} */
    const result = {
      ts: startedIso,
      startedAtMs,
      endedAtMs: 0,
      durationMs: 0,
      candidates: [],
      entries: [],
      exits: [],
      snapshotTaken: false,
      breakerTripped: false,
      breakerKind: null,
      errors: [],
      fatalError: null,
    };
    try {
      await this._runTick(result, startedAt, startedAtMs);
    } catch (e) {
      result.fatalError = {
        name: e?.name ?? 'Error',
        message: e?.message ?? String(e),
        kind: e?.kind ?? null,
      };
      this._lastError = result.fatalError;
      this.logger.error('loop.tick.fatal', result.fatalError);
    } finally {
      // Always release the Electrum socket at end of tick.
      //
      // The cashscript `ElectrumNetworkProvider` keeps a persistent
      // TCP connection across `getUtxos()` queries. When the prior
      // connection ends in a half-closed state (e.g. server timeout
      // mid-response), Node refuses to open a new socket with
      // "Cannot initiate a new socket connection when an existing
      // connection exists", and _safeBalanceSats falls back to 0n
      // for every subsequent tick. Reproducible on both Windows and
      // Linux (confirmed 2026-09-12). Forcing the provider to close
      // at the tick boundary avoids the stuck-socket class entirely.
      //
      // Idempotent: `wallet.close()` is a no-op when the provider
      // is missing (e.g. init() threw) and safe to call multiple
      // times. Inner try/catch keeps the tick-result shape unchanged;
      // a close failure is non-fatal and not the operator's problem.
      // Latency cost: ~50–150ms per tick for the reconnect.
      if (this.wallet && typeof this.wallet.close === 'function') {
        try {
          await this.wallet.close();
        } catch (closeErr) {
          if (this.logger) {
            this.logger.warn('loop.tick.wallet-close.error', {
              err_name: closeErr?.name ?? 'Error',
              err_message: closeErr?.message ?? String(closeErr),
            });
          }
        }
      }
    }
    result.endedAtMs = Date.now();
    result.durationMs = result.endedAtMs - startedAtMs;
    this._tickCount += 1;
    // T78 subset 1 — bump cumulative counters using the same per-
    // tick fields we already log to `data/history.jsonl`. Defensive
    // coercion: non-array results degrade to a +0 bump so a future
    // refactor that forgets to initialize `entries`/`exits`/`errors`
    // can't silently corrupt the cumulative counts.
    if (Array.isArray(result.entries)) this._entryAttemptCount += result.entries.length;
    if (Array.isArray(result.exits)) this._exitAttemptCount += result.exits.length;
    if (Array.isArray(result.errors)) this._errorCount += result.errors.length;
    this._lastTickAtMs = result.endedAtMs;
    this._lastTickDurationMs = result.durationMs;
    this._lastTickResult = result;
    // T80 — push the tick duration into the rolling ring buffer
    // so the Prometheus `/metrics` endpoint can emit a real
    // histogram from `loop.stats()` instead of re-reading
    // `data/history.jsonl`. Defensive: a negative or non-finite
    // `durationMs` is clamped to 0 (a negative duration is a
    // sign of clock drift, not a real measurement).
    this._pushTickDuration(Math.max(0, result.durationMs | 0));
    return result;
  }

  /**
   * @private — the actual tick pipeline. Pulled out so the catch
   *           in `tick()` can be uniform across every path.
   */
  async _runTick(result, now, nowMs) {
    // T70: reset per-tick auto-consolidation guard. Multiple
    // candidates can hit the fragmentation gate in the same tick
    // but we only need to consolidate ONCE — after the first
    // successful consolidation we short-circuit the rest with
    // kind 'utxo_consolidation_already_fired_this_tick' and let
    // next tick re-evaluate once the on-chain UTXO set updates.
    this._utxoConsolidationFiredThisTick = false;
    // T76 subset 2b: reset per-tick rug-pattern gate metrics so
    // each tick starts with a clean slate (the dashboard's
    // /healthz tile + the structured `loop.rug_pattern.tick_summary`
    // log line read these).
    this._rugPatternCheckThisTick = {
      enabled: this._isRugPatternGateEnabled(),
      candidate_count: 0,
      checked_count: 0,
      cache_hit_count: 0,
      detected_count: 0,
      error_count: 0,
      token_not_found_count: 0,
      skipped_unwired_count: 0,
    };
    // 1. Refresh breaker state — trips/cool-downs may have elapsed.
    const breakerEval = await this.breaker.evaluate({ nowMs });
    result.breakerTripped = !breakerEval.allow;
    result.breakerKind = breakerEval.tripKind ?? breakerEval.kind ?? null;

    // 2. Fetch market state. Cached — the fetcher handles TTLs.
    const statsList = await this._fetchStats();
    const statsIndex = indexStatsByTokenId(statsList);
    if (statsList.length === 0) {
      this.logger.warn('loop.tick.no_stats', {
        ts: now.toISOString(),
        reason: 'indexer returned 0 tokens',
      });
    }

    // 3. Rank.
    let ranked;
    try {
      ranked = this.ranker(statsList, this.cfg.scoring, { nowMs });
    } catch (e) {
      this.logger.error('loop.tick.rank.error', {
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
      });
      // Without ranks, we cannot enter new positions. We CAN still
      // process exits (they only need per-token stats), so continue.
      ranked = { candidates: [], meta: { input_count: 0, returned: 0, notes: ['rank_failed'] } };
      result.errors.push({ stage: 'rank', message: e?.message ?? String(e) });
    }
    result.candidates = ranked.candidates;

    // 4. Refresh wallet + portfolio state.
    const walletBalanceSats = await this._safeBalanceSats();
    const [openList, pendingList, closingList] = await Promise.all([
      this._safeListPositions('open'),
      this._safeListPositions('pending'),
      this._safeListPositions('closing'),
    ]);
    // T36: pre-fetch the held-token price-series map ONCE per tick
    // (not per candidate). Used by the correlation-skip gate at
    // entry time. Cheap when statsIndex already carries the
    // series (the common case for tokens the indexer also ranked),
    // and falls back to the cached `fetcher.getTokenStats` path
    // otherwise. Per-token errors are swallowed.
    let heldSeriesByTokenId;
    try {
      heldSeriesByTokenId = await this._safeHeldPriceSeries(openList, statsIndex);
    } catch (e) {
      this.logger.warn('loop.tick.held_series.error', {
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
      });
      heldSeriesByTokenId = new Map();
    }
    const portfolioState = buildPortfolioState({
      walletBalanceSats,
      openPositions: openList,
      pendingPositions: pendingList,
      closingPositions: closingList,
      nowIso: now.toISOString(),
      heldSeriesByTokenId,
    });

    // 5. Entries (only when the breaker is not tripped).
    if (!result.breakerTripped) {
      for (const candidate of ranked.candidates) {
        if (!candidate || typeof candidate !== 'object') continue;
        const entryReport = await this._evaluateEntry(candidate, portfolioState, statsIndex);
        result.entries.push(entryReport);
      }
    } else {
      this.logger.info('loop.tick.entries.skipped_breaker', {
        ts: now.toISOString(),
        breaker_kind: result.breakerKind,
        breaker_reason: breakerEval.reason ?? null,
        candidate_count: ranked.candidates.length,
      });
      // T53.2: dispatch a `breaker_trip` event ONCE per tick when
      // the breaker is still tripping entries. The breaker's own
      // logger already emits `circuit_breaker.tripped` on the
      // transition (trip ts set), but operators want a per-tick
      // "still tripped" pulse so the dashboard's Recent Alerts
      // stream doesn't go silent during the cooldown window.
      void this._dispatchBreakerSkipped({
        breaker_kind: result.breakerKind,
        breaker_reason: breakerEval.reason ?? null,
        candidate_count: ranked.candidates.length,
        ts: now.toISOString(),
      });
    }

    // 6. Exits — every open position gets a re-quote + decision.
    for (const pos of openList) {
      if (!pos || typeof pos !== 'object') continue;
      const market = statsIndex.get(String(pos.token_id ?? '').toLowerCase());
      // T38: thread the 7d price series into the exit decision so
      // dynamic TP/SL thresholds can be derived per-token. Prefer
      // the market stats (current, possibly fresh), fall back to
      // the position's stamped series at entry time if stats didn't
      // surface one. Missing series → fixed TP/SL fallback.
      const exitReport = await this._evaluateExit(pos, market, nowMs);
      result.exits.push(exitReport);
    }

    // 6b. Re-read positions AFTER entries/exits. Step 5's
    //     `positions.open(...)` and step 6's `positions.close(...)`
    //     mutated the on-disk file; the snapshot + tick-summary
    //     we record below MUST reflect post-mutation state, not
    //     the pre-tick state we loaded into `openList` at step 4.
    //     Without this refresh, the snapshot's `open_position_count`
    //     would lag the truth by one tick — and the dashboard's
    //     "balance over time" graph would show a flat line every
    //     time the bot opened or closed a position.
    let postOpenList = openList;
    let postPendingList = pendingList;
    let postClosingList = closingList;
    try {
      [postOpenList, postPendingList, postClosingList] = await Promise.all([
        this._safeListPositions('open'),
        this._safeListPositions('pending'),
        this._safeListPositions('closing'),
      ]);
    } catch (e) {
      this.logger.error('loop.tick.post_positions.error', {
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
      });
      // Fall back to the pre-tick lists so we don't lose the
      // snapshot — the post-state mismatch is logged for audit.
    }
    const postPositionCount = (Array.isArray(postOpenList) ? postOpenList.length : 0)
      + (Array.isArray(postPendingList) ? postPendingList.length : 0)
      + (Array.isArray(postClosingList) ? postClosingList.length : 0);

    // 7. Snapshot (every cfg.loop.snapshot_interval_seconds).
    try {
      const recorded = await this.snapshots.maybeRecord(
        {
          bchBalanceSats: walletBalanceSats,
          openPositions: [...postOpenList, ...postPendingList, ...postClosingList],
          marketPricesSats: _extractPriceIndex(statsIndex),
          // T28e: thread the same price-vs-entry ratio guard the
          // exit decision uses into the snapshot's unrealized P&L
          // calculation. Without this, a token with a wildly-wrong
          // indexer price (e.g. QBTC: 100,000,000x off the actual
          // AMM spot rate) silently shows $20M+ of "unrealized
          // gains" on every snapshot. See commit 9561393 for the
          // original `shouldExit` fix and T28e for the snapshot
          // follow-up.
          maxPriceRatioX: (this.cfg && this.cfg.exit
            && Number.isFinite(Number(this.cfg.exit.max_price_vs_entry_ratio_x))
            && Number(this.cfg.exit.max_price_vs_entry_ratio_x) > 0)
            ? Number(this.cfg.exit.max_price_vs_entry_ratio_x)
            : null,
          source: 'loop',
          now: now,  // pin the snapshot clock to the loop's clock so tests can advance time deterministically
        },
        this.loopCfg.snapshot_interval_seconds,
      );
      result.snapshotTaken = recorded !== null;
    } catch (e) {
      this.logger.error('loop.tick.snapshot.error', {
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
      });
      result.errors.push({ stage: 'snapshot', message: e?.message ?? String(e) });
    }

    // 8. Append the tick summary to history.jsonl.
    await this._safeHistoryAppend({
      kind: 'tick',
      ts: now.toISOString(),
      candidate_count: ranked.candidates.length,
      entry_attempts: result.entries.length,
      exit_attempts: result.exits.length,
      entries_succeeded: result.entries.filter((e) => e?.executed).length,
      exits_succeeded: result.exits.filter((e) => e?.executed).length,
      wallet_balance_sats: walletBalanceSats.toString(),
      open_position_count: postPositionCount,
      open_exposure_bch: portfolioState.openExposureBch,
      breaker_tripped: result.breakerTripped,
      breaker_kind: result.breakerKind,
      snapshot_taken: result.snapshotTaken,
      duration_ms: result.durationMs,
    });

    // 9. T59-2 — orphan-position self-check. Fires once per tick
    //    when `alerts.orphan_position_check_enabled !== false`.
    //    Fetches the wallet's live UTXO set + the open positions
    //    from disk, runs the pure `diffPositionsVsChain`, and
    //    routes any high-severity `on_disk_only` findings through
    //    the existing T53.2 alert seams. NEVER throws on a
    //    wallet / positions / dispatch failure — a stuck socket or
    //    a Telegram outage can't kill a live bot.
    await this._maybeCheckOrphanPositions(now, nowMs);

    // 9.5. T62 — orphan auto-reconcile. Fires once per tick
    //      when `alerts.orphan_auto_reconcile_enabled !== false`.
    //      Hot-reads the open positions, runs the same T47 diff
    //      the orphan-position check uses, filters closeable
    //      findings (min-age gate protects against UTXO-scan
    //      races), and closes each closeable orphan via
    //      `Positions.close()`. Every close appends a structured
    //      history event so the dashboard / P&L roll-ups see the
    //      synthetic close immediately. NEVER throws on a single
    //      bad plan or a `positions.close()` blip — the per-
    //      position `error` field captures failures + a warn log
    //      surfaces them.
    await this._maybeAutoReconcileOrphans(now, nowMs);

    // 9.6. T87 — dust-position auto-close. Fires once per tick
    //      when `risk.dust_position_auto_close_enabled === true`.
    //      Reads the same `statsIndex` the tick already built
    //      (so no extra indexer round-trip) + the open positions
    //      list, runs `findDustPositions()` (pure math, no I/O),
    //      and closes each dust position via `Positions.close()`.
    //      Operator-set `exit_overrides.prevent_stop_loss:true`
    //      is honored inside `isDustPosition` as a HARD skip —
    //      hold-until-profit always wins over dust-close.
    //      On-chain-synced positions are skipped too (their
    //      `entry.token_amount_base` is reconstructed from a
    //      best-effort UTXO scan and could devour a real
    //      position). Every close appends a `kind:'dust_position_auto_close'`
    //      history event so the audit trail is preserved. NEVER
    //      throws on a single bad `positions.close()` blip — the
    //      per-position `error` field captures failures + a
    //      warn log surfaces them.
    await this._maybeAutoCloseDustPositions(now, nowMs, statsIndex);

    // 10. T56-2 — adaptive-weights self-tune. Fires once per tick
    //     when `scoring.adaptive_weights_enabled !== false`. Runs
    //     the calibration-correlation engine from
    //     `src/strategy/adaptive-weights.mjs` against the last
    //     `adaptive_weights_window_days` of closed trades, and
    //     when the engine reports a real shift, deep-merges the
    //     suggested weights into `config/user.json` AND appends
    //     an audit row to `data/adaptive-weights.jsonl`. Every
    //     call is defensive — a corrupt history file or a
    //     permissions blip on user.json can never kill the tick.
    await this._maybeApplyAdaptiveWeights(now, nowMs);

    // 11. T58 subset 3 — BadgerCoin Staking auto-wire. Fires once
    //     per tick when `cfg.staking.enabled === true` AND
    //     `cfg.staking.simulation_only === false`. The auto-wire
    //     itself has TWO sub-paths (auto-lock + auto-unlock),
    //     each gated on its own sub-mode knob:
    //     - Auto-LOCK when `auto_lock_enabled:true` AND the
    //       wallet holds no lockNFT AND the wallet balance covers
    //       the lock amount + the trade reserve.
    //     - Auto-UNLOCK when `auto_unlock_enabled:true` AND the
    //       wallet holds at least one lockNFT AND the lock
    //       timelock has elapsed.
    //     Both paths route through `dispatchStakeAlert` so the
    //     operator gets a row in `data/alerts.jsonl` + a channel
    //     notification (Telegram) on every dispatch. Defensive:
    //     a wallet outage / Electrum blip / cashscript SDK throw
    //     can never crash the tick — every code path is wrapped
    //     in try/catch and surfaces a structured warn line.
    await this._maybeAutoStake(now, nowMs);
  }

  /**
   * @private — fetch the discovery list (cached per-token).
   * @returns {Promise<Array<Object>>}
   */
  async _fetchStats() {
    const records = await this.fetcher.listTopTokens({
      by: 'tvl',
      order: 'desc',
      limit: Number.isFinite(this.cfg.scoring?.limit) ? this.cfg.scoring.limit : 200,
    });
    if (!Array.isArray(records)) return [];
    // T26d: stablecoin exclusion. Operators can list category ids
    // (or symbols) of tokens the bot must never consider — pegged
    // assets like PUSD / MUSD trade sideways, so the ranker's
    // 24h-change signal would oscillate around zero and burn the
    // bot on entries that have no expected upside. Filtering
    // happens here (before scoring + before normalization) so the
    // downstream pipeline is unaffected.
    const excluded = this._excludedTokenSet();
    if (excluded.size > 0) {
      const before = records.length;
      const filtered = records.filter((r) => {
        if (!r || typeof r !== 'object') return false;
        const id = typeof r.token_id === 'string' ? r.token_id.toLowerCase() : '';
        const sym = (typeof r.display_symbol === 'string' ? r.display_symbol
                   : typeof r.symbol === 'string' ? r.symbol : '').toUpperCase();
        return !excluded.has(id) && !excluded.has(sym);
      });
      if (before !== filtered.length) {
        this.logger.info('loop.tick.excluded_tokens', {
          before,
          after: filtered.length,
          excluded_count: before - filtered.length,
          excluded_set: [...excluded],
        });
      }
      return this._normalizeStats(filtered);
    }
    return this._normalizeStats(records);
  }

  /**
   * T26d: resolve the operator's excluded-tokens list to a set of
   * lowercased category ids + uppercased symbols. The set is used
   * for O(1) membership tests in `_fetchStats()`.
   *
   * @returns {Set<string>}
   */
  _excludedTokenSet() {
    const cfg = this.cfg || {};
    const sc = cfg.scoring || {};
    /** @type {Set<string>} */
    const out = new Set();
    /** @type {Array<string>} */
    const sources = [
      ...(Array.isArray(sc.excluded_tokens) ? sc.excluded_tokens : []),
      ...(Array.isArray(sc.stablecoins) ? sc.stablecoins : []),
      // T76 subset 1 — operator-curated rug-concentration blacklist.
      // Same lowercased-membership semantics as `excluded_tokens` (the
      // `_normalizeExcludedId` block below handles the bucketing). The
      // automated detection (chain scan for top-N holders) is deferred
      // to T76 subset 2; this is the operator-friendly escape hatch.
      ...(Array.isArray(sc.excluded_concentration_tokens) ? sc.excluded_concentration_tokens : []),
    ];
    for (const v of sources) {
      if (typeof v !== 'string') continue;
      const s = v.trim();
      if (s.length === 0) continue;
      // Symbols are short, uppercase, no colons. Category ids are
      // 64-char lowercase hex. Normalize each into the right
      // bucket; membership tests happen both ways.
      if (s.includes(':') || s.length === 64) {
        out.add(s.toLowerCase());
      } else {
        out.add(s.toUpperCase());
      }
    }
    return out;
  }

  /**
   * T23e helper: normalize raw indexer entries to canonical
   * PoolStats. Extracted so `_fetchStats` stays readable.
   * @param {Array<Object>} records
   * @returns {Array<Object>}
   */
  _normalizeStats(records) {
    // T23e: normalize raw indexer entries (`price_now`, `trade_volume`)
    // to the canonical PoolStats shape (`price_now_sats`,
    // `trade_volume_sats`) that the ranker + entry/exit logic
    // consume. The fetcher's `buildStatsRecord` does this mapping;
    // doing it once here defuses every downstream field-name
    // mismatch in one place. `extractFeatures` still has T23e
    // fallbacks as a defensive layer for callers that bypass
    // this path (e.g. tests passing raw entries directly).
    const normalized = [];
    for (const raw of records) {
      try {
        const stats = buildStatsRecord(raw);
        if (stats && typeof stats.token_id === 'string' && stats.token_id.length > 0) {
          normalized.push(stats);
        }
      } catch (_) {
        // Skip malformed rows rather than aborting the whole tick.
      }
    }
    return normalized;
  }

  /**
   * @private — `wallet.getBalanceSats()` with structured logging
   *           + a default to 0n on transient errors (the bot can
   *           still operate with stale balance; we just refuse new
   *           entries because `canOpen`'s floor will trip).
   * @returns {Promise<bigint>}
   */
  async _safeBalanceSats() {
    try {
      return await this.wallet.getBalanceSats();
    } catch (e) {
      this.logger.error('loop.tick.balance.error', {
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
      });
      // Fall back to 0n — the breaker / risk layer will refuse new
      // entries on the wallet-floor gate. Better than pretending we
      // know the balance when we don't.
      return 0n;
    }
  }

  /**
   * @private — `positions.list(bucket)` with a safe fallback to [].
   * @returns {Promise<Array<Object>>}
   */
  async _safeListPositions(bucket) {
    try {
      const out = await this.positions.list(bucket);
      return Array.isArray(out) ? out : [];
    } catch (e) {
      this.logger.error('loop.tick.positions.list.error', {
        bucket,
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
      });
      return [];
    }
  }

  /**
   * @private — T31 helper. Compute the AMM-implied marginal buy rate
   *           (sats per token) for one candidate. Returns `null` on
   *           fetch error / no pools / zero liquidity. The T31
   *           divergence guard is then SKIPPED — the conservative
   *           path lets `shouldEnter` decide based on the indexer
   *           price alone.
   *
   *           Uses `statsIndex` to skip the AMM fetch when the
   *           fetcher already returned a stats record with
   *           `amm_spot_sats` attached (test seam + future
   *           "fetcher also returns AMM spot" optimization). The
   *           fetcher-side implementation is `fetcher.getAmmSpotSats`.
   *
   * @param {string} tokenId
   * @param {Map<string, Object>} statsIndex
   * @returns {Promise<number|null>}
   */
  async _safeAmmSpotSats(tokenId, statsIndex) {
    if (!tokenId || typeof tokenId !== 'string') return null;
    // Fast path: if the fetcher returned an `amm_spot_sats` field
    // on the stats record (a future-proofing seam for the
    // `listTopTokens` discovery path), reuse it.
    try {
      const stats = statsIndex && typeof statsIndex.get === 'function'
        ? statsIndex.get(tokenId.toLowerCase())
        : null;
      if (stats && Number.isFinite(Number(stats.amm_spot_sats)) && Number(stats.amm_spot_sats) > 0) {
        return Number(stats.amm_spot_sats);
      }
    } catch (_) { /* fall through to fetcher call */ }
    // Standard path: fetcher.getAmmSpotSats() pulls active pools
    // (cached) and reduces to the marginal buy rate. Errors are
    // swallowed (returns null) so the entry decision can proceed
    // without the divergence guard.
    if (!this.fetcher || typeof this.fetcher.getAmmSpotSats !== 'function') return null;
    try {
      const out = await this.fetcher.getAmmSpotSats(tokenId);
      if (typeof out === 'number' && Number.isFinite(out) && out > 0) return out;
      return null;
    } catch (_) {
      return null;
    }
  }

  /**
   * @private — T32 helper. Compute the total BCH-side reserves
   *           across every active pool for this token. Returns
   *           `null` on fetch error / no pools / zero liquidity —
   *           the strategy layer then SKIPS the depth guard
   *           (the existing `scoring.min_tvl_bch` ranker filter
   *           still screens the worst cases).
   *
   *           Uses `statsIndex` to skip the AMM fetch when the
   *           fetcher already returned a stats record with
   *           `amm_total_depth_sats` attached (test seam + future
   *           "fetcher also returns AMM depth" optimization). The
   *           fetcher-side implementation is
   *           `fetcher.getAmmTotalDepthSats`.
   *
   * @param {string} tokenId
   * @param {Map<string, Object>} statsIndex
   * @returns {Promise<bigint|null>}
   */
  async _safeAmmTotalDepthSats(tokenId, statsIndex) {
    if (!tokenId || typeof tokenId !== 'string') return null;
    // Fast path: if the fetcher returned an `amm_total_depth_sats`
    // field on the stats record, reuse it.
    try {
      const stats = statsIndex && typeof statsIndex.get === 'function'
        ? statsIndex.get(tokenId.toLowerCase())
        : null;
      if (stats) {
        const v = stats.amm_total_depth_sats;
        if (typeof v === 'bigint' && v > 0n) return v;
        if (typeof v === 'string' && v.length > 0) {
          try {
            const bi = BigInt(v);
            if (bi > 0n) return bi;
          } catch { /* fall through */ }
        }
        if (Number.isFinite(Number(v)) && Number(v) > 0) {
          return BigInt(Math.trunc(Number(v)));
        }
      }
    } catch (_) { /* fall through to fetcher call */ }
    // Standard path: fetcher.getAmmTotalDepthSats() pulls active
    // pools (cached) and sums the BCH-side sats. Errors are
    // swallowed (returns null) so the entry decision can proceed
    // without the depth guard.
    if (!this.fetcher || typeof this.fetcher.getAmmTotalDepthSats !== 'function') return null;
    try {
      const out = await this.fetcher.getAmmTotalDepthSats(tokenId);
      if (typeof out === 'bigint' && out > 0n) return out;
      if (typeof out === 'number' && Number.isFinite(out) && out > 0) {
        return BigInt(Math.trunc(out));
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  /**
   * @private — T36 helper. Compute a Map<tokenId, price_series_7d>
   *           for every open position's token, sourced from the
   *           cached fetcher (statsIndex fast-path then
   *           `fetcher.getTokenStats`). Used by the correlation-skip
   *           gate at entry time so we don't open a position that
   *           duplicates an existing position's risk factor.
   *
   *           Tokens whose stats record lacks a `price_series_7d`
   *           array (or has a degenerate / empty series) are
   *           silently omitted from the map — `shouldEnter`'s
   *           `maxAbsCorrelation` helper tolerates a partial map
   *           and just skips the missing entries. Same conservative
   *           posture as T31 / T32 / T33.
   *
   *           Errors are swallowed per-token so one bad entry in
   *           the open portfolio doesn't block the whole tick.
   *
   * @param {Array<Object>} openPositions
   * @param {Map<string, Object>} statsIndex
   * @returns {Promise<Map<string, number[]>>}
   */
  async _safeHeldPriceSeries(openPositions, statsIndex) {
    /** @type {Map<string, number[]>} */
    const out = new Map();
    if (!Array.isArray(openPositions) || openPositions.length === 0) return out;
    if (!this.fetcher || typeof this.fetcher.getTokenStats !== 'function') return out;
    // Dedupe by lowercase token_id — multiple positions in the same
    // token (rare but possible across the open + closing buckets)
    // only need one series fetch.
    const seen = new Set();
    for (const pos of openPositions) {
      if (!pos || typeof pos !== 'object') continue;
      const raw = pos.token_id;
      if (typeof raw !== 'string' || raw.length === 0) continue;
      const key = raw.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      // Fast path: statsIndex already carries the series.
      try {
        const cached = statsIndex && typeof statsIndex.get === 'function'
          ? statsIndex.get(key)
          : null;
        if (cached && Array.isArray(cached.price_series_7d) && cached.price_series_7d.length >= 2) {
          const series = cached.price_series_7d.filter((n) => Number.isFinite(Number(n)));
          if (series.length >= 2) {
            out.set(key, series);
            continue;
          }
        }
      } catch (_) { /* fall through to fetcher call */ }
      // Slow path: fetcher.getTokenStats (cached, TTL 60s).
      try {
        const stats = await this.fetcher.getTokenStats(key);
        const series = stats && Array.isArray(stats.price_series_7d)
          ? stats.price_series_7d.filter((n) => Number.isFinite(Number(n)))
          : null;
        if (Array.isArray(series) && series.length >= 2) {
          out.set(key, series);
        }
      } catch (e) {
        this.logger.warn('loop.entry.held_series.error', {
          token_id: key,
          err_name: e?.name ?? 'Error',
          err_message: e?.message ?? String(e),
        });
        // Swallow — missing series for one held token doesn't
        // block the whole tick.
      }
    }
    return out;
  }

  /**
   * @private — T57-3. Pick the best DEX adapter for a single
   *           candidate. Returns the chosen adapter or null when
   *           no adapter should be threaded into this trade.
   *
   *           Fast paths (no router call):
   *             - no adapters wired      → null  (legacy path;
   *                                                `swap` uses
   *                                                its own
   *                                                default
   *                                                adapter)
   *             - exactly one adapter    → that adapter
   *
   *           Multi-adapter path: delegate to
   *           `this._pickBestAdapter(...)`. The router walks every
   *           adapter's `getPoolsAndMeta` and returns the one with
   *           the best per-base-unit marginal rate for `side`. On
   *           a router miss (all adapters returned no rate) the
   *           loop falls back to the FIRST adapter in the list —
   *           the legacy "use whatever's wired" behavior. This
   *           keeps the bot from being completely stuck when the
   *           indexer is flaky; the `dex_router.no_winner` warn
   *           line gives the operator the audit trail they need.
   *
   *           Per-adapter failures (one adapter throws while
   *           another returns a rate) are surfaced via the router's
   *           `scorecards` field, NOT via this helper — the loop
   *           only cares about the chosen adapter.
   *
   * @param {string} tokenId
   * @param {'buy'|'sell'} side
   * @param {bigint} amountBase
   * @returns {Promise<object|null>}
   */
  async _selectDexAdapter(tokenId, side, amountBase) {
    if (this.dexAdapters.length === 0) return null;
    if (this.dexAdapters.length === 1) return this.dexAdapters[0];
    try {
      const pick = await this._pickBestAdapter(this.dexAdapters, {
        tokenId,
        side,
        amountBase,
        logger: this.logger,
      });
      if (pick && pick.ok && pick.adapter) {
        return pick.adapter;
      }
      // Router miss — log the reason via pick.reason and fall back
      // to the first wired adapter (legacy behavior; the audit
      // trail gives the operator a head's up).
      this.logger.warn('loop.entry.dex_router.miss', {
        token_id: tokenId, side,
        amount_base: typeof amountBase === 'bigint' ? amountBase.toString() : String(amountBase ?? 0),
        router_reason: pick?.reason ?? 'unknown',
        scorecard_summary: Array.isArray(pick?.scorecards)
          ? pick.scorecards.map((s) => ({
              id: s.id, rate_sats: s.rateSats?.toString() ?? null, error: s.error,
            }))
          : null,
        fallback_adapter_id: this.dexAdapters[0]?.id ?? null,
      });
      return this.dexAdapters[0] ?? null;
    } catch (e) {
      // Router threw — treat as a miss + fall back. Never let an
      // adapter bug poison the entry pipeline.
      this.logger.warn('loop.entry.dex_router.error', {
        token_id: tokenId, side,
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
        fallback_adapter_id: this.dexAdapters[0]?.id ?? null,
      });
      return this.dexAdapters[0] ?? null;
    }
  }

  /**
   * @private — evaluate one entry candidate end-to-end. Returns a
   *           structured report (one of `executed` / `skipped` /
   *           `rejected` / `failed`).
   */
  async _evaluateEntry(candidate, portfolioState, statsIndex) {
    /** @type {Object} */
    const report = {
      token_id: candidate?.token_id ?? null,
      candidate_rank: candidate?.rank ?? null,
      decision: null,    // 'executed' | 'skipped' | 'rejected' | 'failed'
      reason: null,
      kind: null,        // machine-readable ('no_price_evidence', 'exposure_full', ...)
      size_bch: null,
      txid: null,
      slippage_bps: null,
      position_id: null,
      error: null,
      ts: new Date().toISOString(),
    };
    try {
      // 5a. Pre-flight wallet-floor check. The strategy layer also
      //     enforces `min_wallet_balance_bch`, but it returns
      //     `enter: false / kind: 'below_floor'` which the loop
      //     surfaces as `decision: 'skipped'`. The mission contract
      //     is that a wallet-floor refusal is a *risk* rejection
      //     (decision='rejected'), not a strategy skip — so the loop
      //     runs the check first. canOpen does the same check
      //     defensively; this is the canonical gate.
      const riskCfg = (this.cfg && typeof this.cfg.risk === 'object') ? this.cfg.risk : {};
      const minWalletBalanceBch = Number(riskCfg.min_wallet_balance_bch);
      if (Number.isFinite(minWalletBalanceBch) && minWalletBalanceBch > 0
          && portfolioState.walletBalanceBch < minWalletBalanceBch) {
        report.decision = 'rejected';
        report.reason = `wallet ${portfolioState.walletBalanceBch} BCH below min_wallet_balance_bch ${minWalletBalanceBch}`;
        report.kind = 'below_floor';
        // T53.2: dispatch a `wallet_floor` event so the operator
        // sees the wallet balance is below the safety floor BEFORE
        // the strategy layer's own floor check (which returns
        // `skipped` rather than `rejected`). Fire-and-forget; a
        // dispatch failure cannot kill the loop.
        void this._dispatchWalletFloorBreach({
          token_id: report.token_id,
          reason: report.reason,
          wallet_balance_bch: portfolioState.walletBalanceBch,
          min_wallet_balance_bch: minWalletBalanceBch,
          stage: 'entry_pre_flight',
          ts: report.ts,
        });
        // T40: surface the live config + observed values so the
        // dashboard's REASONING view can show the operator which
        // threshold tripped. The full strategy-layer reasoning blob
        // is NOT available here (shouldEnter hasn't run yet), but
        // the relevant slice for this gate is just the balance /
        // threshold pair + the candidate's score / rank for
        // context.
        const preflightReasoning = {
          ts: Date.now(),
          token_id: report.token_id,
          score: candidate?.score ?? null,
          rank: candidate?.rank ?? null,
          topK: candidate?.topK ?? null,
          eligible_for_trade: candidate?.eligible === true,
          decision: { kind: 'below_floor', wallet_balance_bch: portfolioState.walletBalanceBch },
          conditions: {
            min_wallet_balance_bch: minWalletBalanceBch,
          },
        };
        await this._safeHistoryAppend({
          kind: 'entry_rejected',
          ts: report.ts,
          token_id: report.token_id,
          reason: report.reason,
          reject_kind: report.kind,
          rank: report.candidate_rank,
          score: candidate?.score ?? null,
          reasoning: preflightReasoning,
        });
        return report;
      }

      // 5a-t60: pre-trade UTXO fragmentation gate. A wallet may
      //     have plenty of TOTAL BCH but no SINGLE UTXO large
      //     enough to fund a 0.005 BCH buy — multi-input funding
      //     inflates tx size and fees. Without this gate the bot
      //     surfaces the fragmented UTXO set as a silent
      //     `below_floor` rejection from inside the swap layer
      //     and the operator can't tell why their healthy wallet
      //     isn't trading. The pure helper classifies the wallet's
      //     UTXO set against `entry.max_position_bch` + fee
      //     headroom; when `needsConsolidation === true` we skip
      //     the entry with `kind:'utxo_fragmented'` so the gap
      //     surfaces in REASONING + history (the actual
      //     largestSats / totalSats / dustCount numbers ride along
      //     in the reasoning blob). Auto-consolidation is deferred
      //     to T60-2 — subset 1 only DETECTS + logs.
      //
      //     Defensive: a wallet.listUtxos() throw, a missing
      //     listUtxos() method, a non-array return, or a missing
      //     wallet object all fall through to the entry pipeline
      //     (the trade may still fail later, but the fragmentation
      //     check never kills the tick). The only failure mode that
      //     SKIPS is `needsConsolidation === true` — a true
      //     positive, surfaced as `entry_skipped`.
      const t60Cfg = (this.cfg && typeof this.cfg.risk === 'object') ? this.cfg.risk : {};
      const t60EnabledRaw = t60Cfg.utxo_consolidation_check_enabled;
      if (t60EnabledRaw !== false) {
        let t60Utxos = null;
        if (this.wallet && typeof this.wallet.listUtxos === 'function') {
          try {
            const u = await this.wallet.listUtxos();
            t60Utxos = Array.isArray(u) ? u : [];
          } catch (e) {
            this.logger.warn('loop.entry.utxo_fragmentation.listUtxos.error', {
              token_id: report.token_id,
              err_name: e?.name ?? 'Error',
              err_message: e?.message ?? String(e),
            });
            t60Utxos = null;
          }
        }
        if (Array.isArray(t60Utxos)) {
          // Required = max_position_bch + a generous fee headroom
          // (1000 sats ≈ 200-byte pre-vin tx + BCH dust limit slack).
          // The helper reports `largestSats - requiredSats` as
          // feeHeadroomSats; a negative value is the gap the
          // operator needs to close.
          const entryCfg60 = (this.cfg && typeof this.cfg.entry === 'object') ? this.cfg.entry : {};
          const maxPosBch = Number(entryCfg60.max_position_bch);
          const requiredSats = (Number.isFinite(maxPosBch) && maxPosBch > 0)
            ? BigInt(Math.floor(maxPosBch * 1e8) + 1000)
            : null;
          // The min-balance floor mirrors `risk.min_wallet_balance_bch`
          // (already enforced above) — re-stated here so the analysis
          // is its own single source of truth for the audit trail.
          const minBalanceBch = Number(t60Cfg.min_wallet_balance_bch);
          const minBalanceSats = (Number.isFinite(minBalanceBch) && minBalanceBch > 0)
            ? BigInt(Math.floor(minBalanceBch * 1e8))
            : null;
          const dustThresholdSats = (() => {
            const v = Number(t60Cfg.utxo_consolidation_dust_sats);
            return (Number.isFinite(v) && v >= 0) ? BigInt(Math.floor(v)) : 1000n;
          })();
          let t60Analysis = null;
          if (requiredSats !== null) {

            try {
              t60Analysis = analyzeUtxoFragmentation(t60Utxos, {
                requiredSats,
                dustThresholdSats,
                minBalanceSats,
              });
            } catch (e) {
              this.logger.warn('loop.entry.utxo_fragmentation.analysis.error', {
                token_id: report.token_id,
                err_name: e?.name ?? 'Error',
                err_message: e?.message ?? String(e),
              });
              t60Analysis = null;
            }
          }
          if (t60Analysis && t60Analysis.needsConsolidation === true) {

            // T70: AUTO-CONSOLIDATION BRANCH. When the operator has
            // opted in via `risk.utxo_consolidation_auto_enabled`
            // AND the wallet balance covers the consolidation
            // min-balance floor, the loop calls
            // `executeConsolidationTx` itself instead of just
            // emitting `entry_skipped:utxo_fragmented`. The
            // original T60 skip path stays as the safe default —
            // when the auto knob is OFF or a refusal guard trips,
            // we fall through to the existing entry_skipped with
            // kind `utxo_fragmented`. The dashboard filters on
            // `skip_kind` to keep the new kinds separate.
            const autoEnabledRaw = t60Cfg.utxo_consolidation_auto_enabled;
            const autoEnabled = autoEnabledRaw === true;
            const balanceCoversMin = !Number.isFinite(minBalanceBch)
              || portfolioState.walletBalanceBch >= minBalanceBch;
            const alreadyFired = this._utxoConsolidationFiredThisTick === true;
            if (autoEnabled && balanceCoversMin && !alreadyFired) {
              const autoReport = await this._maybeAutoConsolidate({
                tokenId: report.token_id,
                t60Analysis,
                t60Utxos,
                requiredSats,
                minBalanceBch,
                maxPosBch,
                t60Cfg,
                portfolioState,
              });
              if (autoReport && autoReport.skipEntry === true) {
                // Mirror the existing skip path — emit
                // `entry_skipped` with the auto-wire's kind +
                // reasoning, then return.
                // T70 fix: set the per-tick guard BEFORE returning
                // so any sibling candidate that also hits the
                // fragmentation gate short-circuits with
                // `utxo_consolidation_already_fired_this_tick`
                // instead of firing a duplicate broadcast.
                if (autoReport.consolidationAttempted === true) {
                  this._utxoConsolidationFiredThisTick = true;
                }
                report.decision = 'skipped';
                report.reason = autoReport.reason;
                report.kind = autoReport.kind;
                const t70Reasoning = {
                  ts: Date.now(),
                  token_id: report.token_id,
                  score: candidate?.score ?? null,
                  rank: candidate?.rank ?? null,
                  topK: candidate?.topK ?? null,
                  eligible_for_trade: candidate?.eligible === true,
                  decision: {
                    kind: autoReport.kind,
                    reason_code: t60Analysis.reason,
                    largest_utxo_sats: t60Analysis.largestSats.toString(),
                    total_utxo_sats: t60Analysis.totalSats.toString(),
                    required_sats: requiredSats !== null ? requiredSats.toString() : null,
                    fee_headroom_sats: t60Analysis.feeHeadroomSats !== null ? t60Analysis.feeHeadroomSats.toString() : null,
                    dust_count: t60Analysis.dustCount,
                    consolidated_count: t60Analysis.consolidatedCount,
                    utxo_count: t60Utxos.length,
                    ...(autoReport.reasoningExtra ?? {}),
                  },
                  conditions: {
                    max_position_bch: Number.isFinite(maxPosBch) ? maxPosBch : null,
                    min_wallet_balance_bch: Number.isFinite(minBalanceBch) ? minBalanceBch : null,
                    utxo_consolidation_dust_sats: Number(t60Cfg.utxo_consolidation_dust_sats ?? 1000),
                    wallet_balance_bch: portfolioState.walletBalanceBch,
                  },
                  ...(autoReport.kind === 'utxo_consolidation_failed' || autoReport.kind === 'utxo_consolidation_refused'
                    ? { remediation: {
                        script: 'scripts/consolidate-utxos.mjs',
                        dry_run: 'node scripts/consolidate-utxos.mjs --dry-run',
                        manual_broadcast: 'node scripts/consolidate-utxos.mjs --fee-sat-per-byte 1',
                      } }
                    : {}),
                };
                await this._safeHistoryAppend({
                  kind: 'entry_skipped',
                  ts: report.ts,
                  token_id: report.token_id,
                  reason: report.reason,
                  skip_kind: report.kind,
                  rank: report.candidate_rank,
                  score: candidate?.score ?? null,
                  reasoning: t70Reasoning,
                });
                return report;
              }
              // auto-ON but the helper says "no consolidation
              // needed after all" (e.g. a single-input fallback
              // from a guard). Fall through to the original
              // fragmented skip so the operator still sees the
              // gap in REASONING.
              if (autoReport && autoReport.consolidationAttempted === true) {
                this._utxoConsolidationFiredThisTick = true;
              }
            }
            if (alreadyFired) {
              // T70: a sibling candidate already triggered
              // consolidation this tick. Emit a distinct skip kind
              // so the dashboard can separate "first trigger" from
              // "followers in the same tick".
              report.decision = 'skipped';
              report.reason = `wallet fragmented: largest UTXO ${t60Analysis.largestSats.toString()} sats < required ${(requiredSats ?? 0n).toString()} sats; auto-consolidation already fired this tick — next tick will re-evaluate after the consolidation tx confirms.`;
              report.kind = 'utxo_consolidation_already_fired_this_tick';
              await this._safeHistoryAppend({
                kind: 'entry_skipped',
                ts: report.ts,
                token_id: report.token_id,
                reason: report.reason,
                skip_kind: report.kind,
                rank: report.candidate_rank,
                score: candidate?.score ?? null,
                reasoning: {
                  ts: Date.now(),
                  token_id: report.token_id,
                  score: candidate?.score ?? null,
                  rank: candidate?.rank ?? null,
                  topK: candidate?.topK ?? null,
                  eligible_for_trade: candidate?.eligible === true,
                  decision: {
                    kind: 'utxo_consolidation_already_fired_this_tick',
                    reason_code: t60Analysis.reason,
                    largest_utxo_sats: t60Analysis.largestSats.toString(),
                    total_utxo_sats: t60Analysis.totalSats.toString(),
                    required_sats: requiredSats !== null ? requiredSats.toString() : null,
                    fee_headroom_sats: t60Analysis.feeHeadroomSats !== null ? t60Analysis.feeHeadroomSats.toString() : null,
                    dust_count: t60Analysis.dustCount,
                    consolidated_count: t60Analysis.consolidatedCount,
                    utxo_count: t60Utxos.length,
                  },
                  conditions: {
                    max_position_bch: Number.isFinite(maxPosBch) ? maxPosBch : null,
                    min_wallet_balance_bch: Number.isFinite(minBalanceBch) ? minBalanceBch : null,
                    utxo_consolidation_dust_sats: Number(t60Cfg.utxo_consolidation_dust_sats ?? 1000),
                    wallet_balance_bch: portfolioState.walletBalanceBch,
                  },
                },
              });
              return report;
            }
            report.decision = 'skipped';
            report.reason = `wallet fragmented: largest UTXO ${t60Analysis.largestSats.toString()} sats < required ${(requiredSats ?? 0n).toString()} sats; total ${t60Analysis.totalSats.toString()} sats across ${t60Analysis.consolidatedCount + t60Analysis.dustCount} UTXOs (${t60Analysis.dustCount} dust). Run scripts/consolidate-utxos.mjs to merge.`;
            report.kind = 'utxo_fragmented';
            const t60Reasoning = {
              ts: Date.now(),
              token_id: report.token_id,
              score: candidate?.score ?? null,
              rank: candidate?.rank ?? null,
              topK: candidate?.topK ?? null,
              eligible_for_trade: candidate?.eligible === true,
              decision: {
                kind: 'utxo_fragmented',
                reason_code: t60Analysis.reason,
                largest_utxo_sats: t60Analysis.largestSats.toString(),
                total_utxo_sats: t60Analysis.totalSats.toString(),
                required_sats: requiredSats !== null ? requiredSats.toString() : null,
                fee_headroom_sats: t60Analysis.feeHeadroomSats !== null ? t60Analysis.feeHeadroomSats.toString() : null,
                dust_count: t60Analysis.dustCount,
                consolidated_count: t60Analysis.consolidatedCount,
                utxo_count: t60Utxos.length,
              },
              conditions: {
                max_position_bch: Number.isFinite(maxPosBch) ? maxPosBch : null,
                min_wallet_balance_bch: Number.isFinite(minBalanceBch) ? minBalanceBch : null,
                utxo_consolidation_dust_sats: Number(t60Cfg.utxo_consolidation_dust_sats ?? 1000),
                wallet_balance_bch: portfolioState.walletBalanceBch,
              },
              remediation: {
                script: 'scripts/consolidate-utxos.mjs',
                dry_run: 'node scripts/consolidate-utxos.mjs --dry-run',
                manual_broadcast: 'node scripts/consolidate-utxos.mjs --fee-sat-per-byte 1',
              },
            };
            await this._safeHistoryAppend({
              kind: 'entry_skipped',
              ts: report.ts,
              token_id: report.token_id,
              reason: report.reason,
              skip_kind: report.kind,
              rank: report.candidate_rank,
              score: candidate?.score ?? null,
              reasoning: t60Reasoning,
            });
            return report;
          }
        }
      }

      // 5a-t31: pre-fetch the AMM-implied marginal buy rate for this
      //     token and thread it into the candidate so `shouldEnter`
      //     can run the T31 indexer-vs-AMM divergence guard.
      //     Without this, the bot enters tokens whose indexer
      //     reference price is wildly off from the actual AMM spot
      //     rate, then the exit-side guard (T28d) keeps flagging
      //     the position as `price_missing` on every tick while
      //     the swap layer rejects every exit attempt — the
      //     position sits stuck until the time-stop fires
      //     (2026-09-14 QBTC incident: indexer 326 BCH/QBTC vs
      //     AMM 326 sats/QBTC = 100,000,000x divergence).
      //
      //     Units: the indexer's `stats.price_now_sats` is per
      //     DISPLAY unit; the AMM spot is per BASE unit. We
      //     align by multiplying the indexer price by 10^decimals
      //     when we know the decimals (BCMR-reported). When the
      //     decimals are missing (no authchain commitment), the
      //     indexer's `decimals_warn` field is set; we fall back
      //     to comparing the raw numbers and let the wide 1000x
      //     ratio absorb any unit-scale mismatch. Both sides
      //     positive → guard active; either side missing →
      //     `amm_spot_sats: null` → guard skipped (conservative:
      //     don't reject just because the AMM probe failed).
      try {
        const ammSpotSats = await this._safeAmmSpotSats(
          String(report.token_id ?? ''),
          statsIndex,
        );
        if (ammSpotSats !== null && Number.isFinite(ammSpotSats) && ammSpotSats > 0) {
          const stats = statsIndex.get(String(report.token_id ?? '').toLowerCase());
          const decimals = (stats && typeof stats.decimals === 'number' && Number.isFinite(stats.decimals))
            ? stats.decimals
            : null;
          const indexerPrice = stats && Number.isFinite(stats.price_now_sats) ? Number(stats.price_now_sats) : null;
          if (decimals !== null && indexerPrice !== null) {
            // Align units: multiply the indexer price by 10^decimals
            // so it's per BASE unit (matches the AMM's basis).
            candidate.amm_spot_sats = indexerPrice * (10 ** decimals);
          } else {
            // Decimals missing — pass through raw indexer price.
            // The 1000x ratio will absorb any unit-scale mismatch
            // (display vs base) since the operator-set ratio is
            // 4+ orders of magnitude wider than the 10^N unit gap
            // for typical tokens (N ≤ 8).
            candidate.amm_spot_sats = indexerPrice;
          }
        }
      } catch (e) {
        // Don't abort the entry on an AMM-spot fetch error — let
        // shouldEnter see `candidate.amm_spot_sats: undefined` and
        // skip the divergence check. The exit-side guard (T28d)
        // still catches any pathological indexer divergence
        // post-entry. Logged so operators see the issue.
        this.logger.warn('loop.entry.amm_spot.error', {
          token_id: report.token_id,
          err_name: e?.name ?? 'Error',
          err_message: e?.message ?? String(e),
        });
      }

      // 5a-t32: pre-fetch the total BCH-side depth across the
      //     active pools for this token and thread it into the
      //     candidate so `shouldEnter` can run the pre-entry
      //     illiquidity guard (T32). Mirrors the T31 AMM-spot
      //     probe — fast statsIndex path → fetcher call → null
      //     on error → guard SKIPPED.
      try {
        const ammTotalDepth = await this._safeAmmTotalDepthSats(
          String(report.token_id ?? ''),
          statsIndex,
        );
        if (ammTotalDepth !== null) {
          candidate.amm_total_depth_sats = ammTotalDepth;
        }
      } catch (e) {
        this.logger.warn('loop.entry.amm_total_depth.error', {
          token_id: report.token_id,
          err_name: e?.name ?? 'Error',
          err_message: e?.message ?? String(e),
        });
      }

      // T53.2: AMM divergence detector. The T31 guard inside
      //     `shouldEnter` rejects entries when indexer price and
      //     AMM spot diverge by 1000x, but it does so SILENTLY
      //     (the entry is just skipped with `no_price_evidence`).
      //     Surface the divergence as an alert so the operator
      //     can see when the indexer is misbehaving without
      //     grepping `data/history.jsonl` by hand. Uses the same
      //     1000x ratio the guard uses internally (mirrored here
      //     so we don't expose the guard's internals).
      try {
        const stats = statsIndex.get(String(report.token_id ?? '').toLowerCase());
        const ammSpotSats = candidate.amm_spot_sats;
        const indexerPrice = (stats && Number.isFinite(stats.price_now_sats))
          ? Number(stats.price_now_sats)
          : null;
        const decimals = (stats && typeof stats.decimals === 'number' && Number.isFinite(stats.decimals))
          ? stats.decimals
          : null;
        if (decimals !== null && indexerPrice !== null
            && typeof ammSpotSats === 'number' && Number.isFinite(ammSpotSats) && ammSpotSats > 0) {
          const alignedIndexer = indexerPrice * (10 ** decimals);
          const ratio = Math.max(alignedIndexer, ammSpotSats) / Math.max(Math.min(alignedIndexer, ammSpotSats), 1e-12);
          if (ratio >= 1000) {
            void this._dispatchAmmDivergence({
              token_id: report.token_id,
              indexer_price_sats: alignedIndexer,
              amm_spot_sats: ammSpotSats,
              ratio,
              decimals,
              ts: report.ts,
            });
          }
        }
      } catch (e) {
        // AMM divergence dispatch is best-effort; never let it
        // poison the entry pipeline.
        this.logger.warn('loop.entry.amm_divergence.dispatch.error', {
          token_id: report.token_id,
          err_name: e?.name ?? 'Error',
          err_message: e?.message ?? String(e),
        });
      }

      // 5b. Pure strategy decision.
      const decision = shouldEnter(candidate, portfolioState, this.cfg, { nowMs: Date.now() });
      if (!decision || decision.enter !== true) {
        report.decision = 'skipped';
        report.reason = decision?.reason ?? null;
        report.kind = decision?.kind ?? null;
        // T40: surface the full reasoning blob on skipped candidates
        // so the dashboard's REASONING view can show the operator
        // WHY (which gates fired, what thresholds applied, what
        // scoring inputs looked like) without truncating to the
        // 120-char `reason` string. Falls back to null when
        // shouldEnter didn't produce one (defensive — shouldn't
        // happen in production, but guards against a future
        // refactor of the strategy layer).
        const skipReasoning = (decision && typeof decision.reasoning === 'object' && decision.reasoning !== null)
          ? decision.reasoning
          : null;
        await this._safeHistoryAppend({
          kind: 'entry_skipped',
          ts: report.ts,
          token_id: report.token_id,
          reason: report.reason,
          skip_kind: report.kind,
          rank: report.candidate_rank,
          score: candidate?.score ?? null,
          reasoning: skipReasoning,
        });
        return report;
      }
      const sizeBch = Number(decision.sizeBch);
      report.size_bch = sizeBch;

      // 5c. Risk gate.
      //
      // O02 (idea_operator_allow-second-position-for-a-token_20260917):
      // also pass `proposedPricePerBaseUnit` so canOpen's second-position
      // discount gate can evaluate the new entry vs the oldest open
      // position's `entry.price_sats_per_token` (both per-BASE-unit).
      // The indexer's `stats.price_now_sats` is per-DISPLAY; convert
      // via `displayRateToBaseRate` (B04-correct direction) so units
      // line up. If the conversion fails or decimals are missing,
      // fall back to passing null — canOpen's helper then refuses
      // the second-position allowance (safe default: strict v1
      // single-position-per-token gate applies).
      //
      // Renamed to `proposedPriceStats` to avoid shadowing the
      // `stats` binding used later in this function (line ~1386 in
      // the dry-run path) — both reads go through `statsIndex` but
      // shadowing in the same function scope is a SyntaxError.
      const proposedPriceStats = statsIndex.get(String(report.token_id ?? '').toLowerCase());
      const proposedPricePerBaseUnit = (() => {
        if (!proposedPriceStats || !Number.isFinite(proposedPriceStats.price_now_sats)) return null;
        const conv = displayRateToBaseRate(
          BigInt(Math.round(proposedPriceStats.price_now_sats)),
          Number.isFinite(proposedPriceStats.decimals) ? proposedPriceStats.decimals : null,
        );
        return conv.ok ? Number(conv.value) : null;
      })();
      const riskCheck = canOpen({
        tokenId: String(report.token_id ?? ''),
        proposedSizeBch: sizeBch,
        proposedPricePerBaseUnit,
        openPositions: portfolioState.openPositions,
        closedPositions: await this._safeListPositions('closed'),
        walletBalanceBch: portfolioState.walletBalanceBch,
        cfg: this.cfg,
        nowMs: Date.now(),
      });
      if (!riskCheck.ok) {
        report.decision = 'rejected';
        report.reason = riskCheck.reason ?? null;
        report.kind = riskCheck.kind ?? null;
        // T53.2: dispatch a `risk_threshold` event when the risk
        // gate refuses the trade. Maps the canOpen kind to the
        // canonical alert kind (wallet_floor / risk_threshold) so
        // the dashboard's filter UI works. Fire-and-forget.
        void this._dispatchEntryRefused({
          token_id: report.token_id,
          reason: report.reason,
          reject_kind: report.kind,
          size_bch: sizeBch,
          stage: 'risk_gate',
          ts: report.ts,
        });
        // T40: surface the strategy-layer reasoning blob alongside
        // the risk-layer reject reason so the operator can see BOTH
        // (a) why the strategy layer said YES it was eligible AND
        // (b) why the risk layer said NO anyway. Without this, the
        // dashboard's REASONING view only shows the truncated
        // 1-line `reason` ("token X already has an open position").
        const rejectReasoning = (decision && typeof decision.reasoning === 'object' && decision.reasoning !== null)
          ? decision.reasoning
          : null;
        await this._safeHistoryAppend({
          kind: 'entry_rejected',
          ts: report.ts,
          token_id: report.token_id,
          reason: report.reason,
          reject_kind: report.kind,
          size_bch: sizeBch,
          reasoning: rejectReasoning,
        });
        return report;
      }

      // 5c-t76-2b: Live holders-based rug-pattern eligibility
      //     gate (new step 9.5, mirroring the dashboard's subset
      //     2a `?holders=` wiring). Fires AFTER `canOpen` (5c)
      //     and BEFORE `swap.execute` (5d) so it's the LAST gate
      //     before the buy broadcasts. Default OFF
      //     (`scoring.concentration_rug_enabled` shared with
      //     subset 2a — operator opts in once the upstream has
      //     been audited). On rug-pattern detection the loop emits
      //     `entry_skipped` with `kind:'rug_pattern_detected'`
      //     and the full audit blob in `reasoning` so the
      //     dashboard's REASONING view can surface WHY
      //     (top_n_pct, total_supply_base, holders_count, upstream,
      //     cached, cache_age_ms, threshold_pct, top_n).
      //
      //     Refusal guards are documented in
      //     `_checkRugPatternEligible`; the short version is
      //     "the live check NEVER blocks an entry unless the
      //     upstream returned a clean, non-cached rug-pattern
      //     positive." A `token_not_found` (unindexed), any
      //     scanner_error, an unexpected throw, or a missing
      //     cache seam all fall through to the existing
      //     `swap.execute` path.
      const t76bMetrics = this._rugPatternCheckThisTick;
      if (t76bMetrics && typeof t76bMetrics === 'object') {
        t76bMetrics.candidate_count = (t76bMetrics.candidate_count || 0) + 1;
      }
      const rugCheck = await this._checkRugPatternEligible(String(report.token_id ?? ''));
      if (rugCheck && rugCheck.shouldSkip === true) {
        const audit = (rugCheck.audit && typeof rugCheck.audit === 'object')
          ? rugCheck.audit : {};
        report.decision = 'skipped';
        report.reason = `live rug-pattern detected: top ${audit.top_n ?? '?'} wallets hold ${Number(audit.top_n_pct ?? 0).toFixed(2)}% of supply (threshold ${audit.threshold_pct ?? '?'}%); upstream=${audit.upstream ?? 'unknown'}, cached=${audit.cached === true ? 'true' : 'false'}. Token flagged as a rug-pattern by the live holders scanner — add to scoring.excluded_concentration_tokens to blacklist or set scoring.concentration_rug_enabled=false to disable.`;
        report.kind = 'rug_pattern_detected';
        const t76bReasoning = {
          ts: Date.now(),
          token_id: report.token_id,
          score: candidate?.score ?? null,
          rank: candidate?.rank ?? null,
          topK: candidate?.topK ?? null,
          eligible_for_trade: candidate?.eligible === true,
          decision: {
            kind: 'rug_pattern_detected',
            is_rug_pattern: true,
            top_n_pct: typeof audit.top_n_pct === 'number' ? Number(audit.top_n_pct.toFixed(4)) : null,
            total_supply_base: audit.total_supply_base ?? '0',
            holders_count: audit.holders_count ?? 0,
            threshold_pct: audit.threshold_pct ?? null,
            top_n: audit.top_n ?? null,
            epsilon_pct: audit.epsilon_pct ?? null,
            upstream: audit.upstream ?? null,
            cached: audit.cached === true,
            cache_age_ms: typeof audit.cache_age_ms === 'number' ? audit.cache_age_ms : 0,
            snapshot_at_unix_s: audit.snapshot_at_unix_s ?? null,
          },
          conditions: {
            max_position_bch: (() => {
              const ec = (this.cfg && typeof this.cfg === 'object' && this.cfg.entry
                && typeof this.cfg.entry === 'object')
                ? this.cfg.entry : null;
              const v = Number(ec?.max_position_bch);
              return Number.isFinite(v) ? v : null;
            })(),
            concentration_rug_enabled: this._isRugPatternGateEnabled(),
            concentration_rug_top_n: audit.top_n ?? null,
            concentration_rug_threshold_pct: audit.threshold_pct ?? null,
          },
          remediation: {
            blacklist: 'add this token_id to scoring.excluded_concentration_tokens in config/user.json',
            disable_live_check: 'set scoring.concentration_rug_enabled=false in config/user.json',
            audit_endpoint: 'GET /api/token/<id>/holders',
          },
        };
        await this._safeHistoryAppend({
          kind: 'entry_skipped',
          ts: report.ts,
          token_id: report.token_id,
          reason: report.reason,
          skip_kind: report.kind,
          rank: report.candidate_rank,
          score: candidate?.score ?? null,
          reasoning: t76bReasoning,
        });
        return report;
      }

      // 5d. Execute the buy.
      const amountBase = BigInt(Math.round(sizeBch * SATS_PER_BCH));
      // T27f: token-aware destination. The swap's sell-side output
      // must land at a `z...` cashaddr (legacy `q...` is rejected
      // by cauldron-swap-sdk with "Address is not a token-aware
      // address"). Fall back to getAddress() for bots whose wallet
      // hasn't been refactored yet.
      const destination = (this.wallet.getTokenAddress && this.wallet.getTokenAddress())
        ?? (this.wallet.getAddress ? this.wallet.getAddress() : null);
      if (!destination) {
        throw new LoopConfigError('TradingLoop._evaluateEntry: wallet tokenAddress/address returned null — wallet not init()\'d');
      }
      const expectedRateSats = (() => {
        const stats = statsIndex.get(String(report.token_id ?? '').toLowerCase());
        if (stats && Number.isFinite(stats.price_now_sats)) {
          // Pass the indexer's per-DISPLAY-unit rate through verbatim.
          // The swap layer (B04 / bug-exit-failed-20260916) normalizes
          // it to per-BASE-unit via `tokenMeta.decimals` so it can be
          // compared against `plan.effectiveRate` (also per-base). No
          // conversion is done at the loop level — that keeps the
          // boundary in one place and makes the indexer-fed path
          // trivially auditable.
          return BigInt(Math.round(stats.price_now_sats));
        }
        return null;
      })();
      // B04 FIX (rate-units direction + tokenMeta plumbing): same as
      // the exit path — see _evaluateExit. Threading the parsed
      // BCMR decimals through `tokenMeta` lets the swap layer's
      // `displayRateToBaseRate` normalize `expectedRateSats` from
      // per-DISPLAY to per-BASE before comparing against the AMM's
      // per-base `effectiveRate`. Without it the slippage pre-flight
      // reports ~10000 bps for any decimals>=1 token.
      const entryTokenMeta = (() => {
        const stats = statsIndex.get(String(report.token_id ?? '').toLowerCase());
        if (!stats) return null;
        return { decimals: stats.decimals ?? null, symbol: stats.symbol ?? null };
      })();
      // T57-3: pick the best DEX adapter for this candidate when
      // multiple are wired in. Single-adapter mode falls through
      // and the swap executor uses its constructor adapter (or
      // the live cauldron default).
      const dexAdapter = await this._selectDexAdapter(
        String(report.token_id),
        'buy',
        amountBase,
      );
      const swapResult = await this.swap.execute({
        tokenId: String(report.token_id),
        side: 'buy',
        amountBase,
        destination,
        expectedRateSats,
        tokenMeta: entryTokenMeta,
        dryRun: this.dryRun,
        dexAdapter,
      });
      if (!swapResult || !swapResult.ok) {
        report.decision = 'failed';
        report.reason = swapResult?.error ?? 'swap.execute returned ok=false';
        report.kind = swapResult?.errorKind ?? 'swap_failed';
        report.slippage_bps = swapResult?.slippageBps ? String(swapResult.slippageBps) : null;
        await this._safeHistoryAppend({
          kind: 'entry_failed',
          ts: report.ts,
          token_id: report.token_id,
          reason: report.reason,
          fail_kind: report.kind,
          size_bch: sizeBch,
          slippage_bps: report.slippage_bps,
          wallet_balance_after: swapResult?.walletBalanceAfterSats
            ? String(swapResult.walletBalanceAfterSats)
            : null,
        });
        return report;
      }
      report.txid = swapResult.txid ?? null;
      report.slippage_bps = swapResult.slippageBps ? String(swapResult.slippageBps) : null;

      // 5d. Persist the position. Best-effort; a write failure is
      //     logged but the swap itself is on-chain.
      //
      // B04 / bug-exit-failed-20260916: `swapResult.effectiveRateSats`
      // is sats per BASE unit. Storing it raw as `price_sats_per_token`
      // would surface "0.97 sat/token" for an OLA-like token with
      // `decimals=2` (the SDK's `totalSupply / amount` bigint-floors
      // the per-base rate to `0n` and the per-display rate to `97`).
      // The human-readable `price_sats_per_token` field on the
      // position should be per-DISPLAY unit to match the indexer's
      // `price_now_sats`, so convert via `tokenMeta.decimals`.
      const entryDisplayRateSats = _effectiveRateToDisplay(swapResult);
      const entryBlock = {
        txid: report.txid,
        price_sats_per_token: entryDisplayRateSats,
        bch_spent_sats: Number(swapResult.totalSatsInOrOut),
        token_amount_base: swapResult.amountBase.toString(),
        fee_sats: totalSwapFeeSats(swapResult),
        broadcast_ms: 0,
        ts: report.ts,
        slippage_bps: report.slippage_bps,
      };
      const stats = statsIndex.get(String(report.token_id ?? '').toLowerCase());
      const symbol = stats?.symbol ?? stats?.display_symbol ?? null;
      const decimals = (typeof stats?.decimals === 'number' && Number.isFinite(stats.decimals))
        ? stats.decimals
        : null;
      // 5d-dryrun: dry-run mode must NOT pollute the live positions
      //     store — the swap above was plan-only and never broadcast.
      //     Record a synthetic report + a `entry_dry_run` history line
      //     so the operator can still see "what would have happened"
      //     in `data/history.jsonl`.
      if (this.dryRun) {
        report.position_id = null;
        report.decision = 'dry_run';
        this.logger.info('loop.entry.dry_run', {
          ts: report.ts,
          token_id: report.token_id,
          size_bch: sizeBch,
          would_be_txid: report.txid,
          effective_rate_sats: swapResult.effectiveRateSats?.toString() ?? null,
          slippage_bps: report.slippage_bps,
          bch_spent_sats: entryBlock.bch_spent_sats,
          token_amount_base: entryBlock.token_amount_base,
        });
        await this._safeHistoryAppend({
          kind: 'entry_dry_run',
          ts: report.ts,
          token_id: report.token_id,
          dry_run: true,
          size_bch: sizeBch,
          would_be_txid: report.txid,
          price_sats_per_token: entryBlock.price_sats_per_token,
          bch_spent_sats: entryBlock.bch_spent_sats,
          token_amount_base: entryBlock.token_amount_base,
          fee_sats: entryBlock.fee_sats,
          slippage_bps: report.slippage_bps,
          rank: report.candidate_rank,
          score: candidate?.score ?? null,
        });
        return report;
      }
      const opened = await this.positions.open({
        tokenId: String(report.token_id),
        tokenSymbol: symbol,
        tokenDecimals: decimals,
        entry: entryBlock,
        reasoning: decision.reasoning ?? { ts: Date.now(), token_id: report.token_id },
        initialStatus: 'open',
      });
      report.position_id = opened?.id ?? null;
      report.decision = 'executed';
      await this._safeHistoryAppend({
        kind: 'entry',
        ts: report.ts,
        token_id: report.token_id,
        position_id: report.position_id,
        txid: report.txid,
        size_bch: sizeBch,
        price_sats_per_token: entryBlock.price_sats_per_token,
        bch_spent_sats: entryBlock.bch_spent_sats,
        token_amount_base: entryBlock.token_amount_base,
        fee_sats: entryBlock.fee_sats,
        slippage_bps: report.slippage_bps,
        rank: report.candidate_rank,
        score: candidate?.score ?? null,
        // O02: if canOpen permitted this entry as a second position on
        // the same token (via the discount gate), surface the anchor +
        // discount so the audit trail + REASONING view can show
        // "2nd position opened at X% discount from anchor Y (age Z)".
        // Defensive: only attach when canOpen returned the
        // `second_position` flag (omitted for the common first-position
        // case so the audit envelope stays compact).
        ...(riskCheck && riskCheck.second_position === true
          ? {
              second_position: true,
              anchor_position_id: riskCheck.anchor_position_id ?? null,
              anchor_entry_price_sats: riskCheck.anchor_entry_price_sats ?? null,
              anchor_age_ms: riskCheck.anchor_age_ms ?? null,
              discount_fraction: riskCheck.discount_fraction ?? null,
              required_discount_pct: riskCheck.required_discount_pct ?? null,
            }
          : {}),
      });
      return report;
    } catch (e) {
      report.decision = 'failed';
      report.reason = e?.message ?? String(e);
      report.kind = e?.kind ?? 'entry_evaluate_threw';
      report.error = { name: e?.name ?? 'Error', message: report.reason };
      this.logger.error('loop.entry.evaluate.error', {
        token_id: report.token_id,
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
      });
      await this._safeHistoryAppend({
        kind: 'entry_failed',
        ts: report.ts,
        token_id: report.token_id,
        reason: report.reason,
        fail_kind: report.kind,
      }).catch(() => { /* never let history-append failure mask the underlying error */ });
      return report;
    }
  }

  /**
   * @private — evaluate one exit per open position. Returns a
   *           structured report (one of `executed` / `skipped` /
   *           `failed`).
   */
  async _evaluateExit(position, market, nowMs) {
    /** @type {Object} */
    const report = {
      position_id: position?.id ?? null,
      token_id: position?.token_id ?? null,
      decision: null,    // 'executed' | 'skipped' | 'failed'
      reason: null,
      kind: null,        // 'take_profit' | 'stop_loss' | 'trailing_stop' | 'time_stop'
      txid: null,
      realized_pnl_sats: null,
      new_high_water_mark_sats: null,
      error: null,
      ts: new Date().toISOString(),
    };
    try {
      // 6a. Pure strategy decision.
      //
      // T38: thread the 7d price series into `shouldExit` so the
      // dynamic TP/SL thresholds can be derived per-token. The
      // indexer's `price_series_7d` is the same 29-point normalized
      // series used by T35 / T36 / T37 — when present on the
      // current market stats, it produces per-position thresholds.
      // Falls back to the position's entry-time `price_series_7d`
      // snapshot when stats is missing it (chain-synced positions
      // etc.). Missing both → fixed `take_profit_pct` / `stop_loss_pct`.
      const priceSeries7d = (() => {
        if (market && Array.isArray(market.price_series_7d) && market.price_series_7d.length >= 2) {
          return market.price_series_7d;
        }
        const stamped = position?.entry?.reasoning?.conditions?.price_series_7d
          ?? position?.entry?.reasoning?.price_series_7d;
        if (Array.isArray(stamped) && stamped.length >= 2) {
          return stamped;
        }
        return null;
      })();
      const decision = shouldExit(position, market ?? null, this.cfg, {
        nowMs,
        ...(priceSeries7d !== null ? { priceSeries7d } : {}),
      });
      // Always update HWM when the market moved up — but skip the
      // on-disk write in dry-run mode (the position itself was never
      // persisted by a dry-run entry, so a dry-run update would 404
      // anyway).
      if (decision.newHighWaterMarkSats != null && !this.dryRun) {
        try {
          await this.positions.updateHighWaterMark(
            String(position.id),
            BigInt(Math.round(Number(decision.newHighWaterMarkSats))),
          );
          report.new_high_water_mark_sats = String(decision.newHighWaterMarkSats);
        } catch (e) {
          this.logger.warn('loop.exit.hwm.error', {
            position_id: position.id,
            err_name: e?.name ?? 'Error',
            err_message: e?.message ?? String(e),
          });
        }
      }
      if (!decision || decision.exit !== true) {
        report.decision = 'skipped';
        report.reason = 'no_exit_condition';
        // O03: if the operator-set profit-gate blocked an otherwise-
        // triggered exit, surface the gate state on the audit event
        // so /api/history / the dashboard can show "held by
        // prevent-stop-loss (actual X%, target Y%)" instead of the
        // generic `no_exit_condition` noise.
        const gate = decision?.snapshot?.exit_overrides_gate ?? null;
        const auditRecord = {
          kind: gate && gate.decision === 'blocked' ? 'exit_blocked_by_profit_target' : 'exit_skipped',
          ts: report.ts,
          position_id: report.position_id,
          token_id: report.token_id,
          reason: gate && gate.decision === 'blocked'
            ? `profit_target:${gate.actual_pct?.toFixed(2)}%<${gate.target_pct}% (prevent_stop_loss=ON)`
            : report.reason,
          hwm_sats: report.new_high_water_mark_sats,
        };
        if (gate && gate.decision === 'blocked') {
          auditRecord.profit_target_pct = gate.target_pct;
          auditRecord.actual_pct = gate.actual_pct;
        }
        await this._safeHistoryAppend(auditRecord);
        return report;
      }

      report.kind = decision.kind ?? null;
      report.reason = decision.reason ?? null;

      // T43: profit-floor extension gate. When a `time_stop` exit
      // fires but the projected realized P&L is below the
      // operator-configured floor (`exit.min_realized_pnl_sats`,
      // default 3000 sats) AND the P&L is still positive, extend
      // the time-stop by `exit.time_stop_extension_hours` and skip
      // the swap. The extension is single-shot — after the second
      // time-stop fires the bot closes regardless, so a dead-flat
      // position can't get trapped.
      //
      // Applied ONLY to `time_stop` exits:
      //   - take_profit already means price moved favorably by
      //     ~5%+, so P&L after fees easily exceeds the 3000-sat
      //     floor for any sane position size.
      //   - stop_loss / trailing_stop mean the trade thesis failed;
      //     extending would just lock in a bigger loss.
      //   - time_stop is the one exit that fires regardless of
      //     price action — and that's exactly the case where the
      //     bot ended up closing FURU at +368 sats instead of
      //     letting it run another 6h.
      //
      // Negative P&L never extends (handled inside
      // `evaluateProfitFloor`; it returns null for net < 0).
      if (report.kind === 'time_stop') {
        const currentPriceSats = (() => {
          const p = market && Number.isFinite(market.price_now_sats) ? Number(market.price_now_sats) : null;
          if (p !== null && p > 0) return p;
          // Fall back to the HWM-based price the strategy was
          // using as `effectiveCurrentPrice` (1 step back, after
          // the price-sanity guard rejected the indexer). Best-
          // effort — if we have nothing, the floor check degrades
          // to "no extension".
          return decision?.snapshot?.effective_current_price_sats
            ?? decision?.snapshot?.current_price_sats
            ?? null;
        })();
        const floorEval = evaluateProfitFloor(position, currentPriceSats, this.cfg, { nowMs });
        if (floorEval && floorEval.shouldExtend) {
          report.decision = 'extended';
          report.reason = `below_floor_extending:pnl=${floorEval.pnlSats.toString()},floor=${floorEval.floorSats},cutoff=${floorEval.newCutoffMs}`;
          report.realized_pnl_sats = floorEval.pnlSats.toString();
          // Stamp the extension on the position. Single-shot —
          // `evaluateProfitFloor` returns null once this field is
          // set, so subsequent ticks will close on the next
          // time-stop fire.
          if (!this.dryRun) {
            try {
              await this.positions.setTimeStopExtension(String(position.id), floorEval.newCutoffMs);
            } catch (e) {
              this.logger.warn('loop.exit.floor.extension_persist.error', {
                position_id: position.id,
                err_name: e?.name ?? 'Error',
                err_message: e?.message ?? String(e),
              });
            }
          }
          this.logger.warn('loop.exit.floor.extended', {
            position_id: report.position_id,
            token_id: report.token_id,
            projected_pnl_sats: floorEval.pnlSats.toString(),
            floor_sats: floorEval.floorSats,
            new_cutoff_ms: floorEval.newCutoffMs,
            kind: report.kind,
          });
          // T53.2: dispatch a `wallet_floor` event when the exit
          // is extended via the profit-floor gate. The position
          // is NOT closed (decision='extended'); the alert signals
          // that the bot would have taken a sub-floor P&L had it
          // closed at the current rate. Fire-and-forget.
          void this._dispatchExitExtended({
            position_id: report.position_id,
            token_id: report.token_id,
            projected_pnl_sats: floorEval.pnlSats.toString(),
            floor_sats: floorEval.floorSats,
            new_cutoff_ms: floorEval.newCutoffMs,
            kind: report.kind,
            ts: report.ts,
          });
          await this._safeHistoryAppend({
            kind: 'exit_skipped',
            ts: report.ts,
            position_id: report.position_id,
            token_id: report.token_id,
            reason: report.reason,
            projected_pnl_sats: floorEval.pnlSats.toString(),
            floor_sats: floorEval.floorSats,
            new_cutoff_ms: floorEval.newCutoffMs,
            skip_kind: 'below_floor_extending',
          });
          return report;
        }
      }

      // 6b. Execute the sell. amountBase is the position's
      //     token_amount_base (bigint string from `entry.token_amount_base`).
      const tokenAmountBaseStr = position?.entry?.token_amount_base;
      let amountBase;
      if (typeof tokenAmountBaseStr === 'bigint') {
        amountBase = tokenAmountBaseStr;
      } else if (typeof tokenAmountBaseStr === 'string' && tokenAmountBaseStr.length > 0) {
        try { amountBase = BigInt(tokenAmountBaseStr); }
        catch {
          // If we can't parse, fall back to the historical entry.amountBase
          // — but the entry block always carries it, so this is a bug.
          throw new LoopConfigError(`_evaluateExit: position.entry.token_amount_base not bigint-coercible (${tokenAmountBaseStr})`);
        }
      } else if (typeof tokenAmountBaseStr === 'number' && Number.isFinite(tokenAmountBaseStr)) {
        amountBase = BigInt(Math.round(tokenAmountBaseStr));
      } else {
        throw new LoopConfigError(`_evaluateExit: position.entry.token_amount_base missing for ${position.id}`);
      }
      if (amountBase <= 0n) {
        throw new LoopConfigError(`_evaluateExit: amountBase must be > 0; got ${amountBase}`);
      }
      // T27f: token-aware destination (see _evaluateEntry for the
      // rationale). The exit-side output of a token sale is BCH,
      // which both address forms can hold, but we still use the
      // token-aware form for consistency with the entry path.
      const destination = (this.wallet.getTokenAddress && this.wallet.getTokenAddress())
        ?? (this.wallet.getAddress ? this.wallet.getAddress() : null);
      if (!destination) {
        throw new LoopConfigError('_evaluateExit: wallet tokenAddress/address returned null');
      }
      // Pass `decision.trailPriceSats` (sats per DISPLAY unit,
      // computed by the exit strategy from `effectiveCurrentPrice`
      // which comes from `market.price_now_sats`) through verbatim.
      // The swap layer (B04 / bug-exit-failed-20260916) normalizes
      // it to per-BASE-unit via `tokenMeta.decimals` so it can be
      // compared against `plan.effectiveRate` (also per-base). For
      // time-stop exits the trail price is no longer the right
      // anchor — but the slippage math now correctly compares
      // apples to apples, so even a stale trail anchor produces a
      // meaningful slippage number rather than a guaranteed
      // 10000-bps false positive.
      const expectedRateSats = decision.trailPriceSats != null
        ? BigInt(Math.round(Number(decision.trailPriceSats)))
        : null;
      // B04 FIX (rate-units direction + tokenMeta plumbing): the
      // swap layer's rate-units helper needs `tokenMeta.decimals`
      // to normalize `expectedRateSats` (per-DISPLAY) into per-BASE
      // before comparing against `plan.effectiveRate` (per-BASE).
      // Before this thread-through, `getPoolsAndMeta` only resolves
      // `tokenMeta` when called with a `symbol`, never via `tokenId`;
      // the exit path passes only `tokenId`, so `tokenMeta` arrived
      // as `null` and the helper fell through to passing the per-display
      // value verbatim as if it were per-base — producing the
      // ~10000-bps false positive that locked every decimals>=1
      // token's exit into a retry storm. The market stats from
      // `statsIndex` already carry the parsed BCMR decimals (see
      // `buildStatsRecord` in src/data/fetcher.mjs), so thread the
      // relevant slice into the swap call.
      const exitTokenMeta = (market && typeof market === 'object')
        ? { decimals: market.decimals ?? null, symbol: market.symbol ?? null }
        : null;
      // T57-3: pick the best DEX adapter for this SELL when
      // multiple are wired in. Mirrors the entry-path thread-
      // through — `_selectDexAdapter` is a no-op (returns null)
      // when there's no wiring, single-adapter fast-path when
      // there's exactly one, and the router path otherwise. The
      // router picks by `effectiveSell` rate so the operator
      // gets the best per-base-unit exit price across active
      // DEXes (cauldron live vs. cauldron_safe_mode cached,
      // guanaco once it ships, etc.).
      const exitDexAdapter = await this._selectDexAdapter(
        String(position.token_id),
        'sell',
        amountBase,
      );
      const swapResult = await this.swap.execute({
        tokenId: String(position.token_id),
        side: 'sell',
        amountBase,
        destination,
        expectedRateSats,
        tokenMeta: exitTokenMeta,
        dryRun: this.dryRun,
        dexAdapter: exitDexAdapter,
      });
      if (!swapResult || !swapResult.ok) {
        report.decision = 'failed';
        report.reason = swapResult?.error ?? 'swap.execute returned ok=false';
        await this._safeHistoryAppend({
          kind: 'exit_failed',
          ts: report.ts,
          position_id: report.position_id,
          token_id: report.token_id,
          reason: report.reason,
          exit_kind: report.kind,
        });
        return report;
      }

      // 6c. Compute realized P&L (sats) BEFORE writing the close.
      const exitBlock = {
        txid: swapResult.txid ?? null,
        price_sats_per_token: _effectiveRateToDisplay(swapResult),
        bch_received_sats: Number(swapResult.totalSatsInOrOut),
        fee_sats: totalSwapFeeSats(swapResult),
        ts: report.ts,
        reason: report.kind ?? 'exit',
        slippage_bps: swapResult.slippageBps ? String(swapResult.slippageBps) : null,
      };
      const pnl = realizedPnlSats(position, exitBlock);
      const realizedPnlSatsVal = pnl.net === null ? 0 : Number(pnl.net);

      // 6d-dryrun: dry-run must NOT mutate the positions store or the
      //     breaker state — those are side effects of a real on-chain
      //     close. Emit a synthetic report + `exit_dry_run` history line
      //     so the operator can still see what would have happened.
      if (this.dryRun) {
        report.txid = exitBlock.txid;
        report.realized_pnl_sats = realizedPnlSatsVal;
        report.decision = 'dry_run';
        this.logger.info('loop.exit.dry_run', {
          ts: report.ts,
          position_id: report.position_id,
          token_id: report.token_id,
          would_be_txid: report.txid,
          exit_kind: report.kind,
          bch_received_sats: exitBlock.bch_received_sats,
          realized_pnl_sats: realizedPnlSatsVal,
          slippage_bps: exitBlock.slippage_bps,
        });
        await this._safeHistoryAppend({
          kind: 'exit_dry_run',
          ts: report.ts,
          position_id: report.position_id,
          token_id: report.token_id,
          dry_run: true,
          would_be_txid: report.txid,
          exit_kind: report.kind,
          price_sats_per_token: exitBlock.price_sats_per_token,
          bch_received_sats: exitBlock.bch_received_sats,
          fee_sats: exitBlock.fee_sats,
          realized_pnl_sats: realizedPnlSatsVal,
          realized_pnl_bch: realizedPnlSatsVal / SATS_PER_BCH,
          slippage_bps: exitBlock.slippage_bps,
        });
        return report;
      }

      // 6d. Persist the close.
      const closed = await this.positions.close(
        String(position.id),
        exitBlock,
        realizedPnlSatsVal,
      );
      report.txid = closed?.exit?.txid ?? exitBlock.txid;
      report.realized_pnl_sats = realizedPnlSatsVal;
      report.decision = 'executed';

      // 6e. Record into the circuit breaker. Consecutive-loss trips
      //     surface in the next tick's `breaker.evaluate()`. T34: also
      //     pass `exitKind` so the breaker can start a stop-loss-only
      //     `loss_cooldown_minutes` pause that doesn't gate exits but
      //     does block new entries until the cooldown elapses.
      try {
        const rec = this.breaker.recordResult({
          pnlSats: realizedPnlSatsVal,
          tsMs: Date.now(),
          tokenId: String(position.token_id),
          exitKind: report.kind,    // 'take_profit' | 'stop_loss' | 'trailing_stop' | 'time_stop'
        });
        if (rec?.tripped) {
          this.logger.warn('loop.exit.breaker.tripped', {
            position_id: report.position_id,
            token_id: report.token_id,
            trip_kind: rec.tripKind,
            realized_pnl_sats: realizedPnlSatsVal,
          });
        }
        if (rec?.lossCooldownStarted) {
          this.logger.warn('loop.exit.breaker.loss_cooldown', {
            position_id: report.position_id,
            token_id: report.token_id,
            exit_kind: report.kind,
            realized_pnl_sats: realizedPnlSatsVal,
            ts: report.ts,
          });
        }
      } catch (e) {
        // A breaker failure must NOT prevent the close from being
        // recorded — the trade is on-chain either way.
        this.logger.warn('loop.exit.breaker.record.error', {
          position_id: report.position_id,
          err_name: e?.name ?? 'Error',
          err_message: e?.message ?? String(e),
        });
      }

      await this._safeHistoryAppend({
        kind: 'exit',
        ts: report.ts,
        position_id: report.position_id,
        token_id: report.token_id,
        txid: report.txid,
        exit_kind: report.kind,
        price_sats_per_token: exitBlock.price_sats_per_token,
        bch_received_sats: exitBlock.bch_received_sats,
        fee_sats: exitBlock.fee_sats,
        realized_pnl_sats: realizedPnlSatsVal,
        realized_pnl_bch: realizedPnlSatsVal / SATS_PER_BCH,
        slippage_bps: exitBlock.slippage_bps,
      });
      return report;
    } catch (e) {
      report.decision = 'failed';
      report.reason = e?.message ?? String(e);
      report.error = { name: e?.name ?? 'Error', message: report.reason };
      this.logger.error('loop.exit.evaluate.error', {
        position_id: report.position_id,
        token_id: report.token_id,
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
      });
      await this._safeHistoryAppend({
        kind: 'exit_failed',
        ts: report.ts,
        position_id: report.position_id,
        token_id: report.token_id,
        reason: report.reason,
      }).catch(() => { /* never let history-append failure mask the underlying error */ });
      return report;
    }
  }

  /**
   * @private — wrap historyAppend in try/catch so a single bad
   *           append never aborts the tick. Tests inject their own
   *           appender (typically an in-memory array).
   */
  async _safeHistoryAppend(record) {
    if (!record || typeof record !== 'object') return;
    const line = JSON.stringify({
      ...record,
      // Keep the trailing newline OUT — atomicAppendNdjson adds it.
    });
    try {
      await this.historyAppend(line);
    } catch (e) {
      this.logger.error('loop.history.append.error', {
        kind: record.kind ?? null,
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
      });
    }
  }

  /**
   * T59-2 — orphan-position self-check. Runs at the END of every
   * tick (after step 8 history append). Reads `alerts.orphan_position_check_enabled`
   * from `this.cfg.alerts` (default: enabled when the knob is
   * missing/null — the v1 subset 1 contract). When disabled, the
   * check is a true no-op (zero wallet UTXO fetch, zero
   * `diffPositionsVsChain` cost).
   *
   * The check itself is three pure-shaped steps wrapped in
   * defensive try/catch so a wallet outage, a positions.json
   * write race, or a Telegram dispatch failure can NEVER crash
   * the tick. Every failure mode emits a structured warn line
   * (`loop.orphan_check.<stage>.error`) with the same shape the
   * rest of the loop uses; the dispatchOrphanAlerts helper
   * already captures per-alert errors into its typed envelope so
   * the audit trail is preserved even on a Telegram outage.
   *
   * @param {Date} now  The loop's clock-pinned `Date`.
   * @param {number} nowMs  Same, in epoch ms.
   * @returns {Promise<void>}
   * @private
   */
  async _maybeCheckOrphanPositions(now, nowMs) {
    // 1. Knob gate — honor `alerts.orphan_position_check_enabled`.
    //    Treat `undefined` / `null` / non-false as "enabled" so
    //    config drift (the field removed) doesn't silently disable
    //    a defensive check. Only an explicit `false` opts out.
    const cfg = this.cfg || {};
    const alertsCfg = cfg.alerts || {};
    const enabledRaw = alertsCfg.orphan_position_check_enabled;
    if (enabledRaw === false) {
      return;
    }

    // 2. Skip when alerts are completely disabled (no router + no
    //    appender wired). The dispatch helper becomes a no-op but
    //    still has a (small) cost in the positions+utxo fetch;
    //    cutting the whole branch when both seams are absent
    //    saves a real RPC round-trip on every tick for operators
    //    who never enabled the alerts subsystem.
    const hasSeams = (typeof this._safeAlertDispatch === 'function')
      || (typeof this._alertsAppend === 'function');
    if (!hasSeams) {
      return;
    }

    // 3. Fetch positions + wallet UTXOs. Both are wrapped in
    //    try/catch so a wallet outage or a positions-store
    //    failure can't kill the tick. The defensive pattern
    //    mirrors `_safeBalanceSats` / `_safeListPositions`.
    let openPositions = [];
    try {
      const list = await this.positions.list('open');
      openPositions = Array.isArray(list) ? list : [];
    } catch (e) {
      this.logger.warn('loop.orphan_check.positions.error', {
        event: 'loop.orphan_check.positions',
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
      });
      return;
    }

    let utxos = [];
    if (!this.wallet || typeof this.wallet.listUtxos !== 'function') {
      // Wallet doesn't expose the UTXO surface — nothing to check
      // against. Log once at warn so a future wallet refactor
      // that drops the method shows up in the audit trail.
      this.logger.warn('loop.orphan_check.wallet.missing_listUtxos', {
        event: 'loop.orphan_check.wallet',
        reason: 'wallet.listUtxos is not a function',
      });
      return;
    }
    try {
      const u = await this.wallet.listUtxos();
      utxos = Array.isArray(u) ? u : [];
    } catch (e) {
      this.logger.warn('loop.orphan_check.wallet.error', {
        event: 'loop.orphan_check.wallet',
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
      });
      return;
    }

    // 4. Run the pure diff. `diffPositionsVsChain` is itself
    //    synchronous + side-effect-free; passing the clock's ISO
    //    string keeps the report `generated_at` deterministic in
    //    the loop's test harness.
    let report;
    try {
      report = diffPositionsVsChain(openPositions, utxos, {
        generatedAt: (now instanceof Date && !Number.isNaN(now.getTime()))
          ? now.toISOString()
          : new Date(nowMs).toISOString(),
      });
    } catch (e) {
      this.logger.warn('loop.orphan_check.diff.error', {
        event: 'loop.orphan_check.diff',
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
      });
      return;
    }

    if (!report || !Array.isArray(report.findings)) {
      // Defensive: the diff should always return a `{findings: []}`
      // shape; guard against a future refactor that breaks the
      // contract.
      return;
    }

    // 5. Build a position index for age stamping. Reuse the same
    //    shape the dispatch wrapper expects.
    const positionIndex = new Map();
    for (const p of openPositions) {
      if (!p || typeof p !== 'object') continue;
      const id = p.id;
      if (typeof id === 'string' && id.length > 0) {
        positionIndex.set(id, p);
      }
    }

    // 6. Dispatch through the existing T53.2 seams. The dispatch
    //    helper (`dispatchOrphanAlerts`) never throws by contract;
    //    we belt-and-suspenders wrap it in a try/catch anyway so
    //    a future refactor that breaks the contract can't kill
    //    the tick.
    let dispatchResult = null;
    try {
      dispatchResult = await this._orphanPositionDispatch({
        router: this._safeAlertDispatch ?? null,
        appender: this._alertsAppend ?? null,
        findings: report.findings,
        nowMs,
        positionIndex,
        logger: this.logger,
      });
    } catch (e) {
      this.logger.warn('loop.orphan_check.dispatch.unexpected_throw', {
        event: 'loop.orphan_check.dispatch',
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
      });
      return;
    }

    // 7. Emit the per-tick audit line so the dashboard's Recent
    //    Alerts stream + the operator's history grep both see
    //    what happened, even when zero orphans were found.
    const summary = (report && report.summary) || {};
    const findingsCount = Array.isArray(report.findings) ? report.findings.length : 0;
    const highCount = (typeof summary.high === 'number') ? summary.high : 0;
    this.logger.info('loop.orphan_check.done', {
      event: 'loop.orphan_check.done',
      open_positions: openPositions.length,
      utxo_count: utxos.length,
      findings: findingsCount,
      high: highCount,
      dispatched: (dispatchResult && typeof dispatchResult.dispatched === 'number') ? dispatchResult.dispatched : 0,
      persisted: (dispatchResult && typeof dispatchResult.persisted === 'number') ? dispatchResult.persisted : 0,
      failed: (dispatchResult && typeof dispatchResult.failed === 'number') ? dispatchResult.failed : 0,
    });
  }

  /**
   * T62 — orphan auto-reconcile. Runs at the END of every
   * `_runTick()` (after step 9 orphan-position check, as the
   * new step 9.5) when `alerts.orphan_auto_reconcile_enabled !== false`.
   * Treat `undefined` / `null` / non-false as "enabled" so a
   * config drift (the field removed) doesn't silently disable
   * the feature. Only an explicit `false` opts out.
   *
   * Pipeline:
   *   1. Hot-read `alerts.orphan_auto_reconcile_enabled` +
   *      `alerts.orphan_auto_reconcile_min_age_minutes` from
   *      `this.cfg.alerts` (default: disabled when the
   *      `enabled` flag is missing or `false`; 60-minute min-age
   *      when `min_age_minutes` is missing).
   *   2. Fetch `positions.list('open')` + `wallet.listUtxos()`
   *      + run the same T47 diff the orphan-alert path uses.
   *   3. Filter findings through `pickOrphanAutoCloseableFindings`
   *      (min-age gate guards against UTXO-scan races).
   *   4. For each closeable pair, build the synthetic exit plan
   *      via `buildOrphanAutoClosePlan`, execute via the
   *      `_orphanAutoCloseExecute` seam, and append the audit
   *      record to `data/history.jsonl` via `_safeHistoryAppend`.
   *   5. Emit a structured `loop.orphan_auto_reconcile.done` info
   *      line every tick so the operator's audit grep sees the
   *      decision regardless of whether anything was closed.
   *
   * Defensive: any throw from the loader / diff / plan-builder
   * / executor / history-append is caught + logged structured.
   * A wallet outage or a positions-store blip can never kill
   * the tick. Per-position close failures are captured in the
   * `result.error` field of the typed envelope + a per-position
   * warn line is emitted.
   *
   * @param {Date} now
   * @param {number} nowMs
   * @returns {Promise<void>}
   * @private
   */
  async _maybeAutoReconcileOrphans(now, nowMs) {
    // 1. Knob gate — honor `alerts.orphan_auto_reconcile_enabled`.
    //    Treat `undefined` / `null` / non-false as "disabled"
    //    (default OFF) so a fresh install can never silently
    //    close positions. Only an explicit `true` opts in.
    const cfg = this.cfg || {};
    const alertsCfg = cfg.alerts || {};
    const enabledRaw = alertsCfg.orphan_auto_reconcile_enabled;
    if (enabledRaw !== true) {
      return;
    }

    // 2. Min-age gate — read once per tick.
    const minAgeMs = ageGateMsFromMinutes(alertsCfg.orphan_auto_reconcile_min_age_minutes);

    // 3. Fetch positions + wallet UTXOs. Both are wrapped in
    //    try/catch so a wallet outage or a positions-store
    //    failure can't kill the tick. The defensive pattern
    //    mirrors `_maybeCheckOrphanPositions` (T59-2).
    let openPositions = [];
    try {
      const list = await this.positions.list('open');
      openPositions = Array.isArray(list) ? list : [];
    } catch (e) {
      this.logger.warn('loop.orphan_auto_reconcile.positions.error', {
        event: 'loop.orphan_auto_reconcile.positions',
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
      });
      return;
    }

    if (openPositions.length === 0) {
      // No positions to reconcile — emit the per-tick audit line
      // so the operator can see the check ran + decided to skip.
      this.logger.info('loop.orphan_auto_reconcile.done', {
        event: 'loop.orphan_auto_reconcile.done',
        open_positions: 0,
        closeable: 0,
        closed: 0,
        failed: 0,
      });
      return;
    }

    let utxos = [];
    if (!this.wallet || typeof this.wallet.listUtxos !== 'function') {
      // Wallet doesn't expose the UTXO surface — nothing to
      // diff against. Log once at warn so a future wallet
      // refactor that drops the method shows up in the audit
      // trail.
      this.logger.warn('loop.orphan_auto_reconcile.wallet.missing_listUtxos', {
        event: 'loop.orphan_auto_reconcile.wallet',
        reason: 'wallet.listUtxos is not a function',
      });
      return;
    }
    try {
      const u = await this.wallet.listUtxos();
      utxos = Array.isArray(u) ? u : [];
    } catch (e) {
      this.logger.warn('loop.orphan_auto_reconcile.wallet.error', {
        event: 'loop.orphan_auto_reconcile.wallet',
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
      });
      return;
    }

    // 4. Run the pure diff. `diffPositionsVsChain` is itself
    //    synchronous + side-effect-free; passing the clock's ISO
    //    string keeps the report `generated_at` deterministic in
    //    the loop's test harness.
    let report;
    try {
      report = diffPositionsVsChain(openPositions, utxos, {
        generatedAt: (now instanceof Date && !Number.isNaN(now.getTime()))
          ? now.toISOString()
          : new Date(nowMs).toISOString(),
      });
    } catch (e) {
      this.logger.warn('loop.orphan_auto_reconcile.diff.error', {
        event: 'loop.orphan_auto_reconcile.diff',
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
      });
      return;
    }

    if (!report || !Array.isArray(report.findings)) {
      return;
    }

    // 5. Build the position index. Reuse the same shape the
    //    orphan-alert dispatch path uses.
    const positionIndex = new Map();
    for (const p of openPositions) {
      if (!p || typeof p !== 'object') continue;
      const id = p.id;
      if (typeof id === 'string' && id.length > 0) {
        positionIndex.set(id, p);
      }
    }

    // 6. Filter to the closeable subset (min-age gate).
    const pairs = pickOrphanAutoCloseableFindings(report.findings, positionIndex, { nowMs, minAgeMs });

    // 7. Execute one close per pair. Each close is wrapped in
    //    its own try/catch so a single bad plan or a single
    //    positions.close() throw can't kill the rest of the tick.
    let closed = 0;
    let failed = 0;
    const failedErrors = [];
    for (const pair of pairs) {
      let plan;
      try {
        plan = buildOrphanAutoClosePlan({ pair, nowMs });
      } catch (e) {
        failed += 1;
        const errMsg = (e && typeof e === 'object' && typeof e.message === 'string') ? e.message : String(e);
        failedErrors.push({ position_id: pair?.finding?.position_id ?? null, stage: 'plan', error: errMsg });
        this.logger.warn('loop.orphan_auto_reconcile.plan.error', {
          event: 'loop.orphan_auto_reconcile.plan',
          position_id: pair?.finding?.position_id ?? null,
          err_name: e?.name ?? 'Error',
          err_message: errMsg,
        });
        continue;
      }

      let result;
      try {
        result = await this._orphanAutoCloseExecute({
          plan,
          positions: this.positions,
          nowMs,
          logger: this.logger,
        });
      } catch (e) {
        // The I/O wrapper is contracted to never throw; belt-and-
        // suspenders wrap so a future refactor that breaks the
        // contract can't kill the tick.
        failed += 1;
        const errMsg = (e && typeof e === 'object' && typeof e.message === 'string') ? e.message : String(e);
        failedErrors.push({ position_id: plan.positionId, stage: 'execute', error: errMsg });
        this.logger.warn('loop.orphan_auto_reconcile.execute.unexpected_throw', {
          event: 'loop.orphan_auto_reconcile.execute',
          position_id: plan.positionId,
          err_name: e?.name ?? 'Error',
          err_message: errMsg,
        });
        continue;
      }

      // 8. Append the audit row via the existing history seam.
      try {
        const auditRecord = buildOrphanAutoCloseAuditRecord({ plan, result, nowMs });
        await this._safeHistoryAppend(auditRecord);
      } catch (e) {
        // `_safeHistoryAppend` already catches + logs internally;
        // this is just belt-and-suspenders in case the helper
        // itself is refactored.
        this.logger.warn('loop.orphan_auto_reconcile.audit.error', {
          event: 'loop.orphan_auto_reconcile.audit',
          position_id: plan.positionId,
          err_name: e?.name ?? 'Error',
          err_message: e?.message ?? String(e),
        });
      }

      if (result && result.ok === true) {
        closed += 1;
      } else {
        failed += 1;
        const errMsg = (result && typeof result.error === 'string') ? result.error : 'unknown';
        failedErrors.push({ position_id: plan.positionId, stage: 'close', error: errMsg });
      }
    }

    // 9. Emit the per-tick audit line.
    this.logger.info('loop.orphan_auto_reconcile.done', {
      event: 'loop.orphan_auto_reconcile.done',
      open_positions: openPositions.length,
      findings: Array.isArray(report.findings) ? report.findings.length : 0,
      closeable: pairs.length,
      closed,
      failed,
      min_age_minutes: Math.floor(minAgeMs / 60000),
      failed_errors: failedErrors.length > 0 ? failedErrors : undefined,
    });
  }

  /**
   * T56-2 — End-of-tick adaptive-weights self-tune.
   *
   * Runs at the end of every `_runTick()` (after the orphan-
   * position check) when `scoring.adaptive_weights_enabled !== false`.
   * Treat `undefined` / `null` / non-false as "enabled" so a
   * config drift (the field removed) doesn't silently disable the
   * feature. Only an explicit `false` opts out.
   *
   * Pipeline:
   *   1. Hot-read `scoring.adaptive_weights_*` knobs from `this.cfg`.
   *   2. Load the last `adaptive_weights_window_days` of closed
   *      trades from `data/history.jsonl` via the injected
   *      `_adaptiveWeightsLoadHistory` seam (default: disk read).
   *   3. Run `runAdaptiveWeightsSuggestion(...)` (injected seam)
   *      to produce the suggestion envelope.
   *   4. If `envelope.suggestion.applied === true`, load the
   *      current `config/user.json`, deep-merge the suggested
   *      weights via `applyAdaptiveWeightsToUserJson(...)` (which
   *      also stamps `adaptive_weights_last_applied`), and write
   *      the result back atomically.
   *   5. Append the audit record (`buildAdaptiveWeightsAuditRecord(...)`)
   *      to `data/adaptive-weights.jsonl` via
   *      `atomicAppendNdjson` — even on no-op ticks we still want
   *      the audit row so the operator can see "the engine
   *      considered this tick and decided not to shift" (the row
   *      carries `applied:false` + the reason).
   *
   * Defensive:
   *   - Any throw from the loaders / suggestion engine / apply
   *     helper / writers is caught + logged structured. A wallet /
   *     config / disk failure cannot kill the tick.
   *   - The WIF / mnemonic in `user.json` are NEVER touched by the
   *     apply helper — see `applyAdaptiveWeightsToUserJson` deep-
   *     merge contract. Tests verify this end-to-end with a
   *     hand-crafted user.json containing the seed.
   *
   * @param {Date} now
   * @param {number} nowMs
   * @returns {Promise<void>}
   * @private
   */
  /**
   * T58 subset 3 — BadgerCoin Staking auto-wire.
   *
   * Runs at the end of every `_runTick()` (after step 9 orphan
   * check + step 10 adaptive-weights self-tune). The master
   * switch is `cfg.staking.enabled === true` AND
   * `cfg.staking.simulation_only === false`. When the master
   * switch is OFF, the entire method is a no-op (no wallet UTXO
   * fetch, no dispatch, zero overhead).
   *
   * Two sub-paths:
   *   - **Auto-LOCK** — gated on `staking.auto_lock_enabled`.
   *     Fires `executeLock` when the wallet holds ZERO lockNFTs
   *     AND wallet balance ≥ `lock_min_balance_bch + entry.max_position_bch`
   *     AND `(allow_when_positions_open || no open positions)`.
   *     Skipped gracefully when any of the guards fail (the loop
   *     emits `loop.stake.lock.skipped` so the operator can see
   *     why the auto-tick declined to dispatch).
   *   - **Auto-UNLOCK** — gated on `staking.auto_unlock_enabled`.
   *     Fires `executeUnlock` for ONE lockNFT per tick when the
   *     wallet holds at least one lockNFT AND the timelock has
   *     elapsed (current tip height ≥ lock block height +
   *     stakeBlocks + graceBlocks). Fail-fast per lock; the
   *     next tick drains the next stale lockNFT.
   *
   * Each orchestrator return envelope is routed through
   * `dispatchStakeAlert` (the T53.2 alert pipeline). Lock +
   * unlock dispatch failures are NON-FATAL — a bad Electrum
   * response or a missing cashscript dep can never kill the
   * tick. The audit trail (`data/alerts.jsonl`) is the source of
   * truth; channel routing (Telegram) is best-effort.
   *
   * Defensive:
   *   - Every code path wrapped in try/catch. Wallet /
   *     provider / dispatch failures all surface as structured
   *     warn lines; the tick completes normally.
   *   - When `stakingProvider` is absent (legacy boot path,
   *     staking not yet wired into run-bot), the auto-wire
   *     short-circuits to a single warn so a stale config
   *     can't crash the tick.
   *   - No real chain call in the test path: tests inject
   *     `stakingLockExecute` / `stakingUnlockExecute` /
   *     `stakingDispatch` / `stakingGetBlockHeight` seams.
   *
   * @param {Date} now
   * @param {number} nowMs
   * @returns {Promise<void>}
   * @private
   */
  /**
   * T87 — Dust-position auto-close. End-of-tick helper that
   * closes every open position whose projected market value is
   * below the close-cost budget (tx fee + slippage ×
   * `risk.dust_position_close_budget_multiplier`). Wired as
   * step 9.6 (after T62 orphan-reconcile + before T56-2
   * adaptive-weights). Hot-reads the same `statsIndex` the
   * tick already built (no extra indexer round-trip).
   *
   * Pipeline:
   *   1. Knob gate — honor `risk.dust_position_auto_close_enabled`.
   *      Treat `undefined` / `null` / non-true as "disabled"
   *      (default OFF) so a fresh install can never silently
   *      close positions. Only an explicit `true` opts in.
   *   2. Fetch open positions (defensive: positions.list throw
   *      → warn + return).
   *   3. Build the price index from `statsIndex` (the Map<token_id,
   *      stats> the tick built in step 2). If `statsIndex` is
   *      missing or empty, warn + return (no live prices means
   *      no dust detection).
   *   4. Resolve the dust config via `resolveDustConfig(this.cfg)`.
   *   5. Run `findDustPositions()` (pure math, no I/O). Skip
   *      positions with `exit_overrides.prevent_stop_loss:true`
   *      (operator-set "hold until profit" wins) and on-chain-synced
   *      positions (their entry data is reconstructed from UTXO
   *      scan and could devour a real position).
   *   6. For each dust position: build the close exit block,
   *      call `Positions.close()` (the same API the rest of the
   *      bot uses so the dashboard / P&L rollups see the synthetic
   *      close immediately), append a `kind:'dust_position_auto_close'`
   *      history event with the full dust envelope so the
   *      audit trail records WHY.
   *   7. Emit the per-tick `loop.dust_position_auto_close.done`
   *      info line with open/evaluated/dust/closed/failed/skipped
   *      counts.
   *
   * Defensive:
   *   - Each `positions.close()` is wrapped in its own try/catch.
   *   - The whole method is wrapped in a top-level try/catch.
   *   - Positions.list / Positions.close failures log + return;
   *     they never throw out of the method.
   *
   * @param {Date} now
   * @param {number} nowMs
   * @param {Map<string, Object>|undefined} statsIndex  the per-token stats index the tick already built
   * @returns {Promise<void>}
   * @private
   */
  async _maybeAutoCloseDustPositions(now, nowMs, statsIndex) {
    // 1. Knob gate — only an explicit `true` enables the path.
    const cfg = this.cfg || {};
    const riskCfg = (cfg && typeof cfg === 'object' && cfg.risk && typeof cfg.risk === 'object')
      ? cfg.risk
      : {};
    if (riskCfg.dust_position_auto_close_enabled !== true) {
      return;
    }

    // 2. Fetch open positions. Defensive: a positions.list
    //    failure can't kill the tick (matches the T62 orphan
    //    auto-reconcile pattern).
    let openPositions = [];
    try {
      const list = await this.positions.list('open');
      openPositions = Array.isArray(list) ? list : [];
    } catch (e) {
      this.logger.warn('loop.dust_position_auto_close.positions.error', {
        event: 'loop.dust_position_auto_close.positions',
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
      });
      return;
    }

    if (openPositions.length === 0) {
      this.logger.info('loop.dust_position_auto_close.done', {
        event: 'loop.dust_position_auto_close.done',
        open_positions: 0,
        evaluated: 0,
        dust: 0,
        closed: 0,
        failed: 0,
        skipped_no_price: 0,
        skipped_override: 0,
      });
      return;
    }

    // 3. Build the price index from the tick's existing
    //    `statsIndex`. Coerce bigint → number (the dust math
    //    is regular-number based; the bigint is just for
    //    snapshot-precision).
    /** @type {Record<string, number>} */
    const priceIndex = {};
    let skippedNoPrice = 0;
    if (statsIndex instanceof Map) {
      for (const [tid, stats] of statsIndex.entries()) {
        if (stats && Number.isFinite(stats.price_now_sats) && stats.price_now_sats > 0) {
          priceIndex[tid] = Number(stats.price_now_sats);
        }
      }
    }
    if (Object.keys(priceIndex).length === 0) {
      this.logger.warn('loop.dust_position_auto_close.no_prices', {
        event: 'loop.dust_position_auto_close.no_prices',
        open_positions: openPositions.length,
        reason: 'statsIndex missing or empty',
      });
      return;
    }

    // 4. Resolve the dust config (defensive; never throws).
    const dustCfg = resolveDustConfig(this.cfg).config;

    // 5. Run the pure dust-detection pass.
    let findings;
    try {
      findings = findDustPositions(openPositions, priceIndex, { config: dustCfg });
    } catch (e) {
      this.logger.warn('loop.dust_position_auto_close.find.error', {
        event: 'loop.dust_position_auto_close.find',
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
      });
      return;
    }

    const dustItems = findings.filter((f) => f.dust_info && f.dust_info.is_dust);
    const skippedItems = findings.filter((f) => f.skipped === true);
    skippedNoPrice = skippedItems.length;

    if (dustItems.length === 0) {
      this.logger.info('loop.dust_position_auto_close.done', {
        event: 'loop.dust_position_auto_close.done',
        open_positions: openPositions.length,
        evaluated: findings.length,
        dust: 0,
        closed: 0,
        failed: 0,
        skipped_no_price: skippedNoPrice,
        skipped_override: 0,
      });
      return;
    }

    // 6. Close each dust position. Each close is wrapped in
    //    its own try/catch so a single bad `positions.close()`
    //    throw can't kill the rest of the tick.
    let closed = 0;
    let failed = 0;
    const failedErrors = [];
    for (const item of dustItems) {
      const position = item.position;
      const dustInfo = item.dust_info;
      const positionId = (position && typeof position === 'object' && typeof position.id === 'string')
        ? position.id
        : null;
      let exitBlock;
      try {
        exitBlock = buildDustCloseExitBlock(position, dustInfo, { nowMs });
      } catch (e) {
        failed += 1;
        const errMsg = (e && typeof e === 'object' && typeof e.message === 'string') ? e.message : String(e);
        failedErrors.push({ position_id: positionId, stage: 'build_exit_block', error: errMsg });
        this.logger.warn('loop.dust_position_auto_close.build_exit.error', {
          event: 'loop.dust_position_auto_close.build_exit',
          position_id: positionId,
          err_name: e?.name ?? 'Error',
          err_message: errMsg,
        });
        continue;
      }

      try {
        await this.positions.close(
          positionId,
          exitBlock,
          exitBlock.realized_pnl_sats,
        );
        closed += 1;
      } catch (e) {
        // `Positions.close()` is contracted to never throw on
        // structural errors (it throws PositionsNotFoundError /
        // PositionsStateError on real bugs). Either way, we
        // catch + log so a bad close can't kill the tick.
        failed += 1;
        const errMsg = (e && typeof e === 'object' && typeof e.message === 'string') ? e.message : String(e);
        failedErrors.push({ position_id: positionId, stage: 'positions_close', error: errMsg });
        this.logger.warn('loop.dust_position_auto_close.close.error', {
          event: 'loop.dust_position_auto_close.close',
          position_id: positionId,
          err_name: e?.name ?? 'Error',
          err_message: errMsg,
        });
        continue;
      }

      // Append the audit row via the existing history seam so
      // the dashboard / P&L rollups see the synthetic close
      // immediately and the audit trail records WHY.
      try {
        const auditRecord = {
          kind: DUST_CLOSE_REASON,
          ts: exitBlock.ts,
          ts_ms: nowMs,
          position_id: positionId,
          token_id: (position && typeof position.token_id === 'string') ? position.token_id : null,
          side: (position && typeof position.side === 'string') ? position.side : null,
          entry_price_sats_per_token: (position && position.entry && Number.isFinite(position.entry.price_sats_per_token))
            ? position.entry.price_sats_per_token : null,
          current_value_sats: dustInfo.current_value_sats,
          total_cost_sats: dustInfo.total_cost_sats,
          net_recoverable_sats: dustInfo.net_recoverable_sats,
          ratio_cost_to_proceeds: (Number.isFinite(dustInfo.ratio_cost_to_proceeds) ? dustInfo.ratio_cost_to_proceeds : null),
          budget_threshold_sats: dustInfo.budget_threshold_sats,
          tx_fee_sats: dustInfo.tx_fee_sats,
          slippage_cost_sats: dustInfo.slippage_cost_sats,
          realized_pnl_sats: exitBlock.realized_pnl_sats,
          reasons: dustInfo.reasons,
        };
        await this._safeHistoryAppend(auditRecord);
      } catch (e) {
        // `_safeHistoryAppend` already catches + logs internally;
        // this is just belt-and-suspenders.
        this.logger.warn('loop.dust_position_auto_close.audit.error', {
          event: 'loop.dust_position_auto_close.audit',
          position_id: positionId,
          err_name: e?.name ?? 'Error',
          err_message: e?.message ?? String(e),
        });
      }
    }

    // 7. Emit the per-tick audit line.
    this.logger.info('loop.dust_position_auto_close.done', {
      event: 'loop.dust_position_auto_close.done',
      open_positions: openPositions.length,
      evaluated: findings.length,
      dust: dustItems.length,
      closed,
      failed,
      skipped_no_price: skippedNoPrice,
      skipped_override: openPositions.length - findings.length,
    });
  }

  /**
   * T70: pre-entry auto-consolidation helper. Called from
   * `_processCandidate` step 5a-t60 when
   * `analyzeUtxoFragmentation` reports `needsConsolidation:true`
   * AND `risk.utxo_consolidation_auto_enabled:true` AND the
   * wallet balance covers `risk.utxo_consolidation_min_balance_bch`.
   *
   * Behavior:
   *   1. Refusal guards (auto-consolidate REFUSES when ANY is true):
   *      (i)  `t60Analysis.consolidatedCount < 2` — single-UTXO
   *           wallet is a no-op.
   *      (ii) `t60Analysis.largestSats >= requiredSats` — no
   *           fragmentation actually present (operator opted in
   *           but the trade would have fit).
   *      (iii) any consolidated UTXO carries a cashtoken amount
   *           (`u.token?.amount`) — refuse to consolidate a UTXO
   *           that holds cashtokens (could be a position, dust,
   *           or NFT).
   *      (iv) `walletBalanceBch - min_wallet_balance_bch` can't
   *           cover the conservative fee estimate. We short-circuit
   *           BEFORE calling executeConsolidationTx so the loop
   *           never spends from the reserve.
   *      (v)  any of the broadcast / WIF / execute seams are
   *           missing — the loop refuses so a partial wiring can't
   *           fire a half-built tx.
   *   2. Success path: call `_utxoConsolidationExecute(...)` with
   *      `inputs = t60Analysis.consolidatedUtxos`,
   *      `outputAddress = wallet address`, `wif = _utxoConsolidationWif`,
   *      `broadcast = _utxoConsolidationBroadcast`, plus the wallet
   *      network. Emit `history.jsonl` event
   *      `{kind:'utxo_consolidation_auto', ...}` + structured
   *      `loop.utxo_consolidation.auto.success` log.
   *   3. Failure path: emit `entry_skipped` with kind
   *      `utxo_consolidation_failed` (with the underlying error)
   *      + structured `loop.utxo_consolidation.auto.error` warn
   *      line. Refusals emit kind `utxo_consolidation_refused`
   *      with the guard that tripped + a structured
   *      `loop.utxo_consolidation.auto.refused` warn.
   *
   * Defensive: any throw from the orchestrator is caught +
   * logged + surfaced as `utxo_consolidation_failed`. The tick
   * never crashes on a broadcast blip.
   *
   * @param {Object} args
   * @param {string} args.tokenId
   * @param {Object} args.t60Analysis   `analyzeUtxoFragmentation` envelope
   * @param {Array}  args.t60Utxos      raw UTXO list (cashscript shape)
   * @param {bigint|null} args.requiredSats
   * @param {number} args.minBalanceBch
   * @param {number} args.maxPosBch
   * @param {Object} args.t60Cfg        `cfg.risk` slice
   * @param {Object} args.portfolioState
   * @returns {Promise<{
   *   skipEntry: boolean,
   *   reason?: string,
   *   kind?: string,
   *   consolidationAttempted?: boolean,
   *   reasoningExtra?: Object,
   * }>}
   * @private
   */
  async _maybeAutoConsolidate({
    tokenId,
    t60Analysis,
    t60Utxos,
    requiredSats,
    minBalanceBch,
    maxPosBch,
    t60Cfg,
    portfolioState,
  }) {
    // Guard (i): single-UTXO wallet is a no-op.
    if (t60Analysis.consolidatedCount < 2) {
      this.logger.warn('loop.utxo_consolidation.auto.refused', {
        event: 'loop.utxo_consolidation.auto',
        reason: 'single_utxo',
        consolidated_count: t60Analysis.consolidatedCount,
        trigger_token_id: tokenId,
      });
      return {
        skipEntry: true,
        kind: 'utxo_consolidation_refused',
        reason: `auto-consolidation refused: only ${t60Analysis.consolidatedCount} above-dust UTXO — nothing to consolidate`,
        reasoningExtra: { refusal_reason: 'single_utxo' },
      };
    }
    // Guard (ii): largest UTXO already fits the trade.
    if (requiredSats !== null && t60Analysis.largestSats >= requiredSats) {
      this.logger.warn('loop.utxo_consolidation.auto.refused', {
        event: 'loop.utxo_consolidation.auto',
        reason: 'largest_fits',
        largest_utxo_sats: t60Analysis.largestSats.toString(),
        required_sats: requiredSats.toString(),
        trigger_token_id: tokenId,
      });
      return {
        skipEntry: true,
        kind: 'utxo_consolidation_refused',
        reason: `auto-consolidation refused: largest UTXO ${t60Analysis.largestSats.toString()} sats already covers required ${requiredSats.toString()} sats`,
        reasoningExtra: { refusal_reason: 'largest_fits' },
      };
    }
    // Guard (iii): any consolidated UTXO carries cashtokens.
    const tokenBearing = (Array.isArray(t60Analysis.consolidatedUtxos) ? t60Analysis.consolidatedUtxos : [])
      .find((u) => u && typeof u === 'object' && u.token && typeof u.token === 'object'
        && (u.token.amount !== undefined && u.token.amount !== null && u.token.amount !== '' && u.token.amount !== 0));
    if (tokenBearing) {
      this.logger.warn('loop.utxo_consolidation.auto.refused', {
        event: 'loop.utxo_consolidation.auto',
        reason: 'token_bearing_utxo',
        consolidated_count: t60Analysis.consolidatedCount,
        trigger_token_id: tokenId,
      });
      return {
        skipEntry: true,
        kind: 'utxo_consolidation_refused',
        reason: 'auto-consolidation refused: wallet contains cashtoken-bearing UTXOs — consolidating them risks burning positions, dust, or NFTs',
        reasoningExtra: { refusal_reason: 'token_bearing_utxo' },
      };
    }
    // Guard (iv): reserve can't cover the fee.
    const feeSatPerByte = Number(t60Cfg.utxo_consolidation_fee_sat_per_byte ?? 1);
    const safeFeeRate = (Number.isFinite(feeSatPerByte) && feeSatPerByte > 0) ? feeSatPerByte : 1;
    // Mirror executeConsolidationTx's fee math (10 + N*180 + 34 bytes
    // for one P2PKH output). Pure helper; no I/O.
    const inputCount = t60Analysis.consolidatedCount;
    const feeSats = BigInt(Math.ceil((10 + (inputCount * 180) + 34) * safeFeeRate));
    const reserveSats = BigInt(Math.floor((portfolioState.walletBalanceBch - (Number.isFinite(minBalanceBch) ? minBalanceBch : 0)) * 1e8));
    if (reserveSats <= feeSats) {
      this.logger.warn('loop.utxo_consolidation.auto.refused', {
        event: 'loop.utxo_consolidation.auto',
        reason: 'fee_reserve_breach',
        fee_sats: feeSats.toString(),
        reserve_sats: reserveSats.toString(),
        wallet_balance_bch: portfolioState.walletBalanceBch,
        min_wallet_balance_bch: Number.isFinite(minBalanceBch) ? minBalanceBch : null,
        trigger_token_id: tokenId,
      });
      return {
        skipEntry: true,
        kind: 'utxo_consolidation_refused',
        reason: `auto-consolidation refused: reserve ${reserveSats.toString()} sats can't cover fee ${feeSats.toString()} sats at ${safeFeeRate} sat/byte`,
        reasoningExtra: {
          refusal_reason: 'fee_reserve_breach',
          estimated_fee_sats: feeSats.toString(),
          reserve_sats: reserveSats.toString(),
          fee_sat_per_byte: safeFeeRate,
        },
      };
    }
    // Guard (v): broadcast / WIF / execute seams must all be wired.
    if (typeof this._utxoConsolidationExecute !== 'function') {
      this.logger.warn('loop.utxo_consolidation.auto.refused', {
        event: 'loop.utxo_consolidation.auto',
        reason: 'execute_seam_missing',
        trigger_token_id: tokenId,
      });
      return {
        skipEntry: true,
        kind: 'utxo_consolidation_refused',
        reason: 'auto-consolidation refused: utxoConsolidationExecute seam is not wired (loop constructor default missing)',
        reasoningExtra: { refusal_reason: 'execute_seam_missing' },
      };
    }
    if (typeof this._utxoConsolidationBroadcast !== 'function') {
      this.logger.warn('loop.utxo_consolidation.auto.refused', {
        event: 'loop.utxo_consolidation.auto',
        reason: 'seam_missing',
        missing_seam: 'utxoConsolidationBroadcast',
        trigger_token_id: tokenId,
      });
      return {
        skipEntry: true,
        kind: 'utxo_consolidation_seam_missing',
        reason: 'auto-consolidation refused: utxoConsolidationBroadcast seam is not wired (production wires it in scripts/run-bot.mjs)',
        reasoningExtra: { refusal_reason: 'broadcast_seam_missing' },
      };
    }
    if (typeof this._utxoConsolidationWif !== 'string' || this._utxoConsolidationWif.length < 40) {
      this.logger.warn('loop.utxo_consolidation.auto.refused', {
        event: 'loop.utxo_consolidation.auto',
        reason: 'no_wif',
        trigger_token_id: tokenId,
      });
      return {
        skipEntry: true,
        kind: 'utxo_consolidation_no_wif',
        reason: 'auto-consolidation refused: utxoConsolidationWif seam is not wired (production wires it from resolveWif(...) in scripts/run-bot.mjs)',
        reasoningExtra: { refusal_reason: 'no_wif' },
      };
    }
    // Guard: wallet.getAddress() must return a string.
    const outputAddress = (this.wallet && typeof this.wallet.getAddress === 'function')
      ? this.wallet.getAddress()
      : null;
    if (typeof outputAddress !== 'string' || outputAddress.length === 0) {
      this.logger.warn('loop.utxo_consolidation.auto.refused', {
        event: 'loop.utxo_consolidation.auto',
        reason: 'no_wallet_address',
        trigger_token_id: tokenId,
      });
      return {
        skipEntry: true,
        kind: 'utxo_consolidation_refused',
        reason: 'auto-consolidation refused: wallet.getAddress() returned an empty/non-string value',
        reasoningExtra: { refusal_reason: 'no_wallet_address' },
      };
    }
    // Guard: wallet.getNetwork() must return a known network.
    const network = (this.wallet && typeof this.wallet.getNetwork === 'function')
      ? this.wallet.getNetwork()
      : 'mainnet';

    // All guards passed — fire the consolidation tx.
    const before = {
      utxo_count: Array.isArray(t60Utxos) ? t60Utxos.length : 0,
      largest_sats: t60Analysis.largestSats.toString(),
      total_sats: t60Analysis.totalSats.toString(),
    };
    let envelope;
    try {
      envelope = await this._utxoConsolidationExecute({
        inputs: t60Analysis.consolidatedUtxos,
        outputAddress,
        feeSatPerByte: safeFeeRate,
        wif: this._utxoConsolidationWif,
        network,
        broadcast: this._utxoConsolidationBroadcast,
        logger: this.logger,
      });
    } catch (e) {
      const errName = (e && typeof e === 'object' && typeof e.name === 'string') ? e.name : 'Error';
      const errMsg = (e && typeof e === 'object' && typeof e.message === 'string') ? e.message : String(e);
      this.logger.warn('loop.utxo_consolidation.auto.error', {
        event: 'loop.utxo_consolidation.auto',
        stage: 'execute_throw',
        err_name: errName,
        err_message: errMsg,
        trigger_token_id: tokenId,
      });
      return {
        skipEntry: true,
        kind: 'utxo_consolidation_failed',
        reason: `auto-consolidation failed: orchestrator threw ${errName}: ${errMsg}`,
        reasoningExtra: {
          refusal_reason: 'execute_threw',
          error_name: errName,
          error_message: errMsg,
        },
      };
    }
    if (!envelope || envelope.ok !== true) {
      const errMsg = (envelope && typeof envelope.error === 'string') ? envelope.error : 'unknown';
      this.logger.warn('loop.utxo_consolidation.auto.error', {
        event: 'loop.utxo_consolidation.auto',
        stage: 'envelope_not_ok',
        error: errMsg,
        envelope: envelope ?? null,
        trigger_token_id: tokenId,
      });
      return {
        skipEntry: true,
        kind: 'utxo_consolidation_failed',
        reason: `auto-consolidation failed: ${errMsg}`,
        reasoningExtra: {
          refusal_reason: 'envelope_not_ok',
          error: errMsg,
        },
      };
    }
    // Success — emit history + structured log. The `after`
    // snapshot is approximate (1 output = the consolidation
    // target). The next tick will refresh `wallet.listUtxos()`
    // and the on-chain `after` will be authoritative.
    const after = {
      utxo_count: 1,
      largest_sats: envelope.output_sats,
      total_sats: envelope.output_sats,
    };
    const successRecord = {
      kind: 'utxo_consolidation_auto',
      ts: Date.now(),
      txid: envelope.txid ?? null,
      input_count: envelope.input_count,
      output_count: envelope.output_count,
      total_input_sats: envelope.total_in_sats,
      total_output_sats: envelope.output_sats,
      fee_sats: envelope.fee_sats,
      broadcast_ms: envelope.broadcast_ms,
      source: envelope.source ?? 'broadcast',
      trigger_token_id: tokenId,
      before,
      after,
    };
    try {
      await this._safeHistoryAppend(successRecord);
    } catch (e) {
      this.logger.warn('loop.utxo_consolidation.auto.audit.error', {
        event: 'loop.utxo_consolidation.auto',
        stage: 'history_append',
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
      });
      // Don't fail the tick on an audit-write blip.
    }
    this.logger.info('loop.utxo_consolidation.auto.success', {
      event: 'loop.utxo_consolidation.auto',
      txid: envelope.txid ?? null,
      input_count: envelope.input_count,
      output_count: envelope.output_count,
      total_input_sats: envelope.total_in_sats,
      total_output_sats: envelope.output_sats,
      fee_sats: envelope.fee_sats,
      broadcast_ms: envelope.broadcast_ms,
      source: envelope.source ?? 'broadcast',
      trigger_token_id: tokenId,
      before,
      after,
    });
    // Return success: caller will skip the entry and let the next
    // tick re-evaluate with the freshly-consolidated wallet.
    return {
      skipEntry: true,
      kind: 'utxo_consolidation_auto_fired',
      reason: `wallet fragmented — auto-consolidation txid=${envelope.txid ?? '(pending)'} fired (${envelope.input_count} inputs → 1 output, ${envelope.fee_sats} sat fee); entry deferred to next tick after confirmation`,
      consolidationAttempted: true,
      reasoningExtra: {
        consolidation_txid: envelope.txid ?? null,
        consolidation_fee_sats: envelope.fee_sats,
        consolidation_input_count: envelope.input_count,
        consolidation_output_count: envelope.output_count,
        consolidation_total_input_sats: envelope.total_in_sats,
        consolidation_total_output_sats: envelope.output_sats,
        consolidation_broadcast_ms: envelope.broadcast_ms,
        consolidation_source: envelope.source ?? 'broadcast',
      },
    };
  }

  // ────────────────────────────────────────────────────────────────────
  //  T76 subset 2b — Live holders-based rug-pattern eligibility gate
  // ────────────────────────────────────────────────────────────────────

  /**
   * T76 subset 2b: read `cfg.scoring.concentration_rug_enabled`
   * defensively. Mirrors `isConcentrationRugEnabled` from
   * `src/dashboard/token-holders.mjs` (the same knob gates the
   * dashboard endpoint + the trader-loop eligibility check). Returns
   * `false` for missing ctx / missing cfg / missing scoring section
   * / non-boolean values. Pure.
   * @returns {boolean}
   * @private
   */
  _isRugPatternGateEnabled() {
    const cfg = (this.cfg && typeof this.cfg === 'object') ? this.cfg : null;
    if (!cfg) return false;
    const sc = (cfg.scoring && typeof cfg.scoring === 'object') ? cfg.scoring : null;
    if (!sc) return false;
    return sc.concentration_rug_enabled === true;
  }

  /**
   * T76 subset 2b: read the rug-pattern config knobs (`top_n` /
   * `threshold_pct` / `epsilon_pct`) defensively. Returns the
   * `DEFAULT_HOLDER_CONCENTRATION_CONFIG` shape with the values
   * from `cfg.scoring` overlaid where present + finite. Pure.
   * @returns {{rug_top_n: number, rug_threshold_pct: number, epsilon_pct: number}}
   * @private
   */
  _rugPatternConfig() {
    const out = {
      rug_top_n: 5,
      rug_threshold_pct: 80,
      epsilon_pct: 1.0,
    };
    const cfg = (this.cfg && typeof this.cfg === 'object') ? this.cfg : null;
    const sc = (cfg && cfg.scoring && typeof cfg.scoring === 'object') ? cfg.scoring : null;
    if (!sc) return out;
    const topN = Number(sc.concentration_rug_top_n);
    if (Number.isFinite(topN) && topN > 0) out.rug_top_n = Math.floor(topN);
    const thr = Number(sc.concentration_rug_threshold_pct);
    if (Number.isFinite(thr) && thr >= 0) out.rug_threshold_pct = thr;
    const eps = Number(sc.concentration_rug_epsilon_pct);
    if (Number.isFinite(eps) && eps >= 0) out.epsilon_pct = eps;
    return out;
  }

  /**
   * T76 subset 2b: the actual live holders-based rug-pattern
   * eligibility check. Wired into the entry pipeline as a NEW
   * gate between `canOpen` and `swap.execute` — it's the LAST gate
   * before the swap fires so a rug pattern is the final
   * (and only) reason to skip an entry.
   *
   * Refusal guards (mirror the dashboard's defensive posture from
   * subset 2a):
   *   (i)   `scoring.concentration_rug_enabled !== true` →
   *         `{shouldSkip:false, reason:'gate_disabled'}` (zero
   *         per-tick fetch; the existing `_excludedTokenSet()`
   *         blacklist + `applyEligibilityGates()` continue to do
   *         their job).
   *   (ii)  No cache seam wired (`_holdersScannerCache === null`)
   *         AND the gate is enabled → `{shouldSkip:false,
   *         reason:'unwired'}` + a structured
   *         `loop.rug_pattern.unwired` warn line. This is the
   *         subset 1 fallback: an operator who flipped the
   *         production knob without restarting the bot never
   *         gets a per-tick fetch explosion.
   *   (iii) Resolver returns `error:'token_not_found'` →
   *         `{shouldSkip:false, reason:'token_not_found'}`. We
   *         do NOT punish tokens the upstream hasn't indexed yet.
   *   (iv)  Resolver returns `error:'invalid_token_id'` →
   *         `{shouldSkip:false, reason:'invalid_token_id'}`
   *         (defensive: a malformed token_id should never crash
   *         a tick).
   *   (v)   Resolver returns `error:'scanner_unexpected_throw'`
   *         or any other upstream failure →
   *         `{shouldSkip:false, reason:'scanner_error',
   *         scanner_error:<envelope error>}`. We pass through
   *         (defensive: better to consider a token than to
   *         silently never enter).
   *   (vi)  Resolver throws (which `resolveHoldersSnapshot`
   *         documents NEVER happens, but we wrap defensively) →
   *         `{shouldSkip:false, reason:'unexpected_throw'}`.
   *
   * Happy path: returns the audit shape from
   * `extractRugPatternAuditFromResolver` so the loop can populate
   * the `entry_skipped` reasoning blob verbatim:
   *   `{shouldSkip:rugPattern, audit:{rug_pattern, error,
   *     top_n, threshold_pct, top_n_pct, total_supply_base,
   *     holders_count, upstream, cached, cache_age_ms,
   *     snapshot_at_unix_s}, reason:null, gateEnabled:true}`
   *
   * @param {string} tokenId  validated lowercase 64-hex token_id
   * @returns {Promise<{
   *   shouldSkip: boolean,
   *   reason: string|null,
   *   gateEnabled: boolean,
   *   audit: Object,
   * }>}
   * @private
   */
  async _checkRugPatternEligible(tokenId) {
    const metrics = this._rugPatternCheckThisTick || null;
    const gateEnabled = this._isRugPatternGateEnabled();
    if (!gateEnabled) {
      if (metrics) metrics.skipped_unwired_count = (metrics.skipped_unwired_count || 0) + 1;
      return {
        shouldSkip: false,
        reason: 'gate_disabled',
        gateEnabled: false,
        audit: { rug_pattern: false, error: null, gate_disabled: true },
      };
    }
    if (this._holdersScannerCache === null) {
      if (metrics) {
        metrics.skipped_unwired_count = (metrics.skipped_unwired_count || 0) + 1;
        metrics.error_count = (metrics.error_count || 0) + 1;
      }
      this.logger.warn('loop.rug_pattern.unwired', {
        event: 'loop.rug_pattern',
        reason: 'unwired',
        token_id: tokenId,
        message: 'scoring.concentration_rug_enabled is true but loop.holdersScannerCache is null — falling back to subset 1 behavior. Wire a HoldersScannerCache in scripts/run-bot.mjs to enable the live check.',
      });
      return {
        shouldSkip: false,
        reason: 'unwired',
        gateEnabled: true,
        audit: { rug_pattern: false, error: 'unwired' },
      };
    }
    if (typeof tokenId !== 'string' || !/^[0-9a-f]{64}$/i.test(tokenId)) {
      return {
        shouldSkip: false,
        reason: 'invalid_token_id',
        gateEnabled: true,
        audit: { rug_pattern: false, error: 'invalid_token_id' },
      };
    }
    const scannerOpts = {
      ...(this._holdersScannerProviderUrl !== null
        ? { baseUrl: this._holdersScannerProviderUrl } : {}),
      ...(this._holdersScannerTimeoutMs !== null
        ? { timeoutMs: this._holdersScannerTimeoutMs } : {}),
    };
    /** @type {Object} */
    let resolverR;
    try {
      resolverR = await resolveHoldersSnapshot({
        tokenId,
        cache: this._holdersScannerCache,
        ...(this._holdersScannerFetcher !== null
          ? { fetcher: this._holdersScannerFetcher } : {}),
        scannerOpts,
      });
    } catch (e) {
      if (metrics) metrics.error_count = (metrics.error_count || 0) + 1;
      this.logger.warn('loop.rug_pattern.unexpected_throw', {
        event: 'loop.rug_pattern',
        reason: 'unexpected_throw',
        token_id: tokenId,
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
      });
      return {
        shouldSkip: false,
        reason: 'unexpected_throw',
        gateEnabled: true,
        audit: {
          rug_pattern: false,
          error: 'unexpected_throw',
          message: (e && e.message) ? e.message : 'resolveHoldersSnapshot threw',
        },
      };
    }
    const audit = extractRugPatternAuditFromResolver(resolverR, this._rugPatternConfig());
    if (metrics) {
      metrics.checked_count = (metrics.checked_count || 0) + 1;
      if (audit && audit.cached === true) {
        metrics.cache_hit_count = (metrics.cache_hit_count || 0) + 1;
      }
      if (audit && audit.token_not_found === true) {
        metrics.token_not_found_count = (metrics.token_not_found_count || 0) + 1;
      }
      if (audit && audit.error && audit.error !== 'token_not_found') {
        metrics.error_count = (metrics.error_count || 0) + 1;
      }
      if (audit && audit.rug_pattern === true) {
        metrics.detected_count = (metrics.detected_count || 0) + 1;
      }
    }
    if (audit && audit.error === 'token_not_found') {
      return {
        shouldSkip: false,
        reason: 'token_not_found',
        gateEnabled: true,
        audit,
      };
    }
    if (audit && audit.error && audit.error !== null && audit.rug_pattern === false) {
      // Any other scanner error → pass through with the audit blob
      // so the operator's structured log + dashboard health probe
      // can surface it without blocking the entry.
      this.logger.warn('loop.rug_pattern.scanner_error', {
        event: 'loop.rug_pattern',
        reason: 'scanner_error',
        token_id: tokenId,
        scanner_error: audit.error,
        upstream: audit.upstream ?? null,
        cached: audit.cached === true,
      });
      return {
        shouldSkip: false,
        reason: 'scanner_error',
        gateEnabled: true,
        audit,
      };
    }
    if (audit && audit.rug_pattern === true) {
      this.logger.warn('loop.rug_pattern.detected', {
        event: 'loop.rug_pattern',
        reason: 'rug_pattern_detected',
        token_id: tokenId,
        top_n_pct: audit.top_n_pct ?? null,
        holders_count: audit.holders_count ?? null,
        threshold_pct: audit.threshold_pct ?? null,
        top_n: audit.top_n ?? null,
        upstream: audit.upstream ?? null,
        cached: audit.cached === true,
        cache_age_ms: audit.cache_age_ms ?? 0,
      });
      return {
        shouldSkip: true,
        reason: null,
        gateEnabled: true,
        audit,
      };
    }
    return {
      shouldSkip: false,
      reason: null,
      gateEnabled: true,
      audit,
    };
  }

  async _maybeAutoStake(now, nowMs) {
    const cfg = this.cfg || {};
    const stakeCfg = cfg.staking || {};
    // Master switch.
    if (stakeCfg.enabled !== true) return;
    if (stakeCfg.simulation_only === true) {
      this.logger.info('loop.stake.simulation_only', {
        event: 'loop.stake.simulation_only',
        reason: 'simulation_only is true; auto-wire is a no-op',
      });
      return;
    }

    // Provider seam — refuse to act if the boot path didn't wire
    // one in. A missing provider means the run-bot script needs
    // an update, not a config flip.
    if (!this._stakingProvider || typeof this._stakingProvider.sendRawTransaction !== 'function') {
      this.logger.warn('loop.stake.provider.missing', {
        event: 'loop.stake.provider',
        reason: 'stakingProvider seam is not wired; auto-wire cannot dispatch',
      });
      return;
    }

    // Wallet UTXO fetch (defensive — both listUtxos throws AND
    // non-array returns are caught). We don't reuse the orphan-
    // check wallet fetch because: (a) timing-wise we want a fresh
    // UTXO set right before the staking decision, and (b) the
    // orphan check is wrapped in its own try/catch and we don't
    // want a failure in that path to silence the staking path.
    let utxos;
    try {
      if (!this.wallet || typeof this.wallet.listUtxos !== 'function') {
        this.logger.warn('loop.stake.wallet.missing_listUtxos', {
          event: 'loop.stake.wallet',
          reason: 'wallet.listUtxos is not a function',
        });
        return;
      }
      const u = await this.wallet.listUtxos();
      utxos = Array.isArray(u) ? u : [];
    } catch (e) {
      this.logger.warn('loop.stake.wallet.error', {
        event: 'loop.stake.wallet',
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
      });
      return;
    }

    const lockNftCount = countLockNfts(utxos);
    const results = [];

    // Sub-path A: auto-LOCK.
    if (stakeCfg.auto_lock_enabled === true) {
      const lockResult = await this._maybeAutoLock({
        stakeCfg,
        utxos,
        lockNftCount,
        nowMs,
      });
      if (lockResult) results.push(lockResult);
    }

    // Sub-path B: auto-UNLOCK.
    if (stakeCfg.auto_unlock_enabled === true) {
      const unlockResult = await this._maybeAutoUnlock({
        stakeCfg,
        utxos,
        lockNftCount,
        nowMs,
      });
      if (unlockResult) results.push(unlockResult);
    }

    // Route every dispatch through `dispatchStakeAlert` so the
    // operator gets a row in `data/alerts.jsonl` + a channel
    // notification on every dispatch. Belt-and-suspenders wrap:
    // the dispatch wrapper already promises never to throw, but
    // we double-guard so a future refactor that breaks the
    // contract can't kill the tick.
    if (results.length === 0) {
      this.logger.info('loop.stake.no_dispatch', {
        event: 'loop.stake.no_dispatch',
        lockNftCount,
      });
      return;
    }
    let dispatchResult = null;
    try {
      dispatchResult = await this._stakingDispatch({
        router: this._safeAlertDispatch ?? null,
        appender: this._alertsAppend ?? null,
        results,
        nowMs,
        logger: this.logger,
      });
    } catch (e) {
      this.logger.warn('loop.stake.dispatch.unexpected_throw', {
        event: 'loop.stake.dispatch',
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
      });
      return;
    }
    this.logger.info('loop.stake.done', {
      event: 'loop.stake.done',
      lockNftCount,
      dispatch_results: results.length,
      dispatched: (dispatchResult && typeof dispatchResult.dispatched === 'number') ? dispatchResult.dispatched : 0,
      persisted: (dispatchResult && typeof dispatchResult.persisted === 'number') ? dispatchResult.persisted : 0,
      failed: (dispatchResult && typeof dispatchResult.failed === 'number') ? dispatchResult.failed : 0,
    });
  }

  /**
   * T58 subset 3 — Auto-LOCK sub-path. Returns the dispatch
   * result envelope from `executeLock` (or `null` when the guard
   * chain declined to fire). Pure orchestration: every guard
   * failure is a structured log line + a `null` return.
   *
   * Guards (all must pass for the orchestrator to fire):
   *   1. `countLockNfts(utxos) === 0` — refuse to stack a
   *      second BadgerStake position while one is already
   *      active. (Subset 2's `executeLock` also refuses, but
   *      this surface gives the operator a clearer log line.)
   *   2. `walletBalanceSats >= lockMinBalanceSats + maxPositionSats`
   *      — keep enough BCH for the next trade after the lock.
   *   3. `(allowWhenPositionsOpen || openPositions.length === 0)`
   *      — conservative default: don't lock while trades are
   *      mid-flight.
   *
   * @private
   */
  async _maybeAutoLock({ stakeCfg, utxos, lockNftCount, nowMs }) {
    if (lockNftCount !== 0) {
      this.logger.info('loop.stake.lock.skipped', {
        event: 'loop.stake.lock.skipped',
        reason: 'lockNFT already present',
        lock_nft_count: lockNftCount,
      });
      return null;
    }
    // T75 (BadgerCoin staking live wire) — the lock amount is
    // **half of the wallet's available BCH**, computed from the
    // current UTXO set on every tick (not a fixed `lock_amount_sats`
    // knob). Operator spec: a single BadgerStake position that
    // uses 50% of the bot's available BCH. The remaining 50% stays
    // in the wallet as the trading reserve.
    //
    // Single-position enforcement is layered at three levels so
    // the invariant survives any one layer failing:
    //   1. `lockNftCount !== 0` short-circuit above (this function).
    //   2. `executeLock` guard 3 (`STALE_LOCK_EXISTS`) inside the
    //      orchestrator (`src/staking/badger-stake-tx.mjs:578`).
    //   3. `cfg.staking.max_active_stakes: 1` (consumer-side; future
    //      work might raise this if the operator wants a ladder).
    const walletBalanceSats = utxos.reduce(
      (acc, u) => acc + BigInt(u?.satoshis ?? u?.sats ?? 0),
      0n,
    );
    if (walletBalanceSats <= 0n) {
      this.logger.warn('loop.stake.lock.skipped', {
        event: 'loop.stake.lock.skipped',
        reason: 'empty_wallet',
        wallet_balance_sats: walletBalanceSats.toString(),
      });
      return null;
    }
    // Half, rounded down via BigInt integer division. With 0.01
    // BCH the lock is exactly 0.005 BCH; with 0.013 the lock is
    // 0.006 BCH and the wallet retains 0.007 BCH. BigInt floors so
    // we never over-lock.
    const lockAmountSats = walletBalanceSats / 2n;
    // Reserve-floor guard: refuse to lock if it would leave the
    // wallet below `cfg.staking.lock_min_balance_bch`. The reserve
    // exists so the trading side has funding; the user spec says
    // open positions don't gate this, but the floor still does.
    const lockMinBalanceBch = Number(stakeCfg.lock_min_balance_bch ?? 0.005);
    const reserveSats = BigInt(Math.floor(lockMinBalanceBch * 1e8));
    if (lockAmountSats < reserveSats) {
      this.logger.warn('loop.stake.lock.skipped', {
        event: 'loop.stake.lock.skipped',
        reason: 'below_min_balance',
        wallet_balance_sats: walletBalanceSats.toString(),
        lock_amount_sats: lockAmountSats.toString(),
        reserve_sats: reserveSats.toString(),
        reserve_bch: lockMinBalanceBch,
      });
      return null;
    }
    // T75 spec: open trading positions do NOT factor into the
    // BadgerStake decision. The previous `allow_when_positions_open`
    // guard is intentionally removed — the operator wants the
    // stake attempt to fire regardless of position state, on the
    // theory that locking half the BCH and keeping positions open
    // is exactly the diversification intent.
    //
    // All guards passed — fire `executeLock`. The orchestrator
    // itself refuses on stale-lock + below-min-balance (subset 2
    // contract), but the loop's surface guards give us a clearer
    // audit trail for the operator.
    let result;
    try {
      result = await this._stakingLockExecute({
        cfg: this.cfg,
        wallet: this.wallet,
        provider: this._stakingProvider,
        amountSats: lockAmountSats.toString(),
        stakeBlocks: Number(stakeCfg.stake_blocks ?? 1440),
        logger: this.logger,
        deps: { nowMs, wif: this._stakingWif },
      });
    } catch (e) {
      this.logger.warn('loop.stake.lock.execute_throw', {
        event: 'loop.stake.lock.execute',
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
      });
      // Return a synthetic envelope so the dispatch wrapper still
      // emits a `stake_failed` alert (otherwise a throw would
      // silently swallow the attempt — bad for the audit trail).
      result = {
        kind: 'lock',
        ok: false,
        code: 'EXECUTE_THREW',
        error: e?.message ?? String(e),
        txid: null,
      };
    }
    this.logger.info('loop.stake.lock.executed', {
      event: 'loop.stake.lock.executed',
      ok: result?.ok === true,
      txid: result?.txid ?? null,
      code: result?.code ?? null,
      error: result?.error ?? null,
    });
    // T70-3: persist to the dedicated stake-attempt NDJSON log so
    // the dashboard's collapsible Status div can show every attempt
    // without grepping the run-bot log. Append is fire-and-forget;
    // a write failure logs but never blocks the tick.
    appendStakeAttempt({
      event: buildStakeAttemptEvent({
        kind: 'lock',
        phase: result?.ok === true ? 'success' : 'failed',
        result,
        context: {
          tick_id: this._tickCount,
          amount_sats: lockAmountSats,
          stake_blocks: Number(stakeCfg.stake_blocks ?? 1440),
          wallet_balance_sats: walletBalanceSats,
          contract_address: stakeCfg.contract_address ?? null,
        },
        nowMs,
      }),
      file: this.cfg?.staking?.attempt_log_file,
    }).then((r) => {
      if (r && r.ok === false) {
        this.logger.warn('loop.stake.lock.attempt_log.write_failed', {
          err_name: 'AppendStakeAttempt',
          err_message: r?.error ?? 'unknown',
        });
      }
    }).catch(() => { /* swallow — best-effort audit log */ });
    return { ...(result || {}), kind: 'lock' };
  }

  /**
   * T58 subset 3 — Auto-UNLOCK sub-path. Returns the dispatch
   * result envelope from `executeUnlock` (or `null` when the
   * guard chain declined to fire). One unlock per tick; the
   * next tick drains the next stale lockNFT.
   *
   * Guards (all must pass for the orchestrator to fire):
   *   1. `countLockNfts(utxos) >= 1` — nothing to unlock.
   *   2. The lock timelock has elapsed: `(currentTipHeight -
   *      lockBlockHeight) >= stakeBlocks + graceBlocks`. The
   *      `graceBlocks` is derived from `lock_unlock_grace_seconds`
   *      divided by the BCH block period (600s ≈ 10min).
   *   3. The decode step succeeds — a malformed commitment
   *      logs a warn and skips the tick rather than dispatching
   *      a tx the contract will reject.
   *
   * @private
   */
  async _maybeAutoUnlock({ stakeCfg, utxos, lockNftCount, nowMs }) {
    if (lockNftCount < 1) {
      // No lockNFT present — no-op (and we don't log this; it's
      // the steady state for a wallet that never staked).
      return null;
    }
    const lockUtxo = findLockNftUtxo(utxos);
    if (!lockUtxo) {
      this.logger.warn('loop.stake.unlock.find_failed', {
        event: 'loop.stake.unlock',
        reason: 'findLockNftUtxo returned null despite count>=1',
        lock_nft_count: lockNftCount,
      });
      return null;
    }
    // Decode the commitment so we know the timelock length. The
    // helper throws on malformed commitments; we catch + log +
    // skip so the loop never crashes on a bad UTXO shape.
    let stakeBlocks;
    try {
      const decoded = decodeLockNftCommitment(getCommitment(lockUtxo));
      stakeBlocks = decoded.stakeBlocks;
    } catch (e) {
      this.logger.warn('loop.stake.unlock.decode_failed', {
        event: 'loop.stake.unlock',
        reason: 'decodeLockNftCommitment threw',
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
      });
      return null;
    }
    if (!Number.isFinite(stakeBlocks) || stakeBlocks <= 0) {
      this.logger.warn('loop.stake.unlock.bad_stake_blocks', {
        event: 'loop.stake.unlock',
        reason: 'decoded stakeBlocks is not a positive integer',
        stake_blocks: stakeBlocks,
      });
      return null;
    }
    // Timelock guard. `lockBlockHeight` is injected by the
    // operator via the `lockUtxo` shape OR defaulted to 0 (which
    // means "never mature" — safe fallback for tests that
    // exercise the refuse path).
    const tipHeight = await this._stakingGetBlockHeight();
    const lockBlockHeight = Number(lockUtxo.lockBlockHeight ?? 0);
    const graceSeconds = Number(stakeCfg.lock_unlock_grace_seconds ?? 60);
    const graceBlocks = Math.ceil(graceSeconds / 600);
    const blocksElapsed = Number(tipHeight) - lockBlockHeight;
    if (blocksElapsed < (stakeBlocks + graceBlocks)) {
      this.logger.info('loop.stake.unlock.skipped', {
        event: 'loop.stake.unlock.skipped',
        reason: 'timelock_not_elapsed',
        tip_height: Number(tipHeight),
        lock_block_height: lockBlockHeight,
        blocks_elapsed: blocksElapsed,
        stake_blocks: stakeBlocks,
        grace_blocks: graceBlocks,
      });
      return null;
    }
    // Fire `executeUnlock`. Same defensive pattern as the lock
    // path: a throw is wrapped in a synthetic envelope so the
    // dispatch wrapper still surfaces the failure.
    let result;
    try {
      result = await this._stakingUnlockExecute({
        cfg: this.cfg,
        wallet: this.wallet,
        provider: this._stakingProvider,
        lockUtxo,
        logger: this.logger,
        deps: { nowMs, wif: this._stakingWif },
      });
    } catch (e) {
      this.logger.warn('loop.stake.unlock.execute_throw', {
        event: 'loop.stake.unlock.execute',
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
      });
      return {
        kind: 'unlock',
        ok: false,
        code: 'EXECUTE_THREW',
        error: e?.message ?? String(e),
        txid: null,
      };
    }
    this.logger.info('loop.stake.unlock.executed', {
      event: 'loop.stake.unlock.executed',
      ok: result?.ok === true,
      txid: result?.txid ?? null,
      code: result?.code ?? null,
      error: result?.error ?? null,
    });
    // T70-3: persist to the dedicated stake-attempt NDJSON log.
    appendStakeAttempt({
      event: buildStakeAttemptEvent({
        kind: 'unlock',
        phase: result?.ok === true ? 'success' : 'failed',
        result,
        context: {
          tick_id: this._tickCount,
          stake_blocks: stakeBlocks,
          lock_utxo: (typeof lockUtxo.txid === 'string' && typeof lockUtxo.vout === 'number')
            ? `${lockUtxo.txid}:${lockUtxo.vout}` : null,
          contract_address: stakeCfg.contract_address ?? null,
        },
        nowMs,
      }),
      file: this.cfg?.staking?.attempt_log_file,
    }).then((r) => {
      if (r && r.ok === false) {
        this.logger.warn('loop.stake.unlock.attempt_log.write_failed', {
          err_name: 'AppendStakeAttempt',
          err_message: r?.error ?? 'unknown',
        });
      }
    }).catch(() => { /* swallow — best-effort audit log */ });
    return { ...(result || {}), kind: 'unlock' };
  }

  async _maybeApplyAdaptiveWeights(now, nowMs) {
    // 1. Knob gate.
    const cfg = this.cfg || {};
    const scoring = cfg.scoring || {};
    const enabledRaw = scoring.adaptive_weights_enabled;
    if (enabledRaw === false) {
      return;
    }
    // Coerce knobs defensively; bad values fall through to the
    // engine's own defaults inside `runAdaptiveWeightsSuggestion`.
    const opts = {
      windowDays: scoring.adaptive_weights_window_days,
      minClosedTrades: scoring.adaptive_weights_min_closed_trades,
      maxDelta: scoring.adaptive_weights_max_delta_per_feature,
      calibrationFloor: scoring.adaptive_weights_calibration_floor,
    };

    // 2. Resolve the seams (lazy default init so we only hit disk
    //    when actually invoked).
    const loadHistory = (typeof this._adaptiveWeightsLoadHistory === 'function')
      ? this._adaptiveWeightsLoadHistory
      : await _defaultAdaptiveWeightsLoadHistory(DEFAULT_HISTORY_FILE);
    const loadUserJson = (typeof this._adaptiveWeightsLoadUserJson === 'function')
      ? this._adaptiveWeightsLoadUserJson
      : await _defaultAdaptiveWeightsLoadUserJson(this._userJsonPath);
    const auditAppend = (typeof this._adaptiveWeightsAuditAppend === 'function')
      ? this._adaptiveWeightsAuditAppend
      : await _defaultAdaptiveWeightsAuditAppend(this._adaptiveWeightsLogPath);
    const writeUserJson = (typeof this._adaptiveWeightsWriteUserJson === 'function')
      ? this._adaptiveWeightsWriteUserJson
      : await _defaultAdaptiveWeightsWriteUserJson(this._userJsonPath);

    // 3. Resolve base weights from cfg.
    const baseWeights = (scoring && scoring.weights && typeof scoring.weights === 'object'
      && !Array.isArray(scoring.weights) && Object.keys(scoring.weights).length > 0)
      ? scoring.weights : null;
    if (!baseWeights) {
      this.logger.info('loop.adaptive_weights.skipped', {
        event: 'loop.adaptive_weights.skipped',
        reason: 'empty_base_weights',
      });
      return;
    }

    // 4. Run the engine. Errors are caught + logged so the loop
    //    survives a corrupt history file or a config drift.
    let envelope;
    try {
      envelope = await this._adaptiveWeightsSuggest({
        loadHistory,
        baseWeights,
        nowMs,
        opts,
      });
    } catch (e) {
      this.logger.warn('loop.adaptive_weights.engine.error', {
        event: 'loop.adaptive_weights.engine',
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
      });
      return;
    }
    if (!envelope || envelope.ok === false) {
      this.logger.warn('loop.adaptive_weights.engine.failed', {
        event: 'loop.adaptive_weights.engine',
        err_kind: (envelope && envelope.error) || 'unknown',
        err_message: (envelope && envelope.error_message) || null,
      });
      return;
    }

    const suggestion = (envelope && envelope.suggestion && typeof envelope.suggestion === 'object')
      ? envelope.suggestion : null;
    if (!suggestion) {
      this.logger.warn('loop.adaptive_weights.engine.malformed', {
        event: 'loop.adaptive_weights.engine',
        reason: 'envelope_missing_suggestion',
      });
      return;
    }

    // 5. Apply (or no-op) through the pure helper.
    let userJson;
    try {
      const loaded = await loadUserJson();
      userJson = (loaded && loaded.exists && loaded.data && typeof loaded.data === 'object')
        ? loaded.data
        : {};
    } catch (e) {
      this.logger.warn('loop.adaptive_weights.user_json.load.error', {
        event: 'loop.adaptive_weights.user_json.load',
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
      });
      return;
    }

    let applyResult;
    try {
      applyResult = this._adaptiveWeightsApply({
        userJson,
        suggestion,
        nowMs,
        windowDays: opts.windowDays,
      });
    } catch (e) {
      this.logger.warn('loop.adaptive_weights.apply.error', {
        event: 'loop.adaptive_weights.apply',
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
      });
      return;
    }
    if (!applyResult || typeof applyResult !== 'object') {
      this.logger.warn('loop.adaptive_weights.apply.malformed', {
        event: 'loop.adaptive_weights.apply',
        reason: 'helper_returned_garbage',
      });
      return;
    }

    // 6. Write the new user.json iff the helper mutated it. A
    //    no-op (below_min_closed_trades / calibration_below_floor /
    //    no_calibration_evidence / empty_base_weights /
    //    all_zero_base_weights / empty_suggested_weights / malformed_suggestion)
    //    skips the write so we never rewrite a file with the same
    //    content — the audit row alone is enough to record the no-op.
    if (applyResult.mutated === true) {
      try {
        await writeUserJson(applyResult.next, this._userJsonPath);
      } catch (e) {
        this.logger.warn('loop.adaptive_weights.user_json.write.error', {
          event: 'loop.adaptive_weights.user_json.write',
          err_name: e?.name ?? 'Error',
          err_message: e?.message ?? String(e),
        });
        // Don't return early — the audit row can still be written
        // so the operator can see that an apply ATTEMPTED and
        // FAILED to persist. The next tick will retry.
      }
    }

    // 7. Build + append the audit row. We pass the (possibly-
    //    mutated) `applyResult.next` so the audit captures the
    //    post-apply `weights_after` value.
    let auditRecord;
    try {
      auditRecord = this._adaptiveWeightsAuditBuilder({
        suggestion,
        userJson: applyResult.next,
        nowMs,
        userJsonPath: this._userJsonPath,
      });
    } catch (e) {
      this.logger.warn('loop.adaptive_weights.audit.build.error', {
        event: 'loop.adaptive_weights.audit.build',
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
      });
      return;
    }
    let line = '';
    try {
      line = JSON.stringify(auditRecord);
    } catch (e) {
      this.logger.warn('loop.adaptive_weights.audit.serialize.error', {
        event: 'loop.adaptive_weights.audit.serialize',
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
      });
      return;
    }
    try {
      await auditAppend(line, this._adaptiveWeightsLogPath);
    } catch (e) {
      this.logger.warn('loop.adaptive_weights.audit.append.error', {
        event: 'loop.adaptive_weights.audit.append',
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
      });
      return;
    }

    // 8. Per-tick audit log so the loop's main logger + the
    //    dashboard's history view see what happened, even on
    //    no-op ticks (applied:false path).
    const applied = suggestion.applied === true;
    const reason = (typeof suggestion.reason === 'string') ? suggestion.reason : null;
    if (applied) {
      this.logger.info('loop.adaptive_weights.applied', {
        event: 'loop.adaptive_weights.applied',
        calibration_correlation: (typeof suggestion.calibrationCorrelation === 'number')
          ? suggestion.calibrationCorrelation : null,
        closed_trade_count: envelope.closed_trade_count,
        window_days: opts.windowDays,
        direction: (suggestion.summary && suggestion.summary.direction) || null,
        pull_max_used: (suggestion.summary && suggestion.summary.pull_max_used) || null,
        user_json_persisted: applyResult.mutated === true,
      });
    } else {
      this.logger.info('loop.adaptive_weights.skipped', {
        event: 'loop.adaptive_weights.skipped',
        reason: reason || 'unknown',
        closed_trade_count: envelope.closed_trade_count,
        calibration_correlation: (typeof suggestion.calibrationCorrelation === 'number')
          ? suggestion.calibrationCorrelation : null,
        window_days: opts.windowDays,
      });
    }
  }

  /**
   * Start the loop. Schedules a `setTimeout` chain that calls
   * `tick()` every `poll_interval_seconds`. Idempotent: a second
   * `start()` is a no-op.
   *
   * @returns {Promise<void>}  resolves once the FIRST tick has started.
   */
  async start() {
    if (this._running) return;
    this._running = true;
    this._stopRequested = false;
    // T43c-server: install the SIGUSR1 hot-reload handler when a
    // configReader was provided. The handler replaces `this.cfg`
    // atomically + re-derives the loopCfg snapshot so the next tick
    // picks up the new knobs WITHOUT a process restart.
    if (typeof this._configReader === 'function' && this._signalUninstall === null) {
      this._signalUninstall = installConfigHotReloadHandler(this, this.logger);
    }
    this.logger.info('loop.start', {
      poll_interval_seconds: this.loopCfg.poll_interval_seconds,
      snapshot_interval_seconds: this.loopCfg.snapshot_interval_seconds,
      hot_reload_enabled: this._configReader !== null,
    });
    // Schedule the first tick immediately (no leading delay), then
    // chain `setTimeout` calls so a slow tick doesn't overlap with
    // the next one.
    this._scheduleNext(0);
  }

  /**
   * Stop the loop. The currently-running tick is allowed to finish;
   * no further ticks are scheduled. Idempotent.
   *
   * @returns {Promise<void>}
   */
  async stop() {
    if (!this._running) return;
    this._stopRequested = true;
    this._running = false;
    // T43c-server: uninstall the SIGUSR1 handler so a stop+restart
    // cycle doesn't double-register.
    if (typeof this._signalUninstall === 'function') {
      try { this._signalUninstall(); } catch { /* best effort */ }
      this._signalUninstall = null;
    }
    this.logger.info('loop.stop', {
      tick_count: this._tickCount,
      last_tick_at_ms: this._lastTickAtMs,
    });
  }

  /**
   * @private — schedule the next tick after `delayMs` (using
   *           `this.scheduler` so tests can swap it).
   */
  _scheduleNext(delayMs) {
    if (this._stopRequested) return;
    this.scheduler(async () => {
      if (this._stopRequested) return;
      try {
        await this.tick();
      } catch (e) {
        // tick() catches its own errors, but be defensive.
        this.logger.error('loop.tick.unhandled', {
          err_name: e?.name ?? 'Error',
          err_message: e?.message ?? String(e),
        });
      }
      if (!this._stopRequested) {
        this._scheduleNext(this.loopCfg.poll_interval_seconds * 1000);
      }
    }, delayMs);
  }

  /**
   * T53.2 — common dispatch helper. Routes an AlertEvent through
   * `_safeAlertDispatch` (channel router) AND `_alertsAppend`
   * (NDJSON writer); both are independent and both never throw.
   * Mirrors the same helper in `src/risk/circuit-breaker.mjs` and
   * `src/trader/swap.mjs`.
   *
   * @private
   * @param {Object} event
   * @param {string} logEvent
   */
  async _dispatchAlert(event, logEvent) {
    if (this._alertsAppend) {
      try {
        await this._alertsAppend(event);
      } catch (e) {
        if (this.logger && typeof this.logger.warn === 'function') {
          this.logger.warn('loop.alerts_persist.failed', {
            event: logEvent,
            error: e?.message ?? String(e),
            kind: event?.kind ?? null,
          });
        }
      }
    }
    if (this._safeAlertDispatch) {
      try {
        await this._safeAlertDispatch(event);
      } catch (e) {
        if (this.logger && typeof this.logger.warn === 'function') {
          this.logger.warn('loop.alerts_dispatch.failed', {
            event: logEvent,
            error: e?.message ?? String(e),
            kind: event?.kind ?? null,
          });
        }
      }
    }
  }

  /**
   * T53.2 — dispatch a `wallet_floor` event when an entry is
   * refused at the pre-flight check (wallet below the safety
   * floor). Severity `warn`; the bot is still operating, it just
   * can't enter new positions.
   *
   * @private
   * @param {Object} ctx
   */
  async _dispatchWalletFloorBreach(ctx) {
    const ts = (ctx && typeof ctx.ts === 'string') ? ctx.ts : new Date().toISOString();
    const event = {
      kind: 'wallet_floor',
      severity: 'warn',
      title: 'entry_wallet_floor_breach',
      body: `wallet ${ctx.wallet_balance_bch} BCH below min_wallet_balance_bch ${ctx.min_wallet_balance_bch} BCH — ${ctx.token_id} entry refused (${ctx.stage})`,
      context: {
        token_id: ctx.token_id ?? null,
        wallet_balance_bch: ctx.wallet_balance_bch ?? null,
        min_wallet_balance_bch: ctx.min_wallet_balance_bch ?? null,
        stage: ctx.stage ?? null,
        reason: ctx.reason ?? null,
        ts,
      },
      ts,
    };
    await this._dispatchAlert(event, 'loop.dispatch');
  }

  /**
   * T53.2 — dispatch a `risk_threshold` event when the risk gate
   * (`canOpen`) refuses an entry. Maps the canOpen reject kind
   * (already_open / daily_loss / exposure_full / ...) onto the
   * canonical alert kind so the dashboard's filter UI works.
   *
   * @private
   * @param {Object} ctx
   */
  async _dispatchEntryRefused(ctx) {
    const ts = (ctx && typeof ctx.ts === 'string') ? ctx.ts : new Date().toISOString();
    const rejectKind = (ctx && typeof ctx.reject_kind === 'string') ? ctx.reject_kind : 'unknown';
    /** @type {{kind: string, severity: 'warn'|'error'}} */
    let mapped = { kind: 'risk_threshold', severity: 'warn' };
    if (rejectKind === 'below_floor') {
      mapped = { kind: 'wallet_floor', severity: 'warn' };
    } else if (rejectKind === 'already_open') {
      mapped = { kind: 'risk_threshold', severity: 'info' };
    } else if (rejectKind === 'daily_loss' || rejectKind === 'daily_loss_breach') {
      mapped = { kind: 'risk_threshold', severity: 'error' };
    }
    const event = {
      ...mapped,
      title: `entry_refused_${rejectKind}`,
      body: ctx.reason ?? `entry refused by risk gate (${rejectKind}) on ${ctx.token_id}`,
      context: {
        token_id: ctx.token_id ?? null,
        reject_kind: rejectKind,
        stage: ctx.stage ?? null,
        size_bch: ctx.size_bch ?? null,
        reason: ctx.reason ?? null,
        ts,
      },
      ts,
    };
    await this._dispatchAlert(event, 'loop.dispatch');
  }

  /**
   * T53.2 — dispatch a `breaker_trip` event ONCE per tick when
   * the breaker is still tripping entries. The breaker's own
   * `circuit_breaker.tripped` log line fires on the TRANSITION
   * (when the trip ts gets set), but operators want a per-tick
   * pulse during the cooldown window so the dashboard's Recent
   * Alerts stream doesn't go silent.
   *
   * @private
   * @param {Object} ctx
   */
  async _dispatchBreakerSkipped(ctx) {
    const ts = (ctx && typeof ctx.ts === 'string') ? ctx.ts : new Date().toISOString();
    const event = {
      kind: 'breaker_trip',
      severity: 'warn',
      title: 'breaker_still_tripped',
      body: `entries skipped: breaker (${ctx.breaker_kind ?? 'unknown'}) still tripped; ${ctx.candidate_count ?? 0} candidates deferred`,
      context: {
        breaker_kind: ctx.breaker_kind ?? null,
        breaker_reason: ctx.breaker_reason ?? null,
        candidate_count: ctx.candidate_count ?? null,
        ts,
      },
      ts,
    };
    await this._dispatchAlert(event, 'loop.dispatch');
  }

  /**
   * T53.2 — dispatch an `amm_divergence` event when the indexer
   * price diverges from the AMM-implied spot rate by ≥1000x (the
   * threshold the T31 entry guard uses to refuse trades on a
   * bad indexer price). The guard SILENTLY rejects; this alert
   * surfaces the divergence so the operator can investigate
   * without grepping `data/history.jsonl` by hand.
   *
   * @private
   * @param {Object} ctx
   */
  async _dispatchAmmDivergence(ctx) {
    const ts = (ctx && typeof ctx.ts === 'string') ? ctx.ts : new Date().toISOString();
    const ratio = Number.isFinite(Number(ctx.ratio)) ? Number(ctx.ratio) : null;
    const event = {
      kind: 'amm_divergence',
      severity: 'warn',
      title: 'amm_indexer_divergence',
      body: `AMM/indexer price divergence ≥1000x on ${ctx.token_id} (ratio=${ratio})`,
      context: {
        token_id: ctx.token_id ?? null,
        indexer_price_sats: ctx.indexer_price_sats ?? null,
        amm_spot_sats: ctx.amm_spot_sats ?? null,
        ratio,
        decimals: ctx.decimals ?? null,
        ts,
      },
      ts,
    };
    await this._dispatchAlert(event, 'loop.dispatch');
  }

  /**
   * T53.2 — dispatch a `wallet_floor` event when an exit is
   * extended via the profit-floor gate (decision='extended',
   * not 'executed'). The position will close on the next
   * time-stop fire; the alert signals that the bot WOULD have
   * taken a sub-floor P&L had it closed at the current rate.
   *
   * @private
   * @param {Object} ctx
   */
  async _dispatchExitExtended(ctx) {
    const ts = (ctx && typeof ctx.ts === 'string') ? ctx.ts : new Date().toISOString();
    const event = {
      kind: 'wallet_floor',
      severity: 'info',
      title: 'exit_extended_below_floor',
      body: `exit extended on ${ctx.token_id} (kind=${ctx.kind}); projected P&L ${ctx.projected_pnl_sats} sats below floor ${ctx.floor_sats} sats`,
      context: {
        position_id: ctx.position_id ?? null,
        token_id: ctx.token_id ?? null,
        projected_pnl_sats: ctx.projected_pnl_sats ?? null,
        floor_sats: ctx.floor_sats ?? null,
        new_cutoff_ms: ctx.new_cutoff_ms ?? null,
        kind: ctx.kind ?? null,
        ts,
      },
      ts,
    };
    await this._dispatchAlert(event, 'loop.dispatch');
  }
}

/**
 * @private — convert a SwapExecutor result's per-base-unit
 * `effectiveRateSats` to a per-DISPLAY-unit rate suitable for the
 * human-readable `entry.price_sats_per_token` / `exit.price_sats_per_token`
 * fields. Returns a plain `number` (bigint → number, so fractional
 * precision is lost — fine for a display field; the audit log
 * still carries the bigint `effective_rate_sats` separately).
 *
 * B04 / bug-exit-failed-20260916: storing the per-base rate raw
 * would surface "0.97 sat/token" for an OLA-like token with
 * `decimals=2` (the SDK's `totalSupply / amount` bigint-floors
 * the per-base rate to `0n` for many small-balance positions).
 * The dashboard reads `price_sats_per_token` and renders it with
 * a "sat/token" suffix, so the field has to be per-DISPLAY unit
 * to be useful to the operator.
 *
 * @param {Object} swapResult   a `SwapResult` from `SwapExecutor.execute()`
 * @returns {number|null}       per-display-unit rate, or null when
 *                               effectiveRateSats / decimals are missing
 */
function _effectiveRateToDisplay(swapResult) {
  if (!swapResult || typeof swapResult !== 'object') return null;
  const eff = swapResult.effectiveRateSats;
  if (eff == null) return null;
  const decimals = swapResult?.tokenMeta?.decimals;
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 32) {
    // No decimals → pass through. Defensive: missing/garbage
    // decimals would cause the rate to be displayed in the wrong
    // unit (per-base instead of per-display), but at least it's
    // not silent — the dashboard will show a small fractional
    // number instead of zero, which the operator can spot.
    try {
      const n = Number(eff);
      return Number.isFinite(n) ? n : null;
    } catch { return null; }
  }
  const conv = baseRateToDisplayRate(eff, decimals);
  if (conv.ok) return Number(conv.value);
  try {
    const n = Number(eff);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

/** @private — extract a token_id → price sats map for snapshots. */
function _extractPriceIndex(statsIndex) {
  /** @type {Record<string, bigint>} */
  const out = {};
  if (!(statsIndex instanceof Map)) return out;
  for (const [tid, stats] of statsIndex.entries()) {
    if (stats && Number.isFinite(stats.price_now_sats)) {
      out[tid] = BigInt(Math.round(stats.price_now_sats));
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
//  T56-2 — default I/O seams for the adaptive-weights auto-wire
//
//  These live at module scope (not inside the constructor) so the
//  loop can resolve them lazily once per tick without holding the
//  fd / file handle open between ticks. They're plain functions
//  returning `{async function}` closures, which means the test
//  suite can:
//    - inject overrides via `opts.adaptiveWeightsLoadHistory` etc.
//      to bypass disk I/O entirely;
//    - OR call these helpers directly in a fixture to verify the
//      real disk path round-trips a synthetic user.json without
//      touching the bot's live config.
//
//  All four are pure-ish (the only I/O is fs.readFile / fs.writeFile /
//  fs.appendFile), and all four swallow errors by returning the
//  typed envelope that the loop expects (`{exists, data}` / line).
// ─────────────────────────────────────────────────────────────────────

/**
 * @private — default `data/history.jsonl` loader. Returns an async
 * function that reads `file`, splits on newline, filters blanks,
 * and returns the lines array. ENOENT → empty array (the loop
 * treats "no history yet" as a no-op, not an error).
 *
 * `filePath` is bound into the returned closure so call sites
 * that invoke the closure with no args still get the default.
 */
export async function _defaultAdaptiveWeightsLoadHistory(filePath = DEFAULT_HISTORY_FILE) {
  const fsp = await import('node:fs/promises');
  return async function loadHistory(file = filePath) {
    try {
      const text = await fsp.readFile(file, 'utf8');
      return text.split(/\r?\n/).filter((l) => l.length > 0);
    } catch (e) {
      if (e && /** @type {any} */ (e).code === 'ENOENT') return [];
      throw e;
    }
  };
}

/**
 * @private — default `config/user.json` loader. Returns an async
 * function that reads `file` and returns `{exists, data}`. ENOENT
 * → `{exists:false, data:{}}` (legitimate "operator hasn't
 * created user.json yet" case — the apply path will start from
 * an empty object).
 *
 * `filePath` is bound into the returned closure so call sites
 * that invoke the closure with no args still get the default.
 */
export async function _defaultAdaptiveWeightsLoadUserJson(filePath = DEFAULT_USER_CONFIG_FILE) {
  const fsp = await import('node:fs/promises');
  return async function loadUserJson(file = filePath) {
    try {
      const text = await fsp.readFile(file, 'utf8');
      const trimmed = text.trim();
      const data = trimmed.length > 0 ? JSON.parse(trimmed) : {};
      return { exists: true, data };
    } catch (e) {
      if (e && /** @type {any} */ (e).code === 'ENOENT') {
        return { exists: false, data: {} };
      }
      throw e;
    }
  };
}

/**
 * @private — default `data/adaptive-weights.jsonl` writer. Returns
 * an async function that appends a single line (no trailing
 * newline) via `atomicAppendNdjson`.
 *
 * `filePath` is bound into the returned closure so call sites
 * that invoke the closure with no args still get the default.
 */
export async function _defaultAdaptiveWeightsAuditAppend(filePath = DEFAULT_ADAPTIVE_WEIGHTS_LOG_FILE) {
  const awMod = await import('../util/atomic-write.mjs');
  return async function appendAudit(line, file = filePath) {
    await awMod.atomicAppendNdjson(file, line);
  };
}

/**
 * @private — default `config/user.json` writer. Returns an async
 * function that serializes `data` via `atomicWriteJson`. The
 * helper uses mode 0o600 so a stray chmod doesn't expose the
 * WIF; `atomicWriteJson` already enforces that on creation.
 *
 * `filePath` is bound into the returned closure so call sites
 * that invoke the closure with no args still get the default.
 */
export async function _defaultAdaptiveWeightsWriteUserJson(filePath = DEFAULT_USER_CONFIG_FILE) {
  const awMod = await import('../util/atomic-write.mjs');
  return async function writeUserJson(data, file = filePath) {
    await awMod.atomicWriteJson(file, data, { mode: 0o600 });
  };
}

/**
 * Test seam: re-export the helpers the test suite uses to build
 * fixtures + drive the loop deterministically.
 */
export const _internals = {
  buildPortfolioState,
  indexStatsByTokenId,
  totalSwapFeeSats,
  tickBudgetMs,
  createHistoryAppender,
  resolveLoopConfig,
  _effectiveRateToDisplay,
  // T43c-server: hot-reload internals exposed for unit tests.
  computeConfigDiff,
  applyConfigReload,
  installConfigHotReloadHandler,
  // T56-2: adaptive-weights default I/O seams for unit tests.
  _defaultAdaptiveWeightsLoadHistory,
  _defaultAdaptiveWeightsLoadUserJson,
  _defaultAdaptiveWeightsAuditAppend,
  _defaultAdaptiveWeightsWriteUserJson,
  DEFAULT_USER_CONFIG_FILE,
  DEFAULT_ADAPTIVE_WEIGHTS_LOG_FILE,
};

/**
 * T43c-server: compute the diff between two merged configs.
 *
 * For every dotted key present in either `prev` or `next` whose
 * leaf value is a primitive (string / number / boolean / bigint /
 * null) OR an array (treated as opaque-equal), report whether the
 * value changed. Plain-object branches are walked recursively.
 *
 * Pure. Exported (via _internals) for tests + the SIGUSR1 handler.
 *
 * @param {Object} prev
 * @param {Object} next
 * @param {string} [prefix]
 * @param {Set<string>} [seen]
 * @returns {string[]}  dotted keys whose leaf value changed.
 */
export function computeConfigDiff(prev, next, prefix = '', seen = new Set()) {
  /** @type {string[]} */
  const out = [];
  const a = prev ?? {};
  const b = next ?? {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (seen.has(path)) continue;
    const av = /** @type {any} */ (a)[k];
    const bv = /** @type {any} */ (b)[k];
    // Skip cycles (defensive — configs shouldn't cycle, but a bad
    // operator override could create one).
    if (typeof av === 'object' && av !== null) seen.add(av);
    if (typeof bv === 'object' && bv !== null) seen.add(bv);
    const avObj = (av !== null && typeof av === 'object' && !Array.isArray(av));
    const bvObj = (bv !== null && typeof bv === 'object' && !Array.isArray(bv));
    if (avObj && bvObj) {
      out.push(...computeConfigDiff(av, bv, path, seen));
    } else {
      // Leaf or array → strict equality check (no deep array diff;
      // arrays in the bot config are small + rarely mutated).
      const equal = Object.is(av, bv);
      if (!equal) out.push(path);
    }
  }
  return out;
}

/**
 * T43c-server: apply a re-loaded config to a live TradingLoop.
 *
 * Replaces `this.cfg` + re-derives `this.loopCfg` (the only
 * frozen snapshot the loop holds) atomically. The strategy/risk/
 * exit modules all read from `this.cfg.<group>.<knob>` on every
 * call, so a fresh `this.cfg` automatically lights up the new
 * values on the NEXT tick.
 *
 * Emits a `kind:'config_hot_reload'` history event with the diff
 * so the audit trail survives the restart-free path.
 *
 * @param {TradingLoop} loop
 * @param {Object} opts
 * @param {Object} opts.nextCfg        the freshly merged config
 * @param {Object} [opts.logger]       structured logger (defaults to loop.logger)
 * @param {Function} [opts.historyAppend]   history appender (defaults to loop.historyAppend)
 * @param {Function} [opts.resolveLoopConfig]  resolver (defaults to the loop's own import)
 * @returns {{ diff: string[], old_cfg: Object, new_cfg: Object, applied: boolean }}
 */
export async function applyConfigReload(loop, opts) {
  const logger = opts.logger ?? loop.logger;
  const historyAppend = opts.historyAppend ?? loop.historyAppend;
  if (!opts || typeof opts.nextCfg !== 'object' || opts.nextCfg === null) {
    return { diff: [], old_cfg: loop.cfg, new_cfg: loop.cfg, applied: false };
  }
  const prev = loop.cfg ?? {};
  const next = opts.nextCfg;
  const diff = computeConfigDiff(prev, next);
  // Snapshot the old config for the history event BEFORE we mutate.
  const prevSnapshot = prev;
  loop.cfg = next;
  // Re-derive loopCfg so the next _scheduleNext call uses the
  // possibly-changed poll/snapshot intervals.
  loop.loopCfg = (typeof opts.resolveLoopConfig === 'function')
    ? opts.resolveLoopConfig(next.loop)
    : resolveLoopConfig(next.loop);
  logger.info('loop.config_hot_reload.applied', {
    knobs_changed: diff,
    knobs_changed_count: diff.length,
    poll_interval_seconds: loop.loopCfg.poll_interval_seconds,
    snapshot_interval_seconds: loop.loopCfg.snapshot_interval_seconds,
  });
  // Audit event — same shape as the rest of the history stream so
  // the dashboard / pnl-timeseries views can filter on `kind`.
  try {
    await historyAppend(JSON.stringify({
      kind: 'config_hot_reload',
      ts: new Date().toISOString(),
      knobs_changed: diff,
      knobs_changed_count: diff.length,
      prev_config_keys: Object.keys(prevSnapshot ?? {}),
      next_config_keys: Object.keys(next ?? {}),
    }));
  } catch (e) {
    logger.error('loop.config_hot_reload.history-failed', {
      err_name: e?.name ?? 'Error',
      err_message: e?.message ?? String(e),
    });
  }
  return { diff, old_cfg: prevSnapshot, new_cfg: next, applied: true };
}

/**
 * T43c-server: install the SIGUSR1 hot-reload handler on `loop`.
 *
 * The handler is a thin wrapper around `applyConfigReload`. It
 * reads the fresh config via `loop._configReader(opts)` and calls
 * `applyConfigReload`. Errors during the read NEVER bring down the
 * bot — they're logged + the existing config stays in place.
 *
 * Returns the uninstall hook (also stored on `loop._signalUninstall`).
 *
 * @param {TradingLoop} loop
 * @param {Object} [logger]
 * @returns {() => void}
 */
export function installConfigHotReloadHandler(loop, logger = loop.logger) {
  if (typeof loop._configReader !== 'function') {
    return () => { /* no-op when hot-reload isn't enabled */ };
  }
  /** @param {NodeJS.Signals} sig */
  const onSig = async (sig) => {
    if (sig !== 'SIGUSR1') return;
    logger.info('loop.config_hot_reload.signal-received', { signal: sig });
    try {
      const loaded = await loop._configReader();
      if (!loaded || typeof loaded !== 'object' || !loaded.cfg) {
        logger.warn('loop.config_hot_reload.empty-result', {
          signal: sig,
          hint: 'configReader returned no .cfg — keeping the previous config',
        });
        return;
      }
      await applyConfigReload(loop, { nextCfg: loaded.cfg });
    } catch (e) {
      logger.error('loop.config_hot_reload.failed', {
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
        stack: e?.stack ?? null,
      });
    }
  };
  process.on('SIGUSR1', onSig);
  return () => {
    try { process.removeListener('SIGUSR1', onSig); } catch { /* best effort */ }
  };
}
