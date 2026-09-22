#!/usr/bin/env node
// dashboard/src/views/fee-breakdown-helpers.mjs
//
// T71 — pure formatting helpers for the Dashboard's FeeBreakdown
// tile. Kept separate from the JSX component so they're importable
// from `node --test` (Node can't parse .jsx files without a loader).
//
// The helpers project the T71 /api/fees/breakdown response (both the
// rollup-list envelope `{schema, count, tokens:[…], totals}` and the
// per-token-detail envelope `{schema, token_id, symbol, …, trades[]}`)
// into the shapes the React tile needs: rollup-row → display row,
// per-trade attribution → display row, share-severity classification,
// finite-number coercion for bigint/string sat fields, share-pill
// color choice.
//
// Every helper is dependency-free and has no side effects, so each
// one is testable in isolation against fixture data.

const SATS_PER_BCH = 100_000_000n;
const SATS_PER_BCH_NUM = 100_000_000;

// Severity thresholds (mirror src/portfolio/fee-breakdown.mjs).
const SLIPPAGE_RED_THRESHOLD = 0.5;
const SLIPPAGE_AMBER_THRESHOLD = 0.25;

// ─────────────────────────────────────────────────────────────────────
//  Numeric coercion
// ─────────────────────────────────────────────────────────────────────

/**
 * Tolerated numeric coerce for sat/bigint/string fields. Returns
 * bigint when parseable, otherwise null. Rejects NaN, Infinity,
 * and non-integer floats. Allows negative values so a few edge-case
 * sat fields (e.g. realized P&L) survive the parse.
 *
 *   safeSats(null)         → null
 *   safeSats(undefined)    → null
 *   safeSats(0)            → 0n
 *   safeSats(100)          → 100n
 *   safeSats('500000')     → 500000n
 *   safeSats(NaN)          → null
 *   safeSats(Infinity)     → null
 *   safeSats('abc')        → null
 *   safeSats('500000.5')   → null
 *
 * @param {bigint|number|string|null|undefined} v
 * @returns {bigint|null}
 */
export function safeSats(v) {
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
 * Convert a sat count (bigint, number, or numeric string) to a BCH
 * float suitable for display in the dashboard. Returns null on
 * invalid input. Uses BigInt math so the precision is exact up to
 * 8 decimals.
 *
 *   satsToBchNumber(100_000_000n) → 1
 *   satsToBchNumber(50_000_000n)  → 0.5
 *   satsToBchNumber(null)         → null
 *   satsToBchNumber('abc')        → null
 *   satsToBchNumber(-100_000_000n) → -1
 *
 * @param {*} sats
 * @returns {number|null}
 */
export function satsToBchNumber(sats) {
  const bi = safeSats(sats);
  if (bi === null) return null;
  const negative = bi < 0n;
  const abs = negative ? -bi : bi;
  const whole = Number(abs / SATS_PER_BCH);
  const frac = abs % SATS_PER_BCH;
  const fracPart = Number(frac) / SATS_PER_BCH_NUM;
  const result = whole + fracPart;
  return negative ? -result : result;
}

/**
 * Format a sat count (bigint, number, or numeric string) as a
 * human-readable string. Tiny amounts (< 1000 sats) render as
 * `123 sats`. Larger amounts render as `0.0012 BCH` with up to
 * 6 decimals (clamped — BCH has 8 decimal places but the bot's
 * positions are < 1 BCH so 6 keeps the rendering compact). Null
 * inputs render as `—` (em dash).
 *
 * The BCH threshold is 100_000 sats (0.001 BCH = 1 mBCH) so any
 * value the operator would naturally read as "BCH" renders as
 * BCH rather than millions of sats.
 *
 *   formatSats(null)              → '—'
 *   formatSats(0n)                → '0 sats'
 *   formatSats(123n)              → '123 sats'
 *   formatSats(2_500n)            → '2.5K sats'
 *   formatSats(100_000n)          → '0.001000 BCH'
 *   formatSats(50_000_000n)       → '0.500000 BCH'
 *   formatSats(1_500_000n)        → '0.015000 BCH'
 *
 * @param {*} sats
 * @returns {string}
 */
export function formatSats(sats) {
  const bi = safeSats(sats);
  if (bi === null) return '—';
  if (bi === 0n) return '0 sats';
  const negative = bi < 0n;
  const abs = negative ? -bi : bi;
  // 100K sats = 0.001 BCH — anything at or above this reads as
  // BCH rather than millions of sats. The bot's positions are
  // < 1 BCH so 6 decimals keeps the rendering compact.
  if (abs >= 100_000n) {
    const bchNum = satsToBchNumber(bi);
    if (bchNum === null) return '—';
    return `${bchNum.toFixed(6)} BCH`;
  }
  if (abs >= 1_000n) {
    const k = Number(abs) / 1000;
    return `${negative ? '-' : ''}${k.toFixed(1)}K sats`;
  }
  return `${negative ? '-' : ''}${abs.toString()} sats`;
}

// ─────────────────────────────────────────────────────────────────────
//  Share severity (color-coded pills)
// ─────────────────────────────────────────────────────────────────────

/**
 * Coerce a value to a finite JS Number, defaulting to 0 when
 * the input is null / undefined / NaN / Infinity / non-numeric.
 * Used for share values (lp_share / tx_share / slippage_share)
 * which the server emits as floats but the dashboard must render
 * without crashing on malformed input.
 *
 *   safeNumber(null)      → 0
 *   safeNumber(undefined) → 0
 *   safeNumber('abc')     → 0
 *   safeNumber(NaN)       → 0
 *   safeNumber(Infinity)  → 0
 *   safeNumber(0.5)       → 0.5
 *   safeNumber('0.3')     → 0.3
 *
 * @param {*} v
 * @returns {number}
 */
function safeNumber(v) {
  if (typeof v !== 'number') return 0;
  if (!Number.isFinite(v)) return 0;
  return v;
}

/**
 * Classify a per-component share (0..1) into a severity level for
 * the dashboard's pill badges:
 *   - `'high'`   — share > SLIPPAGE_RED_THRESHOLD (50%) → red pill
 *   - `'medium'` — share > SLIPPAGE_AMBER_THRESHOLD (25%) → amber pill
 *   - `'low'`    — share <= 25% → green pill
 *   - `'none'`   — share is null / non-finite / negative → '—' pill
 *
 * The convention is that the share being colored is the
 * slippage-cost share (`slippage_share`) — operator intuition
 * is "how much of my fees went to slippage vs LP vs tx".
 *
 *   shareSeverity(0.6)         → 'high'
 *   shareSeverity(0.4)         → 'medium'
 *   shareSeverity(0.1)         → 'low'
 *   shareSeverity(0)           → 'low'
 *   shareSeverity(null)        → 'none'
 *   shareSeverity('abc')       → 'none'
 *   shareSeverity(-0.1)        → 'none'   (negative → treat as missing)
 *   shareSeverity(NaN)         → 'none'
 *
 * @param {*} share
 * @returns {'high'|'medium'|'low'|'none'}
 */
export function shareSeverity(share) {
  if (typeof share !== 'number') return 'none';
  if (!Number.isFinite(share)) return 'none';
  if (share < 0) return 'none';
  if (share > 1) return 'high';
  if (share > SLIPPAGE_RED_THRESHOLD) return 'high';
  if (share > SLIPPAGE_AMBER_THRESHOLD) return 'medium';
  return 'low';
}

/**
 * Map a severity level to a Tailwind-compatible class string.
 * The dashboard's existing tile palette (see
 * `src/views/token-summary-helpers.mjs#pnlClass` for a similar
 * pattern) uses:
 *   - red:    bg-red-100    / text-red-700    / border-red-300
 *   - amber:  bg-amber-100  / text-amber-700  / border-amber-300
 *   - green:  bg-emerald-100 / text-emerald-700 / border-emerald-300
 *   - gray:   bg-gray-100   / text-gray-500   / border-gray-300
 *
 *   shareClass('high')    → 'bg-red-100 text-red-700 border-red-300'
 *   shareClass('medium')  → 'bg-amber-100 text-amber-700 border-amber-300'
 *   shareClass('low')     → 'bg-emerald-100 text-emerald-700 border-emerald-300'
 *   shareClass('none')    → 'bg-gray-100 text-gray-500 border-gray-300'
 *   shareClass('garbage') → 'bg-gray-100 text-gray-500 border-gray-300'
 *
 * @param {'high'|'medium'|'low'|'none'|string} severity
 * @returns {string}
 */
export function shareClass(severity) {
  if (severity === 'high') return 'bg-red-100 text-red-700 border-red-300';
  if (severity === 'medium') return 'bg-amber-100 text-amber-700 border-amber-300';
  if (severity === 'low') return 'bg-emerald-100 text-emerald-700 border-emerald-300';
  return 'bg-gray-100 text-gray-500 border-gray-300';
}

// ─────────────────────────────────────────────────────────────────────
//  Identity helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Truncate a 64-hex `token_id` to a short form for compact display.
 * Returns the empty string when the input is missing / wrong length.
 *
 *   shortTokenId('abcdef0123456789…') → 'abcdef012345…345'
 *   shortTokenId('abc')               → 'abc'  (too short — pass through)
 *   shortTokenId(null)                → ''
 *   shortTokenId('')                  → ''
 *
 * @param {string|null|undefined} tokenId
 * @returns {string}
 */
export function shortTokenId(tokenId) {
  if (typeof tokenId !== 'string') return '';
  if (tokenId.length === 0) return '';
  if (tokenId.length <= 12) return tokenId;
  return `${tokenId.slice(0, 9)}…${tokenId.slice(-3)}`;
}

/**
 * Compact symbol representation. If the symbol is missing, falls
 * back to the short token_id so the rollup row always shows an
 * identifier.
 *
 *   shortSymbol(null, 'abc…')        → 'abc…'
 *   shortSymbol(undefined, 'abc…')   → 'abc…'
 *   shortSymbol('FURU', 'abc…')      → 'FURU'
 *   shortSymbol('', 'abc…')          → 'abc…'
 *
 * @param {string|null|undefined} symbol
 * @param {string} [tokenId]   fallback if symbol is missing
 * @returns {string}
 */
export function shortSymbol(symbol, tokenId = '') {
  if (typeof symbol === 'string' && symbol.length > 0) return symbol;
  return shortTokenId(tokenId);
}

// ─────────────────────────────────────────────────────────────────────
//  Rollup row builders
// ─────────────────────────────────────────────────────────────────────

/**
 * Build the display row for the rollup view from a T71
 * `/api/fees/breakdown` rollup entry. Pure — no JSX, no React,
 * no I/O. The dashboard subscribes to `useRefresh().tick` and
 * passes the response through this function.
 *
 * Returned shape (all fields are plain values so the React tile
 * can render without further coercion):
 *   {
 *     token_id, token_label, trade_count,
 *     lp_fees_sats (bigint), lp_share (number), lp_severity ('high'|'medium'|'low'|'none'),
 *     tx_fees_sats (bigint), tx_share (number), tx_severity,
 *     slippage_cost_sats (bigint), slippage_share (number), slippage_severity,
 *     fees_paid_sats (bigint),
 *     format_lp_fees (string), format_tx_fees (string), format_slippage_cost (string),
 *     format_fees_paid (string),
 *   }
 *
 * Defensive: every numeric field is coerced via `safeSats` /
 * `Number()` so a malformed server response can't crash the
 * rollup. Null tokens render the short id as the label.
 *
 * @param {Object} row    a T71 rollup row (token_id, symbol, decimals, lp_*, tx_*, slippage_*, fees_paid_sats_total, …)
 * @returns {Object}
 */
export function buildBreakdownRow(row) {
  const safeRow = row && typeof row === 'object' ? row : {};
  const lp = safeSats(safeRow.lp_fees_sats_total);
  const tx = safeSats(safeRow.tx_fees_sats_total);
  const sl = safeSats(safeRow.slippage_cost_sats_total);
  const total = safeSats(safeRow.fees_paid_sats_total);
  const lpShare = safeNumber(safeRow.lp_share);
  const txShare = safeNumber(safeRow.tx_share);
  const slipShare = safeNumber(safeRow.slippage_share);
  const tradeCount = Number.isInteger(safeRow.trade_count) ? safeRow.trade_count : 0;
  const label = shortSymbol(safeRow.symbol, safeRow.token_id);
  return {
    token_id: typeof safeRow.token_id === 'string' ? safeRow.token_id : '',
    token_label: label,
    trade_count: tradeCount,
    lp_fees_sats: lp,
    lp_share: lpShare,
    lp_severity: shareSeverity(lpShare),
    tx_fees_sats: tx,
    tx_share: txShare,
    tx_severity: shareSeverity(txShare),
    slippage_cost_sats: sl,
    slippage_share: slipShare,
    slippage_severity: shareSeverity(slipShare),
    fees_paid_sats: total,
    format_lp_fees: formatSats(lp),
    format_tx_fees: formatSats(tx),
    format_slippage_cost: formatSats(sl),
    format_fees_paid: formatSats(total),
  };
}

/**
 * Build the cross-token rollup totals row from the T71
 * `/api/fees/breakdown` envelope's `totals` field. Mirrors
 * `buildBreakdownRow` but operates on the aggregate envelope
 * (no `token_id` / `symbol` / `trade_count` per token).
 *
 *   {
 *     lp_fees_sats, lp_share, lp_severity,
 *     tx_fees_sats, tx_share, tx_severity,
 *     slippage_cost_sats, slippage_share, slippage_severity,
 *     fees_paid_sats,
 *     format_*, ...
 *     trade_count (integer or 0)
 *   }
 *
 * @param {Object} totals   the `totals` field from the cross-token envelope
 * @returns {Object}
 */
export function buildBreakdownTotals(totals) {
  const safeTotals = totals && typeof totals === 'object' ? totals : {};
  const lp = safeSats(safeTotals.lp_fees_sats_total);
  const tx = safeSats(safeTotals.tx_fees_sats_total);
  const sl = safeSats(safeTotals.slippage_cost_sats_total);
  const total = safeSats(safeTotals.fees_paid_sats_total);
  const lpShare = safeNumber(safeTotals.lp_share);
  const txShare = safeNumber(safeTotals.tx_share);
  const slipShare = safeNumber(safeTotals.slippage_share);
  const tradeCount = Number.isInteger(safeTotals.trade_count) ? safeTotals.trade_count : 0;
  return {
    lp_fees_sats: lp,
    lp_share: lpShare,
    lp_severity: shareSeverity(lpShare),
    tx_fees_sats: tx,
    tx_share: txShare,
    tx_severity: shareSeverity(txShare),
    slippage_cost_sats: sl,
    slippage_share: slipShare,
    slippage_severity: shareSeverity(slipShare),
    fees_paid_sats: total,
    trade_count: tradeCount,
    format_lp_fees: formatSats(lp),
    format_tx_fees: formatSats(tx),
    format_slippage_cost: formatSats(sl),
    format_fees_paid: formatSats(total),
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Detail-view builders
// ─────────────────────────────────────────────────────────────────────

/**
 * Build the per-trade attribution row for the drill-down view
 * from a T71 `/api/fees/breakdown?token_id=…` envelope's `trades[]`
 * entry. Pure — no JSX.
 *
 *   {
 *     position_id, token_id, entry_ts, exit_ts, exit_kind, is_open,
 *     format_tx_fees_entry, format_tx_fees_exit, format_tx_total,
 *     format_lp_fees_entry, format_lp_fees_exit, format_lp_total,
 *     format_slippage_entry, format_slippage_exit, format_slippage_total,
 *     format_fees_total,
 *     slippage_signed_bps (bigint|null),
 *   }
 *
 * Defensive: every numeric field is coerced. Open positions (no
 * exit_ts / is_open=true) render the entry-side legs only.
 *
 * @param {Object} trade    a `trades[]` entry from the per-token detail envelope
 * @returns {Object}
 */
export function buildTradeFeeRow(trade) {
  const safeTrade = trade && typeof trade === 'object' ? trade : {};
  const txE = safeSats(safeTrade.tx_fees_sats_entry);
  const txX = safeSats(safeTrade.tx_fees_sats_exit);
  const txT = safeSats(safeTrade.tx_fees_sats_total);
  const lpE = safeSats(safeTrade.lp_fees_sats_entry);
  const lpX = safeSats(safeTrade.lp_fees_sats_exit);
  const lpT = safeSats(safeTrade.lp_fees_sats_total);
  const slE = safeSats(safeTrade.slippage_cost_sats_entry);
  const slX = safeSats(safeTrade.slippage_cost_sats_exit);
  const slT = safeSats(safeTrade.slippage_cost_sats_total);
  const total = safeSats(safeTrade.fees_paid_sats_total);
  const signedBps = safeSats(safeTrade.slippage_signed_bps);
  return {
    position_id: typeof safeTrade.position_id === 'string' ? safeTrade.position_id : '',
    token_id: typeof safeTrade.token_id === 'string' ? safeTrade.token_id : '',
    entry_ts: typeof safeTrade.entry_ts === 'string' ? safeTrade.entry_ts : null,
    exit_ts: typeof safeTrade.exit_ts === 'string' ? safeTrade.exit_ts : null,
    exit_kind: typeof safeTrade.exit_kind === 'string' ? safeTrade.exit_kind : null,
    is_open: safeTrade.is_open === true,
    fee_rate_bps: typeof safeTrade.fee_rate_bps === 'number' ? safeTrade.fee_rate_bps : null,
    format_tx_fees_entry: formatSats(txE),
    format_tx_fees_exit: formatSats(txX),
    format_tx_total: formatSats(txT),
    format_lp_fees_entry: formatSats(lpE),
    format_lp_fees_exit: formatSats(lpX),
    format_lp_total: formatSats(lpT),
    format_slippage_entry: formatSats(slE),
    format_slippage_exit: formatSats(slX),
    format_slippage_total: formatSats(slT),
    format_fees_total: formatSats(total),
    slippage_signed_bps: signedBps,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Empty / unavailable state helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Decide whether the rollup envelope is "empty" (no tokens tracked
 * yet). Returns true when the envelope is null / missing / has no
 * tokens array / has a 0-length tokens array.
 *
 *   isRollupEmpty(null)         → true
 *   isRollupEmpty({})           → true
 *   isRollupEmpty({tokens: []}) → true
 *   isRollupEmpty({tokens: [{}]}) → false
 *
 * @param {*} envelope
 * @returns {boolean}
 */
export function isRollupEmpty(envelope) {
  if (envelope === null || envelope === undefined) return true;
  if (typeof envelope !== 'object') return true;
  if (!Array.isArray(envelope.tokens)) return true;
  return envelope.tokens.length === 0;
}

/**
 * Decide whether the per-token detail envelope is "unavailable"
 * (404 TOKEN_NOT_FOUND or malformed). Returns true when the
 * envelope is null / missing / has no `trades[]` array / has no
 * `token_id` field.
 *
 *   isDetailUnavailable(null)                          → true
 *   isDetailUnavailable({})                            → true
 *   isDetailUnavailable({token_id: 'a', trades: []})   → false (valid empty)
 *   isDetailUnavailable({token_id: 'a'})               → true  (no trades[])
 *
 * @param {*} envelope
 * @returns {boolean}
 */
export function isDetailUnavailable(envelope) {
  if (envelope === null || envelope === undefined) return true;
  if (typeof envelope !== 'object') return true;
  if (typeof envelope.token_id !== 'string' || envelope.token_id.length === 0) return true;
  if (!Array.isArray(envelope.trades)) return true;
  return false;
}
