#!/usr/bin/env node
// src/portfolio/pnl.mjs
//
// Realized + unrealized P&L computations for TradeBot.
//
// Three layers:
//
//   1. **Position-level P&L** — `realizedPnlSats(position, exit)`
//      and `unrealizedPnlSats(position, marketPriceSats)`. Pure
//      functions; the trader loop uses these to decide whether
//      take-profit / stop-loss has fired and to record the result
//      on close.
//
//   2. **Aggregate P&L** — `summarize(closedPositions)` rolls up
//      realized P&L into win rate, total fees, mean hold time.
//      Powers the DASHBOARD "performance" card.
//
//   3. **Settlement** — `realizedPnlSatsFromSettlement` computes
//      realized P&L from the raw on-chain settlement numbers
//      (BCH received on exit vs BCH spent on entry, net of fees)
//      so the bot doesn't have to trust the indexer's price.
//
// Design rules (also see docs/ARCHITECTURE.md §5.1):
//
//   1. **Sats are the unit.** Everything is normalized to integer
//      sats before being summed. The dashboard converts to BCH
//      only at the display layer.
//
//   2. **P&L excludes fees** by default. The caller passes in
//      `feeSats` explicitly when they want net-of-fees P&L —
//      this matches how a trader's journal works. `pnl.net` is
//      the convention we surface to the dashboard.
//
//   3. **Missing data → null, never 0.** A position with a null
//      `entry.bch_spent_sats` returns null P&L instead of
//      pretending it was a 0-cost trade. The dashboard renders
//      "unknown" for null.
//
//   4. **Side-aware.** v1 only has `long_token` (BCH → token),
//      but the helpers are written to handle a future `short_token`
//      cleanly: a `short_token` position's P&L is `entry.bch_received
//      - exit.bch_paid` (BCH-denominated) and `tokenAmount` is
//      negative from the user's perspective.
//
//   5. **Pure.** No I/O. No logger. Safe to import from anywhere.
//
// Origin: original code for TradeBot. ARCHITECTURE.md §3 places
// this module on the pure layer above `data/*` and `trader/*`.

import { SATS_PER_BCH } from '../data/types.mjs';
import { isPricePlausibleVsEntry, DEFAULT_PRICE_VS_ENTRY_RATIO_X } from '../util/price-sanity.mjs';

// ─────────────────────────────────────────────────────────────────────
//  Errors
// ─────────────────────────────────────────────────────────────────────

/**
 * Base class for P&L errors. Callers should match on
 * `instanceof PnlError` to distinguish P&L-side failures from
 * local bugs (TypeError on bad input, etc.).
 */
export class PnlError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'PnlError';
    if (opts.kind) this.kind = opts.kind;
    if (opts.cause) this.cause = opts.cause;
  }
}

/** Input shape problem (programmer error — fail fast). */
export class PnlConfigError extends PnlError {
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = 'PnlConfigError';
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Pure helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Coerce `v` to a non-negative integer sat value, or `null` if
 * the value is missing / non-numeric. BigInt / number / string
 * inputs are all accepted; `null` / `undefined` / NaN / negative
 * numbers return `null`.
 *
 * Pure — exported for tests + for downstream helpers.
 *
 * @param {unknown} v
 * @returns {bigint|null}
 */
export function toSats(v) {
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
 * Coerce `v` to a non-negative integer per-token price (sats per
 * base unit), or `null` if missing / non-numeric / negative.
 *
 * @param {unknown} v
 * @returns {bigint|null}
 */
export function toPriceSats(v) {
  // `toSats` already enforces non-null + non-negative.
  return toSats(v);
}

/**
 * Compute the realized P&L for a closed position.
 *
 * For a `long_token` (BCH → token) position:
 *   `pnl_gross = bch_received_on_exit - bch_spent_on_entry`
 *   `pnl_net   = pnl_gross - total_fees`
 *
 * Fees are split: `entryFeeSats` (paid when opening) and
 * `exitFeeSats` (paid when closing). The function takes them as
 * separate args so the caller can pull them off the position +
 * exit records without re-parsing.
 *
 * @param {Object} position     a `PositionEntry` (positions.mjs)
 * @param {Object} exit         { bch_received_sats, fee_sats }
 * @returns {{ gross: bigint|null, net: bigint|null, entry_fee_sats: bigint|null, exit_fee_sats: bigint|null }}
 */
export function realizedPnlSats(position, exit) {
  if (!position || typeof position !== 'object') {
    throw new PnlConfigError('realizedPnlSats: position required');
  }
  if (!exit || typeof exit !== 'object') {
    throw new PnlConfigError('realizedPnlSats: exit required');
  }
  const entrySpent = toSats(position?.entry?.bch_spent_sats ?? position?.entry?.bch_spent);
  const exitReceived = toSats(exit?.bch_received_sats ?? exit?.bch_received);
  const entryFee = toSats(position?.entry?.fee_sats);
  const exitFee = toSats(exit?.fee_sats);

  if (entrySpent === null || exitReceived === null) {
    return { gross: null, net: null, entry_fee_sats: entryFee, exit_fee_sats: exitFee };
  }
  const gross = exitReceived - entrySpent;
  const totalFees =
    (entryFee === null ? 0n : entryFee) +
    (exitFee === null ? 0n : exitFee);
  const net = gross - totalFees;
  return { gross, net, entry_fee_sats: entryFee, exit_fee_sats: exitFee };
}

/**
 * Compute unrealized P&L for an OPEN position given the current
 * market price (sats per base unit). Returns `null` for any
 * field we can't compute (missing entry cost, missing market
 * price, missing token amount).
 *
 * `pnl_gross_if_sold_now = token_amount_base * market_price - bch_spent`
 * `pnl_net_if_sold_now   = pnl_gross_if_sold_now - entry_fee - est_exit_fee`
 *
 * `est_exit_fee` is optional — pass null if you don't have it
 * (the dashboard computes it lazily from the LP fee rate).
 *
 * T28e: optional `opts.maxPriceRatioX` parameter — when supplied
 * and the market price is more than `maxPriceRatioX` times the
 * entry price (or less than `1/maxPriceRatioX`), the price is
 * treated as bogus and P&L returns null fields. Mirrors the
 * T28d guard in `shouldExit` (commit 9561393) — without it, a
 * token with a wildly-wrong indexer price (e.g. QBTC: 100,000,000x
 * off) would silently emit $20M+ of "unrealized gains" on every
 * snapshot. When `opts.maxPriceRatioX` is omitted, no check is
 * applied (backward-compatible for callers that already gate the
 * price upstream).
 *
 * @param {Object} position      a `PositionEntry`
 * @param {bigint|number|null} marketPriceSats  sats per token (base units)
 * @param {bigint|number|null} [estExitFeeSats]
 * @param {Object} [opts]
 * @param {number|bigint|null} [opts.maxPriceRatioX=null]   if provided AND exceeded → null
 * @returns {{ gross: bigint|null, net: bigint|null, pct: number|null }}
 */
export function unrealizedPnlSats(position, marketPriceSats, estExitFeeSats = null, opts = null) {
  if (!position || typeof position !== 'object') {
    throw new PnlConfigError('unrealizedPnlSats: position required');
  }
  const entrySpent = toSats(position?.entry?.bch_spent_sats ?? position?.entry?.bch_spent);
  const tokenAmount = toSats(position?.entry?.token_amount_base);
  const entryFee = toSats(position?.entry?.fee_sats);
  const exitFee = toSats(estExitFeeSats);
  const price = toPriceSats(marketPriceSats);

  if (entrySpent === null || tokenAmount === null || price === null) {
    return { gross: null, net: null, pct: null };
  }
  // T28e: paranoid price sanity. Some indexer prices are wildly
  // off from the actual AMM-implied rate (e.g. QBTC: indexer
  // reports 32.6 BCH/token when the AMM spot rate is ~326
  // sats/token — 100,000,000x off). Without this guard the
  // unrealized P&L shows absurd $20M+ "gains" every snapshot.
  // When the operator opts in (by passing opts.maxPriceRatioX),
  // reject the price and return null fields.
  if (opts && Number.isFinite(Number(opts.maxPriceRatioX)) && Number(opts.maxPriceRatioX) > 0) {
    const entryPrice = toSats(position?.entry?.price_sats_per_token ?? position?.entry?.entry_price_sats_per_token);
    if (!isPricePlausibleVsEntry(entryPrice, price, opts.maxPriceRatioX)) {
      return { gross: null, net: null, pct: null };
    }
  }
  const currentValue = tokenAmount * price;
  const gross = currentValue - entrySpent;
  const totalFees =
    (entryFee === null ? 0n : entryFee) +
    (exitFee === null ? 0n : exitFee);
  const net = gross - totalFees;
  // Pct is computed against entrySpent (a 1.0 return = 100% gain).
  // Use Number() division for full precision — bigint truncation
  // rounds away the last 4 decimal places (e.g. 0.099985 → 0.0999).
  const pct = entrySpent > 0n
    ? Number(net) / Number(entrySpent)
    : null;
  return { gross, net, pct };
}

/**
 * T28e: default ratio for the unrealized-P&L sanity check.
 * Re-exported from `src/util/price-sanity.mjs` so callers can
 * `import { DEFAULT_MAX_PRICE_RATIO } from '../portfolio/pnl.mjs'`
 * for parity with the exit-side default.
 */
export const DEFAULT_MAX_PRICE_RATIO = DEFAULT_PRICE_VS_ENTRY_RATIO_X;

/**
 * Compute realized P&L directly from raw on-chain settlement
 * numbers (the trader passes this when it wants to record a
 * close without trusting the position record's fields). Useful
 * for reconciliation / disaster-recovery paths where the on-disk
 * `positions.json` is gone but the wallet's tx history isn't.
 *
 * @param {Object} args
 * @param {bigint|number|string} args.entryBchSpentSats
 * @param {bigint|number|string} args.exitBchReceivedSats
 * @param {bigint|number|string} [args.totalFeeSats]
 * @returns {bigint|null} realized P&L in sats (net of fees), or null on bad input
 */
export function realizedPnlSatsFromSettlement({ entryBchSpentSats, exitBchReceivedSats, totalFeeSats = 0n }) {
  const spent = toSats(entryBchSpentSats);
  const received = toSats(exitBchReceivedSats);
  const fees = toSats(totalFeeSats);
  if (spent === null || received === null) return null;
  const fee = fees ?? 0n;
  return received - spent - fee;
}

/**
 * Return the absolute hold-time for a position in milliseconds.
 * For an open position: `nowMs - openedAtMs`. For a closed
 * position: `closedAtMs - openedAtMs`. Returns null if either
 * timestamp is missing or unparseable.
 *
 * Pure — exported so tests + dashboards can compute mean hold time.
 *
 * @param {Object} position
 * @param {number} [nowMs=Date.now()]
 * @returns {number|null}
 */
export function holdTimeMs(position, nowMs = Date.now()) {
  if (!position || typeof position !== 'object') return null;
  const opened = Date.parse(position.opened_at ?? '');
  if (!Number.isFinite(opened)) return null;
  const closed = position.closed_at ? Date.parse(position.closed_at) : (Number.isFinite(nowMs) ? nowMs : Date.now());
  if (!Number.isFinite(closed)) return null;
  if (closed < opened) return null;
  return closed - opened;
}

/**
 * Roll up a list of closed positions into dashboard-ready
 * aggregates. Returns zeros (not nulls) for empty input so the
 * dashboard never has to special-case "no trades yet".
 *
 * @param {Array<Object>} closedPositions
 * @returns {{
 *   count: number,
 *   wins: number,
 *   losses: number,
 *   breakeven: number,
 *   win_rate_pct: number,
 *   realized_pnl_sats: bigint,
 *   realized_pnl_bch: number,
 *   total_fees_sats: bigint,
 *   total_fees_bch: number,
 *   mean_hold_ms: number|null,
 *   best_trade_sats: bigint|null,
 *   worst_trade_sats: bigint|null,
 *   pct_return: number|null,
 * }}
 */
export function summarize(closedPositions) {
  /** @type {ReturnType<typeof summarize>} */
  const out = {
    count: 0,
    wins: 0,
    losses: 0,
    breakeven: 0,
    win_rate_pct: 0,
    realized_pnl_sats: 0n,
    realized_pnl_bch: 0,
    total_fees_sats: 0n,
    total_fees_bch: 0,
    mean_hold_ms: null,
    best_trade_sats: null,
    worst_trade_sats: null,
    pct_return: null,
  };
  if (!Array.isArray(closedPositions) || closedPositions.length === 0) return out;

  let totalHold = 0n;
  let holdCount = 0;
  let totalEntrySpent = 0n;
  for (const p of closedPositions) {
    if (!p || typeof p !== 'object') continue;
    const pnl = realizedPnlSats(p, p.exit ?? {});
    if (pnl.net === null) continue;
    out.count += 1;
    out.realized_pnl_sats += pnl.net;
    out.total_fees_sats += (pnl.entry_fee_sats ?? 0n) + (pnl.exit_fee_sats ?? 0n);
    if (pnl.net > 0n) out.wins += 1;
    else if (pnl.net < 0n) out.losses += 1;
    else out.breakeven += 1;
    if (out.best_trade_sats === null || pnl.net > out.best_trade_sats) out.best_trade_sats = pnl.net;
    if (out.worst_trade_sats === null || pnl.net < out.worst_trade_sats) out.worst_trade_sats = pnl.net;
    const h = holdTimeMs(p);
    if (h !== null) { totalHold += BigInt(h); holdCount += 1; }
    const entrySpent = toSats(p?.entry?.bch_spent_sats ?? p?.entry?.bch_spent);
    if (entrySpent !== null) totalEntrySpent += entrySpent;
  }
  if (out.count > 0) out.win_rate_pct = (out.wins / out.count) * 100;
  if (holdCount > 0) out.mean_hold_ms = Number(totalHold / BigInt(holdCount));
  out.realized_pnl_bch = Number(out.realized_pnl_sats) / SATS_PER_BCH;
  out.total_fees_bch = Number(out.total_fees_sats) / SATS_PER_BCH;
  // Pct_return is the realized P&L as a percentage of total BCH
  // deployed across all closed trades. Use Number() division so the
  // result is full-precision (bigint truncation rounds to 4 dp).
  if (totalEntrySpent > 0n) {
    out.pct_return = (Number(out.realized_pnl_sats) / Number(totalEntrySpent)) * 100;
  }
  return out;
}

/**
 * Aggregate per-token realized P&L for the dashboard's "P&L by
 * token" view. Returns a map token_id → summary record.
 *
 * @param {Array<Object>} closedPositions
 * @returns {Record<string, ReturnType<typeof summarize>>}
 */
export function summarizeByToken(closedPositions) {
  /** @type {Record<string, ReturnType<typeof summarize>>} */
  const out = {};
  if (!Array.isArray(closedPositions)) return out;
  /** @type {Record<string, Object[]>} */
  const buckets = {};
  for (const p of closedPositions) {
    if (!p || typeof p !== 'object' || typeof p.token_id !== 'string') continue;
    if (!buckets[p.token_id]) buckets[p.token_id] = [];
    buckets[p.token_id].push(p);
  }
  for (const tid of Object.keys(buckets)) {
    out[tid] = summarize(buckets[tid]);
  }
  return out;
}

/**
 * Best-trade / worst-trade helpers — separate from `summarize`
 * so the dashboard's "highlight a single trade" widget doesn't
 * have to compute the full rollup.
 *
 * Returns each as `{position, pnl_sats}` so callers don't have to
 * re-derive the value from the on-disk `exit.realized_pnl_sats`
 * field — that field can be a manual override (e.g. the 2026-09-13
 * FEW orphan-recovery set it to a fake zero to unstick the bot),
 * which would re-introduce the inconsistency the rest of the
 * dashboard surface has already routed around. Using the
 * computed `realizedPnlSats()` result here keeps the displayed
 * best/worst P&L in lockstep with `/api/summary.realized_pnl_sats`
 * and `/api/pnl-timeseries.realized_total_sats`.
 *
 * @param {Array<Object>} closedPositions
 * @returns {{ best: { position: Object, pnl_sats: bigint }|null, worst: { position: Object, pnl_sats: bigint }|null }}
 */
export function bestAndWorst(closedPositions) {
  if (!Array.isArray(closedPositions) || closedPositions.length === 0) {
    return { best: null, worst: null };
  }
  /** @type {{ position: Object, pnl_sats: bigint }|null} */
  let best = null;
  /** @type {{ position: Object, pnl_sats: bigint }|null} */
  let worst = null;
  for (const p of closedPositions) {
    if (!p || typeof p !== 'object') continue;
    const pnl = realizedPnlSats(p, p.exit ?? {});
    if (pnl.net === null) continue;
    if (best === null || pnl.net > best.pnl_sats) {
      best = { position: p, pnl_sats: pnl.net };
    }
    if (worst === null || pnl.net < worst.pnl_sats) {
      worst = { position: p, pnl_sats: pnl.net };
    }
  }
  return { best, worst };
}

export const _internals = { toSats, toPriceSats };
