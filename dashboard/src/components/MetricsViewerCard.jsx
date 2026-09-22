// dashboard/src/components/MetricsViewerCard.jsx
//
// T79 subset 2 — Dashboard tile for the Prometheus-style
// `GET /metrics` endpoint shipped by T78 subset 1 + T79.
//
// The card mounts below `<FeeBreakdownCard />` on Dashboard.jsx
// and surfaces the most recent /metrics scrape as a compact
// table (one row per metric series). Subscribes to
// `useRefresh().tick` so the table re-renders at the dashboard's
// 60s auto-refresh cadence. The Prometheus text format is
// defensively parsed by a small pure helper
// (`parsePrometheusText`) — non-fatal parse failures render an
// "unavailable" pill with the raw text body available behind a
// toggle.
//
// Failure model: every API call returns `{ok, text, ...}`. On
// `ok:false` or a null envelope the tile renders an "unavailable"
// pill rather than blanking the whole card. The raw text body
// is ALWAYS surfaced via a `<details>` toggle so the operator
// can grep it directly without leaving the page.

import React, { useCallback, useEffect, useState } from 'react';
import { useApi, useRefresh } from '../lib/api-context.jsx';
import {
  parsePrometheusText,
  summarizeMetricBlocks,
  groupByPrefix,
  isMetricsUnavailable,
  metricsErrorMessage,
  metricsHelpText,
} from '../views/metrics-view-helpers.mjs';

export default function MetricsViewerCard() {
  const { api } = useApi();
  const { tick } = useRefresh();
  const [text, setText] = useState(/** @type {string|null} */ (null));
  const [err, setErr] = useState(/** @type {string|null} */ (null));
  const [loading, setLoading] = useState(true);
  const [rawOpen, setRawOpen] = useState(false);

  const refresh = useCallback(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const r = await api.metricsText();
        if (cancelled) return;
        if (!r.ok) {
          setErr(r.error || 'request failed');
          setText(null);
        } else {
          setText(r.text || '');
          setErr(null);
        }
      } catch (e) {
        if (!cancelled) {
          setErr(String(e && e.message ? e.message : 'unknown error'));
          setText(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [api]);

  useEffect(() => {
    const cleanup = refresh();
    return cleanup;
  }, [refresh, tick]);

  const unavailable = isMetricsUnavailable(text);
  const errorMessage = metricsErrorMessage(err, text);
  const blocks = parsePrometheusText(text);
  const summary = summarizeMetricBlocks(blocks);
  const groups = groupByPrefix(blocks);

  return (
    <div className="rounded border border-ink-700 bg-ink-900/30 p-3">
      {/* Header */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold tracking-wide text-ink-100">
            /metrics
          </h3>
          <span className="rounded bg-ink-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-400">
            prometheus
          </span>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-ink-400">
          {loading && <span>loading…</span>}
          {!loading && !unavailable && (
            <>
              <span>{summary.totalSeries} series</span>
              <span>·</span>
              <span>{summary.totalSamples} samples</span>
              {summary.upValue !== null && (
                <>
                  <span>·</span>
                  <span className={summary.upValue === 1 ? 'text-emerald-400' : 'text-rose-400'}>
                    tradebot_up={summary.upValue}
                  </span>
                </>
              )}
              {summary.tickCount !== null && (
                <>
                  <span>·</span>
                  <span>tick #{summary.tickCount}</span>
                </>
              )}
            </>
          )}
        </div>
      </div>

      {unavailable ? (
        <div className="rounded border border-amber-700 bg-amber-950/30 p-2 text-xs text-amber-300">
          <div className="font-semibold">unavailable</div>
          <div className="mt-1 text-amber-400">{metricsHelpText(text)}</div>
          {errorMessage && (
            <div className="mt-1 text-amber-500">error: {errorMessage}</div>
          )}
        </div>
      ) : (
        <>
          {/* Grouped metric tables */}
          {groups.map((group) => (
            <details
              key={group.prefix}
              className="mt-2 rounded border border-ink-700 bg-ink-900/30"
              open
            >
              <summary className="cursor-pointer select-none px-2 py-1 text-xs font-semibold text-ink-200">
                {group.prefix} <span className="text-ink-500">({group.seriesCount} series)</span>
              </summary>
              <div className="overflow-x-auto p-1">
                <table className="w-full text-[11px] text-ink-200">
                  <thead>
                    <tr className="text-left text-ink-500">
                      <th className="px-1 py-0.5 font-normal">series</th>
                      <th className="px-1 py-0.5 font-normal">labels</th>
                      <th className="px-1 py-0.5 text-right font-normal">value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.series.flatMap((s) => (
                      // 2026-09-20 fixup: render one row per SAMPLE,
                      // not one row per BLOCK. The previous shape
                      // assumed `s.labels` existed on the block,
                      // but blocks only have `samples: [{labels,
                      // value}]` — so `s.labels` was always
                      // undefined and `Object.keys(undefined)`
                      // threw "TypeError: can't convert undefined
                      // to object" whenever the MetricsViewerCard
                      // rendered. Now each sample gets its own row
                      // with the block name + the sample's per-row
                      // labels (e.g. `probe_status="ok"`) + the
                      // sample's value. Samples without labels
                      // show the literal "—" so the column doesn't
                      // collapse on a missing key.
                      (Array.isArray(s.samples) ? s.samples : []).map((sample, i) => {
                        const labels = (sample && typeof sample.labels === 'object' && sample.labels !== null)
                          ? sample.labels : {};
                        const labelEntries = Object.entries(labels);
                        return (
                          <tr key={`${s.name}#${i}`} className="border-t border-ink-800">
                            <td className="px-1 py-0.5 font-mono text-ink-300">{s.name}</td>
                            <td className="px-1 py-0.5 text-ink-400">
                              {labelEntries.length > 0
                                ? labelEntries.map(([k, v]) => `${k}="${v}"`).join(' ')
                                : <span className="text-ink-600">—</span>}
                            </td>
                            <td className="px-1 py-0.5 text-right font-mono">
                              {sample && sample.value !== undefined ? sample.value : '—'}
                            </td>
                          </tr>
                        );
                      })
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ))}

          {/* Raw text toggle */}
          <div className="mt-2">
            <button
              type="button"
              className="text-[11px] text-ink-400 underline hover:text-ink-200"
              onClick={() => setRawOpen((v) => !v)}
            >
              {rawOpen ? 'hide raw' : 'show raw'}
            </button>
            {rawOpen && (
              <pre className="mt-1 max-h-72 overflow-auto rounded bg-ink-950 p-2 text-[10px] text-ink-300">
                {text}
              </pre>
            )}
          </div>
        </>
      )}
    </div>
  );
}