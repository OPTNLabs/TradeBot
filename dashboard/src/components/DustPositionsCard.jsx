// dashboard/src/components/DustPositionsCard.jsx
//
// T88 — Dashboard tile that consumes `/api/positions/dust`
// (shipped in T88 subset 1: `src/dashboard/dust-positions.mjs`).
// The tile mounts below `<PositionRowCard />` (the Portfolio
// position rows) on Dashboard.jsx and surfaces:
//
//   1. **Knob-OFF state** (when `risk.dust_position_auto_close_enabled:false`):
//      an amber info card pointing the operator at the config knob
//      + a copy-to-clipboard config snippet they can paste into
//      `data/user.json` to flip it ON. Even when OFF, the dust
//      rows are still surfaced as PREVIEW (so the operator can
//      audit "what would be dust" before flipping the knob).
//
//   2. **Active state** (knob ON, or operator clicks "Show dust
//      preview"): a table of currently-flagged dust positions
//      (token_id short + symbol + current_value_bch + total_cost_bch
//      + ratio + dust_kind pill + severity pill) with a
//      refresh-every-60s subscription mirroring `SnapshotStatsCard`.
//
// The card subscribes to `useRefresh().tick` so the dust table
// re-renders at the dashboard's 60s auto-refresh cadence. A
// "Refresh now" button forces an immediate refetch.
//
// Failure model: every API call returns `{ok, data, error}`. On
// `ok:false` or a null envelope the tile renders an "unavailable"
// pill rather than blanking the whole card. Empty state ("no dust
// flagged") renders an emerald "all clear" line. Empty open
// positions renders a muted "no open positions" line.

import React, { useCallback, useEffect, useState } from 'react';
import { useApi, useRefresh } from '../lib/api-context.jsx';
import {
  buildDustPositionsCardProps,
  dustBchFormat,
  dustKindClass,
  dustKindLabel,
} from '../views/dust-positions-helpers.mjs';

export default function DustPositionsCard() {
  const { api } = useApi();
  const { tick } = useRefresh();
  const [env, setEnv] = useState(/** @type {any} */ (null));
  const [err, setErr] = useState(/** @type {string|null} */ (null));
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState(false);
  const [copyHint, setCopyHint] = useState('');

  // Fetch the dust envelope on mount + every auto-refresh tick.
  // The previous version (T88) wrapped this in `useCallback(async)`
  // and called `refresh()` from a separate `useEffect` that returned
  // the Promise's resolved value as its "cleanup". Two problems with
  // that shape under React 18 StrictMode + a 60s tick dep:
  //
  //   1. `useEffect` returning a Promise is NOT a function per
  //      React's contract, so the cleanup is silently dropped.
  //      The cancellation flag inside `refresh` never fires when
  //      the effect re-runs, leaving an in-flight fetch to clobber
  //      newer state (the "TypeError: n is not a function" symptom
  //      T88+ shipped).
  //
  //   2. `let cancelled = false` was declared inside the wrapped
  //      useCallback's body, so a new flag was created on every
  //      rebuild — none of them ever got set to true. Stale fetches
  //      could always overwrite fresh state.
  //
  // Fix (template port of upstream commit 97fced1): drop the
  // `async` from useCallback. The refresh body synchronously spawns
  // the IIFE and returns the cleanup arrow function directly.
  // `useEffect` does `return refresh()` so the arrow gets the
  // cancelled flag for THIS effect invocation, and React actually
  // invokes it on cleanup.
  const refresh = useCallback(
    ({ forcePreview = false } = {}) => {
      let cancelled = false;
      setLoading(true);
      (async () => {
        try {
          const r = await api.dustPositions(
            forcePreview ? { knobOverride: true } : {}
          );
          if (cancelled) return;
          if (!r.ok) {
            setErr(r.error || 'request failed');
            setEnv(null);
          } else {
            setErr(null);
            setEnv(r.data);
          }
        } catch (e) {
          if (cancelled) return;
          setErr(String(e && e.message ? e.message : 'unknown error'));
          setEnv(null);
        } finally {
          if (cancelled) return;
          setLoading(false);
        }
      })();
      return () => { cancelled = true; };
    },
    [api]
  );

  useEffect(() => {
    return refresh();
  }, [refresh, tick]);

  const props = buildDustPositionsCardProps(env, { error: err });
  const showDustRows = props.isKnobOn || preview;

  const handleCopy = useCallback(async () => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(props.configSnippet);
        setCopyHint('copied');
        setTimeout(() => setCopyHint(''), 1500);
      } else {
        setCopyHint('no clipboard');
        setTimeout(() => setCopyHint(''), 1500);
      }
    } catch {
      setCopyHint('copy failed');
      setTimeout(() => setCopyHint(''), 1500);
    }
  }, [props.configSnippet]);

  return (
    <div className="rounded border border-ink-700 bg-ink-900/30 p-3">
      {/* Header */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-mono uppercase tracking-wider text-ash-300">
            dust positions
          </span>
          <span className="text-[11px] text-ash-500">
            {props.header.headline} · {props.header.subline}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wider ${props.header.knobClass}`}
            title={
              props.isKnobOn
                ? 'risk.dust_position_auto_close_enabled=true — loop will auto-close these'
                : 'risk.dust_position_auto_close_enabled=false — rows are preview only'
            }
          >
            {props.header.knobLabel}
          </span>
          {loading && (
            <span className="text-[10px] font-mono text-ash-500">loading…</span>
          )}
          {!props.isKnobOn && !preview && (
            <button
              type="button"
              onClick={() => setPreview(true)}
              className="rounded border border-ink-600 bg-ink-800 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider text-ash-300 hover:bg-ink-700"
              title="Show the dust-flag preview even though auto-close is off"
            >
              show preview
            </button>
          )}
          <button
            type="button"
            onClick={() => refresh({ forcePreview: !props.isKnobOn && preview })}
            className="rounded border border-ink-600 bg-ink-800 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider text-ash-300 hover:bg-ink-700"
          >
            refresh
          </button>
        </div>
      </div>

      {/* Error state */}
      {props.error && (
        <div className="rounded border border-amber-700/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-300">
          {props.error === 'request failed' ? 'Dust positions unavailable.' : props.error}
        </div>
      )}

      {/* Knob-OFF info card (only when knob truly off and preview not enabled) */}
      {!props.error && !props.isKnobOn && !preview && (
        <div className="rounded border border-amber-700/40 bg-amber-950/15 px-3 py-2 text-xs text-amber-300">
          <div className="mb-1.5">{props.knobOffText}</div>
          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded bg-ink-900/70 px-2 py-1 text-[11px] font-mono text-amber-200">
              {props.configSnippet.replace(/\n/g, ' ')}
            </code>
            <button
              type="button"
              onClick={handleCopy}
              className="rounded border border-amber-700/40 bg-amber-950/40 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider text-amber-200 hover:bg-amber-950/60"
            >
              {copyHint || 'copy'}
            </button>
          </div>
        </div>
      )}

      {/* Empty open-positions state */}
      {!props.error && props.open_position_count === 0 && (
        <div className="rounded border border-ink-700 bg-ink-900/30 px-3 py-2 text-xs text-ash-400">
          {props.emptyText}
        </div>
      )}

      {/* Active state: dust-flagged rows */}
      {!props.error && showDustRows && props.hasDust && (
        <div className="overflow-x-auto">
          <table className="min-w-full text-[11px]">
            <thead>
              <tr className="text-left text-[10px] font-mono uppercase tracking-wider text-ash-500">
                <th className="px-2 py-1">token</th>
                <th className="px-2 py-1 text-right">current value</th>
                <th className="px-2 py-1 text-right">close cost</th>
                <th className="px-2 py-1 text-right">ratio</th>
                <th className="px-2 py-1">trigger</th>
              </tr>
            </thead>
            <tbody>
              {props.rows.map((row, i) => (
                <tr key={row.position_id || row.token_id || i} className="border-t border-ink-800">
                  <td className="px-2 py-1 font-mono text-ash-200">
                    <div className="flex flex-col">
                      <span>{row.token_id_short}</span>
                      {row.token_symbol && (
                        <span className="text-[10px] text-ash-500">{row.token_symbol}</span>
                      )}
                    </div>
                  </td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums text-ash-200">
                    {row.current_value_bch}
                  </td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums text-ash-300">
                    {row.total_cost_bch}
                  </td>
                  <td className="px-2 py-1 text-right">
                    <span
                      className={`inline-flex items-center rounded-full border px-1.5 py-0.5 font-mono ${row.pill_class}`}
                      title={`ratio_cost_to_proceeds = ${row.ratio_display}`}
                    >
                      {row.ratio_display}
                    </span>
                  </td>
                  <td className="px-2 py-1">
                    <span
                      className={`inline-flex items-center rounded-full border px-1.5 py-0.5 font-mono uppercase tracking-wider ${row.kind_class}`}
                      title={row.reasons.join(' · ')}
                    >
                      {row.kind_label}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* All-clear state (knob on, but no dust) */}
      {!props.error && showDustRows && !props.hasDust && props.open_position_count > 0 && (
        <div className="rounded border border-emerald-700/40 bg-emerald-950/20 px-3 py-2 text-xs text-emerald-300">
          {props.clearText}
        </div>
      )}

      {/* Skipped rows (operator overrides + on-chain-sync + no-price) */}
      {!props.error && showDustRows && props.hasSkipped && (
        <div className="mt-2 rounded border border-ink-700 bg-ink-900/20 px-3 py-2">
          <div className="mb-1 flex items-center gap-2">
            <span className="text-[10px] font-mono uppercase tracking-wider text-ash-500">
              skipped ({props.skipped_count})
            </span>
            {props.skipped_overrides > 0 && (
              <span className="text-[10px] font-mono text-sky-300">
                · {props.skipped_overrides} operator hold
              </span>
            )}
            {props.skipped_no_price > 0 && (
              <span className="text-[10px] font-mono text-ash-400">
                · {props.skipped_no_price} no price
              </span>
            )}
          </div>
          <ul className="space-y-1">
            {props.skipped.slice(0, 8).map((row, i) => (
              <li key={row.position_id || row.token_id || i} className="flex flex-wrap items-center gap-2 text-[11px]">
                <span className="font-mono text-ash-300">{row.token_id_short}</span>
                {row.token_symbol && (
                  <span className="text-[10px] text-ash-500">{row.token_symbol}</span>
                )}
                <span
                  className={`inline-flex items-center rounded-full border px-1.5 py-0.5 font-mono uppercase tracking-wider ${row.blocked_reason_class}`}
                >
                  {row.blocked_reason_label}
                </span>
              </li>
            ))}
            {props.skipped.length > 8 && (
              <li className="text-[10px] text-ash-500">… and {props.skipped.length - 8} more</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
