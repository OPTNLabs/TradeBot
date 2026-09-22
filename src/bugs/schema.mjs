#!/usr/bin/env node
// src/bugs/schema.mjs
//
// Pure schema + validators for the bugs store. Mirrors
// `src/feature-ideas/schema.mjs` so a feature-ideas operator who's
// already comfortable with the proposals tab can adopt the bugs
// tab without re-learning the JSON shape.
//
// Schema version: 1.
//   {
//     "version": 1,
//     "bugs": [
//       {
//         "id": "bug_<ulid>",
//         "title": "short title (one line)",
//         "description": "what's wrong + repro + expected behaviour (1-5 sentences)",
//         "category": "ui" | "data" | "logic" | "performance" | "config" | "wallet" | "other",
//         "severity": "low" | "medium" | "high" | "critical",
//         "status":   "open" | "in_progress" | "shipped" | "wontfix",
//         "priority": 0,           // integer; LOWER = picked first by the supervisor
//         "created_at": "ISO 8601 UTC",
//         "updated_at": "ISO 8601 UTC",
//         "shipped_in": null | "commit SHA",
//         "notes": [{ "ts": "...", "author": "...", "body": "..." }]
//       },
//       ...
//     ],
//     "meta": {
//       "total_count": 0,
//       "open_count": 0,
//       "in_progress_count": 0,
//       "shipped_count": 0,
//       "wontfix_count": 0,
//       "next_priority": 0,         // lowest priority among open bugs, used as the default for new bugs
//       "highest_priority": null    // highest priority among open bugs (for the "what's next" header)
//     }
//   }

export const BUGS_VERSION = 1;

export const BUGS_CATEGORIES = Object.freeze([
  'ui',
  'data',
  'logic',
  'performance',
  'config',
  'wallet',
  'other',
]);

export const BUGS_SEVERITIES = Object.freeze(['low', 'medium', 'high', 'critical']);

export const BUGS_STATUSES = Object.freeze(['open', 'in_progress', 'shipped', 'wontfix']);

/**
 * Default severity for new bugs when the operator didn't pick one.
 * The dashboard form defaults to `medium` so an under-specified
 * bug lands in the middle of the queue, not the top.
 */
export const DEFAULT_BUG_SEVERITY = 'medium';

/**
 * Build a URL-safe slug from a free-text title. Lowercases,
 * strips diacritics, replaces every non-alphanumeric ASCII char
 * with `-`, collapses runs of `-`, and trims leading/trailing
 * `-`. Pure. Mirrors the proposals slugify so the operator's
 * mental model stays consistent across tabs.
 *
 * Examples:
 *   slugify('Cumulative P&L shows wrong total')
 *     → 'cumulative-p-l-shows-wrong-total'
 *   slugify('  Spaces —  + weird chars?! ')
 *     → 'spaces-weird-chars'
 *   slugify('!!!')
 *     → 'bug'  (placeholder)
 *
 * @param {string} title
 * @returns {string}
 */
export function slugify(title) {
  if (typeof title !== 'string') return 'bug';
  const stripped = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
  const slug = stripped
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug.length > 0 ? slug : 'bug';
}

/**
 * Build the operator-friendly bug id from a title. Pure. Format:
 * `bug_<slug>-<YYYYMMDD>` so the operator can read the timestamp
 * at a glance and the slug is human-scannable. Falls back to
 * `bug-<YYYYMMDD>` (slug defaults to `bug` when the title strips
 * to nothing).
 *
 * Examples:
 *   operatorBugIdForTitle('Cumulative P&L shows wrong total', new Date('2026-09-15'))
 *     → 'bug-cumulative-p-l-shows-wrong-total-20260915'
 *
 * @param {string} title
 * @param {Date} [now]   defaults to `new Date()`
 * @returns {string}
 */
export function operatorBugIdForTitle(title, now) {
  const d = now instanceof Date ? now : new Date();
  const yyyymmdd = [
    d.getUTCFullYear(),
    String(d.getUTCMonth() + 1).padStart(2, '0'),
    String(d.getUTCDate()).padStart(2, '0'),
  ].join('');
  return `bug-${slugify(title)}-${yyyymmdd}`;
}

/**
 * Validate a single bug. Returns the canonicalised bug (with
 * `updated_at` set to `now` if not supplied). Throws on bad
 * shape. Pure — no I/O.
 *
 * @param {Object} bug
 * @param {Date}   [now]   defaults to `new Date()`
 * @returns {Object}
 */
export function validateBug(bug, now) {
  if (!bug || typeof bug !== 'object') {
    throw new TypeError('validateBug: bug object required');
  }
  const ts = now instanceof Date ? now.toISOString() : new Date().toISOString();
  const errs = [];
  if (typeof bug.id !== 'string' || bug.id.length === 0) errs.push('id required (string)');
  if (typeof bug.title !== 'string' || bug.title.trim().length === 0) errs.push('title required');
  if (typeof bug.description !== 'string' || bug.description.trim().length === 0) errs.push('description required (non-empty string)');
  if (!BUGS_CATEGORIES.includes(bug.category)) errs.push(`category must be one of ${BUGS_CATEGORIES.join('|')}`);
  if (!BUGS_SEVERITIES.includes(bug.severity)) errs.push(`severity must be one of ${BUGS_SEVERITIES.join('|')}`);
  if (!BUGS_STATUSES.includes(bug.status)) errs.push(`status must be one of ${BUGS_STATUSES.join('|')}`);
  if (!Number.isInteger(bug.priority)) errs.push('priority must be an integer');
  if (typeof bug.created_at !== 'string' || Number.isNaN(Date.parse(bug.created_at))) errs.push('created_at must be ISO 8601');
  if (errs.length > 0) {
    const e = new Error(`validateBug: ${errs.join('; ')}`);
    e.code = 'BUG_VALIDATION';
    e.errors = errs;
    throw e;
  }
  // Coerce notes to an array of `{ts, author, body}` triples if
  // the caller supplied an array. Skip silently when missing —
  // fresh operator-create flows always start with `notes: []`.
  let notes = [];
  if (Array.isArray(bug.notes)) {
    notes = bug.notes
      .filter((n) => n && typeof n === 'object')
      .map((n) => ({
        ts: typeof n.ts === 'string' ? n.ts : ts,
        author: typeof n.author === 'string' ? n.author : 'unknown',
        body: typeof n.body === 'string' ? n.body : String(n.body ?? ''),
      }));
  }
  return Object.freeze({
    id: bug.id,
    title: bug.title.trim(),
    description: bug.description,
    category: bug.category,
    severity: bug.severity,
    status: bug.status,
    priority: bug.priority,
    created_at: bug.created_at,
    updated_at: typeof bug.updated_at === 'string' ? bug.updated_at : ts,
    shipped_in: (typeof bug.shipped_in === 'string' && bug.shipped_in.length > 0) ? bug.shipped_in : null,
    notes: Object.freeze(notes),
  });
}

/**
 * Validate a whole bugs file (the `{version, bugs, meta}` envelope).
 * Used by the store to assert on-disk shape after every read.
 * Pure.
 *
 * @param {*} obj
 * @returns {Object}  the validated file (frozen)
 */
export function validateBugsFile(obj) {
  if (!obj || typeof obj !== 'object') {
    throw new TypeError('validateBugsFile: object required');
  }
  if (obj.version !== BUGS_VERSION) {
    const e = new Error(`validateBugsFile: unsupported version ${obj.version}; expected ${BUGS_VERSION}`);
    e.code = 'BUGS_VERSION_MISMATCH';
    throw e;
  }
  if (!Array.isArray(obj.bugs)) {
    throw new TypeError('validateBugsFile: bugs must be an array');
  }
  const bugs = obj.bugs.map((b) => validateBug(b));
  const meta = buildMetaForBugs(bugs);
  return Object.freeze({ version: BUGS_VERSION, bugs: Object.freeze(bugs), meta: Object.freeze(meta) });
}

/**
 * Build the `meta` block from a list of validated bugs. Counts
 * per status, plus `next_priority` (= lowest priority among
 * OPEN bugs, used as the default for new bugs) and
 * `highest_priority` (= the highest priority that should appear
 * at the top of the operator's "next up" header).
 *
 * The "priority" semantics: the operator assigns integer values
 * to bugs; LOWER = higher priority (i.e. picked first). When the
 * operator submits a new bug, it gets `priority = next_priority`
 * (the LOWEST open value), pushing everything down. When the
 * operator moves a bug up, its priority becomes ONE LESS THAN
 * the bug above it (or 0 if it's already at the top). When they
 * move it down, ONE MORE THAN the bug below. The store never
 * auto-shrinks the gap — leaving it sparse is fine and lets the
 * operator reorder without re-numbering everything.
 *
 * Pure.
 *
 * @param {Array<Object>} bugs
 * @returns {Object}
 */
export function buildMetaForBugs(bugs) {
  const counts = { open: 0, in_progress: 0, shipped: 0, wontfix: 0 };
  let nextPriority = null;
  let highestPriority = null;
  for (const b of bugs) {
    counts[b.status] = (counts[b.status] || 0) + 1;
    if (b.status === 'open') {
      if (nextPriority === null || b.priority < nextPriority) nextPriority = b.priority;
      if (highestPriority === null || b.priority < highestPriority) highestPriority = b.priority;
    }
  }
  return {
    total_count: bugs.length,
    open_count: counts.open,
    in_progress_count: counts.in_progress,
    shipped_count: counts.shipped,
    wontfix_count: counts.wontfix,
    next_priority: nextPriority === null ? 0 : nextPriority - 1,
    highest_priority: highestPriority,
  };
}

/**
 * Compute the next default priority for a freshly-created bug.
 * One less than the current lowest-open-priority, or 0 if there
 * are no open bugs. Pure.
 *
 * @param {Array<Object>} bugs
 * @returns {number}
 */
export function nextDefaultPriority(bugs) {
  let min = null;
  for (const b of bugs) {
    if (b.status !== 'open') continue;
    if (min === null || b.priority < min) min = b.priority;
  }
  return min === null ? 0 : min - 1;
}
