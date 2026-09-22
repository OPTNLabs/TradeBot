#!/usr/bin/env node
// dashboard/src/views/dust-positions-helpers.mjs
//
// T88 — pure formatting helpers for the Dashboard's
// `DustPositionsCard` tile. Mirrors the patterns from
// `token-holders-helpers.mjs` (T76 subset 2c) +
// `portfolio-helpers.mjs` (T83) + `staking-status-helpers.mjs`
// (T70-3) — every helper is dependency-free, no DOM, no
// module-scope state, no I/O.
//
// Helpers project the `GET /api/positions/dust` response envelope
// (knob-on + knob-off preview) into the shapes the React tile
// needs: header card fields, per-row display rows, severity pills,
// blocked-reason pills, dust-kind pills.
//
// Envelope shapes (from `src/dashboard/dust-positions.mjs`):
//   { schema, ts, generated_at_ms, ok, dust_position_auto_close_enabled,
//     config: { tx_fee_sats, slippage_bps, margin_bps, budget_multiplier, min_token_amount },
//     open_position_count, checked_count, dust_count, skipped_count,
//     skipped_overrides, skipped_no_price,
//     dust: [{ position_id, token_id, token_symbol, token_decimals,
//              entry_ts, entry_bch_spent_sats, entry_price_sats_per_token,
//              current_value_sats, proceeds_sats, slippage_cost_sats,
//              tx_fee_sats, total_cost_sats, net_recoverable_sats,
//              ratio_cost_to_proceeds, budget_threshold_sats,
//              reasons: [...], dust_kind, blocked_reason }],
//     skipped: [{ position_id, token_id, token_symbol, blocked_reason, reasons: [...] }]
//   }
//
// Every helper tolerates null / undefined / missing fields and
// returns a sensible default rather than throwing. The helpers
// are importable from `node --test` (Node can't parse .jsx files
// without a loader) so the dashboard layer is unit-testable
// without spinning up React.

/** Maximum length for a short token id. */
const SHORT_TOKEN_ID_LEN = 8;

/**
 * Shorten a 64-hex token id to the first N chars + ellipsis.
 * Returns the input unchanged if it's shorter than the cap.
 *
 * @param {string|null|undefined} tokenId
 * @returns {string}
 */
export function shortTokenId(tokenId) {
  if (typeof tokenId !== 'string' || tokenId.length === 0) return '—';
  if (tokenId.length <= SHORT_TOKEN_ID_LEN) return tokenId;
  return `${tokenId.slice(0, SHORT_TOKEN_ID_LEN)}…`;
}

/**
 * Format a sats value (number / string) to a BCH string with
 * the requested decimals. Returns '—' for null / NaN / unparseable.
 *
 * @param {number|string|null|undefined} sats
 * @param {number} [decimals=6]
 * @returns {string}
 */
export function satsToBch(sats, decimals = 6) {
  if (sats === null || sats === undefined) return '—';
  let n = null;
  if (typeof sats === 'bigint') n = Number(sats) / 1e8;
  else if (typeof sats === 'number') n = sats / 1e8;
  else if (typeof sats === 'string' && sats.trim().length > 0) {
    const parsed = Number(sats);
    if (Number.isFinite(parsed)) n = parsed / 1e8;
  }
  if (n === null || !Number.isFinite(n)) return '—';
  return n.toFixed(decimals);
}

/**
 * Format a sat value (number / bigint / string) as a sats integer
 * with thousands-separator. Returns '—' for null / NaN / unparseable.
 *
 * @param {number|string|null|undefined} sats
 * @returns {string}
 */
export function formatSats(sats) {
  if (sats === null || sats === undefined) return '—';
  let n = null;
  if (typeof sats === 'bigint') n = Number(sats);
  else if (typeof sats === 'number') n = sats;
  else if (typeof sats === 'string' && sats.trim().length > 0) {
    const parsed = Number(sats);
    if (Number.isFinite(parsed)) n = parsed;
  }
  if (n === null || !Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}

/**
 * Format a ratio (cost-to-proceeds) for display. Tolerates Infinity
 * (returns '∞'), NaN / null / undefined (returns '—'). Caps to
 * 6 significant digits so the table doesn't blow up.
 *
 * @param {number|null|undefined} ratio
 * @returns {string}
 */
export function dustRatioFormat(ratio) {
  if (ratio === null || ratio === undefined) return '—';
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) {
    if (ratio === Infinity) return '∞';
    return '—';
  }
  if (ratio === 0) return '0.0000';
  return ratio.toFixed(4);
}

/**
 * Format a BCH value for the dust-row display. Special-cased to
 * show 8 decimals when the value is small enough that 6 would
 * round to zero.
 *
 * @param {number|string|null|undefined} sats
 * @returns {string}
 */
export function dustBchFormat(sats) {
  if (sats === null || sats === undefined) return '—';
  let n = null;
  if (typeof sats === 'number') n = sats;
  else if (typeof sats === 'string' && sats.trim().length > 0) {
    const parsed = Number(sats);
    if (Number.isFinite(parsed)) n = parsed;
  }
  if (n === null || !Number.isFinite(n)) return '—';
  const bch = n / 1e8;
  // Sub-1000 sat: 8 decimals; sub-1M sat: 6 decimals; otherwise 4.
  const absSats = Math.abs(n);
  if (absSats < 1000) return `${bch.toFixed(8)} BCH`;
  if (absSats < 1_000_000) return `${bch.toFixed(6)} BCH`;
  return `${bch.toFixed(4)} BCH`;
}

/**
 * Severity for a dust row's ratio_cost_to_proceeds.
 *   - ratio >= 1.5      → 'critical' (cost is 150% of proceeds)
 *   - ratio >= 1.0      → 'high'     (cost == proceeds)
 *   - ratio >= 0.5      → 'medium'   (cost == 50% of proceeds)
 *   - ratio >  0        → 'low'
 *   - ratio == 0        → 'none'
 *   - Infinity / null   → 'unknown'
 *
 * @param {number|null|undefined} ratio
 * @returns {'critical'|'high'|'medium'|'low'|'none'|'unknown'}
 */
export function dustSeverity(ratio) {
  if (ratio === null || ratio === undefined) return 'unknown';
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) {
    if (ratio === Infinity) return 'critical';
    return 'unknown';
  }
  if (ratio >= 1.5) return 'critical';
  if (ratio >= 1.0) return 'high';
  if (ratio >= 0.5) return 'medium';
  if (ratio > 0) return 'low';
  return 'none';
}

/**
 * Tailwind text/pill class for a dust severity.
 *
 * @param {string} severity  from `dustSeverity`
 * @returns {string}
 */
export function dustSeverityClass(severity) {
  switch (severity) {
    case 'critical': return 'text-red-300 border-red-700/60 bg-red-950/30';
    case 'high':     return 'text-red-400 border-red-700/40 bg-red-950/20';
    case 'medium':   return 'text-amber-300 border-amber-700/40 bg-amber-950/20';
    case 'low':      return 'text-ash-300 border-ink-600 bg-ink-900/40';
    case 'none':     return 'text-emerald-400 border-emerald-700/40 bg-emerald-950/20';
    default:         return 'text-ash-500 border-ink-700 bg-ink-900/30';
  }
}

/**
 * Tailwind text class for a dust pill (lighter-weight than the
 * severity class — used for inline pills in the table rows).
 *
 * @param {string} severity
 * @returns {string}
 */
export function dustPillClass(severity) {
  switch (severity) {
    case 'critical': return 'bg-red-900/40 text-red-300 border-red-700/50';
    case 'high':     return 'bg-red-950/30 text-red-400 border-red-800/40';
    case 'medium':   return 'bg-amber-950/30 text-amber-300 border-amber-800/40';
    case 'low':      return 'bg-ink-900/40 text-ash-400 border-ink-600';
    case 'none':     return 'bg-emerald-950/20 text-emerald-400 border-emerald-800/40';
    default:         return 'bg-ink-900/40 text-ash-500 border-ink-700';
  }
}

/**
 * Tailwind class for a blocked_reason pill.
 *   - 'prevent_stop_loss'  → blue (operator-set)
 *   - 'no_price'           → gray (data unavailable)
 *   - 'no_price_in_index'  → gray (data unavailable)
 *   - 'positions_unavailable' → amber (I/O issue)
 *   - 'find_failed'        → amber (math failure)
 *   - 'on_chain_sync'      → purple (sync source gate)
 *
 * @param {string|null|undefined} reason
 * @returns {string}
 */
export function dustBlockedReasonClass(reason) {
  switch (reason) {
    case 'prevent_stop_loss':    return 'bg-sky-950/30 text-sky-300 border-sky-800/40';
    case 'on_chain_sync':        return 'bg-purple-950/30 text-purple-300 border-purple-800/40';
    case 'no_price':
    case 'no_price_in_index':    return 'bg-ink-900/40 text-ash-400 border-ink-600';
    case 'positions_unavailable':
    case 'find_failed':          return 'bg-amber-950/30 text-amber-300 border-amber-800/40';
    case 'knob_off':             return 'bg-ink-900/40 text-ash-500 border-ink-700';
    default:                     return 'bg-ink-900/40 text-ash-500 border-ink-700';
  }
}

/**
 * Human-readable label for a blocked_reason.
 *
 * @param {string|null|undefined} reason
 * @returns {string}
 */
export function dustBlockedReasonLabel(reason) {
  switch (reason) {
    case 'prevent_stop_loss':    return 'operator hold';
    case 'on_chain_sync':        return 'on-chain sync';
    case 'no_price':             return 'no price';
    case 'no_price_in_index':    return 'no price';
    case 'positions_unavailable':return 'positions I/O';
    case 'find_failed':          return 'math error';
    case 'knob_off':             return 'knob off (preview)';
    case 'invalid_input':        return 'invalid input';
    default:                     return (typeof reason === 'string' && reason.length > 0) ? reason : 'unknown';
  }
}

/**
 * Human-readable label for a dust_kind.
 *
 * @param {string|null|undefined} kind
 * @returns {string}
 */
export function dustKindLabel(kind) {
  switch (kind) {
    case 'below_cost':               return 'cost eats proceeds';
    case 'below_min_token_amount':   return 'below min token amount';
    case 'below_cost_and_min':       return 'cost + min amount';
    default:                         return (typeof kind === 'string' && kind.length > 0) ? kind : 'unknown';
  }
}

/**
 * Tailwind class for a dust_kind pill (independent of severity —
 * kind labels the trigger, severity labels the cost magnitude).
 *
 * @param {string|null|undefined} kind
 * @returns {string}
 */
export function dustKindClass(kind) {
  switch (kind) {
    case 'below_cost':               return 'bg-red-950/30 text-red-300 border-red-800/40';
    case 'below_min_token_amount':   return 'bg-purple-950/30 text-purple-300 border-purple-800/40';
    case 'below_cost_and_min':       return 'bg-red-950/30 text-red-400 border-purple-800/40';
    default:                         return 'bg-ink-900/40 text-ash-400 border-ink-700';
  }
}

/**
 * Build the canonical header-card line for the DustPositionsCard.
 * Returns:
 *   {
 *     headline: '<n> dust',                 // number of flagged positions
 *     subline: 'of <m> open positions',     // total open
 *     knobLabel: 'on' | 'off (preview)' | 'off',
 *     knobClass: '<tw-class>',
 *   }
 *
 * @param {Object|null|undefined} env  the `/api/positions/dust` envelope
 * @returns {Object}
 */
export function buildDustPositionsHeader(env) {
  if (!env || typeof env !== 'object') {
    return {
      headline: '— dust',
      subline: '— open positions',
      knobLabel: 'unknown',
      knobClass: 'bg-ink-900/40 text-ash-500 border-ink-700',
    };
  }
  const dustCount = Number.isFinite(env.dust_count) ? env.dust_count : 0;
  const openCount = Number.isFinite(env.open_position_count) ? env.open_position_count : 0;
  const knobOn = env.dust_position_auto_close_enabled === true;
  return {
    headline: `${dustCount} dust`,
    subline: `of ${openCount} open`,
    knobLabel: knobOn ? 'auto-close on' : (dustCount > 0 ? 'off (preview)' : 'off'),
    knobClass: knobOn
      ? 'bg-emerald-950/30 text-emerald-300 border-emerald-800/40'
      : 'bg-ink-900/40 text-ash-400 border-ink-700',
  };
}

/**
 * Project a single dust row (from `env.dust[]`) into the table-
 * row shape the React tile needs. Each row carries the display
 * fields + the severity / kind / ratio pre-computed so the
 * React component doesn't have to re-derive.
 *
 * @param {Object|null|undefined} row
 * @returns {Object|null}  null when input is invalid
 */
export function buildDustRow(row) {
  if (!row || typeof row !== 'object') return null;
  const ratio = (typeof row.ratio_cost_to_proceeds === 'number') ? row.ratio_cost_to_proceeds : null;
  const severity = dustSeverity(ratio);
  const kind = (typeof row.dust_kind === 'string') ? row.dust_kind : 'unknown';
  return {
    position_id: (typeof row.position_id === 'string') ? row.position_id : null,
    token_id: (typeof row.token_id === 'string') ? row.token_id : null,
    token_id_short: shortTokenId(row.token_id),
    token_symbol: (typeof row.token_symbol === 'string') ? row.token_symbol : null,
    token_decimals: (Number.isFinite(row.token_decimals)) ? row.token_decimals : null,
    entry_ts: (typeof row.entry_ts === 'string') ? row.entry_ts : null,
    entry_bch_spent_sats: (Number.isFinite(row.entry_bch_spent_sats)) ? row.entry_bch_spent_sats : null,
    entry_price_sats_per_token: (Number.isFinite(row.entry_price_sats_per_token)) ? row.entry_price_sats_per_token : null,
    current_value_bch: dustBchFormat(row.current_value_sats),
    current_value_sats: row.current_value_sats,
    total_cost_bch: dustBchFormat(row.total_cost_sats),
    total_cost_sats: row.total_cost_sats,
    proceeds_bch: dustBchFormat(row.proceeds_sats),
    proceeds_sats: row.proceeds_sats,
    net_recoverable_bch: dustBchFormat(row.net_recoverable_sats),
    net_recoverable_sats: row.net_recoverable_sats,
    ratio,
    ratio_display: dustRatioFormat(ratio),
    severity,
    severity_class: dustSeverityClass(severity),
    pill_class: dustPillClass(severity),
    kind,
    kind_label: dustKindLabel(kind),
    kind_class: dustKindClass(kind),
    reasons: Array.isArray(row.reasons) ? row.reasons : [],
  };
}

/**
 * Build the full table-rows array from `env.dust[]`. Returns an
 * empty array when env is missing / dust is missing.
 *
 * @param {Object|null|undefined} env
 * @returns {Array<Object>}
 */
export function dustPositionsTableRows(env) {
  if (!env || typeof env !== 'object' || !Array.isArray(env.dust)) return [];
  return env.dust.map(buildDustRow).filter((r) => r !== null);
}

/**
 * Build the skipped-rows array (operator prevent_stop_loss overrides
 * + on-chain-sync skips + no-price skips). Each row carries the
 * blocked-reason pill class + label pre-computed.
 *
 * @param {Object|null|undefined} env
 * @returns {Array<{position_id, token_id, token_id_short, token_symbol, blocked_reason, blocked_reason_label, blocked_reason_class, reasons}>}
 */
export function dustPositionsSkippedRows(env) {
  if (!env || typeof env !== 'object' || !Array.isArray(env.skipped)) return [];
  return env.skipped
    .filter((r) => r && typeof r === 'object')
    .map((r) => ({
      position_id: (typeof r.position_id === 'string') ? r.position_id : null,
      token_id: (typeof r.token_id === 'string') ? r.token_id : null,
      token_id_short: shortTokenId(r.token_id),
      token_symbol: (typeof r.token_symbol === 'string') ? r.token_symbol : null,
      blocked_reason: (typeof r.blocked_reason === 'string') ? r.blocked_reason : 'unknown',
      blocked_reason_label: dustBlockedReasonLabel(r.blocked_reason),
      blocked_reason_class: dustBlockedReasonClass(r.blocked_reason),
      reasons: Array.isArray(r.reasons) ? r.reasons : [],
    }));
}

/**
 * Empty-state message when `env.dust[]` is empty AND the open
 * position count is zero. Returned by the React tile when no
 * positions exist at all.
 *
 * @returns {string}
 */
export function positionsAreEmptyMessage() {
  return 'No open positions to evaluate.';
}

/**
 * Empty-state message when positions exist but none are dust.
 *
 * @param {Object|null|undefined} env
 * @returns {string}
 */
export function dustEmptyMessage(env) {
  const open = (env && Number.isFinite(env.open_position_count)) ? env.open_position_count : 0;
  return `0 dust positions across ${open} open — all clear.`;
}

/**
 * Knob-OFF info-card message (rendered when `dust_position_auto_close_enabled:false`).
 *
 * @returns {string}
 */
export function knobOffMessage() {
  return 'Auto-close is OFF. Rows shown are PREVIEW only — the loop will not act on them. Set risk.dust_position_auto_close_enabled=true in data/user.json to enable.';
}

/**
 * Config snippet the operator can paste into data/user.json to
 * flip the knob ON. Returned verbatim by the React tile.
 *
 * @returns {string}
 */
export function dustAutoCloseConfigSnippet() {
  return JSON.stringify({ risk: { dust_position_auto_close_enabled: true } }, null, 2);
}

/**
 * Has the envelope actually flagged any dust positions? Used by
 * the React tile to decide whether to render the empty-state
 * message or the table.
 *
 * @param {Object|null|undefined} env
 * @returns {boolean}
 */
export function dustCardHasDust(env) {
  if (!env || typeof env !== 'object') return false;
  if (!Array.isArray(env.dust)) return false;
  return env.dust.length > 0;
}

/**
 * Has the envelope any SKIPPED positions to surface? Used by the
 * React tile to decide whether to render the skipped-rows sub-panel.
 *
 * @param {Object|null|undefined} env
 * @returns {boolean}
 */
export function dustCardHasSkipped(env) {
  if (!env || typeof env !== 'object') return false;
  if (!Array.isArray(env.skipped)) return false;
  return env.skipped.length > 0;
}

/**
 * Build a flat "card props" object for the DustPositionsCard
 * React tile. Aggregates every helper so the .jsx can read a
 * single value. Defensive on null / undefined env.
 *
 * @param {Object|null|undefined} env
 * @param {Object} [opts]
 * @param {string|null} [opts.error]  error string when the request failed
 * @returns {Object}
 */
export function buildDustPositionsCardProps(env, opts = {}) {
  const error = (opts && typeof opts.error === 'string') ? opts.error : null;
  const knobOn = !!(env && typeof env === 'object' && env.dust_position_auto_close_enabled === true);
  return {
    error,
    isKnobOn: knobOn,
    header: buildDustPositionsHeader(env),
    rows: dustPositionsTableRows(env),
    skipped: dustPositionsSkippedRows(env),
    hasDust: dustCardHasDust(env),
    hasSkipped: dustCardHasSkipped(env),
    configSnippet: dustAutoCloseConfigSnippet(),
    knobOffText: knobOffMessage(),
    emptyText: positionsAreEmptyMessage(),
    clearText: dustEmptyMessage(env),
    generated_at_ms: (env && Number.isFinite(env.generated_at_ms)) ? env.generated_at_ms : null,
    ts: (env && typeof env.ts === 'string') ? env.ts : null,
    config: (env && env.config && typeof env.config === 'object') ? env.config : null,
    open_position_count: (env && Number.isFinite(env.open_position_count)) ? env.open_position_count : 0,
    dust_count: (env && Number.isFinite(env.dust_count)) ? env.dust_count : 0,
    skipped_count: (env && Number.isFinite(env.skipped_count)) ? env.skipped_count : 0,
    skipped_overrides: (env && Number.isFinite(env.skipped_overrides)) ? env.skipped_overrides : 0,
    skipped_no_price: (env && Number.isFinite(env.skipped_no_price)) ? env.skipped_no_price : 0,
  };
}

// Internal: short id cap exposed for direct tests.
export const _internals = { SHORT_TOKEN_ID_LEN };
