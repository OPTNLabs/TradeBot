#!/usr/bin/env node
// src/bugs/store.mjs
//
// Persistent store for operator-reported bugs. Mirrors the
// FeatureIdeasStore shape (load / list / add / updateStatus /
// reorder / addNote / addOperatorBug) so the dashboard, the
// supervisor-bridge, and the test suite all talk to one
// uniform API.
//
// File format is the schema documented in `schema.mjs`. All
// writes go through `atomicWriteJson` so a crash mid-write
// can't corrupt the file (same pattern positions.mjs /
// snapshots.mjs / feature-ideas/store.mjs use).
//
// Class API:
//   - `new BugsStore({file, logger})`
//   - `await store.load()`            → returns the parsed file
//   - `await store.list({...})`       → list + filter
//   - `await store.findById(id)`      → single bug or null
//   - `await store.addBug(bug)`       → idempotent insert (skips if id exists)
//   - `await store.addOperatorBug({title, description, ...})` → operator-create flow (slug id + auto-priority)
//   - `await store.updateStatus(id, status, opts)`  → flip status; sets shipped_in / updated_at
//   - `await store.reorder(id, newPriority)`        → move a bug to a new priority slot (auto-renumbers neighbours)
//   - `await store.deleteBug(id)`     → remove a bug entirely
//   - `await store.addNote(id, note)` → append a note

import { atomicWriteJson, readJsonFile, ensureDirForFile } from '../util/atomic-write.mjs';
import {
  BUGS_VERSION,
  buildMetaForBugs,
  operatorBugIdForTitle,
  validateBug,
  validateBugsFile,
  nextDefaultPriority,
  DEFAULT_BUG_SEVERITY,
} from './schema.mjs';

/**
 * @typedef {ReturnType<typeof validateBugsFile>} BugsFile
 */

/**
 * Empty store — used when the on-disk file is missing.
 * @returns {BugsFile}
 */
export function emptyBugsFile() {
  return Object.freeze({
    version: BUGS_VERSION,
    bugs: Object.freeze([]),
    meta: Object.freeze({
      total_count: 0,
      open_count: 0,
      in_progress_count: 0,
      shipped_count: 0,
      wontfix_count: 0,
      next_priority: 0,
      highest_priority: null,
    }),
  });
}

export class BugsStore {
  /**
   * @param {{file: string, logger?: Object}} opts
   */
  constructor(opts) {
    if (!opts || typeof opts.file !== 'string' || opts.file.length === 0) {
      throw new Error('BugsStore: file path required');
    }
    this.file = opts.file;
    this.logger = opts.logger ?? null;
  }

  /**
   * Read the on-disk file (or the empty default if missing) and
   * validate the envelope. Re-validates on every read so a
   * hand-edited file gets rejected loudly rather than silently
   * corrupting the dashboard.
   *
   * @returns {Promise<BugsFile>}
   */
  async load() {
    let raw = null;
    try {
      raw = await readJsonFile(this.file);
    } catch (e) {
      if (e && typeof e === 'object' && /** @type {any} */ (e).code === 'ENOENT') {
        return emptyBugsFile();
      }
      throw e;
    }
    return validateBugsFile(raw);
  }

  /**
   * Internal: load, mutate the bugs array, validate, write.
   * Centralises the atomic-write + meta-rebuild pattern so the
   * public methods don't repeat it.
   *
   * @template T
   * @param {(file: BugsFile) => { file: BugsFile, result: T }} mutator
   * @returns {Promise<T>}
   */
  async _withFile(mutator) {
    const file = await this.load();
    const out = mutator(file);
    const validated = validateBugsFile(out.file);
    await ensureDirForFile(this.file);
    await atomicWriteJson(this.file, validated);
    if (this.logger) {
      this.logger.info('bugs.store.write', {
        file: this.file,
        bug_count: validated.bugs.length,
      });
    }
    return out.result;
  }

  /**
   * Read-only list with optional filters. Filters compose with
   * AND semantics (status + category + severity + priority-min).
   *
   * @param {Object} [opts]
   * @param {string} [opts.status]
   * @param {string} [opts.category]
   * @param {string} [opts.severity]
   * @returns {Promise<{bugs: Array<Object>, meta: Object}>}
   */
  async list(opts = {}) {
    const file = await this.load();
    let bugs = file.bugs;
    if (opts.status) bugs = bugs.filter((b) => b.status === opts.status);
    if (opts.category) bugs = bugs.filter((b) => b.category === opts.category);
    if (opts.severity) bugs = bugs.filter((b) => b.severity === opts.severity);
    // Sort by priority asc (lower = higher priority = picked first).
    bugs = bugs.slice().sort((a, b) => a.priority - b.priority);
    return { bugs: Array.from(bugs), meta: file.meta };
  }

  /**
   * Single-bug lookup.
   *
   * @param {string} id
   * @returns {Promise<Object|null>}
   */
  async findById(id) {
    const file = await this.load();
    return file.bugs.find((b) => b.id === id) ?? null;
  }

  /**
   * Idempotent insert: skips if a bug with the same id already
   * exists. Validates the input. Returns the persisted bug.
   *
   * @param {Object} bug  a fully-formed bug (after validateBug)
   * @returns {Promise<Object>}
   */
  async addBug(bug) {
    const validated = validateBug(bug);
    return this._withFile((file) => {
      if (file.bugs.some((b) => b.id === validated.id)) {
        return { file, result: file.bugs.find((b) => b.id === validated.id) };
      }
      const bugs = Object.freeze([...file.bugs, validated]);
      const meta = buildMetaForBugs(bugs);
      return { file: { ...file, bugs, meta }, result: validated };
    });
  }

  /**
   * Operator-create flow. Generates a slug id, picks a default
   * priority (= current lowest-open-priority - 1, or 0 if no
   * open bugs), and assembles the bug envelope. Status defaults
   * to `open`.
   *
   * @param {{
   *   title: string,
   *   description: string,
   *   category?: string,
   *   severity?: string,
   *   author?: string,
   * }} opts
   * @returns {Promise<Object>}
   */
  async addOperatorBug(opts) {
    if (!opts || typeof opts !== 'object') throw new TypeError('addOperatorBug: opts required');
    if (typeof opts.title !== 'string' || opts.title.trim().length === 0) {
      throw new TypeError('addOperatorBug: title required');
    }
    if (typeof opts.description !== 'string') {
      throw new TypeError('addOperatorBug: description required');
    }
    const now = new Date();
    const file = await this.load();
    const id = operatorBugIdForTitle(opts.title, now);
    const priority = nextDefaultPriority(file.bugs);
    const bug = {
      id,
      title: opts.title.trim(),
      description: opts.description,
      category: (typeof opts.category === 'string') ? opts.category : 'other',
      severity: (typeof opts.severity === 'string') ? opts.severity : DEFAULT_BUG_SEVERITY,
      status: 'open',
      priority,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      shipped_in: null,
      notes: opts.author ? [{ ts: now.toISOString(), author: opts.author, body: 'created' }] : [],
    };
    return this.addBug(bug);
  }

  /**
   * Flip a bug's status. Sets `updated_at`. If the new status is
   * `shipped`, records `shipped_in` (caller-supplied commit SHA).
   * If the new status is `in_progress` from `open`/`wontfix`,
   * records a transition note so the audit trail shows who
   * claimed the bug.
   *
   * @param {string} id
   * @param {string} newStatus
   * @param {{shipped_in?: string, author?: string}} [opts]
   * @returns {Promise<Object>}
   */
  async updateStatus(id, newStatus, opts = {}) {
    const VALID = ['open', 'in_progress', 'shipped', 'wontfix'];
    if (!VALID.includes(newStatus)) {
      throw new Error(`updateStatus: bad status ${newStatus}`);
    }
    const now = new Date().toISOString();
    return this._withFile((file) => {
      const idx = file.bugs.findIndex((b) => b.id === id);
      if (idx === -1) {
        const e = new Error(`updateStatus: bug ${id} not found`);
        e.code = 'BUG_NOT_FOUND';
        throw e;
      }
      const old = file.bugs[idx];
      const next = {
        ...old,
        status: newStatus,
        updated_at: now,
        shipped_in: newStatus === 'shipped'
          ? (opts.shipped_in ?? old.shipped_in ?? null)
          : (newStatus !== 'shipped' ? null : old.shipped_in),
        notes: (newStatus === 'in_progress' && (old.status === 'open' || old.status === 'wontfix') && opts.author)
          ? [...old.notes, { ts: now, author: opts.author, body: `status: ${old.status} → in_progress` }]
          : old.notes,
      };
      const validated = validateBug(next);
      const bugs = Object.freeze([...file.bugs.slice(0, idx), validated, ...file.bugs.slice(idx + 1)]);
      const meta = buildMetaForBugs(bugs);
      return { file: { ...file, bugs, meta }, result: validated };
    });
  }

  /**
   * Reorder: move bug `id` so it sits at `newPriority`. Other
   * bugs between the old and new positions are shifted by ±1 to
   * keep priorities unique (still monotonic — lower = picked
   * first). Returns the moved bug.
   *
   * The `newPriority` argument is the INTEGER slot you want the
   * bug to land at, not a delta. To move a bug to the TOP, pass
   * a number smaller than the current lowest-open-priority (the
   * caller is expected to know the topology). To move to the
   * BOTTOM, pass a number larger than the current highest.
   *
   * Refuses to reorder `shipped` or `wontfix` bugs (their
   * position is historical; moving them would corrupt the audit
   * trail).
   *
   * @param {string} id
   * @param {number} newPriority
   * @returns {Promise<Object>}
   */
  async reorder(id, newPriority) {
    if (!Number.isInteger(newPriority)) {
      throw new TypeError(`reorder: newPriority must be an integer; got ${newPriority}`);
    }
    return this._withFile((file) => {
      const idx = file.bugs.findIndex((b) => b.id === id);
      if (idx === -1) {
        const e = new Error(`reorder: bug ${id} not found`);
        e.code = 'BUG_NOT_FOUND';
        throw e;
      }
      const target = file.bugs[idx];
      if (target.status === 'shipped' || target.status === 'wontfix') {
        const e = new Error(`reorder: cannot reorder ${target.status} bug ${id}`);
        e.code = 'BUG_NOT_REORDERABLE';
        throw e;
      }
      const others = file.bugs
        .filter((b) => b.id !== id && (b.status === 'open' || b.status === 'in_progress'))
        .sort((a, b) => a.priority - b.priority);
      // Re-number so that priorities remain unique and the
      // moved bug lands at newPriority, with everything else
      // shifted by exactly 1 to make room (or close the gap).
      const rebuilt = [];
      let priorityCursor = 0;
      let placed = false;
      for (const b of others) {
        if (!placed && priorityCursor === newPriority) {
          rebuilt.push({ ...target, priority: newPriority, updated_at: new Date().toISOString() });
          priorityCursor += 1;
          placed = true;
        }
        // Skip the slot if it would collide with the target.
        rebuilt.push({ ...b, priority: priorityCursor });
        priorityCursor += 1;
      }
      if (!placed) {
        // Bug moved past the end of the queue.
        rebuilt.push({ ...target, priority: newPriority, updated_at: new Date().toISOString() });
      }
      // Reassemble the file: non-open bugs keep their priority,
      // the rebuilt ones (open/in_progress) get the renumbered
      // priorities.
      const renumberedIds = new Set(rebuilt.map((b) => b.id));
      const kept = file.bugs
        .filter((b) => !renumberedIds.has(b.id))
        .map((b) => ({ ...b }));   // shallow clone so the freeze at the end works cleanly
      const merged = [...kept, ...rebuilt]
        .map((b) => validateBug(b))
        .sort((a, b) => a.priority - b.priority);
      const meta = buildMetaForBugs(merged);
      const frozen = Object.freeze([...merged]);
      const result = frozen.find((b) => b.id === id);
      return { file: { ...file, bugs: frozen, meta }, result };
    });
  }

  /**
   * Permanently delete a bug. Use sparingly — most fixes flow
   * through the `shipped` or `wontfix` status. This is for the
   * case where the operator accidentally filed a duplicate.
   *
   * @param {string} id
   * @returns {Promise<{deleted: boolean}>}
   */
  async deleteBug(id) {
    return this._withFile((file) => {
      const before = file.bugs.length;
      const bugs = file.bugs.filter((b) => b.id !== id);
      if (bugs.length === before) {
        return { file, result: { deleted: false } };
      }
      const meta = buildMetaForBugs(bugs);
      return { file: { ...file, bugs: Object.freeze(bugs), meta }, result: { deleted: true } };
    });
  }

  /**
   * Append a note to a bug's `notes[]` array.
   *
   * @param {string} id
   * @param {{author: string, body: string}} note
   * @returns {Promise<Object>}
   */
  async addNote(id, note) {
    if (!note || typeof note !== 'object') throw new TypeError('addNote: note required');
    if (typeof note.author !== 'string' || note.author.length === 0) {
      throw new TypeError('addNote: author required');
    }
    if (typeof note.body !== 'string' || note.body.trim().length === 0) {
      throw new TypeError('addNote: body required');
    }
    const now = new Date().toISOString();
    return this._withFile((file) => {
      const idx = file.bugs.findIndex((b) => b.id === id);
      if (idx === -1) {
        const e = new Error(`addNote: bug ${id} not found`);
        e.code = 'BUG_NOT_FOUND';
        throw e;
      }
      const old = file.bugs[idx];
      const next = {
        ...old,
        notes: Object.freeze([...old.notes, { ts: now, author: note.author, body: note.body.trim() }]),
        updated_at: now,
      };
      const validated = validateBug(next);
      const bugs = Object.freeze([...file.bugs.slice(0, idx), validated, ...file.bugs.slice(idx + 1)]);
      const meta = buildMetaForBugs(bugs);
      return { file: { ...file, bugs, meta }, result: validated };
    });
  }
}
