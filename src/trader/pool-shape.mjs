// src/trader/pool-shape.mjs
//
// Pre-flight helpers for detecting Cauldron pools whose liquidity
// shape would cause the SDK to construct a swap transaction that
// cashscript rejects with "Implicit burning of fungible tokens for
// category <X>". The bot's `SwapExecutor.execute()` consults these
// helpers AFTER `planTrade()` returns its allocations but BEFORE
// `prepareAndBuildSwap()` is called, so the swap is rejected with a
// clean `errorKind:'pool_shape'` failure rather than a raw
// `prepareAndBuildSwap` exception.
//
// ───────────────────────────────────────────────────────────────────
//  WHY THIS EXISTS (the ROACH failure — bug-roach-entry-failed-20260916)
// ───────────────────────────────────────────────────────────────────
//
// On 2026-09-16 the bot retried a BUY into the ROACH pool every
// ~70 seconds for hours, each attempt producing:
//
//   prepareAndBuildSwap: tx build/sign failed:
//     Implicit burning of fungible tokens for category
//     892cef80a326f92583… is not allowed
//     (input amount: 11090684002, output amount: 11090683990)
//
// The root cause lives in `@mr-zwets/cauldron-swap-sdk`'s
// `buildCauldronInputsOutputs(allocations, 'buy', options)`:
//
//   const newSatsExclFee = ceilDiv(poolConstantK, newTokens);
//   const feeAmount = ceilDiv(tradeValue * 3n, 997n);
//   const newSats = newSatsExclFee + feeAmount;
//   const newTokensOutput = ceilDiv(poolConstantK, newSatsExclFee);
//
// The pool output carries `token.amount = newTokensOutput`. For
// ROACH, newTokensOutput computes to `pool.tokens − 12`, which
// cashscript's `checkFungibleTokenBurn()` rejects because the
// pool's input amount (`pool.tokens = 11090684002`) exceeds the
// output (`newTokensOutput = 11090683990`). The user's bought-
// tokens output adds `amountToBuy` to the same category, but the
// shortfall still tips the cumulative balance negative.
//
// `newTokensOutput = ceil(K / newSatsExclFee)` is always ≤
// `newTokens = pool.tokens − demandAmount` (with equality only
// when K is divisible by newTokens), and can be many tokens
// short on pools whose `tokens * sats` doesn't round cleanly
// against the post-trade token count. ROACH just happens to be
// the first pool where the rounding deficit exceeds what the
// user's bought-tokens output can mask.
//
// ───────────────────────────────────────────────────────────────────
//  WHAT THIS MODULE DOES
// ───────────────────────────────────────────────────────────────────
//
// - `ceilDiv(num, den)` — BigInt ceiling division. Pure helper.
// - `simulateSdkNewTokensOutput({tokens, sats, demandAmount})` —
//   replays the SDK's `newTokensOutput` formula in pure form, no
//   side effects, no SDK import. Returns 0n for inputs that would
//   underflow the pool (defensive).
// - `wouldSdkImplicitBurn(pool, demandAmount)` — for a single pool
//   + demand, returns true iff `simulateSdkNewTokensOutput(...) +
//   demandAmount < pool.tokens` (the cashscript check).
// - `analyzePlanForImplicitBurn(allocations)` — for a full
//   `plan.allocations` array, returns `{burns, totalInputTokens,
//   totalOutputTokens, totalDemand, deficit}` so the executor can
//   log a structured event with the exact symptom.
// - `filterSwapablePools(pools, demandByPoolId)` — strips pools
//   that would cause implicit burn from a candidate pool list
//   (defensive helper, not used by the executor today but exported
//   so tests + future re-planners can reason about pool subsets).
//
// All helpers are pure — no I/O, no SDK imports, no logger. This
// keeps them trivial to unit-test and side-effect-free at runtime
// (the executor logs the analysis itself).

// ─────────────────────────────────────────────────────────────────
//  Pure helpers
// ─────────────────────────────────────────────────────────────────

/**
 * BigInt ceiling division. Mirrors the SDK's `ceilDiv` from
 * `node_modules/@mr-zwets/cauldron-swap-sdk/dist/multipool.js`.
 * Returns 0n when `den <= 0n` so callers don't have to guard.
 *
 * @param {bigint} num  numerator (≥ 0)
 * @param {bigint} den  denominator (> 0)
 * @returns {bigint}    ceil(num / den)
 */
export function ceilDiv(num, den) {
  if (typeof num !== 'bigint' || typeof den !== 'bigint') {
    throw new TypeError('ceilDiv: num and den must be BigInt');
  }
  if (den <= 0n) return 0n;
  if (num <= 0n) return 0n;
  return (num + den - 1n) / den;
}

/**
 * Replay the SDK's `buildCauldronInputsOutputs(allocations, direction, ...)`
 * formula for `newTokensOutput`. Pure — no I/O, no SDK import.
 *
 * Mirrors:
 *   const newTokens = direction === 'buy'
 *     ? pool.tokens - demandAmount
 *     : pool.tokens + demandAmount;
 *   const newSatsExclFee = ceilDiv(K, newTokens);
 *   const newTokensOutput = ceilDiv(K, newSatsExclFee);
 *
 * Returns 0n when the demand would deplete the pool
 * (`newTokens <= 0n`) — caller should treat that as "pool too
 * shallow for this demand" rather than an implicit burn.
 *
 * @param {Object} args
 * @param {bigint|number} args.tokens       pool's pre-trade token reserve
 * @param {bigint|number} args.sats         pool's pre-trade BCH reserve
 * @param {bigint|number} args.demandAmount tokens the trade removes (BUY) or adds (SELL) to this pool
 * @param {'buy'|'sell'} [args.side='buy']  trade side
 * @returns {bigint}                        the SDK's `newTokensOutput`
 */
export function simulateSdkNewTokensOutput({ tokens, sats, demandAmount, side = 'buy' }) {
  const t = toBig(tokens);
  const s = toBig(sats);
  const d = toBig(demandAmount);
  if (t === null || s === null || d === null) return 0n;
  if (t <= 0n || s <= 0n || d <= 0n) return 0n;
  const newTokens = side === 'sell' ? (t + d) : (t - d);
  if (newTokens <= 0n) return 0n;
  const K = t * s;
  const newSatsExclFee = ceilDiv(K, newTokens);
  if (newSatsExclFee <= 0n) return 0n;
  return ceilDiv(K, newSatsExclFee);
}

/**
 * Single-pool check for the ROACH-class SDK bug.
 *
 * Returns `true` when the cashscript `checkFungibleTokenBurn()`
 * invariant would FAIL for this pool alone. Side-aware:
 *   - BUY:  burn when newTokensOutput + demandAmount < pool.tokens
 *           (the user's bought-tokens output carries `demandAmount`
 *           for the pool's category, but if the pool output alone
 *           falls short of pool.tokens, cashscript catches it).
 *   - SELL: burn when newTokensOutput − demandAmount < pool.tokens
 *           (the user sends `demandAmount` tokens to the pool's
 *           category, so the net pool output is `newTokensOutput − demand`;
 *           burn when that's less than pool.tokens).
 *
 * Returns `false` when the pool is safe (or the demand would
 * fully deplete it — `simulateSdkNewTokensOutput` returns 0n and
 * the inequality trivially fails for `demandAmount > pool.tokens`,
 * which the executor's existing `maxTokensForBudget` guard
 * already prevents upstream).
 *
 * Defensive: tolerates null / missing / non-bigint inputs by
 * returning `false` (no burn detected on garbage) so a future
 * caller passing partial data gets a no-op rather than a crash.
 *
 * @param {Object} pool                  active cauldron pool (needs .tokens, .sats)
 * @param {bigint|number} demandAmount   tokens the trade removes (BUY) or adds (SELL) to this pool
 * @param {'buy'|'sell'} [side='buy']    trade side
 * @returns {boolean}
 */
export function wouldSdkImplicitBurn(pool, demandAmount, side = 'buy') {
  if (!pool || typeof pool !== 'object') return false;
  const tokens = pool.tokens;
  const sats = pool.sats;
  if (tokens === undefined || sats === undefined) return false;
  const newTokensOutput = simulateSdkNewTokensOutput({ tokens, sats, demandAmount, side });
  if (newTokensOutput === 0n) return false; // pool too shallow — different problem
  const t = toBig(tokens);
  const d = toBig(demandAmount);
  if (t === null || d === null) return false;
  if (side === 'sell') {
    return (newTokensOutput - d) < t;
  }
  return (newTokensOutput + d) < t;
}

/**
 * Run `wouldSdkImplicitBurn` over every allocation in a plan and
 * return a structured report the executor can log + use to decide
 * whether to refuse the swap.
 *
 * The plan's `allocations` array is the same shape that
 * `planTrade(...)` returns — each entry carries `.pool` (the
 * pool object) and `.demandAmount` (the tokens the trade would
 * remove from that pool for BUY, or add for SELL).
 *
 * Side-aware deficit math:
 *   - BUY:  pool.tokens (input) vs newTokensOutput + demandAmount
 *           (output). Burn when newTokensOutput + demandAmount < pool.tokens.
 *   - SELL: pool.tokens (input) vs newTokensOutput − demandAmount
 *           (output, since the user ADDS demandAmount tokens to the
 *           pool's category total). Burn when newTokensOutput < pool.tokens
 *           + demandAmount, equivalently newTokensOutput − demandAmount < pool.tokens.
 *
 * Both sides share the same SDK pathology: `ceil(K / newSatsExclFee)` can
 * be off by 1+ token from the true post-trade token count, just in
 * opposite directions.
 *
 * @param {Array<{pool: Object, demandAmount: bigint|number}>} allocations
 * @param {'buy'|'sell'} [side='buy']
 * @returns {{
 *   burns: boolean,
 *   side: 'buy'|'sell',
 *   badPools: Array<{pool: Object, demandAmount: bigint, newTokensOutput: bigint, newTokens: bigint, deficit: bigint}>,
 *   totalInputTokens: bigint,
 *   totalOutputTokens: bigint,
 *   totalDemand: bigint,
 *   deficit: bigint,
 * }}
 */
export function analyzePlanForImplicitBurn(allocations, side = 'buy') {
  const isBuy = side !== 'sell'; // default to BUY for back-compat
  const badPools = [];
  let totalInputTokens = 0n;
  let totalOutputTokens = 0n;
  let totalDemand = 0n;
  if (!Array.isArray(allocations)) {
    return { burns: false, side, badPools: [], totalInputTokens: 0n, totalOutputTokens: 0n, totalDemand: 0n, deficit: 0n };
  }
  for (const a of allocations) {
    if (!a || typeof a !== 'object') continue;
    const pool = a.pool;
    if (!pool || typeof pool !== 'object') continue;
    const t = toBig(pool.tokens);
    const s = toBig(pool.sats);
    const d = toBig(a.demandAmount);
    if (t === null || s === null || d === null) continue;
    const newTokensOutput = simulateSdkNewTokensOutput({ tokens: t, sats: s, demandAmount: d, side });
    if (newTokensOutput === 0n) continue; // pool too shallow — different problem
    // newTokens = post-trade pool token count (post-trade: subtract for
    // BUY, add for SELL — same SDK math, different sign).
    const newTokens = isBuy ? (t - d) : (t + d);
    const deficit = newTokens - newTokensOutput;
    if (deficit > 0n) {
      badPools.push({ pool, demandAmount: d, newTokensOutput, newTokens, deficit });
    }
    totalInputTokens += t;
    // Output token amount for the category, summed across all outputs:
    //   BUY:  newTokensOutput (pool) + demandAmount (user receives)
    //   SELL: newTokensOutput (pool) − demandAmount (user sends in; net −demand)
    totalOutputTokens += isBuy ? (newTokensOutput + d) : (newTokensOutput - d);
    totalDemand += d;
  }
  const deficit = totalInputTokens - totalOutputTokens;
  return {
    burns: badPools.length > 0,
    side,
    badPools,
    totalInputTokens,
    totalOutputTokens,
    totalDemand,
    deficit,
  };
}

/**
 * Filter a candidate pool list, dropping any pool that would
 * cause the ROACH-class implicit-burn failure for the planned
 * per-pool demand. Exported for tests + future re-planners; the
 * executor itself doesn't call this today (it short-circuits
 * the whole swap via `analyzePlanForImplicitBurn`).
 *
 * @param {Array} pools
 * @param {Map<string, bigint>|Object} demandByPoolId  pool.id → demandAmount (BigInt)
 * @param {'buy'|'sell'} [side='buy']                 trade side
 * @returns {Array}                                   subset of `pools` that wouldn't burn
 */
export function filterSwapablePools(pools, demandByPoolId, side = 'buy') {
  if (!Array.isArray(pools) || pools.length === 0) return [];
  const lookup = (id) => {
    if (!demandByPoolId) return 0n;
    if (demandByPoolId instanceof Map) return demandByPoolId.get(id) ?? 0n;
    return demandByPoolId[id] ?? 0n;
  };
  return pools.filter((p) => {
    if (!p || typeof p !== 'object') return false;
    const demand = lookup(p.pool_id ?? p.id);
    return !wouldSdkImplicitBurn(p, demand, side);
  });
}

// ─────────────────────────────────────────────────────────────────
//  Internal helpers
// ─────────────────────────────────────────────────────────────────

/** @private — coerce Number | bigint | string | null | undefined to BigInt, or null. */
function toBig(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.round(v));
  if (typeof v === 'string' && v.length > 0) {
    try { return BigInt(v); } catch { return null; }
  }
  return null;
}
