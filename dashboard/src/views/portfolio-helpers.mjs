#!/usr/bin/env node
// dashboard/src/views/portfolio-helpers.mjs
//
// T83 — pure formatting helpers for the PORTFOLIO view's
// `PositionRow` component. Kept separate from the .jsx so the
// helpers are importable from `node --test` (Node can't parse
// .jsx files without a loader) and so the logic is regression-
// testable without spinning up React.
//
// The first helper exported here, `buildPositionTokenCountLine`,
// is the display shape behind the small "1 282 FURU"-style line
// rendered below the TokenBadge on every position row. It reads
// the entry-side `token_amount_base` (string-encoded base-unit
// amount) + the BCMR-reported `token_decimals` (number | null)
// and projects them into `{ formatted, symbol, raw, decimals,
// hasData }` so the React component can render the row without
// inline-IIFE logic.
//
// Every helper is dependency-free and has no side effects, so
// each one is testable in isolation against fixture data.

import { formatTokenAmount } from '../lib/format.mjs';

// The em-dash placeholder used by `formatTokenAmount` when the
// amount can't be parsed (mirrors the internal `PLACEHOLDER`
// constant in `format.mjs`). Duplicated here because that
// constant is not exported; if it changes there, the equality
// check below will catch it via the "does not surface the
// PLACEHOLDER em-dash" test in portfolio-helpers.test.mjs.
const PLACEHOLDER = '—';

/**
 * Tolerant check whether a value is a finite, non-negative
 * integer suitable for the `token_decimals` slot. We don't
 * expect fractional decimals — a token with `decimals=1.5`
 * is malformed upstream and the row should fall back to the
 * raw integer + `decimals='?'` rendering rather than crash.
 *
 * @param {*} v
 * @returns {boolean}
 */
export function isValidTokenDecimals(v) {
  return (
    typeof v === 'number'
    && Number.isFinite(v)
    && v >= 0
    // Must be a non-negative integer (cashscript decimals are uint8).
    && Math.floor(v) === v
  );
}

/**
 * Project a position + entry into the small "1 282 FURU"-style
 * secondary line below the TokenBadge. Returns `null` when the
 * data is unavailable — the React tile uses that as "render
 * nothing" so older positions written before `token_amount_base`
 * landed don't show an em-dash line.
 *
 * Defensive guards:
 *   - `entry` must be an object (else return null)
 *   - `entry.token_amount_base` must be a non-empty string OR a
 *     number OR a bigint (formatTokenAmount handles each of those
 *     and returns PLACEHOLDER for everything else)
 *   - `token_decimals` must pass `isValidTokenDecimals` — else we
 *     pass `null` to formatTokenAmount so the helper's
 *     `rawOnMissing:true` fallback renders the raw integer with
 *     thin-space separators (no false-precision rendering of an
 *     unknown-decimals token)
 *
 * @param {Object|null|undefined} entry — position.entry sub-object
 * @param {number|null|undefined} token_decimals — p.token_decimals
 * @param {string|null|undefined} token_symbol — p.token_symbol
 * @returns {{
 *   formatted: string,
 *   symbol: string|null,
 *   raw: string,
 *   decimals: number|null,
 *   hasData: true,
 * }|null}
 */
export function buildPositionTokenCountLine(entry, token_decimals, token_symbol) {
  if (!entry || typeof entry !== 'object') return null;
  const raw = entry.token_amount_base;
  if (raw === undefined || raw === null || raw === '') return null;
  // Stringly-validate the raw so formatTokenAmount's built-in
  // safety net never fires on the dashboard. Accept number / bigint
  // / numeric-string; reject everything else.
  const rawType = typeof raw;
  if (rawType !== 'string' && rawType !== 'number' && rawType !== 'bigint') return null;
  if (rawType === 'string' && raw.trim().length === 0) return null;
  if (rawType === 'number' && !Number.isFinite(raw)) return null;
  const decimals = isValidTokenDecimals(token_decimals) ? token_decimals : null;
  const formatted = formatTokenAmount(raw, decimals);
  if (!formatted || formatted === PLACEHOLDER) return null;
  return {
    formatted,
    symbol: (typeof token_symbol === 'string' && token_symbol.length > 0) ? token_symbol : null,
    raw: rawType === 'bigint' ? raw.toString() : String(raw),
    decimals,
    hasData: true,
  };
}