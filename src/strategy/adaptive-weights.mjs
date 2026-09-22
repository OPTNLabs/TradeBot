#!/usr/bin/env node
// src/strategy/adaptive-weights.mjs
//
// T56 subset 1 — Adaptive scoring-weights suggestion engine.
//
// Why this exists
// ────────────────
// `src/strategy/scoring.mjs` ships static weights (T46b: 24h/7d/30d
// volume blend + volatility + TVL + APY + fee yield + upward
// volatility). The static weights assume the scoring function /
// edge ratio is stable across market regimes. It usually isn't:
// quiet markets reward the 7d/30d blend, meme rotations reward
// the 24h momentum signal. Adaptive weights tune the scorer to
// recent closed-trade performance.
//
// Subset 1 (this module + the `suggest-adaptive-weights` CLI) is
// the pure-function foundation. The CLI loads `data/history.jsonl`,
// pairs entry+exit events by `position_id`, and emits a suggested
// `scoring.weights` map. The operator decides whether to apply it.
// Subset 2 will wire this into the trader loop hot path, add the
// `scoring.adaptive_weights_*` knobs to `src/util/knob-catalog.mjs`,
// and write every applied weight-set to `data/adaptive-weights.jsonl`
// for audit.
//
// What subset 1 CAN and CANNOT do, honestly
// ─────────────────────────────────────────
//   - The history stream does NOT carry the per-feature
//     `breakdown.normalized` map that `scorePool()` produces —
//     entry events only have the final blended `score`. So we
//     don't have a per-feature attribution of "this trade won
//     because feature X was strong".
//
//   - We DO have per-trade: `entry_score` (the blended final
//     score), realized P&L, hold time, size, slippage, exit kind.
//     That's enough to compute a single "calibration" signal:
//     the correlation between `entry_score` and `realized_pnl_sats`
//     across the closed cohort.
//
//   - When calibration is POSITIVE (high-score trades tend to win
//     and low-score trades tend to lose), the current weights are
//     well-calibrated and we LEAVE them alone (or apply a tiny
//     amplification toward the current shape).
//
//   - When calibration is NEGATIVE (low-score trades win and high-
//     score trades lose), the current weights are MIS-calibrated
//     and we move every weight uniformly TOWARD UNIFORMITY (each
//     weight gets pulled toward 1/N, attenuating the ranker's
//     reliance on noisy feature signals). This is a defensible
//     default: when the ranking signal is anti-correlated with
//     P&L, the safest move is to dilute the signal.
//
//   - When calibration is NEAR ZERO (uncorrelated), we treat that
//     as "not enough evidence" and return the base weights
//     unchanged with `applied:false`.
//
//   - This is intentionally NOT per-feature attribution. Subset 2
//     (or a follow-up tick) can extend `recordEntryHistory` to
//     include `breakdown.contributions` on every entry event and
//     then upgrade the algorithm to a true per-feature shift
//     correlator. The data shape for that upgrade is already
//     documented in the JSDoc below; subset 1 leaves the seam
//     open without pretending to have the data it doesn't.
//
// Design rules
// ────────────
//   1. **Pure core, I/O at the edges.** Everything in this file is
//      pure: input → output, no logger, no globals, no clock. The
//      caller passes `nowMs`, the history lines, the current
//      weights, and the resolved opts.
//
//   2. **Typed envelopes, never throws on bad input.** Every public
//      helper returns `{ok, ...}` or `{ok:false, error}` so the
//      caller can branch without try/catch. The CLI converts the
//      envelope to an exit code; the loop (subset 2) routes the
//      same envelope through the existing alert pipeline.
//
//   3. **Sum-to-1 invariant preserved.** The suggestion engine
//      renormalizes the weights every iteration so the closed-form
//      `effectiveWeights` sum stays at 1.0 even after a wide shift.
//      The ranker (`src/strategy/ranker.mjs`) reads weights that
//      sum to 1.0; violating the invariant silently down-weights
//      every feature by `(new_sum / 1.0)`.
//
//   4. **Bounded shift per feature.** A single market anomaly
//      can flip the calibration signal. Without a per-feature shift
//      cap, the engine would yank the weights away from a
//      well-calibrated baseline on a handful of evidence. We
//      expose `opts.deltaMaxPerFeature` (default 0.05) and
//      `opts.uniformityPullMax` (default 0.20) so each weight
//      moves at most toward uniformity / away from uniformity by
//      `uniformityPullMax × (1 - current_weight)`. Set both to
//      `1.0` to disable the cap.
//
//   5. **Minimum evidence gate.** Empty / sparse data forces the
//      suggestion to a no-op. `opts.minClosedTrades` (default 5)
//      ensures at least 5 closed trades exist in the window
//      before the heuristic activates. Below the threshold the
//      returned suggestion is the input baseWeights (unchanged)
//      with `applied: false` so the caller can short-circuit.
//
//   6. **Defensive parse.** `loadClosedTrades()` skips lines that
//      aren't valid JSON or don't have a `kind` discriminator and
//      captures them in the `errors[]` envelope. Malformed lines
//      never abort the scan.
//
// Origin: T56 — Adaptive scoring weights
// ([USER-APPROVED from feature-ideas idea_adaptive_score_weights_20260917]).
// Depends on: T46b (the 8-feature weight map the engine
// adjusts), T13 (entry history shape), T32 (exit history shape).

// ─── Constants ──────────────────────────────────────────────────────────

/**
 * Default cap on the per-feature pull toward uniformity. When
 * calibration is NEGATIVE, each weight is pulled toward
 * `1 / N_FEATURES` by at most `UNIFORMITY_PULL_MAX × gap`, where
 * `gap = |current_weight - uniform_weight|`. A 0.20 cap means
 * each weight moves at most 20% of the way to uniformity in a
 * single suggestion.
 */
export const DEFAULT_UNIFORMITY_PULL_MAX = 0.20;

/**
 * Default amplification cap (applied when calibration is
 * POSITIVE). The current weight is amplified away from uniform
 * by at most `DEFAULT_AMPLIFICATION_MAX × gap`. A 0.10 cap
 * keeps the current shape but slightly exaggerates it.
 */
export const DEFAULT_AMPLIFICATION_MAX = 0.10;

/**
 * Minimum calibration-correlation magnitude for the engine to
 * produce a non-trivial suggestion. Below this threshold we
 * return `applied:false` (effectively saying "the signal is
 * so weak we should not move on it").
 */
export const DEFAULT_CALIBRATION_FLOOR = 0.10;

/**
 * Minimum number of closed trades required for the engine to
 * activate.
 */
export const DEFAULT_MIN_CLOSED_TRADES = 5;

/**
 * Default rolling window.
 */
export const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Entry/exit kinds we expect on the history stream.
 */
export const TRADE_ENTRY_KIND = 'entry';
export const TRADE_EXIT_KIND = 'exit';

// ─── Pure helpers ───────────────────────────────────────────────────────

/**
 * Coerce an input to a finite number. Returns `null` for null /
 * undefined / NaN / Infinity. String-numerics parse via Number().
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
 * Parse an ISO-8601 timestamp into epoch ms. Accepts string
 * (parsed via `Date.parse`) or a finite number. Returns null
 * for any non-parseable / missing input so the caller can decide
 * whether to drop the line.
 *
 * @param {unknown} ts
 * @returns {number|null}
 */
export function parseTimestampMs(ts) {
  if (ts === null || ts === undefined) return null;
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  if (typeof ts === 'string' && ts.length > 0) {
    const parsed = Date.parse(ts);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Parse one NDJSON history line into a normalized record.
 * Returns a discriminated union:
 *
 *   - `{kind:'entry', event:Object}` — recognized trade entry.
 *   - `{kind:'exit',  event:Object}` — recognized trade exit.
 *   - `{kind:'other', kind_name:string, event:Object}` — valid
 *     JSON but the discriminator isn't a trade (e.g.
 *     `kind:'tick'`, `kind:'alert'`, `kind:'snapshot'`). The
 *     `kind_name` field carries the original discriminator for
 *     the caller's diagnostic counter.
 *   - `{kind:'error', error:string}` — the line did not parse
 *     as JSON / was blank / was a comment. `error` is a short
 *     human-readable reason.
 *
 * Defensive: never throws on bad input.
 *
 * @param {string} line
 * @returns {{kind: 'entry'|'exit'|'other'|'error', event?: Object, kind_name?: string, error?: string}}
 */
export function parseHistoryLine(line) {
  if (typeof line !== 'string' || line.length === 0) {
    return { kind: 'error', error: 'empty_line' };
  }
  const trimmed = line.trim();
  if (trimmed.length === 0) return { kind: 'error', error: 'blank_line' };
  if (trimmed.startsWith('//')) return { kind: 'error', error: 'comment_line' };
  let obj;
  try {
    obj = JSON.parse(trimmed);
  } catch (e) {
    return { kind: 'error', error: 'json_parse_failed' };
  }
  if (!obj || typeof obj !== 'object') return { kind: 'error', error: 'not_object' };
  if (obj.kind === TRADE_ENTRY_KIND) return { kind: TRADE_ENTRY_KIND, event: obj };
  if (obj.kind === TRADE_EXIT_KIND) return { kind: TRADE_EXIT_KIND, event: obj };
  return { kind: 'other', kind_name: (typeof obj.kind === 'string' ? obj.kind : '<unknown>'), event: obj };
}

/**
 * Load closed trades from NDJSON history lines. Pairs each
 * `kind:'exit'` event back to its matching `kind:'entry'` event
 * via `position_id`. Returns the paired trades + an `errors[]`
 * list of lines that didn't parse (the caller can write them
 * to stderr / a log without aborting the scan).
 *
 * Window filter: only pairs where the EXIT timestamp is at or
 * after `sinceMs`. Trims `sinceMs=null` → no lower bound (use the
 * entire history).
 *
 * Pure: no I/O, no clock. Caller passes `historyLines` (already
 * read from disk) and `sinceMs` (resolved against their own clock).
 *
 * @param {string[]} historyLines   NDJSON lines (one record per line).
 * @param {Object} [opts]
 * @param {number} [opts.nowMs]     Reference ms (returned via the envelope so callers can stamp it). Unused for filtering.
 * @param {number} [opts.sinceMs]   Inclusive lower bound on exit `ts`. Null/undefined = no bound.
 * @returns {{
 *   ok: true,
 *   trades: Array<{
 *     position_id: string,
 *     token_id: string|null,
 *     entry_ts_ms: number,
 *     exit_ts_ms: number,
 *     hold_ms: number,
 *     entry_price_sats: number|null,
 *     exit_price_sats: number|null,
 *     size_bch: number|null,
 *     realized_pnl_sats: number|null,
 *     realized_pnl_bch: number|null,
 *     entry_score: number|null,
 *     exit_kind: string|null,
 *     slippage_bps: number|null,
 *     bch_spent_sats: number|null,
 *     bch_received_sats: number|null,
 *     fee_sats: number|null,
 *   }>,
 *   unpaired_exit_count: number,
 *   parse_error_count: number,
 *   skipped_event_count: number,
 *   errors: string[],
 * }}
 */
export function loadClosedTrades(historyLines, opts = {}) {
  const lines = Array.isArray(historyLines) ? historyLines : [];
  const sinceMs = (typeof opts.sinceMs === 'number' && Number.isFinite(opts.sinceMs))
    ? opts.sinceMs : null;

  /** @type {Map<string, Object>} */
  const pendingEntries = new Map();
  /** @type {Array<Object>} */
  const trades = [];
  let unpairedExitCount = 0;
  let parseErrorCount = 0;
  let skippedEventCount = 0;
  const errors = [];

  for (const line of lines) {
    const parsed = parseHistoryLine(line);
    if (parsed.kind === 'error') {
      // Discriminate: blank-line + comment-line are intentional
      // skip markers (the pipeline injects them), not parse
      // failures. Only `json_parse_failed` + `not_object` count
      // as parse errors — those are real corruption that the
      // operator should investigate.
      if (parsed.error === 'json_parse_failed' || parsed.error === 'not_object') {
        parseErrorCount += 1;
        if (errors.length < 50 && typeof line === 'string') {
          errors.push(line.trim().slice(0, 120));
        }
      }
      continue;
    }
    if (parsed.kind === 'other') {
      // Recognized JSON event but not a trade — silently skip.
      skippedEventCount += 1;
      continue;
    }
    if (parsed.kind === TRADE_ENTRY_KIND) {
      const e = parsed.event;
      const pid = (typeof e.position_id === 'string') ? e.position_id : null;
      if (pid) pendingEntries.set(pid, e);
    } else if (parsed.kind === TRADE_EXIT_KIND) {
      const e = parsed.event;
      const pid = (typeof e.position_id === 'string') ? e.position_id : null;
      if (!pid) { unpairedExitCount += 1; continue; }
      const entryEvent = pendingEntries.get(pid);
      if (!entryEvent) { unpairedExitCount += 1; continue; }
      pendingEntries.delete(pid);

      const exitTsMs = parseTimestampMs(e.ts);
      const entryTsMs = parseTimestampMs(entryEvent.ts);
      if (exitTsMs === null || entryTsMs === null) { unpairedExitCount += 1; continue; }
      if (sinceMs !== null && exitTsMs < sinceMs) continue;
      const holdMs = Math.max(0, exitTsMs - entryTsMs);
      const realizedPnlSats = num(e.realized_pnl_sats);
      const realizedPnlBch = num(e.realized_pnl_bch);
      trades.push({
        position_id: pid,
        token_id: (typeof e.token_id === 'string') ? e.token_id
          : (typeof entryEvent.token_id === 'string' ? entryEvent.token_id : null),
        entry_ts_ms: entryTsMs,
        exit_ts_ms: exitTsMs,
        hold_ms: holdMs,
        entry_price_sats: num(entryEvent.price_sats_per_token),
        exit_price_sats: num(e.price_sats_per_token),
        size_bch: num(entryEvent.size_bch),
        realized_pnl_sats: realizedPnlSats,
        realized_pnl_bch: realizedPnlBch,
        entry_score: num(entryEvent.score),
        exit_kind: (typeof e.exit_kind === 'string') ? e.exit_kind : null,
        slippage_bps: num(e.slippage_bps),
        bch_spent_sats: num(entryEvent.bch_spent_sats),
        bch_received_sats: num(e.bch_received_sats),
        fee_sats: num(e.fee_sats),
      });
    }
  }
  return { ok: true, trades, unpaired_exit_count: unpairedExitCount, parse_error_count: parseErrorCount, skipped_event_count: skippedEventCount, errors };
}

/**
 * Summarize a list of closed trades. Returns aggregate stats for
 * the dashboard + the CLI summary line. Pure.
 *
 * Drops trades with `realized_pnl_sats === null` from the
 * win/loss accounting (we don't know the P&L if the exit event
 * didn't carry it — common when an exit fails or a `kind:'exit'`
 * stream entry has missing fields). The returned `count` counts
 * the input; `accounted_count` counts what we used for win/loss.
 *
 * @param {Array<{realized_pnl_sats: number|null, hold_ms: number, entry_score: number|null, size_bch: number|null, exit_kind: string|null}>} trades
 * @returns {{
 *   count: number,
 *   accounted_count: number,
 *   unaccounted_count: number,
 *   wins: number,
 *   losses: number,
 *   break_evens: number,
 *   win_rate: number,
 *   total_realized_pnl_sats: number,
 *   mean_realized_pnl_sats: number,
 *   median_realized_pnl_sats: number,
 *   best_trade_pnl_sats: number,
 *   worst_trade_pnl_sats: number,
 *   mean_hold_ms: number,
 *   mean_entry_score: number|null,
 *   by_exit_kind: Record<string, {count: number, wins: number, losses: number, mean_pnl_sats: number}>,
 * }}
 */
export function summarizeClosedTrades(trades) {
  const list = Array.isArray(trades) ? trades : [];
  const total = list.length;
  let accounted = 0;
  let wins = 0;
  let losses = 0;
  let breakEvens = 0;
  let totalPnl = 0;
  const pnls = [];
  let best = 0;
  let worst = 0;
  let holdAccum = 0;
  let holdCount = 0;
  let scoreAccum = 0;
  let scoreCount = 0;

  /** @type {Record<string, {count: number, wins: number, losses: number, pnl_sum: number}>} */
  const byExitKind = {};

  for (const t of list) {
    const pnl = t && t.realized_pnl_sats;
    const exitKind = (t && typeof t.exit_kind === 'string') ? t.exit_kind : '<unspecified>';
    if (byExitKind[exitKind] === undefined) {
      byExitKind[exitKind] = { count: 0, wins: 0, losses: 0, pnl_sum: 0 };
    }
    byExitKind[exitKind].count += 1;
    if (typeof t?.hold_ms === 'number' && Number.isFinite(t.hold_ms)) {
      holdAccum += t.hold_ms;
      holdCount += 1;
    }
    if (typeof t?.entry_score === 'number' && Number.isFinite(t.entry_score)) {
      scoreAccum += t.entry_score;
      scoreCount += 1;
    }
    if (typeof pnl !== 'number' || !Number.isFinite(pnl)) continue;
    accounted += 1;
    totalPnl += pnl;
    pnls.push(pnl);
    if (pnl > best) best = pnl;
    if (pnl < worst) worst = pnl;
    if (pnl > 0) { wins += 1; byExitKind[exitKind].wins += 1; }
    else if (pnl < 0) { losses += 1; byExitKind[exitKind].losses += 1; }
    else { breakEvens += 1; }
    byExitKind[exitKind].pnl_sum += pnl;
  }
  const sortedPnls = pnls.slice().sort((a, b) => a - b);
  const median = sortedPnls.length === 0
    ? 0
    : (sortedPnls.length % 2 === 1
      ? sortedPnls[(sortedPnls.length - 1) >> 1]
      : 0.5 * (sortedPnls[sortedPnls.length / 2 - 1] + sortedPnls[sortedPnls.length / 2]));
  /** @type {Record<string, {count: number, wins: number, losses: number, mean_pnl_sats: number}>} */
  const byExitKindOut = {};
  for (const k of Object.keys(byExitKind)) {
    const v = byExitKind[k];
    byExitKindOut[k] = {
      count: v.count,
      wins: v.wins,
      losses: v.losses,
      mean_pnl_sats: v.count > 0 ? v.pnl_sum / v.count : 0,
    };
  }
  return {
    count: total,
    accounted_count: accounted,
    unaccounted_count: total - accounted,
    wins,
    losses,
    break_evens: breakEvens,
    win_rate: accounted > 0 ? wins / accounted : 0,
    total_realized_pnl_sats: totalPnl,
    mean_realized_pnl_sats: accounted > 0 ? totalPnl / accounted : 0,
    median_realized_pnl_sats: median,
    best_trade_pnl_sats: best,
    worst_trade_pnl_sats: worst,
    mean_hold_ms: holdCount > 0 ? holdAccum / holdCount : 0,
    mean_entry_score: scoreCount > 0 ? scoreAccum / scoreCount : null,
    by_exit_kind: byExitKindOut,
  };
}

/**
 * Mean of a numeric array; returns null on empty / no-finite
 * inputs. Pure.
 *
 * @param {Array<number>} xs
 * @returns {number|null}
 */
export function mean(xs) {
  if (!Array.isArray(xs) || xs.length === 0) return null;
  let acc = 0;
  let n = 0;
  for (const x of xs) {
    if (typeof x === 'number' && Number.isFinite(x)) { acc += x; n += 1; }
  }
  if (n === 0) return null;
  return acc / n;
}

/**
 * Pearson correlation coefficient between two parallel numeric
 * series. Returns null when fewer than 2 paired observations are
 * finite, when either series has zero variance, or when the
 * inputs aren't parallel arrays of equal length.
 *
 * Pure.
 *
 * @param {Array<number|null|undefined>} xs
 * @param {Array<number|null|undefined>} ys
 * @returns {number|null}
 */
export function pearson(xs, ys) {
  if (!Array.isArray(xs) || !Array.isArray(ys)) return null;
  if (xs.length !== ys.length) return null;
  const pairs = [];
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    const y = ys[i];
    if (typeof x === 'number' && Number.isFinite(x)
        && typeof y === 'number' && Number.isFinite(y)) {
      pairs.push([x, y]);
    }
  }
  if (pairs.length < 2) return null;
  const xs2 = pairs.map((p) => p[0]);
  const ys2 = pairs.map((p) => p[1]);
  const mx = mean(xs2);
  const my = mean(ys2);
  if (mx === null || my === null) return null;
  let num_ = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < pairs.length; i++) {
    const dx = xs2[i] - mx;
    const dy = ys2[i] - my;
    num_ += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  if (!Number.isFinite(denom) || denom === 0) return null;
  const r = num_ / denom;
  if (!Number.isFinite(r)) return null;
  return r;
}

/**
 * Compute the SINGLE calibration signal that drives subset 1's
 * weight adjustment: the Pearson r between `entry_score` and
 * `realized_pnl_sats` across the closed cohort. Positive r means
 * "the ranker is working — high-score trades win"; negative r
 * means "the ranker is hurting — high-score trades lose" and the
 * weights should dilute toward uniformity; near-zero r means
 * "no evidence of either — don't move".
 *
 * Pure. Returns the calibration correlation in [-1, 1] or null
 * when the cohort is too small or has zero variance in either
 * series.
 *
 * @param {Array<{entry_score: number|null, realized_pnl_sats: number|null}>} trades
 * @returns {number|null}
 */
export function computeCalibrationCorrelation(trades) {
  const list = Array.isArray(trades) ? trades : [];
  const xs = [];
  const ys = [];
  for (const t of list) {
    xs.push((typeof t?.entry_score === 'number' && Number.isFinite(t.entry_score)) ? t.entry_score : null);
    ys.push((typeof t?.realized_pnl_sats === 'number' && Number.isFinite(t.realized_pnl_sats)) ? t.realized_pnl_sats : null);
  }
  return pearson(xs, ys);
}

/**
 * Suggested `scoring.weights` map based on the calibration
 * correlation. Pure. Mirrors the convention in
 * `src/strategy/scoring.mjs#resolveScoringConfig`:
 *
 *   1. Validate baseWeights (every value finite + >= 0; sum > 0).
 *      Bad inputs → envelope with `applied:false` and the input
 *      echoed back so the CLI can print "invalid weights" cleanly.
 *
 *   2. Renormalize baseWeights so they sum to 1.0. Without this
 *      the relative pull magnitudes depend on the absolute sum,
 *      which would make the suggestion non-stationary across
 *      config edits. (E.g. scaling every weight by 0.5 must NOT
 *      change the suggested set, only the absolute values.)
 *
 *   3. Compute the calibration correlation. Missing/insufficient
 *      evidence → `applied:false`.
 *
 *   4. Compute the uniform target `1/N`. The per-feature pull is
 *      `sign × pullMax × gap`, where:
 *          - `sign` is `+1` for amplification (calibration > 0),
 *            `-1` for dilution-toward-uniform (calibration < 0);
 *          - `pullMax` is `amplificationMax` when sign > 0,
 *            `uniformityPullMax` when sign < 0;
 *          - `gap` is `|current_weight - target_weight|` —
 *            this is what makes the pull distance-dependent (a
 *            weight already close to 1/N barely moves on
 *            dilution; a weight far from 1/N moves the most).
 *
 *   5. Renormalize again so the suggested weights sum to 1.0.
 *      Renormalization scales every weight uniformly including
 *      any that hit the cap, which keeps the relative ordering
 *      intact while honoring the constraint.
 *
 * Returns `{ok, applied, reason, calibrationCorrelation,
 *  baseWeights, suggested, deltas, summary}`. Never throws.
 *
 * @param {Object} input
 * @param {Record<string, number>} input.baseWeights    Current `scoring.weights`.
 * @param {number|null|undefined} input.calibrationCorrelation   Output of `computeCalibrationCorrelation(trades)`.
 * @param {Object} [opts]
 * @param {number} [opts.uniformityPullMax=0.20]
 * @param {number} [opts.amplificationMax=0.10]
 * @param {number} [opts.calibrationFloor=0.10]
 * @param {number} [opts.minClosedTrades=5]
 * @param {number} [opts.tradeCount=0]    Closed-trade count feeding calibration (used purely for the min-trades gate).
 * @returns {{
 *   ok: true,
 *   applied: boolean,
 *   reason: string|null,
 *   calibrationCorrelation: number|null,
 *   baseWeights: Record<string, number>,
 *   suggested: Record<string, number>,
 *   deltas: Record<string, number>,
 *   summary: {
 *     features_evaluated: number,
 *     uniform_target: number,
 *     direction: 'amplify'|'dilute'|'none',
 *     pull_max_used: number,
 *     sum_base: number,
 *     sum_suggested: number,
 *   },
 * }}
 */
export function suggestAdaptiveWeights(
  { baseWeights, calibrationCorrelation } = {},
  opts = {}
) {
  const uniformityPullMax = (typeof opts?.uniformityPullMax === 'number' && Number.isFinite(opts.uniformityPullMax))
    ? Math.max(0, Math.min(1, Number(opts.uniformityPullMax))) : DEFAULT_UNIFORMITY_PULL_MAX;
  const amplificationMax = (typeof opts?.amplificationMax === 'number' && Number.isFinite(opts.amplificationMax))
    ? Math.max(0, Math.min(1, Number(opts.amplificationMax))) : DEFAULT_AMPLIFICATION_MAX;
  const calibrationFloor = (typeof opts?.calibrationFloor === 'number' && Number.isFinite(opts.calibrationFloor))
    ? Math.max(0, Math.min(1, Number(opts.calibrationFloor))) : DEFAULT_CALIBRATION_FLOOR;
  const minTrades = (typeof opts?.minClosedTrades === 'number' && Number.isFinite(opts.minClosedTrades))
    ? Math.max(1, Math.floor(Number(opts.minClosedTrades))) : DEFAULT_MIN_CLOSED_TRADES;
  const tradeCount = (typeof opts?.tradeCount === 'number' && Number.isFinite(opts.tradeCount))
    ? Math.max(0, Math.floor(Number(opts.tradeCount))) : 0;

  const base = (baseWeights && typeof baseWeights === 'object') ? { ...baseWeights } : {};
  const baseKeys = Object.keys(base);
  const emptySummary = () => ({
    features_evaluated: 0, uniform_target: 0, direction: /** @type {'amplify'|'dilute'|'none'} */ ('none'),
    pull_max_used: 0, sum_base: 0, sum_suggested: 0,
  });
  if (baseKeys.length === 0) {
    return {
      ok: true, applied: false, reason: 'empty_base_weights',
      calibrationCorrelation: (typeof calibrationCorrelation === 'number' && Number.isFinite(calibrationCorrelation))
        ? calibrationCorrelation : null,
      baseWeights: {}, suggested: {}, deltas: {}, summary: emptySummary(),
    };
  }

  // Validate every base weight, normalize non-finite / negative to 0.
  let sumBase = 0;
  let hasAnyPositive = false;
  for (const k of baseKeys) {
    const v = Number(base[k]);
    if (!Number.isFinite(v) || v < 0) { base[k] = 0; }
    else { base[k] = v; sumBase += base[k]; if (base[k] > 0) hasAnyPositive = true; }
  }
  if (!hasAnyPositive) {
    return {
      ok: true, applied: false, reason: 'all_zero_base_weights',
      calibrationCorrelation: (typeof calibrationCorrelation === 'number' && Number.isFinite(calibrationCorrelation))
        ? calibrationCorrelation : null,
      baseWeights: { ...base }, suggested: { ...base },
      deltas: Object.fromEntries(baseKeys.map((k) => [k, 0])),
      summary: { features_evaluated: baseKeys.length, uniform_target: 1 / baseKeys.length,
        direction: 'none', pull_max_used: 0, sum_base: 0, sum_suggested: 0 },
    };
  }
  const baseNorm = {};
  for (const k of baseKeys) { baseNorm[k] = base[k] / sumBase; }
  const uniformTarget = 1 / baseKeys.length;

  // Min-trades gate.
  if (tradeCount < minTrades) {
    return {
      ok: true, applied: false, reason: 'below_min_closed_trades',
      calibrationCorrelation: (typeof calibrationCorrelation === 'number' && Number.isFinite(calibrationCorrelation))
        ? calibrationCorrelation : null,
      baseWeights: baseNorm, suggested: { ...baseNorm },
      deltas: Object.fromEntries(baseKeys.map((k) => [k, 0])),
      summary: { features_evaluated: baseKeys.length, uniform_target: uniformTarget,
        direction: 'none', pull_max_used: 0, sum_base: 1.0, sum_suggested: 1.0 },
    };
  }

  // Calibration gate.
  const corr = (typeof calibrationCorrelation === 'number' && Number.isFinite(calibrationCorrelation))
    ? calibrationCorrelation : null;
  if (corr === null) {
    return {
      ok: true, applied: false, reason: 'no_calibration_evidence',
      calibrationCorrelation: null,
      baseWeights: baseNorm, suggested: { ...baseNorm },
      deltas: Object.fromEntries(baseKeys.map((k) => [k, 0])),
      summary: { features_evaluated: baseKeys.length, uniform_target: uniformTarget,
        direction: 'none', pull_max_used: 0, sum_base: 1.0, sum_suggested: 1.0 },
    };
  }
  const absCorr = Math.abs(corr);
  if (absCorr < calibrationFloor) {
    return {
      ok: true, applied: false, reason: 'calibration_below_floor',
      calibrationCorrelation: corr,
      baseWeights: baseNorm, suggested: { ...baseNorm },
      deltas: Object.fromEntries(baseKeys.map((k) => [k, 0])),
      summary: { features_evaluated: baseKeys.length, uniform_target: uniformTarget,
        direction: 'none', pull_max_used: 0, sum_base: 1.0, sum_suggested: 1.0 },
    };
  }

  // Apply the per-feature pull.
  const direction = corr > 0 ? 'amplify' : 'dilute';
  const pullMax = corr > 0 ? amplificationMax : uniformityPullMax;
  const raw = {};
  const deltas = {};
  for (const k of baseKeys) {
    const gap = baseNorm[k] - uniformTarget;
    // Sign of gap × sign of correction = direction of motion. When
    // amplifying a positive gap, we want the gap to WIDEN (move AWAY
    // from uniform); when diluting, we want it to NARROW (move
    // TOWARD uniform).
    const signedGap = corr > 0 ? gap : -gap;
    let delta = signedGap * pullMax;
    deltas[k] = delta;
    raw[k] = Math.max(0, baseNorm[k] + delta);
  }
  // Renormalize so the result still sums to 1.0.
  const sumRaw = Object.values(raw).reduce((acc, v) => acc + v, 0);
  const suggested = {};
  if (sumRaw > 0) {
    for (const k of Object.keys(raw)) {
      suggested[k] = raw[k] / sumRaw;
    }
  } else {
    for (const k of baseKeys) suggested[k] = baseNorm[k];
  }
  // Recompute the deltas as suggested - baseNorm so the returned
  // table reflects the post-renormalization shift exactly.
  const outDeltas = {};
  for (const k of baseKeys) {
    outDeltas[k] = suggested[k] - baseNorm[k];
  }
  return {
    ok: true, applied: true, reason: null,
    calibrationCorrelation: corr,
    baseWeights: baseNorm, suggested, deltas: outDeltas,
    summary: {
      features_evaluated: baseKeys.length,
      uniform_target: uniformTarget,
      direction,
      pull_max_used: pullMax,
      sum_base: 1.0,
      sum_suggested: Object.values(suggested).reduce((acc, v) => acc + v, 0),
    },
  };
}

/**
 * Format a base-vs-suggested weights diff for the CLI / dashboard.
 * Returns a plain string (not ANSI color) so the output is grep-safe
 * and pipe-safe. Per-feature lines: `key: base -> suggested (Δ delta)`.
 *
 * Pure. Empty baseWeights → returns a header-only string.
 *
 * @param {Object} input
 * @param {Record<string, number>} input.base
 * @param {Record<string, number>} input.suggested
 * @param {Record<string, number>} input.deltas
 * @returns {string}
 */
export function formatSuggestionDiff({ base, suggested, deltas } = {}) {
  const b = (base && typeof base === 'object') ? base : {};
  const s = (suggested && typeof suggested === 'object') ? suggested : {};
  const d = (deltas && typeof deltas === 'object') ? deltas : {};
  const keys = Object.keys(b);
  if (keys.length === 0) return 'feature: base -> suggested (Δ delta)\n  (no features — nothing to suggest yet)';
  const keyLen = Math.max(...keys.map((k) => k.length), 11);
  const lines = [];
  lines.push(`${'feature'.padEnd(keyLen)}  base       suggested  delta   `);
  lines.push(`${'-'.repeat(keyLen)}  ---------- ---------- -------- `);
  for (const k of keys) {
    const baseV = Number(b[k] ?? 0);
    const suggV = Number(s[k] ?? 0);
    const delta = Number(d[k] ?? 0);
    lines.push(`${k.padEnd(keyLen)}  ${baseV.toFixed(4).padStart(8)}   ${suggV.toFixed(4).padStart(8)}   ${(delta >= 0 ? '+' : '') + delta.toFixed(4)}`);
  }
  return lines.join('\n');
}

// ─── T56-2 — pure apply helper + audit envelope builder ──────────────────

/**
 * T56-2 — Apply a `suggestAdaptiveWeights()` result to a
 * `config/user.json`-shaped object in-memory and return the next
 * shape. Pure: no I/O, no clock, no mutations on the input.
 *
 * Contract:
 *   - The result of `suggestAdaptiveWeights()` is passed in via
 *     `{ suggestion }` — the same shape returned by the engine
 *     (`{ ok, applied, reason, suggested, ... }`).
 *   - The `userJson` object is shallow-copied; the nested
 *     `scoring` and `scoring.weights` blocks are each rebuilt as
 *     a fresh object so callers can safely mutate / serialize the
 *     returned shape without disturbing the input.
 *   - When `suggestion.applied === true` (engine wrote a real
 *     weight shift), the result's `scoring.weights` is replaced
 *     with `suggestion.suggested` and `userJson.adaptive_weights_last_applied`
 *     is stamped with `{ts_iso, ts_ms, applied, reason, calibration_correlation,
 *     closed_trade_count, window_days}` so the operator can audit
 *     the timeline by grepping the file.
 *   - When `applied === false` (engine no-op'd: below_min_closed_trades,
 *     calibration_below_floor, no_calibration_evidence, empty_base_weights,
 *     all_zero_base_weights), the `scoring.weights` block is left
 *     untouched and `userJson.adaptive_weights_last_applied` is
 *     stamped with `{applied:false, reason, ...}`. The stamp lets
 *     the operator see "the engine considered this tick and
 *     decided not to shift" without reading the logs.
 *   - Every other key of `userJson` (including the WIF + mnemonic
 *     + `dashboard.api_token` + `wallet.last_balance_check`) is
 *     preserved verbatim. This is the same deep-merge pattern
 *     `scripts/suggest-adaptive-weights.mjs` uses on disk — the
 *     helper here is the pure half so the loop's write path can
 *     stay a thin wrapper around `atomicWriteJson`.
 *   - When `nowMs` is omitted / non-finite the stamp uses
 *     `Date.now()` (production path); tests pass a fixed ms so
 *     the audit envelope is deterministic.
 *
 * Returns: `{ next: Object, mutated: boolean, reason: string|null,
 *             suggestedWeights: Object }`. `mutated` is true iff
 *     the engine applied a shift — the loop's NDJSON writer uses
 *     it to decide whether to append a `loop.adaptive_weights.applied`
 *     audit row. A no-op still returns `{ mutated:false, reason:<why> }`
 *     so the loop can stamp `loop.adaptive_weights.skipped` for
 *     visibility.
 *
 * Defensive:
 *   - `userJson` MUST be a non-null object; throws otherwise.
 *   - `suggestion` MUST be the shape returned by `suggestAdaptiveWeights`
 *     (it MUST have `.applied` + `.suggested`); on missing fields
 *     the helper returns `{ next: userJson, mutated:false,
 *     reason:'malformed_suggestion', suggestedWeights: {} }` so a
 *     buggy engine call cannot crash the trader loop.
 *   - When the engine reports `applied:true` but `suggested` is
 *     empty / not-an-object, the helper downgrades to a no-op
 *     (`mutated:false, reason:'empty_suggested_weights'`) — a
 *     caller bug rather than a real apply.
 *
 * @param {Object} args
 * @param {Object} args.userJson      the parsed `config/user.json` (or `{}`).
 * @param {Object} args.suggestion    output of `suggestAdaptiveWeights(...)`.
 * @param {number} [args.nowMs]       override clock (default `Date.now()`).
 * @param {number} [args.windowDays]  included in the stamp (default 7).
 * @returns {{ next: Object, mutated: boolean, reason: string|null, suggestedWeights: Object }}
 */
export function applyAdaptiveWeightsToUserJson({ userJson, suggestion, nowMs, windowDays } = {}) {
  if (!userJson || typeof userJson !== 'object' || Array.isArray(userJson)) {
    throw new TypeError('applyAdaptiveWeightsToUserJson: userJson must be a non-null object');
  }
  if (!suggestion || typeof suggestion !== 'object') {
    return {
      next: { ...userJson },
      mutated: false,
      reason: 'malformed_suggestion',
      suggestedWeights: {},
    };
  }
  const tsMs = (typeof nowMs === 'number' && Number.isFinite(nowMs)) ? nowMs : Date.now();
  const win = (typeof windowDays === 'number' && Number.isFinite(windowDays))
    ? windowDays : 7;

  // Copy outer so callers can mutate next without touching the input.
  const next = { ...userJson };
  const scoring = (next.scoring && typeof next.scoring === 'object' && !Array.isArray(next.scoring))
    ? { ...next.scoring } : {};

  const applied = suggestion.applied === true;
  const reason = (typeof suggestion.reason === 'string') ? suggestion.reason : null;
  let suggestedWeights = {};
  if (applied) {
    const s = suggestion.suggested;
    if (s && typeof s === 'object' && !Array.isArray(s) && Object.keys(s).length > 0) {
      suggestedWeights = { ...s };
      scoring.weights = { ...suggestedWeights };
    } else {
      // Defensive: applied:true with no real weights → downgrade to no-op.
      next.adaptive_weights_last_applied = {
        ts_iso: new Date(tsMs).toISOString(),
        ts_ms: tsMs,
        applied: false,
        reason: 'empty_suggested_weights',
        calibration_correlation: (typeof suggestion.calibrationCorrelation === 'number')
          ? suggestion.calibrationCorrelation : null,
        closed_trade_count: (typeof suggestion.summary?.features_evaluated === 'number')
          ? null : null,
        window_days: win,
      };
      next.scoring = scoring;
      return { next, mutated: false, reason: 'empty_suggested_weights', suggestedWeights: {} };
    }
  }

  next.scoring = scoring;
  next.adaptive_weights_last_applied = {
    ts_iso: new Date(tsMs).toISOString(),
    ts_ms: tsMs,
    applied,
    reason,
    calibration_correlation: (typeof suggestion.calibrationCorrelation === 'number')
      ? suggestion.calibrationCorrelation : null,
    closed_trade_count: (typeof suggestion.summary?.features_evaluated === 'number')
      ? suggestion.summary.features_evaluated : null,
    window_days: win,
  };
  return { next, mutated: applied, reason, suggestedWeights };
}

/**
 * T56-2 — Build the NDJSON audit record the trader loop appends to
 * `data/adaptive-weights.jsonl` after a successful apply. Pure:
 * no I/O, no clock (caller passes `nowMs` + `nowIso`), no bigint
 * coercion. The shape mirrors the audit fields the operator asked
 * for in the TODO entry: `{ts, calibration_correlation,
 * base_weights, suggested_weights, deltas, direction,
 * trade_count, window_days}` — plus a few extension fields so
 * the audit row can be diff'd against the loop's per-tick
 * history appends (`knobs_changed`, `user_json_path`).
 *
 * Defensive:
 *   - Missing fields fall through to `null` so a corrupt engine
 *     result can't crash the loop's NDJSON writer.
 *   - Booleans / numbers are coerced to primitives; objects are
 *     left as-is (the loop's history appender already wraps the
 *     line in `JSON.stringify` so a deep object is fine).
 *
 * @param {Object} args
 * @param {Object} args.suggestion    output of `suggestAdaptiveWeights(...)`.
 * @param {Object} [args.userJson]    the (already-mutated) `user.json` shape, for cross-ref.
 * @param {number} args.nowMs         loop's clock (epoch ms).
 * @param {string} [args.userJsonPath]  path the loop writes to (for audit cross-ref).
 * @returns {Object}  the audit record; loop calls `JSON.stringify` on it.
 */
export function buildAdaptiveWeightsAuditRecord({ suggestion, userJson, nowMs, userJsonPath } = {}) {
  const now = (typeof nowMs === 'number' && Number.isFinite(nowMs)) ? nowMs : Date.now();
  const isoNow = new Date(now).toISOString();
  const s = (suggestion && typeof suggestion === 'object') ? suggestion : {};
  const summary = (s.summary && typeof s.summary === 'object') ? s.summary : {};
  const weights = (userJson && userJson.scoring && userJson.scoring.weights
    && typeof userJson.scoring.weights === 'object')
    ? userJson.scoring.weights : null;
  return {
    kind: 'adaptive_weights_apply',
    ts: isoNow,
    ts_ms: now,
    calibration_correlation: (typeof s.calibrationCorrelation === 'number')
      ? s.calibrationCorrelation : null,
    base_weights: (s.baseWeights && typeof s.baseWeights === 'object') ? s.baseWeights : null,
    suggested_weights: (s.suggested && typeof s.suggested === 'object') ? s.suggested : null,
    deltas: (s.deltas && typeof s.deltas === 'object') ? s.deltas : null,
    direction: (typeof summary.direction === 'string') ? summary.direction : null,
    pull_max_used: (typeof summary.pull_max_used === 'number') ? summary.pull_max_used : null,
    features_evaluated: (typeof summary.features_evaluated === 'number')
      ? summary.features_evaluated : null,
    uniform_target: (typeof summary.uniform_target === 'number') ? summary.uniform_target : null,
    sum_base: (typeof summary.sum_base === 'number') ? summary.sum_base : null,
    sum_suggested: (typeof summary.sum_suggested === 'number') ? summary.sum_suggested : null,
    trade_count: (typeof summary.features_evaluated === 'number')
      ? summary.features_evaluated : null,
    window_days: (userJson && userJson.adaptive_weights_last_applied
      && typeof userJson.adaptive_weights_last_applied.window_days === 'number')
      ? userJson.adaptive_weights_last_applied.window_days : null,
    applied: s.applied === true,
    reason: (typeof s.reason === 'string') ? s.reason : null,
    weights_after: weights,
    user_json_path: (typeof userJsonPath === 'string') ? userJsonPath : null,
  };
}

/**
 * T56-2 — Pure helper that orchestrates `loadClosedTrades +
 * summarizeClosedTrades + computeCalibrationCorrelation +
 * suggestAdaptiveWeights` so the loop's per-tick call site can
 * stay a one-liner. All four inputs come from injected seams
 * (`loadHistory`, `nowMs`, `baseWeights`, `opts`) so the loop's
 * test suite can exercise every code path without hitting the
 * real `data/history.jsonl` or the real clock.
 *
 * Returns the same `{ ok, applied, reason, baseWeights,
 * suggested, deltas, summary, calibrationCorrelation,
 * closed_trade_count, ... }` envelope the suggest CLI emits —
 * the loop just decides whether to call `applyAdaptiveWeightsToUserJson`
 * based on `applied`.
 *
 * Defensive:
 *   - `loadHistory` MUST be a function; throws otherwise (caller
 *     bug, never the loop's hot path).
 *   - `loadHistory()` throwing is caught and converted to
 *     `{ ok:false, error:'history_load_failed', error_message }`
 *     so the loop can log + skip without crashing the tick.
 *   - `baseWeights` MUST be a non-null object; on missing the
 *     helper returns `{ ok:true, applied:false, reason:'empty_base_weights',
 *     ... }` (matches the engine's own behavior).
 *   - `opts.windowDays`, `opts.minClosedTrades`, `opts.maxDelta`,
 *     `opts.calibrationFloor` are read defensively; bad values
 *     fall through to the engine's own defaults.
 *
 * @param {Object} args
 * @param {Function} args.loadHistory  `async () => string[]` — returns NDJSON lines.
 * @param {Object} args.baseWeights    the static `scoring.weights` map.
 * @param {number} args.nowMs          loop's clock (epoch ms).
 * @param {Object} [args.opts]
 * @param {number} [args.opts.windowDays]          default 7
 * @param {number} [args.opts.minClosedTrades]     default 5
 * @param {number} [args.opts.maxDelta]            default 0.05
 * @param {number} [args.opts.calibrationFloor]    default 0.10
 * @returns {Promise<Object>}   envelope shape.
 */
export async function runAdaptiveWeightsSuggestion({ loadHistory, baseWeights, nowMs, opts } = {}) {
  if (typeof loadHistory !== 'function') {
    throw new TypeError('runAdaptiveWeightsSuggestion: loadHistory must be a function');
  }
  if (!baseWeights || typeof baseWeights !== 'object' || Array.isArray(baseWeights)) {
    throw new TypeError('runAdaptiveWeightsSuggestion: baseWeights must be a non-null object');
  }
  const winDays = (opts && Number.isFinite(Number(opts.windowDays))) ? Number(opts.windowDays) : 7;
  const winMs = winDays * 24 * 60 * 60 * 1000;
  const minTrades = (opts && Number.isFinite(Number(opts.minClosedTrades)))
    ? Number(opts.minClosedTrades) : DEFAULT_MIN_CLOSED_TRADES;
  const maxDelta = (opts && Number.isFinite(Number(opts.maxDelta)))
    ? Number(opts.maxDelta) : null;
  const calibFloor = (opts && Number.isFinite(Number(opts.calibrationFloor)))
    ? Number(opts.calibrationFloor) : DEFAULT_CALIBRATION_FLOOR;
  const sinceMs = (typeof nowMs === 'number' && Number.isFinite(nowMs))
    ? nowMs - winMs : Date.now() - winMs;

  let lines;
  try {
    const out = await loadHistory();
    lines = Array.isArray(out) ? out : [];
  } catch (e) {
    return {
      ok: false,
      error: 'history_load_failed',
      error_message: (e && typeof e === 'object' && /** @type {any} */ (e).message)
        ? /** @type {any} */ (e).message : String(e),
      window_days: winDays,
      min_closed_trades: minTrades,
      max_delta: maxDelta,
      calibration_floor: calibFloor,
    };
  }

  const loadResult = loadClosedTrades(lines, { sinceMs });
  const summary = summarizeClosedTrades(loadResult.trades);
  const calibration = computeCalibrationCorrelation(loadResult.trades);
  const suggestion = suggestAdaptiveWeights(
    { baseWeights, calibrationCorrelation: calibration },
    {
      uniformityPullMax: maxDelta ?? DEFAULT_UNIFORMITY_PULL_MAX,
      amplificationMax: maxDelta ?? DEFAULT_AMPLIFICATION_MAX,
      calibrationFloor: calibFloor,
      minClosedTrades: minTrades,
      tradeCount: loadResult.trades.length,
    }
  );
  return {
    ok: true,
    now_ms: (typeof nowMs === 'number' && Number.isFinite(nowMs)) ? nowMs : Date.now(),
    window_days: winDays,
    window_ms: winMs,
    since_ms: sinceMs,
    closed_trade_count: loadResult.trades.length,
    unpaired_exit_count: loadResult.unpaired_exit_count,
    parse_error_count: loadResult.errors.length,
    summary: {
      accounted_count: summary.accounted_count,
      wins: summary.wins,
      losses: summary.losses,
      win_rate: summary.win_rate,
      total_realized_pnl_sats: summary.total_realized_pnl_sats,
      mean_hold_ms: summary.mean_hold_ms,
      mean_entry_score: summary.mean_entry_score,
    },
    calibration_correlation: calibration,
    suggestion,
  };
}

// ─── Internals (for tests) ──────────────────────────────────────────────

/**
 * Internal exports so the test file can reach the private helpers
 * without re-implementing the parse logic.
 */
export const _internals = Object.freeze({
  parseTimestampMs,
  parseHistoryLine,
  computeCalibrationCorrelation,
  formatSuggestionDiff,
  mean,
  pearson,
  num,
  applyAdaptiveWeightsToUserJson,
  buildAdaptiveWeightsAuditRecord,
  runAdaptiveWeightsSuggestion,
});
