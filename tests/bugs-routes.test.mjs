#!/usr/bin/env node
/**
 * Unit tests for src/bugs/routes.mjs.
 *
 * Routes are tested via direct handler invocation (no supertest).
 * Mirrors the pattern in tests/feature-ideas.test.mjs so the
 * route-test surface is uniform across tabs. Each test gets a
 * fresh tmp directory + store so they don't pollute each other.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BugsStore } from '../src/bugs/store.mjs';
import { buildBugRoutes } from '../src/bugs/routes.mjs';

async function makeTmp() {
  const dir = await mkdtemp(join(tmpdir(), 'bugs-routes-test-'));
  return {
    dir,
    file: join(dir, 'bugs.json'),
    cleanup: async () => { try { await rm(dir, { recursive: true, force: true }); } catch {} },
  };
}

function makeRoutes(store) {
  // Auth is gated by the dashboard server via `route.auth === true`;
  // the route handlers themselves don't check. Stub the logger so
  // the tests don't pollute stdout.
  const routes = buildBugRoutes({
    bugsStore: store,
    logger: { info() {}, warn() {}, error() {} },
  });
  const find = (method, path) => {
    const r = routes.find((x) => x.method === method && x.path === path);
    if (!r) throw new Error(`route not found: ${method} ${path}`);
    return r;
  };
  return { routes, find };
}

const mkBug = (overrides = {}) => ({
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
//  Routing table shape
// ───────────────────────────────────────────────────────────────────

test('buildBugRoutes: returns the expected 8 routes', async (t) => {
  const tmp = await makeTmp();
  const store = new BugsStore({ file: tmp.file });
  const { routes } = makeRoutes(store);
  assert.equal(routes.length, 8);
  const paths = routes.map((r) => r.method + ' ' + r.path).sort();
  assert.deepEqual(paths, [
    'DELETE /api/bugs/:bugId',
    'GET /api/bugs',
    'GET /api/bugs/:bugId',
    'GET /api/bugs/meta',
    'POST /api/bugs',
    'POST /api/bugs/:bugId/notes',
    'POST /api/bugs/:bugId/reorder',
    'POST /api/bugs/:bugId/status',
  ]);
  // Mutating routes are auth-gated.
  for (const r of routes.filter((x) => x.method !== 'GET')) {
    assert.equal(r.auth, true, `${r.method} ${r.path} must be auth-gated`);
  }
  await tmp.cleanup();
});

test('buildBugRoutes: requires bugsStore + throws on missing', () => {
  assert.throws(() => buildBugRoutes({}), /bugsStore required/);
});

// ───────────────────────────────────────────────────────────────────
//  GET /api/bugs
// ───────────────────────────────────────────────────────────────────

test('GET /api/bugs: empty list', async (t) => {
  const tmp = await makeTmp();
  const store = new BugsStore({ file: tmp.file });
  const { find } = makeRoutes(store);
  const out = await find('GET', '/api/bugs').handler({}, {}, new URL('http://x/api/bugs'), null);
  assert.deepEqual(out.ideas ?? out.bugs, []);
  assert.equal(out.meta.total_count, 0);
  await tmp.cleanup();
});

test('GET /api/bugs: lists + filters compose', async (t) => {
  const tmp = await makeTmp();
  const store = new BugsStore({ file: tmp.file });
  await store.addBug(mkBug({ id: 'a', status: 'open', category: 'ui' }));
  await store.addBug(mkBug({ id: 'b', status: 'shipped', category: 'ui' }));
  await store.addBug(mkBug({ id: 'c', status: 'open', category: 'data' }));
  const { find } = makeRoutes(store);
  const out = await find('GET', '/api/bugs').handler({}, {}, new URL('http://x/api/bugs?status=open&category=ui'), null);
  assert.deepEqual(out.bugs.map((b) => b.id), ['a']);
  await tmp.cleanup();
});

// ───────────────────────────────────────────────────────────────────
//  GET /api/bugs/meta
// ───────────────────────────────────────────────────────────────────

test('GET /api/bugs/meta: counters + next/highest priority', async (t) => {
  const tmp = await makeTmp();
  const store = new BugsStore({ file: tmp.file });
  await store.addBug(mkBug({ id: 'a', priority: 0 }));
  await store.addBug(mkBug({ id: 'b', priority: -3 }));
  const { find } = makeRoutes(store);
  const out = await find('GET', '/api/bugs/meta').handler({}, {}, new URL('http://x/api/bugs/meta'), null);
  assert.equal(out.total_count, 2);
  assert.equal(out.open_count, 2);
  assert.equal(out.highest_priority, -3);
  assert.equal(out.next_priority, -4);
  await tmp.cleanup();
});

// ───────────────────────────────────────────────────────────────────
//  GET /api/bugs/:bugId
// ───────────────────────────────────────────────────────────────────

test('GET /api/bugs/:bugId: returns the bug', async (t) => {
  const tmp = await makeTmp();
  const store = new BugsStore({ file: tmp.file });
  await store.addBug(mkBug({ id: 'a' }));
  const { find } = makeRoutes(store);
  const out = await find('GET', '/api/bugs/:bugId').handler({}, { bugId: 'a' }, new URL('http://x/api/bugs/a'), null);
  assert.equal(out.id, 'a');
  await tmp.cleanup();
});

test('GET /api/bugs/:bugId: 404 on missing', async (t) => {
  const tmp = await makeTmp();
  const store = new BugsStore({ file: tmp.file });
  const { find } = makeRoutes(store);
  await assert.rejects(
    find('GET', '/api/bugs/:bugId').handler({}, { bugId: 'nope' }, new URL('http://x/api/bugs/nope'), null),
    (e) => e.statusCode === 404,
  );
  await tmp.cleanup();
});

// ───────────────────────────────────────────────────────────────────
//  POST /api/bugs
// ───────────────────────────────────────────────────────────────────

test('POST /api/bugs: creates a bug with auto-priority', async (t) => {
  const tmp = await makeTmp();
  const store = new BugsStore({ file: tmp.file });
  const { find } = makeRoutes(store);
  // Pre-seed one open bug at priority 0.
  await store.addBug(mkBug({ id: 'bug-pre-20260101', priority: 0 }));
  const out = await find('POST', '/api/bugs').handler({}, {}, new URL('http://x/api/bugs'), {
    title: 'Charts blank after refresh',
    description: 'The line is missing.',
    category: 'ui',
    severity: 'high',
    author: 'op',
  });
  assert.match(out.id, /^bug-charts-blank-after-refresh-\d{8}$/);
  assert.equal(out.priority, -1);
  assert.equal(out.notes.length, 1);
  assert.equal(out.notes[0].author, 'op');
  await tmp.cleanup();
});

test('POST /api/bugs: rejects empty title', async (t) => {
  const tmp = await makeTmp();
  const store = new BugsStore({ file: tmp.file });
  const { find } = makeRoutes(store);
  await assert.rejects(
    find('POST', '/api/bugs').handler({}, {}, new URL('http://x/api/bugs'), {
      title: '   ',
      description: 'x',
    }),
    (e) => e.statusCode === 400 && /title required/.test(e.message),
  );
  await tmp.cleanup();
});

test('POST /api/bugs: rejects bad category', async (t) => {
  const tmp = await makeTmp();
  const store = new BugsStore({ file: tmp.file });
  const { find } = makeRoutes(store);
  await assert.rejects(
    find('POST', '/api/bugs').handler({}, {}, new URL('http://x/api/bugs'), {
      title: 'x', description: 'y', category: 'nonsense',
    }),
    (e) => e.statusCode === 400 && /category must be one of/.test(e.message),
  );
  await tmp.cleanup();
});

// ───────────────────────────────────────────────────────────────────
//  POST /api/bugs/:bugId/status
// ───────────────────────────────────────────────────────────────────

test('POST /api/bugs/:bugId/status: flips status', async (t) => {
  const tmp = await makeTmp();
  const store = new BugsStore({ file: tmp.file });
  await store.addBug(mkBug({ id: 'a' }));
  const { find } = makeRoutes(store);
  const out = await find('POST', '/api/bugs/:bugId/status').handler({}, { bugId: 'a' }, null, {
    status: 'shipped',
    shipped_in: 'abc123',
  });
  assert.equal(out.status, 'shipped');
  assert.equal(out.shipped_in, 'abc123');
  await tmp.cleanup();
});

test('POST /api/bugs/:bugId/status: rejects unknown status', async (t) => {
  const tmp = await makeTmp();
  const store = new BugsStore({ file: tmp.file });
  await store.addBug(mkBug({ id: 'a' }));
  const { find } = makeRoutes(store);
  await assert.rejects(
    find('POST', '/api/bugs/:bugId/status').handler({}, { bugId: 'a' }, null, { status: 'unknown' }),
    (e) => e.statusCode === 400,
  );
  await tmp.cleanup();
});

// ───────────────────────────────────────────────────────────────────
//  POST /api/bugs/:bugId/reorder
// ───────────────────────────────────────────────────────────────────

test('POST /api/bugs/:bugId/reorder: moves a bug', async (t) => {
  const tmp = await makeTmp();
  const store = new BugsStore({ file: tmp.file });
  await store.addBug(mkBug({ id: 'a', priority: 0 }));
  await store.addBug(mkBug({ id: 'b', priority: 1 }));
  const { find } = makeRoutes(store);
  const out = await find('POST', '/api/bugs/:bugId/reorder').handler({}, { bugId: 'b' }, null, { new_priority: 0 });
  assert.equal(out.priority, 0);
  await tmp.cleanup();
});

test('POST /api/bugs/:bugId/reorder: rejects non-integer new_priority', async (t) => {
  const tmp = await makeTmp();
  const store = new BugsStore({ file: tmp.file });
  await store.addBug(mkBug({ id: 'a' }));
  const { find } = makeRoutes(store);
  await assert.rejects(
    find('POST', '/api/bugs/:bugId/reorder').handler({}, { bugId: 'a' }, null, { new_priority: 1.5 }),
    (e) => e.statusCode === 400 && /new_priority must be an integer/.test(e.message),
  );
  await tmp.cleanup();
});

// ───────────────────────────────────────────────────────────────────
//  POST /api/bugs/:bugId/notes
// ───────────────────────────────────────────────────────────────────

test('POST /api/bugs/:bugId/notes: appends a note', async (t) => {
  const tmp = await makeTmp();
  const store = new BugsStore({ file: tmp.file });
  await store.addBug(mkBug({ id: 'a' }));
  const { find } = makeRoutes(store);
  const out = await find('POST', '/api/bugs/:bugId/notes').handler({}, { bugId: 'a' }, null, {
    author: 'op',
    body: 'reproduced on mainnet',
  });
  assert.equal(out.notes.length, 1);
  assert.equal(out.notes[0].body, 'reproduced on mainnet');
  await tmp.cleanup();
});

test('POST /api/bugs/:bugId/notes: rejects empty body', async (t) => {
  const tmp = await makeTmp();
  const store = new BugsStore({ file: tmp.file });
  await store.addBug(mkBug({ id: 'a' }));
  const { find } = makeRoutes(store);
  await assert.rejects(
    find('POST', '/api/bugs/:bugId/notes').handler({}, { bugId: 'a' }, null, { author: 'op', body: '' }),
    (e) => e.statusCode === 400,
  );
  await tmp.cleanup();
});

// ───────────────────────────────────────────────────────────────────
//  DELETE /api/bugs/:bugId
// ───────────────────────────────────────────────────────────────────

test('DELETE /api/bugs/:bugId: removes the bug', async (t) => {
  const tmp = await makeTmp();
  const store = new BugsStore({ file: tmp.file });
  await store.addBug(mkBug({ id: 'a' }));
  await store.addBug(mkBug({ id: 'b' }));
  const { find } = makeRoutes(store);
  const out = await find('DELETE', '/api/bugs/:bugId').handler({}, { bugId: 'a' }, null, null);
  assert.equal(out.deleted, true);
  const remaining = await store.load();
  assert.equal(remaining.bugs.length, 1);
  await tmp.cleanup();
});

test('DELETE /api/bugs/:bugId: 404 on missing', async (t) => {
  const tmp = await makeTmp();
  const store = new BugsStore({ file: tmp.file });
  const { find } = makeRoutes(store);
  await assert.rejects(
    find('DELETE', '/api/bugs/:bugId').handler({}, { bugId: 'nope' }, null, null),
    (e) => e.statusCode === 404,
  );
  await tmp.cleanup();
});
