// dashboard/src/components/StakingStatusCard.jsx
//
// T58 subset 4 — Dashboard tile for the BadgerCoin Staking
// module. The operator sees at-a-glance:
//
//   1. lockNFT state in the wallet (count + total locked BCH +
//      per-lock decoded commitment fields — userPkh / stakeBlocks
//      / BCH sat value).
//   2. Last 10 stake alerts from `data/alerts.jsonl` (kind:
//      stake_locked / stake_unlock / stake_failed with txid +
//      amount + status).
//   3. The four operator-facing knobs (`enabled` /
//      `simulation_only` / `auto_lock_enabled` /
//      `auto_unlock_enabled`) with a one-click flip-on/off
//      toggle that writes to `config/user.json` (deep-merge
//      preserving WIF/mnemonic + every other key).
//
// Reads exclusively from `data/` + `config/default.json` + the
// wallet's UTXO set (no chain calls from the dashboard; the trader
// loop owns the `getBlockHeight` seam). All formatting + severity
// logic lives in `dashboard/src/views/staking-status-helpers.mjs`
// so the Node test suite can pin every edge case without a JSX
// loader.
//
// Failure model: every API call returns `{ok, data, error}`. On
// `ok:false` the tile renders an "unavailable" pill rather than
// blanking the whole card. The knob-toggle goes through the
// existing `PUT /api/config` endpoint so the validation +
// restart-banner plumbing keeps working.

import React, { useCallback, useEffect, useState } from 'react';
import { useApi, useRefresh } from '../lib/api-context.jsx';
import {
  satsToBch,
  lockNftCountSeverity,
  lockNftCountClass,
  autoStakeSeverity,
  autoStakeClass,
  autoStakeLabel,
  stakeAlertSeverity,
  stakeAlertClass,
  stakeAlertKindLabel,
  shortHex,
  alertAmountBch,
  buildStakingKnobPatch,
  emptyStateLabel,
  // T70-3: stake-attempt log helpers for the collapsible Status div
  attemptTone,
  attemptToneClass,
  attemptSummary,
  attemptTimestamp,
  attemptsSeverity,
  attemptsSeverityClass,
  attemptsSeverityLabel,
  maturitySeverity,
  maturityClass,
  maturityLabel,
  maturityBarClass,
  formatPercentComplete,
  tipHeightSeverity,
  tipHeightClass,
  tipHeightLabel,
} from '../views/staking-status-helpers.mjs';

const KNOB_LABELS = {
  enabled: 'enabled',
  simulation_only: 'simulation_only',
  auto_lock_enabled: 'auto_lock_enabled',
  auto_unlock_enabled: 'auto_unlock_enabled',
};

const KNOB_ORDER = ['enabled', 'simulation_only', 'auto_lock_enabled', 'auto_unlock_enabled'];

export default function StakingStatusCard() {
  const { api, token } = useApi();
  // T58 subset 6: subscribe to the dashboard's auto-refresh tick
  // (60s by default — see `AppProviders` in `api-context.jsx`).
  // This avoids spinning up a parallel polling timer that would
  // leak across hot-reloads. Each tick re-fetches `/api/staking/status`
  // so the maturity countdown + the chain-tip pill stay fresh.
  const { tick } = useRefresh();
  const [status, setStatus] = useState(/** @type {any} */ (null));
  const [err, setErr] = useState(/** @type {string|null} */ (null));
  const [toggling, setToggling] = useState(/** @type {string|null} */ (null));
  const [toggleMsg, setToggleMsg] = useState(/** @type {{kind:'ok'|'err', text:string}|null} */ (null));
  // T70-3: collapsible Status div state + log payload. The
  // `statusExpanded` flag starts collapsed so the card doesn't
  // bloat by default; the operator clicks the header to peek.
  const [statusExpanded, setStatusExpanded] = useState(false);
  const [stakeLog, setStakeLog] = useState(/** @type {any} */ (null));
  const [stakeLogErr, setStakeLogErr] = useState(/** @type {string|null} */ (null));

  const refresh = useCallback(() => {
    let cancelled = false;
    (async () => {
      setErr(null);
      const r = await api.stakingStatus();
      if (cancelled) return;
      if (!r.ok) {
        setErr(r.error || 'unknown');
        setStatus(null);
        return;
      }
      setStatus(r.data);
    })();
    return () => { cancelled = true; };
  }, [api]);

  useEffect(() => {
    const cleanup = refresh();
    return cleanup;
  }, [refresh, tick]);

  // T70-3: fetch the stake-attempt log on the same refresh tick
  // as the main status endpoint. Cheap (one NDJSON read) and
  // keeps the Status div's data fresh.
  const refreshLog = useCallback(() => {
    let cancelled = false;
    (async () => {
      const r = await api.stakeLog({ limit: 50 });
      if (cancelled) return;
      if (!r.ok) {
        setStakeLogErr(r.error || 'unknown');
        setStakeLog(null);
        return;
      }
      setStakeLogErr(null);
      setStakeLog(r.data);
    })();
    return () => { cancelled = true; };
  }, [api]);
  useEffect(() => {
    const cleanup = refreshLog();
    return cleanup;
  }, [refreshLog, tick]);

  const canWrite = typeof token === 'string' && token.trim().length > 0;

  const handleToggle = useCallback(async (key, nextValue) => {
    if (!canWrite || toggling) return;
    setToggling(key);
    setToggleMsg(null);
    const patch = buildStakingKnobPatch(status && status.knobs, { [key]: nextValue });
    const r = await api.putConfig(patch);
    setToggling(null);
    if (r.ok) {
      setToggleMsg({ kind: 'ok', text: `${KNOB_LABELS[key]} → ${nextValue}` });
      refresh();
    } else {
      setToggleMsg({ kind: 'err', text: r.error || 'save failed' });
    }
  }, [api, canWrite, status, toggling, refresh]);

  const lockNfts = (status && status.lockNfts) || { count: 0, total_bch: 0, total_bch_sats: '0', items: [], error: null };
  const knobs = (status && status.knobs) || {
    enabled: false, simulation_only: true, auto_lock_enabled: false, auto_unlock_enabled: false,
  };
  const recentAlerts = (status && Array.isArray(status.recent_alerts)) ? status.recent_alerts : [];
  const lockNftSeverity = lockNftCountSeverity(lockNfts.count);
  const stakeSeverity = autoStakeSeverity(knobs);
  // T58 subset 6: chain-tip pill mirrors the backend's
  // `tip_height_source` so the operator sees at-a-glance whether
  // the dashboard is talking to the chain or showing cached /
  // unavailable data. Hidden when status hasn't loaded yet (first
  // paint); surfaces on every subsequent render.
  const tip = (status && typeof status === 'object') ? {
    tip_height: status.tip_height,
    tip_height_source: status.tip_height_source,
    tip_height_age_ms: status.tip_height_age_ms,
  } : null;
  const tipSev = tipHeightSeverity(tip);

  return (
    <section className="panel">
      <header className="flex items-start justify-between gap-3 border-b border-ink-700 px-4 py-2">
        <div className="min-w-0">
          <h2 className="panel-title border-0 px-0 py-0">BadgerCoin staking</h2>
          <p className="mt-0.5 text-[11px] text-ash-400 leading-snug">
            lockNFT state · last 10 stake alerts · one-click knob toggle · per-lock maturity
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5 text-xs text-ash-300 shrink-0">
          {tip && (
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono ${tipHeightClass(tipSev)}`}
              title={tip && tip.tip_height ? `current BCH chain tip (source: ${tip.tip_height_source})` : 'chain tip unavailable'}
              data-testid="staking-tip-height-pill"
            >
              {tipHeightLabel(tip)}
            </span>
          )}
          <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono uppercase tracking-wider ${autoStakeClass(stakeSeverity)}`}>
            {autoStakeLabel(stakeSeverity)}
          </span>
        </div>
      </header>

      <div className="p-4 space-y-4">
        {err && (
          <div className="rounded border border-amber-700/60 bg-amber-950/30 p-3 text-xs text-amber-200">
            <span className="font-mono uppercase tracking-wider">unavailable:</span> {err}
          </div>
        )}
        {toggleMsg && (
          <div className={`rounded border px-3 py-2 text-xs ${toggleMsg.kind === 'ok'
            ? 'border-emerald-700/60 bg-emerald-950/40 text-emerald-200'
            : 'border-amber-700/60 bg-amber-950/30 text-amber-200'}`}>
            {toggleMsg.text}
          </div>
        )}

        {/* LockNFT state */}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <div className={`rounded border p-3 ${lockNftCountClass(lockNftSeverity)}`}>
            <div className="text-[10px] font-mono uppercase tracking-wider opacity-80">lockNFTs</div>
            <div className="mt-1 text-xl font-semibold tabular-nums">{lockNfts.count}</div>
            <div className="mt-0.5 text-[11px] opacity-80">
              {lockNfts.count === 0 ? 'none in wallet' : (lockNfts.count === 1 ? '1 lockNFT' : `${lockNfts.count} lockNFTs`)}
            </div>
          </div>
          <div className="rounded border border-ink-700 bg-ink-900/40 p-3">
            <div className="text-[10px] font-mono uppercase tracking-wider text-ash-400">total locked</div>
            <div className="mt-1 text-xl font-semibold tabular-nums text-ash-100">{satsToBch(lockNfts.total_bch_sats)}</div>
            <div className="mt-0.5 text-[11px] text-ash-400">BCH across all lockNFTs</div>
          </div>
          <div className="rounded border border-ink-700 bg-ink-900/40 p-3">
            <div className="text-[10px] font-mono uppercase tracking-wider text-ash-400">wallet</div>
            <div className="mt-1 text-xl font-semibold tabular-nums text-ash-100">
              {status && status.wallet_configured === false
                ? 'not configured'
                : (lockNfts.error ? 'lookup failed' : 'ready')}
            </div>
            <div className="mt-0.5 text-[11px] text-ash-400">
              {status && status.wallet_configured === false
                ? 'boot dashboard with --wallet'
                : (lockNfts.error ? shortHex(lockNfts.error, 24, 8) : 'listUtxos wired')}
            </div>
          </div>
        </div>

        {/* Per-lock rows */}
        {Array.isArray(lockNfts.items) && lockNfts.items.length > 0 && (
          <div>
            <div className="mb-1 text-[11px] font-mono uppercase tracking-wider text-ash-400">lockNFT details</div>
            <div className="overflow-x-auto rounded border border-ink-700">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-ink-900/60 text-ash-300">
                    <th className="px-2 py-1.5 text-left font-mono uppercase tracking-wider">outpoint</th>
                    <th className="px-2 py-1.5 text-right font-mono uppercase tracking-wider">value (BCH)</th>
                    <th className="px-2 py-1.5 text-right font-mono uppercase tracking-wider">stake blocks</th>
                    <th className="px-2 py-1.5 text-right font-mono uppercase tracking-wider">~days</th>
                    <th className="px-2 py-1.5 text-left font-mono uppercase tracking-wider">user pkh</th>
                    {/* T58 subset 6 — per-lock maturity column. Renders
                        the countdown / READY-NOW pill + a thin
                        progress bar under it so the operator can see
                        "this lock will be unlockable in ~2h" without
                        cross-referencing the dashboard's chain-tip
                        data. */}
                    <th className="px-2 py-1.5 text-left font-mono uppercase tracking-wider">maturity</th>
                  </tr>
                </thead>
                <tbody>
                  {lockNfts.items.map((it, i) => {
                    const matSev = maturitySeverity(it.maturity);
                    const pct = (typeof it.percent_complete === 'number' && Number.isFinite(it.percent_complete))
                      ? Math.max(0, Math.min(1, it.percent_complete))
                      : 0;
                    return (
                      <tr key={`${it.txid}:${it.vout}:${i}`} className="border-t border-ink-800">
                        <td className="px-2 py-1 font-mono text-ash-200">{shortHex(it.txid)}:{it.vout}</td>
                        <td className="px-2 py-1 text-right tabular-nums text-ash-100">{Number(it.value_bch).toFixed(6)}</td>
                        <td className="px-2 py-1 text-right tabular-nums text-ash-100">{it.stake_blocks ?? '—'}</td>
                        <td className="px-2 py-1 text-right tabular-nums text-ash-100">{it.stake_blocks_approx_days ?? '—'}</td>
                        <td className="px-2 py-1 font-mono text-ash-200">{it.user_pkh_hex ? shortHex(it.user_pkh_hex) : '—'}</td>
                        <td className="px-2 py-1">
                          <div className="flex flex-col gap-1 min-w-[160px]">
                            <span
                              className={`inline-flex items-center gap-1 self-start rounded-full border px-2 py-0.5 font-mono uppercase tracking-wider ${maturityClass(matSev)}`}
                              data-testid="staking-lock-maturity-pill"
                              data-maturity={it.maturity ?? 'unknown'}
                            >
                              {maturityLabel(it)}
                            </span>
                            <div
                              className="h-1 w-full overflow-hidden rounded-full bg-ink-700"
                              title={`${formatPercentComplete(pct)} of ${it.stake_blocks ?? '—'} blocks elapsed`}
                              role="progressbar"
                              aria-valuenow={Math.round(pct * 100)}
                              aria-valuemin={0}
                              aria-valuemax={100}
                            >
                              <div
                                className={`h-full ${maturityBarClass(it.maturity)}`}
                                style={{ width: `${Math.round(pct * 100)}%` }}
                              />
                            </div>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Knob toggles */}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <div className="text-[11px] font-mono uppercase tracking-wider text-ash-400">knobs</div>
            {!canWrite && (
              <div className="text-[10px] text-ash-400">
                set <code className="text-ash-200">?token=***</code> to flip
              </div>
            )}
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {KNOB_ORDER.map((key) => {
              const v = knobs[key] === true;
              const nextValue = !v;
              const disabled = !canWrite || toggling !== null;
              const isToggling = toggling === key;
              return (
                <div key={key} className="flex items-center justify-between gap-2 rounded border border-ink-700 bg-ink-900/40 px-3 py-2">
                  <div className="min-w-0">
                    <div className="font-mono text-xs text-ash-100">{KNOB_LABELS[key]}</div>
                    <div className="text-[10px] text-ash-400">{v ? 'on' : 'off'}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleToggle(key, nextValue)}
                    disabled={disabled}
                    className={`rounded border px-3 py-1 text-[10px] font-mono uppercase tracking-wider transition-colors ${v
                      ? 'border-bch-500/60 bg-bch-500/20 text-bch-200 hover:bg-bch-500/30'
                      : 'border-ink-600 bg-ink-800 text-ash-200 hover:bg-ink-700'} ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    {isToggling ? 'saving…' : (v ? 'turn off' : 'turn on')}
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Recent stake alerts */}
        <div>
          <div className="mb-1 text-[11px] font-mono uppercase tracking-wider text-ash-400">
            recent stake alerts ({recentAlerts.length})
          </div>
          {recentAlerts.length === 0 ? (
            <div className="rounded border border-ink-700 bg-ink-900/40 p-3 text-xs text-ash-400">
              {emptyStateLabel({ ...status, lockNfts })}
            </div>
          ) : (
            <div className="space-y-1">
              {recentAlerts.map((a, i) => {
                const sev = stakeAlertSeverity(a && a.kind, a && a.severity);
                const ctx = (a && a.context && typeof a.context === 'object') ? a.context : {};
                const txid = typeof ctx.txid === 'string' ? ctx.txid : (typeof a.txid === 'string' ? a.txid : null);
                const amount = alertAmountBch(a);
                return (
                  <div key={`${(a && a.ts) || i}:${i}`} className={`flex flex-wrap items-center gap-2 rounded border px-2 py-1 text-[11px] ${stakeAlertClass(sev)}`}>
                    <span className="font-mono uppercase tracking-wider">{stakeAlertKindLabel(a && a.kind)}</span>
                    <span className="text-ash-300">·</span>
                    <span className="font-mono tabular-nums">{amount} BCH</span>
                    {txid && (
                      <>
                        <span className="text-ash-300">·</span>
                        <span className="font-mono">{shortHex(txid)}</span>
                      </>
                    )}
                    {a && typeof a.ts === 'number' && (
                      <>
                        <span className="text-ash-300">·</span>
                        <span className="font-mono opacity-80">{new Date(a.ts).toISOString().slice(0, 19)}Z</span>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* T70-3 — Collapsible Stake-Attempt Status log.
            Shows the most-recent lock/unlock attempts the bot
            made + the result (txid, code, error) so the operator
            can see WHY staking is/isn't firing without opening
            devtools. Collapsed by default so the card doesn't
            bloat; click the header to expand. */}
        <div className="mt-3 rounded border border-ink-700 bg-ink-900/40">
          <button
            type="button"
            onClick={() => setStatusExpanded((v) => !v)}
            className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-ink-700/30 transition-colors"
            aria-expanded={statusExpanded}
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-[11px] font-mono uppercase tracking-wider text-ash-400">Stake Attempts</span>
              {(() => {
                const attempts = (stakeLog && Array.isArray(stakeLog.attempts)) ? stakeLog.attempts : [];
                const sev = attemptsSeverity(attempts);
                const cls = attemptsSeverityClass(sev);
                const lbl = attemptsSeverityLabel(sev);
                const count = (stakeLog && Number.isFinite(stakeLog.count)) ? stakeLog.count : attempts.length;
                return (
                  <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wider ${cls}`}>
                    <span>{lbl}</span>
                    <span className="text-ash-400">·</span>
                    <span className="tabular-nums">{count}</span>
                  </span>
                );
              })()}
            </div>
            <span className={`text-ash-400 transition-transform ${statusExpanded ? 'rotate-180' : ''}`}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 4.5 L6 7.5 L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </span>
          </button>
          {statusExpanded && (
            <div className="border-t border-ink-700 px-3 py-2 max-h-80 overflow-y-auto">
              {stakeLogErr ? (
                <div className="rounded border border-rose-500/30 bg-rose-500/10 p-2 text-xs text-rose-300">
                  stake log fetch failed: {stakeLogErr}
                </div>
              ) : (() => {
                const attempts = (stakeLog && Array.isArray(stakeLog.attempts)) ? stakeLog.attempts : [];
                if (attempts.length === 0) {
                  return (
                    <div className="py-4 text-center text-xs text-ash-400">
                      no stake attempts logged yet — enable
                      <span className="font-mono text-ash-200"> staking.auto_lock_enabled</span>
                      or wait for the next trader-loop tick.
                    </div>
                  );
                }
                return (
                  <div className="space-y-1">
                    {attempts.map((att, i) => {
                      const tone = attemptTone(att);
                      const ts = attemptTimestamp(att);
                      const summary = attemptSummary(att);
                      return (
                        <div key={`${(att && att.ts) || i}:${i}`} className={`flex items-start gap-2 rounded px-2 py-1 text-[11px] font-mono leading-snug ${attemptToneClass(tone)}`}>
                          <span className="shrink-0 tabular-nums text-ash-400 w-16">{ts || '———'}</span>
                          <span className="flex-1 break-words">{summary}</span>
                        </div>
                      );
                    })}
                    {Array.isArray(stakeLog?.load_errors) && stakeLog.load_errors.length > 0 && (
                      <div className="mt-2 rounded border border-amber-500/30 bg-amber-500/10 p-2 text-[10px] text-amber-300">
                        {stakeLog.load_errors.length} parse error(s) reading the log — see file: {stakeLog.file}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
