// dashboard/src/components/Panel.jsx
//
// Card-like container used by every panel on the dashboard.
// Keeps the chrome consistent and the JSX at the call-site short.

import React from 'react';

/**
 * @param {Object} props
 * @param {string} [props.title]            panel header text
 * @param {string} [props.subtitle]         one-line muted descriptor rendered
 *                                          beneath the title (e.g. "per-tick
 *                                          decision tree · auto-refresh 60s").
 *                                          Optional — most call-sites are
 *                                          title-only.
 * @param {React.ReactNode} [props.action]  right-aligned action slot
 *                                          (e.g. refresh button). Accepted
 *                                          as an alias for `right` so older
 *                                          call-sites keep working.
 * @param {React.ReactNode} [props.right]   right-aligned action slot. The
 *                                          views in this repo standardised
 *                                          on `right`; `action` is kept as a
 *                                          back-compat alias. If both are
 *                                          passed, `right` wins.
 * @param {React.ReactNode} props.children
 * @param {string} [props.className]
 */
export default function Panel(props) {
  const rightSlot = props.right ?? props.action;
  const hasHeader = Boolean(props.title || rightSlot || props.subtitle);
  return (
    <section className={`panel ${props.className || ''}`}>
      {hasHeader && (
        <header className="flex items-start justify-between gap-3 border-b border-ink-700 px-4 py-2">
          <div className="min-w-0">
            {props.title && <h2 className="panel-title border-0 px-0 py-0">{props.title}</h2>}
            {props.subtitle && (
              <p className="mt-0.5 text-[11px] text-ash-400 leading-snug">
                {props.subtitle}
              </p>
            )}
          </div>
          {rightSlot && <div className="text-xs text-ash-300 shrink-0">{rightSlot}</div>}
        </header>
      )}
      <div className="p-4">{props.children}</div>
    </section>
  );
}