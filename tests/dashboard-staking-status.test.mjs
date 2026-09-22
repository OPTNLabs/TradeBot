// tests/dashboard-staking-status.test.mjs
//
// T58 subset 4 — unit + HTTP integration tests for the staking
// status endpoint (`src/dashboard/staking-status.mjs` +
// `GET /api/staking/status`).
//
// Covers:
//   - `asBool` truthiness contract (literal true/false only;
//     type-coerced strings stay default).
//   - `asNonNegInt` tolerance (number / string / NaN / negative).
//   - `stakeBlocksToApproxDays` math + null fallback.
//   - `buildLockNftSummaries` shape contract (txid / vout /
//     value_sats / value_bch / stake_blocks /
//     stake_blocks_approx_days / user_pkh_hex).
//   - `filterStakeAlerts` kind whitelist + newest-first ordering.
//   - `summarizeKnobs` default-when-missing + boolean coercion.
//   - `buildStakingStatusResponse` schema envelope + defaults.
//   - `fetchLockNftUtxos` graceful degrade (no wallet, throw,
//     non-array, no lockNFT-shaped UTXO, single lockNFT, multiple).
//   - `loadStakeAlertsTail` ENOENT-clean + kind-filter + cap.
//   - `buildStakingStatus(ctx)` end-to-end (wallet wired +
//     alerts file wired → full envelope).
//   - HTTP integration via supertest: schema, content shape,
//     graceful degrade when wallet is not wired, alerts tail,
//     knob passthrough.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';

import {
  asBool,
  asNonNegInt,
  stakeBlocksToApproxDays,
  buildLockNftSummaries,
  filterStakeAlerts,
  summarizeKnobs,
  buildStakingStatusResponse,
  fetchLockNftUtxos,
  loadStakeAlertsTail,
  buildStakingStatus,
  buildLockMaturity,
  summarizeLockMaturities,
  graceSecondsToBlocks,
  withCachedTipHeight,
  resetTipHeightCache,
  tipHeightSeverity,
  BCH_BLOCKS_PER_DAY,
  DEFAULT_TIP_HEIGHT_CACHE_MS,
  DEFAULT_LOCK_GRACE_SECONDS,
  MATURITY_MATURE,
  MATURITY_PREMATURE,
  MATURITY_NEVER,
  MATURITY_UNKNOWN,
  STAKING_STATUS_SCHEMA,
  DEFAULT_STAKING_ALERTS_FILE,
  STAKE_ALERT_KINDS,
  StakingStatusConfigError,
} from '../src/dashboard/staking-status.mjs';
import { createDashboardServer } from '../src/dashboard/server.mjs';
import { createLogger, createMemorySink } from '../src/util/logger.mjs';
import { Positions } from '../src/portfolio/positions.mjs';
import { Snapshots } from '../src/portfolio/snapshots.mjs';

// ─── Fixtures ──────────────────────────────────────────────────────────

const MASTER_CAT = 'd7ff0a63d5c1cbe1ced509314fe3caca563a73095be37734744c40dbce6e2f24';

function makeCommitment({ userPkhHex = '11'.repeat(20), stakeBlocks = 1440 } = {}) {
  // 40 bytes = 80 hex: userPkh[20] + reserved[18] + stakeBlocks[2 BE].
  const reserved = '00'.repeat(18);
  const sb = stakeBlocks & 0xffff;
  const sbHex = sb.toString(16).padStart(4, '0');
  return userPkhHex + reserved + sbHex;
}

function makeLockNftUtxo({ value = 500_000, txid = 'aa'.repeat(32), vout = 0, userPkhHex, stakeBlocks } = {}) {
  return {
    txid,
    vout,
    value,
    satoshis: value,
    token: {
      category: MASTER_CAT,
      amount: '0',
      capability: 'mutable',
      commitment: makeCommitment({ userPkhHex, stakeBlocks }),
    },
  };
}

// ─── asBool ────────────────────────────────────────────────────────────

test('staking-status: asBool returns true only for literal true', () => {
  assert.equal(asBool(true, false), true);
  assert.equal(asBool(false, true), false);
});

test('staking-status: asBool falls back to default for non-boolean', () => {
  assert.equal(asBool(null, false), false);
  assert.equal(asBool(undefined, false), false);
  assert.equal(asBool(0, true), true); // 0 is not literal false
  assert.equal(asBool(1, false), false); // 1 is not literal true
  assert.equal(asBool('true', false), false); // type-coerced strings stay default
  assert.equal(asBool('false', true), true);
  assert.equal(asBool({}, true), true);
  assert.equal(asBool([], false), false);
});

// ─── asNonNegInt ───────────────────────────────────────────────────────

test('staking-status: asNonNegInt accepts finite non-negative integers', () => {
  assert.equal(asNonNegInt(0), 0);
  assert.equal(asNonNegInt(1440), 1440);
  assert.equal(asNonNegInt('2880'), 2880);
});

test('staking-status: asNonNegInt rejects NaN / negative / float / non-numeric', () => {
  assert.equal(asNonNegInt(NaN), 0);
  assert.equal(asNonNegInt(-1), 0);
  assert.equal(asNonNegInt(1.5), 0);
  assert.equal(asNonNegInt('1.5'), 0);
  assert.equal(asNonNegInt('not-a-number'), 0);
  assert.equal(asNonNegInt(null), 0);
  assert.equal(asNonNegInt(undefined), 0);
  assert.equal(asNonNegInt({}), 0);
});

// ─── stakeBlocksToApproxDays ───────────────────────────────────────────

test('staking-status: stakeBlocksToApproxDays divides by 144 and rounds', () => {
  assert.equal(stakeBlocksToApproxDays(144), 1);
  assert.equal(stakeBlocksToApproxDays(1440), 10);
  assert.equal(stakeBlocksToApproxDays(1008), 7);
  assert.equal(stakeBlocksToApproxDays(72), 0.5);
});

test('staking-status: stakeBlocksToApproxDays returns null on bad input', () => {
  assert.equal(stakeBlocksToApproxDays(null), null);
  assert.equal(stakeBlocksToApproxDays(undefined), null);
  assert.equal(stakeBlocksToApproxDays(NaN), null);
  assert.equal(stakeBlocksToApproxDays(0), null);
  assert.equal(stakeBlocksToApproxDays(-1), null);
  assert.equal(stakeBlocksToApproxDays('not-a-number'), null);
});

// ─── buildLockNftSummaries ─────────────────────────────────────────────

test('staking-status: buildLockNftSummaries returns [] for non-array', () => {
  assert.deepEqual(buildLockNftSummaries(null), []);
  assert.deepEqual(buildLockNftSummaries(undefined), []);
  assert.deepEqual(buildLockNftSummaries('not-array'), []);
});

test('staking-status: buildLockNftSummaries skips non-object entries', () => {
  assert.deepEqual(buildLockNftSummaries([null, undefined, 'x', 5]), []);
});

test('staking-status: buildLockNftSummaries projects a well-formed lockNFT', () => {
  const lockUtxo = makeLockNftUtxo({ value: 500_000, txid: 'bb'.repeat(32), vout: 2, userPkhHex: '33'.repeat(20), stakeBlocks: 1440 });
  const [row] = buildLockNftSummaries([lockUtxo]);
  assert.equal(row.txid, 'bb'.repeat(32));
  assert.equal(row.vout, 2);
  assert.equal(row.value_sats, '500000');
  assert.equal(row.value_bch, 0.005);
  assert.equal(row.stake_blocks, 1440);
  assert.equal(row.stake_blocks_approx_days, 10);
  assert.equal(row.user_pkh_hex, '33'.repeat(20));
});

test('staking-status: buildLockNftSummaries falls back to null on malformed commitment', () => {
  const bad = makeLockNftUtxo({ value: 500_000 });
  bad.token.commitment = 'aa'.repeat(20); // wrong length → decode throws
  const [row] = buildLockNftSummaries([bad]);
  assert.equal(row.stake_blocks, null);
  assert.equal(row.stake_blocks_approx_days, null);
  assert.equal(row.user_pkh_hex, null);
  assert.equal(row.value_bch, 0.005);
});

test('staking-status: buildLockNftSummaries tolerates missing vout / txid', () => {
  const utxo = makeLockNftUtxo();
  delete utxo.vout;
  delete utxo.txid;
  const [row] = buildLockNftSummaries([utxo]);
  assert.equal(row.txid, '');
  assert.equal(row.vout, 0);
});

// ─── filterStakeAlerts ─────────────────────────────────────────────────

test('staking-status: filterStakeAlerts keeps only stake kinds', () => {
  const events = [
    { ts: 1, kind: 'stake_locked', title: 'lock' },
    { ts: 2, kind: 'stake_unlock', title: 'unlock' },
    { ts: 3, kind: 'stake_failed', title: 'fail' },
    { ts: 4, kind: 'risk_threshold', title: 'risk' },
    { ts: 5, kind: 'slippage_spike', title: 'slip' },
    { ts: 6, kind: 'unrelated', title: 'misc' },
    { ts: 7, kind: null, title: 'no-kind' },
    null,
  ];
  const out = filterStakeAlerts(events);
  assert.equal(out.length, 3);
  // Newest-first: stake_failed (ts=3) → stake_unlock (ts=2) → stake_locked (ts=1).
  assert.deepEqual(out.map((e) => e.kind), ['stake_failed', 'stake_unlock', 'stake_locked']);
});

test('staking-status: filterStakeAlerts tolerates non-array', () => {
  assert.deepEqual(filterStakeAlerts(null), []);
  assert.deepEqual(filterStakeAlerts({}), []);
  assert.deepEqual(filterStakeAlerts('events'), []);
});

test('staking-status: filterStakeAlerts parses string timestamps', () => {
  const events = [
    { kind: 'stake_locked', ts: '2026-09-19T10:00:00.000Z' },
    { kind: 'stake_locked', ts: '2026-09-19T11:00:00.000Z' },
  ];
  const out = filterStakeAlerts(events);
  // Newer first.
  assert.equal(out.length, 2);
  assert.equal(out[0].ts, '2026-09-19T11:00:00.000Z');
});

// ─── summarizeKnobs ────────────────────────────────────────────────────

test('staking-status: summarizeKnobs defaults all to safe values when missing', () => {
  const k = summarizeKnobs({});
  assert.equal(k.enabled, false);
  assert.equal(k.simulation_only, true); // safe default — bot won't fire live
  assert.equal(k.auto_lock_enabled, false);
  assert.equal(k.auto_unlock_enabled, false);
});

test('staking-status: summarizeKnobs tolerates null / non-object cfg', () => {
  assert.deepEqual(summarizeKnobs(null), {
    enabled: false, simulation_only: true, auto_lock_enabled: false, auto_unlock_enabled: false,
  });
  assert.deepEqual(summarizeKnobs(undefined), {
    enabled: false, simulation_only: true, auto_lock_enabled: false, auto_unlock_enabled: false,
  });
});

test('staking-status: summarizeKnobs projects the live values', () => {
  const k = summarizeKnobs({
    staking: {
      enabled: true,
      simulation_only: false,
      auto_lock_enabled: true,
      auto_unlock_enabled: false,
    },
  });
  assert.equal(k.enabled, true);
  assert.equal(k.simulation_only, false);
  assert.equal(k.auto_lock_enabled, true);
  assert.equal(k.auto_unlock_enabled, false);
});

// ─── buildStakingStatusResponse ────────────────────────────────────────

test('staking-status: buildStakingStatusResponse shapes the schema envelope', () => {
  const r = buildStakingStatusResponse({
    nowMs: 1_700_000_000_000,
    walletConfigured: true,
    lockNfts: { count: 1, total_bch: 0.005, total_bch_sats: '500000', items: [{ txid: 'aa', vout: 0, value_sats: '500000', value_bch: 0.005, stake_blocks: 1440, stake_blocks_approx_days: 10, user_pkh_hex: '11'.repeat(20) }], error: null },
    knobs: { enabled: true, simulation_only: false, auto_lock_enabled: true, auto_unlock_enabled: false },
    recentAlerts: [{ ts: 1_700_000_000_000, kind: 'stake_locked', severity: 'info', title: 'lock', body: 'x', context: {} }],
    loadErrors: [],
    alertsSource: 'data/alerts.jsonl',
  });
  assert.equal(r.schema, STAKING_STATUS_SCHEMA);
  assert.equal(r.ts, new Date(1_700_000_000_000).toISOString());
  assert.equal(r.wallet_configured, true);
  assert.equal(r.lockNfts.count, 1);
  assert.equal(r.knobs.enabled, true);
  assert.equal(r.recent_alerts.length, 1);
  assert.equal(r.recent_alerts_source, 'data/alerts.jsonl');
  assert.deepEqual(r.load_errors, []);
});

test('staking-status: buildStakingStatusResponse defaults to safe values on missing parts', () => {
  const r = buildStakingStatusResponse({ nowMs: 1_700_000_000_000 });
  assert.equal(r.schema, STAKING_STATUS_SCHEMA);
  assert.equal(r.wallet_configured, false);
  assert.equal(r.lockNfts.count, 0);
  assert.equal(r.lockNfts.error, null);
  assert.equal(r.knobs.enabled, false);
  assert.deepEqual(r.recent_alerts, []);
});

// ─── fetchLockNftUtxos ─────────────────────────────────────────────────

test('staking-status: fetchLockNftUtxos returns wallet_not_configured when wallet is missing', async () => {
  const sink = createMemorySink();
  const logger = createLogger({ component: 'test', sink });
  const r = await fetchLockNftUtxos(null, logger);
  assert.equal(r.count, 0);
  assert.equal(r.total_bch_sats, '0');
  assert.equal(r.error, 'wallet_not_configured');
});

test('staking-status: fetchLockNftUtxos returns wallet_utxo_lookup_failed when listUtxos throws', async () => {
  const sink = createMemorySink();
  const logger = createLogger({ component: 'test', sink });
  const wallet = { listUtxos: async () => { throw new Error('electrum down'); } };
  const r = await fetchLockNftUtxos(wallet, logger);
  assert.equal(r.count, 0);
  assert.match(r.error, /wallet_utxo_lookup_failed/);
});

test('staking-status: fetchLockNftUtxos returns defensive error when listUtxos returns non-array', async () => {
  const sink = createMemorySink();
  const logger = createLogger({ component: 'test', sink });
  const wallet = { listUtxos: async () => 'oops' };
  const r = await fetchLockNftUtxos(wallet, logger);
  assert.equal(r.error, 'wallet_listUtxos_returned_non_array');
});

test('staking-status: fetchLockNftUtxos filters down to lockNFT-shaped UTXOs', async () => {
  const sink = createMemorySink();
  const logger = createLogger({ component: 'test', sink });
  const lockA = makeLockNftUtxo({ value: 500_000, txid: 'aa'.repeat(32), vout: 0 });
  const lockB = makeLockNftUtxo({ value: 1_000_000, txid: 'bb'.repeat(32), vout: 1, userPkhHex: '44'.repeat(20), stakeBlocks: 2880 });
  const wallet = { listUtxos: async () => [
    lockA,
    lockB,
    // Plain BCH UTXO — no token, should be ignored.
    { txid: 'cc'.repeat(32), vout: 0, value: 100_000 },
    // Different token category — should be ignored.
    { txid: 'dd'.repeat(32), vout: 0, value: 100_000, token: { category: 'ff'.repeat(32), amount: '1', capability: 'mutable', commitment: makeCommitment() } },
    // Minting-capability masterBadger UTXO — should be ignored (not lockNFT).
    { txid: 'ee'.repeat(32), vout: 0, value: 100_000, token: { category: MASTER_CAT, amount: '1000', capability: 'minting', commitment: makeCommitment() } },
    null,
  ] };
  const r = await fetchLockNftUtxos(wallet, logger);
  assert.equal(r.count, 2);
  assert.equal(r.total_bch_sats, '1500000');
  assert.equal(r.total_bch, 0.015);
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].stake_blocks, 1440);
  assert.equal(r.items[1].stake_blocks, 2880);
  assert.equal(r.items[1].stake_blocks_approx_days, 20);
});

// ─── loadStakeAlertsTail ───────────────────────────────────────────────

test('staking-status: loadStakeAlertsTail returns empty tail on ENOENT', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'stake-alerts-'));
  try {
    const r = await loadStakeAlertsTail({ file: path.join(tmp, 'missing.jsonl') });
    assert.deepEqual(r.alerts, []);
    assert.deepEqual(r.loadErrors, []);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('staking-status: loadStakeAlertsTail filters by kind + caps by max', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'stake-alerts-'));
  try {
    const file = path.join(tmp, 'alerts.jsonl');
    const lines = [];
    for (let i = 0; i < 25; i += 1) {
      lines.push(JSON.stringify({ ts: 1_700_000_000_000 + i * 1000, kind: i % 2 === 0 ? 'stake_locked' : 'risk_threshold', severity: 'info', title: `e${i}`, body: 'b', context: {} }));
    }
    await writeFile(file, lines.join('\n') + '\n');
    const r = await loadStakeAlertsTail({ file, max: 10 });
    assert.equal(r.alerts.length, 10);
    // Newest first → all even indexes from 24 down to 6 (13 stake events, capped at 10).
    assert.equal(r.alerts[0].title, 'e24');
    for (const e of r.alerts) {
      assert.equal(e.kind, 'stake_locked');
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ─── buildStakingStatus (I/O wrapper) ──────────────────────────────────

test('staking-status: buildStakingStatus throws on missing ctx / cfg', async () => {
  await assert.rejects(() => buildStakingStatus(null), StakingStatusConfigError);
  await assert.rejects(() => buildStakingStatus({}), StakingStatusConfigError);
});

test('staking-status: buildStakingStatus composes the envelope when wallet + alerts file are wired', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'stake-status-'));
  try {
    const alertsFile = path.join(tmp, 'alerts.jsonl');
    await writeFile(alertsFile, JSON.stringify({ ts: 1_700_000_000_000, kind: 'stake_locked', severity: 'info', title: 'lock', body: 'b', context: { txid: 'aa'.repeat(32), amount_sats: '500000' } }) + '\n');
    const sink = createMemorySink();
    const logger = createLogger({ component: 'test', sink });
    const wallet = { listUtxos: async () => [makeLockNftUtxo({ value: 500_000, txid: 'aa'.repeat(32), vout: 0 })] };
    const r = await buildStakingStatus({
      cfg: { staking: { enabled: true, simulation_only: false, auto_lock_enabled: true, auto_unlock_enabled: false } },
      wallet,
      alertsFile,
      alertsMax: 10,
      clock: () => 1_700_000_001_000,
      logger,
    });
    assert.equal(r.schema, STAKING_STATUS_SCHEMA);
    assert.equal(r.wallet_configured, true);
    assert.equal(r.lockNfts.count, 1);
    assert.equal(r.lockNfts.total_bch_sats, '500000');
    assert.equal(r.lockNfts.items[0].stake_blocks, 1440);
    assert.equal(r.knobs.enabled, true);
    assert.equal(r.knobs.auto_lock_enabled, true);
    assert.equal(r.recent_alerts.length, 1);
    assert.equal(r.recent_alerts[0].kind, 'stake_locked');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('staking-status: buildStakingStatus gracefully degrades when wallet is missing', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'stake-status-'));
  try {
    const sink = createMemorySink();
    const logger = createLogger({ component: 'test', sink });
    const r = await buildStakingStatus({
      cfg: {},
      wallet: null,
      alertsFile: path.join(tmp, 'missing.jsonl'),
      clock: () => 1_700_000_001_000,
      logger,
    });
    assert.equal(r.wallet_configured, false);
    assert.equal(r.lockNfts.error, 'wallet_not_configured');
    assert.equal(r.lockNfts.count, 0);
    assert.equal(r.recent_alerts.length, 0);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ─── HTTP integration via supertest ────────────────────────────────────

async function bootDashboardServer({ cfg, wallet, alertsFile }) {
  const positions = new Positions();
  const snapshots = new Snapshots();
  const logger = createLogger({ component: 'test', sink: createMemorySink() });
  return createDashboardServer({
    cfg,
    positions,
    snapshots,
    historyReader: { read: async () => [] },
    wallet: wallet ?? null,
    alertsFile,
    staticRoot: null,
    logger,
  });
}

test('staking-status: GET /api/staking/status returns the schema envelope (no wallet wired)', async (t) => {
  const supertest = await import('supertest').catch(() => null);
  if (!supertest) {
    t.skip('supertest not installed — skipping HTTP integration');
    return;
  }
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'stake-status-http-'));
  try {
    const alertsFile = path.join(tmp, 'alerts.jsonl');
    const server = await bootDashboardServer({
      cfg: { staking: { enabled: true, simulation_only: true, auto_lock_enabled: false, auto_unlock_enabled: false } },
      wallet: null,
      alertsFile,
    });
    const res = await supertest.default(server.handler)
      .get('/api/staking/status');
    assert.equal(res.status, 200);
    assert.equal(res.body.schema, STAKING_STATUS_SCHEMA);
    assert.equal(res.body.wallet_configured, false);
    assert.equal(res.body.lockNfts.count, 0);
    assert.equal(res.body.lockNfts.error, 'wallet_not_configured');
    assert.equal(res.body.knobs.enabled, true);
    assert.equal(res.body.knobs.simulation_only, true);
    assert.equal(res.body.knobs.auto_lock_enabled, false);
    assert.deepEqual(res.body.recent_alerts, []);
    assert.equal(res.body.recent_alerts_source, alertsFile);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('staking-status: GET /api/staking/status returns lockNFTs + alerts when wallet is wired', async (t) => {
  const supertest = await import('supertest').catch(() => null);
  if (!supertest) {
    t.skip('supertest not installed — skipping HTTP integration');
    return;
  }
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'stake-status-http-'));
  try {
    const alertsFile = path.join(tmp, 'alerts.jsonl');
    await writeFile(alertsFile, JSON.stringify({ ts: 1_700_000_000_000, kind: 'stake_locked', severity: 'info', title: 'lock', body: 'b', context: { txid: 'aa'.repeat(32), amount_sats: '500000' } }) + '\n');
    const lockUtxo = makeLockNftUtxo({ value: 500_000, txid: 'aa'.repeat(32), vout: 0 });
    const wallet = { listUtxos: async () => [lockUtxo] };
    const server = await bootDashboardServer({
      cfg: { staking: { enabled: true, simulation_only: false, auto_lock_enabled: true, auto_unlock_enabled: false } },
      wallet,
      alertsFile,
    });
    const res = await supertest.default(server.handler)
      .get('/api/staking/status');
    assert.equal(res.status, 200);
    assert.equal(res.body.wallet_configured, true);
    assert.equal(res.body.lockNfts.count, 1);
    assert.equal(res.body.lockNfts.total_bch_sats, '500000');
    assert.equal(res.body.lockNfts.items[0].stake_blocks, 1440);
    assert.equal(res.body.recent_alerts.length, 1);
    assert.equal(res.body.recent_alerts[0].kind, 'stake_locked');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('staking-status: STAKE_ALERT_KINDS matches the subset 3 dispatch contract', () => {
  assert.deepEqual([...STAKE_ALERT_KINDS].sort(), ['stake_failed', 'stake_locked', 'stake_unlock']);
});

test('staking-status: DEFAULT_STAKING_ALERTS_FILE points at data/alerts.jsonl', () => {
  assert.equal(DEFAULT_STAKING_ALERTS_FILE, 'data/alerts.jsonl');
});

// ─── T58 subset 6: graceSecondsToBlocks ───────────────────────────────────

test('staking-status: graceSecondsToBlocks matches the trader-loop math (Math.ceil(sec/600))', () => {
  assert.equal(graceSecondsToBlocks(0), 0);
  assert.equal(graceSecondsToBlocks(60), 1);   // 60s -> 1 block
  assert.equal(graceSecondsToBlocks(599), 1);  // 599s -> 1 block (ceil)
  assert.equal(graceSecondsToBlocks(600), 1);  // 600s -> 1 block
  assert.equal(graceSecondsToBlocks(601), 2);  // 601s -> 2 blocks (ceil)
  assert.equal(graceSecondsToBlocks(1200), 2);
  assert.equal(graceSecondsToBlocks(3600), 6);
});

test('staking-status: graceSecondsToBlocks is defensive about bad input', () => {
  assert.equal(graceSecondsToBlocks(null), 0);
  assert.equal(graceSecondsToBlocks(undefined), 0);
  assert.equal(graceSecondsToBlocks(NaN), 0);
  assert.equal(graceSecondsToBlocks(-10), 0);
  assert.equal(graceSecondsToBlocks('not a number'), 0);
  assert.equal(graceSecondsToBlocks('60'), 1); // numeric string is coerced
});

// ─── T58 subset 6: buildLockMaturity ─────────────────────────────────────────

test('staking-status: buildLockMaturity returns mature when blocksElapsed >= stakeBlocks+graceBlocks', () => {
  // 1440-block stake, locked 100 blocks ago, grace 60s (1 block).
  const m = buildLockMaturity({ stakeBlocks: 1440, lockBlockHeight: 100, tipHeight: 100 + 1440 + 1, graceBlocks: 1 });
  assert.equal(m.maturity, MATURITY_MATURE);
  assert.equal(m.blocks_remaining, 0);
  assert.equal(m.approx_seconds_remaining, 0);
  assert.ok(m.percent_complete >= 1, `percent_complete should be >=1, got ${m.percent_complete}`);
});

test('staking-status: buildLockMaturity returns premature when blocksRemaining > 0', () => {
  const m = buildLockMaturity({ stakeBlocks: 1440, lockBlockHeight: 100, tipHeight: 200, graceBlocks: 1 });
  assert.equal(m.maturity, MATURITY_PREMATURE);
  assert.equal(m.next_mature_block, 100 + 1440 + 1);
  assert.equal(m.blocks_remaining, (100 + 1440 + 1) - 200);
  // ~10.025 days remaining at 144 blocks/day.
  assert.ok(m.approx_seconds_remaining > 800_000, `approx_seconds_remaining should be ~860k, got ${m.approx_seconds_remaining}`);
  // ~7% complete (100 elapsed out of 1441 needed).
  assert.ok(m.percent_complete > 0.05 && m.percent_complete < 0.1, `percent_complete should be ~0.07, got ${m.percent_complete}`);
});

test('staking-status: buildLockMaturity returns never when tip is below lock_block_height', () => {
  const m = buildLockMaturity({ stakeBlocks: 1440, lockBlockHeight: 1000, tipHeight: 500, graceBlocks: 1 });
  assert.equal(m.maturity, MATURITY_NEVER);
  assert.equal(m.percent_complete, 0);
  assert.ok(m.blocks_remaining > 0, 'blocks_remaining should still be positive in the never bucket');
});

test('staking-status: buildLockMaturity treats stakeBlocks=0 as immediately mature', () => {
  const m = buildLockMaturity({ stakeBlocks: 0, lockBlockHeight: 100, tipHeight: 105, graceBlocks: 1 });
  assert.equal(m.maturity, MATURITY_MATURE);
  assert.equal(m.percent_complete, 1);
  assert.equal(m.blocks_remaining, 0);
});

test('staking-status: buildLockMaturity returns unknown when inputs are missing', () => {
  const a = buildLockMaturity({ stakeBlocks: null, lockBlockHeight: 100, tipHeight: 200 });
  assert.equal(a.maturity, MATURITY_UNKNOWN);
  assert.equal(a.next_mature_block, null);
  const b = buildLockMaturity({ stakeBlocks: 1440, lockBlockHeight: null, tipHeight: 200 });
  assert.equal(b.maturity, MATURITY_UNKNOWN);
  const c = buildLockMaturity({ stakeBlocks: 1440, lockBlockHeight: 100, tipHeight: null });
  assert.equal(c.maturity, MATURITY_UNKNOWN);
});

test('staking-status: buildLockMaturity is defensive about bad inputs', () => {
  assert.equal(buildLockMaturity({ stakeBlocks: -10, lockBlockHeight: 100, tipHeight: 200 }).maturity, MATURITY_UNKNOWN);
  assert.equal(buildLockMaturity({ stakeBlocks: 1440, lockBlockHeight: -1, tipHeight: 200 }).maturity, MATURITY_UNKNOWN);
  assert.equal(buildLockMaturity({ stakeBlocks: 1440, lockBlockHeight: 100, tipHeight: -1 }).maturity, MATURITY_UNKNOWN);
  assert.equal(buildLockMaturity({ stakeBlocks: 1440.5, lockBlockHeight: 100, tipHeight: 200 }).maturity, MATURITY_UNKNOWN); // non-integer stake
  // Numeric string `stakeBlocks='100'` should coerce to 100; tip=150 is 50 blocks past the lock start
  // (50 elapsed out of 100 needed) → premature.
  assert.equal(buildLockMaturity({ stakeBlocks: '100', lockBlockHeight: 100, tipHeight: 150 }).maturity, MATURITY_PREMATURE); // numeric string coerces
});

test('staking-status: buildLockMaturity clamps negative graceBlocks to 0', () => {
  const m = buildLockMaturity({ stakeBlocks: 100, lockBlockHeight: 50, tipHeight: 150, graceBlocks: -5 });
  assert.equal(m.maturity, MATURITY_MATURE); // 100 elapsed >= 100+0
});

test('staking-status: buildLockMaturity respects custom blocksPerDay', () => {
  // 144 blocks/day is the default; with blocksPerDay=288 the
  // approx_seconds_remaining should halve.
  const a = buildLockMaturity({ stakeBlocks: 1440, lockBlockHeight: 100, tipHeight: 200, graceBlocks: 0, blocksPerDay: 144 });
  const b = buildLockMaturity({ stakeBlocks: 1440, lockBlockHeight: 100, tipHeight: 200, graceBlocks: 0, blocksPerDay: 288 });
  assert.ok(a.approx_seconds_remaining > b.approx_seconds_remaining, `a (${a.approx_seconds_remaining}) should be > b (${b.approx_seconds_remaining})`);
  // 600s/block is the default — both should land at multiples of 600.
  assert.equal(a.approx_seconds_remaining % 600, 0);
});

test('staking-status: buildLockMaturity honors BCH_BLOCKS_PER_DAY=144 default', () => {
  assert.equal(BCH_BLOCKS_PER_DAY, 144);
});

// ─── T58 subset 6: summarizeLockMaturities ──────────────────────────────────

test('staking-status: summarizeLockMaturities maps over items and decorates each with maturity', () => {
  const items = [
    { txid: 'aa'.repeat(32), vout: 0, stake_blocks: 1440, lock_block_height: 100 }, // premature (tip 100)
    { txid: 'bb'.repeat(32), vout: 1, stake_blocks: 100, lock_block_height: 100, value_bch: 0.005 }, // mature (tip 300 > nextMature 201)
    { txid: 'cc'.repeat(32), vout: 0, stake_blocks: 1440, lock_block_height: 2000 }, // never (tip 300 < lock 2000)
  ];
  const out = summarizeLockMaturities({ items, tipHeight: 300, graceSeconds: 60 });
  assert.equal(out.length, 3);
  assert.equal(out[0].maturity, MATURITY_PREMATURE);
  assert.equal(out[0].next_mature_block, 100 + 1440 + 1);
  assert.equal(out[1].maturity, MATURITY_MATURE);
  assert.equal(out[2].maturity, MATURITY_NEVER);
});

test('staking-status: summarizeLockMaturities returns unknown for items missing maturity inputs', () => {
  const items = [
    { txid: 'aa'.repeat(32), vout: 0, stake_blocks: null, lock_block_height: null },
    { txid: 'bb'.repeat(32), vout: 0 }, // both missing
  ];
  const out = summarizeLockMaturities({ items, tipHeight: 100 });
  assert.equal(out[0].maturity, MATURITY_UNKNOWN);
  assert.equal(out[1].maturity, MATURITY_UNKNOWN);
  assert.equal(out[0].next_mature_block, null);
});

test('staking-status: summarizeLockMaturities handles empty / non-array / null tip', () => {
  assert.deepEqual(summarizeLockMaturities({ items: [], tipHeight: 100 }), []);
  assert.deepEqual(summarizeLockMaturities({ items: null, tipHeight: 100 }), []);
  assert.deepEqual(summarizeLockMaturities({ items: undefined, tipHeight: 100 }), []);
  const items = [{ txid: 'aa'.repeat(32), vout: 0, stake_blocks: 1440, lock_block_height: 100 }];
  // null tipHeight → every row should get maturity:'unknown'.
  const out = summarizeLockMaturities({ items, tipHeight: null });
  assert.equal(out[0].maturity, MATURITY_UNKNOWN);
});

test('staking-status: summarizeLockMaturities tolerates bad item entries', () => {
  const items = [null, undefined, {}, 'not an object', 42, { txid: 'aa'.repeat(32), vout: 0, stake_blocks: 1440, lock_block_height: 100 }];
  const out = summarizeLockMaturities({ items, tipHeight: 200 });
  assert.equal(out.length, 6);
  assert.equal(out[0].maturity, MATURITY_UNKNOWN);
  assert.equal(out[4].maturity, MATURITY_UNKNOWN);
  assert.equal(out[5].maturity, MATURITY_PREMATURE);
});

test('staking-status: summarizeLockMaturities honors custom graceSeconds + blocksPerDay', () => {
  const items = [{ txid: 'aa'.repeat(32), vout: 0, stake_blocks: 100, lock_block_height: 100 }];
  const a = summarizeLockMaturities({ items, tipHeight: 150, graceSeconds: 0 });     // needs 100 elapsed; tip is 50 past
  const b = summarizeLockMaturities({ items, tipHeight: 150, graceSeconds: 600 });  // grace = 1 block; tip only 49 past; still premature
  // With graceSeconds=0, blocksElapsed=50 < stakeBlocks=100 → premature with 50 remaining.
  assert.equal(a[0].maturity, MATURITY_PREMATURE);
  assert.equal(a[0].blocks_remaining, 50);
  // With graceSeconds=600, grace=1 block, needs 101 elapsed; tip is only 50 past → premature with 51 remaining.
  assert.equal(b[0].maturity, MATURITY_PREMATURE);
  assert.equal(b[0].blocks_remaining, 51);
});

// ─── T58 subset 6: withCachedTipHeight ──────────────────────────────────────

test('staking-status: withCachedTipHeight fetches on cold cache', async () => {
  resetTipHeightCache();
  let calls = 0;
  const fetcher = async () => { calls += 1; return 826142; };
  const r = await withCachedTipHeight({ wallet: null, getTipHeight: fetcher, nowMs: 1_700_000_000_000 });
  assert.equal(calls, 1);
  assert.equal(r.tipHeight, 826142);
  assert.equal(r.source, 'fresh');
  assert.equal(r.ageMs, 0);
  assert.equal(r.fetchedAtMs, 1_700_000_000_000);
});

test('staking-status: withCachedTipHeight returns cache hit within TTL', async () => {
  resetTipHeightCache();
  let calls = 0;
  const fetcher = async () => { calls += 1; return 826142; };
  await withCachedTipHeight({ wallet: null, getTipHeight: fetcher, nowMs: 1_700_000_000_000 });
  const r2 = await withCachedTipHeight({ wallet: null, getTipHeight: fetcher, nowMs: 1_700_000_000_000 + 5_000 });
  assert.equal(calls, 1, 'fetcher should NOT be called within TTL');
  assert.equal(r2.source, 'cache');
  assert.equal(r2.tipHeight, 826142);
  assert.equal(r2.ageMs, 5_000);
});

test('staking-status: withCachedTipHeight re-fetches after TTL expires', async () => {
  resetTipHeightCache();
  let calls = 0;
  let height = 826142;
  const fetcher = async () => { calls += 1; return ++height; };
  await withCachedTipHeight({ wallet: null, getTipHeight: fetcher, nowMs: 1_700_000_000_000, cacheMs: 10_000 });
  const r2 = await withCachedTipHeight({ wallet: null, getTipHeight: fetcher, nowMs: 1_700_000_000_000 + 11_000, cacheMs: 10_000 });
  assert.equal(calls, 2, 'fetcher should be called again after TTL expiry');
  assert.equal(r2.source, 'fresh');
  // First call: height=826142 -> ++height=826143 (returned). Second call: ++height=826144 (returned).
  assert.equal(r2.tipHeight, 826144);
});

test('staking-status: withCachedTipHeight falls back to wallet.getBlockHeight() when no fetcher injected', async () => {
  resetTipHeightCache();
  let calls = 0;
  const wallet = { getBlockHeight: async () => { calls += 1; return 826142; } };
  const r = await withCachedTipHeight({ wallet, nowMs: 1_700_000_000_000 });
  assert.equal(calls, 1);
  assert.equal(r.tipHeight, 826142);
  assert.equal(r.source, 'fresh');
});

test('staking-status: withCachedTipHeight returns unavailable when no fetcher + no wallet.getBlockHeight', async () => {
  resetTipHeightCache();
  const r = await withCachedTipHeight({ wallet: null, nowMs: 1_700_000_000_000 });
  assert.equal(r.source, 'unavailable');
  assert.equal(r.tipHeight, null);
  assert.equal(r.error, 'tip_height_fetcher_unavailable');
});

test('staking-status: withCachedTipHeight keeps the stale tip on fetcher throw', async () => {
  resetTipHeightCache();
  // First call: cache populates.
  await withCachedTipHeight({ wallet: null, getTipHeight: async () => 826142, nowMs: 1_700_000_000_000 });
  // Second call: TTL elapsed + fetcher throws — should return the
  // stale tip + an 'unavailable' envelope.
  const r = await withCachedTipHeight({
    wallet: null,
    getTipHeight: async () => { throw new Error('electrum down'); },
    nowMs: 1_700_000_000_000 + 60_000,
    cacheMs: 30_000,
  });
  assert.equal(r.source, 'unavailable');
  assert.equal(r.tipHeight, 826142, 'stale tip must be preserved');
  assert.ok(r.error.includes('tip_height_fetch_failed:electrum down'));
});

test('staking-status: withCachedTipHeight invalidates cache when fetcher returns non-integer / negative', async () => {
  resetTipHeightCache();
  // Cold cache + fetcher returns a non-integer height — should NOT populate the cache.
  await withCachedTipHeight({ wallet: null, getTipHeight: async () => -5, nowMs: 1_700_000_000_000 });
  const r = await withCachedTipHeight({ wallet: null, getTipHeight: async () => -5, nowMs: 1_700_000_000_000 + 5_000 });
  assert.equal(r.source, 'unavailable', 'non-integer should not be cached');
  assert.ok(r.error.includes('tip_height_invalid'));
});

test('staking-status: withCachedTipHeight invalidates cache when fetcher returns NaN / null', async () => {
  resetTipHeightCache();
  const r1 = await withCachedTipHeight({ wallet: null, getTipHeight: async () => NaN, nowMs: 1_700_000_000_000 });
  assert.equal(r1.source, 'unavailable');
  const r2 = await withCachedTipHeight({ wallet: null, getTipHeight: async () => null, nowMs: 1_700_000_000_000 + 100 });
  assert.equal(r2.source, 'unavailable');
  assert.ok(r2.error.includes('tip_height_invalid'));
});

test('staking-status: withCachedTipHeight resetTipHeightCache clears between tests', async () => {
  await withCachedTipHeight({ wallet: null, getTipHeight: async () => 826142, nowMs: 1_700_000_000_000 });
  resetTipHeightCache();
  let calls = 0;
  const r = await withCachedTipHeight({ wallet: null, getTipHeight: async () => { calls += 1; return 999; }, nowMs: 1_700_000_000_000 });
  assert.equal(calls, 1, 'cache should be empty after reset');
  assert.equal(r.tipHeight, 999);
});

// ─── T58 subset 6: tipHeightSeverity ─────────────────────────────────────

test('staking-status: tipHeightSeverity returns fresh / stale / unavailable / unknown', () => {
  assert.equal(tipHeightSeverity(null), 'unknown');
  assert.equal(tipHeightSeverity({ source: 'fresh' }), 'fresh');
  assert.equal(tipHeightSeverity({ source: 'unavailable' }), 'unavailable');
  assert.equal(tipHeightSeverity({ source: 'cache', ageMs: 5_000 }, 60_000), 'fresh');
  assert.equal(tipHeightSeverity({ source: 'cache', ageMs: 60_000 }, 60_000), 'stale');
  assert.equal(tipHeightSeverity({ source: 'cache', ageMs: 100_000 }, 60_000), 'stale');
  assert.equal(tipHeightSeverity({ source: 'unknown' }), 'unknown');
});

test('staking-status: DEFAULT_TIP_HEIGHT_CACHE_MS is 30s and DEFAULT_LOCK_GRACE_SECONDS is 60', () => {
  assert.equal(DEFAULT_TIP_HEIGHT_CACHE_MS, 30_000);
  assert.equal(DEFAULT_LOCK_GRACE_SECONDS, 60);
});

// ─── T58 subset 6: buildStakingStatus end-to-end with wallet + tip-height ───────────────────────

test('staking-status: buildStakingStatus composes tip-height envelope when wallet.getBlockHeight is wired', async () => {
  resetTipHeightCache();
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'stake-status-tip-'));
  try {
    const alertsFile = path.join(tmp, 'alerts.jsonl');
    await writeFile(alertsFile, '');
    const lockUtxo = makeLockNftUtxo({ value: 500_000, txid: 'aa'.repeat(32), vout: 0, stakeBlocks: 1440 });
    // Inject lockBlockHeight so the maturity calc can compute.
    lockUtxo.lockBlockHeight = 800000;
    const wallet = {
      listUtxos: async () => [lockUtxo],
      getBlockHeight: async () => 800100,
    };
    const cfg = {
      staking: {
        enabled: true,
        simulation_only: false,
        auto_lock_enabled: true,
        auto_unlock_enabled: false,
        lock_unlock_grace_seconds: 60,
        dashboard_tip_height_cache_ms: 30_000,
      },
    };
    const r = await buildStakingStatus({
      cfg,
      wallet,
      alertsFile,
      clock: () => 1_700_000_000_000,
      tipHeightCacheMs: 30_000,
      logger: null,
    });
    assert.equal(r.tip_height, 800100);
    assert.equal(r.tip_height_source, 'fresh');
    assert.equal(r.tip_height_age_ms, 0);
    assert.equal(r.tip_height_fetched_at, '2023-11-14T22:13:20.000Z');
    assert.equal(r.tip_height_error, null);
    assert.equal(r.lockNfts.items[0].maturity, MATURITY_PREMATURE);
    assert.equal(r.lockNfts.items[0].lock_block_height, 800000);
    assert.ok(r.lockNfts.items[0].blocks_remaining > 0, 'should still be premature (only 100 blocks elapsed, 1440 needed)');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('staking-status: buildStakingStatus surfaces tip_height=unavailable when wallet has no getBlockHeight', async () => {
  resetTipHeightCache();
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'stake-status-tip-no-'));
  try {
    const alertsFile = path.join(tmp, 'alerts.jsonl');
    await writeFile(alertsFile, '');
    const lockUtxo = makeLockNftUtxo({ value: 500_000, txid: 'aa'.repeat(32), vout: 0, stakeBlocks: 1440 });
    lockUtxo.lockBlockHeight = 800000;
    const wallet = { listUtxos: async () => [lockUtxo] }; // no getBlockHeight
    const cfg = { staking: { enabled: true } };
    const r = await buildStakingStatus({
      cfg,
      wallet,
      alertsFile,
      clock: () => 1_700_000_000_000,
      logger: null,
    });
    assert.equal(r.tip_height, null);
    assert.equal(r.tip_height_source, 'unavailable');
    assert.equal(r.tip_height_error, 'tip_height_fetcher_unavailable');
    // Items should still be decorated with maturity:unknown.
    assert.equal(r.lockNfts.items[0].maturity, MATURITY_UNKNOWN);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('staking-status: buildStakingStatus marks lockNFT mature when blocksElapsed >= stakeBlocks+grace', async () => {
  resetTipHeightCache();
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'stake-status-mature-'));
  try {
    const alertsFile = path.join(tmp, 'alerts.jsonl');
    await writeFile(alertsFile, '');
    const lockUtxo = makeLockNftUtxo({ value: 500_000, txid: 'aa'.repeat(32), vout: 0, stakeBlocks: 100 });
    lockUtxo.lockBlockHeight = 800000;
    const wallet = {
      listUtxos: async () => [lockUtxo],
      getBlockHeight: async () => 800200, // 200 blocks elapsed vs 100-block stake + 1-block grace
    };
    const cfg = { staking: { enabled: true, lock_unlock_grace_seconds: 60 } };
    const r = await buildStakingStatus({
      cfg,
      wallet,
      alertsFile,
      clock: () => 1_700_000_000_000,
      logger: null,
    });
    assert.equal(r.lockNfts.items[0].maturity, MATURITY_MATURE);
    assert.equal(r.lockNfts.items[0].blocks_remaining, 0);
    assert.equal(r.lockNfts.items[0].percent_complete, 1);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('staking-status: buildStakingStatus re-uses cached tip height across requests', async () => {
  resetTipHeightCache();
  let calls = 0;
  const wallet = {
    listUtxos: async () => [],
    getBlockHeight: async () => { calls += 1; return 826142; },
  };
  const cfg = { staking: { enabled: true } };
  // First call — populates cache.
  const r1 = await buildStakingStatus({ cfg, wallet, clock: () => 1_700_000_000_000, alertsFile: '/tmp/no-such-alerts.jsonl', logger: null });
  assert.equal(r1.tip_height_source, 'fresh');
  assert.equal(calls, 1);
  // Second call within TTL — should hit cache, NOT call getBlockHeight.
  const r2 = await buildStakingStatus({ cfg, wallet, clock: () => 1_700_000_000_000 + 5_000, alertsFile: '/tmp/no-such-alerts.jsonl', logger: null });
  assert.equal(r2.tip_height_source, 'cache');
  assert.equal(r2.tip_height, 826142);
  assert.equal(calls, 1, 'getBlockHeight should not be called again within TTL');
});

test('staking-status: buildStakingStatusResponse carries tip-height fields through the envelope', () => {
  const r = buildStakingStatusResponse({
    nowMs: 1_700_000_000_000,
    walletConfigured: true,
    lockNfts: { count: 0, total_bch: 0, total_bch_sats: '0', items: [], error: null },
    knobs: { enabled: false, simulation_only: true, auto_lock_enabled: false, auto_unlock_enabled: false },
    recentAlerts: [],
    loadErrors: [],
    tipHeight: { tipHeight: 826142, fetchedAtMs: 1_700_000_000_000 - 14_000, ageMs: 14_000, source: 'cache', error: null },
  });
  assert.equal(r.tip_height, 826142);
  assert.equal(r.tip_height_source, 'cache');
  assert.equal(r.tip_height_age_ms, 14_000);
  assert.equal(r.tip_height_error, null);
  assert.equal(r.tip_height_fetched_at, new Date(1_700_000_000_000 - 14_000).toISOString());
});

test('staking-status: buildStakingStatusResponse defaults tip-height fields when not supplied', () => {
  const r = buildStakingStatusResponse({
    nowMs: 1_700_000_000_000,
    walletConfigured: false,
    lockNfts: { count: 0, total_bch: 0, total_bch_sats: '0', items: [], error: null },
    knobs: { enabled: false, simulation_only: true, auto_lock_enabled: false, auto_unlock_enabled: false },
    recentAlerts: [],
    loadErrors: [],
  });
  assert.equal(r.tip_height, null);
  assert.equal(r.tip_height_source, 'unavailable');
  assert.equal(r.tip_height_error, null);
});
