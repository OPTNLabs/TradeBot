#!/usr/bin/env node
// src/feature-ideas/schema.mjs
//
// Pure schema + validators for the feature-ideas store. Kept
// separate from `store.mjs` so the validators can be unit-tested
// without spinning up any I/O.
//
// Schema version: 1.
//   {
//     "version": 1,
//     "ideas": [
//       {
//         "id": "idea_<ulid>",
//         "title": "human-readable title",
//         "category": "edge-case-protection" | "decision-logic" | "dashboard" | "observability" | "performance",
//         "rationale": "why this matters (1-3 sentences)",
//         "evidence": "concrete example(s) from this codebase",
//         "effort": "S" | "M" | "L",
//         "impact": "low" | "medium" | "high",
//         "source": "research-cron" | "operator" | "supervisor",
//         "status": "pending" | "approved" | "rejected" | "shipped",
//         "created_at": "ISO 8601 UTC",
//         "updated_at": "ISO 8601 UTC",
//         "notes": [{ "ts": "...", "author": "...", "body": "..." }],
//         "category_tags": ["..."],
//         "shipped_in": null | "commit SHA"  // set when status flips to shipped
//       },
//       ...
//     ],
//     "meta": {
//       "total_count": 1,
//       "pending_count": 1,
//       "approved_count": 0,
//       "shipped_count": 0,
//       "rejected_count": 0,
//       "last_research_at": "ISO 8601 UTC" | null
//     }
//   }

export const FEATURE_IDEAS_VERSION = 1;

export const FEATURE_IDEAS_CATEGORIES = Object.freeze([
  'edge-case-protection',
  'decision-logic',
  'dashboard',
  'observability',
  'performance',
]);

export const FEATURE_IDEAS_EFFORTS = Object.freeze(['S', 'M', 'L']);
export const FEATURE_IDEAS_IMPACTS = Object.freeze(['low', 'medium', 'high']);
export const FEATURE_IDEAS_STATUSES = Object.freeze(['pending', 'approved', 'rejected', 'shipped']);

/**
 * Build a URL-safe slug from a free-text title. Lowercases,
 * strips diacritics, replaces every non-alphanumeric ASCII char
 * with `-`, collapses runs of `-`, and trims leading/trailing
 * `-`. Pure. Exported so the operator-create flow can preview
 * the generated id without doing I/O.
 *
 * Examples:
 *   slugify('Pre-flight: reject entry when indexer price is wildly divergent')
 *     → 'pre-flight-reject-entry-when-indexer-price-is-wildly-divergent'
 *   slugify('Dashboard P&L Over Time')
 *     → 'dashboard-p-nl-over-time'    (the & gets dropped, not replaced)
 *   slugify('  Spaces —  + weird chars?! ')
 *     → 'spaces-weird-chars'
 *   slugify('!!!')
 *     → 'idea'  (placeholder for titles that strip to nothing)
 *
 * @param {string} title
 * @returns {string}
 */
export function slugify(title) {
  if (typeof title !== 'string') return '';
  // Decompose Unicode + drop combining marks (e.g. Café → Cafe).
  const stripped = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
  const slug = stripped
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug;
}

/**
 * Build an operator-created idea id: `idea_operator_<slug>_<YYYYMMDD>`.
 * On collision the caller is expected to suffix `-1`, `-2`, etc.
 * Pure. Exported for tests.
 *
 * @param {string} title              free-text idea title
 * @param {Date} [now]                injected clock for tests
 * @returns {string}
 */
export function operatorIdeaIdForTitle(title, now = new Date()) {
  const slug = slugify(title) || 'idea';
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `idea_operator_${slug}_${y}${m}${d}`;
}

/**
 * Validate + coerce an idea object. Throws on missing/invalid
 * fields; returns a frozen object on success.
 *
 * @param {unknown} raw
 * @returns {Object}
 */
export function validateIdea(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('validateIdea: idea must be an object');
  }
  const o = /** @type {Record<string, unknown>} */ (raw);
  if (typeof o.id !== 'string' || o.id.length === 0) {
    throw new Error('validateIdea: id must be a non-empty string');
  }
  if (typeof o.title !== 'string' || o.title.length === 0) {
    throw new Error('validateIdea: title must be a non-empty string');
  }
  if (typeof o.category !== 'string' || !FEATURE_IDEAS_CATEGORIES.includes(/** @type {string} */ (o.category))) {
    throw new Error(`validateIdea: category must be one of ${FEATURE_IDEAS_CATEGORIES.join(', ')}`);
  }
  if (typeof o.rationale !== 'string' || o.rationale.length === 0) {
    throw new Error('validateIdea: rationale must be a non-empty string');
  }
  if (typeof o.evidence !== 'string') {
    throw new Error('validateIdea: evidence must be a string');
  }
  if (typeof o.effort !== 'string' || !FEATURE_IDEAS_EFFORTS.includes(/** @type {string} */ (o.effort))) {
    throw new Error(`validateIdea: effort must be one of ${FEATURE_IDEAS_EFFORTS.join(', ')}`);
  }
  if (typeof o.impact !== 'string' || !FEATURE_IDEAS_IMPACTS.includes(/** @type {string} */ (o.impact))) {
    throw new Error(`validateIdea: impact must be one of ${FEATURE_IDEAS_IMPACTS.join(', ')}`);
  }
  if (!FEATURE_IDEAS_STATUSES.includes(/** @type {string} */ (o.status))) {
    throw new Error(`validateIdea: status must be one of ${FEATURE_IDEAS_STATUSES.join(', ')}`);
  }
  if (typeof o.created_at !== 'string' || o.created_at.length === 0) {
    throw new Error('validateIdea: created_at must be a non-empty ISO 8601 string');
  }
  if (typeof o.updated_at !== 'string' || o.updated_at.length === 0) {
    throw new Error('validateIdea: updated_at must be a non-empty ISO 8601 string');
  }
  if (!Array.isArray(o.notes)) {
    throw new Error('validateIdea: notes must be an array');
  }
  for (const note of o.notes) {
    if (!note || typeof note !== 'object') {
      throw new Error('validateIdea: each note must be an object');
    }
    // Forward-compat: accept `created_at` as alias for `ts` when
    // `ts` is missing/non-string. The supervisor's auto-stamp path
    // historically used both shapes; this keeps existing data
    // valid and prevents the Proposals tab from 500-ing when a
    // future stamp slips through with the legacy shape (mirrors
    // the `body`/`message` alias below). 2026-09-20 fixup: a
    // supervisor stamp on T78 subset 1 wrote `created_at` only,
    // which broke GET /api/feature-ideas with "note.ts must be a
    // string". The backfill + this alias makes the schema tolerant
    // of both without silently corrupting future writes.
    if (typeof note.ts !== 'string') {
      if (typeof note.created_at === 'string' && note.created_at.length > 0) {
        note.ts = note.created_at;
      } else {
        throw new Error('validateIdea: note.ts must be a string');
      }
    }
    // Forward-compat: accept any missing string field on a note
    // (author / body) and backfill it with a sentinel rather than
    // blowing up the entire Proposals tab on a single malformed
    // supervisor stamp. 2026-09-20 fixup: a T78 subset 1 stamp
    // wrote `created_at` + `body` but no `author`, which crashed
    // the schema validator and rendered the Proposals page as
    // "Could not load data." The aliases above keep the schema
    // strict on shape but tolerant on field naming; this fallback
    // covers the rarer "field completely missing" case so a single
    // bad stamp doesn't take the whole tab down. The sentinel
    // values are flagged in the UI (operator can edit/repair).
    if (typeof note.author !== 'string' || note.author.trim() === '') {
      note.author = 'unknown-author';
    }
    // Forward-compat: accept `message` as alias for `body` when
    // `body` is missing/non-string. The supervisor's auto-stamp path
    // (see T70 supervisor note) historically wrote `message`; this
    // keeps existing data valid and prevents the Proposals tab from
    // 500-ing when a future stamp slips through with the legacy shape.
    if (typeof note.body !== 'string') {
      if (typeof note.message === 'string' && note.message.length > 0) {
        note.body = note.message;
      } else {
        throw new Error('validateIdea: note.body must be a string');
      }
    }
  }
  if (!Array.isArray(o.category_tags)) {
    throw new Error('validateIdea: category_tags must be an array');
  }
  if (o.shipped_in !== null && o.shipped_in !== undefined && typeof o.shipped_in !== 'string') {
    throw new Error('validateIdea: shipped_in must be null or a string');
  }
  return Object.freeze({
    id: o.id,
    title: o.title,
    category: o.category,
    rationale: o.rationale,
    evidence: o.evidence,
    effort: o.effort,
    impact: o.impact,
    source: typeof o.source === 'string' ? o.source : 'operator',
    status: o.status,
    created_at: o.created_at,
    updated_at: o.updated_at,
    notes: Object.freeze(o.notes.map((n) => Object.freeze({ ...n }))),
    category_tags: Object.freeze([...o.category_tags]),
    shipped_in: o.shipped_in ?? null,
  });
}

/**
 * Validate the whole file shape. Returns a normalized object.
 *
 * @param {unknown} raw
 * @returns {{
 *   version: number,
 *   ideas: Array<Object>,
 *   meta: {
 *     total_count: number,
 *     pending_count: number,
 *     approved_count: number,
 *     shipped_count: number,
 *     rejected_count: number,
 *     last_research_at: string|null,
 *   }
 * }}
 */
export function validateFeatureIdeasFile(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('validateFeatureIdeasFile: file must be an object');
  }
  const o = /** @type {Record<string, unknown>} */ (raw);
  if (o.version !== FEATURE_IDEAS_VERSION) {
    throw new Error(`validateFeatureIdeasFile: version must be ${FEATURE_IDEAS_VERSION}, got ${o.version}`);
  }
  if (!Array.isArray(o.ideas)) {
    throw new Error('validateFeatureIdeasFile: ideas must be an array');
  }
  const ideas = o.ideas.map((i) => validateIdea(i));
  const meta = buildMeta(ideas, o.meta);
  return Object.freeze({
    version: FEATURE_IDEAS_VERSION,
    ideas: Object.freeze(ideas),
    meta: Object.freeze(meta),
  });
}

/**
 * Recompute the meta counters from the ideas array. Pure.
 *
 * @param {Array<Object>} ideas
 * @param {unknown} [storedMeta]   existing meta block (for
 *   preserved fields like `last_research_at` that don't depend
 *   on idea list contents)
 * @returns {{
 *   total_count: number,
 *   pending_count: number,
 *   approved_count: number,
 *   shipped_count: number,
 *   rejected_count: number,
 *   last_research_at: string|null,
 * }}
 */
export function buildMeta(ideas, storedMeta) {
  let pending = 0, approved = 0, shipped = 0, rejected = 0;
  for (const idea of ideas) {
    if (idea.status === 'pending') pending++;
    else if (idea.status === 'approved') approved++;
    else if (idea.status === 'shipped') shipped++;
    else if (idea.status === 'rejected') rejected++;
  }
  const lastResearchAt = (storedMeta && typeof storedMeta === 'object' && typeof /** @type {Record<string, unknown>} */ (storedMeta).last_research_at === 'string')
    ? /** @type {string} */ (/** @type {Record<string, unknown>} */ (storedMeta).last_research_at)
    : null;
  return Object.freeze({
    total_count: ideas.length,
    pending_count: pending,
    approved_count: approved,
    shipped_count: shipped,
    rejected_count: rejected,
    last_research_at: lastResearchAt,
  });
}
