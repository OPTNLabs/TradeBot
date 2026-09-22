#!/usr/bin/env node
// src/util/volatility.mjs
//
// Pure helpers for converting a normalized 7-day price series into
// a "daily volatility percent" suitable for sizing TP / SL thresholds.
//
// T38: dynamic take-profit / stop-loss based on 7d realized volatility.
// The bot's fixed 5% TP / 3% SL is appropriate for some tokens but too
// tight for high-vol tokens (TP fires before any real move) or too loose
// for low-vol tokens (TP is unreachable in any reasonable timeframe).
// Per-token dynamic thresholds computed from the 7d step-by-step
// standard deviation set TP at `entry * (1 + tp_mult * vol)` and SL at
// `entry * (1 - sl_mult * vol)`, where `vol` is the daily volatility
// expressed as a fraction.
//
// Data shape: the Cauldron indexer's `price_series_7d` is a normalized
// 29-point series (1.0 = max in window, 0+ = fraction of max). The
// actual fractional returns between adjacent points DO reflect the
// token's volatility *relative to itself* even though the absolute
// scale is normalized — a token that bounced 0% to 100% of its max in
// one step will show a much larger step return than a token that
// drifted gently. We compute the standard deviation of these step
// returns, scale by √(steps_per_day) to express it as a daily
// volatility, and return the result as a fraction (e.g. 0.18 for an
// 18%-daily-vol token).
//
// Design rules (mirrors src/util/correlation.mjs, src/util/price-sanity.mjs):
//
//   1. **Pure.** No I/O. No logger. Same inputs → same outputs.
//   2. **Tolerant.** Bad input → null (caller treats null as "skip the
//      dynamic gate, fall back to the fixed cfg.exit.take_profit_pct /
//      stop_loss_pct"). No throws for normal bad-input cases.
//   3. **Stateless.** No module-level caches, no Date.now() reads.
//   4. **Auditable.** The returned value is the SAME unit that callers
//      feed into TP/SL math (`entry * (1 + pct)`), so the dashboard
//      can show "TP at +2σ = 4.2%" directly.
//
// Origin: shipped in T38 (commit pending). See TODO.md §T38.

/**
 * @typedef {Object} VolatilityResult
 * @property {number|null} daily_vol_pct     daily volatility as a percent (e.g. 5.0 for 5%); null on bad input
 * @property {number|null} step_std           raw standard deviation of step returns (fraction, e.g. 0.05)
 * @property {number}      steps_per_day      steps-per-day used for the √N scaling (29/7 = ~4.14)
 * @property {number}      return_count       number of step returns that contributed to the std
 */

/**
 * Compute the daily volatility (in percent) from a normalized price
 * series. The series is interpreted as a sequence of equal-time-step
 * observations (the indexer's `price_series_7d` is 29 points over 7
 * days → ~4.14 points per day).
 *
 * Algorithm:
 *   1. Filter to finite, positive numbers (the indexer can return
 *      null/NaN/0 for low-activity buckets).
 *   2. Compute step returns r_i = (p[i+1] - p[i]) / p[i] for each
 *      adjacent pair (log-returns aren't appropriate here because
 *      the series is normalized to a max of 1.0, so the "true"
 *      percentage move is captured in the linear return).
 *   3. Compute the population standard deviation of the step returns.
 *      Population std (not sample) is the right choice: the indexer
 *      emits a fixed 29-point window, so every return in the window
 *      IS the population we're trying to characterize — using
 *      sample std would inflate the estimate by Bessel's correction.
 *   4. Scale to a daily volatility by `sqrt(steps_per_day)`. This is
 *      the standard time-aggregation identity: std of sum of N iid
 *      steps grows as √N, so dividing the per-step std by √steps_per_day
 *      would express a single-step vol; we want the *daily* vol, so
 *      multiply by √steps_per_day.
 *   5. Return as a percent (multiply by 100).
 *
 * Returns `{daily_vol_pct: null, ...}` on bad / insufficient input.
 * Caller treats null as "no evidence — fall back to fixed TP/SL".
 *
 * @param {Array<number|string|bigint>|null|undefined} series
 * @param {Object} [opts]
 * @param {number} [opts.pointsPerWindow=29] number of points in the indexer's series (29 for `price_series_7d`)
 * @param {number} [opts.daysInWindow=7]     number of days the series covers (7 for `price_series_7d`)
 * @returns {VolatilityResult}
 */
export function realizedDailyVolatilityPct(series, opts = {}) {
  const pointsPerWindow = (Number.isFinite(Number(opts.pointsPerWindow)) && Number(opts.pointsPerWindow) > 0)
    ? Number(opts.pointsPerWindow)
    : 29;
  const daysInWindow = (Number.isFinite(Number(opts.daysInWindow)) && Number(opts.daysInWindow) > 0)
    ? Number(opts.daysInWindow)
    : 7;
  const stepsPerDay = pointsPerWindow / daysInWindow;
  const meta = {
    daily_vol_pct: null,
    step_std: null,
    steps_per_day: stepsPerDay,
    return_count: 0,
  };
  if (!Array.isArray(series) || series.length < 2) return meta;
  const asNum = (v) => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'bigint') return Number(v);
    if (typeof v === 'string' && v.length > 0) {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };
  // Step returns: r_i = (p[i+1] - p[i]) / p[i]
  /** @type {number[]} */
  const rets = [];
  for (let i = 1; i < series.length; i++) {
    const prev = asNum(series[i - 1]);
    const curr = asNum(series[i]);
    if (prev === null || curr === null) continue;
    if (prev <= 0) continue; // Can't divide by zero or negative — skip.
    rets.push((curr - prev) / prev);
  }
  meta.return_count = rets.length;
  if (rets.length < 1) return meta;
  // Population standard deviation (sqrt of mean of squared deviations
  // from the mean). For n=1 the variance is 0 (single element, no
  // deviation from itself), for n>=2 it's the usual population std.
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  let sumSq = 0;
  for (const r of rets) {
    const d = r - mean;
    sumSq += d * d;
  }
  const variance = sumSq / rets.length;
  const stepStd = Math.sqrt(variance);
  meta.step_std = stepStd;
  // Scale to a daily volatility. sqrt(steps_per_day) = sqrt(29/7) ≈ 2.03.
  // Multiplying by this gives the std of a 1-day walk made of
  // `steps_per_day` independent steps.
  meta.daily_vol_pct = stepStd * Math.sqrt(stepsPerDay) * 100;
  return meta;
}

/**
 * Compute the dynamic take-profit percentage from a daily-vol percent
 * and the configured multiplier. Pure.
 *
 *   dynamic_tp_pct = daily_vol_pct * tp_vol_multiplier
 *
 * Caller-supplied bounds clamp the output to `[floor, ceiling]`. The
 * default bounds are 2% (TP must be at least 2% — never tighter than
 * the existing small-balance 5% / 2) and 80% (TP must never be wider
 * than that — a 100%+ TP is just "never take profit", which is a bug).
 *
 * Returns null on bad input (caller falls back to the fixed
 * `cfg.exit.take_profit_pct`).
 *
 * @param {number|null|undefined} dailyVolPct      output of `realizedDailyVolatilityPct(...).daily_vol_pct`
 * @param {number}                tpVolMultiplier   configured multiplier (default 2.0 — TP at +2σ daily move)
 * @param {Object} [opts]
 * @param {number} [opts.floor=2.0]   minimum TP% (lower clamp)
 * @param {number} [opts.ceiling=80.0] maximum TP% (upper clamp)
 * @returns {number|null}
 */
export function dynamicTakeProfitPct(dailyVolPct, tpVolMultiplier, opts = {}) {
  // T38: explicit null/undefined guard — `Number(null) === 0` would
  // otherwise pass `Number.isFinite` and compute a meaningless 0% TP.
  if (dailyVolPct === null || dailyVolPct === undefined) return null;
  if (!Number.isFinite(Number(dailyVolPct))) return null;
  if (tpVolMultiplier === null || tpVolMultiplier === undefined) return null;
  if (!Number.isFinite(Number(tpVolMultiplier)) || Number(tpVolMultiplier) <= 0) return null;
  // Default floor=2, ceiling=80. A user-provided `floor` or `ceiling`
  // that is missing / non-finite / non-positive / zero falls back to
  // the default. A user-provided `ceiling <= floor` is treated as a
  // broken clamp and FALLS BACK to the default ceiling — silently
  // clamping to a tighter ceiling would be the dangerous default.
  const floorRaw = opts?.floor;
  const floor = (floorRaw !== null && floorRaw !== undefined
    && Number.isFinite(Number(floorRaw)) && Number(floorRaw) > 0)
    ? Number(floorRaw)
    : 2.0;
  const ceilingRaw = opts?.ceiling;
  const ceiling = (ceilingRaw !== null && ceilingRaw !== undefined
    && Number.isFinite(Number(ceilingRaw)) && Number(ceilingRaw) > floor)
    ? Number(ceilingRaw)
    : 80.0;
  const raw = Number(dailyVolPct) * Number(tpVolMultiplier);
  if (!Number.isFinite(raw)) return null;
  if (raw < floor) return floor;
  if (raw > ceiling) return ceiling;
  return raw;
}

/**
 * Compute the dynamic stop-loss percentage from a daily-vol percent
 * and the configured multiplier. Pure.
 *
 *   dynamic_sl_pct = daily_vol_pct * sl_vol_multiplier
 *
 * Same clamping semantics as `dynamicTakeProfitPct`, with tighter
 * defaults (SL floor 1%, SL ceiling 50%) reflecting the asymmetry
 * between "TP fires before any real move" (annoyance) and "SL is so
 * wide it never fires" (silent loss).
 *
 * Returns null on bad input.
 *
 * @param {number|null|undefined} dailyVolPct
 * @param {number}                slVolMultiplier   configured multiplier (default 1.0 — SL at -1σ daily move)
 * @param {Object} [opts]
 * @param {number} [opts.floor=1.0]
 * @param {number} [opts.ceiling=50.0]
 * @returns {number|null}
 */
export function dynamicStopLossPct(dailyVolPct, slVolMultiplier, opts = {}) {
  // T38: explicit null/undefined guard — `Number(null) === 0` would
  // otherwise pass `Number.isFinite` and compute a meaningless 0% SL.
  if (dailyVolPct === null || dailyVolPct === undefined) return null;
  if (!Number.isFinite(Number(dailyVolPct))) return null;
  if (slVolMultiplier === null || slVolMultiplier === undefined) return null;
  if (!Number.isFinite(Number(slVolMultiplier)) || Number(slVolMultiplier) <= 0) return null;
  // Default floor=1, ceiling=50. Same broken-clamp fallback as TP.
  const floorRaw = opts?.floor;
  const floor = (floorRaw !== null && floorRaw !== undefined
    && Number.isFinite(Number(floorRaw)) && Number(floorRaw) > 0)
    ? Number(floorRaw)
    : 1.0;
  const ceilingRaw = opts?.ceiling;
  const ceiling = (ceilingRaw !== null && ceilingRaw !== undefined
    && Number.isFinite(Number(ceilingRaw)) && Number(ceilingRaw) > floor)
    ? Number(ceilingRaw)
    : 50.0;
  const raw = Number(dailyVolPct) * Number(slVolMultiplier);
  if (!Number.isFinite(raw)) return null;
  if (raw < floor) return floor;
  if (raw > ceiling) return ceiling;
  return raw;
}

/**
 * Convenience: compute dynamic TP + SL in one call from a single
 * daily-vol result + a config blob. Returns `{tp: null, sl: null,
 * daily_vol_pct}` when input is missing — caller falls back to the
 * fixed `cfg.exit.take_profit_pct` / `stop_loss_pct`.
 *
 * @param {Array<number|string|bigint>|null|undefined} series
 * @param {Object} cfg   {tp_vol_multiplier, sl_vol_multiplier, ...}
 * @param {Object} [opts] passed through to `realizedDailyVolatilityPct`
 * @returns {{tp: number|null, sl: number|null, daily_vol_pct: number|null, step_std: number|null, return_count: number}}
 */
export function computeDynamicExitPcts(series, cfg, opts = {}) {
  const volResult = realizedDailyVolatilityPct(series, opts);
  const cfgObj = (cfg && typeof cfg === 'object') ? cfg : {};
  const tpMult = Number(cfgObj.tp_vol_multiplier);
  const slMult = Number(cfgObj.sl_vol_multiplier);
  const tp = (volResult.daily_vol_pct !== null && Number.isFinite(tpMult) && tpMult > 0)
    ? dynamicTakeProfitPct(volResult.daily_vol_pct, tpMult, {
      floor: Number(cfgObj.tp_vol_floor_pct),
      ceiling: Number(cfgObj.tp_vol_ceiling_pct),
    })
    : null;
  const sl = (volResult.daily_vol_pct !== null && Number.isFinite(slMult) && slMult > 0)
    ? dynamicStopLossPct(volResult.daily_vol_pct, slMult, {
      floor: Number(cfgObj.sl_vol_floor_pct),
      ceiling: Number(cfgObj.sl_vol_ceiling_pct),
    })
    : null;
  return {
    tp,
    sl,
    daily_vol_pct: volResult.daily_vol_pct,
    step_std: volResult.step_std,
    return_count: volResult.return_count,
  };
}
