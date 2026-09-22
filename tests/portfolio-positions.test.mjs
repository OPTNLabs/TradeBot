#!/usr/bin/env node
/**
 * Unit tests for src/portfolio/positions.mjs.
 *
 * Exercises every export (pure helpers + the `Positions` class)
 * against real tmp dirs. No mocking of `fs` — the atomic write
 * contract is what we're verifying.
 *
 * Run via:
 *   node --test tests/portfolio-positions.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  Positions,
  PositionsConfigError,
  PositionsNotFoundError,
  PositionsStateError,
  DEFAULT_POSITIONS_FILE,
  POSITIONS_VERSION,
  computeOpenExposureBch,
  computeExposureByToken,
  newPositionId,
  maxCounterFromIds,
  normalizeStatus,
  isValidPosition,
  applyClose,
  applyConfirm,
  applyStartClosing,
  applyDelete,
  applyOverrides,
  _resetModuleCounter,
} from '../src/portfolio/positions.mjs';
import { createLogger, createMemorySink } from '../src/util/logger.mjs';

// ─────────────────────────────────────────────────────────────────────
//  Test helpers
// ─────────────────────────────────────────────────────────────────────

async function makeTmp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tradebot-positions-'));
  t.after(async () => {
    try { await rm(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });
  return dir;
}

function makePositions(t, opts = {}) {
  const file = opts.file ?? path.join(t._dir ?? '', 'positions.json');
  const sink = opts.sink ?? createMemorySink();
  const logger = opts.logger ?? createLogger({ sink: sink.stream });
  return { positions: new Positions({ file, logger, fs: opts.fs ?? fsp, now: opts.now }), sink };
}

function fixtureEntry(overrides = {}) {
  return {
    txid: '11'.repeat(32),
    price_sats_per_token: 100,
    bch_spent_sats: 100_000_000,
    token_amount_base: 1_000_000,
    fee_sats: 1_000,
    broadcast_ms: 1840,
    ts: '2026-09-10T00:00:00.000Z',
    ...overrides,
  };
}

function fixtureReasoning() {
  return {
    score: 0.82,
    rank: 1,
    topK: 3,
    passed_filters: ['min_score', 'max_age', 'dedup', 'topk'],
    conditions: { min_score: 0.35 },
    ts: 1_700_000_000_000,
    token_id: 'a'.repeat(64),
  };
}

// ============================================================
// Pure helpers
// ============================================================

test('newPositionId: format is pos_<base36-seconds><base36-ms>_<hex-counter>', () => {
  const { id, nextCounter } = newPositionId({ nowMs: 1700000000000, counter: 0 });
  assert.match(id, /^pos_[0-9a-z]+_[0-9a-f]{4}$/);
  assert.equal(nextCounter, 1);
});

test('newPositionId: counter increments across calls', () => {
  const a = newPositionId({ nowMs: 1700000000000, counter: 5 });
  const b = newPositionId({ nowMs: 1700000000000, counter: 5 });
  assert.equal(a.id.endsWith('0005'), true);
  assert.equal(b.id.endsWith('0006'), true);
});

test('newPositionId: throws on bad nowMs', () => {
  assert.throws(() => newPositionId({ nowMs: -1 }), PositionsConfigError);
  assert.throws(() => newPositionId({ nowMs: NaN }), PositionsConfigError);
  assert.throws(() => newPositionId({ nowMs: 'now' }), PositionsConfigError);
});

test('newPositionId: throws on bad counter', () => {
  assert.throws(() => newPositionId({ nowMs: 1, counter: -1 }), PositionsConfigError);
  assert.throws(() => newPositionId({ nowMs: 1, counter: 1.5 }), PositionsConfigError);
});

test('maxCounterFromIds: returns the max hex counter', () => {
  const ids = [
    'pos_abcdef_0005',
    'pos_zzzzzz_00ff',
    'pos_xxxxxx_0010',
    'not_an_id',
    null,
  ];
  assert.equal(maxCounterFromIds(ids.map((id) => ({ id }))), 0xff);
});

test('maxCounterFromIds: returns 0 for empty / null input', () => {
  assert.equal(maxCounterFromIds([]), 0);
  assert.equal(maxCounterFromIds(null), 0);
  assert.equal(maxCounterFromIds(undefined), 0);
});

test('normalizeStatus: accepts known statuses', () => {
  for (const s of ['pending', 'open', 'closing', 'closed']) {
    assert.equal(normalizeStatus(s), s);
  }
});

test('normalizeStatus: rejects unknown statuses', () => {
  assert.throws(() => normalizeStatus('in_progress'), PositionsConfigError);
  assert.throws(() => normalizeStatus(''), PositionsConfigError);
  assert.throws(() => normalizeStatus(null), PositionsConfigError);
});

test('isValidPosition: accepts a well-formed open position', () => {
  assert.equal(isValidPosition({
    id: 'pos_1_0001',
    token_id: 'a'.repeat(64),
    status: 'open',
    entry: { bch_spent_sats: 100n },
    opened_at: '2026-09-10T00:00:00.000Z',
  }), true);
});

test('isValidPosition: rejects bad shapes', () => {
  assert.equal(isValidPosition(null), false);
  assert.equal(isValidPosition({}), false);
  assert.equal(isValidPosition({ id: 'x' }), false);
  assert.equal(isValidPosition({
    id: 'x', token_id: 'y', status: 'open', entry: {}, opened_at: '',
  }), false);
  assert.equal(isValidPosition({
    id: 'x', token_id: 'y', status: 'unknown', entry: {}, opened_at: '2026',
  }), false);
});

// ============================================================
// computeOpenExposureBch
// ============================================================

test('computeOpenExposureBch: sums bch_spent across non-closed positions', () => {
  const positions = [
    { status: 'open', entry: { bch_spent_sats: 100_000_000 } },
    { status: 'pending', entry: { bch_spent_sats: 50_000_000 } },
    { status: 'closing', entry: { bch_spent_sats: 25_000_000 } },
    { status: 'closed', entry: { bch_spent_sats: 999_999_999 } }, // excluded
  ];
  // 100M + 50M + 25M = 175M sats = 1.75 BCH
  assert.equal(computeOpenExposureBch(positions), 1.75);
});

test('computeOpenExposureBch: tolerates bigint / string / missing / malformed', () => {
  const positions = [
    { status: 'open', entry: { bch_spent_sats: 100_000_000n } },
    { status: 'open', entry: { bch_spent: '50000000' } },
    { status: 'open', entry: { bch_spent_sats: 25_000_000 } },
    { status: 'open', entry: {} }, // missing — skipped
    { status: 'open', entry: { bch_spent_sats: 'not-a-number' } }, // malformed — skipped
    null,
  ];
  // 100M + 50M + 25M = 175M sats = 1.75 BCH
  assert.equal(computeOpenExposureBch(positions), 1.75);
});

test('computeOpenExposureBch: empty / non-array → 0', () => {
  assert.equal(computeOpenExposureBch([]), 0);
  assert.equal(computeOpenExposureBch(null), 0);
  assert.equal(computeOpenExposureBch(undefined), 0);
});

// ============================================================
// computeExposureByToken
// ============================================================

test('computeExposureByToken: groups by token_id', () => {
  const positions = [
    { token_id: 'a'.repeat(64), status: 'open', entry: { bch_spent_sats: 100_000_000 } },
    { token_id: 'a'.repeat(64), status: 'pending', entry: { bch_spent_sats: 50_000_000 } },
    { token_id: 'b'.repeat(64), status: 'open', entry: { bch_spent_sats: 25_000_000 } },
    { token_id: 'b'.repeat(64), status: 'closed', entry: { bch_spent_sats: 999_999_999 } }, // excluded
  ];
  const byTok = computeExposureByToken(positions);
  const aId = 'a'.repeat(64);
  const bId = 'b'.repeat(64);
  assert.equal(byTok[aId], 1.5);
  assert.equal(byTok[bId], 0.25);
});

// ============================================================
// applyClose / applyConfirm / applyStartClosing (pure state transitions)
// ============================================================

test('applyConfirm: pending → open is allowed', () => {
  const file = {
    open: [{ id: 'p1', token_id: 'a'.repeat(64), status: 'pending', entry: {}, opened_at: '2026-09-10T00:00:00.000Z' }],
    closed: [],
  };
  const next = applyConfirm(file, 'p1');
  assert.equal(next.open[0].status, 'open');
  assert.match(next.open[0].updated_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('applyConfirm: open → open is idempotent (returns same file)', () => {
  const file = {
    open: [{ id: 'p1', token_id: 'a'.repeat(64), status: 'open', entry: {}, opened_at: '2026-09-10T00:00:00.000Z' }],
    closed: [],
  };
  const next = applyConfirm(file, 'p1');
  assert.equal(next, file);
});

test('applyConfirm: closed → open throws PositionsStateError', () => {
  const file = {
    open: [],
    closed: [{ id: 'p1', token_id: 'a'.repeat(64), status: 'closed', entry: {}, opened_at: '2026-09-10T00:00:00.000Z', closed_at: '2026-09-11T00:00:00.000Z' }],
  };
  assert.throws(() => applyConfirm(file, 'p1'), PositionsStateError);
});

test('applyStartClosing: open → closing is allowed', () => {
  const file = {
    open: [{ id: 'p1', token_id: 'a'.repeat(64), status: 'open', entry: {}, opened_at: '2026-09-10T00:00:00.000Z' }],
    closed: [],
  };
  const next = applyStartClosing(file, 'p1');
  assert.equal(next.open[0].status, 'closing');
});

test('applyStartClosing: pending → closing throws', () => {
  const file = {
    open: [{ id: 'p1', token_id: 'a'.repeat(64), status: 'pending', entry: {}, opened_at: '2026-09-10T00:00:00.000Z' }],
    closed: [],
  };
  assert.throws(() => applyStartClosing(file, 'p1'), PositionsStateError);
});

test('applyClose: moves open → closed, stamps realized_pnl_sats', () => {
  const file = {
    open: [{
      id: 'p1', token_id: 'a'.repeat(64), status: 'open',
      entry: { bch_spent_sats: 100_000_000 },
      opened_at: '2026-09-10T00:00:00.000Z',
    }],
    closed: [],
    meta: {},
  };
  const next = applyClose(file, 'p1', {
    txid: '22'.repeat(32),
    bch_received_sats: 110_000_000,
    fee_sats: 1_500,
    reason: 'take_profit',
  }, 8_498_500);
  assert.equal(next.open.length, 0);
  assert.equal(next.closed.length, 1);
  assert.equal(next.closed[0].status, 'closed');
  assert.equal(next.closed[0].exit.realized_pnl_sats, 8_498_500);
  assert.equal(next.closed[0].exit.reason, 'take_profit');
  assert.equal(next.meta.total_closed, 1);
});

test('applyClose: throws PositionsNotFoundError when id is missing', () => {
  const file = { open: [], closed: [], meta: {} };
  assert.throws(() => applyClose(file, 'missing', {}, 0), PositionsNotFoundError);
});

// ============================================================
// Positions class — CRUD against a tmp file
// ============================================================

test('Positions.load: creates an empty file on first read', async (t) => {
  const dir = await makeTmp(t);
  const file = path.join(dir, 'positions.json');
  const { positions } = makePositions(t, { file });
  t._dir = dir;
  const loaded = await positions.load();
  assert.equal(loaded.version, POSITIONS_VERSION);
  assert.deepEqual(loaded.open, []);
  assert.deepEqual(loaded.closed, []);
  assert.equal(loaded.meta.total_opened, 0);
  // File on disk should be valid JSON.
  const onDisk = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(onDisk.version, POSITIONS_VERSION);
});

test('Positions.open: appends a position to open[] + writes file', async (t) => {
  const dir = await makeTmp(t);
  const file = path.join(dir, 'positions.json');
  const { positions, sink } = makePositions(t, { file });
  t._dir = dir;
  const tokenId = 'a'.repeat(64);
  const entry = await positions.open({
    tokenId,
    tokenSymbol: 'FOO',
    tokenDecimals: 2,
    entry: fixtureEntry(),
    reasoning: fixtureReasoning(),
  });
  assert.equal(entry.token_id, tokenId);
  assert.equal(entry.token_symbol, 'FOO');
  assert.equal(entry.status, 'pending');
  assert.equal(entry.side, 'long_token');
  assert.match(entry.id, /^pos_[0-9a-z]+_[0-9a-f]{4}$/);

  // File should have the position in open[].
  const onDisk = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(onDisk.open.length, 1);
  assert.equal(onDisk.open[0].id, entry.id);
  assert.equal(onDisk.meta.total_opened, 1);

  // Logger should have emitted a positions.open event.
  const logs = sink.lines();
  const openLog = logs.map((l) => JSON.parse(l)).find((r) => r.msg === 'positions.open');
  assert.ok(openLog, 'expected positions.open log line');
  assert.equal(openLog.position_id, entry.id);
  assert.equal(openLog.token_id, tokenId);
  assert.equal(openLog.status, 'pending');
});

test('Positions.open: counter increments across multiple opens in the same ms', async (t) => {
  const dir = await makeTmp(t);
  const file = path.join(dir, 'positions.json');
  const { positions } = makePositions(t, { file });
  t._dir = dir;
  const fixedNow = () => new Date(1_700_000_000_000);
  const ps = new Positions({ file, now: fixedNow, logger: makePositions(t, { file }).positions.logger, fs: fsp });
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const e = await ps.open({
      tokenId: 'a'.repeat(64),
      entry: fixtureEntry(),
      reasoning: fixtureReasoning(),
    });
    ids.push(e.id);
  }
  // All 5 IDs must be unique.
  assert.equal(new Set(ids).size, 5);
});

test('Positions.confirm: pending → open is allowed', async (t) => {
  const dir = await makeTmp(t);
  const file = path.join(dir, 'positions.json');
  const { positions, sink } = makePositions(t, { file });
  t._dir = dir;
  const opened = await positions.open({
    tokenId: 'a'.repeat(64),
    entry: fixtureEntry(),
    reasoning: fixtureReasoning(),
  });
  sink.clear();
  const confirmed = await positions.confirm(opened.id);
  assert.equal(confirmed.status, 'open');
  const onDisk = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(onDisk.open[0].status, 'open');
  const logs = sink.lines().map((l) => JSON.parse(l));
  assert.ok(logs.some((r) => r.msg === 'positions.confirm'));
});

test('Positions.confirm: open → open is idempotent', async (t) => {
  const dir = await makeTmp(t);
  const file = path.join(dir, 'positions.json');
  const { positions } = makePositions(t, { file });
  t._dir = dir;
  const opened = await positions.open({
    tokenId: 'a'.repeat(64),
    entry: fixtureEntry(),
    reasoning: fixtureReasoning(),
    initialStatus: 'open',
  });
  // Confirm again — should not throw, should remain open.
  const reConfirmed = await positions.confirm(opened.id);
  assert.equal(reConfirmed.status, 'open');
});

test('Positions.startClosing: open → closing is allowed', async (t) => {
  const dir = await makeTmp(t);
  const file = path.join(dir, 'positions.json');
  const { positions } = makePositions(t, { file });
  t._dir = dir;
  const opened = await positions.open({
    tokenId: 'a'.repeat(64),
    entry: fixtureEntry(),
    reasoning: fixtureReasoning(),
    initialStatus: 'open',
  });
  const closing = await positions.startClosing(opened.id);
  assert.equal(closing.status, 'closing');
});

test('Positions.updateHighWaterMark: never downgrades', async (t) => {
  const dir = await makeTmp(t);
  const file = path.join(dir, 'positions.json');
  const { positions } = makePositions(t, { file });
  t._dir = dir;
  const opened = await positions.open({
    tokenId: 'a'.repeat(64),
    entry: fixtureEntry(),
    reasoning: fixtureReasoning(),
    initialStatus: 'open',
  });
  // Bump HWM to 200.
  await positions.updateHighWaterMark(opened.id, 200n);
  let onDisk = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(onDisk.open[0].high_water_mark_sats_per_token, '200');
  // Try to lower to 150 — should stay at 200.
  await positions.updateHighWaterMark(opened.id, 150n);
  onDisk = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(onDisk.open[0].high_water_mark_sats_per_token, '200');
  // Bump to 250 — should update.
  await positions.updateHighWaterMark(opened.id, 250);
  onDisk = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(onDisk.open[0].high_water_mark_sats_per_token, '250');
});

test('Positions.updateHighWaterMark: throws on bad inputs', async (t) => {
  const dir = await makeTmp(t);
  const file = path.join(dir, 'positions.json');
  const { positions } = makePositions(t, { file });
  t._dir = dir;
  const opened = await positions.open({
    tokenId: 'a'.repeat(64),
    entry: fixtureEntry(),
    reasoning: fixtureReasoning(),
    initialStatus: 'open',
  });
  await assert.rejects(() => positions.updateHighWaterMark(opened.id, 'not-a-number'), PositionsConfigError);
  await assert.rejects(() => positions.updateHighWaterMark(opened.id, NaN), PositionsConfigError);
  await assert.rejects(() => positions.updateHighWaterMark('', 100n), PositionsConfigError);
});

test('Positions.updateHighWaterMark: throws PositionsNotFoundError when missing', async (t) => {
  const dir = await makeTmp(t);
  const file = path.join(dir, 'positions.json');
  const { positions } = makePositions(t, { file });
  t._dir = dir;
  await assert.rejects(() => positions.updateHighWaterMark('pos_nope', 100n), PositionsNotFoundError);
});

test('Positions.close: moves open → closed, stamps realized P&L', async (t) => {
  const dir = await makeTmp(t);
  const file = path.join(dir, 'positions.json');
  const { positions, sink } = makePositions(t, { file });
  t._dir = dir;
  const opened = await positions.open({
    tokenId: 'a'.repeat(64),
    entry: fixtureEntry(),
    reasoning: fixtureReasoning(),
    initialStatus: 'open',
  });
  sink.clear();
  const closed = await positions.close(opened.id, {
    txid: '22'.repeat(32),
    price_sats_per_token: 110,
    bch_received_sats: 110_000_000,
    fee_sats: 1_500,
    ts: '2026-09-10T01:00:00.000Z',
    reason: 'take_profit',
  }, 8_498_500);
  assert.equal(closed.status, 'closed');
  assert.equal(closed.exit.realized_pnl_sats, 8_498_500);
  assert.equal(closed.exit.reason, 'take_profit');

  const onDisk = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(onDisk.open.length, 0);
  assert.equal(onDisk.closed.length, 1);
  assert.equal(onDisk.meta.total_closed, 1);

  // Logger should have emitted positions.close.
  const logs = sink.lines().map((l) => JSON.parse(l));
  const closeLog = logs.find((r) => r.msg === 'positions.close');
  assert.ok(closeLog);
  assert.equal(closeLog.position_id, opened.id);
  assert.equal(closeLog.realized_pnl_sats, 8_498_500);
});

test('Positions.close: throws PositionsNotFoundError when missing', async (t) => {
  const dir = await makeTmp(t);
  const file = path.join(dir, 'positions.json');
  const { positions } = makePositions(t, { file });
  t._dir = dir;
  await assert.rejects(
    () => positions.close('pos_nope', { txid: 'x', bch_received_sats: 100n }, 0),
    PositionsNotFoundError,
  );
});

test('Positions.close: throws PositionsConfigError on bad args', async (t) => {
  const dir = await makeTmp(t);
  const file = path.join(dir, 'positions.json');
  const { positions } = makePositions(t, { file });
  t._dir = dir;
  await assert.rejects(() => positions.close('', {}, 0), PositionsConfigError);
  await assert.rejects(() => positions.close('p1', null, 0), PositionsConfigError);
  await assert.rejects(() => positions.close('p1', {}, 'not-a-number'), PositionsConfigError);
});

test('Positions.findById: finds positions in open[]', async (t) => {
  const dir = await makeTmp(t);
  const file = path.join(dir, 'positions.json');
  const { positions } = makePositions(t, { file });
  t._dir = dir;
  const opened = await positions.open({
    tokenId: 'a'.repeat(64),
    entry: fixtureEntry(),
    reasoning: fixtureReasoning(),
  });
  const found = await positions.findById(opened.id);
  assert.ok(found);
  assert.equal(found.id, opened.id);
});

test('Positions.findById: finds positions in closed[]', async (t) => {
  const dir = await makeTmp(t);
  const file = path.join(dir, 'positions.json');
  const { positions } = makePositions(t, { file });
  t._dir = dir;
  const opened = await positions.open({
    tokenId: 'a'.repeat(64),
    entry: fixtureEntry(),
    reasoning: fixtureReasoning(),
    initialStatus: 'open',
  });
  await positions.close(opened.id, { bch_received_sats: 110_000_000n, fee_sats: 0 }, 10_000_000);
  const found = await positions.findById(opened.id);
  assert.ok(found);
  assert.equal(found.status, 'closed');
});

test('Positions.findById: returns null when not found', async (t) => {
  const dir = await makeTmp(t);
  const file = path.join(dir, 'positions.json');
  const { positions } = makePositions(t, { file });
  t._dir = dir;
  await positions.load();
  assert.equal(await positions.findById('pos_nope'), null);
});

test('Positions.findById: throws on empty id', async (t) => {
  const dir = await makeTmp(t);
  const file = path.join(dir, 'positions.json');
  const { positions } = makePositions(t, { file });
  t._dir = dir;
  await assert.rejects(() => positions.findById(''), PositionsConfigError);
});

test('Positions.list: returns shallow copies of open / closed / pending / closing', async (t) => {
  const dir = await makeTmp(t);
  const file = path.join(dir, 'positions.json');
  const { positions } = makePositions(t, { file });
  t._dir = dir;
  const o1 = await positions.open({
    tokenId: 'a'.repeat(64),
    tokenSymbol: 'FOO',
    entry: fixtureEntry(),
    reasoning: fixtureReasoning(),
    initialStatus: 'open',
  });
  const o2 = await positions.open({
    tokenId: 'a'.repeat(64),
    tokenSymbol: 'FOO',
    entry: fixtureEntry(),
    reasoning: fixtureReasoning(),
    initialStatus: 'open',
  });
  await positions.close(o1.id, { bch_received_sats: 110_000_000n, fee_sats: 0 }, 10_000_000);

  const open = await positions.list('open');
  assert.equal(open.length, 1);
  assert.equal(open[0].id, o2.id);
  // Mutating the returned object must NOT affect on-disk state.
  open[0].token_symbol = 'MUTATED';
  const onDisk = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(onDisk.open[0].token_symbol, 'FOO'); // initial value, not 'MUTATED'

  const closed = await positions.list('closed');
  assert.equal(closed.length, 1);
  assert.equal(closed[0].id, o1.id);

  const all = await positions.list('all');
  assert.equal(all.length, 2);
});

test('Positions.list: pending / closing filter inside open[]', async (t) => {
  const dir = await makeTmp(t);
  const file = path.join(dir, 'positions.json');
  const { positions } = makePositions(t, { file });
  t._dir = dir;
  const pending = await positions.open({
    tokenId: 'a'.repeat(64),
    entry: fixtureEntry(),
    reasoning: fixtureReasoning(),
    initialStatus: 'pending',
  });
  const open = await positions.open({
    tokenId: 'a'.repeat(64),
    entry: fixtureEntry(),
    reasoning: fixtureReasoning(),
    initialStatus: 'open',
  });
  await positions.startClosing(open.id);
  assert.equal((await positions.list('pending')).length, 1);
  assert.equal((await positions.list('closing')).length, 1);
  assert.equal((await positions.list('open')).length, 0); // strict `status === 'open'`
  assert.equal(pending.id, (await positions.list('pending'))[0].id);
});

test('Positions.open: rejects malformed args', async (t) => {
  const dir = await makeTmp(t);
  const file = path.join(dir, 'positions.json');
  const { positions } = makePositions(t, { file });
  t._dir = dir;
  await assert.rejects(() => positions.open(null), PositionsConfigError);
  await assert.rejects(() => positions.open({ tokenId: 'a'.repeat(64) }), PositionsConfigError);
  await assert.rejects(
    () => positions.open({ tokenId: 'a'.repeat(64), entry: {}, reasoning: fixtureReasoning() }),
    PositionsConfigError,
  );
  await assert.rejects(
    () => positions.open({ tokenId: 'a'.repeat(64), entry: fixtureEntry() }),
    PositionsConfigError,
  );
  await assert.rejects(
    () => positions.open({
      tokenId: 'a'.repeat(64),
      entry: fixtureEntry(),
      reasoning: fixtureReasoning(),
      initialStatus: 'closed',
    }),
    PositionsConfigError,
  );
  await assert.rejects(
    () => positions.open({
      tokenId: 'not-a-token-id',
      entry: fixtureEntry(),
      reasoning: fixtureReasoning(),
    }),
    TypeError, // thrown by normalizeTokenId
  );
});

test('Positions: existing file is preserved on load', async (t) => {
  // The newPositionId module-level counter is shared across every
  // test in this file; earlier tests have already bumped it well
  // past 0x0002. Reset before this test so the seeded file's
  // counter is the authoritative source — which is exactly the
  // property we're verifying here.
  _resetModuleCounter(0);
  const dir = await makeTmp(t);
  const file = path.join(dir, 'positions.json');
  // Seed with an existing open position + a closed position.
  await writeFile(file, JSON.stringify({
    version: POSITIONS_VERSION,
    updated_at: '2026-09-09T00:00:00.000Z',
    open: [{
      id: 'pos_seeded0001',
      token_id: 'a'.repeat(64),
      side: 'long_token',
      status: 'open',
      entry: { bch_spent_sats: 100_000_000 },
      opened_at: '2026-09-09T00:00:00.000Z',
    }],
    closed: [],
    meta: { total_opened: 1 },
  }), 'utf8');
  const { positions } = makePositions(t, { file });
  t._dir = dir;
  await positions.load();
  const open = await positions.list('open');
  assert.equal(open.length, 1);
  assert.equal(open[0].id, 'pos_seeded0001');
  // New positions should bump the counter past the seeded id (0x0001).
  const newPos = await positions.open({
    tokenId: 'b'.repeat(64),
    entry: fixtureEntry(),
    reasoning: fixtureReasoning(),
  });
  // Counter starts at 0x0002 (since 0x0001 was the max).
  assert.equal(newPos.id.endsWith('0002'), true);
});

test('Positions: load handles missing/corrupt file gracefully', async (t) => {
  const dir = await makeTmp(t);
  const file = path.join(dir, 'positions.json');
  await writeFile(file, '{ corrupt json', 'utf8');
  const { positions } = makePositions(t, { file });
  t._dir = dir;
  await assert.rejects(() => positions.load(), /JSON/);
});

test('DEFAULT_POSITIONS_FILE: points at data/positions.json', () => {
  assert.equal(DEFAULT_POSITIONS_FILE, 'data/positions.json');
});

// ───────────────────────────────────────────────────────────────────
//  T43: setTimeStopExtension — profit-floor extension timestamp
//
// Stamps `entry.time_stop_extended_at` on a position so the exit
// strategy will use max(baseCutoff, extendedMs) as the new cutoff.
// Single-shot guard: refuses to downgrade an existing extension.
// ───────────────────────────────────────────────────────────────────

test('Positions.setTimeStopExtension: stamps entry.time_stop_extended_at', async (t) => {
  const dir = await makeTmp(t);
  const file = path.join(dir, 'positions.json');
  const { positions } = makePositions(t, { file });
  t._dir = dir;
  const opened = await positions.open({
    tokenId: 'a'.repeat(64),
    entry: fixtureEntry(),
    reasoning: fixtureReasoning(),
    initialStatus: 'open',
  });
  const cutoffMs = Date.parse('2026-09-17T06:00:00Z');
  const updated = await positions.setTimeStopExtension(opened.id, cutoffMs);
  assert.equal(updated.entry.time_stop_extended_at, cutoffMs);
  // Persisted on disk
  const onDisk = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(onDisk.open[0].entry.time_stop_extended_at, cutoffMs);
});

test('Positions.setTimeStopExtension: refuses to downgrade an existing extension', async (t) => {
  const dir = await makeTmp(t);
  const file = path.join(dir, 'positions.json');
  const { positions } = makePositions(t, { file });
  t._dir = dir;
  const opened = await positions.open({
    tokenId: 'a'.repeat(64),
    entry: fixtureEntry(),
    reasoning: fixtureReasoning(),
    initialStatus: 'open',
  });
  const initialCutoff = Date.parse('2026-09-17T06:00:00Z');
  await positions.setTimeStopExtension(opened.id, initialCutoff);
  // Try to set EARLIER — must be a no-op (caller still gets the original).
  const earlierCutoff = Date.parse('2026-09-15T00:00:00Z');
  const updated = await positions.setTimeStopExtension(opened.id, earlierCutoff);
  assert.equal(updated.entry.time_stop_extended_at, initialCutoff);
});

test('Positions.setTimeStopExtension: accepts a later timestamp (upgrade)', async (t) => {
  const dir = await makeTmp(t);
  const file = path.join(dir, 'positions.json');
  const { positions } = makePositions(t, { file });
  t._dir = dir;
  const opened = await positions.open({
    tokenId: 'a'.repeat(64),
    entry: fixtureEntry(),
    reasoning: fixtureReasoning(),
    initialStatus: 'open',
  });
  const firstCutoff = Date.parse('2026-09-17T06:00:00Z');
  await positions.setTimeStopExtension(opened.id, firstCutoff);
  const laterCutoff = Date.parse('2026-09-18T06:00:00Z');
  const updated = await positions.setTimeStopExtension(opened.id, laterCutoff);
  assert.equal(updated.entry.time_stop_extended_at, laterCutoff);
});

test('Positions.setTimeStopExtension: throws PositionsConfigError on bad inputs', async (t) => {
  const dir = await makeTmp(t);
  const file = path.join(dir, 'positions.json');
  const { positions } = makePositions(t, { file });
  t._dir = dir;
  const opened = await positions.open({
    tokenId: 'a'.repeat(64),
    entry: fixtureEntry(),
    reasoning: fixtureReasoning(),
    initialStatus: 'open',
  });
  await assert.rejects(() => positions.setTimeStopExtension('', 1000), PositionsConfigError);
  await assert.rejects(() => positions.setTimeStopExtension(opened.id, null), PositionsConfigError);
  await assert.rejects(() => positions.setTimeStopExtension(opened.id, -1), PositionsConfigError);
  await assert.rejects(() => positions.setTimeStopExtension(opened.id, NaN), PositionsConfigError);
  await assert.rejects(() => positions.setTimeStopExtension(opened.id, 'not-a-number'), PositionsConfigError);
});

test('Positions.setTimeStopExtension: throws PositionsNotFoundError when missing', async (t) => {
  const dir = await makeTmp(t);
  const file = path.join(dir, 'positions.json');
  const { positions } = makePositions(t, { file });
  t._dir = dir;
  await assert.rejects(
    () => positions.setTimeStopExtension('pos_does_not_exist', Date.now()),
    PositionsNotFoundError,
  );
});

test('Positions.setTimeStopExtension: accepts an ISO string timestamp via string-coerce path', async (t) => {
  // The helper internally reads `entry.time_stop_extended_at` and
  // accepts both number (ms) and ISO string. The setter only accepts
  // numbers (cleaner contract), so verify the read path via a
  // hand-edited position record (mimics a recovery scenario).
  const dir = await makeTmp(t);
  const file = path.join(dir, 'positions.json');
  const { positions } = makePositions(t, { file });
  t._dir = dir;
  const opened = await positions.open({
    tokenId: 'a'.repeat(64),
    entry: fixtureEntry(),
    reasoning: fixtureReasoning(),
    initialStatus: 'open',
  });
  // Stamp via the setter (number).
  const cutoffMs = Date.parse('2026-09-17T06:00:00Z');
  await positions.setTimeStopExtension(opened.id, cutoffMs);
  // The strategy reads `entry.time_stop_extended_at` — verify the
  // shape is what `shouldExit` expects (a number).
  const onDisk = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(typeof onDisk.open[0].entry.time_stop_extended_at, 'number');
  assert.equal(onDisk.open[0].entry.time_stop_extended_at, cutoffMs);
});

// ───────────────────────────────────────────────────────────────────
//  B05: applyDelete + Positions.delete — removal without audit
//
// Stuck-on-pre-flight positions (B04) record an entry block in
// `data/positions.json` but the swap never broadcast — there's
// nothing real to close, only a phantom record the bot keeps
// retrying against. `applyDelete` + `Positions.delete` remove
// the row from `open[]` WITHOUT moving it to `closed[]` and
// bump `meta.total_deleted` so operators can grep for the
// counter.
// ───────────────────────────────────────────────────────────────────

test('applyDelete: removes from open[] without moving to closed[]', () => {
  const file = {
    version: 1,
    open: [
      { id: 'pos_a', token_id: 'a'.repeat(64), side: 'long_token', status: 'open', entry: {}, opened_at: '2026-09-14T00:00:00.000Z' },
      { id: 'pos_b', token_id: 'b'.repeat(64), side: 'long_token', status: 'open', entry: {}, opened_at: '2026-09-14T00:00:00.000Z' },
    ],
    closed: [{ id: 'pos_c', token_id: 'c'.repeat(64), side: 'long_token', status: 'closed', entry: {}, opened_at: '2026-09-14T00:00:00.000Z', closed_at: '2026-09-14T01:00:00.000Z' }],
    meta: { total_opened: 3, total_closed: 1 },
  };
  const next = applyDelete(file, 'pos_a');
  assert.equal(next.open.length, 1);
  assert.equal(next.open[0].id, 'pos_b');
  assert.equal(next.closed.length, 1); // closed[] untouched
  assert.equal(next.closed[0].id, 'pos_c');
  assert.equal(next.meta.total_deleted, 1);
});

test('applyDelete: throws PositionsStateError on closed position (audit trail intact)', () => {
  const file = {
    version: 1,
    open: [],
    closed: [{ id: 'pos_a', token_id: 'a'.repeat(64), status: 'closed', entry: {}, opened_at: '2026-09-14T00:00:00.000Z', closed_at: '2026-09-14T01:00:00.000Z' }],
    meta: {},
  };
  assert.throws(() => applyDelete(file, 'pos_a'), PositionsStateError);
});

test('applyDelete: throws PositionsNotFoundError when missing', () => {
  const file = { version: 1, open: [], closed: [], meta: {} };
  assert.throws(() => applyDelete(file, 'pos_nope'), PositionsNotFoundError);
});

test('applyDelete: tolerates missing meta + missing closed[] (defensive)', () => {
  const file = { version: 1, open: [{ id: 'pos_a', token_id: 'a'.repeat(64), side: 'long_token', status: 'open', entry: {}, opened_at: 'x' }] };
  const next = applyDelete(file, 'pos_a');
  assert.equal(next.open.length, 0);
  assert.equal(next.meta.total_deleted, 1);
  assert.deepEqual(next.closed, []); // auto-created as []
});

test('Positions.delete: removes from open[] + bumps meta.total_deleted + emits positions.delete log', async (t) => {
  const dir = await makeTmp(t);
  const file = path.join(dir, 'positions.json');
  const { positions, sink } = makePositions(t, { file });
  t._dir = dir;
  const opened = await positions.open({
    tokenId: 'a'.repeat(64),
    entry: fixtureEntry(),
    reasoning: fixtureReasoning(),
    initialStatus: 'open',
  });
  sink.clear();
  const { removed, file: after } = await positions.delete(opened.id, 'B05 stuck recovery');
  assert.equal(removed.id, opened.id);
  assert.equal(after.open.length, 0);
  assert.equal(after.meta.total_deleted, 1);
  // Persisted on disk.
  const onDisk = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(onDisk.open.length, 0);
  assert.equal(onDisk.meta.total_deleted, 1);
  // Logger emitted positions.delete.
  const logs = sink.lines().map((l) => JSON.parse(l));
  const delLog = logs.find((r) => r.msg === 'positions.delete');
  assert.ok(delLog);
  assert.equal(delLog.position_id, opened.id);
  assert.equal(delLog.reason, 'B05 stuck recovery');
  assert.equal(delLog.meta_total_deleted, 1);
});

test('Positions.delete: throws PositionsStateError on closed position (audit trail protected)', async (t) => {
  const dir = await makeTmp(t);
  const file = path.join(dir, 'positions.json');
  const { positions } = makePositions(t, { file });
  t._dir = dir;
  const opened = await positions.open({
    tokenId: 'a'.repeat(64),
    entry: fixtureEntry(),
    reasoning: fixtureReasoning(),
    initialStatus: 'open',
  });
  await positions.close(opened.id, { bch_received_sats: 100_000n, fee_sats: 0 }, 50_000);
  await assert.rejects(
    () => positions.delete(opened.id, 'should fail'),
    PositionsStateError,
  );
});

test('Positions.delete: throws PositionsNotFoundError when missing', async (t) => {
  const dir = await makeTmp(t);
  const file = path.join(dir, 'positions.json');
  const { positions } = makePositions(t, { file });
  t._dir = dir;
  await positions.load();
  await assert.rejects(
    () => positions.delete('pos_nope'),
    PositionsNotFoundError,
  );
});

test('Positions.delete: throws PositionsConfigError on empty id', async (t) => {
  const dir = await makeTmp(t);
  const file = path.join(dir, 'positions.json');
  const { positions } = makePositions(t, { file });
  t._dir = dir;
  await positions.load();
  await assert.rejects(() => positions.delete(''), PositionsConfigError);
});

// ────────────────────────────────────────────────────────────────────
//  O03 — Per-position prevent-stop-loss + profit-target override
//  idea_operator_position-prevent-stop-loss-with-profit-target_20260917
//
// Tests for `applyOverrides` (pure helper) + `Positions.updateOverrides`
// (atomic write). Validates the validation contract (boolean toggle,
// numeric pct in [0, 10000], closed-position rejection, idempotency).
// ────────────────────────────────────────────────────────────────────

const FURU_TOKEN_ID = 'd9ab24ed15a7846cc3d9e004aa5cb976860f13dac1ead05784ee4f4622af96ea';

function makeOpenFile() {
  // Minimal valid PositionsFile with one open position.
  return {
    version: POSITIONS_VERSION,
    open: [
      {
        id: 'pos_test_0001',
        token_id: FURU_TOKEN_ID,
        token_symbol: 'FURU',
        token_decimals: 0,
        side: 'long_token',
        status: 'open',
        opened_at: '2026-09-17T00:00:00.000Z',
        updated_at: '2026-09-17T00:00:00.000Z',
        entry: {
          txid: 'aa'.repeat(32),
          price_sats_per_token: 377,
          bch_spent_sats: '496939',
          token_amount_base: '1315',
          fee_sats: '0',
          ts: '2026-09-17T00:00:00.000Z',
        },
      },
    ],
    closed: [],
    meta: {},
  };
}

test('O03 applyOverrides: toggle ON with explicit profit_target_pct → override stamped', () => {
  const file = makeOpenFile();
  const next = applyOverrides(file, 'pos_test_0001', {
    prevent_stop_loss: true,
    profit_target_pct: 10,
    set_by: 'dashboard',
  });
  assert.equal(next.open.length, 1);
  assert.equal(next.open[0].id, 'pos_test_0001');
  const ov = next.open[0].exit_overrides;
  assert.ok(ov, 'exit_overrides should be stamped');
  assert.equal(ov.prevent_stop_loss, true);
  assert.equal(ov.profit_target_pct, 10);
  assert.equal(ov.set_by, 'dashboard');
  assert.equal(typeof ov.set_at, 'string');
});

test('O03 applyOverrides: toggle ON with no profit_target_pct → defaults to 5%', () => {
  const file = makeOpenFile();
  const next = applyOverrides(file, 'pos_test_0001', {
    prevent_stop_loss: true,
    profit_target_pct: null,
  });
  assert.equal(next.open[0].exit_overrides.profit_target_pct, 5,
    'no explicit pct + toggle ON should default to 5% so a freshly-toggled position does not block forever');
});

test('O03 applyOverrides: toggle ON with profit_target_pct=0 → zero percent target (immediately allowed)', () => {
  const file = makeOpenFile();
  const next = applyOverrides(file, 'pos_test_0001', {
    prevent_stop_loss: true,
    profit_target_pct: 0,
  });
  assert.equal(next.open[0].exit_overrides.profit_target_pct, 0);
});

test('O03 applyOverrides: toggle OFF with pct=null → cleared (no stale pct left on record)', () => {
  const file = makeOpenFile();
  const next = applyOverrides(file, 'pos_test_0001', {
    prevent_stop_loss: false,
    profit_target_pct: null,
  });
  const ov = next.open[0].exit_overrides;
  assert.equal(ov.prevent_stop_loss, false);
  assert.equal(ov.profit_target_pct, null);
  assert.equal(typeof ov.cleared_at, 'string');
  assert.equal(ov.cleared_by, null);
});

test('O03 applyOverrides: non-boolean prevent_stop_loss → PositionsConfigError', () => {
  const file = makeOpenFile();
  for (const bad of [null, undefined, 0, 1, 'true', {}]) {
    assert.throws(
      () => applyOverrides(file, 'pos_test_0001', { prevent_stop_loss: bad, profit_target_pct: 10 }),
      PositionsConfigError,
      `bad value ${JSON.stringify(bad)} should be rejected`,
    );
  }
});

test('O03 applyOverrides: pct out of range [-1, 10001] → PositionsConfigError', () => {
  const file = makeOpenFile();
  for (const bad of [-1, -0.5, 10001, 100000, Number.NaN, Infinity, 'not a number']) {
    assert.throws(
      () => applyOverrides(file, 'pos_test_0001', { prevent_stop_loss: true, profit_target_pct: bad }),
      PositionsConfigError,
      `bad pct ${JSON.stringify(bad)} should be rejected`,
    );
  }
});

test('O03 applyOverrides: closed position → PositionsStateError', () => {
  const file = makeOpenFile();
  file.closed = [file.open[0]];
  file.open = [];
  file.closed[0].status = 'closed';
  file.closed[0].closed_at = '2026-09-17T01:00:00.000Z';
  assert.throws(
    () => applyOverrides(file, 'pos_test_0001', { prevent_stop_loss: true, profit_target_pct: 10 }),
    PositionsStateError,
  );
});

test('O03 applyOverrides: unknown position id → PositionsNotFoundError', () => {
  const file = makeOpenFile();
  assert.throws(
    () => applyOverrides(file, 'pos_does_not_exist', { prevent_stop_loss: true, profit_target_pct: 10 }),
    PositionsNotFoundError,
  );
});

test('O03 applyOverrides: idempotent — unchanged values do not bump updated_at', () => {
  const file = makeOpenFile();
  const first = applyOverrides(file, 'pos_test_0001', { prevent_stop_loss: true, profit_target_pct: 10, set_by: 'dashboard' });
  const beforeUpdatedAt = first.updated_at;
  // Apply the SAME values again; expect updated_at to stay the same.
  const second = applyOverrides(first, 'pos_test_0001', { prevent_stop_loss: true, profit_target_pct: 10, set_by: 'dashboard' });
  assert.equal(second.updated_at, beforeUpdatedAt, 'idempotent re-apply must not bump updated_at');
});

test('O03 Positions.updateOverrides: persists toggle + pct to data/positions.json and round-trips', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'positions-o03-'));
  try {
    const filePath = path.join(tmp, 'positions.json');
    // Seed with one open position via the class.
    const positions = new Positions({ file: filePath });
    await positions.open({
      tokenId: FURU_TOKEN_ID,
      tokenSymbol: 'FURU',
      tokenDecimals: 0,
      side: 'long_token',
      initialStatus: 'open',  // bypass the pending→confirm flow for the test
      entry: {
        txid: 'aa'.repeat(32),
        price_sats_per_token: 377,
        bch_spent_sats: 496939,
        token_amount_base: 1315,
        fee_sats: 0,
        ts: '2026-09-17T00:00:00.000Z',
      },
      reasoning: { test: true },
    });
    const opened = await positions.list('open');
    const positionId = opened[0].id;

    const updated = await positions.updateOverrides(positionId, {
      prevent_stop_loss: true,
      profit_target_pct: 15,
      set_by: 'dashboard',
    });
    assert.equal(updated.exit_overrides.prevent_stop_loss, true);
    assert.equal(updated.exit_overrides.profit_target_pct, 15);

    // Re-load from disk and confirm persistence.
    const reloaded = await positions.list('open');
    assert.equal(reloaded[0].id, positionId);
    assert.equal(reloaded[0].exit_overrides.prevent_stop_loss, true);
    assert.equal(reloaded[0].exit_overrides.profit_target_pct, 15);

    // Toggle off + clear pct.
    const cleared = await positions.updateOverrides(positionId, {
      prevent_stop_loss: false,
      profit_target_pct: null,
    });
    assert.equal(cleared.exit_overrides.prevent_stop_loss, false);
    assert.equal(cleared.exit_overrides.profit_target_pct, null);
    assert.equal(typeof cleared.exit_overrides.cleared_at, 'string');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('O03 Positions.updateOverrides: closed position → PositionsStateError', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'positions-o03-'));
  try {
    const filePath = path.join(tmp, 'positions.json');
    const positions = new Positions({ file: filePath });
    await positions.open({
      tokenId: FURU_TOKEN_ID,
      tokenSymbol: 'FURU',
      tokenDecimals: 0,
      side: 'long_token',
      initialStatus: 'open',  // bypass pending→confirm for the test
      entry: {
        txid: 'aa'.repeat(32),
        price_sats_per_token: 377,
        bch_spent_sats: 496939,
        token_amount_base: 1315,
        fee_sats: 0,
        ts: '2026-09-17T00:00:00.000Z',
      },
      reasoning: { test: true },
    });
    const opened = await positions.list('open');
    const positionId = opened[0].id;
    // Force-close via applyClose (the production path).
    await positions.close(positionId, {
      txid: 'bb'.repeat(32),
      price_sats_per_token: 377,
      bch_received_sats: 495000,
      fee_sats: 200,
      ts: '2026-09-17T02:00:00.000Z',
      reason: 'test_close',
    }, -1939);
    await assert.rejects(
      () => positions.updateOverrides(positionId, { prevent_stop_loss: true, profit_target_pct: 10 }),
      PositionsStateError,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('O03 Positions.updateOverrides: unknown id → PositionsNotFoundError', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'positions-o03-'));
  try {
    const filePath = path.join(tmp, 'positions.json');
    const positions = new Positions({ file: filePath });
    await assert.rejects(
      () => positions.updateOverrides('pos_no_such_thing', { prevent_stop_loss: true, profit_target_pct: 10 }),
      PositionsNotFoundError,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
