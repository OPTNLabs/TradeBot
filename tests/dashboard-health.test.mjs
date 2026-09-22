// tests/dashboard-health.test.mjs
//
// T61 — unit + HTTP integration tests for the extended `/healthz`
// builder (`src/dashboard/health.mjs` + `GET /healthz`).
//
// Covers:
//   - Schema constant pinned (`tradebot.dashboard.health/v1`).
//   - `asCount` math (negative / float / NaN / non-numeric → 0;
//     non-negative integer preserved).
//   - `asTimeoutMs` math (out-of-range / missing → DEFAULT; integer
//     in [100..60000] preserved; large-cap at 60_000ms).
//   - `buildLoopProbe` shape contract + unconfigured / degraded
//     / ok / stale classification (last_tick_age_ms >
//     stale_loop_age_ms → degraded with explanatory error).
//   - `buildPositionsProbe` shape contract + unconfigured (null
//     input) / degraded (non-array) / degraded (thrown).
//   - `buildWalletProbe` shape contract + unconfigured / non-array
//     degraded / timeout degraded (resolve-after-budget) / ok path.
//     The timeout test wins the race so we never hang the suite.
//   - `buildBreakerProbe` shape contract + unconfigured / degraded
//     (state() throws) / ok + is_tripped:true / recent_daily_pnl_bch
//     sat→bch conversion / loss_cooldown_remaining_ms guard.
//   - `buildExtendedHealthz({ctx})` end-to-end: aggregates all
//     four probes, surfaces `probes` map mirror + `ok:true` + `ts` +
//     `uptime_s`. Defensive: missing ctx sub-modules → `unconfigured`
//     probes; throwing sub-modules → `degraded` probes + structured
//     warn log entry.
//   - HTTP integration via supertest: `GET /healthz` returns 200
//     with the schema envelope + probes map; defaults for missing
//     loop/wallet/risk/positions; breaker-trip state surfaces
//     `is_tripped:true` + `trip_kind`; UTXO timeout path reports
//     `status:'degraded'` without throwing the endpoint; stale-loop
//     classification fires when last_tick_age exceeds 5min default.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';

import {
  HEALTH_SCHEMA,
  PROBE_STATUS_OK,
  PROBE_STATUS_DEGRADED,
  PROBE_STATUS_UNCONFIGURED,
  DEFAULT_HEALTH_UTXO_TIMEOUT_MS,
  DEFAULT_STALE_LOOP_AGE_MS,
  asCount,
  asTimeoutMs,
  buildLoopProbe,
  buildPositionsProbe,
  buildWalletProbe,
  buildBreakerProbe,
  buildExtendedHealthz,
} from '../src/dashboard/health.mjs';
import { createDashboardServer } from '../src/dashboard/server.mjs';
import { createLogger, createMemorySink } from '../src/util/logger.mjs';
import { Positions } from '../src/portfolio/positions.mjs';
import { Snapshots } from '../src/portfolio/snapshots.mjs';

// ─── Fixtures ──────────────────────────────────────────────────────────

function makeLogger() {
  const sink = createMemorySink();
  const logger = createLogger({
    component: 'test',
    sink: sink.stream,
    level: 'debug',
  });
  return { logger, sink };
}

/** Write a JSON seed for the positions file. Test-only fixture helper. */
async function writeJsonSeed(filePath, obj) {
  await writeFile(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

async function bootDashboardServer({ cfg = {}, wallet = null, risk = null, loop = null, clock = null } = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'health-'));
  const positions = new Positions({ file: path.join(tmp, 'positions.json') });
  await positions.load();
  const snapshots = new Snapshots({ dir: path.join(tmp, 'snapshots') });
  await snapshots.load();
  const { logger } = makeLogger();
  const server = createDashboardServer({
    cfg,
    positions,
    snapshots,
    historyReader: { read: async () => ({ events: [], errors: [] }) },
    wallet,
    risk,
    loop,
    staticRoot: null,
    logger,
    clock: clock ?? (() => Date.now()),
  });
  return { server, tmp, positions };
}

// ─── Constants ────────────────────────────────────────────────────────

test('health: HEALTH_SCHEMA matches the tradebot.dashboard.health/v1 envelope', () => {
  assert.equal(HEALTH_SCHEMA, 'tradebot.dashboard.health/v1');
});

test('health: probe status constants are pinned for downstream alert rules', () => {
  assert.equal(PROBE_STATUS_OK, 'ok');
  assert.equal(PROBE_STATUS_DEGRADED, 'degraded');
  assert.equal(PROBE_STATUS_UNCONFIGURED, 'unconfigured');
});

test('health: DEFAULT_HEALTH_UTXO_TIMEOUT_MS is 5s + DEFAULT_STALE_LOOP_AGE_MS is 5min', () => {
  assert.equal(DEFAULT_HEALTH_UTXO_TIMEOUT_MS, 5000);
  assert.equal(DEFAULT_STALE_LOOP_AGE_MS, 5 * 60 * 1000);
});

// ─── asCount ──────────────────────────────────────────────────────────

test('health: asCount accepts non-negative integers', () => {
  assert.equal(asCount(0), 0);
  assert.equal(asCount(7), 7);
  assert.equal(asCount(144), 144);
});

test('health: asCount rejects / coerces bad inputs to 0', () => {
  assert.equal(asCount(-1), 0);
  assert.equal(asCount(1.5), 0);
  assert.equal(asCount(NaN), 0);
  assert.equal(asCount(Infinity), 0);
  assert.equal(asCount('7'), 0);
  assert.equal(asCount(null), 0);
  assert.equal(asCount(undefined), 0);
  assert.equal(asCount({}), 0);
});

// ─── asTimeoutMs ───────────────────────────────────────────────────────

test('health: asTimeoutMs accepts integers in [100..60000]', () => {
  assert.equal(asTimeoutMs(100), 100);
  assert.equal(asTimeoutMs(2500), 2500);
  assert.equal(asTimeoutMs(60_000), 60_000);
});

test('health: asTimeoutMs coerces out-of-range / bad inputs to the default', () => {
  assert.equal(asTimeoutMs(0), DEFAULT_HEALTH_UTXO_TIMEOUT_MS);
  assert.equal(asTimeoutMs(99), DEFAULT_HEALTH_UTXO_TIMEOUT_MS);
  assert.equal(asTimeoutMs(60_001), DEFAULT_HEALTH_UTXO_TIMEOUT_MS);
  assert.equal(asTimeoutMs(-1), DEFAULT_HEALTH_UTXO_TIMEOUT_MS);
  assert.equal(asTimeoutMs(NaN), DEFAULT_HEALTH_UTXO_TIMEOUT_MS);
  assert.equal(asTimeoutMs('5000'), DEFAULT_HEALTH_UTXO_TIMEOUT_MS);
  assert.equal(asTimeoutMs(null), DEFAULT_HEALTH_UTXO_TIMEOUT_MS);
  assert.equal(asTimeoutMs(undefined), DEFAULT_HEALTH_UTXO_TIMEOUT_MS);
});

// ─── buildLoopProbe ───────────────────────────────────────────────────

test('health: buildLoopProbe returns unconfigured when loop is missing', () => {
  const r = buildLoopProbe(null, 1_700_000_000_000);
  assert.equal(r.tick_count, null);
  assert.equal(r.last_tick_at_ms, null);
  assert.equal(r.last_tick_age_ms, null);
  assert.equal(r.last_tick_duration_ms, null);
  assert.equal(r.loop_running, null);
  assert.equal(r.status, PROBE_STATUS_UNCONFIGURED);
  assert.equal(r.error, null);
});

test('health: buildLoopProbe returns unconfigured when loop has no stats() method', () => {
  const r = buildLoopProbe({ tick: () => {} }, 1_700_000_000_000);
  assert.equal(r.status, PROBE_STATUS_UNCONFIGURED);
});

test('health: buildLoopProbe classifies a recently-tickled loop as ok', () => {
  const now = 1_700_000_000_000;
  const loop = {
    stats: () => ({
      running: true,
      tick_count: 42,
      last_tick_at_ms: now - 1000,
      last_tick_duration_ms: 230,
    }),
  };
  const r = buildLoopProbe(loop, now);
  assert.equal(r.tick_count, 42);
  assert.equal(r.last_tick_at_ms, now - 1000);
  assert.equal(r.last_tick_age_ms, 1000);
  assert.equal(r.last_tick_duration_ms, 230);
  assert.equal(r.loop_running, true);
  assert.equal(r.status, PROBE_STATUS_OK);
  assert.equal(r.error, null);
});

test('health: buildLoopProbe degrades when last_tick_age exceeds the 5min default', () => {
  const now = 1_700_000_000_000;
  const loop = {
    stats: () => ({
      running: true,
      tick_count: 3,
      last_tick_at_ms: now - (10 * 60 * 1000), // 10 min ago
      last_tick_duration_ms: 100,
    }),
  };
  const r = buildLoopProbe(loop, now);
  assert.equal(r.status, PROBE_STATUS_DEGRADED);
  assert.match(r.error, /last_tick_age_ms/);
});

test('health: buildLoopProbe keeps ok when last_tick_at_ms is 0 (mid-boot)', () => {
  const r = buildLoopProbe({ stats: () => ({ running: false, tick_count: 0, last_tick_at_ms: 0 }) }, 1_700_000_000_000);
  assert.equal(r.status, PROBE_STATUS_OK);
  assert.equal(r.last_tick_age_ms, null);
  assert.equal(r.loop_running, false);
});

test('health: buildLoopProbe returns degraded when stats() throws', () => {
  const loop = { stats: () => { throw new Error('kaboom'); } };
  const r = buildLoopProbe(loop, 1_700_000_000_000);
  assert.equal(r.status, PROBE_STATUS_DEGRADED);
  assert.equal(r.error, 'kaboom');
});

// ─── buildPositionsProbe ──────────────────────────────────────────────

test('health: buildPositionsProbe returns unconfigured on null', () => {
  const r = buildPositionsProbe(null);
  assert.equal(r.status, PROBE_STATUS_UNCONFIGURED);
  assert.equal(r.open_count, null);
});

test('health: buildPositionsProbe returns ok with the array length', () => {
  const r = buildPositionsProbe([{}, {}, {}]);
  assert.equal(r.status, PROBE_STATUS_OK);
  assert.equal(r.open_count, 3);
});

test('health: buildPositionsProbe returns degraded on non-array', () => {
  const r = buildPositionsProbe('not-array');
  assert.equal(r.status, PROBE_STATUS_DEGRADED);
  assert.equal(r.open_count, null);
});

test('health: buildPositionsProbe surfaces thrown errors', () => {
  const r = buildPositionsProbe(undefined, new Error('disk full'));
  assert.equal(r.status, PROBE_STATUS_DEGRADED);
  assert.equal(r.error, 'disk full');
});

// ─── buildWalletProbe ─────────────────────────────────────────────────

test('health: buildWalletProbe returns unconfigured when wallet is missing', async () => {
  const r = await buildWalletProbe(null);
  assert.equal(r.status, PROBE_STATUS_UNCONFIGURED);
  assert.equal(r.utxo_count, null);
  assert.equal(r.utxo_timeout_ms, DEFAULT_HEALTH_UTXO_TIMEOUT_MS);
});

test('health: buildWalletProbe returns ok with the utxo count', async () => {
  const wallet = { listUtxos: async () => [{ txid: 'aa', vout: 0 }, { txid: 'bb', vout: 1 }] };
  const r = await buildWalletProbe(wallet, 5000);
  assert.equal(r.status, PROBE_STATUS_OK);
  assert.equal(r.utxo_count, 2);
  assert.equal(r.utxo_timeout_ms, 5000);
});

test('health: buildWalletProbe returns degraded on non-array result', async () => {
  const wallet = { listUtxos: async () => 'oops' };
  const r = await buildWalletProbe(wallet, 5000);
  assert.equal(r.status, PROBE_STATUS_DEGRADED);
  assert.equal(r.utxo_count, null);
  assert.match(r.error, /non-array/);
});

test('health: buildWalletProbe returns degraded when listUtxos throws', async () => {
  const wallet = { listUtxos: async () => { throw new Error('provider disconnected'); } };
  const r = await buildWalletProbe(wallet, 5000);
  assert.equal(r.status, PROBE_STATUS_DEGRADED);
  assert.match(r.error, /provider disconnected/);
});

test('health: buildWalletProbe races listUtxos against the budget and surfaces degraded on timeout', async () => {
  // listUtxos takes 5s of wall-clock; budget is 150ms (sits above
  // the 100ms floor in asTimeoutMs but well under the 1s budget).
  const wallet = { listUtxos: () => new Promise((resolve) => setTimeout(() => resolve([{ txid: 'too-late', vout: 0 }]), 5000)) };
  const start = Date.now();
  const r = await buildWalletProbe(wallet, 150);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1000, `should return near-instantly when timeout is 150ms (actual ${elapsed}ms)`);
  assert.equal(r.status, PROBE_STATUS_DEGRADED);
  assert.equal(r.utxo_count, null);
  assert.match(r.error, /timed out/);
});

test('health: buildWalletProbe falls back to default when budget is invalid', async () => {
  const wallet = { listUtxos: async () => [{}] };
  const r = await buildWalletProbe(wallet, 0);  // 0 is below the 100-min and should fall back.
  assert.equal(r.status, PROBE_STATUS_OK);
  assert.equal(r.utxo_timeout_ms, DEFAULT_HEALTH_UTXO_TIMEOUT_MS);
});

// ─── buildBreakerProbe ────────────────────────────────────────────────

test('health: buildBreakerProbe returns unconfigured when risk is missing', () => {
  const r = buildBreakerProbe(null);
  assert.equal(r.status, PROBE_STATUS_UNCONFIGURED);
  assert.equal(r.is_tripped, null);
  assert.equal(r.trip_kind, null);
  assert.equal(r.recent_daily_pnl_bch, null);
  assert.equal(r.consecutive_losses, null);
});

test('health: buildBreakerProbe returns ok + is_tripped:false + sat→bch conversion', () => {
  const risk = {
    state: () => ({
      isTripped: false,
      tripKind: null,
      consecutiveLosses: 0,
      recentDailyPnlSats: -50_000_000,  // -0.5 BCH
      lossCooldownRemainingMs: 0,
      maxDailyLossBch: 0.005,
    }),
  };
  const r = buildBreakerProbe(risk);
  assert.equal(r.status, PROBE_STATUS_OK);
  assert.equal(r.is_tripped, false);
  assert.equal(r.recent_daily_pnl_bch, -0.5);
  assert.equal(r.max_daily_loss_bch, 0.005);
});

test('health: buildBreakerProbe surfaces tripped breaker with the right trip_kind', () => {
  const risk = {
    state: () => ({
      isTripped: true,
      tripKind: 'consecutive_losses',
      consecutiveLosses: 3,
      recentDailyPnlSats: -250_000,
      lossCooldownRemainingMs: 120_000,
      maxDailyLossBch: 0.005,
    }),
  };
  const r = buildBreakerProbe(risk);
  assert.equal(r.status, PROBE_STATUS_OK);  // trip is OPERATIONAL data, not a health failure.
  assert.equal(r.is_tripped, true);
  assert.equal(r.trip_kind, 'consecutive_losses');
  assert.equal(r.consecutive_losses, 3);
  assert.equal(r.loss_cooldown_remaining_ms, 120_000);
});

test('health: buildBreakerProbe returns degraded when state() throws', () => {
  const risk = { state: () => { throw new Error('breaker offline'); } };
  const r = buildBreakerProbe(risk);
  assert.equal(r.status, PROBE_STATUS_DEGRADED);
  assert.equal(r.error, 'breaker offline');
});

// ─── buildExtendedHealthz (end-to-end) ────────────────────────────────

test('health: buildExtendedHealthz aggregates all four probes and surfaces ok:true + ts + probes map', async () => {
  const { logger } = makeLogger();
  const ctx = {
    loop: { stats: () => ({ running: true, tick_count: 10, last_tick_at_ms: 1_700_000_000_000 - 250, last_tick_duration_ms: 50 }) },
    risk: { state: () => ({ isTripped: false, tripKind: null, consecutiveLosses: 0, recentDailyPnlSats: 0, lossCooldownRemainingMs: 0, maxDailyLossBch: 0.005 }) },
    wallet: { listUtxos: async () => [{ txid: 'a', vout: 0 }, { txid: 'b', vout: 0 }] },
    positions: { list: async (status) => (status === 'open' ? [{}, {}] : []) },
    logger,
    dashboardCfg: { health_utxo_timeout_ms: 2500 },
    clock: () => 1_700_000_000_000,
  };
  const r = await buildExtendedHealthz({ ctx });
  assert.equal(r.schema, HEALTH_SCHEMA);
  assert.equal(r.ok, true);
  assert.ok(typeof r.ts === 'string');
  assert.ok(typeof r.uptime_s === 'number');
  assert.equal(r.loop.tick_count, 10);
  assert.equal(r.loop.status, PROBE_STATUS_OK);
  assert.equal(r.positions.open_count, 2);
  assert.equal(r.positions.status, PROBE_STATUS_OK);
  assert.equal(r.wallet.utxo_count, 2);
  assert.equal(r.wallet.status, PROBE_STATUS_OK);
  assert.equal(r.wallet.utxo_timeout_ms, 2500);
  assert.equal(r.breaker.is_tripped, false);
  assert.equal(r.breaker.status, PROBE_STATUS_OK);
  assert.deepEqual(r.probes, {
    loop: 'ok', positions: 'ok', wallet: 'ok', breaker: 'ok',
  });
});

test('health: buildExtendedHealthz marks missing sub-modules as unconfigured', async () => {
  const ctx = {
    loop: null,
    risk: null,
    wallet: null,
    positions: null,
    logger: null,
    dashboardCfg: {},
    clock: () => 1_700_000_000_000,
  };
  const r = await buildExtendedHealthz({ ctx });
  assert.equal(r.loop.status, PROBE_STATUS_UNCONFIGURED);
  assert.equal(r.positions.status, PROBE_STATUS_UNCONFIGURED);
  assert.equal(r.wallet.status, PROBE_STATUS_UNCONFIGURED);
  assert.equal(r.breaker.status, PROBE_STATUS_UNCONFIGURED);
  assert.deepEqual(r.probes, {
    loop: 'unconfigured', positions: 'unconfigured', wallet: 'unconfigured', breaker: 'unconfigured',
  });
});

test('health: buildExtendedHealthz marks throwing sub-modules as degraded + logs a warn', async () => {
  const { logger, sink } = makeLogger();
  const ctx = {
    loop: { stats: () => { throw new Error('loop dead'); } },
    risk: { state: () => { throw new Error('breaker offline'); } },
    wallet: { listUtxos: async () => { throw new Error('wallet down'); } },
    positions: { list: async () => { throw new Error('positions disk full'); } },
    logger,
    dashboardCfg: {},
    clock: () => 1_700_000_000_000,
  };
  const r = await buildExtendedHealthz({ ctx });
  assert.equal(r.loop.status, PROBE_STATUS_DEGRADED);
  assert.equal(r.positions.status, PROBE_STATUS_DEGRADED);
  assert.equal(r.wallet.status, PROBE_STATUS_DEGRADED);
  assert.equal(r.breaker.status, PROBE_STATUS_DEGRADED);
  assert.deepEqual(r.probes, {
    loop: 'degraded', positions: 'degraded', wallet: 'degraded', breaker: 'degraded',
  });
  // Every degraded probe should produce exactly one structured warn
  // line for audit-trail purposes:
  //   - positions.async: 'dashboard.health.positions.failed'
  //   - wallet (degraded from inner throw): 'dashboard.health.wallet.degraded'
  //   - loop (synchronous throw → degraded): 'dashboard.health.loop.degraded'
  //   - breaker (synchronous throw → degraded): 'dashboard.health.breaker.degraded'
  const warns = sink.lines().filter((l) => l.includes('"level":"warn"'));
  assert.ok(warns.length >= 4, `expected ≥4 warn lines, got ${warns.length}`);
  assert.ok(warns.some((l) => l.includes('dashboard.health.positions.failed')));
  assert.ok(warns.some((l) => l.includes('dashboard.health.wallet.degraded')));
  assert.ok(warns.some((l) => l.includes('dashboard.health.loop.degraded')));
  assert.ok(warns.some((l) => l.includes('dashboard.health.breaker.degraded')));
  // Sync probes' error messages should also surface on the wire.
  assert.equal(r.loop.error, 'loop dead');
  assert.equal(r.breaker.error, 'breaker offline');
});

test('health: buildExtendedHealthz applies stale-loop classification across the loop probe', async () => {
  const ctx = {
    loop: { stats: () => ({ running: true, tick_count: 5, last_tick_at_ms: 1_700_000_000_000 - (10 * 60 * 1000), last_tick_duration_ms: 100 }) },
    risk: null,
    wallet: null,
    positions: null,
    logger: null,
    dashboardCfg: {},
    clock: () => 1_700_000_000_000,
  };
  const r = await buildExtendedHealthz({ ctx });
  assert.equal(r.loop.status, PROBE_STATUS_DEGRADED);
  assert.match(r.loop.error, /exceeds stale_loop_age_ms/);
});

test('health: buildExtendedHealthz honors nowMs injection for deterministic tests', async () => {
  const nowMs = 1_700_000_000_000;
  const ctx = {
    loop: { stats: () => ({ running: true, tick_count: 1, last_tick_at_ms: nowMs - 100, last_tick_duration_ms: 10 }) },
    risk: null,
    wallet: null,
    positions: null,
    logger: null,
    dashboardCfg: {},
    clock: () => nowMs,
  };
  const r = await buildExtendedHealthz({ ctx, nowMs });
  assert.equal(r.ts, new Date(nowMs).toISOString());
  assert.equal(r.loop.last_tick_age_ms, 100);
});

test('health: buildExtendedHealthz throws TypeError when ctx is missing', async () => {
  await assert.rejects(
    () => buildExtendedHealthz({}),
    (e) => e instanceof TypeError && /ctx required/.test(e.message),
  );
});

// ─── HTTP integration via supertest ──────────────────────────────────

async function importSupertest(t) {
  const supertest = await import('supertest').catch(() => null);
  if (!supertest) {
    t.skip('supertest not installed — skipping HTTP integration');
    return null;
  }
  return supertest.default ?? supertest;
}

test('health: GET /healthz returns the schema envelope (positions wired but empty → ok:0; rest unconfigured)', async (t) => {
  const supertest = await importSupertest(t);
  if (!supertest) return;
  const { server, tmp } = await bootDashboardServer({});
  try {
    const res = await supertest(server.handler).get('/healthz').expect(200);
    assert.equal(res.body.schema, HEALTH_SCHEMA);
    assert.equal(res.body.ok, true);
    assert.ok(typeof res.body.ts === 'string');
    assert.ok(typeof res.body.uptime_s === 'number');
    // The boot helper always wires `positions` (the dashboard
    // requires it). An empty file → `list('open')` returns `[]`
    // → probe is `ok` with `open_count: 0`.
    assert.equal(res.body.loop.status, 'unconfigured');
    assert.equal(res.body.positions.status, 'ok');
    assert.equal(res.body.positions.open_count, 0);
    assert.equal(res.body.wallet.status, 'unconfigured');
    assert.equal(res.body.breaker.status, 'unconfigured');
    assert.deepEqual(res.body.probes, {
      loop: 'unconfigured', positions: 'ok', wallet: 'unconfigured', breaker: 'unconfigured',
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('health: GET /healthz surfaces loop + positions + wallet + breaker when wired', async (t) => {
  const supertest = await importSupertest(t);
  if (!supertest) return;
  const nowMs = 1_700_000_000_000;
  const loop = {
    stats: () => ({
      running: true,
      tick_count: 17,
      last_tick_at_ms: nowMs - 250,
      last_tick_duration_ms: 88,
    }),
  };
  const risk = {
    state: () => ({
      isTripped: true,
      tripKind: 'daily_loss',
      consecutiveLosses: 1,
      recentDailyPnlSats: -300_000,  // -0.003 BCH
      lossCooldownRemainingMs: 60_000,
      maxDailyLossBch: 0.005,
    }),
  };
  const wallet = { listUtxos: async () => [{}, {}, {}, {}] };
  // Inject the fixed clock so `last_tick_age_ms = nowMs - last_tick_at_ms`
  // matches the fixture without drifting into "89 billion ms ago".
  const { server, tmp } = await bootDashboardServer({
    wallet, risk, loop,
    clock: () => nowMs,
    cfg: { dashboard: { health_utxo_timeout_ms: 2500 } },
  });
  try {
    // Seed two open positions by overwriting the file the boot
    // helper created. Using the high-level `Positions.open()` API
    // would require a full `entry` + `reasoning` envelope, which
    // is more noise than signal for a probe test. The probes
    // only care about `positions.list('open').length`.
    const positionsPath = path.join(tmp, 'positions.json');
    await writeJsonSeed(positionsPath, {
      open: [
        { id: 'pos_seed1', token_id: 'aa'.repeat(32), side: 'long_token', entry_bch: 0.005, status: 'open' },
        { id: 'pos_seed2', token_id: 'bb'.repeat(32), side: 'long_token', entry_bch: 0.004, status: 'open' },
      ],
      closed: [],
      meta: { total_opened: 2, total_closed: 0, created_at: '2026-09-19T00:00:00Z' },
      version: 1,
    });
    // Force the dashboard server to reload the seed (the boot
    // helper pre-cached an empty file).
    await server.ctx.positions.load();
    const res = await supertest(server.handler).get('/healthz').expect(200);
    assert.equal(res.body.schema, HEALTH_SCHEMA);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.loop.tick_count, 17);
    assert.equal(res.body.loop.loop_running, true);
    assert.equal(res.body.loop.last_tick_age_ms, 250);
    assert.equal(res.body.loop.status, 'ok');
    assert.equal(res.body.positions.open_count, 2);
    assert.equal(res.body.positions.status, 'ok');
    assert.equal(res.body.wallet.utxo_count, 4);
    assert.equal(res.body.wallet.utxo_timeout_ms, 2500);
    assert.equal(res.body.wallet.status, 'ok');
    assert.equal(res.body.breaker.is_tripped, true);
    assert.equal(res.body.breaker.trip_kind, 'daily_loss');
    assert.equal(res.body.breaker.consecutive_losses, 1);
    assert.equal(res.body.breaker.recent_daily_pnl_bch, -0.003);
    assert.equal(res.body.breaker.loss_cooldown_remaining_ms, 60_000);
    assert.equal(res.body.breaker.max_daily_loss_bch, 0.005);
    assert.equal(res.body.breaker.status, 'ok');  // trip ≠ health failure.
    assert.deepEqual(res.body.probes, {
      loop: 'ok', positions: 'ok', wallet: 'ok', breaker: 'ok',
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('health: GET /healthz surfaces a slow wallet as degraded without blocking the endpoint', async (t) => {
  const supertest = await importSupertest(t);
  if (!supertest) return;
  // listUtxos resolves after 3 seconds; budget is 150ms (above the
  // 100ms floor in asTimeoutMs but well under the 3s resolution).
  const wallet = {
    listUtxos: () => new Promise((resolve) => setTimeout(() => resolve([{}]), 3000)),
  };
  const { server, tmp } = await bootDashboardServer({ wallet, cfg: { dashboard: { health_utxo_timeout_ms: 150 } } });
  try {
    const start = Date.now();
    const res = await supertest(server.handler).get('/healthz').expect(200);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 1500, `should return well under 3s (actual ${elapsed}ms)`);
    assert.equal(res.body.wallet.status, 'degraded');
    assert.equal(res.body.wallet.utxo_count, null);
    assert.equal(res.body.wallet.utxo_timeout_ms, 150);
    assert.match(res.body.wallet.error, /timed out/);
    // The other probes should still report `unconfigured` without
    // being affected by the wallet timeout.
    assert.equal(res.body.loop.status, 'unconfigured');
    assert.equal(res.body.breaker.status, 'unconfigured');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('health: GET /healthz degrades the loop probe when the bot has been silent for >5min', async (t) => {
  const supertest = await importSupertest(t);
  if (!supertest) return;
  const tenMinAgoMs = Date.now() - (10 * 60 * 1000);
  const loop = {
    stats: () => ({
      running: true,
      tick_count: 7,
      last_tick_at_ms: tenMinAgoMs,
      last_tick_duration_ms: 100,
    }),
  };
  const { server, tmp } = await bootDashboardServer({ loop });
  try {
    const res = await supertest(server.handler).get('/healthz').expect(200);
    assert.equal(res.body.loop.status, 'degraded');
    assert.match(res.body.loop.error, /exceeds stale_loop_age_ms/);
    assert.ok(res.body.loop.last_tick_age_ms > 5 * 60 * 1000);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('health: GET /healthz degrades the positions probe when positions.list throws', async (t) => {
  const supertest = await importSupertest(t);
  if (!supertest) return;
  const { server, tmp } = await bootDashboardServer({});
  try {
    // Sabotage positions.list AFTER boot so the next /healthz call
    // surfaces the degraded state.
    server.ctx.positions.list = async () => { throw new Error('disk read error'); };
    const res = await supertest(server.handler).get('/healthz').expect(200);
    assert.equal(res.body.positions.status, 'degraded');
    assert.equal(res.body.positions.open_count, null);
    assert.match(res.body.positions.error, /disk read error/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('health: GET /healthz degrades the breaker probe when risk.state() throws', async (t) => {
  const supertest = await importSupertest(t);
  if (!supertest) return;
  const risk = { state: () => { throw new Error('breaker offline'); } };
  const { server, tmp } = await bootDashboardServer({ risk });
  try {
    const res = await supertest(server.handler).get('/healthz').expect(200);
    assert.equal(res.body.breaker.status, 'degraded');
    assert.equal(res.body.breaker.is_tripped, null);
    assert.equal(res.body.breaker.trip_kind, null);
    assert.match(res.body.breaker.error, /breaker offline/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
