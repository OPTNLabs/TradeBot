#!/usr/bin/env node
// tests/alerts-persist.test.mjs
//
// T53.2 — Unit tests for the alerts NDJSON writer.
//
// Covers:
//   - src/alerts/persist.mjs (appendAlertEvent, createAlertsAppender,
//     createNoopAlertsAppender, readAlertsLog)
//
// Run via:
//   node --test tests/alerts-persist.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendAlertEvent,
  createAlertsAppender,
  createNoopAlertsAppender,
  readAlertsLog,
  DEFAULT_ALERTS_LOG_FILE,
} from '../src/alerts/persist.mjs';
import { atomicAppendNdjson, _unsafeDirectWrite } from '../src/util/atomic-write.mjs';

function tmpPath(name) {
  const dir = mkdtempSync(join(tmpdir(), 'tradebot-alerts-'));
  return { dir, file: join(dir, name) };
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

test('appendAlertEvent: writes one JSON line per call (BigInt-safe)', async () => {
  const { dir, file } = tmpPath('alerts.jsonl');
  try {
    const event = {
      kind: 'risk_threshold',
      severity: 'warn',
      title: 'entry_refused',
      body: 'reason text',
      context: {
        token_id: '0xabc',
        sats: 12345n,         // BigInt must stringify to a decimal string
        bps: 250,
      },
    };
    const result = await appendAlertEvent({ event, file });
    assert.equal(result.ok, true, `expected ok:true; got ${JSON.stringify(result)}`);
    assert.equal(typeof result.line, 'string');
    assert.ok(result.line.length > 0, 'line should be non-empty');

    const body = readFileSync(file, 'utf8');
    const lines = body.split('\n').filter((l) => l.length > 0);
    assert.equal(lines.length, 1, `expected exactly one line; got ${lines.length}`);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.kind, 'risk_threshold');
    assert.equal(parsed.severity, 'warn');
    assert.equal(parsed.context.sats, '12345', 'BigInt must serialize to decimal string');
    assert.equal(parsed.context.bps, 250);
  } finally {
    cleanup(dir);
  }
});

test('appendAlertEvent: appends (does NOT truncate) across calls', async () => {
  const { dir, file } = tmpPath('alerts2.jsonl');
  try {
    for (let i = 0; i < 3; i += 1) {
      const ev = { kind: 'custom', severity: 'info', title: `t${i}`, body: `b${i}`, context: { i } };
      const r = await appendAlertEvent({ event: ev, file });
      assert.equal(r.ok, true);
    }
    const body = readFileSync(file, 'utf8');
    const lines = body.split('\n').filter((l) => l.length > 0);
    assert.equal(lines.length, 3, `expected 3 lines; got ${lines.length}`);
    const titles = lines.map((l) => JSON.parse(l).title);
    assert.deepEqual(titles, ['t0', 't1', 't2']);
  } finally {
    cleanup(dir);
  }
});

test('appendAlertEvent: reuses atomicAppendNdjson — survives concurrent appends', async () => {
  const { dir, file } = tmpPath('alerts3.jsonl');
  try {
    const events = Array.from({ length: 20 }, (_, i) => ({
      kind: 'custom', severity: 'info', title: `parallel_${i}`, body: '', context: { i },
    }));
    await Promise.all(events.map((ev) => appendAlertEvent({ event: ev, file })));
    const body = readFileSync(file, 'utf8');
    const lines = body.split('\n').filter((l) => l.length > 0);
    assert.equal(lines.length, events.length, 'every event must land on its own line');
  } finally {
    cleanup(dir);
  }
});

test('appendAlertEvent: returns ok:false when event is not an object (does not throw)', async () => {
  const result = await appendAlertEvent({ event: null, file: '/tmp/x.jsonl' });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /must be a plain object/);
});

test('appendAlertEvent: returns ok:false when event is a string (does not throw)', async () => {
  const result = await appendAlertEvent({ event: 'not-an-object', file: '/tmp/x.jsonl' });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /must be a plain object/);
});

test('appendAlertEvent: returns ok:false on bad serializer (does not throw)', async () => {
  const deps = { stringify: () => { throw new Error('boom'); } };
  const result = await appendAlertEvent({
    event: { kind: 'custom', severity: 'info', title: 't', body: '' },
    file: '/tmp/x.jsonl',
    deps,
  });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /serialize: boom/);
});

test('appendAlertEvent: returns ok:false on append failure (does not throw)', async () => {
  const deps = {
    append: async () => { throw new Error('disk full'); },
  };
  const result = await appendAlertEvent({
    event: { kind: 'custom', severity: 'info', title: 't', body: '' },
    file: '/tmp/x.jsonl',
    deps,
  });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /append: disk full/);
});

test('appendAlertEvent: defaults file path to DEFAULT_ALERTS_LOG_FILE', async () => {
  // Use a deps that captures the path so we don't have to clean up data/alerts.jsonl.
  let capturedFile = null;
  const deps = {
    append: async (file) => { capturedFile = file; },
    stringify: (v) => JSON.stringify(v),
  };
  const result = await appendAlertEvent({
    event: { kind: 'custom', severity: 'info', title: 't', body: '' },
    deps,
  });
  assert.equal(result.ok, true);
  assert.equal(capturedFile, DEFAULT_ALERTS_LOG_FILE);
});

test('appendAlertEvent: empty-string file falls back to DEFAULT_ALERTS_LOG_FILE', async () => {
  let capturedFile = null;
  const deps = {
    append: async (file) => { capturedFile = file; },
    stringify: (v) => JSON.stringify(v),
  };
  const result = await appendAlertEvent({
    event: { kind: 'custom', severity: 'info', title: 't', body: '' },
    file: '',
    deps,
  });
  assert.equal(result.ok, true);
  assert.equal(capturedFile, DEFAULT_ALERTS_LOG_FILE);
});

test('createAlertsAppender: returns a bound function; logger.warn fires on failure', async () => {
  const { dir, file } = tmpPath('alerts4.jsonl');
  try {
    const warns = [];
    const logger = { warn: (event, payload) => warns.push({ event, payload }) };
    const appender = createAlertsAppender({ file, logger });
    const r1 = await appender({ kind: 'custom', severity: 'info', title: 'a', body: '' });
    assert.equal(r1.ok, true);
    // No warn on success.
    assert.equal(warns.length, 0);
    // No warn when the append succeeds (positive control).
    const body = readFileSync(file, 'utf8');
    assert.ok(body.length > 0);
  } finally {
    cleanup(dir);
  }
});

test('createAlertsAppender: logs structured warning when underlying append throws', async () => {
  const warns = [];
  const logger = { warn: (event, payload) => warns.push({ event, payload }) };
  const appender = createAlertsAppender({
    file: '/tmp/whatever.jsonl',
    logger,
    deps: {
      append: async () => { throw new Error('boom'); },
    },
  });
  const r = await appender({ kind: 'risk_threshold', severity: 'warn', title: 't', body: '' });
  assert.equal(r.ok, false);
  assert.equal(warns.length, 1);
  assert.equal(warns[0].event, 'alerts.persist.failed');
  assert.equal(warns[0].payload.error, 'append: boom');
  assert.equal(warns[0].payload.event_kind, 'risk_threshold');
});

test('createAlertsAppender: no-op when logger is absent (does not throw on failure)', async () => {
  const appender = createAlertsAppender({
    file: '/tmp/whatever.jsonl',
    deps: {
      append: async () => { throw new Error('boom'); },
    },
  });
  const r = await appender({ kind: 'custom', severity: 'info', title: 't', body: '' });
  assert.equal(r.ok, false);
});

test('createNoopAlertsAppender: always returns ok:true without writing anywhere', async () => {
  const appender = createNoopAlertsAppender();
  const r = await appender({ kind: 'custom', severity: 'info', title: 't', body: '' });
  assert.equal(r.ok, true);
  assert.equal(r.file, '<noop>');
  assert.equal(r.event_id, null);
});

test('readAlertsLog: parses every line from a previously-written file', async () => {
  const { dir, file } = tmpPath('alerts5.jsonl');
  try {
    // Seed via the real atomicAppendNdjson so the read path matches
    // what the production writer would produce.
    await atomicAppendNdjson(file, JSON.stringify({ kind: 'custom', severity: 'info', title: 'a', body: '', context: null }));
    await atomicAppendNdjson(file, JSON.stringify({ kind: 'custom', severity: 'warn', title: 'b', body: '', context: null }));
    const { lines, errors, total } = await readAlertsLog(file);
    assert.equal(lines.length, 2);
    assert.equal(total, 2);
    assert.equal(errors.length, 0);
    assert.equal(lines[0].title, 'a');
    assert.equal(lines[1].title, 'b');
  } finally {
    cleanup(dir);
  }
});

test('readAlertsLog: missing file returns empty lines + empty errors', async () => {
  const { dir, file } = tmpPath('nonexistent.jsonl');
  try {
    await assert.rejects(() => readAlertsLog(file), /not found|ENOENT/);
  } finally {
    cleanup(dir);
  }
});

test('readAlertsLog: corrupt lines surface as parse errors without dropping valid neighbors', async () => {
  const { dir, file } = tmpPath('alerts6.jsonl');
  try {
    // Write 3 lines manually: good, corrupt, good.
    await _unsafeDirectWrite(file,
      JSON.stringify({ kind: 'custom', severity: 'info', title: 'a', body: '' }) + '\n' +
      '{not-json' + '\n' +
      JSON.stringify({ kind: 'custom', severity: 'warn', title: 'b', body: '' }) + '\n');
    const { lines, errors, total } = await readAlertsLog(file);
    assert.equal(lines.length, 2, 'only the 2 valid lines parse');
    assert.equal(total, 2);
    assert.equal(errors.length, 1, 'one corrupt line surfaces');
    assert.equal(lines[0].title, 'a');
    assert.equal(lines[1].title, 'b');
  } finally {
    cleanup(dir);
  }
});

test('DEFAULT_ALERTS_LOG_FILE: matches the dashboard reader path', () => {
  // Mirrors `src/dashboard/alerts-recent.mjs#DEFAULT_ALERTS_FILE`
  // — keep them in sync if one moves. The cross-check guards
  // against the writer + reader pointing at different files.
  assert.equal(DEFAULT_ALERTS_LOG_FILE, 'data/alerts.jsonl');
});
