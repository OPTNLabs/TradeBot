// tests/dashboard-trade-history.test.mjs
//
// Tests for the T42 trade-history subsystem: the pure helpers
// (`flattenPositionsToTradeEvents`, `filterTradeEvents`,
// `parseTradeHistoryFilters`) + the `/api/trade-history` route
// handler. Mirrors the structure of `dashboard-risk-panel.test.mjs`
// and `dashboard-pnl-timeseries.test.mjs`.
//
// All tests run against the pure helpers / a mock `ctx` — no
// real positions file or HTTP server is opened.

import test from 'node:test';
import assert from 'node:assert/strict';
import supertest from 'supertest';

import {
  flattenPositionsToTradeEvents,
  filterTradeEvents,
  parseTradeHistoryFilters,
  rangeToMs,
  createDashboardServer,
} from '../src/dashboard/server.mjs';

// ─────────────────────────────────────────────────────────────────────
//  Fixtures
// ─────────────────────────────────────────────────────────────────────

function makePosition(overrides = {}) {
  const base = {
    id: 'pos_abc_0001',
    token_id: '7fa887fd4eac015478b95392c4984721fbe3060223c30b342d43cc06817f07f6',
    token_symbol: 'FOO',
    token_decimals: 2,
    side: 'long_token',
    status: 'closed',
    opened_at: '2026-09-01T10:00:00.000Z',
    updated_at: '2026-09-01T11:00:00.000Z',
    closed_at: '2026-09-01T11:00:00.000Z',
    entry: {
      txid: '1111111111111111111111111111111111111111111111111111111111111111',
      price_sats_per_token: 1000,
      bch_spent_sats: 500000,
      token_amount_base: '50000',
      fee_sats: 2000,
      broadcast_ms: 1234,
      ts: '2026-09-01T10:00:00.000Z',
    },
    exit: {
      txid: '2222222222222222222222222222222222222222222222222222222222222222',
      price_sats_per_token: 1100,
      bch_received_sats: 510000,
      fee_sats: 2000,
      ts: '2026-09-01T11:00:00.000Z',
      reason: 'take_profit',
      realized_pnl_sats: 10000,
    },
    high_water_mark_sats_per_token: 1100,
    reasoning: null,
  };
  return { ...base, ...overrides };
}

// ─────────────────────────────────────────────────────────────────────
//  flattenPositionsToTradeEvents
// ─────────────────────────────────────────────────────────────────────

test('flattenPositionsToTradeEvents: closed position yields entry+exit events', () => {
  const evs = flattenPositionsToTradeEvents([makePosition()]);
  assert.equal(evs.length, 2);
  const entry = evs.find((e) => e.kind === 'entry');
  const exit = evs.find((e) => e.kind === 'exit');
  assert.ok(entry);
  assert.ok(exit);
  assert.equal(entry.token_symbol, 'FOO');
  assert.equal(entry.side, 'long_token');
  assert.equal(entry.position_id, 'pos_abc_0001');
  assert.equal(entry.amounts.bch_spent_sats, 500000);
  assert.equal(entry.amounts.token_amount_base, '50000');
  assert.equal(entry.pnl.realized_pnl_sats, null);
  assert.equal(exit.amounts.bch_received_sats, 510000);
  assert.equal(exit.amounts.price_sats_per_token, 1100);
  assert.equal(exit.pnl.realized_pnl_sats, 10000);
  assert.equal(exit.pnl_sign, 'gain');
  assert.equal(exit.exit_reason, 'take_profit');
});

test('flattenPositionsToTradeEvents: open position yields entry-only event', () => {
  const p = makePosition({ status: 'open', exit: null });
  const evs = flattenPositionsToTradeEvents([p]);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, 'entry');
  assert.equal(evs[0].status, 'open');
  assert.equal(evs[0].pnl_sign, null);
});

test('flattenPositionsToTradeEvents: loss sign', () => {
  const p = makePosition({
    exit: {
      txid: '2222',
      price_sats_per_token: 900,
      bch_received_sats: 480000,
      fee_sats: 2000,
      ts: '2026-09-01T11:00:00.000Z',
      reason: 'stop_loss',
      realized_pnl_sats: -20000,
    },
  });
  const evs = flattenPositionsToTradeEvents([p]);
  const exit = evs.find((e) => e.kind === 'exit');
  assert.equal(exit.pnl_sign, 'loss');
});

test('flattenPositionsToTradeEvents: zero realized pnl → flat', () => {
  const p = makePosition({
    exit: {
      txid: '3333',
      price_sats_per_token: 1000,
      bch_received_sats: 500000,
      fee_sats: 0,
      ts: '2026-09-01T11:00:00.000Z',
      reason: 'time_stop',
      realized_pnl_sats: 0,
    },
  });
  const evs = flattenPositionsToTradeEvents([p]);
  const exit = evs.find((e) => e.kind === 'exit');
  assert.equal(exit.pnl_sign, 'flat');
});

test('flattenPositionsToTradeEvents: sorts newest-first, entry before exit at same ts', () => {
  const p1 = makePosition({
    id: 'pos_old_0001',
    entry: { ...makePosition().entry, ts: '2026-08-30T00:00:00.000Z' },
    exit: { ...makePosition().exit, ts: '2026-08-30T01:00:00.000Z' },
  });
  const p2 = makePosition({
    id: 'pos_new_0002',
    entry: { ...makePosition().entry, ts: '2026-09-15T00:00:00.000Z' },
    exit: { ...makePosition().exit, ts: '2026-09-15T00:00:00.000Z' }, // same ts as entry
  });
  const evs = flattenPositionsToTradeEvents([p1, p2]);
  // newest ts first (sep 15 > aug 30). At same ts, entry wins.
  assert.equal(evs[0].position_id, 'pos_new_0002');
  assert.equal(evs[0].kind, 'entry'); // entry before exit at same ts
  assert.equal(evs[1].position_id, 'pos_new_0002');
  assert.equal(evs[1].kind, 'exit');
  // p2 events are both newer than p1. Within p1, the exit lands 1h after
  // the entry (Aug 30 00:00 vs Aug 30 01:00), so the exit has a later ts
  // and comes first when sorted newest-first. The "entry before exit at
  // same ts" rule only kicks in for events that share an exact ts.
  assert.equal(evs[2].position_id, 'pos_old_0001');
  assert.equal(evs[2].kind, 'exit');
  assert.equal(evs[3].position_id, 'pos_old_0001');
  assert.equal(evs[3].kind, 'entry');
});

test('flattenPositionsToTradeEvents: ignores non-array', () => {
  assert.deepEqual(flattenPositionsToTradeEvents(null), []);
  assert.deepEqual(flattenPositionsToTradeEvents(undefined), []);
});

test('flattenPositionsToTradeEvents: skips malformed positions', () => {
  const evs = flattenPositionsToTradeEvents([
    null,
    {},
    { id: 'pos_x', token_id: 'aa'.padEnd(64, 'a'), side: 'long_token' }, // no entry/exit
    makePosition(),
  ]);
  assert.equal(evs.length, 2);
  assert.ok(evs.some((e) => e.kind === 'entry'));
  assert.ok(evs.some((e) => e.kind === 'exit'));
});

// ─────────────────────────────────────────────────────────────────────
//  filterTradeEvents
// ─────────────────────────────────────────────────────────────────────

function sampleEvents() {
  // 3 closed positions = 6 events + 1 open = 1 event → 7 events total
  const p1 = makePosition({
    id: 'p1',
    token_id: 'aa'.padEnd(64, 'a'),
    token_symbol: 'AAA',
    side: 'long_token',
    entry: { ...makePosition().entry, ts: '2026-09-01T10:00:00.000Z' },
    exit: { ...makePosition().exit, ts: '2026-09-01T11:00:00.000Z', realized_pnl_sats: 10000 },
  });
  const p2 = makePosition({
    id: 'p2',
    token_id: 'bb'.padEnd(64, 'b'),
    token_symbol: 'BBB',
    side: 'long_token',
    entry: { ...makePosition().entry, ts: '2026-09-05T10:00:00.000Z' },
    exit: { ...makePosition().exit, ts: '2026-09-05T11:00:00.000Z', realized_pnl_sats: -5000 },
  });
  const p3 = makePosition({
    id: 'p3',
    token_id: 'cc'.padEnd(64, 'c'),
    token_symbol: 'CCC',
    side: 'short_token',
    entry: { ...makePosition().entry, ts: '2026-09-10T10:00:00.000Z' },
    exit: { ...makePosition().exit, ts: '2026-09-10T11:00:00.000Z', realized_pnl_sats: 0 },
  });
  const pOpen = makePosition({ id: 'p_open', status: 'open', exit: null, entry: { ...makePosition().entry, ts: '2026-09-15T10:00:00.000Z' } });
  return flattenPositionsToTradeEvents([p1, p2, p3, pOpen]);
}

test('filterTradeEvents: no filters returns everything', () => {
  const evs = sampleEvents();
  const out = filterTradeEvents(evs);
  assert.equal(out.length, evs.length);
});

test('filterTradeEvents: eventKind=entry drops exits', () => {
  const evs = sampleEvents();
  const out = filterTradeEvents(evs, { eventKind: 'entry' });
  assert.equal(out.length, evs.filter((e) => e.kind === 'entry').length);
  assert.ok(out.every((e) => e.kind === 'entry'));
});

test('filterTradeEvents: eventKind=exit drops entries', () => {
  const evs = sampleEvents();
  const out = filterTradeEvents(evs, { eventKind: 'exit' });
  assert.equal(out.length, evs.filter((e) => e.kind === 'exit').length);
});

test('filterTradeEvents: tokenId scopes to one token', () => {
  const evs = sampleEvents();
  const tokenId = 'aa'.padEnd(64, 'a');
  const out = filterTradeEvents(evs, { tokenId });
  assert.ok(out.every((e) => e.token_id === tokenId));
  assert.equal(out.length, 2);
});

test('filterTradeEvents: side filter', () => {
  const evs = sampleEvents();
  const out = filterTradeEvents(evs, { side: 'short_token' });
  assert.ok(out.every((e) => e.side === 'short_token'));
  assert.equal(out.length, 2); // entry + exit of CCC
});

test('filterTradeEvents: pnl=gain drops losses and entries', () => {
  const evs = sampleEvents();
  const out = filterTradeEvents(evs, { pnl: 'gain' });
  assert.equal(out.length, 1);
  assert.equal(out[0].pnl_sign, 'gain');
});

test('filterTradeEvents: pnl=loss drops gains and entries', () => {
  const evs = sampleEvents();
  const out = filterTradeEvents(evs, { pnl: 'loss' });
  assert.equal(out.length, 1);
  assert.equal(out[0].pnl_sign, 'loss');
});

test('filterTradeEvents: pnl=flat matches only the zero-pnl exit', () => {
  const evs = sampleEvents();
  const out = filterTradeEvents(evs, { pnl: 'flat' });
  assert.equal(out.length, 1);
  assert.equal(out[0].pnl_sign, 'flat');
});

test('filterTradeEvents: sinceMs filters by event.ts', () => {
  const evs = sampleEvents();
  const sinceMs = Date.parse('2026-09-10T00:00:00.000Z');
  const out = filterTradeEvents(evs, { sinceMs });
  // Only the 2026-09-10 and 2026-09-15 events should remain
  assert.ok(out.every((e) => Date.parse(e.ts) >= sinceMs));
  assert.ok(out.length >= 2);
});

test('filterTradeEvents: untilMs filters by event.ts', () => {
  const evs = sampleEvents();
  const untilMs = Date.parse('2026-09-05T23:59:59.000Z');
  const out = filterTradeEvents(evs, { untilMs });
  assert.ok(out.every((e) => Date.parse(e.ts) <= untilMs));
  assert.ok(out.length <= 4);
});

test('filterTradeEvents: limit caps result size (newest-first)', () => {
  const evs = sampleEvents();
  const out = filterTradeEvents(evs, { limit: 3 });
  assert.equal(out.length, 3);
  // Newest first → first row is from 2026-09-15
  assert.ok(Date.parse(out[0].ts) >= Date.parse(out[1].ts));
});

test('filterTradeEvents: combined filters compose', () => {
  const evs = sampleEvents();
  const out = filterTradeEvents(evs, {
    eventKind: 'exit',
    pnl: 'gain',
    side: 'long_token',
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].pnl_sign, 'gain');
  assert.equal(out[0].kind, 'exit');
});

test('filterTradeEvents: invalid input → empty array', () => {
  assert.deepEqual(filterTradeEvents(null), []);
  assert.deepEqual(filterTradeEvents(undefined), []);
});

// ─────────────────────────────────────────────────────────────────────
//  parseTradeHistoryFilters
// ─────────────────────────────────────────────────────────────────────

const FIXED_NOW_MS = Date.parse('2026-09-16T17:00:00.000Z');

test('parseTradeHistoryFilters: defaults when no params', () => {
  const qs = new URLSearchParams();
  const out = parseTradeHistoryFilters(qs, { defaultRange: '30d', maxEvents: 1000, clock: () => FIXED_NOW_MS });
  assert.equal(out.range, '30d');
  assert.equal(out.eventKind, 'any');
  assert.equal(out.side, null);
  assert.equal(out.tokenId, null);
  assert.equal(out.pnl, 'any');
  assert.equal(out.limit, 1000);
  assert.equal(out.sinceMs, FIXED_NOW_MS - rangeToMs('30d'));
  assert.equal(out.untilMs, null);
});

test('parseTradeHistoryFilters: explicit query params', () => {
  const qs = new URLSearchParams({
    range: '7d',
    until: '24h',
    event_kind: 'exit',
    side: 'long_token',
    pnl: 'gain',
    token_id: 'ff'.padEnd(64, 'f'),
    limit: '50',
  });
  const out = parseTradeHistoryFilters(qs, { defaultRange: '30d', maxEvents: 1000, clock: () => FIXED_NOW_MS });
  assert.equal(out.range, '7d');
  assert.equal(out.untilMs, FIXED_NOW_MS - rangeToMs('24h'));
  assert.equal(out.eventKind, 'exit');
  assert.equal(out.side, 'long_token');
  assert.equal(out.pnl, 'gain');
  assert.equal(out.tokenId, 'ff'.padEnd(64, 'f'));
  assert.equal(out.limit, 50);
});

test('parseTradeHistoryFilters: range=all → sinceMs null', () => {
  const qs = new URLSearchParams({ range: 'all' });
  const out = parseTradeHistoryFilters(qs, { defaultRange: '30d', maxEvents: 1000, clock: () => FIXED_NOW_MS });
  assert.equal(out.range, 'all');
  assert.equal(out.sinceMs, null);
});

test('parseTradeHistoryFilters: unknown event_kind → falls back to any', () => {
  const qs = new URLSearchParams({ event_kind: 'banana' });
  const out = parseTradeHistoryFilters(qs, { defaultRange: '30d', maxEvents: 1000, clock: () => FIXED_NOW_MS });
  assert.equal(out.eventKind, 'any');
});

test('parseTradeHistoryFilters: unknown pnl → any', () => {
  const qs = new URLSearchParams({ pnl: '?' });
  const out = parseTradeHistoryFilters(qs, { defaultRange: '30d', maxEvents: 1000, clock: () => FIXED_NOW_MS });
  assert.equal(out.pnl, 'any');
});

test('parseTradeHistoryFilters: invalid range string uses default', () => {
  const qs = new URLSearchParams({ range: 'banana' });
  const out = parseTradeHistoryFilters(qs, { defaultRange: '7d', maxEvents: 1000, clock: () => FIXED_NOW_MS });
  assert.equal(out.range, '7d');
});

test('parseTradeHistoryFilters: plain object qs (not URLSearchParams)', () => {
  const out = parseTradeHistoryFilters(
    { range: '24h', event_kind: 'entry', pnl: 'loss' },
    { defaultRange: '30d', maxEvents: 500, clock: () => FIXED_NOW_MS },
  );
  assert.equal(out.range, '24h');
  assert.equal(out.sinceMs, FIXED_NOW_MS - rangeToMs('24h'));
  assert.equal(out.eventKind, 'entry');
  assert.equal(out.pnl, 'loss');
  assert.equal(out.limit, 500);
});

test('parseTradeHistoryFilters: limit cap applied at maxEvents', () => {
  const qs = new URLSearchParams({ limit: '999999' });
  const out = parseTradeHistoryFilters(qs, { defaultRange: '30d', maxEvents: 100, clock: () => FIXED_NOW_MS });
  assert.equal(out.limit, 100);
});

// ─────────────────────────────────────────────────────────────────────
//  Handler route integration (mock ctx + supertest-free)
// ─────────────────────────────────────────────────────────────────────

test('listTradeHistory route integration: open+closed positions flatten + filter by gain', async () => {
  const positions = {
    open:  [makePosition({ id: 'p_open', status: 'open', exit: null, entry: { ...makePosition().entry, ts: '2026-09-15T10:00:00.000Z' } })],
    closed: [
      makePosition({
        id: 'p_gain',
        entry: { ...makePosition().entry, ts: '2026-09-10T10:00:00.000Z' },
        exit: { ...makePosition().exit, ts: '2026-09-10T11:00:00.000Z', realized_pnl_sats: 10000, reason: 'take_profit' },
      }),
      makePosition({
        id: 'p_loss',
        entry: { ...makePosition().entry, ts: '2026-09-05T10:00:00.000Z' },
        exit: { ...makePosition().exit, ts: '2026-09-05T11:00:00.000Z', realized_pnl_sats: -2000, reason: 'stop_loss' },
      }),
    ],
  };
  const positionsList = {
    async list(bucket) {
      if (bucket === 'open') return positions.open;
      if (bucket === 'closed') return positions.closed;
      return [];
    },
  };
  const handler = makeHandler({ positions: positionsList });
  const all = await getJson(handler, '/api/trade-history?range=all');
  assert.equal(all.schema, 'tradebot.dashboard.trade-history/v1');
  assert.equal(all.total_count, 5); // 1 open (entry) + 2 closed (entry+exit each) = 5
  const gains = await getJson(handler, '/api/trade-history?range=all&event_kind=exit&pnl=gain');
  assert.equal(gains.count, 1);
  assert.equal(gains.events[0].pnl_sign, 'gain');
  const losses = await getJson(handler, '/api/trade-history?range=all&event_kind=exit&pnl=loss');
  assert.equal(losses.count, 1);
  assert.equal(losses.events[0].pnl_sign, 'loss');
});

test('listTradeHistory route: since/until windowing via injected clock', async () => {
  const positionsList = {
    async list(bucket) {
      if (bucket === 'open') return [];
      if (bucket === 'closed') return [
        makePosition({
          id: 'old',
          entry: { ...makePosition().entry, ts: '2026-08-01T10:00:00.000Z' },
          exit: { ...makePosition().exit, ts: '2026-08-01T11:00:00.000Z', realized_pnl_sats: 100 },
        }),
        makePosition({
          id: 'new',
          entry: { ...makePosition().entry, ts: '2026-09-10T10:00:00.000Z' },
          exit: { ...makePosition().exit, ts: '2026-09-10T11:00:00.000Z', realized_pnl_sats: 200 },
        }),
      ];
      return [];
    },
  };
  const frozen = Date.parse('2026-09-16T12:00:00.000Z');
  const handler = makeHandler({ positions: positionsList, clock: () => frozen });
  const out = await getJson(handler, '/api/trade-history?range=7d');
  assert.equal(out.count, 2); // entry+exit of "new"
  assert.equal(out.events[0].position_id, 'new');
});

// ─────────────────────────────────────────────────────────────────────
//  helpers
// ─────────────────────────────────────────────────────────────────────

function makeHandler({ positions, clock } = {}) {
  const cfg = { dashboard: { trade_history_default_range: '30d', trade_history_max_events: 100 } };
  const noopHistory = { async read() { return { events: [], errors: [] }; } };
  const noopSnapshots = { async readBack() { return { records: [], errors: [] }; } };
  const serverOpts = {
    cfg,
    positions: positions || { async list() { return []; } },
    snapshots: noopSnapshots,
    historyReader: noopHistory,
  };
  if (typeof clock === 'function') serverOpts.clock = clock;
  const server = createDashboardServer(serverOpts);
  return server.handler;
}

async function getJson(handler, path) {
  const res = await supertest(handler).get(path);
  assert.equal(res.status, 200, `GET ${path} → ${res.status}: ${res.text}`);
  return res.body;
}
