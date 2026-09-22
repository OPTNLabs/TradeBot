// dashboard/src/views/pnl-breakdown-helpers.mjs
//
// B01: per-position breakdown helpers for the DASHBOARD's
// "cumulative realized P&L" panel. Renders each closed trade as a
// table row so the operator can verify the cumulative math
// themselves: sum of `realized_pnl_sats` across every row must
// equal the API's `realized_total_sats`, byte-for-byte.
//
// B01 motivation: the operator filed
// `bug-cumulative-p-l-shows-wrong-total-20260916` after the BADGER
// fix landed because the total didn't match the value they
// expected ("-0.00036502 BCH"). The actual current value
// (-0.00036134 BCH) was a follow-on small win from FURU
// (+368 sats) that closed after the BADGER fix — so the user's
// expectation matched the pre-FURU state but not the current one.
// The cleanest fix is to surface the per-position math so the
// operator can verify the total themselves, instead of trusting
// a single black-box number.
//
// Pure — exported for direct unit testing without booting React.
// All numeric helpers are bigint-tolerant because the backend
// serializes sat fields as strings.

/** @typedef {{
 *   ts: string,
 *   ts_ms: number,
 *   position_id: string,
 *   token_id: string|null,
 *   token_symbol: string|null,
 *   side: string|null,
 *   closed_at: string|null,
 *   reason: string|null,
 *   pnl_source: string,
 *   realized_pnl_sats: string,
 *   realized_pnl_bch: number,
 *   cumulative_realized_pnl_sats: string,
 *   cumulative_realized_pnl_bch: number,
 *   bch_spent_sats: string|null,
 *   bch_received_sats: string|null,
 *   fee_sats: string,
 *   kind: 'win'|'loss'|'breakeven'|'unknown',
 * }} PnlTimeseriesRowLike
 */

/**
 * Parse a sat value (string | number | bigint | null | undefined)
 * to a bigint. Returns `null` for missing / non-numeric input.
 *
 * Pure.
 *
 * @param {unknown} v
 * @returns {bigint|null}
 */
export function parseSats(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    return BigInt(Math.round(v));
  }
  if (typeof v === 'string') {
    const t = v.trim();
    if (t.length === 0) return null;
    if (!/^-?\d+$/.test(t)) return null;
    try { return BigInt(t); } catch (_) { return null; }
  }
  return null;
}

/**
 * Coerce a sat amount to a BCH `Number` (Number(sats) / 1e8).
 * Returns `null` for missing / non-numeric input. The `Number`
 * conversion can lose precision for sats > 2^53 (~90M BCH) but
 * the bot's max_total_exposure_bch is 0.04 BCH so we're nowhere
 * near that ceiling — the dashboard's wire shape carries sats as
 * strings specifically to avoid the precision loss, so we only
 * do the division at the display layer.
 *
 * @param {unknown} sats
 * @returns {number|null}
 */
export function satsToBchNumber(sats) {
  const n = parseSats(sats);
  if (n === null) return null;
  return Number(n) / 100_000_000;
}

/**
 * Build the per-position breakdown table from a
 * `/api/pnl-timeseries` response envelope. Each row in the input
 * already carries `realized_pnl_sats` (per-trade) and
 * `cumulative_realized_pnl_sats` (running total), so the
 * breakdown is purely a normalization pass — no math is
 * recomputed here. We sort newest-first so the most-recent
 * trade (the one the operator is usually thinking about) is at
 * the top of the table, but we also expose the cumulative value
 * for each row so the operator can verify it matches the API's
 * top-level `realized_total_sats` (or, equivalently,
 * `/api/summary.realized.realized_pnl_sats`).
 *
 * The function is tolerant of any missing-field garbage so a
 * partial API regression renders an empty breakdown rather than
 * crashing the dashboard.
 *
 * Pure.
 *
 * @param {{
 *   realized_total_sats?: string|number|bigint|null,
 *   realized_total_bch?: number|string|null,
 *   count?: number,
 *   trades_count?: number,
 *   skipped?: number,
 *   rows?: Array<PnlTimeseriesRowLike>,
 * } | null | undefined} pnl
 * @returns {{
 *   rows: Array<{
 *     position_id: string,
 *     token_id: string|null,
 *     token_symbol: string|null,
 *     side: string|null,
 *     closed_at: string|null,
 *     reason: string|null,
 *     pnl_sats: bigint,
 *     pnl_bch: number,
 *     cum_sats: bigint,
 *     cum_bch: number,
 *     pnl_source: string,
 *     kind: 'win'|'loss'|'breakeven'|'unknown',
 *   }>,
 *   total_sats: bigint|null,
 *   total_bch: number|null,
 *   computed_sum_sats: bigint,
 *   match: boolean,
 *   source_count: number,
 *   skipped: number,
 * }}
 */
export function buildCumulativePnlBreakdown(pnl) {
  const empty = {
    rows: [],
    total_sats: null,
    total_bch: null,
    computed_sum_sats: 0n,
    match: false,
    source_count: 0,
    skipped: 0,
  };
  if (!pnl || typeof pnl !== 'object') return empty;
  if (!Array.isArray(pnl.rows) || pnl.rows.length === 0) {
    // Even with no rows we still surface the API-declared total
    // so the operator can see "the chart says zero but the API
    // says -36134" — useful when the chart's filter (e.g. ?range)
    // drops everything but the underlying totals are non-zero.
    const t = parseSats(pnl.realized_total_sats ?? null);
    return {
      ...empty,
      total_sats: t,
      total_bch: typeof pnl.realized_total_bch === 'number' ? pnl.realized_total_bch : (t === null ? null : Number(t) / 1e8),
      skipped: typeof pnl.skipped === 'number' ? pnl.skipped : 0,
    };
  }
  /** @type {Array<any>} */
  const out = [];
  let computedSum = 0n;
  const sources = { computed: 0, stored: 0, unknown: 0 };
  for (const r of pnl.rows) {
    if (!r || typeof r !== 'object') continue;
    const pid = (typeof r.position_id === 'string' && r.position_id.length > 0) ? r.position_id : null;
    if (!pid) continue;
    const pnlSats = parseSats(r.realized_pnl_sats ?? null);
    const cumSats = parseSats(r.cumulative_realized_pnl_sats ?? null);
    if (pnlSats === null) continue;
    computedSum += pnlSats;
    const src = (typeof r.pnl_source === 'string' && r.pnl_source.length > 0) ? r.pnl_source : 'unknown';
    if (Object.prototype.hasOwnProperty.call(sources, src)) sources[src] += 1;
    else sources.unknown += 1;
    out.push({
      position_id: pid,
      token_id: (typeof r.token_id === 'string') ? r.token_id : null,
      token_symbol: (typeof r.token_symbol === 'string' && r.token_symbol.length > 0) ? r.token_symbol : null,
      side: (typeof r.side === 'string') ? r.side : null,
      closed_at: (typeof r.closed_at === 'string') ? r.closed_at : null,
      reason: (typeof r.reason === 'string' && r.reason.length > 0) ? r.reason : null,
      pnl_sats: pnlSats,
      pnl_bch: satsToBchNumber(pnlSats) ?? 0,
      cum_sats: cumSats === null ? pnlSats : cumSats,
      cum_bch: cumSats === null ? (satsToBchNumber(pnlSats) ?? 0) : (satsToBchNumber(cumSats) ?? 0),
      pnl_source: src,
      kind: (typeof r.kind === 'string') ? r.kind : 'unknown',
    });
  }
  // Newest-first so the most-recent trade (where the operator
  // usually looks for confirmation) is at the top.
  out.sort((a, b) => {
    const ax = a.closed_at ? Date.parse(a.closed_at) : 0;
    const bx = b.closed_at ? Date.parse(b.closed_at) : 0;
    if (Number.isFinite(ax) && Number.isFinite(bx) && ax !== bx) return bx - ax;
    if (a.position_id < b.position_id) return -1;
    if (a.position_id > b.position_id) return 1;
    return 0;
  });
  const totalSats = parseSats(pnl.realized_total_sats ?? null);
  const match = (totalSats !== null) && (totalSats === computedSum);
  const totalBch = (typeof pnl.realized_total_bch === 'number')
    ? pnl.realized_total_bch
    : (totalSats === null ? null : Number(totalSats) / 1e8);
  return {
    rows: out,
    total_sats: totalSats,
    total_bch: totalBch,
    computed_sum_sats: computedSum,
    match,
    source_count: sources,
    skipped: typeof pnl.skipped === 'number' ? pnl.skipped : 0,
  };
}

/**
 * Short human label for a `kind` row. Used in the breakdown
 * table's "kind" column. Pure.
 *
 * @param {string} kind
 * @returns {string}
 */
export function kindLabel(kind) {
  switch (kind) {
    case 'win': return 'win';
    case 'loss': return 'loss';
    case 'breakeven': return 'breakeven';
    default: return '—';
  }
}

/**
 * Short human label for a `pnl_source` row. "computed" is the
 * dashboard's preferred source (raw received - spent - fees);
 * "stored" indicates an orphan recovery row where the on-disk
 * `exit.realized_pnl_sats` was used as a fallback. Operators
 * should rarely see "stored" — flag if they do.
 *
 * Pure.
 *
 * @param {string} source
 * @returns {string}
 */
export function pnlSourceLabel(source) {
  switch (source) {
    case 'computed': return 'computed';
    case 'stored': return 'stored (orphan)';
    default: return '—';
  }
}

/**
 * Convenience helper for the React component: short exit-reason
 * summary so the table stays compact. Truncates very long
 * `orphan recovery` exit reasons with an ellipsis so the column
 * doesn't blow out the layout. Pure.
 *
 * @param {string|null|undefined} reason
 * @param {number} [max=40]
 * @returns {string}
 */
export function shortReason(reason, max = 40) {
  if (!reason) return '—';
  const r = String(reason);
  if (r.length <= max) return r;
  return `${r.slice(0, max - 1)}…`;
}

/**
 * Sign-prefixed BCH string for a sat bigint. Used by the
 * breakdown table's "pnl" + "cum" columns. Returns "—" for
 * null/unparseable input.
 *
 * Pure.
 *
 * @param {bigint|null|undefined} sats
 * @param {number} [decimals=8]
 * @returns {string}
 */
export function formatSignedBch(sats, decimals = 8) {
  if (sats === null || sats === undefined) return '—';
  const n = Number(sats) / 1e8;
  if (!Number.isFinite(n)) return '—';
  const sign = sats > 0n ? '+' : (sats < 0n ? '-' : '');
  return `${sign}${Math.abs(n).toFixed(decimals)} BCH`;
}
