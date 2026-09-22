// dashboard/src/views/Bugs.jsx
//
// T44 — BUGS view. Operator-facing CRUD on `data/bugs.json`. Bugs
// are HIGHER priority than approved proposals (the supervisor-bridge
// picks the lowest-priority open bug FIRST, then falls through to
// proposals when no bugs exist).
//
// Data sources (all read-only by default; writes need `?token=***`):
//   GET    /api/bugs                       list (filterable by status/category/severity)
//   GET    /api/bugs/meta                  counters + next/highest priority
//   GET    /api/bugs/:bugId                single bug
//   POST   /api/bugs                       create
//   POST   /api/bugs/:bugId/status         flip status
//   POST   /api/bugs/:bugId/reorder        move priority
//   POST   /api/bugs/:bugId/notes          append a note
//   DELETE /api/bugs/:bugId               permanent remove
//
// Refresh interval: 30s (shorter than Proposals because bugs are
// time-sensitive — the operator wants fresh queue state).

import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { useApi } from '../lib/api-context.jsx';
import Panel from '../components/Panel.jsx';
import ErrorState from '../components/ErrorState.jsx';
import { formatLocal, truncate } from '../lib/format.mjs';
import {
  STATUS_FILTERS,
  CATEGORY_OPTIONS,
  SEVERITY_OPTIONS,
  STATUS_LABEL,
  STATUS_DESCRIPTION,
  statusClass,
  severityClass,
  blankDraft,
  validateDraft,
  createFormCategoryOptions,
  createFormSeverityOptions,
  createBugPanelSubtitle,
  BUGS_HEADER_SUBTITLE,
  isShippedInPlaceholder,
} from './bugs-helpers.mjs';

// Form-options derived once per module. The pure helpers return fresh
// arrays on each call, so we cache at module scope to keep referential
// equality across renders (so React doesn't think every render is a
// different prop).
const FORM_CATEGORY_OPTIONS = Object.freeze(createFormCategoryOptions());
const FORM_SEVERITY_OPTIONS = Object.freeze(createFormSeverityOptions());

const REFRESH_MS = 30_000;

// ─────────────────────────────────────────────────────────────────────
//  Main view
// ─────────────────────────────────────────────────────────────────────

export default function Bugs() {
  const { api, token } = useApi();
  const canWrite = Boolean(token && token.length > 0);
  const [list, setList] = useState(null);
  const [meta, setMeta] = useState(null);
  const [err, setErr] = useState(null);
  const [filterStatus, setFilterStatus] = useState('open');
  const [filterCategory, setFilterCategory] = useState('all');
  const [filterSeverity, setFilterSeverity] = useState('all');
  const [showCreate, setShowCreate] = useState(false);
  const [draft, setDraft] = useState(blankDraft);
  const [busy, setBusy] = useState(null);
  const [actionMsg, setActionMsg] = useState(null);

  const load = useCallback(async () => {
    const params = {};
    if (filterStatus !== 'all') params.status = filterStatus;
    if (filterCategory !== 'all') params.category = filterCategory;
    if (filterSeverity !== 'all') params.severity = filterSeverity;
    try {
      // /api/bugs returns the same envelope shape as /api/feature-ideas:
      // { bugs: [...], meta: {...} }. Unwrap both halves so the rest of
      // the view can treat `list` as the bugs array and `meta` as the
      // counters object. (The earlier version stored `listR.data` (the
      // whole envelope) into `list` and then called `list.map(...)` on
      // it, which threw `TypeError: t.map is not a function` because
      // the envelope is an object, not an array. — fixed.)
      const listR = await api.bugs(params);
      if (listR.ok) {
        setList(Array.isArray(listR.data?.bugs) ? listR.data.bugs : []);
        setMeta(listR.data?.meta ?? null);
      } else {
        setErr(listR.error || 'list failed');
      }
    } catch (e) {
      setErr((e && e.message) || 'list failed');
    }
  }, [api, filterStatus, filterCategory, filterSeverity]);

  useEffect(() => {
    setErr(null);
    load();
  }, [load]);

  useEffect(() => {
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const refresh = useCallback(() => load(), [load]);

  // ── create ──
  const onCreateSubmit = useCallback(async () => {
    const errs = validateDraft(draft);
    if (errs.length > 0) {
      setActionMsg({ kind: 'err', text: errs.join('; ') });
      return;
    }
    setBusy('create');
    try {
      const r = await api.createBug({
        title: draft.title.trim(),
        description: draft.description.trim(),
        category: draft.category,
        severity: draft.severity,
        author: (draft.author || 'operator').trim() || 'operator',
      });
      if (r.ok) {
        setShowCreate(false);
        setDraft(blankDraft());
        setActionMsg({ kind: 'ok', text: `filed ${r.data.id}` });
        await refresh();
      } else {
        setActionMsg({ kind: 'err', text: r.error || 'create failed' });
      }
    } finally {
      setBusy(null);
    }
  }, [api, draft, refresh]);

  // ── reorder (up/down buttons) ──
  const onMove = useCallback(async (bug, delta) => {
    if (bug.status !== 'open' && bug.status !== 'in_progress') return;
    setBusy(`reorder:${bug.id}`);
    try {
      // Compute new_priority by stepping to the neighbour's slot.
      // The store handles the renumbering of siblings internally.
      const target = (bug.priority || 0) + delta;
      const r = await api.reorderBug(bug.id, target);
      if (r.ok) {
        setActionMsg({ kind: 'ok', text: `moved ${bug.id} → priority ${r.data.priority}` });
        await refresh();
      } else {
        setActionMsg({ kind: 'err', text: r.error || 'reorder failed' });
      }
    } finally {
      setBusy(null);
    }
  }, [api, refresh]);

  // ── status flip ──
  const onStatus = useCallback(async (bug, newStatus) => {
    setBusy(`status:${bug.id}`);
    try {
      const body = { status: newStatus };
      if (newStatus === 'shipped') {
        body.shipped_in = (window.prompt('commit SHA shipped_in (optional):') || '').trim() || undefined;
      }
      const r = await api.updateBugStatus(bug.id, body);
      if (r.ok) {
        setActionMsg({ kind: 'ok', text: `${bug.id} → ${newStatus}` });
        await refresh();
      } else {
        setActionMsg({ kind: 'err', text: r.error || 'status update failed' });
      }
    } finally {
      setBusy(null);
    }
  }, [api, refresh]);

  // ── delete ──
  const onDelete = useCallback(async (bug) => {
    if (!window.confirm(`Delete bug ${bug.id}?\nThis is permanent and removes notes too. Prefer "WONTFIX" for normal lifecycle.`)) return;
    setBusy(`delete:${bug.id}`);
    try {
      const r = await api.deleteBug(bug.id);
      if (r.ok) {
        setActionMsg({ kind: 'ok', text: `deleted ${bug.id}` });
        await refresh();
      } else {
        setActionMsg({ kind: 'err', text: r.error || 'delete failed' });
      }
    } finally {
      setBusy(null);
    }
  }, [api, refresh]);

  const draftErrs = useMemo(() => validateDraft(draft), [draft]);

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      {/* Header / queue summary */}
      <Panel
        title="BUGS"
        subtitle={BUGS_HEADER_SUBTITLE}
        right={
          <div className="text-[10px] font-mono uppercase tracking-wider text-ash-400">
            {meta ? (
              <>
                <span className="text-bch-400">{meta.open_count ?? 0}</span> open
                {' · '}
                <span>{meta.in_progress_count ?? 0}</span> in-progress
                {' · '}
                <span>{meta.shipped_count ?? 0}</span> shipped
              </>
            ) : '…'}
          </div>
        }
      >
        {err && <ErrorState error={err} onRetry={refresh} />}
        {actionMsg && (
          <div
            data-testid="action-msg"
            className={`mb-3 px-3 py-2 rounded text-xs font-mono ${
              actionMsg.kind === 'ok' ? 'bg-bch-500/10 text-bch-300 border border-bch-500/40'
                                       : 'bg-pnl-loss/10 text-pnl-loss border border-pnl-loss/40'
            }`}
          >
            {actionMsg.text}
          </div>
        )}
        {/* Filter row */}
        <div className="flex flex-wrap gap-2 mb-4">
          <FilterRow
            label="status"
            value={filterStatus}
            options={STATUS_FILTERS}
            onChange={setFilterStatus}
          />
          <FilterRow
            label="category"
            value={filterCategory}
            options={CATEGORY_OPTIONS}
            onChange={setFilterCategory}
          />
          <FilterRow
            label="severity"
            value={filterSeverity}
            options={SEVERITY_OPTIONS}
            onChange={setFilterSeverity}
          />
        </div>
        {/* List */}
        {!list ? (
          <div className="py-8 text-center text-sm text-ash-300">loading…</div>
        ) : list.length === 0 ? (
          <div className="py-8 text-center text-sm text-ash-300">
            no bugs match the current filters.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {list.map((bug) => (
              <BugCard
                key={bug.id}
                bug={bug}
                busy={busy}
                onMove={onMove}
                onStatus={onStatus}
                onDelete={onDelete}
              />
            ))}
          </div>
        )}
      </Panel>

      {/* Create form */}
      <Panel
        title={showCreate ? 'FILE A NEW BUG' : 'NEED A NEW BUG FILED?'}
        subtitle={createBugPanelSubtitle(showCreate, canWrite)}
      >
        {!showCreate ? (
          <button
            type="button"
            data-testid="open-create-btn"
            onClick={() => { setShowCreate(true); setDraft(blankDraft()); }}
            className="px-4 py-2 rounded border border-bch-500/60 text-bch-300 hover:bg-bch-500/10 font-mono uppercase tracking-wider text-xs"
          >
            + file a bug
          </button>
        ) : (
          <CreateForm
            draft={draft}
            setDraft={setDraft}
            errs={draftErrs}
            busy={busy === 'create'}
            onSubmit={onCreateSubmit}
            onCancel={() => { setShowCreate(false); setDraft(blankDraft()); }}
          />
        )}
        {/* Helpful inline notes */}
        <div className="mt-6 text-[11px] text-ash-400 space-y-1">
          <div className="uppercase font-mono tracking-wider text-ash-500 text-[10px] mb-1">priority semantics</div>
          <p>
            Each bug carries an integer priority (lower = picked first). New bugs land at
            <code className="ml-1 px-1 bg-ink-800 rounded text-ash-200">next_priority</code>
            (one less than the current lowest). Use the ↑ / ↓ buttons per card to move a bug up or
            down the queue. Shipped and wontfix bugs are immutable.
          </p>
          <div className="uppercase font-mono tracking-wider text-ash-500 text-[10px] mb-1 mt-3">how the supervisor picks</div>
          <p>
            On each tick the supervisor calls
            <code className="ml-1 px-1 bg-ink-800 rounded text-ash-200">pickNextWorkItem()</code>:
            lowest-priority OPEN bug first; if no OPEN bugs exist, fall through to the
            highest-impact approved proposal. So a flood of bugs SUPERSEDES proposals
            until they\u2019re all shipped or marked wontfix.
          </p>
        </div>
      </Panel>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
//  Sub-components
// ─────────────────────────────────────────────────────────────────────

function FilterRow(props) {
  const { label, value, options, onChange } = props;
  return (
    <label className="inline-flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-ash-400">
      <span>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-ink-900 border border-ink-700 rounded px-1.5 py-0.5 text-[11px] text-ash-100 focus:outline-none focus:border-bch-500"
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

function BugCard(props) {
  const { bug, busy, onMove, onStatus, onDelete } = props;
  const disabled = (key) => busy === key;
  const reorderable = bug.status === 'open' || bug.status === 'in_progress';
  return (
    <div
      data-testid="bug-card"
      data-bug-id={bug.id}
      className="rounded border border-ink-700 bg-ink-900/40 p-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
        <div className="text-sm font-medium text-ash-100 flex-1">{bug.title}</div>
        <div className="text-[10px] font-mono text-ash-500 flex items-center gap-2">
          <span className="px-1.5 py-0.5 rounded border text-[9px] uppercase tracking-wider" data-testid="bug-priority">
            priority {bug.priority}
          </span>
          <span
            data-testid="bug-status"
            className={`px-1.5 py-0.5 rounded border text-[9px] uppercase tracking-wider ${statusClass(bug.status)}`}
          >
            {STATUS_LABEL[bug.status]}
          </span>
          <span
            data-testid="bug-severity"
            className={`px-1.5 py-0.5 rounded border text-[9px] uppercase tracking-wider ${severityClass(bug.severity)}`}
          >
            {bug.severity}
          </span>
        </div>
      </div>
      <div className="text-[11px] text-ash-400 font-mono mb-2">{bug.id}</div>
      <p className="text-xs text-ash-200 whitespace-pre-wrap break-words mb-2">{bug.description}</p>
      <div className="text-[10px] text-ash-500 font-mono flex flex-wrap gap-x-3">
        <span>category: {bug.category}</span>
        <span>created: {formatLocal(bug.created_at)}</span>
        {bug.updated_at && bug.updated_at !== bug.created_at && (
          <span>updated: {formatLocal(bug.updated_at)}</span>
        )}
        {bug.shipped_in && (
          isShippedInPlaceholder(bug.shipped_in) ? (
            // Defensive rendering: literal placeholder strings like
            // `<pending-commit-hash>` used to render as the commit hash,
            // making shipped bugs look un-shipped. Surface them as an
            // amber warning pill instead.
            <span className="inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-amber-300">
              <span className="text-[10px] uppercase tracking-wider">shipped in:</span>
              <code className="text-[10px]">{String(bug.shipped_in)}</code>
            </span>
          ) : (
            <span>shipped in: <code className="text-ash-300">{truncate(bug.shipped_in, 12)}</code></span>
          )
        )}
      </div>
      {/* Notes */}
      {Array.isArray(bug.notes) && bug.notes.length > 0 && (
        <div className="mt-2 border-t border-ink-700 pt-2 space-y-1">
          {bug.notes.map((n, i) => (
            <div key={i} className="text-[10px] text-ash-400">
              <span className="font-mono text-ash-500">[{formatLocal(n.ts)} · {n.author}]</span>
              <span className="ml-1.5">{n.body}</span>
            </div>
          ))}
        </div>
      )}
      {/* Action bar */}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {reorderable && (
          <>
            <ActionButton onClick={() => onMove(bug, -1)} busy={disabled(`reorder:${bug.id}`)} tone="approve" testid="bug-move-up">
              ↑ up
            </ActionButton>
            <ActionButton onClick={() => onMove(bug, +1)} busy={disabled(`reorder:${bug.id}`)} testid="bug-move-down">
              ↓ down
            </ActionButton>
          </>
        )}
        {bug.status === 'open' && (
          <ActionButton onClick={() => onStatus(bug, 'in_progress')} busy={disabled(`status:${bug.id}`)} testid="bug-claim">
            claim
          </ActionButton>
        )}
        {bug.status === 'in_progress' && (
          <>
            <ActionButton onClick={() => onStatus(bug, 'shipped')} busy={disabled(`status:${bug.id}`)} tone="approve" testid="bug-ship">
              ship
            </ActionButton>
            <ActionButton onClick={() => onStatus(bug, 'open')} busy={disabled(`status:${bug.id}`)} testid="bug-reopen">
              reopen
            </ActionButton>
          </>
        )}
        {(bug.status === 'open' || bug.status === 'in_progress') && (
          <ActionButton onClick={() => onStatus(bug, 'wontfix')} busy={disabled(`status:${bug.id}`)} tone="reject" testid="bug-wontfix">
            wontfix
          </ActionButton>
        )}
        <ActionButton onClick={() => onDelete(bug)} busy={disabled(`delete:${bug.id}`)} tone="reject" testid="bug-delete">
          delete
        </ActionButton>
      </div>
      <div className="mt-1 text-[10px] text-ash-500 italic">{STATUS_DESCRIPTION[bug.status]}</div>
    </div>
  );
}

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
        `px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider rounded border transition-colors ` +
        toneClass +
        ' disabled:opacity-50 disabled:cursor-not-allowed'
      }
    >
      {children}
    </button>
  );
}

function CreateForm(props) {
  const { draft, setDraft, errs, busy, onSubmit, onCancel } = props;
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onSubmit(); }}
      className="space-y-3"
      data-testid="bug-create-form"
    >
      <FormField label="title (short, scannable)">
        <input
          type="text"
          value={draft.title}
          autoFocus
          maxLength={120}
          required
          placeholder="Cumulative P&L shows wrong total after partial close"
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          className="w-full bg-ink-950 border border-ink-700 rounded px-2 py-1 text-sm text-ash-100 focus:outline-none focus:border-bch-500"
        />
      </FormField>
      <FormField label="description (what\u2019s broken, repro, expected)">
        <textarea
          value={draft.description}
          required
          minLength={5}
          maxLength={4000}
          rows={5}
          placeholder="What you saw, what you expected, how to reproduce (commands, settings, token)."
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          className="w-full bg-ink-950 border border-ink-700 rounded px-2 py-1 text-xs text-ash-100 focus:outline-none focus:border-bch-500 font-mono"
        />
      </FormField>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="category">
          <select
            value={draft.category}
            onChange={(e) => setDraft({ ...draft, category: e.target.value })}
            className="w-full bg-ink-950 border border-ink-700 rounded px-2 py-1 text-xs text-ash-100"
          >
            {FORM_CATEGORY_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
        </FormField>
        <FormField label="severity">
          <select
            value={draft.severity}
            onChange={(e) => setDraft({ ...draft, severity: e.target.value })}
            className="w-full bg-ink-950 border border-ink-700 rounded px-2 py-1 text-xs text-ash-100"
          >
            {FORM_SEVERITY_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
        </FormField>
      </div>
      <FormField label="filed by (optional, used as the audit author for the create-note)">
        <input
          type="text"
          value={draft.author}
          maxLength={64}
          placeholder="operator"
          onChange={(e) => setDraft({ ...draft, author: e.target.value })}
          className="w-full bg-ink-950 border border-ink-700 rounded px-2 py-1 text-xs text-ash-100"
        />
      </FormField>
      {errs.length > 0 && (
        <ul className="text-[11px] text-pnl-loss list-disc pl-5">
          {errs.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      )}
      <div className="flex flex-wrap gap-2 pt-1">
        <button
          type="submit"
          disabled={busy || errs.length > 0}
          data-testid="bug-submit"
          className="px-4 py-1.5 rounded border border-bch-500/60 text-bch-300 hover:bg-bch-500/10 font-mono uppercase tracking-wider text-xs disabled:opacity-50"
        >
          {busy ? 'filing…' : 'file bug'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          data-testid="bug-cancel"
          className="px-3 py-1.5 rounded border border-ink-700 text-ash-300 hover:bg-ink-800 font-mono uppercase tracking-wider text-xs"
        >
          cancel
        </button>
      </div>
    </form>
  );
}

function FormField(props) {
  const { label, children } = props;
  return (
    <label className="block">
      <span className="block text-[10px] font-mono uppercase tracking-wider text-ash-400 mb-1">{label}</span>
      {children}
    </label>
  );
}
