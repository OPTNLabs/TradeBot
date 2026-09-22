#!/usr/bin/env node
// src/feature-ideas/routes.mjs
//
// HTTP route handlers for the feature-ideas dashboard tab.
// Mirrors the shape used by src/dashboard/server.mjs (one entry
// per route, with `method`, `path`, `pattern`, `paramNames`,
// `auth`, and `handler`).
//
// All five routes live behind the same `featureIdeasStore` so
// the dashboard can render and act on the same view the cron
// populates.

import { appendApprovedIdeaToTodo } from './supervisor-bridge.mjs';
import {
  FEATURE_IDEAS_CATEGORIES,
  FEATURE_IDEAS_EFFORTS,
  FEATURE_IDEAS_IMPACTS,
  validateIdea,
} from './schema.mjs';

/**
 * Build the route list. `featureIdeasStore` is the
 * `FeatureIdeasStore` instance; `todoPath` is the path to the
 * supervisor's TODO.md (used by the approve endpoint). Both are
 * required.
 *
 * @param {{ featureIdeasStore: import('./store.mjs').FeatureIdeasStore, todoPath: string, logger?: Object }} opts
 * @returns {Array<Object>}
 */
export function buildFeatureIdeaRoutes(opts) {
  if (!opts || !opts.featureIdeasStore) {
    throw new Error('buildFeatureIdeaRoutes: featureIdeasStore required');
  }
  if (typeof opts.todoPath !== 'string' || opts.todoPath.length === 0) {
    throw new Error('buildFeatureIdeaRoutes: todoPath required');
  }
  const store = opts.featureIdeasStore;
  const todoPath = opts.todoPath;
  const logger = opts.logger ?? null;

  /**
   * Helper: list ideas, with optional query-string filters.
   */
  async function listIdeas(_ctx, _params, url) {
    const file = await store.load();
    const status = url.searchParams.get('status');
    const category = url.searchParams.get('category');
    let ideas = file.ideas;
    if (status) ideas = ideas.filter((i) => i.status === status);
    if (category) ideas = ideas.filter((i) => i.category === category);
    return { ideas: Array.from(ideas), meta: file.meta };
  }

  /**
   * Helper: fetch a single idea.
   */
  async function getIdea(_ctx, params) {
    const idea = await store.findById(params.ideaId);
    if (!idea) {
      const err = new Error(`feature-idea ${params.ideaId} not found`);
      // @ts-ignore
      err.statusCode = 404;
      throw err;
    }
    return idea;
  }

  /**
   * Helper: approve (or reject, or any status flip) an idea.
   * POST `/api/feature-ideas/:ideaId/status` body:
   *   { "status": "approved"|"rejected"|"shipped", "shipped_in": "<sha>"? }
   * Side-effect on `approved`: appends a TODO entry to the
   * supervisor's TODO.md so it picks the work up on its next tick.
   */
  async function updateStatus(_ctx, params, _url, body) {
    const newStatus = body && typeof body.status === 'string' ? body.status : null;
    if (!['pending', 'approved', 'rejected', 'shipped'].includes(/** @type {string} */ (newStatus))) {
      const err = new Error('updateStatus: status must be one of pending|approved|rejected|shipped');
      // @ts-ignore
      err.statusCode = 400;
      throw err;
    }
    const ideaBefore = await store.findById(params.ideaId);
    if (!ideaBefore) {
      const err = new Error(`feature-idea ${params.ideaId} not found`);
      // @ts-ignore
      err.statusCode = 404;
      throw err;
    }
    const shippedIn = body && typeof body.shipped_in === 'string' ? body.shipped_in : null;
    const file = await store.updateStatus(params.ideaId, /** @type {any} */ (newStatus), { shipped_in: shippedIn });
    let todoResult = null;
    if (newStatus === 'approved' && ideaBefore.status === 'pending') {
      // Append a TODO entry so the supervisor picks it up.
      const updated = file.ideas.find((i) => i.id === params.ideaId);
      if (updated) {
        try {
          const r = await appendApprovedIdeaToTodo({ todoPath, idea: updated });
          todoResult = { appended: true, todoId: r.todoId, todoPath };
          if (logger) logger.info('feature-ideas.approve.todo-appended', {
            idea_id: params.ideaId, todo_id: `T${String(r.todoId).padStart(2, '0')}`,
          });
        } catch (e) {
          if (logger) logger.error('feature-ideas.approve.todo-append-failed', {
            idea_id: params.ideaId,
            err_name: e?.name ?? 'Error',
            err_message: e?.message ?? String(e),
          });
          todoResult = { appended: false, error: e?.message ?? String(e) };
        }
      }
    }
    return {
      idea: file.ideas.find((i) => i.id === params.ideaId),
      meta: file.meta,
      todo: todoResult,
    };
  }

  /**
   * Helper: append a note to an idea. POST
   * `/api/feature-ideas/:ideaId/notes` body: { "body": "...", "author": "..." }
   * `author` defaults to `"operator"`; `ts` defaults to now.
   */
  async function addNote(_ctx, params, _url, body) {
    const noteBody = body && typeof body.body === 'string' ? body.body : '';
    if (noteBody.length === 0) {
      const err = new Error('addNote: body must be a non-empty string');
      // @ts-ignore
      err.statusCode = 400;
      throw err;
    }
    const author = (body && typeof body.author === 'string') ? body.author : 'operator';
    const ts = (body && typeof body.ts === 'string') ? body.ts : new Date().toISOString();
    try {
      const file = await store.addNote(params.ideaId, { body: noteBody, author, ts });
      return { idea: file.ideas.find((i) => i.id === params.ideaId), meta: file.meta };
    } catch (e) {
      // @ts-ignore
      if (e?.code === 'IDEA_NOT_FOUND') {
        // @ts-ignore
        const err = new Error(`feature-idea ${params.ideaId} not found`);
        // @ts-ignore
        err.statusCode = 404;
        throw err;
      }
      throw e;
    }
  }

  /**
   * Helper: read the current meta (counters + last_research_at).
   * Useful for the dashboard header / "since last research" widget.
   */
  async function getMeta(_ctx) {
    return await store.meta();
  }

  /**
   * Helper: create a new idea from operator input. POST `/api/feature-ideas`
   * body: { title, category, rationale, evidence?, effort, impact, category_tags? }.
   * The store generates the id (`idea_operator_<slug>_<YYYYMMDD>`), stamps
   * `source: 'operator'`, status: 'pending', and timestamps. Idempotent on
   * collision: the slug is suffixed with `-N` so re-submitting the same
   * draft produces a fresh idea each time.
   */
  async function createIdea(_ctx, _params, _url, body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      const err = new Error('createIdea: body must be a JSON object');
      // @ts-ignore
      err.statusCode = 400;
      throw err;
    }
    // Validate each required field before touching the store so the
    // caller gets the most actionable error message possible.
    const errs = [];
    if (typeof body.title !== 'string' || body.title.trim().length === 0) {
      errs.push('title must be a non-empty string');
    }
    if (typeof body.category !== 'string' || !FEATURE_IDEAS_CATEGORIES.includes(body.category)) {
      errs.push(`category must be one of ${FEATURE_IDEAS_CATEGORIES.join(', ')}`);
    }
    if (typeof body.rationale !== 'string' || body.rationale.trim().length === 0) {
      errs.push('rationale must be a non-empty string');
    }
    if (body.evidence !== undefined && typeof body.evidence !== 'string') {
      errs.push('evidence must be a string when provided');
    }
    if (typeof body.effort !== 'string' || !FEATURE_IDEAS_EFFORTS.includes(body.effort)) {
      errs.push(`effort must be one of ${FEATURE_IDEAS_EFFORTS.join(', ')}`);
    }
    if (typeof body.impact !== 'string' || !FEATURE_IDEAS_IMPACTS.includes(body.impact)) {
      errs.push(`impact must be one of ${FEATURE_IDEAS_IMPACTS.join(', ')}`);
    }
    if (body.category_tags !== undefined && !Array.isArray(body.category_tags)) {
      errs.push('category_tags must be an array of strings when provided');
    } else if (Array.isArray(body.category_tags)) {
      for (const t of body.category_tags) {
        if (typeof t !== 'string') {
          errs.push('each category_tags entry must be a string');
          break;
        }
      }
    }
    if (errs.length > 0) {
      const err = new Error(`createIdea: ${errs.join('; ')}`);
      // @ts-ignore
      err.statusCode = 400;
      throw err;
    }

    const result = await store.addOperatorIdea({
      title: body.title.trim(),
      category: body.category,
      rationale: body.rationale.trim(),
      evidence: typeof body.evidence === 'string' ? body.evidence : '',
      effort: body.effort,
      impact: body.impact,
      category_tags: Array.isArray(body.category_tags) ? body.category_tags : [],
    });

    if (logger) logger.info('feature-ideas.create', {
      idea_id: result.idea.id,
      id_was_collision: result.id_was_collision,
      title: result.idea.title.slice(0, 80),
      category: result.idea.category,
      effort: result.idea.effort,
      impact: result.idea.impact,
    });
    return { idea: result.idea, meta: result.file.meta, id_was_collision: result.id_was_collision };
  }

  return [
    {
      method: 'GET',
      path: '/api/feature-ideas',
      pattern: /^\/api\/feature-ideas\/?$/,
      paramNames: [],
      auth: false,
      handler: listIdeas,
    },
    {
      method: 'GET',
      path: '/api/feature-ideas/meta',
      pattern: /^\/api\/feature-ideas\/meta\/?$/,
      paramNames: [],
      auth: false,
      handler: getMeta,
    },
    {
      method: 'GET',
      path: '/api/feature-ideas/:ideaId',
      pattern: /^\/api\/feature-ideas\/([A-Za-z0-9_-]+)\/?$/,
      paramNames: ['ideaId'],
      auth: false,
      handler: getIdea,
    },
    {
      method: 'POST',
      path: '/api/feature-ideas/:ideaId/status',
      pattern: /^\/api\/feature-ideas\/([A-Za-z0-9_-]+)\/status\/?$/,
      paramNames: ['ideaId'],
      // Approval is a write; gate behind the same bearer token as
      // the rest of the dashboard's write endpoints. The dashboard
      // reads are still public — useful for the operator looking
      // at the ideas list from any device.
      auth: true,
      handler: updateStatus,
    },
    {
      method: 'POST',
      path: '/api/feature-ideas/:ideaId/notes',
      pattern: /^\/api\/feature-ideas\/([A-Za-z0-9_-]+)\/notes\/?$/,
      paramNames: ['ideaId'],
      auth: true,
      handler: addNote,
    },
    {
      method: 'POST',
      path: '/api/feature-ideas',
      // Matches the bare /api/feature-ideas POST. The route list is
      // matched top-to-bottom; this entry MUST come BEFORE the
      // GET /:ideaId entry (which would otherwise try to match an
      // empty `ideaId`). Position in the list IS the source of
      // truth for routing order.
      pattern: /^\/api\/feature-ideas\/?$/,
      paramNames: [],
      // Operator-create is a write; gate behind the bearer token
      // alongside status updates and notes. The proposals list and
      // meta endpoint stay public so the operator can preview
      // what's there from any device.
      auth: true,
      handler: createIdea,
    },
  ];
}

/**
 * Wrap the server-side handler errors into HTTP responses with
 * the right status code. The dashboard server treats thrown Errors
 * as 500 unless they carry a numeric `.statusCode` field. This
 * helper is called by the dashboard's request dispatcher when it
 * sees a `.statusCode` on the thrown Error.
 *
 * (This is just a doc — the actual statusCode honoring is handled
 * in src/dashboard/server.mjs. If the server doesn't already read
 * `.statusCode`, the FeatureIdeasStore calls just need a wrapper.)
 */
export function routeStatusCodeFromError(e) {
  // @ts-ignore
  return (e && typeof e.statusCode === 'number') ? /** @type {number} */ (e.statusCode) : null;
}
