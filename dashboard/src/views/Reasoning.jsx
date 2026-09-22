// dashboard/src/views/Reasoning.jsx
//
// T25b — REASONING view. Shows the per-tick decision tree: what
// the bot considered, how each candidate scored, and the exact
// reason it was skipped / executed. The "is the bot actually
// active?" question has a single-glance answer here.
//
// T40 — added the expandable "decision trace" detail row. Each
// per-candidate decision can be expanded to reveal the full
// reasoning blob the trading loop stamps onto the history event
// (`entry_skipped` carries the strategy-layer reasoning, `entry`
// / `exit` link via position_id back to positions.json). The blob
// is grouped into Why / Conditions / Scoring / Meta sections and
// rendered as a key/value grid with sat-amount + redacted-secret
// formatting applied per-key.
//
// Data sources:
//   /api/reasoning — per-tick decision trees (default: 5 ticks × 20 decisions)
//
// Refreshes every 10 s (faster than the dashboard's 15 s default)
// because the user explicitly asked for visibility into "is the
// bot active RIGHT NOW." Lives on its own refresh timer so the
// other views aren't dragged along.

import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { useApi } from '../lib/api-context.jsx';
import Panel from '../components/Panel.jsx';
import ErrorState from '../components/ErrorState.jsx';
import TokenBadge from '../components/TokenBadge.jsx';
import { formatBch, formatPct, formatSats, formatLocal, truncate } from '../lib/format.mjs';
import {
  groupReasoningEntries,
  hasReasoningDetails,
  formatReasoningValue,
  formatSatsValue,
  isSatsKey,
  isSensitiveKey,
} from './reasoning-helpers.mjs';

/** Kind chips filter the per-decision rows. */
const KIND_FILTERS = [
  { id: 'all',           label: 'ALL' },
  { id: 'entry',         label: 'ENTRY' },
  { id: 'exit',          label: 'EXIT' },
  { id: 'entry_skipped', label: 'ENTRY · SKIP' },
  { id: 'entry_rejected', label: 'ENTRY · REJECT' },
  { id: 'exit_skipped',  label: 'EXIT · SKIP' },
  { id: 'entry_executed', label: 'ENTRY · EXECUTED' },
  { id: 'exit_executed', label: 'EXIT · EXECUTED' },
];

// 60s avoids browser throttling on background / Telegram in-app tabs.
const REASONING_REFRESH_MS = 60_000;

/**
 * Maps a per-decision `kind` to a Tailwind class for the reason pill.
 * Pure — exported for tests.
 */
export function kindClass(kind) {
  if (typeof kind !== 'string') return 'bg-ink-800 text-ash-300';
  if (kind === 'entry_executed' || kind === 'exit_executed') return 'bg-pnl-pos/20 text-pnl-pos border-pnl-pos/30';
  if (kind === 'entry_rejected' || kind === 'exit_rejected') return 'bg-pnl-neg/20 text-pnl-neg border-pnl-neg/30';
  if (kind === 'entry_skipped' || kind === 'exit_skipped') return 'bg-ink-800 text-ash-300 border-ink-700';
  if (kind.startsWith('entry_')) return 'bg-bch-500/15 text-bch-300 border-bch-500/30';
  if (kind.startsWith('exit_')) return 'bg-ink-800 text-ash-200 border-ink-600';
  return 'bg-ink-800 text-ash-300';
}

/**
 * Pulls the symbol out of a token_id by looking at the latest
 * history event that referenced it. Cheap O(N) walk — fine for
 * the dashboard's tens-of-tokens scale.
 *
 * @param {string} tokenId
 * @param {Array<Object>} allTicks
 * @returns {string}
 */
function resolveSymbol(tokenId, allTicks) {
  if (!tokenId) return '';
  for (let i = allTicks.length - 1; i >= 0; i--) {
    const dec = allTicks[i];
    if (!dec) continue;
    if (dec.symbol && dec.token_id === tokenId) return dec.symbol;
  }
  return `${tokenId.slice(0, 8)}…`;
}

/**
 * Resolve a `score` into a [0, 1] value for bar rendering. Already
 * normalized scores stay put; null → 0.
 *
 * @param {number|null|undefined} score
 * @returns {number}
 */
function scoreFraction(score) {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(1, score));
}

export default function Reasoning() {
  const { api } = useApi();
  const [data, setData] = useState(/** @type {any} */ (null));
  const [err, setErr] = useState(/** @type {string|null} */ (null));
  const [filter, setFilter] = useState('all');
  const [now, setNow] = useState(() => Date.now());

  const reload = useCallback(async () => {
    setErr(null);
    const r = await api.reasoning({ limit: 5, decisions: 20 });
    if (!r.ok) {
      setErr(r.error || 'unknown error');
      return;
    }
    setData(r.data);
    setNow(Date.now());
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    reload();
    const id = setInterval(() => { if (!cancelled) reload(); }, REASONING_REFRESH_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [reload]);

  // Flatten decisions across ticks for the kind-filter chip counts.
  const allDecisions = useMemo(() => {
    if (!data || !Array.isArray(data.ticks)) return [];
    const out = [];
    for (const t of data.ticks) {
      if (Array.isArray(t.decisions)) out.push(...t.decisions);
    }
    return out;
  }, [data]);

  const counts = useMemo(() => {
    const c = { all: allDecisions.length };
    for (const d of allDecisions) {
      const k = typeof d.kind === 'string' ? d.kind : 'unknown';
      c[k] = (c[k] ?? 0) + 1;
    }
    return c;
  }, [allDecisions]);

  return (
    <div className="space-y-4" data-testid="reasoning-view">
      <Panel
        title="REASONING"
        subtitle={`per-tick decision tree · auto-refresh ${REASONING_REFRESH_MS / 1000}s`}
        right={
          <div className="text-xs text-ash-400 num">
            {data?.ts ? `fetched ${formatLocal(data.ts)}` : 'loading…'}
            {data ? ` · ${data.count ?? 0} ticks · ${allDecisions.length} decisions` : ''}
          </div>
        }
      >
        {err && <ErrorState error={err} onRetry={reload} />}
        {!err && !data && <div className="text-ash-400 text-sm">loading…</div>}
        {!err && data && data.count === 0 && (
          <div className="text-ash-400 text-sm">
            No tick events yet. The bot logs one tick every <code>poll_interval_seconds</code> (default 60 s);
            check back shortly.
          </div>
        )}

        {!err && data && data.count > 0 && (
          <>
            {/* Kind filter chips */}
            <div className="flex flex-wrap gap-1.5 mb-3" data-testid="kind-filters">
              {KIND_FILTERS.map((f) => {
                const n = counts[f.id] ?? 0;
                const isActive = filter === f.id;
                const disabled = f.id !== 'all' && n === 0;
                return (
                  <button
                    key={f.id}
                    onClick={() => setFilter(f.id)}
                    disabled={disabled}
                    data-active={isActive ? 'true' : 'false'}
                    className={
                      `px-2.5 py-1 rounded text-[10px] font-mono uppercase tracking-wider border transition-colors ` +
                      (disabled
                        ? 'bg-ink-900 text-ash-500 border-ink-800 cursor-not-allowed opacity-50'
                        : isActive
                          ? 'bg-bch-500 text-ink-950 border-bch-500'
                          : 'bg-ink-800 text-ash-200 border-ink-600 hover:bg-ink-700 hover:text-ash-100')
                    }
                  >
                    {f.label} <span className="num ml-1 opacity-80">{n}</span>
                  </button>
                );
              })}
            </div>

            {/* One card per tick (newest first). */}
            <div className="space-y-3">
              {data.ticks.map((t, idx) => (
                <TickDecisionCard
                  key={t.ts ?? idx}
                  tick={t}
                  filter={filter}
                  allTicks={allDecisions}
                />
              ))}
            </div>
          </>
        )}
      </Panel>

      <Panel title="HOW TO READ THIS">
        <p className="text-sm text-ash-300 leading-relaxed">
          Each card is one <code>tick()</code> call. The header line shows the wallet balance and whether
          the circuit breaker tripped. The table is what the bot did with the top 3 ranked candidates:
          for each, the score (0–1, higher is better), the rank (1 is best), and the exact skip / reject
          reason. <span className="text-bch-300">ENTRY · EXECUTED</span> = the bot signed and broadcast a
          real swap. <span className="text-ash-200">ENTRY · SKIP</span> = strategy said no (e.g.
          too close to 24h high). <span className="text-pnl-neg">ENTRY · REJECT</span> = risk layer said no
          (e.g. position would exceed max exposure).
        </p>
      </Panel>

      <div className="text-[10px] text-ash-500 num" data-testid="reasoning-clock">
        local clock {formatLocal(new Date(now).toISOString())}
      </div>
    </div>
  );
}

/**
 * One tick = one card. Renders the tick summary + a table of
 * per-candidate decisions filtered by `filter`.
 */
function TickDecisionCard(props) {
  const { tick, filter, allTicks } = props;
  const { decisions } = tick;
  const tickEvent = tick.tick ?? {};

  const filteredDecisions = useMemo(() => {
    if (!Array.isArray(decisions)) return [];
    if (filter === 'all') return decisions;
    if (filter === 'entry') return decisions.filter((d) => typeof d.kind === 'string' && d.kind.startsWith('entry_'));
    if (filter === 'exit') return decisions.filter((d) => typeof d.kind === 'string' && d.kind.startsWith('exit_'));
    return decisions.filter((d) => d.kind === filter);
  }, [decisions, filter]);

  const balanceBch = useMemo(() => {
    const s = tickEvent.wallet_balance_sats;
    if (typeof s === 'string' || typeof s === 'number') return formatBch(s);
    return '—';
  }, [tickEvent.wallet_balance_sats]);

  const duration = (typeof tickEvent.duration_ms === 'number') ? `${tickEvent.duration_ms} ms` : '—';

  return (
    <div className="rounded border border-ink-700 bg-ink-900/40 p-3" data-testid="tick-card">
      {/* Header */}
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
        <div className="text-xs font-mono text-ash-200">
          TICK <span className="text-bch-400">{formatLocal(tick.ts)}</span>
        </div>
        <div className="text-[10px] text-ash-400 flex flex-wrap gap-x-3 gap-y-1 num">
          <span>balance <span className="text-ash-100">{balanceBch}</span></span>
          <span>candidates <span className="text-ash-100">{tickEvent.candidate_count ?? 0}</span></span>
          <span>attempts <span className="text-ash-100">{tickEvent.entry_attempts ?? 0}</span></span>
          <span>executed <span className={tickEvent.entries_succeeded > 0 ? 'text-pnl-pos' : 'text-ash-100'}>{tickEvent.entries_succeeded ?? 0}</span></span>
          <span>positions <span className="text-ash-100">{tickEvent.open_position_count ?? 0}</span></span>
          <span>breaker <span className={tickEvent.breaker_tripped ? 'text-pnl-neg' : 'text-ash-500'}>{tickEvent.breaker_tripped ? 'TRIPPED' : 'ok'}</span></span>
          <span>dur <span className="text-ash-500">{duration}</span></span>
        </div>
      </div>

      {filteredDecisions.length === 0 ? (
        <div className="text-xs text-ash-500 italic">
          {Array.isArray(decisions) && decisions.length > 0
            ? `no decisions match filter "${filter}" for this tick`
            : 'no per-candidate events recorded for this tick'}
        </div>
      ) : (
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-xs" data-testid="decision-table">
            <thead className="text-[10px] text-ash-400 uppercase tracking-wider">
              <tr className="border-b border-ink-700">
                <th className="px-1 py-1 w-5 font-medium" aria-label="expand"></th>
                <th className="px-2 py-1 text-left font-medium">kind</th>
                <th className="px-2 py-1 text-left font-medium">token</th>
                <th className="px-2 py-1 text-right font-medium">score</th>
                <th className="px-2 py-1 text-right font-medium">rank</th>
                <th className="px-2 py-1 text-left font-medium">reason</th>
              </tr>
            </thead>
            <tbody>
              {filteredDecisions.map((d, i) => (
                <DecisionRow key={`${d.kind ?? '?'}-${d.token_id ?? ''}-${d.ts ?? i}`} decision={d} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * One row in the decision table. Renders the kind pill, symbol
 * (or token_id prefix), score bar + number, rank, and reason.
 *
 * T40: when the decision carries a reasoning blob, the row grows
 * a leading expand toggle. Clicking it reveals a colspan row
 * underneath with the full blob grouped into Why / Conditions /
 * Scoring / Meta sections (see reasoning-helpers.mjs).
 */
function DecisionRow(props) {
  const { decision: d } = props;
  const kind = typeof d.kind === 'string' ? d.kind : '?';
  const score = (typeof d.score === 'number') ? d.score : null;
  const rank = (typeof d.rank === 'number') ? d.rank : null;
  const reason = typeof d.reason === 'string' ? d.reason : '';
  const tokenId = typeof d.token_id === 'string' ? d.token_id : '';
  const symbol = (typeof d.symbol === 'string' && d.symbol.length > 0)
    ? d.symbol
    : `${tokenId.slice(0, 8)}…`;
  const fraction = scoreFraction(score);
  const pct = Math.round(fraction * 100);
  // T40: expandable detail panel. Only available when the decision
  // event carries a reasoning blob with at least one recognized
  // key — older history events without the blob just hide the
  // toggle (backward-compatible).
  const reasoning = (d && typeof d.reasoning === 'object' && d.reasoning !== null)
    ? d.reasoning
    : null;
  const showDetails = hasReasoningDetails(reasoning);
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <tr className="border-b border-ink-800 last:border-b-0 hover:bg-ink-900/60" data-testid="decision-row">
        <td className="px-1 py-1.5 align-top">
          {showDetails ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="w-5 h-5 rounded border border-ink-700 bg-ink-900 hover:bg-ink-800 text-ash-300 hover:text-bch-300 text-[10px] font-mono leading-none flex items-center justify-center transition-colors"
              aria-label={expanded ? 'collapse details' : 'expand details'}
              aria-expanded={expanded}
              data-testid="expand-toggle"
            >
              {expanded ? '▼' : '▶'}
            </button>
          ) : (
            <span className="inline-block w-5 h-5" aria-hidden="true" />
          )}
        </td>
        <td className="px-2 py-1.5 align-top">
          <span className={`inline-block rounded px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider border ${kindClass(kind)}`} data-kind={kind}>
            {kind}
          </span>
        </td>
        <td className="px-2 py-1.5 align-top">
          {tokenId ? (
            <TokenBadge tokenId={tokenId} compact />
          ) : (
            <div className="font-mono text-ash-100 text-[11px]">{symbol}</div>
          )}
          {tokenId && (
            <div className="text-[9px] text-ash-500 font-mono num mt-0.5">{tokenId.slice(0, 12)}…</div>
          )}
        </td>
        <td className="px-2 py-1.5 align-top text-right">
          <div className="flex items-center justify-end gap-2">
            <div className="w-16 h-1.5 rounded bg-ink-800 overflow-hidden">
              <div
                className={`h-full rounded ${fraction >= 0.6 ? 'bg-pnl-pos' : fraction >= 0.35 ? 'bg-bch-400' : 'bg-ash-500'}`}
                style={{ width: `${pct}%` }}
                data-testid="score-bar"
              />
            </div>
            <span className="font-mono num text-[11px] w-10 text-right">
              {score !== null ? score.toFixed(2) : '—'}
            </span>
          </div>
        </td>
        <td className="px-2 py-1.5 align-top text-right font-mono num text-ash-200">
          {rank !== null ? `#${rank}` : '—'}
        </td>
        <td className="px-2 py-1.5 align-top text-[11px] text-ash-300 max-w-md">
          {reason ? truncate(reason, 120) : <span className="text-ash-500">—</span>}
        </td>
      </tr>
      {showDetails && expanded && (
        <tr data-testid="decision-detail">
          <td colSpan={6} className="px-2 py-2 align-top bg-ink-900/60 border-b border-ink-700">
            <ReasoningDetail reasoning={reasoning} />
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * T40: render the full reasoning blob grouped into Why /
 * Conditions / Scoring / Meta sections. Each section is a
 * key/value grid; values get sat-amount formatting when the key
 * looks like a sat field, and secret-shaped keys are redacted.
 *
 * Pure presentation — relies entirely on reasoning-helpers.mjs.
 */
function ReasoningDetail(props) {
  const { reasoning } = props;
  const sections = useMemo(() => groupReasoningEntries(reasoning), [reasoning]);
  if (sections.length === 0) {
    return <div className="text-xs text-ash-500 italic">no reasoning blob recorded</div>;
  }
  return (
    <div className="space-y-3" data-testid="reasoning-detail">
      {sections.map((section) => (
        <div key={section.id} className="rounded border border-ink-700 bg-ink-950/60 p-2">
          <div className="label text-bch-400 mb-1.5">{section.label}</div>
          <dl className="grid grid-cols-12 gap-y-1 text-xs">
            {section.entries.map(([key, value]) => (
              <ReasoningField key={key} fieldKey={key} value={value} />
            ))}
          </dl>
        </div>
      ))}
    </div>
  );
}

/**
 * T40: one key/value row inside the ReasoningDetail panel. Renders
 * the key as a label, then formats the value (sat-amount aware +
 * redacted-secret + nested-object-as-JSON).
 */
function ReasoningField(props) {
  const { fieldKey, value } = props;
  const sensitive = isSensitiveKey(fieldKey);
  let formatted;
  if (sensitive) {
    formatted = '***redacted***';
  } else if (isSatsKey(fieldKey)) {
    const satFmt = formatSatsValue(value);
    formatted = satFmt !== null ? satFmt : formatReasoningValue(value);
  } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    // Nested objects render as a short JSON preview so the operator
    // can drill in without expanding a tree-control.
    try {
      formatted = JSON.stringify(value, null, 0);
    } catch {
      formatted = formatReasoningValue(value);
    }
  } else {
    formatted = formatReasoningValue(value);
  }
  return (
    <>
      <dt className="col-span-4 text-ash-400 font-mono text-[10px] break-all">{fieldKey}</dt>
      <dd className="col-span-8 text-ash-100 text-[11px] break-all whitespace-pre-wrap">{formatted}</dd>
    </>
  );
}
