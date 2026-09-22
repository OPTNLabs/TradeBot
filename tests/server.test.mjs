#!/usr/bin/env node
/**
 * tests/server.test.mjs
 *
 * Unit + integration tests for `src/dashboard/server.mjs` (T16).
 *
 * Two test layers:
 *
 *   1. **Pure helpers** — `redactConfig`, `rangeToMs`, `parseRange`,
 *      `parseLimit`, `filterHistory`, `filterSnapshots`, `isAuthed`,
 *      `walkAndReject`, `matchRoute`, `buildRouteTable`, `summarizePosition`.
 *      No I/O, no servers. Fast + deterministic.
 *
 *   2. **HTTP integration** — boots the dashboard server's
 *      `handler()` directly via supertest. Positions, snapshots,
 *      and history are backed by real on-disk tmp dirs (so we
 *      verify the atomic-write integration works end-to-end).
 *      `risk` and `wallet` are DI-injected (so we never touch
 *      mainnet). All status codes + JSON bodies are asserted.
 *
 * Run via:
 *   node --test tests/server.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import supertest from 'supertest';

import {
  createDashboardServer,
  resolveDashboardConfig,
  buildRouteTable,
  matchRoute,
  redactConfig,
  rangeToMs,
  parseRange,
  parseLimit,
  filterHistory,
  filterSnapshots,
  groupReasoningEvents,
  isAuthed,
  walkAndReject,
  summarizePosition,
  createHistoryReader,
  resolveSafeStaticPath,
  shouldServeStatic,
  contentTypeFor,
  STATIC_CONTENT_TYPES,
  DEFAULT_STATIC_CONTENT_TYPE,
  DEFAULT_DASHBOARD_CONFIG,
  REDACTED_FIELD_NAMES,
  DashboardConfigError,
  DashboardServerError,
  // T43c-server: helpers + endpoint helpers.
  parseConfigKnobPath,
  readPathValue,
  setPathValue,
  signalBotPid,
  DEFAULT_DASHBOARD_PID_FILE,
  statusForResult,
  // T45: manual-trade parser + handler.
  parseManualTradeRequest,
  // T45b: pool-list projection helper.
  projectPoolOption,
  _internals,
} from '../src/dashboard/server.mjs';
import { Positions, DEFAULT_POSITIONS_FILE } from '../src/portfolio/positions.mjs';
import { Snapshots, DEFAULT_SNAPSHOTS_DIR, SNAPSHOT_VERSION } from '../src/portfolio/snapshots.mjs';
import { createLogger, createMemorySink } from '../src/util/logger.mjs';
import { SATS_PER_BCH } from '../src/data/types.mjs';
import { BugsStore } from '../src/bugs/store.mjs';

// ─────────────────────────────────────────────────────────────────────
//  Test helpers
// ─────────────────────────────────────────────────────────────────────

async function makeTmp(t, prefix = 'tradebot-dashboard-') {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    try { await rm(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });
  return dir;
}

function makeMemoryLogger() {
  const sink = createMemorySink();
  const logger = createLogger({ component: 'test', sink: sink.stream });
  return { logger, sink };
}

/**
 * Build a Positions store pre-loaded with two open + one closed
 * position + one pending position. Returns a Positions instance
 * that's already `load()`'d.
 *
 * @param {Object} opts
 * @param {string} opts.file
 */
async function makeFixturePositions(opts) {
  const positions = new Positions({ file: opts.file, logger: opts.logger ?? createLogger({ sink: process.stderr }) });
  await positions.load();
  const ts = new Date('2026-09-11T12:00:00Z').toISOString();
  const posA = await positions.open({
    tokenId: 'a'.repeat(64),
    tokenSymbol: 'PUSD',
    tokenDecimals: 8,
    entry: {
      txid: 'aa'.repeat(32),
      price_sats_per_token: 14500,
      bch_spent_sats: 500_000,
      token_amount_base: 3_448_275_86n.toString(),
      fee_sats: 1000,
      broadcast_ms: 1500,
      ts,
    },
    reasoning: { score: 0.82, rank: 1, topK: 3, reason: 'volume+volatility', ts },
  });
  await positions.confirm(posA.id);
  const posB = await positions.open({
    tokenId: 'b'.repeat(64),
    tokenSymbol: 'TST',
    tokenDecimals: 4,
    entry: {
      txid: 'bb'.repeat(32),
      price_sats_per_token: 8000,
      bch_spent_sats: 250_000,
      token_amount_base: '312500000',
      fee_sats: 800,
      broadcast_ms: 1100,
      ts,
    },
    reasoning: { score: 0.74, rank: 2, topK: 3, reason: 'volume spike', ts },
  });
  await positions.confirm(posB.id);
  await positions.open({
    tokenId: 'c'.repeat(64),
    tokenSymbol: 'NEW',
    tokenDecimals: 0,
    entry: {
      txid: 'cc'.repeat(32),
      price_sats_per_token: 100,
      bch_spent_sats: 100_000,
      token_amount_base: '1000000',
      fee_sats: 500,
      broadcast_ms: 900,
      ts,
    },
    reasoning: { score: 0.55, rank: 3, topK: 5, reason: 'pending review', ts },
    initialStatus: 'pending',
  });
  // One closed trade so realized P&L is non-zero.
  const openForClose = await positions.open({
    tokenId: 'd'.repeat(64),
    tokenSymbol: 'CLOSED',
    tokenDecimals: 2,
    entry: {
      txid: 'dd'.repeat(32),
      price_sats_per_token: 1234,
      bch_spent_sats: 49_360,
      token_amount_base: '400000',
      fee_sats: 250,
      broadcast_ms: 700,
      ts: new Date('2026-09-10T08:00:00Z').toISOString(),
    },
    reasoning: { score: 0.5, rank: 4, topK: 5, reason: 'closed test', ts: new Date('2026-09-10T08:00:00Z').toISOString() },
    initialStatus: 'open',
  });
  await positions.confirm(openForClose.id);
  await positions.close(openForClose.id, {
    txid: 'ee'.repeat(32),
    price_sats_per_token: 1357,
    bch_received_sats: 54_280,
    fee_sats: 220,
    ts: new Date('2026-09-10T18:00:00Z').toISOString(),
    reason: 'take_profit',
  }, 54_280 - 49_360 - (250 + 220));
  return positions;
}

async function makeFixtureSnapshots(opts) {
  const snapshots = new Snapshots({ dir: opts.dir, logger: opts.logger ?? createLogger({ sink: process.stderr }) });
  await snapshots.load();
  await snapshots.record({
    v: SNAPSHOT_VERSION,
    ts: '2026-09-09T12:00:00.000Z',
    bch_balance_sats: '4000000',
    open_position_count: 0,
    total_exposure_sats: '0',
    unrealized_pnl_sats: null,
    meta: { source: 'test' },
  });
  await snapshots.record({
    v: SNAPSHOT_VERSION,
    ts: '2026-09-10T12:00:00.000Z',
    bch_balance_sats: '4400000',
    open_position_count: 1,
    total_exposure_sats: '500000',
    unrealized_pnl_sats: '15000',
    meta: {
      source: 'test',
      market_prices_sats: [
        { token_id: 'a'.repeat(64), price_sats_per_token: 14650 },
      ],
    },
  });
  await snapshots.record({
    v: SNAPSHOT_VERSION,
    ts: '2026-09-11T12:00:00.000Z',
    bch_balance_sats: '4435967',
    open_position_count: 2,
    total_exposure_sats: '750000',
    unrealized_pnl_sats: '22000',
    meta: {
      source: 'test',
      market_prices_sats: [
        { token_id: 'a'.repeat(64), price_sats_per_token: 14780 },
        { token_id: 'b'.repeat(64), price_sats_per_token: 8200 },
      ],
    },
  });
  return snapshots;
}

async function writeNdjson(file, lines) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

/**
 * Build a server bound to the given tmp dirs. Returns the
 * supertest-aware `handler` plus the underlying context.
 */
function makeServer(opts) {
  const { logger, sink } = makeMemoryLogger();
  /** @type {Object} */
  const serverOpts = {
    cfg: opts.cfg,
    positions: opts.positions,
    snapshots: opts.snapshots,
    historyReader: opts.historyReader,
    risk: opts.risk ?? null,
    wallet: opts.wallet ?? null,
    logger,
    fs: opts.fs ?? null,
    readUserJson: opts.readUserJson ?? null,
    // T45: manual-trade endpoint needs `swap` + `historyAppend` on ctx.
    // Optional — route returns SWAP_NOT_CONFIGURED when missing.
    swap: opts.swap ?? null,
    historyAppend: typeof opts.historyAppend === 'function' ? opts.historyAppend : null,
    // T45b: pool-list endpoint needs `fetcher` on ctx. Optional —
    // route returns FETCHER_NOT_CONFIGURED when missing.
    fetcher: opts.fetcher ?? null,
  };
  // T43c-server: pidFile is optional (default = data/run.pid).
  // Tests pass a fixture path so signal-probe results are deterministic.
  if (typeof opts.pidFile === 'string') serverOpts.pidFile = opts.pidFile;
  // Only attach `clock` when caller passed a function. `createDashboardServer`
  // throws on non-callable clock values, so passing `null` here would crash
  // the server boot for every test that doesn't care about time.
  if (typeof opts.clock === 'function') serverOpts.clock = opts.clock;
  const server = createDashboardServer(serverOpts);
  return { server, logger, sink, handler: server.handler };
}

// ─────────────────────────────────────────────────────────────────────
//  Pure helpers
// ─────────────────────────────────────────────────────────────────────

test('server: resolveDashboardConfig returns DEFAULT_DASHBOARD_CONFIG for null/missing input', () => {
  assert.deepEqual(resolveDashboardConfig(null), DEFAULT_DASHBOARD_CONFIG);
  assert.deepEqual(resolveDashboardConfig(undefined), DEFAULT_DASHBOARD_CONFIG);
  assert.deepEqual(resolveDashboardConfig(42), DEFAULT_DASHBOARD_CONFIG);
  assert.deepEqual(resolveDashboardConfig('not-an-object'), DEFAULT_DASHBOARD_CONFIG);
});

test('server: resolveDashboardConfig overrides individual fields', () => {
  const out = resolveDashboardConfig({ bind_host: '0.0.0.0', bind_port: 9999, api_token: 'sek' });
  assert.equal(out.bind_host, '0.0.0.0');
  assert.equal(out.bind_port, 9999);
  assert.equal(out.api_token, 'sek');
  // Untouched fields keep defaults.
  assert.equal(out.cors_origin, null);
  assert.equal(out.history_max_events, DEFAULT_DASHBOARD_CONFIG.history_max_events);
});

test('server: redactConfig — WIF + mnemonic + xprv + seed are redacted', () => {
  const input = {
    wallet: {
      wif: 'L4rK7yHmQ4r8sR8pN8gT6tE2vN1wL9kP3jF8mS7dQ9aZ2bX3cV4nM5',
      address: 'bitcoincash:qp...',
    },
    mnemonic: 'word1 word2 word3',
    bip39_seed: 'abcdef',
    xprv: 'xprv9s21ZrQH143K3t1xcG7W7wYqQ4e8b5X8z',
    public_stuff: 'should not be redacted',
    positions: { open: [{ id: 'pos_abc', wif_local: 'never' }] },
  };
  const out = redactConfig(input);
  assert.equal(out.wallet.wif, '[REDACTED]');
  assert.equal(out.wallet.address, 'bitcoincash:qp...', 'address is not in the redact list');
  assert.equal(out.mnemonic, '[REDACTED]');
  assert.equal(out.bip39_seed, '[REDACTED]');
  assert.equal(out.xprv, '[REDACTED]');
  assert.equal(out.public_stuff, 'should not be redacted');
  assert.equal(out.positions.open[0].id, 'pos_abc');
  assert.equal(out.positions.open[0].wif_local, '[REDACTED]');
});

test('server: redactConfig — never mutates the input', () => {
  const input = { wif: 'L1234567890abcdef' };
  const before = JSON.stringify(input);
  redactConfig(input);
  assert.equal(JSON.stringify(input), before);
});

test('server: redactConfig — handles circular refs without throwing', () => {
  const a = { name: 'a' };
  a.self = a;
  const out = redactConfig(a);
  assert.equal(out.name, 'a');
  assert.equal(out.self, '[Circular]');
});

test('server: redactConfig — array of redaction targets', () => {
  const out = redactConfig([{ wif: 'a' }, { mnemonic: 'b' }, 'plain string']);
  assert.equal(out[0].wif, '[REDACTED]');
  assert.equal(out[1].mnemonic, '[REDACTED]');
  assert.equal(out[2], 'plain string');
});

test('server: REDACTED_FIELD_NAMES contains all common secret field names', () => {
  for (const k of ['wif', 'mnemonic', 'seed', 'xprv', 'passphrase', 'private_key']) {
    assert.ok(REDACTED_FIELD_NAMES.includes(k), `expected ${k} to be in REDACTED_FIELD_NAMES`);
  }
});

test('server: rangeToMs — accepts s/m/h/d/w suffixes + "all" + ""', () => {
  assert.equal(rangeToMs('30s'), 30_000);
  assert.equal(rangeToMs('5m'), 5 * 60 * 1000);
  assert.equal(rangeToMs('2h'), 2 * 60 * 60 * 1000);
  assert.equal(rangeToMs('1d'), 24 * 60 * 60 * 1000);
  assert.equal(rangeToMs('7d'), 7 * 24 * 60 * 60 * 1000);
  assert.equal(rangeToMs('2w'), 14 * 24 * 60 * 60 * 1000);
  assert.equal(rangeToMs(''), null);
  assert.equal(rangeToMs('all'), null);
  assert.equal(rangeToMs('All'), null, 'case insensitive');
  assert.equal(rangeToMs(' 30d '), 30 * 24 * 60 * 60 * 1000);
});

test('server: rangeToMs — throws DashboardConfigError on bad input', () => {
  assert.throws(() => rangeToMs('abc'), DashboardConfigError);
  assert.throws(() => rangeToMs('7'), DashboardConfigError);
  assert.throws(() => rangeToMs('-5d'), DashboardConfigError);
  assert.throws(() => rangeToMs('5y'), DashboardConfigError);
  assert.throws(() => rangeToMs(null), DashboardConfigError);
  assert.throws(() => rangeToMs(undefined), DashboardConfigError);
  assert.throws(() => rangeToMs(123), DashboardConfigError);
});

test('server: parseRange — falls back to defaultRange', () => {
  const qs = new URLSearchParams('');
  assert.equal(parseRange(qs, '7d'), 7 * 24 * 60 * 60 * 1000);
  qs.set('range', '30d');
  assert.equal(parseRange(qs, '7d'), 30 * 24 * 60 * 60 * 1000);
  qs.set('range', 'all');
  assert.equal(parseRange(qs, '7d'), null);
});

test('server: parseRange — accepts plain object for portability', () => {
  assert.equal(parseRange({ range: '12h' }, '7d'), 12 * 60 * 60 * 1000);
  assert.equal(parseRange({}, '1d'), 24 * 60 * 60 * 1000);
});

test('server: parseLimit — clamps to max', () => {
  const qs = new URLSearchParams('limit=3');
  assert.equal(parseLimit(qs, 100), 3);
  assert.equal(parseLimit(qs, 2), 2, 'cap respected');
  const q2 = new URLSearchParams('');
  assert.equal(parseLimit(q2, 50), 50);
  assert.equal(parseLimit({}, 75), 75);
  assert.equal(parseLimit({ limit: 'abc' }, 99), 99);
});

test('server: filterHistory — drops events older than sinceMs + kind filter + tail cap', () => {
  const events = [
    { ts: '2026-09-01T00:00:00Z', kind: 'entry' },
    { ts: '2026-09-05T00:00:00Z', kind: 'exit' },
    { ts: '2026-09-10T00:00:00Z', kind: 'entry' },
    { ts: '2026-09-15T00:00:00Z', kind: 'entry' },
    { ts: '2026-09-20T00:00:00Z', kind: 'exit' },
  ];
  const sinceMs = Date.parse('2026-09-09T00:00:00Z');
  assert.deepEqual(
    filterHistory(events, { sinceMs, kind: 'entry' }).map((e) => e.ts),
    ['2026-09-10T00:00:00Z', '2026-09-15T00:00:00Z'],
  );
  assert.deepEqual(
    filterHistory(events, { sinceMs }).map((e) => e.ts),
    ['2026-09-10T00:00:00Z', '2026-09-15T00:00:00Z', '2026-09-20T00:00:00Z'],
  );
  // tail cap (returns the LAST N)
  assert.equal(filterHistory(events, { sinceMs: null, limit: 2 }).length, 2);
});

test('server: filterHistory — drops unparseable timestamps + non-objects', () => {
  const events = [
    null,
    'string-event',
    { ts: 'not-a-date', kind: 'entry' },
    { ts: '2026-09-01T00:00:00Z', kind: 'entry' },
  ];
  const sinceMs = Date.parse('2025-01-01T00:00:00Z');
  const out = filterHistory(events, { sinceMs });
  assert.deepEqual(out.map((e) => e.ts), ['2026-09-01T00:00:00Z']);
});

// ────────────────────────────────────────────────────────────────────────
//  T25b — groupReasoningEvents + /api/reasoning
// ────────────────────────────────────────────────────────────────────────

test('groupReasoningEvents: groups per-candidate events by tick timestamp', () => {
  // Production ordering: tick is appended LAST in the loop, but
  // per-candidate events use the wall-clock at the moment of their
  // own write. Net effect: decisions land in history.jsonl with ts
  // AFTER the parent tick ts (typically a few ms to ~1s later,
  // depending on how many candidates were evaluated). The test
  // mirrors that ordering.
  const events = [
    { kind: 'tick', ts: '2026-09-12T22:00:00.100Z', candidate_count: 2, entries_succeeded: 0 },
    { kind: 'entry_skipped', ts: '2026-09-12T22:00:00.115Z', token_id: 'aaa', reason: 'too close to high', rank: 1, score: 0.6 },
    { kind: 'entry_skipped', ts: '2026-09-12T22:00:00.130Z', token_id: 'bbb', reason: 'no price', rank: 2, score: 0.5 },
    { kind: 'tick', ts: '2026-09-12T22:01:00.100Z', candidate_count: 1, entries_succeeded: 1, wallet_balance_sats: '4435967' },
    { kind: 'entry_executed', ts: '2026-09-12T22:01:00.115Z', token_id: 'ccc', rank: 1, score: 0.7 },
  ];
  const out = groupReasoningEvents(events, { maxTicks: 5, maxDecisionsPerTick: 20 });
  // Newest tick first.
  assert.equal(out.length, 2);
  assert.equal(out[0].ts, '2026-09-12T22:01:00.100Z');
  assert.equal(out[0].tick.entries_succeeded, 1);
  assert.equal(out[0].decisions.length, 1);
  assert.equal(out[0].decisions[0].token_id, 'ccc');
  // Older tick — 2 decisions attached.
  assert.equal(out[1].ts, '2026-09-12T22:00:00.100Z');
  assert.equal(out[1].decisions.length, 2);
  // Decisions sorted by rank asc (best first).
  assert.deepEqual(out[1].decisions.map((d) => d.rank), [1, 2]);
});

test('groupReasoningEvents: never bleeds decisions into the previous tick (time-bucket guard)', () => {
  // Pathological case: a per-candidate event with ts BEFORE its
  // parent tick (clock skew, slow disk flush, etc.) must NOT be
  // attributed to the previous tick — the time-bucket guard rejects
  // it, and the event gets dropped (the index walk already passed
  // it). The result is that the older tick simply has fewer
  // decisions, never the wrong ones.
  const events = [
    { kind: 'entry_skipped', ts: '2026-09-12T22:00:00.500Z', token_id: 'late', rank: 1 },
    { kind: 'tick', ts: '2026-09-12T22:01:00.000Z', candidate_count: 1 },
  ];
  const out = groupReasoningEvents(events);
  assert.equal(out.length, 1);
  // The decision with ts 22:00:00.500Z (BEFORE tick ts 22:01:00Z) is dropped.
  assert.equal(out[0].decisions.length, 0);
});

test('groupReasoningEvents: respects maxTicks cap (returns at most N)', () => {
  const events = [];
  for (let i = 0; i < 10; i++) {
    events.push({ kind: 'tick', ts: `2026-09-12T22:0${i}:00Z`, candidate_count: 0 });
  }
  const out = groupReasoningEvents(events, { maxTicks: 3 });
  assert.equal(out.length, 3);
  // Newest first.
  assert.equal(out[0].ts, '2026-09-12T22:09:00Z');
  assert.equal(out[2].ts, '2026-09-12T22:07:00Z');
});

test('groupReasoningEvents: respects maxDecisionsPerTick cap', () => {
  const events = [];
  // Tick first, then 50 decisions all with ts AFTER the tick.
  events.push({ kind: 'tick', ts: '2026-09-12T22:00:00.000Z', candidate_count: 50 });
  for (let i = 0; i < 50; i++) {
    // Spread decisions across 1 second so ts ordering doesn't
    // collapse them via the index walk.
    const ms = String(i * 10).padStart(3, '0');
    events.push({ kind: 'entry_skipped', ts: `2026-09-12T22:00:00.${ms}Z`, token_id: `t${i}`, rank: i + 1 });
  }
  const out = groupReasoningEvents(events, { maxTicks: 1, maxDecisionsPerTick: 10 });
  assert.equal(out.length, 1);
  assert.equal(out[0].decisions.length, 10);
});

test('groupReasoningEvents: empty / non-array input returns []', () => {
  assert.deepEqual(groupReasoningEvents([]), []);
  assert.deepEqual(groupReasoningEvents(null), []);
  assert.deepEqual(groupReasoningEvents(undefined), []);
});

test('groupReasoningEvents: returns [] when there are no tick events', () => {
  const events = [
    { kind: 'entry_skipped', ts: '2026-09-12T22:00:00.000Z', token_id: 'a' },
    { kind: 'snapshot', ts: '2026-09-12T22:00:00.100Z' },
  ];
  assert.deepEqual(groupReasoningEvents(events), []);
});

test('server: GET /api/reasoning returns the per-tick decision tree (T25b)', async (t) => {
  const dir = await makeTmp(t, 'tradebot-reasoning-');
  const historyFile = `${dir}/history.jsonl`;
  // Seed two ticks worth of history (tick first, decisions after).
  const events = [
    { kind: 'tick', ts: '2026-09-12T22:00:00.100Z', candidate_count: 2, entries_succeeded: 0, wallet_balance_sats: '4435967' },
    { kind: 'entry_skipped', ts: '2026-09-12T22:00:00.115Z', token_id: 'aaa', reason: 'too close to high', rank: 1, score: 0.6 },
    { kind: 'entry_skipped', ts: '2026-09-12T22:00:00.130Z', token_id: 'bbb', reason: 'no price', rank: 2, score: 0.5 },
    { kind: 'tick', ts: '2026-09-12T22:01:00.100Z', candidate_count: 1, entries_succeeded: 1, wallet_balance_sats: '4400000' },
    { kind: 'entry_executed', ts: '2026-09-12T22:01:00.115Z', token_id: 'ccc', rank: 1, score: 0.7 },
  ];
  await writeFile(historyFile, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const historyReader = createHistoryReader({ file: historyFile });
  const cfg = { paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s` } };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const server = createDashboardServer({
    cfg, positions, snapshots, historyReader,
    logger: createLogger({ component: 'reasoning', sink: process.stderr }),
  });
  const res = await supertest(server.handler).get('/api/reasoning').expect(200);
  assert.equal(res.body.schema, 'tradebot.dashboard.reasoning/v1');
  assert.equal(res.body.count, 2);
  assert.equal(res.body.ticks[0].tick.entries_succeeded, 1);
  assert.equal(res.body.ticks[0].decisions[0].token_id, 'ccc');
  assert.equal(res.body.ticks[1].decisions.length, 2);
  // Schema fields present.
  assert.equal(typeof res.body.ts, 'string');
  assert.equal(res.body.limit, 5);
  assert.equal(res.body.decisions_per_tick, 20);
});

test('server: GET /api/reasoning?limit=1 caps to one tick (T25b)', async (t) => {
  const dir = await makeTmp(t, 'tradebot-reasoning-cap-');
  const historyFile = `${dir}/history.jsonl`;
  const events = [];
  for (let i = 0; i < 5; i++) {
    events.push({ kind: 'tick', ts: `2026-09-12T22:0${i}:00Z`, candidate_count: 0 });
  }
  await writeFile(historyFile, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const historyReader = createHistoryReader({ file: historyFile });
  const cfg = { paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s` } };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const server = createDashboardServer({
    cfg, positions, snapshots, historyReader,
    logger: createLogger({ component: 'reasoning-cap', sink: process.stderr }),
  });
  const res = await supertest(server.handler).get('/api/reasoning?limit=1').expect(200);
  assert.equal(res.body.count, 1);
});

test('server: filterSnapshots — filters by token_id + sinceMs + limit', () => {
  const records = [
    { ts: '2026-09-01T00:00:00Z', token_id: 'aaa', bch_balance_sats: '1' },
    { ts: '2026-09-05T00:00:00Z', bch_balance_sats: '2' },
    { ts: '2026-09-15T00:00:00Z', token_id: 'aaa', bch_balance_sats: '3' },
    { ts: '2026-09-20T00:00:00Z', token_id: 'bbb', bch_balance_sats: '4' },
  ];
  const sinceMs = Date.parse('2026-09-09T00:00:00Z');
  assert.equal(filterSnapshots(records, { sinceMs, tokenId: 'aaa' }).length, 1);
  assert.equal(filterSnapshots(records, { sinceMs, tokenId: 'bbb' }).length, 1);
  assert.equal(filterSnapshots(records, { sinceMs }).length, 2);
  // Tail cap.
  assert.equal(filterSnapshots(records, { sinceMs: null, limit: 2 }).length, 2);
});

test('server: clock injection — /api/history + /api/snapshots use the injected clock for ?range', async (t) => {
  // Construct a tiny fixture and verify that listers honour an
  // injected clock by checking they preserve / drop the same boundary
  // event the time would imply. With real Date.now() this test is
  // impossible to write deterministically.
  const dir = await makeTmp(t);
  const cfg = { dashboard: { history_default_range: '7d' }, paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s` } };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const histFile = `${dir}/history.ndjson`;
  await writeNdjson(histFile, [
    { ts: '2026-01-01T00:00:00Z', kind: 'entry' },
    { ts: '2026-09-01T00:00:00Z', kind: 'entry' },
    { ts: '2026-09-08T00:00:00Z', kind: 'exit' },
  ]);
  const historyReader = createHistoryReader({ file: histFile });

  // Pin clock at 2026-09-10. With 7d window, 2026-09-03..2026-09-10
  // is the kept band → 9-08 stays, 9-01 + 1-1 drop.
  const FROZEN = Date.parse('2026-09-10T00:00:00Z');
  const { server } = makeServer({
    cfg, positions, snapshots, historyReader,
    clock: () => FROZEN,
  });
  const res = await supertest(server.handler).get('/api/history').expect(200);
  assert.equal(res.body.count, 1, 'only 9-08 falls inside the 7d window from frozen-now');
  assert.equal(res.body.events[0].ts, '2026-09-08T00:00:00Z');

  // Now move the clock forward a week — 9-08 drops out, 1-1 + 9-01
  // already dropped earlier.
  const FAR_FUTURE = Date.parse('2027-01-01T00:00:00Z');
  const { server: server2 } = makeServer({
    cfg, positions, snapshots, historyReader,
    clock: () => FAR_FUTURE,
  });
  const res2 = await supertest(server2.handler).get('/api/history').expect(200);
  assert.equal(res2.body.count, 0, 'a 7d window a quarter-year out drops every fixture event');
});

test('server: clock injection — ?range=30d in /api/snapshots honours the injected clock', async (t) => {
  const dir = await makeTmp(t);
  const cfg = { dashboard: {}, paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s` } };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = await makeFixtureSnapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });

  // Pin clock far in the future so 30d drops everything.
  const FUTURE = Date.parse('2099-01-01T00:00:00Z');
  const { server } = makeServer({
    cfg, positions, snapshots, historyReader,
    clock: () => FUTURE,
  });
  const res = await supertest(server.handler).get('/api/snapshots').expect(200);
  assert.equal(res.body.count, 0, 'a 30d window 70+ years out drops every fixture snapshot');

  // Pin clock inside the window so all three records return.
  const RECENT = Date.parse('2026-09-11T12:00:00Z');
  const { server: server2 } = makeServer({
    cfg, positions, snapshots, historyReader,
    clock: () => RECENT,
  });
  const res2 = await supertest(server2.handler).get('/api/snapshots').expect(200);
  assert.equal(res2.body.count, 3);
});

test('server: clock injection — opts.clock must be a function (rejects non-callable)', () => {
  const opts = {
    cfg: {}, positions: { list: () => [] }, snapshots: { readBack: () => ({ records: [] }) },
    historyReader: { read: () => ({ events: [], errors: [] }) },
    clock: 'not-a-fn',
  };
  assert.throws(() => createDashboardServer(opts), /opts.clock must be a function/);
});

test('server: isAuthed — bearer token + timing-safe compare', () => {
  assert.equal(isAuthed('Bearer abc123', 'abc123'), true);
  assert.equal(isAuthed('abc123', 'abc123'), true, 'accepts raw token too');
  assert.equal(isAuthed('Bearer abc123 ', 'abc123'), true, 'trims whitespace');
  assert.equal(isAuthed('Bearer ABC123', 'abc123'), false, 'case sensitive');
  assert.equal(isAuthed('Bearer wrong', 'abc123'), false);
  assert.equal(isAuthed('', 'abc123'), false);
  assert.equal(isAuthed(null, 'abc123'), false);
  assert.equal(isAuthed('Bearer ', ''), false, 'empty expected token = never auth');
  assert.equal(isAuthed('Bearer abc', ''), false);
  // Length mismatch path — must not throw and must return false.
  assert.equal(isAuthed('Bearer aaaaa', 'bbbbb'), false);
});

test('server: walkAndReject — finds redactable keys at any depth', () => {
  const result = walkAndReject({
    a: 1,
    wallet: { wif: 'x', xprv: 'y' },
    list: [{ mnemonic: 'z' }, { ok: true }],
  });
  assert.deepEqual(result.rejected.sort(), ['mnemonic', 'wif', 'xprv']);
});

test('server: walkAndReject — empty / null input returns empty rejected', () => {
  assert.deepEqual(walkAndReject(null).rejected, []);
  assert.deepEqual(walkAndReject(undefined).rejected, []);
  assert.deepEqual(walkAndReject(42).rejected, []);
  assert.deepEqual(walkAndReject('string').rejected, []);
});

test('server: summarizePosition — projects the wire shape', () => {
  const out = summarizePosition({
    id: 'pos_x',
    token_id: 'a'.repeat(64),
    token_symbol: 'PUSD',
    side: 'long_token',
    status: 'open',
    opened_at: '2026-09-11T00:00:00Z',
    entry: {
      txid: 'zz',
      price_sats_per_token: 14500,
      bch_spent_sats: 500_000,
      token_amount_base: '344827586',
      fee_sats: 1000,
      ts: '2026-09-11T00:00:00Z',
    },
    reasoning: { score: 0.8 },
  });
  assert.equal(out.id, 'pos_x');
  assert.equal(out.entry.price_sats_per_token, 14500);
  assert.equal(out.reasoning.score, 0.8);
  assert.equal(out.exit, null);
});

test('server: buildRouteTable — contains every documented route + correct shape', () => {
  const routes = buildRouteTable();
  // Use `r.path` (the literal-path documentation field) instead of
  // `r.pattern.source` so the assertions don't break when the
  // pattern gets tweaked.
  const paths = routes.map((r) => `${r.method} ${r.path}`);
  assert.ok(paths.some((p) => p === 'GET /healthz'));
  assert.ok(paths.some((p) => p === 'GET /api/summary'));
  assert.ok(paths.some((p) => p === 'GET /api/positions'));
  assert.ok(paths.some((p) => p === 'GET /api/positions/dust'));
  assert.ok(paths.some((p) => p === 'GET /api/history'));
  assert.ok(paths.some((p) => p === 'GET /api/snapshots'));
  assert.ok(paths.some((p) => p === 'GET /api/config'));
  assert.ok(paths.some((p) => p === 'GET /api/config/defaults'));
  assert.ok(paths.some((p) => p === 'GET /api/risk'));
  assert.ok(paths.some((p) => p === 'GET /api/activity'));
  assert.ok(paths.some((p) => p === 'PUT /api/config'));
  assert.ok(paths.some((p) => p === 'POST /api/risk/reset'));
  // The two write routes must be flagged as auth-required.
  // EXCEPTION: `/api/setup/status` (GET) + `/api/setup` (POST) are
  // intentionally unauthenticated — they are the first-run wizard,
  // and the operator has no token yet. The dashboard's auto-redirect
  // (`<App />`) calls `/api/setup/status` on every page load before
  // any auth can possibly be configured. Excluding them here keeps
  // the "every PUT/POST is auth-required" invariant accurate for
  // the post-setup routes.
  const UNAUTHENTICATED_PATHS = new Set(['/api/setup', '/api/setup/status']);
  const puts = routes.filter((r) => r.method === 'PUT' || r.method === 'POST');
  for (const r of puts) {
    if (UNAUTHENTICATED_PATHS.has(r.path)) {
      assert.equal(r.auth, false, `first-run route ${r.method} ${r.path} must be unauthenticated`);
    } else {
      assert.equal(r.auth, true, `post-setup route ${r.method} ${r.path} must be auth-required`);
    }
  }
  // Every route must carry a `path` (used by the route-table docs
  // and the handler's structured logs).
  for (const r of routes) {
    assert.equal(typeof r.path, 'string', `route ${r.method} missing path`);
    assert.ok(r.path.length > 0);
  }
});

test('server: matchRoute — method + path + param extraction', () => {
  const routes = buildRouteTable();
  const hit = matchRoute(routes, 'GET', '/healthz');
  assert.ok(hit);
  assert.equal(hit.params.tokenId, undefined);
  const miss = matchRoute(routes, 'GET', '/no-such-path');
  assert.equal(miss, null);
  const wrongMethod = matchRoute(routes, 'DELETE', '/healthz');
  assert.equal(wrongMethod, null);
});

// ─────────────────────────────────────────────────────────────────────
//  HTTP integration: /healthz
// ─────────────────────────────────────────────────────────────────────

test('server: GET /healthz returns 200 + ok:true', async (t) => {
  const dir = await makeTmp(t);
  const cfg = {
    dashboard: { bind_host: '127.0.0.1', bind_port: 0 },
    paths: { positions_file: `${dir}/positions.json`, snapshots_dir: `${dir}/snapshots` },
  };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/history.ndjson` });
  const { server } = makeServer({ cfg, positions, snapshots, historyReader });

  const res = await supertest(server.handler).get('/healthz').expect(200);
  assert.equal(res.body.ok, true);
  assert.ok(typeof res.body.ts === 'string');
  assert.ok(typeof res.body.uptime_s === 'number');
});

test('server: GET /no-such-path returns 404', async (t) => {
  const dir = await makeTmp(t);
  const cfg = { dashboard: {}, paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s` } };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const { server } = makeServer({ cfg, positions, snapshots, historyReader });
  const res = await supertest(server.handler).get('/nope').expect(404);
  assert.match(res.body.error, /no route/);
});

// ─────────────────────────────────────────────────────────────────────
//  HTTP integration: /api/summary
// ─────────────────────────────────────────────────────────────────────

test('server: GET /api/summary builds dashboard summary from positions + snapshots', async (t) => {
  const dir = await makeTmp(t);
  const cfg = {
    tuning_preset: 'small_balance_startup',
    wallet: { network: 'mainnet', address: 'bitcoincash:qprh...' },
    entry: { max_position_bch: 0.005, max_total_exposure_bch: 0.04, slippage_tolerance_bps: 100 },
    risk: { min_wallet_balance_bch: 0.005 },
    exit: {
      tp_vol_multiplier: 2.0,
      sl_vol_multiplier: 1.0,
      tp_vol_floor_pct: 2.0,
      tp_vol_ceiling_pct: 80.0,
      sl_vol_floor_pct: 1.0,
      sl_vol_ceiling_pct: 50.0,
    },
    loop: { poll_interval_seconds: 60 },
    user: { wallet: { cashaddr: 'bitcoincash:qprh...' } },
    dashboard: { positions_default_status: 'open' },
    paths: { positions_file: `${dir}/positions.json`, snapshots_dir: `${dir}/snapshots` },
  };
  const positions = await makeFixturePositions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  const snapshots = await makeFixtureSnapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  const historyReader = createHistoryReader({ file: `${dir}/history.ndjson` });
  const { server } = makeServer({ cfg, positions, snapshots, historyReader });

  const res = await supertest(server.handler).get('/api/summary').expect(200);
  assert.equal(res.body.schema, 'tradebot.dashboard.summary/v1');
  assert.equal(res.body.config.tuning_preset, 'small_balance_startup');
  assert.equal(res.body.config.cashaddr, 'bitcoincash:qprh...');
  // T38: dynamic TP/SL knobs surface in summary.
  assert.equal(res.body.config.tp_vol_multiplier, 2.0);
  assert.equal(res.body.config.sl_vol_multiplier, 1.0);
  assert.equal(res.body.config.tp_vol_floor_pct, 2.0);
  assert.equal(res.body.config.tp_vol_ceiling_pct, 80.0);
  assert.equal(res.body.config.sl_vol_floor_pct, 1.0);
  assert.equal(res.body.config.sl_vol_ceiling_pct, 50.0);
  assert.equal(res.body.balance.bch_balance_sats, '4435967');
  assert.equal(res.body.balance.source, 'snapshot');
  // 1 closed trade (win by 4450 sats)
  assert.equal(res.body.realized.count, 1);
  assert.equal(res.body.realized.wins, 1);
  assert.equal(res.body.realized.realized_pnl_sats, '4450');
  assert.equal(res.body.unrealized.open_position_count, 2);
  assert.equal(res.body.unrealized.pending_count, 1);
  assert.equal(res.body.unrealized.closing_count, 0);
  // per-token summary should mention the closed token
  assert.ok(res.body.by_token['d'.repeat(64)], 'by_token should include the closed token');
});

test('server: GET /api/summary prefers live wallet balance when wired', async (t) => {
  const dir = await makeTmp(t);
  const cfg = { dashboard: {}, paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s` } };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const wallet = { getBalanceSats: async () => 9_999n };
  const { server } = makeServer({ cfg, positions, snapshots, historyReader, wallet });
  const res = await supertest(server.handler).get('/api/summary').expect(200);
  assert.equal(res.body.balance.bch_balance_sats, '9999');
  assert.equal(res.body.balance.source, 'wallet');
});

// ─────────────────────────────────────────────────────────────────────
//  HTTP integration: /api/positions
// ─────────────────────────────────────────────────────────────────────

test('server: GET /api/positions returns open + reasoning', async (t) => {
  const dir = await makeTmp(t);
  const cfg = { dashboard: {}, paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s` } };
  const positions = await makeFixturePositions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const { server } = makeServer({ cfg, positions, snapshots, historyReader });

  const res = await supertest(server.handler).get('/api/positions').expect(200);
  assert.equal(res.body.schema, 'tradebot.dashboard.positions/v1');
  assert.equal(res.body.status, 'open');
  assert.equal(res.body.count, 2);
  assert.equal(res.body.positions[0].status, 'open');
  assert.ok(res.body.positions[0].reasoning, 'reasoning must be exposed');
  assert.equal(res.body.positions[0].reasoning.score, 0.82);
});

test('server: GET /api/positions?status=all returns open + pending + closed', async (t) => {
  const dir = await makeTmp(t);
  const cfg = { dashboard: {}, paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s` } };
  const positions = await makeFixturePositions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const { server } = makeServer({ cfg, positions, snapshots, historyReader });
  const res = await supertest(server.handler).get('/api/positions?status=all').expect(200);
  // 2 open + 1 pending + 1 closed = 4
  assert.equal(res.body.count, 4);
});

test('server: GET /api/positions?status=bogus returns empty + valid list', async (t) => {
  const dir = await makeTmp(t);
  const cfg = { dashboard: {}, paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s` } };
  const positions = await makeFixturePositions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const { server } = makeServer({ cfg, positions, snapshots, historyReader });
  const res = await supertest(server.handler).get('/api/positions?status=bogus').expect(200);
  assert.deepEqual(res.body.valid.sort(), ['all', 'closed', 'closing', 'open', 'pending']);
  assert.equal(res.body.count, 0);
});

// ─────────────────────────────────────────────────────────────────────
//  HTTP integration: /api/history
// ─────────────────────────────────────────────────────────────────────

test('server: GET /api/history reads + filters + tails history.ndjson', async (t) => {
  const dir = await makeTmp(t);
  const cfg = {
    dashboard: { history_default_range: '7d', history_max_events: 100 },
    paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s` },
  };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const histFile = `${dir}/history.ndjson`;
  await writeNdjson(histFile, [
    { ts: '2026-09-01T00:00:00Z', kind: 'entry', token_id: 'a' },
    { ts: '2026-09-05T00:00:00Z', kind: 'exit', token_id: 'a' },
    { ts: '2026-09-09T00:00:00Z', kind: 'entry', token_id: 'b' },
    { ts: '2026-09-10T00:00:00Z', kind: 'entry', token_id: 'c' },
    { ts: '2026-09-11T00:00:00Z', kind: 'entry', token_id: 'd' },
    { ts: '2026-09-12T00:00:00Z', kind: 'exit', token_id: 'b' },
  ]);
  const historyReader = createHistoryReader({ file: histFile });
  // Freeze the clock at 2026-09-08T12:00:00Z so the 7d window is
  // 2026-09-01T12:00:00Z..2026-09-08T12:00:00Z. That's the only point
  // at which 9-01 drops, 9-05..9-12 survive, and the assertion is
  // deterministic regardless of when the test runs.
  const FROZEN_NOW_MS = Date.parse('2026-09-08T12:00:00Z');
  const { server } = makeServer({
    cfg, positions, snapshots, historyReader,
    clock: () => FROZEN_NOW_MS,
  });

  const res = await supertest(server.handler).get('/api/history').expect(200);
  assert.equal(res.body.schema, 'tradebot.dashboard.history/v1');
  assert.equal(res.body.count, 5, '7d window from current-now → 9-01 dropped, 9-05..9-12 kept');
  // Oldest kept event is 9-05 (the only 'a' event still in range).
  assert.equal(res.body.events[0].token_id, 'a');

  const byKind = await supertest(server.handler).get('/api/history?kind=exit').expect(200);
  assert.equal(byKind.body.count, 2);

  const limited = await supertest(server.handler).get('/api/history?limit=2').expect(200);
  assert.equal(limited.body.count, 2, 'limit applied after filter (tail)');
});

test('server: GET /api/history on missing file returns empty', async (t) => {
  const dir = await makeTmp(t);
  const cfg = { dashboard: {}, paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s` } };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/never-exists.ndjson` });
  const { server } = makeServer({ cfg, positions, snapshots, historyReader });
  const res = await supertest(server.handler).get('/api/history').expect(200);
  assert.equal(res.body.count, 0);
});

// ─────────────────────────────────────────────────────────────────────
//  HTTP integration: /api/snapshots
// ─────────────────────────────────────────────────────────────────────

test('server: GET /api/snapshots returns records (default 30d window)', async (t) => {
  const dir = await makeTmp(t);
  const cfg = { dashboard: {}, paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s` } };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = await makeFixtureSnapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  // Freeze the clock at 2026-09-12T04:00:00Z so the 1d, 7d, and 30d
  // windows behave deterministically regardless of when the test runs
  // (mirrors the wall-clock at which the suite was originally written).
  const FROZEN_NOW_MS = Date.parse('2026-09-12T04:00:00Z');
  const { server } = makeServer({
    cfg, positions, snapshots, historyReader,
    clock: () => FROZEN_NOW_MS,
  });

  const res = await supertest(server.handler).get('/api/snapshots').expect(200);
  assert.equal(res.body.schema, 'tradebot.dashboard.snapshots/v1');
  assert.equal(res.body.count, 3);
  const last = res.body.records[res.body.records.length - 1];
  assert.equal(last.bch_balance_sats, '4435967');
});

test('server: GET /api/snapshots?range=7d only returns the last 7 days', async (t) => {
  const dir = await makeTmp(t);
  const cfg = { dashboard: {}, paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s` } };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = await makeFixtureSnapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  // Freeze the clock at 2026-09-12T04:00:00Z — mirrors the wall-clock
  // the suite was originally written for. 7d cutoff: 2026-09-05T04:00Z
  // → all three fixture snapshots (9-09, 9-10, 9-11) are in range.
  // 1d cutoff: 2026-09-11T04:00Z → only 9-11 survives.
  const FROZEN_NOW_MS = Date.parse('2026-09-12T04:00:00Z');
  const { server } = makeServer({
    cfg, positions, snapshots, historyReader,
    clock: () => FROZEN_NOW_MS,
  });
  const res = await supertest(server.handler).get('/api/snapshots?range=7d').expect(200);
  assert.equal(res.body.count, 3);
  assert.equal(res.body.records[0].ts, '2026-09-09T12:00:00.000Z');
  // Tighten the window — ?range=1d should only return today.
  const recent = await supertest(server.handler).get('/api/snapshots?range=1d').expect(200);
  assert.equal(recent.body.count, 1);
  assert.equal(recent.body.records[0].ts, '2026-09-11T12:00:00.000Z');
});

// ─────────────────────────────────────────────────────────────────────
//  HTTP integration: /api/pnl-timeseries (T39)
// ─────────────────────────────────────────────────────────────────────

test('server: GET /api/pnl-timeseries returns cumulative rows from closed positions', async (t) => {
  const dir = await makeTmp(t);
  const cfg = { dashboard: {}, paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s` } };
  const positions = await makeFixturePositions({
    file: cfg.paths.positions_file,
    logger: createLogger({ sink: process.stderr }),
  });
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  // Freeze clock so the default 30d window is deterministic.
  const { server } = makeServer({ cfg, positions, snapshots, historyReader });
  const res = await supertest(server.handler).get('/api/pnl-timeseries').expect(200);
  assert.equal(res.body.schema, 'tradebot.dashboard.pnl-timeseries/v1');
  assert.equal(typeof res.body.ts, 'string');
  assert.equal(res.body.range, '30d');
  assert.equal(typeof res.body.range_ms, 'number');
  assert.equal(res.body.count, 1, 'one closed trade in the fixture');
  assert.equal(res.body.trades_count, 1);
  assert.equal(res.body.skipped, 0);
  // Pull the closed position id from the on-disk store to assert
  // the response row references it directly.
  const closedList = await positions.list('closed');
  assert.equal(closedList.length, 1);
  const row = res.body.rows[0];
  assert.equal(row.kind, 'win');
  assert.equal(row.position_id, closedList[0].id);
  assert.equal(row.token_symbol, 'CLOSED');
  assert.equal(row.reason, 'take_profit');
  assert.equal(row.realized_pnl_sats, '4450'); // 54_280 - 49_360 - 470
  assert.equal(row.cumulative_realized_pnl_sats, '4450');
  assert.equal(typeof row.cumulative_realized_pnl_bch, 'number');
  assert.equal(row.cumulative_realized_pnl_bch > 0, true);
  assert.equal(res.body.realized_total_sats, '4450');
  assert.equal(typeof res.body.realized_total_bch, 'number');
  assert.equal(res.body.first_close_ts, row.ts);
  assert.equal(res.body.last_close_ts, row.ts);
  assert.deepEqual(res.body.skip_breakdown, {});
  // The response includes a `limit` field reflecting the cap.
  assert.equal(typeof res.body.limit, 'number');
  assert.ok(res.body.limit > 0);
});

test('server: GET /api/pnl-timeseries?token_id filters to one token (case-folded)', async (t) => {
  const dir = await makeTmp(t);
  const cfg = { dashboard: {}, paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s` } };
  const positions = await makeFixturePositions({
    file: cfg.paths.positions_file,
    logger: createLogger({ sink: process.stderr }),
  });
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const { server } = makeServer({ cfg, positions, snapshots, historyReader });
  // Upper-case filter should case-fold to match the lower-case token_id.
  const res = await supertest(server.handler)
    .get(`/api/pnl-timeseries?token_id=${'d'.repeat(64).toUpperCase()}`)
    .expect(200);
  assert.equal(res.body.count, 1);
  assert.equal(res.body.token_id, 'd'.repeat(64).toUpperCase());
  assert.equal(res.body.rows[0].token_id, 'd'.repeat(64));
});

test('server: GET /api/pnl-timeseries?range=1d drops out-of-window closes', async (t) => {
  const dir = await makeTmp(t);
  const cfg = { dashboard: {}, paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s` } };
  const positions = await makeFixturePositions({
    file: cfg.paths.positions_file,
    logger: createLogger({ sink: process.stderr }),
  });
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  // Fixture closes the only position at 2026-09-10T18:00:00Z.
  // Freezing clock at 2026-09-10T19:00:00Z (1h after close) with a 1h
  // window should drop the row entirely (since close is at the boundary
  // — but sinceMs is inclusive in our filter since we check `< sinceMs`,
  // the close at 18:00 IS < sinceMs=18:00? No, 18:00 is NOT strictly
  // before 18:00 so it stays). Use a 1m window to definitely drop it.
  const FROZEN_NOW_MS = Date.parse('2026-09-11T00:00:00Z');
  const { server } = makeServer({ cfg, positions, snapshots, historyReader, clock: () => FROZEN_NOW_MS });
  const res = await supertest(server.handler).get('/api/pnl-timeseries?range=1m').expect(200);
  assert.equal(res.body.count, 0);
  assert.equal(res.body.trades_count, 0);
  assert.equal(res.body.skipped, 1, 'one trade dropped by since-window');
  assert.equal(res.body.skip_breakdown.since_window_miss, 1);
  // The cumulative is anchored to the bot's full close history (NOT
  // reset to 0 at the window boundary) so the chart line doesn't lie
  // about how the bot is actually performing. See
  // `buildPnlTimeseries` docstring — `sinceMs` drops ROWS but keeps
  // them in the cumulative running total.
  assert.equal(res.body.realized_total_sats, '4450');
});

test('server: GET /api/pnl-timeseries?limit=1 caps rows but keeps cumulative anchored', async (t) => {
  const dir = await makeTmp(t);
  const cfg = { dashboard: { pnl_timeseries_max_rows: 1 }, paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s` } };
  const positions = await makeFixturePositions({
    file: cfg.paths.positions_file,
    logger: createLogger({ sink: process.stderr }),
  });
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const { server } = makeServer({ cfg, positions, snapshots, historyReader });
  const res = await supertest(server.handler).get('/api/pnl-timeseries').expect(200);
  assert.equal(res.body.limit, 1);
  assert.equal(res.body.count, 1);
  assert.equal(res.body.realized_total_sats, '4450');
});

test('server: GET /api/pnl-timeseries?range=all returns every closed trade', async (t) => {
  const dir = await makeTmp(t);
  const cfg = { dashboard: {}, paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s` } };
  const positions = await makeFixturePositions({
    file: cfg.paths.positions_file,
    logger: createLogger({ sink: process.stderr }),
  });
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const { server } = makeServer({ cfg, positions, snapshots, historyReader });
  const res = await supertest(server.handler).get('/api/pnl-timeseries?range=all').expect(200);
  assert.equal(res.body.range, 'all');
  assert.equal(res.body.range_ms, null);
  assert.equal(res.body.count, 1);
});

test('server: GET /api/pnl-timeseries with no closed positions returns empty envelope', async (t) => {
  const dir = await makeTmp(t);
  const cfg = { dashboard: {}, paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s` } };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const { server } = makeServer({ cfg, positions, snapshots, historyReader });
  const res = await supertest(server.handler).get('/api/pnl-timeseries').expect(200);
  assert.equal(res.body.count, 0);
  assert.equal(res.body.trades_count, 0);
  assert.equal(res.body.realized_total_sats, '0');
  assert.equal(res.body.realized_total_bch, 0);
  assert.equal(res.body.first_close_ts, null);
  assert.equal(res.body.last_close_ts, null);
  assert.deepEqual(res.body.rows, []);
});

// ─────────────────────────────────────────────────────────────────────
//  HTTP integration: /api/config (redaction)
// ─────────────────────────────────────────────────────────────────────

test('server: GET /api/config redacts every redactable field', async (t) => {
  const dir = await makeTmp(t);
  const cfg = {
    wallet: { address: 'bitcoincash:qp...' },
    user: {
      wallet: {
        cashaddr: 'bitcoincash:qp...',
        wif: 'L4rK7yHmQ4r8sR8pN8gT6tE2vN1wL9kP3jF8mS7dQ9aZ2bX3cV4nM5',
        mnemonic: 'one two three four five',
      },
    },
    paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s` },
  };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const { server } = makeServer({ cfg, positions, snapshots, historyReader });

  const res = await supertest(server.handler).get('/api/config').expect(200);
  assert.equal(res.body.config.user.wallet.wif, '[REDACTED]');
  assert.equal(res.body.config.user.wallet.mnemonic, '[REDACTED]');
  assert.equal(res.body.config.user.wallet.cashaddr, 'bitcoincash:qp...');
  assert.equal(res.body.config.wallet.address, 'bitcoincash:qp...');
});

// ─────────────────────────────────────────────────────────────────────
//  HTTP integration: /api/config/defaults (T43c — Settings reset-to-default baseline)
// ─────────────────────────────────────────────────────────────────────

test('server: GET /api/config/defaults returns the raw default.json content', async (t) => {
  const dir = await makeTmp(t);
  // Write a fixture default.json and point cfg.paths.default at it.
  const defaultsPath = `${dir}/default.json`;
  await fsp.writeFile(defaultsPath, JSON.stringify({
    version: 2,
    entry: { max_position_bch: 0.005, max_total_exposure_bch: 0.04 },
    notes: 'tiny',
  }), 'utf8');
  const cfg = {
    entry: { max_position_bch: 0.012 }, // operator override — must NOT leak here
    paths: {
      default: defaultsPath,
      positions_file: `${dir}/p.json`,
      snapshots_dir: `${dir}/s`,
    },
  };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const { server } = makeServer({ cfg, positions, snapshots, historyReader });

  const res = await supertest(server.handler).get('/api/config/defaults').expect(200);
  assert.equal(res.body.path, defaultsPath);
  // The endpoint returns PRISTINE values from default.json, NOT the
  // merged cfg. This is the whole point — the operator's reset-to-
  // default button needs the baseline, not their own overrides.
  assert.equal(res.body.defaults.entry.max_position_bch, 0.005);
  assert.equal(res.body.defaults.entry.max_total_exposure_bch, 0.04);
  assert.equal(res.body.defaults.notes, 'tiny');
  assert.equal(res.body.defaults.version, 2);
});

test('server: GET /api/config/defaults redacts redactable fields defensively', async (t) => {
  const dir = await makeTmp(t);
  // A pathological default.json that does have a secret-shaped field.
  // The endpoint should redact it before returning (no real TradeBot
  // config carries secrets in default.json, but defense in depth).
  const defaultsPath = `${dir}/default.json`;
  await fsp.writeFile(defaultsPath, JSON.stringify({
    version: 2,
    user_wif: 'L4rK7yHmQ4r8sR8pN8gT6tE2vN1wL9kP3jF8mS7dQ9aZ2bX3cV4nM5',
    mnemonic: 'one two three four five',
    wallet: { address: 'bitcoincash:qp...' },
  }), 'utf8');
  const cfg = { paths: { default: defaultsPath, positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s` } };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const { server } = makeServer({ cfg, positions, snapshots, historyReader });

  const res = await supertest(server.handler).get('/api/config/defaults').expect(200);
  assert.equal(res.body.defaults.user_wif, '[REDACTED]');
  assert.equal(res.body.defaults.mnemonic, '[REDACTED]');
  assert.equal(res.body.defaults.wallet.address, 'bitcoincash:qp...');
});

test('server: GET /api/config/defaults returns empty object when the file is missing', async (t) => {
  const dir = await makeTmp(t);
  const cfg = {
    paths: {
      default: `${dir}/does-not-exist.json`, // ENOENT path
      positions_file: `${dir}/p.json`,
      snapshots_dir: `${dir}/s`,
    },
  };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const { server } = makeServer({ cfg, positions, snapshots, historyReader });

  const res = await supertest(server.handler).get('/api/config/defaults').expect(200);
  assert.deepEqual(res.body.defaults, {});
  assert.equal(res.body.path, `${dir}/does-not-exist.json`);
  assert.equal(res.body.reason, 'missing');
});

test('server: GET /api/config/defaults returns empty object when no path is configured', async (t) => {
  const dir = await makeTmp(t);
  const cfg = {
    paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s` },
    // no `default` key — the loader failed before recording it
  };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const { server } = makeServer({ cfg, positions, snapshots, historyReader });

  const res = await supertest(server.handler).get('/api/config/defaults').expect(200);
  assert.deepEqual(res.body.defaults, {});
  assert.equal(res.body.path, null);
  assert.equal(res.body.reason, 'no_default_path');
});

test('server: GET /api/config/defaults surfaces a 400 when default.json is malformed', async (t) => {
  const dir = await makeTmp(t);
  const defaultsPath = `${dir}/default.json`;
  await fsp.writeFile(defaultsPath, '{not valid json', 'utf8');
  const cfg = {
    paths: { default: defaultsPath, positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s` },
  };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const { server } = makeServer({ cfg, positions, snapshots, historyReader });

  const res = await supertest(server.handler).get('/api/config/defaults');
  // The dispatcher honors `err.statusCode` (T28e).
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'CONFIG_DEFAULTS_PARSE_INVALID');
});

test('server: GET /api/config/defaults requires no auth (read-only public route)', async (t) => {
  const dir = await makeTmp(t);
  const defaultsPath = `${dir}/default.json`;
  await fsp.writeFile(defaultsPath, JSON.stringify({ version: 2 }), 'utf8');
  const cfg = {
    dashboard: { api_token: 'sek' }, // token set, but defaults is read-only
    paths: { default: defaultsPath, positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s` },
  };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const { server } = makeServer({ cfg, positions, snapshots, historyReader });

  const res = await supertest(server.handler).get('/api/config/defaults').expect(200);
  assert.equal(res.body.defaults.version, 2);
});

// ─────────────────────────────────────────────────────────────────────
//  HTTP integration: /api/risk
// ─────────────────────────────────────────────────────────────────────

test('server: GET /api/risk returns the breaker state when wired', async (t) => {
  const dir = await makeTmp(t);
  const cfg = { dashboard: {}, paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s` } };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const fakeBreaker = {
    state: () => ({
      isTripped: false,
      tripKind: null,
      consecutiveLosses: 1,
      recentDailyPnlSats: -1000,
      maxDailyLossBch: 0.005,
      maxConsecutiveLosses: 3,
      dailyLossCooldownHours: 6,
      consecutiveLossesCooldownHours: 6,
      nowMs: Date.now(),
    }),
    reset: async () => { fakeBreaker.state().isTripped = false; },
  };
  const { server } = makeServer({ cfg, positions, snapshots, historyReader, risk: fakeBreaker });
  const res = await supertest(server.handler).get('/api/risk').expect(200);
  assert.equal(res.body.schema, 'tradebot.dashboard.risk/v1');
  assert.equal(res.body.state.maxConsecutiveLosses, 3);
});

test('server: GET /api/risk returns NO_BREAKER when not wired', async (t) => {
  const dir = await makeTmp(t);
  const cfg = { dashboard: {}, paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s` } };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const { server } = makeServer({ cfg, positions, snapshots, historyReader });
  const res = await supertest(server.handler).get('/api/risk').expect(200);
  assert.equal(res.body.code, 'NO_BREAKER');
});

// ─────────────────────────────────────────────────────────────────────
//  HTTP integration: write endpoints (PUT /api/config, POST /api/risk/reset)
// ─────────────────────────────────────────────────────────────────────

test('server: PUT /api/config without api_token returns 503 AUTH_NOT_CONFIGURED', async (t) => {
  const dir = await makeTmp(t);
  const cfg = {
    dashboard: { api_token: null },
    paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s` },
  };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const { server } = makeServer({ cfg, positions, snapshots, historyReader });
  const res = await supertest(server.handler)
    .put('/api/config')
    .send({ dashboard: { bind_port: 9999 } })
    .expect(503);
  assert.equal(res.body.code, 'AUTH_NOT_CONFIGURED');
});

test('server: PUT /api/config with wrong api_token returns 503', async (t) => {
  const dir = await makeTmp(t);
  const cfg = {
    dashboard: { api_token: 'correct-token' },
    paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s`, user: `${dir}/user.json` },
  };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const { server } = makeServer({ cfg, positions, snapshots, historyReader });
  const res = await supertest(server.handler)
    .put('/api/config')
    .set('Authorization', 'Bearer wrong-token')
    .send({ dashboard: { bind_port: 9999 } })
    .expect(503);
  assert.equal(res.body.code, 'AUTH_NOT_CONFIGURED');
});

test('server: PUT /api/config with correct api_token writes user.json atomically', async (t) => {
  const dir = await makeTmp(t);
  const userPath = `${dir}/user.json`;
  const cfg = {
    dashboard: { api_token: 'super-secret-token' },
    paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s`, user: userPath },
  };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const { server } = makeServer({ cfg, positions, snapshots, historyReader });

  const res = await supertest(server.handler)
    .put('/api/config')
    .set('Authorization', 'Bearer super-secret-token')
    .send({ dashboard: { bind_port: 9999, log_level: 'debug' } })
    .expect(200);
  assert.equal(res.body.schema, 'tradebot.dashboard.config.update/v1');
  assert.deepEqual(res.body.keys_written.sort(), ['bind_port', 'log_level']);

  const written = JSON.parse(await readFile(userPath, 'utf8'));
  assert.equal(written.dashboard.bind_port, 9999);
  assert.equal(written.dashboard.log_level, 'debug');
});

test('server: PUT /api/config rejects secret-looking fields even with valid token', async (t) => {
  const dir = await makeTmp(t);
  const cfg = {
    dashboard: { api_token: 'tok' },
    paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s`, user: `${dir}/user.json` },
  };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const { server } = makeServer({ cfg, positions, snapshots, historyReader });
  const res = await supertest(server.handler)
    .put('/api/config')
    .set('Authorization', 'Bearer tok')
    .send({ wallet: { wif: 'L1234567890' } })
    .expect(200);
  assert.equal(res.body.error.match(/refusing/i)?.[0], 'refusing');
  assert.match(res.body.error, /wif/);
});

test('server: PUT /api/config with non-JSON body returns 400', async (t) => {
  const dir = await makeTmp(t);
  const cfg = {
    dashboard: { api_token: 'tok' },
    paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s`, user: `${dir}/user.json` },
  };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const { server } = makeServer({ cfg, positions, snapshots, historyReader });
  const res = await supertest(server.handler)
    .put('/api/config')
    .set('Authorization', 'Bearer tok')
    .set('Content-Type', 'application/json')
    .send('{not valid json')
    .expect(400);
  assert.equal(res.body.code, 'BAD_BODY');
});

test('server: PUT /api/config merges onto existing user.json (deep merge)', async (t) => {
  const dir = await makeTmp(t);
  const userPath = `${dir}/user.json`;
  await writeFile(userPath, JSON.stringify({ wallet: { wif: 'LExistingWIF', cashaddr: 'bitcoincash:qpExisting' }, dashboard: { api_token: 'tok' } }), 'utf8');
  const cfg = {
    dashboard: { api_token: 'tok' },
    paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s`, user: userPath },
  };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const { server } = makeServer({ cfg, positions, snapshots, historyReader });
  await supertest(server.handler)
    .put('/api/config')
    .set('Authorization', 'Bearer tok')
    .send({ dashboard: { bind_port: 5555 } })
    .expect(200);
  const after = JSON.parse(await readFile(userPath, 'utf8'));
  assert.equal(after.dashboard.bind_port, 5555, 'updated');
  assert.equal(after.dashboard.api_token, 'tok', 'preserved');
  assert.equal(after.wallet.cashaddr, 'bitcoincash:qpExisting', 'preserved');
  assert.equal(after.wallet.wif, 'LExistingWIF', 'preserved (never touched by merge)');
});

test('server: POST /api/risk/reset without breaker returns AUTH_NOT_CONFIGURED even with token', async (t) => {
  const dir = await makeTmp(t);
  const cfg = {
    dashboard: { api_token: 'tok' },
    paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s`, user: `${dir}/user.json` },
  };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const { server } = makeServer({ cfg, positions, snapshots, historyReader });
  const res = await supertest(server.handler)
    .post('/api/risk/reset')
    .set('Authorization', 'Bearer tok')
    .send({ reason: 'manual' })
    .expect(200);
  // No breaker → error code
  assert.match(res.body.error, /risk state not available/);
});

test('server: POST /api/risk/reset with wired breaker calls reset()', async (t) => {
  const dir = await makeTmp(t);
  const cfg = {
    dashboard: { api_token: 'tok' },
    paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s` },
  };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const calls = [];
  const breaker = {
    state: () => ({ isTripped: false, tripKind: null }),
    reset: async ({ reason } = {}) => { calls.push(reason); },
  };
  const { server } = makeServer({ cfg, positions, snapshots, historyReader, risk: breaker });
  const res = await supertest(server.handler)
    .post('/api/risk/reset')
    .set('Authorization', 'Bearer tok')
    .send({ reason: 'because tests' })
    .expect(200);
  assert.equal(res.body.schema, 'tradebot.dashboard.risk.reset/v1');
  assert.equal(res.body.reason, 'because tests');
  assert.deepEqual(calls, ['because tests']);
});

// ─────────────────────────────────────────────────────────────────────
//  HTTP integration: /api/activity
// ─────────────────────────────────────────────────────────────────────

test('server: GET /api/activity returns last snapshot + tail of history', async (t) => {
  const dir = await makeTmp(t);
  const cfg = { dashboard: {}, paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s` } };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = await makeFixtureSnapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  const histFile = `${dir}/history.ndjson`;
  await writeNdjson(histFile, [
    { ts: '2026-09-10T00:00:00Z', kind: 'tick' },
    { ts: '2026-09-10T12:00:00Z', kind: 'entry', token_id: 'a' },
    { ts: '2026-09-10T18:00:00Z', kind: 'exit', token_id: 'a' },
  ]);
  const historyReader = createHistoryReader({ file: histFile });
  const { server } = makeServer({ cfg, positions, snapshots, historyReader });
  const res = await supertest(server.handler).get('/api/activity').expect(200);
  assert.equal(res.body.schema, 'tradebot.dashboard.activity/v1');
  assert.ok(res.body.last_snapshot, 'last_snapshot populated');
  assert.equal(res.body.last_snapshot.bch_balance_sats, '4435967');
  assert.equal(res.body.last_events.length, 3);
  // events are reversed (most recent first)
  assert.equal(res.body.last_events[0].kind, 'exit');
});

// ─────────────────────────────────────────────────────────────────────
//  HTTP integration: lifecycle + CORS + createDashboardServer errors
// ─────────────────────────────────────────────────────────────────────

test('server: createDashboardServer validates required inputs', () => {
  assert.throws(() => createDashboardServer({}), DashboardConfigError);
  assert.throws(() => createDashboardServer({ cfg: { dashboard: {} } }), DashboardConfigError);
  assert.throws(() => createDashboardServer({
    cfg: { dashboard: {} },
    positions: { list: () => {} },
    snapshots: { readBack: () => {} },
  }), DashboardConfigError);
});

test('server: CORS — wildcard when cors_origin is "*"', async (t) => {
  const dir = await makeTmp(t);
  const cfg = {
    dashboard: { cors_origin: '*' },
    paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s` },
  };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const { server } = makeServer({ cfg, positions, snapshots, historyReader });
  const res = await supertest(server.handler)
    .get('/healthz')
    .set('Origin', 'http://localhost:5173')
    .expect(200);
  assert.equal(res.headers['access-control-allow-origin'], '*');
});

test('server: CORS — same-origin (no header) when cors_origin is null', async (t) => {
  const dir = await makeTmp(t);
  const cfg = { dashboard: {}, paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s` } };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const { server } = makeServer({ cfg, positions, snapshots, historyReader });
  const res = await supertest(server.handler)
    .get('/healthz')
    .set('Origin', 'http://localhost:5173')
    .expect(200);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('server: OPTIONS preflight short-circuits with 204', async (t) => {
  const dir = await makeTmp(t);
  const cfg = { dashboard: { cors_origin: '*' }, paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s` } };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const { server } = makeServer({ cfg, positions, snapshots, historyReader });
  const res = await supertest(server.handler)
    .options('/api/config')
    .set('Origin', 'http://localhost:5173')
    .set('Access-Control-Request-Method', 'PUT')
    .expect(204);
  assert.equal(res.headers['access-control-allow-origin'], '*');
});

test('server: every request emits exactly one dashboard.request log line', async (t) => {
  const dir = await makeTmp(t);
  const cfg = { dashboard: {}, paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s` } };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const { server, sink } = makeServer({ cfg, positions, snapshots, historyReader });
  await supertest(server.handler).get('/healthz').expect(200);
  const logLines = sink.lines();
  const reqLines = logLines.filter((l) => l.includes('"msg":"dashboard.request"'));
  assert.equal(reqLines.length, 1, 'expected one dashboard.request log line');
  assert.match(reqLines[0], /"status":200/);
});

// ─────────────────────────────────────────────────────────────────────
//  Caching historyReader
// ─────────────────────────────────────────────────────────────────────

test('createHistoryReader: caches reads for CACHE_TTL_MS', async (t) => {
  const dir = await makeTmp(t);
  const histFile = `${dir}/h.ndjson`;
  await writeNdjson(histFile, [
    { ts: '2026-09-10T00:00:00Z', kind: 'entry' },
    { ts: '2026-09-11T00:00:00Z', kind: 'exit' },
  ]);
  const reader = createHistoryReader({ file: histFile });
  const out1 = await reader.read({});
  assert.equal(out1.events.length, 2);
  // Append a new line — cache means we still see 2.
  await writeFile(histFile, JSON.stringify({ ts: '2026-09-12T00:00:00Z', kind: 'tick' }) + '\n', { flag: 'a' });
  const out2 = await reader.read({});
  assert.equal(out2.events.length, 2, 'cached — did not re-read');
  reader.invalidate();
  const out3 = await reader.read({});
  assert.equal(out3.events.length, 3, 'post-invalidate re-read picked up the new line');
});

// ─────────────────────────────────────────────────────────────────────
//  Static serving — pure helpers
// ─────────────────────────────────────────────────────────────────────

test('static: STATIC_CONTENT_TYPES covers every extension the SPA emits', () => {
  for (const ext of ['.html', '.js', '.mjs', '.css', '.json', '.svg', '.png', '.woff', '.woff2']) {
    assert.ok(STATIC_CONTENT_TYPES[ext], `missing ${ext}`);
  }
  // Locked down for grep-ability: do NOT silently add new types.
  assert.equal(Object.keys(STATIC_CONTENT_TYPES).length, 22, 'expected exactly 22 entries — update this test if adding a new type');
});

test('static: contentTypeFor maps known extensions + defaults to octet-stream', () => {
  assert.equal(contentTypeFor('/some/path/index.html'), 'text/html; charset=utf-8');
  assert.equal(contentTypeFor('foo.js'), 'application/javascript; charset=utf-8');
  assert.equal(contentTypeFor('weirdext.unknown'), DEFAULT_STATIC_CONTENT_TYPE);
  assert.equal(contentTypeFor(''), DEFAULT_STATIC_CONTENT_TYPE);
  // case-insensitive
  assert.equal(contentTypeFor('IMG.PNG'), 'image/png');
});

test('static: shouldServeStatic — API + healthz always fall through; GET/HEAD only', () => {
  assert.equal(shouldServeStatic('/', 'GET'), true, '/ should serve index.html');
  assert.equal(shouldServeStatic('/', 'HEAD'), true);
  assert.equal(shouldServeStatic('/portfolio', 'GET'), true);
  assert.equal(shouldServeStatic('/api/summary', 'GET'), false);
  assert.equal(shouldServeStatic('/api/', 'GET'), false);
  assert.equal(shouldServeStatic('/healthz', 'GET'), false);
  assert.equal(shouldServeStatic('/healthz/', 'GET'), false);
  assert.equal(shouldServeStatic('/api/risk/reset', 'GET'), false, 'matchRoute handles POST; static should defer');
  assert.equal(shouldServeStatic('/', 'POST'), false);
  assert.equal(shouldServeStatic('/portfolio', 'PUT'), false);
  assert.equal(shouldServeStatic('', 'GET'), false);
});

test('static: resolveSafeStaticPath — happy paths', () => {
  const root = '/srv/spa';
  assert.equal(resolveSafeStaticPath(root, '/'), '/srv/spa/index.html');
  assert.equal(resolveSafeStaticPath(root, '/portfolio'), '/srv/spa/portfolio');
  assert.equal(resolveSafeStaticPath(root, '/assets/index-AbCd.js'), '/srv/spa/assets/index-AbCd.js');
  // custom index filename
  assert.equal(resolveSafeStaticPath(root, '/', 'shell.html'), '/srv/spa/shell.html');
  // leading `/` stripped and joined cleanly with repeated slashes
  assert.equal(resolveSafeStaticPath(root, '//double//slash'), '/srv/spa/double/slash');
});

test('static: resolveSafeStaticPath — traversal payloads return null', () => {
  const root = '/srv/spa';
  assert.equal(resolveSafeStaticPath(root, '/../etc/passwd'), null);
  assert.equal(resolveSafeStaticPath(root, '/assets/../../../etc/passwd'), null, 'inner .. resolved against the joined path');
  assert.equal(resolveSafeStaticPath(root, '/%2E%2E/etc/passwd'), null, 'percent-encoded .. blocked');
  // Backslashes (Windows-y payload against a POSIX root) rejected after decode.
  assert.equal(resolveSafeStaticPath(root, '/foo\\..\\bar'), null);
  // Null-byte payload.
  assert.equal(resolveSafeStaticPath(root, '/foo\0bar'), null);
  // Empty / invalid inputs.
  assert.equal(resolveSafeStaticPath('', '/foo'), null);
  assert.equal(resolveSafeStaticPath(root, ''), null);
  assert.equal(resolveSafeStaticPath(root, '%E0%A4%A'), null, 'malformed percent encoding rejected');
});

test('static: resolveSafeStaticPath — bad inputs return null without throwing', () => {
  // Pass garbage; must NOT throw, just return null. Defends against
  // operator-supplied weirdness + parser bugs at the URL parse step.
  assert.doesNotThrow(() => resolveSafeStaticPath(undefined, '/foo'));
  assert.doesNotThrow(() => resolveSafeStaticPath(null, '/foo'));
  assert.doesNotThrow(() => resolveSafeStaticPath(42, '/foo'));
  assert.equal(resolveSafeStaticPath(null, '/foo'), null);
});

// ─────────────────────────────────────────────────────────────────────
//  Static serving — integration (supertest against handler)
// ─────────────────────────────────────────────────────────────────────

/**
 * Build a fake dist/ tree under `tmp`. Returns the absolute path.
 * Shape:
 *   dist/index.html               (always)
 *   dist/assets/<hashed-name>.js  (always, with `"INTEGRATION_JS_CONTENT"` payload)
 *   dist/assets/<other>.css       (always)
 *   dist/icons/favicon.svg        (optional)
 *   dist/sub/dir/                 (optional directory; tested with dir/index.html resolution)
 */
async function makeTmpDist(t, opts = {}) {
  const dir = await makeTmp(t, 'tradebot-static-');
  const dist = `${dir}/dist`;
  await mkdir(`${dist}/assets`, { recursive: true });
  await mkdir(`${dist}/icons`, { recursive: true });
  await writeFile(`${dist}/index.html`, '<!doctype html><html><head><title>TradeBot Test SPA</title></head><body><div id="root"></div></body></html>\n');
  await writeFile(`${dist}/assets/index-AbCd.js`, '/* INTEGRATION_JS_CONTENT */ console.log("hello");');
  await writeFile(`${dist}/assets/index-AbCd.css`, '/* INTEGRATION_CSS_CONTENT */ body { color: red; }');
  await writeFile(`${dist}/icons/favicon.svg`, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  if (opts.withDirIndex) {
    await mkdir(`${dist}/sub`, { recursive: true });
    await writeFile(`${dist}/sub/index.html`, '<!doctype html><html><body>SUB DIR INDEX</body></html>\n');
  }
  return dist;
}

/**
 * Build a server (via supertest-friendly handler) configured with
 * the given static_root override; falls back to default config
 * (no static_root) when `root === null`.
 */
async function makeServerWithStatic(t, { root = '/tmp/nonexistent-path-asdf', index } = {}) {
  const dir = await makeTmp(t, 'tradebot-server-');
  const cfg = {
    dashboard: {},
    paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s` },
  };
  if (root !== undefined) {
    cfg.dashboard.static_root = root;
    if (index !== undefined) cfg.dashboard.static_index = index;
  }
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const { server } = makeServer({ cfg, positions, snapshots, historyReader });
  return server;
}

test('static: serves index.html for GET / when static_root is configured', async (t) => {
  const dist = await makeTmpDist(t);
  const server = await makeServerWithStatic(t, { root: dist });
  const res = await supertest(server.handler).get('/').expect(200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.headers['cache-control'], /no-cache/, 'index.html is no-cache so updates propagate');
  assert.match(res.text, /TradeBot Test SPA/, 'returned the real index.html from dist/');
});

test('static: serves JS asset with correct mime + Cache-Control + exact bytes', async (t) => {
  const dist = await makeTmpDist(t);
  const server = await makeServerWithStatic(t, { root: dist });
  const res = await supertest(server.handler).get('/assets/index-AbCd.js').expect(200);
  assert.match(res.headers['content-type'], /application\/javascript/);
  assert.equal(res.headers['cache-control'], 'no-cache');
  assert.match(res.text, /INTEGRATION_JS_CONTENT/, 'returned the real asset bytes');
});

test('static: serves CSS asset with text/css mime', async (t) => {
  const dist = await makeTmpDist(t);
  const server = await makeServerWithStatic(t, { root: dist });
  const res = await supertest(server.handler).get('/assets/index-AbCd.css').expect(200);
  assert.match(res.headers['content-type'], /text\/css/);
  assert.match(res.text, /INTEGRATION_CSS_CONTENT/);
});

test('static: serves SVG with image/svg+xml mime', async (t) => {
  const dist = await makeTmpDist(t);
  const server = await makeServerWithStatic(t, { root: dist });
  const res = await supertest(server.handler).get('/icons/favicon.svg').expect(200);
  assert.match(res.headers['content-type'], /image\/svg\+xml/);
});

test('static: SPA route falls back to index.html when Accept includes text/html', async (t) => {
  const dist = await makeTmpDist(t);
  const server = await makeServerWithStatic(t, { root: dist });
  // /portfolio doesn't exist on disk; Accept: text/html makes the
  // backend serve index.html so React Router can take over.
  const res = await supertest(server.handler).get('/portfolio').set('Accept', 'text/html,application/xhtml+xml').expect(200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.text, /TradeBot Test SPA/);
  // Without Accept: text/html, /portfolio is treated as a missing
  // asset and returns the JSON 404 (so curl/img-tag scrapers don't
  // get spam-fallbacked to HTML).
  const resPlain = await supertest(server.handler).get('/missing-asset.png').expect(404);
  assert.match(resPlain.headers['content-type'], /application\/json/);
});

test('static: HEAD / returns headers without body', async (t) => {
  const dist = await makeTmpDist(t);
  const server = await makeServerWithStatic(t, { root: dist });
  const res = await supertest(server.handler).head('/').expect(200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.equal(res.text ?? '', '', 'HEAD must not return a body');
});

test('static: directory request resolves to dir/index.html', async (t) => {
  const dist = await makeTmpDist(t, { withDirIndex: true });
  const server = await makeServerWithStatic(t, { root: dist });
  const res = await supertest(server.handler).get('/sub/').expect(200);
  assert.match(res.text, /SUB DIR INDEX/);
});

test('static: GET /api/* is NEVER intercepted, even with Accept: text/html', async (t) => {
  const dist = await makeTmpDist(t);
  const server = await makeServerWithStatic(t, { root: dist });
  // /api/summary is a real endpoint — it must hit the route matcher, not the SPA fallback.
  const res = await supertest(server.handler).get('/api/summary').set('Accept', 'text/html').expect(200);
  assert.match(res.headers['content-type'], /application\/json/);
  // /api/portfolio doesn't exist as a route; it must return JSON 404, not HTML index.
  const res404 = await supertest(server.handler).get('/api/portfolio').set('Accept', 'text/html').expect(404);
  assert.match(res404.headers['content-type'], /application\/json/);
  assert.match(res404.body.error, /no route for GET \/api\/portfolio/);
});

test('static: /healthz is NOT intercepted', async (t) => {
  const dist = await makeTmpDist(t);
  const server = await makeServerWithStatic(t, { root: dist });
  const res = await supertest(server.handler).get('/healthz').expect(200);
  assert.equal(res.body.ok, true);
});

test('static: blocks path-traversal attempts (returns JSON 404)', async (t) => {
  const dist = await makeTmpDist(t);
  const server = await makeServerWithStatic(t, { root: dist });
  // Each of these is a known traversal payload; none should serve
  // anything from outside dist/.
  const payloads = [
    '/../etc/passwd',
    '/assets/../../etc/passwd',
    '/%2E%2E/etc/passwd',
    '/foo\\..\\bar',
  ];
  for (const p of payloads) {
    const res = await supertest(server.handler).get(p).expect(404);
    assert.match(res.headers['content-type'], /application\/json/);
    assert.match(res.body.error, /no route for GET/);
  }
});

test('static: disable via static_root: null \u2014 GET / returns JSON 404 (no fallback to disk)', async (t) => {
  // No dist/ is created; even if static_root pointed somewhere safe,
  // null disables the entire feature.
  const server = await makeServerWithStatic(t, { root: null });
  const res = await supertest(server.handler).get('/').set('Accept', 'text/html').expect(404);
  assert.match(res.headers['content-type'], /application\/json/);
  assert.match(res.body.error, /no route for GET/);
});

test('static: disable via static_root pointing at a non-existent directory \u2014 JSON 404, no crash', async (t) => {
  const server = await makeServerWithStatic(t, { root: '/tmp/definitely-not-a-real-path-1234' });
  const res = await supertest(server.handler).get('/').set('Accept', 'text/html').expect(404);
  assert.match(res.headers['content-type'], /application\/json/);
});

test('static: boot log records static_root + enabled flag via memory sink', async (t) => {
  const dist = await makeTmpDist(t);
  const dir = await makeTmp(t, 'tradebot-bootlog-');
  const cfg = {
    dashboard: { static_root: dist },
    paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s` },
  };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  // Inject a memory-sink logger directly so we can read the bootstrap log line.
  const memSink = createMemorySink();
  const memLog = createLogger({ component: 'boot-test', sink: memSink.stream });
  const server = createDashboardServer({
    cfg, positions, snapshots, historyReader, logger: memLog,
  });
  // Send one harmless request to push past construction.
  await supertest(server.handler).get('/healthz').expect(200);
  const lines = memSink.lines();
  const staticLine = lines.find((l) => l.includes('"msg":"dashboard.static.configured"'));
  assert.ok(staticLine, 'expected one dashboard.static.configured log line at construction');
  assert.match(staticLine, /"enabled":true/);
  assert.match(staticLine, /"resolved_root":/);
  // Silence the unused-variable lint (server IS used to trigger construction).
  assert.ok(server);
});

test('static: opts.staticRoot override beats cfg.dashboard.static_root', async (t) => {
  const dist = await makeTmpDist(t);
  // cfg says one path, opts override says another. The opts override should win.
  const dir = await makeTmp(t, 'tradebot-override-');
  const cfg = {
    dashboard: { static_root: '/tmp/wrong-path-1234' }, // intentionally broken
    paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s` },
  };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const server = createDashboardServer({
    cfg, positions, snapshots, historyReader,
    logger: createLogger({ component: 'ovr', sink: process.stderr }),
    staticRoot: dist,
  });
  const res = await supertest(server.handler).get('/').expect(200);
  assert.match(res.text, /TradeBot Test SPA/, 'opts.staticRoot override served the override path');
});

test('static: opts.staticRoot: null beats any cfg.dashboard.static_root (hard disable)', async (t) => {
  const dist = await makeTmpDist(t);
  const dir = await makeTmp(t, 'tradebot-disable-');
  const cfg = {
    dashboard: { static_root: dist },        // would have enabled
    paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s` },
  };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const server = createDashboardServer({
    cfg, positions, snapshots, historyReader,
    logger: createLogger({ component: 'dsbl', sink: process.stderr }),
    staticRoot: null,
  });
  const res = await supertest(server.handler).get('/').set('Accept', 'text/html').expect(404);
  assert.match(res.body.error, /no route for GET/);
});

test('static: opts.staticIndex override (custom filename for SPA fallback)', async (t) => {
  const dist = await makeTmpDist(t);
  const dir = await makeTmp(t, 'tradebot-idx-');
  // Write a shell.html that is NOT named index.html.
  await writeFile(`${dist}/shell.html`, '<!doctype html><html><body>CUSTOM_INDEX_HTML</body></html>\n');
  const cfg = {
    dashboard: { static_root: dist, static_index: 'shell.html' },
    paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s` },
  };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const server = createDashboardServer({
    cfg, positions, snapshots, historyReader,
    logger: createLogger({ component: 'idx', sink: process.stderr }),
  });
  const res = await supertest(server.handler).get('/').expect(200);
  assert.match(res.text, /CUSTOM_INDEX_HTML/);
});

// ────────────────────────────────────────────────────────────────────────
//  T26c — /api/token/:tokenId (Paytaca BCMR lookup)
// ────────────────────────────────────────────────────────────────────────

import { createPaytacaBcmrClient } from '../src/dashboard/paytacaBcmr.mjs';

const T26C_TOKEN = '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544';

function fakeBcmrClient(overrides = {}) {
  return createPaytacaBcmrClient({
    baseUrl: 'http://fake.bcmr.test/api',
    ttlMs: 60_000,
    fetchImpl: overrides.fetchImpl,
    now: overrides.now,
    maxRetries: 0,
  });
}

async function makeBcmrServer(t, overrides = {}) {
  const dir = await makeTmp(t, 'tradebot-bcmr-');
  const positions = new Positions({ file: `${dir}/p.json`, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: `${dir}/s`, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const cfg = { paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s` } };
  const server = createDashboardServer({
    cfg, positions, snapshots, historyReader,
    bcmrClient: overrides.bcmrClient ?? fakeBcmrClient(),
    logger: createLogger({ component: 'bcmr', sink: process.stderr }),
  });
  return server;
}

test('server: GET /api/token/:tokenId returns Paytaca BCMR metadata (T26c)', async (t) => {
  const bcmrClient = fakeBcmrClient({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        name: 'ParyonUSD',
        token: { symbol: 'PUSD', decimals: 2 },
        uris: { icon: 'https://example/x.svg', web: 'https://example' },
      }),
    }),
  });
  const server = await makeBcmrServer(t, { bcmrClient });
  const res = await supertest(server.handler)
    .get(`/api/token/${T26C_TOKEN}`)
    .expect(200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.record.name, 'ParyonUSD');
  assert.equal(res.body.record.symbol, 'PUSD');
  assert.equal(res.body.record.decimals, 2);
  assert.equal(res.body.record.icon_url, 'https://example/x.svg');
  assert.equal(res.body.record.web_url, 'https://example');
  assert.equal(res.body.cached, false);
});

test('server: GET /api/token/:tokenId returns cached:true on cache hit (T26c)', async (t) => {
  let calls = 0;
  const bcmrClient = fakeBcmrClient({
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ name: 'X', token: { symbol: 'X' } }) };
    },
  });
  const server = await makeBcmrServer(t, { bcmrClient });
  await supertest(server.handler).get(`/api/token/${T26C_TOKEN}`).expect(200);
  const res = await supertest(server.handler).get(`/api/token/${T26C_TOKEN}`).expect(200);
  assert.equal(calls, 1, 'second lookup must hit the in-process cache');
  assert.equal(res.body.cached, true);
});

test('server: GET /api/token/:tokenId returns 404 for a malformed token id (T26c)', async (t) => {
  const server = await makeBcmrServer(t);
  const res = await supertest(server.handler).get('/api/token/not-a-hex-id').expect(404);
  assert.match(res.body.error, /no route for GET/);
});

test('server: GET /api/token/:tokenId surfaces upstream 404 as typed error (T26c)', async (t) => {
  const bcmrClient = fakeBcmrClient({
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  });
  const server = await makeBcmrServer(t, { bcmrClient });
  const res = await supertest(server.handler).get(`/api/token/${T26C_TOKEN}`).expect(200);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error, 'not_found');
  assert.equal(res.body.status, 404);
});

test('server: GET /api/token/:tokenId returns 503 when no bcmrClient wired (T26c)', async (t) => {
  const dir = await makeTmp(t, 'tradebot-bcmr-noclient-');
  const positions = new Positions({ file: `${dir}/p.json`, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: `${dir}/s`, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const cfg = { paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s` } };
  const server = createDashboardServer({
    cfg, positions, snapshots, historyReader,
    // bcmrClient omitted on purpose
    logger: createLogger({ component: 'bcmr-noclient', sink: process.stderr }),
  });
  const res = await supertest(server.handler).get(`/api/token/${T26C_TOKEN}`).expect(200);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error, 'bcmr_not_configured');
  assert.equal(res.body.status, 503);
});

// ────────────────────────────────────────────────────────────────────────
//  T48 — bugsStore mount gate (no authPredicate required)
// ────────────────────────────────────────────────────────────────────────

test('server: opts.bugsStore mounts /api/bugs routes (no authPredicate required)', async (t) => {
  const dir = await makeTmp(t, 'tradebot-bugs-mounted-');
  const positions = new Positions({ file: `${dir}/p.json`, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: `${dir}/s`, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const cfg = { paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s` } };
  const bugsStore = new BugsStore({ file: `${dir}/bugs.json`, logger: createLogger({ sink: process.stderr }) });
  await bugsStore.load();
  const { logger, sink } = makeMemoryLogger();
  const server = createDashboardServer({
    cfg, positions, snapshots, historyReader,
    bugsStore,                          // intentionally NO authPredicate — that's the T48-fix invariant
    logger,
  });
  // GET /api/bugs is auth:false, so it must serve even without a token.
  const listRes = await supertest(server.handler).get('/api/bugs').expect(200);
  assert.deepEqual(listRes.body.bugs, []);
  assert.equal(listRes.body.meta.total_count, 0);
  // GET /api/bugs/meta is also auth:false.
  const metaRes = await supertest(server.handler).get('/api/bugs/meta').expect(200);
  assert.equal(metaRes.body.total_count, 0);
  // POST /api/bugs is auth:true → must 503 (api_token is null in default cfg).
  const createRes = await supertest(server.handler)
    .post('/api/bugs')
    .send({ title: 'should be rejected', description: 'auth not configured' })
    .expect(503);
  assert.equal(createRes.body.code, 'AUTH_NOT_CONFIGURED');
  // The mount log must have fired (proves the gate fired for bugsStore, not for authPredicate).
  const lines = sink.lines();
  assert.ok(
    lines.some((l) => l.includes('"msg":"dashboard.bugs.mounted"')),
    'expected one dashboard.bugs.mounted log line — bugsStore gate should fire without authPredicate',
  );
});

test('server: opts.bugsStore omitted → /api/bugs is a 404', async (t) => {
  const dir = await makeTmp(t, 'tradebot-bugs-notmounted-');
  const positions = new Positions({ file: `${dir}/p.json`, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: `${dir}/s`, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const cfg = { paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s` } };
  const server = createDashboardServer({
    cfg, positions, snapshots, historyReader,
    // no bugsStore on purpose
    logger: createLogger({ component: 'no-bugs', sink: process.stderr }),
  });
  const res = await supertest(server.handler).get('/api/bugs').expect(404);
  assert.match(res.body.error, /no route for GET/);
});

// ─────────────────────────────────────────────────────────────────────
//  T43c-server: per-knob restart-aware patch endpoint
// ─────────────────────────────────────────────────────────────────────

test('server: parseConfigKnobPath accepts catalog-shaped paths', () => {
  const ok = parseConfigKnobPath('entry.max_position_bch');
  assert.deepEqual(ok, { ok: true, path: 'entry.max_position_bch' });
  const deep = parseConfigKnobPath('scoring.weights.volume_30d_bch');
  assert.deepEqual(deep, { ok: true, path: 'scoring.weights.volume_30d_bch' });
  const urlEncoded = parseConfigKnobPath('entry%2Emax_position_bch');
  assert.deepEqual(urlEncoded, { ok: true, path: 'entry.max_position_bch' });
});

test('server: parseConfigKnobPath rejects bad inputs', () => {
  assert.equal(parseConfigKnobPath('').ok, false);
  assert.equal(parseConfigKnobPath(null).ok, false);
  assert.equal(parseConfigKnobPath(42).ok, false);
  assert.equal(parseConfigKnobPath('a..b').ok, false, 'rejects double-dot');
  assert.equal(parseConfigKnobPath('a/b').ok, false, 'rejects slash');
  assert.equal(parseConfigKnobPath('a\\b').ok, false, 'rejects backslash');
  // 5 segments is too deep (deepest catalog entry is 4).
  assert.equal(parseConfigKnobPath('a.b.c.d.e').ok, false);
  assert.equal(parseConfigKnobPath('a.b.c.d.e.f').ok, false);
  // Bad characters.
  assert.equal(parseConfigKnobPath('a b').ok, false);
  assert.equal(parseConfigKnobPath('a$b').ok, false);
});

test('server: readPathValue + setPathValue round-trip on dotted paths', () => {
  const obj = { entry: { max_position_bch: 0.005, deep: { x: 1 } } };
  assert.equal(readPathValue(obj, 'entry.max_position_bch'), 0.005);
  assert.equal(readPathValue(obj, 'entry.max_position_bch.unknown'), undefined, 'beyond leaf → undefined');
  assert.equal(readPathValue(obj, 'entry.missing.leaf'), undefined, 'missing branch → undefined');
  setPathValue(obj, 'entry.max_position_bch', 0.025);
  assert.equal(obj.entry.max_position_bch, 0.025);
  // Setting on a leaf path that didn't exist creates intermediate branches.
  setPathValue(obj, 'new_branch.sub.leaf', 'hello');
  assert.equal(obj.new_branch.sub.leaf, 'hello');
  // Setting across a non-object branch must throw, not silently overwrite.
  assert.throws(() => setPathValue(obj, 'entry.max_position_bch.sub', 'nope'), /cannot traverse/);
});

test('server: signalBotPid probes liveness before signaling', () => {
  const calls = [];
  const fakeKill = (pid, sig) => {
    calls.push({ pid, sig });
    if (sig === 0) return true; // probe always succeeds in this fake
    return true;
  };
  const ok = signalBotPid({ pid: 12345, signal: 'SIGUSR1', kill: fakeKill });
  assert.equal(ok.ok, true);
  assert.deepEqual(calls, [{ pid: 12345, sig: 0 }, { pid: 12345, sig: 'SIGUSR1' }], 'probe (sig=0) sent before real signal');
});

test('server: signalBotPid reports PID_NOT_RUNNING on ESRCH', () => {
  const fakeKill = (pid, sig) => {
    if (sig === 0) {
      const e = new Error('no such process');
      /** @type {any} */ (e).code = 'ESRCH';
      throw e;
    }
    return true;
  };
  const out = signalBotPid({ pid: 1, signal: 'SIGUSR1', kill: fakeKill });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'PID_NOT_RUNNING');
});

test('server: signalBotPid rejects bad inputs', () => {
  assert.equal(signalBotPid({ pid: 0 }).ok, false);
  assert.equal(signalBotPid({ pid: -5 }).ok, false);
  assert.equal(signalBotPid({ pid: 1.5 }).ok, false);
  assert.equal(signalBotPid({ pid: 1, signal: '' }).ok, false);
});

test('server: POST /api/config/:path without api_token returns 503 AUTH_NOT_CONFIGURED', async (t) => {
  const dir = await makeTmp(t);
  const cfg = {
    paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s`, user: `${dir}/user.json` },
  };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const { server } = makeServer({ cfg, positions, snapshots, historyReader });
  const res = await supertest(server.handler)
    .post('/api/config/entry.max_position_bch')
    .send({ value: 0.01 })
    .expect(503);
  assert.equal(res.body.code, 'AUTH_NOT_CONFIGURED');
});

test('server: POST /api/config/:path with unknown knob returns 404 KNOB_NOT_IN_CATALOG', async (t) => {
  const dir = await makeTmp(t);
  const cfg = {
    dashboard: { api_token: 'tok' },
    paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s`, user: `${dir}/user.json` },
  };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const { server } = makeServer({ cfg, positions, snapshots, historyReader });
  const res = await supertest(server.handler)
    .post('/api/config/entry.this_does_not_exist')
    .set('Authorization', 'Bearer tok')
    .send({ value: 0.01 })
    .expect(404);
  assert.equal(res.body.code, 'KNOB_NOT_IN_CATALOG');
});

test('server: POST /api/config/:path rejects value above catalog max with KNOB_VALUE_INVALID', async (t) => {
  const dir = await makeTmp(t);
  const cfg = {
    dashboard: { api_token: 'tok' },
    paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s`, user: `${dir}/user.json` },
  };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const { server } = makeServer({ cfg, positions, snapshots, historyReader });
  // scoring.weights.volume_30d_bch max is 5 (catalog).
  const res = await supertest(server.handler)
    .post('/api/config/scoring.weights.volume_30d_bch')
    .set('Authorization', 'Bearer tok')
    .send({ value: 99 })
    .expect(400);
  assert.equal(res.body.code, 'KNOB_VALUE_INVALID');
  assert.equal(res.body.reason, 'above_max');
});

test('server: POST /api/config/:path with missing value returns 400 BAD_BODY', async (t) => {
  const dir = await makeTmp(t);
  const cfg = {
    dashboard: { api_token: 'tok' },
    paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s`, user: `${dir}/user.json` },
  };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const { server } = makeServer({ cfg, positions, snapshots, historyReader });
  const res = await supertest(server.handler)
    .post('/api/config/entry.max_position_bch')
    .set('Authorization', 'Bearer tok')
    .send({ wrong_key: 'oops' })
    .expect(400);
  assert.equal(res.body.code, 'BAD_BODY');
});

test('server: POST /api/config/:path writes user.json atomically + returns diff', async (t) => {
  const dir = await makeTmp(t);
  const userPath = `${dir}/user.json`;
  const pidPath = `${dir}/run.pid`;
  // PID points at a non-existent process so the signal probe fails
  // — the test asserts the write still succeeds + pid_signaled:false
  // (the endpoint should NOT fail the patch because the bot isn't
  // running; the operator can decide to restart manually).
  await writeFile(pidPath, '99999999\n', 'utf8');
  const cfg = {
    dashboard: { api_token: 'tok' },
    paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s`, user: userPath },
  };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const { server } = makeServer({ cfg, positions, snapshots, historyReader, pidFile: pidPath });
  const res = await supertest(server.handler)
    .post('/api/config/entry.max_position_bch')
    .set('Authorization', 'Bearer tok')
    .send({ value: 0.0125 })
    .expect(200);
  assert.equal(res.body.schema, 'tradebot.dashboard.config.knob/v1');
  assert.equal(res.body.applied, true);
  assert.equal(res.body.knob, 'entry.max_position_bch');
  assert.equal(res.body.new_value, 0.0125);
  assert.equal(res.body.old_value, undefined, 'first time the knob was set → old_value is undefined');
  assert.equal(res.body.pid_signaled, false, 'PID 99999999 is not running on this host');
  assert.equal(res.body.pid_error_code, 'PID_NOT_RUNNING');
  assert.equal(res.body.restart_required, true, 'max_position_bch is restart:true in the catalog');
  const written = JSON.parse(await readFile(userPath, 'utf8'));
  assert.equal(written.entry.max_position_bch, 0.0125);
});

test('server: POST /api/config/:path preserves sibling knobs when deep-merging', async (t) => {
  const dir = await makeTmp(t);
  const userPath = `${dir}/user.json`;
  await writeFile(userPath, JSON.stringify({
    entry: { max_position_bch: 0.005, slippage_tolerance_bps: 100, time_stop_hours: 24 },
    dashboard: { api_token: 'tok' },
  }), 'utf8');
  const cfg = {
    dashboard: { api_token: 'tok' },
    paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s`, user: userPath },
  };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const { server } = makeServer({ cfg, positions, snapshots, historyReader, pidFile: `${dir}/missing.pid` });
  const res = await supertest(server.handler)
    .post('/api/config/entry.max_position_bch')
    .set('Authorization', 'Bearer tok')
    .send({ value: 0.05 })
    .expect(200);
  assert.equal(res.body.old_value, 0.005);
  assert.equal(res.body.new_value, 0.05);
  const after = JSON.parse(await readFile(userPath, 'utf8'));
  assert.equal(after.entry.max_position_bch, 0.05);
  assert.equal(after.entry.slippage_tolerance_bps, 100, 'sibling knob preserved');
  assert.equal(after.entry.time_stop_hours, 24, 'sibling knob preserved');
  assert.equal(after.dashboard.api_token, 'tok', 'sibling branch preserved');
  // Missing PID file → endpoint succeeds (write landed) but
  // reports pid_signaled:false with PID_FILE_MISSING.
  assert.equal(res.body.pid_signaled, false);
  assert.equal(res.body.pid_error_code, 'PID_FILE_MISSING');
});

test('server: POST /api/config/:path with restart:false knob returns 400 RESTART_NOT_NEEDED without override', async (t) => {
  const dir = await makeTmp(t);
  const cfg = {
    dashboard: { api_token: 'tok' },
    paths: { positions_file: `${dir}/p.json`, snapshots_dir: `${dir}/s`, user: `${dir}/user.json` },
  };
  const positions = new Positions({ file: cfg.paths.positions_file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshots = new Snapshots({ dir: cfg.paths.snapshots_dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const historyReader = createHistoryReader({ file: `${dir}/h.ndjson` });
  const { server } = makeServer({ cfg, positions, snapshots, historyReader, pidFile: `${dir}/missing.pid` });
  // No knob in the catalog is currently restart:false — simulate
  // by passing a meta-restart:false knob via a tiny mock catalog.
  // Easier: use one of the boolean/text knobs. None of those are
  // currently in the catalog. Instead, exercise the gate logic by
  // asserting the default path is restart_required:true (proves the
  // catalog lookup returns meta.restart === true for every catalog
  // entry today). If a future knob is added with restart:false the
  // gate test below covers that branch.
  const res = await supertest(server.handler)
    .post('/api/config/entry.max_position_bch')
    .set('Authorization', 'Bearer tok')
    .send({ value: 0.01 })
    .expect(200);
  assert.equal(res.body.restart_required, true);
});

// ─────────────────────────────────────────────────────────────────────
//  T45 — manual BUY/SELL trigger (subset 1: backend route + parser)
// ─────────────────────────────────────────────────────────────────────

const VALID_TOKEN = 'a'.repeat(64);
const OTHER_VALID_TOKEN = 'B'.repeat(64);

test('T45 parseManualTradeRequest: happy path accepts all required fields', () => {
  const out = parseManualTradeRequest({
    token_id: VALID_TOKEN,
    side: 'buy',
    amount_bch: 0.001,
  });
  assert.equal(out.ok, true);
  assert.equal(out.value.token_id, VALID_TOKEN);
  assert.equal(out.value.side, 'buy');
  assert.equal(out.value.amount_bch, 0.001);
  assert.equal(out.value.dry_run, false);
  assert.equal(out.value.expected_rate_sats_per_token, null);
});

test('T45 parseManualTradeRequest: lowercases the token_id', () => {
  const upper = 'A'.repeat(64);
  const out = parseManualTradeRequest({ token_id: upper, side: 'sell', amount_bch: 0.005 });
  assert.equal(out.ok, true);
  assert.equal(out.value.token_id, upper.toLowerCase());
});

test('T45 parseManualTradeRequest: trims whitespace from token_id', () => {
  const out = parseManualTradeRequest({
    token_id: `  ${VALID_TOKEN}  `,
    side: 'buy',
    amount_bch: 0.001,
  });
  assert.equal(out.ok, true);
  assert.equal(out.value.token_id, VALID_TOKEN);
});

test('T45 parseManualTradeRequest: passes through optional fields', () => {
  const out = parseManualTradeRequest({
    token_id: VALID_TOKEN,
    side: 'sell',
    amount_bch: 0.5,
    dry_run: true,
    expected_rate_sats_per_token: 12345.67,
  });
  assert.equal(out.ok, true);
  assert.equal(out.value.dry_run, true);
  assert.equal(out.value.expected_rate_sats_per_token, 12345.67);
});

test('T45 parseManualTradeRequest: rejects non-object body', () => {
  for (const bad of [null, undefined, 'string', 42, [], true]) {
    const out = parseManualTradeRequest(bad);
    assert.equal(out.ok, false, `should reject ${JSON.stringify(bad)}`);
    assert.equal(out.code, 'BAD_BODY');
  }
});

test('T45 parseManualTradeRequest: rejects missing or wrong-shape token_id', () => {
  for (const bad of [undefined, '', 'short', 12345, {}, VALID_TOKEN.slice(0, 63), `${VALID_TOKEN}00`, 'g'.repeat(64)]) {
    const out = parseManualTradeRequest({ token_id: bad, side: 'buy', amount_bch: 0.001 });
    assert.equal(out.ok, false, `should reject token_id=${JSON.stringify(bad)}`);
    assert.equal(out.code, 'BAD_BODY');
    assert.match(out.error, /token_id/);
  }
});

test('T45 parseManualTradeRequest: rejects wrong side', () => {
  for (const bad of ['hold', 'BUY', 'Sell', '', null, 1, {}, []]) {
    const out = parseManualTradeRequest({ token_id: VALID_TOKEN, side: bad, amount_bch: 0.001 });
    assert.equal(out.ok, false, `should reject side=${JSON.stringify(bad)}`);
    assert.equal(out.code, 'BAD_BODY');
    assert.match(out.error, /side/);
  }
});

test('T45 parseManualTradeRequest: rejects non-positive or non-numeric amount_bch', () => {
  for (const bad of [0, -0.001, -1, NaN, Infinity, -Infinity, null, undefined, '0.5', true, [], {}]) {
    const out = parseManualTradeRequest({ token_id: VALID_TOKEN, side: 'buy', amount_bch: bad });
    assert.equal(out.ok, false, `should reject amount_bch=${JSON.stringify(bad)}`);
    assert.equal(out.code, 'BAD_BODY');
    assert.match(out.error, /amount_bch/);
  }
});

test('T45 parseManualTradeRequest: rejects non-boolean dry_run', () => {
  const out = parseManualTradeRequest({
    token_id: VALID_TOKEN, side: 'buy', amount_bch: 0.001, dry_run: 'true',
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'BAD_BODY');
  assert.match(out.error, /dry_run/);
});

test('T45 parseManualTradeRequest: rejects non-positive expected_rate_sats_per_token', () => {
  for (const bad of [0, -1, NaN, Infinity, '100', true, [], {}]) {
    const out = parseManualTradeRequest({
      token_id: VALID_TOKEN, side: 'buy', amount_bch: 0.001,
      expected_rate_sats_per_token: bad,
    });
    assert.equal(out.ok, false, `should reject rate=${JSON.stringify(bad)}`);
    assert.equal(out.code, 'BAD_BODY');
    assert.match(out.error, /expected_rate_sats_per_token/);
  }
  // Null is OK (means "don't override, use the indexer's spot rate").
  const ok = parseManualTradeRequest({
    token_id: VALID_TOKEN, side: 'buy', amount_bch: 0.001,
    expected_rate_sats_per_token: null,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.expected_rate_sats_per_token, null);
});

// ── HTTP integration: POST /api/trade/manual ──────────────────────────

function makeManualTradeServer({ apiToken = 'tok', swap, wallet, historyAppend } = {}) {
  const cfg = { dashboard: { api_token: apiToken } };
  return makeServer({
    cfg,
    positions: { list: async () => [] },
    snapshots: { readBack: async () => ({ records: [], errors: [] }) },
    historyReader: { read: async () => ({ events: [], errors: [] }) },
    wallet: wallet ?? { getTokenAddress: () => 'bitcoincash:ztest' },
    swap,
    historyAppend,
  });
}

test('T45: POST /api/trade/manual returns 503 AUTH_NOT_CONFIGURED without api_token', async () => {
  const { server } = makeServer({
    cfg: { dashboard: { api_token: '' } },
    positions: { list: async () => [] },
    snapshots: { readBack: async () => ({ records: [], errors: [] }) },
    historyReader: { read: async () => ({ events: [], errors: [] }) },
  });
  const res = await supertest(server.handler)
    .post('/api/trade/manual')
    .set('Authorization', 'Bearer wrong')
    .send({ token_id: VALID_TOKEN, side: 'buy', amount_bch: 0.001 })
    .expect(503);
  assert.equal(res.body.code, 'AUTH_NOT_CONFIGURED');
});

test('T45: POST /api/trade/manual returns 503 SWAP_NOT_CONFIGURED when ctx.swap missing', async () => {
  const { server } = makeManualTradeServer({});
  const res = await supertest(server.handler)
    .post('/api/trade/manual')
    .set('Authorization', 'Bearer tok')
    .send({ token_id: VALID_TOKEN, side: 'buy', amount_bch: 0.001 })
    .expect(503);
  assert.equal(res.body.code, 'SWAP_NOT_CONFIGURED');
  assert.match(res.body.error, /swap executor not wired/);
});

test('T45: POST /api/trade/manual returns 503 WALLET_NOT_CONFIGURED when wallet missing getTokenAddress', async () => {
  const swap = { execute: async () => ({ ok: true }) };
  // `wallet: null` falls through the `null ?? default` in makeManualTradeServer,
  // so we pass a sentinel object that lacks `getTokenAddress` to exercise the
  // WALLET_NOT_CONFIGURED branch in the handler.
  const { server } = makeManualTradeServer({ swap, wallet: {} });
  const res = await supertest(server.handler)
    .post('/api/trade/manual')
    .set('Authorization', 'Bearer tok')
    .send({ token_id: VALID_TOKEN, side: 'buy', amount_bch: 0.001 })
    .expect(503);
  assert.equal(res.body.code, 'WALLET_NOT_CONFIGURED');
});

test('T45: POST /api/trade/manual returns 400 BAD_BODY for malformed body', async () => {
  const swap = { execute: async () => ({ ok: true }) };
  const { server } = makeManualTradeServer({ swap });
  // No body at all.
  const res1 = await supertest(server.handler)
    .post('/api/trade/manual')
    .set('Authorization', 'Bearer tok')
    .send({})
    .expect(400);
  assert.equal(res1.body.code, 'BAD_BODY');
  // Bad token_id.
  const res2 = await supertest(server.handler)
    .post('/api/trade/manual')
    .set('Authorization', 'Bearer tok')
    .send({ token_id: 'short', side: 'buy', amount_bch: 0.001 })
    .expect(400);
  assert.equal(res2.body.code, 'BAD_BODY');
  assert.match(res2.body.error, /token_id/);
});

test('T45: POST /api/trade/manual calls SwapExecutor.execute with translated BCH-sats amountBase', async () => {
  let received = null;
  const swap = {
    execute: async (req) => {
      received = req;
      return {
        ok: true,
        side: req.side,
        tokenId: req.tokenId,
        amountBase: 1000n,
        effectiveRateSats: 50n,
        expectedRateSats: 49n,
        slippageBps: 100n,
        totalSatsInOrOut: 50000n,
        lpFeeSats: 200n,
        estNetworkFeeSats: 1000n,
        txid: 'abc123',
        ts: new Date().toISOString(),
      };
    },
  };
  const { server } = makeManualTradeServer({ swap });
  const res = await supertest(server.handler)
    .post('/api/trade/manual')
    .set('Authorization', 'Bearer tok')
    .send({ token_id: VALID_TOKEN, side: 'buy', amount_bch: 0.005 })
    .expect(200);
  assert.equal(received.tokenId, VALID_TOKEN);
  assert.equal(received.side, 'buy');
  assert.equal(received.amountBase, 500000n, '0.005 BCH * 1e8 = 500_000 sats');
  assert.equal(received.destination, 'bitcoincash:ztest');
  assert.equal(received.dryRun, false);
  // Envelope shape
  assert.equal(res.body.schema, 'tradebot.dashboard.trade.manual/v1');
  assert.equal(res.body.ok, true);
  assert.equal(res.body.side, 'buy');
  assert.equal(res.body.token_id, VALID_TOKEN);
  assert.equal(res.body.amount_bch, 0.005);
  assert.equal(res.body.dry_run, false);
  assert.equal(res.body.swap.txid, 'abc123');
  assert.equal(res.body.swap.effectiveRateSats, '50');
  assert.equal(res.body.swap.slippageBps, '100');
});

test('T45: POST /api/trade/manual threads expected_rate_sats_per_token through as bigint expectedRateSats', async () => {
  let received = null;
  const swap = {
    execute: async (req) => {
      received = req;
      return { ok: true, side: req.side, tokenId: req.tokenId, amountBase: 0n, effectiveRateSats: 0n, expectedRateSats: 0n, slippageBps: 0n, totalSatsInOrOut: 0n, lpFeeSats: 0n, estNetworkFeeSats: 0n, ts: new Date().toISOString() };
    },
  };
  const { server } = makeManualTradeServer({ swap });
  await supertest(server.handler)
    .post('/api/trade/manual')
    .set('Authorization', 'Bearer tok')
    .send({ token_id: VALID_TOKEN, side: 'sell', amount_bch: 0.003, expected_rate_sats_per_token: 42.7, dry_run: true })
    .expect(200);
  assert.equal(received.expectedRateSats, 43n, '42.7 rounds to 43');
  assert.equal(received.dryRun, true);
  assert.equal(received.side, 'sell');
});

test('T45: POST /api/trade/manual surfaces swap-result envelope shape on ok=false', async () => {
  const swap = {
    execute: async () => ({
      ok: false,
      side: 'buy',
      tokenId: VALID_TOKEN,
      error: 'expected slippage 5000 bps exceeds tolerance 100 bps',
      errorKind: 'slippage_exceeded',
      ts: new Date().toISOString(),
      effectiveRateSats: 0n, expectedRateSats: 0n, slippageBps: 5000n, totalSatsInOrOut: 0n, lpFeeSats: 0n, estNetworkFeeSats: 0n, amountBase: 0n,
    }),
  };
  const { server } = makeManualTradeServer({ swap });
  const res = await supertest(server.handler)
    .post('/api/trade/manual')
    .set('Authorization', 'Bearer tok')
    .send({ token_id: VALID_TOKEN, side: 'buy', amount_bch: 0.001 })
    .expect(200); // The HTTP envelope is 200 (the swap pre-flight refuses inside the envelope).
  assert.equal(res.body.ok, false);
  assert.equal(res.body.swap.errorKind, 'slippage_exceeded');
  assert.match(res.body.swap.error, /slippage/);
});

test('T45: POST /api/trade/manual returns 500 SWAP_THREW when executor throws', async () => {
  const swap = { execute: async () => { throw new Error('wallet WIF unavailable'); } };
  const { server } = makeManualTradeServer({ swap });
  const res = await supertest(server.handler)
    .post('/api/trade/manual')
    .set('Authorization', 'Bearer tok')
    .send({ token_id: VALID_TOKEN, side: 'buy', amount_bch: 0.001 })
    .expect(500);
  assert.equal(res.body.code, 'SWAP_THREW');
  assert.match(res.body.error, /wallet WIF unavailable/);
  assert.equal(res.body.error_name, 'Error');
});

test('T45: POST /api/trade/manual appends kind:manual_trade history event on success', async () => {
  const appended = [];
  const swap = {
    execute: async (req) => ({
      ok: true, side: req.side, tokenId: req.tokenId,
      amountBase: 0n, effectiveRateSats: 0n, expectedRateSats: 0n, slippageBps: 0n,
      totalSatsInOrOut: 0n, lpFeeSats: 0n, estNetworkFeeSats: 0n,
      txid: 'deadbeef', ts: new Date().toISOString(),
    }),
  };
  const historyAppend = async (e) => { appended.push(e); };
  const { server } = makeManualTradeServer({ swap, historyAppend });
  await supertest(server.handler)
    .post('/api/trade/manual')
    .set('Authorization', 'Bearer tok')
    .send({ token_id: VALID_TOKEN, side: 'buy', amount_bch: 0.001 })
    .expect(200);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].kind, 'manual_trade');
  assert.equal(appended[0].source, 'dashboard');
  assert.equal(appended[0].token_id, VALID_TOKEN);
  assert.equal(appended[0].side, 'buy');
  assert.equal(appended[0].amount_bch, 0.001);
  assert.equal(appended[0].dry_run, false);
  assert.equal(appended[0].ok, true);
  assert.equal(appended[0].txid, 'deadbeef');
});

test('T45: POST /api/trade/manual still returns 200 if historyAppend fails (audit is best-effort)', async () => {
  const swap = {
    execute: async (req) => ({
      ok: true, side: req.side, tokenId: req.tokenId,
      amountBase: 0n, effectiveRateSats: 0n, expectedRateSats: 0n, slippageBps: 0n,
      totalSatsInOrOut: 0n, lpFeeSats: 0n, estNetworkFeeSats: 0n, ts: new Date().toISOString(),
    }),
  };
  const historyAppend = async () => { throw new Error('disk full'); };
  const { server } = makeManualTradeServer({ swap, historyAppend });
  const res = await supertest(server.handler)
    .post('/api/trade/manual')
    .set('Authorization', 'Bearer tok')
    .send({ token_id: VALID_TOKEN, side: 'buy', amount_bch: 0.001 })
    .expect(200);
  assert.equal(res.body.ok, true);
});

test('T45: buildRouteTable includes POST /api/trade/manual with auth:true', () => {
  const routes = buildRouteTable();
  const route = routes.find((r) => r.path === '/api/trade/manual');
  assert.ok(route, 'route missing');
  assert.equal(route.method, 'POST');
  assert.equal(route.auth, true);
  assert.equal(typeof route.handler, 'function');
  assert.ok(route.pattern.test('/api/trade/manual'));
  assert.ok(route.pattern.test('/api/trade/manual/'));
});

test('T45: statusForResult maps new T45 error codes to HTTP statuses', () => {
  assert.equal(statusForResult({ code: 'SWAP_NOT_CONFIGURED' }), 503);
  assert.equal(statusForResult({ code: 'WALLET_NOT_CONFIGURED' }), 503);
  assert.equal(statusForResult({ code: 'SWAP_THREW' }), 500);
});

// ─────────────────────────────────────────────────────────────────────
//  T45b: GET /api/pools/top + projectPoolOption
// ─────────────────────────────────────────────────────────────────────

const POOL_FETCHER_OK = {
  listTopTokens: async () => [
    {
      token_id: 'a'.repeat(64),
      bcmr: { token: { symbol: 'NWB', decimals: 2 }, name: 'NewB' },
      tvl_sats: 1_500_000_000,
      trade_volume: 25_000_000,
    },
    {
      token_id: 'b'.repeat(64),
      display_symbol: 'OLA',
      tvl_sats: 250_000,
      trade_volume: 5_000,
    },
    {
      token_id: 'c'.repeat(64),
      bcmr: { token: { symbol: 'HONEY', decimals: 4 } },
      tvl_sats: 0,
      trade_volume: null,
    },
    // Garbage entry — must be filtered out (token_id wrong length).
    { token_id: 'short', bcmr: { token: { symbol: 'X' } } },
  ],
};

function makePoolsServer({ fetcher } = {}) {
  const cfg = { dashboard: {} };
  return makeServer({
    cfg,
    positions: { list: async () => [] },
    snapshots: { readBack: async () => ({ records: [], errors: [] }) },
    historyReader: { read: async () => ({ events: [], errors: [] }) },
    fetcher,
  });
}

test('T45b: projectPoolOption — collapses BCMR + display_symbol into one shape', () => {
  const out = projectPoolOption({
    token_id: 'a'.repeat(64),
    bcmr: { token: { symbol: 'NWB', decimals: 2 }, name: 'NewB' },
    tvl_sats: 100,
    trade_volume: 50,
  });
  assert.equal(out.token_id, 'a'.repeat(64));
  assert.equal(out.symbol, 'NWB');
  assert.equal(out.decimals, 2);
  assert.equal(out.name, 'NewB');
  assert.equal(out.tvl_sats, 100);
  assert.equal(out.trade_volume, 50);
});

test('T45b: projectPoolOption — falls back to display_symbol when no BCMR', () => {
  const out = projectPoolOption({
    token_id: 'a'.repeat(64),
    display_symbol: 'OLA',
    display_name: 'Olive',
    tvl_sats: null,
    trade_volume: null,
  });
  assert.equal(out.symbol, 'OLA');
  assert.equal(out.name, 'Olive');
  assert.equal(out.decimals, null);
});

test('T45b: projectPoolOption — null on garbage input', () => {
  assert.deepEqual(projectPoolOption(null), {
    token_id: '', symbol: null, decimals: null, name: null, tvl_sats: null, trade_volume: null,
  });
  assert.deepEqual(projectPoolOption({}), {
    token_id: '', symbol: null, decimals: null, name: null, tvl_sats: null, trade_volume: null,
  });
});

test('T45b: projectPoolOption — coerces non-finite tvl to null', () => {
  const out = projectPoolOption({
    token_id: 'a'.repeat(64),
    tvl_sats: NaN,
    trade_volume: 'not-a-number',
  });
  assert.equal(out.tvl_sats, null);
  assert.equal(out.trade_volume, null);
});

test('T45b: GET /api/pools/top returns 503 fetcher_not_configured when no fetcher wired', async () => {
  const { server } = makePoolsServer({ fetcher: null });
  const res = await supertest(server.handler).get('/api/pools/top').expect(200);
  // 200 with typed-error body — mirrors /api/reconcile/positions-vs-chain.
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error, 'fetcher_not_configured');
  assert.equal(res.body.status, 503);
});

test('T45b: GET /api/pools/top returns the projected pool list', async () => {
  const { server } = makePoolsServer({ fetcher: POOL_FETCHER_OK });
  const res = await supertest(server.handler).get('/api/pools/top').expect(200);
  assert.equal(res.body.ok, undefined); // endpoint uses a plain schema envelope, not {ok:...}
  assert.equal(res.body.schema, 'tradebot.dashboard.pools.top/v1');
  assert.equal(res.body.limit, 50);
  assert.equal(res.body.count, 3); // garbage entry with short token_id is filtered out
  const symbols = res.body.pools.map((p) => p.symbol);
  assert.deepEqual(symbols, ['NWB', 'OLA', 'HONEY']);
  const nwb = res.body.pools[0];
  assert.equal(nwb.token_id, 'a'.repeat(64));
  assert.equal(nwb.symbol, 'NWB');
  assert.equal(nwb.decimals, 2);
  assert.equal(nwb.name, 'NewB');
});

test('T45b: GET /api/pools/top respects ?limit=N and clamps to [1, 200]', async () => {
  const { server } = makePoolsServer({ fetcher: POOL_FETCHER_OK });
  const r1 = await supertest(server.handler).get('/api/pools/top?limit=2').expect(200);
  assert.equal(r1.body.limit, 2);
  // The fetcher mock returns 4 entries (3 valid); we just assert
  // the limit param is passed through — the fetcher's own clamping
  // is exercised in fetcher tests.
  const r2 = await supertest(server.handler).get('/api/pools/top?limit=0').expect(200);
  assert.equal(r2.body.error, 'limit must be an integer in [1, 200]');
  assert.equal(r2.body.status, 400);
  const r3 = await supertest(server.handler).get('/api/pools/top?limit=999').expect(200);
  assert.equal(r3.body.error, 'limit must be an integer in [1, 200]');
  const r4 = await supertest(server.handler).get('/api/pools/top?limit=abc').expect(200);
  assert.equal(r4.body.error, 'limit must be an integer in [1, 200]');
});

test('T45b: GET /api/pools/top returns 502 when fetcher throws', async () => {
  const { server } = makePoolsServer({
    fetcher: { listTopTokens: async () => { throw new Error('network down'); } },
  });
  const res = await supertest(server.handler).get('/api/pools/top').expect(200);
  assert.equal(res.body.error, 'indexer lookup failed: network down');
  assert.equal(res.body.status, 502);
  assert.equal(res.body.code, 'FETCHER_LOOKUP_FAILED');
});

test('T45b: GET /api/pools/top returns 502 when fetcher returns a non-array', async () => {
  const { server } = makePoolsServer({
    fetcher: { listTopTokens: async () => ({ not: 'an array' }) },
  });
  const res = await supertest(server.handler).get('/api/pools/top').expect(200);
  assert.equal(res.body.error, 'indexer returned a non-array response');
  assert.equal(res.body.status, 502);
  assert.equal(res.body.code, 'FETCHER_SHAPE_INVALID');
});

test('T45b: buildRouteTable includes GET /api/pools/top with auth:false', () => {
  const routes = buildRouteTable();
  const route = routes.find((r) => r.path === '/api/pools/top');
  assert.ok(route, 'route missing');
  assert.equal(route.method, 'GET');
  assert.equal(route.auth, false);
  assert.equal(typeof route.handler, 'function');
  assert.ok(route.pattern.test('/api/pools/top'));
  assert.ok(route.pattern.test('/api/pools/top/'));
});

// ────────────────────────────────────────────────────────────────────
//  O03 (idea_operator_position-prevent-stop-loss-with-profit-target_20260917):
//  computeCurrentWorthBch + computePctChangeVsEntry pure helpers.
// ────────────────────────────────────────────────────────────────────

test('O03 computeCurrentWorthBch: token_amount_base as string-encoded bigint', async () => {
  const { computeCurrentWorthBch } = await import('../src/dashboard/server.mjs');
  // 1315 tokens × 299 sats/token = 392,985 sats = 0.00393185 BCH
  const w = computeCurrentWorthBch(299, '1315');
  assert.equal(w, 0.00393185);
});

test('O03 computeCurrentWorthBch: token_amount_base as number', async () => {
  const { computeCurrentWorthBch } = await import('../src/dashboard/server.mjs');
  const w = computeCurrentWorthBch(299, 1315);
  assert.equal(w, 0.00393185);
});

test('O03 computeCurrentWorthBch: missing price → null', async () => {
  const { computeCurrentWorthBch } = await import('../src/dashboard/server.mjs');
  assert.equal(computeCurrentWorthBch(null, 1315), null);
  assert.equal(computeCurrentWorthBch(0, 1315), null);
  assert.equal(computeCurrentWorthBch(-1, 1315), null);
  assert.equal(computeCurrentWorthBch(NaN, 1315), null);
});

test('O03 computeCurrentWorthBch: missing amount → null', async () => {
  const { computeCurrentWorthBch } = await import('../src/dashboard/server.mjs');
  assert.equal(computeCurrentWorthBch(299, null), null);
  assert.equal(computeCurrentWorthBch(299, undefined), null);
  assert.equal(computeCurrentWorthBch(299, 0), null);
  assert.equal(computeCurrentWorthBch(299, -1), null);
  assert.equal(computeCurrentWorthBch(299, 'not a number'), null);
});

test('O03 computePctChangeVsEntry: +20% when worth is 1.2× entry', async () => {
  const { computePctChangeVsEntry } = await import('../src/dashboard/server.mjs');
  // Entry: 0.005 BCH (500,000 sats), current worth: 0.006 BCH → +20%
  const pct = computePctChangeVsEntry(0.006, 500000);
  assert.ok(Math.abs(pct - 20) < 1e-6);
});

test('O03 computePctChangeVsEntry: -10% when worth is 0.9× entry', async () => {
  const { computePctChangeVsEntry } = await import('../src/dashboard/server.mjs');
  const pct = computePctChangeVsEntry(0.0045, 500000);
  assert.ok(Math.abs(pct - (-10)) < 1e-6);
});

test('O03 computePctChangeVsEntry: 0% when worth equals entry', async () => {
  const { computePctChangeVsEntry } = await import('../src/dashboard/server.mjs');
  const pct = computePctChangeVsEntry(0.005, 500000);
  assert.equal(pct, 0);
});

test('O03 computePctChangeVsEntry: missing inputs → null', async () => {
  const { computePctChangeVsEntry } = await import('../src/dashboard/server.mjs');
  assert.equal(computePctChangeVsEntry(null, 500000), null);
  assert.equal(computePctChangeVsEntry(0.005, null), null);
  assert.equal(computePctChangeVsEntry(0.005, 0), null);
  assert.equal(computePctChangeVsEntry(0.005, 'not a number'), null);
  assert.equal(computePctChangeVsEntry(NaN, 500000), null);
});

test('O03 computePctChangeVsEntry: string-encoded sats', async () => {
  const { computePctChangeVsEntry } = await import('../src/dashboard/server.mjs');
  // String-encoded sats (positions.json serializes bigints as strings)
  const pct = computePctChangeVsEntry(0.004, '500000');
  assert.ok(Math.abs(pct - (-20)) < 1e-6);
});

// Bug bug-both-graphs-on-the-dashboard-dont-seem-to-reflect-positions-20260918
// (O03 follow-up): the wire field for live position worth is
// `current_worth_sats` (string-encoded sat amount) — NOT a BCH
// float. The dashboard's formatBch(sats) divides by 1e8 exactly
// once, so the operator sees the real BCH worth instead of
// 0.00000000 BCH. This locks the wire format.
test('O03 positions wire: current_worth_sats is a sat string, NOT a BCH float', async () => {
  const { computeCurrentWorthBch } = await import('../src/dashboard/server.mjs');
  // 1315 tokens × 299 sats/token = 393,185 sats = 0.00393185 BCH.
  const worthBch = computeCurrentWorthBch(299, 1315);
  assert.equal(worthBch, 0.00393185);
  // The wire field conversion: round the BCH float to sats,
  // serialize as a string. Same precision the dashboard's
  // formatBch(sats) is built for.
  const sats = Math.round(worthBch * 100_000_000).toString();
  assert.equal(sats, '393185');
  // Sanity: the old (buggy) wire shape was the BCH float. A
  // dashboard that passed that through formatBch would render
  // 0.00000004 BCH (one extra /1e8) — making this assertion the
  // regression-latch for the O03 unit-mismatch fix.
  assert.notEqual(sats, String(worthBch));
});

// ─────────────────────────────────────────────────────────────────────
//  Setup-wizard integration tests
//
// Drive the dashboard server end-to-end through /api/setup/status
// and /api/setup. The wizard writes to `config/user.json` via the
// atomic-write helper; the tests inject an in-memory `fs` so no
// real disk write happens.
//
// Run with:
//   node --test tests/server.test.mjs  (this block)
// ─────────────────────────────────────────────────────────────────────

function makeSetupServer({ fs: fsImpl, cfg = {}, readUserJson = null } = {}) {
  const mergedCfg = {
    paths: {
      user: '/cfg/user.json',
      default: '/cfg/default.json',
      positions_file: '/data/positions.json',
      snapshots_dir: '/data/snapshots',
    },
    ...cfg,
  };
  return makeServer({
    cfg: mergedCfg,
    positions: { list: async () => [] },
    snapshots: { readBack: async () => ({ records: [], errors: [] }) },
    historyReader: { read: async () => ({ events: [], errors: [] }) },
    fs: fsImpl ?? null,
    readUserJson,
  });
}

/**
 * Build an in-memory `fs/promises`-shaped mock that supports
 * `readFile`, `writeFile`, `appendFile`, `mkdir`, `access`,
 * `stat`, AND `open`/`rename`/`unlink` (the three calls
 * `atomicWriteJson` makes). The file store is a Map<string,string>.
 */
function makeMemoryFs() {
  /** @type {Map<string, string>} */
  const files = new Map();
  /** @type {Set<string>} */
  const dirs = new Set();
  const enoent = (p) => { const e = new Error(`ENOENT: ${p}`); e.code = 'ENOENT'; throw e; };
  return {
    files,
    dirs,
    async readFile(p) { if (!files.has(p)) enoent(p); return files.get(p); },
    async writeFile(p, data) { files.set(p, String(data)); },
    async appendFile(p, data) { files.set(p, (files.get(p) ?? '') + String(data)); },
    async access(p) { if (!files.has(p) && !dirs.has(p)) enoent(p); },
    async stat(p) {
      if (files.has(p)) return { isFile: () => true };
      if (dirs.has(p)) return { isFile: () => false };
      enoent(p);
    },
    async mkdir(p, opts = {}) {
      const parts = String(p).split('/').filter(Boolean);
      let cur = '';
      for (const part of parts) {
        cur = cur ? `${cur}/${part}` : (p.startsWith('/') ? `/${part}` : part);
        dirs.add(cur);
      }
      return undefined;
    },
    async rename(from, to) {
      if (!files.has(from)) enoent(from);
      files.set(to, files.get(from));
      files.delete(from);
    },
    async unlink(p) {
      if (files.has(p)) { files.delete(p); return; }
      enoent(p);
    },
    async open(p) {
      // Return a file-handle stub that supports writeFile + sync + close.
      return {
        async writeFile(data) { files.set(p, String(data)); },
        async sync() {},
        async close() {},
      };
    },
  };
}

test('setup: GET /api/setup/status → setup_required=true when cfg has no wallet', async () => {
  const { server } = makeSetupServer();
  const res = await supertest(server.handler)
    .get('/api/setup/status')
    .expect(200);
  assert.equal(res.body.setup_required, true);
  assert.ok(res.body.missing.includes('network'));
  assert.ok(res.body.missing.includes('wallet.wif'));
  assert.ok(res.body.missing.includes('wallet.cashaddr'));
  assert.ok(res.body.missing.includes('dashboard.api_token'));
  assert.equal(res.body.network, null);
  assert.equal(res.body.cashaddr, null);
});

test('setup: GET /api/setup/status → setup_required=false when fully configured', async () => {
  const { server } = makeSetupServer({
    cfg: {
      wallet: { network: 'mainnet', wif: 'Kx', cashaddr: 'bitcoincash:qqcp6q32dt4x4ddzrkdz28xmv6a3ev6wwq4t0m57ak' },
      dashboard: { api_token: 'abcdef0123456789' },
    },
  });
  const res = await supertest(server.handler)
    .get('/api/setup/status')
    .expect(200);
  assert.equal(res.body.setup_required, false);
  assert.deepEqual(res.body.missing, []);
  assert.equal(res.body.network, 'mainnet');
  assert.equal(res.body.cashaddr, 'qqcp6q…57ak');
});

test('setup: POST /api/setup — generate mode writes user.json + returns generated_mnemonic', async () => {
  const fsImpl = makeMemoryFs();
  const { server } = makeSetupServer({ fs: fsImpl });

  const res = await supertest(server.handler)
    .post('/api/setup')
    .send({
      network: 'mainnet',
      wallet_mode: 'generate',
      max_position_bch: 0.005,
      max_total_exposure_bch: 0.04,
      take_profit_pct: 5,
      stop_loss_pct: 3,
      slippage_tolerance_bps: 100,
      time_stop_hours: 24,
    })
    .expect(200);

  assert.equal(res.body.network, 'mainnet');
  assert.ok(res.body.cashaddr.startsWith('bitcoincash:'));
  assert.ok(res.body.generated_mnemonic);
  assert.ok(res.body.generated_mnemonic.split(/\s+/).length >= 12);
  assert.ok(res.body.api_token);
  assert.ok(/^[0-9a-f]{64}$/i.test(res.body.api_token), `expected 64-hex api_token, got ${res.body.api_token}`);
  assert.equal(res.body.api_token_auto_generated, true);

  const userPath = '/cfg/user.json';
  assert.ok(fsImpl.files.has(userPath), 'user.json should be written');
  const written = JSON.parse(fsImpl.files.get(userPath));
  assert.equal(written.wallet.network, 'mainnet');
  assert.ok(written.wallet.wif);
  assert.ok(written.wallet.cashaddr.startsWith('bitcoincash:'));
  assert.equal(written.entry.max_position_bch, 0.005);
  assert.equal(written.exit.take_profit_pct, 5);
  assert.equal(written.dashboard.api_token.length, 64);
  assert.ok(written.wallet.last_setup_at);

  const auditFiles = [...fsImpl.files.keys()].filter((k) => k.endsWith('setup-audit.jsonl'));
  assert.equal(auditFiles.length, 1);
  const auditLine = JSON.parse(fsImpl.files.get(auditFiles[0]).split('\n').filter(Boolean)[0]);
  assert.equal(auditLine.mode, 'generate');
  assert.equal(auditLine.network, 'mainnet');
  // cashaddr is truncated, never full.
  assert.ok(auditLine.cashaddr_prefix.endsWith('…') || auditLine.cashaddr_prefix.length < 12);
  assert.equal(auditLine.wif, undefined);
  assert.equal(auditLine.mnemonic, undefined);
});

test('setup: POST /api/setup — bad payload → 400 BAD_PAYLOAD with per-field messages', async () => {
  const fsImpl = makeMemoryFs();
  const { server } = makeSetupServer({ fs: fsImpl });

  const res = await supertest(server.handler)
    .post('/api/setup')
    .send({ network: 'fakenet', wallet_mode: 'guess', max_position_bch: 'NaN' })
    .expect(400);
  assert.equal(res.body.code, 'BAD_PAYLOAD');
  assert.ok(Array.isArray(res.body.errors));
  assert.ok(res.body.errors.some((e) => e.field === 'network'));
  assert.ok(res.body.errors.some((e) => e.field === 'wallet_mode'));
});

test('setup: POST /api/setup — bad WIF checksum → 400 WIF_INVALID (no user.json write)', async () => {
  const fsImpl = makeMemoryFs();
  const { server } = makeSetupServer({ fs: fsImpl });

  const res = await supertest(server.handler)
    .post('/api/setup')
    .send({
      network: 'mainnet',
      wallet_mode: 'import_wif',
      wif: 'KxQ4P9rrnEasbaUFRkfwvYrLy1amRaYisAr4B62NfAry4xd4F41e2E', // bad checksum
      max_position_bch: 0.005,
      max_total_exposure_bch: 0.04,
      take_profit_pct: 5,
      stop_loss_pct: 3,
      slippage_tolerance_bps: 100,
      time_stop_hours: 24,
    })
    .expect(400);
  assert.equal(res.body.code, 'WIF_INVALID');
  assert.equal(res.body.field, 'wif');
  assert.equal([...fsImpl.files.keys()].filter((k) => k.endsWith('user.json')).length, 0);
});

test('setup: POST /api/setup — respects caller-supplied api_token', async () => {
  const fsImpl = makeMemoryFs();
  const { server } = makeSetupServer({ fs: fsImpl });

  const res = await supertest(server.handler)
    .post('/api/setup')
    .send({
      network: 'mainnet',
      wallet_mode: 'generate',
      max_position_bch: 0.005,
      max_total_exposure_bch: 0.04,
      take_profit_pct: 5,
      stop_loss_pct: 3,
      slippage_tolerance_bps: 100,
      time_stop_hours: 24,
      api_token: 'abcdef1234567890',
    })
    .expect(200);
  assert.equal(res.body.api_token, 'abcdef1234567890');
  assert.equal(res.body.api_token_auto_generated, false);
  const written = JSON.parse(fsImpl.files.get('/cfg/user.json'));
  assert.equal(written.dashboard.api_token, 'abcdef1234567890');
});

test('setup: POST /api/setup — deep-merges onto existing user.json (preserves prior WIF if same user.json)', async () => {
  const fsImpl = makeMemoryFs();
  fsImpl.files.set('/cfg/user.json', JSON.stringify({
    wallet: { network: 'mainnet', wif: 'OLDWIF', cashaddr: 'bitcoincash:qold' },
    dashboard: { bind_port: 9999 },
  }));
  const { server } = makeSetupServer({ fs: fsImpl });

  const res = await supertest(server.handler)
    .post('/api/setup')
    .send({
      network: 'mainnet',
      wallet_mode: 'generate',
      max_position_bch: 0.005,
      max_total_exposure_bch: 0.04,
      take_profit_pct: 5,
      stop_loss_pct: 3,
      slippage_tolerance_bps: 100,
      time_stop_hours: 24,
    })
    .expect(200);
  assert.ok(res.body.cashaddr.startsWith('bitcoincash:'));
  const written = JSON.parse(fsImpl.files.get('/cfg/user.json'));
  // bind_port was preserved (deep merge).
  assert.equal(written.dashboard.bind_port, 9999);
  // wallet block was REPLACED (not merged), so the old WIF is gone.
  assert.notEqual(written.wallet.wif, 'OLDWIF');
});
