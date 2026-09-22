// dashboard/src/components/TokenSummaryCard.jsx
//
// T68 — Dashboard tile that consumes /api/tokens/summary (shipped
// in T63 subset 1). The tile mounts below the snapshot stats card
// on Dashboard.jsx and renders two layers:
//
//   1. Rollup view (default): one row per token the bot has touched,
//      with realized P&L (BCH, color-coded), win-rate, trade count,
//      open-position count, mean hold time. Click a row →
//      drill-down to the per-token attribution.
//
//   2. Detail view: fetched via /api/tokens/summary?token_id=<hex>
//      when a row is clicked. Renders the per-token closed_trades[]
//      attribution (each trade's entry/exit/hold/P&L/outcome) + the
//      open_positions[] list. A back button restores the rollup.
//
// The card subscribes to `useRefresh().tick` so it re-polls at the
// dashboard's 60s auto-refresh cadence. The server-side history
// read is fast (capped at 5000 events by the endpoint) so polling
// is cheap.
//
// Failure model: every API call returns `{ok, data, error}`. On
// `ok:false` or a null envelope the tile renders an "unavailable"
// pill rather than blanking the whole card. Null fields render as
// "—" (not "NaN" or "null"). The rollup-empty state renders a
// friendly "no token history yet" message.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useApi, useRefresh } from '../lib/api-context.jsx';
import {
  buildRollupRow,
  buildClosedTradeRow,
  buildOpenPositionRow,
  buildRollupTotals,
  isRollupEmpty,
  isDetailUnavailable,
  formatBch,
  formatHoldMs,
  shortTokenId,
} from '../views/token-summary-helpers.mjs';

export default function TokenSummaryCard() {
  const { api } = useApi();
  // T68: subscribe to the dashboard's auto-refresh tick so the
  // rollup re-polls at the same cadence as the rest of the
  // dashboard (60s by default — see `AppProviders` in
  // `api-context.jsx`). Detail view does NOT re-poll (it's a
  // one-shot fetch when the operator clicks a row).
  const { tick } = useRefresh();
  const [rollup, setRollup] = useState(/** @type {any} */ (null));
  const [err, setErr] = useState(/** @type {string|null} */ (null));
  const [loading, setLoading] = useState(true);

  const [detail, setDetail] = useState(/** @type {any} */ (null));
  const [detailErr, setDetailErr] = useState(/** @type {string|null} */ (null));
  const [detailLoading, setDetailLoading] = useState(false);

  const refreshRollup = useCallback(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const r = await api.tokensSummary({});
        if (cancelled) return;
        if (!r.ok) {
          setErr(r.error || 'request failed');
          setRollup(null);
        } else {
          setRollup(r.data);
          setErr(null);
        }
      } catch (e) {
        if (!cancelled) {
          setErr(String(e && e.message ? e.message : 'unknown error'));
          setRollup(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [api]);

  useEffect(() => {
    const cleanup = refreshRollup();
    return cleanup;
  }, [refreshRollup, tick]);

  const rollupRows = useMemo(() => {
    if (!rollup || !Array.isArray(rollup.tokens)) return [];
    return rollup.tokens.map(buildRollupRow);
  }, [rollup]);

  const totals = useMemo(() => buildRollupTotals(rollupRows), [rollupRows]);

  const openDetail = useCallback(async (tokenId) => {
    if (typeof tokenId !== 'string' || tokenId.length === 0) return;
    setDetailLoading(true);
    setDetailErr(null);
    setDetail(null);
    try {
      const r = await api.tokensSummary({ tokenId });
      if (!r.ok) {
        setDetailErr(r.error || 'request failed');
      } else {
        setDetail(r.data);
      }
    } catch (e) {
      setDetailErr(String(e && e.message ? e.message : 'unknown error'));
    } finally {
      setDetailLoading(false);
    }
  }, [api]);

  const closeDetail = useCallback(() => {
    setDetail(null);
    setDetailErr(null);
  }, []);

  const isEmpty = isRollupEmpty(rollup);

  return (
    <div className="rounded border border-ink-700 bg-ink-900/30 p-3">
      {/* Header */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-mono uppercase tracking-wider text-ash-300">
            per-token summary
          </span>
          {!detail && !isEmpty && (
            <span className="text-[11px] text-ash-500">
              {totals.token_count} tokens · {totals.total_closed} trades ·{' '}
              <span className={totals.total_pnl_sats > 0n
                ? 'text-emerald-400'
                : totals.total_pnl_sats < 0n
                  ? 'text-rose-400'
                  : 'text-ash-400'}>
                {totals.total_pnl_bch_display} BCH
              </span>
            </span>
          )}
          {detail && (
            <span className="text-[11px] text-ash-500">
              {typeof detail.symbol === 'string' && detail.symbol.length > 0
                ? detail.symbol
                : shortTokenId(detail.token_id)}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {loading && (
            <span className="text-[10px] font-mono text-ash-500">loading…</span>
          )}
          {detail && !detailLoading && (
            <button
              type="button"
              onClick={closeDetail}
              className="rounded border border-ink-600 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider text-ash-200 hover:border-ink-500"
            >
              ← back
            </button>
          )}
        </div>
      </div>

      {/* Error / unavailable state */}
      {err && (
        <div className="rounded border border-amber-700/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-300">
          {err}
        </div>
      )}

      {/* Empty state */}
      {!err && isEmpty && !loading && (
        <div className="px-1 py-2 text-[11px] text-ash-500">
          no token history yet — the bot hasn't recorded any
          entries/exits.
        </div>
      )}

      {/* Rollup table */}
      {!detail && !err && !isEmpty && (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-ash-500 font-mono uppercase tracking-wider text-[9px]">
                <th className="text-left font-normal pb-1 pr-2">token</th>
                <th className="text-right font-normal pb-1 pr-2">closed</th>
                <th className="text-right font-normal pb-1 pr-2">open</th>
                <th className="text-right font-normal pb-1 pr-2">win %</th>
                <th className="text-right font-normal pb-1 pr-2">hold</th>
                <th className="text-right font-normal pb-1 pr-2">realized P&amp;L (BCH)</th>
              </tr>
            </thead>
            <tbody>
              {rollupRows.map((r) => (
                <tr
                  key={r.token_id ?? r.shortTokenId}
                  className="border-t border-ink-800/60 hover:bg-ink-800/30 cursor-pointer"
                  onClick={() => openDetail(r.token_id)}
                >
                  <td className="py-1 pr-2">
                    <span className="text-ash-100 font-mono">{r.shortSymbol}</span>
                    <span className="ml-2 text-[9px] text-ash-500 font-mono">{r.shortTokenId}</span>
                  </td>
                  <td className="py-1 pr-2 text-right text-ash-200 tabular-nums">{r.closed_trade_count}</td>
                  <td className="py-1 pr-2 text-right text-ash-200 tabular-nums">
                    {r.open_position_count > 0
                      ? <span className="text-amber-400">{r.open_position_count}</span>
                      : r.open_position_count}
                  </td>
                  <td className="py-1 pr-2 text-right text-ash-200 tabular-nums">{r.win_rate_display}</td>
                  <td className="py-1 pr-2 text-right text-ash-200 tabular-nums">{r.mean_hold_display}</td>
                  <td className={`py-1 pr-2 text-right tabular-nums ${r.severityClass}`}>
                    {r.pnl_bch_display}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Detail loading */}
      {detailLoading && (
        <div className="px-1 py-2 text-[11px] text-ash-500">loading detail…</div>
      )}

      {/* Detail error */}
      {detailErr && !detailLoading && (
        <div className="rounded border border-amber-700/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-300">
          {detailErr}
        </div>
      )}

      {/* Detail view */}
      {detail && !detailLoading && !isDetailUnavailable(detail) && (() => {
        const closed = Array.isArray(detail.closed_trades) ? detail.closed_trades.map(buildClosedTradeRow) : [];
        const open = Array.isArray(detail.open_positions) ? detail.open_positions.map(buildOpenPositionRow) : [];
        const detailPnlSats = (() => {
          let total = 0n;
          for (const t of closed) if (t.pnl_sats !== null) total += t.pnl_sats;
          return total;
        })();
        const detailPnlBch = formatBch(
          (() => {
            if (detailPnlSats === 0n) return 0;
            // Reuse the helper indirectly via bch number conversion
            const n = Number(detailPnlSats) / 100_000_000;
            return Number.isFinite(n) ? n : null;
          })(),
          6,
        );
        return (
          <div className="space-y-3">
            {/* Summary header */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
              <span className="text-ash-500 font-mono uppercase tracking-wider text-[9px]">realized</span>
              <span className={`tabular-nums ${
                detailPnlSats > 0n
                  ? 'text-emerald-400'
                  : detailPnlSats < 0n
                    ? 'text-rose-400'
                    : 'text-ash-300'
              }`}>
                {detailPnlBch} BCH
              </span>
              <span className="text-ash-500 font-mono uppercase tracking-wider text-[9px]">trades</span>
              <span className="text-ash-200 tabular-nums">{closed.length}</span>
              <span className="text-ash-500 font-mono uppercase tracking-wider text-[9px]">open</span>
              <span className={open.length > 0 ? 'text-amber-400 tabular-nums' : 'text-ash-200 tabular-nums'}>
                {open.length}
              </span>
              {typeof detail.win_rate === 'number' && Number.isFinite(detail.win_rate) && (
                <>
                  <span className="text-ash-500 font-mono uppercase tracking-wider text-[9px]">win</span>
                  <span className="text-ash-200 tabular-nums">
                    {(detail.win_rate * 100).toFixed(1)}%
                  </span>
                </>
              )}
              {detail.mean_hold_ms !== null && detail.mean_hold_ms !== undefined && (
                <>
                  <span className="text-ash-500 font-mono uppercase tracking-wider text-[9px]">avg hold</span>
                  <span className="text-ash-200 tabular-nums">{formatHoldMs(detail.mean_hold_ms)}</span>
                </>
              )}
            </div>

            {/* Open positions */}
            {open.length > 0 && (
              <div>
                <div className="mb-1 text-[10px] font-mono uppercase tracking-wider text-ash-500">
                  open positions ({open.length})
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-[11px]">
                    <thead>
                      <tr className="text-ash-500 font-mono uppercase tracking-wider text-[9px]">
                        <th className="text-left font-normal pb-1 pr-2">position</th>
                        <th className="text-left font-normal pb-1 pr-2">entered</th>
                        <th className="text-right font-normal pb-1 pr-2">age</th>
                        <th className="text-right font-normal pb-1 pr-2">size (BCH)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {open.map((o) => (
                        <tr key={o.position_id ?? o.entry_ts} className="border-t border-ink-800/60">
                          <td className="py-1 pr-2 font-mono text-ash-300 text-[10px]">{o.position_id ?? '—'}</td>
                          <td className="py-1 pr-2 text-ash-300 font-mono text-[10px]">{o.entry_ts ?? '—'}</td>
                          <td className="py-1 pr-2 text-right text-ash-200 tabular-nums">{o.age_display}</td>
                          <td className="py-1 pr-2 text-right text-ash-200 tabular-nums">{o.size_bch_display}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Closed trades */}
            <div>
              <div className="mb-1 text-[10px] font-mono uppercase tracking-wider text-ash-500">
                closed trades ({closed.length})
              </div>
              {closed.length === 0 ? (
                <div className="text-[11px] text-ash-500">no closed trades yet for this token.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-[11px]">
                    <thead>
                      <tr className="text-ash-500 font-mono uppercase tracking-wider text-[9px]">
                        <th className="text-left font-normal pb-1 pr-2">opened</th>
                        <th className="text-left font-normal pb-1 pr-2">closed</th>
                        <th className="text-left font-normal pb-1 pr-2">exit</th>
                        <th className="text-right font-normal pb-1 pr-2">hold</th>
                        <th className="text-right font-normal pb-1 pr-2">net P&amp;L (BCH)</th>
                        <th className="text-right font-normal pb-1 pr-2">%</th>
                      </tr>
                    </thead>
                    <tbody>
                      {closed.map((t) => (
                        <tr key={t.position_id ?? `${t.entry_ts}-${t.exit_ts}`} className="border-t border-ink-800/60">
                          <td className="py-1 pr-2 text-ash-300 font-mono text-[10px]">{t.entry_ts ?? '—'}</td>
                          <td className="py-1 pr-2 text-ash-300 font-mono text-[10px]">{t.exit_ts ?? '—'}</td>
                          <td className="py-1 pr-2 text-ash-300 font-mono text-[10px]">{t.exit_kind ?? '—'}</td>
                          <td className="py-1 pr-2 text-right text-ash-200 tabular-nums">{t.hold_display}</td>
                          <td className={`py-1 pr-2 text-right tabular-nums ${t.severityClass}`}>
                            {t.pnl_bch_display}
                          </td>
                          <td className="py-1 pr-2 text-right text-ash-300 tabular-nums">{t.pnl_pct_display}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
