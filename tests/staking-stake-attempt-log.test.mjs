import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildStakeAttemptEvent,
  appendStakeAttempt,
  readStakeAttemptsTail,
  STAKE_ATTEMPT_LOG_SCHEMA,
  DEFAULT_STAKE_ATTEMPT_LOG_FILE,
  DEFAULT_STAKE_ATTEMPT_LOG_TAIL,
} from '../src/staking/stake-attempt-log.mjs';

function tmpFile() {
  const dir = mkdtempSync(join(tmpdir(), 'stake-attempt-log-'));
  return { dir, file: join(dir, 'attempts.jsonl') };
}

// ─── Pure helpers ────────────────────────────────────────────────────────

test('stake-attempt-log: buildStakeAttemptEvent shapes lock/success envelope', () => {
  const ev = buildStakeAttemptEvent({
    kind: 'lock',
    phase: 'success',
    result: { ok: true, txid: 'a'.repeat(64), code: null, error: null },
    context: { tick_id: 42, amount_sats: 50000n, stake_blocks: 1440, wallet_balance_sats: 100000n },
    nowMs: 1_700_000_000_000,
  });
  assert.equal(ev.v, 1);
  assert.equal(ev.schema ?? ev.kind, 'lock'); // schema is on the file, not the row
  assert.equal(ev.kind, 'lock');
  assert.equal(ev.phase, 'success');
  assert.equal(ev.ok, true);
  assert.equal(ev.txid, 'a'.repeat(64));
  assert.equal(ev.amount_sats, '50000');
  assert.equal(ev.stake_blocks, 1440);
  assert.equal(ev.tick_id, 42);
});

test('stake-attempt-log: buildStakeAttemptEvent handles missing fields defensively', () => {
  const ev = buildStakeAttemptEvent({ kind: 'lock', phase: 'attempt', nowMs: 1 });
  assert.equal(ev.ok, false);
  assert.equal(ev.txid, null);
  assert.equal(ev.code, null);
  assert.equal(ev.amount_sats, null);
  assert.equal(ev.tried, null);
});

test('stake-attempt-log: buildStakeAttemptEvent propagates the tried[] audit trail (T70-2 wire-up)', () => {
  const tried = [{ endpoint: 'new', ok: false, code: 'HTTP_ERROR' }];
  const ev = buildStakeAttemptEvent({
    kind: 'lock',
    phase: 'failed',
    result: { ok: false, code: 'NO_MASTER', error: 'no masterBadger UTXO found', tried },
    context: {},
    nowMs: 1,
  });
  assert.equal(ev.tried, tried);
});

// ─── I/O wrappers ────────────────────────────────────────────────────────

test('stake-attempt-log: appendStakeAttempt writes a single NDJSON line', async () => {
  const { dir, file } = tmpFile();
  try {
    const ev = buildStakeAttemptEvent({ kind: 'lock', phase: 'failed', result: { ok: false, code: 'NO_MASTER', error: 'x' }, nowMs: 1 });
    const r = await appendStakeAttempt({ event: ev, file, appender: async (f, l) => { writeFileSync(f, l, { flag: 'a' }); } });
    assert.equal(r.ok, true);
    assert.equal(r.persisted, true);
    const content = readFileSync(file, 'utf8');
    assert.equal(content.split('\n').filter(Boolean).length, 1);
    assert.match(content, /"code":"NO_MASTER"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stake-attempt-log: appendStakeAttempt is no-op when file is empty string', async () => {
  const r = await appendStakeAttempt({ event: { kind: 'lock' }, file: '' });
  assert.equal(r.ok, true);
  assert.equal(r.persisted, false);
});

test('stake-attempt-log: readStakeAttemptsTail returns newest-first and skips malformed rows', async () => {
  const { dir, file } = tmpFile();
  try {
    // Three valid rows + one bad JSON line.
    const ev1 = buildStakeAttemptEvent({ kind: 'lock', phase: 'failed', result: { ok: false, code: 'NO_MASTER' }, nowMs: 1000 });
    const ev2 = buildStakeAttemptEvent({ kind: 'lock', phase: 'failed', result: { ok: false, code: 'STALE_LOCK_EXISTS' }, nowMs: 2000 });
    const ev3 = buildStakeAttemptEvent({ kind: 'unlock', phase: 'success', result: { ok: true, txid: 'b'.repeat(64) }, nowMs: 3000 });
    writeFileSync(file, JSON.stringify(ev1) + '\n' + '{ not json\n' + JSON.stringify(ev2) + '\n' + JSON.stringify(ev3) + '\n');
    const tail = await readStakeAttemptsTail({ file, max: 10 });
    assert.equal(tail.attempts.length, 3);
    assert.equal(tail.attempts[0].kind, 'unlock');
    assert.equal(tail.attempts[0].phase, 'success');
    assert.equal(tail.attempts[2].kind, 'lock');
    assert.ok(tail.loadErrors.length >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stake-attempt-log: readStakeAttemptsTail returns empty on ENOENT', async () => {
  const tail = await readStakeAttemptsTail({ file: '/nonexistent/attempts.jsonl' });
  assert.deepEqual(tail.attempts, []);
  assert.deepEqual(tail.loadErrors, []);
});

test('stake-attempt-log: schema constant matches the wire format', () => {
  assert.match(STAKE_ATTEMPT_LOG_SCHEMA, /^tradebot\.staking\.attempt-log\/v1$/);
  assert.match(DEFAULT_STAKE_ATTEMPT_LOG_FILE, /data\/stake-attempts\.jsonl$/);
  assert.equal(typeof DEFAULT_STAKE_ATTEMPT_LOG_TAIL, 'number');
  assert.ok(DEFAULT_STAKE_ATTEMPT_LOG_TAIL > 0);
});
