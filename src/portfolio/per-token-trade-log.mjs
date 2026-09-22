#!/usr/bin/env node
// src/portfolio/per-token-trade-log.mjs
//
// Per-token trade-log aggregator for TradeBot.
//
// One missing affordance the operator hit on 2026-09-17 with the
// FURU cascade: 8 open FURU positions, no easy way to answer
// "what did the bot actually do with FURU" without grepping
// `data/history.jsonl` by hand. The `/api/trade-history` endpoint
// already gives a flat per-event stream; this module rolls it up
// PER TOKEN so a future React tile (subset 2) can render one card
// per token with closed-trade attribution + open-position list.
//
// Three layers:
//
//   1. **Grouping** — `groupEventsByToken(events)` walks the
//      history events and buckets them by `token_id`, separating
//      `kind:'entry'` events from `kind:'exit'` events. Pure.
//
//   2. **Attribution** — `attributionForClosedPosition(position,
//      exitEvent?)` produces the per-trade P&L envelope that
//      matches `src/portfolio/pnl.mjs`'s `realizedPnlSats()`
//      output exactly (operator can cross-check against the
//      DASHBOARD "cumulative realized P&L" chart).
//
//   3. **Roll-up** — `buildPerTokenSummary({events, positions,
//      tokenId, opts})` and `listPerTokenSummaries({events,
//      positions, opts})` produce the per-token envelope the
//      `/api/tokens/summary` endpoint serializes.
//
// Design rules (also see docs/ARCHITECTURE.md §3 + §5):
//
//   1. **Pure.** No I/O. No logger. No globals. Every helper
//      takes the data it needs as an argument and returns a typed
//      plain-JS object. The dashboard wires the I/O seam.
//
//   2. **Defensive at every boundary.** A null exit on a closed
//      position returns `outcome:'unknown'` rather than crashing;
//      a malformed event is dropped (with a typed
//      `DroppedEventError` thrown so the caller can decide to
//      log + continue or surface a 400); a missing token_id is
//      classified as a `token_group_other` bucket so the rest of
//      the rollup stays intact.
//
//   3. **Sats are the unit.** Every money number is normalized
//      to either integer sats (string-typed) or a BigInt. BCH
//      conversions go through `satsToBch` so the wire format
//      stays consistent with the rest of the bot.
//
//   4. **Wire shape matches `pnl.mjs`.** The realized-PnL numbers
//      here MUST match `summarize(closedPositions).realized_pnl_sats`
//      (modulo BigInt→string coercion) so the operator can audit
//      the per-token breakdown against the global line on the
//      DASHBOARD chart.
//
//   5. **No hard-coded knobs.** All thresholds (default win/loss
//      classification epsilon, default nowMs injection, etc.) are
//      either `DEFAULT_*` constants exported here or accepted
//      via `opts`.
//
// Origin: T63 (this commit) — `idea_seed_per_token_trade_log`
// was filed 2026-09-14; this module ships subset 1 (backend +
// endpoint). Subset 2 (React tile + drill-down) deferred.

// ─────────────────────────────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────────────────────────────

/** Schema constant for the wire envelope. */
export const TOKENS_SUMMARY_SCHEMA = 'tradebot.dashboard.tokens-summary/v1';

/**
 * `realized_pnl_sats` values within +/- this many sats of zero are
 * classified as `'breakeven'` (so a position that round-trips net
 * of fees to 1 sat doesn't get counted as a win).
 */
export const DEFAULT_BREAKEVEN_EPSILON_SATS = 1n;

/**
 * Outcome classification for a single closed trade.
 *   - `'gain'`     — net_pnl_sats >  epsilon
 *   - `'loss'`     — net_pnl_sats < -epsilon
 *   - `'breakeven'`— |net_pnl_sats| <= epsilon
 *   - `'unknown'`  — net_pnl_sats is null (missing data)
 */
export const OUTCOME_KINDS = Object.freeze(['gain', 'loss', 'breakeven', 'unknown']);

/**
 * Marker bucket name for events with missing / malformed token_id.
 * Surfaces in the rollup list as `__missing_token_id__` so the
 * operator can see the gap but the per-token summaries stay clean.
 */
export const MISSING_TOKEN_BUCKET = '__missing_token_id__';

// ─────────────────────────────────────────────────────────────────────
//  Errors
// ─────────────────────────────────────────────────────────────────────

/**
 * Thrown when the caller passes a malformed event / position that
 * the rest of the pipeline can't recover from. The dashboard
 * surfaces this as HTTP 400.
 */
export class TradeLogArgError extends Error {
  /**
   * @param {string} message
   * @param {Object} [opts]
   * @param {string} [opts.kind]  e.g. 'events_not_array'
   * @param {*}      [opts.value]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = 'TradeLogArgError';
    this.kind = opts.kind || 'invalid_arg';
    this.value = opts.value;
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Pure helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Coerce a numeric value to a BigInt-or-null. Mirrors
 * `src/portfolio/pnl.mjs#toSats` semantics but kept local so this
 * module has zero cross-module coupling.
 *
 *   toSatsBigInt(null)         → null
 *   toSatsBigInt(undefined)    → null
 *   toSatsBigInt(0)            → 0n
 *   toSatsBigInt(100)          → 100n
 *   toSatsBigInt('500000')     → 500000n  (string of int)
 *   toSatsBigInt('500000.5')   → null     (fractional not allowed)
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
    // Reject fractions + exponent notation explicitly.
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
 * Convert sats (BigInt / number / string) to a BCH decimal string
 * with 8 decimal places. Negative values render with a leading `-`.
 * Null / undefined / NaN / non-finite input returns null.
 *
 *   satsToBch(null)            → null
 *   satsToBch(100000000n)      → '1.00000000'
 *   satsToBch(150000000n)      → '1.50000000'
 *   satsToBch(-50000000n)      → '-0.50000000'
 *   satsToBch(1n)              → '0.00000001'
 *   satsToBch(0n)              → '0.00000000'
 *   satsToBch(123)             → '0.00000123'
 *
 * @param {*} sats
 * @returns {string|null}
 */
export function satsToBch(sats) {
  const bi = toSatsBigInt(sats);
  if (bi === null) return null;
  const negative = bi < 0n;
  const abs = negative ? -bi : bi;
  // Split integer + fractional parts. 1 BCH = 100_000_000 sats.
  const whole = abs / 100_000_000n;
  const frac = abs % 100_000_000n;
  const fracStr = frac.toString().padStart(8, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fracStr}`;
}

/**
 * Compute hold-time in ms between two ISO-8601 timestamps.
 * Both null / undefined / unparseable → null. Same as the entry
 * leg / exit leg of the position.
 *
 *   computeHoldMs(null, null)               → null
 *   computeHoldMs('2026-09-13T19:44:52Z', null) → null
 *   computeHoldMs(null, '2026-09-14T06:18:08Z') → null
 *   computeHoldMs('2026-09-13T19:44:52Z', '2026-09-14T06:18:08Z') → 37996116
 *
 * @param {string|null|undefined} startIso
 * @param {string|null|undefined} endIso
 * @returns {number|null}
 */
export function computeHoldMs(startIso, endIso) {
  if (typeof startIso !== 'string' || typeof endIso !== 'string') return null;
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  const diff = endMs - startMs;
  if (!Number.isFinite(diff)) return null;
  return diff;
}

/**
 * Classify a closed-trade outcome from net realized P&L (sats).
 *
 *   classifyOutcome(null, {epsilon:1n})  → 'unknown'
 *   classifyOutcome(0n, {epsilon:1n})    → 'breakeven'
 *   classifyOutcome(1n, {epsilon:1n})    → 'breakeven'  (within epsilon)
 *   classifyOutcome(2n, {epsilon:1n})    → 'gain'
 *   classifyOutcome(-2n, {epsilon:1n})   → 'loss'
 *   classifyOutcome(100n, {epsilon:1n})  → 'gain'
 *
 * @param {bigint|null|undefined} netPnlSats
 * @param {Object} [opts]
 * @param {bigint} [opts.epsilon=DEFAULT_BREAKEVEN_EPSILON_SATS]
 * @returns {'gain'|'loss'|'breakeven'|'unknown'}
 */
export function classifyOutcome(netPnlSats, opts = {}) {
  const epsilon = toSatsBigInt(opts.epsilon ?? DEFAULT_BREAKEVEN_EPSILON_SATS) ?? 0n;
  if (netPnlSats === null || netPnlSats === undefined) return 'unknown';
  const bi = toSatsBigInt(netPnlSats);
  if (bi === null) return 'unknown';
  if (bi > epsilon) return 'gain';
  if (bi < -epsilon) return 'loss';
  return 'breakeven';
}

/**
 * Validate the input event shape. Returns the bucket name
 * (token_id, or MISSING_TOKEN_BUCKET for malformed). Null entries
 * always bucket to MISSING_TOKEN_BUCKET.
 *
 *   bucketForEvent(null)                               → '__missing_token_id__'
 *   bucketForEvent({})                                 → '__missing_token_id__'
 *   bucketForEvent({kind:'tick'})                      → '__missing_token_id__'  (kind with no token_id)
 *   bucketForEvent({kind:'entry',token_id:'abc'})      → 'abc'
 *   bucketForEvent({kind:'entry',token_id:123})        → '__missing_token_id__'  (non-string)
 *
 * @param {*} event
 * @returns {string}
 */
export function bucketForEvent(event) {
  if (event === null || typeof event !== 'object') return MISSING_TOKEN_BUCKET;
  const tid = event.token_id;
  if (typeof tid !== 'string' || tid.length === 0) return MISSING_TOKEN_BUCKET;
  return tid;
}

// ─────────────────────────────────────────────────────────────────────
//  Grouping
// ─────────────────────────────────────────────────────────────────────

/**
 * Walk the history events list and bucket by token_id. Each bucket
 * carries the entry events + exit events separately so downstream
 * attribution can pair them up by `position_id`.
 *
 * Returns a `Map<token_id, {entries, exits, skipped_count}>` where:
 *   - `entries[]`  — every event with `kind === 'entry'`
 *   - `exits[]`    — every event with `kind === 'exit'`
 *   - `skipped_count` — events that landed in this bucket but
 *                       weren't `entry`/`exit` (e.g. a
 *                       `kind:'entry_skipped'` that came with a
 *                       token_id). Surfaced in the per-token
 *                       envelope as a count so the operator can
 *                       see how many events were ignored.
 *
 * The MISSING_TOKEN_BUCKET catches events with a missing / non-string
 * token_id so the rest of the rollup stays clean.
 *
 * @param {Array<Object>} events
 * @returns {Map<string, {entries: Object[], exits: Object[], skipped_count: number, skipped_kinds: Record<string, number>}>}
 */
export function groupEventsByToken(events) {
  if (!Array.isArray(events)) {
    throw new TradeLogArgError('groupEventsByToken: events must be an array', {
      kind: 'events_not_array',
      value: typeof events,
    });
  }
  /** @type {Map<string, {entries: Object[], exits: Object[], skipped_count: number, skipped_kinds: Record<string, number>}>} */
  const out = new Map();
  for (const ev of events) {
    const bucket = bucketForEvent(ev);
    if (!out.has(bucket)) {
      out.set(bucket, { entries: [], exits: [], skipped_count: 0, skipped_kinds: {} });
    }
    const slot = /** @type {any} */ (out.get(bucket));
    if (ev && typeof ev === 'object') {
      const kind = ev.kind;
      // Only push entry/exit to the bucket's typed arrays when the
      // bucket is a real token_id; events that bucketed to the
      // MISSING_TOKEN_BUCKET sentinel count as skipped even when
      // they have a valid `kind` — otherwise the missing-bucket
      // would accumulate junk entries that the per-token rollup
      // could mistake for real position-attribution data.
      if (bucket !== MISSING_TOKEN_BUCKET && kind === 'entry') {
        slot.entries.push(ev);
      } else if (bucket !== MISSING_TOKEN_BUCKET && kind === 'exit') {
        slot.exits.push(ev);
      } else {
        slot.skipped_count += 1;
        slot.skipped_kinds[kind ?? 'null'] = (slot.skipped_kinds[kind ?? 'null'] ?? 0) + 1;
      }
    } else {
      slot.skipped_count += 1;
      slot.skipped_kinds['null'] = (slot.skipped_kinds['null'] ?? 0) + 1;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
//  Per-trade attribution
// ─────────────────────────────────────────────────────────────────────

/**
 * Pure — build the closed-trade attribution envelope for ONE
 * position. Mirrors `realizedPnlSats()` from `pnl.mjs` so the
 * numbers cross-check against the DASHBOARD chart. Returns null
 * fields (never throws) for missing data so the rollup survives
 * partial / corrupted positions.
 *
 * Returned shape:
 *   {
 *     position_id:       string|null,
 *     token_id:          string|null,
 *     entry_ts:          string|null,
 *     exit_ts:           string|null,
 *     hold_ms:           number|null,
 *     exit_kind:         string|null,
 *     entry_event:       Object|null,
 *     exit_event:        Object|null,
 *     cost_basis_sats:   bigint|null,
 *     exit_value_sats:   bigint|null,
 *     entry_fee_sats:    bigint|null,
 *     exit_fee_sats:     bigint|null,
 *     fees_sats_total:   bigint|null,
 *     gross_pnl_sats:    bigint|null,
 *     net_pnl_sats:      bigint|null,
 *     net_pnl_bch:       string|null,
 *     net_pnl_pct_of_cost: number|null,
 *     outcome:           'gain'|'loss'|'breakeven'|'unknown',
 *   }
 *
 * @param {Object} position        a Position entry (open OR closed)
 * @param {Object|null} [exitEvent=null]   a history `kind:'exit'` event (null for open positions)
 * @param {Object} [opts]
 * @param {bigint} [opts.epsilon=DEFAULT_BREAKEVEN_EPSILON_SATS]
 * @returns {Object}
 */
export function attributionForClosedPosition(position, exitEvent = null, opts = {}) {
  const epsilon = toSatsBigInt(opts.epsilon ?? DEFAULT_BREAKEVEN_EPSILON_SATS) ?? 0n;
  const safePos = position && typeof position === 'object' ? position : null;
  const safeExit = exitEvent && typeof exitEvent === 'object' ? exitEvent : null;

  const positionId = safePos && typeof safePos.id === 'string' ? safePos.id : null;
  const tokenId = safePos && typeof safePos.token_id === 'string' ? safePos.token_id : null;
  const entryTs = safePos?.entry?.ts ?? null;
  const exitTs = safeExit?.ts ?? null;
  const holdMs = computeHoldMs(entryTs, exitTs);
  const exitKind = safeExit && typeof safeExit.exit_kind === 'string' ? safeExit.exit_kind : null;

  const costBasis = toSatsBigInt(safePos?.entry?.bch_spent_sats);
  const entryFee = toSatsBigInt(safePos?.entry?.fee_sats);
  const exitValue = toSatsBigInt(safeExit?.bch_received_sats);
  const exitFee = toSatsBigInt(safeExit?.fee_sats);

  let gross = null;
  let net = null;
  if (costBasis !== null && exitValue !== null) {
    gross = exitValue - costBasis;
    const totalFees =
      (entryFee === null ? 0n : entryFee) +
      (exitFee === null ? 0n : exitFee);
    net = gross - totalFees;
  }
  const feesTotal =
    entryFee === null && exitFee === null
      ? null
      : (entryFee ?? 0n) + (exitFee ?? 0n);

  const netPctOfCost =
    net !== null && costBasis !== null && costBasis > 0n
      ? Number((net * 10_000n) / costBasis) / 100  // pct with 2 decimals
      : null;

  return {
    position_id: positionId,
    token_id: tokenId,
    entry_ts: entryTs,
    exit_ts: exitTs,
    hold_ms: holdMs,
    exit_kind: exitKind,
    entry_event: safePos ? safePos.entry ?? null : null,
    exit_event: safeExit,
    cost_basis_sats: costBasis,
    exit_value_sats: exitValue,
    entry_fee_sats: entryFee,
    exit_fee_sats: exitFee,
    fees_sats_total: feesTotal,
    gross_pnl_sats: gross,
    net_pnl_sats: net,
    net_pnl_bch: satsToBch(net),
    net_pnl_pct_of_cost: netPctOfCost,
    outcome: classifyOutcome(net, { epsilon }),
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Roll-ups
// ─────────────────────────────────────────────────────────────────────

/**
 * Reduce an array of closed-trade attributions to the per-token
 * totals the dashboard surfaces on the rollup row.
 *
 *   {
 *     closed_trade_count:    number,
 *     realized_pnl_sats:     bigint|null,
 *     total_bch_in_sats:     bigint|null,    sum of entry.bch_spent_sats
 *     total_bch_out_sats:    bigint|null,    sum of exit.bch_received_sats
 *     total_fees_sats:       bigint|null,    entry + exit fees
 *     total_token_volume_base: bigint|null,  sum of entry.token_amount_base
 *     win_count:             number,
 *     loss_count:            number,
 *     breakeven_count:       number,
 *     unknown_count:         number,
 *     total_hold_ms:         number|null,    null if any hold is missing
 *     mean_hold_ms:          number|null,    null if total_hold is null
 *   }
 *
 * @param {Array<Object>} closedTrades
 * @returns {Object}
 */
export function aggregateTotals(closedTrades) {
  const result = {
    closed_trade_count: 0,
    realized_pnl_sats: 0n,
    total_bch_in_sats: 0n,
    total_bch_out_sats: 0n,
    total_fees_sats: 0n,
    total_token_volume_base: 0n,
    win_count: 0,
    loss_count: 0,
    breakeven_count: 0,
    unknown_count: 0,
    total_hold_ms: 0n,
    mean_hold_ms: null,
  };
  if (!Array.isArray(closedTrades) || closedTrades.length === 0) {
    // Keep the BigInt zeros for downstream sum-aggregation. `mean_hold_ms`
    // stays null because we have nothing to average over.
    return result;
  }
  result.closed_trade_count = closedTrades.length;
  let allHoldsPresent = true;
  for (const t of closedTrades) {
    if (t?.net_pnl_sats !== null && t?.net_pnl_sats !== undefined) {
      result.realized_pnl_sats += t.net_pnl_sats;
    }
    if (t?.cost_basis_sats !== null && t?.cost_basis_sats !== undefined) {
      result.total_bch_in_sats += t.cost_basis_sats;
    }
    if (t?.exit_value_sats !== null && t?.exit_value_sats !== undefined) {
      result.total_bch_out_sats += t.exit_value_sats;
    }
    if (t?.fees_sats_total !== null && t?.fees_sats_total !== undefined) {
      result.total_fees_sats += t.fees_sats_total;
    }
    if (t?.entry_event?.token_amount_base !== undefined && t?.entry_event?.token_amount_base !== null) {
      const vol = toSatsBigInt(t.entry_event.token_amount_base);
      if (vol !== null) result.total_token_volume_base += vol;
    }
    if (t?.outcome === 'gain') result.win_count += 1;
    else if (t?.outcome === 'loss') result.loss_count += 1;
    else if (t?.outcome === 'breakeven') result.breakeven_count += 1;
    else result.unknown_count += 1;
    if (t?.hold_ms === null || t?.hold_ms === undefined) {
      allHoldsPresent = false;
    } else if (allHoldsPresent) {
      result.total_hold_ms += BigInt(Math.trunc(t.hold_ms));
    }
  }
  if (allHoldsPresent && result.closed_trade_count > 0) {
    result.mean_hold_ms = Number(result.total_hold_ms / BigInt(result.closed_trade_count));
  } else {
    result.total_hold_ms = null;
  }
  return result;
}

/**
 * Compute the realized-PnL win rate as a fraction [0..1].
 * Returns null when there are no closed trades (the denominator
 * is zero — operator would render this as '—').
 *
 *   computeWinRate({win_count:3, loss_count:1, breakeven_count:1, ...}) → 0.75
 *   computeWinRate({win_count:0, loss_count:0, breakeven_count:0, ...}) → null
 *   computeWinRate({win_count:0, loss_count:0, breakeven_count:1, ...}) → 0
 *
 * @param {Object} totals   output of `aggregateTotals`
 * @returns {number|null}
 */
export function computeWinRate(totals) {
  if (!totals || typeof totals !== 'object') return null;
  const denom = totals.win_count + totals.loss_count + totals.breakeven_count;
  if (denom === 0) return null;
  return totals.win_count / denom;
}

/**
 * Build the per-token summary for ONE token. Accepts the full
 * `events` list + the full `positions` list (open + closed) +
 * the `tokenId` to focus on. Returns the full envelope with
 * closed_trades[] + open_positions[] populated.
 *
 * @param {Object} args
 * @param {Array<Object>} args.events
 * @param {Array<Object>} args.positions    open + closed positions for the bot
 * @param {string}      args.tokenId        64-hex token_id
 * @param {Object}      [args.opts]
 * @param {bigint}      [args.opts.epsilon=DEFAULT_BREAKEVEN_EPSILON_SATS]
 * @param {number|null} [args.opts.nowMs=null]    injected now (for tests); null = use system clock
 * @returns {Object}
 */
export function buildPerTokenSummary({ events, positions, tokenId, opts = {} }) {
  if (!Array.isArray(events)) {
    throw new TradeLogArgError('buildPerTokenSummary: events must be an array', {
      kind: 'events_not_array',
      value: typeof events,
    });
  }
  if (!Array.isArray(positions)) {
    throw new TradeLogArgError('buildPerTokenSummary: positions must be an array', {
      kind: 'positions_not_array',
      value: typeof positions,
    });
  }
  if (typeof tokenId !== 'string' || tokenId.length === 0) {
    throw new TradeLogArgError('buildPerTokenSummary: tokenId required (non-empty string)', {
      kind: 'token_id_required',
      value: tokenId,
    });
  }
  const epsilon = toSatsBigInt(opts.epsilon ?? DEFAULT_BREAKEVEN_EPSILON_SATS) ?? 0n;
  const nowMs = typeof opts.nowMs === 'number' && Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();

  const grouped = groupEventsByToken(events);
  const bucket = grouped.get(tokenId) ?? { entries: [], exits: [], skipped_count: 0, skipped_kinds: {} };
  const myPositions = positions.filter(
    (p) => p && typeof p === 'object' && p.token_id === tokenId,
  );

  // Build a quick lookup from position_id → exit event so the
  // attribution loop can pair them up without scanning the exits
  // list N times.
  const exitByPositionId = new Map();
  for (const ev of bucket.exits) {
    if (typeof ev?.position_id === 'string') exitByPositionId.set(ev.position_id, ev);
  }

  const closedTrades = [];
  const openPositions = [];

  // Walk the on-disk positions list (NOT the history events) so the
  // per-token breakdown matches the global realized P&L line on the
  // DASHBOARD chart (which also sources from `positions.json#closed`).
  for (const pos of myPositions) {
    const exitEv = typeof pos?.id === 'string' ? exitByPositionId.get(pos.id) ?? null : null;
    const hasExitOnPos = pos?.exit && typeof pos.exit === 'object';
    // Use the on-disk exit envelope when the history event is missing
    // (orphan close path / manual reconcile) — both encode the same data.
    const exitForAttribution = exitEv ?? (hasExitOnPos ? { ts: pos.exit.ts, exit_kind: pos.exit.exit_kind, bch_received_sats: pos.exit.bch_received_sats, fee_sats: pos.exit.fee_sats } : null);
    const isClosed = !!hasExitOnPos || (pos?.status === 'closed') || exitEv !== null;
    if (isClosed && exitForAttribution) {
      closedTrades.push(attributionForClosedPosition(pos, exitForAttribution, { epsilon }));
    } else if (pos?.entry) {
      const entryTs = pos.entry?.ts ?? null;
      const entryMs = typeof entryTs === 'string' ? Date.parse(entryTs) : null;
      const ageMs = entryMs !== null && Number.isFinite(entryMs) ? Math.max(0, nowMs - entryMs) : null;
      openPositions.push({
        position_id: typeof pos.id === 'string' ? pos.id : null,
        entry_ts: entryTs,
        age_ms: ageMs,
        side: typeof pos.side === 'string' ? pos.side : null,
        size_bch: typeof pos.entry?.bch_spent_sats !== 'undefined'
          ? satsToBch(pos.entry.bch_spent_sats)
          : null,
        cost_basis_sats: toSatsBigInt(pos.entry?.bch_spent_sats),
        fee_sats: toSatsBigInt(pos.entry?.fee_sats),
        token_amount_base: toSatsBigInt(pos.entry?.token_amount_base),
        entry_event: pos.entry ?? null,
      });
    }
  }

  // Sort newest-first by entry_ts.
  const byEntryTsDesc = (a, b) => {
    const aMs = typeof a.entry_ts === 'string' ? Date.parse(a.entry_ts) : 0;
    const bMs = typeof b.entry_ts === 'string' ? Date.parse(b.entry_ts) : 0;
    if (Number.isNaN(aMs) && Number.isNaN(bMs)) return 0;
    if (Number.isNaN(aMs)) return 1;
    if (Number.isNaN(bMs)) return -1;
    return bMs - aMs;
  };
  closedTrades.sort(byEntryTsDesc);
  openPositions.sort(byEntryTsDesc);

  const totals = aggregateTotals(closedTrades);
  const winRate = computeWinRate(totals);

  // First / last event ts across BOTH closed and open, for the dashboard header.
  const allTs = [];
  for (const t of closedTrades) {
    if (typeof t.entry_ts === 'string') allTs.push(t.entry_ts);
    if (typeof t.exit_ts === 'string') allTs.push(t.exit_ts);
  }
  for (const o of openPositions) {
    if (typeof o.entry_ts === 'string') allTs.push(o.entry_ts);
  }
  allTs.sort();
  const firstEventTs = allTs[0] ?? null;
  const lastEventTs = allTs[allTs.length - 1] ?? null;

  // Symbol / decimals — pick from the first position that has them populated.
  const symbol = myPositions.find((p) => typeof p?.token_symbol === 'string')?.token_symbol ?? null;
  const decimals = myPositions.find((p) => typeof p?.token_decimals === 'number')?.token_decimals ?? null;

  return {
    schema: TOKENS_SUMMARY_SCHEMA,
    token_id: tokenId,
    symbol,
    decimals,
    entry_count: bucket.entries.length,
    exit_count: bucket.exits.length,
    skipped_event_count: bucket.skipped_count,
    skipped_event_kinds: { ...bucket.skipped_kinds },
    closed_trade_count: totals.closed_trade_count,
    open_position_count: openPositions.length,
    total_bch_in_sats: totals.total_bch_in_sats,
    total_bch_out_sats: totals.total_bch_out_sats,
    total_fees_sats: totals.total_fees_sats,
    total_token_volume_base: totals.total_token_volume_base,
    realized_pnl_sats: totals.realized_pnl_sats,
    realized_pnl_bch: satsToBch(totals.realized_pnl_sats),
    win_count: totals.win_count,
    loss_count: totals.loss_count,
    breakeven_count: totals.breakeven_count,
    unknown_count: totals.unknown_count,
    win_rate: winRate,
    total_hold_ms: totals.total_hold_ms,
    mean_hold_ms: totals.mean_hold_ms,
    first_event_ts: firstEventTs,
    last_event_ts: lastEventTs,
    closed_trades: closedTrades,
    open_positions: openPositions,
  };
}

/**
 * Build the rollup list (one row per token + the MISSING_TOKEN_BUCKET
 * if any events lacked a token_id) for the dashboard.
 *
 * The list is sorted by `realized_pnl_sats` DESC (most profitable
 * first) so the operator sees the winning tokens at the top.
 *
 * @param {Object} args
 * @param {Array<Object>} args.events
 * @param {Array<Object>} args.positions
 * @param {Object}      [args.opts]
 * @param {string}      [args.opts.excludeBucket=MISSING_TOKEN_BUCKET]  bucket name to omit from rollup
 * @returns {Object}        the per-token list envelope
 */
export function listPerTokenSummaries({ events, positions, opts = {} }) {
  if (!Array.isArray(events)) {
    throw new TradeLogArgError('listPerTokenSummaries: events must be an array', {
      kind: 'events_not_array',
      value: typeof events,
    });
  }
  if (!Array.isArray(positions)) {
    throw new TradeLogArgError('listPerTokenSummaries: positions must be an array', {
      kind: 'positions_not_array',
      value: typeof positions,
    });
  }
  const excludeBucket = typeof opts.excludeBucket === 'string' ? opts.excludeBucket : MISSING_TOKEN_BUCKET;
  const grouped = groupEventsByToken(events);
  const tokenIds = [];
  for (const tid of grouped.keys()) {
    if (tid !== excludeBucket) tokenIds.push(tid);
  }
  // Stable-sort by token_id ASC when no positions have non-zero PnL.
  tokenIds.sort();

  const summaries = tokenIds.map((tid) => {
    // We pass an empty positions list when the bucket has no entries/exits
    // for the token — the per-token summary handles this gracefully.
    const sub = buildPerTokenSummary({ events, positions, tokenId: tid, opts });
    // Drop the heavy arrays from the rollup row to keep the wire payload
    // small — the dashboard can re-fetch /api/tokens/summary?token_id=...
    // for the full attribution when the operator clicks into a token.
    return {
      token_id: sub.token_id,
      symbol: sub.symbol,
      decimals: sub.decimals,
      entry_count: sub.entry_count,
      exit_count: sub.exit_count,
      closed_trade_count: sub.closed_trade_count,
      open_position_count: sub.open_position_count,
      total_bch_in_sats: sub.total_bch_in_sats,
      total_bch_out_sats: sub.total_bch_out_sats,
      total_fees_sats: sub.total_fees_sats,
      realized_pnl_sats: sub.realized_pnl_sats,
      realized_pnl_bch: sub.realized_pnl_bch,
      win_count: sub.win_count,
      loss_count: sub.loss_count,
      breakeven_count: sub.breakeven_count,
      unknown_count: sub.unknown_count,
      win_rate: sub.win_rate,
      mean_hold_ms: sub.mean_hold_ms,
      first_event_ts: sub.first_event_ts,
      last_event_ts: sub.last_event_ts,
    };
  });

  // Sort by realized_pnl_sats DESC; tiebreak by token_id ASC for stability.
  summaries.sort((a, b) => {
    const aPnl = a.realized_pnl_sats;
    const bPnl = b.realized_pnl_sats;
    if (aPnl === bPnl) return a.token_id.localeCompare(b.token_id);
    return aPnl > bPnl ? -1 : 1;
  });

  return {
    schema: TOKENS_SUMMARY_SCHEMA,
    count: summaries.length,
    tokens: summaries,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Self-check
// ─────────────────────────────────────────────────────────────────────

/**
 * Tiny pure check that the per-token breakdown matches the global
 * `summarize(closedPositions).realized_pnl_sats` (modulo BigInt
 * stringification). Returns `{ok:true}` when the totals match,
 * `{ok:false, drift_sats, global_sats, per_token_sats}` otherwise.
 *
 * Catches the case where a future refactor breaks the cross-check
 * invariant — the operator would notice "DASHBOARD says +0.001 BCH
 * but /api/tokens/summary sums to +0.0".
 *
 * @param {Array<Object>} events
 * @param {Array<Object>} positions
 * @returns {{ok: boolean, drift_sats: bigint|null, global_sats: bigint|null, per_token_sats: bigint|null}}
 */
export function selfCheckTotalsMatch({ events, positions }) {
  const tokenList = listPerTokenSummaries({ events, positions });
  let perToken = 0n;
  for (const t of tokenList.tokens) {
    perToken += t.realized_pnl_sats;
  }
  // Global total: walk positions.json#closed manually with the same
  // math `pnl.mjs#summarize` uses so we don't have to import it.
  let global = 0n;
  if (Array.isArray(positions)) {
    for (const p of positions) {
      if (!p || typeof p !== 'object') continue;
      if (!p.exit || typeof p.exit !== 'object') continue;
      const cost = toSatsBigInt(p.entry?.bch_spent_sats);
      const value = toSatsBigInt(p.exit?.bch_received_sats);
      const efee = toSatsBigInt(p.entry?.fee_sats) ?? 0n;
      const xfee = toSatsBigInt(p.exit?.fee_sats) ?? 0n;
      if (cost === null || value === null) continue;
      global += value - cost - efee - xfee;
    }
  }
  const drift = perToken - global;
  return {
    ok: drift === 0n,
    drift_sats: drift,
    global_sats: global,
    per_token_sats: perToken,
  };
}
