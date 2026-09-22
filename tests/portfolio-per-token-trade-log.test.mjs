#!/usr/bin/env node
// tests/portfolio-per-token-trade-log.test.mjs
//
// Unit + integration tests for `src/portfolio/per-token-trade-log.mjs`.
// The module ships with T63 (per-token trade log with P&L attribution).
// Tests run under `node --test` so they slot into the repo's existing
// test runner without new devDependencies.
//
// Coverage groups:
//   1. Coin helpers — `toSatsBigInt` + `satsToBch`
//   2. Time helper — `computeHoldMs`
//   3. Outcome classification — `classifyOutcome`
//   4. Bucket routing — `bucketForEvent` + MISSING_TOKEN_BUCKET constant
//   5. Grouping — `groupEventsByToken`
//   6. Attribution — `attributionForClosedPosition`
//   7. Roll-up — `aggregateTotals` + `computeWinRate`
//   8. Per-token summary — `buildPerTokenSummary` (full token / only-entries / only-exits / open-only / multi-position / single-trade)
//   9. Rollup list — `listPerTokenSummaries`
//  10. Self-check — `selfCheckTotalsMatch`
//  11. Error paths — `TradeLogArgError` thrown on bad input
//  12. End-to-end with realistic fixtures (cross-check invariant)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TOKENS_SUMMARY_SCHEMA,
  DEFAULT_BREAKEVEN_EPSILON_SATS,
  OUTCOME_KINDS,
  MISSING_TOKEN_BUCKET,
  TradeLogArgError,
  toSatsBigInt,
  satsToBch,
  computeHoldMs,
  classifyOutcome,
  bucketForEvent,
  groupEventsByToken,
  attributionForClosedPosition,
  aggregateTotals,
  computeWinRate,
  buildPerTokenSummary,
  listPerTokenSummaries,
  selfCheckTotalsMatch,
} from '../src/portfolio/per-token-trade-log.mjs';

// ─────────────────────────────────────────────────────────────────────
//  Fixtures
// ─────────────────────────────────────────────────────────────────────

const TOKEN_FURU = 'd9ab24ed15a7846cc3d9e004aa5cb976860f13dac1ead05784ee4f4622af96ea';
const TOKEN_QBTC = '892cef80a326f92583766abb85562f550fe6a6ff9a7d458067680c720135ff53';
const TOKEN_BADGER = '242f6ecedb404c743477e35b09733a56cacae34f3109d5cee1cbc1d5630affd7';
const TOKEN_OTHER = '0000000000000000000000000000000000000000000000000000000000000001';

/**
 * Build a position object that matches the on-disk
 * `positions.json#open[]|closed[]` envelope.
 */
function mkPosition(over = {}) {
  return {
    id: 'pos_test_0001',
    token_id: TOKEN_FURU,
    token_symbol: 'FURU',
    token_decimals: 0,
    side: 'long_token',
    entry: {
      txid: 'a'.repeat(64),
      price_sats_per_token: 100,
      bch_spent_sats: 500000,
      token_amount_base: '5000',
      fee_sats: 2000,
      broadcast_ms: 0,
      ts: '2026-09-18T10:00:00.000Z',
      slippage_bps: '10',
    },
    ...over,
  };
}

/**
 * Build a closed-position object (position with `exit` set).
 */
function mkClosedPosition(over = {}) {
  const defaultExit = {
    txid: 'b'.repeat(64),
    exit_kind: 'take_profit',
    price_sats_per_token: 120,
    bch_received_sats: 600000,
    fee_sats: 2000,
    ts: '2026-09-18T14:00:00.000Z',
    realized_pnl_sats: 96000,
    realized_pnl_bch: 0.00096,
    slippage_bps: '20',
  };
  // Merge the override's exit on top of the default so individual
  // tests can tweak just one field (e.g. `fee_sats: 0`) without
  // having to re-specify the whole envelope.
  return mkPosition({
    ...over,
    exit: { ...defaultExit, ...(over.exit ?? {}) },
  });
}

/**
 * Build a history event of a given kind.
 */
function mkEvent(kind, tokenId, over = {}) {
  return {
    kind,
    ts: '2026-09-18T10:00:00.000Z',
    token_id: tokenId,
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  1. toSatsBigInt
// ─────────────────────────────────────────────────────────────────────

test('toSatsBigInt: null / undefined / NaN / Infinity / non-numeric → null', () => {
  assert.equal(toSatsBigInt(null), null);
  assert.equal(toSatsBigInt(undefined), null);
  assert.equal(toSatsBigInt(NaN), null);
  assert.equal(toSatsBigInt(Infinity), null);
  assert.equal(toSatsBigInt(-Infinity), null);
  assert.equal(toSatsBigInt('abc'), null);
  assert.equal(toSatsBigInt(''), null);
  assert.equal(toSatsBigInt('   '), null);
  assert.equal(toSatsBigInt('500000.5'), null); // fractional not allowed
  assert.equal(toSatsBigInt({}), null);
  assert.equal(toSatsBigInt([]), null);
  assert.equal(toSatsBigInt(100.5), null); // number fractional not allowed
});

test('toSatsBigInt: int number → bigint', () => {
  assert.equal(toSatsBigInt(0), 0n);
  assert.equal(toSatsBigInt(1), 1n);
  assert.equal(toSatsBigInt(100), 100n);
  assert.equal(toSatsBigInt(-100), -100n);
});

test('toSatsBigInt: int string → bigint', () => {
  assert.equal(toSatsBigInt('0'), 0n);
  assert.equal(toSatsBigInt('500000'), 500000n);
  assert.equal(toSatsBigInt('-500000'), -500000n);
  assert.equal(toSatsBigInt('  100  '), 100n);
});

test('toSatsBigInt: bigint passes through', () => {
  assert.equal(toSatsBigInt(42n), 42n);
  assert.equal(toSatsBigInt(-42n), -42n);
});

// ─────────────────────────────────────────────────────────────────────
//  2. satsToBch
// ─────────────────────────────────────────────────────────────────────

test('satsToBch: 1 BCH = 100,000,000 sats', () => {
  assert.equal(satsToBch(100_000_000n), '1.00000000');
  assert.equal(satsToBch(150_000_000n), '1.50000000');
  assert.equal(satsToBch(0n), '0.00000000');
  assert.equal(satsToBch(1n), '0.00000001');
  assert.equal(satsToBch(-50_000_000n), '-0.50000000');
  assert.equal(satsToBch(123), '0.00000123');
});

test('satsToBch: garbage → null', () => {
  assert.equal(satsToBch(null), null);
  assert.equal(satsToBch(undefined), null);
  assert.equal(satsToBch(NaN), null);
  assert.equal(satsToBch('abc'), null);
  assert.equal(satsToBch({}), null);
});

// ─────────────────────────────────────────────────────────────────────
//  3. computeHoldMs
// ─────────────────────────────────────────────────────────────────────

test('computeHoldMs: null inputs → null', () => {
  assert.equal(computeHoldMs(null, null), null);
  assert.equal(computeHoldMs('2026-09-18T10:00:00.000Z', null), null);
  assert.equal(computeHoldMs(null, '2026-09-18T10:00:00.000Z'), null);
});

test('computeHoldMs: unparseable → null', () => {
  assert.equal(computeHoldMs('not-a-date', 'also-not'), null);
  assert.equal(computeHoldMs('2026-09-18T10:00:00.000Z', 'not-a-date'), null);
});

test('computeHoldMs: happy path', () => {
  const start = '2026-09-13T19:44:52.878Z';
  const end = '2026-09-14T06:18:08.953Z';
  // 37996175 ms (computed externally)
  const expected = Date.parse(end) - Date.parse(start);
  assert.equal(computeHoldMs(start, end), expected);
});

// ─────────────────────────────────────────────────────────────────────
//  4. classifyOutcome
// ─────────────────────────────────────────────────────────────────────

test('classifyOutcome: gain / loss / breakeven default epsilon', () => {
  assert.equal(classifyOutcome(100n), 'gain');
  assert.equal(classifyOutcome(1n), 'breakeven'); // within +/-1n
  assert.equal(classifyOutcome(0n), 'breakeven');
  assert.equal(classifyOutcome(-1n), 'breakeven');
  assert.equal(classifyOutcome(-100n), 'loss');
});

test('classifyOutcome: null / undefined → unknown', () => {
  assert.equal(classifyOutcome(null), 'unknown');
  assert.equal(classifyOutcome(undefined), 'unknown');
  assert.equal(classifyOutcome(NaN), 'unknown');
});

test('classifyOutcome: custom epsilon', () => {
  assert.equal(classifyOutcome(5n, { epsilon: 10n }), 'breakeven');
  assert.equal(classifyOutcome(15n, { epsilon: 10n }), 'gain');
  assert.equal(classifyOutcome(-15n, { epsilon: 10n }), 'loss');
});

test('classifyOutcome: DEFAULT_BREAKEVEN_EPSILON_SATS === 1n', () => {
  assert.equal(DEFAULT_BREAKEVEN_EPSILON_SATS, 1n);
});

test('OUTCOME_KINDS: includes the four shapes', () => {
  assert.deepEqual([...OUTCOME_KINDS], ['gain', 'loss', 'breakeven', 'unknown']);
});

// ─────────────────────────────────────────────────────────────────────
//  5. bucketForEvent + MISSING_TOKEN_BUCKET constant
// ─────────────────────────────────────────────────────────────────────

test('bucketForEvent: malformed events → MISSING_TOKEN_BUCKET', () => {
  assert.equal(bucketForEvent(null), MISSING_TOKEN_BUCKET);
  assert.equal(bucketForEvent(undefined), MISSING_TOKEN_BUCKET);
  assert.equal(bucketForEvent({}), MISSING_TOKEN_BUCKET);
  assert.equal(bucketForEvent({ kind: 'entry' }), MISSING_TOKEN_BUCKET);
  assert.equal(bucketForEvent({ kind: 'entry', token_id: '' }), MISSING_TOKEN_BUCKET);
  assert.equal(bucketForEvent({ kind: 'entry', token_id: 123 }), MISSING_TOKEN_BUCKET);
  assert.equal(bucketForEvent('not-an-object'), MISSING_TOKEN_BUCKET);
  assert.equal(bucketForEvent(42), MISSING_TOKEN_BUCKET);
});

test('bucketForEvent: valid token_id → token_id', () => {
  assert.equal(bucketForEvent({ kind: 'entry', token_id: TOKEN_FURU }), TOKEN_FURU);
});

test('MISSING_TOKEN_BUCKET is the sentinel string', () => {
  assert.equal(MISSING_TOKEN_BUCKET, '__missing_token_id__');
});

// ─────────────────────────────────────────────────────────────────────
//  6. groupEventsByToken
// ─────────────────────────────────────────────────────────────────────

test('groupEventsByToken: empty input → empty map', () => {
  const out = groupEventsByToken([]);
  assert.equal(out.size, 0);
});

test('groupEventsByToken: throws on non-array', () => {
  assert.throws(() => groupEventsByToken(null), (e) => {
    return e instanceof TradeLogArgError && e.kind === 'events_not_array';
  });
  assert.throws(() => groupEventsByToken('not-array'), (e) => {
    return e instanceof TradeLogArgError && e.kind === 'events_not_array';
  });
});

test('groupEventsByToken: groups entries + exits by token_id', () => {
  const events = [
    mkEvent('entry', TOKEN_FURU, { position_id: 'p1' }),
    mkEvent('entry', TOKEN_FURU, { position_id: 'p2' }),
    mkEvent('exit', TOKEN_FURU, { position_id: 'p1' }),
    mkEvent('entry', TOKEN_QBTC, { position_id: 'p3' }),
    mkEvent('exit', TOKEN_QBTC, { position_id: 'p3' }),
  ];
  const out = groupEventsByToken(events);
  assert.equal(out.size, 2);
  const furu = out.get(TOKEN_FURU);
  assert.equal(furu.entries.length, 2);
  assert.equal(furu.exits.length, 1);
  assert.equal(furu.skipped_count, 0);
  const qbtc = out.get(TOKEN_QBTC);
  assert.equal(qbtc.entries.length, 1);
  assert.equal(qbtc.exits.length, 1);
});

test('groupEventsByToken: malformed events land in MISSING_TOKEN_BUCKET', () => {
  const events = [
    mkEvent('entry', TOKEN_FURU),
    { kind: 'entry' }, // no token_id
    null,
    { kind: 'entry_skipped', token_id: TOKEN_FURU }, // wrong kind for entry slot
  ];
  const out = groupEventsByToken(events);
  assert.equal(out.size, 2);
  const furu = out.get(TOKEN_FURU);
  assert.equal(furu.entries.length, 1);
  assert.equal(furu.skipped_count, 1);
  assert.equal(furu.skipped_kinds['entry_skipped'], 1);
  const missing = out.get(MISSING_TOKEN_BUCKET);
  assert.equal(missing.entries.length, 0);
  assert.equal(missing.skipped_count, 2);
  // null lands as 'null' kind; the kind-only object lands as 'entry'
  assert.equal(missing.skipped_kinds['null'], 1);
  assert.equal(missing.skipped_kinds['entry'], 1);
});

// ─────────────────────────────────────────────────────────────────────
//  7. attributionForClosedPosition
// ─────────────────────────────────────────────────────────────────────

test('attributionForClosedPosition: gain on the closed trade', () => {
  const pos = mkClosedPosition();
  const exitEv = mkEvent('exit', TOKEN_FURU, {
    position_id: pos.id,
    exit_kind: 'take_profit',
    bch_received_sats: 600000,
    fee_sats: 2000,
    ts: '2026-09-18T14:00:00.000Z', // 4h after entry
  });
  const att = attributionForClosedPosition(pos, exitEv);
  assert.equal(att.position_id, pos.id);
  assert.equal(att.token_id, TOKEN_FURU);
  assert.equal(att.exit_kind, 'take_profit');
  assert.equal(att.cost_basis_sats, 500000n);
  assert.equal(att.exit_value_sats, 600000n);
  assert.equal(att.entry_fee_sats, 2000n);
  assert.equal(att.exit_fee_sats, 2000n);
  assert.equal(att.fees_sats_total, 4000n);
  assert.equal(att.gross_pnl_sats, 100000n);
  assert.equal(att.net_pnl_sats, 96000n);
  assert.equal(att.net_pnl_bch, '0.00096000');
  assert.equal(att.outcome, 'gain');
  assert.ok(att.hold_ms !== null && att.hold_ms > 0, `hold_ms=${att.hold_ms}`);
});

test('attributionForClosedPosition: loss on the closed trade', () => {
  const pos = mkClosedPosition({
    exit: {
      txid: 'b'.repeat(64),
      exit_kind: 'stop_loss',
      price_sats_per_token: 80,
      bch_received_sats: 400000,
      fee_sats: 2000,
      ts: '2026-09-18T14:00:00.000Z',
      realized_pnl_sats: -104000,
    },
  });
  const exitEv = mkEvent('exit', TOKEN_FURU, {
    position_id: pos.id,
    exit_kind: 'stop_loss',
    bch_received_sats: 400000,
    fee_sats: 2000,
  });
  const att = attributionForClosedPosition(pos, exitEv);
  assert.equal(att.gross_pnl_sats, -100000n);
  assert.equal(att.net_pnl_sats, -104000n);
  assert.equal(att.outcome, 'loss');
});

test('attributionForClosedPosition: breakeven within epsilon', () => {
  const pos = mkClosedPosition({
    exit: {
      txid: 'b'.repeat(64),
      exit_kind: 'time_stop',
      bch_received_sats: 502000, // entry 500k + 2k entry fee + 0 exit fee → exactly 0 net
      fee_sats: 0,
      ts: '2026-09-18T14:00:00.000Z',
    },
  });
  const exitEv = mkEvent('exit', TOKEN_FURU, {
    position_id: pos.id,
    exit_kind: 'time_stop',
    bch_received_sats: 502000,
    fee_sats: 0,
    ts: '2026-09-18T14:00:00.000Z',
  });
  const att = attributionForClosedPosition(pos, exitEv);
  assert.equal(att.net_pnl_sats, 0n);
  assert.equal(att.outcome, 'breakeven');
});

test('attributionForClosedPosition: missing exit → unknown', () => {
  const pos = mkPosition();
  const att = attributionForClosedPosition(pos, null);
  assert.equal(att.position_id, pos.id);
  assert.equal(att.net_pnl_sats, null);
  assert.equal(att.outcome, 'unknown');
  assert.equal(att.hold_ms, null);
});

test('attributionForClosedPosition: missing fields → null + outcome:unknown', () => {
  const pos = { id: 'pos_x', token_id: TOKEN_FURU, entry: { ts: '2026-09-18T10:00:00.000Z' } };
  const exitEv = { kind: 'exit', position_id: 'pos_x', token_id: TOKEN_FURU, ts: '2026-09-18T14:00:00.000Z' };
  const att = attributionForClosedPosition(pos, exitEv);
  assert.equal(att.cost_basis_sats, null);
  assert.equal(att.exit_value_sats, null);
  assert.equal(att.net_pnl_sats, null);
  assert.equal(att.outcome, 'unknown');
  assert.equal(att.hold_ms, 4 * 3600 * 1000);
});

test('attributionForClosedPosition: null position → safe defaults', () => {
  const att = attributionForClosedPosition(null, null);
  assert.equal(att.position_id, null);
  assert.equal(att.token_id, null);
  assert.equal(att.net_pnl_sats, null);
  assert.equal(att.outcome, 'unknown');
});

// ─────────────────────────────────────────────────────────────────────
//  8. aggregateTotals + computeWinRate
// ─────────────────────────────────────────────────────────────────────

test('aggregateTotals: empty input returns zeros', () => {
  const t = aggregateTotals([]);
  assert.equal(t.closed_trade_count, 0);
  assert.equal(t.realized_pnl_sats, 0n);
  assert.equal(t.win_count, 0);
  assert.equal(t.mean_hold_ms, null);
});

test('aggregateTotals: closed trades roll up correctly', () => {
  const atts = [
    { net_pnl_sats: 100n, cost_basis_sats: 1000n, exit_value_sats: 1100n, fees_sats_total: 50n, outcome: 'gain', hold_ms: 1000, entry_event: { token_amount_base: '100' } },
    { net_pnl_sats: -50n, cost_basis_sats: 500n, exit_value_sats: 450n, fees_sats_total: 25n, outcome: 'loss', hold_ms: 2000, entry_event: { token_amount_base: '50' } },
    { net_pnl_sats: 0n, cost_basis_sats: 100n, exit_value_sats: 100n, fees_sats_total: 5n, outcome: 'breakeven', hold_ms: 500, entry_event: { token_amount_base: '10' } },
  ];
  const t = aggregateTotals(atts);
  assert.equal(t.closed_trade_count, 3);
  assert.equal(t.realized_pnl_sats, 50n);
  assert.equal(t.total_bch_in_sats, 1600n);
  assert.equal(t.total_bch_out_sats, 1650n);
  assert.equal(t.total_fees_sats, 80n);
  assert.equal(t.total_token_volume_base, 160n);
  assert.equal(t.win_count, 1);
  assert.equal(t.loss_count, 1);
  assert.equal(t.breakeven_count, 1);
  assert.equal(t.unknown_count, 0);
  assert.equal(t.total_hold_ms, 3500n);
  assert.equal(t.mean_hold_ms, Math.floor(3500 / 3));
});

test('aggregateTotals: missing hold → total_hold_ms=null', () => {
  const atts = [
    { net_pnl_sats: 100n, cost_basis_sats: 1000n, exit_value_sats: 1100n, fees_sats_total: 50n, outcome: 'gain', hold_ms: 1000 },
    { net_pnl_sats: -50n, cost_basis_sats: 500n, exit_value_sats: 450n, fees_sats_total: 25n, outcome: 'loss', hold_ms: null },
  ];
  const t = aggregateTotals(atts);
  assert.equal(t.total_hold_ms, null);
  assert.equal(t.mean_hold_ms, null);
});

test('aggregateTotals: unknown outcomes counted', () => {
  const atts = [{ net_pnl_sats: null, outcome: 'unknown', hold_ms: 0 }];
  const t = aggregateTotals(atts);
  assert.equal(t.unknown_count, 1);
  assert.equal(t.win_count, 0);
  assert.equal(t.loss_count, 0);
});

test('computeWinRate: 3 wins + 1 loss + 1 breakeven → 0.6', () => {
  assert.equal(computeWinRate({ win_count: 3, loss_count: 1, breakeven_count: 1 }), 0.6);
});

test('computeWinRate: 0 wins + 0 losses → null', () => {
  assert.equal(computeWinRate({ win_count: 0, loss_count: 0, breakeven_count: 0 }), null);
});

test('computeWinRate: only breakevens → 0 (not null)', () => {
  assert.equal(computeWinRate({ win_count: 0, loss_count: 0, breakeven_count: 5 }), 0);
});

// ─────────────────────────────────────────────────────────────────────
//  9. buildPerTokenSummary
// ─────────────────────────────────────────────────────────────────────

test('buildPerTokenSummary: closed-trade token with full attribution', () => {
  const positions = [mkClosedPosition()];
  const events = [
    mkEvent('entry', TOKEN_FURU, { position_id: positions[0].id }),
    mkEvent('exit', TOKEN_FURU, {
      position_id: positions[0].id,
      exit_kind: 'take_profit',
      bch_received_sats: 600000,
      fee_sats: 2000,
    }),
  ];
  const sum = buildPerTokenSummary({ events, positions, tokenId: TOKEN_FURU });
  assert.equal(sum.schema, TOKENS_SUMMARY_SCHEMA);
  assert.equal(sum.token_id, TOKEN_FURU);
  assert.equal(sum.symbol, 'FURU');
  assert.equal(sum.decimals, 0);
  assert.equal(sum.entry_count, 1);
  assert.equal(sum.exit_count, 1);
  assert.equal(sum.closed_trade_count, 1);
  assert.equal(sum.open_position_count, 0);
  assert.equal(sum.realized_pnl_sats, 96000n);
  assert.equal(sum.realized_pnl_bch, '0.00096000');
  assert.equal(sum.win_count, 1);
  assert.equal(sum.loss_count, 0);
  assert.equal(sum.breakeven_count, 0);
  assert.equal(sum.win_rate, 1);
  assert.equal(sum.closed_trades.length, 1);
  assert.equal(sum.open_positions.length, 0);
});

test('buildPerTokenSummary: only-open token shows open positions list', () => {
  const positions = [mkPosition()];
  const events = [mkEvent('entry', TOKEN_FURU, { position_id: positions[0].id })];
  const nowMs = Date.parse('2026-09-19T10:00:00.000Z');
  const sum = buildPerTokenSummary({ events, positions, tokenId: TOKEN_FURU, opts: { nowMs } });
  assert.equal(sum.closed_trade_count, 0);
  assert.equal(sum.open_position_count, 1);
  assert.equal(sum.realized_pnl_sats, 0n);
  assert.equal(sum.open_positions[0].position_id, positions[0].id);
  // 24h after entry
  assert.equal(sum.open_positions[0].age_ms, 24 * 3600 * 1000);
  assert.equal(sum.open_positions[0].size_bch, '0.00500000');
  assert.equal(sum.open_positions[0].cost_basis_sats, 500000n);
});

test('buildPerTokenSummary: token with both closed + open positions', () => {
  const closed = mkClosedPosition({ id: 'pos_test_closed' });
  const open = mkPosition({ id: 'pos_test_open' });
  const positions = [closed, open];
  const events = [
    mkEvent('entry', TOKEN_FURU, { position_id: closed.id }),
    mkEvent('exit', TOKEN_FURU, {
      position_id: closed.id,
      exit_kind: 'take_profit',
      bch_received_sats: 600000,
      fee_sats: 2000,
    }),
    mkEvent('entry', TOKEN_FURU, { position_id: open.id }),
  ];
  const sum = buildPerTokenSummary({ events, positions, tokenId: TOKEN_FURU });
  assert.equal(sum.closed_trade_count, 1);
  assert.equal(sum.open_position_count, 1);
  assert.equal(sum.entry_count, 2);
  assert.equal(sum.exit_count, 1);
});

test('buildPerTokenSummary: multi-position token (8 FURU cascade)', () => {
  const positions = [];
  const events = [];
  for (let i = 0; i < 8; i += 1) {
    const id = `pos_furu_${i}`;
    positions.push(mkPosition({ id }));
    events.push(mkEvent('entry', TOKEN_FURU, { position_id: id }));
  }
  const sum = buildPerTokenSummary({ events, positions, tokenId: TOKEN_FURU });
  assert.equal(sum.closed_trade_count, 0);
  assert.equal(sum.open_position_count, 8);
  assert.equal(sum.entry_count, 8);
  assert.equal(sum.exit_count, 0);
});

test('buildPerTokenSummary: closed_trades sorted newest-first by entry_ts', () => {
  const positions = [
    mkClosedPosition({ id: 'pos_a', entry: { ...mkPosition().entry, ts: '2026-09-15T10:00:00.000Z' } }),
    mkClosedPosition({ id: 'pos_b', entry: { ...mkPosition().entry, ts: '2026-09-18T10:00:00.000Z' } }),
    mkClosedPosition({ id: 'pos_c', entry: { ...mkPosition().entry, ts: '2026-09-16T10:00:00.000Z' } }),
  ];
  const events = positions.flatMap((p) => [
    mkEvent('entry', TOKEN_FURU, { position_id: p.id }),
    mkEvent('exit', TOKEN_FURU, {
      position_id: p.id,
      exit_kind: 'take_profit',
      bch_received_sats: 600000,
      fee_sats: 2000,
    }),
  ]);
  const sum = buildPerTokenSummary({ events, positions, tokenId: TOKEN_FURU });
  assert.deepEqual(
    sum.closed_trades.map((t) => t.position_id),
    ['pos_b', 'pos_c', 'pos_a'],
  );
});

test('buildPerTokenSummary: throws on non-array events / positions / missing tokenId', () => {
  assert.throws(
    () => buildPerTokenSummary({ events: null, positions: [], tokenId: TOKEN_FURU }),
    (e) => e instanceof TradeLogArgError && e.kind === 'events_not_array',
  );
  assert.throws(
    () => buildPerTokenSummary({ events: [], positions: null, tokenId: TOKEN_FURU }),
    (e) => e instanceof TradeLogArgError && e.kind === 'positions_not_array',
  );
  assert.throws(
    () => buildPerTokenSummary({ events: [], positions: [], tokenId: '' }),
    (e) => e instanceof TradeLogArgError && e.kind === 'token_id_required',
  );
});

// ─────────────────────────────────────────────────────────────────────
//  10. listPerTokenSummaries
// ─────────────────────────────────────────────────────────────────────

test('listPerTokenSummaries: rollup across multiple tokens sorted by pnl DESC', () => {
  const positions = [
    // FURU closed + closed + closed (one gain, one loss, one breakeven)
    mkClosedPosition({ id: 'f1' }),
    mkClosedPosition({
      id: 'f2',
      exit: {
        txid: 'b'.repeat(64),
        exit_kind: 'stop_loss',
        bch_received_sats: 400000,
        fee_sats: 2000,
        ts: '2026-09-18T14:00:00.000Z',
      },
    }),
    // QBTC one closed gain
    mkClosedPosition({ id: 'q1', token_id: TOKEN_QBTC, token_symbol: 'QBTC', token_decimals: 8 }),
  ];
  // For positions[1] (FURU loss), set entry event
  const events = [];
  for (const p of positions) {
    events.push(mkEvent('entry', p.token_id, { position_id: p.id }));
    events.push(mkEvent('exit', p.token_id, {
      position_id: p.id,
      exit_kind: p.exit.exit_kind,
      bch_received_sats: p.exit.bch_received_sats,
      fee_sats: p.exit.fee_sats,
    }));
  }
  const rollup = listPerTokenSummaries({ events, positions });
  assert.equal(rollup.schema, TOKENS_SUMMARY_SCHEMA);
  assert.equal(rollup.count, 2);
  // QBTC gain (+96k) > FURU gain - loss - gain = (-2k) → QBTC first
  assert.equal(rollup.tokens[0].token_id, TOKEN_QBTC);
  assert.equal(rollup.tokens[1].token_id, TOKEN_FURU);
  // Rollup rows omit the heavy closed_trades[] + open_positions[] arrays
  assert.equal(rollup.tokens[0].closed_trades, undefined);
  assert.equal(rollup.tokens[0].open_positions, undefined);
});

test('listPerTokenSummaries: empty inputs → empty tokens list', () => {
  const rollup = listPerTokenSummaries({ events: [], positions: [] });
  assert.equal(rollup.count, 0);
  assert.deepEqual(rollup.tokens, []);
});

test('listPerTokenSummaries: excludes MISSING_TOKEN_BUCKET by default', () => {
  const events = [
    mkEvent('entry', TOKEN_FURU, { position_id: 'p1' }),
    { kind: 'entry' }, // missing token_id → goes to MISSING_TOKEN_BUCKET
  ];
  const positions = [mkPosition({ id: 'p1' })];
  const rollup = listPerTokenSummaries({ events, positions });
  assert.equal(rollup.count, 1);
  assert.equal(rollup.tokens[0].token_id, TOKEN_FURU);
});

test('listPerTokenSummaries: throws on non-array events / positions', () => {
  assert.throws(
    () => listPerTokenSummaries({ events: 'not-array', positions: [] }),
    (e) => e instanceof TradeLogArgError && e.kind === 'events_not_array',
  );
  assert.throws(
    () => listPerTokenSummaries({ events: [], positions: 'not-array' }),
    (e) => e instanceof TradeLogArgError && e.kind === 'positions_not_array',
  );
});

// ─────────────────────────────────────────────────────────────────────
//  11. selfCheckTotalsMatch
// ─────────────────────────────────────────────────────────────────────

test('selfCheckTotalsMatch: cross-check invariant holds for closed trades', () => {
  const positions = [
    mkClosedPosition({ id: 'p1' }),
    mkClosedPosition({
      id: 'p2',
      token_id: TOKEN_QBTC,
      token_symbol: 'QBTC',
      token_decimals: 8,
    }),
  ];
  const events = positions.flatMap((p) => [
    mkEvent('entry', p.token_id, { position_id: p.id }),
    mkEvent('exit', p.token_id, {
      position_id: p.id,
      exit_kind: 'take_profit',
      bch_received_sats: 600000,
      fee_sats: 2000,
    }),
  ]);
  const check = selfCheckTotalsMatch({ events, positions });
  assert.equal(check.ok, true);
  assert.equal(check.drift_sats, 0n);
});

test('selfCheckTotalsMatch: detects drift when events disagree with positions.exit', () => {
  // The per-token attribution reads `bch_received_sats` from the
  // exit EVENT (because that's what `attributionForClosedPosition`
  // accepts); the global walk reads it from `positions#exit` directly.
  // When the two disagree the cross-check MUST surface the drift so
  // a future refactor that changes the source-of-truth can't slip
  // through unnoticed.
  const positions = [
    mkClosedPosition({
      id: 'p1',
      // on-disk positions.json says we got 800k out
      exit: { txid: 'b'.repeat(64), exit_kind: 'take_profit', bch_received_sats: 800000, fee_sats: 2000, ts: '2026-09-18T14:00:00.000Z' },
    }),
  ];
  // ...but the history event says we got 600k out. Per-token uses
  // 600k; global uses 800k → drift of (600000 - 500000 - 4000) -
  // (800000 - 500000 - 4000) = -200000 sats.
  const events = [
    mkEvent('entry', TOKEN_FURU, { position_id: 'p1' }),
    mkEvent('exit', TOKEN_FURU, {
      position_id: 'p1',
      exit_kind: 'take_profit',
      bch_received_sats: 600000,
      fee_sats: 2000,
    }),
  ];
  const check = selfCheckTotalsMatch({ events, positions });
  assert.equal(check.ok, false);
  // drift = per_token_sats - global_sats = 96000 - 296000 = -200000
  assert.equal(check.drift_sats, -200000n);
  assert.equal(check.global_sats, 296000n);
  assert.equal(check.per_token_sats, 96000n);
});

test('selfCheckTotalsMatch: omitting events for a closed position does NOT drift (canonical source = positions.json)', () => {
  // The implementation intentionally reads the on-disk
  // `positions.json#closed[]` envelope as the canonical source of
  // realized PnL — the history events are an audit trail that the
  // attribution can pair up to. So a closed position WITHOUT a
  // matching exit event still gets included in the per-token
  // breakdown (with attribution pulled from `pos.exit` directly).
  // That's the operator-friendly behavior — the audit trail can
  // be lossy without corrupting the dashboard numbers.
  const positions = [
    mkClosedPosition({ id: 'p1' }),
    mkClosedPosition({ id: 'p2' }),
  ];
  // Only emit events for p1 — p2 still closes correctly because
  // `buildPerTokenSummary` falls back to `pos.exit` when no event
  // is found.
  const events = [
    mkEvent('entry', TOKEN_FURU, { position_id: 'p1' }),
    mkEvent('exit', TOKEN_FURU, {
      position_id: 'p1',
      exit_kind: 'take_profit',
      bch_received_sats: 600000,
      fee_sats: 2000,
    }),
  ];
  const check = selfCheckTotalsMatch({ events, positions });
  assert.equal(check.ok, true);
  assert.equal(check.drift_sats, 0n);
});

// ─────────────────────────────────────────────────────────────────────
//  12. End-to-end with realistic fixtures
// ─────────────────────────────────────────────────────────────────────

test('e2e: realistic 3-token / 6-position fixture cross-checks against global PnL', () => {
  // Token A: 2 closed + 1 open
  // Token B: 2 closed
  // Token C: 1 open
  const posA1 = mkClosedPosition({ id: 'A1', token_id: TOKEN_FURU, token_symbol: 'FURU', token_decimals: 0,
    exit: { txid: 'b'.repeat(64), exit_kind: 'take_profit', bch_received_sats: 600000, fee_sats: 2000, ts: '2026-09-18T14:00:00.000Z' } });
  const posA2 = mkClosedPosition({ id: 'A2', token_id: TOKEN_FURU, token_symbol: 'FURU', token_decimals: 0,
    exit: { txid: 'c'.repeat(64), exit_kind: 'stop_loss', bch_received_sats: 450000, fee_sats: 2000, ts: '2026-09-18T14:00:00.000Z' } });
  const posA3 = mkPosition({ id: 'A3', token_id: TOKEN_FURU, token_symbol: 'FURU', token_decimals: 0 });
  const posB1 = mkClosedPosition({ id: 'B1', token_id: TOKEN_QBTC, token_symbol: 'QBTC', token_decimals: 8,
    exit: { txid: 'd'.repeat(64), exit_kind: 'time_stop', bch_received_sats: 510000, fee_sats: 2000, ts: '2026-09-18T14:00:00.000Z' } });
  const posB2 = mkClosedPosition({ id: 'B2', token_id: TOKEN_QBTC, token_symbol: 'QBTC', token_decimals: 8,
    exit: { txid: 'e'.repeat(64), exit_kind: 'take_profit', bch_received_sats: 700000, fee_sats: 2000, ts: '2026-09-18T14:00:00.000Z' } });
  const posC1 = mkPosition({ id: 'C1', token_id: TOKEN_BADGER, token_symbol: 'BADGER', token_decimals: 2 });
  const positions = [posA1, posA2, posA3, posB1, posB2, posC1];
  const events = [];
  for (const p of positions) {
    events.push(mkEvent('entry', p.token_id, { position_id: p.id }));
    if (p.exit) {
      events.push(mkEvent('exit', p.token_id, {
        position_id: p.id,
        exit_kind: p.exit.exit_kind,
        bch_received_sats: p.exit.bch_received_sats,
        fee_sats: p.exit.fee_sats,
      }));
    }
  }
  const rollup = listPerTokenSummaries({ events, positions });
  assert.equal(rollup.count, 3);

  // FURU row: 1 gain (96k) + 1 loss (-54k) + 1 open
  const furu = rollup.tokens.find((t) => t.token_id === TOKEN_FURU);
  assert.equal(furu.closed_trade_count, 2);
  assert.equal(furu.open_position_count, 1);
  assert.equal(furu.win_count, 1);
  assert.equal(furu.loss_count, 1);
  assert.equal(furu.realized_pnl_sats, 42000n); // 96k - 54k = 42k
  assert.equal(furu.realized_pnl_bch, '0.00042000');

  // QBTC row: 2 closed gains
  const qbtc = rollup.tokens.find((t) => t.token_id === TOKEN_QBTC);
  assert.equal(qbtc.closed_trade_count, 2);
  assert.equal(qbtc.open_position_count, 0);
  assert.equal(qbtc.win_count, 2);

  // BADGER row: 1 open, 0 closed
  const badger = rollup.tokens.find((t) => t.token_id === TOKEN_BADGER);
  assert.equal(badger.closed_trade_count, 0);
  assert.equal(badger.open_position_count, 1);

  // Cross-check invariant
  const check = selfCheckTotalsMatch({ events, positions });
  assert.equal(check.ok, true, `drift=${check.drift_sats}`);

  // Build single-token detail for FURU
  const furuDetail = buildPerTokenSummary({ events, positions, tokenId: TOKEN_FURU });
  assert.equal(furuDetail.closed_trades.length, 2);
  assert.equal(furuDetail.open_positions.length, 1);
  assert.equal(furuDetail.realized_pnl_sats, 42000n);
});

// ─────────────────────────────────────────────────────────────────────
//  13. HTTP integration via supertest
//     `/api/tokens/summary` end-to-end through createDashboardServer.
//     Mirrors the `dashboard-staking-status.test.mjs` supertest pattern.
//     Skipped when supertest is not installed (matches the other
//     dashboard HTTP suites).
// ─────────────────────────────────────────────────────────────────────

import { createDashboardServer } from '../src/dashboard/server.mjs';
import { Positions } from '../src/portfolio/positions.mjs';
import { Snapshots } from '../src/portfolio/snapshots.mjs';
import { createLogger, createMemorySink } from '../src/util/logger.mjs';

/**
 * Build a lightweight mock positions object that the dashboard server
 * accepts (it only calls `.list('open'|'closed')`). This sidesteps
 * the Positions class's lazy async load() — we inject the data
 * synchronously so the test is self-contained and doesn't depend
 * on a writable data/positions.json file.
 */
function makePositionsMock({ open = [], closed = [] } = {}) {
  return {
    async list(bucket = 'open') {
      if (bucket === 'open') return open.map((p) => ({ ...p }));
      if (bucket === 'closed') return closed.map((p) => ({ ...p }));
      if (bucket === 'all') return [...open, ...closed].map((p) => ({ ...p }));
      return [];
    },
  };
}

async function bootDashboardServerForTokens({ cfg, positions, historyEvents }) {
  const snapshots = new Snapshots();
  const logger = createLogger({ component: 'test-tokens-summary', sink: createMemorySink() });
  return createDashboardServer({
    cfg: cfg ?? {},
    positions,
    snapshots,
    historyReader: { read: async () => ({ events: historyEvents ?? [], errors: [] }) },
    wallet: null,
    alertsFile: null,
    staticRoot: null,
    logger,
  });
}

test('tokens-summary: GET /api/tokens/summary (no token_id) returns the per-token rollup', async (t) => {
  const supertest = await import('supertest').catch(() => null);
  if (!supertest) {
    t.skip('supertest not installed — skipping HTTP integration');
    return;
  }
  const closed = mkClosedPosition({ id: 'p1', token_id: TOKEN_FURU, token_symbol: 'FURU', token_decimals: 0 });
  const positions = makePositionsMock({ closed: [closed] });
  const events = [
    mkEvent('entry', TOKEN_FURU, { position_id: 'p1' }),
    mkEvent('exit', TOKEN_FURU, { position_id: 'p1', exit_kind: 'take_profit', bch_received_sats: 600000, fee_sats: 2000 }),
  ];
  const server = await bootDashboardServerForTokens({ positions, historyEvents: events });
  const res = await supertest.default(server.handler).get('/api/tokens/summary');
  assert.equal(res.status, 200);
  assert.equal(res.body.schema, TOKENS_SUMMARY_SCHEMA);
  assert.equal(res.body.count, 1);
  assert.equal(res.body.tokens.length, 1);
  assert.equal(res.body.tokens[0].token_id, TOKEN_FURU);
  assert.equal(res.body.tokens[0].symbol, 'FURU');
  assert.equal(res.body.tokens[0].closed_trade_count, 1);
  assert.equal(res.body.tokens[0].win_count, 1);
  // Rollup rows omit the heavy attribution arrays
  assert.equal(res.body.tokens[0].closed_trades, undefined);
  assert.equal(res.body.tokens[0].open_positions, undefined);
  // history_errors present even when read succeeded (empty array)
  assert.deepEqual(res.body.history_errors, []);
});

test('tokens-summary: GET /api/tokens/summary?token_id=<64-hex> returns single-token detail with attribution arrays', async (t) => {
  const supertest = await import('supertest').catch(() => null);
  if (!supertest) {
    t.skip('supertest not installed — skipping HTTP integration');
    return;
  }
  const closed = mkClosedPosition({ id: 'p1', token_id: TOKEN_FURU, token_symbol: 'FURU', token_decimals: 0 });
  const open = mkPosition({ id: 'p2', token_id: TOKEN_FURU, token_symbol: 'FURU', token_decimals: 0 });
  const positions = makePositionsMock({ closed: [closed], open: [open] });
  const events = [
    mkEvent('entry', TOKEN_FURU, { position_id: 'p1' }),
    mkEvent('exit', TOKEN_FURU, { position_id: 'p1', exit_kind: 'take_profit', bch_received_sats: 600000, fee_sats: 2000 }),
    mkEvent('entry', TOKEN_FURU, { position_id: 'p2' }),
  ];
  const server = await bootDashboardServerForTokens({ positions, historyEvents: events });
  const res = await supertest.default(server.handler)
    .get(`/api/tokens/summary?token_id=${TOKEN_FURU}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.token_id, TOKEN_FURU);
  assert.equal(res.body.symbol, 'FURU');
  assert.equal(res.body.closed_trade_count, 1);
  assert.equal(res.body.open_position_count, 1);
  assert.equal(res.body.closed_trades.length, 1);
  assert.equal(res.body.open_positions.length, 1);
  // BigInt fields are serialized as strings over HTTP JSON
  assert.equal(res.body.realized_pnl_sats, '96000');
  assert.equal(res.body.realized_pnl_bch, '0.00096000');
  assert.equal(res.body.win_count, 1);
});

test('tokens-summary: malformed token_id (not 64-hex) → 400 BAD_TOKEN_ID', async (t) => {
  const supertest = await import('supertest').catch(() => null);
  if (!supertest) {
    t.skip('supertest not installed — skipping HTTP integration');
    return;
  }
  const positions = new Positions();
  const server = await bootDashboardServerForTokens({ positions, historyEvents: [] });
  const res = await supertest.default(server.handler)
    .get('/api/tokens/summary?token_id=not-hex');
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'BAD_TOKEN_ID');
});

test('tokens-summary: unknown token_id → 404 TOKEN_NOT_FOUND', async (t) => {
  const supertest = await import('supertest').catch(() => null);
  if (!supertest) {
    t.skip('supertest not installed — skipping HTTP integration');
    return;
  }
  const positions = new Positions();
  const server = await bootDashboardServerForTokens({ positions, historyEvents: [] });
  const unknown = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const res = await supertest.default(server.handler)
    .get(`/api/tokens/summary?token_id=${unknown}`);
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'TOKEN_NOT_FOUND');
});

test('tokens-summary: empty history + empty positions → 200 with empty rollup', async (t) => {
  const supertest = await import('supertest').catch(() => null);
  if (!supertest) {
    t.skip('supertest not installed — skipping HTTP integration');
    return;
  }
  const positions = new Positions();
  const server = await bootDashboardServerForTokens({ positions, historyEvents: [] });
  const res = await supertest.default(server.handler).get('/api/tokens/summary');
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 0);
  assert.deepEqual(res.body.tokens, []);
});

test('tokens-summary: historyReader throwing does NOT 500 — surfaces empty list with error', async (t) => {
  const supertest = await import('supertest').catch(() => null);
  if (!supertest) {
    t.skip('supertest not installed — skipping HTTP integration');
    return;
  }
  const positions = new Positions();
  const snapshots = new Snapshots();
  const logger = createLogger({ component: 'test-tokens-summary', sink: createMemorySink() });
  const server = await createDashboardServer({
    cfg: {},
    positions,
    snapshots,
    historyReader: {
      read: async () => { throw new Error('disk on fire'); },
    },
    wallet: null,
    alertsFile: null,
    staticRoot: null,
    logger,
  });
  const res = await supertest.default(server.handler).get('/api/tokens/summary');
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 0);
  assert.equal(res.body.history_errors.length, 1);
  assert.match(res.body.history_errors[0], /disk on fire/);
});
