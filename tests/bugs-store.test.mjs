#!/usr/bin/env node
/**
 * Unit tests for src/bugs/store.mjs.
 *
 * Covers load / list / findById / addBug / addOperatorBug /
 * updateStatus / reorder / deleteBug / addNote. Uses a tmp
 * directory per test so the suite is parallel-safe (Node's
 * `--test` runs tests concurrently within a file by default
 * since v22).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BugsStore, emptyBugsFile } from '../src/bugs/store.mjs';

// Each test gets a fresh tmp directory so file-based writes don't
// leak across tests.
function makeStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bugs-store-test-'));
  t._tmpDir = dir;
  const file = join(dir, 'bugs.json');
  const store = new BugsStore({ file });
  return { store, file, dir };
}

const validBug = (overrides = {}) => ({
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
//  Constructor
// ───────────────────────────────────────────────────────────────────

test('BugsStore ctor requires file path', () => {
  assert.throws(() => new BugsStore({}), /file path required/);
  assert.throws(() => new BugsStore({ file: '' }), /file path required/);
  assert.throws(() => new BugsStore({ file: 123 }), /file path required/);
});

test('BugsStore ctor accepts an empty config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bugs-store-test-'));
  const store = new BugsStore({ file: join(dir, 'bugs.json') });
  assert.ok(store);
  rmSync(dir, { recursive: true, force: true });
});

// ───────────────────────────────────────────────────────────────────
//  load + addBug + list
// ───────────────────────────────────────────────────────────────────

test('load: returns empty default when file is missing', async (t) => {
  const { store } = makeStore(t);
  const file = await store.load();
  assert.equal(file.bugs.length, 0);
  assert.equal(file.meta.total_count, 0);
  // Should be deep-equal to the helper.
  assert.deepEqual(file, emptyBugsFile());
});

test('addBug: inserts and validates', async (t) => {
  const { store, file } = makeStore(t);
  const bug = await store.addBug(validBug());
  assert.equal(bug.id, 'bug-test-20260915');
  // Persisted on disk
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(onDisk.bugs.length, 1);
  assert.equal(onDisk.bugs[0].id, bug.id);
});

test('addBug: idempotent on duplicate id (returns existing)', async (t) => {
  const { store } = makeStore(t);
  const a = await store.addBug(validBug());
  const b = await store.addBug(validBug({ title: 'Different title' }));
  assert.equal(a.id, b.id);
  assert.equal(a.title, 'Test bug'); // original wins
});

test('addBug: rejects invalid shape', async (t) => {
  const { store } = makeStore(t);
  await assert.rejects(
    () => store.addBug({ ...validBug(), category: 'nonsense' }),
    /category must be one of/,
  );
});

test('list: returns bugs sorted by priority asc', async (t) => {
  const { store } = makeStore(t);
  await store.addBug(validBug({ id: 'a', priority: 5 }));
  await store.addBug(validBug({ id: 'b', priority: 0 }));
  await store.addBug(validBug({ id: 'c', priority: 10 }));
  const out = await store.list();
  assert.deepEqual(out.bugs.map((b) => b.id), ['b', 'a', 'c']);
});

test('list: filters compose with AND', async (t) => {
  const { store } = makeStore(t);
  await store.addBug(validBug({ id: 'a', status: 'open', category: 'ui' }));
  await store.addBug(validBug({ id: 'b', status: 'shipped', category: 'ui' }));
  await store.addBug(validBug({ id: 'c', status: 'open', category: 'data' }));
  const out = await store.list({ status: 'open', category: 'ui' });
  assert.deepEqual(out.bugs.map((b) => b.id), ['a']);
});

test('findById: returns bug or null', async (t) => {
  const { store } = makeStore(t);
  await store.addBug(validBug({ id: 'a' }));
  assert.ok(await store.findById('a'));
  assert.equal(await store.findById('zzz'), null);
});

// ───────────────────────────────────────────────────────────────────
//  addOperatorBug (slug id + auto-priority)
// ───────────────────────────────────────────────────────────────────

test('addOperatorBug: generates slug id + assigns next priority', async (t) => {
  const { store } = makeStore(t);
  const existing = await store.addBug(validBug({ id: 'bug-a-20260101', priority: 0 }));
  assert.equal(existing.priority, 0);
  const fresh = await store.addOperatorBug({
    title: 'Charts blank after refresh',
    description: 'the chart line is missing',
    author: 'operator',
  });
  assert.match(fresh.id, /^bug-charts-blank-after-refresh-\d{8}$/);
  // The new bug gets priority -1 (= lowest open - 1).
  assert.equal(fresh.priority, -1);
  // Author-recorded note
  assert.equal(fresh.notes.length, 1);
  assert.equal(fresh.notes[0].author, 'operator');
});

test('addOperatorBug: defaults priority to 0 when no open bugs', async (t) => {
  const { store } = makeStore(t);
  const fresh = await store.addOperatorBug({
    title: 'First bug',
    description: 'a bug',
  });
  assert.equal(fresh.priority, 0);
});

test('addOperatorBug: rejects empty title / description', async (t) => {
  const { store } = makeStore(t);
  await assert.rejects(() => store.addOperatorBug({ title: '', description: 'x' }), /title required/);
  await assert.rejects(() => store.addOperatorBug({ title: 'x', description: '' }), /description required/);
});

test('addOperatorBug: ignores shipped/wontfix when picking default priority', async (t) => {
  const { store } = makeStore(t);
  // Plenty of shipped bugs with low priorities, no open bugs.
  await store.addBug(validBug({ id: 'shipped-1', priority: -100, status: 'shipped' }));
  await store.addBug(validBug({ id: 'shipped-2', priority: -50, status: 'wontfix' }));
  const fresh = await store.addOperatorBug({ title: 'A', description: 'b' });
  assert.equal(fresh.priority, 0);
});

// ───────────────────────────────────────────────────────────────────
//  updateStatus
// ───────────────────────────────────────────────────────────────────

test('updateStatus: flip open → in_progress stamps updated_at', async (t) => {
  const { store } = makeStore(t);
  const bug = await store.addBug(validBug({ id: 'a' }));
  const updated = await store.updateStatus('a', 'in_progress', { author: 'op' });
  assert.equal(updated.status, 'in_progress');
  assert.notEqual(updated.updated_at, bug.updated_at);
  // The status transition is recorded as a note.
  assert.equal(updated.notes.length, 1);
  assert.equal(updated.notes[0].author, 'op');
  assert.match(updated.notes[0].body, /status: open → in_progress/);
});

test('updateStatus: shipped records shipped_in', async (t) => {
  const { store } = makeStore(t);
  await store.addBug(validBug({ id: 'a' }));
  const updated = await store.updateStatus('a', 'shipped', { shipped_in: 'abc123' });
  assert.equal(updated.status, 'shipped');
  assert.equal(updated.shipped_in, 'abc123');
});

test('updateStatus: shipped without shipped_in keeps the existing one', async (t) => {
  const { store } = makeStore(t);
  await store.addBug(validBug({ id: 'a', shipped_in: 'read' }));
  const updated = await store.updateStatus('a', 'shipped');
  assert.equal(updated.shipped_in, 'read');
});

test('updateStatus: rejects unknown status', async (t) => {
  const { store } = makeStore(t);
  await store.addBug(validBug({ id: 'a' }));
  await assert.rejects(() => store.updateStatus('a', 'unknown'), /bad status/);
});

test('updateStatus: throws BUG_NOT_FOUND on missing id', async (t) => {
  const { store } = makeStore(t);
  await assert.rejects(() => store.updateStatus('nope', 'shipped'), /not found/);
});

// ───────────────────────────────────────────────────────────────────
//  reorder
// ───────────────────────────────────────────────────────────────────

test('reorder: moves a bug to a new priority slot, renumbers neighbours', async (t) => {
  const { store } = makeStore(t);
  // Setup: open bugs at priorities 0, 1, 2, 3.
  await store.addBug(validBug({ id: 'a', priority: 0 }));
  await store.addBug(validBug({ id: 'b', priority: 1 }));
  await store.addBug(validBug({ id: 'c', priority: 2 }));
  await store.addBug(validBug({ id: 'd', priority: 3 }));
  // Move 'c' to priority 1 (between a and b).
  const moved = await store.reorder('c', 1);
  assert.equal(moved.id, 'c');
  assert.equal(moved.priority, 1);
  // All priorities still unique, contiguously renumbered 0..3.
  const out = await store.list();
  const byId = Object.fromEntries(out.bugs.map((b) => [b.id, b.priority]));
  assert.deepEqual(byId, { a: 0, c: 1, b: 2, d: 3 });
});

test('reorder: move to TOP (priority 0)', async (t) => {
  const { store } = makeStore(t);
  await store.addBug(validBug({ id: 'a', priority: 0 }));
  await store.addBug(validBug({ id: 'b', priority: 1 }));
  await store.addBug(validBug({ id: 'c', priority: 2 }));
  const moved = await store.reorder('c', 0);
  assert.equal(moved.priority, 0);
  const out = await store.list();
  assert.deepEqual(out.bugs.map((b) => b.id), ['c', 'a', 'b']);
});

test('reorder: move to BOTTOM (priority past end)', async (t) => {
  const { store } = makeStore(t);
  await store.addBug(validBug({ id: 'a', priority: 0 }));
  await store.addBug(validBug({ id: 'b', priority: 1 }));
  const moved = await store.reorder('a', 100);
  assert.equal(moved.priority, 100);
  const out = await store.list();
  assert.deepEqual(out.bugs.map((b) => b.id), ['b', 'a']);
});

test('reorder: refuses to reorder shipped / wontfix', async (t) => {
  const { store } = makeStore(t);
  await store.addBug(validBug({ id: 'a', status: 'shipped' }));
  await store.addBug(validBug({ id: 'b', status: 'wontfix' }));
  await assert.rejects(() => store.reorder('a', 0), /cannot reorder shipped/);
  await assert.rejects(() => store.reorder('b', 0), /cannot reorder wontfix/);
});

test('reorder: rejects non-integer newPriority', async (t) => {
  const { store } = makeStore(t);
  await store.addBug(validBug({ id: 'a' }));
  await assert.rejects(() => store.reorder('a', 1.5), /must be an integer/);
});

test('reorder: throws on missing id', async (t) => {
  const { store } = makeStore(t);
  await assert.rejects(() => store.reorder('nope', 0), /not found/);
});

// ───────────────────────────────────────────────────────────────────
//  deleteBug
// ───────────────────────────────────────────────────────────────────

test('deleteBug: removes from disk', async (t) => {
  const { store, file } = makeStore(t);
  await store.addBug(validBug({ id: 'a' }));
  await store.addBug(validBug({ id: 'b' }));
  const result = await store.deleteBug('a');
  assert.equal(result.deleted, true);
  const out = await store.load();
  assert.equal(out.bugs.length, 1);
  assert.equal(out.bugs[0].id, 'b');
  // Persisted
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(onDisk.bugs.length, 1);
});

test('deleteBug: idempotent (no-op on missing id)', async (t) => {
  const { store } = makeStore(t);
  const result = await store.deleteBug('nope');
  assert.equal(result.deleted, false);
});

// ───────────────────────────────────────────────────────────────────
//  addNote
// ───────────────────────────────────────────────────────────────────

test('addNote: appends to the bug.notes array', async (t) => {
  const { store } = makeStore(t);
  await store.addBug(validBug({ id: 'a' }));
  const updated = await store.addNote('a', { author: 'op', body: 'reproduced on mainnet' });
  assert.equal(updated.notes.length, 1);
  assert.equal(updated.notes[0].body, 'reproduced on mainnet');
});

test('addNote: rejects empty author / body', async (t) => {
  const { store } = makeStore(t);
  await store.addBug(validBug({ id: 'a' }));
  await assert.rejects(() => store.addNote('a', { author: '', body: 'x' }), /author required/);
  await assert.rejects(() => store.addNote('a', { author: 'op', body: '  ' }), /body required/);
});

test('addNote: throws on missing bug id', async (t) => {
  const { store } = makeStore(t);
  await assert.rejects(() => store.addNote('nope', { author: 'op', body: 'x' }), /not found/);
});
