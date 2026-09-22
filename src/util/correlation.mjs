#!/usr/bin/env node
// src/util/correlation.mjs
//
// T36: pure helpers for "correlation-aware entry" gating.
//
// The trading loop fetches the indexer's 29-point normalized 7-day
// price series (`stats.price_series_7d`) for the candidate token and
// for every open position's token, then asks
// `maxAbsCorrelation(candidate, seriesByTokenId, excludeTokenId)` for
// the worst absolute Pearson correlation. If that value exceeds
// `entry.correlation_skip_threshold`, the entry is rejected with
// `kind: 'correlation_skip'` — diversification rule.
//
// Design rules (also see docs/ARCHITECTURE.md §4.2):
//
//   1. **Pure.** No I/O. No globals. No logging. Every input is a
//      plain JS value; every output is a plain JS value. This makes
//      the helpers trivially unit-testable and safe to call from
//      any layer (entry strategy, ranking, snapshot).
//
//   2. **Tolerant to missing / malformed input.** A `null` series,
//      an array containing `NaN`, an array of length 1, or two
//      series of different lengths all return `null` from
//      `pearsonCorrelation` — the caller decides whether `null`
//      means "skip the guard" (T36's strategy-layer choice) or
//      "reject as suspicious" (NOT T36's choice — a fresh token
//      with no observable history MUST be allowed through).
//
//   3. **No allocation on the hot path beyond the inputs.** Pearson
//      is O(n) over the intersection of two series; for the
//      indexer's 29-point series + ~8 open positions this is a
//      few microseconds per call. No need for streaming /
//      incremental updates.
//
//   4. **Symmetric.** `pearsonCorrelation(a, b) ===
//      pearsonCorrelation(b, a)`. `pearsonCorrelation(a, a) === 1`
//      when there's any variance in `a`; `0` when `a` is constant
//      (degenerate input — caller should treat as `null`).
//
// Origin: original code for TradeBot. ARCHITECTURE.md §3 places
// this module on the pure-util layer below `strategy/entry` and
// `trader/loop`. Pairs with `src/util/price-sanity.mjs` (T28e) —
// both are pure, side-effect-free, single-source-of-truth helpers
// for the entry / exit decision layer.

// ─────────────────────────────────────────────────────────────────────
//  Pearson correlation
// ─────────────────────────────────────────────────────────────────────

/**
 * Coerce a value to a clean numeric series (`number[]` of finite
 * values), or `null` if it can't be made into one.
 *
 * Accepts `null`, `undefined`, arrays of numbers / numeric strings,
 * and rejects anything else (objects, NaN-only arrays, mixed types).
 *
 * @param {unknown} raw
 * @returns {number[]|null}
 */
export function asNumericSeries(raw) {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (let i = 0; i < raw.length; i += 1) {
    const v = raw[i];
    if (typeof v === 'number') {
      if (Number.isFinite(v)) out.push(v);
      else return null; // NaN / Infinity → malformed input
    } else if (typeof v === 'string' && v.length > 0) {
      const n = Number(v);
      if (Number.isFinite(n)) out.push(n);
      else return null;
    } else {
      // bigint, boolean, object, undefined, null inside array
      return null;
    }
  }
  // An empty series is technically well-formed but useless for
  // correlation. We return `null` so callers don't need to special-case
  // the zero-length case.
  if (out.length === 0) return null;
  return out;
}

/**
 * Compute the Pearson product-moment correlation coefficient
 * between two numeric series.
 *
 * Returns `null` for any input the function can't make sense of:
 *   - either argument is not a clean series (use `asNumericSeries`)
 *   - the two series have different lengths
 *   - either series has zero variance (constant signal — correlation
 *     is undefined; the caller should treat this as "not enough
 *     evidence" rather than fabricate a 0)
 *   - the series have < 2 points (a single observation has no
 *     variance and no meaningful correlation)
 *
 * @param {unknown} aRaw
 * @param {unknown} bRaw
 * @returns {number|null} r ∈ [-1, 1] when well-defined; `null` otherwise
 */
export function pearsonCorrelation(aRaw, bRaw) {
  const a = asNumericSeries(aRaw);
  const b = asNumericSeries(bRaw);
  if (a === null || b === null) return null;
  if (a.length !== b.length) return null;
  const n = a.length;
  if (n < 2) return null;

  // Single pass: sums + sum-of-squares. Means derived at the end.
  let sumA = 0;
  let sumB = 0;
  let sumAA = 0;
  let sumBB = 0;
  let sumAB = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i];
    const y = b[i];
    sumA += x;
    sumB += y;
    sumAA += x * x;
    sumBB += y * y;
    sumAB += x * y;
  }
  // Variance (population form): E[X^2] - E[X]^2. Same for Y.
  // Covariance: E[XY] - E[X]E[Y].
  const meanA = sumA / n;
  const meanB = sumB / n;
  const varA = sumAA / n - meanA * meanA;
  const varB = sumBB / n - meanB * meanB;
  const covAB = sumAB / n - meanA * meanB;

  // Degenerate cases: zero variance in either series → no
  // correlation defined. Return `null` so the caller can decide
  // what "constant signal" should mean.
  if (!(varA > 0) || !(varB > 0)) return null;

  const denom = Math.sqrt(varA * varB);
  if (!(denom > 0)) return null;

  // Clamp to [-1, 1] to absorb any floating-point overshoot from
  // rounding noise on near-perfectly correlated series.
  let r = covAB / denom;
  if (r > 1) r = 1;
  else if (r < -1) r = -1;
  return r;
}

/**
 * Compute the worst absolute Pearson correlation between a candidate
 * series and any series in `seriesByTokenId`.
 *
 * "Worst" in the T36 sense = highest `|r|`. A 0.95 positive and a
 * 0.95 negative correlation are equally bad (the bot would be holding
 * a duplicate bet either way). The caller compares `maxAbs` against
 * `entry.correlation_skip_threshold` (positive value in [0, 1]).
 *
 * Returns `{ maxAbs, againstTokenId, r }` where:
 *   - `maxAbs`      — the largest `|r|` observed (or `null` when no
 *                      candidate series, no held series, or every
 *                      series is degenerate — caller treats `null`
 *                      as "guard SKIPPED")
 *   - `againstTokenId` — the token whose series produced `maxAbs`
 *                      (deterministic tie-break: lowest token id);
 *                      `null` when no held series matched.
 *   - `r`           — the signed Pearson r that produced `maxAbs`
 *                      (`null` when no held series matched). Useful
 *                      for the audit blob — "the bot rejected X
 *                      because it was 0.92 correlated with Y".
 *
 * `excludeTokenId` lets the caller skip the candidate's own series
 * (used by tests where the candidate series is also in the held
 * map). When `excludeTokenId` is omitted, no token is excluded.
 *
 * @param {unknown} candidateSeries
 * @param {Map<string, unknown>|Object|null} seriesByTokenId
 * @param {Object} [opts]
 * @param {string} [opts.excludeTokenId]
 * @returns {{ maxAbs: number|null, againstTokenId: string|null, r: number|null }}
 */
export function maxAbsCorrelation(candidateSeries, seriesByTokenId, opts = {}) {
  const cand = asNumericSeries(candidateSeries);
  if (cand === null) return { maxAbs: null, againstTokenId: null, r: null };
  if (!seriesByTokenId || typeof seriesByTokenId !== 'object') {
    return { maxAbs: null, againstTokenId: null, r: null };
  }
  const exclude = (typeof opts.excludeTokenId === 'string' && opts.excludeTokenId.length > 0)
    ? opts.excludeTokenId.toLowerCase()
    : null;

  const entries = [];
  if (typeof seriesByTokenId.get === 'function' && typeof seriesByTokenId.entries === 'function') {
    // Map-like
    for (const [k, v] of seriesByTokenId.entries()) entries.push([k, v]);
  } else {
    // Plain object — filter out inherited / non-own keys.
    for (const k of Object.keys(seriesByTokenId)) entries.push([k, seriesByTokenId[k]]);
  }

  let bestAbs = null;
  let bestToken = null;
  let bestR = null;

  for (const [rawKey, rawVal] of entries) {
    if (typeof rawKey !== 'string' || rawKey.length === 0) continue;
    const key = rawKey.toLowerCase();
    if (exclude !== null && key === exclude) continue;
    const r = pearsonCorrelation(cand, rawVal);
    if (r === null || !Number.isFinite(r)) continue;
    const abs = Math.abs(r);
    if (bestAbs === null
        || abs > bestAbs
        || (abs === bestAbs && bestToken !== null && key < bestToken)) {
      bestAbs = abs;
      bestToken = key;
      bestR = r;
    }
  }

  return { maxAbs: bestAbs, againstTokenId: bestToken, r: bestR };
}
