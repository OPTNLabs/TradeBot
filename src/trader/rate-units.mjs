// src/trader/rate-units.mjs
//
// Pure helpers for converting token rate units between "per display unit"
// and "per base unit". Lives next to `swap.mjs` / `pool-shape.mjs` so
// the trader layer owns its own unit conventions rather than reaching
// into `src/util/` for a one-off conversion.
//
// ─────────────────────────────────────────────────────────────────────
//  WHY THIS EXISTS
// ─────────────────────────────────────────────────────────────────────
//
// Two layers of the bot emit "rate" numbers that look identical but
// live in different units, and conflating them silently corrupts
// every slippage check + audit log:
//
//   1. **Cauldron indexer** (`PoolStats.price_now_sats`,
//      `PoolStats.price_series_7d[].price_now_sats`, etc.) —
//      **sats per DISPLAY unit** (e.g. 97 sats per OLA when
//      `token_decimals = 2`).
//
//   2. **cauldron-swap-sdk** (`planTrade.effectiveRate`,
//      `bestMarginalBuyRate`, `bestMarginalSellRate`,
//      `PoolAllocation.supplyAmount / demandAmount`, etc.) —
//      **sats per BASE unit** (e.g. `97 / 100 = 0.97n` for the
//      same OLA pool, which bigint-floors to `0n`).
//
// `PoolAllocation.supplyAmount` (BCH sats received/paid) divided by
// `PoolAllocation.demandAmount` (token base units) is the SDK's
// definition of `effectiveRate` — confirmed in
// `src/trader/cauldron/check_and_swap.mjs#planTrade`.
//
// The bug this module fixes (B04 / bug-exit-failed-20260916):
// when the loop passes an indexer `price_now_sats` (per-display) as
// `request.expectedRateSats` to `SwapExecutor.execute()` and the
// executor compares it directly against `plan.effectiveRate`
// (per-base), the slippage formula `(expected − actual) × 10000 / expected`
// returns ~10000 bps for every SELL on a `decimals ≥ 2` token —
// because `actual = plan.effectiveRate` bigint-floors to `0n` and
// `expected − 0` over `expected` is `1.0` = `10000 bps`. The exit
// pre-flight then refuses every swap with `slippage_exceeded` and
// the position gets stuck.
//
// The fix is a per-call unit-normalization at the swap boundary:
// the caller still passes the indexer's per-display rate (so
// upstream code that reads `price_now_sats` doesn't have to think
// about base units), and the executor divides it by `10^decimals`
// when `tokenMeta.decimals` is available before the slippage
// arithmetic. Tests pass `tokenMeta: null` or
// `tokenMeta: { decimals: undefined }` and the conversion is a
// no-op, preserving backwards compatibility with the existing
// per-base-unit fixtures.
//
// Earlier revisions of this module multiplied by `10^decimals` to
// "go from per-display to per-base", which inflated the per-base
// rate by `10^decimals` and made the slippage pre-flight always
// report ~10000 bps for any token with `decimals >= 1`. The bug
// (`bug-preflight-slippage-always-reports-10000-bps-displayratetobaserate-direction-20260917`)
// tripped on every SELL of OLA / NWB / HONEY and made the OLA /
// NWB positions sticky. The fix flips the direction (divide, not
// multiply) + flips the 5 unit tests that had locked the wrong
// direction; the regression test below pins the OLA-shaped profit
// case to the post-fix slippage (now `~0 bps`, was `~10000 bps`).
//
// All helpers are PURE (no I/O, no side effects) and tolerate every
// garbage shape the field can take (`null` / `undefined` / `0` /
// negative / non-integer decimals / NaN rates) by returning a typed
// `{ ok, value, reason }` envelope so callers can log + branch
// without having to know which knob tripped.
//
// ─────────────────────────────────────────────────────────────────────
//  Exports
// ─────────────────────────────────────────────────────────────────────

/**
 * Divide `displayRateSats` by `10^decimals` to convert a
 * per-DISPLAY-unit rate to a per-BASE-unit rate. Used by the swap
 * layer when the caller passes an indexer-style per-display rate
 * (the indexer is the only `price_now_sats` source upstream of
 * the swap boundary today).
 *
 * Returns a typed envelope so the caller can distinguish:
 *   - `ok: true,  value: <bigint>` — conversion succeeded.
 *   - `ok: false, reason: 'rate_missing' | 'rate_invalid' | 'decimals_missing' |
 *                     'decimals_invalid' | 'rate_non_integer' | 'overflow'`
 *
 * Defensive: any non-positive / non-finite rate returns
 * `rate_invalid`; non-integer decimals returns `decimals_invalid`;
 * negative decimals returns `decimals_invalid`; non-integer rate
 * returns `rate_non_integer`; `decimals > 32` or `decimals < 0`
 * returns `decimals_invalid` (tokens on Cauldron have 0-9 decimals
 * in practice; 32 is a hard cap to prevent bigint overflow).
 *
 * @param {bigint|number|string|null|undefined} displayRateSats
 * @param {number|null|undefined} decimals
 * @returns {{ ok: true, value: bigint } | { ok: false, reason: string }}
 */
export function displayRateToBaseRate(displayRateSats, decimals) {
  if (displayRateSats === null || displayRateSats === undefined) {
    return { ok: false, reason: 'rate_missing' };
  }
  if (decimals === null || decimals === undefined) {
    return { ok: false, reason: 'decimals_missing' };
  }
  if (typeof decimals !== 'number' || !Number.isFinite(decimals) || decimals < 0 || decimals > 32) {
    return { ok: false, reason: 'decimals_invalid' };
  }
  if (Number.isInteger(decimals) === false) {
    return { ok: false, reason: 'decimals_invalid' };
  }
  let rate;
  if (typeof displayRateSats === 'bigint') {
    rate = displayRateSats;
  } else if (typeof displayRateSats === 'number') {
    if (!Number.isFinite(displayRateSats) || displayRateSats <= 0) {
      return { ok: false, reason: 'rate_invalid' };
    }
    rate = BigInt(Math.round(displayRateSats));
  } else if (typeof displayRateSats === 'string' && displayRateSats.length > 0) {
    try {
      rate = BigInt(displayRateSats);
    } catch {
      return { ok: false, reason: 'rate_invalid' };
    }
  } else {
    return { ok: false, reason: 'rate_invalid' };
  }
  if (rate <= 0n) {
    return { ok: false, reason: 'rate_invalid' };
  }
  if (decimals === 0) {
    return { ok: true, value: rate };
  }
  // B04 / rate-units: divide by 10^decimals to convert per-DISPLAY
  // to per-BASE unit rate. Earlier (pre-fix) this incorrectly
  // multiplied, which inflated the per-base rate by `10^decimals`
  // and made the slippage pre-flight always report ~10000 bps
  // for any token with decimals>=1. See bug
  // `bug-preflight-slippage-always-reports-10000-bps-displayratetobaserate-direction-20260917`.
  const divisor = 10n ** BigInt(decimals);
  const value = rate / divisor;
  // `bigint` is unbounded on Node.js, but a sanity check prevents
  // a runaway value (e.g. 1e30 sats/token / 10^0 = 1e30) from
  // silently flowing into the slippage arithmetic. The bot's
  // largest legit per-base rate is "the AMM has effectively no
  // liquidity" = ~1e10 sats/base unit; 1e18 is a comfortable cap.
  if (value > 10n ** 18n) {
    return { ok: false, reason: 'overflow' };
  }
  return { ok: true, value };
}

/**
 * Divide `baseRateSats` by `10^decimals` to convert a per-BASE-unit
 * rate to a per-DISPLAY-unit rate. Mirrors `displayRateToBaseRate`
 * but in the opposite direction — used by the audit log layer
 * when it wants to surface a per-display rate in a human-readable
 * `expected_price` field.
 *
 * Truncates toward zero (bigint floor) so the result is always the
 * largest integer-display-unit rate that fits the actual base rate.
 * For most tokens the fractional part is < 1 sat and dropping it is
 * fine; callers who need sub-display-unit precision should call
 * `displayRateToBaseRate` on the indexer side instead.
 *
 * Same defensive envelope shape as `displayRateToBaseRate`.
 *
 * @param {bigint|number|string|null|undefined} baseRateSats
 * @param {number|null|undefined} decimals
 * @returns {{ ok: true, value: bigint } | { ok: false, reason: string }}
 */
export function baseRateToDisplayRate(baseRateSats, decimals) {
  if (baseRateSats === null || baseRateSats === undefined) {
    return { ok: false, reason: 'rate_missing' };
  }
  if (decimals === null || decimals === undefined) {
    return { ok: false, reason: 'decimals_missing' };
  }
  if (typeof decimals !== 'number' || !Number.isFinite(decimals) || decimals < 0 || decimals > 32) {
    return { ok: false, reason: 'decimals_invalid' };
  }
  if (Number.isInteger(decimals) === false) {
    return { ok: false, reason: 'decimals_invalid' };
  }
  let rate;
  if (typeof baseRateSats === 'bigint') {
    rate = baseRateSats;
  } else if (typeof baseRateSats === 'number') {
    if (!Number.isFinite(baseRateSats) || baseRateSats < 0) {
      return { ok: false, reason: 'rate_invalid' };
    }
    rate = BigInt(Math.round(baseRateSats));
  } else if (typeof baseRateSats === 'string' && baseRateSats.length > 0) {
    try {
      rate = BigInt(baseRateSats);
    } catch {
      return { ok: false, reason: 'rate_invalid' };
    }
  } else {
    return { ok: false, reason: 'rate_invalid' };
  }
  if (rate < 0n) {
    return { ok: false, reason: 'rate_invalid' };
  }
  if (decimals === 0) {
    return { ok: true, value: rate };
  }
  // B04 / rate-units: MULTIPLY by 10^decimals to convert per-BASE
  // unit rate to per-DISPLAY unit rate. Mathematically: per-base ×
  // 10^decimals = per-display (since 1 display-unit = 10^decimals
  // base units). Earlier (pre-fix) this incorrectly divided by
  // 10^decimals, which made the human-readable
  // `price_sats_per_token` field on stored positions round to
  // something wildly different from the indexer's per-display
  // rate — the position-stored value would be `~0 n/token` for
  // any per-display rate below 10^decimals. See bug
  // `bug-preflight-slippage-always-reports-10000-bps-displayratetobaserate-direction-20260917`
  // for the companion direction-flip.
  const multiplier = 10n ** BigInt(decimals);
  const value = rate * multiplier;
  // `bigint` is unbounded on Node.js, but a sanity check prevents
  // a runaway value (e.g. 1e30 sats/token * 10^32 = 1e62) from
  // silently flowing into the audit layer. The bot's largest
  // legit per-display rate is "the AMM has effectively no
  // liquidity" = ~1e10 sats/display unit; 1e18 is a comfortable cap.
  if (value > 10n ** 18n) {
    return { ok: false, reason: 'overflow' };
  }
  return { ok: true, value };
}

/**
 * Pick the right unit basis for the slippage pre-flight.
 *
 * Returns a bigint `expectedRateSats` in PER-BASE-UNIT units (matching
 * `plan.effectiveRate`'s basis) when conversion succeeds, or the
 * raw input when it doesn't (the slippage code falls through to
 * `plan.effectiveRate` in that case — see `SwapExecutor.execute`).
 *
 * Decision tree:
 *   - input `null` / `undefined`     → returns `null` (caller falls back to SDK spot rate)
 *   - decimals missing / invalid    → returns the input verbatim (back-compat for
 *                                      per-base-unit fixtures; the slippage layer
 *                                      still does its own check vs `plan.effectiveRate`)
 *   - conversion succeeds           → returns the converted per-base-unit bigint
 *   - conversion fails on rate side → returns the input verbatim (e.g. caller passed
 *                                      a per-base-unit rate that doesn't need converting;
 *                                      let `computeSlippageBps` do its job)
 *
 * @param {bigint|number|string|null|undefined} inputRateSats
 * @param {number|null|undefined} decimals
 * @returns {bigint|null}
 */
export function normalizeExpectedRateToBase(inputRateSats, decimals) {
  if (inputRateSats === null || inputRateSats === undefined) return null;
  // Defensive: missing/invalid decimals — caller is asking us to
  // pass the rate through verbatim. The slippage code is then
  // comparing input vs `plan.effectiveRate`; if both happen to
  // share the same basis the math is correct, otherwise the
  // pre-flight will trip on a known-mismatch error (which is a
  // real bot bug worth surfacing, not silently passing).
  if (decimals === null || decimals === undefined
      || typeof decimals !== 'number'
      || !Number.isFinite(decimals)
      || !Number.isInteger(decimals)
      || decimals < 0
      || decimals > 32) {
    if (typeof inputRateSats === 'bigint') return inputRateSats;
    if (typeof inputRateSats === 'number' && Number.isFinite(inputRateSats)) {
      return BigInt(Math.round(inputRateSats));
    }
    if (typeof inputRateSats === 'string' && inputRateSats.length > 0) {
      try { return BigInt(inputRateSats); } catch { return null; }
    }
    return null;
  }
  const conv = displayRateToBaseRate(inputRateSats, decimals);
  if (conv.ok) return conv.value;
  // Conversion refused (rate missing/invalid, overflow) — fall
  // through to passing the input verbatim, matching the
  // back-compat branch above.
  if (typeof inputRateSats === 'bigint') return inputRateSats;
  if (typeof inputRateSats === 'number' && Number.isFinite(inputRateSats)) {
    return BigInt(Math.round(inputRateSats));
  }
  if (typeof inputRateSats === 'string' && inputRateSats.length > 0) {
    try { return BigInt(inputRateSats); } catch { return null; }
  }
  return null;
}
