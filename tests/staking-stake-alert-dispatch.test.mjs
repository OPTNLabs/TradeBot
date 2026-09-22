#!/usr/bin/env node
// tests/staking-stake-alert-dispatch.test.mjs
//
// Unit tests for `src/staking/stake-alert-dispatch.mjs` — the
// pure projection + dispatch wrapper that turns
// `executeLock` / `executeUnlock` envelopes into AlertEvents routed
// through the T53 alert pipeline (channel router + NDJSON appender).
//
// Pure builders (`classifyStakeResult`, `buildStakeAlertEvent`,
// `mapResultsToStakeAlerts`) get their own isolated tests with zero
// mocks. The dispatch wrapper (`dispatchStakeAlert`) is tested
// against minimal router + appender stubs to lock the contract:
// NEVER throws, captures per-event failures, returns the typed
// `{ok, dispatched, persisted, failed, errors}` envelope.
//
// Run with:
//   node --test tests/staking-stake-alert-dispatch.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STAKE_LOCK_ALERT_KIND,
  STAKE_UNLOCK_ALERT_KIND,
  STAKE_FAILED_ALERT_KIND,
  STAKE_SUCCESS_SEVERITY,
  STAKE_FAILED_SEVERITY,
  classifyStakeResult,
  buildStakeAlertEvent,
  mapResultsToStakeAlerts,
  dispatchStakeAlert,
  _internals,
} from '../src/staking/stake-alert-dispatch.mjs';

const NOW_MS = 1_700_000_000_000;

// ─────────────────────────────────────────────────────────────────────
//  Constants — shape lock so the T58-3 trader-loop tests can mirror
//  these assertions without re-importing.
// ─────────────────────────────────────────────────────────────────────

test('constants: alert kinds match the T53 AlertKind union surface', () => {
  assert.equal(STAKE_LOCK_ALERT_KIND, 'stake_locked');
  assert.equal(STAKE_UNLOCK_ALERT_KIND, 'stake_unlock');
  assert.equal(STAKE_FAILED_ALERT_KIND, 'stake_failed');
  assert.equal(STAKE_SUCCESS_SEVERITY, 'info');
  assert.equal(STAKE_FAILED_SEVERITY, 'warn');
});

test('_internals: re-exports the public constants for test-side drift detection', () => {
  assert.equal(_internals.STAKE_LOCK_ALERT_KIND, 'stake_locked');
  assert.equal(_internals.STAKE_UNLOCK_ALERT_KIND, 'stake_unlock');
  assert.equal(_internals.STAKE_FAILED_ALERT_KIND, 'stake_failed');
  assert.equal(_internals.STAKE_SUCCESS_SEVERITY, 'info');
  assert.equal(_internals.STAKE_FAILED_SEVERITY, 'warn');
});

// ─────────────────────────────────────────────────────────────────────
//  classifyStakeResult — pure coercion helper
// ─────────────────────────────────────────────────────────────────────

test('classifyStakeResult: lock success → kind=lock, ok=true, txid set', () => {
  const r = classifyStakeResult({
    kind: 'lock',
    ok: true,
    code: null,
    error: null,
    txid: 'ab'.repeat(32),
  });
  assert.equal(r.kind, 'lock');
  assert.equal(r.ok, true);
  assert.equal(r.txid, 'ab'.repeat(32));
  assert.equal(r.code, null);
  assert.equal(r.error, null);
});

test('classifyStakeResult: unlock refusal → kind=unlock, ok=false, code=STALE_LOCK_EXISTS', () => {
  const r = classifyStakeResult({
    kind: 'unlock',
    ok: false,
    code: 'STALE_LOCK_EXISTS',
    error: 'wallet already holds 1 lockNFT',
    txid: null,
  });
  assert.equal(r.kind, 'unlock');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'STALE_LOCK_EXISTS');
  assert.match(r.error, /already holds/);
  assert.equal(r.txid, null);
});

test('classifyStakeResult: bad input → kind=null, ok=false', () => {
  assert.equal(classifyStakeResult(null).kind, null);
  assert.equal(classifyStakeResult(undefined).kind, null);
  assert.equal(classifyStakeResult('not an object').kind, null);
  assert.equal(classifyStakeResult(42).kind, null);
  assert.equal(classifyStakeResult({}).kind, null);
  assert.equal(classifyStakeResult({ ok: 'yes' }).kind, null);
  assert.equal(classifyStakeResult({ ok: true, kind: 'banana' }).kind, null);
});

test('classifyStakeResult: missing code/error/txid → nulls', () => {
  const r = classifyStakeResult({ kind: 'lock', ok: false });
  assert.equal(r.code, null);
  assert.equal(r.error, null);
  assert.equal(r.txid, null);
});

// ─────────────────────────────────────────────────────────────────────
//  buildStakeAlertEvent — pure event builder
// ─────────────────────────────────────────────────────────────────────

test('buildStakeAlertEvent: lock success → stake_locked / info', () => {
  const ev = buildStakeAlertEvent({
    result: {
      kind: 'lock',
      ok: true,
      txid: 'cd'.repeat(32),
      amountSats: 500000n,
      stakeBlocks: 1440,
      fee: '243',
    },
    nowMs: NOW_MS,
  });
  assert.equal(ev.kind, 'stake_locked');
  assert.equal(ev.severity, 'info');
  assert.match(ev.title, /^stake_locked:/);
  assert.match(ev.title, /cdcdcdcdcdcdcdcd/);
  assert.match(ev.body, /stake locked — txid/);
  assert.match(ev.body, /cdcdcdcdcdcdcdcd/);
  assert.equal(ev.context.requested_kind, 'lock');
  assert.equal(ev.context.ok, true);
  assert.equal(ev.context.txid, 'cd'.repeat(32));
  assert.equal(ev.context.amount_sats, '500000');
  assert.equal(ev.context.stake_blocks, 1440);
  assert.equal(ev.context.fee_sats, '243');
  assert.equal(ev.context.now_ms, NOW_MS);
  assert.equal(ev.ts, NOW_MS);
});

test('buildStakeAlertEvent: unlock success → stake_unlock / info', () => {
  const ev = buildStakeAlertEvent({
    result: {
      kind: 'unlock',
      ok: true,
      txid: 'ef'.repeat(32),
      fee: '210',
    },
    nowMs: NOW_MS,
  });
  assert.equal(ev.kind, 'stake_unlock');
  assert.equal(ev.severity, 'info');
  assert.match(ev.title, /^stake_unlock:/);
  assert.match(ev.body, /stake unlocked/);
  assert.equal(ev.context.requested_kind, 'unlock');
  assert.equal(ev.context.ok, true);
  assert.equal(ev.context.fee_sats, '210');
});

test('buildStakeAlertEvent: lock refusal → stake_failed / warn (BELOW_MIN_BALANCE)', () => {
  const ev = buildStakeAlertEvent({
    result: {
      kind: 'lock',
      ok: false,
      code: 'BELOW_MIN_BALANCE',
      error: 'wallet 0.001 BCH < 0.005 BCH reserve',
      txid: null,
      wallet_balance_sats: '100000',
      min_balance_bch: 0.005,
    },
    nowMs: NOW_MS,
  });
  assert.equal(ev.kind, 'stake_failed');
  assert.equal(ev.severity, 'warn');
  assert.match(ev.title, /^stake_failed:lock_below_min_balance$/);
  assert.match(ev.body, /stake lock refused/);
  assert.match(ev.body, /BELOW_MIN_BALANCE/);
  assert.match(ev.body, /< 0\.005 BCH/);
  assert.equal(ev.context.code, 'BELOW_MIN_BALANCE');
  assert.equal(ev.context.error, 'wallet 0.001 BCH < 0.005 BCH reserve');
});

test('buildStakeAlertEvent: unlock refusal → stake_failed / warn (SIMULATE_VIOLATIONS)', () => {
  const ev = buildStakeAlertEvent({
    result: {
      kind: 'unlock',
      ok: false,
      code: 'SIMULATE_VIOLATIONS',
      error: 'timelock not yet expired',
      txid: null,
    },
    nowMs: NOW_MS,
  });
  assert.equal(ev.kind, 'stake_failed');
  assert.equal(ev.severity, 'warn');
  assert.match(ev.title, /^stake_failed:unlock_simulate_violations$/);
  assert.equal(ev.context.code, 'SIMULATE_VIOLATIONS');
});

test('buildStakeAlertEvent: explicit event_id round-trips onto the event', () => {
  const ev = buildStakeAlertEvent({
    result: { kind: 'lock', ok: true, txid: '11'.repeat(32) },
    nowMs: NOW_MS,
    event_id: 'stake-event-001',
  });
  assert.equal(ev.event_id, 'stake-event-001');
});

test('buildStakeAlertEvent: rejects missing result → TypeError', () => {
  assert.throws(
    () => buildStakeAlertEvent({ nowMs: NOW_MS }),
    TypeError,
    /result must be a plain object/,
  );
});

test('buildStakeAlertEvent: rejects missing nowMs → TypeError', () => {
  assert.throws(
    () => buildStakeAlertEvent({ result: { kind: 'lock', ok: true, txid: 'ab'.repeat(32) } }),
    TypeError,
    /nowMs must be a finite number/,
  );
});

test('buildStakeAlertEvent: bigint fee_sats → decimal string in context', () => {
  const ev = buildStakeAlertEvent({
    result: { kind: 'lock', ok: true, txid: 'aa'.repeat(32), fee_sats: 432n },
    nowMs: NOW_MS,
  });
  assert.equal(ev.context.fee_sats, '432');
});

test('buildStakeAlertEvent: ok=true but missing txid → falls back to failed envelope', () => {
  const ev = buildStakeAlertEvent({
    result: { kind: 'lock', ok: true, code: null, error: null, txid: null },
    nowMs: NOW_MS,
  });
  // Without a txid we can't claim success → the builder degrades
  // gracefully to a failed envelope so the operator still sees a
  // row in the audit trail.
  assert.equal(ev.kind, 'stake_failed');
  assert.equal(ev.severity, 'warn');
});

// ─────────────────────────────────────────────────────────────────────
//  mapResultsToStakeAlerts — pure projection
// ─────────────────────────────────────────────────────────────────────

test('mapResultsToStakeAlerts: empty / non-array input → []', () => {
  assert.deepEqual(mapResultsToStakeAlerts([], { nowMs: NOW_MS }), []);
  assert.deepEqual(mapResultsToStakeAlerts(null, { nowMs: NOW_MS }), []);
  assert.deepEqual(mapResultsToStakeAlerts('not-an-array', { nowMs: NOW_MS }), []);
});

test('mapResultsToStakeAlerts: missing nowMs → [] (defensive no-op)', () => {
  const r = mapResultsToStakeAlerts([{ kind: 'lock', ok: true, txid: 'aa'.repeat(32) }], {});
  assert.deepEqual(r, []);
});

test('mapResultsToStakeAlerts: mixed lock success + lock refusal → 2 events with the right kinds', () => {
  const events = mapResultsToStakeAlerts([
    { kind: 'lock', ok: true, txid: 'aa'.repeat(32) },
    { kind: 'lock', ok: false, code: 'BELOW_MIN_BALANCE', error: 'low', txid: null },
  ], { nowMs: NOW_MS });
  assert.equal(events.length, 2);
  assert.equal(events[0].kind, 'stake_locked');
  assert.equal(events[1].kind, 'stake_failed');
});

test('mapResultsToStakeAlerts: skips null / non-object entries', () => {
  const events = mapResultsToStakeAlerts([
    null,
    undefined,
    'string',
    42,
    { kind: 'lock', ok: true, txid: 'aa'.repeat(32) },
  ], { nowMs: NOW_MS });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'stake_locked');
});

// ─────────────────────────────────────────────────────────────────────
//  dispatchStakeAlert — dispatch wrapper
// ─────────────────────────────────────────────────────────────────────

function makeMemoryLogger() {
  /** @type {Array<{level: string, event: string, payload: Object}>} */
  const records = [];
  const rec = (level) => (event, payload) => {
    records.push({ level, event, payload: (payload && typeof payload === 'object') ? payload : {} });
  };
  return {
    records,
    info: rec('info'),
    warn: rec('warn'),
    error: rec('error'),
  };
}

test('dispatchStakeAlert: empty results → ok envelope, zero counts', async () => {
  const result = await dispatchStakeAlert({
    results: [],
    nowMs: NOW_MS,
    router: null,
    appender: null,
  });
  assert.equal(result.ok, true);
  assert.equal(result.dispatched, 0);
  assert.equal(result.persisted, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.events, []);
});

test('dispatchStakeAlert: lock success → persists + dispatches when both seams present', async () => {
  let appendCount = 0;
  let dispatchCount = 0;
  /** @type {Array<any>} */
  const persisted = [];
  /** @type {Array<any>} */
  const routed = [];
  const appender = async (ev) => {
    appendCount += 1;
    persisted.push(ev);
    return { ok: true };
  };
  const router = {
    async dispatch(ev) {
      dispatchCount += 1;
      routed.push(ev);
      return { ok: true, dispatched: 1 };
    },
  };
  const logger = makeMemoryLogger();

  const result = await dispatchStakeAlert({
    results: [{ kind: 'lock', ok: true, txid: 'aa'.repeat(32) }],
    nowMs: NOW_MS,
    router,
    appender,
    logger,
  });

  assert.equal(result.ok, true);
  assert.equal(result.dispatched, 1);
  assert.equal(result.persisted, 1);
  assert.equal(result.failed, 0);
  assert.equal(appendCount, 1);
  assert.equal(dispatchCount, 1);
  assert.equal(persisted[0].kind, 'stake_locked');
  assert.equal(routed[0].kind, 'stake_locked');
});

test('dispatchStakeAlert: appender present, router null → persists but does not dispatch', async () => {
  let persistedCount = 0;
  const appender = async () => { persistedCount += 1; return { ok: true }; };

  const result = await dispatchStakeAlert({
    results: [{ kind: 'lock', ok: true, txid: 'aa'.repeat(32) }],
    nowMs: NOW_MS,
    router: null,
    appender,
  });

  assert.equal(persistedCount, 1);
  assert.equal(result.dispatched, 0);
  assert.equal(result.persisted, 1);
});

test('dispatchStakeAlert: appender absent, router present → dispatches but does not persist', async () => {
  let dispatchCount = 0;
  const router = { async dispatch() { dispatchCount += 1; return { ok: true, dispatched: 1 }; } };

  const result = await dispatchStakeAlert({
    results: [{ kind: 'lock', ok: true, txid: 'aa'.repeat(32) }],
    nowMs: NOW_MS,
    router,
    appender: null,
  });

  assert.equal(dispatchCount, 1);
  assert.equal(result.dispatched, 1);
  assert.equal(result.persisted, 0);
});

test('dispatchStakeAlert: appender throws → captures + reports failure, dispatch still runs', async () => {
  const appender = async () => { throw new Error('disk full'); };
  let dispatchCount = 0;
  const router = { async dispatch() { dispatchCount += 1; return { ok: true, dispatched: 1 }; } };
  const logger = makeMemoryLogger();

  const result = await dispatchStakeAlert({
    results: [{ kind: 'lock', ok: true, txid: 'aa'.repeat(32) }],
    nowMs: NOW_MS,
    router,
    appender,
    logger,
  });

  assert.equal(result.failed, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].stage, 'persist');
  assert.match(result.errors[0].error, /disk full/);
  assert.equal(result.dispatched, 1);
  // The warn line was logged for the persist failure.
  assert.ok(logger.records.some((r) => r.event === 'alerts.stake.persist.failed'));
});

test('dispatchStakeAlert: appender returns ok:false → captured as failure', async () => {
  const appender = async () => ({ ok: false, error: { message: 'EACCES' } });
  const router = { async dispatch() { return { ok: true, dispatched: 1 }; } };
  const logger = makeMemoryLogger();

  const result = await dispatchStakeAlert({
    results: [{ kind: 'lock', ok: true, txid: 'aa'.repeat(32) }],
    nowMs: NOW_MS,
    router,
    appender,
    logger,
  });

  assert.equal(result.failed, 1);
  assert.equal(result.errors[0].stage, 'persist');
  assert.match(result.errors[0].error, /EACCES/);
  assert.ok(result.ok === false, 'ok envelope must flip to false when any stage failed');
});

test('dispatchStakeAlert: router throws → captures + reports failure', async () => {
  const appender = async () => ({ ok: true });
  const router = { async dispatch() { throw new Error('telegram 5xx'); } };
  const logger = makeMemoryLogger();

  const result = await dispatchStakeAlert({
    results: [{ kind: 'lock', ok: true, txid: 'aa'.repeat(32) }],
    nowMs: NOW_MS,
    router,
    appender,
    logger,
  });

  assert.equal(result.failed, 1);
  assert.equal(result.errors[0].stage, 'dispatch');
  assert.match(result.errors[0].error, /telegram 5xx/);
  assert.ok(logger.records.some((r) => r.event === 'alerts.stake.dispatch.failed'));
  // Persist succeeded → count = 1
  assert.equal(result.persisted, 1);
});

test('dispatchStakeAlert: router returns ok:false → non-fatal warn logged, count still bumps', async () => {
  const appender = async () => ({ ok: true });
  const router = { async dispatch() { return { ok: false, dispatched: 0, channels_ready: 0, errors: ['telegram-token-missing'] }; } };
  const logger = makeMemoryLogger();

  const result = await dispatchStakeAlert({
    results: [{ kind: 'lock', ok: true, txid: 'aa'.repeat(32) }],
    nowMs: NOW_MS,
    router,
    appender,
    logger,
  });

  assert.equal(result.dispatched, 1, 'dispatch counter bumps even when all channels refused');
  assert.equal(result.failed, 0, 'no per-event failure when router returns ok:false (channels refused is informational)');
  assert.ok(logger.records.some((r) => r.event === 'alerts.stake.dispatch.no_op'));
});

test('dispatchStakeAlert: multiple results → each one persisted + dispatched independently', async () => {
  /** @type {Array<any>} */
  const persisted = [];
  /** @type {Array<any>} */
  const routed = [];
  const appender = async (ev) => { persisted.push(ev); return { ok: true }; };
  const router = { async dispatch(ev) { routed.push(ev); return { ok: true, dispatched: 1 }; } };

  const result = await dispatchStakeAlert({
    results: [
      { kind: 'lock', ok: true, txid: 'aa'.repeat(32) },
      { kind: 'unlock', ok: true, txid: 'bb'.repeat(32) },
      { kind: 'lock', ok: false, code: 'STALE_LOCK_EXISTS', error: 'has lock' },
    ],
    nowMs: NOW_MS,
    router,
    appender,
  });

  assert.equal(result.dispatched, 3);
  assert.equal(result.persisted, 3);
  assert.equal(result.failed, 0);
  assert.equal(persisted[0].kind, 'stake_locked');
  assert.equal(persisted[1].kind, 'stake_unlock');
  assert.equal(persisted[2].kind, 'stake_failed');
  assert.equal(routed[0].kind, 'stake_locked');
  assert.equal(routed[1].kind, 'stake_unlock');
  assert.equal(routed[2].kind, 'stake_failed');
});

test('dispatchStakeAlert: never throws even when EVERY seam throws', async () => {
  const appender = async () => { throw new Error('disk full'); };
  const router = { async dispatch() { throw new Error('net down'); } };

  // The contract: NO exception escapes, even when every seam
  // misbehaves.
  const result = await dispatchStakeAlert({
    results: [
      { kind: 'lock', ok: true, txid: 'aa'.repeat(32) },
      { kind: 'unlock', ok: true, txid: 'bb'.repeat(32) },
    ],
    nowMs: NOW_MS,
    router,
    appender,
  });

  assert.equal(result.failed, 4, 'both events × both stages failed');
  assert.equal(result.errors.length, 4);
  assert.equal(result.dispatched, 0);
  assert.equal(result.persisted, 0);
  assert.equal(result.ok, false);
});

test('dispatchStakeAlert: logger absent → no crash, no log lines', async () => {
  // No logger seam at all. The dispatch must still return the
  // typed envelope; just skip the structured-warn path.
  const result = await dispatchStakeAlert({
    results: [{ kind: 'lock', ok: true, txid: 'aa'.repeat(32) }],
    nowMs: NOW_MS,
    router: { async dispatch() { return { ok: true, dispatched: 1 }; } },
    appender: null,
  });
  assert.equal(result.dispatched, 1);
});