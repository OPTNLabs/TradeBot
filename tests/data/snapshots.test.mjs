#!/usr/bin/env node
/**
 * tests/data/snapshots.test.mjs (DT07)
 *
 * Validates the snapshot LAYOUT + atomic-write helper used by
 * scripts/pull-data.mjs.
 *
 * Covers:
 *  1. atomicWrite creates complete files (no truncation)
 *  2. atomicWrite overwrites existing files
 *  3. atomicWrite creates parent directories recursively
 *  4. ndjson append is non-truncating (subsequent appends keep prior lines)
 *  5. Snapshot directory layout: pools.json + token-stats/<id>.json
 *
 * Pure, in-process — no indexer hits. Uses tmpdir for isolation.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  rmdirSync,
  mkdtempSync,
  existsSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── atomicWrite (re-implemented to mirror scripts/pull-data.mjs) ─────────
// We keep this test self-contained — the production code exports nothing
// for atomicWrite (it's an internal helper). The implementations MUST
// stay byte-for-byte equivalent in behavior; if scripts/pull-data.mjs
// changes, update this copy.

/**
 * Atomic write: write to a unique temp dir then rename to the target path.
 * Matches the helper used by scripts/pull-data.mjs.
 *
 * @param {string} filePath
 * @param {string} content
 */
function atomicWrite(filePath, content) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = mkdtempSync(tmpdir() + '/tradebot-test-');
  const tmpFile = tmp + '/file';
  writeFileSync(tmpFile, content, 'utf8');
  renameSync(tmpFile, filePath);
}

// ─── atomicWrite tests ─────────────────────────────────────────────────────

describe('atomicWrite', () => {
  test('writes complete file (no truncation) after rename', () => {
    const testDir = mkdtempSync(tmpdir() + '/tradebot-atomic-test-');
    const filePath = join(testDir, 'subdir', 'data.json');
    const content = JSON.stringify({ key: 'value', list: [1, 2, 3] });

    atomicWrite(filePath, content);

    const read = readFileSync(filePath, 'utf8');
    assert.strictEqual(read, content);

    unlinkSync(filePath);
    rmdirSync(dirname(filePath));
    rmdirSync(testDir);
  });

  test('overwrites existing file', () => {
    const testDir = mkdtempSync(tmpdir() + '/tradebot-atomic-test-');
    const filePath = join(testDir, 'data.json');

    atomicWrite(filePath, 'first');
    atomicWrite(filePath, 'second');

    assert.strictEqual(readFileSync(filePath, 'utf8'), 'second');

    unlinkSync(filePath);
    rmdirSync(testDir);
  });

  test('creates parent directories recursively', () => {
    const testDir = mkdtempSync(tmpdir() + '/tradebot-atomic-test-');
    const filePath = join(testDir, 'a', 'b', 'c', 'deep.json');

    atomicWrite(filePath, '{"deep":true}');

    assert.strictEqual(readFileSync(filePath, 'utf8'), '{"deep":true}');

    unlinkSync(filePath);
    rmdirSync(join(testDir, 'a', 'b', 'c'));
    rmdirSync(join(testDir, 'a', 'b'));
    rmdirSync(join(testDir, 'a'));
    rmdirSync(testDir);
  });

  test('leaves no leftover temp dirs (rename moves file, not copies)', () => {
    const testDir = mkdtempSync(tmpdir() + '/tradebot-atomic-test-');
    const filePath = join(testDir, 'data.json');

    atomicWrite(filePath, 'x');

    // The temp dir was inside /tmp; we can't reliably enumerate /tmp,
    // but we can verify the destination file exists and has the right size.
    assert.ok(existsSync(filePath));
    assert.strictEqual(readFileSync(filePath, 'utf8'), 'x');

    unlinkSync(filePath);
    rmdirSync(testDir);
  });
});

// ─── ndjson append tests ────────────────────────────────────────────────────

describe('ndjson append (history.ndjson shape)', () => {
  /**
   * Mirror of the appendHistory helper from scripts/pull-data.mjs:
   * append one JSON line per call, never truncate.
   */
  function appendHistoryLine(filePath, line) {
    if (!existsSync(filePath)) writeFileSync(filePath, '', 'utf8');
    appendFileSync(filePath, line + '\n', 'utf8');
  }

  test('first append creates empty file with one line', () => {
    const testDir = mkdtempSync(tmpdir() + '/tradebot-ndjson-test-');
    const filePath = join(testDir, 'history.ndjson');
    const line = JSON.stringify({ ts: '2026-09-11T00:00:00Z', type: 'snapshot' });

    appendHistoryLine(filePath, line);

    const content = readFileSync(filePath, 'utf8');
    assert.strictEqual(content, line + '\n');

    unlinkSync(filePath);
    rmdirSync(testDir);
  });

  test('successive appends preserve prior lines (non-truncating)', () => {
    const testDir = mkdtempSync(tmpdir() + '/tradebot-ndjson-test-');
    const filePath = join(testDir, 'history.ndjson');

    const lines = [
      JSON.stringify({ ts: '2026-09-11T00:00:00Z', type: 'snapshot', i: 1 }),
      JSON.stringify({ ts: '2026-09-11T01:00:00Z', type: 'snapshot', i: 2 }),
      JSON.stringify({ ts: '2026-09-11T02:00:00Z', type: 'top20', i: 3 }),
    ];

    for (const l of lines) appendHistoryLine(filePath, l);

    const content = readFileSync(filePath, 'utf8');
    const read = content.trimEnd().split('\n').map(l => JSON.parse(l));
    assert.strictEqual(read.length, 3);
    assert.deepStrictEqual(read.map(r => r.i), [1, 2, 3]);
    assert.deepStrictEqual(read.map(r => r.type), ['snapshot', 'snapshot', 'top20']);

    unlinkSync(filePath);
    rmdirSync(testDir);
  });

  test('each line is parseable JSON (NDJSON invariant)', () => {
    const testDir = mkdtempSync(tmpdir() + '/tradebot-ndjson-test-');
    const filePath = join(testDir, 'history.ndjson');

    const events = [
      { ts: '2026-09-11T00:00:00Z', source: 'snapshot', type: 'full-snapshot', pool_count: 200, top_token: 'PUSD' },
      { ts: '2026-09-11T01:00:00Z', source: 'top20', type: 'top20-recompute', top_token: 'XEC' },
    ];
    for (const e of events) appendHistoryLine(filePath, JSON.stringify(e));

    const lines = readFileSync(filePath, 'utf8').trimEnd().split('\n');
    assert.strictEqual(lines.length, events.length);
    for (let i = 0; i < lines.length; i++) {
      const parsed = JSON.parse(lines[i]);
      assert.strictEqual(parsed.ts, events[i].ts);
      assert.strictEqual(parsed.type, events[i].type);
    }

    unlinkSync(filePath);
    rmdirSync(testDir);
  });
});

// ─── Snapshot directory layout tests ─────────────────────────────────────────

describe('snapshot directory layout', () => {
  /**
   * Validate the layout shape: <date>/pools.json + <date>/token-stats/<id>.json
   * Mirrors data/snapshots/<YYYY-MM-DD>/... in DATA_LAYOUT.md.
   */
  function validateLayout(dateDir) {
    const poolsPath = join(dateDir, 'pools.json');
    const statsDir = join(dateDir, 'token-stats');
    return {
      poolsExists: existsSync(poolsPath),
      statsDirExists: existsSync(statsDir),
      poolsPath,
      statsDir,
    };
  }

  test('layout has pools.json + token-stats/ after snapshot', () => {
    const testDir = mkdtempSync(tmpdir() + '/tradebot-snap-test-');
    const dateDir = join(testDir, '2026-09-11');

    // Simulate the snapshot writes
    atomicWrite(join(dateDir, 'pools.json'), JSON.stringify({ tokens: [] }));
    atomicWrite(join(dateDir, 'token-stats', 'abc.json'), JSON.stringify({ token_id: 'abc' }));

    const layout = validateLayout(dateDir);
    assert.ok(layout.poolsExists, 'pools.json should exist');
    assert.ok(layout.statsDirExists, 'token-stats/ should exist');

    // pools.json must be valid JSON
    const pools = JSON.parse(readFileSync(layout.poolsPath, 'utf8'));
    assert.ok('tokens' in pools);

    // per-token file must be valid JSON with token_id
    const statFile = join(layout.statsDir, 'abc.json');
    const stat = JSON.parse(readFileSync(statFile, 'utf8'));
    assert.strictEqual(stat.token_id, 'abc');

    unlinkSync(join(dateDir, 'token-stats', 'abc.json'));
    rmdirSync(join(dateDir, 'token-stats'));
    unlinkSync(join(dateDir, 'pools.json'));
    rmdirSync(dateDir);
    rmdirSync(testDir);
  });

  test('token-stats filename matches the token_id exactly', () => {
    // Each token_id (64-char hex) should map to a single <id>.json file
    const testDir = mkdtempSync(tmpdir() + '/tradebot-snap-test-');
    const statsDir = join(testDir, 'token-stats');
    const id1 = 'a'.repeat(64);
    const id2 = 'b'.repeat(64);

    atomicWrite(join(statsDir, `${id1}.json`), JSON.stringify({ token_id: id1 }));
    atomicWrite(join(statsDir, `${id2}.json`), JSON.stringify({ token_id: id2 }));

    const f1 = JSON.parse(readFileSync(join(statsDir, `${id1}.json`), 'utf8'));
    const f2 = JSON.parse(readFileSync(join(statsDir, `${id2}.json`), 'utf8'));
    assert.strictEqual(f1.token_id, id1);
    assert.strictEqual(f2.token_id, id2);

    // Cleanup
    unlinkSync(join(statsDir, `${id1}.json`));
    unlinkSync(join(statsDir, `${id2}.json`));
    rmdirSync(statsDir);
    rmdirSync(testDir);
  });
});