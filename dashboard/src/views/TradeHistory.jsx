// dashboard/src/views/TradeHistory.jsx
//
// TRADE HISTORY view — a flat table of every entry + exit event
// across the bot's lifetime, filterable by token, side, event
// kind, date range, and P&L outcome. Powers the audit workflow
// ("what did the bot do with X last month?") that the flat
// ActivityFeed can't answer.
//
// All non-trivial helpers live in `trade-history-helpers.mjs` so
// they're importable from `node --test`. The formatters are
// re-exported via `lib/format.mjs` to keep the table rendering
// consistent with Portfolio + Risk Panel.

import React, { useEffect, useMemo, useState } from 'react';

import { useApi, useRefresh } from '../lib/api-context.jsx';
import Panel from '../components/Panel.jsx';
import ErrorState from '../components/ErrorState.jsx';
import ManualTradePanel from './ManualTradePanel.jsx';
import {
  formatBch, formatPct, formatSats, formatLocal, truncate,
} from '../lib/format.mjs';
import {
  RANGE_OPTIONS, EVENT_KIND_OPTIONS, PNL_OPTIONS, SIDE_OPTIONS,
  emptyTradeHistoryFilters, validateTradeHistoryFilters,
  eventKindClass, pnlSignClass, statusLabel,
  formatSignedSats, tokenOptionsFromEvents, classifyPnl,
  tradeHistoryParamsFromFilters, TradeHistoryValidationError,
} from './trade-history-helpers.mjs';

// 60s refresh matches Portfolio + Risk Panel — the operator is
// reading this view interactively, not auto-polling like DASHBOARD.
const REFRESH_LIVE_MS = 60_000;

export default function TradeHistory() {
  const { api } = useApi();
  const { tick, trigger } = useRefresh();
  const [filters, setFilters] = useState(() => emptyTradeHistoryFilters());
  const [result, setResult] = useState(/** @type {any} */ (null));
  const [err, setErr] = useState(/** @type {string|null} */ (null));
  const [filterErr, setFilterErr] = useState(/** @type {string|null} */ (null));
  // T45b: parent-state result envelope so the toast + panel state
  // survive across the operator opening/collapsing the panel.
  const [lastTrade, setLastTrade] = useState(/** @type {any} */ (null));

  useEffect(() => {
    let cancelled = false;
    let validated;
    try {
      validated = validateTradeHistoryFilters(filters);
      setFilterErr(null);
    } catch (e) {
      const msg = (e instanceof Error) ? e.message : String(e);
      setFilterErr(msg);
      setResult(null);
      return () => { cancelled = true; };
    }
    (async () => {
      setErr(null);
      const params = tradeHistoryParamsFromFilters(validated);
      const qs = params.toString().length > 0 ? `?${params.toString()}` : '';
      const r = await api.tradeHistory(validated);
      if (cancelled) return;
      if (!r.ok) {
        setErr(r.error || 'unknown');
        setResult(null);
        return;
      }
      setResult(r.data);
    })();
    return () => { cancelled = true; };
    // We intentionally depend on the raw filter object — the
    // operator wants every keystroke to re-fire. Validate inside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, filters, tick]);

  const events = useMemo(() => {
    if (!result || !Array.isArray(result.events)) return [];
    return result.events;
  }, [result]);

  const tokenOptions = useMemo(() => {
    return tokenOptionsFromEvents(events, filters.tokenId);
  }, [events, filters.tokenId]);

  const totals = useMemo(() => computeTotals(events), [events]);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold">Trade History</h1>
          <p className="text-sm text-ash-300">Every entry + exit event across the bot's lifetime, with filters.</p>
        </div>
        <button
          type="button"
          onClick={trigger}
          className="rounded border border-ink-600 px-3 py-1.5 text-xs font-mono uppercase tracking-wider text-ash-200 hover:bg-ink-800"
        >
          refresh
        </button>
      </div>

      <FilterBar
        filters={filters}
        setFilters={setFilters}
        tokenOptions={tokenOptions}
        filterErr={filterErr}
      />

      <ManualTradePanel
        api={api}
        lastResult={lastTrade}
        onResult={setLastTrade}
      />

      {err && <ErrorState message={err} onRetry={trigger} />}

      <TotalsStrip totals={totals} />

      <EventsTable events={events} loading={!result && !err} />
    </div>
  );
}

function FilterBar({ filters, setFilters, tokenOptions, filterErr }) {
  const update = (patch) => setFilters((prev) => ({ ...prev, ...patch }));
  return (
    <Panel>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <SelectField
          label="range"
          value={filters.range}
          onChange={(v) => update({ range: v })}
          options={RANGE_OPTIONS}
        />
        <SelectField
          label="kind"
          value={filters.eventKind}
          onChange={(v) => update({ eventKind: v })}
          options={EVENT_KIND_OPTIONS}
        />
        <SelectField
          label="side"
          value={filters.side}
          onChange={(v) => update({ side: v })}
          options={SIDE_OPTIONS}
        />
        <SelectField
          label="pnl"
          value={filters.pnl}
          onChange={(v) => update({ pnl: v })}
          options={PNL_OPTIONS}
        />
        <SelectField
          label="token"
          value={filters.tokenId}
          onChange={(v) => update({ tokenId: v })}
          options={tokenOptions}
        />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ash-300">
        <button
          type="button"
          onClick={() => setFilters(emptyTradeHistoryFilters())}
          className="rounded border border-ink-600 px-3 py-1.5 font-mono uppercase tracking-wider text-ash-200 hover:bg-ink-800"
        >
          reset
        </button>
        <LimitField
          value={filters.limit}
          onChange={(v) => update({ limit: v })}
        />
        {filterErr && (
          <span className="ml-2 text-pnl-neg">⚠ {filterErr}</span>
        )}
      </div>
    </Panel>
  );
}

function SelectField({ label, value, onChange, options }) {
  const id = `th-filter-${label}`;
  return (
    <label htmlFor={id} className="flex flex-col gap-1 text-xs text-ash-300">
      <span className="font-mono uppercase tracking-wider">{label}</span>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-ink-700 bg-ink-900 px-2 py-1.5 text-sm text-ash-100"
      >
        {options.map((o) => (
          <option key={o.value || 'any'} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

function LimitField({ value, onChange }) {
  return (
    <label className="ml-auto flex items-center gap-2 text-ash-300">
      <span className="font-mono uppercase tracking-wider">limit</span>
      <input
        type="number"
        min={1}
        max={2000}
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value, 10) || 0)}
        className="num w-20 rounded border border-ink-700 bg-ink-900 px-2 py-1 text-sm text-ash-100"
      />
    </label>
  );
}

function TotalsStrip({ totals }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <TotalsCard label="events" value={String(totals.count)} />
      <TotalsCard label="exits"  value={String(totals.exitCount)} />
      <TotalsCard
        label="realized P&L"
        value={`${formatSignedSats(totals.realizedPnlSats)} sat`}
        tone={totals.realizedPnlSats > 0 ? 'pos' : totals.realizedPnlSats < 0 ? 'neg' : 'flat'}
      />
      <TotalsCard
        label="wins / losses"
        value={`${totals.gainCount} / ${totals.lossCount}`}
      />
    </div>
  );
}

function TotalsCard({ label, value, tone = 'flat' }) {
  const toneClass = tone === 'pos'
    ? 'text-pnl-pos'
    : tone === 'neg'
    ? 'text-pnl-neg'
    : 'text-ash-100';
  return (
    <div className="rounded border border-ink-700 bg-ink-900/60 px-3 py-2">
      <div className="label text-ash-400">{label}</div>
      <div className={`num mt-1 text-lg ${toneClass}`}>{value}</div>
    </div>
  );
}

function EventsTable({ events, loading }) {
  if (loading) {
    return (
      <Panel>
        <p className="text-sm text-ash-300">loading trade history…</p>
      </Panel>
    );
  }
  if (events.length === 0) {
    return (
      <Panel>
        <p className="text-sm text-ash-300">No trades match the current filters.</p>
      </Panel>
    );
  }
  return (
    <Panel padded={false}>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-ink-700 text-xs uppercase tracking-wider text-ash-400">
              <Th>when</Th>
              <Th>kind</Th>
              <Th>token</Th>
              <Th>side</Th>
              <Th>bch</Th>
              <Th>tokens</Th>
              <Th>realized P&amp;L</Th>
              <Th>status</Th>
              <Th>position</Th>
            </tr>
          </thead>
          <tbody>
            {events.map((e, idx) => (
              <EventRow key={`${e.position_id}-${e.kind}-${idx}`} event={e} />
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function Th({ children }) {
  return <th className="px-3 py-2 font-mono">{children}</th>;
}

function Td({ children, className = '' }) {
  return <td className={`px-3 py-2 align-top ${className}`}>{children}</td>;
}

function EventRow({ event }) {
  const kind = event.kind === 'entry' ? 'entry' : 'exit';
  const amounts = event.amounts || {};
  const bchCell = kind === 'entry'
    ? (Number.isFinite(amounts.bch_spent_sats) ? `-${formatSats(amounts.bch_spent_sats)}` : '—')
    : (Number.isFinite(amounts.bch_received_sats) ? `+${formatSats(amounts.bch_received_sats)}` : '—');
  const tokenCell = amounts.token_amount_base ?? '—';
  const pnlSats = event.pnl?.realized_pnl_sats;
  const pnlSign = event.pnl_sign || classifyPnl(pnlSats);
  return (
    <tr className="border-b border-ink-800 last:border-b-0 hover:bg-ink-900/40">
      <Td className="num text-ash-200">{formatLocal(event.ts)}</Td>
      <Td>
        <span className={`inline-block rounded border px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider ${eventKindClass(kind)}`}>
          {kind}
        </span>
      </Td>
      <Td>
        <div className="font-mono text-ash-100">{event.token_symbol || truncate(event.token_id, 12)}</div>
        <div className="text-[10px] text-ash-500 font-mono">{truncate(event.token_id, 16) || '—'}</div>
      </Td>
      <Td className="text-ash-300">{event.side || '—'}</Td>
      <Td className="num text-ash-200">{bchCell}</Td>
      <Td className="num text-ash-300">{tokenCell}</Td>
      <Td>
        {kind === 'exit' ? (
          <span className={`inline-block rounded border px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider ${pnlSignClass(pnlSign)}`}>
            {formatSignedSats(pnlSats)} sat
          </span>
        ) : (
          <span className="text-ash-500">—</span>
        )}
      </Td>
      <Td className="text-ash-300">{statusLabel(event.status)}</Td>
      <Td className="font-mono text-[11px] text-ash-400">{truncate(event.position_id, 18) || '—'}</Td>
    </tr>
  );
}

function computeTotals(events) {
  let count = 0;
  let exitCount = 0;
  let realizedPnlSats = 0;
  let gainCount = 0;
  let lossCount = 0;
  for (const e of (Array.isArray(events) ? events : [])) {
    if (!e || typeof e !== 'object') continue;
    count += 1;
    if (e.kind !== 'exit') continue;
    exitCount += 1;
    const sats = e.pnl?.realized_pnl_sats;
    if (typeof sats === 'number' && Number.isFinite(sats)) {
      realizedPnlSats += sats;
      if (sats > 0) gainCount += 1;
      else if (sats < 0) lossCount += 1;
    }
  }
  return { count, exitCount, realizedPnlSats, gainCount, lossCount };
}
