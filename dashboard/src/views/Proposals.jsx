// dashboard/src/views/Proposals.jsx
//
// T30 — PROPOSALS view. The dashboard tab that lets the operator
// review ideas the research cron (scripts/feature_researcher.mjs)
// has generated, approve / reject / reset them, and (on approve)
// trigger a TODO entry to be appended to TODO.md so the supervisor
// picks the work up on its next tick.
//
// Data sources (all read-only by default, write needs `?token=`):
//   GET  /api/feature-ideas            list (with status/category filters)
//   GET  /api/feature-ideas/meta        counters + last_research_at
//   POST /api/feature-ideas/:id/status  approve / reject / reset (write)
//   POST /api/feature-ideas/:id/notes   append a note (write)
//
// Refresh interval: 60s. The operator's actions are usually
// explicit (button clicks), so the poll is just to catch
// research-cron runs the operator didn't trigger themselves.

import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { useApi } from '../lib/api-context.jsx';
import Panel from '../components/Panel.jsx';
import ErrorState from '../components/ErrorState.jsx';
import { formatLocal, truncate } from '../lib/format.mjs';
import {
  statusClass,
  impactClass,
  effortLabel,
  relativeTime,
  countsFromMeta,
  emptyOperatorDraft,
  validateOperatorDraft,
  csvToCategoryTags,
  CATEGORY_OPTIONS,
  EFFORT_OPTIONS,
  IMPACT_OPTIONS,
} from './proposals-helpers.mjs';

const REFRESH_MS = 60_000;

const STATUS_FILTERS = [
  { id: 'pending',  label: 'PENDING'  },
  { id: 'approved', label: 'APPROVED' },
  { id: 'rejected', label: 'REJECTED' },
  { id: 'shipped',  label: 'SHIPPED'  },
  { id: 'all',      label: 'ALL'      },
];

const CATEGORY_FILTERS = [
  { id: 'all',                   label: 'ALL'                   },
  { id: 'edge-case-protection',  label: 'EDGE-CASE'             },
  { id: 'decision-logic',        label: 'DECISION'              },
  { id: 'dashboard',             label: 'DASHBOARD'             },
  { id: 'observability',         label: 'OBSERVABILITY'         },
  { id: 'performance',           label: 'PERFORMANCE'           },
];

/**
 * Re-exports kept here for any external consumer that imports
 * from the .jsx file directly (Node can't import .jsx, so test
 * suites should import from `./proposals-helpers.mjs` instead).
 */
export {
  statusClass,
  impactClass,
  effortLabel,
  relativeTime,
} from './proposals-helpers.mjs';

export default function Proposals() {
  const { api, token } = useApi();
  const canWrite = Boolean(token && token.length > 0);

  const [data, setData] = useState(/** @type {{ideas: Array<Object>, meta: Object}|null} */ (null));
  const [err, setErr] = useState(/** @type {string|null} */ (null));
  const [statusFilter, setStatusFilter] = useState('pending');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [now, setNow] = useState(() => Date.now());
  const [busyId, setBusyId] = useState(/** @type {string|null} */ (null));
  const [banner, setBanner] = useState(/** @type {{ok:boolean,msg:string}|null} */ (null));
  const [runs, setRuns] = useState(/** @type {Array<Object>} */ ([]));
  const [runsErr, setRunsErr] = useState(/** @type {string|null} */ (null));
  // Operator-create flow. When `creating` is true, the form panel
  // shows below the header; submission goes via api.createFeatureIdea.
  const [creating, setCreating] = useState(false);
  const [createDraft, setCreateDraft] = useState(emptyOperatorDraft());
  const [createBusy, setCreateBusy] = useState(false);
  const [createErr, setCreateErr] = useState(/** @type {string|null} */ (null));

  const reload = useCallback(async () => {
    setErr(null);
    const opts = {};
    if (statusFilter !== 'all') opts.status = statusFilter;
    if (categoryFilter !== 'all') opts.category = categoryFilter;
    const r = await api.featureIdeas(opts);
    if (!r.ok) {
      setErr(r.error || 'unknown error');
      return;
    }
    setData(r.data);
    setNow(Date.now());
  }, [api, statusFilter, categoryFilter]);

  // T30c: also tail the research-cron-run history so the operator
  // can see "last 5 cron runs" + "since last research" without
  // reading the script logs.
  const reloadRuns = useCallback(async () => {
    const r = await api.researchRuns({ limit: 5 });
    if (!r.ok) {
      setRunsErr(r.error || 'unknown');
      return;
    }
    setRunsErr(null);
    setRuns(Array.isArray(r.data?.events) ? r.data.events : []);
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    reload();
    reloadRuns();
    const id = setInterval(() => {
      if (!cancelled) { reload(); reloadRuns(); }
    }, REFRESH_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [reload, reloadRuns]);

  // After every action, briefly reload to pull the canonical state.
  const handleAction = useCallback(async (idea, newStatus) => {
    if (!canWrite) {
      setBanner({ ok: false, msg: 'write actions need a token — append ?token=… to the URL' });
      return;
    }
    setBusyId(idea.id);
    setBanner(null);
    try {
      const r = await api.updateFeatureIdeaStatus(idea.id, { status: newStatus });
      if (!r.ok) {
        setBanner({ ok: false, msg: `${newStatus} failed: ${r.error || 'unknown'}` });
        return;
      }
      const todoSuffix = (r.data && r.data.todo && r.data.todo.appended)
        ? ` → TODO ${r.data.todo.todoId ?? '?'} appended`
        : '';
      const todoFailSuffix = (r.data && r.data.todo && r.data.todo.appended === false)
        ? ` (TODO append failed: ${r.data.todo.error || 'unknown'})`
        : '';
      setBanner({
        ok: true,
        msg: `set "${truncate(idea.title, 40)}" → ${newStatus}${todoSuffix}${todoFailSuffix}`,
      });
      await reload();
    } finally {
      setBusyId(null);
    }
  }, [api, canWrite, reload]);

  const handleAddNote = useCallback(async (idea, noteBody) => {
    if (!canWrite) {
      setBanner({ ok: false, msg: 'write actions need a token — append ?token=… to the URL' });
      return;
    }
    if (typeof noteBody !== 'string' || noteBody.trim().length === 0) return;
    setBusyId(idea.id);
    setBanner(null);
    try {
      const r = await api.addFeatureIdeaNote(idea.id, { body: noteBody.trim(), author: 'operator' });
      if (!r.ok) {
        setBanner({ ok: false, msg: `note failed: ${r.error || 'unknown'}` });
        return;
      }
      setBanner({ ok: true, msg: `note added to "${truncate(idea.title, 40)}"` });
      await reload();
    } finally {
      setBusyId(null);
    }
  }, [api, canWrite, reload]);

  /**
   * Operator-create handler. POSTs the draft to the backend, then
   * reloads the list. On collision the backend still creates a new
   * idea (with `-1` suffix); we surface that in the success banner
   * so the operator knows their copy became a sibling idea.
   */
  const handleCreate = useCallback(async (event) => {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    if (!canWrite) {
      setCreateErr('write actions need a token — append ?token=… to the URL');
      return;
    }
    setCreateErr(null);
    const draft = createDraft;
    const check = validateOperatorDraft(draft);
    if (!check.ok) {
      setCreateErr(check.error);
      return;
    }
    setCreateBusy(true);
    try {
      const body = {
        title: draft.title.trim(),
        category: draft.category,
        rationale: draft.rationale.trim(),
        evidence: typeof draft.evidence === 'string' ? draft.evidence : '',
        effort: draft.effort,
        impact: draft.impact,
        category_tags: csvToCategoryTags(draft),
      };
      const r = await api.createFeatureIdea(body);
      if (!r.ok) {
        setCreateErr(r.error || 'unknown error');
        return;
      }
      const id = (r.data && r.data.idea && r.data.idea.id) || '?';
      const collisionNote = (r.data && r.data.id_was_collision)
        ? ' (collision — id suffixed)'
        : '';
      setBanner({
        ok: true,
        msg: `created "${truncate(draft.title, 40)}" → id ${id}${collisionNote}`,
      });
      setCreating(false);
      setCreateDraft(emptyOperatorDraft());
      await reload();
    } finally {
      setCreateBusy(false);
    }
  }, [api, canWrite, createDraft, reload]);

  // Per-status filter chip counts come from the meta envelope (always
  // global, regardless of which status/category filter is active).
  // Previously this derived from `data.ideas` which is the filtered
  // list — so approving a pending idea didn't bump Approved# because
  // `approved` keys in `data.ideas` were all 0.
  const counts = useMemo(() => countsFromMeta(data?.meta), [data]);

  const meta = data?.meta;
  const lastResearch = (meta && typeof meta.last_research_at === 'string') ? meta.last_research_at : null;

  return (
    <div className="space-y-4" data-testid="proposals-view">
      <Panel
        title="PROPOSALS"
        subtitle={`feature ideas · auto-refresh ${REFRESH_MS / 1000}s`}
        right={
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <div className="text-xs text-ash-400 num flex flex-wrap gap-x-3" data-testid="proposals-meta">
              {lastResearch ? (
                <span>last research <span className="text-ash-100">{relativeTime(lastResearch, now)}</span> <span className="text-ash-500">({formatLocal(lastResearch)})</span></span>
              ) : (
                <span className="text-ash-500">no research yet</span>
              )}
              {meta && (
                <>
                  <span>total <span className="text-ash-100">{meta.total_count ?? 0}</span></span>
                  <span>pending <span className="text-bch-300">{meta.pending_count ?? 0}</span></span>
                  <span>approved <span className="text-pnl-pos">{meta.approved_count ?? 0}</span></span>
                  <span>shipped <span className="text-bch-400">{meta.shipped_count ?? 0}</span></span>
                  <span>rejected <span className="text-pnl-neg">{meta.rejected_count ?? 0}</span></span>
                </>
              )}
              {!canWrite && <span className="text-amber-300">read-only (no token)</span>}
            </div>
            {canWrite && (
              <button
                type="button"
                onClick={() => {
                  setCreating((c) => !c);
                  setCreateErr(null);
                  setCreateDraft(emptyOperatorDraft());
                }}
                data-testid="toggle-create-btn"
                className="px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider rounded border border-bch-500/60 text-bch-300 hover:bg-bch-500/10"
              >
                {creating ? '× cancel' : '+ new proposal'}
              </button>
            )}
          </div>
        }
      >
        {err && <ErrorState error={err} onRetry={reload} />}
        {!err && !data && <div className="text-ash-400 text-sm">loading…</div>}
        {banner && (
          <div
            className={
              `mb-3 rounded border px-3 py-2 text-xs font-mono ` +
              (banner.ok
                ? 'border-bch-500/40 bg-bch-500/10 text-bch-300'
                : 'border-amber-700/60 bg-amber-950/30 text-amber-200')
            }
            data-testid="proposals-banner"
          >
            {banner.msg}
          </div>
        )}

        {!err && data && (
          <>
            {/* Status + category filters */}
            <div className="space-y-2 mb-3">
              <FilterRow
                testid="status-filters"
                items={STATUS_FILTERS.map((f) => ({ ...f, count: counts[f.id] ?? 0 }))}
                active={statusFilter}
                onSelect={setStatusFilter}
              />
              <FilterRow
                testid="category-filters"
                items={CATEGORY_FILTERS}
                active={categoryFilter}
                onSelect={setCategoryFilter}
              />
            </div>

            {/* List */}
            {data.ideas.length === 0 ? (
              <div className="text-ash-400 text-sm italic py-4">
                No ideas match the current filters.
                {statusFilter === 'pending'
                  ? ' When the research cron runs, pending ideas will appear here.'
                  : ''}
              </div>
            ) : (
              <div className="space-y-3" data-testid="idea-list">
                {data.ideas.map((idea) => (
                  <IdeaCard
                    key={idea.id}
                    idea={idea}
                    canWrite={canWrite}
                    busy={busyId === idea.id}
                    onAction={handleAction}
                    onAddNote={handleAddNote}
                    nowMs={now}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </Panel>

      <Panel
        title="RECENT CRON RUNS"
        subtitle={`kind: research_cron_run · last ${runs.length}`}
      >
        {runsErr && <ErrorState error={runsErr} onRetry={reloadRuns} />}
        {!runsErr && runs.length === 0 && (
          <div className="text-ash-400 text-sm italic py-2">
            No cron runs recorded yet. The first <code>feature_researcher</code> run will appear here.
          </div>
        )}
        {!runsErr && runs.length > 0 && (
          <div className="space-y-2 text-xs" data-testid="cron-runs-list">
            {runs.map((r) => {
              const ts = typeof r.ts === 'string' ? r.ts : null;
              const ran = r.ran === true;
              const dryRun = r.dry_run === true;
              const rateLimited = r.rate_limited === true;
              const forced = r.forced === true;
              const added = Number.isFinite(r.added) ? r.added : 0;
              const skipped = Number.isFinite(r.skipped) ? r.skipped : 0;
              const available = Number.isFinite(r.available) ? r.available : 0;
              const spent = Number.isFinite(r.spent) ? r.spent : 0;
              const hoursSince = Number.isFinite(r.hours_since_last_run) ? r.hours_since_last_run : null;
              const summary = rateLimited
                ? `rate-limited${forced ? ' (forced)' : ''}`
                : (ran
                    ? `${added} added · ${skipped} skipped · ${available} available · ${spent} spent`
                    : 'no-op');
              const pill = rateLimited
                ? 'border-amber-700/60 text-amber-200 bg-amber-950/30'
                : (dryRun
                    ? 'border-bch-700/40 text-bch-300 bg-bch-900/20'
                    : (ran
                        ? 'border-pnl-pos/40 text-pnl-pos bg-pnl-pos/5'
                        : 'border-ash-700 text-ash-400 bg-ash-900/30'));
              return (
                <div
                  key={`${ts ?? ''}-${r.file ?? ''}-${added}`}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-ash-800/60 bg-ash-950/50 px-3 py-2 font-mono"
                >
                  <span className={`px-1.5 py-0.5 rounded text-[10px] border ${pill}`}>
                    {rateLimited ? 'RATE-LIMITED' : (dryRun ? 'DRY-RUN' : (ran ? 'RAN' : 'NO-OP'))}
                  </span>
                  <span className="text-ash-300 num">{summary}</span>
                  {hoursSince !== null && (
                    <span className="text-ash-500 num">Δ {hoursSince.toFixed(1)}h</span>
                  )}
                  {ts && (
                    <span className="text-ash-400 num ml-auto">
                      {relativeTime(ts, now)} <span className="text-ash-600">({formatLocal(ts)})</span>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      {canWrite && creating && (
        <Panel
          title="NEW PROPOSAL"
          subtitle="operator-created — id will be assigned by the backend"
        >
          <form onSubmit={handleCreate} data-testid="create-form" className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <Field label="Title *">
                <input
                  type="text"
                  required
                  maxLength={200}
                  value={createDraft.title}
                  onChange={(e) => setCreateDraft((d) => ({ ...d, title: e.target.value }))}
                  data-testid="create-title"
                  placeholder="e.g. Auto-reconcile orphan positions when wallet UTXO sweep detects them"
                  className="w-full bg-ink-950 border border-ink-700 rounded px-2 py-1 text-xs text-ash-100 placeholder:text-ash-500 focus:outline-none focus:border-bch-500"
                />
              </Field>
              <Field label="Category">
                <select
                  value={createDraft.category}
                  onChange={(e) => setCreateDraft((d) => ({ ...d, category: e.target.value }))}
                  data-testid="create-category"
                  className="w-full bg-ink-950 border border-ink-700 rounded px-2 py-1 text-xs text-ash-100 focus:outline-none focus:border-bch-500"
                >
                  {CATEGORY_OPTIONS.map((c) => (
                    <option key={c.value} value={c.value} className="bg-ink-950">{c.label}</option>
                  ))}
                </select>
              </Field>
              <Field label="Effort / Impact">
                <div className="flex gap-2">
                  <select
                    value={createDraft.effort}
                    onChange={(e) => setCreateDraft((d) => ({ ...d, effort: e.target.value }))}
                    data-testid="create-effort"
                    className="flex-1 bg-ink-950 border border-ink-700 rounded px-2 py-1 text-xs text-ash-100 focus:outline-none focus:border-bch-500"
                  >
                    {EFFORT_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value} className="bg-ink-950">{o.label}</option>
                    ))}
                  </select>
                  <select
                    value={createDraft.impact}
                    onChange={(e) => setCreateDraft((d) => ({ ...d, impact: e.target.value }))}
                    data-testid="create-impact"
                    className="flex-1 bg-ink-950 border border-ink-700 rounded px-2 py-1 text-xs text-ash-100 focus:outline-none focus:border-bch-500"
                  >
                    {IMPACT_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value} className="bg-ink-950">{o.label}</option>
                    ))}
                  </select>
                </div>
              </Field>
            </div>

            <Field label="Rationale *">
              <textarea
                required
                rows={3}
                value={createDraft.rationale}
                onChange={(e) => setCreateDraft((d) => ({ ...d, rationale: e.target.value }))}
                data-testid="create-rationale"
                placeholder="Why is this worth building? What problem does it solve?"
                className="w-full bg-ink-950 border border-ink-700 rounded px-2 py-1 text-xs text-ash-100 placeholder:text-ash-500 focus:outline-none focus:border-bch-500 resize-y"
              />
            </Field>

            <Field label="Evidence (optional)">
              <textarea
                rows={2}
                value={createDraft.evidence}
                onChange={(e) => setCreateDraft((d) => ({ ...d, evidence: e.target.value }))}
                data-testid="create-evidence"
                placeholder="A specific observed case, a URL, a position id, or anything concrete"
                className="w-full bg-ink-950 border border-ink-700 rounded px-2 py-1 text-xs text-ash-100 placeholder:text-ash-500 focus:outline-none focus:border-bch-500 resize-y"
              />
            </Field>

            <Field label="Tags (comma-separated, optional)">
              <input
                type="text"
                value={createDraft.category_tags_csv}
                onChange={(e) => setCreateDraft((d) => ({ ...d, category_tags_csv: e.target.value }))}
                data-testid="create-tags"
                placeholder="e.g. wallet, utxo-management, follow-up"
                className="w-full bg-ink-950 border border-ink-700 rounded px-2 py-1 text-xs text-ash-100 placeholder:text-ash-500 focus:outline-none focus:border-bch-500"
              />
            </Field>

            {createErr && (
              <div className="text-xs text-amber-300 border border-amber-700/60 bg-amber-950/30 rounded px-2 py-1" data-testid="create-error">
                {createErr}
              </div>
            )}

            <div className="flex items-center gap-2 pt-1">
              <button
                type="submit"
                disabled={createBusy}
                data-testid="create-submit"
                className="px-3 py-1.5 text-xs font-mono uppercase tracking-wider rounded border border-bch-500 bg-bch-500/15 text-bch-300 hover:bg-bch-500/25 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {createBusy ? 'creating…' : '✓ create proposal'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setCreating(false);
                  setCreateErr(null);
                  setCreateDraft(emptyOperatorDraft());
                }}
                disabled={createBusy}
                data-testid="create-cancel"
                className="px-3 py-1.5 text-xs font-mono uppercase tracking-wider rounded border border-ink-600 text-ash-200 hover:bg-ink-800 disabled:opacity-50"
              >
                cancel
              </button>
              <span className="text-[10px] text-ash-500 ml-2">
                id: <code className="font-mono text-ash-400">idea_operator_&lt;slug&gt;_&lt;YYYYMMDD&gt;</code> (assigned on submit)
              </span>
            </div>
          </form>
        </Panel>
      )}

      <Panel title="HOW THIS WORKS">
        <p className="text-sm text-ash-300 leading-relaxed space-y-2">
          <span className="block">
            The <code>feature_researcher</code> cron runs periodically and pulls 1-3 new ideas from a
            curated catalog, deduped against everything already in the store.
          </span>
          <span className="block">
            <span className="text-bch-300">APPROVE</span> flips the idea to <code>approved</code> and
            appends a <code>T##</code> entry to <code>TODO.md</code> — the supervisor picks it up on
            its next tick. <span className="text-pnl-neg">REJECT</span> marks it rejected; the
            catalog won\'t re-propose it. <span className="text-ash-200">RESET</span> moves a
            rejected/approved idea back to pending.
          </span>
          <span className="block">
            The supervisor sets status to <span className="text-bch-400">shipped</span> after
            shipping the work; shipped ideas stay visible for audit.
          </span>
        </p>
      </Panel>
    </div>
  );
}

/**
 * A horizontal row of filter chips. Pure render — exported for tests.
 */
function FilterRow(props) {
  const { items, active, onSelect, testid } = props;
  return (
    <div className="flex flex-wrap gap-1.5" data-testid={testid}>
      {items.map((f) => {
        const isActive = active === f.id;
        const count = f.count;
        const showCount = typeof count === 'number' && (f.id !== 'all' || count > 0);
        return (
          <button
            key={f.id}
            onClick={() => onSelect(f.id)}
            data-active={isActive ? 'true' : 'false'}
            data-filter-id={f.id}
            className={
              `px-2.5 py-1 rounded text-[10px] font-mono uppercase tracking-wider border transition-colors ` +
              (isActive
                ? 'bg-bch-500 text-ink-950 border-bch-500'
                : 'bg-ink-800 text-ash-200 border-ink-600 hover:bg-ink-700 hover:text-ash-100')
            }
          >
            {f.label}
            {showCount && <span className="num ml-1 opacity-80">{count}</span>}
          </button>
        );
      })}
    </div>
  );
}

/**
 * One idea. Renders title, status / category / effort / impact pills,
 * rationale + evidence, notes (if any), and action buttons.
 */
/**
 * Copy `text` to the clipboard. Falls back to a hidden-textarea +
 * execCommand('copy') trick when navigator.clipboard isn't available
 * (older browsers, non-secure contexts). Returns a promise that
 * resolves to true on success.
 */
function copyText(text) {
  if (typeof window === 'undefined' || typeof text !== 'string' || text.length === 0) {
    return Promise.resolve(false);
  }
  if (navigator && typeof navigator.clipboard?.writeText === 'function') {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => fallbackCopy(text));
  }
  return Promise.resolve(fallbackCopy(text));
}

/** Last-resort clipboard write — execCommand is deprecated but
 *  supported in every desktop browser. Pure-DOM, no globals. */
function fallbackCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand && document.execCommand('copy');
    document.body.removeChild(ta);
    return !!ok;
  } catch {
    return false;
  }
}

function IdeaCard(props) {
  const { idea, canWrite, busy, onAction, onAddNote, nowMs } = props;
  const id = typeof idea.id === 'string' ? idea.id : '';
  const title = typeof idea.title === 'string' ? idea.title : '(untitled)';
  const status = typeof idea.status === 'string' ? idea.status : 'pending';
  const category = typeof idea.category === 'string' ? idea.category : 'unknown';
  const effort = typeof idea.effort === 'string' ? idea.effort : 'M';
  const impact = typeof idea.impact === 'string' ? idea.impact : 'medium';
  const rationale = typeof idea.rationale === 'string' ? idea.rationale : '';
  const evidence = typeof idea.evidence === 'string' ? idea.evidence : '';
  const tags = Array.isArray(idea.category_tags) ? idea.category_tags : [];
  const notes = Array.isArray(idea.notes) ? idea.notes : [];
  const createdAt = typeof idea.created_at === 'string' ? idea.created_at : '';
  const shippedIn = typeof idea.shipped_in === 'string' ? idea.shipped_in : null;

  const [noteDraft, setNoteDraft] = useState('');
  const [showNote, setShowNote] = useState(false);
  // Track which idea id is currently in the "copied" state so each
  // card flashes its own confirmation independently. Cleared after 1.2s.
  const [copiedId, setCopiedId] = useState(null);

  const isPending  = status === 'pending';
  const isApproved = status === 'approved';
  const isRejected = status === 'rejected';
  const isShipped  = status === 'shipped';

  return (
    <div className="rounded border border-ink-700 bg-ink-900/40 p-3" data-testid="idea-card" data-idea-id={id}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
        <div className="text-sm font-medium text-ash-100 pr-2 flex-1" data-testid="idea-title">
          {title}
        </div>
        <div className="flex flex-wrap gap-1">
          <span className={`inline-block rounded px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider border ${statusClass(status)}`} data-testid="idea-status">
            {status}
          </span>
          <span className={`inline-block rounded px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider border ${impactClass(impact)}`} data-testid="idea-impact">
            {impact}
          </span>
          <span className="inline-block rounded px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider border bg-ink-800 text-ash-200 border-ink-600" data-testid="idea-effort">
            effort {effortLabel(effort)}
          </span>
          <span className="inline-block rounded px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider border bg-ink-800 text-ash-300 border-ink-700" data-testid="idea-category">
            {category}
          </span>
        </div>
      </div>

      <div className="text-xs text-ash-300 mb-2 leading-relaxed" data-testid="idea-rationale">
        {rationale || <span className="text-ash-500 italic">(no rationale)</span>}
      </div>

      {evidence && evidence.length > 0 && (
        <div className="text-[11px] text-ash-400 mb-2 leading-relaxed pl-2 border-l border-ink-700" data-testid="idea-evidence">
          {evidence}
        </div>
      )}

      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2" data-testid="idea-tags">
          {tags.map((t, i) => (
            <span key={`${t}-${i}`} className="text-[9px] font-mono text-ash-500 px-1.5 py-0.5 rounded bg-ink-950 border border-ink-800">
              {t}
            </span>
          ))}
        </div>
      )}

      <div className="text-[10px] text-ash-500 num flex flex-wrap gap-x-3 mb-2" data-testid="idea-timestamps">
        {createdAt && <span>created <span className="text-ash-300">{relativeTime(createdAt, nowMs)}</span></span>}
        {shippedIn && <span>shipped in <code className="text-bch-400">{shippedIn.slice(0, 7)}</code></span>}
      </div>

      {/* ID row — click-to-copy so the operator can reference specific
          ideas in chat ("should we ship idea_seed_indexer_price_pre_entry_check?").
          Uses navigator.clipboard when available, falls back to a hidden
          textarea + execCommand for older browsers / non-secure contexts. */}
      <div className="mb-2 flex flex-wrap items-center gap-2" data-testid="idea-id-row">
        <span className="text-[10px] text-ash-500 uppercase tracking-wider">id</span>
        <code
          className="text-[10px] font-mono text-ash-300 bg-ink-950 border border-ink-800 rounded px-1.5 py-0.5 select-all"
          data-testid="idea-id"
          title="Click to copy"
        >
          {id}
        </code>
        <button
          type="button"
          onClick={() => {
            copyText(id);
            setCopiedId(id);
            // Clear the confirmation after 1.2s. The card may be
            // unmounted by then (filter switched, idea approved) —
            // that's fine, the timeout just no-ops against state.
            setTimeout(() => {
              setCopiedId((cur) => (cur === id ? null : cur));
            }, 1200);
          }}
          data-testid="copy-id-btn"
          className="text-[10px] font-mono uppercase tracking-wider text-ash-400 hover:text-bch-300 border border-ink-700 hover:border-bch-500/60 rounded px-1.5 py-0.5"
        >
          {copiedId === id ? '✓ copied' : 'copy'}
        </button>
      </div>

      {notes.length > 0 && (
        <div className="text-[11px] text-ash-300 mb-2 space-y-1" data-testid="idea-notes">
          {notes.map((n, i) => (
            <div key={i} className="border-l border-ink-700 pl-2">
              <span className="text-ash-500 mr-1">[{n.author || '?'}]</span>
              <span>{n.body}</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 mt-2">
        {canWrite && isPending && (
          <ActionButton
            tone="approve"
            busy={busy}
            onClick={() => onAction(idea, 'approved')}
            testid="approve-btn"
          >
            ✓ Approve
          </ActionButton>
        )}
        {canWrite && isPending && (
          <ActionButton
            tone="reject"
            busy={busy}
            onClick={() => onAction(idea, 'rejected')}
            testid="reject-btn"
          >
            ✕ Reject
          </ActionButton>
        )}
        {canWrite && (isApproved || isRejected) && (
          <ActionButton
            tone="neutral"
            busy={busy}
            onClick={() => onAction(idea, 'pending')}
            testid="reset-btn"
          >
            ↺ Reset to pending
          </ActionButton>
        )}
        {canWrite && isApproved && (
          <ActionButton
            tone="neutral"
            busy={busy}
            onClick={() => onAction(idea, 'shipped')}
            testid="mark-shipped-btn"
          >
            ✓ Mark shipped
          </ActionButton>
        )}
        {canWrite && !isShipped && (
          <button
            type="button"
            onClick={() => setShowNote((s) => !s)}
            disabled={busy}
            data-testid="toggle-note-btn"
            className="px-2 py-1 text-[10px] font-mono uppercase tracking-wider rounded border border-ink-600 text-ash-200 hover:bg-ink-800 disabled:opacity-50"
          >
            {showNote ? '× cancel' : '+ note'}
          </button>
        )}
      </div>

      {canWrite && showNote && !isShipped && (
        <div className="mt-2 flex gap-2" data-testid="note-input-row">
          <input
            type="text"
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            placeholder="Add a note (visible in audit)"
            disabled={busy}
            data-testid="note-input"
            className="flex-1 bg-ink-950 border border-ink-700 rounded px-2 py-1 text-xs text-ash-100 placeholder:text-ash-500 focus:outline-none focus:border-bch-500"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && noteDraft.trim().length > 0 && !busy) {
                onAddNote(idea, noteDraft);
                setNoteDraft('');
                setShowNote(false);
              }
            }}
          />
          <button
            type="button"
            disabled={busy || noteDraft.trim().length === 0}
            onClick={() => {
              onAddNote(idea, noteDraft);
              setNoteDraft('');
              setShowNote(false);
            }}
            data-testid="note-submit"
            className="px-2 py-1 text-[10px] font-mono uppercase tracking-wider rounded border border-bch-500/60 text-bch-300 hover:bg-bch-500/10 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            save
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Small action button with consistent tone styling. Pure render.
 */
function ActionButton(props) {
  const { tone, busy, onClick, children, testid } = props;
  const toneClass =
    tone === 'approve' ? 'border-pnl-pos/60 text-pnl-pos hover:bg-pnl-pos/10'
    : tone === 'reject' ? 'border-pnl-neg/60 text-pnl-neg hover:bg-pnl-neg/10'
    : 'border-ink-600 text-ash-200 hover:bg-ink-800';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      data-testid={testid}
      className={
        `px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider rounded border transition-colors ` +
        toneClass +
        ' disabled:opacity-50 disabled:cursor-not-allowed'
      }
    >
      {children}
    </button>
  );
}

/**
 * Tiny labeled form field. Pure render. Keeps the create form
 * visually consistent with the rest of the dashboard.
 */
function Field(props) {
  const { label, children } = props;
  return (
    <div className="block">
      <label className="block text-[10px] font-mono uppercase tracking-wider text-ash-400 mb-1">{label}</label>
      {children}
    </div>
  );
}