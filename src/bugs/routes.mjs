#!/usr/bin/env node
// src/bugs/routes.mjs
//
// HTTP route handlers for the bugs dashboard tab. Mirrors
// `src/feature-ideas/routes.mjs` so the dashboard server's route
// registration is uniform across tabs.
//
// Routes:
//   GET    /api/bugs                       list (filterable by status/category/severity)
//   GET    /api/bugs/meta                  counters + next/highest priority
//   GET    /api/bugs/:bugId                single bug (404 on missing)
//   POST   /api/bugs                       create (auth) — body: {title, description, category?, severity?, author?}
//   POST   /api/bugs/:bugId/status         flip status (auth) — body: {status, shipped_in?}
//   POST   /api/bugs/:bugId/reorder        move priority (auth) — body: {new_priority: number}
//   POST   /api/bugs/:bugId/notes          append a note (auth) — body: {author, body}
//   DELETE /api/bugs/:bugId               permanently remove (auth)
//
// Auth: routes marked `auth: true` are gated by the dashboard
// server (which enforces the api_token match BEFORE invoking the
// handler — see server.mjs#handler for the auth gate). Mutating
// routes trust that gate; they don't re-check.

import {
  BUGS_CATEGORIES,
  BUGS_SEVERITIES,
  BUGS_STATUSES,
} from './schema.mjs';

/**
 * Build the route list. `bugsStore` is the `BugsStore` instance.
 * `logger` is optional.
 *
 * @param {{
 *   bugsStore: import('./store.mjs').BugsStore,
 *   logger?: Object,
 * }} opts
 * @returns {Array<Object>}
 */
export function buildBugRoutes(opts) {
  if (!opts || !opts.bugsStore) {
    throw new Error('buildBugRoutes: bugsStore required');
  }
  const store = opts.bugsStore;
  const logger = opts.logger ?? null;

  /**
   * List bugs with optional filters. Read-only; no auth required.
   * Filters compose with AND.
   */
  async function listBugs(_ctx, _params, url) {
    const status = url.searchParams.get('status');
    const category = url.searchParams.get('category');
    const severity = url.searchParams.get('severity');
    return await store.list({
      ...(status ? { status } : {}),
      ...(category ? { category } : {}),
      ...(severity ? { severity } : {}),
    });
  }

  /**
   * Counters + next/highest priority. Read-only.
   */
  async function getMeta(_ctx) {
    const file = await store.load();
    return file.meta;
  }

  /**
   * Single bug. 404 on missing.
   */
  async function getBug(_ctx, params) {
    const bug = await store.findById(params.bugId);
    if (!bug) {
      const e = new Error(`bug ${params.bugId} not found`);
      e.statusCode = 404;
      throw e;
    }
    return bug;
  }

  /**
   * Operator-create flow. Body:
   *   { title, description, category?, severity?, author? }
   * Returns the persisted bug + the auto-assigned priority.
   */
  async function createBug(_ctx, _params, _url, body) {
    if (!body || typeof body !== 'object') {
      const e = new Error('createBug: body required');
      e.statusCode = 400;
      throw e;
    }
    const title = (typeof body.title === 'string') ? body.title.trim() : '';
    const description = (typeof body.description === 'string') ? body.description.trim() : '';
    if (title.length === 0) {
      const e = new Error('createBug: title required');
      e.statusCode = 400;
      throw e;
    }
    if (description.length === 0) {
      const e = new Error('createBug: description required');
      e.statusCode = 400;
      throw e;
    }
    if (typeof body.category === 'string' && !BUGS_CATEGORIES.includes(body.category)) {
      const e = new Error(`createBug: category must be one of ${BUGS_CATEGORIES.join('|')}`);
      e.statusCode = 400;
      throw e;
    }
    if (typeof body.severity === 'string' && !BUGS_SEVERITIES.includes(body.severity)) {
      const e = new Error(`createBug: severity must be one of ${BUGS_SEVERITIES.join('|')}`);
      e.statusCode = 400;
      throw e;
    }
    const bug = await store.addOperatorBug({
      title,
      description,
      category: body.category,
      severity: body.severity,
      author: body.author,
    });
    if (logger) {
      logger.info('bugs.create', { bug_id: bug.id, priority: bug.priority });
    }
    return bug;
  }

  /**
   * Flip a bug's status. Body: { status, shipped_in?, author? }
   * The supervisor uses this to mark a bug `in_progress` /
   * `shipped` / `wontfix`.
   */
  async function updateStatus(_ctx, params, _url, body) {
    const newStatus = body && typeof body.status === 'string' ? body.status : null;
    if (!BUGS_STATUSES.includes(/** @type {string} */ (newStatus))) {
      const e = new Error(`updateStatus: status must be one of ${BUGS_STATUSES.join('|')}`);
      e.statusCode = 400;
      throw e;
    }
    const updated = await store.updateStatus(params.bugId, /** @type {any} */ (newStatus), {
      ...(body && typeof body.shipped_in === 'string' ? { shipped_in: body.shipped_in } : {}),
      ...(body && typeof body.author === 'string' ? { author: body.author } : {}),
    });
    if (logger) {
      logger.info('bugs.status.update', { bug_id: updated.id, status: updated.status });
    }
    return updated;
  }

  /**
   * Move a bug to a new priority slot. Body: { new_priority:
   * number, author?: string }. Auth-gated.
   */
  async function reorderBug(_ctx, params, _url, body) {
    if (!body || typeof body !== 'object') {
      const e = new Error('reorder: body required');
      e.statusCode = 400;
      throw e;
    }
    if (!Number.isInteger(body.new_priority)) {
      const e = new Error('reorder: new_priority must be an integer');
      e.statusCode = 400;
      throw e;
    }
    const updated = await store.reorder(params.bugId, body.new_priority);
    if (logger) {
      logger.info('bugs.reorder', { bug_id: updated.id, new_priority: updated.priority });
    }
    return updated;
  }

  /**
   * Append a note. Body: { author, body }. Auth-gated.
   *
   * Validation mirrors `BugsStore.addNote`: rejects missing OR
   * whitespace-only author/body. Whitespace-only bodies are a
   * common operator typo (hit-Enter, then submit) and would
   * otherwise slip past the type-check guard and surface as an
   * opaque 500 from the store.
   */
  async function addNote(_ctx, params, _url, body) {
    if (
      !body ||
      typeof body.author !== 'string' ||
      typeof body.body !== 'string' ||
      body.author.trim().length === 0 ||
      body.body.trim().length === 0
    ) {
      const e = new Error('addNote: {author, body} required (non-empty)');
      e.statusCode = 400;
      throw e;
    }
    const updated = await store.addNote(params.bugId, {
      author: body.author.trim(),
      body: body.body.trim(),
    });
    if (logger) {
      logger.info('bugs.note', { bug_id: updated.id, author: body.author });
    }
    return updated;
  }

  /**
   * Permanently delete a bug. Auth-gated; the operator should
   * prefer `shipped` / `wontfix` for normal lifecycle.
   */
  async function deleteBug(_ctx, params) {
    const result = await store.deleteBug(params.bugId);
    if (!result.deleted) {
      const e = new Error(`deleteBug: bug ${params.bugId} not found`);
      e.statusCode = 404;
      throw e;
    }
    if (logger) {
      logger.info('bugs.delete', { bug_id: params.bugId });
    }
    return result;
  }

  // Route table — mirrors the feature-ideas routes shape so the
  // server.mjs route-registration loop is uniform.
  return [
    { method: 'GET',    path: '/api/bugs',                   pattern: /^\/api\/bugs\/?$/,                    paramNames: [],                                                  auth: false, handler: listBugs },
    { method: 'GET',    path: '/api/bugs/meta',              pattern: /^\/api\/bugs\/meta\/?$/,               paramNames: [],                                                  auth: false, handler: getMeta },
    { method: 'GET',    path: '/api/bugs/:bugId',            pattern: /^\/api\/bugs\/([^/]+)\/?$/,            paramNames: ['bugId'],                                           auth: false, handler: getBug },
    { method: 'POST',   path: '/api/bugs',                   pattern: /^\/api\/bugs\/?$/,                    paramNames: [],                                                  auth: true,  handler: createBug },
    { method: 'POST',   path: '/api/bugs/:bugId/status',     pattern: /^\/api\/bugs\/([^/]+)\/status\/?$/,    paramNames: ['bugId'],                                           auth: true,  handler: updateStatus },
    { method: 'POST',   path: '/api/bugs/:bugId/reorder',    pattern: /^\/api\/bugs\/([^/]+)\/reorder\/?$/,   paramNames: ['bugId'],                                           auth: true,  handler: reorderBug },
    { method: 'POST',   path: '/api/bugs/:bugId/notes',      pattern: /^\/api\/bugs\/([^/]+)\/notes\/?$/,     paramNames: ['bugId'],                                           auth: true,  handler: addNote },
    { method: 'DELETE', path: '/api/bugs/:bugId',            pattern: /^\/api\/bugs\/([^/]+)\/?$/,            paramNames: ['bugId'],                                           auth: true,  handler: deleteBug },
  ];
}
