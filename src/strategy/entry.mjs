#!/usr/bin/env node
// src/strategy/entry.mjs
//
// Pure entry-side decision + position-sizing.
//
// The trader loop calls `shouldEnter(candidate, portfolioState, cfg)`
// on every candidate the ranker surfaced. The result is a typed
// decision the loop can act on directly:
//
//   { enter: true,  sizeBch, reason, slippageCapBps }
//   { enter: false, reason }                       ← why we skipped
//
// Design rules (also see docs/ARCHITECTURE.md §4.2 + §5):
//
//   1. **Pure.** No I/O. No logger. No globals. The only inputs are
//      `candidate`, `portfolioState`, and `cfg`. Same inputs → same
//      output. This is what makes the decision unit-testable AND
//      makes the bot safe to replay (the backtester runs the same
//      code path).
//
//   2. **All knobs read from `cfg.entry`.** The function never
//      hard-codes a size limit, a slippage tolerance, or a min-trade
//      floor. If a knob is missing from `cfg.entry`, we fall back to
//      `DEFAULT_ENTRY_CONFIG` (small-balance tuned) — never to a
//      literal in this file. This is enforced by a guard test.
//
//   3. **"Missing evidence ≠ zero."** If `candidate.stats.price_now_sats`
//      is `null` (fresh token, no oracle yet), we DO NOT pretend the
//      price is 0 and crash the math. We return `enter: false` with
//      `reason: 'no_price_evidence'` — surfacing the gap rather than
//      silently inventing a number.
//
//   4. **The bot NEVER spends more than `max_position_bch` per trade.**
//      `max_total_exposure_bch` is enforced here too — the entry
//      layer is the single chokepoint for sizing.
//
//   5. **`sizeBch` is rounded DOWN to the nearest `min_trade_size_bch`
//      step.** If the resulting trade would be below
//      `min_trade_size_bch`, we return `enter: false` with
//      `reason: 'size_below_dust'`. A dust trade wouldn't cover fees.
//
//   6. **The `reason` blob is what gets stamped onto the position**
//      (`positions.open({ reasoning })`). It includes the scoring
//      context, the gate decisions, the requested size, the slippage
//      cap, and the timestamp — everything a human auditor needs to
//      reconstruct why this trade happened.
//
// Origin: original code for TradeBot. ARCHITECTURE.md §3 places this
// module on the pure layer above `strategy/scoring` + `strategy/ranker`.

import { isPricePlausibleVsEntry } from '../util/price-sanity.mjs';
import { maxAbsCorrelation } from '../util/correlation.mjs';
import { poolAgeDays } from './ranker.mjs';
import { resolveSlippageCapBps } from '../trader/slippage-cap.mjs';

// ─────────────────────────────────────────────────────────────────────
//  Defaults
// ─────────────────────────────────────────────────────────────────────

/**
 * Defaults that mirror `config/default.json` → `entry` for the
 * `small_balance_startup` preset. These only fire when the caller
 * passes a null/garbage `cfg.entry`; the real config always wins
 * otherwise.
 *
 * Tests use these to assert that no caller can accidentally bypass
 * the config knob path (the literal `0.005` etc. never appears in
 * `src/strategy/entry.mjs` directly — only the test code references
 * these values).
 */
export const DEFAULT_ENTRY_CONFIG = Object.freeze({
  max_position_bch: 0.005,
  max_total_exposure_bch: 0.04,
  min_entry_gap_from_high_pct: 2.0,
  slippage_tolerance_bps: 100,
  use_post_trade_check: true,
  min_trade_size_bch: 0.0005,
  // T55: per-token slippage cap derived from AMM pool depth. The flat
  // `slippage_tolerance_bps` above is REPLACED for each trade by a
  // depth-aware cap when `candidate.amm_total_depth_sats` is
  // available. See `src/trader/slippage-cap.mjs` for the algorithm.
  // Default 30/250/2.0 means: deep pools tighten the cap to ~30bps;
  // shallow pools loosen to ~250bps; the multiplier gives a 2x safety
  // margin on the constant-product slippage estimate.
  slippage_cap_per_token_enabled: true,
  slippage_cap_min_bps: 30,
  slippage_cap_max_bps: 250,
  slippage_cap_multiplier: 2.0,
  // T31: indexer-reference-price vs AMM-implied-spot divergence
  // guard. The trading loop pre-computes `candidate.amm_spot_sats`
  // (from `fetcher.getAmmSpotSats(tokenId)`) and threads it into the
  // candidate object before `shouldEnter()` runs. When BOTH the
  // indexer price AND the AMM spot are present, the indexer price
  // must be within `max_indexer_vs_amm_ratio_x` of the AMM spot —
  // else we return `enter: false / kind: 'indexer_vs_amm_divergence'`.
  // Mirrors the exit-side `exit.max_price_vs_entry_ratio_x` guard
  // (T28d) — same default (1000x), same pathology-class
  // (indexer price wildly off the actual AMM-implied rate). Wide
  // enough that no legitimate 7d pump on an entered token gets
  // rejected; tight enough to cap the 100,000,000x-class 'indexer
  // is wildly off' pathology that bit the QBTC entry on 2026-09-14.
  max_indexer_vs_amm_ratio_x: 1000,
  // T32: pre-entry AMM depth floor. The bot's `min_tvl_bch` ranker
  // filter reads the indexer's `tvl_sats`, which can be stale or
  // computed across a DIFFERENT pool set than the one
  // `prepareAndBuildSwap` actually routes through. For example,
  // QBTC 2026-09-14: indexer reported `tvl_bch=4.74` but the live
  // active-pools list summed to only ~1.32 BCH — a 0.005 BCH buy
  // consumed ~0.4% of pool liquidity, and a similar sell would
  // face massive slippage. Adding a "minimum total sats across the
  // active pools the swap will actually use" gate prevents entries
  // where the bot cannot exit at any meaningful size.
  //
  // Default 150,000,000 sats = 1.5 BCH — wide enough to comfortably
  // accept QBTC's 1.32 BCH live depth (paired with the T31
  // divergence guard, the bot now refuses QBTC's bogus 326
  // BCH/QBTC indexer price AND this entry would still be too
  // shallow under the floor — both layers compound). At the
  // small-balance preset's `max_position_bch=0.005`, a 1.5 BCH
  // floor means each trade consumes at most ~0.33% of pool depth
  // (well under the slippage tolerance's comfort zone). Operators
  // scaling the wallet up should re-tune via `user.json` rather
  // than editing the default.
  //
  // Knob semantics:
  //   - 0 / negative / non-finite → guard DISABLED (operator
  //     opts out, mirroring the `max_indexer_vs_amm_ratio_x`
  //     fallback policy in `resolveEntryConfig`).
  //   - candidate.amm_total_depth_sats missing / null → guard
  //     SKIPPED (conservative: don't reject just because the AMM
  //     probe failed; the existing `min_tvl_bch` ranker filter
  //     still screens the worst cases).
  min_amm_total_depth_sats: 150_000_000,
  // T33: position concentration cap. The current
  // `max_position_bch=0.005` is an absolute ceiling — it does NOT
  // scale with wallet. With a $10-20 USD wallet that's roughly
  // 10-12% of total BCH per trade, which is conservative. But if
  // the wallet shrinks (drawdown, fees eating capital, a stuck
  // position that silently drops the wallet), `max_position_bch`
  // can become a much larger fraction of the wallet — and a single
  // bad trade can blow up to 25-50% of remaining capital. The
  // concentration cap enforces "no single trade can exceed pct% of
  // the current wallet balance", scaling the position size DOWN as
  // the wallet shrinks.
  //
  // Implementation: at sizing time, compute
  //   `concentration_cap_bch = walletBalanceBch * (pct / 100)`
  // and `min()` it against the existing per-trade ceiling. With the
  // default `max_position_bch=0.005` and a 0.044 BCH wallet, the
  // 25% cap yields 0.011 BCH — well above the per-trade ceiling, so
  // the cap is a NO-OP at the small-balance preset's expected
  // wallet size. It only kicks in when the wallet shrinks below
  // ~0.02 BCH (where 25% < 0.005), which is the operator's
  // intended safety net.
  //
  // Knob semantics (matches `min_amm_total_depth_sats` policy):
  //   - 0 / negative / non-finite → guard DISABLED (operator opts
  //     out; matches the "knob is opt-in" pattern of T32's depth
  //     floor). When the operator doesn't supply the knob at all,
  //     `resolveEntryConfig` inherits `DEFAULT_ENTRY_CONFIG.
  //     max_position_concentration_pct` (25.0) via the `{ ...base }`
  //     spread at the top.
  //   - > 100 → guard DISABLED (>100% of wallet would let a trade
  //     exceed the wallet, which is a no-op anyway — the other gates
  //     catch it; we don't want to silently clamp size to wallet).
  //   - 1..100 inclusive → cap = walletBalanceBch * (pct / 100).
  max_position_concentration_pct: 25.0,
  // T35: volatility-adjusted position sizing (Kelly-lite). The
  // current per-trade ceiling (`max_position_bch`) is a flat
  // constant — every token gets the same 0.005 BCH regardless of
  // how violently it moves. For high-vol tokens, a single trade
  // is more likely to either blow through the SL or fire the TP
  // before any real move happens (mean-reversion / choppy
  // regime); shrinking the position linearly with volatility
  // reduces risk-adjusted drawdown without abandoning the
  // opportunity. For low-vol tokens the ceiling already
  // dominates (no scale-up beyond `max_position_bch`), so the
  // guard is a no-op in the calm regime.
  //
  // Math: when `candidate.volatility_24h_pct > target_volatility_pct`,
  //   size_bch = min(pre-vol-size, max_position_bch * (target / realized))
  // which scales DOWN monotonically as realized vol climbs. We
  // never scale UP — Kelly-lite is asymmetric by design (the
  // operator can raise `max_position_bch` themselves when they
  // want more size on a calm token).
  //
  // Knob semantics (matches T33 `max_position_concentration_pct`
  // opt-in pattern):
  //   - 0 / negative / non-finite → guard DISABLED (operator opts
  //     out; e.g. for a backtest pass where they want every
  //     candidate at the per-trade ceiling regardless of vol).
  //   - > 100 → guard DISABLED (>100% daily vol would scale every
  //     trade to zero — better to opt out explicitly).
  //   - 0 < target <= 100 → apply scaling.
  //
  // Evidence: 2026-09-14 QBTC incident (3.44% daily vol)
  // consumed 0.4% of pool depth; a half-sized 0.0025 BCH entry
  // would have absorbed the slippage more cleanly.
  // Implementation lives in `computeEntrySizeBch` (pure) and is
  // exposed via `resolveEntryConfig` / `_entryReasoning`.
  volatility_sizing_target_pct: 5.0,
  // T36: correlation-aware entries. Multiple positions in tokens
  // that move together aren't diversifying — they're a concentrated
  // bet. The bot currently ranks each candidate independently; the
  // trading loop now pre-fetches the 29-point normalized 7-day price
  // series (`price_series_7d`) for the candidate AND every open
  // position's token, then asks `maxAbsCorrelation` for the worst
  // absolute Pearson r. If that value exceeds this threshold, the
  // entry is rejected with `kind: 'correlation_skip'` — true
  // diversification rule.
  //
  // Data source: `candidate.price_series_7d` (already in the
  // candidate's `stats` record — see `Fetcher.buildStatsRecord`'s
  // `price_series_7d` pass-through) and
  // `portfolioState.heldSeriesByTokenId` (a Map<tokenId, series>
  // populated by the trading loop's `_safeHeldPriceSeries` helper
  // from the cached fetcher).
  //
  // Knob semantics (matches T33 / T35 opt-in pattern):
  //   - 0 / negative / non-finite → guard DISABLED (operator opts
  //     out; e.g. for a backtest pass where they want every
  //     candidate evaluated without the diversification rule).
  //   - > 1 → guard DISABLED (correlation is bounded in [-1, 1];
  //     a threshold > 1 would never trigger, which is the same as
  //     "no-op" — better to opt out explicitly).
  //   - 0 < threshold <= 1 → apply guard. Sensible operational
  //     range: 0.7 (loose — accepts near-duplicates) to 0.95
  //     (tight — rejects anything strongly correlated).
  //
  // Pair semantics: the T36 guard compares the candidate's series
  // against EACH held token's series independently. A held token
  // with no price series (indexer missing) is silently skipped —
  // we don't reject the candidate just because the data isn't
  // available (same conservative posture as T31 / T32 / T33: the
  // existing ranker filters still screen the worst cases).
  correlation_skip_threshold: -1,
  // T37: minimum pool age (days). Tokens whose oldest active pool
  // is younger than this are dropped at entry — wash-trade /
  // seed-swap / rug-pull risk on freshly-launched tokens. The
  // ranker's `filterByMaxAge` (T37) applies a parallel check at the
  // discovery layer; this entry-strategy gate is the second line of
  // defense for the case where the ranker skipped the filter
  // (e.g. `first_seen_ts_ms` missing on the stats record) or where
  // the operator tunes the two knobs independently.
  //
  // Knob semantics (matches T33 / T35 / T36 opt-in pattern):
  //   - 0 / negative / non-finite → guard DISABLED (operator opts
  //     out; e.g. for a backtest pass where they want every
  //     candidate regardless of pool age).
  //   - > 365 → guard DISABLED (a > 1y minimum would reject nearly
  //     every token — better to opt out explicitly).
  //   - 0 < N <= 365 → apply guard. Default 7 days matches the
  //     ranker's `max_pool_age_days` (T37) so the two layers
  //     operate at the same threshold.
  //
  // Conservative posture (matches T31 / T32 / T33 / T35 / T36):
  //   - candidate.stats.first_seen_ts_ms missing / null → guard
  //     SKIPPED (don't reject just because the indexer didn't
  //     surface a timestamp; the ranker's filter still screens
  //     obvious cases).
  min_pool_age_days: 7,
});

/**
 * Coerce an input to a valid `EntryConfig`. Falls back to
 * `DEFAULT_ENTRY_CONFIG` for any missing / bad / non-object input.
 * Mirrors `resolveRankerConfig`'s pattern (see strategy/ranker.mjs).
 *
 * @param {Object|undefined|null} input
 * @returns {{
 *   max_position_bch: number,
 *   max_total_exposure_bch: number,
 *   min_entry_gap_from_high_pct: number,
 *   slippage_tolerance_bps: number,
 *   use_post_trade_check: boolean,
 *   min_trade_size_bch: number,
 *   max_indexer_vs_amm_ratio_x: number,
 *   min_amm_total_depth_sats: number,
 *   max_position_concentration_pct: number,
 *   volatility_sizing_target_pct: number,
 *   correlation_skip_threshold: number,
 *   min_pool_age_days: number,
 * }}
 */
export function resolveEntryConfig(input) {
  const base = DEFAULT_ENTRY_CONFIG;
  if (!input || typeof input !== 'object') {
    return { ...base };
  }
  /** @type {ReturnType<typeof resolveEntryConfig>} */
  const out = { ...base };
  const num = (k) => {
    const v = input[k];
    if (v === undefined || v === null) return;
    const n = Number(v);
    if (Number.isFinite(n)) out[k] = n;
  };
  num('max_position_bch');
  num('max_total_exposure_bch');
  num('min_entry_gap_from_high_pct');
  num('slippage_tolerance_bps');
  num('min_trade_size_bch');
  num('max_indexer_vs_amm_ratio_x');
  num('min_amm_total_depth_sats');
  num('max_position_concentration_pct');
  num('volatility_sizing_target_pct');
  num('correlation_skip_threshold');
  // T55: per-token slippage cap knobs. The base spread above picks
  // up the defaults from `DEFAULT_ENTRY_CONFIG`; the operator's
  // overrides need to be copied here too.
  num('slippage_cap_min_bps');
  num('slippage_cap_max_bps');
  num('slippage_cap_multiplier');
  if (typeof input.slippage_cap_per_token_enabled === 'boolean') {
    out.slippage_cap_per_token_enabled = input.slippage_cap_per_token_enabled;
  }
  // min_pool_age_days handled explicitly below to catch Infinity
  // (the `num()` helper refuses to write non-finite values, so
  // `Infinity` would otherwise silently fall through to the
  // default).
  if (typeof input.use_post_trade_check === 'boolean') {
    out.use_post_trade_check = input.use_post_trade_check;
  }
  // Sanity: clamp slippage tolerance to >= 0; negative is a config bug.
  if (!Number.isFinite(out.slippage_tolerance_bps) || out.slippage_tolerance_bps < 0) {
    out.slippage_tolerance_bps = base.slippage_tolerance_bps;
  }
  if (!Number.isFinite(out.max_position_bch) || out.max_position_bch <= 0) {
    out.max_position_bch = base.max_position_bch;
  }
  if (!Number.isFinite(out.max_total_exposure_bch) || out.max_total_exposure_bch <= 0) {
    out.max_total_exposure_bch = base.max_total_exposure_bch;
  }
  if (!Number.isFinite(out.min_trade_size_bch) || out.min_trade_size_bch <= 0) {
    out.min_trade_size_bch = base.min_trade_size_bch;
  }
  if (!Number.isFinite(out.min_entry_gap_from_high_pct)) {
    out.min_entry_gap_from_high_pct = base.min_entry_gap_from_high_pct;
  }
  // T31: a missing / non-finite / non-positive ratio disables the
  // pre-entry divergence check entirely (operator opts out). Match
  // the T28d exit-side guard's policy: missing → fall back to the
  // preset default rather than silently flipping to "always pass".
  if (!Number.isFinite(out.max_indexer_vs_amm_ratio_x) || out.max_indexer_vs_amm_ratio_x <= 0) {
    out.max_indexer_vs_amm_ratio_x = base.max_indexer_vs_amm_ratio_x;
  }
  // T32: 0 / negative / non-finite depth floor DISABLES the guard
  // (operator opts out — different from `max_indexer_vs_amm_ratio_x`
  // above, where 0 falls back to default. "Guard disabled" is a
  // deliberate operator action here, e.g. for a tight-wallet
  // backtest where they want to see every candidate). When the
  // operator doesn't supply the knob at all, `resolveEntryConfig`
  // inherits `DEFAULT_ENTRY_CONFIG.min_amm_total_depth_sats` (150M
  // sats) via the `{ ...base }` spread at the top.
  // T33: 0 / negative / > 100 concentration cap DISABLES the guard
  // (operator opts out, same opt-in pattern as `min_amm_total_depth_sats`).
  // Non-numeric strings / NaN fall back to the base default via the
  // `num()` helper above (matching `max_indexer_vs_amm_ratio_x`).
  // When the operator doesn't supply the knob at all,
  // `resolveEntryConfig` inherits `DEFAULT_ENTRY_CONFIG.
  // max_position_concentration_pct` (25.0) via the `{ ...base }`
  // spread at the top. Set the guard-disabled signal to a sentinel
  // value (`-1`) so the entry layer can distinguish "0%" (which
  // would mean "no trade can ever happen") from "disabled".
  if (Number.isFinite(out.max_position_concentration_pct)
      && (out.max_position_concentration_pct <= 0
          || out.max_position_concentration_pct > 100)) {
    out.max_position_concentration_pct = -1; // sentinel: guard DISABLED
  }
  // T35: same opt-in pattern as T33. `volatility_sizing_target_pct`
  // is consumed by `computeEntrySizeBch`, which already handles
  // any non-positive / non-finite / >100 value as a SKIP (rather
  // than scaling every trade to zero). We still coerce out-of-range
  // values to the `-1` sentinel here so the audit blob can render
  // "guard disabled" rather than a fake-looking 200% target.
  if (Number.isFinite(out.volatility_sizing_target_pct)
      && (out.volatility_sizing_target_pct <= 0
          || out.volatility_sizing_target_pct > 100)) {
    out.volatility_sizing_target_pct = -1; // sentinel: guard DISABLED
  }
  // T36: correlation-skip threshold. Coerce any non-positive /
  // non-finite / > 1 value to the `-1` disabled sentinel — same
  // opt-in pattern as T33 / T35. Correlation is bounded in [-1, 1]
  // by definition, so a threshold above 1 would never fire and is
  // better expressed as "guard disabled" (the operator can always
  // set it back to 0.85 when they want the guard back).
  if (Number.isFinite(out.correlation_skip_threshold)
      && (out.correlation_skip_threshold <= 0
          || out.correlation_skip_threshold > 1)) {
    out.correlation_skip_threshold = -1; // sentinel: guard DISABLED
  }
  // T37: minimum pool age. Coerce any non-positive / non-finite /
  // > 365 value to the `-1` disabled sentinel — same opt-in pattern
  // as T33 / T35 / T36. A 365-day maximum cap is generous enough
  // that no legitimate token gets rejected (only freshly-launched
  // launches do); anything beyond that would reject nearly every
  // token, so opt-out is the safer default. The explicit Infinity
  // check handles the case where the operator passes Infinity
  // directly: the `num()` helper above refuses to write non-finite
  // values, so the spread default (7) would otherwise survive.
  const rawMinPoolAge = input?.min_pool_age_days;
  if (rawMinPoolAge === Infinity
      || rawMinPoolAge === -Infinity
      || !Number.isFinite(Number(rawMinPoolAge))
      || Number(rawMinPoolAge) <= 0
      || Number(rawMinPoolAge) > 365) {
    out.min_pool_age_days = -1; // sentinel: guard DISABLED
  } else {
    out.min_pool_age_days = Number(rawMinPoolAge);
  }
  return out;
}

/**
 * @typedef {Object} PortfolioState
 * @property {Array<Object>} openPositions      positions.json → open[] + pending + closing
 * @property {number}        openExposureBch    sum of entry.bch_spent_sats (BCH)
 * @property {number}        walletBalanceBch   sats / 1e8 — current wallet balance (BCH)
 * @property {string}        [nowIso]           ISO timestamp (defaults to new Date().toISOString())
 */

/**
 * @typedef {Object} EntryDecision
 * @property {boolean} enter
 * @property {string}  [reason]            human-readable reason when enter=false
 * @property {string}  [kind]              machine-readable code when enter=false
 * @property {number}  [sizeBch]           proposed BCH spend (when enter=true)
 * @property {number}  [slippageCapBps]    ceiling for the swap layer (when enter=true)
 * @property {Object}  [reasoning]         audit blob stamped onto the position
 */

// ─────────────────────────────────────────────────────────────────────
//  Pure helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Floor a BCH amount to the nearest `stepBch`. Returns `0` when
 * the floored amount is below the dust threshold `minBch`.
 *
 * Pure. Exported for tests.
 *
 * @param {number} amountBch
 * @param {number} stepBch
 * @param {number} minBch
 * @returns {number}
 */
export function floorToStep(amountBch, stepBch, minBch) {
  if (!Number.isFinite(amountBch) || amountBch <= 0) return 0;
  if (!Number.isFinite(stepBch) || stepBch <= 0) return amountBch;
  // Defensive: NaN/undefined min → 0 (caller bug). Don't silently
  // let an arbitrary trade through when the dust floor isn't
  // actually defined.
  if (minBch === undefined || minBch === null || !Number.isFinite(minBch)) return 0;
  const units = Math.floor(amountBch / stepBch);
  // Multiply via integer arithmetic to avoid 0.0045000000000000005
  // floating-point drift. Convert stepBch to integer-safe notation
  // by rounding the result to the same decimal precision as `stepBch`.
  const decimals = (String(stepBch).split('.')[1] ?? '').length;
  let floored = units * stepBch;
  if (decimals > 0) {
    floored = Math.round(floored * 10 ** decimals) / 10 ** decimals;
  }
  if (floored < minBch) return 0;
  // Snap up to the dust floor if rounding would push us below — i.e.
  // if the trade WOULD have been above dust before flooring but the
  // floor cuts it under, we still take it (better than skipping).
  if (floored < amountBch && amountBch >= minBch && floored === 0) {
    return minBch;
  }
  return floored;
}

/**
 * Compute the entry size for one trade, honoring:
 *   - max_position_bch            (per-trade ceiling)
 *   - max_total_exposure_bch      (portfolio ceiling; subtract open exposure)
 *   - min_wallet_balance_bch      (reserve floor)
 *   - min_trade_size_bch          (dust floor)
 *   - max_position_concentration_pct (wallet-relative ceiling, T33)
 *   - step sizing via floorToStep
 *
 * Returns `0` when no trade is possible (config bug, fully exposed,
 * insufficient balance). Pure. Exported for the test suite + the
 * "GUARD" assertions.
 *
 * @param {Object} args
 * @param {number} args.maxPositionBch
 * @param {number} args.maxTotalExposureBch
 * @param {number} args.openExposureBch
 * @param {number} args.walletBalanceBch
 * @param {number} args.minWalletBalanceBch
 * @param {number} args.minTradeSizeBch
 * @param {number} [args.maxPositionConcentrationPct]   1..100 inclusive;
 *        omitted / 0 / negative / > 100 / non-finite → guard SKIPPED.
 *        When in range, the per-trade size is also capped at
 *        `walletBalanceBch * (pct / 100)` so a shrinking wallet
 *        automatically scales positions DOWN. See T33.
 * @param {number} [args.volatilitySizingTargetPct]      T35 Kelly-lite
 *        target. When `args.realizedVolatility24hPct > target`, the
 *        per-trade size is scaled DOWN to
 *        `pre-vol-size * (target / realized)`. Range 0..100; 0 /
 *        negative / > 100 / non-finite → guard SKIPPED. We NEVER
 *        scale UP beyond the existing per-trade ceiling.
 * @param {number} [args.realizedVolatility24hPct]        T35 realized
 *        volatility, in percent (e.g. 3.44 = 3.44% daily move). The
 *        trader loop threads `candidate.stats.volatility_24h_pct`
 *        into the sizer; null / non-finite / negative → guard
 *        SKIPPED (conservative: don't shrink without data). The
 *        guard also won't scale up if realized < target.
 * @returns {number} BCH (number, can be 0)
 */
export function computeEntrySizeBch({
  maxPositionBch,
  maxTotalExposureBch,
  openExposureBch,
  walletBalanceBch,
  minWalletBalanceBch,
  minTradeSizeBch,
  maxPositionConcentrationPct,
  volatilitySizingTargetPct,
  realizedVolatility24hPct,
}) {
  if (!Number.isFinite(maxPositionBch) || maxPositionBch <= 0) return 0;
  if (!Number.isFinite(maxTotalExposureBch) || maxTotalExposureBch <= 0) return 0;
  if (!Number.isFinite(openExposureBch) || openExposureBch < 0) return 0;
  if (!Number.isFinite(walletBalanceBch) || walletBalanceBch <= 0) return 0;
  if (!Number.isFinite(minWalletBalanceBch) || minWalletBalanceBch < 0) return 0;
  if (!Number.isFinite(minTradeSizeBch) || minTradeSizeBch <= 0) return 0;

  // 1. Per-trade ceiling.
  let size = Math.min(maxPositionBch, walletBalanceBch);
  // 2. Portfolio ceiling: headroom = max - open.
  const headroom = maxTotalExposureBch - openExposureBch;
  if (headroom <= 0) return 0;
  size = Math.min(size, headroom);
  // 3. Reserve floor: never leave less than minWalletBalanceBch.
  const affordable = walletBalanceBch - minWalletBalanceBch;
  if (affordable <= 0) return 0;
  size = Math.min(size, affordable);
  // 4. T33: concentration cap. Only applied when the operator
  //    configured an in-range percentage (1..100 inclusive). Missing /
  //    0 / negative / > 100 / non-finite → guard SKIPPED. We compute
  //    the cap from the LIVE wallet balance (not from a snapshot)
  //    so a shrinking wallet automatically scales positions DOWN —
  //    exactly the "force the bot to scale down when wallet is
  //    small" behavior the feature asked for. Track whether the
  //    cap actually REDUCED size (vs. being a no-op) so the caller
  //    can distinguish "cap shrunk the position to dust" from
  //    "dust floor swallowed a normally-sized position".
  let capReducedSize = false;
  if (Number.isFinite(maxPositionConcentrationPct)
      && maxPositionConcentrationPct > 0
      && maxPositionConcentrationPct <= 100) {
    const concentrationCap = walletBalanceBch * (maxPositionConcentrationPct / 100);
    if (Number.isFinite(concentrationCap) && concentrationCap > 0) {
      const preCapSize = size;
      size = Math.min(size, concentrationCap);
      if (size < preCapSize) capReducedSize = true;
    }
  }
  // 5. T35 — volatility-adjusted sizing (Kelly-lite). When the
  //    realized 24h volatility exceeds the configured target,
  //    scale the position DOWN by `target / realized` (linear).
  //    We do NOT scale up — Kelly-lite is asymmetric by design,
  //    so a calm-vol token gets the existing per-trade ceiling
  //    unchanged. `volatilitySizingTargetPct` follows the same
  //    opt-in pattern as T33 (0 / negative / >100 / non-finite
  //    → guard SKIPPED). `realizedVolatility24hPct` follows the
  //    `candidate.stats.volatility_24h_pct` semantics: null /
  //    non-finite / negative → guard SKIPPED (conservative:
  //    don't shrink without data). The guard only fires when
  //    realized > target — otherwise the math would be a no-op
  //    and we save the floating-point work.
  if (size > 0
      && Number.isFinite(volatilitySizingTargetPct)
      && volatilitySizingTargetPct > 0
      && volatilitySizingTargetPct <= 100
      && Number.isFinite(realizedVolatility24hPct)
      && realizedVolatility24hPct > volatilitySizingTargetPct) {
    const scale = volatilitySizingTargetPct / realizedVolatility24hPct;
    // `scale` is in (0, 1) because `realized > target`. Apply
    // it directly to the current size (which already accounts
    // for concentration cap, headroom, floor, etc.); the result
    // is at most `size`, and the dust-floor / `floorToStep`
    // step below handles the rounding.
    size = size * scale;
  }
  if (size <= 0) return 0;
  // 5. Round DOWN to min_trade_size_bch step (dust floor).
  const floored = floorToStep(size, minTradeSizeBch, minTradeSizeBch);
  // T33: when the post-floor size rounds to 0 AND the cap actually
  // reduced the pre-floor size below the dust floor — signal via
  // the special `NaN` sentinel so the caller can distinguish
  // "dust floor swallowed a normally-sized position" from
  // "concentration cap shrunk the position below the dust floor".
  // NaN is safe because `floorToStep` only ever returns 0 or a
  // positive multiple — NaN can never collide. We require BOTH
  // that the cap was the cause of the reduction AND that the
  // cap-driven size was already below the dust floor; otherwise
  // we'd misdiagnose a normal dust-floor rejection as a cap
  // rejection (e.g. when max_position_bch is below min_trade_size_bch
  // and the cap was a no-op).
  if (floored <= 0 && capReducedSize && size < minTradeSizeBch) return NaN;
  return floored;
}

// ─────────────────────────────────────────────────────────────────────
//  Main entry decision
// ─────────────────────────────────────────────────────────────────────

/**
 * Decide whether to enter a position on `candidate`. Pure.
 *
 * @param {Object}       candidate       a ranker candidate row
 * @param {PortfolioState} portfolioState
 * @param {Object}       cfg             merged default+user config
 * @param {Object}       [opts]
 * @param {number}       [opts.nowMs]    ms since epoch (defaults to Date.now)
 * @returns {EntryDecision}
 */
export function shouldEnter(candidate, portfolioState, cfg, opts = {}) {
  // 1. Validate the inputs.
  if (!candidate || typeof candidate !== 'object') {
    return { enter: false, reason: 'candidate not an object', kind: 'bad_input' };
  }
  // 1. Validate the inputs.
  if (!candidate || typeof candidate !== 'object') {
    return { enter: false, reason: 'candidate not an object', kind: 'bad_input' };
  }
  if (!portfolioState || typeof portfolioState !== 'object') {
    return { enter: false, reason: 'portfolioState not an object', kind: 'bad_input' };
  }
  if (!cfg || typeof cfg !== 'object') {
    return { enter: false, reason: 'cfg not an object', kind: 'bad_input' };
  }
  // cfg.risk is where we read min_wallet_balance_bch (see ARCHITECTURE §5);
  // cfg.entry is where we read sizing knobs.
  const riskCfg = cfg.risk ?? {};
  const entryCfg = resolveEntryConfig(cfg.entry);
  const minWalletBalanceBch = Number(riskCfg.min_wallet_balance_bch);
  const maxDailyLossBch = Number(riskCfg.max_daily_loss_bch);

  const tokenId = typeof candidate.token_id === 'string' ? candidate.token_id : '';
  const nowMs = (opts && Number.isFinite(Number(opts.nowMs)))
    ? Number(opts.nowMs)
    : Date.now();
  const nowIso = (typeof portfolioState.nowIso === 'string' && portfolioState.nowIso.length > 0)
    ? portfolioState.nowIso
    : new Date(nowMs).toISOString();

  // 2. Eligibility (from the ranker).
  if (candidate.eligible === false) {
    return {
      enter: false,
      reason: 'ranker marked ineligible',
      kind: 'not_eligible',
      reasoning: _entryReasoning({
        nowMs, tokenId, cfg: { ...cfg, entry: entryCfg, risk: riskCfg },
        candidate, decision: { kind: 'not_eligible' },
      }),
    };
  }
  if (!candidate.rank || candidate.rank < 1) {
    return {
      enter: false,
      reason: 'no rank assigned (not in top-K)',
      kind: 'not_in_topk',
      reasoning: _entryReasoning({
        nowMs, tokenId, cfg: { ...cfg, entry: entryCfg, risk: riskCfg },
        candidate, decision: { kind: 'not_in_topk' },
      }),
    };
  }

  // 3. Price evidence. A candidate must have a non-null spot price,
  //    otherwise the swap executor would be flying blind. The ranker
  //    passes the underlying stats record through `candidate.stats`.
  const stats = candidate.stats ?? null;
  const priceNowSats = stats && Number.isFinite(stats.price_now_sats)
    ? Number(stats.price_now_sats)
    : null;
  if (priceNowSats === null || priceNowSats <= 0) {
    return {
      enter: false,
      reason: 'no price evidence (oracle missing)',
      kind: 'no_price_evidence',
      reasoning: _entryReasoning({
        nowMs, tokenId, cfg: { ...cfg, entry: entryCfg, risk: riskCfg },
        candidate, decision: { kind: 'no_price_evidence' },
      }),
    };
  }

  // 4. "Gap from 24h high" gate (don't buy right at the top).
  //
  //    SEMANTIC CAVEAT — `change_24h_bp` is the indexer's reported
  //    24-hour price delta in basis points, defined as
  //      `(current - price_24h_ago) / price_24h_ago * 10_000`.
  //    It is NOT a literal "distance from 24h high" — the 24h-ago
  //    price is a point in time, not the maximum. If a token
  //    pumped 50% then dropped 25%, the 24h high is 50% above
  //    current but `change_24h_bp` is only +250 (still positive
  //    because current is above the 24h-ago price). The gate
  //    uses `change_24h_bp` as a proxy because the indexer does
  //    not currently expose a separate "24h high" field — so it
  //    over-skips tokens that pumped-and-crashed (current is
  //    visibly below the high, but the gate still fires). The
  //    reasoning message below is explicit about what metric is
  //    being compared against, so operators can spot the proxy.
  const gap = entryCfg.min_entry_gap_from_high_pct;
  if (Number.isFinite(gap) && gap > 0) {
    const ch24bp = stats && Number.isFinite(stats.change_24h_bp) ? Number(stats.change_24h_bp) : null;
    if (ch24bp !== null) {
      // ch24bp > 0 → price rose vs 24h ago (skip — anti-pump).
      // ch24bp < 0 → price dropped vs 24h ago; require the drop
      // to be at least `gap`% before entering.
      const thresholdBp = -(gap * 100);
      if (ch24bp > thresholdBp) {
        // Honest skip-reason phrasing. The previous version
        // rendered `${(-ch24bp / 100)}% below` for both signs of
        // ch24bp, which produced a misleading "-2.06% below" when
        // ch24bp was actually +206 (price had risen 2.06%, not
        // dropped). Operators reading the message concluded the
        // gate should pass; the gate was correct, the message
        // wasn't. The new wording distinguishes "below" (price
        // dropped but not enough) from "above" (price rose, gate
        // fires because the token hasn't cooled off).
        const ch24pct = Math.abs(ch24bp / 100).toFixed(2);
        const direction = ch24bp < 0 ? 'below' : 'above';
        const reason = ch24bp < 0
          ? `24h gap not deep enough (gap ${gap}% required, price only ${ch24pct}% ${direction} 24h-ago price; uses change_24h_bp proxy for 24h high)`
          : `price above 24h-ago by ${ch24pct}% (gap ${gap}% required; uses change_24h_bp proxy for 24h high)`;
        return {
          enter: false,
          reason,
          kind: 'too_close_to_high',
          reasoning: _entryReasoning({
            nowMs, tokenId, cfg: { ...cfg, entry: entryCfg, risk: riskCfg },
            candidate, decision: { kind: 'too_close_to_high', ch24bp, thresholdBp },
          }),
        };
      }
    }
  }

  // 4b. T32: pre-entry AMM depth floor. The trading loop
  //     pre-computes the total BCH-side reserves across every
  //     ACTIVE pool for this token (via
  //     `fetcher.getAmmTotalDepthSats(tokenId)`) and threads it
  //     in as `candidate.amm_total_depth_sats`. The bot's
  //     existing `scoring.min_tvl_bch` ranker filter reads the
  //     indexer's `tvl_sats`, which can be STALE or based on a
  //     DIFFERENT pool set than the one `prepareAndBuildSwap`
  //     actually routes through. When the live active-pools
  //     depth is below `entry.min_amm_total_depth_sats`, the
  //     swap would face catastrophic slippage on entry AND on
  //     exit — every position that lands in this pool is
  //     effectively a one-way trip.
  //
  //     Default: 150,000,000 sats = 1.5 BCH. At the
  //     small-balance preset's `max_position_bch=0.005`, a 1.5
  //     BCH floor means each trade consumes at most ~0.33% of
  //     pool depth (well under the slippage tolerance's comfort
  //     zone). QBTC 2026-09-14 had live ~1.32 BCH across 10
  //     pools — under both this floor AND the T31 divergence
  //     guard's indexer check, the bot would now reject the
  //     entry instead of opening a position that immediately
  //     spammed `exit_failed`.
  //
  //     Knob semantics:
  //       - 0 → guard DISABLED (operator opts out)
  //       - positive finite → floor in sats
  //       - negative / non-finite → guard DISABLED (same as 0)
  //       - candidate.amm_total_depth_sats missing / null /
  //         negative → guard SKIPPED (conservative: don't
  //         reject just because the AMM probe failed; the
  //         existing `min_tvl_bch` ranker filter still screens
  //         the worst cases).
  const ammTotalDepthRaw = (() => {
    if (!candidate || typeof candidate !== 'object') return null;
    const v = candidate.amm_total_depth_sats;
    if (v === null || v === undefined) return null;
    if (typeof v === 'bigint') return v < 0n ? null : v;
    if (typeof v === 'number') return (Number.isFinite(v) && v >= 0) ? BigInt(Math.trunc(v)) : null;
    if (typeof v === 'string' && v.length > 0) {
      try {
        const bi = BigInt(v);
        return bi < 0n ? null : bi;
      } catch { return null; }
    }
    return null;
  })();
  const minDepthSats = Number(entryCfg.min_amm_total_depth_sats);
  if (ammTotalDepthRaw !== null
      && Number.isFinite(minDepthSats)
      && minDepthSats > 0
      && ammTotalDepthRaw < BigInt(Math.trunc(minDepthSats))) {
    return {
      enter: false,
      reason: `total AMM depth ${ammTotalDepthRaw.toString()} sats across ${(Array.isArray(candidate.amm_total_pools) ? candidate.amm_total_pools : 'all')} active pools < min_amm_total_depth_sats ${Math.trunc(minDepthSats)} sats — would face exit-side slippage at the configured position size`,
      kind: 'below_min_amm_depth',
      reasoning: _entryReasoning({
        nowMs, tokenId, cfg: { ...cfg, entry: entryCfg, risk: riskCfg },
        candidate,
        decision: {
          kind: 'below_min_amm_depth',
          amm_total_depth_sats: ammTotalDepthRaw.toString(),
          min_amm_total_depth_sats: Math.trunc(minDepthSats),
        },
      }),
    };
  }

  // 4c. T31: indexer-reference-price vs AMM-implied-spot divergence
  //     guard. The trading loop pre-computes the AMM-implied spot
  //     rate (via `fetcher.getAmmSpotSats(tokenId)`) and attaches
  //     it as `candidate.amm_spot_sats`. When BOTH the indexer
  //     price AND the AMM spot are present, the indexer price must
  //     be within `max_indexer_vs_amm_ratio_x` of the AMM spot —
  //     else reject with `kind: 'indexer_vs_amm_divergence'`.
  //
  //     Without this guard, the bot can enter a token whose
  //     indexer reference price is 1000x+ off from the actual
  //     AMM-implied rate. Take-profit then fires on the bogus
  //     indexer price on every subsequent tick, and the swap
  //     layer's pre-flight slippage rejects every exit attempt —
  //     the position sits stuck for the full 24h time-stop. The
  //     2026-09-14 QBTC incident is the canonical example
  //     (indexer reported 326 BCH/QBTC, AMM rate was 326
  //     sats/QBTC — a 100,000,000x divergence).
  //
  //     Units: the indexer's `stats.price_now_sats` is per DISPLAY
  //     unit; the AMM spot (from `bestMarginalBuyRate`) is per
  //     BASE unit. The loop aligns them by multiplying the indexer
  //     price by 10^decimals before threading it in as
  //     `candidate.amm_spot_sats` (see `_evaluateEntry` in
  //     `src/trader/loop.mjs`). When the caller hasn't done that
  //     alignment (e.g. tests pass raw candidates), we still
  //     detect divergence at the order-of-magnitude level — a
  //     100,000,000x disparity shows up regardless of unit scale.
  //
  //     `isPricePlausibleVsEntry` is a generic two-price ratio
  //     check (anchor + candidate + ratio) — the "VsEntry" name is
  //     a holdover from the T28d exit-side use case but the
  //     semantics are identical for any two positive prices.
  const ammSpotSats = (() => {
    if (!candidate || typeof candidate !== 'object') return null;
    const v = candidate.amm_spot_sats;
    if (v === null || v === undefined) return null;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
    if (typeof v === 'bigint' && v > 0n) return Number(v);
    if (typeof v === 'string' && v.length > 0) {
      try {
        const bi = BigInt(v);
        return bi > 0n ? Number(bi) : null;
      } catch { return null; }
    }
    return null;
  })();
  if (ammSpotSats !== null && Number.isFinite(priceNowSats) && priceNowSats > 0) {
    const ratioX = Number(entryCfg.max_indexer_vs_amm_ratio_x);
    const plausible = isPricePlausibleVsEntry(priceNowSats, ammSpotSats, ratioX);
    if (!plausible) {
      // Compute the actual ratio (always >= ratioX, since we got
      // here via `!plausible`) so the reason string + reasoning
      // blob both carry the empirical figure for the operator.
      const observedRatioX = (priceNowSats > ammSpotSats)
        ? priceNowSats / ammSpotSats
        : ammSpotSats / priceNowSats;
      return {
        enter: false,
        reason: `indexer price ${priceNowSats} sats/token vs AMM spot ${ammSpotSats} sats/token — ratio ${observedRatioX.toFixed(0)}x exceeds max ${ratioX}x (entry would be unrecoverable at the indexer reference price)`,
        kind: 'indexer_vs_amm_divergence',
        reasoning: _entryReasoning({
          nowMs, tokenId, cfg: { ...cfg, entry: entryCfg, risk: riskCfg },
          candidate,
          decision: {
            kind: 'indexer_vs_amm_divergence',
            indexer_price_sats: priceNowSats,
            amm_spot_sats: ammSpotSats,
            observed_ratio_x: observedRatioX,
            max_ratio_x: ratioX,
          },
        }),
      };
    }
  }

  // 4d. T36: correlation-skip gate. Multiple positions in tokens
  //     that move together aren't diversifying — they're a
  //     concentrated bet. The trading loop pre-fetches the
  //     29-point normalized 7-day price series (`price_series_7d`)
  //     for the candidate AND every open position's token, and
  //     attaches the held-token map as
  //     `portfolioState.heldSeriesByTokenId`. The candidate's own
  //     series is read from `candidate.price_series_7d` (already
  //     in the candidate's `stats` record, passed through by
  //     `Fetcher.buildStatsRecord`).
  //
  //     When the worst absolute Pearson r between the candidate
  //     and any held token exceeds `entry.correlation_skip_threshold`,
  //     the entry is rejected with `kind: 'correlation_skip'`. The
  //     audit blob surfaces `correlation_threshold`, the observed
  //     `correlation_max`, and `correlation_against_token_id` so
  //     the operator can see which held position the candidate
  //     was duplicating.
  //
  //     Knob semantics (matches T33 / T35 opt-in pattern):
  //       - 0 / negative / non-finite / > 1 → guard DISABLED
  //         (the `-1` sentinel from `resolveEntryConfig` is the
  //         canonical "guard disabled" signal).
  //       - 0 < threshold <= 1 → apply guard.
  //
  //     Conservative posture (matches T31 / T32 / T33):
  //       - candidate.price_series_7d missing / null → guard SKIPPED
  //         (don't reject just because the indexer didn't return a
  //         series for the candidate).
  //       - portfolioState.heldSeriesByTokenId missing / empty /
  //         null → guard SKIPPED (no held positions to compare
  //         against — every entry is a fresh diversification).
  //       - heldSeriesByTokenId contains tokens with no series /
  //         degenerate series → those tokens are silently skipped
  //         (no correlation defined for a constant signal).
  const corrThresholdRaw = entryCfg.correlation_skip_threshold;
  const corrThresholdAudit = (Number.isFinite(corrThresholdRaw)
    && corrThresholdRaw > 0
    && corrThresholdRaw <= 1)
    ? corrThresholdRaw
    : null;
  if (corrThresholdAudit !== null) {
    const candSeries = (candidate && Array.isArray(candidate.price_series_7d))
      ? candidate.price_series_7d
      : (stats && Array.isArray(stats.price_series_7d))
        ? stats.price_series_7d
        : null;
    const heldMap = portfolioState.heldSeriesByTokenId;
    if (candSeries !== null && candSeries.length >= 2
        && heldMap && typeof heldMap === 'object') {
      const corr = maxAbsCorrelation(candSeries, heldMap, {
        excludeTokenId: tokenId,
      });
      if (corr.maxAbs !== null && corr.maxAbs > corrThresholdAudit) {
        return {
          enter: false,
          reason: `candidate price series ${corr.maxAbs.toFixed(3)} |Pearson r| with held token ${corr.againstTokenId ?? '?'} exceeds correlation_skip_threshold ${corrThresholdAudit} (r=${corr.r.toFixed(3)}) — entering would double exposure to the same risk factor`,
          kind: 'correlation_skip',
          reasoning: _entryReasoning({
            nowMs, tokenId, cfg: { ...cfg, entry: entryCfg, risk: riskCfg },
            candidate,
            decision: {
              kind: 'correlation_skip',
              correlation_threshold: corrThresholdAudit,
              correlation_max: corr.maxAbs,
              correlation_signed_r: corr.r,
              correlation_against_token_id: corr.againstTokenId,
            },
          }),
        };
      }
    }
  }

  // 4e. T37: minimum-pool-age gate. Tokens whose oldest active pool
  //     is younger than `entry.min_pool_age_days` are dropped at
  //     entry — wash-trade / seed-swap / rug-pull risk on
  //     freshly-launched tokens. The ranker's `filterByMaxAge`
  //     (T37) applies a parallel check at discovery; this
  //     entry-strategy gate is the second line of defense for the
  //     case where the ranker skipped the filter (e.g. when the
  //     indexer didn't surface a `first_pool_ts` for the token —
  //     `filterByMaxAge` treats missing evidence as "skip filter")
  //     or where the operator tunes the two knobs independently.
  //
  //     The age is computed from `candidate.stats.first_seen_ts_ms`
  //     (the indexer's `first_pool_ts` converted to ms by
  //     `Fetcher.buildStatsRecord`). We reuse the ranker's
  //     `poolAgeDays` helper to keep the math identical across the
  //     two layers.
  //
  //     Knob semantics (matches T33 / T35 / T36 opt-in pattern):
  //       - 0 / negative / non-finite / > 365 → guard DISABLED
  //         (the `-1` sentinel from `resolveEntryConfig` is the
  //         canonical "guard disabled" signal).
  //       - 0 < days <= 365 → apply guard. Default 7 days matches
  //         the ranker's `max_pool_age_days` (T37) so the two
  //         layers operate at the same threshold by default.
  //
  //     Conservative posture (matches T31 / T32 / T33 / T35 / T36):
  //       - candidate.stats.first_seen_ts_ms missing / null →
  //         guard SKIPPED (don't reject just because the indexer
  //         didn't surface a timestamp; the ranker's filter still
  //         screens obvious cases).
  //       - nowMs not finite → guard SKIPPED (the caller didn't
  //         pass a clock; we can't compute age without one).
  const minPoolAgeDays = entryCfg.min_pool_age_days;
  if (Number.isFinite(minPoolAgeDays) && minPoolAgeDays > 0 && minPoolAgeDays <= 365
      && Number.isFinite(nowMs)) {
    const ageDays = poolAgeDays(stats, nowMs);
    if (ageDays !== null && ageDays < minPoolAgeDays) {
      return {
        enter: false,
        reason: `oldest active pool is ${ageDays.toFixed(2)}d < min_pool_age_days ${minPoolAgeDays}d — freshly-launched tokens carry wash-trade / seed-swap risk`,
        kind: 'too_young_pool',
        reasoning: _entryReasoning({
          nowMs, tokenId, cfg: { ...cfg, entry: entryCfg, risk: riskCfg },
          candidate,
          decision: {
            kind: 'too_young_pool',
            pool_age_days: ageDays,
            min_pool_age_days: minPoolAgeDays,
            first_seen_ts_ms: (stats && Number.isFinite(Number(stats.first_seen_ts_ms)))
              ? Number(stats.first_seen_ts_ms)
              : null,
          },
        }),
      };
    }
  }

  // 5. Compute the size. Always reads from cfg, never from a literal.
  const walletBalanceBch = Number(portfolioState.walletBalanceBch);
  const openExposureBch = Number(portfolioState.openExposureBch);
  // T33: pass the concentration cap into the sizer. -1 sentinel from
  // `resolveEntryConfig` means "guard disabled" — we pass it through
  // verbatim and let `computeEntrySizeBch` treat any non-positive or
  // non-finite value as a SKIP. The default 25.0 + the small-balance
  // wallet size means this knob is a no-op in production; it only
  // bites when the wallet shrinks (the intended safety net).
  const concentrationPctRaw = entryCfg.max_position_concentration_pct;
  // -1 sentinel from `resolveEntryConfig` → null for the audit blob
  // (so the operator sees "guard disabled", not "-1 percent").
  const concentrationPct = (Number.isFinite(concentrationPctRaw)
    && concentrationPctRaw > 0
    && concentrationPctRaw <= 100)
    ? concentrationPctRaw
    : null;
  const concentrationPctForSizer = concentrationPctRaw; // raw value (may be -1)
  // T35: thread the realized 24h volatility from the candidate's
  // stats record into the sizer. `volatility_24h_pct` is set by
  // the ranker from `stats.change_24h_bp` (absolute % move over
  // the last 24h). null / non-finite / negative → guard SKIPPED
  // (conservative: don't shrink without data). We read the value
  // off `candidate.stats` (preferred) and fall back to
  // `candidate.volatility_24h_pct` for test-fixture parity.
  const realizedVolRaw = (() => {
    const fromStats = stats && Number.isFinite(Number(stats.volatility_24h_pct))
      ? Number(stats.volatility_24h_pct) : null;
    const fromCand = (candidate && Number.isFinite(Number(candidate.volatility_24h_pct)))
      ? Number(candidate.volatility_24h_pct) : null;
    const v = fromStats !== null ? fromStats : fromCand;
    if (v === null) return null;
    if (!Number.isFinite(v) || v < 0) return null;
    return v;
  })();
  // T35: same -1 sentinel pattern as T33 for the sizer (raw,
  // may be -1 when guard disabled).
  const volSizingTargetRaw = entryCfg.volatility_sizing_target_pct;
  const volSizingTarget = (Number.isFinite(volSizingTargetRaw)
    && volSizingTargetRaw > 0
    && volSizingTargetRaw <= 100)
    ? volSizingTargetRaw
    : null;
  // T35: pre-compute the effective Kelly-lite scale factor so it
  // can be surfaced in BOTH the happy-path decision blob AND the
  // size-zero rejection path. Operator audit needs to be able to
  // see "this candidate's size was zero because vol-scaling shrank
  // it below the dust floor", not just "size rounded to 0" — the
  // latter is ambiguous (could be dust floor, concentration cap,
  // exposure, or wallet-floor). `scale` is in [0, 1] (1.0 = no-op,
  // <1.0 = guard reduced size).
  const volSizingScalePre = (realizedVolRaw !== null && volSizingTarget !== null
    && realizedVolRaw > volSizingTarget)
    ? Number((volSizingTarget / realizedVolRaw).toFixed(6))
    : 1.0;
  const size = computeEntrySizeBch({
    maxPositionBch: entryCfg.max_position_bch,
    maxTotalExposureBch: entryCfg.max_total_exposure_bch,
    openExposureBch,
    walletBalanceBch,
    minWalletBalanceBch: Number.isFinite(minWalletBalanceBch) ? minWalletBalanceBch : 0,
    minTradeSizeBch: entryCfg.min_trade_size_bch,
    maxPositionConcentrationPct: Number.isFinite(concentrationPctForSizer)
      ? concentrationPctForSizer
      : -1,
    volatilitySizingTargetPct: Number.isFinite(volSizingTargetRaw)
      ? volSizingTargetRaw
      : -1,
    realizedVolatility24hPct: realizedVolRaw,
  });
  if (!(size > 0)) {
    let reason = 'size rounded to 0';
    let kind = 'size_zero';
    // T33: when the sizer returns NaN, the concentration cap was
    // responsible for sizing the position down to below the dust
    // floor. We surface this as a distinct `kind` so the operator
    // audit trail can tell the difference between "dust floor
    // swallowed a normally-sized position" (kind:'size_zero') and
    // "concentration cap swallowed a position because the wallet
    // shrunk" (kind:'concentration_cap').
    const capWasResponsible = Number.isNaN(size);
    if (walletBalanceBch <= 0) { reason = 'wallet balance zero'; kind = 'no_balance'; }
    else if (!Number.isFinite(minWalletBalanceBch) || walletBalanceBch <= minWalletBalanceBch) {
      reason = `wallet balance ${walletBalanceBch} BCH at or below reserve floor ${minWalletBalanceBch}`;
      kind = 'below_floor';
    } else if (openExposureBch >= entryCfg.max_total_exposure_bch) {
      reason = `max total exposure ${entryCfg.max_total_exposure_bch} BCH already deployed`;
      kind = 'exposure_full';
    } else if (capWasResponsible) {
      // T33: with wallet balance, exposure, and reserve floor all
      // satisfied, the only remaining reason the position could
      // round to 0 is the concentration cap being below the dust
      // floor. Surface it as `kind:'concentration_cap'` so the
      // operator can tell the difference between "I configured a
      // cap and the wallet shrunk" vs. "min_trade_size_bch dust
      // floor swallowed the trade". `concentrationPct` is `null`
      // when the guard is disabled, but the NaN sentinel from
      // `computeEntrySizeBch` only fires when the guard was
      // active, so this branch is unreachable when `concentrationPct`
      // is `null` (defensive assertion kept for clarity).
      if (concentrationPct === null) {
        // Defensive: if the sizer said "cap was responsible" but
        // the guard was supposed to be off, fall through to the
        // generic `size_zero` rather than fabricating a cap
        // explanation. This should never fire because the NaN
        // sentinel requires `concentrationCapApplied === true`.
        kind = 'size_zero';
        reason = `size rounded to 0 (cap-applied sentinel with no active cap)`;
      } else {
        const cap = walletBalanceBch * (concentrationPct / 100);
        reason = `position concentration cap ${concentrationPct}% of wallet = ${cap.toFixed(8)} BCH would round to 0 below min_trade_size_bch ${entryCfg.min_trade_size_bch}`;
        kind = 'concentration_cap';
      }
    }
    return {
      enter: false, reason, kind,
      reasoning: _entryReasoning({
        nowMs, tokenId, cfg: { ...cfg, entry: entryCfg, risk: riskCfg },
        candidate,
        decision: {
          kind,
          size_requested: size,
          // T35: surface the vol-scaling state on rejection paths
          // too so the operator can tell "size=0 because vol guard
          // shrank it below dust" from "size=0 because dust floor
          // swallowed a normal position".
          vol_sizing_target_pct: volSizingTarget,
          vol_sizing_realized_pct: realizedVolRaw,
          vol_sizing_scale: volSizingScalePre,
        },
      }),
    };
  }

  // 6. Compose the reasoning blob the trader loop stamps onto the
  //    position. We snapshot EVERY gate value so the auditor can
  //    reconstruct the decision later (config drifts between then
  //    and now will not retroactively change the record).
  // T55: the cap reported on the position is the EFFECTIVE per-token
  // cap (when `candidate.amm_total_depth_sats` is available) so the
  // audit trail reflects what actually gated the trade — not the flat
  // `slippage_tolerance_bps` fallback. The `cap_source` field surfaces
  // 'flat' vs 'per_token' so the operator can tell at a glance which
  // cap fired.
  const baseSlippageBpsBi = BigInt(entryCfg.slippage_tolerance_bps ?? 100);
  const slippageCapInfo = (() => {
    const rawDepth = ammTotalDepthRaw; // bigint | null (validated above)
    if (rawDepth === null) {
      return { capBps: baseSlippageBpsBi, source: 'flat', poolDepthSats: null };
    }
    const perTokenBps = resolveSlippageCapBps({
      baseCapBps: baseSlippageBpsBi,
      sizeBch: size,
      poolDepthBch: Number(rawDepth) / 1e8,
      minBps: entryCfg.slippage_cap_min_bps,
      maxBps: entryCfg.slippage_cap_max_bps,
      multiplier: entryCfg.slippage_cap_multiplier,
      enabled: entryCfg.slippage_cap_per_token_enabled ?? true,
    });
    return {
      capBps: perTokenBps,
      source: perTokenBps === baseSlippageBpsBi ? 'flat' : 'per_token',
      poolDepthSats: rawDepth,
    };
  })();
  const slippageCapBps = Number(slippageCapInfo.capBps);
  const reasoning = _entryReasoning({
    nowMs, nowIso, tokenId,
    cfg: { ...cfg, entry: entryCfg, risk: riskCfg },
    candidate,
    decision: {
      kind: 'enter',
      size_bch: size,
      wallet_balance_bch: walletBalanceBch,
      open_exposure_bch: openExposureBch,
      headroom_bch: entryCfg.max_total_exposure_bch - openExposureBch,
      slippage_cap_bps: slippageCapBps,
      slippage_cap_source: slippageCapInfo.source,
      slippage_cap_pool_depth_sats:
        slippageCapInfo.poolDepthSats === null
          ? null
          : slippageCapInfo.poolDepthSats.toString(),
      price_now_sats: priceNowSats,
      score: candidate.score ?? null,
      rank: candidate.rank ?? null,
      max_daily_loss_bch: Number.isFinite(maxDailyLossBch) ? maxDailyLossBch : null,
      // T33: surface the concentration cap and the implied
      // wallet-relative ceiling so the operator audit trail shows
      // exactly which ceiling was applied. `null` when the guard
      // was disabled (operator opted out).
      max_position_concentration_pct: concentrationPct,
      concentration_cap_bch: concentrationPct !== null
        ? Number((walletBalanceBch * (concentrationPct / 100)).toFixed(8))
        : null,
      // T35: surface the Kelly-lite sizing state. `vol_sizing_target_pct`
      // is the configured target; `vol_sizing_realized_pct` is the
      // observed 24h volatility we measured; `vol_sizing_scale` is the
      // effective scale factor applied (1.0 = guard didn't fire,
      // < 1.0 = guard reduced size). All three are `null` when the
      // guard was disabled / data was missing — same audit semantics
      // as the T33 concentration cap.
      vol_sizing_target_pct: volSizingTarget,
      vol_sizing_realized_pct: realizedVolRaw,
      vol_sizing_scale: volSizingScalePre,
    },
  });

  return {
    enter: true,
    sizeBch: size,
    slippageCapBps,
    reasoning,
  };
}

/**
 * @private — build the audit-trail blob stamped onto the position.
 *            Pure. Mirrors the ranker's `reasoning` shape so the
 *            PORTFOLIO view can show one combined record.
 */
function _entryReasoning({ nowMs, nowIso, tokenId, cfg, candidate, decision }) {
  const entryCfg = cfg.entry ?? {};
  const riskCfg = cfg.risk ?? {};
  // T33: convert the -1 disabled-sentinel from `resolveEntryConfig`
  // to `null` so the operator audit trail reads as
  // "guard disabled" rather than "concentration cap = -1%".
  const concentrationPctAudit = (Number.isFinite(Number(entryCfg.max_position_concentration_pct))
    && Number(entryCfg.max_position_concentration_pct) > 0
    && Number(entryCfg.max_position_concentration_pct) <= 100)
    ? Number(entryCfg.max_position_concentration_pct)
    : null;
  return {
    ts: nowMs,
    ts_iso: nowIso ?? new Date(nowMs).toISOString(),
    token_id: tokenId,
    score: candidate?.score ?? null,
    rank: candidate?.rank ?? null,
    topK: candidate?.topK ?? null,
    eligible_for_trade: candidate?.eligible === true,
    breakdown: candidate?.breakdown ?? null,
    passed_filters: candidate?.reasoning?.passed_filters ?? [],
    notes: candidate?.notes ?? [],
    decision,
    conditions: {
      max_position_bch: entryCfg.max_position_bch ?? null,
      max_total_exposure_bch: entryCfg.max_total_exposure_bch ?? null,
      min_wallet_balance_bch: riskCfg.min_wallet_balance_bch ?? null,
      min_trade_size_bch: entryCfg.min_trade_size_bch ?? null,
      slippage_tolerance_bps: entryCfg.slippage_tolerance_bps ?? null,
      min_entry_gap_from_high_pct: entryCfg.min_entry_gap_from_high_pct ?? null,
      max_daily_loss_bch: riskCfg.max_daily_loss_bch ?? null,
      // T31: pre-entry indexer-vs-AMM divergence guard. Null when
      // the loop didn't pre-compute an AMM spot (offline run, AMM
      // fetch failed, unit test passing a raw candidate) — the
      // gate is then skipped (conservative: don't reject just
      // because the operator disabled the AMM probe).
      max_indexer_vs_amm_ratio_x: entryCfg.max_indexer_vs_amm_ratio_x ?? null,
      // T32: pre-entry AMM depth floor. Always present (even when
      // null probe) so the operator audit trail shows what the
      // configured threshold WAS — drift between config-now and
      // config-at-entry-time is then legible.
      min_amm_total_depth_sats: Number.isFinite(Number(entryCfg.min_amm_total_depth_sats))
        ? Number(entryCfg.min_amm_total_depth_sats)
        : null,
      // T33: the wallet-relative per-trade ceiling (percent). Null
      // when disabled (-1 sentinel from `resolveEntryConfig`) so
      // the operator can tell "missing config" from "guard off"
      // from "guard set to N%".
      max_position_concentration_pct: concentrationPctAudit,
      // T35: surface the configured target so the operator audit
      // trail shows what the threshold WAS at decision-time
      // (config drifts between then and now will not retroactively
      // change the record). `null` when the guard was disabled
      // (-1 sentinel from `resolveEntryConfig`).
      volatility_sizing_target_pct: (Number.isFinite(Number(entryCfg.volatility_sizing_target_pct))
        && Number(entryCfg.volatility_sizing_target_pct) > 0
        && Number(entryCfg.volatility_sizing_target_pct) <= 100)
        ? Number(entryCfg.volatility_sizing_target_pct)
        : null,
      // T36: correlation-skip threshold. Null when the guard is
      // disabled (-1 sentinel from `resolveEntryConfig`) so the
      // operator can tell "missing config" from "guard off" from
      // "guard set to N". The gate sits at decision gate 4d in
      // `shouldEnter` — above this number the candidate is
      // rejected as duplicating an existing position's risk
      // factor.
      correlation_skip_threshold: (Number.isFinite(Number(entryCfg.correlation_skip_threshold))
        && Number(entryCfg.correlation_skip_threshold) > 0
        && Number(entryCfg.correlation_skip_threshold) <= 1)
        ? Number(entryCfg.correlation_skip_threshold)
        : null,
      // T37: minimum pool age. Null when the guard is disabled
      // (-1 sentinel from `resolveEntryConfig`). The gate sits at
      // decision gate 4e in `shouldEnter` — above this number of
      // days is the threshold; below it the candidate is rejected
      // for being too freshly-launched.
      min_pool_age_days: (Number.isFinite(Number(entryCfg.min_pool_age_days))
        && Number(entryCfg.min_pool_age_days) > 0
        && Number(entryCfg.min_pool_age_days) <= 365)
        ? Number(entryCfg.min_pool_age_days)
        : null,
    },
  };
}