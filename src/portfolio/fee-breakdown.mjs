#!/usr/bin/env node
// src/portfolio/fee-breakdown.mjs
//
// Per-token fee-breakdown aggregator for TradeBot.
//
// One missing affordance the operator hit on 2026-09-18 when
// the per-token trade log (T63) started surfacing realized P&L:
// "OK, the bot made +0.0001 BCH on FEW. But where did the
// 0.0005 BCH that left the wallet go?" — fee composition was
// invisible. The realized P&L is net of fees but the operator
// can't see which kind of fee (LP / tx / slippage) ate the
// capital, so they can't answer "is my slippage cost eating
// my LP fees?" without grepping raw swap envelopes.
//
// T71 closes that gap with a per-token fee breakdown split
// into three components:
//
//   1. **LP fees** — the constant AMM fee per trade
//      (`fee_rate_bps` × trade size). Sourced from
//      `cfg.scoring.fee_rate_bps` (default 30 bps — Cauldron's
//      typical pool fee) so the operator can change it without
//      touching this module.
//
//   2. **Tx fees** — mining fees paid to the network. Sourced
//      directly from `entry.fee_sats` / `exit.fee_sats` on the
//      history events / position record (no estimation needed —
//      the bot already tracks the actual cost on every trade).
//
//   3. **Slippage cost** — the deviation from expected rate.
//      Derived from `slippage_bps × amount / 10000`. Positive
//      slippage_bps = adverse (bot paid more / got less);
//      negative = favorable (bot saved some). The breakdown
//      uses `|slippage_bps|` × amount as the cost magnitude so
//      the operator can see the full deviation, not just the
//      "loss" leg.
//
// The three components sum to `fees_paid_sats_total` and the
// relative shares (lp_share / tx_share / slippage_share) are
// exposed as floats [0..1] so the dashboard can color-code the
// severity (red > 50%, amber 25-50%, green < 25%).
//
// Three layers (mirrors `src/portfolio/per-token-trade-log.mjs`):
//
//   1. **Per-position helpers** — `txFeesForPosition`,
//      `slippageCostForPosition`, `lpFeesForPosition`,
//      `feesTotalForPosition` — pure, take one position +
//      its exit event, return the per-component sats.
//
//   2. **Per-trade attribution** — `attributionForPositionWithFees(position, exitEvent?, opts)`
//      wraps the four helpers + the by-kind split into a single
//      envelope the dashboard can render as a row.
//
//   3. **Roll-up** — `breakdownFeesForToken({tokenId, events, positions, opts})`
//      + `breakdownFeesAcrossTokens({events, positions, opts})`
//      produce the per-token envelope the `/api/fees/breakdown`
//      endpoint serializes.
//
// Design rules (also see docs/ARCHITECTURE.md §3 + §5):
//
//   1. **Pure.** No I/O. No logger. No globals. Every helper
//      takes the data it needs as an argument and returns a
//      typed plain-JS object. The dashboard wires the I/O seam.
//
//   2. **Defensive at every boundary.** A position with null
//      slippage_bps returns `slippage_cost_sats:'0'` rather
//      than crashing; a missing exit returns `tx_fees_sats_entry`
//      only; a non-array events/positions throws a typed
//      `FeeBreakdownArgError` so the server surfaces a 400.
//
//   3. **Sats are the unit.** Every money number is normalized
//      to either integer sats (string-typed BigInt for
//      JSON-safety) or a BigInt. BCH conversions happen at the
//      API edge via the existing helpers.
//
//   4. **No hard-coded knobs.** The `fee_rate_bps` defaults to
//      cauldron's typical 30 bps (`DEFAULT_LP_FEE_RATE_BPS`)
//      but every caller can override via `opts.fee_rate_bps`.
//
//   5. **Symmetric with T63.** The per-trade attribution
//      envelope carries the same `position_id` + `entry_ts` +
//      `exit_ts` fields as `attributionForClosedPosition()` so
//      the dashboard's two tiles can cross-link without a
//      second lookup.
//
// Origin: T71 (this commit) — `idea_dashboard_fee_breakdown_20260918`
// was filed 2026-09-18. This module ships subset 1 (backend +
// endpoint). Subset 2 (React tile + drill-down) also ships in
// the same commit (the React side is small once the backend is
// in — mirrors the T63 / T68 pattern).

// ─────────────────────────────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────────────────────────────

/** Schema constant for the wire envelope. */
export const FEE_BREAKDOWN_SCHEMA = 'tradebot.dashboard.fees-breakdown/v1';

/**
 * Default AMM LP-fee rate (basis points). Cauldron pools
 * typically charge 30 bps (0.30%) per trade; the scoring
 * layer's `cfg.scoring.fee_rate_bps` already defaults to 30
 * (see `src/strategy/scoring.mjs`). The breakdown module
 * surfaces the same default so callers don't have to import
 * the scoring config just to compute LP fees.
 *
 * Callers can override per-call via `opts.fee_rate_bps`.
 */
export const DEFAULT_LP_FEE_RATE_BPS = 30;

/**
 * Severity thresholds for the per-token share badges the
 * dashboard renders. Shares ABOVE `SLIPPAGE_RED_THRESHOLD`
 * surface as red ("your slippage cost is eating your LP
 * fees"); between amber and red is amber; below amber is
 * green.
 */
export const SLIPPAGE_RED_THRESHOLD = 0.50;
export const SLIPPAGE_AMBER_THRESHOLD = 0.25;
// ─────────────────────────────────────────────────────────────────────
//  Errors
// ─────────────────────────────────────────────────────────────────────

/**
 * Thrown when the caller passes a malformed input that the
 * rest of the pipeline can't recover from. The dashboard
 * surfaces this as HTTP 400.
 */
export class FeeBreakdownArgError extends Error {
  /**
   * @param {string} message
   * @param {Object} [opts]
   * @param {string} [opts.kind]  e.g. 'events_not_array'
   * @param {*}      [opts.value]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = 'FeeBreakdownArgError';
    this.kind = opts.kind || 'invalid_arg';
    this.value = opts.value;
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Conversion helpers (local — zero cross-module coupling)
// ─────────────────────────────────────────────────────────────────────

/**
 * Coerce a numeric value to a BigInt-or-null. Mirrors
 * `src/portfolio/per-token-trade-log.mjs#toSatsBigInt` exactly.
 * Duplicated here so this module has zero cross-module coupling
 * (the dashboard bundles the helpers via separate import trees).
 *
 *   toSatsBigInt(null)         → null
 *   toSatsBigInt(undefined)    → null
 *   toSatsBigInt(0)            → 0n
 *   toSatsBigInt(100)          → 100n
 *   toSatsBigInt('500000')     → 500000n  (string of int)
 *   toSatsBigInt(NaN)          → null
 *   toSatsBigInt(Infinity)     → null
 *   toSatsBigInt('abc')        → null
 *
 * @param {*} v
 * @returns {bigint|null}
 */
export function toSatsBigInt(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    if (!Number.isInteger(v)) return null;
    return BigInt(v);
  }
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (trimmed.length === 0) return null;
    if (!/^-?\d+$/.test(trimmed)) return null;
    try {
      return BigInt(trimmed);
    } catch (_e) {
      return null;
    }
  }
  return null;
}

/**
 * Convert a BigInt sats value to a finite JS Number for the
 * share-computation path. Returns null on overflow / non-bigint
 * input so the caller can render `—` instead of `Infinity`.
 *
 * BigInt values above `Number.MAX_SAFE_INTEGER` (~9e15 sats ≈
 * 9e7 BCH) are clamped to `null` rather than returned with
 * precision loss — the bot's wallet has never held anything
 * close to that magnitude, but a corrupted history file might.
 *
 *   safeBigFloat(0n)                          → 0
 *   safeBigFloat(100n)                        → 100
 *   safeBigFloat(null)                        → null
 *   safeBigFloat(2n ** 60n)                   → null  (overflow)
 *   safeBigFloat('100')                       → null  (must coerce first)
 *
 * @param {*} v   bigint or null
 * @returns {number|null}
 */
export function safeBigFloat(v) {
  if (v === null || v === undefined) return null;
  const bi = typeof v === 'bigint' ? v : toSatsBigInt(v);
  if (bi === null) return null;
  // JS Number can losslessly represent integers up to 2^53-1.
  if (bi > BigInt(Number.MAX_SAFE_INTEGER) || bi < -BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return Number(bi);
}

// ─────────────────────────────────────────────────────────────────────
//  Per-position helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Compute the tx-fee component of a single position (entry +
 * exit when present). Sourced from the EXPLICIT `fee_sats`
 * fields on the history events / position records — no
 * estimation, no fallback to a per-byte-rate × size model.
 *
 *   txFeesForPosition({entry:{fee_sats:2285}}, null) → 2285n (entry only, open)
 *   txFeesForPosition({entry:{fee_sats:2285}}, {fee_sats:2705}) → 4990n (entry + exit)
 *   txFeesForPosition(null, null) → null
 *
 * @param {Object|null} position
 * @param {Object|null} [exitEvent=null]
 * @returns {bigint|null}
 */
export function txFeesForPosition(position, exitEvent = null) {
  const entryFee = toSatsBigInt(position?.entry?.fee_sats);
  const exitFee = toSatsBigInt(exitEvent?.fee_sats);
  if (entryFee === null && exitFee === null) return null;
  return (entryFee ?? 0n) + (exitFee ?? 0n);
}

/**
 * Compute the LP-fee component of a single position. This is
 * the CONSTANT AMM fee per trade, separate from slippage.
 *
 * For ENTRY (buy): `fee_rate_bps / 10000 × bch_spent_sats`
 *   (the bch_spent_sats IS the BCH-in to the pool; the AMM
 *   takes its LP fee from the output side so the actual sats
 *   spent is bch_spent_sats × (1 + fee_rate_bps/10000). We
 *   report the lp fee ON the bch_spent_sats baseline so the
 *   "tx + lp + slippage" decomposition adds up to the realized
 *   cost the operator observes.)
 *
 * For EXIT (sell): `fee_rate_bps / 10000 × bch_received_sats`
 *   (the bch_received_sats is the BCH-out from the pool after
 *   the LP fee was deducted; the LP fee is what was DEDUCTED
 *   from the gross output. Same convention.)
 *
 * The two-leg total is the sum of entry-side + exit-side LP
 * fees. For an OPEN position (no exit) only the entry side
 * contributes.
 *
 *   lpFeesForPosition({entry:{bch_spent_sats:496939}}, null, {fee_rate_bps:30}) → 1490n
 *     (30 / 10000 × 496939 = 1490.817 → floor → 1490)
 *   lpFeesForPosition({entry:{bch_spent_sats:496939}}, {bch_received_sats:502231}, {fee_rate_bps:30})
 *     → 1490n + 1506n = 2996n
 *
 * @param {Object|null} position
 * @param {Object|null} [exitEvent=null]
 * @param {Object} [opts]
 * @param {number|bigint} [opts.fee_rate_bps=DEFAULT_LP_FEE_RATE_BPS]
 * @returns {bigint|null}
 */
export function lpFeesForPosition(position, exitEvent = null, opts = {}) {
  // Fall back to DEFAULT_LP_FEE_RATE_BPS when opts.fee_rate_bps
  // is missing, null, undefined, or unparseable. Negative
  // values are clamped to 0n (defensive — a negative fee rate
  // makes no economic sense but we don't want to throw).
  let feeRateBps = toSatsBigInt(opts.fee_rate_bps ?? DEFAULT_LP_FEE_RATE_BPS);
  if (feeRateBps === null) feeRateBps = BigInt(DEFAULT_LP_FEE_RATE_BPS);
  if (feeRateBps < 0n) feeRateBps = 0n;
  const entryAmount = toSatsBigInt(position?.entry?.bch_spent_sats);
  const exitAmount = toSatsBigInt(exitEvent?.bch_received_sats);
  if (entryAmount === null && exitAmount === null) return null;
  // (amount × bps) / 10000 — integer-floor so the result is
  // always a non-negative bigint. The remainder is dropped so
  // the per-position row sums exactly match the operator's
  // expectations (no fractional-sats rounding leakage).
  const entryLp = entryAmount !== null ? (entryAmount * feeRateBps) / 10000n : 0n;
  const exitLp = exitAmount !== null ? (exitAmount * feeRateBps) / 10000n : 0n;
  return entryLp + exitLp;
}

/**
 * Compute the slippage cost of a single position. This is
 * the deviation from the expected rate the bot quoted before
 * the trade.
 *
 *   slippageCostForPosition(position, exitEvent)
 *     = (|slippage_bps_entry| / 10000) × entry_amount_sats
 *     + (|slippage_bps_exit| / 10000) × exit_amount_sats
 *
 * The slippage_bps can be NEGATIVE (favorable — the bot got
 * a better rate than expected) or POSITIVE (adverse — the bot
 * paid more / got less than expected). The breakdown uses
 * the absolute value so the operator sees the full deviation
 * magnitude; the SIGN is preserved on the per-trade envelope
 * (`slippage_signed_bps`) for the rare cases where the
 * operator wants to see "this trade saved me 12 bps".
 *
 * Null / missing slippage_bps is treated as 0 (the data was
 * never populated — likely an older event). The helper NEVER
 * throws; a position with no slippage data returns `0n`.
 *
 *   slippageCostForPosition({entry:{bch_spent_sats:496939, slippage_bps:'33'}}, null)
 *     = 33 / 10000 × 496939 = 1640n (1640 sats lost to slippage)
 *   slippageCostForPosition({entry:{bch_spent_sats:496939}}, null)
 *     = 0n (no slippage data)
 *   slippageCostForPosition({entry:{bch_spent_sats:496939, slippage_bps:'-5'}}, null)
 *     = 5 / 10000 × 496939 = 248n (5 bps favorable — still
 *       counts as a "deviation from expected", just a positive
 *       one)
 *
 * @param {Object|null} position
 * @param {Object|null} [exitEvent=null]
 * @returns {bigint|null}
 */
export function slippageCostForPosition(position, exitEvent = null) {
  const entrySlip = parseSlippageBps(position?.entry?.slippage_bps);
  const exitSlip = parseSlippageBps(exitEvent?.slippage_bps);
  const entryAmount = toSatsBigInt(position?.entry?.bch_spent_sats);
  const exitAmount = toSatsBigInt(exitEvent?.bch_received_sats);
  // If BOTH amounts are missing, there's nothing to attribute fees against.
  if (entryAmount === null && exitAmount === null) return null;
  // Compute entry-side cost only when amount AND slippage are known
  // AND slippage is non-zero. Missing amount OR missing slippage
  // defaults to 0n — no error.
  let entryCost = 0n;
  if (entryAmount !== null && entrySlip !== null && entrySlip !== 0n) {
    entryCost = (absBigInt(entrySlip) * entryAmount) / 10000n;
  }
  let exitCost = 0n;
  if (exitAmount !== null && exitSlip !== null && exitSlip !== 0n) {
    exitCost = (absBigInt(exitSlip) * exitAmount) / 10000n;
  }
  return entryCost + exitCost;
}

/**
 * Compute the signed slippage-bps total for a single position
 * (positive = adverse; negative = favorable). Differs from
 * `slippageCostForPosition()` which returns the magnitude —
 * this returns the SIGNED entry-side bps + exit-side bps so
 * the dashboard can surface "this trade was net favorable"
 * when applicable.
 *
 *   signedSlippageBpsForPosition({entry:{slippage_bps:'33'}}, null) → 33n
 *   signedSlippageBpsForPosition({entry:{slippage_bps:'-5'}}, {slippage_bps:'12'}) → 7n
 *   signedSlippageBpsForPosition({entry:{}}, null) → 0n  (no data → 0)
 *
 * @param {Object|null} position
 * @param {Object|null} [exitEvent=null]
 * @returns {bigint|null}
 */
export function signedSlippageBpsForPosition(position, exitEvent = null) {
  const entrySlip = parseSlippageBps(position?.entry?.slippage_bps);
  const exitSlip = parseSlippageBps(exitEvent?.slippage_bps);
  if (entrySlip === null && exitSlip === null) return null;
  return (entrySlip ?? 0n) + (exitSlip ?? 0n);
}

/**
 * Compute the TOTAL fees paid on a single position. Sum of
 * `txFeesForPosition` + `lpFeesForPosition` +
 * `slippageCostForPosition`. Returns null when ALL three are
 * null (no fee data at all) so the rollup can distinguish
 * "no fees tracked" from "0 sats in fees".
 *
 * @param {Object|null} position
 * @param {Object|null} [exitEvent=null]
 * @param {Object} [opts]
 * @param {number|bigint} [opts.fee_rate_bps=DEFAULT_LP_FEE_RATE_BPS]
 * @returns {bigint|null}
 */
export function feesTotalForPosition(position, exitEvent = null, opts = {}) {
  const tx = txFeesForPosition(position, exitEvent);
  const lp = lpFeesForPosition(position, exitEvent, opts);
  const sl = slippageCostForPosition(position, exitEvent);
  if (tx === null && lp === null && sl === null) return null;
  return (tx ?? 0n) + (lp ?? 0n) + (sl ?? 0n);
}

/**
 * Per-trade attribution with the full fee breakdown. Wraps
 * the four helpers above into a single envelope the
 * dashboard can render as one row in the detail view.
 *
 * Returned shape:
 *   {
 *     position_id:           string|null,
 *     token_id:              string|null,
 *     entry_ts:              string|null,
 *     exit_ts:               string|null,
 *     exit_kind:             string|null,
 *     is_open:               boolean,
 *     fee_rate_bps:          bigint,
 *     tx_fees_sats_entry:    bigint|null,
 *     tx_fees_sats_exit:     bigint|null,
 *     tx_fees_sats_total:    bigint|null,
 *     lp_fees_sats_entry:    bigint|null,
 *     lp_fees_sats_exit:     bigint|null,
 *     lp_fees_sats_total:    bigint|null,
 *     slippage_cost_sats_entry: bigint|null,
 *     slippage_cost_sats_exit:  bigint|null,
 *     slippage_cost_sats_total: bigint|null,
 *     fees_paid_sats_total:  bigint|null,
 *     entry_amount_sats:     bigint|null,
 *     exit_amount_sats:      bigint|null,
 *     entry_slippage_bps:    bigint|null,
 *     exit_slippage_bps:     bigint|null,
 *     slippage_signed_bps:   bigint|null,
 *   }
 *
 * @param {Object} position
 * @param {Object|null} [exitEvent=null]
 * @param {Object} [opts]
 * @param {number|bigint} [opts.fee_rate_bps=DEFAULT_LP_FEE_RATE_BPS]
 * @returns {Object}
 */
export function attributionForPositionWithFees(position, exitEvent = null, opts = {}) {
  const safePos = position && typeof position === 'object' ? position : null;
  const safeExit = exitEvent && typeof exitEvent === 'object' ? exitEvent : null;
  const feeRateBps = toSatsBigInt(opts.fee_rate_bps ?? DEFAULT_LP_FEE_RATE_BPS) ?? BigInt(DEFAULT_LP_FEE_RATE_BPS);

  const entryAmount = toSatsBigInt(safePos?.entry?.bch_spent_sats);
  const exitAmount = toSatsBigInt(safeExit?.bch_received_sats);
  const entrySlip = parseSlippageBps(safePos?.entry?.slippage_bps);
  const exitSlip = parseSlippageBps(safeExit?.slippage_bps);

  const txEntry = toSatsBigInt(safePos?.entry?.fee_sats);
  const txExit = toSatsBigInt(safeExit?.fee_sats);
  const lpEntry = entryAmount !== null ? (entryAmount * feeRateBps) / 10000n : null;
  const lpExit = exitAmount !== null ? (exitAmount * feeRateBps) / 10000n : null;
  const slEntry = entryAmount !== null && entrySlip !== null && entrySlip !== 0n
    ? (absBigInt(entrySlip) * entryAmount) / 10000n
    : (entryAmount !== null ? 0n : null);
  const slExit = exitAmount !== null && exitSlip !== null && exitSlip !== 0n
    ? (absBigInt(exitSlip) * exitAmount) / 10000n
    : (exitAmount !== null ? 0n : null);

  const sumMaybe = (a, b) => {
    if (a === null && b === null) return null;
    return (a ?? 0n) + (b ?? 0n);
  };
  const txTotal = sumMaybe(txEntry, txExit);
  const lpTotal = sumMaybe(lpEntry, lpExit);
  const slTotal = sumMaybe(slEntry, slExit);
  const totalFees = sumMaybe(sumMaybe(txTotal, lpTotal), slTotal);

  return {
    position_id: typeof safePos?.id === 'string' ? safePos.id : null,
    token_id: typeof safePos?.token_id === 'string' ? safePos.token_id : null,
    entry_ts: typeof safePos?.entry?.ts === 'string' ? safePos.entry.ts : null,
    exit_ts: typeof safeExit?.ts === 'string' ? safeExit.ts : null,
    exit_kind: typeof safeExit?.exit_kind === 'string' ? safeExit.exit_kind : null,
    is_open: !safeExit,
    fee_rate_bps: feeRateBps,
    tx_fees_sats_entry: txEntry,
    tx_fees_sats_exit: txExit,
    tx_fees_sats_total: txTotal,
    lp_fees_sats_entry: lpEntry,
    lp_fees_sats_exit: lpExit,
    lp_fees_sats_total: lpTotal,
    slippage_cost_sats_entry: slEntry,
    slippage_cost_sats_exit: slExit,
    slippage_cost_sats_total: slTotal,
    fees_paid_sats_total: totalFees,
    entry_amount_sats: entryAmount,
    exit_amount_sats: exitAmount,
    entry_slippage_bps: entrySlip,
    exit_slippage_bps: exitSlip,
    slippage_signed_bps: signedSlippageBpsForPosition(safePos, safeExit),
  };
}

// ─────────────────────────────────────────────────────────────────────
//  By-kind splits + rollups
// ─────────────────────────────────────────────────────────────────────

/**
 * Sum the by-kind sub-totals across an array of
 * `attributionForPositionWithFees()` envelopes. The
 * rollup-side `breakdownFeesForToken` uses this to collapse
 * the per-position rows into one {entry, exit} pair.
 *
 * The `kind` field on each attribution envelope is implicit:
 * the entry-side legs come from `safePos?.entry` (always
 * present on a real position); the exit-side legs come from
 * `safeExit` (null for open positions). The helper extracts
 * the by-kind fields verbatim.
 *
 * @param {Array<Object>} attributions   output of `attributionForPositionWithFees`
 * @returns {{
 *   entry: { tx_fees_sats, lp_fees_sats, slippage_cost_sats, fees_paid_sats_total, amount_sats, slippage_signed_bps, trade_count },
 *   exit:  { tx_fees_sats, lp_fees_sats, slippage_cost_sats, fees_paid_sats_total, amount_sats, slippage_signed_bps, trade_count },
 * }}
 */
export function pickByKind(attributions) {
  const entry = {
    tx_fees_sats: 0n,
    lp_fees_sats: 0n,
    slippage_cost_sats: 0n,
    fees_paid_sats_total: 0n,
    amount_sats: 0n,
    slippage_signed_bps: 0n,
    trade_count: 0,
  };
  const exit = {
    tx_fees_sats: 0n,
    lp_fees_sats: 0n,
    slippage_cost_sats: 0n,
    fees_paid_sats_total: 0n,
    amount_sats: 0n,
    slippage_signed_bps: 0n,
    trade_count: 0,
  };
  if (!Array.isArray(attributions)) {
    return { entry, exit };
  }
  for (const a of attributions) {
    if (!a || typeof a !== 'object') continue;
    entry.tx_fees_sats += a.tx_fees_sats_entry ?? 0n;
    entry.lp_fees_sats += a.lp_fees_sats_entry ?? 0n;
    entry.slippage_cost_sats += a.slippage_cost_sats_entry ?? 0n;
    entry.amount_sats += a.entry_amount_sats ?? 0n;
    entry.slippage_signed_bps += a.entry_slippage_bps ?? 0n;
    entry.trade_count += 1;
    if (!a.is_open) {
      exit.tx_fees_sats += a.tx_fees_sats_exit ?? 0n;
      exit.lp_fees_sats += a.lp_fees_sats_exit ?? 0n;
      exit.slippage_cost_sats += a.slippage_cost_sats_exit ?? 0n;
      exit.amount_sats += a.exit_amount_sats ?? 0n;
      exit.slippage_signed_bps += a.exit_slippage_bps ?? 0n;
      exit.trade_count += 1;
    }
  }
  entry.fees_paid_sats_total = entry.tx_fees_sats + entry.lp_fees_sats + entry.slippage_cost_sats;
  exit.fees_paid_sats_total = exit.tx_fees_sats + exit.lp_fees_sats + exit.slippage_cost_sats;
  return { entry, exit };
}

/**
 * Compute the relative shares (floats 0..1) from a totals
 * object with `lp_fees_sats_total`, `tx_fees_sats_total`, and
 * `slippage_cost_sats_total` bigint fields. Returns all three
 * shares summing to 1.0 (rounded to 6 decimals via
 * `Number(bi) / total`) or 0 when the total is zero.
 *
 *   sharesFromTotals({lp_fees_sats_total: 1500n, tx_fees_sats_total: 5000n, slippage_cost_sats_total: 3500n})
 *     → {lp_share: 0.15, tx_share: 0.50, slippage_share: 0.35}
 *   sharesFromTotals({lp_fees_sats_total: 0n, tx_fees_sats_total: 0n, slippage_cost_sats_total: 0n})
 *     → {lp_share: 0, tx_share: 0, slippage_share: 0}
 *
 * @param {Object} totals
 * @returns {{lp_share: number, tx_share: number, slippage_share: number}}
 */
export function sharesFromTotals(totals) {
  const lp = safeBigFloat(totals?.lp_fees_sats_total ?? 0n) ?? 0;
  const tx = safeBigFloat(totals?.tx_fees_sats_total ?? 0n) ?? 0;
  const sl = safeBigFloat(totals?.slippage_cost_sats_total ?? 0n) ?? 0;
  const total = lp + tx + sl;
  if (total === 0) {
    return { lp_share: 0, tx_share: 0, slippage_share: 0 };
  }
  return {
    lp_share: round6(lp / total),
    tx_share: round6(tx / total),
    slippage_share: round6(sl / total),
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Per-token rollup
// ─────────────────────────────────────────────────────────────────────

/**
 * Reduce an array of `attributionForPositionWithFees` rows
 * to the per-token totals the dashboard renders in the
 * rollup row.
 *
 * Returns:
 *   {
 *     trade_count:           number,    entry + exit positions combined (exit counted separately)
 *     lp_fees_sats_total:    bigint,
 *     tx_fees_sats_total:    bigint,
 *     slippage_cost_sats_total: bigint,
 *     fees_paid_sats_total:  bigint,
 *   }
 *
 * @param {Array<Object>} attributions
 * @returns {Object}
 */
export function aggregateFeeTotals(attributions) {
  const result = {
    trade_count: 0,
    lp_fees_sats_total: 0n,
    tx_fees_sats_total: 0n,
    slippage_cost_sats_total: 0n,
    fees_paid_sats_total: 0n,
  };
  if (!Array.isArray(attributions)) return result;
  for (const a of attributions) {
    if (!a || typeof a !== 'object') continue;
    result.trade_count += 1;
    result.lp_fees_sats_total += a.lp_fees_sats_total ?? 0n;
    result.tx_fees_sats_total += a.tx_fees_sats_total ?? 0n;
    result.slippage_cost_sats_total += a.slippage_cost_sats_total ?? 0n;
    result.fees_paid_sats_total += a.fees_paid_sats_total ?? 0n;
  }
  return result;
}

/**
 * Build the per-token fee breakdown for ONE token. Accepts
 * the full `events` list + the full `positions` list
 * (open + closed) + the `tokenId` to focus on. Returns
 * the full envelope with by-kind (entry vs exit) sub-totals
 * + the per-trade attribution array.
 *
 * @param {Object} args
 * @param {Array<Object>} args.events
 * @param {Array<Object>} args.positions
 * @param {string}      args.tokenId
 * @param {Object}      [args.opts]
 * @param {number|bigint} [args.opts.fee_rate_bps=DEFAULT_LP_FEE_RATE_BPS]
 * @returns {Object}
 */
export function breakdownFeesForToken({ events, positions, tokenId, opts = {} }) {
  if (!Array.isArray(events)) {
    throw new FeeBreakdownArgError('breakdownFeesForToken: events must be an array', {
      kind: 'events_not_array',
      value: typeof events,
    });
  }
  if (!Array.isArray(positions)) {
    throw new FeeBreakdownArgError('breakdownFeesForToken: positions must be an array', {
      kind: 'positions_not_array',
      value: typeof positions,
    });
  }
  if (typeof tokenId !== 'string' || tokenId.length === 0) {
    throw new FeeBreakdownArgError('breakdownFeesForToken: tokenId required (non-empty string)', {
      kind: 'token_id_required',
      value: tokenId,
    });
  }
  const feeRateBps = toSatsBigInt(opts.fee_rate_bps ?? DEFAULT_LP_FEE_RATE_BPS) ?? BigInt(DEFAULT_LP_FEE_RATE_BPS);

  // Filter to events + positions for the focused token.
  const myEvents = events.filter((e) => e && typeof e === 'object' && e.token_id === tokenId);
  const exitByPositionId = new Map();
  for (const ev of myEvents) {
    if (ev && ev.kind === 'exit' && typeof ev.position_id === 'string') {
      exitByPositionId.set(ev.position_id, ev);
    }
  }
  const myPositions = positions.filter(
    (p) => p && typeof p === 'object' && p.token_id === tokenId,
  );

  const attributions = [];
  for (const pos of myPositions) {
    const exitEv = typeof pos?.id === 'string' ? exitByPositionId.get(pos.id) ?? null : null;
    const hasExitOnPos = pos?.exit && typeof pos.exit === 'object';
    const exitForAttribution = exitEv ?? (hasExitOnPos
      ? {
          ts: pos.exit.ts,
          exit_kind: pos.exit.exit_kind,
          bch_received_sats: pos.exit.bch_received_sats,
          fee_sats: pos.exit.fee_sats,
          slippage_bps: pos.exit.slippage_bps,
        }
      : null);
    attributions.push(attributionForPositionWithFees(pos, exitForAttribution, { fee_rate_bps: feeRateBps }));
  }

  // Sort newest-first by entry_ts (so the dashboard's per-trade
  // table is consistent with T63's TokenSummaryCard).
  attributions.sort((a, b) => {
    const aMs = typeof a.entry_ts === 'string' ? Date.parse(a.entry_ts) : 0;
    const bMs = typeof b.entry_ts === 'string' ? Date.parse(b.entry_ts) : 0;
    if (Number.isNaN(aMs) && Number.isNaN(bMs)) return 0;
    if (Number.isNaN(aMs)) return 1;
    if (Number.isNaN(bMs)) return -1;
    return bMs - aMs;
  });

  const totals = aggregateFeeTotals(attributions);
  const byKind = pickByKind(attributions);
  const shares = sharesFromTotals(totals);

  // Symbol / decimals picked from the first position that has
  // them populated (mirrors T63's `buildPerTokenSummary`).
  const symbol = myPositions.find((p) => typeof p?.token_symbol === 'string')?.token_symbol ?? null;
  const decimals = myPositions.find((p) => typeof p?.token_decimals === 'number')?.token_decimals ?? null;

  const tradeCount = attributions.length;

  return {
    schema: FEE_BREAKDOWN_SCHEMA,
    token_id: tokenId,
    symbol,
    decimals,
    trade_count: tradeCount,
    fee_rate_bps: feeRateBps,
    lp_fees_sats_total: totals.lp_fees_sats_total,
    tx_fees_sats_total: totals.tx_fees_sats_total,
    slippage_cost_sats_total: totals.slippage_cost_sats_total,
    fees_paid_sats_total: totals.fees_paid_sats_total,
    lp_share: shares.lp_share,
    tx_share: shares.tx_share,
    slippage_share: shares.slippage_share,
    by_kind: {
      entry: byKind.entry,
      exit: byKind.exit,
    },
    trades: attributions,
  };
}

/**
 * Build the cross-token rollup list (one row per token) for
 * the dashboard. Sorted by `fees_paid_sats_total` DESC so the
 * operator sees the tokens with the highest fee drag first.
 *
 * @param {Object} args
 * @param {Array<Object>} args.events
 * @param {Array<Object>} args.positions
 * @param {Object}      [args.opts]
 * @param {number|bigint} [args.opts.fee_rate_bps=DEFAULT_LP_FEE_RATE_BPS]
 * @returns {{schema: string, count: number, tokens: Array<Object>, totals: Object}}
 */
export function breakdownFeesAcrossTokens({ events, positions, opts = {} }) {
  if (!Array.isArray(events)) {
    throw new FeeBreakdownArgError('breakdownFeesAcrossTokens: events must be an array', {
      kind: 'events_not_array',
      value: typeof events,
    });
  }
  if (!Array.isArray(positions)) {
    throw new FeeBreakdownArgError('breakdownFeesAcrossTokens: positions must be an array', {
      kind: 'positions_not_array',
      value: typeof positions,
    });
  }
  const feeRateBps = toSatsBigInt(opts.fee_rate_bps ?? DEFAULT_LP_FEE_RATE_BPS) ?? BigInt(DEFAULT_LP_FEE_RATE_BPS);

  // Collect unique token_ids from BOTH events and positions so
  // a token with only open positions (no entry event yet) is
  // still surfaced on the rollup.
  const tokenIdSet = new Set();
  for (const e of events) {
    if (e && typeof e === 'object' && typeof e.token_id === 'string') tokenIdSet.add(e.token_id);
  }
  for (const p of positions) {
    if (p && typeof p === 'object' && typeof p.token_id === 'string') tokenIdSet.add(p.token_id);
  }

  const summaries = [];
  for (const tid of tokenIdSet) {
    summaries.push(breakdownFeesForToken({ events, positions, tokenId: tid, opts: { fee_rate_bps: feeRateBps } }));
  }

  // Strip the heavy `trades[]` array from the rollup row —
  // the dashboard re-fetches `/api/fees/breakdown?token_id=...`
  // for the per-trade detail. Mirrors T63's `listPerTokenSummaries`.
  const rollupRows = summaries.map((s) => ({
    token_id: s.token_id,
    symbol: s.symbol,
    decimals: s.decimals,
    trade_count: s.trade_count,
    fee_rate_bps: s.fee_rate_bps,
    lp_fees_sats_total: s.lp_fees_sats_total,
    tx_fees_sats_total: s.tx_fees_sats_total,
    slippage_cost_sats_total: s.slippage_cost_sats_total,
    fees_paid_sats_total: s.fees_paid_sats_total,
    lp_share: s.lp_share,
    tx_share: s.tx_share,
    slippage_share: s.slippage_share,
    by_kind: s.by_kind,
  }));

  rollupRows.sort((a, b) => {
    const aFees = a.fees_paid_sats_total;
    const bFees = b.fees_paid_sats_total;
    if (aFees === bFees) return a.token_id.localeCompare(b.token_id);
    return aFees > bFees ? -1 : 1;
  });

  // Cross-token aggregate.
  const crossTotals = aggregateFeeTotals(summaries.map((s) => ({
    lp_fees_sats_total: s.lp_fees_sats_total,
    tx_fees_sats_total: s.tx_fees_sats_total,
    slippage_cost_sats_total: s.slippage_cost_sats_total,
    fees_paid_sats_total: s.fees_paid_sats_total,
  })));
  crossTotals.lp_share = sharesFromTotals(crossTotals).lp_share;
  crossTotals.tx_share = sharesFromTotals(crossTotals).tx_share;
  crossTotals.slippage_share = sharesFromTotals(crossTotals).slippage_share;
  // trade_count for the cross-token rollup is the SUM of per-token
  // trade_counts (each trade belongs to exactly one token so no
  // double-counting is possible).
  crossTotals.trade_count = rollupRows.reduce((acc, r) => acc + r.trade_count, 0);

  return {
    schema: FEE_BREAKDOWN_SCHEMA,
    count: rollupRows.length,
    tokens: rollupRows,
    totals: crossTotals,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Internal helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Parse the slippage_bps field (which can arrive as a bigint,
 * a number, a numeric string, a "missing data" sentinel,
 * null, or undefined) into a bigint or null. Returns 0n when
 * the value is a SENTINEL (abs(value) >= 9999 — both
 * `-9999` and `-10000` are emitted by the cauldron-swap-sdk
 * when the indexer rate is unavailable, e.g. a degenerate
 * trade where the post-trade rate was 0). A real AMM slippage
 * won't approach 100% (10000 bps), so the threshold is
 * conservatively tight.
 *
 *   parseSlippageBps(null)        → null
 *   parseSlippageBps(undefined)   → null
 *   parseSlippageBps('-9999')     → 0n   (sentinel — SDK "no data")
 *   parseSlippageBps('-10000')    → 0n   (sentinel — degenerate rate=0)
 *   parseSlippageBps(0)           → 0n
 *   parseSlippageBps(33)          → 33n
 *   parseSlippageBps('-5')        → -5n
 *   parseSlippageBps('abc')       → null
 *   parseSlippageBps(NaN)         → null
 *   parseSlippageBps(Infinity)    → null
 *
 * @param {*} v
 * @returns {bigint|null}
 */
function parseSlippageBps(v) {
  if (v === null || v === undefined) return null;
  const bi = toSatsBigInt(v);
  if (bi === null) return null;
  // Sentinel: any slippage at or above 9999 bps (in absolute
  // value) means the SDK didn't have data — drop it. The
  // `-10000` case = 100% deviation = degenerate rate (post-trade
  // rate was 0). The `-9999` case = explicit "no data" marker
  // historically emitted by `cauldron-swap-sdk`. A real AMM
  // slippage on a healthy pool tops out around 200-500 bps; the
  // threshold is generous on purpose so any future SDK-style
  // sentinels get caught.
  if (bi <= -9999n || bi >= 9999n) return 0n;
  return bi;
}

/** BigInt absolute value. Returns 0n when v is null. */
function absBigInt(v) {
  if (v === null || v === undefined) return 0n;
  const bi = typeof v === 'bigint' ? v : toSatsBigInt(v);
  if (bi === null) return 0n;
  return bi < 0n ? -bi : bi;
}

/** Round a float to 6 decimals so the wire-format shares look clean. */
function round6(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1_000_000) / 1_000_000;
}
