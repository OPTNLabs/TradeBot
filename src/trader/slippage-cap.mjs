// src/trader/slippage-cap.mjs
//
// T55: Per-token slippage cap derived from AMM pool depth.
//
// A flat `slippage_tolerance_bps` is too loose for shallow pools (it
// lets through trades whose real slippage is 5x the configured cap —
// the QBTC-class pathology) and too tight for deep pools (it rejects
// profitable trades whose real slippage is 0.02% of a 5-BCH-deep pool).
// Per-token cap derived from `sizeBch / poolDepthBch` balances both:
//   - Deep pool: cap shrinks (tighter protection).
//   - Shallow pool: cap grows (legitimate trades get through).
//
// Algorithm (constant-product AMM approximation):
//
//   size_pct_of_depth = (sizeBch / poolDepthBch) * 100
//   est_slippage_bps  = (size_pct * 10000) / (100 - size_pct)
//
// That's the exact marginal rate-vs-spot ratio for a single-pool
// constant-product BUY where `size_pct < 100`. With `size = 0.005 BCH`
// and `depth = 5 BCH` it's `0.1% / 99.9% * 10000 ≈ 10bps`; with
// `size = 0.005 BCH` and `depth = 0.5 BCH` it's `~101bps`.
//
// The effective cap is `clamp(est_slippage_bps * multiplier, minBps, maxBps)`.
// The `multiplier` (default 2.0) gives a safety margin so legitimate
// noise (LP fees, marginal-rate rounding) doesn't trip the gate.
//
// Pure. No I/O. No logging. Designed for both pre-flight and audit-trail
// use — the same helper stamps the cap onto the position's reasoning
// blob so the operator can see "for token X with depth Y, the
// effective cap was Z bps".

/**
 * @typedef {Object} SlippageCapArgs
 * @property {number} sizeBch            BCH the trade will spend (must be > 0).
 * @property {number} poolDepthBch       Total AMM pool depth in BCH (must be > 0).
 * @property {number} baseCapBps         The flat cap from `entry.slippage_tolerance_bps` (must be > 0).
 * @property {number} [minBps=30]        Floor — cap cannot shrink below this (deep-pool protection).
 * @property {number} [maxBps=250]       Ceiling — cap cannot grow above this (shallow-pool protection).
 * @property {number} [multiplier=2.0]   Safety multiplier on the estimated slippage.
 * @property {number} [enabled=true]     When false, returns null (operator opt-out).
 */

/**
 * @typedef {Object} SlippageCapResult
 * @property {bigint} capBps                 Effective per-token slippage cap (bps).
 * @property {bigint} baseCapBps             The flat cap the cap was derived from (bps).
 * @property {number} sizeBch                Echo of the input.
 * @property {number} poolDepthBch           Echo of the input.
 * @property {number} sizePctOfDepth         sizeBch / poolDepthBch * 100 (sanity check for the operator).
 * @property {number} estSlippageBps         Raw estimate before multiplier/clamp (sanity check).
 * @property {number} targetCapBps           Pre-clamp target (est * multiplier).
 * @property {number} minBps                 Floor used.
 * @property {number} maxBps                 Ceiling used.
 * @property {number} multiplier             Multiplier used.
 * @property {'ok'|'clamped_to_min'|'clamped_to_max'} clampKind
 *                                           Which side the clamp pinned at (or 'ok' if no clamp fired).
 * @property {boolean} enabled               Mirrors the input.
 */

/**
 * Compute the effective per-token slippage cap (in bps) for a given
 * trade. Returns `null` when:
 *   - any required input is missing/non-finite/non-positive
 *   - the multiplier / clamp knobs are inconsistent (min > max, etc.)
 *   - `enabled === false`
 *
 * Returns a `SlippageCapResult` otherwise — including the `BigInt`
 * `capBps` so callers don't need to re-coerce for the `preFlightCheck`
 * comparison.
 *
 * @param {SlippageCapArgs} args
 * @returns {SlippageCapResult | null}
 */
export function computePerTokenSlippageCapBps({
  sizeBch,
  poolDepthBch,
  baseCapBps,
  minBps = 30,
  maxBps = 250,
  multiplier = 2.0,
  enabled = true,
} = {}) {
  if (enabled === false) return null;
  // Validate numerics. Don't trust anything non-finite/non-positive.
  if (!Number.isFinite(sizeBch) || sizeBch <= 0) return null;
  if (!Number.isFinite(poolDepthBch) || poolDepthBch <= 0) return null;
  if (!Number.isFinite(baseCapBps) || baseCapBps <= 0) return null;
  if (!Number.isFinite(minBps) || minBps <= 0) return null;
  if (!Number.isFinite(maxBps) || maxBps <= 0) return null;
  if (!Number.isFinite(multiplier) || multiplier <= 0) return null;
  // Inconsistent knob config — fail closed (returns null) so the
  // caller falls back to the flat cap. Same defensive posture as
  // the rest of the strategy layer: bad config never widens the gate.
  if (minBps > maxBps) return null;
  if (multiplier > 100) return null; // operator typo guard

  const sizePctOfDepth = (sizeBch / poolDepthBch) * 100;
  // Constant-product AMM slippage estimate. As size_pct → 100 the
  // formula → ∞; we cap at `maxBps` below. A negative `denom` (size
  // > depth) is the same pathology — cap at `maxBps` so the cap
  // doesn't NaN.
  const denom = 100 - sizePctOfDepth;
  let estSlippageBps;
  if (denom <= 0) {
    estSlippageBps = Number.POSITIVE_INFINITY;
  } else {
    estSlippageBps = (sizePctOfDepth * 10000) / denom;
  }

  const targetCapBps = estSlippageBps * multiplier;
  // Clamp to [minBps, maxBps].
  let clampedCapBps = targetCapBps;
  let clampKind = 'ok';
  if (clampedCapBps < minBps) {
    clampedCapBps = minBps;
    clampKind = 'clamped_to_min';
  } else if (clampedCapBps > maxBps) {
    clampedCapBps = maxBps;
    clampKind = 'clamped_to_max';
  }
  // Defensive: still pin to maxBps if Infinity slipped through.
  if (!Number.isFinite(clampedCapBps)) {
    clampedCapBps = maxBps;
    clampKind = 'clamped_to_max';
  }

  return {
    capBps: BigInt(Math.floor(clampedCapBps)),
    baseCapBps: BigInt(Math.floor(baseCapBps)),
    sizeBch,
    poolDepthBch,
    sizePctOfDepth,
    estSlippageBps: Number.isFinite(estSlippageBps) ? estSlippageBps : Number.POSITIVE_INFINITY,
    targetCapBps,
    minBps,
    maxBps,
    multiplier,
    clampKind,
    enabled: true,
  };
}

/**
 * Compute the effective per-token slippage cap OR fall back to the
 * flat `baseCapBps` if the helper returns null. Convenience wrapper
 * for the swap path that doesn't care about the audit-trail metadata.
 *
 * @param {Object} args
 * @param {bigint} args.baseCapBps           The flat cap (BigInt, must be > 0).
 * @param {number} [args.sizeBch]            Same as `computePerTokenSlippageCapBps`.
 * @param {number} [args.poolDepthBch]       Same.
 * @param {number} [args.minBps]             Same.
 * @param {number} [args.maxBps]             Same.
 * @param {number} [args.multiplier]         Same.
 * @param {boolean} [args.enabled]           Same.
 * @returns {bigint}
 */
export function resolveSlippageCapBps({
  baseCapBps,
  sizeBch,
  poolDepthBch,
  minBps,
  maxBps,
  multiplier,
  enabled,
} = {}) {
  const baseBi = (typeof baseCapBps === 'bigint' && baseCapBps > 0n)
    ? baseCapBps
    : BigInt(100);
  const result = computePerTokenSlippageCapBps({
    sizeBch, poolDepthBch,
    baseCapBps: Number(baseBi),
    minBps, maxBps, multiplier, enabled,
  });
  if (result === null) return baseBi;
  // T55 intent: the per-token cap can LOOSEN the flat cap for shallow
  // pools (where realistic slippage genuinely exceeds the flat cap —
  // 100bps on a 0.5 BCH pool rejecting legitimate ~150bps trades was
  // the original operator-filed pathology). The flat cap remains the
  // fallback when the helper returns null (no depth info, knobs
  // inconsistent, etc.).
  return result.capBps;
}