#!/usr/bin/env node
// dashboard/src/views/trade-history-helpers.mjs
//
// Pure helpers for the TRADE HISTORY view. Mirrors the
// proposals-helpers / bugs-helpers pattern: every helper is
// dependency-free, has no side effects, and is importable from
// `node --test` (Node can't parse .jsx files without a loader).
//
// The view itself lives in TradeHistory.jsx; this file owns the
// filter UI state shape, validation, chip-classification, and
// any pure formatters the table renders.

/**
 * Side options for the side filter. The dashboard exposes a
 * curated short list — `long_token` is what the bot actually trades
 * today (T14), but we still surface `short_token` so a future
 * short-side strategy works out of the box.
 */
export const SIDE_OPTIONS = Object.freeze([
  Object.freeze({ value: '',         label: 'any' }),
  Object.freeze({ value: 'long_token',  label: 'long' }),
  Object.freeze({ value: 'short_token', label: 'short' }),
]);

/**
 * Date range presets. The dashboard's ?range= URL parameter accepts
 * the same shape (`<int><s|m|h|d|w>`) — the helper just exposes the
 * label strings.
 */
export const RANGE_OPTIONS = Object.freeze([
  Object.freeze({ value: '24h', label: '24h' }),
  Object.freeze({ value: '7d',  label: '7d'  }),
  Object.freeze({ value: '30d', label: '30d' }),
  Object.freeze({ value: '90d', label: '90d' }),
  Object.freeze({ value: 'all', label: 'all' }),
]);

/**
 * Event-kind filter (entry-only / exit-only / both). The current
 * operator workflow leans on exit events for P&L review, so the
 * default is 'any' but 'exit' is the obvious one-click drilldown.
 */
export const EVENT_KIND_OPTIONS = Object.freeze([
  Object.freeze({ value: 'any',   label: 'entry + exit' }),
  Object.freeze({ value: 'entry', label: 'entry only'   }),
  Object.freeze({ value: 'exit',  label: 'exit only'    }),
]);

/**
 * P&L outcome filter. `pnl` only applies to exit events — entry
 * events have no realized P&L so they're filtered out when the
 * user picks gain/loss/flat. This is a deliberate UX trade-off
 * (mirrors the backend's filterTradeEvents rule).
 */
export const PNL_OPTIONS = Object.freeze([
  Object.freeze({ value: 'any',  label: 'any'  }),
  Object.freeze({ value: 'gain', label: 'gain' }),
  Object.freeze({ value: 'loss', label: 'loss' }),
  Object.freeze({ value: 'flat', label: 'flat' }),
]);

/**
 * Build the initial filter state for the view. Pure. Exported
 * for tests + so the React component stays free of magic property
 * names.
 *
 * @returns {{
 *   range: string,
 *   eventKind: string,
 *   side: string,
 *   tokenId: string,
 *   pnl: string,
 *   limit: number,
 * }}
 */
export function emptyTradeHistoryFilters() {
  return {
    range: '30d',
    eventKind: 'any',
    side: '',
    tokenId: '',
    pnl: 'any',
    limit: 500,
  };
}

/**
 * Coerce + validate a filter draft. Returns the same shape on
 * pass; throws a `TradeHistoryValidationError` on fail with a
 * human-readable message (the React view catches it and surfaces
 * a banner). Pure.
 *
 * @param {ReturnType<typeof emptyTradeHistoryFilters>|Object} draft
 * @returns {ReturnType<typeof emptyTradeHistoryFilters>}
 */
export function validateTradeHistoryFilters(draft) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    throw new TradeHistoryValidationError('filters must be an object');
  }
  const range = String(draft.range ?? '').trim();
  if (range.length > 0 && !RANGE_OPTIONS.some((r) => r.value === range) && !/^\d+[smhdw]$/i.test(range)) {
    throw new TradeHistoryValidationError(`range must be one of ${RANGE_OPTIONS.map((r) => r.value).join(', ')} or <int><s|m|h|d|w>`);
  }
  const eventKind = String(draft.eventKind ?? '');
  if (!EVENT_KIND_OPTIONS.some((e) => e.value === eventKind)) {
    throw new TradeHistoryValidationError(`eventKind must be one of ${EVENT_KIND_OPTIONS.map((e) => e.value).join(', ')}`);
  }
  const side = String(draft.side ?? '');
  if (side.length > 0 && !SIDE_OPTIONS.some((s) => s.value === side)) {
    throw new TradeHistoryValidationError(`side must be one of ${SIDE_OPTIONS.map((s) => s.value || '""').join(', ')}`);
  }
  const pnl = String(draft.pnl ?? '');
  if (!PNL_OPTIONS.some((p) => p.value === pnl)) {
    throw new TradeHistoryValidationError(`pnl must be one of ${PNL_OPTIONS.map((p) => p.value).join(', ')}`);
  }
  const tokenId = String(draft.tokenId ?? '').trim();
  if (tokenId.length > 0 && !/^[0-9a-f]{64}$/i.test(tokenId)) {
    throw new TradeHistoryValidationError('tokenId must be a 64-hex category id when set');
  }
  const limit = Number.isFinite(draft.limit) && draft.limit > 0
    ? Math.floor(draft.limit)
    : 500;
  return {
    range: range.length === 0 ? '30d' : range,
    eventKind,
    side,
    tokenId,
    pnl,
    limit,
  };
}

export class TradeHistoryValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TradeHistoryValidationError';
  }
}

/**
 * Map an event kind to its pill colour. Pure.
 *
 * @param {string} kind
 * @returns {string}
 */
export function eventKindClass(kind) {
  if (kind === 'entry') return 'bg-bch-500/20 text-bch-300 border-bch-500/40';
  if (kind === 'exit')  return 'bg-pnl-pos/15 text-pnl-pos border-pnl-pos/40';
  return 'bg-ink-800 text-ash-300 border-ink-700';
}

/**
 * Map a P&L-sign pill colour. Pure. `flat` is a neutral grey
 * (not a win/loss), gain is green, loss is red.
 *
 * @param {string|null|undefined} sign
 * @returns {string}
 */
export function pnlSignClass(sign) {
  if (sign === 'gain') return 'bg-pnl-pos/15 text-pnl-pos border-pnl-pos/40';
  if (sign === 'loss') return 'bg-pnl-neg/15 text-pnl-neg border-pnl-neg/40';
  if (sign === 'flat') return 'bg-ink-800 text-ash-300 border-ink-700';
  return 'bg-ink-800 text-ash-400 border-ink-700';
}

/**
 * Format a sat amount as a "+/-N NNN" string with a sign prefix.
 * Used for the realized P&L column. Pure.
 *
 * @param {number|null|undefined} sats
 * @returns {string}
 */
export function formatSignedSats(sats) {
  if (typeof sats !== 'number' || !Number.isFinite(sats)) return '—';
  const abs = Math.abs(Math.trunc(sats));
  const formatted = abs.toLocaleString('en-US');
  if (sats > 0) return `+${formatted}`;
  if (sats < 0) return `-${formatted}`;
  return '0';
}

/**
 * Format a sat amount as "X.XXXX BCH" via the same shared helper
 * the other views use. Re-exported here so the view doesn't have
 * to import `lib/format.mjs` twice (keeps the helpers file a
 * single import surface for tests).
 *
 * @param {number|null|undefined} sats
 * @returns {string}
 */
export { formatBch } from '../lib/format.mjs';

/**
 * Derive the distinct token options from the current event list so
 * the dropdown stays in sync with what the table actually shows.
 * When the user has typed a tokenId in the manual filter, we
 * always include it too so the chip doesn't disappear when no
 * event matches (otherwise the user would lose their filter).
 * Pure.
 *
 * @param {Array<Object>} events
 * @param {string} [activeTokenId]
 * @returns {Array<{value:string, label:string}>}
 */
export function tokenOptionsFromEvents(events, activeTokenId) {
  const seen = new Map();
  for (const e of (Array.isArray(events) ? events : [])) {
    if (!e || typeof e !== 'object') continue;
    const id = typeof e.token_id === 'string' ? e.token_id : null;
    if (!id) continue;
    const sym = typeof e.token_symbol === 'string' && e.token_symbol.length > 0
      ? e.token_symbol
      : `${id.slice(0, 6)}…${id.slice(-4)}`;
    if (!seen.has(id)) seen.set(id, sym);
  }
  if (typeof activeTokenId === 'string' && activeTokenId.length > 0 && !seen.has(activeTokenId)) {
    seen.set(activeTokenId, `${activeTokenId.slice(0, 6)}…${activeTokenId.slice(-4)}`);
  }
  const out = [{ value: '', label: 'any token' }];
  for (const [id, sym] of seen) {
    out.push({ value: id, label: sym });
  }
  return out;
}

/**
 * Pretty-print a status pill for live positions. Closed positions
 * always render as `closed` in the table (the exit event's status
 * is hard-coded to `'closed'`).
 *
 * @param {string|null|undefined} status
 * @returns {string}
 */
export function statusLabel(status) {
  if (status === 'open')    return 'open';
  if (status === 'pending') return 'pending';
  if (status === 'closing') return 'closing';
  if (status === 'closed')  return 'closed';
  return '—';
}

/**
 * Decide whether a row's realized P&L is positive, negative, flat,
 * or unknown. Re-derives the same shape as the backend's
 * `pnl_sign` so the UI can fall back gracefully on a stale entry
 * (the backend is authoritative; this helper exists for tests).
 * Pure.
 *
 * @param {number|null|undefined} sats
 * @returns {'gain'|'loss'|'flat'|null}
 */
export function classifyPnl(sats) {
  if (typeof sats !== 'number' || !Number.isFinite(sats)) return null;
  if (sats > 0) return 'gain';
  if (sats < 0) return 'loss';
  return 'flat';
}

/**
 * Build the URLSearchParams to send to `/api/trade-history`. Pure.
 * Drops empty strings + out-of-range values so the wire shape
 * stays minimal (the server treats missing params as defaults).
 *
 * @param {ReturnType<typeof emptyTradeHistoryFilters>} filters
 * @returns {URLSearchParams}
 */
export function tradeHistoryParamsFromFilters(filters) {
  const params = new URLSearchParams();
  const f = validateTradeHistoryFilters(filters);
  if (f.range && f.range !== '30d') params.set('range', f.range);
  if (f.eventKind && f.eventKind !== 'any') params.set('event_kind', f.eventKind);
  if (f.side) params.set('side', f.side);
  if (f.tokenId) params.set('token_id', f.tokenId);
  if (f.pnl && f.pnl !== 'any') params.set('pnl', f.pnl);
  if (Number.isFinite(f.limit) && f.limit > 0 && f.limit !== 500) params.set('limit', String(f.limit));
  return params;
}
