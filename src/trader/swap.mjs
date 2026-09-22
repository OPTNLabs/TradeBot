// src/trader/swap.mjs
//
// TradeBot's swap executor.
//
// Wraps the cauldron-swap-sdk + the trimmed-down `check_and_swap.mjs`
// library functions (under `src/trader/cauldron/`) into a single
// in-process entry point that:
//
//   1. Looks up the active pools (via the cauldron-swap-sdk, not via the
//      indexer HTTP API — the SDK keeps the indexer URL configurable but
//      the algorithm is the same).
//   2. Plans the optimal multi-pool allocation for the requested side
//      and base-unit amount.
//   3. Builds + signs the transaction via the configured LibAuthBchWallet
//      (signing happens inside `prepareAndBuildSwap`, which takes the
//      wallet's WIF; the WIF never leaves the wallet module's memory).
//   4. Broadcasts via the wallet's Electrum provider (re-using the
//      connection that already verified UTXOs/balance).
//   5. Verifies the broadcast result against the expected effective rate
//      (post-trade check), logging the slippage.
//
// What this module does NOT do:
//
//   - Position-sizing / risk gates / circuit breakers (T13).
//   - Wallet initialization (the caller owns the wallet lifecycle).
//   - Persisting trade history (T12).
//
// All async operations are timeout-bounded via the wallet's
// `timeoutMs`. Every async call is structured-logged on entry/exit so the
// audit trail (one JSON line per event) covers the full trade lifecycle.

import process from 'node:process';

import {
  planTrade,
  spotRates,
  prepareAndBuildSwap,
  broadcastTx,
  PUBLIC_CONSTANTS,
} from './cauldron/check_and_swap.mjs';
import { verifyTrade } from './cauldron/post_trade_check.mjs';
import { getPoolsAndMeta } from './cauldron/get_price.mjs';
import { analyzePlanForImplicitBurn } from './pool-shape.mjs';
import { resolveSlippageCapBps } from './slippage-cap.mjs';
import { fmtSats, fmtBch } from './cauldron/check_and_swap.mjs';
import { computeOptimalBuy } from '@mr-zwets/cauldron-swap-sdk';

import { createLogger } from '../util/logger.mjs';

// ─────────────────────────────────────────────────────────────────────
//  Errors
// ─────────────────────────────────────────────────────────────────────

export class SwapError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'SwapError';
    if (opts.cause) this.cause = opts.cause;
    if (opts.kind) this.kind = opts.kind;
  }
}

export class SwapConfigError extends SwapError {
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = 'SwapConfigError';
  }
}

export class SwapPreFlightError extends SwapError {
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = 'SwapPreFlightError';
  }
}

export class SwapInsufficientFundsError extends SwapError {
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = 'SwapInsufficientFundsError';
  }
}

export class SwapBroadcastError extends SwapError {
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = 'SwapBroadcastError';
  }
}

export class SwapVerificationError extends SwapError {
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = 'SwapVerificationError';
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Compute the slippage in basis points between an expected rate and the
 * rate that actually executed. Positive = worse for the user (we paid
 * MORE sats per token on a buy, or received FEWER sats per token on a
 * sell).
 *
 * For a BUY: the user wants a LOW rate. actualRate - expectedRate > 0
 * means we paid more than expected (bad). slippageBps > 0.
 *
 * For a SELL: the user wants a HIGH rate. expectedRate - actualRate > 0
 * means we received less than expected (bad). slippageBps > 0.
 *
 * Coerces `Number` inputs to BigInt (the cauldron-swap-sdk emits
 * marginal rates as plain `number`; `effectiveRate` from `planTrade` is
 * already bigint — accept either).
 *
 * Returns bigint (bps, integer). 1 bps = 0.01%. Returns `0n` when
 * `expectedRate` is missing / 0 / NaN (defensive — caller should
 * guarantee an expected rate is set).
 *
 * @param {'buy'|'sell'} side
 * @param {bigint|number|null|undefined} expectedRate
 * @param {bigint|number|null|undefined} actualRate
 * @returns {bigint}
 */
export function computeSlippageBps(side, expectedRate, actualRate) {
  const exp = toBig(expectedRate);
  const act = toBig(actualRate);
  if (exp === null || act === null || exp === 0n) return 0n;
  if (side === 'buy') {
    return ((act - exp) * 10000n) / exp;
  }
  // 'sell'
  return ((exp - act) * 10000n) / exp;
}

/** @private — coerce a Number | bigint | null | undefined to BigInt, or null. */
function toBig(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isFinite(v)) {
    return BigInt(Math.round(v));
  }
  if (typeof v === 'string' && v.length > 0) {
    try { return BigInt(v); } catch { return null; }
  }
  return null;
}

/**
 * Verify a swap plan against the position-size limits in the merged
 * config. Pure — easy to unit-test. Throws SwapPreFlightError or
 * SwapInsufficientFundsError on failure.
 *
 * Required config keys (read from the `risk` block):
 *   - max_position_bch
 *   - max_total_exposure_bch
 *   - min_wallet_balance_bch
 *   - slippage_tolerance_bps
 *
 * Required facts:
 *   - `walletBalanceSats`        current wallet balance
 *   - `openExposureBch`          BCH currently committed to open positions
 *   - `side`                     'buy' or 'sell'
 *   - `amountBch`                BCH the proposed trade will spend (buy)
 *                                  or BCH that will be returned (sell = 0)
 *   - `slippageBps`              expected slippage from `planTrade(...)`
 *
 * @param {Object} args
 * @param {Object} args.cfg
 * @param {'buy'|'sell'} args.side
 * @param {number} args.amountBch
 * @param {bigint} args.walletBalanceSats
 * @param {number} args.openExposureBch
 * @param {bigint} args.slippageBps
 * @param {bigint} [args.poolDepthSats]   T55: AMM pool depth in sats. When provided,
 *                                        `preFlightCheck` uses `resolveSlippageCapBps`
 *                                        (see `src/trader/slippage-cap.mjs`) to derive
 *                                        a per-token cap instead of the flat
 *                                        `slippage_tolerance_bps`. Falls back to the
 *                                        flat cap when missing/non-positive.
 */
export function preFlightCheck({ cfg, side, amountBch, walletBalanceSats, openExposureBch, slippageBps, poolDepthSats }) {
  if (!cfg || typeof cfg !== 'object') {
    throw new SwapConfigError('preFlightCheck: cfg is required');
  }
  // Per `config/default.json` (T03) the position-size knobs live under
  // `entry` (where the entry strategy layer reads them) and the
  // wallet-floor knob lives under `risk` (where canOpen reads it).
  // For backward compatibility with older configs that nested all of
  // these under `risk`, we accept either location — `entry` wins if
  // both are set, matching what `canOpen` does in src/risk/limits.mjs.
  const r = cfg.risk ?? {};
  const e = cfg.entry ?? {};
  const maxPos = e.max_position_bch ?? r.max_position_bch;
  const maxExposure = e.max_total_exposure_bch ?? r.max_total_exposure_bch;
  const minBalance = r.min_wallet_balance_bch;
  const baseSlippageBps = BigInt(e.slippage_tolerance_bps ?? r.slippage_tolerance_bps ?? 100);
  // T55: per-token slippage cap derived from AMM pool depth. When the
  // caller supplies `poolDepthSats` (bigint > 0n) the helper
  // computes a tighter / looser cap than the flat one based on the
  // expected constant-product slippage. When poolDepthSats is
  // missing/non-positive OR the per-token knobs are inconsistent,
  // the helper returns `null` and we fall back to the flat cap. See
  // `src/trader/slippage-cap.mjs` for the algorithm.
  let slippageTolBps = baseSlippageBps;
  let slippageCapSource = 'flat';
  if (typeof poolDepthSats === 'bigint' && poolDepthSats > 0n) {
    const perTokenBps = resolveSlippageCapBps({
      baseCapBps: baseSlippageBps,
      sizeBch: amountBch,
      poolDepthBch: Number(poolDepthSats) / 1e8,
      minBps: e.slippage_cap_min_bps ?? r.slippage_cap_min_bps,
      maxBps: e.slippage_cap_max_bps ?? r.slippage_cap_max_bps,
      multiplier: e.slippage_cap_multiplier ?? r.slippage_cap_multiplier,
      enabled: e.slippage_cap_per_token_enabled ?? r.slippage_cap_per_token_enabled ?? true,
    });
    slippageTolBps = perTokenBps;
    slippageCapSource = perTokenBps === baseSlippageBps ? 'flat' : 'per_token';
  }

  if (typeof maxPos !== 'number' || maxPos <= 0) {
    throw new SwapConfigError(`preFlightCheck: entry.max_position_bch (or risk.max_position_bch) missing/invalid (${maxPos})`);
  }
  if (typeof maxExposure !== 'number' || maxExposure <= 0) {
    throw new SwapConfigError(`preFlightCheck: entry.max_total_exposure_bch (or risk.max_total_exposure_bch) missing/invalid (${maxExposure})`);
  }
  if (typeof minBalance !== 'number' || minBalance < 0) {
    throw new SwapConfigError(`preFlightCheck: risk.min_wallet_balance_bch missing/invalid (${minBalance})`);
  }

  if (side !== 'buy' && side !== 'sell') {
    throw new SwapConfigError(`preFlightCheck: side must be 'buy' or 'sell'; got ${JSON.stringify(side)}`);
  }
  if (typeof amountBch !== 'number' || amountBch <= 0) {
    throw new SwapConfigError(`preFlightCheck: amountBch must be a positive number; got ${amountBch}`);
  }
  if (typeof walletBalanceSats !== 'bigint' || walletBalanceSats < 0n) {
    throw new SwapConfigError(`preFlightCheck: walletBalanceSats must be a non-negative bigint; got ${walletBalanceSats}`);
  }
  if (typeof openExposureBch !== 'number' || openExposureBch < 0) {
    throw new SwapConfigError(`preFlightCheck: openExposureBch must be a non-negative number; got ${openExposureBch}`);
  }

  // Position-size ceiling. Applies to BUYs only — a sell is bounded
  // by the size of the open position it is closing, not by
  // `max_position_bch`. A sell that returns more than the entry
  // size (e.g. +10% take-profit on a 0.005 BCH position returns
  // 0.0055 BCH) is NORMAL and must NOT be rejected here.
  if (side === 'buy' && amountBch > maxPos + 1e-9) {
    throw new SwapPreFlightError(
      `preFlightCheck: amount ${amountBch} BCH exceeds max_position_bch ${maxPos}`,
      { kind: 'position_too_large' },
    );
  }
  // Total exposure ceiling.
  if (side === 'buy' && openExposureBch + amountBch > maxExposure + 1e-9) {
    throw new SwapPreFlightError(
      `preFlightCheck: total exposure ${openExposureBch + amountBch} BCH would exceed max_total_exposure_bch ${maxExposure}`,
      { kind: 'exposure_exceeded' },
    );
  }
  // Wallet floor: keep at least min_wallet_balance_bch after the trade.
  if (side === 'buy') {
    const walletBalanceBch = Number(walletBalanceSats) / 1e8;
    if (walletBalanceBch - amountBch < minBalance - 1e-9) {
      throw new SwapInsufficientFundsError(
        `preFlightCheck: wallet balance ${walletBalanceBch} BCH minus trade ${amountBch} BCH ` +
        `would fall below min_wallet_balance_bch ${minBalance}`,
        { kind: 'below_floor' },
      );
    }
  }
  // Slippage ceiling.
  if (typeof slippageBps !== 'bigint') {
    throw new SwapConfigError(`preFlightCheck: slippageBps must be a bigint; got ${typeof slippageBps}`);
  }
  if (slippageBps > slippageTolBps) {
    const err = new SwapPreFlightError(
      `preFlightCheck: expected slippage ${slippageBps} bps exceeds tolerance ${slippageTolBps} bps`,
      { kind: 'slippage_exceeded' },
    );
    // T55: enrich the slippage_exceeded error so execute() can log the
    // per-token vs flat cap that actually gated the trade.
    err.effective_cap_bps = slippageTolBps;
    err.base_cap_bps = baseSlippageBps;
    err.cap_source = slippageCapSource;
    throw err;
  }
}

/**
 * T55: resolve the effective per-token slippage cap WITHOUT running
 * the pre-flight check. Used by `SwapExecutor.execute()` for audit-trail
 * logging so the operator can see which cap (flat / per-token) gated
 * the trade even when the slippage check PASSED.
 *
 * Returns `{ capBps: bigint, source: 'flat'|'per_token' }`. Falls back
 * to `{ capBps: <flat cap>, source: 'flat' }` when:
 *   - cfg is missing the slippage_tolerance_bps knobs (already throws via
 *     preFlightCheck, but this helper is non-throwing for log safety)
 *   - poolDepthSats is missing/non-positive/non-bigint
 *   - the per-token cap helper returns the flat cap (no change)
 *
 * @param {Object} args
 * @param {Object} args.cfg
 * @param {number} args.amountBch
 * @param {bigint|null|undefined} [args.poolDepthSats]
 * @returns {{ capBps: bigint, source: 'flat'|'per_token' }}
 */
export function resolveEffectiveSlippageCapBps({ cfg, amountBch, poolDepthSats } = {}) {
  const r = cfg?.risk ?? {};
  const e = cfg?.entry ?? {};
  const baseBps = BigInt(e.slippage_tolerance_bps ?? r.slippage_tolerance_bps ?? 100);
  if (typeof poolDepthSats !== 'bigint' || poolDepthSats <= 0n) {
    return { capBps: baseBps, source: 'flat' };
  }
  const perTokenBps = resolveSlippageCapBps({
    baseCapBps: baseBps,
    sizeBch: amountBch,
    poolDepthBch: Number(poolDepthSats) / 1e8,
    minBps: e.slippage_cap_min_bps ?? r.slippage_cap_min_bps,
    maxBps: e.slippage_cap_max_bps ?? r.slippage_cap_max_bps,
    multiplier: e.slippage_cap_multiplier ?? r.slippage_cap_multiplier,
    enabled: e.slippage_cap_per_token_enabled ?? r.slippage_cap_per_token_enabled ?? true,
  });
  return {
    capBps: perTokenBps,
    source: perTokenBps === baseBps ? 'flat' : 'per_token',
  };
}

// ─────────────────────────────────────────────────────────────────────
//  SwapExecutor
// ─────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} SwapExecutorOpts
 * @property {Object} cfg                  merged default+user config
 * @property {Object} wallet               a LibAuthBchWallet (init()'d)
 * @property {Object} [logger]             structured logger
 * @property {Object} [dexAdapter]         T57-3: DEX adapter to route the trade through
 *                                          (exposes `prepareAndBuildSwap` + `broadcastTx` +
 *                                          `verifyTrade` + `getPoolsAndMeta` + `constants`).
 *                                          When omitted, the executor falls back to the live
 *                                          cauldron adapter (backward compatible — every
 *                                          existing call site keeps working).
 * @property {Object} [deps]               injection points for tests
 * @property {Function} [deps.sdk]         cauldron-swap-sdk (defaults to real import)
 * @property {Function} [deps.getPoolsAndMeta]  defaults to getPoolsAndMeta from cauldron/get_price.mjs
 * @property {Function} [deps.planTrade]   defaults to planTrade from cauldron/check_and_swap.mjs
 * @property {Function} [deps.prepareAndBuildSwap]
 * @property {Function} [deps.broadcastTx]
 * @property {Function} [deps.verifyTrade]
 * @property {Function} [deps.maxTokensForBudget]  defaults to module-local helper (BCH sats → token base units)
 * @property {Function} [deps.fetchImpl]   defaults to global fetch
 * @property {number}  [deps.openExposureBch]   BCH currently committed to open positions
 */

/**
 * @typedef {Object} SwapRequest
 * @property {string} tokenId
 * @property {'buy'|'sell'} side
 * @property {bigint} amountBase       trade amount — semantics depend on side:
 *                                      BUY: BCH budget in satoshis (the operator's input).
 *                                           The executor translates this into the
 *                                           corresponding token base-unit amount via
 *                                           `maxTokensForBudget(pools, amountBase)`
 *                                           before calling `planTrade` /
 *                                           `prepareAndBuildSwap` (which both expect
 *                                           token base units, not BCH).
 *                                      SELL: token base units (the position's
 *                                            `entry.token_amount_base`).
 * @property {string} destination      cashaddr (receives tokens for buy, BCH for sell)
 * @property {Object} [tokenMeta]      optional pre-resolved token metadata
 * @property {Object} [dexAdapter]     T57-3: per-call adapter override. When set,
 *                                      this single trade is routed through the
 *                                      adapter's prepareAndBuildSwap + broadcastTx
 *                                      + verifyTrade instead of the executor's
 *                                      default. The trader loop uses this to
 *                                      route each candidate to the adapter with
 *                                      the best effective rate (selected via
 *                                      `src/trader/dex-router.mjs`). The legacy
 *                                      `deps.{...}` injection seam still wins
 *                                      over the override when set.
 * @property {bigint} [expectedRateSats]  sats/token (defaults to the SDK's spot rate)
 */

/**
 * @typedef {Object} SwapResult
 * @property {boolean} ok
 * @property {'buy'|'sell'} side
 * @property {string} tokenId
 * @property {bigint} amountBase           the amount the executor actually traded:
 *                                          BUY:  token base units (translated from
 *                                                the operator's BCH-sats budget via
 *                                                `maxTokensForBudget`).
 *                                          SELL: token base units (echoes input).
 * @property {bigint} effectiveRateSats        volume-weighted rate (incl. LP fee)
 * @property {bigint} expectedRateSats         spot / user-supplied expected
 * @property {bigint} slippageBps              int bps; +ve = worse than expected
 * @property {bigint} totalSatsInOrOut         sats paid (buy) or received (sell)
 * @property {bigint} lpFeeSats
 * @property {bigint} estNetworkFeeSats
 * @property {Array}  allocations              pool-by-pool breakdown
 * @property {string} [txid]                   set when broadcast succeeded
 * @property {Object} [verification]           set when verifyTrade() ran
 * @property {bigint} walletBalanceAfterSats   post-trade balance snapshot
 * @property {string} ts                       ISO timestamp
 * @property {string} [error]                  populated only when ok=false
 * @property {string} [errorKind]
 */

// ─────────────────────────────────────────────────────────────────────
//  Rate-unit normalization (B04 / bug-exit-failed-20260916)
//
// The indexer's `PoolStats.price_now_sats` is sats per DISPLAY unit;
// `plan.effectiveRate` (from `planTrade`) is sats per BASE unit.
// Without a unit conversion at this boundary the slippage math
// compares two rates in different units — for any token with
// `token_decimals >= 2` the SDK's `totalSupply / amount` bigint-
// floors to `0n`, every SELL pre-flight trips on
// `slippage_exceeded` with `~10000 bps` reported, and the position
// is stuck. See `src/trader/rate-units.mjs` for the full story.
// ─────────────────────────────────────────────────────────────────────
import {
  normalizeExpectedRateToBase,
} from './rate-units.mjs';

// ─────────────────────────────────────────────────────────────────────
//  Token-amount budget helper (T28)
// ─────────────────────────────────────────────────────────────────────

/**
 * @private — constants used by `maxTokensForBudget`. Mirrors the
 * cauldron-swap-sdk's internal fee math (`planning.js`,
 * `maxTokensForBudget`) so the two stay in lockstep at planning
 * time. `DUST_SATS`, `BASE_TX_OVERHEAD_SATS`, `SATS_PER_BYTE` come
 * from `PUBLIC_CONSTANTS` in `cauldron/check_and_swap.mjs`. The
 * per-extra-pool fee is SDK-private and stable on BCH (600 sats
 * per additional pool consumed by the multi-pool buy plan).
 */
const _PER_EXTRA_POOL_FEE_SATS = 600n;

/**
 * Largest base-unit token amount buyable through `pools` while
 * staying within `budgetSats` BCH. Mirrors the SDK's
 * `maxTokensForBudget` (which is not re-exported from the package
 * root) so we can use it without deep-importing `planning.js`.
 *
 * Algorithm: binary search over `[1, totalLiquidity]` using
 * `computeOptimalBuy` to test "does this token amount fit the
 * budget?" incl. AMM slippage + LP fee + base tx overhead + the
 * per-pool incremental overhead + dust for the change output.
 *
 * Returns `0n` for empty pools / zero budget / budget too small to
 * afford even 1 base-unit of the cheapest token.
 *
 * @param {Array} pools              active cauldron pools (must have .sats, .tokens)
 * @param {bigint} budgetSats        BCH budget in satoshis
 * @returns {bigint}
 */
export function maxTokensForBudget(pools, budgetSats) {
  if (!Array.isArray(pools) || pools.length === 0) return 0n;
  if (typeof budgetSats !== 'bigint' || budgetSats <= 0n) return 0n;

  // Total liquid token supply across pools, leaving 1 base unit in
  // each pool as reserve (matches the SDK's `MIN_POOL_TOKENS_REMAINING`).
  let totalLiquidity = 0n;
  for (const p of pools) {
    if (!p || typeof p !== 'object') return 0n;
    const t = (typeof p.tokens === 'bigint') ? p.tokens : BigInt(p.tokens ?? 0);
    totalLiquidity += t - 1n;
    if (totalLiquidity < 0n) totalLiquidity = 0n;
  }
  if (totalLiquidity <= 0n) return 0n;

  const fits = (tokens) => {
    try {
      const allocs = computeOptimalBuy(pools, tokens, PUBLIC_CONSTANTS.SATS_PER_BYTE);
      let cost = 0n;
      for (const a of allocs) cost += a.supplyAmount;
      const baseFee = PUBLIC_CONSTANTS.BASE_TX_OVERHEAD_SATS
        + _PER_EXTRA_POOL_FEE_SATS * BigInt(Math.max(0, allocs.length - 1));
      return cost + PUBLIC_CONSTANTS.DUST_SATS + baseFee <= budgetSats;
    } catch {
      return false;
    }
  };

  if (!fits(1n)) return 0n;
  let lo = 1n;
  let hi = totalLiquidity;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

export class SwapExecutor {
  /**
   * @param {SwapExecutorOpts} opts
   */
  constructor(opts) {
    if (!opts || typeof opts !== 'object') {
      throw new SwapConfigError('SwapExecutor: opts is required');
    }
    if (!opts.cfg) throw new SwapConfigError('SwapExecutor: cfg is required');
    if (!opts.wallet) throw new SwapConfigError('SwapExecutor: wallet is required');
    this.cfg = opts.cfg;
    this.wallet = opts.wallet;
    this.logger = opts.logger ?? createLogger({ sink: process.stderr });
    this.deps = opts.deps ?? {};
    /**
     * T53.2: optional AlertRouter seam. When provided, the executor
     * dispatches `slippage_spike` / `risk_threshold` / `wallet_floor`
     * events on preflight rejection so the operator's Telegram / log
     * subscribers see why a trade was refused. Dispatch is
     * fire-and-forget and NEVER throws — a Telegram outage cannot
     * kill a live swap. Default = `null` (no alerts; legacy behavior).
     * @private
     */
    this._safeAlertDispatch = (typeof opts.safeAlertDispatch === 'function')
      ? opts.safeAlertDispatch
      : null;
    /**
     * T53.2: optional alerts NDJSON writer seam. Independent from
     * `_safeAlertDispatch` so operators can disable channel routing
     * (e.g. telegram-bot maintenance) without losing the audit
     * trail. Default = `null`.
     * @private
     */
    this._alertsAppend = (typeof opts.alertsAppend === 'function')
      ? opts.alertsAppend
      : null;
    // T57-3: when a `dexAdapter` is provided, route the
    // prepare/build/broadcast/verify path through its methods.
    // The legacy `deps.{prepareAndBuildSwap,broadcastTx,verifyTrade}`
    // injection seam still wins when set (so existing tests don't
    // need to change); this just lets the trader loop pick the
    // adapter per-candidate without rebuilding the executor.
    //
    // Validation: the adapter must expose the methods the executor
    // uses. CauldronSafeMode + Cauldron live adapters do; the
    // guanaco scaffold throws GuanacoNotImplementedError — but
    // the executor only sees an adapter when `bootDexAdapters`
    // succeeded (which it can't for guanaco today since the
    // factory itself throws when the operator didn't set the
    // indexer URL + sdk_module). When that DOES happen in a
    // future tick, `this.dexAdapter.prepareAndBuildSwap(...)` will
    // throw at the call site and we'll catch + return a typed
    // failure — see the build step below for the catch path.
    if (opts.dexAdapter !== undefined && opts.dexAdapter !== null) {
      if (typeof opts.dexAdapter !== 'object') {
        throw new SwapConfigError('SwapExecutor: dexAdapter must be an object when provided');
      }
      if (typeof opts.dexAdapter.prepareAndBuildSwap !== 'function'
        || typeof opts.dexAdapter.broadcastTx !== 'function'
        || typeof opts.dexAdapter.verifyTrade !== 'function') {
        throw new SwapConfigError(
          'SwapExecutor: dexAdapter must expose prepareAndBuildSwap + broadcastTx + verifyTrade (got adapter '
          + `id=${JSON.stringify(opts.dexAdapter.id)}); use src/dex/adapter.mjs#createDexAdapter to build a valid adapter`,
        );
      }
      this.dexAdapter = opts.dexAdapter;
    } else {
      this.dexAdapter = null;
    }
  }

  /**
   * Execute a single swap (or plan-only when `request.dryRun` is set).
   * Returns a structured result; never throws on trade failures (those
   * come back as `{ ok: false, error, errorKind }`). Throws only on
   * CONFIG / wiring failures (no WIF, no address, etc.) — those are
   * programmer errors and should fail fast.
   *
   * @param {SwapRequest & { dryRun?: boolean }} request
   * @returns {Promise<SwapResult>}
   */
  async execute(request) {
    if (!request || typeof request !== 'object') {
      throw new SwapConfigError('SwapExecutor.execute: request is required');
    }
    const { tokenId, side, amountBase, destination, dryRun = false } = request;
    if (!tokenId || typeof tokenId !== 'string') {
      throw new SwapConfigError('SwapExecutor.execute: tokenId is required');
    }
    if (side !== 'buy' && side !== 'sell') {
      throw new SwapConfigError(`SwapExecutor.execute: side must be 'buy' or 'sell'; got ${JSON.stringify(side)}`);
    }
    if (typeof amountBase !== 'bigint' || amountBase <= 0n) {
      throw new SwapConfigError(`SwapExecutor.execute: amountBase must be a positive bigint; got ${amountBase}`);
    }
    if (!destination || !destination.startsWith('bitcoincash:')) {
      throw new SwapConfigError('SwapExecutor.execute: destination must start with bitcoincash:');
    }

    // WIF availability check — production path only. The throw must
    // escape `execute()` so the trader loop sees the `SwapConfigError`
    // and marks the tick as a wiring failure (vs. the soft `_failure`
    // result the catch blocks below would emit for in-band errors).
    //
    // Test path skips this check entirely: injected
    // `deps.prepareAndBuildSwap` mocks implement their own signing
    // surface and don't need a real WIF. This check happens BEFORE
    // any network call so a wallet that was never `init()`'d fails
    // fast — no point burning an indexer round-trip just to discover
    // the signer is missing.
    if (!this.deps.prepareAndBuildSwap) {
      const wif = this.wallet._wif;
      if (typeof wif !== 'string' || wif.length < 40) {
        throw new SwapConfigError(
          'SwapExecutor.execute: wallet WIF unavailable — call wallet.init() before execute()',
        );
      }
    }

    const ts = new Date().toISOString();
    // T57-3: when a `dexAdapter` is wired into this executor,
    // route `prepareAndBuildSwap` / `broadcastTx` / `verifyTrade`
    // through its methods so the multi-DEX trader loop can pick
    // the adapter per-candidate. `getPoolsAndMeta` defaults to
    // the adapter's too — that's the source-of-truth for the
    // trade's pool list, and the loop's `dex-router.mjs` already
    // chose the adapter based on those pools. Legacy
    // `deps.{...}` injection still wins when set, so existing
    // tests (which inject mocks) keep working without rewriting.
    //
    // Per-call override: `request.dexAdapter` wins over the
    // constructor adapter when set, letting the trader loop pick
    // the adapter on a per-candidate basis without rebuilding
    // the executor. The per-call adapter must satisfy the same
    // shape contract as the constructor adapter (validated
    // below).
    let adapter = this.dexAdapter;
    if (request.dexAdapter !== undefined && request.dexAdapter !== null) {
      if (typeof request.dexAdapter !== 'object') {
        throw new SwapConfigError('SwapExecutor.execute: request.dexAdapter must be an object when provided');
      }
      if (typeof request.dexAdapter.prepareAndBuildSwap !== 'function'
        || typeof request.dexAdapter.broadcastTx !== 'function'
        || typeof request.dexAdapter.verifyTrade !== 'function') {
        throw new SwapConfigError(
          'SwapExecutor.execute: request.dexAdapter must expose prepareAndBuildSwap + broadcastTx + verifyTrade (got adapter '
          + `id=${JSON.stringify(request.dexAdapter.id)})`,
        );
      }
      adapter = request.dexAdapter;
    }
    const getPoolsAndMetaFn = this.deps.getPoolsAndMeta
      ?? (adapter && typeof adapter.getPoolsAndMeta === 'function'
          // Wrap in an arrow so the method's `this` binding
          // stays anchored to the adapter object. Without this,
          // adapters that read `this.calls` / `this.config` /
          // similar per-instance state get an `undefined` `this`
          // and crash with "Cannot read properties of undefined".
          ? (req) => adapter.getPoolsAndMeta(req)
          : getPoolsAndMeta);
    const planFn = this.deps.planTrade ?? planTrade;
    const prepFn = this.deps.prepareAndBuildSwap
      ?? (adapter && typeof adapter.prepareAndBuildSwap === 'function'
          ? (args) => adapter.prepareAndBuildSwap(args)
          : prepareAndBuildSwap);
    const bcastFn = this.deps.broadcastTx
      ?? (adapter && typeof adapter.broadcastTx === 'function'
          ? (args) => adapter.broadcastTx(args)
          : broadcastTx);
    const verifyFn = this.deps.verifyTrade
      ?? (adapter && typeof adapter.verifyTrade === 'function'
          ? (args) => adapter.verifyTrade(args)
          : verifyTrade);
    /** @type {(pools: Array, budgetSats: bigint) => bigint} */
    const maxTokensFn = this.deps.maxTokensForBudget ?? maxTokensForBudget;

    // T28: `effectiveAmountBase` starts as the input `amountBase`
    // (token base units for SELL, BCH sats for BUY — see JSDoc).
    // For BUY, step 2 below rewrites it to the token base units the
    // SDK actually expects. Pre-translation failures (pools_fetch,
    // budget) report the input value; post-translation failures
    // report the token amount we tried to trade.
    let effectiveAmountBase = amountBase;

    // 1. Fetch pools + meta.
    let poolsAndMeta;
    try {
      poolsAndMeta = await getPoolsAndMetaFn({ tokenId });
    } catch (e) {
      this.logger.error('swap.pools.error', {
        token_id: tokenId, side, amount_base: amountBase.toString(),
        err_name: e?.name ?? 'Error', err_message: e?.message ?? String(e),
      });
      return this._failure({ ts, tokenId, side, amountBase: effectiveAmountBase, error: `pools fetch: ${e.message}`, errorKind: 'pools_fetch' });
    }
    const { pools } = poolsAndMeta;
    // T55: extract the total AMM depth for the per-token slippage cap.
    // `poolsAndMeta.totalSats` is the sum of BCH-side sats across all
    // active pools for this token (sourced from the cauldron indexer
    // via `getPoolsAndMeta`). BigInt coerced; `null` when missing.
    const poolDepthSats = (() => {
      const v = poolsAndMeta.totalSats;
      if (typeof v === 'bigint' && v > 0n) return v;
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
        return BigInt(Math.trunc(v));
      }
      return null;
    })();
    // B04 FIX (tokenMeta plumbing): `getPoolsAndMeta` only resolves
    // `tokenMeta` when called with a `symbol`. The trader loop's
    // exit/entry paths pass only `tokenId` — so `poolsAndMeta.tokenMeta`
    // arrives as `null`. Without decimals the rate-units helper falls
    // through to passing the per-display value verbatim, recreating the
    // original ~10000-bps false positive. The caller can pre-resolve
    // `tokenMeta` from the indexer's BCMR (`buildStatsRecord` already
    // extracts `bcmr.token.decimals`); honor it here before falling
    // back to the (null) value returned by `getPoolsAndMeta`.
    const tokenMeta = request.tokenMeta ?? poolsAndMeta.tokenMeta ?? null;
    const { buySpot, sellSpot } = spotRates(pools);
    const spotRate = side === 'buy' ? buySpot : sellSpot;

    // 2. BUY path — translate BCH-sats budget into token base units.
    //    T28 (latent since T03): the operator passes `amountBase` in
    //    BCH satoshis (the amount they want to spend). The SDK's
    //    `computeOptimalBuy` + `prepareBuyTokens` both interpret
    //    `amount` as TOKENS TO BUY (base units). For tokens where
    //    1 base unit > 1 sat, feeding BCH sats into the SDK made the
    //    swap ask for way more BCH than the wallet had, producing
    //    the "Insufficient BCH to cover the required amount" throw
    //    on every BUY. T27 fixed the pre-flight `amountBch`
    //    arithmetic but the bug upstream of that (BCH-sats masquerading
    //    as token base units all the way through planTrade +
    //    prepareAndBuildSwap) was untouched, so every BUY since then
    //    has been failing at the SDK's UTXO gather.
    //
    //    Fix: for BUY, run `maxTokensForBudget(pools, amountBase)` to
    //    get the largest token base-unit amount that the BCH-sats
    //    budget can afford (binary search over `computeOptimalBuy`).
    //    The resulting `effectiveAmountBase` is what `planTrade` and
    //    `prepareAndBuildSwap` actually want.
    //
    //    For SELL, `amountBase` is already in token base units (the
    //    position's `entry.token_amount_base`); pass it through.
    //    (Initialized earlier so pre-translation failures can report it.)
    if (side === 'buy') {
      try {
        effectiveAmountBase = maxTokensFn(pools, amountBase);
      } catch (e) {
        this.logger.error('swap.budget.error', {
          token_id: tokenId, side,
          bch_budget_sats: amountBase.toString(),
          err_name: e?.name ?? 'Error', err_message: e?.message ?? String(e),
        });
        return this._failure({ ts, tokenId, side, amountBase: effectiveAmountBase, error: `budget: ${e.message}`, errorKind: 'budget' });
      }
      if (effectiveAmountBase <= 0n) {
        // BCH budget too small to afford even 1 base unit of the
        // cheapest pool. Surface as a clean refusal so the operator
        // can see "this pool / this size is below dust".
        this.logger.warn('swap.budget.too_small', {
          token_id: tokenId, side,
          bch_budget_sats: amountBase.toString(),
          pool_count: pools.length,
          pool_liquidity_tokens: pools.map((p) => String(p.tokens ?? 0)).join(','),
        });
        return this._failure({
          ts, tokenId, side, amountBase: effectiveAmountBase,
          error: `BCH budget ${amountBase} sats too small for any pool allocation (max tokens for budget = 0)`,
          errorKind: 'below_dust',
        });
      }
    }

    // 3. Plan the trade. We thread `expectedRateSats` through (when
    //    the caller supplied one) so mocked `planTrade` can derive
    //    a deterministic `effectiveRate` from the same reference
    //    price the slippage check will compare against. Production
    //    `planTrade` ignores the hint (it derives its own marginal
    //    rate from pool reserves) so the slippage check stays
    //    accurate end-to-end.
    let plan;
    try {
      plan = planFn({
        side,
        amount: effectiveAmountBase,
        pools,
        expectedRateSats: request.expectedRateSats ?? null,
      });
    } catch (e) {
      this.logger.error('swap.plan.error', {
        token_id: tokenId, side,
        amount_base: amountBase.toString(),
        effective_amount_base: effectiveAmountBase.toString(),
        err_name: e?.name ?? 'Error', err_message: e?.message ?? String(e),
      });
      return this._failure({ ts, tokenId, side, amountBase: effectiveAmountBase, error: `plan: ${e.message}`, errorKind: 'plan' });
    }

    // 2.5. Pool-shape pre-flight (B02 / ROACH entry failed).
    // The cauldron-swap-sdk's `buildCauldronInputsOutputs(allocations, 'buy', ...)`
    // computes `newTokensOutput = ceilDiv(poolConstantK, newSatsExclFee)` for each
    // pool's output token amount. By ceiling math, this is always <= `newTokens
    // = pool.tokens - demandAmount`, and is strictly less on pools whose
    // `tokens * sats` doesn't divide cleanly against the post-trade token count.
    // The shortfall tips cashscript's `checkFungibleTokenBurn()` strict <
    // check (inputAmount > outputAmount by even 1 token) which rejects the
    // swap at `builder.build()` with "Implicit burning of fungible tokens for
    // category <X>". See bug-roach-entry-failed-20260916.
    //
    // Detect the symptom BEFORE calling `prepareAndBuildSwap` so the swap is
    // refused with `errorKind: 'pool_shape'` instead of a raw `build/sign`
    // failure. The trader loop's `swap.preflight.reject` path then sees a
    // structured refusal it can distinguish from a transient slippage miss.
    const shapeAnalysis = analyzePlanForImplicitBurn(plan.allocations, side);
    if (shapeAnalysis.burns) {
      const badPoolsList = shapeAnalysis.badPools.map((bp) => bp.pool.pool_id ?? bp.pool.id ?? 'unknown').join(',');
      this.logger.warn('swap.pool_shape.reject', {
        token_id: tokenId, side,
        amount_base: amountBase.toString(),
        effective_amount_base: effectiveAmountBase.toString(),
        bad_pool_count: shapeAnalysis.badPools.length,
        bad_pool_ids: badPoolsList,
        total_input_tokens: shapeAnalysis.totalInputTokens.toString(),
        total_output_tokens: shapeAnalysis.totalOutputTokens.toString(),
        total_demand: shapeAnalysis.totalDemand.toString(),
        deficit: shapeAnalysis.deficit.toString(),
      });
      return this._failure({
        ts, tokenId, side, amountBase: effectiveAmountBase,
        error: `pool shape: ${shapeAnalysis.badPools.length} of ${plan.allocations.length} pool(s) would cause implicit fungible-token burn (deficit ${shapeAnalysis.deficit} tokens across category); refusing swap to avoid on-chain rejection`,
        errorKind: 'pool_shape',
      });
    }

    // 3. Compute slippage vs expected rate. Coerce the SDK's `number`
    //    marginal spot rate into bigint; `plan.effectiveRate` is already
    //    bigint.
    //
    // B04 / bug-exit-failed-20260916: the caller passes
    // `expectedRateSats` from the indexer (`stats.price_now_sats`),
    // which is sats per DISPLAY unit. `plan.effectiveRate` is sats
    // per BASE unit (= `totalSupply / amount`). Without a unit
    // conversion the slippage arithmetic compares two rates in
    // different units — for any `token_decimals >= 2` token the
    // per-base rate bigint-floors to `0n` and the pre-flight trips
    // on `slippage_exceeded` with ~10000 bps reported, leaving the
    // position stuck (see `src/trader/rate-units.mjs`). The SDK's
    // `spotRates(pools)` (the fallback path) is also per-base-unit
    // because the SDK's `bestMarginalBuyRate` / `bestMarginalSellRate`
    // divide `pool.sats / pool.tokens` where `pool.tokens` is in base
    // units. So the conversion is needed only when the CALLER
    // supplied `expectedRateSats` (which is the indexer-fed case).
    //
    // `tokenMeta.decimals` is the only knob needed for the
    // conversion. When missing / invalid the helper passes the
    // input through verbatim, preserving back-compat with the
    // existing per-base-unit test fixtures.
    const tokenDecimals = (tokenMeta
      && typeof tokenMeta.decimals === 'number'
      && Number.isInteger(tokenMeta.decimals)
      && tokenMeta.decimals >= 0
      && tokenMeta.decimals <= 32)
      ? tokenMeta.decimals
      : null;
    const expectedRateRaw = (() => {
      if (request.expectedRateSats != null) {
        // Caller-supplied path: indexer-style per-DISPLAY-unit rate
        // needs to be normalized to per-BASE-unit before the slippage
        // math. Returns `null` only when the helper couldn't coerce
        // the input at all (e.g. garbage string).
        return normalizeExpectedRateToBase(request.expectedRateSats, tokenDecimals);
      }
      // Fallback path: SDK spot rate (already per-base) or
      // plan.effectiveRate as a last resort (also per-base).
      if (spotRate != null) return toBig(spotRate) ?? plan.effectiveRate;
      return plan.effectiveRate;
    })();
    const expectedRate = expectedRateRaw ?? plan.effectiveRate;
    const slippageBps = computeSlippageBps(side, expectedRate, plan.effectiveRate);

    // 4. Pre-flight (position size / exposure / wallet floor / slippage).
    //
    // T28 update: for BUY the `amountBase` parameter is BCH SATS
    // (the operator's input budget). `plan.totalSupply` is the
    // actual BCH the AMM will consume (after slippage + LP fee),
    // which is the right number to gate against `max_position_bch`
    // + `max_total_exposure_bch` + wallet-floor. They differ by
    // ~0.3% (LP fee); using `totalSupply` is strictly more accurate
    // for BUY and exactly matches SELL's `amountBch` definition.
    //
    // T27 also flagged a related issue (plan.totalSupply is the
    // OUTPUT side of the swap, not the input — tokens for BUY, BCH
    // for SELL). But T27 only corrected SELL's path; BUY still used
    // `Number(amountBase) / 1e8`. With T28's amountBase=BCH-sats
    // semantics that BUY path now also reads from plan.totalSupply,
    // keeping the two sides consistent.
    //
    // Semantics:
    //   - BUY:  amountBch = BCH the swap will spend
    //           (= plan.totalSupply, the AMM's cost incl. slippage).
    //   - SELL: amountBch = BCH the swap will return
    //           (= plan.totalSupply, the AMM's payout).
    const amountBch = Number(plan.totalSupply) / 1e8;
    const openExposureBch = this.deps.openExposureBch ?? 0;
    let walletBalanceSats = 0n;
    try {
      walletBalanceSats = await this.wallet.getBalanceSats();
    } catch (e) {
      this.logger.error('swap.balance.error', {
        err_name: e?.name ?? 'Error', err_message: e?.message ?? String(e),
      });
      return this._failure({ ts, tokenId, side, amountBase: effectiveAmountBase, error: `balance: ${e.message}`, errorKind: 'balance' });
    }
    // T55: resolve the effective slippage cap (flat OR per-token
    // derived from AMM depth) BEFORE the pre-flight check so the
    // audit log can stamp which source gated the trade. The same
    // resolution happens inside `preFlightCheck` — this is a log-only
    // mirror for the operator.
    const slippageCap = resolveEffectiveSlippageCapBps({
      cfg: this.cfg,
      amountBch,
      poolDepthSats,
    });
    try {
      preFlightCheck({
        cfg: this.cfg,
        side,
        amountBch,
        walletBalanceSats,
        openExposureBch,
        slippageBps,
        poolDepthSats,
      });
    } catch (e) {
      this.logger.error('swap.preflight.reject', {
        token_id: tokenId, side, amount_base: amountBase.toString(),
        amount_bch: amountBch, slippage_bps: slippageBps.toString(),
        wallet_balance_sats: walletBalanceSats.toString(),
        open_exposure_bch: openExposureBch,
        pool_depth_sats: poolDepthSats ? poolDepthSats.toString() : null,
        slippage_cap_bps: slippageCap.capBps.toString(),
        slippage_cap_source: slippageCap.source,
        err_name: e?.name ?? 'Error', err_message: e?.message ?? String(e),
        err_kind: e?.kind ?? 'preflight',
      });
      // T53.2: outbound alerts. Map the preflight error kind to the
      // alert kind (slippage_spike / risk_threshold / wallet_floor)
      // and dispatch through both the channel router AND the NDJSON
      // writer. Both never throw; a dispatch failure cannot kill the
      // swap path.
      void this._dispatchPreflightReject({
        token_id: tokenId, side, amount_bch: amountBch,
        slippage_bps: slippageBps.toString(),
        wallet_balance_sats: walletBalanceSats.toString(),
        open_exposure_bch: openExposureBch,
        error_kind: e?.kind ?? 'preflight',
        error_message: e?.message ?? String(e),
        ts,
      });
      return this._failure({
        ts, tokenId, side, amountBase: effectiveAmountBase,
        error: `preflight: ${e.message}`,
        errorKind: e?.kind ?? 'preflight',
      });
    }

    if (dryRun) {
      // 5. Dry-run path: skip build + broadcast + verify.
      this.logger.info('swap.dry_run.ok', {
        ts, token_id: tokenId, side,
        bch_budget_sats: amountBase.toString(),
        effective_amount_base: effectiveAmountBase.toString(),
        effective_rate_sats: plan.effectiveRate.toString(),
        expected_rate_sats: expectedRate.toString(),
        rate_basis: 'per_base_unit',
        rate_decimals: tokenDecimals,
        slippage_bps: slippageBps.toString(),
        slippage_cap_bps: slippageCap.capBps.toString(),
        slippage_cap_source: slippageCap.source,
        total_sats: plan.totalSupply.toString(),
        lp_fee_sats: plan.totalFees.toString(),
        est_network_fee_sats: plan.estNetworkFeeSats.toString(),
        pool_count: plan.allocations.length,
        pool_depth_sats: poolDepthSats ? poolDepthSats.toString() : null,
        wallet_balance_sats: walletBalanceSats.toString(),
      });
      return {
        ok: true,
        side, tokenId,
        amountBase: effectiveAmountBase,
        effectiveRateSats: plan.effectiveRate,
        expectedRateSats: expectedRate,
        slippageBps,
        totalSatsInOrOut: plan.totalSupply,
        lpFeeSats: plan.totalFees,
        estNetworkFeeSats: plan.estNetworkFeeSats,
        allocations: plan.allocations,
        walletBalanceAfterSats: walletBalanceSats,
        ts,
        tokenMeta: tokenMeta ?? null,
      };
    }

    // 5. Build + sign.
    // Production path: the wallet does not export its WIF — pass
    // `null` and let the executor retrieve it from the wallet's
    // signer path. The trimmed `check_and_swap.mjs` requires a WIF;
    // we re-use the wallet's own private key by going through
    // `wallet.signHash(...)` indirectly: since `prepareAndBuildSwap`
    // calls the SDK's `prepareBuyTokens`/`prepareSellTokens` with a
    // WIF, we hand it the wallet's own WIF via the `wallet._wif`
    // private field. To keep `wallet.mjs`'s public API narrow, this
    // is the ONE place we reach into it.
    //
    // Test path: when `deps.prepareAndBuildSwap` is injected, we
    // skip the WIF lookup entirely — the mock implements its own
    // signing surface and doesn't need a real WIF. Production tests
    // always inject a mock (see `buildSwapExecutor` in
    // tests/integration/pipeline.test.mjs); production calls always
    // fall through to the WIF lookup.
    //
    // `electrumProvider` is declared in the outer scope so it is
    // visible to `bcastFn({ txHex, electrumProvider })` and
    // `verifyFn({ ..., electrumProvider })` below, regardless of
    // which branch we took. In the test branch we leave it as
    // `null`; the injected `broadcastTx` / `verifyTrade` mocks
    // ignore it (the production broadcastTx would refuse a null
    // provider, so this stays a test-only fast path).
    // WIF availability is checked at the top of `execute()` (before
    // any network call) — production code now throws `SwapConfigError`
    // there. Production tests always inject a `deps.prepareAndBuildSwap`
    // mock so the early check is skipped and this path runs to
    // completion.

    let txHex;
    let electrumProvider = null;
    try {
      if (this.deps.prepareAndBuildSwap) {
        const out = await prepFn({
          side,
          allocations: plan.allocations,
          amount: effectiveAmountBase,
          destination,
          wallet: this.wallet,
          sdk: this.deps.sdk,
        });
        txHex = out.txHex;
      } else {
        const wif = this.wallet._wif;
        electrumProvider = await this.wallet._provider
          ?? (await this.wallet._resolveDeps()).provider;
        const out = await prepFn({
          side,
          allocations: plan.allocations,
          amount: effectiveAmountBase,
          destination,
          wallet: this.wallet,
          wif,
          electrumProvider,
          sdk: this.deps.sdk,
        });
        txHex = out.txHex;
      }
    } catch (e) {
      this.logger.error('swap.build.error', {
        token_id: tokenId, side,
        amount_base: amountBase.toString(),
        effective_amount_base: effectiveAmountBase.toString(),
        err_name: e?.name ?? 'Error', err_message: e?.message ?? String(e),
      });
      return this._failure({
        ts, tokenId, side, amountBase: effectiveAmountBase,
        error: `build/sign: ${e.message}`,
        errorKind: 'build',
      });
    }

    // 6. Broadcast.
    let txid;
    try {
      txid = await bcastFn({ txHex, electrumProvider });
    } catch (e) {
      this.logger.error('swap.broadcast.error', {
        token_id: tokenId, side, amount_base: amountBase.toString(),
        err_name: e?.name ?? 'Error', err_message: e?.message ?? String(e),
      });
      return this._failure({
        ts, tokenId, side, amountBase: effectiveAmountBase,
        error: `broadcast: ${e.message}`,
        errorKind: 'broadcast',
      });
    }

    // 7. Verify (post-trade check) — best-effort, never blocks on failure.
    let verification = null;
    try {
      verification = await verifyFn({
        txid,
        tokenId,
        expectedEffectiveRate: expectedRate,
        electrumProvider,
      });
    } catch (e) {
      // Verification failures are advisory — the swap itself is on chain.
      this.logger.warn('swap.verify.error', {
        token_id: tokenId, txid,
        err_name: e?.name ?? 'Error', err_message: e?.message ?? String(e),
      });
    }

    // 8. Refresh balance snapshot for the audit log.
    let walletBalanceAfterSats = walletBalanceSats;
    try {
      walletBalanceAfterSats = await this.wallet.getBalanceSats();
    } catch (e) {
      this.logger.warn('swap.balance.refresh-failed', {
        err_name: e?.name ?? 'Error', err_message: e?.message ?? String(e),
      });
    }

    // 9. Emit the audit-event the mission rules require.
    //    T28: for BUY, `tokens_in_or_out` is `+effectiveAmountBase`
    //    (the token base units the swap delivers), NOT the BCH-sats
    //    budget. The budget was the INPUT, not the received amount.
    const event = {
      ts,
      token_id: tokenId,
      side,
      // T57-3: surface the DEX adapter id + safe-mode flag on
      // every audit event so the operator can tell which DEX
      // settled the trade (cauldron, cauldron_safe_mode,
      // guanaco, ...). `null` dex_id when no adapter is wired
      // (legacy code paths that bypass the abstraction — only
      // the test mocks today). `dex_safe_mode` is a boolean
      // (never null) so JSON consumers can rely on the type —
      // `false` when the adapter is missing OR present-but-not-
      // safe-mode, `true` when the cauldron_safe_mode adapter
      // (or any future safe-mode adapter) actually settled.
      dex_id: adapter && typeof adapter.id === 'string' ? adapter.id : null,
      dex_safe_mode: Boolean(adapter && adapter.safeMode === true),
      bch_in_or_out: side === 'buy'
        ? `-${plan.totalSupply.toString()}`
        : `+${plan.totalSupply.toString()}`,
      tokens_in_or_out: side === 'buy'
        ? `+${effectiveAmountBase.toString()}`
        : `-${effectiveAmountBase.toString()}`,
      bch_budget_sats: side === 'buy' ? amountBase.toString() : null,
      entry_price: plan.effectiveRate.toString(),
      expected_price: expectedRate.toString(),
      rate_basis: 'per_base_unit',
      rate_decimals: tokenDecimals,
      actual_slippage_bps: slippageBps.toString(),
      txid,
      balance_after: walletBalanceAfterSats.toString(),
      lp_fee_sats: plan.totalFees.toString(),
      est_network_fee_sats: plan.estNetworkFeeSats.toString(),
      verification_kind: verification?.kind ?? null,
      // T55: surface the per-token slippage cap that gated the trade
      // so the operator can confirm the depth-aware cap was applied
      // (or that the flat cap was the fallback for shallow pools).
      slippage_cap_bps: slippageCap.capBps.toString(),
      slippage_cap_source: slippageCap.source,
      pool_depth_sats: poolDepthSats ? poolDepthSats.toString() : null,
    };
    if (side === 'buy') {
      this.logger.info('trade.entry', event);
    } else {
      this.logger.info('trade.exit', event);
    }

    return {
      ok: true,
      side,
      tokenId,
      amountBase: effectiveAmountBase,
      effectiveRateSats: plan.effectiveRate,
      expectedRateSats: expectedRate,
      slippageBps,
      totalSatsInOrOut: plan.totalSupply,
      lpFeeSats: plan.totalFees,
      estNetworkFeeSats: plan.estNetworkFeeSats,
      allocations: plan.allocations,
      txid,
      verification,
      walletBalanceAfterSats,
      ts,
      tokenMeta: tokenMeta ?? null,
    };
  }

  /**
   * Wrap a failed result. Pure — easy to test.
   * @private
   */
  _failure({ ts, tokenId, side, amountBase, error, errorKind }) {
    return {
      ok: false,
      side,
      tokenId,
      amountBase,
      effectiveRateSats: 0n,
      expectedRateSats: 0n,
      slippageBps: 0n,
      totalSatsInOrOut: 0n,
      lpFeeSats: 0n,
      estNetworkFeeSats: 0n,
      allocations: [],
      walletBalanceAfterSats: 0n,
      ts,
      error,
      errorKind,
    };
  }

  /**
   * T53.2 — fire an AlertEvent when preflight rejects the trade.
   * Maps the preflight error kind to the canonical alert kind:
   *   - `slippage_exceeded` -> `slippage_spike`
   *   - `below_floor`        -> `wallet_floor`
   *   - `exposure_exceeded`  -> `risk_threshold`
   *   - `position_too_large`-> `risk_threshold`
   *   - anything else        -> `risk_threshold` (defensive)
   *
   * Never throws — a dispatch failure cannot kill the swap path.
   *
   * @private
   * @param {Object} ctx
   */
  async _dispatchPreflightReject(ctx) {
    const ts = (ctx && Number.isFinite(ctx.ts)) ? Number(ctx.ts) : Date.now();
    const errKind = (ctx && typeof ctx.error_kind === 'string') ? ctx.error_kind : 'preflight';
    /** @type {{kind: string, severity: 'warn'|'error', title: string, body: string, context: Object}} */
    let mapped;
    if (errKind === 'slippage_exceeded') {
      mapped = {
        kind: 'slippage_spike',
        severity: 'warn',
        title: 'swap_slippage_rejected',
        body: `slippage ${ctx.slippage_bps ?? '?'} bps exceeds tolerance on ${ctx.token_id}`,
      };
    } else if (errKind === 'below_floor') {
      mapped = {
        kind: 'wallet_floor',
        severity: 'warn',
        title: 'swap_wallet_floor_breach',
        body: `wallet balance ${ctx.wallet_balance_sats ?? '?'} sats minus trade ${ctx.amount_bch ?? '?'} BCH would breach min_wallet_balance_bch on ${ctx.token_id}`,
      };
    } else if (errKind === 'exposure_exceeded' || errKind === 'position_too_large') {
      mapped = {
        kind: 'risk_threshold',
        severity: 'warn',
        title: `swap_${errKind}`,
        body: `position sizing on ${ctx.token_id} would breach ${errKind === 'exposure_exceeded' ? 'max_total_exposure_bch' : 'max_position_bch'}`,
      };
    } else {
      mapped = {
        kind: 'risk_threshold',
        severity: 'warn',
        title: 'swap_preflight_reject',
        body: `preflight rejected ${ctx.token_id}: ${ctx.error_message ?? errKind}`,
      };
    }
    const event = {
      ...mapped,
      context: {
        token_id: ctx.token_id ?? null,
        side: ctx.side ?? null,
        amount_bch: ctx.amount_bch ?? null,
        slippage_bps: ctx.slippage_bps ?? null,
        wallet_balance_sats: ctx.wallet_balance_sats ?? null,
        open_exposure_bch: ctx.open_exposure_bch ?? null,
        error_kind: errKind,
        error_message: ctx.error_message ?? null,
        ts,
      },
      ts,
    };
    await this._dispatchAlert(event, 'swap.dispatch');
  }

  /**
   * T53.2 — common dispatch helper. Routes through `_safeAlertDispatch`
   * (channel router) AND `_alertsAppend` (NDJSON writer); both are
   * independent and both never throw. Mirrors the same helper in
   * `src/risk/circuit-breaker.mjs`.
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
          this.logger.warn('swap.alerts_persist.failed', {
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
          this.logger.warn('swap.alerts_dispatch.failed', {
            event: logEvent,
            error: e?.message ?? String(e),
            kind: event?.kind ?? null,
          });
        }
      }
    }
  }
}

export const _internals = { SwapError, SwapConfigError, SwapPreFlightError, SwapInsufficientFundsError, SwapBroadcastError, SwapVerificationError };

// Re-export the few helpers the bot's entry/exit modules will reach for.
export { fmtSats, fmtBch };