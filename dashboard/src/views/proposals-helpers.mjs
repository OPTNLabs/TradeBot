#!/usr/bin/env node
// dashboard/src/views/proposals-helpers.mjs
//
// Pure helpers for the PROPOSALS view. Kept separate from the
// JSX component so they're importable from `node --test` (Node
// can't parse .jsx files without a loader). Mirrors the
// `src/lib/api.mjs` / `src/lib/api-context.jsx` split.
//
// Every helper is dependency-free and has no side effects.

/**
 * Pill color for an idea's status. Pure.
 * @param {string} status
 * @returns {string}
 */
export function statusClass(status) {
  if (status === 'approved') return 'bg-pnl-pos/15 text-pnl-pos border-pnl-pos/40';
  if (status === 'shipped')  return 'bg-bch-500/20 text-bch-300 border-bch-500/40';
  if (status === 'rejected') return 'bg-pnl-neg/15 text-pnl-neg border-pnl-neg/40';
  if (status === 'pending')  return 'bg-ink-800 text-ash-200 border-ink-600';
  return 'bg-ink-800 text-ash-300 border-ink-700';
}

/**
 * Pill color for an idea's impact rating. Pure.
 * @param {string} impact
 * @returns {string}
 */
export function impactClass(impact) {
  if (impact === 'high')   return 'bg-bch-500/15 text-bch-300 border-bch-500/30';
  if (impact === 'medium') return 'bg-ink-800 text-ash-200 border-ink-600';
  if (impact === 'low')    return 'bg-ink-800 text-ash-400 border-ink-700';
  return 'bg-ink-800 text-ash-300 border-ink-700';
}

/**
 * Human-friendly effort label. Pure.
 * @param {string|null|undefined} effort
 * @returns {string}
 */
export function effortLabel(effort) {
  if (effort === 'S') return 'small';
  if (effort === 'M') return 'medium';
  if (effort === 'L') return 'large';
  if (typeof effort === 'string' && effort.length > 0) return effort;
  return '—';
}

/**
 * Render a "5m ago"-style relative timestamp. Pure.
 * @param {string|null|undefined} iso
 * @param {number} nowMs
 * @returns {string}
 */
export function relativeTime(iso, nowMs) {
  if (typeof iso !== 'string' || iso.length === 0) return 'never';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 'never';
  const diff = nowMs - t;
  if (diff < 0) return 'in the future';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toISOString().slice(0, 10);
}

/**
 * Derive per-status filter chip counts from the meta envelope.
 *
 * The backend returns the same `meta` block on the list endpoint
 * regardless of which status / category filter is active — those
 * counts are always GLOBAL (across the entire store). So the
 * Pending# / Approved# / Rejected# / Shipped# badges must be
 * derived from `meta`, not from the already-filtered `ideas`
 * array (which would always report "0" for any non-selected
 * status, breaking the UX).
 *
 * Bug that motivated this helper: when status='pending' is
 * selected, deriving counts from `ideas.length` per status shows
 * `pending=N, approved=0, rejected=0, shipped=0` — so approving
 * a pending idea correctly drops Pending# by 1 but doesn't bump
 * Approved#. Selecting the Approved tab then resets everything
 * to 0 because the new `ideas` array contains only approved rows.
 *
 * Pure. Exported for tests + so the React component stays free of
 * magic property names.
 *
 * @param {Object|null|undefined} meta      the `meta` field from /api/feature-ideas
 * @returns {{
 *   all: number,
 *   pending: number,
 *   approved: number,
 *   rejected: number,
 *   shipped: number,
 * }}
 */
export function countsFromMeta(meta) {
  const out = { all: 0, pending: 0, approved: 0, rejected: 0, shipped: 0 };
  if (!meta || typeof meta !== 'object') return out;
  const pick = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0) ? Math.floor(v) : 0;
  out.all      = pick(meta.total_count);
  out.pending  = pick(meta.pending_count);
  out.approved = pick(meta.approved_count);
  out.rejected = pick(meta.rejected_count);
  out.shipped  = pick(meta.shipped_count);
  return out;
}

// ─────────────────────────────────────────────────────────────────────
//  Operator-create form helpers (T30+)
// ─────────────────────────────────────────────────────────────────────

/** Select options for the category dropdown on the create form. */
export const CATEGORY_OPTIONS = Object.freeze([
  Object.freeze({ value: 'edge-case-protection', label: 'edge-case protection' }),
  Object.freeze({ value: 'decision-logic',       label: 'decision logic'       }),
  Object.freeze({ value: 'dashboard',            label: 'dashboard'            }),
  Object.freeze({ value: 'observability',        label: 'observability'        }),
  Object.freeze({ value: 'performance',          label: 'performance'          }),
]);

/** Select options for the effort dropdown. */
export const EFFORT_OPTIONS = Object.freeze([
  Object.freeze({ value: 'S', label: 'S — small' }),
  Object.freeze({ value: 'M', label: 'M — medium' }),
  Object.freeze({ value: 'L', label: 'L — large' }),
]);

/** Select options for the impact dropdown. */
export const IMPACT_OPTIONS = Object.freeze([
  Object.freeze({ value: 'low',    label: 'low'    }),
  Object.freeze({ value: 'medium', label: 'medium' }),
  Object.freeze({ value: 'high',   label: 'high'   }),
]);

/**
 * Build the initial draft object for the operator-create form.
 * Pure. Exported for tests.
 *
 * @returns {{
 *   title: string,
 *   category: string,
 *   rationale: string,
 *   evidence: string,
 *   effort: 'S'|'M'|'L',
 *   impact: 'low'|'medium'|'high',
 *   category_tags_csv: string,
 * }}
 */
export function emptyOperatorDraft() {
  return {
    title: '',
    category: 'edge-case-protection',
    rationale: '',
    evidence: '',
    effort: 'M',
    impact: 'medium',
    category_tags_csv: '',
  };
}

/**
 * Client-side validation for the operator draft. Returns `{ok:true}`
 * on pass; `{ok:false, error}` with a human-readable message on
 * fail. The backend re-validates with the same rules + schema.mjs
 * `validateIdea` — this client-side pass is only there to surface
 * the most common mistakes without a network round-trip.
 *
 * Pure. Exported for tests.
 *
 * @param {ReturnType<typeof emptyOperatorDraft>|Object} draft
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateOperatorDraft(draft) {
  if (!draft || typeof draft !== 'object') {
    return { ok: false, error: 'draft must be an object' };
  }
  const t = String(draft.title ?? '').trim();
  if (t.length === 0) return { ok: false, error: 'title is required' };
  if (t.length > 200) return { ok: false, error: 'title must be ≤ 200 chars' };
  const cat = String(draft.category ?? '');
  if (!CATEGORY_OPTIONS.some((c) => c.value === cat)) {
    return { ok: false, error: `category must be one of ${CATEGORY_OPTIONS.map((c) => c.value).join(', ')}` };
  }
  const r = String(draft.rationale ?? '').trim();
  if (r.length === 0) return { ok: false, error: 'rationale is required' };
  if (!EFFORT_OPTIONS.some((e) => e.value === draft.effort)) {
    return { ok: false, error: `effort must be one of ${EFFORT_OPTIONS.map((e) => e.value).join(', ')}` };
  }
  if (!IMPACT_OPTIONS.some((i) => i.value === draft.impact)) {
    return { ok: false, error: `impact must be one of ${IMPACT_OPTIONS.map((i) => i.value).join(', ')}` };
  }
  return { ok: true };
}

/**
 * Convert a draft's `category_tags_csv` (comma-separated string typed
 * by the operator) into the array the backend expects. Empty /
 * whitespace-only entries are dropped. Pure.
 *
 * @param {Object} draft
 * @returns {string[]}
 */
export function csvToCategoryTags(draft) {
  const raw = typeof draft?.category_tags_csv === 'string' ? draft.category_tags_csv : '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}