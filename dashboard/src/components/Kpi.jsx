// dashboard/src/components/Kpi.jsx
//
// Single KPI tile — label + big number + optional sub-label.
// Used in a grid on the DASHBOARD view for headline numbers
// (balance, win rate, total P&L, fees paid, etc).

import React from 'react';
import { pnlClass } from '../lib/format.mjs';

/**
 * @param {Object} props
 * @param {string} props.label
 * @param {React.ReactNode} props.value
 * @param {string} [props.sub]
 * @param {number|null|undefined} [props.pct]   when set, colours the value green/red via pnlClass
 * @param {string|null} [props.valueClass]      explicit Tailwind colour override for the value (e.g. 'text-pnl-win'/'text-pnl-loss'). Wins over pct.
 * @param {string} [props.className]
 */
export default function Kpi(props) {
  const colour = (typeof props.valueClass === 'string' && props.valueClass.length > 0)
    ? props.valueClass
    : (typeof props.pct === 'number' ? pnlClass(props.pct) : 'text-ash-100');
  return (
    <div className={`panel p-4 ${props.className || ''}`}>
      <div className="label">{props.label}</div>
      <div className={`num mt-1 text-2xl font-semibold ${colour}`}>{props.value}</div>
      {props.sub && <div className="num mt-1 text-xs text-ash-300">{props.sub}</div>}
    </div>
  );
}