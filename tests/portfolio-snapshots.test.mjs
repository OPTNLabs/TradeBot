#!/usr/bin/env node
/**
 * Unit tests for src/portfolio/snapshots.mjs.
 *
 * Exercises every export (pure helpers + the `Snapshots` class)
 * against real tmp dirs. No mocking of `fs` — the atomic append
 * contract is what we're verifying.
 *
 * Run via:
 *   node --test tests/portfolio-snapshots.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  Snapshots,
  DEFAULT_SNAPSHOTS_DIR,
  SNAPSHOT_VERSION,
  snapshotFilePath,
  deriveSnapshot,
  shouldRecord,
  SnapshotsConfigError,
} from '../src/portfolio/snapshots.mjs';
import { createLogger, createMemorySink } from '../src/util/logger.mjs';
import { SATS_PER_BCH } from '../src/data/types.mjs';

// ─────────────────────────────────────────────────────────────────────
//  Test helpers
// ─────────────────────────────────────────────────────────────────────

async function makeTmp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tradebot-snapshots-'));
  t.after(async () => {
    try { await rm(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });
  return dir;
}

function makeSnapshots(t, opts = {}) {
  const dir = opts.dir ?? t._dir ?? '';
  const sink = opts.sink ?? createMemorySink();
  const logger = opts.logger ?? createLogger({ sink: sink.stream });
  return {
    snapshots: new Snapshots({ dir, logger, fs: opts.fs ?? fsp, now: opts.now }),
    sink,
  };
}

function fixtureSnapshot(overrides = {}) {
  return {
    v: SNAPSHOT_VERSION,
    ts: new Date().toISOString(),
    bch_balance_sats: '4400000',
    open_position_count: 0,
    total_exposure_sats: '0',
    unrealized_pnl_sats: null,
    meta: { source: 'loop' },
    ...overrides,
  };
}

function fixturePosition(overrides = {}) {
  return {
    id: 'pos_test_0001',
    token_id: 'a'.repeat(64),
    side: 'long_token',
    entry: {
      txid: '11'.repeat(32),
      price_sats_per_token: 100,
      bch_spent_sats: 100_000_000,
      token_amount_base: 1_000_000,
      fee_sats: 1_000,
      ts: '2026-09-10T00:00:00.000Z',
    },
    opened_at: '2026-09-10T00:00:00.000Z',
    status: 'open',
    ...overrides,
  };
}

// ============================================================
// Pure helpers — snapshotFilePath
// ============================================================

test('snapshotFilePath: uses UTC YYYY-MM-DD', () => {
  // 2026-09-10 18:00 PDT = 2026-09-11 01:00 UTC
  const d = new Date('2026-09-11T01:00:00Z');
  assert.equal(snapshotFilePath('data/snapshots', d), 'data/snapshots/2026-09-11.jsonl');
});

test('snapshotFilePath: pads month/day to 2 digits', () => {
  const d = new Date('2026-01-05T00:00:00Z');
  assert.equal(snapshotFilePath('data/snapshots', d), 'data/snapshots/2026-01-05.jsonl');
});

test('snapshotFilePath: strips trailing slashes', () => {
  const d = new Date('2026-09-10T00:00:00Z');
  assert.equal(snapshotFilePath('/tmp/snapshots///', d), '/tmp/snapshots/2026-09-10.jsonl');
});

test('snapshotFilePath: throws on empty dir', () => {
  assert.throws(() => snapshotFilePath('', new Date()), /non-empty string/);
});

test('snapshotFilePath: throws on invalid date', () => {
  assert.throws(() => snapshotFilePath('data/snapshots', 'not a date'), /invalid date/);
});

// ============================================================
// Pure helpers — shouldRecord
// ============================================================

test('shouldRecord: returns true on first call (no prior ts)', () => {
  assert.equal(shouldRecord(null, 60, new Date()), true);
  assert.equal(shouldRecord(undefined, 60, new Date()), true);
});

test('shouldRecord: returns false when cadence has not elapsed', () => {
  const now = new Date('2026-09-10T18:00:00Z');
  const last = new Date(now.getTime() - 30_000).toISOString(); // 30s ago
  assert.equal(shouldRecord(last, 60, now), false);
});

test('shouldRecord: returns true when cadence has elapsed', () => {
  const now = new Date('2026-09-10T18:00:00Z');
  const last = new Date(now.getTime() - 65_000).toISOString(); // 65s ago
  assert.equal(shouldRecord(last, 60, now), true);
});

test('shouldRecord: accepts epoch-ms number for lastTs', () => {
  const now = new Date('2026-09-10T18:00:00Z');
  const last = now.getTime() - 65_000;
  assert.equal(shouldRecord(last, 60, now), true);
});

test('shouldRecord: invalid lastTs → true (treat as first call)', () => {
  assert.equal(shouldRecord('not a date', 60, new Date()), true);
});

test('shouldRecord: throws on bad intervalSeconds', () => {
  assert.throws(() => shouldRecord(null, 0, new Date()), /positive finite number/);
  assert.throws(() => shouldRecord(null, -1, new Date()), /positive finite number/);
  assert.throws(() => shouldRecord(null, NaN, new Date()), /positive finite number/);
  assert.throws(() => shouldRecord(null, '60', new Date()), /positive finite number/);
});

// ============================================================
// Pure helpers — deriveSnapshot
// ============================================================

test('deriveSnapshot: empty state produces v=1 record', () => {
  const r = deriveSnapshot({ bchBalanceSats: 5_000_000n, openPositions: [] });
  assert.equal(r.v, SNAPSHOT_VERSION);
  assert.equal(typeof r.ts, 'string');
  assert.equal(r.bch_balance_sats, '5000000');
  assert.equal(r.open_position_count, 0);
  assert.equal(r.total_exposure_sats, '0');
  assert.equal(r.unrealized_pnl_sats, null);
});

test('deriveSnapshot: balances / counts positions correctly', () => {
  const positions = [
    fixturePosition({ id: 'pos_a' }),
    fixturePosition({ id: 'pos_b' }),
    fixturePosition({ id: 'pos_c', status: 'closed', closed_at: new Date().toISOString() }),
  ];
  const r = deriveSnapshot({ bchBalanceSats: 200_000_000n, openPositions: positions });
  assert.equal(r.open_position_count, 2);
  // 2 positions × 1 BCH spent each = 2 BCH = 200_000_000 sats
  assert.equal(r.total_exposure_sats, '200000000');
});

test('deriveSnapshot: sums unrealized P&L across priced positions', () => {
  const positions = [
    fixturePosition({ id: 'pos_a' }),
    fixturePosition({ id: 'pos_b' }),
  ];
  // Market price 110 sats/unit (vs 100 entry); 1M tokens each →
  // gross = 110_000_000 - 100_000_000 = 10_000_000 sats per position.
  // Net: 10_000_000 - 1000 entry_fee = 9_999_000 per position.
  // 2 positions = 19_998_000 sats.
  const r = deriveSnapshot({
    bchBalanceSats: 100_000_000n,
    openPositions: positions,
    marketPricesSats: { ['a'.repeat(64)]: 110n },
  });
  assert.equal(r.unrealized_pnl_sats, '19998000');
});

test('deriveSnapshot: nulls unrealized_pnl when no positions are priced', () => {
  const r = deriveSnapshot({
    bchBalanceSats: 100_000_000n,
    openPositions: [fixturePosition()],
    marketPricesSats: {},
  });
  assert.equal(r.unrealized_pnl_sats, null);
});

test('deriveSnapshot: filters positions by tokenId when provided', () => {
  const positions = [
    fixturePosition({ id: 'pos_a', token_id: 'a'.repeat(64) }),
    fixturePosition({ id: 'pos_b', token_id: 'b'.repeat(64) }),
  ];
  const r = deriveSnapshot({
    bchBalanceSats: 100_000_000n,
    openPositions: positions,
    tokenId: 'a'.repeat(64),
  });
  assert.equal(r.open_position_count, 1);
  assert.equal(r.total_exposure_sats, '100000000');
  assert.equal(r.token_id, 'a'.repeat(64));
});

test('deriveSnapshot: coerces bigint/number/string balance', () => {
  const r1 = deriveSnapshot({ bchBalanceSats: 100n, openPositions: [] });
  const r2 = deriveSnapshot({ bchBalanceSats: 100, openPositions: [] });
  const r3 = deriveSnapshot({ bchBalanceSats: '100', openPositions: [] });
  assert.equal(r1.bch_balance_sats, '100');
  assert.equal(r2.bch_balance_sats, '100');
  assert.equal(r3.bch_balance_sats, '100');
});

test('deriveSnapshot: throws on missing balance', () => {
  assert.throws(() => deriveSnapshot({ openPositions: [] }), /bchBalanceSats required/);
});

test('deriveSnapshot: throws on non-array positions', () => {
  assert.throws(() => deriveSnapshot({ bchBalanceSats: 100n, openPositions: 'oops' }), /must be an array/);
});

test('deriveSnapshot: throws on negative balance', () => {
  assert.throws(() => deriveSnapshot({ bchBalanceSats: -1, openPositions: [] }), /non-negative sats/);
});

test('deriveSnapshot: throws on bad now', () => {
  assert.throws(() => deriveSnapshot({ bchBalanceSats: 100n, openPositions: [], now: 'oops' }), /invalid now/);
});

// ============================================================
// Snapshots class — load / record
// ============================================================

test('Snapshots.load: returns null when directory does not exist', async (t) => {
  t._dir = await makeTmp(t);
  const { snapshots } = makeSnapshots(t);
  const last = await snapshots.load();
  assert.equal(last, null);
});

test('Snapshots.record: appends a line to today\u2019s NDJSON file', async (t) => {
  t._dir = await makeTmp(t);
  const { snapshots } = makeSnapshots(t);
  const rec = fixtureSnapshot();
  await snapshots.record(rec);
  const file = snapshotFilePath(t._dir, new Date(rec.ts));
  const body = await readFile(file, 'utf8');
  assert.equal(body.endsWith('\n'), true);
  const lines = body.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.v, SNAPSHOT_VERSION);
  assert.equal(parsed.bch_balance_sats, rec.bch_balance_sats);
});

test('Snapshots.record: appends multiple lines (O_APPEND preserves order)', async (t) => {
  t._dir = await makeTmp(t);
  const { snapshots } = makeSnapshots(t);
  const base = Date.parse('2026-09-10T18:00:00Z');
  for (let i = 0; i < 5; i++) {
    const ts = new Date(base + i * 60_000).toISOString();
    await snapshots.record(
      fixtureSnapshot({ ts, bch_balance_sats: String(4_400_000 + i * 1000) }),
    );
  }
  const file = snapshotFilePath(t._dir, new Date(base));
  const body = await readFile(file, 'utf8');
  const lines = body.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 5);
  // Verify ascending order preserved.
  const balances = lines.map((l) => JSON.parse(l).bch_balance_sats);
  assert.deepEqual(balances, [
    '4400000', '4401000', '4402000', '4403000', '4404000',
  ]);
});

test('Snapshots.record: throws on missing ts', async (t) => {
  t._dir = await makeTmp(t);
  const { snapshots } = makeSnapshots(t);
  await assert.rejects(
    snapshots.record({ v: SNAPSHOT_VERSION }),
    /ts must be an ISO string/,
  );
});

test('Snapshots.record: throws on bad version', async (t) => {
  t._dir = await makeTmp(t);
  const { snapshots } = makeSnapshots(t);
  await assert.rejects(
    snapshots.record({ v: 999, ts: new Date().toISOString() }),
    /record.v must be 1/,
  );
});

test('Snapshots.record: throws on unparseable ts', async (t) => {
  t._dir = await makeTmp(t);
  const { snapshots } = makeSnapshots(t);
  await assert.rejects(
    snapshots.record({ v: SNAPSHOT_VERSION, ts: 'not a date' }),
    /unparseable/,
  );
});

// ============================================================
// Snapshots.maybeRecord
// ============================================================

test('Snapshots.maybeRecord: first call records', async (t) => {
  t._dir = await makeTmp(t);
  const { snapshots } = makeSnapshots(t);
  const rec = await snapshots.maybeRecord({ bchBalanceSats: 5_000_000n, openPositions: [] }, 300);
  assert.ok(rec);
  assert.equal(rec.bch_balance_sats, '5000000');
});

test('Snapshots.maybeRecord: skips when cadence has not elapsed', async (t) => {
  t._dir = await makeTmp(t);
  let fakeNow = new Date('2026-09-10T18:00:00Z');
  const { snapshots } = makeSnapshots(t, { now: () => new Date(fakeNow.getTime()) });
  // First call records.
  const a = await snapshots.maybeRecord({ bchBalanceSats: 5_000_000n, openPositions: [] }, 60);
  assert.ok(a);
  // Advance by 30s — under the 60s cadence → no record.
  fakeNow = new Date(fakeNow.getTime() + 30_000);
  const b = await snapshots.maybeRecord({ bchBalanceSats: 5_001_000n, openPositions: [] }, 60);
  assert.equal(b, null);
});

test('Snapshots.maybeRecord: records again after cadence elapses', async (t) => {
  t._dir = await makeTmp(t);
  let fakeNow = new Date('2026-09-10T18:00:00Z');
  const { snapshots } = makeSnapshots(t, { now: () => new Date(fakeNow.getTime()) });
  await snapshots.maybeRecord({ bchBalanceSats: 5_000_000n, openPositions: [] }, 60);
  fakeNow = new Date(fakeNow.getTime() + 90_000);
  const b = await snapshots.maybeRecord({ bchBalanceSats: 5_009_000n, openPositions: [] }, 60);
  assert.ok(b);
  assert.equal(b.bch_balance_sats, '5009000');
});

test('Snapshots.maybeRecord: throws on bad interval', async (t) => {
  t._dir = await makeTmp(t);
  const { snapshots } = makeSnapshots(t);
  await assert.rejects(
    snapshots.maybeRecord({ bchBalanceSats: 1n, openPositions: [] }, 0),
    /positive finite number/,
  );
});

// ============================================================
// Snapshots.readBack / last
// ============================================================

test('Snapshots.readBack: returns empty when no files exist', async (t) => {
  t._dir = await makeTmp(t);
  const { snapshots } = makeSnapshots(t);
  const out = await snapshots.readBack();
  assert.deepEqual(out.records, []);
  assert.equal(out.total, 0);
});

test('Snapshots.readBack: returns records sorted by ts asc', async (t) => {
  t._dir = await makeTmp(t);
  const { snapshots } = makeSnapshots(t);
  const base = Date.parse('2026-09-10T18:00:00Z');
  // Write out of order to verify sorting.
  const order = [2, 0, 4, 1, 3];
  for (const i of order) {
    await snapshots.record(
      fixtureSnapshot({ ts: new Date(base + i * 60_000).toISOString() }),
    );
  }
  const { records, total } = await snapshots.readBack();
  assert.equal(total, 5);
  assert.equal(records.length, 5);
  // Verify ascending order.
  for (let i = 1; i < records.length; i++) {
    assert.ok(records[i].ts > records[i - 1].ts, `record ${i} not after ${i - 1}`);
  }
});

test('Snapshots.readBack: respects limit (returns tail)', async (t) => {
  t._dir = await makeTmp(t);
  const { snapshots } = makeSnapshots(t);
  const base = Date.parse('2026-09-10T18:00:00Z');
  for (let i = 0; i < 10; i++) {
    await snapshots.record(
      fixtureSnapshot({ ts: new Date(base + i * 60_000).toISOString() }),
    );
  }
  const { records, total } = await snapshots.readBack({ limit: 3 });
  assert.equal(total, 10);
  assert.equal(records.length, 3);
  // Tail should be the most recent 3.
  assert.equal(records[0].ts, new Date(base + 7 * 60_000).toISOString());
  assert.equal(records[2].ts, new Date(base + 9 * 60_000).toISOString());
});

test('Snapshots.readBack: filters by tokenId', async (t) => {
  t._dir = await makeTmp(t);
  const { snapshots } = makeSnapshots(t);
  await snapshots.record(
    fixtureSnapshot({ token_id: 'a'.repeat(64) }),
  );
  await snapshots.record(
    fixtureSnapshot({ token_id: 'b'.repeat(64) }),
  );
  const { records } = await snapshots.readBack({ tokenId: 'a'.repeat(64) });
  assert.equal(records.length, 1);
  assert.equal(records[0].token_id, 'a'.repeat(64));
});

test('Snapshots.last: returns most recent record', async (t) => {
  t._dir = await makeTmp(t);
  const { snapshots } = makeSnapshots(t);
  const base = Date.parse('2026-09-10T18:00:00Z');
  await snapshots.record(
    fixtureSnapshot({ ts: new Date(base).toISOString(), bch_balance_sats: '4400000' }),
  );
  await snapshots.record(
    fixtureSnapshot({ ts: new Date(base + 60_000).toISOString(), bch_balance_sats: '4500000' }),
  );
  const last = await snapshots.last();
  assert.ok(last);
  assert.equal(last.bch_balance_sats, '4500000');
});

test('Snapshots.last: returns null when empty', async (t) => {
  t._dir = await makeTmp(t);
  const { snapshots } = makeSnapshots(t);
  const last = await snapshots.last();
  assert.equal(last, null);
});

// ============================================================
// Cross-day rollover
// ============================================================

test('Snapshots: cross-day rollover writes to separate files', async (t) => {
  t._dir = await makeTmp(t);
  const { snapshots } = makeSnapshots(t);
  // Day 1: 2026-09-10
  await snapshots.record(
    fixtureSnapshot({ ts: '2026-09-10T18:00:00.000Z', bch_balance_sats: '4400000' }),
  );
  // Day 2: 2026-09-11
  await snapshots.record(
    fixtureSnapshot({ ts: '2026-09-11T18:00:00.000Z', bch_balance_sats: '4500000' }),
  );
  // Both files should exist + readBack should return both records.
  const { records, total } = await snapshots.readBack();
  assert.equal(total, 2);
  assert.equal(records.length, 2);
  assert.equal(records[0].bch_balance_sats, '4400000');
  assert.equal(records[1].bch_balance_sats, '4500000');
});

// ============================================================
// Crash safety: append atomicity
// ============================================================

test('Snapshots: append does not corrupt existing content on concurrent writes', async (t) => {
  t._dir = await makeTmp(t);
  const { snapshots } = makeSnapshots(t);
  const base = Date.parse('2026-09-10T18:00:00Z');
  // Fire 20 concurrent appends; the file should end up with 20
  // well-formed JSON lines (no torn writes).
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      snapshots.record(
        fixtureSnapshot({ ts: new Date(base + i).toISOString() }),
      ),
    ),
  );
  const file = snapshotFilePath(t._dir, new Date(base));
  const body = await readFile(file, 'utf8');
  const lines = body.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 20);
  for (const line of lines) {
    const parsed = JSON.parse(line); // throws on torn write
    assert.equal(parsed.v, SNAPSHOT_VERSION);
  }
});

// ============================================================
// Structured logging
// ============================================================

function parsedEvents(sink) {
  return sink.lines().map((l) => JSON.parse(l));
}

function msgs(sink) {
  return parsedEvents(sink).map((e) => e.msg);
}

test('Snapshots.record: emits structured log line', async (t) => {
  t._dir = await makeTmp(t);
  const { snapshots, sink } = makeSnapshots(t);
  await snapshots.record(
    fixtureSnapshot({ bch_balance_sats: '5500000' }),
  );
  const ms = msgs(sink);
  assert.ok(ms.includes('snapshots.record'),
    `expected snapshots.record msg; got ${JSON.stringify(ms)}`);
});

test('Snapshots: load emits warn event on corrupt lines', async (t) => {
  t._dir = await makeTmp(t);
  // Seed a file with a corrupt line.
  const file = snapshotFilePath(t._dir, new Date('2026-09-10T18:00:00Z'));
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(
    file,
    JSON.stringify({ v: 1, ts: '2026-09-10T18:00:00.000Z', bch_balance_sats: '4400000' }) + '\n' +
      'not valid json\n',
    'utf8',
  );
  const { snapshots, sink } = makeSnapshots(t);
  await snapshots.load();
  const ms = msgs(sink);
  assert.ok(ms.includes('snapshots.load.corrupt_lines'),
    `expected corrupt_lines warn; got ${JSON.stringify(ms)}`);
});

// ============================================================
// Constants
// ============================================================

test('SNAPSHOT_VERSION is 1', () => {
  assert.equal(SNAPSHOT_VERSION, 1);
});

test('DEFAULT_SNAPSHOTS_DIR points to data/snapshots', () => {
  assert.equal(DEFAULT_SNAPSHOTS_DIR, 'data/snapshots');
});

// Touch SATS_PER_BCH import so test file fails loudly if the
// data/types.mjs export gets renamed away.
test('SATS_PER_BCH constant is 100_000_000', () => {
  assert.equal(SATS_PER_BCH, 100_000_000);
});
// ─── 2026-09-20 fixup: persist marketPricesSats to the snapshot record's
// `meta.market_prices_sats` field in the array-of-rows shape the
// dashboard expects. Without this, the dashboard's positions /
// summary / risk-panel endpoints all fall back to entry price and the
// "current worth" column renders +0% P&L forever, even when the AMM
// price has moved (this is what was happening with the 1315-FURU
// position — dashboard showed 0.00495755 BCH worth at 377 sat/token
// while cauldron actually priced it at 0.00392609 BCH at ~298 sat).

test('deriveSnapshot: persists market_prices_sats to meta in the dashboard-expected array shape', () => {
  const tid = 'd9ab24ed15a7846cc3d9e004aa5cb976860f13dac1ead05784ee4f4622af96ea';
  const r = deriveSnapshot({
    bchBalanceSats: 1_000_000_000n,
    openPositions: [],
    marketPricesSats: { [tid]: 298n },
  });
  assert.ok(Array.isArray(r.meta.market_prices_sats), 'snapshot.meta.market_prices_sats must be an array');
  assert.equal(r.meta.market_prices_sats.length, 1);
  assert.equal(r.meta.market_prices_sats[0].token_id, tid);
  assert.equal(r.meta.market_prices_sats[0].price_sats_per_token, 298);
});

test('deriveSnapshot: bigint / number / null price inputs all coerce cleanly', () => {
  const tids = {
    bigint:  'a'.repeat(64),
    number:  'b'.repeat(64),
    string:  'c'.repeat(64),  // must be dropped (defensive)
    null:    'd'.repeat(64),  // must be dropped
    nan:     'e'.repeat(64),  // NaN must be dropped
  };
  const r = deriveSnapshot({
    bchBalanceSats: 1_000_000_000n,
    openPositions: [],
    marketPricesSats: {
      [tids.bigint]: 110n,
      [tids.number]: 222,
      [tids.string]: '99',     // not a number/bigint — must be skipped
      [tids.null]: null,        // null — must be skipped
      [tids.nan]: Number.NaN,   // NaN — must be skipped
    },
  });
  const out = r.meta.market_prices_sats;
  assert.ok(Array.isArray(out));
  const kept = Object.fromEntries(out.map((row) => [row.token_id, row.price_sats_per_token]));
  // Bigint and number both kept, others dropped.
  assert.equal(kept[tids.bigint], 110);
  assert.equal(kept[tids.number], 222);
  assert.equal(kept[tids.string], undefined);
  assert.equal(kept[tids.null], undefined);
  assert.equal(kept[tids.nan], undefined);
});

test('deriveSnapshot: token_id is lowercased (matches indexer convention)', () => {
  const upper = 'D9AB24ED15A7846CC3D9E004AA5CB976860F13DAC1EAD05784EE4F4622AF96EA';
  const lower = upper.toLowerCase();
  const r = deriveSnapshot({
    bchBalanceSats: 1_000_000_000n,
    openPositions: [],
    marketPricesSats: { [upper]: 100n },
  });
  assert.equal(r.meta.market_prices_sats[0].token_id, lower);
});

test('deriveSnapshot: empty / null / missing marketPricesSats all produce no meta.market_prices_sats', () => {
  const cases = [
    { input: undefined, label: 'undefined' },
    { input: null, label: 'null' },
    { input: {}, label: 'empty object' },
  ];
  for (const c of cases) {
    const r = deriveSnapshot({
      bchBalanceSats: 1_000_000_000n,
      openPositions: [],
      marketPricesSats: c.input,
    });
    assert.equal(r.meta.market_prices_sats, undefined,
      `case ${c.label}: meta.market_prices_sats must be undefined when input is missing/empty`);
  }
});

test('deriveSnapshot: market_prices_sats preserves the snapshot\'s price-input contract for unrealized PnL', () => {
  // Regression — writing to meta.market_prices_sats must NOT
  // mutate or interfere with the `marketPricesSats[token_id]`
  // object-form lookup the unrealized-PnL walk uses above. Same
  // input → same unrealized_pnl_sats output as before.
  const tid = 'a'.repeat(64);
  const positions = [
    fixturePosition({ id: 'pos_a' }),
    fixturePosition({ id: 'pos_b' }),
  ];
  const r = deriveSnapshot({
    bchBalanceSats: 100_000_000n,
    openPositions: positions,
    marketPricesSats: { [tid]: 110n },
  });
  // Existing invariant: 2 positions × 9_999_000 net = 19_998_000
  // sats unrealized PnL when price is 110.
  assert.equal(r.unrealized_pnl_sats, '19998000');
  // New invariant: meta.market_prices_sats carries the same index
  // the dashboard needs.
  assert.equal(r.meta.market_prices_sats[0].token_id, tid);
  assert.equal(r.meta.market_prices_sats[0].price_sats_per_token, 110);
});
