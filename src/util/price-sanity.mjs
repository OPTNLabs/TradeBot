#!/usr/bin/env node
// src/util/price-sanity.mjs
//
// Paranoid sanity checks for indexer-supplied market prices.
//
// Origin: TradeBot. Pulled out of `src/strategy/exit.mjs` after T28d
// (2026-09-14) so the SAME check can be reused by the unrealized-P&L
// code path. Without sharing the helper, the snapshot's
// `unrealized_pnl_sats` field was reporting $20M+ of "unrealized
// gains" on a real QBTC position (commit 9561393 fixed `shouldExit`
// but missed the snapshot + dashboard paths).
//
// Design rules:
//
//   1. **Pure.** No I/O. No side effects. Tolerates bigint /
//      number / null / string inputs (matches `pnl.mjs#toSats`
//      coercion policy).
//
//   2. **Single source of truth.** `shouldExit` (strategy) and
//      `unrealizedPnlSats` (portfolio) BOTH call this — no
//      chance of drift between the two layers.
//
//   3. **Default ratio = 1000x.** Matches `DEFAULT_EXIT_CONFIG
//      .max_price_vs_entry_ratio_x`. Wide enough that no legitimate
//      7d pump on a token the bot has entered gets rejected; tight
//      enough to catch the QBTC-class "indexer is 100,000,000x off
//      the actual AMM spot rate" pathology that triggered T28d.
//
//   4. **Conservative.** Missing / non-numeric inputs always
//      return "plausible" (i.e. don't reject) — better to show a
//      possibly-bogus P&L than to silently drop every position
//      when the entry price is missing (the chain-synced case).
//
// Origin: original code for TradeBot, post-T28d follow-up.

/**
 * Coerce `v` to a non-negative integer or `null`. Mirrors the
 * policy used by `pnl.mjs#toSats` — bigint / number / string
 * inputs all coerce; negative / NaN / null / undefined return
 * null.
 *
 * @param {unknown} v
 * @returns {bigint|null}
 */
export function toNonNegativeInt(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v < 0n ? null : v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    if (v < 0) return null;
    return BigInt(Math.round(v));
  }
  if (typeof v === 'string' && v.length > 0) {
    try {
      const n = BigInt(v);
      return n < 0n ? null : n;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Decide whether a market price (sats per base unit) is plausible
 * given the position's entry price (sats per base unit).
 *
 * Returns `true` when:
 *   - either `entryPriceSats` is missing / non-positive (no
 *     anchor — caller should fall back to its own missing-data
 *     path), OR
 *   - `marketPriceSats` is missing / non-numeric (no evidence —
 *     caller should treat as missing price), OR
 *   - `maxRatioX` is missing / non-positive / non-finite
 *     (operator disabled the check — be permissive), OR
 *   - the market price is within `1/maxRatioX` … `maxRatioX`
 *     times the entry price.
 *
 * Returns `false` only when ALL of:
 *   - `entryPriceSats` is a positive finite number, AND
 *   - `marketPriceSats` is a positive finite number, AND
 *   - `maxRatioX` is a positive finite number, AND
 *   - the market price is > `entryPriceSats * maxRatioX`
 *     OR < `entryPriceSats / maxRatioX`.
 *
 * Pure — exported so callers can unit-test it independently of
 * `shouldExit` and `unrealizedPnlSats`.
 *
 * @param {bigint|number|string|null|undefined} entryPriceSats
 * @param {bigint|number|string|null|undefined} marketPriceSats
 * @param {bigint|number|string|null|undefined} maxRatioX       e.g. 1000
 * @returns {boolean}
 */
export function isPricePlausibleVsEntry(entryPriceSats, marketPriceSats, maxRatioX) {
  const entry = toNonNegativeInt(entryPriceSats);
  const market = toNonNegativeInt(marketPriceSats);
  const ratio = (() => {
    if (maxRatioX === null || maxRatioX === undefined) return null;
    if (typeof maxRatioX === 'bigint') return maxRatioX > 0n ? Number(maxRatioX) : null;
    if (typeof maxRatioX === 'number') return Number.isFinite(maxRatioX) && maxRatioX > 0 ? maxRatioX : null;
    if (typeof maxRatioX === 'string' && maxRatioX.length > 0) {
      const n = Number(maxRatioX);
      return Number.isFinite(n) && n > 0 ? n : null;
    }
    return null;
  })();

  // Missing/null entry → don't reject (let the caller treat it as
  // missing data instead).
  if (entry === null) return true;
  // T40 fix: entry === 0n is treated as "no anchor available"
  // rather than "anchor is zero" — a token the bot entered at
  // `price_sats_per_token: 0` was almost certainly recorded with
  // the T28 swap-recording bug (the AMM delivered a real rate
  // but the trader loop stored 0). Without a valid entry anchor
  // there's no way to bound the market price into a plausible
  // window, so we reject the price as not plausible. This stops
  // the snapshot layer from emitting $20M+ of "unrealized gains"
  // on positions the loop itself couldn't even price at entry
  // time.
  if (entry === 0n) return false;
  if (market === null || market === 0n) return true;
  if (ratio === null) return true;

  // Plausibility window: market ∈ [entry / ratio, entry * ratio].
  // All arithmetic done in Number space — token prices are sats
  // (typically 1..10^9), well within Number's safe-integer range;
  // mixing BigInt and Number here would throw at the comparison
  // operators, and converting the ratio to BigInt loses the
  // fractional precision we want for ratio < 1.
  const entryN = Number(entry);
  const marketN = Number(market);
  const lowerBound = entryN / ratio;
  const upperBound = entryN * ratio;
  return marketN >= lowerBound && marketN <= upperBound;
}

/**
 * Default ratio — mirrors `DEFAULT_EXIT_CONFIG
 * .max_price_vs_entry_ratio_x`. 1000x is wide enough that no
 * legitimate 7d pump on an entered token gets rejected, tight
 * enough to catch the QBTC-class "indexer is 100,000,000x off"
 * pathology.
 */
export const DEFAULT_PRICE_VS_ENTRY_RATIO_X = 1000;
