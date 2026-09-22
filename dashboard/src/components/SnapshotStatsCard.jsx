// dashboard/src/components/SnapshotStatsCard.jsx
//
// T65 — Dashboard tile for the T64 snapshot aggregate endpoint.
// The card mounts below the balance-over-time chart on Dashboard.jsx
// and renders the T64 aggregate envelope as a compact "stats bar"
// (min / max / mean / latest balance + drawdown + open-position
// count) plus a small sparkline slot.
//
// The card subscribes to `useRefresh().tick` so it re-renders at
// the dashboard's auto-refresh cadence (60s by default). The server
// side cache keeps the polling cheap.
//
// Failure model: every API call returns `{ok, data, error}`. On
// `ok:false` or a null envelope the tile renders an "unavailable"
// pill rather than blanking the whole card. Null fields render as
// "—" (not "NaN" or "null"). The source badge surfaces whether the
// envelope was served from the TTL cache or computed fresh.

import React, { useCallback, useEffect, useState } from 'react';
import { useApi, useRefresh } from '../lib/api-context.jsx';
import {
  buildStatsBarLines,
  cacheSourceLabel,
  isAggregateUnavailable,
  aggregateErrorMessage,
  bucketCountLabel,
} from '../views/snapshot-stats-helpers.mjs';

export default function SnapshotStatsCard() {
  const { api } = useApi();
  // T65: subscribe to the dashboard's auto-refresh tick (60s by
  // default — see `AppProviders` in `api-context.jsx`). This avoids
  // spinning up a parallel polling timer that would leak across
  // hot-reloads.
  const { tick } = useRefresh();
  const [agg, setAgg] = useState(/** @type {any} */ (null));
  const [err, setErr] = useState(/** @type {string|null} */ (null));
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const r = await api.snapshotStats({});
        if (cancelled) return;
        if (!r.ok) {
          setErr(r.error || 'request failed');
          setAgg(null);
        } else {
          setAgg(r.data);
          setErr(null);
        }
      } catch (e) {
        if (!cancelled) {
          setErr(String(e && e.message ? e.message : 'unknown error'));
          setAgg(null);
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

  const unavailable = isAggregateUnavailable(agg);
  const statsLines = buildStatsBarLines(agg);
  const sourceLabel = cacheSourceLabel(agg);
  const countLabel = bucketCountLabel(agg);

  return (
    <div className="rounded border border-ink-700 bg-ink-900/30 p-3">
      {/* Header */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-mono uppercase tracking-wider text-ash-300">
            snapshot stats
          </span>
          <span className="text-[11px] text-ash-500">
            {countLabel}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {loading && (
            <span className="text-[10px] font-mono text-ash-500">loading…</span>
          )}
          {!loading && sourceLabel !== '—' && (
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wider ${
                sourceLabel === 'fresh'
                  ? 'border-emerald-700/60 text-emerald-400'
                  : 'border-ink-600 text-ash-400'
              }`}
            >
              {sourceLabel}
            </span>
          )}
        </div>
      </div>

      {/* Error / unavailable state */}
      {unavailable && (
        <div className="rounded border border-amber-700/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-300">
          {aggregateErrorMessage(agg)}
        </div>
      )}

      {/* Stats bar */}
      {!unavailable && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
          {statsLines.map((line) => (
            <div key={line.label} className="flex items-baseline justify-between gap-2">
              <span className="text-[10px] font-mono uppercase tracking-wider text-ash-500">
                {line.label}
              </span>
              <span
                className={`text-[11px] font-mono tabular-nums ${
                  line.highlight
                    ? 'font-semibold text-ash-100'
                    : (line.valueClass || 'text-ash-200')
                }`}
              >
                {line.value}
                {line.unit && <span className="ml-0.5 text-[9px] text-ash-500">{line.unit}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
