// tests/dashboard-risk-panel.test.mjs
//
// Unit + HTTP integration tests for the T41 live risk panel
// (`src/dashboard/risk-panel.mjs` + `GET /api/risk-panel`).
//
// Covers:
//   - `readConfigNumber` tolerance (null / number / bigint / string / NaN).
//   - `buildExposure` semantics (current_bch, max_bch, utilization clamp,
//     headroom, position count).
//   - `buildDailyLoss` window filter (default 24h, closed_at vs
//     exit.ts fallback, unparseable skip, limit_breached arithmetic).
//   - `buildDrawdown` peak detection (window cutoff, peak_ts,
//     current balance override, drawdown=0 on the way up).
//   - `buildConcentration` ranking + per-token rollup + wallet-relative
//     pct + hidden-position count.
//   - `buildRiskPanel(ctx)` I/O wrapper (positions / snapshots / wallet /
//     circuit-breaker passthrough).
//   - HTTP integration via supertest: schema, content shape, breaker
//     pass-through when wired, empty-state handling, optional knobs
//     missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';

import {
  buildExposure,
  buildDailyLoss,
  buildDrawdown,
  buildConcentration,
  buildRiskPanel,
  readConfigNumber,
  RiskPanelConfigError,
} from '../src/dashboard/risk-panel.mjs';
import { createDashboardServer, createHistoryReader } from '../src/dashboard/server.mjs';
import { createLogger, createMemorySink } from '../src/util/logger.mjs';
import { SATS_PER_BCH } from '../src/data/types.mjs';
import { Positions } from '../src/portfolio/positions.mjs';
import { Snapshots } from '../src/portfolio/snapshots.mjs';
import supertest from 'supertest';

// ─────────────────────────────────────────────────────────────────────
//  Test helpers
// ─────────────────────────────────────────────────────────────────────

async function makeTmp(t, prefix = 'tradebot-risk-panel-') {
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
 * Three open positions (2 tokens) + 1 closed (with a clean profit)
 * + 1 pending. Matches the shape `positions.list('open'|'pending'|
 * 'closing'|'closed')` returns.
 */
function makeFixturePositions() {
  const openedAt = '2026-09-12T10:00:00Z';
  // Closed inside the I/O-wrapper's 24h window (test freezes now at 2026-09-16T00:00:00Z).
  const closedAt = '2026-09-15T18:00:00Z';
  const open = [
    {
      id: 'pos_open_a',
      token_id: 'a'.repeat(64),
      token_symbol: 'FEW',
      status: 'open',
      opened_at: openedAt,
      updated_at: openedAt,
      entry: {
        txid: 'aa'.repeat(32),
        price_sats_per_token: 1234,
        bch_spent_sats: '500000',
        token_amount_base: '40500000',
        fee_sats: '1000',
        ts: openedAt,
      },
    },
    {
      id: 'pos_open_b',
      token_id: 'b'.repeat(64),
      token_symbol: 'BADGER',
      status: 'open',
      opened_at: openedAt,
      updated_at: openedAt,
      entry: {
        txid: 'bb'.repeat(32),
        price_sats_per_token: 8000,
        bch_spent_sats: '1500000',
        token_amount_base: '18750000',
        fee_sats: '1500',
        ts: openedAt,
      },
    },
  ];
  const pending = [
    {
      id: 'pos_pending_c',
      token_id: 'c'.repeat(64),
      token_symbol: 'QBTC',
      status: 'pending',
      opened_at: openedAt,
      updated_at: openedAt,
      entry: {
        txid: 'cc'.repeat(32),
        price_sats_per_token: 326,
        bch_spent_sats: '500000',
        token_amount_base: '153374233',
        fee_sats: '800',
        ts: openedAt,
      },
    },
  ];
  const closing = [];
  const closed = [
    {
      id: 'pos_closed_d',
      token_id: 'd'.repeat(64),
      token_symbol: 'CLOSED',
      status: 'closed',
      opened_at: '2026-09-13T08:00:00Z',
      closed_at: closedAt,
      updated_at: closedAt,
      entry: {
        txid: 'dd'.repeat(32),
        price_sats_per_token: 1234,
        bch_spent_sats: '49360',
        token_amount_base: '40000',
        fee_sats: '250',
        ts: '2026-09-13T08:00:00Z',
      },
      exit: {
        txid: 'ee'.repeat(32),
        price_sats_per_token: 1357,
        bch_received_sats: '54280',
        fee_sats: '220',
        ts: closedAt,
        reason: 'take_profit',
        realized_pnl_sats: '4450',
      },
    },
  ];
  return { open, pending, closing, closed };
}

/** A circuit-breaker mock returning a static state blob. */
function makeBreaker(stateOverrides = {}) {
  const base = {
    dailyLossTripTsMs: null,
    consecutiveLossesTripTsMs: null,
    stopLossCooldownTripTsMs: null,
    dailyLossCooldownHours: 24,
    consecutiveLossesCooldownHours: 24,
    lossCooldownMinutes: 30,
    maxDailyLossBch: 0.005,
    maxConsecutiveLosses: 3,
    consecutiveLosses: 0,
    recentDailyPnlSats: 0,
    nowMs: Date.now(),
    isTripped: false,
    tripKind: null,
    lossCooldownRemainingMs: 0,
  };
  return { state: () => ({ ...base, ...stateOverrides }) };
}

/**
 * Build a server bound to the given tmp dirs. Same shape as
 * `tests/server.test.mjs#makeServer` so the test patterns are
 * familiar.
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
  };
  if (typeof opts.clock === 'function') serverOpts.clock = opts.clock;
  const server = createDashboardServer(serverOpts);
  return { server, logger, sink, handler: server.handler };
}

// ─────────────────────────────────────────────────────────────────────
//  readConfigNumber
// ─────────────────────────────────────────────────────────────────────

test('risk-panel: readConfigNumber handles null/undefined/missing', () => {
  assert.equal(readConfigNumber(null), null);
  assert.equal(readConfigNumber(undefined), null);
});

test('risk-panel: readConfigNumber handles finite numbers', () => {
  assert.equal(readConfigNumber(0.005), 0.005);
  assert.equal(readConfigNumber(1), 1);
  assert.equal(readConfigNumber(-0.5), -0.5);
});

test('risk-panel: readConfigNumber rejects non-finite numbers', () => {
  assert.equal(readConfigNumber(NaN), null);
  assert.equal(readConfigNumber(Infinity), null);
  assert.equal(readConfigNumber(-Infinity), null);
});

test('risk-panel: readConfigNumber handles bigint + numeric string', () => {
  assert.equal(readConfigNumber(100n), 100);
  assert.equal(readConfigNumber('500'), 500);
  assert.equal(readConfigNumber('not-a-number'), null);
  assert.equal(readConfigNumber(''), null);
});

test('risk-panel: readConfigNumber rejects non-string non-number values', () => {
  assert.equal(readConfigNumber({}), null);
  assert.equal(readConfigNumber([]), null);
  assert.equal(readConfigNumber(true), null);
});

// ─────────────────────────────────────────────────────────────────────
//  buildExposure
// ─────────────────────────────────────────────────────────────────────

test('risk-panel: buildExposure sums open + pending + closing', () => {
  const { open, pending } = makeFixturePositions();
  const cfg = { entry: { max_total_exposure_bch: 0.04 } };
  // 500_000 + 1_500_000 + 500_000 = 2_500_000 sats = 0.025 BCH.
  const out = buildExposure([...open, ...pending], cfg);
  assert.equal(out.current_bch, 0.025);
  assert.equal(out.max_bch, 0.04);
  assert.equal(out.open_position_count, 3);
  assert.equal(out.headroom_bch, 0.04 - 0.025);
  assert.ok(Math.abs(out.utilization - (0.025 / 0.04)) < 1e-9);
});

test('risk-panel: buildExposure utilization clamped to 1.0 when over limit', () => {
  const cfg = { entry: { max_total_exposure_bch: 0.001 } };
  const out = buildExposure(makeFixturePositions().open, cfg);
  assert.equal(out.utilization, 1);
  assert.equal(out.headroom_bch, 0);
});

test('risk-panel: buildExposure utilization is null when max is missing', () => {
  const out = buildExposure(makeFixturePositions().open, {});
  assert.equal(out.utilization, null);
  assert.equal(out.max_bch, null);
  assert.equal(out.headroom_bch, null);
  // Fixture has 2 open positions (FEW 500k + BADGER 1.5M = 2M sats).
  assert.equal(out.current_bch, 0.02);
});

test('risk-panel: buildExposure returns zeros for empty positions', () => {
  const out = buildExposure([], { entry: { max_total_exposure_bch: 0.04 } });
  assert.equal(out.current_bch, 0);
  assert.equal(out.utilization, 0);
  assert.equal(out.open_position_count, 0);
});

test('risk-panel: buildExposure tolerates malformed input', () => {
  const out = buildExposure(null, { entry: { max_total_exposure_bch: 0.04 } });
  assert.equal(out.current_bch, 0);
});

// ─────────────────────────────────────────────────────────────────────
//  buildDailyLoss
// ─────────────────────────────────────────────────────────────────────

test('risk-panel: buildDailyLoss sums realized P&L from positions closed inside window', () => {
  const { closed } = makeFixturePositions();
  const cfg = { risk: { max_daily_loss_bch: 0.005 } };
  const nowMs = Date.parse('2026-09-14T12:00:00Z');
  const out = buildDailyLoss(closed, cfg, 24, nowMs);
  assert.equal(out.lookback_hours, 24);
  assert.equal(out.contributing_positions, 1);
  // 54_280 - 49_360 - 470 = +4_450 sats (small win, well above -0.005 BCH).
  assert.equal(out.realized_pnl_sats, 4450n);
  assert.equal(out.threshold_bch, -0.005);
  assert.equal(out.limit_breached, false);
});

test('risk-panel: buildDailyLoss excludes positions closed outside window', () => {
  // Fixture closes at 2026-09-15T18:00:00Z; freeze now at
  // 2026-09-17T18:00:00Z (48h later) so a 24h window drops it.
  const { closed } = makeFixturePositions();
  const nowMs = Date.parse('2026-09-17T18:00:00Z');
  const out = buildDailyLoss(closed, {}, 24, nowMs);
  assert.equal(out.contributing_positions, 0);
  assert.equal(out.realized_pnl_sats, 0n);
});

test('risk-panel: buildDailyLoss limit_breached=true when realized < threshold', () => {
  const closed = [{
    id: 'loser',
    token_id: 'e'.repeat(64),
    status: 'closed',
    closed_at: '2026-09-14T11:00:00Z',
    opened_at: '2026-09-13T11:00:00Z',
    entry: {
      txid: 'aa'.repeat(32),
      price_sats_per_token: 1000,
      bch_spent_sats: '500000',
      token_amount_base: '50000',
      fee_sats: '1000',
      ts: '2026-09-13T11:00:00Z',
    },
    exit: {
      txid: 'bb'.repeat(32),
      price_sats_per_token: 800,
      bch_received_sats: '300000',
      fee_sats: '1000',
      ts: '2026-09-14T11:00:00Z',
      reason: 'stop_loss',
      realized_pnl_sats: '-201000',
    },
  }];
  const cfg = { risk: { max_daily_loss_bch: 0.005 } };
  const nowMs = Date.parse('2026-09-14T12:00:00Z');
  const out = buildDailyLoss(closed, cfg, 24, nowMs);
  // realized = 300_000 - 500_000 - 2_000 = -202_000 sats. Below -500_000? No.
  // Use a tighter threshold.
  const cfg2 = { risk: { max_daily_loss_bch: 0.001 } };
  const out2 = buildDailyLoss(closed, cfg2, 24, nowMs);
  assert.equal(out2.threshold_bch, -0.001);
  assert.equal(out2.limit_breached, true);
  assert.ok(out2.realized_pnl_sats < 0n);
});

test('risk-panel: buildDailyLoss falls back to exit.ts when closed_at missing', () => {
  const closed = [{
    id: 'no-closed-at',
    token_id: 'f'.repeat(64),
    status: 'closed',
    opened_at: '2026-09-14T11:00:00Z',
    entry: {
      txid: 'aa'.repeat(32),
      price_sats_per_token: 1000,
      bch_spent_sats: '500000',
      token_amount_base: '50000',
      fee_sats: '1000',
      ts: '2026-09-14T11:00:00Z',
    },
    exit: {
      txid: 'bb'.repeat(32),
      price_sats_per_token: 1100,
      bch_received_sats: '550000',
      fee_sats: '1000',
      ts: '2026-09-14T11:30:00Z',
      reason: 'take_profit',
    },
  }];
  const cfg = { risk: { max_daily_loss_bch: 0.005 } };
  const nowMs = Date.parse('2026-09-14T12:00:00Z');
  const out = buildDailyLoss(closed, cfg, 24, nowMs);
  assert.equal(out.contributing_positions, 1);
  assert.equal(out.realized_pnl_sats, 48000n); // 550_000 - 500_000 - 2_000
});

test('risk-panel: buildDailyLoss skips rows with neither closed_at nor exit.ts', () => {
  const closed = [{
    id: 'no-ts',
    token_id: 'a'.repeat(64),
    status: 'closed',
    opened_at: '2026-09-14T11:00:00Z',
    entry: { bch_spent_sats: '500000', fee_sats: '1000' },
    exit: { bch_received_sats: '600000', fee_sats: '1000', reason: 'manual' },
  }];
  const out = buildDailyLoss(closed, { risk: { max_daily_loss_bch: 0.005 } }, 24, Date.parse('2026-09-14T12:00:00Z'));
  assert.equal(out.contributing_positions, 0);
});

test('risk-panel: buildDailyLoss returns zeros when cfg is missing', () => {
  const { closed } = makeFixturePositions();
  const out = buildDailyLoss(closed, null, 24, Date.parse('2026-09-14T12:00:00Z'));
  assert.equal(out.max_loss_bch, null);
  assert.equal(out.threshold_bch, null);
  assert.equal(out.limit_breached, false);
  assert.equal(out.realized_pnl_sats, 4450n);
});

// ─────────────────────────────────────────────────────────────────────
//  buildDrawdown
// ─────────────────────────────────────────────────────────────────────

test('risk-panel: buildDrawdown finds peak in window + reports current', () => {
  const snapshots = [
    { ts: '2026-09-01T00:00:00Z', bch_balance_sats: '5000000' },
    { ts: '2026-09-10T00:00:00Z', bch_balance_sats: '6000000' }, // peak
    { ts: '2026-09-15T00:00:00Z', bch_balance_sats: '4000000' }, // current
  ];
  const nowMs = Date.parse('2026-09-16T00:00:00Z');
  const out = buildDrawdown(snapshots, {}, 30, nowMs);
  assert.equal(out.peak_balance_sats, 6000000n);
  assert.equal(out.peak_ts, '2026-09-10T00:00:00Z');
  assert.equal(out.current_balance_sats, 4000000n);
  assert.equal(out.drawdown_sats, 2000000n);
  // 2_000_000 / 6_000_000 = 33.33%.
  assert.ok(Math.abs(out.drawdown_pct - (2_000_000 / 6_000_000) * 100) < 1e-6);
  assert.equal(out.window_days, 30);
});

test('risk-panel: buildDrawdown uses explicit currentBalanceSats override (live wallet)', () => {
  const snapshots = [
    { ts: '2026-09-10T00:00:00Z', bch_balance_sats: '6000000' }, // peak
    { ts: '2026-09-15T00:00:00Z', bch_balance_sats: '4000000' }, // stale
  ];
  const nowMs = Date.parse('2026-09-16T00:00:00Z');
  const out = buildDrawdown(snapshots, {}, 30, nowMs, 3_000_000n);
  assert.equal(out.current_balance_sats, 3_000_000n);
  assert.equal(out.drawdown_sats, 3_000_000n);
});

test('risk-panel: buildDrawdown excludes snapshots outside window', () => {
  const snapshots = [
    { ts: '2026-08-01T00:00:00Z', bch_balance_sats: '9000000' }, // too old
    { ts: '2026-09-10T00:00:00Z', bch_balance_sats: '6000000' }, // peak in window
    { ts: '2026-09-15T00:00:00Z', bch_balance_sats: '4000000' },
  ];
  const nowMs = Date.parse('2026-09-16T00:00:00Z');
  const out = buildDrawdown(snapshots, {}, 30, nowMs);
  assert.equal(out.peak_balance_sats, 6_000_000n, 'peak from old snapshot excluded');
});

test('risk-panel: buildDrawdown returns 0 drawdown when current >= peak', () => {
  const snapshots = [
    { ts: '2026-09-10T00:00:00Z', bch_balance_sats: '4000000' },
    { ts: '2026-09-15T00:00:00Z', bch_balance_sats: '6000000' }, // new peak
  ];
  const out = buildDrawdown(snapshots, {}, 30, Date.parse('2026-09-16T00:00:00Z'));
  assert.equal(out.drawdown_sats, 0n);
  assert.equal(out.drawdown_pct, 0);
});

test('risk-panel: buildDrawdown handles empty + malformed snapshots', () => {
  const out = buildDrawdown([], {}, 30, Date.parse('2026-09-16T00:00:00Z'));
  assert.equal(out.peak_balance_sats, 0n);
  assert.equal(out.current_balance_sats, 0n);
  assert.equal(out.drawdown_sats, 0n);
  const out2 = buildDrawdown([{}, { ts: 'not-a-date' }], {}, 30, Date.parse('2026-09-16T00:00:00Z'));
  assert.equal(out2.peak_balance_sats, 0n);
});

// ─────────────────────────────────────────────────────────────────────
//  buildConcentration
// ─────────────────────────────────────────────────────────────────────

test('risk-panel: buildConcentration ranks by bch_spent_sats and reports pct', () => {
  const { open, pending } = makeFixturePositions();
  const positions = [...open, ...pending];
  const out = buildConcentration(positions, {}, 5, 4_400_000n);
  assert.equal(out.total_exposure_bch, 0.025);
  // BADGER (1.5M) > FEW (500k) > QBTC (500k) — tie-broken by ts.
  assert.equal(out.top_positions[0].token_symbol, 'BADGER');
  assert.equal(out.top_positions[0].position_id, 'pos_open_b');
  // 1_500_000 / 2_500_000 = 60% of exposure.
  assert.ok(Math.abs(out.top_positions[0].pct_of_exposure - 60) < 1e-6);
  // 1_500_000 / 4_400_000 = ~34.09% of wallet.
  assert.ok(Math.abs(out.top_positions[0].pct_of_wallet - (1_500_000 / 4_400_000) * 100) < 1e-6);
  assert.equal(out.hidden_position_count, 0);
});

test('risk-panel: buildConcentration topN caps + hidden_position_count', () => {
  const { open, pending } = makeFixturePositions();
  const positions = [...open, ...pending];
  const out = buildConcentration(positions, {}, 2);
  assert.equal(out.top_positions.length, 2);
  assert.equal(out.hidden_position_count, 1);
});

test('risk-panel: buildConcentration filters out zero-cost positions (e.g. on-chain-synced)', () => {
  const positions = [
    {
      id: 'pos_zero',
      token_id: 'a'.repeat(64),
      token_symbol: 'SYNC',
      status: 'open',
      opened_at: '2026-09-12T10:00:00Z',
      entry: { bch_spent_sats: '0', fee_sats: '0', ts: '2026-09-12T10:00:00Z' },
    },
    {
      id: 'pos_real',
      token_id: 'b'.repeat(64),
      token_symbol: 'REAL',
      status: 'open',
      opened_at: '2026-09-12T10:00:00Z',
      entry: { bch_spent_sats: '500000', fee_sats: '1000', ts: '2026-09-12T10:00:00Z' },
    },
  ];
  const out = buildConcentration(positions, {}, 5);
  assert.equal(out.top_positions.length, 1);
  assert.equal(out.top_positions[0].token_symbol, 'REAL');
});

test('risk-panel: buildConcentration pct_of_wallet is null when no wallet provided', () => {
  const out = buildConcentration(makeFixturePositions().open, {}, 5, null);
  assert.equal(out.top_positions[0].pct_of_wallet, null);
  assert.equal(out.wallet_balance_bch, null);
});

test('risk-panel: buildConcentration computes per_token_bch rollup', () => {
  const { open, pending } = makeFixturePositions();
  const positions = [...open, ...pending];
  const out = buildConcentration(positions, {}, 5);
  // FEW (0.005) + BADGER (0.015) + QBTC (0.005) = 0.025 total.
  // Grouped by token_id: 0.005, 0.015, 0.005.
  assert.equal(Object.keys(out.per_token_bch).length, 3);
});

// ─────────────────────────────────────────────────────────────────────
//  buildRiskPanel I/O wrapper
// ─────────────────────────────────────────────────────────────────────

test('risk-panel: buildRiskPanel throws RiskPanelConfigError on null ctx', async () => {
  await assert.rejects(buildRiskPanel(null), RiskPanelConfigError);
});

test('risk-panel: buildRiskPanel assembles wire envelope from positions + snapshots', async () => {
  const { open, pending, closing, closed } = makeFixturePositions();
  const ctx = {
    cfg: {
      entry: { max_total_exposure_bch: 0.04 },
      risk: { max_daily_loss_bch: 0.005 },
    },
    positions: {
      list: async (status) => {
        if (status === 'open') return open;
        if (status === 'pending') return pending;
        if (status === 'closing') return closing;
        if (status === 'closed') return closed;
        throw new Error(`unexpected status ${status}`);
      },
    },
    snapshots: {
      readBack: async () => ({
        records: [
          { ts: '2026-09-10T00:00:00Z', bch_balance_sats: '6000000' },
          { ts: '2026-09-15T00:00:00Z', bch_balance_sats: '4000000' },
        ],
        errors: [],
        total: 2,
      }),
    },
    wallet: { getBalanceSats: async () => 4_400_000n },
    risk: makeBreaker({ isTripped: false }),
    clock: () => Date.parse('2026-09-16T00:00:00Z'),
    logger: createLogger({ sink: process.stderr }),
  };
  const out = await buildRiskPanel(ctx);
  assert.equal(out.schema, 'tradebot.dashboard.risk-panel/v1');
  assert.equal(out.exposure.current_bch, 0.025);
  assert.equal(out.exposure.max_bch, 0.04);
  assert.equal(out.daily_loss.realized_pnl_sats, '4450');
  assert.equal(out.drawdown.peak_balance_sats, '6000000');
  assert.equal(out.drawdown.current_balance_sats, '4400000');
  assert.equal(out.concentration.total_exposure_bch, 0.025);
  assert.equal(out.concentration.wallet_balance_bch, 0.044);
  assert.equal(out.circuit_breaker.maxDailyLossBch, 0.005);
  // All values serialized as bigint-as-string for JSON safety.
  assert.equal(typeof out.daily_loss.realized_pnl_sats, 'string');
  assert.equal(typeof out.drawdown.peak_balance_sats, 'string');
  assert.equal(typeof out.drawdown.current_balance_sats, 'string');
  assert.equal(typeof out.drawdown.drawdown_sats, 'string');
  // Top position's bch_spent_sats is also a string.
  assert.equal(typeof out.concentration.top_positions[0].bch_spent_sats, 'string');
});

test('risk-panel: buildRiskPanel tolerates missing snapshots dir (ENOENT)', async () => {
  const { open, pending, closing, closed } = makeFixturePositions();
  const e = new Error('noent');
  e.code = 'ENOENT';
  const ctx = {
    cfg: {},
    positions: {
      list: async (status) => status === 'open' ? open : status === 'pending' ? pending : status === 'closing' ? closing : closed,
    },
    snapshots: { readBack: async () => { throw e; } },
    wallet: null,
    risk: null,
    clock: () => Date.parse('2026-09-16T00:00:00Z'),
    logger: createLogger({ sink: process.stderr }),
  };
  const out = await buildRiskPanel(ctx);
  assert.equal(out.drawdown.peak_balance_sats, '0');
  assert.equal(out.circuit_breaker, null);
});

test('risk-panel: buildRiskPanel tolerates wallet.getBalanceSats failure', async () => {
  const { open, pending, closing, closed } = makeFixturePositions();
  const ctx = {
    cfg: {},
    positions: {
      list: async (status) => status === 'open' ? open : status === 'pending' ? pending : status === 'closing' ? closing : closed,
    },
    snapshots: { readBack: async () => ({ records: [], errors: [], total: 0 }) },
    wallet: { getBalanceSats: async () => { throw new Error('electrum offline'); } },
    risk: null,
    clock: () => Date.parse('2026-09-16T00:00:00Z'),
    logger: createLogger({ sink: process.stderr }),
  };
  const out = await buildRiskPanel(ctx);
  assert.equal(out.concentration.wallet_balance_bch, null);
  assert.equal(out.drawdown.current_balance_sats, '0');
});

test('risk-panel: buildRiskPanel tolerates breaker.state() failure', async () => {
  const { open, pending, closing, closed } = makeFixturePositions();
  const ctx = {
    cfg: {},
    positions: {
      list: async (status) => status === 'open' ? open : status === 'pending' ? pending : status === 'closing' ? closing : closed,
    },
    snapshots: { readBack: async () => ({ records: [], errors: [], total: 0 }) },
    wallet: null,
    risk: { state: () => { throw new Error('breaker broken'); } },
    clock: () => Date.parse('2026-09-16T00:00:00Z'),
    logger: createLogger({ sink: process.stderr }),
  };
  const out = await buildRiskPanel(ctx);
  assert.equal(out.circuit_breaker, null);
});

// ─────────────────────────────────────────────────────────────────────
//  HTTP integration: GET /api/risk-panel
// ─────────────────────────────────────────────────────────────────────

async function makeFixturePositionsOnDisk(t) {
  const dir = await makeTmp(t, 'tradebot-risk-panel-pos-');
  const file = path.join(dir, 'positions.json');
  const positions = new Positions({ file, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const ts = new Date('2026-09-12T10:00:00Z').toISOString();
  const a = await positions.open({
    tokenId: 'a'.repeat(64),
    tokenSymbol: 'FEW',
    tokenDecimals: 8,
    entry: {
      txid: 'aa'.repeat(32),
      price_sats_per_token: 1234,
      bch_spent_sats: 500_000,
      token_amount_base: '40500000',
      fee_sats: 1000,
      ts,
    },
    reasoning: { score: 0.8, rank: 1, topK: 3, reason: 'test fixture', ts },
    initialStatus: 'open',
  });
  await positions.confirm(a.id);
  const b = await positions.open({
    tokenId: 'b'.repeat(64),
    tokenSymbol: 'BADGER',
    tokenDecimals: 4,
    entry: {
      txid: 'bb'.repeat(32),
      price_sats_per_token: 8000,
      bch_spent_sats: 1_500_000,
      token_amount_base: '18750000',
      fee_sats: 1500,
      ts,
    },
    reasoning: { score: 0.7, rank: 2, topK: 3, reason: 'test fixture', ts },
    initialStatus: 'open',
  });
  await positions.confirm(b.id);
  // Closed position for daily-loss tile.
  const c = await positions.open({
    tokenId: 'c'.repeat(64),
    tokenSymbol: 'WINNER',
    tokenDecimals: 2,
    entry: {
      txid: 'cc'.repeat(32),
      price_sats_per_token: 1234,
      bch_spent_sats: 49_360,
      token_amount_base: '40000',
      fee_sats: 250,
      ts: '2026-09-15T08:00:00Z',
    },
    reasoning: { score: 0.6, rank: 3, topK: 3, reason: 'test fixture', ts: '2026-09-15T08:00:00Z' },
    initialStatus: 'open',
  });
  await positions.confirm(c.id);
  await positions.close(c.id, {
    txid: 'dd'.repeat(32),
    price_sats_per_token: 1357,
    bch_received_sats: 54_280,
    fee_sats: 220,
    ts: '2026-09-15T18:00:00Z',
    reason: 'take_profit',
  }, 54_280 - 49_360 - 470);
  return positions;
}

async function makeFixtureSnapshotsOnDisk(t) {
  const dir = await makeTmp(t, 'tradebot-risk-panel-snap-');
  const snapshots = new Snapshots({ dir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  await snapshots.record({
    v: 1,
    ts: '2026-09-01T00:00:00Z',
    bch_balance_sats: '5000000',
    open_position_count: 0,
    total_exposure_sats: '0',
    unrealized_pnl_sats: null,
    meta: {},
  });
  await snapshots.record({
    v: 1,
    ts: '2026-09-10T00:00:00Z',
    bch_balance_sats: '6000000',
    open_position_count: 0,
    total_exposure_sats: '0',
    unrealized_pnl_sats: null,
    meta: {},
  });
  await snapshots.record({
    v: 1,
    ts: '2026-09-15T00:00:00Z',
    bch_balance_sats: '4000000',
    open_position_count: 2,
    total_exposure_sats: '2000000',
    unrealized_pnl_sats: null,
    meta: {},
  });
  return snapshots;
}

async function writeHistory(file, events = []) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

test('server: GET /api/risk-panel returns the panel envelope', async (t) => {
  const positions = await makeFixturePositionsOnDisk(t);
  const snapshots = await makeFixtureSnapshotsOnDisk(t);
  const dir = path.dirname(snapshots.dir);
  const histFile = path.join(dir, 'history.ndjson');
  await writeHistory(histFile, []);
  const historyReader = createHistoryReader({ file: histFile });
  const cfg = {
    dashboard: {},
    paths: { positions_file: '', snapshots_dir: snapshots.dir },
    entry: { max_total_exposure_bch: 0.04 },
    risk: { max_daily_loss_bch: 0.005 },
  };
  const FROZEN_NOW_MS = Date.parse('2026-09-16T00:00:00Z');
  const { server } = makeServer({
    cfg,
    positions,
    snapshots,
    historyReader,
    risk: makeBreaker(),
    clock: () => FROZEN_NOW_MS,
  });
  const res = await supertest(server.handler).get('/api/risk-panel').expect(200);
  assert.equal(res.body.schema, 'tradebot.dashboard.risk-panel/v1');
  // Exposure: 500k + 1.5M = 2_000_000 sats = 0.02 BCH.
  assert.equal(res.body.exposure.current_bch, 0.02);
  assert.equal(res.body.exposure.max_bch, 0.04);
  assert.equal(res.body.exposure.open_position_count, 2);
  // Daily loss: 4_450 sats realized on the closed WINNER trade.
  assert.equal(res.body.daily_loss.realized_pnl_sats, '4450');
  // Drawdown: peak 6M at 2026-09-10, current 4M (latest snapshot) = 2M drawdown.
  assert.equal(res.body.drawdown.peak_balance_sats, '6000000');
  assert.equal(res.body.drawdown.peak_ts, '2026-09-10T00:00:00Z');
  assert.equal(res.body.drawdown.current_balance_sats, '4000000');
  assert.equal(res.body.drawdown.drawdown_sats, '2000000');
  // Concentration: BADGER first (1.5M > 500k).
  assert.equal(res.body.concentration.top_positions[0].token_symbol, 'BADGER');
  // Circuit-breaker pass-through.
  assert.equal(res.body.circuit_breaker.maxDailyLossBch, 0.005);
});

test('server: GET /api/risk-panel with wallet wired uses live balance', async (t) => {
  const positions = await makeFixturePositionsOnDisk(t);
  const snapshots = await makeFixtureSnapshotsOnDisk(t);
  const dir = path.dirname(snapshots.dir);
  const histFile = path.join(dir, 'history.ndjson');
  await writeHistory(histFile, []);
  const historyReader = createHistoryReader({ file: histFile });
  const cfg = { dashboard: {}, paths: { positions_file: '', snapshots_dir: snapshots.dir } };
  const wallet = { getBalanceSats: async () => 3_500_000n };
  const { server } = makeServer({ cfg, positions, snapshots, historyReader, wallet });
  const res = await supertest(server.handler).get('/api/risk-panel').expect(200);
  assert.equal(res.body.drawdown.current_balance_sats, '3500000');
  assert.equal(res.body.concentration.wallet_balance_bch, 0.035);
});

test('server: GET /api/risk-panel with breaker tripped surfaces limit_breached + breaker state', async (t) => {
  const positions = await makeFixturePositionsOnDisk(t);
  const snapshots = await makeFixtureSnapshotsOnDisk(t);
  const dir = path.dirname(snapshots.dir);
  const histFile = path.join(dir, 'history.ndjson');
  await writeHistory(histFile, []);
  const historyReader = createHistoryReader({ file: histFile });
  const cfg = {
    dashboard: {},
    paths: { positions_file: '', snapshots_dir: snapshots.dir },
    risk: { max_daily_loss_bch: 0.005 },
  };
  const breaker = makeBreaker({
    isTripped: true,
    tripKind: 'daily_loss',
    dailyLossTripTsMs: Date.parse('2026-09-16T00:00:00Z'),
    recentDailyPnlSats: -800_000,
  });
  const { server } = makeServer({ cfg, positions, snapshots, historyReader, risk: breaker });
  const res = await supertest(server.handler).get('/api/risk-panel').expect(200);
  assert.equal(res.body.circuit_breaker.isTripped, true);
  assert.equal(res.body.circuit_breaker.tripKind, 'daily_loss');
});

test('server: GET /api/risk-panel handles empty positions + empty snapshots', async (t) => {
  const dir = await makeTmp(t);
  const positionsFile = path.join(dir, 'p.json');
  const positions = new Positions({ file: positionsFile, logger: createLogger({ sink: process.stderr }) });
  await positions.load();
  const snapshotsDir = path.join(dir, 's');
  const snapshots = new Snapshots({ dir: snapshotsDir, logger: createLogger({ sink: process.stderr }) });
  await snapshots.load();
  const histFile = path.join(dir, 'h.ndjson');
  await writeHistory(histFile, []);
  const historyReader = createHistoryReader({ file: histFile });
  const cfg = {
    dashboard: {},
    paths: { positions_file: positionsFile, snapshots_dir: snapshotsDir },
    entry: { max_total_exposure_bch: 0.04 },
    risk: { max_daily_loss_bch: 0.005 },
  };
  const { server } = makeServer({ cfg, positions, snapshots, historyReader });
  const res = await supertest(server.handler).get('/api/risk-panel').expect(200);
  assert.equal(res.body.exposure.current_bch, 0);
  assert.equal(res.body.exposure.utilization, 0);
  assert.equal(res.body.exposure.open_position_count, 0);
  assert.equal(res.body.daily_loss.realized_pnl_sats, '0');
  assert.equal(res.body.daily_loss.contributing_positions, 0);
  assert.equal(res.body.drawdown.peak_balance_sats, '0');
  assert.equal(res.body.concentration.total_exposure_bch, 0);
  assert.equal(res.body.concentration.top_positions.length, 0);
});

test('server: GET /api/risk-panel treats max_daily_loss_bch=0 as opt-out', async (t) => {
  const positions = await makeFixturePositionsOnDisk(t);
  const snapshots = await makeFixtureSnapshotsOnDisk(t);
  const dir = path.dirname(snapshots.dir);
  const histFile = path.join(dir, 'history.ndjson');
  await writeHistory(histFile, []);
  const historyReader = createHistoryReader({ file: histFile });
  const cfg = {
    dashboard: {},
    paths: { positions_file: '', snapshots_dir: snapshots.dir },
    risk: { max_daily_loss_bch: 0 },
  };
  const { server } = makeServer({ cfg, positions, snapshots, historyReader });
  const res = await supertest(server.handler).get('/api/risk-panel').expect(200);
  // 0 is treated as "operator opted out" — same opt-out pattern as
  // T32/T33. threshold_bch=null means limit_breached can never trip.
  assert.equal(res.body.daily_loss.threshold_bch, null);
  assert.equal(res.body.daily_loss.limit_breached, false);
});