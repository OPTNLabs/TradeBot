#!/usr/bin/env node
// src/feature-ideas/supervisor-bridge.mjs
//
// Bridge between the feature-ideas store and the tradebot
// supervisor's TODO list. When an idea is approved via the
// dashboard, we append a new TODO entry to TODO.md so the
// supervisor picks it up on its next tick.
//
// The TODO entry format mirrors the supervisor's convention:
//   - [ ] T## <title> [USER-APPROVED from feature-ideas]
//     <rationale>
//     <evidence>
//     Effort: S | M | L.  Impact: <low|medium|high>.
//     Approved at <iso>.  Source: data/feature-ideas.json#<id>.
//
// The next available `T##` number is parsed from existing TODO
// entries (we look for `^- \[ \] T(\d+)` lines). Numbers are not
// strictly contiguous — we pick the highest existing + 1.

import { readFile, appendFile } from 'node:fs/promises';

/**
 * Pure. Parse the next available TODO id from a TODO.md body.
 * Returns the integer (without the `T` prefix) — caller formats.
 *
 * Matches BOTH the `[ ]` (pending) and `[x]` (shipped) bullet
 * states, so the highest-existing-id approach works even when
 * every prior entry is already shipped (the supervisor's normal
 * end-of-project state). Without matching `[x]`, the regex would
 * return 0 + 1 = 1 and collide with T01.
 *
 * @param {string} todoBody
 * @returns {number}
 */
export function nextTodoId(todoBody) {
  if (typeof todoBody !== 'string') return 1;
  const re = /^- \[[ x]\] T(\d+)/gm;
  let max = 0;
  for (const m of todoBody.matchAll(re)) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

/**
 * Build the TODO entry markdown block for a single approved
 * idea. Pure.
 *
 * @param {Object} idea   a validated idea
 * @param {number} todoId  integer to format as `T##`
 * @returns {string}
 */
export function buildTodoEntry(idea, todoId) {
  const id = String(todoId).padStart(2, '0');
  const lines = [];
  lines.push(`- [ ] T${id} ${idea.title} [USER-APPROVED from feature-ideas ${idea.id}]`);
  lines.push(`  ${idea.rationale}`);
  if (typeof idea.evidence === 'string' && idea.evidence.length > 0) {
    lines.push(`  Evidence: ${idea.evidence}`);
  }
  lines.push(`  Effort: ${idea.effort}.  Impact: ${idea.impact}.  Category: ${idea.category}.`);
  lines.push(`  Approved at ${new Date().toISOString()}.  Source: data/feature-ideas.json#${idea.id}.`);
  return lines.join('\n') + '\n';
}

/**
 * Append a TODO entry to TODO.md. Idempotency note: we always
 * append (the dashboard "approve" action only fires when the
 * status was `pending` → `approved`, so the user can't double-fire
 * from the UI; but if two approvals race, we'll get two TODO
 * entries — the supervisor's existing in-flight detection
 * (commit-SHA dedup) handles that.
 *
 * @param {{ todoPath: string, idea: Object }} opts
 * @returns {Promise<{ todoId: number }>}
 */
export async function appendApprovedIdeaToTodo({ todoPath, idea }) {
  if (!idea || typeof idea !== 'object') {
    throw new Error('appendApprovedIdeaToTodo: idea required');
  }
  let body = '';
  try {
    body = await readFile(todoPath, 'utf8');
  } catch (e) {
    if (e && typeof e === 'object' && /** @type {any} */ (e).code !== 'ENOENT') {
      throw e;
    }
    // Missing TODO.md is fine — we'll create the first entry.
    body = '';
  }
  const id = nextTodoId(body);
  const block = buildTodoEntry(idea, id);
  await appendFile(todoPath, block, 'utf8');
  return { todoId: id };
}
