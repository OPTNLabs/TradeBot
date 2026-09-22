#!/usr/bin/env node
/**
 * tests/data/pull-data.test.mjs
 *
 * CLI smoke tests for scripts/pull-data.mjs. The deep helper tests
 * (atomicWrite, ndjson append, snapshot layout) live in:
 *   tests/data/snapshots.test.mjs   (DT07)
 *
 * The composite-score + ranking tests live in:
 *   tests/data/top20.test.mjs        (DT08)
 *
 * This file covers:
 *  1. parseArgs — splits --flag, --key=value, and positional args
 *  2. CLI smoke — --help prints usage without crashing
 *  3. CLI smoke — no args exits non-zero with a usage message
 *
 * Uses the built-in Node test runner (node --test) — no external deps.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

// ─── parseArgs tests (re-implemented locally for unit isolation) ────────────

/**
 * Re-implementation of the parseArgs helper inside scripts/pull-data.mjs.
 * If the script's parseArgs changes, update this copy (or import the
 * real one and skip this block).
 *
 * @param {string[]} argv
 * @returns {{ flags: Record<string, string|true>, positional: string[] }}
 */
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (const arg of argv.slice(2)) {
    if (arg === '--') continue;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq >= 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        flags[arg.slice(2)] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

// ─── parseArgs tests ─────────────────────────────────────────────────────────

describe('parseArgs (CLI argument parser)', () => {
  test('empty argv → no flags, no positional', () => {
    const r = parseArgs(['node', 'script.mjs']);
    assert.deepStrictEqual(r.flags, {});
    assert.deepStrictEqual(r.positional, []);
  });

  test('--flag → flags.<name> = true', () => {
    const r = parseArgs(['node', 'script.mjs', '--foo']);
    assert.strictEqual(r.flags.foo, true);
  });

  test('--key=value → flags.<name> = value string', () => {
    const r = parseArgs(['node', 'script.mjs', '--out=foo.json']);
    assert.strictEqual(r.flags.out, 'foo.json');
  });

  test('--flag + positional', () => {
    const r = parseArgs(['node', 'script.mjs', '--json', '2469acc5']);
    assert.strictEqual(r.flags.json, true);
    assert.deepStrictEqual(r.positional, ['2469acc5']);
  });

  test('--list-pools [token-id] form (bare flag → true, positional captures id)', () => {
    const r = parseArgs(['node', 'script.mjs', '--list-pools', 'abc123']);
    assert.strictEqual(r.flags['list-pools'], true);
    assert.deepStrictEqual(r.positional, ['abc123']);
  });

  test('--list-pools=token-id form (flag=value, no positional)', () => {
    const r = parseArgs(['node', 'script.mjs', '--list-pools=abc123']);
    assert.strictEqual(r.flags['list-pools'], 'abc123');
    assert.deepStrictEqual(r.positional, []);
  });

  test('-- separator is skipped, args after are still parsed as positional', () => {
    // Convention: `--` is ignored by the parser; subsequent args are
    // parsed normally (positional or flags). This is the most permissive
    // behavior and matches `argv.slice(2)` + skip semantics.
    const r = parseArgs(['node', 'script.mjs', '--json', '--', 'positional']);
    assert.strictEqual(r.flags.json, true);
    assert.deepStrictEqual(r.positional, ['positional']);
  });
});

// ─── CLI smoke tests ─────────────────────────────────────────────────────────

describe('pull-data.mjs CLI (smoke)', () => {
  test('--help prints usage without crashing', async () => {
    const scriptPath = join(process.cwd(), 'scripts/pull-data.mjs');

    return new Promise((resolve, reject) => {
      const proc = spawn('node', [scriptPath, '--help'], { timeout: 5000 });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });

      proc.on('close', (code) => {
        if (code === 0 && stdout.includes('TradeBot data pull CLI')) {
          resolve();
        } else {
          reject(new Error(`--help failed: code=${code} stdout="${stdout.slice(0, 200)}" stderr="${stderr.slice(0, 200)}"`));
        }
      });
      proc.on('error', reject);
    });
  });

  test('no args exits non-zero with "no command specified" message', async () => {
    const scriptPath = join(process.cwd(), 'scripts/pull-data.mjs');

    return new Promise((resolve, reject) => {
      const proc = spawn('node', [scriptPath], { timeout: 5000 });
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('close', (code) => {
        if (code !== 0 && stderr.includes('no command specified')) {
          resolve();
        } else {
          reject(new Error(`expected non-zero exit with "no command specified", got code=${code} stderr="${stderr.slice(0, 200)}"`));
        }
      });
      proc.on('error', reject);
    });
  });

  test('--bad-command still exits non-zero (does not hang)', async () => {
    const scriptPath = join(process.cwd(), 'scripts/pull-data.mjs');

    return new Promise((resolve, reject) => {
      const proc = spawn('node', [scriptPath, '--bogus-flag'], { timeout: 5000 });
      proc.on('close', (code) => {
        if (code !== 0) resolve();
        else reject(new Error(`--bogus-flag should exit non-zero, got ${code}`));
      });
      proc.on('error', reject);
    });
  });
});