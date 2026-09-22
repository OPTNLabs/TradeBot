#!/usr/bin/env node
// src/strategy/scoring.mjs
//
// Pool scoring engine. Pure functions — takes a `PoolStats` record
// (the canonical shape from `src/data/fetcher.mjs`) + the scoring
// sub-config (from `config/default.json` → `config.scoring`) and
// produces a normalized score in [0, 1] plus a per-feature breakdown
// for audit / dashboard display.
//
// Design rules (also see docs/ARCHITECTURE.md §5):
//   1. Pure. No I/O. No logger. No process state. The bot can call
//      this thousands of times per tick with no side effects.
//   2. Pulls knobs from a passed-in `scoringConfig` object — never
//      from globals, never from disk. The run-bot loop loads config
//      once and threads it through.
//   3. Treats `null` / `undefined` / non-finite numeric inputs as
//      MISSING EVIDENCE, not as zero. A brand-new token with no
//      volume MUST NOT score 0 on volume — it scores as "we don't
//      know yet" and the weight is redistributed across the features
//      we DO know (so it can still be considered for entry).
//   4. Volume + TVL use log-scaling (with configurable caps) because
//      they're heavy-tailed: a pool with 100x the volume isn't 100x
//      more interesting. Volatility / APY / fee-yield use linear
//      scaling with caps because they're already percentage-like.
//   5. Hard eligibility gates (min_volume_24h_bch, min_tvl_bch) are
//      separate from the score: a pool can have a perfect score on
//      volatility but still be ineligible because it's too illiquid
//      to actually trade. The gate outputs a `reasons[]` list so the
//      dashboard can show "rejected: volume below floor".
//   6. The output `breakdown.missing[]` lists every feature whose
//      value was null. The dashboard renders this as a "data
//      completeness" badge so users know when a token is scoring
//      with reduced evidence.
//
// Origin: original code for TradeBot. ARCHITECTURE.md §3 places
// this module on the pure layer; the trader loop imports it for
// `ranker.mjs` (T09) and `entry.mjs` (T13).

import {
  isValidPoolStats,
  SATS_PER_BCH,
} from '../data/types.mjs';

// ─────────────────────────────────────────────────────────────────────
//  Default config
// ─────────────────────────────────────────────────────────────────────

/**
 * Defaults that mirror `config/default.json` → `scoring` for the
 * small-balance-startup preset. Anything in the actual config file
 * wins; these only apply when the caller passes nothing.
 *
 * Caps below are tuned for a ~$20 wallet that wants to trade
 * ~$2 positions: anything above 10 BCH/day volume or 5 BCH TVL
 * is "plenty" for our purposes, so the log scale saturates.
 *
 * `fee_rate_bps` is the assumed per-trade fee (cauldron's typical
 * 0.3% = 30 bps). The indexer doesn't surface per-pool fee data
 * yet; when post_trade_check.mjs exposes it (T11), this knob can
 * be replaced with a per-pool lookup.
 */
export const DEFAULT_SCORING_CONFIG = Object.freeze({
  weights: Object.freeze({
    // T46b: shifted from a 24h-momentum-dominated blend to a
    // 30d-window blend. The Cauldron DEX is new, 24h volume is
    // bursty, and a token that's quiet today but had a real
    // trade history over the last 30d is still tradeable. Weights
    // sum to 1.0 so the extractFeatures contract (linear blend)
    // stays calibrated.
    volume_24h_bch: 0.10,    // was 0.30 — recency/now-momentum downweighted
    volume_7d_bch: 0.10,     // was 0.05 — mid-window upweighted
    volume_30d_bch: 0.30,    // NEW     — primary volume signal
    volatility_24h_pct: 0.10, // was 0.25 — daily-move weight trimmed
    tvl_bch: 0.10,           // was 0.15
    apy_30d_pct: 0.10,       // was 0.05 — paired with the 30d APY feature
    fee_yield_bps: 0.05,     // unchanged
    // T28c — upward_volatility: how often + how big the token's
    // positive returns are in its 7-day price series. Without this
    // signal, the ranker would happily score FEW-style "almost-always-
    // down" tokens on raw volatility / APY alone and never surface
    // the fundamental problem: the token has no realistic path to
    // take-profit. Tokens with zero upward activity in 7d score 0;
    // tokens with regular upward spikes + magnitude ≥ 5% per move
    // score up to ~0.85.
    upward_volatility: 0.15, // unchanged
  }),
  min_score: 0.35,
  // T46b: 24h min is now a thin recency check (was the primary
  // gate; was too strict — kept the bot out of established pools
  // that just happened to be quiet today).
  min_volume_7d_bch: 0.05,
  // T46b: 30d min is the new primary volume gate (replaces the old
  // 24h-min role). 1.0 BCH of trailing-30d volume is "this pool
  // has had real trade activity recently" — proxy-derived from
  // apy_30d_bp × tvl_sats / fee_rate_bps in extractFeatures.
  min_volume_30d_bch: 1.0,
  min_tvl_bch: 0.25,
  // T28c: tokens with effectively no upward path in the last 7
  // days are INELIGIBLE regardless of how well they score on
  // volume / TVL / APY. 0.05 ≈ "at least one positive move in the
  // series, however small". Set to 0 to disable the gate.
  min_upward_volatility: 0.05,
  // T44: minimum 24h `trade_count` to consider a pool non-stale.
  // The Cauldron indexer's `price_now_sats` is a stale fallback
  // when a token has had zero trades in the current 24h window —
  // QBTC's `trade_count=0` correlates with its 32.7B phantom
  // price; HoneyBadgers' `trade_count=0` was safe only by
  // accident (the on-disk entry_price was recorded correctly).
  // With `min_trade_count_24h: 1`, any token the indexer reports
  // as "no trades in the last 24h" fails the eligibility gate
  // before scoring — same shape as the volume / TVL gates. Set to
  // 0 to disable (NOT recommended — the gate is the only
  // structural defense against phantom-price entries).
  min_trade_count_24h: 1,
  // T75: minimum synthesized `fee_yield_bps` (LP-fees-per-day
  // relative to TVL, in basis points) before a pool is eligible.
  // The synthesized metric is `trade_count × fee_rate_bps /
  // max(tvl_sats, 1)` — at 30 bps fee rate, 1 BCH TVL, and 10
  // 24h trades that's ~3 bps/day. Tokens with fee_yield_bps=0
  // (no recent trades; or near-zero trade activity relative to
  // their TVL) get cleaned up before they can compete for a top-K
  // slot. Note: this is defense-in-depth on top of
  // `min_trade_count_24h` (T44) — that gate catches the
  // trade_count=0 case; this one additionally catches pools that
  // have trades but aren't generating meaningful LP fee income
  // (e.g., a 5-trade/day pool with 50 BCH TVL → fee_yield_bps ≈
  // 0.003 bps/day ≈ zero ROI). Set to 0 to disable.
  min_fee_yield_bps: 10,
  max_pool_age_days: 7,
  top_k_candidates: 3,
  // Log-scale saturation points. Anything at-or-above the cap scores 1.0.
  caps: Object.freeze({
    volume_24h_bch: 10.0,   // 10 BCH/day = "very liquid" for our bot
    volume_7d_bch: 50.0,    // 50 BCH/week
    volume_30d_bch: 200.0,  // 200 BCH/month = "very liquid pool for our bot"
    tvl_bch: 5.0,           // 5 BCH TVL = "comfortable for tiny trades"
  }),
  // Linear caps for percentage-like features.
  linear_caps: Object.freeze({
    volatility_24h_pct: 30.0, // 30% absolute move/day = "very volatile"
    apy_30d_pct: 200.0,       // 200% APY = clearly a high-yield pool
    fee_yield_bps: 500,       // 5%/day fee yield on top of TVL
    volume_30d_bch: 200.0,    // also accepted under linear_caps so callers
                              // that toggle from caps→linear_caps still
                              // see a valid upper bound.
  }),
  fee_rate_bps: 30,
});

/** Coerce an input to a scoring config. Falls back to defaults on bad input. */
export function resolveScoringConfig(input) {
  if (!input || typeof input !== 'object') return cloneDefaultConfig();
  const def = cloneDefaultConfig();
  const out = { ...def };
  if (input.weights && typeof input.weights === 'object') {
    out.weights = { ...def.weights, ...input.weights };
  }
  for (const k of ['min_score', 'min_volume_7d_bch', 'min_tvl_bch',
    'max_pool_age_days', 'top_k_candidates', 'fee_rate_bps',
    'min_upward_volatility',                   // T28c
    'min_volume_30d_bch',                      // T46b
    'min_trade_count_24h',                     // T44
    'min_fee_yield_bps']) {                    // T75
    if (input[k] !== undefined && Number.isFinite(Number(input[k]))) {
      out[k] = Number(input[k]);
    }
  }
  if (input.caps && typeof input.caps === 'object') {
    out.caps = { ...def.caps, ...input.caps };
  }
  if (input.linear_caps && typeof input.linear_caps === 'object') {
    out.linear_caps = { ...def.linear_caps, ...input.linear_caps };
  }
  return out;
}

function cloneDefaultConfig() {
  return {
    weights: { ...DEFAULT_SCORING_CONFIG.weights },
    min_score: DEFAULT_SCORING_CONFIG.min_score,
    min_volume_7d_bch: DEFAULT_SCORING_CONFIG.min_volume_7d_bch,
    min_tvl_bch: DEFAULT_SCORING_CONFIG.min_tvl_bch,
    min_upward_volatility: DEFAULT_SCORING_CONFIG.min_upward_volatility, // T28c
    min_trade_count_24h: DEFAULT_SCORING_CONFIG.min_trade_count_24h, // T44
    min_fee_yield_bps: DEFAULT_SCORING_CONFIG.min_fee_yield_bps,     // T75
    max_pool_age_days: DEFAULT_SCORING_CONFIG.max_pool_age_days,
    top_k_candidates: DEFAULT_SCORING_CONFIG.top_k_candidates,
    caps: { ...DEFAULT_SCORING_CONFIG.caps },
    linear_caps: { ...DEFAULT_SCORING_CONFIG.linear_caps },
    fee_rate_bps: DEFAULT_SCORING_CONFIG.fee_rate_bps,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Feature extractors (pure)
// ─────────────────────────────────────────────────────────────────────

/**
 * Pull a numeric feature out of `stats`, coercing string / number /
 * bigint safely and returning `null` on missing / non-finite.
 *
 * @param {unknown} v
 * @returns {number|null}
 */
function num(v) {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'bigint' ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Convert the canonical PoolStats fields into the FEATURE names the
 * scoring weights reference. Returns a flat `{ feature_name: value }`
 * map with `null` for missing features. Pure.
 *
 * Field mapping (see src/data/types.mjs for the canonical shape):
 *   volume_24h_bch       ← trade_volume_sats / 1e8
 *   volume_7d_bch        ← NOT available in PoolStats (indexer only
 *                          surfaces 24h volume). Returns null when
 *                          missing; the weight is then redistributed
 *                          to the features that ARE present.
 *   volatility_24h_pct   ← |change_24h_bp| / 100. Magnitude only —
 *                          direction doesn't matter for "is this
 *                          pool tradeable". Negative moves are
 *                          equally good for our purposes (we can
 *                          buy on the way down too).
 *   tvl_bch              ← tvl_sats / 1e8
 *   apy_30d_pct          ← apy_30d_bp / 100
 *   fee_yield_bps        ← SYNTHESIZED: trade_count × fee_rate_bps /
 *                          max(tvl_sats, 1). Approximation — the
 *                          indexer doesn't surface per-pool fee rate.
 *                          With cauldron's typical 0.3% fee this gives
 *                          a daily fee yield in bps/day.
 *
 * @param {import('../data/types.mjs').PoolStats} stats
 * @param {Object} [opts]
 * @param {number} [opts.fee_rate_bps=30] Assumed fee rate in bps
 *   for the synthesized `fee_yield_bps`. Defaults to cauldron's
 *   typical 0.3%. Future T11 work can plumb actual fee data from
 *   `post_trade_check.mjs` here.
 * @returns {{
 *   volume_24h_bch: number|null,
 *   volume_7d_bch: number|null,
 *   volume_30d_bch: number|null,
 *   volatility_24h_pct: number|null,
 *   tvl_bch: number|null,
 *   apy_30d_pct: number|null,
 *   fee_yield_bps: number|null,
 *   upward_volatility: number|null,
 *   trade_count: number|null,
 * }}
 */
export function extractFeatures(stats, opts = {}) {
  if (!isValidPoolStats(stats)) {
    return {
      volume_24h_bch: null,
      volume_7d_bch: null,
      volume_30d_bch: null,
      volatility_24h_pct: null,
      tvl_bch: null,
      apy_30d_pct: null,
      fee_yield_bps: null,
      upward_volatility: null,
      trade_count: null,
    };
  }
  const feeRateBps = Number(opts.fee_rate_bps);
  const safeFeeRateBps = Number.isFinite(feeRateBps) && feeRateBps >= 0 ? feeRateBps : 30;

  // T23e: accept ALL known shapes for 24h volume:
  //   - `volume_24h_bch` (older raw indexer + cached top-tokens.json)
  //   - `trade_volume_sats` (normalized via fetcher.getTokenStats)
  //   - `volume_24h_sats` (older raw indexer variant)
  //
  // T70-3 (operator 2026-09-20): removed the `trade_volume`
  // (cumulative all-time) fallback. The Cauldron indexer's
  // `trade_volume` field is cumulative all-time — reading it as
  // 24h volume made every pool look like it had massive 24h
  // activity. After the fix, if the indexer doesn't expose a
  // real 24h field, we leave `volume_24h_bch = null` rather
  // than silently treating cumulative as windowed.
  let volume24hBch = num(stats.volume_24h_bch);
  if (volume24hBch === null) {
    const vol24Sats = num(stats.trade_volume_sats)
      ?? num(stats.volume_24h_sats);
    volume24hBch = vol24Sats !== null ? vol24Sats / SATS_PER_BCH : null;
  }

  // T70-3 (operator 2026-09-20): estimate `volume_7d_bch` from
  // the 7d price series when the indexer doesn't expose it
  // directly (which is the common case). The estimator:
  //
  //   1. Count consecutive distinct price-level transitions in
  //      the 7d series — each transition ≈ 1 trade event.
  //   2. Multiply by `avgTradePctOfTvl` (1% of TVL, same default
  //      as the fee_yield proxy) — the per-trade notional size.
  //   3. Convert to BCH.
  //
  // This is order-of-magnitude, not exact — the indexer samples
  // every ~6h, so each duplicate run of identical values is a
  // "no trade" period and each new value is a "traded here"
  // event. Used as the eligibility-gate signal instead of the
  // broken `volume_24h_bch` so the BCH ecosystem's slow days
  // don't permanently lock every pool out of the ranker.
  //
  // The estimator lives here (not in fetcher.mjs) so the raw
  // `price_series_7d` field stays untouched in the upstream
  // PoolStats shape; downstream consumers see `volume_7d_bch`
  // alongside the raw series.
  // (volume_7d_bch estimation moved below — needs `tvlSats` which
  //  is declared after this block. Computing it inline would TDZ-
  //  throw `ReferenceError: Cannot access 'tvlSats' before
  //  initialization` on every call. See the post-tvlSats block.)

  const tvlSats = num(stats.tvl_sats);
  const tradeCount = num(stats.trade_count);
  const ch24 = num(stats.change_24h_bp);
  const apyBp = num(stats.apy_30d_bp);

  // T70-3 (operator 2026-09-20): estimate `volume_7d_bch` from
  // the 7d price series when the indexer doesn't expose it
  // directly (which is the common case). The estimator:
  //
  //   1. Count consecutive distinct price-level transitions in
  //      the 7d series — each transition ≈ 1 trade event.
  //   2. Multiply by `avgTradePctOfTvl` (1% of TVL, same default
  //      as the fee_yield proxy) — the per-trade notional size.
  //   3. Convert to BCH.
  //
  // This is order-of-magnitude, not exact — the indexer samples
  // every ~6h, so each duplicate run of identical values is a
  // "no trade" period and each new value is a "traded here"
  // event. Used as the eligibility-gate signal instead of the
  // broken `volume_24h_bch` so the BCH ecosystem's slow days
  // don't permanently lock every pool out of the ranker.
  //
  // Lives here (not in fetcher.mjs) so the raw `price_series_7d`
  // field stays untouched in the upstream PoolStats shape;
  // downstream consumers see `volume_7d_bch` alongside the raw
  // series.
  let volume7dBch = num(stats.volume_7d_bch);
  if (volume7dBch === null) {
    const series = Array.isArray(stats.price_series_7d) ? stats.price_series_7d : null;
    if (series && tvlSats !== null && tvlSats > 0) {
      // countPriceTransitions handles length<2 gracefully (returns 0),
      // so we don't need an explicit length check here — the
      // estimator naturally returns 0 volume for a degenerate series.
      const transitions = countPriceTransitions(series);
      const avgTradePctOfTvl = 0.01;
      const tvlBch = tvlSats / SATS_PER_BCH;
      volume7dBch = transitions * avgTradePctOfTvl * tvlBch;
    } else {
      volume7dBch = null;
    }
  }

  let feeYieldBps = null;
  if (tradeCount !== null && tradeCount > 0 && tvlSats !== null && tvlSats > 0 && safeFeeRateBps > 0) {
    // Approximate 24h fees per unit TVL. Cauldron's fee is charged
    // per swap, so fee-revenue ≈ trade_count × fee_rate × avg_trade_size.
    // Without avg_trade_size we use trade_count alone as a *proxy*:
    // each trade contributes fee_rate_bps bps to the pool's TVL
    // (treated as a single unit of TVL). This is intentionally
    // crude — the ranker (T09) will compare pools, so the bias is
    // uniform across them.
    //
    // To get a meaningful scale we multiply by an assumed
    // average-trade-size as a fraction of TVL. A reasonable
    // default for cauldron is 1% of TVL per trade (most retail
    // traders move small amounts). If trade_count × avg_trade_pct
    // saturates TVL, the yield is `fee_rate_bps × trade_count ×
    // avg_trade_pct` bps/day.
    //
    // trade_count === 0 yields null (not 0) — zero trades = no fee
    // revenue, which is structurally missing evidence rather than
    // a meaningful zero.
    const avgTradePctOfTvl = 0.01;
    feeYieldBps = safeFeeRateBps * tradeCount * avgTradePctOfTvl;
    if (!Number.isFinite(feeYieldBps)) feeYieldBps = null;
  }

  // T46b: derive a 30-day volume proxy from the indexer's apy_30d_bp
  // + tvl_sats + fee_rate. The indexer doesn't expose a native
  // "volume_30d_bch" field, but APY is fees-weighted volume, so:
  //
  //   volume_30d_bch ≈ (apy_30d_bp / 10_000) × tvl × (30 / 365) / fee_rate_bps
  //
  // This is order-of-magnitude, not exact — it gives directional
  // signal of "this pool has had real trade activity in the last
  // ~30 days" without demanding an indexer schema change.
  //
  //   NWB: 60 bp APY × 259 BCH TVL × 0.0822 / 30 bps → ~4 260 BCH / 30d
  //   OLA: 19 bp APY × 177 BCH TVL × 0.0822 / 30 bps → ~919 BCH / 30d
  //
  // tvl_sats may arrive as BigInt (live fetcher) or Number
  // (test fixtures); coerce to Number before doing floating-point
  // math so we don't trigger ERR_INVALID_ARG_TYPE on BigInt × Number.
  let volume30dBch = null;
  if (apyBp !== null && tvlSats !== null && tvlSats > 0 && safeFeeRateBps > 0
      && Number.isFinite(apyBp) && apyBp >= 0) {
    const tvlSatsNum = typeof tvlSats === 'bigint' ? Number(tvlSats) : tvlSats;
    if (Number.isFinite(tvlSatsNum) && tvlSatsNum > 0) {
      const dailyYieldBpPerTvl = apyBp / 365;
      const thirtyDayFeeRevenueSats = tvlSatsNum * dailyYieldBpPerTvl * 30 / 10000;
      const thirtyDayVolSats = thirtyDayFeeRevenueSats / (safeFeeRateBps / 10000);
      volume30dBch = threeDayVolSats_toBch(thirtyDayVolSats);
    }
  }

  return {
    volume_24h_bch: volume24hBch,
    // T70-3 (operator 2026-09-20): estimated from `price_series_7d`
    // when the indexer doesn't expose it directly. Pure ranker
    // input — no I/O.
    volume_7d_bch: volume7dBch,
    // T46b: trailing-30d volume estimate (proxy from apy_30d_bp×tvl_sats
    // since the indexer doesn't surface this directly). Null when either
    // signal is missing — the eligibility gate treats null as "missing",
    // and the ranker will redistribute the 30d weight to the rest.
    volume_30d_bch: volume30dBch,
    volatility_24h_pct: ch24 !== null ? Math.abs(ch24) / 100 : null,
    tvl_bch: tvlSats !== null ? tvlSats / SATS_PER_BCH : null,
    apy_30d_pct: apyBp !== null ? apyBp / 100 : null,
    fee_yield_bps: feeYieldBps,
    // T28c: compute upward-volatility from the 7d price series.
    // upwardVolatilityScore returns 0 when the series is missing OR
    // when there are no positive returns — both "no signal" cases.
    // We treat the in-feature value as 0 (not null) so the eligibility
    // gate can read it; the absence of evidence still fails the gate
    // (the operator opted into requiring upward volatility by setting
    // min_upward_volatility > 0).
    upward_volatility: upwardVolatilityScore(stats.price_series_7d),
    // T44: surface the raw `trade_count` so the staleness
    // eligibility gate can read it. We expose it as its own
    // feature rather than letting the gate reach into `stats`
    // directly — keeps `applyEligibilityGates` working off the
    // same `features` envelope every other gate reads. Null when
    // the indexer didn't surface a count for this token.
    trade_count: tradeCount,
  };
}

/**
 * Tiny helper: convert sats to BCH (number). Returns null for
 * non-finite / negative inputs so the caller can tell "missing /
 * garbage" apart from "real zero". Defined here so the volume_30d
 * derivation lives next to its own typing.
 *
 * @param {number} sats
 * @returns {number|null}
 */
function threeDayVolSats_toBch(sats) {
  if (!Number.isFinite(sats) || sats < 0) return null;
  return sats / SATS_PER_BCH;
}

// ─────────────────────────────────────────────────────────────────────
//  Normalizers (pure)
// ─────────────────────────────────────────────────────────────────────

/**
 * Log-scale normalization. Maps `[0, +inf)` to `[0, 1]` with a
 * soft cap at `cap`. A value of `cap` scores 1.0; values above
 * saturate at 1.0 (they're "plenty"). `0` scores 0.0. `null` /
 * negative / non-finite inputs return `null` (so the caller can
 * tell "missing" apart from "zero").
 *
 * Uses `log10(1 + x) / log10(1 + cap)` so the curve is smooth
 * at x=0 and has the right saturation shape. This is the same
 * shape the indexer's discovery score uses, so the bot's
 * normalized score is comparable to the indexer's `score` field
 * for sanity-checking.
 *
 * @param {number|null|undefined} x
 * @param {number} cap
 * @returns {number|null}
 */
/**
 * T70-3 (operator 2026-09-20): count consecutive distinct-price
 * transitions in a price series. Each transition is a "the price
 * moved here" event ≈ 1 trade. Used to estimate `volume_7d_bch`
 * from the 7d price series when the indexer doesn't expose a
 * native 7d-volume field. Pure + null-tolerant.
 *
 * Examples:
 *   [1, 1, 1, 2, 2, 3, 3, 3, 4]  → 3 transitions (1→2, 2→3, 3→4)
 *   [5, 5, 5, 5, 5]            → 0 transitions (no movement)
 *   [1, 2, 3, 4, 5]            → 4 transitions (every step is a move)
 *   [1.0, 1.0 + ε, 1.0 + 2ε]   → 2 transitions (ε and 2ε both register)
 *
 * The estimator isn't exact — it's an order-of-magnitude proxy
 * used as an eligibility-gate signal so a low-volume BCH token
 * doesn't get permanently locked out of the ranker when the
 * Cauldron indexer only exposes cumulative `trade_volume`.
 *
 * @param {Array<number|string>} series
 * @returns {number}
 */
export function countPriceTransitions(series) {
  if (!Array.isArray(series) || series.length < 2) return 0;
  // Walk the series; skip null/undefined entries (defensive against
  // indexer holes — the dashboard sometimes returns `[null, 1.0,
  // 1.0]`). The first non-null entry seeds `last` WITHOUT counting
  // a transition (an indexer hole is a "no trade" period, not a
  // price move). Each subsequent non-null entry that's different
  // from `last` registers one transition.
  let transitions = 0;
  let last = null;
  let seeded = false;
  for (let i = 0; i < series.length; i++) {
    const cur = series[i];
    if (cur == null) continue;
    if (!seeded) {
      last = cur;
      seeded = true;
      continue;
    }
    if (cur !== last) transitions += 1;
    last = cur;
  }
  return transitions;
}

export function normalizeLogScale(x, cap) {
  if (x === null || x === undefined) return null;
  const n = Number(x);
  if (!Number.isFinite(n) || n < 0) return null;
  if (!Number.isFinite(cap) || cap <= 0) return 0;
  if (n >= cap) return 1;
  const num_ = Math.log10(1 + n);
  const den_ = Math.log10(1 + cap);
  return num_ / den_;
}

/**
 * Linear normalization. Maps `[0, cap]` to `[0, 1]`; values above
 * saturate at 1.0. Negative values return `null` (caller bug).
 *
 * @param {number|null|undefined} x
 * @param {number} cap
 * @returns {number|null}
 */
export function normalizeLinear(x, cap) {
  if (x === null || x === undefined) return null;
  const n = Number(x);
  if (!Number.isFinite(n) || n < 0) return null;
  if (!Number.isFinite(cap) || cap <= 0) return 0;
  if (n >= cap) return 1;
  return n / cap;
}

// ─────────────────────────────────────────────────────────────────────
//  T28c — Upward-volatility score (from 7d price series)
// ─────────────────────────────────────────────────────────────────────

/**
 * Pure. Score a token's UPWARD volatility over the last 7 days.
 * Returns a value in `[0, 1]` where:
 *   0   — the token has had zero positive returns in the window
 *          (e.g. Fewness: monotonic decline 19.57 → 1.0, no ups).
 *   ~0.18 — a single small upward spike (e.g. HoneyBadgers: one
 *          +0.88% move across 28 returns).
 *   0.5+ — meaningful upward activity (frequent positive moves
 *          OR at least one 5%+ move).
 *
 * Why this matters: the existing scoring weights `volatility_24h_pct`
 * (the magnitude of the 24h move) and `apy_30d_pct` (the 30-day
 * trend). Neither captures "has the token EVER gone up enough to
 * take profit at +5% in the last 7d?". A token with strong
 * downward pressure + occasional upward spikes (e.g. HoneyBadgers)
 * is a much better trade candidate than a token with steady
 * downward pressure + no spikes (e.g. Fewness). This score is the
 * signal that distinguishes the two.
 *
 * Two components, equal weight:
 *   1. `frequencyScore` = sqrt(positive_pct)  where positive_pct is
 *      the fraction of consecutive-positive-delta returns. sqrt
 *      curve: a token with 1 of 28 positive returns still gets
 *      ~0.19 instead of the linear 0.036. Saturates at 1.0.
 *   2. `magnitudeScore` = min(1.0, max_positive_return × 20).
 *      5% max positive return = 1.0; 0.5% move = 0.10. The "× 20"
 *      factor means a 5%+ upward move saturates the magnitude arm.
 *
 * Returns 0 (not null) for tokens with no upward activity, since
 * "we have data and it's all-down" is structurally different from
 * "we have no data at all".
 *
 * @param {Array<number>|null|undefined} priceSeries   7d normalized
 *   price series (Cauldron indexer returns 29 points, ~3.5h apart).
 * @returns {number}
 */
export function upwardVolatilityScore(priceSeries) {
  if (!Array.isArray(priceSeries) || priceSeries.length < 2) return 0;
  // Compute per-step returns, skipping zeros (division-by-zero protection).
  const returns = [];
  for (let i = 1; i < priceSeries.length; i++) {
    const prev = priceSeries[i - 1];
    if (typeof prev !== 'number' || !Number.isFinite(prev) || prev <= 0) continue;
    const cur = priceSeries[i];
    if (typeof cur !== 'number' || !Number.isFinite(cur)) continue;
    returns.push((cur - prev) / prev);
  }
  if (returns.length === 0) return 0;
  let positiveCount = 0;
  let maxPositive = 0;
  for (const r of returns) {
    if (r > 0) {
      positiveCount += 1;
      if (r > maxPositive) maxPositive = r;
    }
  }
  if (positiveCount === 0) return 0;
  const positiveRatio = positiveCount / returns.length;
  // sqrt curve: rewards even a single positive return; saturates at 1.0.
  const frequencyScore = Math.min(1.0, Math.sqrt(positiveRatio));
  // 5% max-positive return = 1.0; 1% = 0.20; 0.5% = 0.10.
  const magnitudeScore = Math.min(1.0, maxPositive * 20);
  return frequencyScore * 0.5 + magnitudeScore * 0.5;
}

// ─────────────────────────────────────────────────────────────────────
//  Weight normalization (handles missing features)
// ─────────────────────────────────────────────────────────────────────

/**
 * Compute the effective per-feature weights after redistributing
 * the weight of any feature whose input value is `null`. The sum
 * of the returned weights equals `1.0` (the caller's responsibility
 * to ensure the *input* weights sum to 1.0 — we don't enforce that
 * here so callers can use whatever distribution they like).
 *
 * Returns `{ effectiveWeights, presentFeatures, missingFeatures }`.
 * `missingFeatures` is sorted alphabetically for stable snapshot /
 * audit output.
 *
 * Pure.
 *
 * @param {Record<string, number>} weights
 * @param {Record<string, number|null>} featureValues
 * @returns {{
 *   effectiveWeights: Record<string, number>,
 *   presentFeatures: string[],
 *   missingFeatures: string[],
 * }}
 */
export function redistributeWeights(weights, featureValues) {
  if (!weights || typeof weights !== 'object') {
    return { effectiveWeights: {}, presentFeatures: [], missingFeatures: [] };
  }
  const keys = Object.keys(weights);
  const present = [];
  const missing = [];
  for (const k of keys) {
    const v = featureValues[k];
    if (v === null || v === undefined || !Number.isFinite(v)) {
      missing.push(k);
    } else {
      present.push(k);
    }
  }
  const presentSum = present.reduce((acc, k) => acc + (Number(weights[k]) || 0), 0);
  const effective = {};
  if (presentSum > 0) {
    for (const k of present) {
      effective[k] = (Number(weights[k]) || 0) / presentSum;
    }
  }
  // Sort missing for stable output.
  missing.sort();
  return { effectiveWeights: effective, presentFeatures: present, missingFeatures: missing };
}

// ─────────────────────────────────────────────────────────────────────
//  Hard eligibility gates
// ─────────────────────────────────────────────────────────────────────

/**
 * Apply the hard "is this pool even tradeable?" gates BEFORE
 * scoring. A pool that fails any of these is INELIGIBLE regardless
 * of how well it scores on volatility / APY / etc. — there's no
 * point in trading a pool that's too illiquid to absorb a $2 swap.
 *
 * The output `reasons[]` is human-readable and feeds directly into
 * the dashboard's "why was this token rejected?" tooltip.
 *
 * Pure. Does NOT mutate inputs.
 *
 * @param {{
 *   volume_24h_bch: number|null,
 *   tvl_bch: number|null,
 *   upward_volatility: number|null|undefined,
 *   trade_count: number|null,
 * }} features
 * @param {typeof DEFAULT_SCORING_CONFIG} cfg
 * @returns {{ eligible: boolean, reasons: string[] }}
 */
/**
 * T44.1 — global-staleness fallback for the trade_count_24h gate.
 *
 * The per-token T44 gate (idea_seed_indexer_stale_flag / commit 7f72bef)
 * rejects any token with `trade_count < min_trade_count_24h` because a
 * stale `price_now_sats` correlates with phantom-price pathologies (the
 * QBTC case was 100,000,000× off). The gate is per-token, but its
 * TRIGGER can be global: if the indexer is stale as a whole, every
 * top token reports `trade_count: 0` and the gate rejects everything.
 * That's a false-positive indexer issue, not 200 legitimate
 * staleness events.
 *
 * When `globalContext` is supplied, this gate becomes a soft gate:
 *   - If `globalContext.fractionBelowGate` (the fraction of all
 *     candidates whose `trade_count < min_trade_count_24h`) is >=
 *     `globalContext.stalenessThreshold` (default 0.5), the indexer
 *     is treated as globally stale and the trade_count_24h gate is
 *     skipped for ALL tokens in the cohort.
 *   - Otherwise the gate behaves exactly as before (per-token reject).
 *
 * scorePools() computes the fraction once before calling scorePool for
 * each token and passes the result via `opts.globalContext`. Per-token
 * tests (and any external caller) that don't pass globalContext get
 * the original strict behavior.
 *
 * Defensive: only `trade_count_24h:*` reasons are stripped on the
 * global fallback — other gates (volume_24h, tvl_bch, volume_30d) are
 * unaffected because they reflect per-token reality (a token CAN be
 * genuinely small while the indexer is generally fine).
 *
 * @param {Object} features     extracted pool features (volume, TVL, trade_count, etc.)
 * @param {Object} cfg         resolved scoring config (min_trade_count_24h, …)
 * @param {{fractionBelowGate?: number, stalenessThreshold?: number}=} globalContext
 *   optional cohort-level staleness context. When supplied and the
 *   fraction exceeds the threshold, the trade_count_24h gate is
 *   globally disabled.
 * @returns {{eligible: boolean, reasons: string[]}}
 */
export function applyEligibilityGates(features, cfg, globalContext = null) {
  const reasons = [];
  // T70-3 (operator 2026-09-20): switched from `min_volume_24h_bch`
  // to `min_volume_7d_bch`. The 24h volume signal was unreliable
  // (the Cauldron indexer doesn't expose a native 24h-volume
  // field, and `trade_volume` is cumulative all-time — using it
  // for 24h made every pool look like a heavy trader). For a
  // small BCH ecosystem that's still ramping, the 7d window is
  // a fairer activity signal: gives a quiet token a chance to
  // show a few trades over the week. The `min_volume_7d_bch`
  // gate is computed via `countPriceTransitions` (an estimate
  // from `price_series_7d` — see `extractFeatures`).
  if (features.volume_7d_bch === null) {
    reasons.push('volume_7d_bch:missing');
  } else if (features.volume_7d_bch < cfg.min_volume_7d_bch) {
    reasons.push(`volume_7d_bch:${features.volume_7d_bch.toFixed(4)}<${cfg.min_volume_7d_bch}`);
  }
  // T44: staleness gate. The Cauldron indexer's `price_now_sats`
  // is a stale fallback when a token has had zero trades in the
  // current 24h window — QBTC's `trade_count=0` correlates with
  // its 32.7B phantom price, and HoneyBadgers' `trade_count=0`
  // was safe only by accident. Reject any token the indexer
  // reports as "no trades in the last 24h" so we never enter on
  // a phantom reference price. A null `trade_count` ALSO fails
  // — if the indexer didn't even surface a count, we have no
  // evidence the price is fresh.
  //
  // The gate is "missing-or-below" — same shape as volume_24h /
  // tvl_bch, same shape as the T46b volume_30d_bch gate. Set
  // `min_trade_count_24h: 0` to disable (NOT recommended — the
  // gate is the only structural defense against phantom-price
  // entries; the QBTC pathology was 100,000,000× off and the
  // T28d sanity guard doesn't always catch it before entry).
  const minTc = cfg.min_trade_count_24h ?? 0;
  if (minTc > 0) {
    const tc = features.trade_count;
    const belowGate = (tc === null || tc === undefined) || !Number.isFinite(tc) || tc < minTc;
    if (belowGate) {
      // T44.1: global-staleness fallback. When the cohort-level
      // fraction of tokens below this gate exceeds the threshold,
      // treat the indexer as globally stale and skip the per-token
      // reject. See applyEligibilityGates() JSDoc for the rationale.
      const isGloballyStale = globalContext
        && Number.isFinite(globalContext.fractionBelowGate)
        && Number.isFinite(globalContext.stalenessThreshold)
        && globalContext.fractionBelowGate >= globalContext.stalenessThreshold;
      if (!isGloballyStale) {
        // Strict per-token reject (the original T44 behavior).
        if (tc === null || tc === undefined) {
          reasons.push('trade_count_24h:missing');
        } else {
          reasons.push(`trade_count_24h:${tc}<${minTc}`);
        }
      }
      // else: indexer is globally stale; suppress this gate for
      // this token. The other gates (volume_24h, tvl_bch,
      // volume_30d_bch) still apply per-token.
    }
  }
  // T46b: 30-day volume gate (primary). This is the new primary
  // volume gate — a pool needs ≥ min_volume_30d_bch of trailing
  // activity (derived from apy_30d_bp × tvl_sats) before it can
  // be considered at all. A null volume_30d_bch means we don't
  // have evidence either way; treat as missing so missing-field
  // tokens fail the same way they fail any other gate (the ranker
  // will redistribute the volume_30d weight to other features).
  const min30 = cfg.min_volume_30d_bch ?? 0;
  if (min30 > 0) {
    if (features.volume_30d_bch === null) {
      reasons.push('volume_30d_bch:missing');
    } else if (features.volume_30d_bch < min30) {
      reasons.push(`volume_30d_bch:${features.volume_30d_bch.toFixed(4)}<${min30}`);
    }
  }
  if (features.tvl_bch === null) {
    reasons.push('tvl_bch:missing');
  } else if (features.tvl_bch < cfg.min_tvl_bch) {
    reasons.push(`tvl_bch:${features.tvl_bch.toFixed(4)}<${cfg.min_tvl_bch}`);
  }
  // T28c: tokens with no upward path in the 7-day series are
  // INELIGIBLE regardless of how well they score on volume / TVL /
  // APY. Rationale: take-profit at +5% needs the token to have
  // actually gone UP by ≥ 5% at some point. A token that's been
  // monotonically declining for 7d (e.g. Fewness: 19.57 → 1.0)
  // has essentially no realistic path to +5% from current. The
  // gate default of 0.05 captures "at least one small positive
  // return in the window" — HoneyBadgers scores ~0.18, FEW scores 0.
  const minUv = cfg.min_upward_volatility ?? 0;
  if (minUv > 0) {
    const uv = features.upward_volatility;
    if (uv === null || uv === undefined) {
      reasons.push('upward_volatility:missing');
    } else if (uv < minUv) {
      reasons.push(`upward_volatility:${uv.toFixed(3)}<${minUv}`);
    }
  }
  // T75: synthesized LP-fee-yield floor. Drops tokens whose
  // fee_yield_bps is below the configured minimum — pools that
  // aren't generating meaningful LP income relative to their TVL.
  // Same shape as `min_volume_30d_bch` / `min_tvl_bch` / etc.:
  // missing → reject with `fee_yield_bps:missing`; below → reject
  // with the formatted reason string. Set to 0 to disable (the
  // existing `min_trade_count_24h: 1` gate still screens the
  // trade_count=0 case; this gate is defense-in-depth on top of
  // that — it additionally rejects pools whose trade activity is
  // real but tiny relative to TVL).
  const minFy = cfg.min_fee_yield_bps ?? 0;
  if (minFy > 0) {
    const fy = features.fee_yield_bps;
    if (fy === null || fy === undefined || !Number.isFinite(fy)) {
      reasons.push('fee_yield_bps:missing');
    } else if (fy < minFy) {
      reasons.push(`fee_yield_bps:${fy.toFixed(2)}<${minFy}`);
    }
  }
  return { eligible: reasons.length === 0, reasons };
}

// ─────────────────────────────────────────────────────────────────────
//  Main scorer
// ─────────────────────────────────────────────────────────────────────

/**
 * Score one pool. Returns:
 *   {
 *     score:        number in [0, 1]  (0 if ineligible or all-missing)
 *     breakdown: {
 *       raw:               { feature_name: value|null }    (pre-normalization)
 *       normalized:        { feature_name: value|null }    (0..1)
 *       effective_weights: { feature_name: weight  }       (sum to 1, or 0)
 *       contributions:     { feature_name: weight*norm }   (sum to score)
 *       missing:           string[]   (alphabetized)
 *       caps:              { feature_name: { cap, kind: 'log'|'linear' } }
 *     },
 *     eligible:      boolean
 *     reasons:       string[]  (hard-gate rejection reasons; empty if eligible)
 *   }
 *
 * Pure — no I/O, no logger, no globals. The trader loop and the
 * dashboard both call this with no shared state.
 *
 * @param {import('../data/types.mjs').PoolStats} stats
 * @param {Object} [scoringConfig]
 * @param {Object} [opts]
 * @param {number} [opts.fee_rate_bps=30]
 * @returns {{
 *   score: number,
 *   breakdown: Object,
 *   eligible: boolean,
 *   reasons: string[],
 * }}
 */
export function scorePool(stats, scoringConfig = DEFAULT_SCORING_CONFIG, opts = {}) {
  const cfg = resolveScoringConfig(scoringConfig);

  // Caller can override fee_rate_bps per-call via opts, but the
  // config is the default. This honors the "no hard-coded knobs"
  // rule: even fee_rate_bps is read from config when not supplied.
  const feeRateBps = (opts.fee_rate_bps !== undefined && Number.isFinite(Number(opts.fee_rate_bps)))
    ? Number(opts.fee_rate_bps)
    : cfg.fee_rate_bps;

  // 1. Extract raw features.
  const raw = extractFeatures(stats, { fee_rate_bps: feeRateBps });

  // 2. Apply hard eligibility gates (volume + TVL floors).
  // T44.1: thread `opts.globalContext` (computed by scorePools
  // across the whole candidate cohort) into the gate so the
  // trade_count_24h check can be globally suppressed when the
  // indexer is stale as a whole. Per-token callers that don't
  // supply globalContext get the strict original behavior.
  const gate = applyEligibilityGates(raw, cfg, opts.globalContext ?? null);

  // 3. Normalize each feature to [0, 1] using the right curve.
  const normalized = {
    volume_24h_bch: normalizeLogScale(raw.volume_24h_bch, cfg.caps.volume_24h_bch),
    volume_7d_bch: normalizeLogScale(raw.volume_7d_bch, cfg.caps.volume_7d_bch),
    // T46b: trailing-30d volume is now the primary volume signal
    // (weight 0.30). Log-scaled with the same 200 BCH cap as the
    // other volume signals so a single pool with 10× the trailing
    // volume doesn't dwarf the other features. Null when the
    // derivation couldn't find apy_30d_bp + tvl_sats + fee_rate,
    // which redistributeWeights treats as "missing" and the 0.30
    // weight gets split across the present features.
    volume_30d_bch: normalizeLogScale(raw.volume_30d_bch, cfg.caps.volume_30d_bch),
    volatility_24h_pct: normalizeLinear(raw.volatility_24h_pct, cfg.linear_caps.volatility_24h_pct),
    tvl_bch: normalizeLogScale(raw.tvl_bch, cfg.caps.tvl_bch),
    apy_30d_pct: normalizeLinear(raw.apy_30d_pct, cfg.linear_caps.apy_30d_pct),
    fee_yield_bps: normalizeLinear(raw.fee_yield_bps, cfg.linear_caps.fee_yield_bps),
    // T28c — upward_volatility is already in [0, 1] (computed by
    // upwardVolatilityScore); the linear-cap-at-1 normalizer is
    // a safety belt against a misbehaving series that overshoots.
    upward_volatility: normalizeLinear(raw.upward_volatility, 1.0),
  };

  // 4. Redistribute weights across present features.
  const { effectiveWeights, missingFeatures } = redistributeWeights(cfg.weights, normalized);

  // 5. Weighted sum = final score in [0, 1]. (Sum of contributions
  //    over present features equals effectiveWeights[k] ×
  //    normalized[k], which already sums to 1.0 × average norm
  //    across present features. Average is intentional — a pool
  //    missing one feature isn't penalized beyond the gate stage.)
  let score = 0;
  const contributions = {};
  for (const k of Object.keys(effectiveWeights)) {
    const w = effectiveWeights[k];
    const v = normalized[k] ?? 0;
    const c = w * v;
    contributions[k] = c;
    score += c;
  }
  if (!Number.isFinite(score)) score = 0;
  // Clamp into [0, 1] just in case a feature slipped above 1 due
  // to a bad config.
  if (score < 0) score = 0;
  if (score > 1) score = 1;

  // 6. If the hard gates failed, force score to 0. The eligibility
  //    test is independent from the score; we don't want a pool
  //    that's "rejected for thin volume" to still surface a high
  //    numeric score on the dashboard.
  if (!gate.eligible) {
    score = 0;
  }

  const breakdown = {
    raw,
    normalized,
    effective_weights: effectiveWeights,
    contributions,
    missing: missingFeatures,
    caps: {
      volume_24h_bch: { cap: cfg.caps.volume_24h_bch, kind: 'log' },
      volume_7d_bch: { cap: cfg.caps.volume_7d_bch, kind: 'log' },
      // T46b: surface the cap used by the 30d normalizer so the
      // dashboard / ranker UI can show "saturated at 200 BCH/month"
      // when a pool is past the cap.
      volume_30d_bch: { cap: cfg.caps.volume_30d_bch, kind: 'log' },
      volatility_24h_pct: { cap: cfg.linear_caps.volatility_24h_pct, kind: 'linear' },
      tvl_bch: { cap: cfg.caps.tvl_bch, kind: 'log' },
      apy_30d_pct: { cap: cfg.linear_caps.apy_30d_pct, kind: 'linear' },
      fee_yield_bps: { cap: cfg.linear_caps.fee_yield_bps, kind: 'linear' },
      upward_volatility: { cap: 1.0, kind: 'linear' }, // T28c
    },
    min_score: cfg.min_score,
    min_volume_30d_bch: cfg.min_volume_30d_bch ?? 0, // T46b
    min_upward_volatility: cfg.min_upward_volatility, // T28c
    min_trade_count_24h: cfg.min_trade_count_24h ?? 0, // T44
    fee_rate_bps: feeRateBps,
  };

  return {
    score,
    breakdown,
    eligible: gate.eligible,
    reasons: gate.reasons,
  };
}

/**
 * Bulk helper. Maps `scorePool` over an array of PoolStats. Pure.
 * Order is preserved. Items with `!isValidPoolStats(stats)` are
 * passed through as `{ score: 0, breakdown: ..., eligible: false,
 * reasons: ['invalid_stats'] }` so the caller can `.filter` on
 * `eligible` without losing entries.
 *
 * @param {Array<import('../data/types.mjs').PoolStats>} statsList
 * @param {Object} [scoringConfig]
 * @param {Object} [opts]
 * @returns {Array<{
 *   token_id: string,
 *   score: number,
 *   breakdown: Object,
 *   eligible: boolean,
 *   reasons: string[],
 * }>}
 */
export function scorePools(statsList, scoringConfig = DEFAULT_SCORING_CONFIG, opts = {}) {
  if (!Array.isArray(statsList)) return [];
  const cfg = resolveScoringConfig(scoringConfig);

  // T44.1: compute cohort-level staleness context once before
  // scoring any token. If a high fraction of valid candidates
  // have `trade_count < min_trade_count_24h`, that's a global
  // indexer issue, not a per-token risk. Suppress the gate
  // globally for this cohort. Caller can override the threshold
  // via `opts.stalenessThreshold` (default 0.5 = 50%). Falls
  // back to `cfg.staleness_threshold` (set in config/default.json
  // → knob catalog → Settings view).
  const minTc = cfg.min_trade_count_24h ?? 0;
  const stalenessThreshold = Number.isFinite(opts?.stalenessThreshold)
    ? Number(opts.stalenessThreshold)
    : (Number.isFinite(cfg.staleness_threshold) ? Number(cfg.staleness_threshold) : 0.5);
  let globalContext = null;
  if (minTc > 0) {
    let total = 0;
    let below = 0;
    for (const stats of statsList) {
      if (!isValidPoolStats(stats)) continue;
      total++;
      const tc = stats?.trade_count;
      if (tc === null || tc === undefined || !Number.isFinite(tc) || tc < minTc) below++;
    }
    const fractionBelowGate = total > 0 ? below / total : 0;
    globalContext = { fractionBelowGate, stalenessThreshold };
  }

  return statsList.map((stats) => {
    if (!isValidPoolStats(stats)) {
      return {
        token_id: typeof stats?.token_id === 'string' ? stats.token_id : '',
        score: 0,
        breakdown: { raw: {}, normalized: {}, effective_weights: {}, contributions: {}, missing: [], caps: {}, min_score: 0 },
        eligible: false,
        reasons: ['invalid_stats'],
      };
    }
    const r = scorePool(stats, scoringConfig, { ...opts, globalContext });
    return { token_id: stats.token_id, ...r };
  });
}
