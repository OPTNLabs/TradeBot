#!/usr/bin/env node
// src/dashboard/pnl-timeseries.mjs
//
// T39 — Cumulative realized P&L over time, for the DASHBOARD view.
//
// Every closed position lives in `data/positions.json#closed[]`.
// Each one carries:
//   - `closed_at`         (ISO timestamp the loop finalized the close)
//   - `exit.realized_pnl_sats`  (bigint sat value, set when the
//                                loop / reconcile tool computed it)
//   - `token_id`, `id`, `side`, `entry.bch_spent_sats`, `exit.bch_received_sats`,
//     `exit.fee_sats`, `exit.reason` etc.
//
// The dashboard wants a single chart: "cumulative realized P&L"
// plotted at each close's timestamp, with optional per-trade
// markers (win / loss / breakeven / dry-run). We build that series
// here, pure — the route handler threads `clock()` through so the
// optional `?range=` filter is deterministic.
//
// Design rules (also see docs/ARCHITECTURE.md §3 — pure helpers
// live above the dashboard / network layers):
//
//   1. **Pure.** No I/O, no `Date.now()`, no module-scope state.
//      `nowMs` is threaded in by the caller (the route handler
//      pulls it from `ctx.clock()` so the test suite can freeze
//      time).
//
//   2. **BigInt-friendly.** `realized_pnl_sats` is stored as a
//      stringified bigint in `positions.json`. We accept either
//      string / bigint / number / null and normalize internally.
//
//   3. **Sort stable, deterministic.** Sort by `(closed_at asc,
//      id asc)` so two trades closing in the same ms don't
//      fluctuate the cumsum across runs.
//
//   4. **No silent data loss.** A position missing `closed_at` is
//      excluded (logged via `onSkip`, surfaced in the response
//      envelope). A position with `realized_pnl_sats === null` is
//      skipped too — the operator can see this in the
//      `skipped` counter.
//
//   5. **Token-id filter is case-folded.** 64-hex tokens are
//      stored lowercase; the query string is folded before
//      comparison so `?token_id=<UPPER>` still matches.

import { SATS_PER_BCH } from '../data/types.mjs';
import { realizedPnlSats as computeRealizedPnlSats } from '../portfolio/pnl.mjs';

/** @typedef {{ closed_at: string, exit: { realized_pnl_sats?: string|number|bigint|null } } & Record<string, any> }} ClosedPositionLike */

// ─────────────────────────────────────────────────────────────────────
//  Errors
// ─────────────────────────────────────────────────────────────────────

/**
 * Base class for pnl-timeseries errors. The route handler maps
 * `DashboardConfigError` to HTTP 400 and anything else to 500; the
 * dashboard's request dispatcher honors `err.statusCode` if set.
 */
export class PnlTimeseriesError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'PnlTimeseriesError';
    if (opts.kind) this.kind = opts.kind;
    if (opts.statusCode) this.statusCode = opts.statusCode;
    if (opts.cause) this.cause = opts.cause;
  }
}

/** Bad input — caller passed something that isn't a usable position list. */
export class PnlTimeseriesConfigError extends PnlTimeseriesError {
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = 'PnlTimeseriesConfigError';
    this.statusCode = opts.statusCode ?? 400;
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Pure helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Normalize `realized_pnl_sats` to a bigint, accepting bigint /
 * number / string / null. Returns `null` for null / undefined /
 * unparseable / negative-on-explicit-flag callers.
 *
 * Empty strings and non-numeric strings return `null`. Numbers
 * outside the safe integer range are rejected (use a stringified
 * bigint instead — matches the on-disk convention).
 *
 * Pure — exported for tests.
 *
 * @param {unknown} v
 * @returns {bigint|null}
 */
export function toSatsBig(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    // Math.round matches pnl.mjs#toSats convention. Fractional inputs
    // (e.g. an indexer returning 1.7e-3 BCH) round to nearest sat.
    // Very large integers should be passed as strings (the on-disk
    // convention) to avoid Number precision loss.
    return BigInt(Math.round(v));
  }
  if (typeof v === 'string') {
    const t = v.trim();
    if (t.length === 0) return null;
    if (!/^-?\d+$/.test(t)) return null;
    try {
      return BigInt(t);
    } catch (_) {
      return null;
    }
  }
  return null;
}

/**
 * Classify a single trade's outcome. Pure — exported for tests +
 * the dashboard tooltip layer.
 *
 * @param {bigint|null} pnlSats
 * @returns {'win'|'loss'|'breakeven'|'unknown'}
 */
export function classifyPnl(pnlSats) {
  if (pnlSats === null) return 'unknown';
  if (pnlSats > 0n) return 'win';
  if (pnlSats < 0n) return 'loss';
  return 'breakeven';
}

/**
 * Parse an ISO-8601 `closed_at` string to ms-since-epoch. Returns
 * `null` for missing / unparseable inputs.
 *
 * Pure — exported for tests.
 *
 * @param {unknown} iso
 * @returns {number|null}
 */
export function parseClosedAt(iso) {
  if (typeof iso !== 'string') return null;
  const t = iso.trim();
  if (t.length === 0) return null;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Case-fold a token-id filter. Lowercases 64-hex inputs, leaves
 * non-hex strings untouched so the route handler can reject them
 * with a clear error.
 *
 * Pure.
 *
 * @param {unknown} tokenId
 * @returns {string|null}
 */
export function normalizeTokenFilter(tokenId) {
  if (tokenId === null || tokenId === undefined) return null;
  if (typeof tokenId !== 'string') return null;
  const t = tokenId.trim();
  if (t.length === 0) return null;
  return t.toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────
//  Core: build the timeseries rows
// ─────────────────────────────────────────────────────────────────────

/**
 * Coerce `closedPositions` into the rows the dashboard plots.
 * Returns:
 *   - `rows`: ascending by `closed_at_ms`, with `cumulative_realized_pnl_sats`
 *     (stringified bigint — JSON-safe) and `cumulative_realized_pnl_bch`
 *     (Number). Each row also carries `kind` ('win'|'loss'|'breakeven'),
 *     `realized_pnl_sats` (string), `realized_pnl_bch`, `token_id`,
 *     `position_id`, `side`, `closed_at`, `reason`, `bch_spent_sats`,
 *     `bch_received_sats`, `fee_sats`.
 *   - `skipped`: count of positions dropped (missing `closed_at`,
 *     missing `realized_pnl_sats`, or filtered out).
 *   - `trades_count`: how many positions contributed rows.
 *   - `realized_total_sats`: bigint final cumulative.
 *
 * Filter args:
 *   - `tokenId` (string|null): if set, only rows for that token
 *     pass (case-folded).
 *   - `sinceMs` (number|null): if set, drops rows with
 *     `closed_at_ms < sinceMs`. NOTE: this filter is applied AFTER
 *     the cumulative computation so the chart's line still starts
 *     from the operator-visible "first close in window", but the
 *     series' leading edge reflects the cumulative P&L as if the
 *     dropped closes had happened. That matches what every trading
 *     dashboard does — "since 30 days ago, my running total was X
 *     and is now Y". An alternative interpretation ("reset to 0 at
 *     the start of the window") is rejected because it lies to the
 *     operator about how the bot is actually performing.
 *
 *   - `nowMs` (number): required if `sinceMs` is set, so the
 *     caller can do `clock() - parseRange(...)` upstream. Not used
 *     by this function.
 *
 * @param {Array<ClosedPositionLike>|null|undefined} closedPositions
 * @param {Object} [opts]
 * @param {string} [opts.tokenId]
 * @param {number} [opts.sinceMs]
 * @param {(reason: string, position: any) => void} [opts.onSkip]
 * @returns {{ rows: Array<Object>, skipped: number, trades_count: number, realized_total_sats: bigint }}
 */
export function buildPnlTimeseries(closedPositions, opts = {}) {
  if (!Array.isArray(closedPositions)) {
    throw new PnlTimeseriesConfigError('buildPnlTimeseries: closedPositions must be an array');
  }
  const onSkip = typeof opts.onSkip === 'function' ? opts.onSkip : null;
  const tokenFilter = normalizeTokenFilter(opts.tokenId);
  const sinceMs = (typeof opts.sinceMs === 'number' && Number.isFinite(opts.sinceMs)) ? opts.sinceMs : null;

  /** @type {Array<{ ts_ms: number, position_id: string, position: any }>} */
  const sortable = [];
  let skipped = 0;
  for (let i = 0; i < closedPositions.length; i += 1) {
    const p = closedPositions[i];
    if (!p || typeof p !== 'object') {
      skipped += 1;
      if (onSkip) onSkip('not_an_object', p);
      continue;
    }
    if (tokenFilter !== null) {
      const pToken = (typeof p.token_id === 'string') ? p.token_id.toLowerCase() : null;
      if (pToken !== tokenFilter) {
        skipped += 1;
        if (onSkip) onSkip('token_filter_miss', p);
        continue;
      }
    }
    const closedAtMs = parseClosedAt(p.closed_at);
    if (closedAtMs === null) {
      skipped += 1;
      if (onSkip) onSkip('missing_or_unparseable_closed_at', p);
      continue;
    }
    // T40 fix: prefer COMPUTING realized P&L from the raw exit
    // economics (`received - spent - fees`) over the stored
    // `exit.realized_pnl_sats` value. The on-disk value can be
    // fake-zero when the supervisor (or a recovery script) over-
    // rides it (e.g. the 2026-09-13 FEW orphan recovery set
    // realized_pnl_sats=0 to unstick the bot from the pre-flight-
    // slippage rejection loop). Trust the raw values: they agree
    // byte-for-byte with `/api/summary#realized.realized_pnl_sats`
    // which uses the same `realizedPnlSats()` helper. Stored
    // value remains the fallback when raw spent/received are
    // missing (older positions, synthetic recovery rows).
    let pnl = null;
    let pnlSource = 'unknown';
    try {
      const computed = computeRealizedPnlSats(p, p.exit ?? {});
      if (computed && computed.net !== null) {
        pnl = computed.net;
        pnlSource = 'computed';
      } else {
        pnl = toSatsBig(p?.exit?.realized_pnl_sats ?? null);
        pnlSource = 'stored';
      }
    } catch (_e) {
      pnl = toSatsBig(p?.exit?.realized_pnl_sats ?? null);
      pnlSource = 'stored';
    }
    if (pnl === null) {
      skipped += 1;
      if (onSkip) onSkip('missing_realized_pnl_sats', p);
      continue;
    }
    const pid = (typeof p.id === 'string' && p.id.length > 0) ? p.id : `pos_index_${i}`;
    sortable.push({ ts_ms: closedAtMs, position_id: pid, position: p, pnl, pnl_source: pnlSource });
  }

  // Stable sort by (ts_ms asc, position_id asc). Stable sort + a
  // secondary key prevents the cumsum from jittering when two
  // trades share the same closed_at millisecond.
  sortable.sort((a, b) => {
    if (a.ts_ms !== b.ts_ms) return a.ts_ms - b.ts_ms;
    if (a.position_id < b.position_id) return -1;
    if (a.position_id > b.position_id) return 1;
    return 0;
  });

  let cumulative = 0n;
  /** @type {Array<Object>} */
  const rows = [];
  for (const s of sortable) {
    if (sinceMs !== null && s.ts_ms < sinceMs) {
      // Cumulative keeps accumulating through dropped (out-of-window)
      // closes — see the docstring for the rationale. The drop
      // counts toward `skipped` so the dashboard can break down
      // by reason.
      cumulative += s.pnl;
      skipped += 1;
      if (onSkip) onSkip('since_window_miss', s.position);
      continue;
    }
    cumulative += s.pnl;
    const p = s.position;
    const entrySpent = toSatsBig(p?.entry?.bch_spent_sats ?? null);
    const exitReceived = toSatsBig(p?.exit?.bch_received_sats ?? null);
    const entryFee = toSatsBig(p?.entry?.fee_sats ?? null);
    const exitFee = toSatsBig(p?.exit?.fee_sats ?? null);
    const totalFeeSats = (entryFee ?? 0n) + (exitFee ?? 0n);
    rows.push({
      ts: new Date(s.ts_ms).toISOString(),
      ts_ms: s.ts_ms,
      position_id: s.position_id,
      token_id: typeof p.token_id === 'string' ? p.token_id : null,
      token_symbol: typeof p.token_symbol === 'string' ? p.token_symbol : null,
      side: typeof p.side === 'string' ? p.side : null,
      closed_at: typeof p.closed_at === 'string' ? p.closed_at : null,
      reason: typeof p?.exit?.reason === 'string' ? p.exit.reason : null,
      pnl_source: typeof s.pnl_source === 'string' ? s.pnl_source : 'unknown',
      realized_pnl_sats: s.pnl.toString(),
      realized_pnl_bch: Number(s.pnl) / Number(SATS_PER_BCH),
      cumulative_realized_pnl_sats: cumulative.toString(),
      cumulative_realized_pnl_bch: Number(cumulative) / Number(SATS_PER_BCH),
      bch_spent_sats: entrySpent !== null ? entrySpent.toString() : null,
      bch_received_sats: exitReceived !== null ? exitReceived.toString() : null,
      fee_sats: totalFeeSats.toString(),
      kind: classifyPnl(s.pnl),
    });
  }

  return {
    rows,
    skipped,
    trades_count: rows.length,
    realized_total_sats: cumulative,
  };
}

/**
 * Build the dashboard's `/api/pnl-timeseries` envelope. Wraps
 * `buildPnlTimeseries` and prepends schema/version/count/range
 * metadata so the React UI can render with no client-side massaging.
 *
 * Pure.
 *
 * @param {Array<ClosedPositionLike>|null|undefined} closedPositions
 * @param {Object} [opts]
 * @param {string} [opts.tokenId]
 * @param {number} [opts.sinceMs]
 * @param {number} [opts.rangeMs]    the range in ms (for the envelope's `range` field)
 * @param {string} [opts.rangeLabel]  the range label (e.g. '30d', '7d', 'all') for the envelope
 * @param {(reason: string, position: any) => void} [opts.onSkip]
 * @returns {{
 *   schema: string,
 *   ts: string,
 *   range: string,
 *   range_ms: number|null,
 *   token_id: string|null,
 *   count: number,
 *   trades_count: number,
 *   skipped: number,
 *   realized_total_sats: string,
 *   realized_total_bch: number,
 *   first_close_ts: string|null,
 *   last_close_ts: string|null,
 *   rows: Array<Object>,
 * }}
 */
export function buildPnlTimeseriesResponse(closedPositions, opts = {}) {
  const rangeMs = (typeof opts.rangeMs === 'number' && Number.isFinite(opts.rangeMs)) ? opts.rangeMs : null;
  const rangeLabel = (typeof opts.rangeLabel === 'string' && opts.rangeLabel.length > 0)
    ? opts.rangeLabel
    : (rangeMs === null ? 'all' : `${Math.round(rangeMs / 1000)}s`);
  const tokenId = (typeof opts.tokenId === 'string' && opts.tokenId.length > 0) ? opts.tokenId : null;
  const out = buildPnlTimeseries(closedPositions, {
    tokenId,
    sinceMs: opts.sinceMs,
    onSkip: opts.onSkip,
  });
  return {
    schema: 'tradebot.dashboard.pnl-timeseries/v1',
    ts: new Date().toISOString(),
    range: rangeLabel,
    range_ms: rangeMs,
    token_id: tokenId,
    count: out.rows.length,
    trades_count: out.trades_count,
    skipped: out.skipped,
    realized_total_sats: out.realized_total_sats.toString(),
    realized_total_bch: Number(out.realized_total_sats) / Number(SATS_PER_BCH),
    first_close_ts: out.rows.length > 0 ? out.rows[0].ts : null,
    last_close_ts: out.rows.length > 0 ? out.rows[out.rows.length - 1].ts : null,
    rows: out.rows,
  };
}
