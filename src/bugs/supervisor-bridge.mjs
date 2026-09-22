#!/usr/bin/env node
// src/bugs/supervisor-bridge.mjs
//
// Bridge between the bugs store and the tradebot supervisor's
// TODO list. Mirrors `src/feature-ideas/supervisor-bridge.mjs`:
//
//   - When the supervisor ticks, it picks the LOWEST-PRIORITY
//     `open` bug, appends a `B## <title>` TODO entry to TODO.md,
//     and flips the bug to `in_progress` so the next tick
//     doesn't double-pick.
//   - When the supervisor finishes (TODO.md `[x]`), the operator
//     (or the ship pipeline) flips the bug to `shipped` with the
//     commit SHA.
//
// Bugs are HIGHER priority than approved proposals. If any
// `open` bug exists, the supervisor works it first. Only when
// the bugs file is empty (or every bug is shipped/wontfix) does
// the supervisor fall through to the existing approved-proposals
// bridge.
//
// TODO entry format mirrors the supervisor's convention:
//   - [ ] B## <title> [USER-FILED from bugs <bug-id>]
//     <description>
//     Category: <category>.  Severity: <severity>.
//     Filed at <iso>.  Source: data/bugs.json#<bug-id>.

import { readFile, writeFile } from 'node:fs/promises';

/**
 * Pick the highest-priority open bug (LOWEST priority integer).
 * Pure — does not mutate. Used by the supervisor's tick handler
 * to choose the next bug to work.
 *
 * Tie-breaker: if multiple open bugs share the same priority,
 * pick the OLDEST (earliest `created_at`) so a flood of identical
 * priorities doesn't make the supervisor pick arbitrarily.
 *
 * @param {Array<Object>} bugs  the validated `bugs[]` from `data/bugs.json`
 * @returns {Object|null}      the bug object or null when no open bug exists
 */
export function pickNextBug(bugs) {
  if (!Array.isArray(bugs) || bugs.length === 0) return null;
  const open = bugs.filter((b) => b.status === 'open' || b.status === 'in_progress');
  if (open.length === 0) return null;
  open.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return Date.parse(a.created_at) - Date.parse(b.created_at);
  });
  return open[0];
}

/**
 * Pure: parse the next available `B##` id from a TODO.md body.
 * `B##` is the bugs prefix; matches the `[ ]`/`[x]`/`[~]`
 * states like `nextTodoId` does for `T##`.
 *
 * @param {string} todoBody
 * @returns {number}
 */
export function nextBugTodoId(todoBody) {
  if (typeof todoBody !== 'string') return 1;
  const re = /^- \[[ x~]\] B(\d+)/gm;
  let max = 0;
  for (const m of todoBody.matchAll(re)) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

/**
 * Build the TODO entry markdown block for a single bug. Pure.
 *
 * @param {Object} bug     a validated bug
 * @param {number} todoId  integer to format as `B##`
 * @returns {string}
 */
export function buildBugTodoEntry(bug, todoId) {
  const id = String(todoId).padStart(2, '0');
  const lines = [];
  lines.push(`- [ ] B${id} ${bug.title} [USER-FILED from bugs ${bug.id}]`);
  if (typeof bug.description === 'string' && bug.description.trim().length > 0) {
    // Wrap long descriptions at ~100 chars; mirrors the feature-
    // ideas supervisor-bridge so TODO.md reads consistently.
    const desc = bug.description.trim();
    const wrap = (s) => s
      .split('\n')
      .flatMap((para) => {
        const words = para.split(/\s+/);
        const out = [];
        let cur = '';
        for (const w of words) {
          if ((cur + ' ' + w).trim().length > 100 && cur.length > 0) {
            out.push(cur.trim());
            cur = w;
          } else {
            cur = (cur + ' ' + w).trim();
          }
        }
        if (cur.length > 0) out.push(cur.trim());
        return out;
      })
      .map((s) => `  ${s}`);
    lines.push(...wrap(desc));
  }
  lines.push(`  Category: ${bug.category}.  Severity: ${bug.severity}.`);
  lines.push(`  Filed at ${new Date().toISOString()}.`);
  lines.push(`  Source: data/bugs.json#${bug.id}.`);
  return lines.join('\n') + '\n';
}


/**
 * Append a bug's TODO entry to TODO.md and flip the bug to
 * `in_progress` in the store. The entry is TOP-INSERTED into the
 * `## Active queue` section so the supervisor (which reads top-down)
 * picks it up on the next tick. (Previous behaviour was an
 * `appendFile` to EOF, which left bugs stranded at the bottom of
 * the file and required the operator to manually hoist them to the
 * top — bug B01 + bug B02 both hit this; see the follow-up note
 * in the B01 shipped entry for the full incident write-up.)
 *
 * Top-insert semantics: find the `## Active queue` heading, then
 * insert the entry as the FIRST bullet after that heading (so it
 * sits above any pending `[ ]` items the operator may have queued
 * there). If the heading isn't found, the entry is appended to the
 * file (defensive fallback — the file probably hasn't been created
 * by the supervisor's normal scaffold yet).
 *
 * Idempotent in the supervisor's normal flow (each tick calls
 * once), but not strictly so: if the supervisor crashes between
 * the file write and the status flip, the next tick will see an
 * `open` bug again and re-insert. The operator can detect the
 * duplicate via TODO.md visual inspection or the
 * `in_progress→open` transition log.
 *
 * @param {{
 *   bugsStore: import('./store.mjs').BugsStore,
 *   todoPath: string,
 *   bug: Object,
 *   logger?: Object,
 * }} opts
 * @returns {Promise<{todoId: number, bugId: string}>}
 */
export async function appendBugToTodo(opts) {
  if (!opts || !opts.bugsStore) throw new Error('appendBugToTodo: bugsStore required');
  if (typeof opts.todoPath !== 'string' || opts.todoPath.length === 0) {
    throw new Error('appendBugToTodo: todoPath required');
  }
  if (!opts.bug || typeof opts.bug !== 'object') {
    throw new Error('appendBugToTodo: bug required');
  }
  let body = '';
  try {
    body = await readFile(opts.todoPath, 'utf8');
  } catch (e) {
    if (e && typeof e === 'object' && /** @type {any} */ (e).code !== 'ENOENT') {
      throw e;
    }
    // Missing TODO.md is fine — we'll create the first entry.
    body = '';
  }
  const todoId = nextBugTodoId(body);
  const entry = buildBugTodoEntry(opts.bug, todoId);
  // Top-insert into `## Active queue` if present; otherwise append.
  const newBody = insertBugIntoActiveQueue(body, entry);
  await writeFile(opts.todoPath, newBody, 'utf8');
  await opts.bugsStore.updateStatus(opts.bug.id, 'in_progress', { author: 'supervisor-bridge' });
  if (opts.logger) {
    opts.logger.info('bugs.supervisor-bridge.appended', {
      bug_id: opts.bug.id,
      todo_id: `B${String(todoId).padStart(2, '0')}`,
      todo_path: opts.todoPath,
    });
  }
  return { todoId, bugId: opts.bug.id };
}

/**
 * Pure: top-insert a bug TODO entry into the `## Active queue`
 * section of a TODO.md body. The entry becomes the FIRST bullet
 * after the heading (so the supervisor picks it up on its next
 * read-down pass).
 *
 * Algorithm:
 *   1. Locate the `## Active queue` heading (or `## active queue`,
 *      case-insensitive). The insertion point is the line right
 *      after it.
 *   2. If no heading is found, fall back to appending the entry
 *      (with a leading blank line) to the end of the body. This
 *      keeps the bridge tolerant of TODO.md scaffolding the
 *      operator may have rearranged.
 *   3. If the heading IS found, the entry is inserted immediately
 *      after it — BEFORE any existing bullets. The original body
 *      content (everything from the first existing bullet onward)
 *      is shifted down.
 *
 * Defensive:
 *   - Tolerates non-string body (returns body + entry as a fallback).
 *   - Tolerates entry not ending in `\n` (adds one).
 *   - Tolerates `## Active queue` appearing multiple times (inserts
 *     after the FIRST one, matching the supervisor's read-down pass).
 *
 * @param {string} body   TODO.md file contents
 * @param {string} entry  the bug entry built by `buildBugTodoEntry`
 * @returns {string}      new TODO.md body
 */
export function insertBugIntoActiveQueue(body, entry) {
  if (typeof body !== 'string') body = '';
  if (typeof entry !== 'string' || entry.length === 0) return body;
  const entryWithNewline = entry.endsWith('\n') ? entry : entry + '\n';
  // Match the `## Active queue` heading at start-of-line.
  const re = /^##\s*[Aa]ctive\s+queue\s*$/m;
  const m = body.match(re);
  if (!m || typeof m.index !== 'number') {
    // No active-queue heading — append with a leading blank line so
    // the entry doesn't stick to the previous line.
    const sep = body.length > 0 && !body.endsWith('\n') ? '\n' : '';
    return body + sep + (body.length > 0 ? '\n' : '') + entryWithNewline;
  }
  const insertAt = m.index + m[0].length;
  return body.slice(0, insertAt)
    + '\n'
    + entryWithNewline
    + body.slice(insertAt);
}

/**
 * Pick the next item for the supervisor: BUG FIRST, then
 * FALL THROUGH to approved proposals. This is the single
 * integration point the supervisor's tick handler should call.
 *
 * Returns either:
 *   - `{ kind: 'bug', bug, store }` — a bug to work next (caller
 *     should call `appendBugToTodo` to stamp the TODO entry).
 *   - `{ kind: 'idea', idea }` — an approved idea (caller should
 *     call the existing `appendApprovedIdeaToTodo` from the
 *     feature-ideas bridge).
 *   - `{ kind: 'none' }` — nothing to do; supervisor idle.
 *
 * The bugs store + feature-ideas store are passed in so the
 * function stays pure wrt the on-disk files (the caller owns the
 * I/O). Returns the data the caller needs to act; the caller is
 * responsible for the TODO append + status flip.
 *
 * @param {{
 *   bugsStore: import('./store.mjs').BugsStore,
 *   featureIdeasStore: import('../feature-ideas/store.mjs').FeatureIdeasStore,
 * }} opts
 * @returns {Promise<{kind: 'bug', bug: Object}|{kind: 'idea', idea: Object}|{kind: 'none'}>}
 */
export async function pickNextWorkItem(opts) {
  if (!opts || !opts.bugsStore || !opts.featureIdeasStore) {
    throw new Error('pickNextWorkItem: bugsStore + featureIdeasStore required');
  }
  // Try bugs first — they have explicit operator-set priority.
  const bugsFile = await opts.bugsStore.load();
  const nextBug = pickNextBug(bugsFile.bugs);
  if (nextBug) {
    return { kind: 'bug', bug: nextBug };
  }
  // Fall through to approved proposals (highest-impact first).
  const ideasFile = await opts.featureIdeasStore.load();
  const approved = ideasFile.ideas.filter((i) => i.status === 'approved');
  if (approved.length === 0) {
    return { kind: 'none' };
  }
  // Sort approved ideas the same way the existing supervisor
  // would: highest impact first, then earliest created_at. This
  // matches the proposal store's convention so the operator's
  // mental model stays consistent.
  const impactRank = { high: 0, medium: 1, low: 2 };
  approved.sort((a, b) => {
    const ar = impactRank[a.impact] ?? 99;
    const br = impactRank[b.impact] ?? 99;
    if (ar !== br) return ar - br;
    return Date.parse(a.created_at) - Date.parse(b.created_at);
  });
  return { kind: 'idea', idea: approved[0] };
}
