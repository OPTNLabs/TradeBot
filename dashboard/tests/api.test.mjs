// dashboard/tests/api.test.mjs
//
// Unit tests for `src/lib/api.mjs` — the tiny fetch wrapper used
// by every panel in the dashboard. Run with `node --test` from
// the dashboard/ directory (or via `npm test` once npm install has
// been run).
//
// We do not stub `fetch` — we replace `globalThis.fetch` with a
// callable that records its inputs and returns a stub `Response`.
// This keeps the test surface close to what the browser does
// without dragging jsdom / happy-dom in as a dependency.

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert';

import { buildUrl, authHeader, request, createApiClient } from '../src/lib/api.mjs';

// ─── Fake fetch plumbing ────────────────────────────────────────────

/**
 * Minimal `Response` stand-in matching the slice of the Web
 * `Response` API that `request()` actually uses: `.status` and
 * `.text()`.
 */
class FakeResponse {
  constructor(status, body, opts) {
    this.status = status;
    const headers = (opts && opts.headers) || {};
    this._body = body === null || body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
    this._isJson = (opts && opts.json) !== false && typeof body === 'object';
  }
  get headers() {
    const map = new Map();
    map.set('content-type', this._isJson ? 'application/json' : 'text/plain');
    return { get: (k) => map.get(String(k).toLowerCase()) };
  }
  async text() { return this._body; }
}

let originalFetch;
let lastFetchArgs;
let nextResponse;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  lastFetchArgs = null;
  nextResponse = null;
  globalThis.fetch = async (url, init) => {
    lastFetchArgs = { url, init };
    return nextResponse;
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ─── buildUrl ────────────────────────────────────────────────────────

describe('buildUrl', () => {
  it('returns the path unchanged when no base is supplied', () => {
    strictEqual(buildUrl('/api/summary', ''), '/api/summary');
    strictEqual(buildUrl('/api/summary', undefined), '/api/summary');
    strictEqual(buildUrl('/api/summary', null), '/api/summary');
  });

  it('joins base + path without double slashes', () => {
    strictEqual(buildUrl('/api/summary', 'http://127.0.0.1:8787'), 'http://127.0.0.1:8787/api/summary');
  });

  it('tolerates a trailing slash on base', () => {
    strictEqual(buildUrl('/api/summary', 'http://127.0.0.1:8787/'), 'http://127.0.0.1:8787/api/summary');
  });

  it('tolerates a missing leading slash on path', () => {
    strictEqual(buildUrl('api/summary', 'http://127.0.0.1:8787'), 'http://127.0.0.1:8787/api/summary');
  });

  it('treats non-string baseUrl as missing', () => {
    strictEqual(buildUrl('/api/summary', /** @type {any} */ (123)), '/api/summary');
  });
});

// ─── authHeader ──────────────────────────────────────────────────────

describe('authHeader', () => {
  it('returns Bearer token for a non-empty string', () => {
    strictEqual(authHeader('abc123'), 'Bearer abc123');
  });

  it('trims whitespace before checking emptiness', () => {
    strictEqual(authHeader('  abc123  '), 'Bearer abc123');
  });

  it('returns null for empty / whitespace-only / non-string tokens', () => {
    strictEqual(authHeader(''), null);
    strictEqual(authHeader('   '), null);
    strictEqual(authHeader(null), null);
    strictEqual(authHeader(undefined), null);
    strictEqual(authHeader(42), null);
    strictEqual(authHeader({}), null);
  });
});

// ─── request — happy path ────────────────────────────────────────────

describe('request — happy path', () => {
  it('parses JSON body and returns ok result', async () => {
    nextResponse = new FakeResponse(200, { hello: 'world' });
    const r = await request('/api/summary', { method: 'GET' }, 5000);
    strictEqual(r.ok, true);
    deepStrictEqual(r.data, { hello: 'world' });
    strictEqual(r.status, 200);
    ok(typeof r.durationMs === 'number' && r.durationMs >= 0);
  });

  it('forwards method + headers + body to fetch', async () => {
    nextResponse = new FakeResponse(200, { ok: true });
    await request('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}' }, 5000);
    strictEqual(lastFetchArgs.url, '/api/config');
    strictEqual(lastFetchArgs.init.method, 'PUT');
    strictEqual(lastFetchArgs.init.headers['Content-Type'], 'application/json');
    strictEqual(lastFetchArgs.init.body, '{"a":1}');
    ok(lastFetchArgs.init.signal, 'fetch called with an AbortSignal');
  });

  it('treats empty body as ok with null data', async () => {
    nextResponse = new FakeResponse(204, null);
    const r = await request('/api/foo', {}, 5000);
    strictEqual(r.ok, true);
    strictEqual(r.data, null);
    strictEqual(r.status, 204);
  });

  it('treats non-JSON text body as ok with null data', async () => {
    nextResponse = new FakeResponse(200, 'plain text', { json: false });
    const r = await request('/api/foo', {}, 5000);
    strictEqual(r.ok, true);
    strictEqual(r.data, null);
  });
});

// ─── request — error path ────────────────────────────────────────────

describe('request — error path', () => {
  it('surfaces HTTP errors with the server-provided message', async () => {
    nextResponse = new FakeResponse(403, { error: 'forbidden', code: 'AUTH' });
    const r = await request('/api/secret', {}, 5000);
    strictEqual(r.ok, false);
    strictEqual(r.error, 'forbidden');
    strictEqual(r.code, 'AUTH');
    strictEqual(r.status, 403);
  });

  it('falls back to HTTP <status> when error message missing', async () => {
    nextResponse = new FakeResponse(500, { detail: 'stack trace...' });
    const r = await request('/api/boom', {}, 5000);
    strictEqual(r.ok, false);
    strictEqual(r.error, 'HTTP 500');
    strictEqual(r.status, 500);
  });

  it('returns TIMEOUT on AbortError', async () => {
    globalThis.fetch = async (url, init) => {
      lastFetchArgs = { url, init };
      // Honour the abort signal so the test actually exits.
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(new FakeResponse(200, {})), 5000);
        init.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    };
    const start = Date.now();
    const r = await request('/api/slow', {}, 50);
    const elapsed = Date.now() - start;
    strictEqual(r.ok, false);
    strictEqual(r.code, 'TIMEOUT');
    strictEqual(r.status, 0);
    ok(/timeout/.test(r.error), `error should mention timeout, got: ${r.error}`);
    ok(elapsed < 2000, `should return quickly on timeout, took ${elapsed}ms`);
  });

  it('returns NETWORK on generic fetch rejection', async () => {
    globalThis.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const r = await request('/api/x', {}, 1000);
    strictEqual(r.ok, false);
    strictEqual(r.code, 'NETWORK');
    strictEqual(r.status, 0);
    ok(/ECONNREFUSED/.test(r.error));
  });
});

// ─── request — timeout clamping ──────────────────────────────────────

describe('request — timeout clamping', () => {
  it('falls back to 10s when timeoutMs is missing / invalid', async () => {
    nextResponse = new FakeResponse(200, {});
    const r = await request('/api/x', {}, /** @type {any} */ (undefined));
    strictEqual(r.ok, true);
    // No observable change, but we verify no throw — covered by the ok check.
  });

  it('floors fractional timeoutMs', async () => {
    nextResponse = new FakeResponse(200, {});
    const r = await request('/api/x', {}, 1234.9);
    strictEqual(r.ok, true);
  });
});

// ─── createApiClient — read endpoints ────────────────────────────────

describe('createApiClient — read endpoints', () => {
  it('builds a client with sane defaults', () => {
    const c = createApiClient({});
    strictEqual(c.baseUrl, '');
    strictEqual(c.token, null);
    strictEqual(c.timeoutMs, 10_000);
  });

  it('honors baseUrl + token + timeoutMs options', () => {
    const c = createApiClient({ baseUrl: 'http://h:1', token: 'tok', timeoutMs: 2500 });
    strictEqual(c.baseUrl, 'http://h:1');
    strictEqual(c.token, 'tok');
    strictEqual(c.timeoutMs, 2500);
  });

  it('attaches Authorization header when token is present', async () => {
    nextResponse = new FakeResponse(200, {});
    const c = createApiClient({ token: 's3cret' });
    await c.summary();
    strictEqual(lastFetchArgs.init.headers.Authorization, 'Bearer s3cret');
  });

  it('omits Authorization header when no token', async () => {
    nextResponse = new FakeResponse(200, {});
    const c = createApiClient({});
    await c.summary();
    strictEqual(lastFetchArgs.init.headers.Authorization, undefined);
  });

  it('GET /healthz', async () => {
    nextResponse = new FakeResponse(200, { status: 'ok' });
    const c = createApiClient({});
    const r = await c.healthz();
    strictEqual(r.ok, true);
    strictEqual(lastFetchArgs.url, '/healthz');
    strictEqual(lastFetchArgs.init.method, 'GET');
  });

  it('GET /api/summary', async () => {
    nextResponse = new FakeResponse(200, {});
    const c = createApiClient({});
    await c.summary();
    strictEqual(lastFetchArgs.url, '/api/summary');
  });

  it('GET /api/positions without status', async () => {
    nextResponse = new FakeResponse(200, {});
    const c = createApiClient({});
    await c.positions();
    strictEqual(lastFetchArgs.url, '/api/positions');
  });

  it('GET /api/positions with status encodes the query', async () => {
    nextResponse = new FakeResponse(200, {});
    const c = createApiClient({});
    await c.positions('open');
    strictEqual(lastFetchArgs.url, '/api/positions?status=open');
  });

  it('GET /api/positions with weird status still encodes', async () => {
    nextResponse = new FakeResponse(200, {});
    const c = createApiClient({});
    await c.positions('all');
    strictEqual(lastFetchArgs.url, '/api/positions?status=all');
  });

  it('GET /api/history with no options', async () => {
    nextResponse = new FakeResponse(200, {});
    const c = createApiClient({});
    await c.history();
    strictEqual(lastFetchArgs.url, '/api/history');
  });

  it('GET /api/history with range/kind/limit', async () => {
    nextResponse = new FakeResponse(200, {});
    const c = createApiClient({});
    await c.history({ range: '7d', kind: 'trade', limit: 50 });
    // URLSearchParams encodes keys in insertion order.
    strictEqual(lastFetchArgs.url, '/api/history?range=7d&kind=trade&limit=50');
  });

  it('GET /api/snapshots with range/limit', async () => {
    nextResponse = new FakeResponse(200, {});
    const c = createApiClient({});
    await c.snapshots({ range: '30d', limit: 500 });
    strictEqual(lastFetchArgs.url, '/api/snapshots?range=30d&limit=500');
  });

  it('GET /api/snapshots with tokenId', async () => {
    nextResponse = new FakeResponse(200, {});
    const c = createApiClient({});
    await c.snapshots({ tokenId: 'abc-123' });
    strictEqual(lastFetchArgs.url, '/api/snapshots?token_id=abc-123');
  });

  it('GET /api/pnl-timeseries with no options', async () => {
    nextResponse = new FakeResponse(200, {});
    const c = createApiClient({});
    await c.pnlTimeseries();
    strictEqual(lastFetchArgs.url, '/api/pnl-timeseries');
  });

  it('GET /api/pnl-timeseries with range/tokenId/limit', async () => {
    nextResponse = new FakeResponse(200, {});
    const c = createApiClient({});
    await c.pnlTimeseries({ range: '7d', tokenId: 'a'.repeat(64), limit: 100 });
    strictEqual(lastFetchArgs.url, '/api/pnl-timeseries?range=7d&token_id=' + 'a'.repeat(64) + '&limit=100');
  });

  it('GET /api/pnl-timeseries forwards only the keys the caller passed', async () => {
    nextResponse = new FakeResponse(200, {});
    const c = createApiClient({});
    await c.pnlTimeseries({ range: '30d' });
    strictEqual(lastFetchArgs.url, '/api/pnl-timeseries?range=30d');
  });

  it('GET /api/config', async () => {
    nextResponse = new FakeResponse(200, {});
    const c = createApiClient({});
    await c.getConfig();
    strictEqual(lastFetchArgs.url, '/api/config');
  });

  it('GET /api/config/defaults (T43c — pristine defaults for reset-to-default + help popover)', async () => {
    nextResponse = new FakeResponse(200, {});
    const c = createApiClient({});
    await c.getConfigDefaults();
    strictEqual(lastFetchArgs.url, '/api/config/defaults');
  });

  it('GET /api/risk', async () => {
    nextResponse = new FakeResponse(200, {});
    const c = createApiClient({});
    await c.getRisk();
    strictEqual(lastFetchArgs.url, '/api/risk');
  });

  it('GET /api/risk-panel (T41)', async () => {
    nextResponse = new FakeResponse(200, {});
    const c = createApiClient({});
    await c.riskPanel();
    strictEqual(lastFetchArgs.url, '/api/risk-panel');
  });

  it('GET /api/activity without limit', async () => {
    nextResponse = new FakeResponse(200, {});
    const c = createApiClient({});
    await c.activity();
    strictEqual(lastFetchArgs.url, '/api/activity');
  });

  it('GET /api/activity with numeric limit', async () => {
    nextResponse = new FakeResponse(200, {});
    const c = createApiClient({});
    await c.activity(15);
    strictEqual(lastFetchArgs.url, '/api/activity?limit=15');
  });

  it('joins baseUrl when constructing requests', async () => {
    nextResponse = new FakeResponse(200, {});
    const c = createApiClient({ baseUrl: 'http://127.0.0.1:8787' });
    await c.summary();
    strictEqual(lastFetchArgs.url, 'http://127.0.0.1:8787/api/summary');
  });
});

// ─── createApiClient — write endpoints ───────────────────────────────

describe('createApiClient — write endpoints', () => {
  it('PUT /api/config sends JSON body + correct content-type', async () => {
    nextResponse = new FakeResponse(200, { ok: true });
    const c = createApiClient({ token: 't' });
    const r = await c.putConfig({ risk: { max_daily_loss_bch: 0.01 } });
    strictEqual(r.ok, true);
    strictEqual(lastFetchArgs.url, '/api/config');
    strictEqual(lastFetchArgs.init.method, 'PUT');
    strictEqual(lastFetchArgs.init.headers['Content-Type'], 'application/json');
    strictEqual(lastFetchArgs.init.headers.Authorization, 'Bearer t');
    strictEqual(lastFetchArgs.init.body, JSON.stringify({ risk: { max_daily_loss_bch: 0.01 } }));
  });

  it('POST /api/risk/reset sends default reason when none supplied', async () => {
    nextResponse = new FakeResponse(200, { ok: true });
    const c = createApiClient({ token: 't' });
    await c.postRiskReset();
    strictEqual(lastFetchArgs.url, '/api/risk/reset');
    strictEqual(lastFetchArgs.init.method, 'POST');
    strictEqual(lastFetchArgs.init.body, JSON.stringify({ reason: 'manual dashboard reset' }));
  });

  it('POST /api/risk/reset forwards the supplied reason', async () => {
    nextResponse = new FakeResponse(200, { ok: true });
    const c = createApiClient({ token: 't' });
    await c.postRiskReset('operator tripped');
    strictEqual(lastFetchArgs.init.body, JSON.stringify({ reason: 'operator tripped' }));
  });

  it('write endpoints still surface 4xx as typed results', async () => {
    nextResponse = new FakeResponse(400, { error: 'secret-looking keys are not allowed', code: 'BAD_REQUEST' });
    const c = createApiClient({ token: 't' });
    const r = await c.putConfig({ wif: 'L4r...o0g' });
    strictEqual(r.ok, false);
    strictEqual(r.status, 400);
    strictEqual(r.code, 'BAD_REQUEST');
    strictEqual(r.error, 'secret-looking keys are not allowed');
  });
});

// ─── feature-ideas (T30) ───────────────────────────────────────────

describe('createApiClient — feature-ideas', () => {
  it('GET /api/feature-ideas sends correct URL', async () => {
    nextResponse = new FakeResponse(200, { ideas: [], meta: {} });
    const c = createApiClient();
    const r = await c.featureIdeas();
    strictEqual(r.ok, true);
    strictEqual(lastFetchArgs.url, '/api/feature-ideas');
    strictEqual(lastFetchArgs.init.method, 'GET');
  });

  it('GET /api/feature-ideas forwards status + category filters', async () => {
    nextResponse = new FakeResponse(200, { ideas: [], meta: {} });
    const c = createApiClient();
    await c.featureIdeas({ status: 'pending', category: 'dashboard' });
    strictEqual(lastFetchArgs.url, '/api/feature-ideas?status=pending&category=dashboard');
  });

  it('GET /api/feature-ideas omits empty filters', async () => {
    nextResponse = new FakeResponse(200, { ideas: [], meta: {} });
    const c = createApiClient();
    await c.featureIdeas({});
    strictEqual(lastFetchArgs.url, '/api/feature-ideas');
  });

  it('GET /api/feature-ideas/meta hits the meta endpoint', async () => {
    nextResponse = new FakeResponse(200, { total_count: 5, pending_count: 3 });
    const c = createApiClient();
    const r = await c.featureIdeasMeta();
    strictEqual(r.ok, true);
    strictEqual(lastFetchArgs.url, '/api/feature-ideas/meta');
    strictEqual(r.data.pending_count, 3);
  });

  it('POST /api/feature-ideas/:ideaId/status sends body + token', async () => {
    nextResponse = new FakeResponse(200, { idea: { id: 'idea_x' }, todo: { appended: true } });
    const c = createApiClient({ token: 't' });
    const r = await c.updateFeatureIdeaStatus('idea_x', { status: 'approved' });
    strictEqual(r.ok, true);
    strictEqual(lastFetchArgs.url, '/api/feature-ideas/idea_x/status');
    strictEqual(lastFetchArgs.init.method, 'POST');
    strictEqual(lastFetchArgs.init.headers['Content-Type'], 'application/json');
    strictEqual(lastFetchArgs.init.headers.Authorization, 'Bearer t');
    strictEqual(lastFetchArgs.init.body, JSON.stringify({ status: 'approved' }));
  });

  it('POST /api/feature-ideas/:ideaId/status URL-encodes special chars in ideaId', async () => {
    nextResponse = new FakeResponse(200, { idea: { id: 'idea/a b' } });
    const c = createApiClient({ token: 't' });
    await c.updateFeatureIdeaStatus('idea/a b', { status: 'rejected' });
    strictEqual(lastFetchArgs.url, '/api/feature-ideas/idea%2Fa%20b/status');
  });

  it('POST /api/feature-ideas/:ideaId/status rejects empty ideaId with a typed result', async () => {
    const c = createApiClient({ token: 't' });
    const r = await c.updateFeatureIdeaStatus('', { status: 'approved' });
    strictEqual(r.ok, false);
    strictEqual(r.status, 400);
    strictEqual(r.error, 'invalid_idea_id');
  });

  it('POST /api/feature-ideas/:ideaId/status surfaces 4xx from backend', async () => {
    nextResponse = new FakeResponse(404, { error: 'feature-idea idea_zzz not found', code: 'CLIENT_ERROR' });
    const c = createApiClient({ token: 't' });
    const r = await c.updateFeatureIdeaStatus('idea_zzz', { status: 'approved' });
    strictEqual(r.ok, false);
    strictEqual(r.status, 404);
    strictEqual(r.code, 'CLIENT_ERROR');
  });

  it('POST /api/feature-ideas/:ideaId/notes sends body + token', async () => {
    nextResponse = new FakeResponse(200, { idea: { id: 'idea_x' } });
    const c = createApiClient({ token: 't' });
    await c.addFeatureIdeaNote('idea_x', { body: 'looks good', author: 'operator' });
    strictEqual(lastFetchArgs.url, '/api/feature-ideas/idea_x/notes');
    strictEqual(lastFetchArgs.init.method, 'POST');
    strictEqual(lastFetchArgs.init.body, JSON.stringify({ body: 'looks good', author: 'operator' }));
  });

  it('POST /api/feature-ideas/:ideaId/notes rejects empty ideaId', async () => {
    const c = createApiClient({ token: 't' });
    const r = await c.addFeatureIdeaNote('', { body: 'x' });
    strictEqual(r.ok, false);
    strictEqual(r.error, 'invalid_idea_id');
  });
});

describe('createApiClient — research runs (T30c)', () => {
  it('GET /api/research-runs hits the endpoint with no query', async () => {
    nextResponse = new FakeResponse(200, { count: 0, events: [] });
    const c = createApiClient();
    const r = await c.researchRuns();
    strictEqual(r.ok, true);
    strictEqual(lastFetchArgs.url, '/api/research-runs');
    strictEqual(lastFetchArgs.init.method, 'GET');
  });

  it('GET /api/research-runs?limit=N passes the limit', async () => {
    nextResponse = new FakeResponse(200, { count: 1, events: [{ kind: 'research_cron_run' }] });
    const c = createApiClient();
    const r = await c.researchRuns({ limit: 5 });
    strictEqual(r.ok, true);
    strictEqual(lastFetchArgs.url, '/api/research-runs?limit=5');
    strictEqual(r.data.count, 1);
  });

  it('GET /api/research-runs?range=7d passes the range', async () => {
    nextResponse = new FakeResponse(200, { count: 2, events: [] });
    const c = createApiClient();
    const r = await c.researchRuns({ range: '7d' });
    strictEqual(r.ok, true);
    strictEqual(lastFetchArgs.url, '/api/research-runs?range=7d');
  });

  it('GET /api/research-runs with both limit and range concatenates them', async () => {
    nextResponse = new FakeResponse(200, { count: 1, events: [] });
    const c = createApiClient();
    await c.researchRuns({ limit: 3, range: '30d' });
    // URLSearchParams serializes in insertion order: limit, range.
    strictEqual(lastFetchArgs.url, '/api/research-runs?limit=3&range=30d');
  });

  it('GET /api/research-runs surfaces 5xx errors', async () => {
    nextResponse = new FakeResponse(503, { error: 'not available' });
    const c = createApiClient();
    const r = await c.researchRuns();
    strictEqual(r.ok, false);
    strictEqual(r.status, 503);
  });
});

// ─── trade-history (T42) ─────────────────────────────────────

describe('createApiClient — trade-history (T42)', () => {
  it('GET /api/trade-history with no filters', async () => {
    nextResponse = new FakeResponse(200, { schema: 'tradebot.dashboard.trade-history/v1', events: [] });
    const c = createApiClient();
    const r = await c.tradeHistory();
    strictEqual(r.ok, true);
    ok(lastFetchArgs.url.endsWith('/api/trade-history'));
    strictEqual(lastFetchArgs.init.method, 'GET');
  });

  it('GET /api/trade-history with full filter set', async () => {
    nextResponse = new FakeResponse(200, { events: [] });
    const c = createApiClient();
    await c.tradeHistory({
      range: '7d',
      until: '24h',
      eventKind: 'exit',
      side: 'long_token',
      tokenId: 'a'.repeat(64),
      pnl: 'gain',
      limit: 50,
    });
    const u = new URL(lastFetchArgs.url, 'http://x');
    strictEqual(u.pathname, '/api/trade-history');
    strictEqual(u.searchParams.get('range'), '7d');
    strictEqual(u.searchParams.get('until'), '24h');
    strictEqual(u.searchParams.get('event_kind'), 'exit');
    strictEqual(u.searchParams.get('side'), 'long_token');
    strictEqual(u.searchParams.get('token_id'), 'a'.repeat(64));
    strictEqual(u.searchParams.get('pnl'), 'gain');
    strictEqual(u.searchParams.get('limit'), '50');
  });

  it('GET /api/trade-history surfaces 5xx errors', async () => {
    nextResponse = new FakeResponse(503, { error: 'not available' });
    const c = createApiClient();
    const r = await c.tradeHistory();
    strictEqual(r.ok, false);
    strictEqual(r.status, 503);
  });
});

// ─── feature-ideas create (T30+ feature) ──────────────────────

describe('createApiClient — feature-ideas create', () => {
  it('POST /api/feature-ideas sends the full draft body + token', async () => {
    nextResponse = new FakeResponse(200, {
      idea: { id: 'idea_operator_test_20260914', source: 'operator', status: 'pending' },
      meta: { total_count: 23 },
      id_was_collision: false,
    });
    const c = createApiClient({ token: 't' });
    const r = await c.createFeatureIdea({
      title: 'Manual trade UI',
      category: 'dashboard',
      rationale: 'so the operator can intervene',
      evidence: 'missed 3 setups',
      effort: 'L',
      impact: 'medium',
      category_tags: ['manual-control'],
    });
    strictEqual(r.ok, true);
    strictEqual(lastFetchArgs.url, '/api/feature-ideas');
    strictEqual(lastFetchArgs.init.method, 'POST');
    strictEqual(lastFetchArgs.init.headers['Content-Type'], 'application/json');
    strictEqual(lastFetchArgs.init.headers.Authorization, 'Bearer t');
    strictEqual(r.data.id_was_collision, false);
    strictEqual(r.data.idea.source, 'operator');
    const sent = JSON.parse(lastFetchArgs.init.body);
    strictEqual(sent.title, 'Manual trade UI');
    strictEqual(sent.category, 'dashboard');
    strictEqual(sent.effort, 'L');
    strictEqual(sent.impact, 'medium');
    deepStrictEqual(sent.category_tags, ['manual-control']);
  });

  it('POST /api/feature-ideas surfaces 4xx from backend (e.g. bad draft)', async () => {
    nextResponse = new FakeResponse(400, {
      error: 'createIdea: category must be one of',
      code: 'BAD_REQUEST',
    });
    const c = createApiClient({ token: 't' });
    const r = await c.createFeatureIdea({
      title: 'x', category: 'wrong', rationale: 'r', effort: 'S', impact: 'high',
    });
    strictEqual(r.ok, false);
    strictEqual(r.status, 400);
    strictEqual(r.code, 'BAD_REQUEST');
  });

  it('POST /api/feature-ideas client-side rejects non-object body with typed result', async () => {
    lastFetchArgs = null;  // reset before this test
    const c = createApiClient({ token: 't' });
    const r = await c.createFeatureIdea(['not', 'an', 'object']);
    strictEqual(r.ok, false);
    strictEqual(r.status, 400);
    strictEqual(r.error, 'body must be a JSON object');
    strictEqual(lastFetchArgs, null);  // never hit the network
  });

  it('POST /api/feature-ideas client-side rejects null body with typed result', async () => {
    const c = createApiClient({ token: 't' });
    const r = await c.createFeatureIdea(null);
    strictEqual(r.ok, false);
    strictEqual(r.status, 400);
  });
});

// ────────────────────────────────────────────────────────────────────────
//  createApiClient — bugs tab (T44)
//
// Mirrors the featureIdeas API-test block above. The fetch-stub
// pattern (lastFetchArgs) lets us assert the URL + method + body
// without going near a real network.
// ────────────────────────────────────────────────────────────────────────

describe('createApiClient — bugs', () => {
  it('GET /api/bugs sends correct URL', async () => {
    nextResponse = new FakeResponse(200, { bugs: [], meta: {} });
    const c = createApiClient();
    const r = await c.bugs();
    strictEqual(r.ok, true);
    strictEqual(lastFetchArgs.url, '/api/bugs');
    strictEqual(lastFetchArgs.init.method, 'GET');
  });

  it('GET /api/bugs forwards status + category + severity filters', async () => {
    nextResponse = new FakeResponse(200, { bugs: [], meta: {} });
    const c = createApiClient();
    await c.bugs({ status: 'open', category: 'ui', severity: 'high' });
    strictEqual(lastFetchArgs.url, '/api/bugs?status=open&category=ui&severity=high');
  });

  it('GET /api/bugs omits empty filters', async () => {
    nextResponse = new FakeResponse(200, { bugs: [], meta: {} });
    const c = createApiClient();
    await c.bugs({});
    strictEqual(lastFetchArgs.url, '/api/bugs');
  });

  it('GET /api/bugs/meta hits the meta endpoint', async () => {
    nextResponse = new FakeResponse(200, { total_count: 4, open_count: 2, highest_priority: -3, next_priority: -4 });
    const c = createApiClient();
    const r = await c.bugsMeta();
    strictEqual(r.ok, true);
    strictEqual(lastFetchArgs.url, '/api/bugs/meta');
    strictEqual(r.data.highest_priority, -3);
  });

  it('GET /api/bugs/:bugId URL-encodes the id', async () => {
    nextResponse = new FakeResponse(200, { id: 'bug/x y' });
    const c = createApiClient();
    const r = await c.bug('bug/x y');
    strictEqual(r.ok, true);
    strictEqual(lastFetchArgs.url, '/api/bugs/bug%2Fx%20y');
  });

  it('POST /api/bugs sends body + token', async () => {
    nextResponse = new FakeResponse(200, { id: 'bug-x-20260915' });
    const c = createApiClient({ token: 't' });
    const r = await c.createBug({ title: 'Charts blank', description: 'line missing', category: 'ui', severity: 'high' });
    strictEqual(r.ok, true);
    strictEqual(lastFetchArgs.url, '/api/bugs');
    strictEqual(lastFetchArgs.init.method, 'POST');
    strictEqual(lastFetchArgs.init.headers['Content-Type'], 'application/json');
    strictEqual(lastFetchArgs.init.headers.Authorization, 'Bearer t');
    strictEqual(lastFetchArgs.init.body, JSON.stringify({ title: 'Charts blank', description: 'line missing', category: 'ui', severity: 'high' }));
  });

  it('POST /api/bugs/:bugId/status sends body + token', async () => {
    nextResponse = new FakeResponse(200, { id: 'bug-x-20260915', status: 'in_progress' });
    const c = createApiClient({ token: 't' });
    const r = await c.updateBugStatus('bug-x-20260915', { status: 'in_progress' });
    strictEqual(r.ok, true);
    strictEqual(lastFetchArgs.url, '/api/bugs/bug-x-20260915/status');
    strictEqual(lastFetchArgs.init.body, JSON.stringify({ status: 'in_progress' }));
  });

  it('POST /api/bugs/:bugId/reorder sends new_priority as a JSON body', async () => {
    nextResponse = new FakeResponse(200, { id: 'bug-x-20260915', priority: 0 });
    const c = createApiClient({ token: 't' });
    const r = await c.reorderBug('bug-x-20260915', 0);
    strictEqual(r.ok, true);
    strictEqual(lastFetchArgs.url, '/api/bugs/bug-x-20260915/reorder');
    strictEqual(lastFetchArgs.init.body, JSON.stringify({ new_priority: 0 }));
  });

  it('POST /api/bugs/:bugId/notes sends body + token', async () => {
    nextResponse = new FakeResponse(200, { id: 'bug-x-20260915', notes: [] });
    const c = createApiClient({ token: 't' });
    const r = await c.addBugNote('bug-x-20260915', { author: 'op', body: 'reproduced' });
    strictEqual(r.ok, true);
    strictEqual(lastFetchArgs.url, '/api/bugs/bug-x-20260915/notes');
    strictEqual(lastFetchArgs.init.body, JSON.stringify({ author: 'op', body: 'reproduced' }));
  });

  it('DELETE /api/bugs/:bugId URL-encodes the id', async () => {
    nextResponse = new FakeResponse(200, { deleted: true });
    const c = createApiClient({ token: 't' });
    const r = await c.deleteBug('bug/x y');
    strictEqual(r.ok, true);
    strictEqual(lastFetchArgs.url, '/api/bugs/bug%2Fx%20y');
    strictEqual(lastFetchArgs.init.method, 'DELETE');
    strictEqual(lastFetchArgs.init.headers.Authorization, 'Bearer t');
  });
});

// ─── T45b: poolsTop + tradeManual ──────────────────────────────────

describe('createApiClient — T45b poolsTop', () => {
  it('GET /api/pools/top with default limit (no query string)', async () => {
    nextResponse = new FakeResponse(200, { schema: 'tradebot.dashboard.pools.top/v1', limit: 50, count: 0, pools: [] });
    const c = createApiClient({ token: 't' });
    const r = await c.poolsTop();
    strictEqual(r.ok, true);
    strictEqual(lastFetchArgs.url, '/api/pools/top');
    strictEqual(lastFetchArgs.init.method, 'GET');
  });

  it('GET /api/pools/top?limit=N passes the clamped limit as a query param', async () => {
    nextResponse = new FakeResponse(200, { limit: 5, count: 0, pools: [] });
    const c = createApiClient({ token: 't' });
    const r = await c.poolsTop({ limit: 5 });
    strictEqual(r.ok, true);
    strictEqual(lastFetchArgs.url, '/api/pools/top?limit=5');
  });

  it('GET /api/pools/top clamps limit to [1, 200]', async () => {
    nextResponse = new FakeResponse(200, { limit: 200, count: 0, pools: [] });
    const c = createApiClient({ token: 't' });
    await c.poolsTop({ limit: 9999 });
    strictEqual(lastFetchArgs.url, '/api/pools/top?limit=200');
    await c.poolsTop({ limit: -3 });
    strictEqual(lastFetchArgs.url, '/api/pools/top?limit=1');
  });

  it('GET /api/pools/top omits limit param when limit is non-finite', async () => {
    nextResponse = new FakeResponse(200, { limit: 50, count: 0, pools: [] });
    const c = createApiClient({ token: 't' });
    await c.poolsTop({ limit: NaN });
    strictEqual(lastFetchArgs.url, '/api/pools/top');
    await c.poolsTop({});
    strictEqual(lastFetchArgs.url, '/api/pools/top');
  });

  it('GET /api/pools/top surfaces the 503 fetcher_not_configured envelope', async () => {
    // The dashboard server returns HTTP 200 with a typed-error
    // envelope (matches the /api/reconcile/positions-vs-chain
    // pattern); the api client surfaces the envelope via
    // `r.data.ok === false` + `r.data.error` + `r.data.status`.
    nextResponse = new FakeResponse(200, { ok: false, error: 'fetcher_not_configured', status: 503 });
    const c = createApiClient({ token: 't' });
    const r = await c.poolsTop();
    strictEqual(r.ok, true); // HTTP 200 → wrapper ok=true
    strictEqual(r.data.ok, false);
    strictEqual(r.data.error, 'fetcher_not_configured');
    strictEqual(r.data.status, 503);
  });
});

describe('createApiClient — T45b tradeManual', () => {
  it('POST /api/trade/manual with token sends Authorization header + JSON body', async () => {
    nextResponse = new FakeResponse(200, { ok: true, swap: { ok: true, txid: 'a'.repeat(64) } });
    const c = createApiClient({ token: 't' });
    const r = await c.tradeManual({ token_id: 'a'.repeat(64), side: 'buy', amount_bch: 0.005, dry_run: false });
    strictEqual(r.ok, true);
    strictEqual(lastFetchArgs.url, '/api/trade/manual');
    strictEqual(lastFetchArgs.init.method, 'POST');
    strictEqual(lastFetchArgs.init.headers.Authorization, 'Bearer t');
    strictEqual(lastFetchArgs.init.headers['Content-Type'], 'application/json');
    const body = JSON.parse(lastFetchArgs.init.body);
    strictEqual(body.token_id, 'a'.repeat(64));
    strictEqual(body.side, 'buy');
    strictEqual(body.amount_bch, 0.005);
    strictEqual(body.dry_run, false);
  });

  it('POST /api/trade/manual refuses non-object bodies without a network call', async () => {
    const c = createApiClient({ token: 't' });
    const r1 = await c.tradeManual(null);
    strictEqual(r1.ok, false);
    strictEqual(r1.status, 400);
    const r2 = await c.tradeManual('garbage');
    strictEqual(r2.ok, false);
    strictEqual(r2.status, 400);
    const r3 = await c.tradeManual([]);
    strictEqual(r3.ok, false);
    strictEqual(r3.status, 400);
  });

  it('POST /api/trade/manual surfaces 503 AUTH_NOT_CONFIGURED without throwing', async () => {
    // AUTH_NOT_CONFIGURED envelope is HTTP 200 with typed-error body.
    nextResponse = new FakeResponse(200, { error: 'AUTH_NOT_CONFIGURED', code: 'AUTH_NOT_CONFIGURED' });
    const c = createApiClient({ token: '' });
    const r = await c.tradeManual({ token_id: 'a'.repeat(64), side: 'buy', amount_bch: 0.001 });
    strictEqual(r.ok, true);
    strictEqual(r.data.error, 'AUTH_NOT_CONFIGURED');
    strictEqual(r.data.code, 'AUTH_NOT_CONFIGURED');
  });

  it('POST /api/trade/manual surfaces slippage_exceeded envelope', async () => {
    nextResponse = new FakeResponse(200, {
      ok: false,
      swap: { ok: false, errorKind: 'slippage_exceeded', error: 'expected 5000 bps exceeds tolerance 100 bps' },
    });
    const c = createApiClient({ token: 't' });
    const r = await c.tradeManual({ token_id: 'a'.repeat(64), side: 'buy', amount_bch: 0.001 });
    strictEqual(r.ok, true);
    strictEqual(r.data.swap.errorKind, 'slippage_exceeded');
  });
});


// ────────────────────────────────────────────────────────────────────
//  O03 (idea_operator_position-prevent-stop-loss-with-profit-target_20260917):
//  PUT /api/positions/:id/overrides client method.
// ────────────────────────────────────────────────────────────────────

describe('api.updatePositionOverrides', () => {
  it('PUTs body to /api/positions/:id/overrides with the given id', async () => {
    nextResponse = new FakeResponse(200, {
      schema: 'tradebot.dashboard.position.overrides/v1',
      ok: true,
      position: {
        id: 'pos_x',
        exit_overrides: { prevent_stop_loss: true, profit_target_pct: 7.5 },
      },
    });
    const api = createApiClient({ token: 'tok' });
    const r = await api.updatePositionOverrides('pos_x', { prevent_stop_loss: true, profit_target_pct: 7.5 });
    ok(r.ok, 'result.ok should be true');
    strictEqual(r.status, 200);
    strictEqual(lastFetchArgs.url, '/api/positions/pos_x/overrides');
    strictEqual(lastFetchArgs.init.method, 'PUT');
    strictEqual(lastFetchArgs.init.headers['Content-Type'], 'application/json');
    strictEqual(lastFetchArgs.init.headers.Authorization, 'Bearer tok');
    const body = JSON.parse(lastFetchArgs.init.body);
    strictEqual(body.prevent_stop_loss, true);
    strictEqual(body.profit_target_pct, 7.5);
  });

  it('empty id → client-side 400', async () => {
    const api = createApiClient({ token: 'tok' });
    const r = await api.updatePositionOverrides('', { prevent_stop_loss: true, profit_target_pct: 10 });
    strictEqual(r.ok, false);
    strictEqual(r.status, 400);
    strictEqual(r.error, 'invalid_position_id');
  });

  it('null body → client-side 400', async () => {
    const api = createApiClient({ token: 'tok' });
    const r = await api.updatePositionOverrides('pos_x', null);
    strictEqual(r.ok, false);
    strictEqual(r.status, 400);
    strictEqual(r.error, 'body must be a JSON object');
  });

  it('array body → client-side 400', async () => {
    const api = createApiClient({ token: 'tok' });
    const r = await api.updatePositionOverrides('pos_x', []);
    strictEqual(r.ok, false);
    strictEqual(r.status, 400);
    strictEqual(r.error, 'body must be a JSON object');
  });

  it('special characters in id are URL-encoded', async () => {
    nextResponse = new FakeResponse(200, { ok: true, position: { id: 'pos_a.b-c', exit_overrides: {} } });
    const api = createApiClient({ token: 'tok' });
    await api.updatePositionOverrides('pos_a.b-c', { prevent_stop_loss: true, profit_target_pct: 5 });
    // encodeURIComponent doesn't touch alphanumerics + dash + underscore, so 'pos_a.b-c' stays the same.
    strictEqual(lastFetchArgs.url, '/api/positions/pos_a.b-c/overrides');
  });

  // Bug bug-both-graphs-on-the-dashboard-dont-seem-to-reflect-positions-20260918
  // (O03 follow-up): the response echoes back `current_worth_sats`
  // as a string-encoded sat amount, NOT a BCH float. The Portfolio
  // view reads this field and feeds it to formatBch(sats) — formatBch
  // expects sats, so a BCH float here would render "0.00000000 BCH"
  // for every position. Lock the wire shape so the unit can't drift.
  it('echoes back current_worth_sats (string sats), not current_worth_bch (float)', async () => {
    nextResponse = new FakeResponse(200, {
      ok: true,
      position: {
        id: 'pos_tlgxyvaq_0007',
        exit_overrides: { prevent_stop_loss: true, profit_target_pct: 15 },
        current_worth_sats: '495755',
        current_pct_change: -0.2382586192671523,
      },
    });
    const api = createApiClient({ token: 'tok' });
    const r = await api.updatePositionOverrides('pos_tlgxyvaq_0007', { prevent_stop_loss: true, profit_target_pct: 15 });
    strictEqual(r.ok, true);
    // The sats string '495755' is what the dashboard will pass to
    // formatBch — it'll render as "0.00495755 BCH". A BCH float
    // here (0.00495755) would render as "0.00000000 BCH" — the
    // exact O03 regression this test catches.
    strictEqual(r.data.position.current_worth_sats, '495755');
    strictEqual(typeof r.data.position.current_worth_sats, 'string');
    strictEqual(r.data.position.current_worth_bch, undefined, 'old BCH-float field must be removed from the wire');
  });
});
