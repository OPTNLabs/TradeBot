#!/usr/bin/env node
/**
 * Unit tests for src/bugs/supervisor-bridge.mjs.
 *
 * Pure-function tests for `pickNextBug`, `nextBugTodoId`,
 * `buildBugTodoEntry` plus an integration test for
 * `appendBugToTodo` (file I/O via mkdtemp). The supervisor-bridge
 * is the integration point between the bugs store and the
 * supervisor's TODO list — its correctness pins both the
 * "bugs come first" priority ordering and the on-disk TODO.md
 * entry format the supervisor parses.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  pickNextBug,
  nextBugTodoId,
  buildBugTodoEntry,
  appendBugToTodo,
  insertBugIntoActiveQueue,
  pickNextWorkItem,
} from '../src/bugs/supervisor-bridge.mjs';
import { BugsStore } from '../src/bugs/store.mjs';

const makeBug = (overrides = {}) => ({
  id: 'bug-test-20260915',
  title: 'Test bug',
  description: 'A bug description.',
  category: 'ui',
  severity: 'medium',
  status: 'open',
  priority: 0,
  created_at: '2026-09-15T12:00:00.000Z',
  updated_at: '2026-09-15T12:00:00.000Z',
  shipped_in: null,
  notes: [],
  ...overrides,
});

// ───────────────────────────────────────────────────────────────────
//  pickNextBug
// ───────────────────────────────────────────────────────────────────

test('pickNextBug: returns null when no bugs', () => {
  assert.equal(pickNextBug([]), null);
  assert.equal(pickNextBug(null), null);
  assert.equal(pickNextBug(undefined), null);
});

test('pickNextBug: skips non-open statuses', () => {
  const bugs = [
    makeBug({ id: 'open', status: 'open', priority: 0 }),
    makeBug({ id: 'shipped', status: 'shipped', priority: 1 }),
    makeBug({ id: 'wontfix', status: 'wontfix', priority: 2 }),
  ];
  const picked = pickNextBug(bugs);
  assert.equal(picked.id, 'open');
});

test('pickNextBug: includes in_progress (treats it as "still active")', () => {
  const bugs = [
    makeBug({ id: 'ip', status: 'in_progress', priority: 0 }),
  ];
  // pickNextBug pulls from open + in_progress so a previous
  // crash leaves the bug visible to the next tick (rather than
  // orphaning it). If the operator wanted to skip an in_progress
  // bug, they would have flipped it back to open manually.
  const picked = pickNextBug(bugs);
  assert.equal(picked.id, 'ip');
});

test('pickNextBug: picks lowest priority (highest priority)', () => {
  const bugs = [
    makeBug({ id: 'high', priority: 100 }),
    makeBug({ id: 'top', priority: -5 }),
    makeBug({ id: 'mid', priority: 50 }),
  ];
  assert.equal(pickNextBug(bugs).id, 'top');
});

test('pickNextBug: tie-break by oldest created_at', () => {
  const bugs = [
    makeBug({ id: 'newer', priority: 0, created_at: '2026-09-15T12:00:00.000Z' }),
    makeBug({ id: 'older', priority: 0, created_at: '2026-09-15T11:00:00.000Z' }),
  ];
  assert.equal(pickNextBug(bugs).id, 'older');
});

// ───────────────────────────────────────────────────────────────────
//  nextBugTodoId
// ───────────────────────────────────────────────────────────────────

test('nextBugTodoId: 1 when no existing B## entries', () => {
  assert.equal(nextBugTodoId(''), 1);
  assert.equal(nextBugTodoId('Some unrelated content'), 1);
});

test('nextBugTodoId: highest + 1 across [ ] and [x] states', () => {
  const body = `- [ ] B01 pending bug\n- [x] B02 shipped bug\n`;
  assert.equal(nextBugTodoId(body), 3);
});

test('nextBugTodoId: tolerates non-contiguous numbers', () => {
  const body = `- [ ] B05\n- [x] B10\n`;
  assert.equal(nextBugTodoId(body), 11);
});

test('nextBugTodoId: 1 on bad input', () => {
  assert.equal(nextBugTodoId(null), 1);
  assert.equal(nextBugTodoId(123), 1);
});

// ───────────────────────────────────────────────────────────────────
//  buildBugTodoEntry
// ───────────────────────────────────────────────────────────────────

test('buildBugTodoEntry: format mirrors the supervisor convention', () => {
  const entry = buildBugTodoEntry(
    makeBug({
      id: 'bug-cumulative-p-l-wrong-20260915',
      title: 'Cumulative P&L shows wrong total',
      description: 'The total is wrong by 0.001 BCH.',
      category: 'ui',
      severity: 'high',
    }),
    1,
  );
  assert.match(entry, /^- \[ \] B01 Cumulative P&L shows wrong total \[USER-FILED from bugs bug-cumulative-p-l-wrong-20260915\]$/m);
  assert.match(entry, /^  The total is wrong by 0\.001 BCH\.$/m);
  assert.match(entry, /^  Category: ui\.  Severity: high\.$/m);
  assert.match(entry, /^  Filed at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\.$/m);
  assert.match(entry, /^  Source: data\/bugs\.json#bug-cumulative-p-l-wrong-20260915\.$/m);
});

test('buildBugTodoEntry: wraps long descriptions at ~100 chars', () => {
  const longDesc = 'word '.repeat(80).trim(); // ~400 chars
  const entry = buildBugTodoEntry(makeBug({ description: longDesc }), 1);
  // Each wrapped line should be at most 102 chars (2-char indent + 100).
  for (const line of entry.split('\n')) {
    if (line.startsWith('  ')) {
      assert.ok(line.length <= 102, `line too long: ${line.length} chars: ${line}`);
    }
  }
});

test('buildBugTodoEntry: pads single-digit ids to two digits', () => {
  const entry = buildBugTodoEntry(makeBug({ id: 'x' }), 7);
  assert.match(entry, /^- \[ \] B07 /m);
});

// ───────────────────────────────────────────────────────────────────
//  appendBugToTodo (I/O integration)
// ───────────────────────────────────────────────────────────────────

test('appendBugToTodo: writes entry + flips status to in_progress', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bugs-bridge-test-'));
  t._tmpDir = dir;
  const todoPath = join(dir, 'TODO.md');
  const store = new BugsStore({ file: join(dir, 'bugs.json') });
  await store.addBug(makeBug({ id: 'bug-x-20260915' }));

  const result = await appendBugToTodo({
    bugsStore: store,
    todoPath,
    bug: await store.findById('bug-x-20260915'),
  });

  assert.equal(result.todoId, 1);
  assert.equal(result.bugId, 'bug-x-20260915');
  // TODO.md was created with the entry.
  assert.ok(existsSync(todoPath));
  const body = readFileSync(todoPath, 'utf8');
  assert.match(body, /^- \[ \] B01 Test bug \[USER-FILED from bugs bug-x-20260915\]$/m);
  // Bug was flipped to in_progress.
  const updated = await store.findById('bug-x-20260915');
  assert.equal(updated.status, 'in_progress');
  // Cleanup
  rmSync(dir, { recursive: true, force: true });
});

test('appendBugToTodo: increments B## id when TODO.md already has entries', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bugs-bridge-test-'));
  t._tmpDir = dir;
  const todoPath = join(dir, 'TODO.md');
  // Pre-seed TODO.md with an existing B## entry.
  const { writeFileSync } = await import('node:fs');
  writeFileSync(todoPath, '- [ ] B01 previous bug\n');
  const store = new BugsStore({ file: join(dir, 'bugs.json') });
  await store.addBug(makeBug({ id: 'bug-x-20260915' }));
  const result = await appendBugToTodo({
    bugsStore: store,
    todoPath,
    bug: await store.findById('bug-x-20260915'),
  });
  assert.equal(result.todoId, 2);
  const body = readFileSync(todoPath, 'utf8');
  assert.match(body, /^- \[ \] B02 Test bug/m);
  rmSync(dir, { recursive: true, force: true });
});

test('appendBugToTodo: throws when bugsStore is missing', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bugs-bridge-test-'));
  t._tmpDir = dir;
  await assert.rejects(
    () => appendBugToTodo({ todoPath: join(dir, 'TODO.md'), bug: makeBug() }),
    /bugsStore required/,
  );
  await assert.rejects(
    () => appendBugToTodo({ bugsStore: {}, todoPath: '', bug: makeBug() }),
    /todoPath required/,
  );
  await assert.rejects(
    () => appendBugToTodo({ bugsStore: {}, todoPath: join(dir, 'TODO.md'), bug: null }),
    /bug required/,
  );
  rmSync(dir, { recursive: true, force: true });
});

// ───────────────────────────────────────────────────────────────────
//  pickNextWorkItem — the integration point
// ───────────────────────────────────────────────────────────────────

test('pickNextWorkItem: returns bug FIRST when bugs exist', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bugs-bridge-test-'));
  t._tmpDir = dir;
  const bugsStore = new BugsStore({ file: join(dir, 'bugs.json') });
  await bugsStore.addBug(makeBug({ id: 'bug-1', priority: 0 }));

  // Stub the feature-ideas store with just enough surface to
  // satisfy pickNextWorkItem (it never reads the on-disk file
  // because the bug branch returns first).
  const featureIdeasStore = { load: async () => ({ ideas: [] }) };

  const next = await pickNextWorkItem({ bugsStore, featureIdeasStore });
  assert.equal(next.kind, 'bug');
  assert.equal(next.bug.id, 'bug-1');
  rmSync(dir, { recursive: true, force: true });
});

test('pickNextWorkItem: falls through to approved ideas when no open bugs', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bugs-bridge-test-'));
  t._tmpDir = dir;
  const bugsStore = new BugsStore({ file: join(dir, 'bugs.json') });
  // No bugs filed.
  const featureIdeasStore = {
    load: async () => ({
      ideas: [
        { id: 'idea-approved', status: 'approved', impact: 'high', created_at: '2026-09-15T11:00:00Z' },
        { id: 'idea-low',     status: 'approved', impact: 'low',  created_at: '2026-09-15T10:00:00Z' },
        { id: 'idea-medium',  status: 'approved', impact: 'medium', created_at: '2026-09-15T09:00:00Z' },
        { id: 'idea-pending', status: 'pending', impact: 'high', created_at: '2026-09-15T08:00:00Z' },
      ],
    }),
  };

  const next = await pickNextWorkItem({ bugsStore, featureIdeasStore });
  assert.equal(next.kind, 'idea');
  // Sorted by impact (high first), then created_at asc within tier.
  assert.equal(next.idea.id, 'idea-approved');
  rmSync(dir, { recursive: true, force: true });
});

test('pickNextWorkItem: returns "none" when both stores are empty of work', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bugs-bridge-test-'));
  t._tmpDir = dir;
  const bugsStore = new BugsStore({ file: join(dir, 'bugs.json') });
  const featureIdeasStore = {
    load: async () => ({ ideas: [{ id: 'x', status: 'shipped' }] }),
  };
  const next = await pickNextWorkItem({ bugsStore, featureIdeasStore });
  assert.equal(next.kind, 'none');
  rmSync(dir, { recursive: true, force: true });
});

test('pickNextWorkItem: throws when either store is missing', async () => {
  await assert.rejects(
    () => pickNextWorkItem({ bugsStore: null, featureIdeasStore: {} }),
    /bugsStore \+ featureIdeasStore required/,
  );
});

// ───────────────────────────────────────────────────────────────────
//  insertBugIntoActiveQueue (pure helper, B02 / bridge-tops-into-EOF)
// ───────────────────────────────────────────────────────────────────

test('insertBugIntoActiveQueue: top-inserts into the ## Active queue section', () => {
  const body = [
    '# TODO',
    '',
    '## Active queue',
    '',
    '- [ ] T99 existing feature',
    '',
    '- [ ] T100 another feature',
    '',
    '## Shipped',
    '',
    '- [x] T01 first feature',
    '',
  ].join('\n');
  const entry = '- [ ] B01 New bug\n  Filed at 2026-09-16.\n';
  const out = insertBugIntoActiveQueue(body, entry);
  // The bug entry must appear BEFORE the existing T99 entry (the
  // supervisor reads top-down and picks the first [ ] bullet).
  const bugIdx = out.indexOf('- [ ] B01 New bug');
  const t99Idx = out.indexOf('- [ ] T99 existing feature');
  assert.ok(bugIdx > 0, 'bug entry should be present');
  assert.ok(t99Idx > 0, 'T99 entry should be present');
  assert.ok(bugIdx < t99Idx, 'bug entry should appear BEFORE T99 in the file');
  // ## Active queue heading is still at the same line.
  assert.match(out, /^##\s*[Aa]ctive\s+queue$/m);
  // ## Shipped heading + shipped entries are untouched.
  assert.ok(out.indexOf('- [x] T01 first feature') > out.indexOf('## Shipped'));
});

test('insertBugIntoActiveQueue: case-insensitive heading match', () => {
  const body = [
    '# TODO',
    '',
    '## active queue',
    '',
    '- [ ] T99 existing feature',
    '',
  ].join('\n');
  const entry = '- [ ] B01 New bug\n';
  const out = insertBugIntoActiveQueue(body, entry);
  const bugIdx = out.indexOf('- [ ] B01 New bug');
  const t99Idx = out.indexOf('- [ ] T99 existing feature');
  assert.ok(bugIdx > 0 && t99Idx > 0);
  assert.ok(bugIdx < t99Idx);
});

test('insertBugIntoActiveQueue: appends (with leading blank line) when no heading is found', () => {
  const body = '- [ ] T99 existing feature\n';
  const entry = '- [ ] B01 New bug\n  Filed at 2026-09-16.\n';
  const out = insertBugIntoActiveQueue(body, entry);
  // No heading → entry is appended to the end.
  const t99Idx = out.indexOf('- [ ] T99 existing feature');
  const bugIdx = out.indexOf('- [ ] B01 New bug');
  assert.ok(t99Idx >= 0 && bugIdx > t99Idx, 'entry should be appended AFTER the existing content');
  // Leading blank line so the entry doesn't stick to the previous line.
  assert.match(out, /- \[ \] T99 existing feature\n\n- \[ \] B01 New bug/);
});

test('insertBugIntoActiveQueue: empty body creates a file with just the entry', () => {
  const out = insertBugIntoActiveQueue('', '- [ ] B01 New bug\n');
  assert.equal(out, '- [ ] B01 New bug\n');
});

test('insertBugIntoActiveQueue: tolerates non-string body + empty entry', () => {
  assert.equal(insertBugIntoActiveQueue(null, '- [ ] B01\n'), '- [ ] B01\n');
  assert.equal(insertBugIntoActiveQueue(undefined, '- [ ] B01\n'), '- [ ] B01\n');
  assert.equal(insertBugIntoActiveQueue('body', ''), 'body');
  assert.equal(insertBugIntoActiveQueue('body', null), 'body');
  // Entry without trailing newline gets one appended.
  const out = insertBugIntoActiveQueue('## Active queue\n\n- [ ] T99\n', '- [ ] B01 New bug');
  assert.match(out, /- \[ \] B01 New bug\n/);
  assert.ok(out.indexOf('- [ ] B01 New bug') < out.indexOf('- [ ] T99'));
});

test('insertBugIntoActiveQueue: inserts after the FIRST heading when multiple exist', () => {
  const body = [
    '## Active queue',
    '- [ ] T99 first',
    '',
    '## Active queue', // accidental duplicate
    '- [ ] T100 second',
  ].join('\n');
  const out = insertBugIntoActiveQueue(body, '- [ ] B01 New bug\n');
  const firstHeadingIdx = out.indexOf('## Active queue');
  const bugIdx = out.indexOf('- [ ] B01 New bug');
  const t99Idx = out.indexOf('- [ ] T99 first');
  const t100Idx = out.indexOf('- [ ] T100 second');
  // Bug sits after the FIRST heading, above T99.
  assert.ok(firstHeadingIdx >= 0 && bugIdx > firstHeadingIdx);
  assert.ok(bugIdx < t99Idx);
  assert.ok(t100Idx > bugIdx, 'T100 (after the second heading) stays below the bug');
});

// ───────────────────────────────────────────────────────────────────
//  appendBugToTodo — top-insert (regression tests for the
//  bridge-tops-into-EOF bug that affected B01 + B02)
// ───────────────────────────────────────────────────────────────────

test('appendBugToTodo: top-inserts under ## Active queue (not at EOF)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bugs-bridge-test-'));
  t._tmpDir = dir;
  const todoPath = join(dir, 'TODO.md');
  // Pre-seed TODO.md with a complete scaffold: a heading + an
  // existing T## bullet + a shipped section.
  const { writeFileSync } = await import('node:fs');
  writeFileSync(todoPath, [
    '# TODO',
    '',
    '## Active queue',
    '',
    '- [ ] T50 existing feature',
    '  In progress',
    '',
    '## Shipped',
    '',
    '- [x] T01 first feature',
    '',
  ].join('\n'));
  const store = new BugsStore({ file: join(dir, 'bugs.json') });
  await store.addBug(makeBug({ id: 'bug-x-20260915' }));
  await appendBugToTodo({
    bugsStore: store,
    todoPath,
    bug: await store.findById('bug-x-20260915'),
  });
  const body = readFileSync(todoPath, 'utf8');
  // Bug entry sits directly under the heading, BEFORE T50.
  const bugIdx = body.indexOf('- [ ] B01 Test bug');
  const t50Idx = body.indexOf('- [ ] T50 existing feature');
  const headingIdx = body.indexOf('## Active queue');
  assert.ok(bugIdx > headingIdx);
  assert.ok(bugIdx < t50Idx, 'B## entry must be top-inserted (above T50), not appended to EOF');
  // ## Shipped heading + its content are untouched and stay at the bottom.
  const shippedIdx = body.indexOf('## Shipped');
  const t01Idx = body.indexOf('- [x] T01 first feature');
  assert.ok(shippedIdx > bugIdx);
  assert.ok(t01Idx > shippedIdx);
  rmSync(dir, { recursive: true, force: true });
});

test('appendBugToTodo: appends (with leading blank line) when TODO.md has no ## Active queue heading', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bugs-bridge-test-'));
  t._tmpDir = dir;
  const todoPath = join(dir, 'TODO.md');
  const { writeFileSync } = await import('node:fs');
  // Pre-seed WITHOUT an ## Active queue heading.
  writeFileSync(todoPath, '- [ ] T99 orphan feature\n');
  const store = new BugsStore({ file: join(dir, 'bugs.json') });
  await store.addBug(makeBug({ id: 'bug-y-20260915' }));
  await appendBugToTodo({
    bugsStore: store,
    todoPath,
    bug: await store.findById('bug-y-20260915'),
  });
  const body = readFileSync(todoPath, 'utf8');
  const bugIdx = body.indexOf('- [ ] B01 Test bug');
  const t99Idx = body.indexOf('- [ ] T99 orphan feature');
  assert.ok(t99Idx >= 0 && bugIdx > t99Idx, 'falls back to append when no heading is found');
  rmSync(dir, { recursive: true, force: true });
});
