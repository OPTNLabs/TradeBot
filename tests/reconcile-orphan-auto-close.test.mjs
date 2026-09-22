#!/usr/bin/env node
// tests/reconcile-orphan-auto-close.test.mjs
//
// T62 — orphan auto-reconcile unit tests.
//
// Covers the pure helpers + I/O wrapper in
// `src/reconcile/orphan-auto-close.mjs`:
//   - `ageGateMsFromMinutes` (default / explicit / opt-out / non-finite)
//   - `positionEntryMs` (numeric / string / Date.parse / null / bad)
//   - `isOrphanFindingCloseable` (predicate matrix)
//   - `pickOrphanAutoCloseableFindings` (filter / preserve order)
//   - `buildOrphanAutoCloseExit` (synthetic exit envelope)
//   - `computeOrphanAutoCloseRealizedPnlSats` (entry-fee path / fallback)
//   - `buildOrphanAutoClosePlan` (typed envelope shape)
//   - `executeOrphanAutoClose` (happy path / throw / mismatch /
//     positions.close unavailable)
//   - `buildOrphanAutoCloseAuditRecord` (audit row shape)
//
// Mirrors the test patterns from `tests/alerts-orphan-position.test.mjs`
// + `tests/reconcile-positions-vs-chain.test.mjs` so the test
// infrastructure is familiar to future maintainers.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ORPHAN_AUTO_CLOSE_KIND,
  ORPHAN_AUTO_CLOSE_SOURCE,
  DEFAULT_MIN_AGE_MINUTES,
  MAX_FALLBACK_PNL_SATS,
  ORPHAN_AUTO_CLOSE_FINDING_KIND,
  ageGateMsFromMinutes,
  positionEntryMs,
  isOrphanFindingCloseable,
  pickOrphanAutoCloseableFindings,
  buildOrphanAutoCloseExit,
  computeOrphanAutoCloseRealizedPnlSats,
  buildOrphanAutoClosePlan,
  executeOrphanAutoClose,
  buildOrphanAutoCloseAuditRecord,
} from '../src/reconcile/orphan-auto-close.mjs';

// ─── Test fixtures ──────────────────────────────────────────────────────

// Anchored to a realistic supervisor-tick time so the age math
// reflects a real ~17-day-old orphan rather than contrived
// epoch-ms values.
const NOW_MS = 1_789_756_200_000;
const NOW_ISO = '2026-09-18T18:30:00.000Z';
const POS_ID = 'pos_test_orphan_auto_0001';
const TOKEN_ID = 'a'.repeat(64);

const FINDING = {
  kind: 'on_disk_only',
  severity: 'high',
  token_id: TOKEN_ID,
  token_symbol: 'TST',
  position_id: POS_ID,
  summary: 'position pos_test_orphan_auto_0001 is open but wallet holds 0 tokens for TST',
  details: {
    expected_token_amount_base: '1000',
    wallet_token_amount_base: '0',
    subtype: 'sold_off_chain',
  },
  recommended_action: 'auto-reconcile',
};

// Position opened ~17 days before NOW_MS.
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
    price_sats_per_token: 100,
    fee_sats: 6600,
  },
};

// Fresh position (opened NOW_MS) — should be SKIPPED when min-age is >0.
const FRESH_POSITION = {
  ...POSITION,
  id: 'pos_test_fresh_0002',
  entry: {
    ...POSITION.entry,
    ts: new Date(NOW_MS).toISOString(),
  },
};

// ─── Constants ──────────────────────────────────────────────────────────

test('orphan-auto-close: constants match the design contract', () => {
  assert.equal(ORPHAN_AUTO_CLOSE_KIND, 'orphan_auto_reconcile');
  assert.equal(ORPHAN_AUTO_CLOSE_SOURCE, 'loop.orphan_auto_reconcile');
  assert.equal(DEFAULT_MIN_AGE_MINUTES, 60);
  assert.equal(ORPHAN_AUTO_CLOSE_FINDING_KIND, 'on_disk_only');
  assert.equal(MAX_FALLBACK_PNL_SATS, -1_000_000);
});

// ─── ageGateMsFromMinutes ──────────────────────────────────────────────

test('orphan-auto-close: ageGateMsFromMinutes defaults to 60 minutes', () => {
  assert.equal(ageGateMsFromMinutes(undefined), 60 * 60_000);
  assert.equal(ageGateMsFromMinutes(null), 60 * 60_000);
});

test('orphan-auto-close: ageGateMsFromMinutes respects explicit finite minutes', () => {
  assert.equal(ageGateMsFromMinutes(0), 0);
  assert.equal(ageGateMsFromMinutes(5), 5 * 60_000);
  assert.equal(ageGateMsFromMinutes(120), 120 * 60_000);
  assert.equal(ageGateMsFromMinutes(0.5), 30_000); // 30 seconds (floored)
});

test('orphan-auto-close: ageGateMsFromMinutes returns 0 for negative minutes (opt-out)', () => {
  assert.equal(ageGateMsFromMinutes(-1), 0);
  assert.equal(ageGateMsFromMinutes(-100), 0);
});

test('orphan-auto-close: ageGateMsFromMinutes falls back to default on non-finite', () => {
  assert.equal(ageGateMsFromMinutes(NaN), 60 * 60_000);
  assert.equal(ageGateMsFromMinutes(Infinity), 60 * 60_000);
  assert.equal(ageGateMsFromMinutes('not-a-number'), 60 * 60_000);
  assert.equal(ageGateMsFromMinutes({}), 60 * 60_000);
});

// ─── positionEntryMs ───────────────────────────────────────────────────

test('orphan-auto-close: positionEntryMs returns ms for numeric ts', () => {
  const pos = { entry: { ts: NOW_MS - 1000 } };
  assert.equal(positionEntryMs(pos), NOW_MS - 1000);
});

test('orphan-auto-close: positionEntryMs returns ms for ISO-8601 string ts', () => {
  const pos = { entry: { ts: '2026-09-01T12:00:00.000Z' } };
  const expected = Date.parse('2026-09-01T12:00:00.000Z');
  assert.equal(positionEntryMs(pos), expected);
});

test('orphan-auto-close: positionEntryMs returns null for missing entry / bad ts', () => {
  assert.equal(positionEntryMs(null), null);
  assert.equal(positionEntryMs({}), null);
  assert.equal(positionEntryMs({ entry: {} }), null);
  assert.equal(positionEntryMs({ entry: { ts: 'not-a-date' } }), null);
  assert.equal(positionEntryMs({ entry: { ts: NaN } }), null);
});

// ─── isOrphanFindingCloseable ──────────────────────────────────────────

const buildIndex = (positions) => {
  const idx = new Map();
  for (const p of positions) idx.set(p.id, p);
  return idx;
};

test('orphan-auto-close: isOrphanFindingCloseable returns true for old orphan / open position / 60-min gate', () => {
  const index = buildIndex([POSITION]);
  assert.equal(isOrphanFindingCloseable(FINDING, index, { nowMs: NOW_MS, minAgeMs: 60 * 60_000 }), true);
});

test('orphan-auto-close: isOrphanFindingCloseable returns false for FRESH orphan when min-age gate > 0', () => {
  const index = buildIndex([FRESH_POSITION]);
  const finding = { ...FINDING, position_id: FRESH_POSITION.id };
  assert.equal(isOrphanFindingCloseable(finding, index, { nowMs: NOW_MS, minAgeMs: 60 * 60_000 }), false);
});

test('orphan-auto-close: isOrphanFindingCloseable returns true for fresh orphan when min-age gate is 0', () => {
  const index = buildIndex([FRESH_POSITION]);
  const finding = { ...FINDING, position_id: FRESH_POSITION.id };
  assert.equal(isOrphanFindingCloseable(finding, index, { nowMs: NOW_MS, minAgeMs: 0 }), true);
});

test('orphan-auto-close: isOrphanFindingCloseable returns false when position is missing from index', () => {
  const index = buildIndex([]); // empty
  assert.equal(isOrphanFindingCloseable(FINDING, index, { nowMs: NOW_MS, minAgeMs: 60 * 60_000 }), false);
});

test('orphan-auto-close: isOrphanFindingCloseable returns false when position is closed', () => {
  const index = buildIndex([{ ...POSITION, status: 'closed' }]);
  assert.equal(isOrphanFindingCloseable(FINDING, index, { nowMs: NOW_MS, minAgeMs: 60 * 60_000 }), false);
});

test('orphan-auto-close: isOrphanFindingCloseable returns false for non-orphan finding kinds', () => {
  const index = buildIndex([POSITION]);
  const f1 = { ...FINDING, kind: 'quantity_mismatch' };
  const f2 = { ...FINDING, kind: 'on_chain_only' };
  const f3 = { ...FINDING, kind: 'consensus' };
  const f4 = { ...FINDING, kind: 'note' };
  for (const f of [f1, f2, f3, f4]) {
    assert.equal(isOrphanFindingCloseable(f, index, { nowMs: NOW_MS, minAgeMs: 60 * 60_000 }), false);
  }
});

test('orphan-auto-close: isOrphanFindingCloseable returns false for medium severity', () => {
  const index = buildIndex([POSITION]);
  const f = { ...FINDING, severity: 'medium' };
  assert.equal(isOrphanFindingCloseable(f, index, { nowMs: NOW_MS, minAgeMs: 60 * 60_000 }), false);
});

test('orphan-auto-close: isOrphanFindingCloseable returns false for missing position_id', () => {
  const index = buildIndex([POSITION]);
  const f = { ...FINDING };
  delete f.position_id;
  assert.equal(isOrphanFindingCloseable(f, index, { nowMs: NOW_MS, minAgeMs: 60 * 60_000 }), false);
});

test('orphan-auto-close: isOrphanFindingCloseable returns false for malformed input', () => {
  const index = buildIndex([POSITION]);
  assert.equal(isOrphanFindingCloseable(null, index, { nowMs: NOW_MS, minAgeMs: 60 * 60_000 }), false);
  assert.equal(isOrphanFindingCloseable('foo', index, { nowMs: NOW_MS, minAgeMs: 60 * 60_000 }), false);
  assert.equal(isOrphanFindingCloseable(42, index, { nowMs: NOW_MS, minAgeMs: 60 * 60_000 }), false);
  assert.equal(isOrphanFindingCloseable(FINDING, null, { nowMs: NOW_MS, minAgeMs: 60 * 60_000 }), false);
});

test('orphan-auto-close: isOrphanFindingCloseable returns false for non-finite nowMs / minAgeMs', () => {
  const index = buildIndex([POSITION]);
  assert.equal(isOrphanFindingCloseable(FINDING, index, { nowMs: NaN, minAgeMs: 60 * 60_000 }), false);
  assert.equal(isOrphanFindingCloseable(FINDING, index, { nowMs: NOW_MS, minAgeMs: NaN }), false);
  assert.equal(isOrphanFindingCloseable(FINDING, index, { nowMs: NOW_MS, minAgeMs: -100 }), false);
});

test('orphan-auto-close: isOrphanFindingCloseable returns false when entry ts missing + non-zero age gate (conservative)', () => {
  const index = buildIndex([{ ...POSITION, entry: { ...POSITION.entry, ts: undefined } }]);
  assert.equal(isOrphanFindingCloseable(FINDING, index, { nowMs: NOW_MS, minAgeMs: 60 * 60_000 }), false);
});

// ─── pickOrphanAutoCloseableFindings ───────────────────────────────────

test('orphan-auto-close: pickOrphanAutoCloseableFindings returns empty for empty input', () => {
  assert.deepEqual(pickOrphanAutoCloseableFindings([], buildIndex([POSITION]), { nowMs: NOW_MS, minAgeMs: 60 * 60_000 }), []);
});

test('orphan-auto-close: pickOrphanAutoCloseableFindings returns empty for non-array input', () => {
  assert.deepEqual(pickOrphanAutoCloseableFindings(null, buildIndex([POSITION]), { nowMs: NOW_MS, minAgeMs: 60 * 60_000 }), []);
  assert.deepEqual(pickOrphanAutoCloseableFindings('foo', buildIndex([POSITION]), { nowMs: NOW_MS, minAgeMs: 60 * 60_000 }), []);
});

test('orphan-auto-close: pickOrphanAutoCloseableFindings filters by min-age gate', () => {
  const findings = [FINDING, { ...FINDING, position_id: FRESH_POSITION.id }];
  const pairs = pickOrphanAutoCloseableFindings(findings, buildIndex([POSITION, FRESH_POSITION]), {
    nowMs: NOW_MS,
    minAgeMs: 60 * 60_000,
  });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].finding.position_id, POS_ID);
  assert.equal(pairs[0].position.id, POS_ID);
});

test('orphan-auto-close: pickOrphanAutoCloseableFindings preserves input order', () => {
  const findings = [
    { ...FINDING, position_id: 'pos_a_0001' },
    { ...FINDING, position_id: 'pos_b_0002' },
    { ...FINDING, position_id: 'pos_c_0003' },
  ];
  const positions = [
    { ...POSITION, id: 'pos_a_0001' },
    { ...POSITION, id: 'pos_b_0002' },
    { ...POSITION, id: 'pos_c_0003' },
  ];
  const pairs = pickOrphanAutoCloseableFindings(findings, buildIndex(positions), {
    nowMs: NOW_MS,
    minAgeMs: 60 * 60_000,
  });
  assert.deepEqual(pairs.map((p) => p.finding.position_id), ['pos_a_0001', 'pos_b_0002', 'pos_c_0003']);
});

test('orphan-auto-close: pickOrphanAutoCloseableFindings skips findings for missing positions', () => {
  const findings = [FINDING, { ...FINDING, position_id: 'pos_missing_9999' }];
  const pairs = pickOrphanAutoCloseableFindings(findings, buildIndex([POSITION]), {
    nowMs: NOW_MS,
    minAgeMs: 60 * 60_000,
  });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].finding.position_id, POS_ID);
});

// ─── buildOrphanAutoCloseExit ──────────────────────────────────────────

test('orphan-auto-close: buildOrphanAutoCloseExit produces a synthetic exit envelope', () => {
  const exit = buildOrphanAutoCloseExit({ finding: FINDING, position: POSITION, nowMs: NOW_MS });
  assert.equal(exit.txid, '');
  assert.equal(exit.bch_received_sats, 0);
  assert.equal(exit.fee_sats, 0);
  assert.equal(exit.price_sats_per_token, 100);
  assert.equal(exit.reason, ORPHAN_AUTO_CLOSE_KIND);
  assert.equal(exit.ts, NOW_ISO);
});

test('orphan-auto-close: buildOrphanAutoCloseExit falls back to price 0 when entry price is missing', () => {
  const pos = { ...POSITION, entry: { ...POSITION.entry, price_sats_per_token: undefined } };
  const exit = buildOrphanAutoCloseExit({ finding: FINDING, position: pos, nowMs: NOW_MS });
  assert.equal(exit.price_sats_per_token, 0);
});

test('orphan-auto-close: buildOrphanAutoCloseExit falls back to price 0 when entry price is non-finite string', () => {
  const pos = { ...POSITION, entry: { ...POSITION.entry, price_sats_per_token: 'not-a-number' } };
  const exit = buildOrphanAutoCloseExit({ finding: FINDING, position: pos, nowMs: NOW_MS });
  assert.equal(exit.price_sats_per_token, 0);
});

test('orphan-auto-close: buildOrphanAutoCloseExit clamps negative price to 0', () => {
  const pos = { ...POSITION, entry: { ...POSITION.entry, price_sats_per_token: -100 } };
  const exit = buildOrphanAutoCloseExit({ finding: FINDING, position: pos, nowMs: NOW_MS });
  assert.equal(exit.price_sats_per_token, 0);
});

test('orphan-auto-close: buildOrphanAutoCloseExit throws for malformed input', () => {
  assert.throws(() => buildOrphanAutoCloseExit({ finding: null, position: POSITION, nowMs: NOW_MS }), /finding/);
  assert.throws(() => buildOrphanAutoCloseExit({ finding: FINDING, position: null, nowMs: NOW_MS }), /position/);
  assert.throws(() => buildOrphanAutoCloseExit({ finding: FINDING, position: POSITION, nowMs: NaN }), /nowMs/);
});

// ─── computeOrphanAutoCloseRealizedPnlSats ─────────────────────────────

test('orphan-auto-close: computeOrphanAutoCloseRealizedPnlSats returns -entry.fee_sats when fee is positive', () => {
  const pnl = computeOrphanAutoCloseRealizedPnlSats({ position: POSITION });
  assert.equal(pnl, -6600);
});

test('orphan-auto-close: computeOrphanAutoCloseRealizedPnlSats accepts string fee_sats', () => {
  const pos = { ...POSITION, entry: { ...POSITION.entry, fee_sats: '1234' } };
  const pnl = computeOrphanAutoCloseRealizedPnlSats({ position: pos });
  assert.equal(pnl, -1234);
});

test('orphan-auto-close: computeOrphanAutoCloseRealizedPnlSats falls back to MAX_FALLBACK_PNL_SATS when fee is missing', () => {
  const pos = { ...POSITION, entry: { ...POSITION.entry, fee_sats: undefined } };
  const pnl = computeOrphanAutoCloseRealizedPnlSats({ position: pos });
  assert.equal(pnl, MAX_FALLBACK_PNL_SATS);
});

test('orphan-auto-close: computeOrphanAutoCloseRealizedPnlSats falls back to MAX_FALLBACK_PNL_SATS when fee is 0 or negative', () => {
  const p1 = computeOrphanAutoCloseRealizedPnlSats({ position: { ...POSITION, entry: { ...POSITION.entry, fee_sats: 0 } } });
  const p2 = computeOrphanAutoCloseRealizedPnlSats({ position: { ...POSITION, entry: { ...POSITION.entry, fee_sats: -100 } } });
  assert.equal(p1, MAX_FALLBACK_PNL_SATS);
  assert.equal(p2, MAX_FALLBACK_PNL_SATS);
});

test('orphan-auto-close: computeOrphanAutoCloseRealizedPnlSats throws for malformed input', () => {
  assert.throws(() => computeOrphanAutoCloseRealizedPnlSats({ position: null }), /position/);
  assert.throws(() => computeOrphanAutoCloseRealizedPnlSats({}), /position/);
});

// ─── buildOrphanAutoClosePlan ──────────────────────────────────────────

test('orphan-auto-close: buildOrphanAutoClosePlan produces a typed envelope', () => {
  const plan = buildOrphanAutoClosePlan({ pair: { finding: FINDING, position: POSITION }, nowMs: NOW_MS });
  assert.equal(plan.positionId, POS_ID);
  assert.equal(plan.exit.reason, ORPHAN_AUTO_CLOSE_KIND);
  assert.equal(plan.realizedPnlSats, -6600);
  assert.equal(plan.tokenId, TOKEN_ID);
  assert.equal(plan.tokenSymbol, 'TST');
  assert.ok(plan.ageMs !== null && Number.isFinite(plan.ageMs) && plan.ageMs > 0);
  assert.equal(plan.reason, ORPHAN_AUTO_CLOSE_KIND);
});

test('orphan-auto-close: buildOrphanAutoClosePlan lowercases token_id', () => {
  const upperFinding = { ...FINDING, token_id: TOKEN_ID.toUpperCase() };
  const plan = buildOrphanAutoClosePlan({ pair: { finding: upperFinding, position: POSITION }, nowMs: NOW_MS });
  assert.equal(plan.tokenId, TOKEN_ID);
});

test('orphan-auto-close: buildOrphanAutoClosePlan returns null tokenId/tokenSymbol when missing', () => {
  const f = { ...FINDING };
  delete f.token_id;
  delete f.token_symbol;
  const plan = buildOrphanAutoClosePlan({ pair: { finding: f, position: POSITION }, nowMs: NOW_MS });
  assert.equal(plan.tokenId, null);
  assert.equal(plan.tokenSymbol, null);
});

test('orphan-auto-close: buildOrphanAutoClosePlan throws for malformed input', () => {
  assert.throws(() => buildOrphanAutoClosePlan({ pair: null, nowMs: NOW_MS }), /pair/);
  // Empty-object pair fails on the destructured-finding position_id check.
  assert.throws(() => buildOrphanAutoClosePlan({ pair: {}, nowMs: NOW_MS }), /pair|position_id/);
  assert.throws(() => buildOrphanAutoClosePlan({ pair: { finding: {}, position: POSITION }, nowMs: NOW_MS }), /position_id/);
  assert.throws(() => buildOrphanAutoClosePlan({ pair: { finding: FINDING, position: POSITION }, nowMs: NaN }), /nowMs/);
});

// ─── executeOrphanAutoClose ────────────────────────────────────────────

test('orphan-auto-close: executeOrphanAutoClose happy path returns ok:true', async () => {
  const plan = buildOrphanAutoClosePlan({ pair: { finding: FINDING, position: POSITION }, nowMs: NOW_MS });
  let captured = null;
  const positions = {
    close: async (id, exit, pnl) => {
      captured = { id, exit, pnl };
      return { id, status: 'closed', exit, realized_pnl_sats: pnl };
    },
  };
  const result = await executeOrphanAutoClose({ plan, positions, nowMs: NOW_MS });
  assert.equal(result.ok, true);
  assert.equal(result.positionId, POS_ID);
  assert.equal(result.error, null);
  assert.equal(captured.id, POS_ID);
  assert.equal(captured.exit.reason, ORPHAN_AUTO_CLOSE_KIND);
  assert.equal(captured.pnl, -6600);
});

test('orphan-auto-close: executeOrphanAutoClose captures positions.close() throw', async () => {
  const plan = buildOrphanAutoClosePlan({ pair: { finding: FINDING, position: POSITION }, nowMs: NOW_MS });
  const positions = {
    close: async () => {
      throw new Error('disk on fire');
    },
  };
  const result = await executeOrphanAutoClose({ plan, positions, nowMs: NOW_MS, logger: { warn: () => {} } });
  assert.equal(result.ok, false);
  assert.equal(result.positionId, POS_ID);
  assert.equal(result.error, 'disk on fire');
});

test('orphan-auto-close: executeOrphanAutoClose captures positions.close() returning mismatch id', async () => {
  const plan = buildOrphanAutoClosePlan({ pair: { finding: FINDING, position: POSITION }, nowMs: NOW_MS });
  const positions = {
    close: async () => ({ id: 'wrong-id' }),
  };
  const result = await executeOrphanAutoClose({ plan, positions, nowMs: NOW_MS });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'close_returned_mismatch');
});

test('orphan-auto-close: executeOrphanAutoClose returns error envelope when positions.close is missing', async () => {
  const plan = buildOrphanAutoClosePlan({ pair: { finding: FINDING, position: POSITION }, nowMs: NOW_MS });
  const result = await executeOrphanAutoClose({ plan, positions: null, nowMs: NOW_MS });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'positions_close_unavailable');
});

test('orphan-auto-close: executeOrphanAutoClose returns error envelope when plan is missing', async () => {
  const result = await executeOrphanAutoClose({ plan: null, positions: { close: async () => {} }, nowMs: NOW_MS });
  assert.equal(result.ok, false);
  assert.equal(result.positionId, '<unknown>');
  assert.equal(result.error, 'plan_missing');
});

// ─── buildOrphanAutoCloseAuditRecord ──────────────────────────────────

test('orphan-auto-close: buildOrphanAutoCloseAuditRecord produces the audit row shape', () => {
  const plan = buildOrphanAutoClosePlan({ pair: { finding: FINDING, position: POSITION }, nowMs: NOW_MS });
  const result = { ok: true, positionId: POS_ID, error: null };
  const audit = buildOrphanAutoCloseAuditRecord({ plan, result, nowMs: NOW_MS });
  assert.equal(audit.kind, ORPHAN_AUTO_CLOSE_KIND);
  assert.equal(audit.source, ORPHAN_AUTO_CLOSE_SOURCE);
  assert.equal(audit.ts, NOW_ISO);
  assert.equal(audit.position_id, POS_ID);
  assert.equal(audit.token_id, TOKEN_ID);
  assert.equal(audit.token_symbol, 'TST');
  assert.equal(audit.realized_pnl_sats, -6600);
  assert.equal(audit.ok, true);
  assert.equal(audit.error, null);
  assert.ok(audit.exit && audit.exit.reason === ORPHAN_AUTO_CLOSE_KIND);
});

test('orphan-auto-close: buildOrphanAutoCloseAuditRecord surfaces ok:false error', () => {
  const plan = buildOrphanAutoClosePlan({ pair: { finding: FINDING, position: POSITION }, nowMs: NOW_MS });
  const result = { ok: false, positionId: POS_ID, error: 'disk on fire' };
  const audit = buildOrphanAutoCloseAuditRecord({ plan, result, nowMs: NOW_MS });
  assert.equal(audit.ok, false);
  assert.equal(audit.error, 'disk on fire');
});

test('orphan-auto-close: buildOrphanAutoCloseAuditRecord throws for malformed input', () => {
  const plan = buildOrphanAutoClosePlan({ pair: { finding: FINDING, position: POSITION }, nowMs: NOW_MS });
  assert.throws(() => buildOrphanAutoCloseAuditRecord({ plan: null, result: {}, nowMs: NOW_MS }), /plan/);
  assert.throws(() => buildOrphanAutoCloseAuditRecord({ plan, result: null, nowMs: NOW_MS }), /result/);
  assert.throws(() => buildOrphanAutoCloseAuditRecord({ plan, result: {}, nowMs: NaN }), /nowMs/);
});
