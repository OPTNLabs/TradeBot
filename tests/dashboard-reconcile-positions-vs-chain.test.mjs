#!/usr/bin/env node
/**
 * tests/dashboard-reconcile-positions-vs-chain.test.mjs
 *
 * T47: integration tests for the `/api/reconcile/positions-vs-chain`
 * dashboard route. Mirrors the structure of `dashboard-trade-history.test.mjs`
 * (pure helper coverage + supertest-driven route handler coverage) so
 * the dashboard endpoint stays locked to the same contract the CLI
 * exposes (and vice versa — both go through `diffPositionsVsChain`).
 *
 * Run with:
 *   node --test tests/dashboard-reconcile-positions-vs-chain.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import supertest from 'supertest';

import {
  createDashboardServer,
} from '../src/dashboard/server.mjs';

import {
  RECONCILE_REPORT_VERSION,
} from '../src/reconcile/positions-vs-chain.mjs';

// ─────────────────────────────────────────────────────────────────────
//  Fixtures
// ─────────────────────────────────────────────────────────────────────

const CAT_FEW = 'a'.repeat(64);   // pos_tlbiuvh6_0002 case
const CAT_OLA = 'b'.repeat(64);
const CAT_NWB = 'c'.repeat(64);

function makeOpenPosition(overrides = {}) {
  return {
    id: overrides.id ?? 'pos_open_0001',
    token_id: overrides.token_id ?? CAT_FEW,
    token_symbol: overrides.token_symbol ?? 'FEW',
    status: 'open',
    side: 'long_token',
    opened_at: '2026-09-15T10:00:00.000Z',
    updated_at: '2026-09-15T10:00:00.000Z',
    entry: {
      txid: '1'.repeat(64),
      ts: '2026-09-15T10:00:00.000Z',
      bch_in: '2000000',
      tokens_in: overrides.tokens_in ?? '100',
      token_amount_base: overrides.token_amount_base ?? '100',
      price_sats: '20000',
      ...overrides.entry,
    },
    ...overrides,
  };
}

function makeUtxo({ category, amount, satoshis = 1000n }) {
  if (category === null) {
    return { txid: 'f'.repeat(64), vout: 0, satoshis };
  }
  return {
    txid: 'f'.repeat(64),
    vout: 0,
    satoshis,
    token: { category, amount: typeof amount === 'bigint' ? amount : BigInt(amount) },
  };
}

function makeCtx({ positions = [], utxos = [], positionsList, wallet } = {}) {
  const positionsAdapter = positionsList ?? {
    async list(bucket) {
      if (bucket === 'open') return positions;
      return [];
    },
  };
  const walletAdapter = wallet ?? { async listUtxos() { return utxos; } };
  return {
    cfg: {},
    positions: positionsAdapter,
    wallet: walletAdapter,
    snapshots: { async readBack() { return { records: [], errors: [], total: 0 }; } },
    historyReader: { async read() { return { events: [], errors: [] }; } },
    logger: {
      info() {}, warn() {}, error() {}, debug() {},
      child() { return this; },
    },
  };
}

function makeHandler(opts) {
  const server = createDashboardServer(makeCtx(opts));
  return server.handler;
}

async function getJson(handler, path) {
  const res = await supertest(handler).get(path);
  return { status: res.status, body: res.body };
}

// ─────────────────────────────────────────────────────────────────────
//  Envelope / schema contract
// ─────────────────────────────────────────────────────────────────────

test('dashboard reconcile pvc: envelope shape carries schema + version + ts + summary + findings', async () => {
  const handler = makeHandler({ positions: [], utxos: [] });
  const { status, body } = await getJson(handler, '/api/reconcile/positions-vs-chain');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.schema, 'tradebot.dashboard.reconcile.pvc/v1');
  assert.equal(body.version, RECONCILE_REPORT_VERSION);
  assert.match(body.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  // Empty positions + empty UTXOs emits TWO notes: no_open_positions AND no_bch.
  // (The dashboard framework returns HTTP 200 with a typed error in the body
  // when ctx.dependencies are missing — that's the same pattern as
  // `/api/token/:tokenId` when bcmrClient is absent. See tests/server.test.mjs
  // #2126-2134. The `status` field on the body is a UI hint, NOT the HTTP
  // status code.)
  assert.equal(body.summary.open_positions, 0);
  assert.equal(body.summary.on_chain_tokens, 0);
  assert.equal(body.summary.high, 0);
  assert.equal(body.summary.medium, 0);
  assert.equal(body.summary.low, 2);
  assert.equal(body.findings.length, 2);
  assert.ok(body.findings.some((f) => f.kind === 'note' && f.details?.reason === 'no_open_positions'));
  assert.ok(body.findings.some((f) => f.kind === 'note' && f.details?.reason === 'no_bch'));
});

test('dashboard reconcile pvc: trailing slash variant hits the same handler', async () => {
  const handler = makeHandler({ positions: [], utxos: [] });
  const { status, body } = await getJson(handler, '/api/reconcile/positions-vs-chain/');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.schema, 'tradebot.dashboard.reconcile.pvc/v1');
});

// ─────────────────────────────────────────────────────────────────────
//  Error envelopes
// ─────────────────────────────────────────────────────────────────────

test('dashboard reconcile pvc: typed error body when ctx.wallet is missing', async () => {
  // The dashboard framework returns HTTP 200 with a typed `error`
  // field in the body when a route handler signals "dependency
  // missing" (matches the `/api/token/:tokenId` precedent for
  // bcmrClient-not-wired). The frontend uses `body.ok` + `body.error`
  // for routing, not the HTTP status.
  const server = createDashboardServer({
    cfg: {},
    positions: { async list() { return []; } },
    wallet: null,
    snapshots: { async readBack() { return { records: [], errors: [], total: 0 }; } },
    historyReader: { async read() { return { events: [], errors: [] }; } },
    logger: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } },
  });
  const res = await supertest(server.handler).get('/api/reconcile/positions-vs-chain');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error, 'wallet_not_configured');
  assert.equal(res.body.status, 503);
});

test('dashboard reconcile pvc: typed error body when wallet.listUtxos throws', async () => {
  const handler = makeHandler({
    wallet: { async listUtxos() { throw new Error('electrum offline'); } },
  });
  const res = await supertest(handler).get('/api/reconcile/positions-vs-chain');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error, 'wallet_utxo_lookup_failed');
  assert.equal(res.body.status, 502);
});

test('dashboard reconcile pvc: typed error body when positions.list throws', async () => {
  const handler = makeHandler({
    positionsList: { async list() { throw new Error('positions.json malformed'); } },
  });
  const res = await supertest(handler).get('/api/reconcile/positions-vs-chain');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error, 'positions_read_failed');
  assert.equal(res.body.status, 502);
});

// ─────────────────────────────────────────────────────────────────────
//  Realistic scenarios — endpoint must produce the same findings as the
//  pure helper, just wrapped in the dashboard envelope.
// ─────────────────────────────────────────────────────────────────────

test('dashboard reconcile pvc: empty positions+utxos produce 2 low-severity notes', async () => {
  const handler = makeHandler({ positions: [], utxos: [] });
  const { status, body } = await getJson(handler, '/api/reconcile/positions-vs-chain');
  assert.equal(status, 200);
  assert.equal(body.summary.high, 0);
  assert.equal(body.summary.medium, 0);
  assert.equal(body.summary.low, 2);
});

test('dashboard reconcile pvc: FEW pos_tlbiuvh6_0002 sold-off-chain case', async () => {
  // The motivating case: pos_tlbiuvh6_0002 is open in positions.json
  // but the wallet holds 0 tokens for CAT_FEW (sold off-band).
  const positions = [makeOpenPosition({ id: 'pos_tlbiuvh6_0002', token_id: CAT_FEW, token_amount_base: '100', token_symbol: 'FEW' })];
  const utxos = [
    makeUtxo({ category: CAT_OLA, amount: 50n }),
  ];
  const handler = makeHandler({ positions, utxos });
  const { status, body } = await getJson(handler, '/api/reconcile/positions-vs-chain');
  assert.equal(status, 200);
  assert.equal(body.summary.open_positions, 1);
  assert.equal(body.summary.high, 1);
  assert.equal(body.summary.medium, 1); // on_chain_only for OLA
  const onDiskOnly = body.findings.find((f) => f.kind === 'on_disk_only');
  assert.ok(onDiskOnly);
  assert.equal(onDiskOnly.position_id, 'pos_tlbiuvh6_0002');
  assert.equal(onDiskOnly.severity, 'high');
  assert.match(onDiskOnly.summary, /open but wallet holds 0 tokens for FEW/);
  assert.equal(onDiskOnly.recommended_action, 'scripts/reconcile-position.mjs --position-id pos_tlbiuvh6_0002');
});

test('dashboard reconcile pvc: consensus finding for matching position+UTXO', async () => {
  const positions = [makeOpenPosition({ id: 'pos_match', token_id: CAT_NWB, token_amount_base: '100', token_symbol: 'NWB' })];
  const utxos = [makeUtxo({ category: CAT_NWB, amount: 100n })];
  const handler = makeHandler({ positions, utxos });
  const { status, body } = await getJson(handler, '/api/reconcile/positions-vs-chain');
  assert.equal(status, 200);
  assert.equal(body.summary.high, 0);
  assert.equal(body.summary.medium, 0);
  const consensus = body.findings.find((f) => f.kind === 'consensus');
  assert.ok(consensus);
  assert.equal(consensus.position_id, 'pos_match');
  assert.equal(consensus.recommended_action, null);
});

test('dashboard reconcile pvc: quantity_mismatch surfaces medium severity', async () => {
  const positions = [makeOpenPosition({ id: 'pos_qm', token_id: CAT_OLA, token_amount_base: '1000', token_symbol: 'OLA' })];
  const utxos = [makeUtxo({ category: CAT_OLA, amount: 50n })];   // 50/1000 = 5%
  const handler = makeHandler({ positions, utxos });
  const { status, body } = await getJson(handler, '/api/reconcile/positions-vs-chain');
  assert.equal(status, 200);
  assert.equal(body.summary.medium, 1);
  const qm = body.findings.find((f) => f.kind === 'quantity_mismatch');
  assert.ok(qm);
  assert.equal(qm.position_id, 'pos_qm');
  // Helper format: "position <id> claims <expected> base units, wallet holds <actual> (<ratio>% of expected)"
  assert.equal(qm.summary, 'position pos_qm claims 1000 base units, wallet holds 50 (5.0% of expected)');
  assert.match(qm.summary, /claims 1000 base units/);
  assert.match(qm.summary, /wallet holds 50/);
  assert.match(qm.summary, /5\.0%/);
});

test('dashboard reconcile pvc: case-mismatched token_category still matches (Electrum upper-case vs positions lower-case)', async () => {
  // positions.json uses lower-case, UTXO returns upper-case — both
  // should normalize to the same category id and the finding should
  // be `consensus`, not `on_disk_only`.
  const positions = [makeOpenPosition({ id: 'pos_case', token_id: CAT_OLA, token_amount_base: '100', token_symbol: 'OLA' })];
  const utxos = [makeUtxo({ category: CAT_OLA.toUpperCase(), amount: 100n })];
  const handler = makeHandler({ positions, utxos });
  const { status, body } = await getJson(handler, '/api/reconcile/positions-vs-chain');
  assert.equal(status, 200);
  assert.equal(body.summary.high, 0);
  assert.equal(body.summary.medium, 0);
  assert.ok(body.findings.find((f) => f.kind === 'consensus' && f.position_id === 'pos_case'));
});

test('dashboard reconcile pvc: zero BCH balance emits a note', async () => {
  const positions = [makeOpenPosition({ id: 'pos_zero_bch', token_id: CAT_FEW, token_amount_base: '100', token_symbol: 'FEW' })];
  const utxos = [makeUtxo({ category: CAT_FEW, amount: 100n, satoshis: 0n })];
  const handler = makeHandler({ positions, utxos });
  const { status, body } = await getJson(handler, '/api/reconcile/positions-vs-chain');
  assert.equal(status, 200);
  const note = body.findings.find((f) => f.kind === 'note' && f.details?.reason === 'no_bch');
  assert.ok(note);
  assert.equal(note.severity, 'low');
});

// ─────────────────────────────────────────────────────────────────────
//  Idempotence / determinism
// ─────────────────────────────────────────────────────────────────────

test('dashboard reconcile pvc: two calls in a row produce identical findings[] (pure helper)', async () => {
  const positions = [makeOpenPosition({ id: 'pos_pure', token_id: CAT_FEW, token_amount_base: '100', token_symbol: 'FEW' })];
  const utxos = [makeUtxo({ category: CAT_FEW, amount: 100n })];
  const handler = makeHandler({ positions, utxos });
  const a = await getJson(handler, '/api/reconcile/positions-vs-chain');
  const b = await getJson(handler, '/api/reconcile/positions-vs-chain');
  // ts may differ; strip it before comparing.
  delete a.body.ts;
  delete b.body.ts;
  assert.deepEqual(a.body, b.body);
});
