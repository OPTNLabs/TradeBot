#!/usr/bin/env node
/**
 * tests/data/data-tick.test.mjs (DT12)
 *
 * Pure tests for scripts/data-tick.mjs. The default
 * `defaultRunPullData` spawns a child process — these tests
 * inject a fake via the `runPullData` opts so no network is hit.
 *
 * Covers:
 *  1. parseDataTickArgs — handles --flag, --key=value, positional
 *  2. validateDateString — accepts valid YYYY-MM-DD, rejects bad input
 *  3. runDataTick happy path — runs snapshot-all then top20, rc=0
 *  4. runDataTick skipTop20 — no second call, rc=0
 *  5. runDataTick dryRun — no calls, rc=0, returns immediate summary
 *  6. runDataTick snapshot-fail — propagates rc=1, no top20 call
 *  7. runDataTick top20-fail non-strict — rc=0, warns
 *  8. runDataTick top20-fail strict — rc=1
 *  9. runDataTick bad-date (validation) — rc=2, no calls
 * 10. script parses with `node --check`
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  parseDataTickArgs,
  validateDateString,
  runDataTick,
} from '../../scripts/data-tick.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const DATA_TICK_PATH = join(REPO_ROOT, 'scripts', 'data-tick.mjs');

// ─── Capture log helper (in-memory structured logger) ───────────────────────

/**
 * A simple in-memory structured logger for tests. Captures all calls
 * to `info` / `warn` / `error` so tests can assert on the JSON shape.
 *
 * @returns {{ info: Function, warn: Function, error: Function, log: Array<{ level: string, msg: string, fields: object }> }}
 */
function captureLogger() {
  const log = [];
  const make = (level) => (msg, fields = {}) => log.push({ level, msg, fields });
  return { info: make('info'), warn: make('warn'), error: make('error'), log };
}

// ─── parseDataTickArgs ──────────────────────────────────────────────────────

describe('parseDataTickArgs', () => {
  test('splits --flag, --key=value, and positional', () => {
    const r = parseDataTickArgs(['node', 'data-tick.mjs', '--date=2026-09-11', '--skip-top20', 'extra']);
    assert.equal(r.flags.date, '2026-09-11');
    assert.equal(r.flags['skip-top20'], true);
    assert.deepEqual(r.positional, ['extra']);
  });
  test('drops args after `--` separator (matches pull-data.mjs behaviour)', () => {
    // Our parser `continue`s on `--` (same as pull-data.mjs). Anything
    // after `--` is treated as a comment and dropped on the floor, not
    // added to positional. This is intentional — it matches the parent
    // CLI's surface so the data-tick and pull-data wrappers stay
    // interchangeable in shell pipelines.
    const r = parseDataTickArgs(['node', 'data-tick.mjs', '--date=2026-09-11', '--', '--not-a-flag']);
    assert.equal(r.flags.date, '2026-09-11');
    assert.deepEqual(r.positional, []);
  });
  test('empty argv returns empty', () => {
    const r = parseDataTickArgs(['node', 'data-tick.mjs']);
    assert.deepEqual(r.flags, {});
    assert.deepEqual(r.positional, []);
  });
});

// ─── validateDateString ─────────────────────────────────────────────────────

describe('validateDateString', () => {
  test('accepts a well-formed date', () => {
    assert.equal(validateDateString('2026-09-11'), '2026-09-11');
  });
  test('rejects malformed strings', () => {
    assert.throws(() => validateDateString('2026/09/11'), /YYYY-MM-DD/);
    assert.throws(() => validateDateString('11-09-2026'), /YYYY-MM-DD/);
    assert.throws(() => validateDateString('not-a-date'), /YYYY-MM-DD/);
    assert.throws(() => validateDateString(''), /YYYY-MM-DD/);
    assert.throws(() => validateDateString(null), /YYYY-MM-DD/);
    assert.throws(() => validateDateString(undefined), /YYYY-MM-DD/);
    assert.throws(() => validateDateString(123), /YYYY-MM-DD/);
  });
  test('rejects invalid calendar dates (Feb 30 etc.)', () => {
    assert.throws(() => validateDateString('2026-02-30'), /not a real calendar date/);
    assert.throws(() => validateDateString('2025-13-01'), /not a real calendar date/);
    assert.throws(() => validateDateString('2025-04-31'), /not a real calendar date/);
  });
});

// ─── runDataTick (dependency-injected runPullData) ──────────────────────────

describe('runDataTick', () => {
  /**
   * Helper: returns a fake runPullData that captures all calls
   * and returns per-arg preset codes (default 0).
   *
   * @param {Record<string, number>} presets  arg-prefix → exit code
   */
  function fakeRunPullData(presets = {}) {
    const calls = [];
    const fn = async (args) => {
      calls.push(args);
      for (const arg of args) {
        if (arg in presets) return presets[arg];
      }
      return 0;
    };
    return { fn, calls };
  }

  test('happy path: snapshot-all then top20, rc=0', async () => {
    const { fn, calls } = fakeRunPullData();
    const logger = captureLogger();
    const result = await runDataTick({ runPullData: fn, logger });
    assert.equal(result.rc, 0);
    assert.equal(result.snapshot_rc, 0);
    assert.equal(result.top20_rc, 0);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], ['--snapshot-all']);
    assert.deepEqual(calls[1], ['--top20']);
    assert.ok(result.elapsed_ms >= 0);
    // log trace: start → done
    const trace = logger.log.map((l) => l.msg);
    assert.ok(trace.includes('data-tick.start'));
    assert.ok(trace.includes('data-tick.done'));
  });

  test('honours --date: passes --date=YYYY-MM-DD to snapshot-all', async () => {
    const { fn, calls } = fakeRunPullData();
    await runDataTick({ date: '2026-09-11', runPullData: fn });
    assert.deepEqual(calls[0], ['--snapshot-all', '--date=2026-09-11']);
  });

  test('skipTop20: only one call (snapshot-all)', async () => {
    const { fn, calls } = fakeRunPullData();
    const result = await runDataTick({ skipTop20: true, runPullData: fn });
    assert.equal(result.rc, 0);
    assert.equal(result.top20_rc, null);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], ['--snapshot-all']);
  });

  test('dryRun: zero calls, rc=0, returns immediately', async () => {
    const { fn, calls } = fakeRunPullData();
    const logger = captureLogger();
    const result = await runDataTick({ dryRun: true, runPullData: fn, logger });
    assert.equal(result.rc, 0);
    assert.equal(calls.length, 0);
    // dry-run info line present
    assert.ok(logger.log.some((l) => l.msg === 'data-tick.dry-run'));
  });

  test('snapshot-all fails: rc=1, top20 never called', async () => {
    const { fn, calls } = fakeRunPullData({ '--snapshot-all': 7 });
    const logger = captureLogger();
    const result = await runDataTick({ runPullData: fn, logger });
    assert.equal(result.rc, 1);
    assert.equal(result.snapshot_rc, 7);
    assert.equal(result.top20_rc, null);
    assert.equal(calls.length, 1);
    assert.ok(logger.log.some((l) => l.level === 'error' && l.msg === 'data-tick.snapshot-failed'));
  });

  test('top20 fails non-strict: rc=0, warn logged', async () => {
    const { fn, calls } = fakeRunPullData({ '--top20': 5 });
    const logger = captureLogger();
    const result = await runDataTick({ runPullData: fn, logger });
    assert.equal(result.rc, 0);
    assert.equal(result.snapshot_rc, 0);
    assert.equal(result.top20_rc, 5);
    assert.equal(calls.length, 2);
    assert.ok(logger.log.some((l) => l.level === 'warn' && l.msg === 'data-tick.top20-failed-non-strict'));
  });

  test('top20 fails strict: rc=1, error logged', async () => {
    const { fn, calls } = fakeRunPullData({ '--top20': 5 });
    const logger = captureLogger();
    const result = await runDataTick({ runPullData: fn, strict: true, logger });
    assert.equal(result.rc, 1);
    assert.equal(result.snapshot_rc, 0);
    assert.equal(result.top20_rc, 5);
    assert.ok(logger.log.some((l) => l.level === 'error' && l.msg === 'data-tick.top20-failed-strict'));
  });

  test('bad date input → rc=2, no calls', async () => {
    const { fn, calls } = fakeRunPullData();
    const logger = captureLogger();
    const result = await runDataTick({ date: 'not-a-date', runPullData: fn, logger });
    assert.equal(result.rc, 2);
    assert.equal(result.snapshot_rc, 2);
    assert.equal(result.top20_rc, null);
    assert.equal(calls.length, 0);
    assert.ok(logger.log.some((l) => l.msg === 'data-tick.bad-date'));
  });

  test('bad date input (TypeError from validateDateString) reaches rc=2', async () => {
    const { fn, calls } = fakeRunPullData();
    const logger = captureLogger();
    const result = await runDataTick({ date: '2026-02-30', runPullData: fn, logger });
    assert.equal(result.rc, 2);
    assert.equal(calls.length, 0);
  });
});

// ─── script syntax check ────────────────────────────────────────────────────

describe('scripts/data-tick.mjs', () => {
  test('parses cleanly under `node --check`', () => {
    // `node --check` does NOT execute the module — just parses for
    // syntax errors. Safe in CI / offline.
    const out = execFileSync('node', ['--check', DATA_TICK_PATH], { stdio: 'pipe' });
    assert.ok(out !== null);
  });

  test('main() exits non-zero on bad date (no spawn, no network)', () => {
    // Run the script with an obviously bad date. It exits 2 without
    // ever spawning pull-data.mjs, so the test is hermetic.
    let stderr = '';
    try {
      execFileSync('node', [DATA_TICK_PATH, '--date=2026-13-01'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      stderr = String(e?.stderr?.toString?.('utf8') ?? e?.stderr ?? '');
    }
    assert.match(stderr, /must be YYYY-MM-DD|not a real calendar date/);
  });
});
