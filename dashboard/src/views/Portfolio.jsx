// dashboard/src/views/Portfolio.jsx
//
// PORTFOLIO view — current positions + the ENTRY REASONING the bot
// stamped at open time. Two filters (status: open / pending /
// closing / closed / all) and an expandable row per position that
// shows the full entry/exit/reasoning object.

import React, { useEffect, useMemo, useState } from 'react';

import { useApi, useRefresh } from '../lib/api-context.jsx';
import Panel from '../components/Panel.jsx';
import ErrorState from '../components/ErrorState.jsx';
import TokenBadge from '../components/TokenBadge.jsx';
import ManualTradePanel from './ManualTradePanel.jsx';
import {
  formatBch, formatPct, formatSats, formatLocal, formatDuration,
  formatTokenAmount, pnlClass, statusClass, truncate,
} from '../lib/format.mjs';
import { buildPositionTokenCountLine } from './portfolio-helpers.mjs';

// 60s avoids browser throttling on background / Telegram in-app tabs.
const REFRESH_LIVE_MS = 60_000;

const STATUSES = [
  { value: 'open',    label: 'open' },
  { value: 'pending', label: 'pending' },
  { value: 'closing', label: 'closing' },
  { value: 'closed',  label: 'closed' },
  { value: 'all',     label: 'all' },
];

export default function Portfolio() {
  const { api, token } = useApi();
  const { tick, trigger } = useRefresh();
  const [status, setStatus] = useState('open');
  const [positions, setPositions] = useState(/** @type {any} */ (null));
  const [err, setErr] = useState(/** @type {string|null} */ (null));
  // T45b: parent-state result envelope so a fresh navigation to
  // the view doesn't blow away the operator's most-recent trade
  // toast. Cleared when the operator hits "dismiss" on the toast.
  const [lastTrade, setLastTrade] = useState(/** @type {any} */ (null));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setErr(null);
      const r = await api.positions(status);
      if (cancelled) return;
      if (!r.ok) {
        setErr(r.error || 'unknown');
        setPositions(null);
        return;
      }
      setPositions(r.data);
    })();
    return () => { cancelled = true; };
  }, [api, status, tick]);

  const counts = useMemo(() => {
    if (!positions) return null;
    return positions.count;
  }, [positions]);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold">Portfolio</h1>
          <p className="text-sm text-ash-300">Open positions + the entry reasoning stamped by the bot.</p>
        </div>
        <button
          type="button"
          onClick={trigger}
          className="rounded border border-ink-600 px-3 py-1.5 text-xs font-mono uppercase tracking-wider text-ash-200 hover:bg-ink-800"
        >
          refresh
        </button>
      </div>

      <WalletSummaryCard />

      <ManualTradePanel
        api={api}
        lastResult={lastTrade}
        onResult={setLastTrade}
      />

      <div className="flex flex-wrap items-center gap-2">
        {STATUSES.map((s) => (
          <button
            key={s.value}
            type="button"
            onClick={() => setStatus(s.value)}
            className={`rounded px-3 py-1.5 text-xs font-mono uppercase tracking-wider transition-colors ${
              status === s.value
                ? 'bg-bch-600 text-ink-950'
                : 'border border-ink-600 text-ash-200 hover:bg-ink-800'
            }`}
          >
            {s.label}
          </button>
        ))}
        {counts !== null && (
          <span className="ml-auto text-xs text-ash-300">
            showing <span className="num text-ash-100">{counts}</span> position{counts === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {err && <ErrorState message={err} onRetry={trigger} />}

      <PositionsTable positions={positions} api={api} token={token} />
    </div>
  );
}

/**
 * T27e: live wallet summary card. Queries `/api/wallet/balance`
 * which returns the on-chain BCH balance + every fungible-token
 * category the wallet holds. Refreshes every 30 s (independent of
 * the global 15 s refresh tick) because the source of truth is the
 * chain, not the positions store.
 *
 * Renders nothing while loading (the rest of the page is fine
 * without it) and a small "unavailable" pill on network error so a
 * flaky Electrum can't blank the whole portfolio view.
 */
function WalletSummaryCard() {
  const { api } = useApi();
  const [data, setData] = useState(/** @type {any} */ (null));
  const [err, setErr] = useState(/** @type {string|null} */ (null));

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const r = await api.walletBalance();
      if (cancelled) return;
      if (!r.ok) {
        setErr(r.error || 'unavailable');
        return;
      }
      setData(r.data);
      setErr(null);
    };
    load();
    const id = setInterval(load, REFRESH_LIVE_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [api]);

  const tokens = Array.isArray(data?.tokens) ? data.tokens : [];
  const bch = data?.bch_balance_sats;

  return (
    <div data-testid="wallet-summary-card" className="rounded border border-bch-700/40 bg-bch-500/5 p-4">
      <div className="flex items-baseline justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-bch-400 animate-pulse" aria-hidden="true" />
          <span className="text-xs font-mono uppercase tracking-wider text-bch-400">wallet holdings</span>
          <span className="text-[10px] text-ash-500">· live on-chain</span>
        </div>
        <span className="text-[10px] text-ash-500">
          {data?.address ? `${data.address.slice(0, 18)}…` : err ? `unavailable (${err})` : 'loading…'}
        </span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-ash-400">BCH</div>
          <div className="font-mono text-base text-ash-100">
            {bch === null || bch === undefined ? '—' : formatBch(bch)}
          </div>
        </div>
        <div className="sm:col-span-3">
          <div className="text-[10px] uppercase tracking-wider text-ash-400 mb-1">
            tokens <span className="ml-1 text-ash-500">({tokens.length})</span>
          </div>
          {tokens.length === 0 ? (
            <div className="text-xs text-ash-500">no FT UTXOs at the wallet</div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {tokens.map((t) => {
                const tid = String(t.token_id || '');
                const decimals = (typeof t.decimals === 'number' && Number.isFinite(t.decimals)) ? t.decimals : null;
                // Format the base-unit amount using the BCMR-reported
                // decimals so 507044 base-units of a 2-decimal token
                // renders as "5,070.44" instead of raw "507044". When
                // decimals is missing (BCMR miss / no authchain commit)
                // we fall back to the raw integer so the operator at
                // least sees the magnitude.
                const amt = formatTokenAmount(t.total_amount, decimals);
                const sym = (typeof t.symbol === 'string' && t.symbol.length > 0) ? t.symbol : null;
                // Show the symbol next to the amount when we have
                // it; with decimals it confirms the formatting is
                // correct, and without decimals it hints that the
                // raw integer is missing a decimal point.
                const titleParts = [
                  tid,
                  sym ? `symbol: ${sym}` : null,
                  decimals !== null ? `decimals: ${decimals}` : 'decimals: unknown',
                ].filter(Boolean);
                return (
                  <span
                    key={tid}
                    className="inline-flex items-center gap-1 rounded border border-ink-700 bg-ink-800 px-2 py-0.5"
                    title={titleParts.join('\n')}
                  >
                    <TokenBadge tokenId={tid} compact />
                    <span className="font-mono num text-[11px] text-ash-100">
                      {amt}{sym ? <span className="ml-1 text-ash-400">{sym}</span> : null}
                    </span>
                  </span>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PositionsTable(props) {
  const data = props.positions;
  const api = props.api;
  const token = props.token;
  if (!data) return <Panel><div className="py-8 text-center text-sm text-ash-300">loading…</div></Panel>;
  const list = Array.isArray(data.positions) ? data.positions : [];
  if (list.length === 0) {
    return <Panel><div className="py-8 text-center text-sm text-ash-300">no positions match this filter</div></Panel>;
  }
  return (
    <div className="space-y-2">
      {list.map((p) => <PositionRow key={p.id || p.token_id || Math.random()} position={p} api={api} token={token} />)}
    </div>
  );
}

function PositionRow(props) {
  const p = props.position;
  const [open, setOpen] = useState(false);
  // O03 (idea_operator_position-prevent-stop-loss-with-profit-target_20260917):
  // mirror the server-side `exit_overrides` so the toggle / field are
  // instantly responsive on click without round-tripping the whole
  // position list. `saveError` shows a red pill on the row if the
  // PUT 4xx/5xx'd so the operator knows the override didn't stick.
  const [overrides, setOverrides] = useState(() => p?.exit_overrides ?? null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  if (!p) return null;
  const entry = p.entry || {};
  const exit = p.exit || {};
  const entryBch = entry.bch_spent_sats ?? null;
  const exitBch = exit.bch_received_sats ?? null;
  const pnlSats = exit.realized_pnl_sats ?? null;
  const pct = (typeof pnlSats === 'string' || typeof pnlSats === 'number') && entryBch
    ? (Number(pnlSats) / Math.max(1, Number(entryBch))) * 100
    : null;
  const holdMs = (entry.ts && p.closed_at) ? (new Date(p.closed_at).getTime() - new Date(entry.ts).getTime()) : null;
  // O03: live worth + % change vs entry, computed server-side.
  // `current_worth_sats` is a string-encoded sat amount (same
  // convention as entry.bch_spent_sats, fee_sats, bch_balance_sats)
  // so the dashboard's formatBch(sats) renders the sat→BCH
  // conversion exactly once. Previously this field was a BCH
  // float named `current_worth_bch`, which formatBch divided by
  // 1e8 a second time and rendered "0.00000000 BCH" for every
  // position. See bug
  // bug-both-graphs-on-the-dashboard-dont-seem-to-reflect-positions-20260918.
  const currentWorthSats = (typeof p.current_worth_sats === 'string' && p.current_worth_sats.length > 0)
    ? p.current_worth_sats
    : null;
  const currentPctChange = (typeof p.current_pct_change === 'number' && Number.isFinite(p.current_pct_change))
    ? p.current_pct_change
    : null;
  // Local helpers that optimistically update the in-memory override
  // and PATCH the server. On failure, restore the previous value
  // and surface the error inline.
  const api = props.api;
  const token = props.token;
  const handleToggle = async (nextChecked) => {
    if (!api || !token || !p?.id) return;
    const prev = overrides;
    const next = {
      prevent_stop_loss: nextChecked,
      profit_target_pct: prev?.profit_target_pct ?? 5,
      set_by: 'dashboard',
    };
    setOverrides({ ...next, set_at: new Date().toISOString() });
    setSaving(true);
    setSaveError(null);
    const r = await api.updatePositionOverrides(p.id, next);
    setSaving(false);
    if (r && r.ok) {
      // The server returns the canonicalized override on `r.data.position.exit_overrides`.
      if (r.data?.position?.exit_overrides) setOverrides(r.data.position.exit_overrides);
      // Surface the new worth + pct change in the next fetch too.
      if (r.data?.position) {
        p.current_worth_sats = r.data.position.current_worth_sats ?? p.current_worth_sats;
        p.current_pct_change = r.data.position.current_pct_change ?? p.current_pct_change;
      }
    } else {
      setSaveError(r?.error || 'save_failed');
      setOverrides(prev); // restore
    }
  };
  const handlePctChange = async (raw) => {
    if (!api || !token || !p?.id) return;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 10000) {
      setSaveError('profit_target_pct must be 0..10000');
      return;
    }
    const prev = overrides;
    const next = {
      prevent_stop_loss: prev?.prevent_stop_loss ?? true,
      profit_target_pct: n,
      set_by: 'dashboard',
    };
    setOverrides({ ...next, set_at: new Date().toISOString() });
    setSaving(true);
    setSaveError(null);
    const r = await api.updatePositionOverrides(p.id, next);
    setSaving(false);
    if (r && r.ok) {
      if (r.data?.position?.exit_overrides) setOverrides(r.data.position.exit_overrides);
      if (r.data?.position) {
        p.current_worth_sats = r.data.position.current_worth_sats ?? p.current_worth_sats;
        p.current_pct_change = r.data.position.current_pct_change ?? p.current_pct_change;
      }
    } else {
      setSaveError(r?.error || 'save_failed');
      setOverrides(prev);
    }
  };

  return (
    <div className="panel">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="grid w-full grid-cols-12 items-center gap-2 px-4 py-3 text-left hover:bg-ink-800/60"
      >
        <div className="col-span-2 flex items-center gap-2">
          <span className={`inline-block rounded border px-2 py-0.5 text-[11px] font-mono uppercase tracking-wider ${statusClass(p.status)}`}>
            {p.status || '—'}
          </span>
          <span className="font-mono text-xs text-ash-300">{p.side || '—'}</span>
        </div>
        <div className="col-span-2 min-w-0">
          {p.token_id ? (
            <TokenBadge tokenId={p.token_id} />
          ) : (
            <span className="num text-sm text-ash-100">{p.token_symbol || '—'}</span>
          )}
          {/* T83 — surface the actual token count held by the
              position so the operator can see "how many tokens" at
              a glance without expanding the row. The pure helper
              in `portfolio-helpers.mjs` reads the entry-side
              `token_amount_base` (string-encoded base-unit amount)
              + the BCMR-reported `token_decimals` and formats via
              the shared `formatTokenAmount` helper. Decimal-aware
              tokens (e.g. 8-decimals) render with the correct
              precision; zero-decimal tokens (like FURU) render the
              raw integer; unknown decimals fall back to the raw
              integer via formatTokenAmount's built-in safety net.
              Suppressed entirely when the API doesn't carry a
              count (older positions written before token_amount_base
              landed). */}
          {(() => {
            const line = buildPositionTokenCountLine(entry, p.token_decimals, p.token_symbol);
            if (!line) return null;
            return (
              <div
                className="mt-0.5 truncate text-[11px] font-mono text-ash-400"
                title={`${line.raw} base units (decimals=${line.decimals ?? '?'})`}
                data-testid="position-token-count"
              >
                {line.formatted}
                {line.symbol ? <span className="ml-1 text-ash-500">{line.symbol}</span> : null}
              </div>
            );
          })()}
        </div>
        <div className="col-span-2 num text-right text-sm text-ash-200">
          {formatBch(entryBch)}
        </div>
        {/* O03: current worth column (BCH value if the position were
            sold at the latest snapshot's market price) + green/red
            % change vs entry. Sits after entry-BCH so the operator
            can eyeball "what I paid" vs "what it's worth right now". */}
        <div className="col-span-2 num text-right text-sm">
          {currentWorthSats !== null ? (
            <div className="flex flex-col items-end">
              <span className="text-ash-100">{formatBch(currentWorthSats)}</span>
              {currentPctChange !== null ? (
                <span className={`text-xs ${currentPctChange >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {currentPctChange >= 0 ? '+' : ''}{formatPct(currentPctChange)}
                </span>
              ) : null}
            </div>
          ) : <span className="text-ash-300">—</span>}
        </div>
        <div className="col-span-2 num text-right text-sm text-ash-200">
          {pnlSats !== null && pnlSats !== undefined ? (
            <span className={pnlClass(pct)}>
              {formatBch(pnlSats)} · {formatPct(pct)}
            </span>
          ) : '—'}
        </div>
        <div className="col-span-1 num text-right text-xs text-ash-300">
          {holdMs !== null ? formatDuration(holdMs) : formatLocal(entry.ts)}
        </div>
        <div className="col-span-1 text-right text-ash-400">
          {open ? '▾' : '▸'}
        </div>
      </button>
      {open && (
        <div className="border-t border-ink-700 p-4 space-y-3 text-sm">
          <DetailRow label="token_id" value={p.token_id} mono />
          <DetailRow label="position_id" value={p.id} mono />
          <DetailRow label="opened_at" value={formatLocal(p.opened_at)} />
          <DetailRow label="updated_at" value={formatLocal(p.updated_at)} />
          <DetailRow label="closed_at" value={formatLocal(p.closed_at)} />
          <DetailRow label="entry txid" value={entry.txid} mono />
          <DetailRow label="entry price" value={typeof entry.price_sats_per_token === 'number' ? `${entry.price_sats_per_token} sat/token` : null} />
          <DetailRow label="entry fee" value={typeof entry.fee_sats === 'string' || typeof entry.fee_sats === 'number' ? formatSats(entry.fee_sats) : null} />
          <DetailRow label="entry broadcast" value={typeof entry.broadcast_ms === 'number' ? formatDuration(entry.broadcast_ms) : null} />
          <DetailRow label="exit txid" value={exit.txid} mono />
          <DetailRow label="exit reason" value={exit.reason} />
          <DetailRow label="exit price" value={typeof exit.price_sats_per_token === 'number' ? `${exit.price_sats_per_token} sat/token` : null} />
          <DetailRow label="high water mark" value={typeof p.high_water_mark_sats_per_token === 'number' ? `${p.high_water_mark_sats_per_token} sat/token` : null} />
          {/* O03: operator-set exit overrides. The toggle gates the
              bot's auto-exit on `prevent_stop_loss=ON` + `profit
              target pct` cleared. Saves optimistically + rolls back
              on PUT failure. Hidden entirely when the API token is
              not set (the dashboard would 401 every PUT, which is
              worse than not showing the controls). */}
          {api && token && p.status === 'open' && (
            <OverrideControls
              overrides={overrides}
              saving={saving}
              saveError={saveError}
              onToggle={handleToggle}
              onPctChange={handlePctChange}
              currentPctChange={currentPctChange}
            />
          )}
          {p.reasoning && <ReasoningBlock reasoning={p.reasoning} />}
        </div>
      )}
    </div>
  );
}

/**
 * O03 (idea_operator_position-prevent-stop-loss-with-profit-target_20260917):
 * Per-position "prevent stop loss" toggle + "% profit" field rendered
 * inside the expanded row. Saves optimistically (via the parent
 * PositionRow's handleToggle / handlePctChange) and shows a red pill
 * if the PUT failed. Hidden when no overrides are set + the toggle
 * hasn't been touched yet — keeps the row compact by default.
 */
function OverrideControls(props) {
  const { overrides, saving, saveError, onToggle, onPctChange, currentPctChange } = props;
  const toggleOn = overrides?.prevent_stop_loss === true;
  const pct = (overrides && Number.isFinite(overrides.profit_target_pct))
    ? overrides.profit_target_pct
    : 5;
  return (
    <div className="rounded border border-bch-500/40 bg-bch-500/5 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="label text-bch-300">exit overrides</div>
        {saving && <span className="text-[11px] text-ash-400">saving…</span>}
        {saveError && <span className="rounded bg-red-500/20 px-2 py-0.5 text-[11px] text-red-300">{saveError}</span>}
      </div>
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          className="h-4 w-4 accent-bch-500"
          checked={toggleOn}
          onChange={(e) => onToggle(e.target.checked)}
          disabled={saving}
        />
        <span className="text-sm text-ash-100">Prevent stop loss (hold until &ge; <span className="num">{pct}%</span> profit)</span>
      </label>
      {toggleOn && (
        <div className="flex items-center gap-2 pl-6">
          <label className="text-xs text-ash-300" htmlFor={`pct-${(overrides && overrides.set_at) || 'new'}`}>% profit target:</label>
          <input
            id={`pct-${(overrides && overrides.set_at) || 'new'}`}
            type="number"
            step="0.1"
            min="0"
            max="10000"
            value={pct}
            onChange={(e) => onPctChange(e.target.value)}
            disabled={saving}
            className="w-24 rounded border border-ink-700 bg-ink-900 px-2 py-0.5 text-sm num text-ash-100"
          />
          {Number.isFinite(currentPctChange) && (
            <span className={`text-xs num ${currentPctChange >= pct ? 'text-green-400' : 'text-red-400'}`}>
              current: {currentPctChange >= 0 ? '+' : ''}{formatPct(currentPctChange)}
            </span>
          )}
        </div>
      )}
      <div className="text-[11px] text-ash-400 pl-6">
        When ON, the bot only sells this position when its current P&amp;L is &ge; the target.
        Applies to stop-loss, trailing-stop, time-stop, AND take-profit (any exit kind).
      </div>
    </div>
  );
}

function DetailRow(props) {
  if (props.value === null || props.value === undefined || props.value === '') return null;
  return (
    <div className="grid grid-cols-12 gap-2">
      <div className="col-span-3 label">{props.label}</div>
      <div className={`col-span-9 ${props.mono ? 'num' : ''} text-ash-100 break-all`}>{String(props.value)}</div>
    </div>
  );
}

function ReasoningBlock(props) {
  const r = props.reasoning;
  if (!r || typeof r !== 'object') return null;
  const entries = Object.entries(r);
  if (entries.length === 0) return null;
  return (
    <div className="rounded border border-bch-600/40 bg-bch-600/5 p-3">
      <div className="label text-bch-400">entry reasoning</div>
      <dl className="mt-2 grid grid-cols-12 gap-y-1 text-xs">
        {entries.map(([k, v]) => (
          <React.Fragment key={k}>
            <dt className="col-span-4 text-ash-300">{k}</dt>
            <dd className="col-span-8 num text-ash-100 break-all">
              {typeof v === 'object' ? JSON.stringify(v) : String(v)}
            </dd>
          </React.Fragment>
        ))}
      </dl>
    </div>
  );
}