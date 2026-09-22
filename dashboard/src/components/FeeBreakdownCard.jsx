// dashboard/src/components/FeeBreakdownCard.jsx
//
// T71 — Dashboard tile that consumes /api/fees/breakdown (shipped
// in T71 subset 1). The tile mounts below the TokenSummaryCard on
// Dashboard.jsx and renders two layers:
//
//   1. Rollup view (default): one row per token the bot has touched,
//      with the LP / tx / slippage fee split. Each share is color-
//      coded: red > 50%, amber 25-50%, green < 25% (operator
//      intuition: "is my slippage cost eating my LP fees?"). A
//      stacked-bar at the right of each row shows the LP/tx/
//      slippage share composition. The header shows the cross-token
//      totals so the operator gets a global "how much have I paid
//      in fees overall" pill at a glance.
//
//   2. Detail view: fetched via /api/fees/breakdown?token_id=<hex>
//      when a row is clicked. Renders the per-token per-trade
//      attribution array (entry-side + exit-side legs for each
//      position). A back button restores the rollup.
//
// The card subscribes to `useRefresh().tick` so it re-polls at
// the dashboard's 60s auto-refresh cadence. The server-side
// history read is fast (capped at 5000 events by the endpoint)
// so polling is cheap.
//
// Failure model: every API call returns `{ok, data, error}`. On
// `ok:false` or a null envelope the tile renders an "unavailable"
// pill rather than blanking the whole card. Null fields render as
// "—" (not "NaN" or "null"). The rollup-empty state renders a
// friendly "no fee-tracked trades yet" message.

import React, { useCallback, useEffect, useState } from 'react';
import { useApi, useRefresh } from '../lib/api-context.jsx';
import {
  buildBreakdownRow,
  buildBreakdownTotals,
  buildTradeFeeRow,
  isRollupEmpty,
  isDetailUnavailable,
  shareClass,
} from '../views/fee-breakdown-helpers.mjs';

export default function FeeBreakdownCard() {
  const { api } = useApi();
  // T71: subscribe to the dashboard's auto-refresh tick so the
  // rollup re-polls at the same cadence as the rest of the
  // dashboard (60s by default — see `AppProviders` in
  // `api-context.jsx`). Detail view does NOT re-poll (it's a
  // one-shot fetch when the operator clicks a row).
  const { tick } = useRefresh();
  const [rollup, setRollup] = useState(/** @type {any} */ (null));
  const [detail, setDetail] = useState(/** @type {any} */ (null));
  const [detailLoading, setDetailLoading] = useState(false);
  const [err, setErr] = useState(/** @type {string|null} */ (null));
  const [loading, setLoading] = useState(true);

  const refreshRollup = useCallback(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const r = await api.feesBreakdown({});
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

  const openDetail = useCallback((tokenId) => {
    if (!tokenId) return;
    let cancelled = false;
    setDetailLoading(true);
    setDetail(null);
    (async () => {
      try {
        const r = await api.feesBreakdown({ tokenId });
        if (cancelled) return;
        if (!r.ok) {
          setErr(r.error || 'detail request failed');
        } else {
          setDetail(r.data);
          setErr(null);
        }
      } catch (e) {
        if (!cancelled) {
          setErr(String(e && e.message ? e.message : 'unknown error'));
        }
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [api]);

  const closeDetail = useCallback(() => {
    setDetail(null);
    setErr(null);
  }, []);

  const rollupEmpty = isRollupEmpty(rollup);
  const rollupRows = (rollup && Array.isArray(rollup.tokens))
    ? rollup.tokens.map(buildBreakdownRow)
    : [];
  const totalsRow = buildBreakdownTotals(rollup?.totals);
  const detailUnavailable = isDetailUnavailable(detail);
  const detailRows = (detail && Array.isArray(detail.trades))
    ? detail.trades.map(buildTradeFeeRow)
    : [];

  // ── Detail view ─────────────────────────────────────────────
  if (detail) {
    return (
      <div className="rounded border border-ink-700 bg-ink-900/30 p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={closeDetail}
              className="rounded border border-ink-600 bg-ink-800 px-2 py-0.5 text-[11px] font-mono uppercase tracking-wider text-ash-300 hover:bg-ink-700"
            >
              ← back
            </button>
            <span className="text-[11px] font-mono uppercase tracking-wider text-ash-300">
              fee breakdown · {detail.symbol || (typeof detail.token_id === 'string' ? detail.token_id.slice(0, 9) + '…' : '—')}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {detailLoading && (
              <span className="text-[10px] font-mono text-ash-500">loading…</span>
            )}
            {!detailLoading && (
              <span className="text-[10px] font-mono text-ash-500">
                {detailRows.length} trades
              </span>
            )}
          </div>
        </div>

        {detailUnavailable ? (
          <div className="rounded border border-amber-700/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-300">
            no fees found for this token
          </div>
        ) : (
          <>
            {/* Per-token totals header */}
            <div className="mb-2 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
              {[
                { label: 'lp fees', value: detail.lp_fees_sats_total ? String(detail.lp_fees_sats_total) + ' sats' : '—' },
                { label: 'tx fees', value: detail.tx_fees_sats_total ? String(detail.tx_fees_sats_total) + ' sats' : '—' },
                { label: 'slippage', value: detail.slippage_cost_sats_total ? String(detail.slippage_cost_sats_total) + ' sats' : '—' },
                { label: 'total', value: detail.fees_paid_sats_total ? String(detail.fees_paid_sats_total) + ' sats' : '—' },
              ].map((line) => (
                <div key={line.label} className="flex items-baseline justify-between gap-2">
                  <span className="text-[10px] font-mono uppercase tracking-wider text-ash-500">{line.label}</span>
                  <span className="text-[11px] font-mono tabular-nums text-ash-100">{line.value}</span>
                </div>
              ))}
            </div>

            {/* Per-trade table */}
            <div className="overflow-x-auto">
              <table className="w-full text-[11px] font-mono">
                <thead>
                  <tr className="border-b border-ink-700 text-[10px] uppercase tracking-wider text-ash-500">
                    <th className="py-1 text-left">position</th>
                    <th className="py-1 text-left">opened</th>
                    <th className="py-1 text-left">closed</th>
                    <th className="py-1 text-left">kind</th>
                    <th className="py-1 text-right">lp entry</th>
                    <th className="py-1 text-right">lp exit</th>
                    <th className="py-1 text-right">tx entry</th>
                    <th className="py-1 text-right">tx exit</th>
                    <th className="py-1 text-right">slip entry</th>
                    <th className="py-1 text-right">slip exit</th>
                    <th className="py-1 text-right">total</th>
                  </tr>
                </thead>
                <tbody>
                  {detailRows.map((row) => (
                    <tr key={row.position_id || `${row.entry_ts}-${row.token_id}`} className="border-b border-ink-800">
                      <td className="py-1 text-ash-400">{row.position_id ? row.position_id.slice(0, 14) + (row.position_id.length > 14 ? '…' : '') : '—'}</td>
                      <td className="py-1 text-ash-300">{row.entry_ts ? row.entry_ts.slice(0, 16).replace('T', ' ') : '—'}</td>
                      <td className="py-1 text-ash-300">{row.exit_ts ? row.exit_ts.slice(0, 16).replace('T', ' ') : (row.is_open ? '— (open)' : '—')}</td>
                      <td className="py-1 text-ash-400">{row.exit_kind || (row.is_open ? 'open' : '—')}</td>
                      <td className="py-1 text-right tabular-nums text-ash-200">{row.format_lp_fees_entry}</td>
                      <td className="py-1 text-right tabular-nums text-ash-200">{row.format_lp_fees_exit}</td>
                      <td className="py-1 text-right tabular-nums text-ash-200">{row.format_tx_fees_entry}</td>
                      <td className="py-1 text-right tabular-nums text-ash-200">{row.format_tx_fees_exit}</td>
                      <td className="py-1 text-right tabular-nums text-ash-200">{row.format_slippage_entry}</td>
                      <td className="py-1 text-right tabular-nums text-ash-200">{row.format_slippage_exit}</td>
                      <td className="py-1 text-right tabular-nums font-semibold text-ash-100">{row.format_fees_total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    );
  }

  // ── Rollup view ─────────────────────────────────────────────
  return (
    <div className="rounded border border-ink-700 bg-ink-900/30 p-3">
      {/* Header */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-mono uppercase tracking-wider text-ash-300">
            fee breakdown
          </span>
          <span className="text-[10px] text-ash-500">
            {totalsRow.trade_count} trades · total fees {totalsRow.format_fees_paid}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {loading && (
            <span className="text-[10px] font-mono text-ash-500">loading…</span>
          )}
          {!loading && !rollupEmpty && (
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wider ${
                shareClass(totalsRow.slippage_severity)
              }`}
            >
              slippage {Math.round(totalsRow.slippage_share * 100)}%
            </span>
          )}
        </div>
      </div>

      {/* Error / unavailable state */}
      {err && !rollup && (
        <div className="rounded border border-amber-700/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-300">
          {err}
        </div>
      )}

      {/* Empty state */}
      {!loading && !err && rollupEmpty && (
        <div className="rounded border border-ink-700 bg-ink-900/40 px-3 py-2 text-xs text-ash-400">
          no fee-tracked trades yet — the bot hasn't recorded any closed positions.
        </div>
      )}

      {/* Rollup table */}
      {!rollupEmpty && !err && (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] font-mono">
            <thead>
              <tr className="border-b border-ink-700 text-[10px] uppercase tracking-wider text-ash-500">
                <th className="py-1 text-left">token</th>
                <th className="py-1 text-right">trades</th>
                <th className="py-1 text-right">lp fees</th>
                <th className="py-1 text-right">tx fees</th>
                <th className="py-1 text-right">slippage</th>
                <th className="py-1 text-right">total</th>
                <th className="py-1 text-left">share</th>
              </tr>
            </thead>
            <tbody>
              {rollupRows.map((row) => (
                <tr
                  key={row.token_id || row.token_label}
                  className="cursor-pointer border-b border-ink-800 hover:bg-ink-800/40"
                  onClick={() => openDetail(row.token_id)}
                >
                  <td className="py-1 text-ash-200">{row.token_label || '—'}</td>
                  <td className="py-1 text-right tabular-nums text-ash-300">{row.trade_count}</td>
                  <td className="py-1 text-right tabular-nums text-ash-200">{row.format_lp_fees}</td>
                  <td className="py-1 text-right tabular-nums text-ash-200">{row.format_tx_fees}</td>
                  <td className="py-1 text-right tabular-nums text-ash-200">{row.format_slippage_cost}</td>
                  <td className="py-1 text-right tabular-nums font-semibold text-ash-100">{row.format_fees_paid}</td>
                  <td className="py-1">
                    <ShareBar
                      lpShare={row.lp_share}
                      txShare={row.tx_share}
                      slippageShare={row.slippage_share}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Tiny stacked-bar component for the rollup row's "share"
 * column. Renders three segments (LP / tx / slippage) with the
 * severity-colored borders as the operator's at-a-glance
 * "is my slippage eating my LP?" signal.
 *
 * @param {Object} args
 * @param {number} args.lpShare        0..1
 * @param {number} args.txShare        0..1
 * @param {number} args.slippageShare  0..1
 * @returns {JSX.Element}
 */
function ShareBar({ lpShare, txShare, slippageShare }) {
  const lp = clamp01(lpShare);
  const tx = clamp01(txShare);
  const sl = clamp01(slippageShare);
  return (
    <div className="flex h-3 w-32 overflow-hidden rounded border border-ink-700">
      <div
        className={`${barFillClass(lpShare, 'lp')}`}
        style={{ width: `${lp * 100}%` }}
        title={`LP ${Math.round(lp * 100)}%`}
      />
      <div
        className={`${barFillClass(txShare, 'tx')}`}
        style={{ width: `${tx * 100}%` }}
        title={`tx ${Math.round(tx * 100)}%`}
      />
      <div
        className={`${barFillClass(slippageShare, 'slippage')}`}
        style={{ width: `${sl * 100}%` }}
        title={`slippage ${Math.round(sl * 100)}%`}
      />
    </div>
  );
}

/**
 * Choose the background color for a stacked-bar segment based
 * on the segment's share. Operates in the same severity space
 * as `shareClass()` — high = red, medium = amber, low = green,
 * none = gray.
 *
 * @param {number} share       segment share 0..1
 * @param {string} segment     'lp' | 'tx' | 'slippage'  (used for transparency)
 * @returns {string}
 */
function barFillClass(share, segment) {
  const severity = shareSeverityLocal(share);
  if (severity === 'high') return segment === 'slippage' ? 'bg-red-500' : 'bg-red-400';
  if (severity === 'medium') return segment === 'slippage' ? 'bg-amber-500' : 'bg-amber-400';
  if (severity === 'low') return segment === 'slippage' ? 'bg-emerald-500' : 'bg-emerald-400';
  return 'bg-ink-600';
}

function shareSeverityLocal(share) {
  if (typeof share !== 'number' || !Number.isFinite(share) || share < 0) return 'none';
  if (share > 0.5) return 'high';
  if (share > 0.25) return 'medium';
  return 'low';
}

function clamp01(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
