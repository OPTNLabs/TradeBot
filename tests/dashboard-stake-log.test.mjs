import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildStakingLogResponse,
  STAKING_LOG_SCHEMA,
} from '../src/dashboard/stake-log.mjs';
import {
  buildStakeAttemptEvent,
} from '../src/staking/stake-attempt-log.mjs';

function tmpFile() {
  const dir = mkdtempSync(join(tmpdir(), 'dashboard-stake-log-'));
  return { dir, file: join(dir, 'attempts.jsonl') };
}

test('dashboard-stake-log: returns empty tail + load_errors:[] on ENOENT', async () => {
  const r = await buildStakingLogResponse({
    cfg: {},
    clock: () => 1_700_000_000_000,
  });
  assert.equal(r.schema, STAKING_LOG_SCHEMA);
  assert.equal(r.count, 0);
  assert.deepEqual(r.attempts, []);
  assert.ok(r.max > 0);
  assert.deepEqual(r.load_errors, []);
});

test('dashboard-stake-log: returns the most-recent attempts newest-first', async () => {
  const { dir, file } = tmpFile();
  try {
    const ev1 = buildStakeAttemptEvent({ kind: 'lock', phase: 'failed', result: { ok: false, code: 'NO_MASTER', error: 'no masterBadger' }, context: {}, nowMs: 1000 });
    const ev2 = buildStakeAttemptEvent({ kind: 'lock', phase: 'success', result: { ok: true, txid: 'a'.repeat(64) }, context: {}, nowMs: 2000 });
    const ev3 = buildStakeAttemptEvent({ kind: 'unlock', phase: 'failed', result: { ok: false, code: 'EXECUTE_THREW', error: 'x' }, context: {}, nowMs: 3000 });
    writeFileSync(file, JSON.stringify(ev1) + '\n' + JSON.stringify(ev2) + '\n' + JSON.stringify(ev3) + '\n');
    const r = await buildStakingLogResponse({
      cfg: { staking: { attempt_log_file: file } },
      clock: () => 4_000,
    });
    assert.equal(r.count, 3);
    assert.equal(r.attempts[0].phase, 'failed');
    assert.equal(r.attempts[0].kind, 'unlock');
    assert.equal(r.attempts[1].phase, 'success');
    assert.equal(r.attempts[2].phase, 'failed');
    assert.equal(r.attempts[2].code, 'NO_MASTER');
    assert.equal(r.file, file);
    assert.equal(r.config.attempt_log_file, file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dashboard-stake-log: caps max at 500', async () => {
  const { dir, file } = tmpFile();
  try {
    const r = await buildStakingLogResponse({
      cfg: { staking: { attempt_log_file: file, attempt_log_max: 100000 } },
      clock: () => 1,
    });
    assert.equal(r.max, 500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dashboard-stake-log: respects ?limit= query param within bounds', async () => {
  const r = await buildStakingLogResponse({
    cfg: {},
    url: new URL('http://x/?limit=10'),
    clock: () => 1,
  });
  assert.equal(r.max, 10);
});

test('dashboard-stake-log: throws typed error when ctx.cfg missing', async () => {
  let caught = null;
  try {
    await buildStakingLogResponse({});
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, 'expected throw');
  assert.match(caught.message, /ctx\.cfg required/);
});

test('dashboard-stake-log: schema constant matches the wire format', () => {
  assert.match(STAKING_LOG_SCHEMA, /^tradebot\.dashboard\.staking-log\/v1$/);
});
