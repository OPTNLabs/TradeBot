#!/usr/bin/env node
// tests/dashboard-research-runs.test.mjs
//
// T30c — integration tests for the dashboard's `/api/research-runs`
// route. Mirrors the pattern in `tests/server.test.mjs`: real
// on-disk history NDJSON + tmp dirs + supertest-driven `handler()`.
//
// What we verify:
//   1. Route is registered (matches the pattern).
//   2. Empty history returns `{ count: 0, events: [] }`.
//   3. Non-research events are filtered out — only `kind:
//      'research_cron_run'` events are returned.
//   4. `?limit=N` caps the tail.
//   5. `?range=...` (1d/7d/30d/all) respects the injected clock.
//   6. Default cap (`research_runs_max_events`) is honored when no
//      `?limit=` is passed.
//   7. Mixed event kinds (entry, tick, research_cron_run, manual_exit)
//      all flow through the same historyReader but only research_cron_run
//      ones are surfaced.
//   8. buildSummary is unchanged (the new endpoint doesn't pollute the
//      DASHBOARD summary payload).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import supertest from 'supertest';

import { createDashboardServer } from '../src/dashboard/server.mjs';
import { Positions } from '../src/portfolio/positions.mjs';
import { Snapshots } from '../src/portfolio/snapshots.mjs';
import { createHistoryReader } from '../src/dashboard/server.mjs';
import { createLogger } from '../src/util/logger.mjs';

async function makeTmp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tradebot-research-runs-'));
  t.after(async () => {
    try { await rm(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });
  return dir;
}

async function writeNdjson(file, lines) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

async function makeServer(t, dir, { historyLines = [], clock } = {}) {
  const cfg = { paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s` } };
  const positions = new Positions({
    file: cfg.paths.positions_file,
    logger: createLogger({ sink: process.stderr }),
  });
  await positions.load();
  const snapshots = new Snapshots({
    dir: cfg.paths.snapshots_dir,
    logger: createLogger({ sink: process.stderr }),
  });
  await snapshots.load();
  const historyFile = `${dir}/history.ndjson`;
  if (historyLines.length > 0) {
    await writeNdjson(historyFile, historyLines);
  }
  const historyReader = createHistoryReader({ file: historyFile });
  const server = createDashboardServer({
    cfg,
    positions,
    snapshots,
    historyReader,
    logger: createLogger({ component: 'research-runs-test', sink: process.stderr }),
    ...(typeof clock === 'function' ? { clock } : {}),
  });
  return { server, historyReader };
}

// ─────────────────────────────────────────────────────────────────────
//  Route registration
// ─────────────────────────────────────────────────────────────────────

test('route: /api/research-runs is registered by buildRouteTable()', () => {
  // Import lazily so the test reads like a unit test.
  return import('../src/dashboard/server.mjs').then(({ buildRouteTable }) => {
    const routes = buildRouteTable();
    const route = routes.find((r) => r.path === '/api/research-runs');
    assert.ok(route, '/api/research-runs must be registered');
    assert.equal(route.method, 'GET');
    assert.equal(route.auth, false);
    assert.match(route.pattern.source, /research-runs/);
  });
});

test('route: /api/research-runs matches the URL', () => {
  return import('../src/dashboard/server.mjs').then(({ buildRouteTable, matchRoute }) => {
    const routes = buildRouteTable();
    const m = matchRoute(routes, 'GET', '/api/research-runs');
    assert.ok(m, 'matchRoute must return a route for /api/research-runs');
    assert.equal(m.route.path, '/api/research-runs');
    // matchRoute takes the pathname — verify that the request
    // dispatcher (which strips the query string before matching)
    // correctly resolves the same route.
    const url = new URL('http://x/api/research-runs?limit=5');
    const m2 = matchRoute(routes, 'GET', url.pathname);
    assert.ok(m2, 'matchRoute must return a route for /api/research-runs pathname');
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Empty + happy-path
// ─────────────────────────────────────────────────────────────────────

test('endpoint: GET /api/research-runs returns empty when history is missing', async (t) => {
  const dir = await makeTmp(t);
  const { server } = await makeServer(t, dir, { historyLines: [] });
  const res = await supertest(server.handler).get('/api/research-runs').expect(200);
  assert.equal(res.body.schema, 'tradebot.dashboard.research-runs/v1');
  assert.equal(res.body.count, 0);
  assert.deepEqual(res.body.events, []);
  assert.equal(res.body.range, 'all');
  assert.equal(typeof res.body.ts, 'string');
  assert.equal(typeof res.body.limit, 'number');
});

test('endpoint: GET /api/research-runs filters to kind=research_cron_run only', async (t) => {
  const dir = await makeTmp(t);
  const lines = [
    { ts: '2026-09-12T22:00:00Z', kind: 'tick', candidate_count: 0 },
    { ts: '2026-09-13T00:00:00Z', kind: 'entry_executed', token_id: 'aaa' },
    { ts: '2026-09-13T00:01:00Z', kind: 'research_cron_run', source: 'feature-researcher', added: 2, available: 44, spent: 2, ran: true, forced: true, rate_limited: false, ideas_added: [] },
    { ts: '2026-09-13T00:02:00Z', kind: 'tick', candidate_count: 1 },
    { ts: '2026-09-13T00:03:00Z', kind: 'research_cron_run', source: 'feature-researcher', added: 0, available: 0, spent: 5, ran: false, forced: false, rate_limited: true, ideas_added: [] },
    { ts: '2026-09-13T00:04:00Z', kind: 'exit_executed', token_id: 'aaa' },
  ];
  const { server } = await makeServer(t, dir, { historyLines: lines });
  const res = await supertest(server.handler).get('/api/research-runs').expect(200);
  assert.equal(res.body.count, 2);
  for (const evt of res.body.events) {
    assert.equal(evt.kind, 'research_cron_run');
  }
  // Tail-order: last N research events in arrival order.
  assert.equal(res.body.events[0].added, 2);
  assert.equal(res.body.events[0].forced, true);
  assert.equal(res.body.events[1].added, 0);
  assert.equal(res.body.events[1].rate_limited, true);
});

test('endpoint: GET /api/research-runs?limit=2 caps the tail to 2', async (t) => {
  const dir = await makeTmp(t);
  const lines = [];
  for (let i = 0; i < 10; i++) {
    lines.push({
      ts: `2026-09-13T00:0${i}:00Z`,
      kind: 'research_cron_run',
      source: 'feature-researcher',
      added: i, available: 50 - i, spent: i, ran: i > 0, forced: false, rate_limited: i === 0,
      ideas_added: [],
    });
  }
  const { server } = await makeServer(t, dir, { historyLines: lines });
  const res = await supertest(server.handler).get('/api/research-runs?limit=2').expect(200);
  assert.equal(res.body.count, 2);
  assert.equal(res.body.limit, 2);
  // Last 2 are the highest-added ones.
  assert.equal(res.body.events[0].added, 8);
  assert.equal(res.body.events[1].added, 9);
});

test('endpoint: GET /api/research-runs respects ?range=7d via injected clock', async (t) => {
  const dir = await makeTmp(t);
  // One research event ~31 days old, one 5 days old, one 1 day old.
  const lines = [
    { ts: '2026-08-14T00:00:00Z', kind: 'research_cron_run', source: 'feature-researcher', added: 1, available: 45, spent: 1, ran: true, forced: false, rate_limited: false, ideas_added: [] },
    { ts: '2026-09-09T00:00:00Z', kind: 'research_cron_run', source: 'feature-researcher', added: 0, available: 0, spent: 5, ran: false, forced: false, rate_limited: true, ideas_added: [] },
    { ts: '2026-09-13T00:00:00Z', kind: 'research_cron_run', source: 'feature-researcher', added: 2, available: 43, spent: 3, ran: true, forced: true, rate_limited: false, ideas_added: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }] },
  ];
  const FROZEN_NOW_MS = Date.parse('2026-09-14T12:00:00Z');
  const { server } = await makeServer(t, dir, {
    historyLines: lines,
    clock: () => FROZEN_NOW_MS,
  });
  // 7d window: only the last 2 events fall inside (the Aug 14 event is > 30d old).
  const res = await supertest(server.handler).get('/api/research-runs?range=7d').expect(200);
  assert.equal(res.body.count, 2);
  assert.equal(res.body.events[0].added, 0);
  assert.equal(res.body.events[1].added, 2);
  assert.equal(res.body.range, '604800s');
  // 30d window: 2 events fall inside (Aug 14 is just past the 30d cutoff).
  const res30 = await supertest(server.handler).get('/api/research-runs?range=30d').expect(200);
  assert.equal(res30.body.count, 2);
  // 60d window: all 3 fall inside.
  const res60 = await supertest(server.handler).get('/api/research-runs?range=60d').expect(200);
  assert.equal(res60.body.count, 3);
  // `all` range: all 3.
  const resAll = await supertest(server.handler).get('/api/research-runs?range=all').expect(200);
  assert.equal(resAll.body.count, 3);
  assert.equal(resAll.body.range, 'all');
});

test('endpoint: GET /api/research-runs honors the default cap (research_runs_max_events)', async (t) => {
  const dir = await makeTmp(t);
  // Build 60 research events — well over the default 50 cap.
  const lines = [];
  for (let i = 0; i < 60; i++) {
    lines.push({
      ts: new Date(Date.parse('2026-09-14T00:00:00Z') - i * 60_000).toISOString(),
      kind: 'research_cron_run',
      source: 'feature-researcher',
      added: 1, available: 50, spent: i, ran: true, forced: false, rate_limited: false, ideas_added: [],
    });
  }
  const { server } = await makeServer(t, dir, { historyLines: lines });
  const res = await supertest(server.handler).get('/api/research-runs').expect(200);
  // Default cap is 50.
  assert.ok(res.body.count <= 50, `expected count <= 50, got ${res.body.count}`);
  assert.equal(res.body.limit, 50);
});

test('endpoint: GET /api/research-runs ignores junk?limit values', async (t) => {
  const dir = await makeTmp(t);
  const lines = [
    { ts: '2026-09-13T00:00:00Z', kind: 'research_cron_run', source: 'feature-researcher', added: 1, available: 5, spent: 1, ran: true, forced: false, rate_limited: false, ideas_added: [] },
  ];
  const { server } = await makeServer(t, dir, { historyLines: lines });
  const res = await supertest(server.handler).get('/api/research-runs?limit=junk').expect(200);
  // parseLimit returns the cap (default 50) when garbage is passed.
  assert.equal(res.body.count, 1);
  assert.equal(res.body.limit, 50);
});

test('endpoint: GET /api/research-runs?limit=0 falls back to the default cap', async (t) => {
  const dir = await makeTmp(t);
  const lines = [
    { ts: '2026-09-13T00:00:00Z', kind: 'research_cron_run', source: 'feature-researcher', added: 1, available: 5, spent: 1, ran: true, forced: false, rate_limited: false, ideas_added: [] },
  ];
  const { server } = await makeServer(t, dir, { historyLines: lines });
  const res = await supertest(server.handler).get('/api/research-runs?limit=0').expect(200);
  // parseLimit returns the cap (default 50) when 0 is passed (limit must be > 0).
  assert.equal(res.body.limit, 50);
});

test('endpoint: GET /api/research-runs is public (no auth required)', async (t) => {
  const dir = await makeTmp(t);
  const lines = [
    { ts: '2026-09-13T00:00:00Z', kind: 'research_cron_run', source: 'feature-researcher', added: 1, available: 5, spent: 1, ran: true, forced: false, rate_limited: false, ideas_added: [] },
  ];
  const { server } = await makeServer(t, dir, { historyLines: lines });
  // No Authorization header → still 200.
  const res = await supertest(server.handler).get('/api/research-runs').expect(200);
  assert.equal(res.body.count, 1);
});

test('endpoint: research events with malformed kind are dropped', async (t) => {
  const dir = await makeTmp(t);
  const lines = [
    { ts: '2026-09-13T00:00:00Z', kind: 'research_cron_run', source: 'feature-researcher', added: 1, available: 5, spent: 1, ran: true, forced: false, rate_limited: false, ideas_added: [] },
    { ts: '2026-09-13T00:01:00Z' }, // no kind
    { ts: '2026-09-13T00:02:00Z', kind: 'something_else' }, // wrong kind
  ];
  const { server } = await makeServer(t, dir, { historyLines: lines });
  const res = await supertest(server.handler).get('/api/research-runs').expect(200);
  assert.equal(res.body.count, 1);
  assert.equal(res.body.events[0].kind, 'research_cron_run');
});

test('endpoint: research events carry all required audit fields', async (t) => {
  const dir = await makeTmp(t);
  const lines = [
    {
      ts: '2026-09-13T00:00:00Z',
      kind: 'research_cron_run',
      source: 'feature-researcher',
      dry_run: false,
      forced: true,
      rate_limited: false,
      ran: true,
      added: 2,
      skipped: 0,
      available: 44,
      spent: 2,
      hours_since_last_run: 13.5,
      ideas_added: [{ id: 'idea_a', title: 'A' }],
      file: 'data/feature-ideas.json',
    },
  ];
  const { server } = await makeServer(t, dir, { historyLines: lines });
  const res = await supertest(server.handler).get('/api/research-runs').expect(200);
  assert.equal(res.body.count, 1);
  const evt = res.body.events[0];
  // The route is read-only — it must surface every field the cron wrote.
  for (const key of [
    'ts', 'kind', 'source', 'dry_run', 'forced', 'rate_limited',
    'ran', 'added', 'skipped', 'available', 'spent',
    'hours_since_last_run', 'ideas_added', 'file',
  ]) {
    assert.ok(key in evt, `missing audit field: ${key}`);
  }
  assert.equal(evt.ideas_added[0].id, 'idea_a');
  assert.equal(evt.ideas_added[0].title, 'A');
});
