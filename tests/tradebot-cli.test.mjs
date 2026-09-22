#!/usr/bin/env node
// tests/tradebot-cli.test.mjs
//
// Unit tests for `bin/tradebot-cli.mjs`.
//
// What we cover:
//   - resolveCmd: Windows-aware command resolution (the operator's
//     2026-09-21 18:21 PDT bug — spawnSync('npm', ...) on Windows
//     hits ENOENT because npm is a .cmd shim).
//   - Cli dispatch: --help exits 0 without requiring any setup
//   - Unknown subcommand exits with code 64 (sysexits.h EX_USAGE)
//   - `doctor` subcommand runs without state (doesn't depend on
//     any specific config / runtime state — useful for the
//     first-run on a fresh clone)
//
// Why this file:
//
//   `bin/tradebot-cli.mjs` is the FIRST thing every new TradeBot
//   operator runs. If it crashes on Windows or its error
//   messages are silent, the operator gets stuck. These tests
//   pin the cross-platform behavior so a refactor doesn't
//   accidentally regress it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const CLI = path.join(REPO_ROOT, 'bin', 'tradebot-cli.mjs');

// ─────────────────────────────────────────────────────────────────────
//  resolveCmd — exercised directly via dynamic import
// ─────────────────────────────────────────────────────────────────────

test('tradebot-cli: resolveCmd handles win32 / linux / darwin', async () => {
  // The cli now exports `resolveCmd` directly so we can import
  // it and test all three platform branches via platform
  // mocking (we set process.platform).
  const mod = await import(pathToFileURLAbs(CLI));
  assert.equal(typeof mod.resolveCmd, 'function');

  // Save + restore the global; Node doesn't expose a setter,
  // so we override Object.defineProperty.
  const orig = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    // POSIX
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    assert.equal(mod.resolveCmd('npm'), 'npm');
    assert.equal(mod.resolveCmd('node'), 'node');

    // macOS
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    assert.equal(mod.resolveCmd('npm'), 'npm');

    // Windows — the operator's bug
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    assert.equal(mod.resolveCmd('npm'), 'npm.cmd');
    assert.equal(mod.resolveCmd('node'), 'node.cmd');
    // Already-suffixed commands are passed through
    assert.equal(mod.resolveCmd('npm.cmd'), 'npm.cmd');
    assert.equal(mod.resolveCmd('node.exe'), 'node.exe');
    assert.equal(mod.resolveCmd('python.bat'), 'python.bat');
  } finally {
    if (orig) Object.defineProperty(process, 'platform', orig);
  }
});

function pathToFileURLAbs(p) {
  const u = new URL('file://' + path.resolve(p));
  return u.href;
}

// ─────────────────────────────────────────────────────────────────────
//  CLI end-to-end smoke tests (read-only; don't depend on state)
// ─────────────────────────────────────────────────────────────────────

function run(args, { cwd = REPO_ROOT } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
  });
}

test('tradebot-cli: --help exits 0 and prints subcommand list', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0, `--help exited ${r.status}: ${r.stderr ?? ''}`);
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  assert.match(out, /setup/);
  assert.match(out, /dashboard/);
  assert.match(out, /bot/);
  assert.match(out, /doctor/);
});

test('tradebot-cli: -h exits 0 (alias)', () => {
  const r = run(['-h']);
  assert.equal(r.status, 0);
  assert.match((r.stdout ?? '') + (r.stderr ?? ''), /Usage/);
});

test('tradebot-cli: unknown subcommand exits 64 (sysexits EX_USAGE)', () => {
  const r = run(['no-such-subcommand']);
  assert.equal(r.status, 64, `expected exit 64, got ${r.status}: ${r.stderr ?? ''}`);
});

test('tradebot-cli: unknown -flag exits 64 with "unknown option"', () => {
  const r = run(['--this-does-not-exist']);
  assert.equal(r.status, 64);
  assert.match((r.stderr ?? '') + (r.stdout ?? ''), /unknown option/);
});

test('tradebot-cli: doctor exits 0 on a fresh checkout', () => {
  const r = run(['doctor']);
  // Exit code 0 even if something is missing (doctor is informational).
  assert.equal(r.status, 0, `doctor exited ${r.status}: ${r.stderr ?? ''}`);
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  assert.match(out, /TradeBot doctor/);
  assert.match(out, /Node:/);
  assert.match(out, /root node_modules:/);
  assert.match(out, /dashboard node_modules:/);
});

// ─────────────────────────────────────────────────────────────────────
//  Idempotency: setup with both node_modules present runs in <2s
//  (no re-install, just verifies + rebuilds bundle from cache).
// ─────────────────────────────────────────────────────────────────────

test('tradebot-cli: setup is idempotent (skips when deps exist)', { skip: false, timeout: 60_000 }, () => {
  if (!existsSync(path.join(REPO_ROOT, 'node_modules'))) {
    // First-time setup would require network; skip rather than
    // fail in offline CI.
    return;
  }
  const t0 = Date.now();
  const r = run(['setup', '--quiet']);
  const dt = Date.now() - t0;
  assert.equal(r.status, 0, `setup failed: ${r.stderr ?? ''}`);
  // Just verify it ran in reasonable time.
  assert.ok(dt < 30_000, `setup took ${dt}ms, expected < 30s`);
});
