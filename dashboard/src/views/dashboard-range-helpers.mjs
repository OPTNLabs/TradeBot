#!/usr/bin/env node
// dashboard/src/views/dashboard-range-helpers.mjs
//
// T51: pure helpers for the DASHBOARD chart range pickers.
// Mirrors the proposals-helpers / bugs-helpers /
// trade-history-helpers pattern: every helper is dependency-free,
// has no side effects, and is importable from `node --test` (Node
// can't parse .jsx files without a loader).
//
// The dashboard's two time-series charts ("cumulative realized
// P&L" + "balance over time") both already accept a `?range=` URL
// query parameter on the backend (`/api/pnl-timeseries` and
// `/api/snapshots`). The helpers in this file are the tiny glue
// that lets the operator switch between ranges from the UI:
//
//   - the curated preset list (`RANGE_OPTIONS`)
//   - a `DEFAULT_CHART_RANGE` constant the charts use on first
//     render (and as the fallback when an unrecognized value
//     sneaks through)
//   - a pure `isValidChartRange(value)` predicate so the chart
//     components can refuse a malformed range before they fire a
//     fetch
//   - a pure `chipClassForRange(selectedRange, candidate)` helper
//     so the chip-group renders consistently across both charts
//     (selected = filled, unselected = hollow)
//
// Range values intentionally match the format `parseRange` + the
// `?range=` URL parameter accept on the server side: `<int><s|m|h|d|w>`
// OR the literal string `all` (no filter). Adding a new option
// here is intentionally cheap — append a new `Object.freeze` to
// `RANGE_OPTIONS` and the chip + validation + URL param all
// pick it up automatically.

/**
 * Date-range presets exposed in the DASHBOARD's chart pickers.
 * Mirrors the curated list the TRADE HISTORY view uses
 * (`trade-history-helpers.mjs#RANGE_OPTIONS`) — keeping both lists
 * aligned means the operator only has to learn one vocabulary.
 *
 * `value` is the literal string the server's `parseRange` accepts
 * (`<int><s|m|h|d|w>` or `'all'`). `label` is what the chip
 * renders; the dashboard's narrow header keeps these short so the
 * picker fits on one row.
 *
 * @type {ReadonlyArray<Readonly<{ value: string, label: string }>>}
 */
export const RANGE_OPTIONS = Object.freeze([
  Object.freeze({ value: '24h', label: '24h' }),
  Object.freeze({ value: '7d',  label: '7d'  }),
  Object.freeze({ value: '30d', label: '30d' }),
  Object.freeze({ value: '90d', label: '90d' }),
  Object.freeze({ value: 'all', label: 'all' }),
]);

/**
 * Default range for both DASHBOARD charts when the operator has
 * not picked one yet. Matches `cfg.dashboard.snapshot_default_range`
 * (30d) and `cfg.dashboard.pnl_timeseries_default_range` (30d) so
 * the chart on first paint shows the same window the rest of the
 * dashboard defaults to.
 *
 * @type {string}
 */
export const DEFAULT_CHART_RANGE = '30d';

/**
 * Pure predicate: is `value` one of the curated chart-range
 * presets? Used by the chart components to refuse a malformed
 * range (e.g. URL state corruption, JSON import edge case) before
 * firing a fetch — keeps the chip-group's contract honest.
 *
 * Anything that isn't a string OR isn't in `RANGE_OPTIONS` is
 * rejected; `null`, `undefined`, numbers, booleans, and free-form
 * strings like '1y' or 'forever' all fall through to the default.
 *
 * Note: this is the PRESET-ONLY validator. The server's `parseRange`
 * also accepts arbitrary `<int><s|m|h|d|w>` strings (`'45d'`,
 * `'3h'`, etc.), but the UI only exposes the curated list — so a
 * free-form URL param survives the server round-trip but is
 * refused by the chip-group predicate.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidChartRange(value) {
  if (typeof value !== 'string') return false;
  return RANGE_OPTIONS.some((opt) => opt.value === value);
}

/**
 * Pure helper: build the chip-group className for a given preset.
 * The two dashboard charts (cumulative P&L + balance over time)
 * render the same chip-group UI — keeping the classNames in one
 * helper means a CSS tweak lands in both places at once.
 *
 *   selected (filled, primary text color, subtle border)
 *   unselected (muted text, hover-friendly border)
 *
 * The base classes (`inline-flex items-center rounded border px-2
 * py-0.5 font-mono text-[10px] uppercase tracking-wider`) match
 * the Settings view's per-knob chip styling so the dashboard stays
 * visually consistent with the rest of the operator UI.
 *
 * @param {string} selectedRange
 * @param {string} candidateValue
 * @returns {string}
 */
export function chipClassForRange(selectedRange, candidateValue) {
  const base = 'inline-flex items-center rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider transition-colors';
  if (selectedRange === candidateValue) {
    return `${base} border-emerald-500 bg-emerald-500/10 text-emerald-300`;
  }
  return `${base} border-ink-600 text-ash-300 hover:border-ink-500 hover:text-ash-100`;
}

/**
 * Pure helper: resolve an incoming range value to a safe preset.
 * Falls back to `DEFAULT_CHART_RANGE` when the input is missing,
 * non-string, or not in the curated list. Used on first render so
 * a corrupted URL state (or a future preset deletion) doesn't
 * strand the chart on an invalid range.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function resolveChartRange(value) {
  if (isValidChartRange(value)) return /** @type {string} */ (value);
  return DEFAULT_CHART_RANGE;
}