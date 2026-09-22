#!/usr/bin/env node
// dashboard/src/views/token-summary-helpers.mjs
//
// T68 — pure formatting helpers for the Dashboard's TokenSummary
// tile. Kept separate from the JSX component so they're importable
// from `node --test` (Node can't parse .jsx files without a loader).
//
// The helpers project the T63 /api/tokens/summary response (both the
// rollup-list envelope `{schema, count, tokens:[…]}` and the
// per-token-detail envelope `{schema, token_id, symbol, …,
// closed_trades[], open_positions[]}`) into the shapes the React
// tile needs: rollup-row → display row, closed-trade attribution →
// display row, open-position attribution → display row, P&L color
// classification, hold-time formatting, win-rate formatting.
//
// Every helper is dependency-free and has no side effects, so each
// one is testable in isolation against fixture data.

const SATS_PER_BCH = 100_000_000n;
const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * Tolerated numeric coerce for sat/bigint/string fields. Returns
 * bigint when parseable, otherwise null. Rejects NaN, Infinity, and
 * non-integer floats. Allows negative values so realized P&L fields
 * (which can legitimately be negative) survive the parse.
 *
 * @param {bigint|number|string|null|undefined} v
 * @returns {bigint|null}
 */
export function safeSats(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    return BigInt(Math.trunc(v));
  }
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (trimmed.length === 0) return null;
    if (!/^-?\d+$/.test(trimmed)) return null;
    try {
      return BigInt(trimmed);
    } catch (_err) {
      return null;
    }
  }
  return null;
}

/**
 * Convert a sat value (bigint / string / number / null) to a BCH
 * number. Returns null for null/undefined/unparseable inputs.
 *
 * @param {bigint|number|string|null|undefined} sats
 * @returns {number|null}
 */
export function satsToBchNumber(sats) {
  const big = safeSats(sats);
  if (big === null) return null;
  // Convert via Number for display purposes; the wire envelope also
  // exposes a BigInt-stringified `realized_pnl_sats` for cross-check.
  const n = Number(big) / Number(SATS_PER_BCH);
  if (!Number.isFinite(n)) return null;
  return n;
}

/**
 * Format a BCH value (as a JS number or sat-string) to a
 * fixed-precision string. Tolerates null / NaN / undefined / string
 * input. Returns '—' for null/undefined/NaN inputs.
 *
 * @param {number|string|null|undefined} v
 * @param {number} [decimals=6]
 * @returns {string}
 */
export function formatBch(v, decimals = 6) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number' && !Number.isFinite(v)) return '—';
  if (typeof v === 'string' && v.trim().length === 0) return '—';
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(decimals);
}

/**
 * Classify a realized-PnL sat value into the visual severity buckets
 * the dashboard uses. Negative → `loss` (red), zero (within the
 * breakeven epsilon) → `breakeven` (gray), positive → `gain` (green).
 * null/undefined → `null`.
 *
 * @param {bigint|number|string|null|undefined} pnlSats
 * @param {Object} [opts]
 * @param {bigint|number|string} [opts.epsilon=0n]
 * @returns {'gain'|'loss'|'breakeven'|null}
 */
export function pnlSeverity(pnlSats, opts = {}) {
  const big = safeSats(pnlSats);
  if (big === null) return null;
  const epsRaw = opts.epsilon;
  let eps = 0n;
  if (typeof epsRaw === 'bigint') eps = epsRaw < 0n ? 0n : epsRaw;
  else if (typeof epsRaw === 'number' && Number.isFinite(epsRaw) && epsRaw >= 0) eps = BigInt(Math.trunc(epsRaw));
  else if (typeof epsRaw === 'string') {
    const parsed = safeSats(epsRaw);
    if (parsed !== null) eps = parsed;
  }
  if (big > eps) return 'gain';
  if (big < -eps) return 'loss';
  return 'breakeven';
}

/**
 * Map a severity bucket to a Tailwind text-color class. Mirrors the
 * conventions used by SnapshotStatsCard / StakingStatusCard.
 *
 * @param {'gain'|'loss'|'breakeven'|null} sev
 * @returns {string}
 */
export function pnlClass(sev) {
  switch (sev) {
    case 'gain': return 'text-emerald-400';
    case 'loss': return 'text-rose-400';
    case 'breakeven': return 'text-ash-400';
    default: return 'text-ash-400';
  }
}

/**
 * Format a hold-time in milliseconds as a human-readable string
 * ("12d 4h", "3h 15m", "12m", "45s"). Returns '—' for null /
 * non-finite / negative.
 *
 * @param {number|null|undefined} ms
 * @returns {string}
 */
export function formatHoldMs(ms) {
  if (ms === null || ms === undefined) return '—';
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < MS_PER_HOUR) return `${Math.round(ms / 60_000)}m`;
  if (ms < MS_PER_DAY) {
    const h = Math.floor(ms / MS_PER_HOUR);
    const m = Math.round((ms - h * MS_PER_HOUR) / 60_000);
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
  }
  const d = Math.floor(ms / MS_PER_DAY);
  const h = Math.round((ms - d * MS_PER_DAY) / MS_PER_HOUR);
  return h === 0 ? `${d}d` : `${d}d ${h}h`;
}

/**
 * Format a win-rate fraction (0..1) as a percentage string with one
 * decimal. Returns '—' for null / out-of-range / non-finite.
 *
 * @param {number|null|undefined} rate
 * @returns {string}
 */
export function formatWinRate(rate) {
  if (rate === null || rate === undefined) return '—';
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return '—';
  if (rate < 0 || rate > 1) return '—';
  return `${(rate * 100).toFixed(1)}%`;
}

/**
 * Shorten a token symbol for table display (cap at maxLen with an
 * ellipsis). Returns the symbol verbatim when short enough or when
 * the symbol is missing. Defensive against non-string input.
 *
 * @param {string|null|undefined} sym
 * @param {number} [maxLen=8]
 * @returns {string}
 */
export function shortSymbol(sym, maxLen = 8) {
  if (typeof sym !== 'string' || sym.length === 0) return '—';
  if (sym.length <= maxLen) return sym;
  return `${sym.slice(0, maxLen - 1)}…`;
}

/**
 * Shorten a token_id to a 6-char prefix + "…" + 4-char suffix for
 * compact display. Defensive against non-string / wrong-length input.
 *
 * @param {string|null|undefined} tokenId
 * @returns {string}
 */
export function shortTokenId(tokenId) {
  if (typeof tokenId !== 'string') return '—';
  if (tokenId.length !== 64) return tokenId.length > 12 ? `${tokenId.slice(0, 6)}…${tokenId.slice(-4)}` : tokenId;
  return `${tokenId.slice(0, 6)}…${tokenId.slice(-4)}`;
}

/**
 * Check whether the rollup envelope is in the "empty" shape —
 * `tokens` array missing or empty. Used by the tile to render a
 * friendly empty-state pill rather than a blank grid.
 *
 * @param {any} env
 * @returns {boolean}
 */
export function isRollupEmpty(env) {
  if (!env || typeof env !== 'object') return true;
  if (!Array.isArray(env.tokens)) return true;
  return env.tokens.length === 0;
}

/**
 * Check whether the per-token-detail envelope is in an "unavailable"
 * state (server-side error). Mirrors the SnapshotStats pattern: the
 * tile should show a friendly pill rather than blanking.
 *
 * @param {any} env
 * @returns {boolean}
 */
export function isDetailUnavailable(env) {
  if (!env || typeof env !== 'object') return true;
  if (typeof env.error === 'string' && env.error.length > 0) return true;
  // Missing required identity fields → treat as unavailable rather
  // than rendering a row of em-dashes.
  if (typeof env.token_id !== 'string' || env.token_id.length === 0) return true;
  return false;
}

/**
 * Build a flat display row from one rollup token entry. Pulls out
 * the fields the table renders + the pre-computed display strings +
 * severity bucket. Defensive against partial / malformed entries.
 *
 * @param {Object} tok
 * @returns {Object}
 */
export function buildRollupRow(tok) {
  const safeTok = tok && typeof tok === 'object' ? tok : {};
  const pnlSats = safeSats(safeTok.realized_pnl_sats);
  const sev = pnlSeverity(pnlSats);
  const totalInSats = safeSats(safeTok.total_bch_in_sats);
  const totalOutSats = safeSats(safeTok.total_bch_out_sats);
  const totalFeesSats = safeSats(safeTok.total_fees_sats);
  const openCount = typeof safeTok.open_position_count === 'number' && Number.isFinite(safeTok.open_position_count)
    ? safeTok.open_position_count
    : 0;
  const closedCount = typeof safeTok.closed_trade_count === 'number' && Number.isFinite(safeTok.closed_trade_count)
    ? safeTok.closed_trade_count
    : 0;
  return {
    token_id: typeof safeTok.token_id === 'string' ? safeTok.token_id : null,
    symbol: typeof safeTok.symbol === 'string' ? safeTok.symbol : null,
    decimals: typeof safeTok.decimals === 'number' && Number.isFinite(safeTok.decimals) ? safeTok.decimals : null,
    shortSymbol: shortSymbol(safeTok.symbol),
    shortTokenId: shortTokenId(safeTok.token_id),
    entry_count: typeof safeTok.entry_count === 'number' ? safeTok.entry_count : 0,
    exit_count: typeof safeTok.exit_count === 'number' ? safeTok.exit_count : 0,
    closed_trade_count: closedCount,
    open_position_count: openCount,
    pnl_sats: pnlSats,
    pnl_bch: satsToBchNumber(pnlSats),
    pnl_bch_display: formatBch(satsToBchNumber(pnlSats), 6),
    severity: sev,
    severityClass: pnlClass(sev),
    win_rate: typeof safeTok.win_rate === 'number' ? safeTok.win_rate : null,
    win_rate_display: formatWinRate(safeTok.win_rate),
    win_count: typeof safeTok.win_count === 'number' ? safeTok.win_count : 0,
    loss_count: typeof safeTok.loss_count === 'number' ? safeTok.loss_count : 0,
    breakeven_count: typeof safeTok.breakeven_count === 'number' ? safeTok.breakeven_count : 0,
    unknown_count: typeof safeTok.unknown_count === 'number' ? safeTok.unknown_count : 0,
    mean_hold_ms: typeof safeTok.mean_hold_ms === 'number' ? safeTok.mean_hold_ms : null,
    mean_hold_display: formatHoldMs(safeTok.mean_hold_ms),
    total_bch_in_bch: satsToBchNumber(totalInSats),
    total_bch_out_bch: satsToBchNumber(totalOutSats),
    total_fees_bch: satsToBchNumber(totalFeesSats),
    first_event_ts: typeof safeTok.first_event_ts === 'string' ? safeTok.first_event_ts : null,
    last_event_ts: typeof safeTok.last_event_ts === 'string' ? safeTok.last_event_ts : null,
  };
}

/**
 * Build a flat display row from one closed-trade attribution entry.
 * The rollup detail envelope exposes `closed_trades[]` with
 * per-trade P&L + hold time + outcome. Pure projection.
 *
 * @param {Object} t
 * @returns {Object}
 */
export function buildClosedTradeRow(t) {
  const safe = t && typeof t === 'object' ? t : {};
  const pnlSats = safeSats(safe.net_pnl_sats);
  const sev = pnlSeverity(pnlSats);
  const holdMs = typeof safe.hold_ms === 'number' && Number.isFinite(safe.hold_ms) ? safe.hold_ms : null;
  return {
    position_id: typeof safe.position_id === 'string' ? safe.position_id : null,
    entry_ts: typeof safe.entry_ts === 'string' ? safe.entry_ts : null,
    exit_ts: typeof safe.exit_ts === 'string' ? safe.exit_ts : null,
    exit_kind: typeof safe.exit_kind === 'string' ? safe.exit_kind : null,
    outcome: typeof safe.outcome === 'string' ? safe.outcome : null,
    pnl_sats: pnlSats,
    pnl_bch: satsToBchNumber(pnlSats),
    pnl_bch_display: formatBch(satsToBchNumber(pnlSats), 6),
    pnl_pct_display: typeof safe.net_pnl_pct_of_cost === 'number' && Number.isFinite(safe.net_pnl_pct_of_cost)
      ? `${(safe.net_pnl_pct_of_cost * 100).toFixed(2)}%`
      : '—',
    severity: sev,
    severityClass: pnlClass(sev),
    hold_ms: holdMs,
    hold_display: formatHoldMs(holdMs),
    cost_basis_sats: safeSats(safe.cost_basis_sats),
    exit_value_sats: safeSats(safe.exit_value_sats),
    fees_sats_total: safeSats(safe.fees_sats_total),
  };
}

/**
 * Build a flat display row from one open-position attribution entry.
 *
 * @param {Object} o
 * @returns {Object}
 */
export function buildOpenPositionRow(o) {
  const safe = o && typeof o === 'object' ? o : {};
  const ageMs = typeof safe.age_ms === 'number' && Number.isFinite(safe.age_ms) ? safe.age_ms : null;
  return {
    position_id: typeof safe.position_id === 'string' ? safe.position_id : null,
    entry_ts: typeof safe.entry_ts === 'string' ? safe.entry_ts : null,
    age_ms: ageMs,
    age_display: formatHoldMs(ageMs),
    side: typeof safe.side === 'string' ? safe.side : null,
    size_bch: typeof safe.size_bch === 'number' && Number.isFinite(safe.size_bch) ? safe.size_bch : null,
    size_bch_display: formatBch(safe.size_bch, 6),
    cost_basis_sats: safeSats(safe.cost_basis_sats),
    fee_sats: safeSats(safe.fee_sats),
  };
}

/**
 * Compute the rollup header totals (one row per token, summed). The
 * dashboard header above the rollup shows "5 tokens · 12 trades ·
 * +0.0012 BCH" — this is the projection helper.
 *
 * @param {Array<Object>} rollupRows  pre-projected rows from buildRollupRow
 * @returns {Object} {token_count, total_closed, total_open, total_pnl_sats, win_rate}
 */
export function buildRollupTotals(rollupRows) {
  const rows = Array.isArray(rollupRows) ? rollupRows : [];
  let totalClosed = 0;
  let totalOpen = 0;
  let pnl = 0n;
  let wins = 0;
  let losses = 0;
  let breakeven = 0;
  let withRate = 0;
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    totalClosed += r.closed_trade_count ?? 0;
    totalOpen += r.open_position_count ?? 0;
    if (r.pnl_sats !== null && r.pnl_sats !== undefined) pnl += r.pnl_sats;
    wins += r.win_count ?? 0;
    losses += r.loss_count ?? 0;
    breakeven += r.breakeven_count ?? 0;
    if (typeof r.win_rate === 'number' && Number.isFinite(r.win_rate) && (r.win_count + r.loss_count) > 0) {
      withRate += 1;
    }
  }
  const totalDecided = wins + losses + breakeven;
  const winRate = totalDecided > 0 ? wins / totalDecided : null;
  // Count only meaningful rows — null/undefined/non-object entries
  // are skipped at the top of the loop, so the headline "N tokens"
  // figure should reflect what's actually aggregated rather than
  // the raw input array length.
  let validRowCount = 0;
  for (const r of rows) {
    if (r && typeof r === 'object') validRowCount += 1;
  }
  return {
    token_count: validRowCount,
    total_closed: totalClosed,
    total_open: totalOpen,
    total_pnl_sats: pnl,
    total_pnl_bch: satsToBchNumber(pnl),
    total_pnl_bch_display: formatBch(satsToBchNumber(pnl), 6),
    win_count: wins,
    loss_count: losses,
    breakeven_count: breakeven,
    win_rate: winRate,
    win_rate_display: formatWinRate(winRate),
  };
}
