#!/usr/bin/env node
// tests/util-config.test.mjs
//
// Unit tests for `src/util/config-loader.mjs` and
// `src/util/fs-helpers.mjs` (the new utilities that ship with T15).
//
// Covers:
//   - DEFAULT_CONFIG_PATHS export
//   - deepMerge: scalar precedence, object recursion, arrays opaque,
//     null behaviour, never-mutates inputs
//   - resolveConfigPaths: relative → absolute, override behaviour
//   - readConfigFile: missing optional → null, missing required →
//     ConfigMissingError, bad JSON → ConfigParseError, OK parses
//   - loadConfig: merges default + user, exposes `cfg.user`,
//     stamps `cfg.paths`, default-only when user.json absent
//   - summarizeConfig: redacts the WIF, surfaces knobs
//   - pathExists: ENOENT → false, present → true, inject fs
//   - readJsonIfExists: ENOENT → null, bad JSON → null, OK parses
//   - ensureParentDir: idempotent, recursive, no-op when dir is cwd
//
// Run with:
//   node --test tests/util-config.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CONFIG_PATHS,
  ConfigLoaderError,
  ConfigMissingError,
  ConfigParseError,
  deepMerge,
  resolveConfigPaths,
  readConfigFile,
  loadConfig,
  summarizeConfig,
} from '../src/util/config-loader.mjs';

import {
  pathExists,
  readJsonIfExists,
  ensureParentDir,
} from '../src/util/fs-helpers.mjs';

// ─────────────────────────────────────────────────────────────────────
//  Fixtures
// ─────────────────────────────────────────────────────────────────────

/** In-memory fs stub for pathExists/readJsonIfExists/ensureParentDir. */
function createMemoryFs() {
  /** @type {Map<string, string>} */
  const files = new Map();
  /** @type {Set<string>} */
  const dirs = new Set();
  return {
    files,
    dirs,
    async readFile(p, _enc) {
      if (!files.has(p)) {
        const e = new Error(`ENOENT: ${p}`);
        e.code = 'ENOENT';
        throw e;
      }
      return files.get(p);
    },
    async access(p) {
      if (files.has(p) || dirs.has(p)) return undefined;
      const e = new Error(`ENOENT: ${p}`);
      e.code = 'ENOENT';
      throw e;
    },
    async mkdir(p, opts = {}) {
      if (opts.recursive) {
        const isAbsolute = p.startsWith('/');
        const parts = p.split('/').filter(Boolean);
        let cur = isAbsolute ? '' : '';
        for (const part of parts) {
          cur = cur ? `${cur}/${part}` : (isAbsolute ? `/${part}` : part);
          dirs.add(cur);
        }
      } else {
        dirs.add(p);
      }
      return undefined;
    },
  };
}

/** A small default.json-ish fixture. */
const DEFAULT_FIXTURE = {
  version: 2,
  tuning_preset: 'small_balance_startup',
  scoring: { min_score: 0.35, weights: { volume_24h_bch: 0.30, tvl_bch: 0.15 } },
  entry: { max_position_bch: 0.005, max_total_exposure_bch: 0.04, slippage_tolerance_bps: 100 },
  risk: { min_wallet_balance_bch: 0.005, max_daily_loss_bch: 0.005 },
  wallet: { network: 'mainnet', bip44_path: "m/44'/145'/0'/0/0" },
};

/** A small user.json-ish fixture. */
const USER_FIXTURE = {
  entry: { max_position_bch: 0.05 }, // override one knob
  user: { wallet: { wif: 'L4rK1yL1fakedwif...', cashaddr: 'bitcoincash:qqcp6q32dt4x4ddzrkdz28xmv6a3ev6wwq4t0m57ak' } },
};

// ─────────────────────────────────────────────────────────────────────
//  DEFAULT_CONFIG_PATHS
// ─────────────────────────────────────────────────────────────────────

test('util-config: DEFAULT_CONFIG_PATHS exposes default + user', () => {
  assert.equal(typeof DEFAULT_CONFIG_PATHS, 'object');
  assert.equal(DEFAULT_CONFIG_PATHS.default, 'config/default.json');
  assert.equal(DEFAULT_CONFIG_PATHS.user, 'config/user.json');
  assert.ok(Object.isFrozen(DEFAULT_CONFIG_PATHS), 'should be frozen');
});

// ─────────────────────────────────────────────────────────────────────
//  deepMerge
// ─────────────────────────────────────────────────────────────────────

test('util-config: deepMerge — scalar override', () => {
  const out = deepMerge({ a: 1, b: 2 }, { b: 9 });
  assert.deepEqual(out, { a: 1, b: 9 });
});

test('util-config: deepMerge — object recursion', () => {
  const a = { entry: { max_position_bch: 0.005, slippage: 100 } };
  const b = { entry: { max_position_bch: 0.05 } };
  const out = deepMerge(a, b);
  assert.deepEqual(out, { entry: { max_position_bch: 0.05, slippage: 100 } });
});

test('util-config: deepMerge — arrays are opaque (b wins)', () => {
  const a = { xs: [1, 2, 3] };
  const b = { xs: [9] };
  const out = deepMerge(a, b);
  assert.deepEqual(out, { xs: [9] });
});

test('util-config: deepMerge — null on b wins over object', () => {
  const a = { x: { nested: true } };
  const b = { x: null };
  const out = deepMerge(a, b);
  assert.equal(out.x, null);
});

test('util-config: deepMerge — undefined on b keeps a', () => {
  const a = { x: 1, y: 2 };
  const b = { y: undefined };
  const out = deepMerge(a, b);
  assert.deepEqual(out, { x: 1, y: 2 });
});

test('util-config: deepMerge — non-object b wins', () => {
  const a = { x: 1 };
  const b = { x: 'hi' };
  const out = deepMerge(a, b);
  assert.equal(out.x, 'hi');
});

test('util-config: deepMerge — never mutates inputs', () => {
  const a = { nested: { x: 1 } };
  const b = { nested: { y: 2 } };
  const aBefore = JSON.stringify(a);
  const bBefore = JSON.stringify(b);
  const out = deepMerge(a, b);
  void out;
  assert.equal(JSON.stringify(a), aBefore, 'a unchanged');
  assert.equal(JSON.stringify(b), bBefore, 'b unchanged');
});

// ─────────────────────────────────────────────────────────────────────
//  resolveConfigPaths
// ─────────────────────────────────────────────────────────────────────

test('util-config: resolveConfigPaths — relative → absolute via cwd', () => {
  const out = resolveConfigPaths({ cwd: '/tmp/tradebot' });
  assert.equal(out.defaultPath, '/tmp/tradebot/config/default.json');
  assert.equal(out.userPath, '/tmp/tradebot/config/user.json');
});

test('util-config: resolveConfigPaths — overrides win', () => {
  const out = resolveConfigPaths({
    cwd: '/tmp',
    defaultPath: 'cfg/d.json',
    userPath: 'cfg/u.json',
  });
  assert.equal(out.defaultPath, '/tmp/cfg/d.json');
  assert.equal(out.userPath, '/tmp/cfg/u.json');
});

// ─────────────────────────────────────────────────────────────────────
//  readConfigFile
// ─────────────────────────────────────────────────────────────────────

test('util-config: readConfigFile — optional missing returns null', async () => {
  const fs = createMemoryFs();
  const r = await readConfigFile({ path: '/nope.json', required: false, fs });
  assert.equal(r, null);
});

test('util-config: readConfigFile — required missing throws ConfigMissingError', async () => {
  const fs = createMemoryFs();
  await assert.rejects(
    () => readConfigFile({ path: '/nope.json', required: true, fs }),
    (err) => err instanceof ConfigMissingError && err.code === 'CONFIG_MISSING' && err.path === '/nope.json',
  );
});

test('util-config: readConfigFile — bad JSON throws ConfigParseError', async () => {
  const fs = createMemoryFs();
  fs.files.set('/bad.json', '{ this is not json');
  await assert.rejects(
    () => readConfigFile({ path: '/bad.json', required: true, fs }),
    (err) => err instanceof ConfigParseError && err.code === 'CONFIG_PARSE',
  );
});

test('util-config: readConfigFile — root array is rejected', async () => {
  const fs = createMemoryFs();
  fs.files.set('/arr.json', '[1,2,3]');
  await assert.rejects(
    () => readConfigFile({ path: '/arr.json', required: true, fs }),
    ConfigParseError,
  );
});

test('util-config: readConfigFile — empty path throws', async () => {
  await assert.rejects(
    () => readConfigFile({ path: '' }),
    ConfigLoaderError,
  );
});

test('util-config: readConfigFile — parses a real JSON object', async () => {
  const fs = createMemoryFs();
  fs.files.set('/ok.json', JSON.stringify({ hello: 'world' }));
  const r = await readConfigFile({ path: '/ok.json', required: true, fs });
  assert.deepEqual(r, { hello: 'world' });
});

// ─────────────────────────────────────────────────────────────────────
//  loadConfig
// ─────────────────────────────────────────────────────────────────────

test('util-config: loadConfig — default only (user.json absent)', async () => {
  const fs = createMemoryFs();
  fs.files.set('/repo/config/default.json', JSON.stringify(DEFAULT_FIXTURE));
  const cfg = await loadConfig({ cwd: '/repo', fs });
  assert.equal(cfg.tuning_preset, 'small_balance_startup');
  assert.equal(cfg.entry.max_position_bch, 0.005);
  assert.equal(cfg.user, null);
  assert.equal(cfg.paths.user, null);
  assert.equal(cfg.paths.default, '/repo/config/default.json');
});

test('util-config: loadConfig — deep-merges user.json on top', async () => {
  const fs = createMemoryFs();
  fs.files.set('/repo/config/default.json', JSON.stringify(DEFAULT_FIXTURE));
  fs.files.set('/repo/config/user.json', JSON.stringify(USER_FIXTURE));
  const cfg = await loadConfig({ cwd: '/repo', fs });
  // Override wins
  assert.equal(cfg.entry.max_position_bch, 0.05, 'operator override');
  // Untouched fields still come from default
  assert.equal(cfg.entry.slippage_tolerance_bps, 100);
  assert.equal(cfg.risk.min_wallet_balance_bch, 0.005);
  // `cfg.user` reflects the user.json root
  assert.equal(cfg.user.wallet.cashaddr, USER_FIXTURE.user.wallet.cashaddr);
  assert.equal(cfg.paths.user, '/repo/config/user.json');
});

test('util-config: loadConfig — throws ConfigMissingError when default.json absent', async () => {
  const fs = createMemoryFs();
  await assert.rejects(
    () => loadConfig({ cwd: '/repo', fs }),
    ConfigMissingError,
  );
});

test('util-config: loadConfig — default+user merging preserves nested scalars', async () => {
  const fs = createMemoryFs();
  fs.files.set('/repo/config/default.json', JSON.stringify({
    scoring: { weights: { volume_24h_bch: 0.30, tvl_bch: 0.15 } },
  }));
  fs.files.set('/repo/config/user.json', JSON.stringify({
    scoring: { weights: { tvl_bch: 0.42 } },
  }));
  const cfg = await loadConfig({ cwd: '/repo', fs });
  assert.equal(cfg.scoring.weights.volume_24h_bch, 0.30, 'untouched weight kept');
  assert.equal(cfg.scoring.weights.tvl_bch, 0.42, 'overridden weight wins');
});

// ─────────────────────────────────────────────────────────────────────
//  summarizeConfig
// ─────────────────────────────────────────────────────────────────────

test('util-config: summarizeConfig — surfaces knobs (no WIF leak)', () => {
  const cfg = {
    tuning_preset: 'small_balance_startup',
    version: 2,
    wallet: { network: 'mainnet', address: 'bitcoincash:qqcp6q32dt4x4ddzrkdz28xmv6a3ev6wwq4t0m57ak' },
    entry: { max_position_bch: 0.005, max_total_exposure_bch: 0.04, slippage_tolerance_bps: 100 },
    risk: { max_daily_loss_bch: 0.005, min_wallet_balance_bch: 0.005 },
    exit: {
      tp_vol_multiplier: 2.0,
      sl_vol_multiplier: 1.0,
      tp_vol_floor_pct: 2.0,
      tp_vol_ceiling_pct: 80.0,
      sl_vol_floor_pct: 1.0,
      sl_vol_ceiling_pct: 50.0,
    },
    loop: { poll_interval_seconds: 60 },
    user: { wallet: { wif: 'L4rK1yL1fakedwifxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' } },
  };
  const summary = summarizeConfig(cfg);
  assert.equal(summary.tuning_preset, 'small_balance_startup');
  assert.equal(summary.max_position_bch, 0.005);
  assert.equal(summary.max_total_exposure_bch, 0.04);
  assert.equal(summary.max_daily_loss_bch, 0.005);
  assert.equal(summary.min_wallet_balance_bch, 0.005);
  assert.equal(summary.slippage_tolerance_bps, 100);
  assert.equal(summary.poll_interval_seconds, 60);
  assert.equal(summary.network, 'mainnet');
  assert.equal(summary.cashaddr, 'bitcoincash:qqcp6q32dt4x4ddzrkdz28xmv6a3ev6wwq4t0m57ak');
  assert.equal(summary.wif_present, true, 'wif_present is a bool flag, not the WIF');
  // T38: dynamic TP/SL knobs surfaced to dashboard.
  assert.equal(summary.tp_vol_multiplier, 2.0);
  assert.equal(summary.sl_vol_multiplier, 1.0);
  assert.equal(summary.tp_vol_floor_pct, 2.0);
  assert.equal(summary.tp_vol_ceiling_pct, 80.0);
  assert.equal(summary.sl_vol_floor_pct, 1.0);
  assert.equal(summary.sl_vol_ceiling_pct, 50.0);
  // Critical: the raw WIF must NOT appear anywhere in the summary.
  assert.equal(JSON.stringify(summary).includes('L4rK1yL1'), false, 'WIF must not leak into summary');
});

test('util-config: summarizeConfig — missing knobs serialize as null', () => {
  const summary = summarizeConfig({});
  assert.equal(summary.max_position_bch, null);
  assert.equal(summary.cashaddr, null);
  assert.equal(summary.wif_present, false);
  // T38: missing T38 knobs also serialize as null.
  assert.equal(summary.tp_vol_multiplier, null);
  assert.equal(summary.sl_vol_multiplier, null);
  assert.equal(summary.tp_vol_floor_pct, null);
  assert.equal(summary.tp_vol_ceiling_pct, null);
  assert.equal(summary.sl_vol_floor_pct, null);
  assert.equal(summary.sl_vol_ceiling_pct, null);
});

test('util-config: summarizeConfig — non-object cfg returns { ok:false }', () => {
  assert.deepEqual(summarizeConfig(null), { ok: false });
  assert.deepEqual(summarizeConfig(undefined), { ok: false });
});

// ─────────────────────────────────────────────────────────────────────
//  fs-helpers.pathExists
// ─────────────────────────────────────────────────────────────────────

test('util-config: pathExists — true on existing file', async () => {
  const fs = createMemoryFs();
  fs.files.set('/here.json', '{}');
  assert.equal(await pathExists('/here.json', fs), true);
});

test('util-config: pathExists — false on ENOENT', async () => {
  const fs = createMemoryFs();
  assert.equal(await pathExists('/nope.json', fs), false);
});

test('util-config: pathExists — empty path → false', async () => {
  assert.equal(await pathExists('', createMemoryFs()), false);
});

test('util-config: pathExists — non-ENOENT errors propagate', async () => {
  const fs = {
    async access() {
      const e = new Error('EACCES');
      e.code = 'EACCES';
      throw e;
    },
  };
  await assert.rejects(() => pathExists('/protected.json', /** @type {any} */ (fs)), /EACCES/);
});

// ─────────────────────────────────────────────────────────────────────
//  fs-helpers.readJsonIfExists
// ─────────────────────────────────────────────────────────────────────

test('util-config: readJsonIfExists — returns parsed object', async () => {
  const fs = createMemoryFs();
  fs.files.set('/a.json', JSON.stringify({ x: 1 }));
  assert.deepEqual(await readJsonIfExists('/a.json', fs), { x: 1 });
});

test('util-config: readJsonIfExists — ENOENT → null', async () => {
  assert.equal(await readJsonIfExists('/nope.json', createMemoryFs()), null);
});

test('util-config: readJsonIfExists — bad JSON → null', async () => {
  const fs = createMemoryFs();
  fs.files.set('/bad.json', '{not json');
  assert.equal(await readJsonIfExists('/bad.json', fs), null);
});

test('util-config: readJsonIfExists — root array → null', async () => {
  const fs = createMemoryFs();
  fs.files.set('/arr.json', '[1,2]');
  assert.equal(await readJsonIfExists('/arr.json', fs), null);
});

test('util-config: readJsonIfExists — empty path → null', async () => {
  assert.equal(await readJsonIfExists('', createMemoryFs()), null);
});

// ─────────────────────────────────────────────────────────────────────
//  fs-helpers.ensureParentDir
// ─────────────────────────────────────────────────────────────────────

test('util-config: ensureParentDir — creates parent recursively', async () => {
  const fs = createMemoryFs();
  await ensureParentDir('/a/b/c/file.json', fs);
  assert.ok(fs.dirs.has('/a/b/c'), 'final dir present');
  assert.ok(fs.dirs.has('/a/b'), 'middle dir present');
  assert.ok(fs.dirs.has('/a'), 'top dir present');
});

test('util-config: ensureParentDir — empty path is a no-op', async () => {
  const fs = createMemoryFs();
  await ensureParentDir('', fs);
  assert.equal(fs.dirs.size, 0);
});

test('util-config: ensureParentDir — file with no parent segment is a no-op', async () => {
  const fs = createMemoryFs();
  // path.dirname('file.json') === '' — helper short-circuits.
  await ensureParentDir('file.json', fs);
  assert.equal(fs.dirs.size, 0, 'no parent dir to create');
});