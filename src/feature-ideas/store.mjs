#!/usr/bin/env node
// src/feature-ideas/store.mjs
//
// Persistent store for feature ideas. The research cron adds new
// ideas, the operator approves/rejects them from the dashboard
// tab, and approved ideas get appended to TODO.md by the same
// approve endpoint so the supervisor picks them up on its next
// tick.
//
// File format is the schema documented in `schema.mjs`. All writes
// go through `atomicWriteJson` so a crash mid-write can't corrupt
// the file (same pattern positions.mjs / snapshots.mjs use).
//
// Class API mirrors `Positions` / `Snapshots`:
//   - `new FeatureIdeasStore({file, logger})`
//   - `await store.load()`        → returns the parsed file
//   - `await store.list({...})`   → list + filter
//   - `await store.addIdea(...)`  → idempotent insert (skips if id exists)
//   - `await store.addOperatorIdea(...)`  → operator-created idea (slug id + source=operator)
//   - `await store.updateStatus(...)` → flip status
//   - `await store.addNote(...)`  → append a note

import { atomicWriteJson, readJsonFile, ensureDirForFile } from '../util/atomic-write.mjs';
import {
  FEATURE_IDEAS_VERSION,
  buildMeta,
  operatorIdeaIdForTitle,
  validateFeatureIdeasFile,
  validateIdea,
} from './schema.mjs';

/**
 * @typedef {ReturnType<typeof validateFeatureIdeasFile>} FeatureIdeasFile
 */

/**
 * Empty store — used when the on-disk file is missing.
 * @returns {FeatureIdeasFile}
 */
export function emptyFeatureIdeasFile() {
  return Object.freeze({
    version: FEATURE_IDEAS_VERSION,
    ideas: Object.freeze([]),
    meta: Object.freeze({
      total_count: 0,
      pending_count: 0,
      approved_count: 0,
      shipped_count: 0,
      rejected_count: 0,
      last_research_at: null,
    }),
  });
}

/**
 * Build a fresh `meta` block stamped with `last_research_at = now`.
 * Used by the research cron after a successful research pass.
 *
 * @param {Date} now
 * @returns {Object}
 */
export function freshResearchStamp(now) {
  return Object.freeze({
    ...emptyFeatureIdeasFile().meta,
    last_research_at: now.toISOString(),
  });
}

export class FeatureIdeasStore {
  /**
   * @param {{ file: string, logger?: { info: Function, warn: Function, error: Function } }} opts
   */
  constructor(opts) {
    if (!opts || typeof opts !== 'object') {
      throw new Error('FeatureIdeasStore: opts required');
    }
    if (typeof opts.file !== 'string' || opts.file.length === 0) {
      throw new Error('FeatureIdeasStore: opts.file required');
    }
    this.file = opts.file;
    this.logger = opts.logger ?? null;
    this._loaded = false;
    this._cache = null;
  }

  /**
   * Read the file from disk. Creates an empty file on first
   * start if missing. Caches the result for the rest of the
   * process lifetime.
   *
   * @returns {Promise<FeatureIdeasFile>}
   */
  async load() {
    if (this._loaded && this._cache !== null) return this._cache;
    await ensureDirForFile(this.file);
    let raw = null;
    try {
      raw = await readJsonFile(this.file);
    } catch (e) {
      if (e && typeof e === 'object' && /** @type {any} */ (e).code === 'ENOENT') {
        raw = null;
      } else {
        throw e;
      }
    }
    let parsed;
    if (raw === null) {
      parsed = emptyFeatureIdeasFile();
      await atomicWriteJson(this.file, /** @type {Record<string, unknown>} */ (parsed));
    } else {
      parsed = validateFeatureIdeasFile(raw);
    }
    this._cache = parsed;
    this._loaded = true;
    if (this.logger) this.logger.info('feature-ideas.load', {
      file: this.file,
      total: parsed.meta.total_count,
      pending: parsed.meta.pending_count,
      approved: parsed.meta.approved_count,
    });
    return parsed;
  }

  /**
   * Read-modify-write helper. Mutates the cached file, writes
   * atomically. Pass a mutator that returns the next file.
   *
   * @template T
   * @param {(file: FeatureIdeasFile) => FeatureIdeasFile} mutator
   * @returns {Promise<T>}
   */
  async _withFile(mutator) {
    const current = await this.load();
    const next = mutator(current);
    if (next !== current) {
      await atomicWriteJson(this.file, /** @type {Record<string, unknown>} */ (next));
      this._cache = next;
    }
    return /** @type {T} */ (next);
  }

  /**
   * List ideas, optionally filtered.
   *
   * @param {{ status?: string, category?: string }} [opts]
   * @returns {Promise<Array<Object>>}
   */
  async list(opts = {}) {
    const file = await this.load();
    let ideas = file.ideas;
    if (typeof opts.status === 'string') {
      ideas = ideas.filter((i) => i.status === opts.status);
    }
    if (typeof opts.category === 'string') {
      ideas = ideas.filter((i) => i.category === opts.category);
    }
    return Array.from(ideas);
  }

  /**
   * Look up a single idea by id.
   *
   * @param {string} id
   * @returns {Promise<Object|null>}
   */
  async findById(id) {
    const file = await this.load();
    return file.ideas.find((i) => i.id === id) ?? null;
  }

  /**
   * Append new ideas. Idempotent — ideas whose `id` already
   * exists are silently skipped (research cron re-runs are
   * safe). Returns the resulting file.
   *
   * @param {Array<Object>} ideas    already-validateIdea()'d
   * @param {{ source?: string }} [opts]
   * @returns {Promise<{ added: number, skipped: number, file: FeatureIdeasFile }>}
   */
  async addIdeas(ideas, opts = {}) {
    if (!Array.isArray(ideas)) {
      throw new Error('addIdeas: ideas must be an array');
    }
    const now = new Date();
    const source = typeof opts.source === 'string' ? opts.source : 'research-cron';
    let added = 0;
    let skipped = 0;
    const next = await this._withFile((file) => {
      const existingIds = new Set(file.ideas.map((i) => i.id));
      const toAppend = [];
      for (const raw of ideas) {
        if (existingIds.has(raw.id)) {
          skipped++;
          continue;
        }
        const stamped = {
          ...raw,
          status: 'pending',
          source,
          created_at: now.toISOString(),
          updated_at: now.toISOString(),
          notes: [],
        };
        toAppend.push(validateIdea(stamped));
        existingIds.add(raw.id);
        added++;
      }
      if (toAppend.length === 0) return file;
      const merged = Object.freeze([...file.ideas, ...toAppend]);
      const meta = Object.freeze({
        ...file.meta,
        ...buildMeta(merged, file.meta),
      });
      return Object.freeze({ version: FEATURE_IDEAS_VERSION, ideas: merged, meta });
    });
    return { added, skipped, file: next };
  }

  /**
   * Append a single operator-created idea. The store generates the
   * id from the title (`idea_operator_<slug>_<YYYYMMDD>`, with `-N`
   * suffixed on collision) and stamps `source: 'operator'` so the
   * proposals view + the research cron can tell operator ideas
   * apart from seed/cron-generated ones.
   *
   * Pure-ish: only mutates persistent state on success, and only
   * via the same atomic JSON write path as `addIdeas`. Returns
   * the new idea + the updated file.
   *
   * @param {{
   *   title: string,
   *   category: string,
   *   rationale: string,
   *   evidence?: string,
   *   effort: 'S'|'M'|'L',
   *   impact: 'low'|'medium'|'high',
   *   category_tags?: string[],
   * }} draft
   * @param {{ now?: Date }} [opts]
   * @returns {Promise<{ idea: Object, file: FeatureIdeasFile, id_was_collision: boolean }>}
   */
  async addOperatorIdea(draft, opts = {}) {
    if (!draft || typeof draft !== 'object') {
      throw new Error('addOperatorIdea: draft must be an object');
    }
    const now = opts.now instanceof Date ? opts.now : new Date();
    const category_tags = Array.isArray(draft.category_tags) ? draft.category_tags : [];

    // Compute the slug id; if it collides with an existing idea on
    // the same day, suffix `-1`, `-2`, etc. The first collision
    // check is against the live file.
    const baseId = operatorIdeaIdForTitle(draft.title, now);
    let id = baseId;
    let id_was_collision = false;
    const file = await this.load();
    const existing = new Set(file.ideas.map((i) => i.id));
    if (existing.has(baseId)) {
      id_was_collision = true;
      let n = 1;
      while (existing.has(`${baseId}-${n}`)) n += 1;
      id = `${baseId}-${n}`;
    }

    // Build + validate the full idea before writing.
    const stamped = {
      id,
      title: String(draft.title),
      category: String(draft.category),
      rationale: String(draft.rationale),
      evidence: typeof draft.evidence === 'string' ? draft.evidence : '',
      effort: String(draft.effort),
      impact: String(draft.impact),
      status: 'pending',
      source: 'operator',
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      notes: [],
      category_tags,
      shipped_in: null,
    };
    const validated = validateIdea(stamped);

    const result = await this._withFile((currentFile) => {
      const ids = new Set(currentFile.ideas.map((i) => i.id));
      if (ids.has(validated.id)) {
        // Re-collision (someone else added an idea with the same id
        // between our load() and _withFile). Bail without writing;
        // the caller can retry.
        return currentFile;
      }
      const merged = Object.freeze([...currentFile.ideas, validated]);
      const meta = Object.freeze({ ...currentFile.meta, ...buildMeta(merged, currentFile.meta) });
      return Object.freeze({ version: FEATURE_IDEAS_VERSION, ideas: merged, meta });
    });
    return { idea: validated, file: result, id_was_collision };
  }

  /**
   * Flip an idea's status. Returns the updated file; throws
   * IdeaNotFoundError if the id doesn't exist.
   *
   * @param {string} id
   * @param {'pending'|'approved'|'rejected'|'shipped'} newStatus
   * @param {{ shipped_in?: string|null, now?: Date }} [opts]
   * @returns {Promise<FeatureIdeasFile>}
   */
  async updateStatus(id, newStatus, opts = {}) {
    if (!['pending', 'approved', 'rejected', 'shipped'].includes(newStatus)) {
      throw new Error(`updateStatus: bad status ${newStatus}`);
    }
    const now = opts.now instanceof Date ? opts.now : new Date();
    return this._withFile((file) => {
      const idx = file.ideas.findIndex((i) => i.id === id);
      if (idx === -1) {
        const err = new Error(`updateStatus: idea ${id} not found`);
        err.code = 'IDEA_NOT_FOUND';
        throw err;
      }
      const old = file.ideas[idx];
      const next = Object.freeze({
        ...old,
        status: newStatus,
        updated_at: now.toISOString(),
        shipped_in: newStatus === 'shipped'
          ? (opts.shipped_in ?? old.shipped_in ?? null)
          : null,
      });
      const ideas = Object.freeze([
        ...file.ideas.slice(0, idx),
        next,
        ...file.ideas.slice(idx + 1),
      ]);
      const meta = Object.freeze({
        ...file.meta,
        ...buildMeta(ideas, file.meta),
      });
      return Object.freeze({ version: FEATURE_IDEAS_VERSION, ideas, meta });
    });
  }

  /**
   * Append a note to an idea. Returns the updated file.
   *
   * @param {string} id
   * @param {{ ts: string, author: string, body: string }} note
   * @returns {Promise<FeatureIdeasFile>}
   */
  async addNote(id, note) {
    if (!note || typeof note !== 'object') {
      throw new Error('addNote: note required');
    }
    if (typeof note.body !== 'string' || note.body.length === 0) {
      throw new Error('addNote: note.body must be a non-empty string');
    }
    if (typeof note.author !== 'string' || note.author.length === 0) {
      throw new Error('addNote: note.author must be a non-empty string');
    }
    if (typeof note.ts !== 'string' || note.ts.length === 0) {
      throw new Error('addNote: note.ts must be a non-empty string');
    }
    return this._withFile((file) => {
      const idx = file.ideas.findIndex((i) => i.id === id);
      if (idx === -1) {
        const err = new Error(`addNote: idea ${id} not found`);
        err.code = 'IDEA_NOT_FOUND';
        throw err;
      }
      const old = file.ideas[idx];
      const noteFrozen = Object.freeze({
        ts: note.ts,
        author: note.author,
        body: note.body,
      });
      const next = Object.freeze({
        ...old,
        notes: Object.freeze([...old.notes, noteFrozen]),
        updated_at: note.ts,
      });
      const ideas = Object.freeze([
        ...file.ideas.slice(0, idx),
        next,
        ...file.ideas.slice(idx + 1),
      ]);
      const meta = Object.freeze({
        ...file.meta,
        ...buildMeta(ideas, file.meta),
      });
      return Object.freeze({ version: FEATURE_IDEAS_VERSION, ideas, meta });
    });
  }

  /**
   * Stamp the `last_research_at` field (called by the research
   * cron after a successful pass, whether or not new ideas were
   * appended). Returns the updated file.
   *
   * @param {Date} [now]
   * @returns {Promise<FeatureIdeasFile>}
   */
  async stampLastResearch(now = new Date()) {
    return this._withFile((file) => {
      const meta = Object.freeze({
        ...file.meta,
        last_research_at: now.toISOString(),
      });
      return Object.freeze({ version: FEATURE_IDEAS_VERSION, ideas: file.ideas, meta });
    });
  }

  /**
   * Read the current meta block (counters + last_research_at).
   * Convenience for the dashboard header.
   *
   * @returns {Promise<Object>}
   */
  async meta() {
    const file = await this.load();
    return file.meta;
  }
}

export { validateIdea, validateFeatureIdeasFile, FEATURE_IDEAS_VERSION };
