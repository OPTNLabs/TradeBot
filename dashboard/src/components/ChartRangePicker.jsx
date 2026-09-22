// dashboard/src/components/ChartRangePicker.jsx
//
// T51: chip-group range picker used by the DASHBOARD's two
// time-series charts ("cumulative realized P&L" + "balance over
// time"). The two charts render different data but share the
// same range vocabulary (24h / 7d / 30d / 90d / all), so the
// picker lives in one place to keep the styling + behavior in
// lockstep.
//
// Stateless / controlled — the parent owns the selected value
// and a setter. The picker just renders the curated preset list
// from `dashboard-range-helpers.mjs` and forwards clicks.
//
// The picker's classes match the rest of the dashboard's small
// inline-UI elements (Settings editor's per-knob chips, the
// TRADE HISTORY filter chips): uppercase tracking-wider mono,
// neutral-when-unselected / emerald-when-selected. Keeps the
// dashboard visually consistent without a global design-token
// layer.
//
// Re-exported pure helpers (`isValidChartRange`, etc.) live in
// `dashboard-range-helpers.mjs` so the test suite can exercise
// the validation without booting React.

import React from 'react';
import {
  RANGE_OPTIONS,
  chipClassForRange,
} from '../views/dashboard-range-helpers.mjs';

/**
 * @param {Object} props
 * @param {string} props.value              currently selected range preset
 * @param {(next: string) => void} props.onChange  called with the new
 *                                                  preset value when the
 *                                                  operator clicks a chip
 * @param {string} [props.ariaLabel]        accessible label for the chip
 *                                          group (defaults to
 *                                          "chart date range")
 * @param {string} [props.className]        optional extra class on the
 *                                          wrapping <div>
 */
export default function ChartRangePicker(props) {
  const value = props.value;
  const onChange = props.onChange;
  const ariaLabel = props.ariaLabel || 'chart date range';
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      data-testid="chart-range-picker"
      className={`flex flex-wrap items-center gap-1 ${props.className || ''}`}
    >
      {RANGE_OPTIONS.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={selected}
            data-range={opt.value}
            data-selected={selected ? 'true' : 'false'}
            className={chipClassForRange(value, opt.value)}
            onClick={() => {
              if (typeof onChange === 'function' && opt.value !== value) {
                onChange(opt.value);
              }
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}