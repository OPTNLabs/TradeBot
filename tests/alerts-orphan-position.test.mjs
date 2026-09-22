#!/usr/bin/env node
// tests/alerts-orphan-position.test.mjs
//
// T59 subset 1 — orphan-position alert unit tests.
//
// Covers the pure helpers in `src/alerts/orphan-position.mjs`:
//   - `isOrphanFinding` predicate
//   - `buildOrphanAlertEvent` shape (severity / kind / body / context)
//   - `computeOrphanAgeMs` (string / number / null / bad inputs)
//   - `mapFindingsToOrphanAlerts` (filter + map + ordering)
//   - `indexOpenPositionsById` (defensive)
//   - `pickOrphanPositions` (filter + mismatch)
//   - `dispatchOrphanAlerts` (router wiring / appender wiring /
//     never-throws on individual failures / no-op on empty findings /
//     per-event logger fires)
//
// Mirrors the test patterns from `tests/alerts-dispatch-points.test.mjs`
// + `tests/alerts-persist.test.mjs` so the test infrastructure is
// familiar to future maintainers.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ORPHAN_POSITION_ALERT_KIND,
  ORPHAN_FINDING_KIND,
  ORPHAN_FINDING_SEVERITY,
  isOrphanFinding,
  buildOrphanAlertEvent,
  computeOrphanAgeMs,
  mapFindingsToOrphanAlerts,
  dispatchOrphanAlerts,
  indexOpenPositionsById,
  pickOrphanPositions,
} from '../src/alerts/orphan-position.mjs';

// ─── Test fixtures ──────────────────────────────────────────────────────

// NOW_MS is anchored to 2026-09-18 18:30 UTC (a realistic
// supervisor-tick time) so the age math in the tests reflects a
// real orphan ~17 days old rather than a contrived epoch-ms value
// that pre-dates the position's entry.ts.
const NOW_MS = 1_789_756_200_000;
const POS_ID = 'pos_test_orphan_0001';
const TOKEN_ID = 'a'.repeat(64);
const FINDING = {
  kind: 'on_disk_only',
  severity: 'high',
  token_id: TOKEN_ID,
  position_id: POS_ID,
  token_symbol: 'TST',
  summary: 'position pos_test_orphan_0001 is open but wallet holds 0 tokens for TST — likely sold off-chain',
  details: {
    expected_token_amount_base: '1000',
    wallet_token_amount_base: '0',
    subtype: 'sold_off_chain',
  },
  recommended_action: 'scripts/reconcile-position.mjs --position-id ' + POS_ID,
};

const POSITION = {
  id: POS_ID,
  token_id: TOKEN_ID,
  token_symbol: 'TST',
  status: 'open',
  entry: {
    txid: 'b'.repeat(64),
    ts: '2026-09-01T12:00:00.000Z',
    bch_spent_sats: 100000,
    token_amount_base: '1000',
  },
};

// ─── isOrphanFinding ────────────────────────────────────────────────────

test('orphan-position: isOrphanFinding returns true for on_disk_only / high / position_id', () => {
  assert.equal(isOrphanFinding(FINDING), true);
});

test('orphan-position: isOrphanFinding rejects non-object input', () => {
  assert.equal(isOrphanFinding(null), false);
  assert.equal(isOrphanFinding(undefined), false);
  assert.equal(isOrphanFinding(42), false);
  assert.equal(isOrphanFinding('on_disk_only'), false);
  assert.equal(isOrphanFinding([]), false);
});

test('orphan-position: isOrphanFinding rejects wrong kind', () => {
  const f = { ...FINDING, kind: 'quantity_mismatch' };
  assert.equal(isOrphanFinding(f), false);
});

test('orphan-position: isOrphanFinding rejects medium severity', () => {
  const f = { ...FINDING, severity: 'medium' };
  assert.equal(isOrphanFinding(f), false);
});

test('orphan-position: isOrphanFinding rejects missing position_id', () => {
  const f = { ...FINDING };
  delete f.position_id;
  assert.equal(isOrphanFinding(f), false);
  const f2 = { ...FINDING, position_id: '' };
  assert.equal(isOrphanFinding(f2), false);
});

test('orphan-position: isOrphanFinding constants match T47 contract', () => {
  assert.equal(ORPHAN_FINDING_KIND, 'on_disk_only');
  assert.equal(ORPHAN_FINDING_SEVERITY, 'high');
  assert.equal(ORPHAN_POSITION_ALERT_KIND, 'orphan_position');
});

// ─── computeOrphanAgeMs ─────────────────────────────────────────────────

test('orphan-position: computeOrphanAgeMs handles number epoch ms', () => {
  const age = computeOrphanAgeMs(NOW_MS - 3600000, NOW_MS);
  assert.equal(age, 3600000);
});

test('orphan-position: computeOrphanAgeMs handles ISO string', () => {
  const iso = new Date(NOW_MS - 7200000).toISOString();
  const age = computeOrphanAgeMs(iso, NOW_MS);
  assert.equal(age, 7200000);
});

test('orphan-position: computeOrphanAgeMs returns 0 for negative age', () => {
  // Entry timestamp is in the future relative to `nowMs` — that's
  // a clock-skew / bad-data case; the helper must not return a
  // negative value.
  const age = computeOrphanAgeMs(NOW_MS + 10000, NOW_MS);
  assert.equal(age, 0);
});

test('orphan-position: computeOrphanAgeMs returns null for bad inputs', () => {
  assert.equal(computeOrphanAgeMs(null, NOW_MS), null);
  assert.equal(computeOrphanAgeMs(undefined, NOW_MS), null);
  assert.equal(computeOrphanAgeMs('not-a-date', NOW_MS), null);
  assert.equal(computeOrphanAgeMs(NaN, NOW_MS), null);
  assert.equal(computeOrphanAgeMs(NOW_MS, NaN), null);
});

test('orphan-position: computeOrphanAgeMs returns null for empty string', () => {
  assert.equal(computeOrphanAgeMs('', NOW_MS), null);
});

// ─── buildOrphanAlertEvent ──────────────────────────────────────────────

test('orphan-position: buildOrphanAlertEvent shape', () => {
  const ev = buildOrphanAlertEvent({ finding: FINDING, position: POSITION, nowMs: NOW_MS });
  assert.equal(ev.kind, ORPHAN_POSITION_ALERT_KIND);
  assert.equal(ev.severity, 'warn');
  assert.equal(ev.title, `orphan_position:${POS_ID}`);
  assert.equal(ev.ts, NOW_MS);
  assert.ok(typeof ev.body === 'string' && ev.body.length > 0);
  assert.ok(ev.body.includes(POS_ID), 'body must include position_id');
  assert.ok(ev.body.includes('TST'), 'body must include token_symbol');
});

test('orphan-position: buildOrphanAlertEvent context fields', () => {
  const ev = buildOrphanAlertEvent({ finding: FINDING, position: POSITION, nowMs: NOW_MS });
  assert.equal(ev.context.position_id, POS_ID);
  assert.equal(ev.context.token_id, TOKEN_ID);
  assert.equal(ev.context.token_symbol, 'TST');
  assert.equal(ev.context.expected_token_amount_base, '1000');
  assert.equal(ev.context.wallet_token_amount_base, '0');
  assert.equal(ev.context.finding_kind, 'on_disk_only');
  assert.equal(ev.context.finding_severity, 'high');
  assert.equal(ev.context.recommended_action, FINDING.recommended_action);
  // age_ms should be the difference between NOW_MS and the entry.ts.
  const expectedAgeMs = NOW_MS - Date.parse(POSITION.entry.ts);
  assert.equal(ev.context.age_ms, expectedAgeMs);
  assert.equal(ev.context.age_hours, Math.floor(expectedAgeMs / 3600000));
  assert.equal(ev.context.now_ms, NOW_MS);
});

test('orphan-position: buildOrphanAlertEvent without position still produces alert (age=null)', () => {
  const ev = buildOrphanAlertEvent({ finding: FINDING, nowMs: NOW_MS });
  assert.equal(ev.kind, ORPHAN_POSITION_ALERT_KIND);
  assert.equal(ev.context.position_id, POS_ID);
  assert.equal(ev.context.age_ms, null);
  assert.equal(ev.context.age_hours, null);
});

test('orphan-position: buildOrphanAlertEvent accepts event_id', () => {
  const ev = buildOrphanAlertEvent({ finding: FINDING, nowMs: NOW_MS, event_id: 'evt_xyz' });
  assert.equal(ev.event_id, 'evt_xyz');
});

test('orphan-position: buildOrphanAlertEvent throws on missing finding', () => {
  assert.throws(() => buildOrphanAlertEvent({ nowMs: NOW_MS }), /finding must be/);
  assert.throws(() => buildOrphanAlertEvent({ finding: null, nowMs: NOW_MS }), /finding must be/);
});

test('orphan-position: buildOrphanAlertEvent throws on bad nowMs', () => {
  assert.throws(() => buildOrphanAlertEvent({ finding: FINDING, nowMs: NaN }), /nowMs/);
  assert.throws(() => buildOrphanAlertEvent({ finding: FINDING }), /nowMs/);
});

// ─── mapFindingsToOrphanAlerts ──────────────────────────────────────────

test('orphan-position: mapFindingsToOrphanAlerts filters to orphan findings only', () => {
  const findings = [
    FINDING,                                                               // on_disk_only / high  → kept
    { ...FINDING, kind: 'quantity_mismatch', severity: 'medium' },          // rejected (wrong kind + severity)
    { ...FINDING, position_id: 'pos_2', severity: 'low' },                  // rejected (severity)
    { kind: 'on_disk_only', severity: 'high', position_id: 'pos_3', token_id: TOKEN_ID, token_symbol: 'ABC' },  // kept
    { kind: 'consensus', severity: 'low', position_id: 'pos_4' },           // rejected
    null,                                                                   // rejected (malformed)
  ];
  const events = mapFindingsToOrphanAlerts(findings, { nowMs: NOW_MS });
  assert.equal(events.length, 2);
  assert.equal(events[0].context.position_id, POS_ID);
  assert.equal(events[1].context.position_id, 'pos_3');
  assert.equal(events[0].kind, ORPHAN_POSITION_ALERT_KIND);
  assert.equal(events[1].kind, ORPHAN_POSITION_ALERT_KIND);
});

test('orphan-position: mapFindingsToOrphanAlerts returns [] for bad input', () => {
  assert.deepEqual(mapFindingsToOrphanAlerts(null, { nowMs: NOW_MS }), []);
  assert.deepEqual(mapFindingsToOrphanAlerts([], { nowMs: NOW_MS }), []);
  assert.deepEqual(mapFindingsToOrphanAlerts([FINDING], { nowMs: NaN }), []);
  assert.deepEqual(mapFindingsToOrphanAlerts('not-an-array', { nowMs: NOW_MS }), []);
});

test('orphan-position: mapFindingsToOrphanAlerts stamps age via positionIndex', () => {
  const idx = new Map([[POS_ID, POSITION]]);
  const events = mapFindingsToOrphanAlerts([FINDING], { nowMs: NOW_MS, positionIndex: idx });
  const expectedAge = NOW_MS - Date.parse(POSITION.entry.ts);
  assert.equal(events[0].context.age_ms, expectedAge);
});

test('orphan-position: mapFindingsToOrphanAlerts age=null when positionIndex miss', () => {
  const idx = new Map();  // empty
  const events = mapFindingsToOrphanAlerts([FINDING], { nowMs: NOW_MS, positionIndex: idx });
  assert.equal(events[0].context.age_ms, null);
});

// ─── indexOpenPositionsById ─────────────────────────────────────────────

test('orphan-position: indexOpenPositionsById indexes by id', () => {
  const idx = indexOpenPositionsById([POSITION, { id: 'pos_2' }, null, {}, { id: 42 }, { id: '' }]);
  assert.equal(idx.size, 2);
  assert.equal(idx.get(POS_ID), POSITION);
  assert.equal(idx.get('pos_2').id, 'pos_2');
});

test('orphan-position: indexOpenPositionsById handles bad input', () => {
  assert.equal(indexOpenPositionsById(null).size, 0);
  assert.equal(indexOpenPositionsById(undefined).size, 0);
  assert.equal(indexOpenPositionsById('not-array').size, 0);
});

// ─── pickOrphanPositions ────────────────────────────────────────────────

test('orphan-position: pickOrphanPositions returns only positions referenced by orphan findings', () => {
  const positions = [
    POSITION,
    { id: 'pos_2', token_id: TOKEN_ID },
    { id: 'pos_3', token_id: TOKEN_ID },
  ];
  const findings = [
    FINDING,                                                                       // references pos_1
    { kind: 'on_disk_only', severity: 'high', position_id: 'pos_3', token_id: TOKEN_ID },  // references pos_3
    { kind: 'quantity_mismatch', severity: 'medium', position_id: 'pos_2' },       // ignored
  ];
  const picked = pickOrphanPositions(findings, positions);
  assert.equal(picked.length, 2);
  assert.deepEqual(picked.map((p) => p.id).sort(), [POS_ID, 'pos_3'].sort());
});

test('orphan-position: pickOrphanPositions tolerates bad input', () => {
  assert.deepEqual(pickOrphanPositions(null, null), []);
  assert.deepEqual(pickOrphanPositions([], []), []);
  assert.deepEqual(pickOrphanPositions([FINDING], null), []);
});

// ─── dispatchOrphanAlerts ───────────────────────────────────────────────

test('orphan-position: dispatchOrphanAlerts wires router + appender for each finding', async () => {
  let routerCalls = 0;
  let appenderCalls = 0;
  const router = { dispatch: async (e) => { routerCalls += 1; assert.equal(e.kind, ORPHAN_POSITION_ALERT_KIND); return { ok: true, dispatched: 1, channels_ready: 1, errors: [] }; } };
  const appender = async (e) => { appenderCalls += 1; assert.ok(e.context.position_id); return { ok: true }; };
  // Capture every logger call as `[message, payload]` so the
  // dispatch-event assertion can match on either.
  const loggerEvents = [];
  const logger = {
    warn: (msg, payload) => loggerEvents.push([msg, payload]),
    info: (msg, payload) => loggerEvents.push([msg, payload]),
    error: (msg, payload) => loggerEvents.push([msg, payload]),
  };

  const result = await dispatchOrphanAlerts({
    router,
    appender,
    findings: [FINDING, { ...FINDING, position_id: 'pos_2' }],
    nowMs: NOW_MS,
    logger,
  });

  assert.equal(result.ok, true);
  assert.equal(result.events.length, 2);
  assert.equal(result.dispatched, 2);
  assert.equal(result.persisted, 2);
  assert.equal(result.failed, 0);
  assert.equal(result.errors.length, 0);
  assert.equal(routerCalls, 2);
  assert.equal(appenderCalls, 2);
  // One info log per dispatch.
  const dispatchLogs = loggerEvents.filter(([msg, payload]) =>
    msg === 'alerts.orphan_position.dispatch' && payload && payload.event === 'alerts.orphan_position.dispatch');
  assert.equal(dispatchLogs.length, 2);
});

test('orphan-position: dispatchOrphanAlerts is a no-op on empty findings', async () => {
  let routerCalls = 0;
  let appenderCalls = 0;
  const router = { dispatch: async () => { routerCalls += 1; return { ok: true }; } };
  const appender = async () => { appenderCalls += 1; return { ok: true }; };
  const result = await dispatchOrphanAlerts({ router, appender, findings: [], nowMs: NOW_MS });
  assert.equal(result.ok, true);
  assert.equal(result.events.length, 0);
  assert.equal(result.dispatched, 0);
  assert.equal(result.persisted, 0);
  assert.equal(routerCalls, 0);
  assert.equal(appenderCalls, 0);
});

test('orphan-position: dispatchOrphanAlerts never throws on router failure (captured in errors)', async () => {
  const router = { dispatch: async () => { throw new Error('telegram-down'); } };
  const appender = async () => ({ ok: true });
  const logger = { warn: () => {}, info: () => {}, error: (e) => { /* captures the dispatch.failed */ } };
  const result = await dispatchOrphanAlerts({
    router, appender, findings: [FINDING], nowMs: NOW_MS, logger,
  });
  assert.equal(result.ok, false);
  assert.equal(result.persisted, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].stage, 'dispatch');
  assert.equal(result.errors[0].position_id, POS_ID);
  assert.match(result.errors[0].error, /telegram-down/);
});

test('orphan-position: dispatchOrphanAlerts never throws on appender failure (captured in errors)', async () => {
  const router = { dispatch: async () => ({ ok: true, dispatched: 1 }) };
  const appender = async () => ({ ok: false, error: { message: 'disk-full' } });
  const logger = { warn: () => {}, info: () => {}, error: () => {} };
  const result = await dispatchOrphanAlerts({
    router, appender, findings: [FINDING], nowMs: NOW_MS, logger,
  });
  assert.equal(result.ok, false);
  assert.equal(result.dispatched, 1);
  assert.equal(result.persisted, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].stage, 'persist');
  assert.match(result.errors[0].error, /disk-full/);
});

test('orphan-position: dispatchOrphanAlerts tolerates null router', async () => {
  const appender = async () => ({ ok: true });
  const result = await dispatchOrphanAlerts({
    router: null, appender, findings: [FINDING], nowMs: NOW_MS,
  });
  assert.equal(result.ok, true);
  assert.equal(result.persisted, 1);
  assert.equal(result.dispatched, 0);
});

test('orphan-position: dispatchOrphanAlerts tolerates null appender', async () => {
  const router = { dispatch: async () => ({ ok: true, dispatched: 1, channels_ready: 1, errors: [] }) };
  const result = await dispatchOrphanAlerts({
    router, appender: null, findings: [FINDING], nowMs: NOW_MS,
  });
  assert.equal(result.ok, true);
  assert.equal(result.dispatched, 1);
  assert.equal(result.persisted, 0);
});

test('orphan-position: dispatchOrphanAlerts handles router returning ok:false', async () => {
  const router = { dispatch: async () => ({ ok: false, dispatched: 0, channels_ready: 0, errors: [{ channel: 'telegram', error: 'rate-limited' }] }) };
  const appender = async () => ({ ok: true });
  const logger = { warn: () => {}, info: () => {}, error: () => {} };
  const result = await dispatchOrphanAlerts({
    router, appender, findings: [FINDING], nowMs: NOW_MS, logger,
  });
  // ok:true because the event was persisted + the router captured
  // the per-channel failure (no exception escaped). The router's
  // ok:false is surfaced as a no_op warning, NOT as a hard fail.
  assert.equal(result.ok, true);
  assert.equal(result.dispatched, 1);  // we still attempted
  assert.equal(result.persisted, 1);
  assert.equal(result.failed, 0);
});

test('orphan-position: dispatchOrphanAlerts skips non-orphan findings silently', async () => {
  const router = { dispatch: async () => ({ ok: true }) };
  const appender = async () => ({ ok: true });
  const result = await dispatchOrphanAlerts({
    router, appender,
    findings: [
      { kind: 'quantity_mismatch', severity: 'medium', position_id: 'pos_a' },
      { kind: 'consensus', severity: 'low', position_id: 'pos_b' },
    ],
    nowMs: NOW_MS,
  });
  assert.equal(result.events.length, 0);
  assert.equal(result.dispatched, 0);
  assert.equal(result.persisted, 0);
});

// ─── CLI arg parsing ────────────────────────────────────────────────────

test('orphan-position: parseCheckOrphanArgs defaults', async () => {
  const { parseCheckOrphanArgs, resolveCheckOrphanArgs } = await import('../scripts/check-orphan-positions.mjs');
  const { flags } = parseCheckOrphanArgs(['node', 'check-orphan-positions.mjs']);
  const args = resolveCheckOrphanArgs(flags);
  assert.equal(args.positionsFile, 'data/positions.json');
  assert.equal(args.json, false);
  assert.equal(args.quiet, false);
  assert.equal(args.dryRun, false);
  assert.equal(args.noDispatch, false);
  assert.equal(args.help, false);
});

test('orphan-position: parseCheckOrphanArgs flags', async () => {
  const { parseCheckOrphanArgs, resolveCheckOrphanArgs } = await import('../scripts/check-orphan-positions.mjs');
  const { flags } = parseCheckOrphanArgs([
    'node', 'check-orphan-positions.mjs',
    '--positions-file=/tmp/p.json', '--json', '--quiet', '--dry-run', '--no-dispatch',
  ]);
  const args = resolveCheckOrphanArgs(flags);
  assert.equal(args.positionsFile, '/tmp/p.json');
  assert.equal(args.json, true);
  assert.equal(args.quiet, true);
  assert.equal(args.dryRun, true);
  assert.equal(args.noDispatch, true);
});

test('orphan-position: parseCheckOrphanArgs sets help=true on --help', async () => {
  const { parseCheckOrphanArgs, resolveCheckOrphanArgs } = await import('../scripts/check-orphan-positions.mjs');
  const { flags } = parseCheckOrphanArgs(['node', 'check-orphan-positions.mjs', '--help']);
  assert.equal(resolveCheckOrphanArgs(flags).help, true);
});

test('orphan-position: resolveCheckOrphanArgs rejects unknown flags', async () => {
  const { parseCheckOrphanArgs, resolveCheckOrphanArgs } = await import('../scripts/check-orphan-positions.mjs');
  const { flags } = parseCheckOrphanArgs(['node', 'check-orphan-positions.mjs', '--wat']);
  assert.throws(() => resolveCheckOrphanArgs(flags), /unknown flag --wat/);
});

// ─── CLI main() ─────────────────────────────────────────────────────────

test('orphan-position: main() returns help=ok when --help passed', async () => {
  const { main } = await import('../scripts/check-orphan-positions.mjs');
  process.env.ORPHAN_CHECK_HELP_QUIET = '1';  // suppress the print
  const result = await main({ argv: ['node', 'check-orphan-positions.mjs', '--help'] });
  delete process.env.ORPHAN_CHECK_HELP_QUIET;
  assert.equal(result.code, 0);
  assert.equal(result.ok, true);
  assert.equal(result.args.help, true);
});

test('orphan-position: main() returns code=3 on unknown flag', async () => {
  const { main } = await import('../scripts/check-orphan-positions.mjs');
  const result = await main({ argv: ['node', 'check-orphan-positions.mjs', '--unknown-flag'] });
  assert.equal(result.code, 3);
  assert.equal(result.ok, false);
  assert.match(result.error, /unknown flag/);
});

test('orphan-position: main() with stubbed wallet: orphan-found path', async () => {
  const { main } = await import('../scripts/check-orphan-positions.mjs');

  // Stub wallet provider — returns zero token UTXOs so every open
  // position becomes an orphan finding.
  const walletProvider = { getUtxos: async () => [] };
  let appended = [];
  const appender = async (ev) => { appended.push(ev); return { ok: true }; };
  let dispatched = [];
  const router = { dispatch: async (ev) => { dispatched.push(ev); return { ok: true, dispatched: 1, channels_ready: 1, errors: [] }; } };

  // Stub positions: build a fake Positions-like object via the
  // `deps.positions` seam. The default `Positions` constructor
  // reads from disk, which we want to avoid in tests.
  let loadCalls = 0;
  const fakePositions = {
    _data: { positions: [POSITION, { ...POSITION, id: 'pos_orphan_2' }] },
    init: async () => { loadCalls += 1; },
    all: function () { return this._data.positions; },
  };

  const result = await main({
    argv: ['node', 'check-orphan-positions.mjs', '--json'],
    deps: {
      positions: /** @type {any} */ (function FakePositions() { return fakePositions; }),
      walletProvider,
      appender,
      router,
      nowMs: () => NOW_MS,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    },
  });

  assert.equal(loadCalls, 1);
  assert.equal(result.code, 1, 'orphan-found should yield exit code 1');
  assert.equal(result.ok, false);
  assert.equal(result.report.orphans.findings.length, 2);
  assert.equal(result.report.orphans.events.length, 2);
  assert.equal(result.report.alerts_dispatched, 2);
  assert.equal(result.report.alerts_persisted, 2);
  assert.equal(appended.length, 2);
  assert.equal(dispatched.length, 2);
});

test('orphan-position: main() with stubbed wallet: clean-tree path', async () => {
  const { main } = await import('../scripts/check-orphan-positions.mjs');

  // Stub wallet returns enough tokens to satisfy the position.
  const walletProvider = { getUtxos: async () => ([{
    satoshis: 0,
    token: {
      category: TOKEN_ID,
      amount: '1000',
      nft: { capability: 'none', commitment: '' },
    },
  }]) };

  const fakePositions = {
    _data: { positions: [POSITION] },
    init: async () => {},
    all: function () { return this._data.positions; },
  };

  const result = await main({
    argv: ['node', 'check-orphan-positions.mjs', '--json'],
    deps: {
      positions: /** @type {any} */ (function FakePositions() { return fakePositions; }),
      walletProvider,
      nowMs: () => NOW_MS,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    },
  });

  assert.equal(result.code, 0);
  assert.equal(result.ok, true);
  assert.equal(result.report.orphans.findings.length, 0);
});

test('orphan-position: main() --dry-run path skips wallet boot + dispatch', async () => {
  const { main } = await import('../scripts/check-orphan-positions.mjs');

  // We MUST NOT need to inject a wallet provider in dry-run mode
  // — the script should bail before touching the wallet. If it
  // tries, the test fails because no walletProvider is provided.
  let walletProviderCalled = false;
  const walletProvider = { getUtxos: async () => { walletProviderCalled = true; return []; } };

  const fakePositions = {
    _data: { positions: [POSITION] },
    init: async () => {},
    all: function () { return this._data.positions; },
  };

  let appended = 0;
  const appender = async () => { appended += 1; return { ok: true }; };

  const result = await main({
    argv: ['node', 'check-orphan-positions.mjs', '--dry-run', '--json'],
    deps: {
      positions: /** @type {any} */ (function FakePositions() { return fakePositions; }),
      walletProvider,
      appender,
      nowMs: () => NOW_MS,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    },
  });

  assert.equal(walletProviderCalled, false, 'dry-run must NOT call wallet');
  assert.equal(appended, 0, 'dry-run must NOT append alerts');
  // Dry-run reports orphan findings (the diff runs against an
  // implicit empty UTXO set), but with alerts_dispatched=0.
  assert.equal(result.code, 1, 'orphan-found path');
  assert.equal(result.report.dry_run, true);
  assert.equal(result.report.alerts_dispatched, 0);
  assert.equal(result.report.alerts_persisted, 0);
});

test('orphan-position: main() --no-dispatch path boots wallet + computes diff but skips alerts', async () => {
  const { main } = await import('../scripts/check-orphan-positions.mjs');

  const walletProvider = { getUtxos: async () => [] };  // empty → all orphans
  let appended = 0;
  const appender = async () => { appended += 1; return { ok: true }; };

  const fakePositions = {
    _data: { positions: [POSITION] },
    init: async () => {},
    all: function () { return this._data.positions; },
  };

  const result = await main({
    argv: ['node', 'check-orphan-positions.mjs', '--no-dispatch', '--json'],
    deps: {
      positions: /** @type {any} */ (function FakePositions() { return fakePositions; }),
      walletProvider,
      appender,
      nowMs: () => NOW_MS,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    },
  });

  assert.equal(result.code, 1, 'orphan-found path');
  assert.equal(result.report.no_dispatch, true);
  assert.equal(appended, 0, 'no-dispatch must NOT append alerts');
  assert.equal(result.report.alerts_dispatched, 0);
  assert.equal(result.report.orphans.findings.length, 1);
});

test('orphan-position: main() returns code=2 on wallet error', async () => {
  const { main } = await import('../scripts/check-orphan-positions.mjs');

  const walletProvider = { getUtxos: async () => { throw new Error('electrum-down'); } };

  const fakePositions = {
    _data: { positions: [POSITION] },
    init: async () => {},
    all: function () { return this._data.positions; },
  };

  const result = await main({
    argv: ['node', 'check-orphan-positions.mjs', '--json'],
    deps: {
      positions: /** @type {any} */ (function FakePositions() { return fakePositions; }),
      walletProvider,
      nowMs: () => NOW_MS,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    },
  });

  assert.equal(result.code, 2);
  assert.equal(result.ok, false);
  assert.match(result.error, /electrum-down/);
});
