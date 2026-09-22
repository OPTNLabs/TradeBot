#!/usr/bin/env node
// tests/feature-ideas.test.mjs
//
// Unit tests for the feature-ideas store + schema + supervisor
// bridge. Mirrors the patterns in tests/positions.test.mjs — every
// test gets a fresh tmp directory so they don't pollute each
// other's on-disk state.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FeatureIdeasStore,
  emptyFeatureIdeasFile,
  freshResearchStamp,
} from '../src/feature-ideas/store.mjs';
import {
  validateIdea,
  validateFeatureIdeasFile,
  buildMeta,
  FEATURE_IDEAS_VERSION,
  FEATURE_IDEAS_CATEGORIES,
  slugify,
  operatorIdeaIdForTitle,
} from '../src/feature-ideas/schema.mjs';
import {
  nextTodoId,
  buildTodoEntry,
  appendApprovedIdeaToTodo,
} from '../src/feature-ideas/supervisor-bridge.mjs';
import {
  buildFeatureIdeaRoutes,
} from '../src/feature-ideas/routes.mjs';

// ─────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────

/** Make a fresh tmp dir for one test; returns { dir, cleanup }. */
async function makeTmp() {
  const dir = await mkdtemp(join(tmpdir(), 'feat-ideas-test-'));
  return {
    dir,
    file: join(dir, 'feature-ideas.json'),
    cleanup: async () => { try { await rm(dir, { recursive: true, force: true }); } catch {} },
  };
}

/** Validate a raw idea object; returns the frozen validated idea. */
function mkIdea(overrides = {}) {
  return validateIdea({
    id: overrides.id ?? 'idea_test_1',
    title: overrides.title ?? 'Test idea',
    category: overrides.category ?? 'edge-case-protection',
    rationale: overrides.rationale ?? 'because',
    evidence: overrides.evidence ?? '',
    effort: overrides.effort ?? 'S',
    impact: overrides.impact ?? 'medium',
    source: overrides.source ?? 'seed',
    status: overrides.status ?? 'pending',
    created_at: overrides.created_at ?? new Date().toISOString(),
    updated_at: overrides.updated_at ?? new Date().toISOString(),
    notes: overrides.notes ?? [],
    category_tags: overrides.category_tags ?? ['test'],
    shipped_in: overrides.shipped_in ?? null,
  });
}

// ─────────────────────────────────────────────────────────────────────
//  schema
// ─────────────────────────────────────────────────────────────────────

test('schema: validateIdea accepts a well-formed idea', () => {
  const idea = mkIdea();
  assert.equal(idea.id, 'idea_test_1');
  assert.equal(idea.status, 'pending');
});

test('schema: validateIdea rejects missing title', () => {
  assert.throws(
    () => validateIdea({ ...mkIdea(), title: '' }),
    /title must be a non-empty string/,
  );
});

test('schema: validateIdea rejects bad category', () => {
  assert.throws(
    () => validateIdea({ ...mkIdea(), category: 'spam' }),
    /category must be one of/,
  );
});

test('schema: validateIdea rejects bad effort', () => {
  assert.throws(
    () => validateIdea({ ...mkIdea(), effort: 'XL' }),
    /effort must be one of S, M, L/,
  );
});

test('schema: validateIdea rejects bad status', () => {
  assert.throws(
    () => validateIdea({ ...mkIdea(), status: 'in_progress' }),
    /status must be one of/,
  );
});

test('schema: validateIdea accepts note with `message` as alias for `body` (legacy stamp shape)', () => {
  // Forward-compat: an earlier supervisor commit wrote notes with
  // a `message` field instead of the schema-required `body`. The
  // validator mutates `body` to `message` so the dashboard's
  // Proposals tab can render the note text. See src/feature-ideas/schema.mjs.
  const raw = {
    id: 'idea_msg_alias',
    title: 'Test',
    category: 'edge-case-protection',
    rationale: 'because',
    evidence: '',
    effort: 'S',
    impact: 'medium',
    source: 'seed',
    status: 'pending',
    created_at: '2026-09-19T23:16:56Z',
    updated_at: '2026-09-19T23:16:56Z',
    notes: [{
      ts: '2026-09-19T23:16:56Z',
      author: 'tradebot-supervisor',
      kind: 'stamp_shipped',
      commit: 'deadbee',
      message: 'queued as T71',
    }],
    category_tags: ['test'],
    shipped_in: null,
  };
  const idea = validateIdea(raw);
  assert.equal(idea.notes.length, 1);
  assert.equal(idea.notes[0].body, 'queued as T71');
  // Mutation side-effect: the input object's note.body was set
  // to the alias value too (the validator doesn't deep-clone).
  assert.equal(raw.notes[0].body, 'queued as T71');
  // Other fields pass through unchanged.
  assert.equal(idea.notes[0].kind, 'stamp_shipped');
  assert.equal(idea.notes[0].commit, 'deadbee');
});

test('schema: validateIdea prefers existing `body` over `message` alias', () => {
  // When both fields are present, `body` wins (the alias is only
  // consulted when body is missing/non-string). This protects
  // notes that were correctly written as `body` from being
  // overwritten by a stray `message` field.
  const raw = {
    id: 'idea_msg_body_wins',
    title: 'Test',
    category: 'edge-case-protection',
    rationale: 'because',
    evidence: '',
    effort: 'S',
    impact: 'medium',
    source: 'seed',
    status: 'pending',
    created_at: '2026-09-19T23:16:56Z',
    updated_at: '2026-09-19T23:16:56Z',
    notes: [{
      ts: '2026-09-19T23:16:56Z',
      author: 'x',
      body: 'real body text',
      message: 'stale message text',
    }],
    category_tags: ['test'],
    shipped_in: null,
  };
  const idea = validateIdea(raw);
  assert.equal(idea.notes[0].body, 'real body text');
});

test('schema: validateIdea rejects note when both `body` and `message` are missing', () => {
  const raw = {
    id: 'idea_no_body_no_msg',
    title: 'Test',
    category: 'edge-case-protection',
    rationale: 'because',
    evidence: '',
    effort: 'S',
    impact: 'medium',
    source: 'seed',
    status: 'pending',
    created_at: '2026-09-19T23:16:56Z',
    updated_at: '2026-09-19T23:16:56Z',
    notes: [{ ts: '2026-09-19T23:16:56Z', author: 'x' }],
    category_tags: ['test'],
    shipped_in: null,
  };
  assert.throws(
    () => validateIdea(raw),
    /note\.body must be a string/,
  );
});

test('schema: validateIdea rejects note when `message` is empty string', () => {
  // Empty `message` is treated the same as missing — the alias
  // fallback only fires for non-empty strings.
  const raw = {
    id: 'idea_empty_msg',
    title: 'Test',
    category: 'edge-case-protection',
    rationale: 'because',
    evidence: '',
    effort: 'S',
    impact: 'medium',
    source: 'seed',
    status: 'pending',
    created_at: '2026-09-19T23:16:56Z',
    updated_at: '2026-09-19T23:16:56Z',
    notes: [{
      ts: '2026-09-19T23:16:56Z',
      author: 'x',
      message: '',
    }],
    category_tags: ['test'],
    shipped_in: null,
  };
  assert.throws(
    () => validateIdea(raw),
    /note\.body must be a string/,
  );
});

test('schema: emptyFeatureIdeasFile returns version=1 + zero counts', () => {
  const f = emptyFeatureIdeasFile();
  assert.equal(f.version, FEATURE_IDEAS_VERSION);
  assert.equal(f.meta.total_count, 0);
  assert.equal(f.meta.pending_count, 0);
  assert.equal(f.meta.last_research_at, null);
});

test('schema: buildMeta counts correctly across statuses', () => {
  const ideas = [
    mkIdea({ id: 'a', status: 'pending' }),
    mkIdea({ id: 'b', status: 'approved' }),
    mkIdea({ id: 'c', status: 'rejected' }),
    mkIdea({ id: 'd', status: 'shipped' }),
    mkIdea({ id: 'e', status: 'shipped' }),
  ];
  const meta = buildMeta(ideas);
  assert.equal(meta.total_count, 5);
  assert.equal(meta.pending_count, 1);
  assert.equal(meta.approved_count, 1);
  assert.equal(meta.rejected_count, 1);
  assert.equal(meta.shipped_count, 2);
});

// ─────────────────────────────────────────────────────────────────────
//  store: load / addIdeas / updateStatus / addNote
// ─────────────────────────────────────────────────────────────────────

test('store: load on missing file creates empty store', async (t) => {
  const tmp = await makeTmp();
  t.after(() => tmp.cleanup());
  const store = new FeatureIdeasStore({ file: tmp.file });
  const f = await store.load();
  assert.equal(f.meta.total_count, 0);
});

test('store: addIdeas is idempotent by id', async (t) => {
  const tmp = await makeTmp();
  t.after(() => tmp.cleanup());
  const store = new FeatureIdeasStore({ file: tmp.file });
  await store.load();
  const a = mkIdea({ id: 'idea_x' });
  const b = mkIdea({ id: 'idea_y' });
  const r1 = await store.addIdeas([a, b], { source: 'seed' });
  assert.equal(r1.added, 2);
  assert.equal(r1.skipped, 0);
  // Re-add: both should be skipped.
  const r2 = await store.addIdeas([a, b], { source: 'seed' });
  assert.equal(r2.added, 0);
  assert.equal(r2.skipped, 2);
});

test('store: addIdeas stamps status=pending, source, timestamps', async (t) => {
  const tmp = await makeTmp();
  t.after(() => tmp.cleanup());
  const store = new FeatureIdeasStore({ file: tmp.file });
  await store.load();
  const before = Date.now();
  const r = await store.addIdeas([mkIdea({ id: 'idea_z' })], { source: 'cron' });
  const after = Date.now();
  const idea = r.file.ideas[0];
  assert.equal(idea.status, 'pending');
  assert.equal(idea.source, 'cron');
  const createdMs = Date.parse(idea.created_at);
  assert.ok(createdMs >= before && createdMs <= after);
});

test('store: updateStatus flips pending → approved and updates meta', async (t) => {
  const tmp = await makeTmp();
  t.after(() => tmp.cleanup());
  const store = new FeatureIdeasStore({ file: tmp.file });
  await store.load();
  await store.addIdeas([mkIdea({ id: 'idea_flip' })]);
  const f = await store.updateStatus('idea_flip', 'approved');
  assert.equal(f.ideas[0].status, 'approved');
  assert.equal(f.meta.pending_count, 0);
  assert.equal(f.meta.approved_count, 1);
});

test('store: updateStatus → shipped records shipped_in', async (t) => {
  const tmp = await makeTmp();
  t.after(() => tmp.cleanup());
  const store = new FeatureIdeasStore({ file: tmp.file });
  await store.load();
  await store.addIdeas([mkIdea({ id: 'idea_ship' })]);
  const f = await store.updateStatus('idea_ship', 'shipped', { shipped_in: 'abc1234' });
  assert.equal(f.ideas[0].status, 'shipped');
  assert.equal(f.ideas[0].shipped_in, 'abc1234');
  assert.equal(f.meta.shipped_count, 1);
});

test('store: updateStatus with unknown id throws IDEA_NOT_FOUND', async (t) => {
  const tmp = await makeTmp();
  t.after(() => tmp.cleanup());
  const store = new FeatureIdeasStore({ file: tmp.file });
  await store.load();
  await assert.rejects(
    () => store.updateStatus('idea_does_not_exist', 'approved'),
    (e) => e?.code === 'IDEA_NOT_FOUND',
  );
});

test('store: addNote appends to notes[] and updates updated_at', async (t) => {
  const tmp = await makeTmp();
  t.after(() => tmp.cleanup());
  const store = new FeatureIdeasStore({ file: tmp.file });
  await store.load();
  await store.addIdeas([mkIdea({ id: 'idea_note' })]);
  const noteTs = '2026-09-14T01:00:00.000Z';
  const f = await store.addNote('idea_note', {
    ts: noteTs, author: 'tester', body: 'looks good',
  });
  const idea = f.ideas[0];
  assert.equal(idea.notes.length, 1);
  assert.equal(idea.notes[0].body, 'looks good');
  assert.equal(idea.updated_at, noteTs);
});

test('store: addNote with bad body throws', async (t) => {
  const tmp = await makeTmp();
  t.after(() => tmp.cleanup());
  const store = new FeatureIdeasStore({ file: tmp.file });
  await store.load();
  await store.addIdeas([mkIdea({ id: 'idea_note2' })]);
  await assert.rejects(
    () => store.addNote('idea_note2', { ts: 'x', author: 'y', body: '' }),
    /note.body must be a non-empty string/,
  );
});

test('store: stampLastResearch updates meta without touching ideas', async (t) => {
  const tmp = await makeTmp();
  t.after(() => tmp.cleanup());
  const store = new FeatureIdeasStore({ file: tmp.file });
  await store.load();
  await store.addIdeas([mkIdea({ id: 'idea_stamp' })]);
  const before = await store.meta();
  assert.equal(before.last_research_at, null);
  const after = await store.stampLastResearch(new Date('2026-09-14T02:00:00Z'));
  assert.equal(after.meta.last_research_at, '2026-09-14T02:00:00.000Z');
  assert.equal(after.meta.total_count, 1); // ideas unchanged
});

test('store: persistence round-trip (writes survive reload)', async (t) => {
  const tmp = await makeTmp();
  t.after(() => tmp.cleanup());
  const store1 = new FeatureIdeasStore({ file: tmp.file });
  await store1.load();
  await store1.addIdeas([mkIdea({ id: 'idea_round' })]);
  const store2 = new FeatureIdeasStore({ file: tmp.file });
  const f = await store2.load();
  assert.equal(f.ideas[0].id, 'idea_round');
});

test('store: freshResearchStamp stamps meta to a passed-in Date', () => {
  const d = new Date('2026-09-14T03:00:00Z');
  const stamped = freshResearchStamp(d);
  assert.equal(stamped.last_research_at, '2026-09-14T03:00:00.000Z');
  assert.equal(stamped.total_count, 0);
});

// ─────────────────────────────────────────────────────────────────────
//  supervisor-bridge
// ─────────────────────────────────────────────────────────────────────

test('supervisor-bridge: nextTodoId returns 1 on empty body', () => {
  assert.equal(nextTodoId(''), 1);
});

test('supervisor-bridge: nextTodoId returns max+1', () => {
  const body = '- [ ] T01 foo\n- [x] T02 bar\n- [ ] T03 baz\n';
  assert.equal(nextTodoId(body), 4);
});

test('supervisor-bridge: nextTodoId matches [x] (shipped) entries too', () => {
  // Production case: every prior entry is shipped. The regex
  // must still pick the highest existing id + 1.
  const body = '- [x] T01 foo\n- [x] T02 bar\n- [x] T28b shipped\n';
  assert.equal(nextTodoId(body), 29);
});

test('supervisor-bridge: nextTodoId ignores non-T-prefixed numbered lines', () => {
  const body = '- [x] T01 foo\nrandom "T99" quoted string\n- [x] T05 bar\n';
  assert.equal(nextTodoId(body), 6);
});

test('supervisor-bridge: nextTodoId ignores other bullet styles', () => {
  const body = '* [x] T01 foo\n+ [x] T05 bar\n- [x] T10 baz\n';
  assert.equal(nextTodoId(body), 11);
});

test('supervisor-bridge: buildTodoEntry has all expected fields', () => {
  const idea = mkIdea({
    id: 'idea_test_xyz',
    title: 'Test feature',
    rationale: 'because',
    evidence: 'see QBTC',
    effort: 'S',
    impact: 'high',
    category: 'edge-case-protection',
  });
  const entry = buildTodoEntry(idea, 42);
  assert.match(entry, /^- \[ \] T42 Test feature/);
  assert.match(entry, /\[USER-APPROVED from feature-ideas idea_test_xyz\]/);
  assert.match(entry, /^  because$/m);
  assert.match(entry, /^  Evidence: see QBTC$/m);
  assert.match(entry, /^  Effort: S\.  Impact: high\.  Category: edge-case-protection\.$/m);
});

test('supervisor-bridge: appendApprovedIdeaToTodo appends to existing TODO.md', async (t) => {
  const tmp = await makeTmp();
  t.after(() => tmp.cleanup());
  const todoPath = join(tmp.dir, 'TODO.md');
  await writeFile(todoPath, '- [ ] T01 prior work\n', 'utf8');
  const idea = mkIdea({ id: 'idea_app_1', title: 'Brand new feature' });
  const { todoId } = await appendApprovedIdeaToTodo({ todoPath, idea });
  assert.equal(todoId, 2);
  const body = await readFile(todoPath, 'utf8');
  assert.match(body, /^- \[ \] T01 prior work/);
  assert.match(body, /^- \[ \] T02 Brand new feature \[USER-APPROVED from feature-ideas idea_app_1\]/m);
});

test('supervisor-bridge: appendApprovedIdeaToTodo handles missing TODO.md', async (t) => {
  const tmp = await makeTmp();
  t.after(() => tmp.cleanup());
  const todoPath = join(tmp.dir, 'TODO.md');
  const idea = mkIdea({ id: 'idea_app_2', title: 'First ever entry' });
  const { todoId } = await appendApprovedIdeaToTodo({ todoPath, idea });
  assert.equal(todoId, 1);
  const body = await readFile(todoPath, 'utf8');
  assert.match(body, /First ever entry/);
});

// ─────────────────────────────────────────────────────────────────────
//  routes
// ─────────────────────────────────────────────────────────────────────

function makeRouteTestCtx(store, todoPath) {
  return {
    store,
    todoPath,
    featureIdeasStore: store,
    featureIdeasTodoPath: todoPath,
    logger: { info() {}, warn() {}, error() {} },
  };
}

test('routes: GET /api/feature-ideas lists all ideas', async (t) => {
  const tmp = await makeTmp();
  t.after(() => tmp.cleanup());
  const store = new FeatureIdeasStore({ file: tmp.file });
  await store.load();
  await store.addIdeas([mkIdea({ id: 'a' }), mkIdea({ id: 'b' })]);
  const routes = buildFeatureIdeaRoutes(makeRouteTestCtx(store, join(tmp.dir, 'TODO.md')));
  const handler = routes.find((r) => r.path === '/api/feature-ideas').handler;
  const out = await handler({}, {}, new URL('http://x/api/feature-ideas'), null);
  assert.equal(out.ideas.length, 2);
  assert.equal(out.meta.total_count, 2);
});

test('routes: GET /api/feature-ideas?status=approved filters', async (t) => {
  const tmp = await makeTmp();
  t.after(() => tmp.cleanup());
  const store = new FeatureIdeasStore({ file: tmp.file });
  await store.load();
  await store.addIdeas([mkIdea({ id: 'a' })]);
  await store.updateStatus('a', 'approved');
  await store.addIdeas([mkIdea({ id: 'b' })]);
  const routes = buildFeatureIdeaRoutes(makeRouteTestCtx(store, join(tmp.dir, 'TODO.md')));
  const handler = routes.find((r) => r.path === '/api/feature-ideas').handler;
  const out = await handler({}, {}, new URL('http://x/api/feature-ideas?status=approved'), null);
  assert.equal(out.ideas.length, 1);
  assert.equal(out.ideas[0].id, 'a');
});

test('routes: GET /api/feature-ideas/:ideaId returns 404 for unknown id', async (t) => {
  const tmp = await makeTmp();
  t.after(() => tmp.cleanup());
  const store = new FeatureIdeasStore({ file: tmp.file });
  await store.load();
  const routes = buildFeatureIdeaRoutes(makeRouteTestCtx(store, join(tmp.dir, 'TODO.md')));
  const handler = routes.find((r) => r.path === '/api/feature-ideas/:ideaId').handler;
  await assert.rejects(
    () => handler({}, { ideaId: 'nope' }, new URL('http://x/api/feature-ideas/nope'), null),
    (e) => e.statusCode === 404,
  );
});

test('routes: POST status=approved appends TODO.md entry', async (t) => {
  const tmp = await makeTmp();
  t.after(() => tmp.cleanup());
  const store = new FeatureIdeasStore({ file: tmp.file });
  await store.load();
  await store.addIdeas([mkIdea({ id: 'idea_approve_me', title: 'Approve me' })]);
  const todoPath = join(tmp.dir, 'TODO.md');
  await writeFile(todoPath, '- [ ] T01 prior\n', 'utf8');
  const routes = buildFeatureIdeaRoutes(makeRouteTestCtx(store, todoPath));
  const handler = routes.find((r) => r.path === '/api/feature-ideas/:ideaId/status').handler;
  const out = await handler({}, { ideaId: 'idea_approve_me' }, new URL('http://x'), { status: 'approved' });
  assert.equal(out.idea.status, 'approved');
  assert.equal(out.todo.appended, true);
  assert.equal(out.todo.todoId, 2);
  const body = await readFile(todoPath, 'utf8');
  assert.match(body, /^- \[ \] T02 Approve me/m);
});

test('routes: POST status=rejected does NOT append TODO.md', async (t) => {
  const tmp = await makeTmp();
  t.after(() => tmp.cleanup());
  const store = new FeatureIdeasStore({ file: tmp.file });
  await store.load();
  await store.addIdeas([mkIdea({ id: 'idea_rej' })]);
  const todoPath = join(tmp.dir, 'TODO.md');
  await writeFile(todoPath, '- [ ] T01 prior\n', 'utf8');
  const routes = buildFeatureIdeaRoutes(makeRouteTestCtx(store, todoPath));
  const handler = routes.find((r) => r.path === '/api/feature-ideas/:ideaId/status').handler;
  const out = await handler({}, { ideaId: 'idea_rej' }, new URL('http://x'), { status: 'rejected' });
  assert.equal(out.idea.status, 'rejected');
  assert.equal(out.todo, null);
  const body = await readFile(todoPath, 'utf8');
  assert.ok(!body.includes('idea_rej'), 'rejected idea must NOT be in TODO.md');
});

test('routes: POST status with bad body throws 400', async (t) => {
  const tmp = await makeTmp();
  t.after(() => tmp.cleanup());
  const store = new FeatureIdeasStore({ file: tmp.file });
  await store.load();
  await store.addIdeas([mkIdea({ id: 'idea_bad' })]);
  const routes = buildFeatureIdeaRoutes(makeRouteTestCtx(store, join(tmp.dir, 'TODO.md')));
  const handler = routes.find((r) => r.path === '/api/feature-ideas/:ideaId/status').handler;
  await assert.rejects(
    () => handler({}, { ideaId: 'idea_bad' }, new URL('http://x'), { status: 'invalid' }),
    (e) => e.statusCode === 400,
  );
});

test('routes: POST /notes appends a note', async (t) => {
  const tmp = await makeTmp();
  t.after(() => tmp.cleanup());
  const store = new FeatureIdeasStore({ file: tmp.file });
  await store.load();
  await store.addIdeas([mkIdea({ id: 'idea_n' })]);
  const routes = buildFeatureIdeaRoutes(makeRouteTestCtx(store, join(tmp.dir, 'TODO.md')));
  const handler = routes.find((r) => r.path === '/api/feature-ideas/:ideaId/notes').handler;
  const out = await handler({}, { ideaId: 'idea_n' }, new URL('http://x'), {
    body: 'investigation note', author: 'tester',
  });
  assert.equal(out.idea.notes.length, 1);
  assert.equal(out.idea.notes[0].body, 'investigation note');
});

// ─────────────────────────────────────────────────────────────────────
//  seed integration
// ─────────────────────────────────────────────────────────────────────

test('seed: SEED_FEATURE_IDEAS all validate', async () => {
  const seedMod = await import('../src/feature-ideas/seed.mjs');
  const { SEED_FEATURE_IDEAS } = seedMod;
  assert.ok(SEED_FEATURE_IDEAS.length >= 10, 'expect at least 10 seed ideas');
  for (const raw of SEED_FEATURE_IDEAS) {
    const stamped = {
      ...raw,
      status: 'pending',
      source: 'seed',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      notes: [],
    };
    const v = validateIdea(stamped);
    assert.ok(FEATURE_IDEAS_CATEGORIES.includes(v.category), `bad category for ${v.id}`);
    assert.ok(['S', 'M', 'L'].includes(v.effort), `bad effort for ${v.id}`);
    assert.ok(['low', 'medium', 'high'].includes(v.impact), `bad impact for ${v.id}`);
    assert.ok(v.title.length > 0 && v.title.length < 200, `bad title length for ${v.id}`);
    assert.ok(v.rationale.length > 20, `rationale too short for ${v.id}`);
    assert.ok(v.evidence.length > 20, `evidence too short for ${v.id}`);
  }
});

// ─────────────────────────────────────────────────────────────────────
//  slugify + operatorIdeaIdForTitle (T30+ feature — operator create)
// ─────────────────────────────────────────────────────────────────────

test('slugify: lowercases + strips non-alphanumeric + collapses dashes', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
  assert.equal(slugify('  Multiple   spaces  '), 'multiple-spaces');
});

test('slugify: replaces punctuation with dashes (drops &, ?, !, etc.)', () => {
  assert.equal(slugify('A & B?'), 'a-b');
  assert.equal(slugify('What?!'), 'what');
  assert.equal(slugify('a/b\\c'), 'a-b-c');
});

test('slugify: handles diacritics via NFKD decomposition', () => {
  assert.equal(slugify('Café'), 'cafe');
  assert.equal(slugify('naïve'), 'naive');
});

test('slugify: non-string input returns empty string', () => {
  assert.equal(slugify(null), '');
  assert.equal(slugify(undefined), '');
  assert.equal(slugify(42), '');
});

test('slugify: empty / whitespace-only / all-symbol returns empty string', () => {
  assert.equal(slugify(''), '');
  assert.equal(slugify('   '), '');
  assert.equal(slugify('!!!???'), '');
});

test('operatorIdeaIdForTitle: produces idea_operator_<slug>_<YYYYMMDD>', () => {
  const date = new Date(Date.UTC(2026, 8, 14)); // 2026-09-14
  const id = operatorIdeaIdForTitle('Pre-flight indexer price check', date);
  assert.equal(id, 'idea_operator_pre-flight-indexer-price-check_20260914');
});

test('operatorIdeaIdForTitle: empty title → placeholder slug', () => {
  const date = new Date(Date.UTC(2026, 8, 14));
  assert.equal(operatorIdeaIdForTitle('!!!', date), 'idea_operator_idea_20260914');
});

// ─────────────────────────────────────────────────────────────────────
//  store.addOperatorIdea
// ─────────────────────────────────────────────────────────────────────

test('store.addOperatorIdea: appends a new idea with source=operator + status=pending', async (t) => {
  const tmp = await makeTmp();
  t.after(() => tmp.cleanup());
  const store = new FeatureIdeasStore({ file: tmp.file });
  await store.load();
  const r = await store.addOperatorIdea({
    title: 'Test operator idea',
    category: 'edge-case-protection',
    rationale: 'because we should test this path',
    effort: 'S',
    impact: 'high',
  });
  assert.equal(r.idea.source, 'operator');
  assert.equal(r.idea.status, 'pending');
  assert.equal(r.idea.id, `idea_operator_test-operator-idea_${expectedDate()}`);
  assert.equal(r.idea.title, 'Test operator idea');
  assert.deepEqual(r.idea.category_tags, []);
  assert.equal(r.idea.evidence, '');  // default when omitted
  assert.equal(r.id_was_collision, false);
  // The file should now have 1 idea
  const file = await store.load();
  assert.equal(file.ideas.length, 1);
  assert.equal(file.meta.pending_count, 1);
});

test('store.addOperatorIdea: default evidence is empty string', async (t) => {
  const tmp = await makeTmp();
  t.after(() => tmp.cleanup());
  const store = new FeatureIdeasStore({ file: tmp.file });
  await store.load();
  const r = await store.addOperatorIdea({
    title: 'Evidence-less idea',
    category: 'observability',
    rationale: 'rationale is the only narrative bit',
    effort: 'M',
    impact: 'medium',
  });
  assert.equal(r.idea.evidence, '');
});

test('store.addOperatorIdea: collision appends -1, -2, etc.', async (t) => {
  const tmp = await makeTmp();
  t.after(() => tmp.cleanup());
  const store = new FeatureIdeasStore({ file: tmp.file });
  await store.load();
  // Create 3 ideas with the same title on the same day.
  const r1 = await store.addOperatorIdea({
    title: 'Same title', category: 'dashboard', rationale: 'r1', effort: 'S', impact: 'low',
  });
  const r2 = await store.addOperatorIdea({
    title: 'Same title', category: 'dashboard', rationale: 'r2', effort: 'S', impact: 'low',
  });
  const r3 = await store.addOperatorIdea({
    title: 'Same title', category: 'dashboard', rationale: 'r3', effort: 'S', impact: 'low',
  });
  assert.equal(r1.id_was_collision, false);
  assert.equal(r2.id_was_collision, true);
  assert.equal(r3.id_was_collision, true);
  assert.match(r1.idea.id, /^idea_operator_same-title_\d{8}$/);
  assert.equal(r2.idea.id, `${r1.idea.id}-1`);
  assert.equal(r3.idea.id, `${r1.idea.id}-2`);
});

test('store.addOperatorIdea: invalid draft throws validateIdea error', async (t) => {
  const tmp = await makeTmp();
  t.after(() => tmp.cleanup());
  const store = new FeatureIdeasStore({ file: tmp.file });
  await store.load();
  await assert.rejects(
    () => store.addOperatorIdea({
      title: 'bad cat',
      category: 'not-a-real-category',
      rationale: 'r',
      effort: 'S',
      impact: 'high',
    }),
    /category must be one of/,
  );
});

test('store.addOperatorIdea: missing draft throws', async (t) => {
  const tmp = await makeTmp();
  t.after(() => tmp.cleanup());
  const store = new FeatureIdeasStore({ file: tmp.file });
  await store.load();
  await assert.rejects(() => store.addOperatorIdea(null), /draft must be an object/);
});

test('store.addOperatorIdea: persists across reloads', async (t) => {
  const tmp = await makeTmp();
  t.after(() => tmp.cleanup());
  const store1 = new FeatureIdeasStore({ file: tmp.file });
  await store1.load();
  await store1.addOperatorIdea({
    title: 'Persistence test', category: 'dashboard', rationale: 'r', effort: 'M', impact: 'high',
  });
  // Fresh store instance reads the same file.
  const store2 = new FeatureIdeasStore({ file: tmp.file });
  const file = await store2.load();
  assert.equal(file.ideas.length, 1);
  assert.equal(file.ideas[0].title, 'Persistence test');
});

// ─────────────────────────────────────────────────────────────────────
//  routes: POST /api/feature-ideas (operator create)
// ─────────────────────────────────────────────────────────────────────

test('routes: POST /api/feature-ideas creates a new idea', async (t) => {
  const tmp = await makeTmp();
  t.after(() => tmp.cleanup());
  const store = new FeatureIdeasStore({ file: tmp.file });
  await store.load();
  const routes = buildFeatureIdeaRoutes(makeRouteTestCtx(store, join(tmp.dir, 'TODO.md')));
  const handler = routes.find((r) => r.method === 'POST' && r.path === '/api/feature-ideas').handler;
  assert.ok(handler, 'POST /api/feature-ideas route exists');
  assert.equal(routes.find((r) => r.method === 'POST' && r.path === '/api/feature-ideas').auth, true,
    'create route must be auth-gated');
  const out = await handler({}, {}, new URL('http://x'), {
    title: 'Add a manual trade UI',
    category: 'dashboard',
    rationale: 'so the operator can intervene when the bot misses a clear setup',
    evidence: 'observed 3 missed setups in last 7 days',
    effort: 'L',
    impact: 'medium',
    category_tags: ['manual-control', 'override'],
  });
  assert.equal(out.idea.source, 'operator');
  assert.equal(out.idea.status, 'pending');
  assert.equal(out.idea.title, 'Add a manual trade UI');
  assert.deepEqual(out.idea.category_tags, ['manual-control', 'override']);
  assert.equal(out.id_was_collision, false);
  // Reload and verify it's persisted.
  const file = await store.load();
  assert.equal(file.ideas.length, 1);
  assert.equal(file.meta.pending_count, 1);
});

test('routes: POST /api/feature-ideas with missing required fields throws 400 with all errors', async (t) => {
  const tmp = await makeTmp();
  t.after(() => tmp.cleanup());
  const store = new FeatureIdeasStore({ file: tmp.file });
  await store.load();
  const routes = buildFeatureIdeaRoutes(makeRouteTestCtx(store, join(tmp.dir, 'TODO.md')));
  const handler = routes.find((r) => r.method === 'POST' && r.path === '/api/feature-ideas').handler;
  await assert.rejects(
    () => handler({}, {}, new URL('http://x'), {}),
    (e) => e.statusCode === 400 && /title/.test(e.message) && /category/.test(e.message) && /rationale/.test(e.message) && /effort/.test(e.message) && /impact/.test(e.message),
  );
});

test('routes: POST /api/feature-ideas with bad category throws 400', async (t) => {
  const tmp = await makeTmp();
  t.after(() => tmp.cleanup());
  const store = new FeatureIdeasStore({ file: tmp.file });
  await store.load();
  const routes = buildFeatureIdeaRoutes(makeRouteTestCtx(store, join(tmp.dir, 'TODO.md')));
  const handler = routes.find((r) => r.method === 'POST' && r.path === '/api/feature-ideas').handler;
  await assert.rejects(
    () => handler({}, {}, new URL('http://x'), {
      title: 'x', category: 'wrong-cat', rationale: 'r', effort: 'S', impact: 'high',
    }),
    (e) => e.statusCode === 400 && /category must be one of/.test(e.message),
  );
});

test('routes: POST /api/feature-ideas with non-array body throws 400', async (t) => {
  const tmp = await makeTmp();
  t.after(() => tmp.cleanup());
  const store = new FeatureIdeasStore({ file: tmp.file });
  await store.load();
  const routes = buildFeatureIdeaRoutes(makeRouteTestCtx(store, join(tmp.dir, 'TODO.md')));
  const handler = routes.find((r) => r.method === 'POST' && r.path === '/api/feature-ideas').handler;
  await assert.rejects(
    () => handler({}, {}, new URL('http://x'), ['not', 'an', 'object']),
    (e) => e.statusCode === 400,
  );
});

test('routes: POST /api/feature-ideas with non-string category_tags entries throws 400', async (t) => {
  const tmp = await makeTmp();
  t.after(() => tmp.cleanup());
  const store = new FeatureIdeasStore({ file: tmp.file });
  await store.load();
  const routes = buildFeatureIdeaRoutes(makeRouteTestCtx(store, join(tmp.dir, 'TODO.md')));
  const handler = routes.find((r) => r.method === 'POST' && r.path === '/api/feature-ideas').handler;
  await assert.rejects(
    () => handler({}, {}, new URL('http://x'), {
      title: 'x', category: 'dashboard', rationale: 'r', effort: 'S', impact: 'high',
      category_tags: ['ok', 42, 'also-ok'],
    }),
    (e) => e.statusCode === 400 && /category_tags/.test(e.message),
  );
});

/**
 * Compute today's UTC YYYYMMDD so the addOperatorIdea test can
 * assert the slug id without depending on the wall clock.
 */
function expectedDate() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${dd}`;
}

// ─── 2026-09-20 fixup: `created_at` is a valid alias for `ts` on
// a note when the canonical `ts` is missing/non-string. The
// supervisor's auto-stamp path historically used both shapes; a
// stamp on T78 subset 1 wrote `created_at` only, which broke
// `GET /api/feature-ideas` with "validateIdea: note.ts must be a
// string" — the Proposals tab rendered "Could not load data."
// until the schema accepted the alias (and the on-disk note was
// backfilled). This pair of tests locks in the new contract:
// `created_at` is accepted, and the mutation is observable on the
// returned object so downstream code can read it as `ts`.

test('schema: validateIdea accepts `created_at` as alias for note.ts', () => {
  const ts = '2026-09-20T16:55:00.000Z';
  const idea = mkIdea({
    notes: [
      {
        created_at: ts,
        author: 'supervisor-stamp',
        body: 'shipped T78 subset 1',
      },
    ],
  });
  assert.equal(idea.notes.length, 1);
  assert.equal(idea.notes[0].ts, ts,
    'alias must mutate the note object so downstream reads see the canonical field');
  assert.equal(idea.notes[0].created_at, ts,
    'original created_at field must be preserved alongside the aliased ts');
});

test('schema: validateIdea still rejects notes with no usable timestamp', () => {
  assert.throws(
    () => mkIdea({
      notes: [
        {
          // No ts, no created_at — neither alias path resolves.
          author: 'malformed',
          body: 'this note should be rejected',
        },
      ],
    }),
    /note\.ts must be a string/,
    'notes lacking any timestamp field must still fail validation',
  );
});

test('schema: validateIdea accepts notes with missing author field (sentinel fallback)', () => {
  // 2026-09-20: a T78 subset 1 supervisor stamp wrote `body` +
  // `created_at` but no `author`. The Proposals tab crashed
  // outright. This test locks in the sentinel-fallback path so
  // future bad stamps degrade gracefully (the operator sees
  // "unknown-author" in the UI and can edit) instead of nuking
  // the whole tab.
  const idea = mkIdea({
    notes: [
      {
        created_at: '2026-09-20T16:55:00.000Z',
        body: 'shipped T78 subset 1',
        // no `author` field
      },
    ],
  });
  assert.equal(idea.notes[0].author, 'unknown-author',
    'missing author must be backfilled with the sentinel so the note validates');
  assert.equal(idea.notes[0].ts, '2026-09-20T16:55:00.000Z');
  assert.equal(idea.notes[0].body, 'shipped T78 subset 1');
});
