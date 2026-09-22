#!/usr/bin/env node
// tests/dex-guanaco.test.mjs
//
// Unit tests for the T57-2 guanaco adapter SCAFFOLD (not the
// full adapter — the team hasn't shipped an indexer or SDK).
//
// Covers:
//   - `src/dex/guanaco.mjs` exports: constants (BUYBACK_PKH,
//     BUYBACK_LOCKING_BYTECODE, FEE_TIERS), errors
//     (GuanacoNotConfiguredError, GuanacoNotImplementedError),
//     lookupGuanacoFeeTier, DEFAULT_GUANACO_CONFIG,
//     resolveGuanacoConfig, createGuanacoAdapter
//   - `src/dex/adapter.mjs` registry now includes 'guanaco'
//
// Adapter behavior under test:
//   - isReady() returns false when indexer_url OR sdk_module is null
//   - With both configured, isReady() returns true BUT every other
//     method still throws GuanacoNotImplementedError (no SDK yet)
//   - Factory rejects hard config errors with GuanacoNotConfiguredError
//   - Typed errors are exported and have the expected name/code chain
//
// What is NOT in this subset:
//   - T57-2.2 (the actual swap execution path). Departs on a
//     public guanaco indexer + JS SDK from the team.
//
// Run with:
//   node --test tests/dex-guanaco.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEX_REGISTRY,
  listKnownDexIds,
  isKnownDexId,
  lookupDexRegistryEntry,
  createDexAdapter,
  bootDexAdapters,
  DexAdapterError,
} from '../src/dex/adapter.mjs';

import {
  createGuanacoAdapter,
  resolveGuanacoConfig,
  DEFAULT_GUANACO_CONFIG,
  lookupGuanacoFeeTier,
  GUANACO_BUYBACK_PKH,
  GUANACO_BUYBACK_LOCKING_BYTECODE,
  GUANACO_FEE_TIERS,
  GuanacoNotConfiguredError,
  GuanacoNotImplementedError,
} from '../src/dex/guanaco.mjs';

// ─────────────────────────────────────────────────────────────────────
//  Frozen constants
// ─────────────────────────────────────────────────────────────────────

test('constants: BUYBACK_PKH matches the V1 docs fixed destination', () => {
  assert.equal(GUANACO_BUYBACK_PKH, '748e3dffdc1ab726e8d7d8d381e56034871fe623');
  assert.equal(Object.isFrozen(GUANACO_BUYBACK_PKH), true);
});

test('constants: BUYBACK_LOCKING_BYTECODE is the documented P2PKH bytecode', () => {
  assert.equal(
    GUANACO_BUYBACK_LOCKING_BYTECODE,
    '76a914748e3dffdc1ab726e8d7d8d381e56034871fe62388ac'
  );
  assert.equal(Object.isFrozen(GUANACO_BUYBACK_LOCKING_BYTECODE), true);
});

test('constants: FEE_TIERS enumerates the four V1 fee tiers from the docs', () => {
  assert.equal(GUANACO_FEE_TIERS.length, 4);
  // Tier 0 = 0.01%
  assert.equal(GUANACO_FEE_TIERS[0].level, 0);
  assert.equal(GUANACO_FEE_TIERS[0].feePct, 0.01);
  assert.equal(GUANACO_FEE_TIERS[0].numerator, 1);
  assert.equal(GUANACO_FEE_TIERS[0].denominator, 10_000);
  // Tier 1 = 0.05% (canonical default)
  assert.equal(GUANACO_FEE_TIERS[1].feePct, 0.05);
  assert.equal(GUANACO_FEE_TIERS[1].numerator, 5);
  // Tier 2 = 0.3%
  assert.equal(GUANACO_FEE_TIERS[2].feePct, 0.30);
  assert.equal(GUANACO_FEE_TIERS[2].numerator, 3);
  assert.equal(GUANACO_FEE_TIERS[2].denominator, 1_000);
  // Tier 3 = 1%
  assert.equal(GUANACO_FEE_TIERS[3].feePct, 1.00);
  assert.equal(GUANACO_FEE_TIERS[3].numerator, 1);
  assert.equal(GUANACO_FEE_TIERS[3].denominator, 100);
  // frozen
  assert.equal(Object.isFrozen(GUANACO_FEE_TIERS), true);
  assert.equal(Object.isFrozen(GUANACO_FEE_TIERS[0]), true);
});

test('constants: DEFAULT_GUANACO_CONFIG has both deps null (no public indexer/SDK)', () => {
  assert.equal(DEFAULT_GUANACO_CONFIG.indexerUrl, null);
  assert.equal(DEFAULT_GUANACO_CONFIG.sdkModule, null);
  assert.equal(DEFAULT_GUANACO_CONFIG.defaultFeeTier, 1);
  assert.equal(DEFAULT_GUANACO_CONFIG.buybackPkh, GUANACO_BUYBACK_PKH);
  assert.equal(DEFAULT_GUANACO_CONFIG.requestTimeoutMs, 10_000);
  assert.equal(Object.isFrozen(DEFAULT_GUANACO_CONFIG), true);
});

// ─────────────────────────────────────────────────────────────────────
//  lookupGuanacoFeeTier
// ─────────────────────────────────────────────────────────────────────

test('lookupGuanacoFeeTier: returns the matching tier for valid input', () => {
  assert.deepEqual(lookupGuanacoFeeTier(0), GUANACO_FEE_TIERS[0]);
  assert.deepEqual(lookupGuanacoFeeTier(1), GUANACO_FEE_TIERS[1]);
  assert.deepEqual(lookupGuanacoFeeTier(2), GUANACO_FEE_TIERS[2]);
  assert.deepEqual(lookupGuanacoFeeTier(3), GUANACO_FEE_TIERS[3]);
});

test('lookupGuanacoFeeTier: returns null for bad input (non-integer / out of range / non-number)', () => {
  assert.equal(lookupGuanacoFeeTier(-1), null);
  assert.equal(lookupGuanacoFeeTier(4), null);
  assert.equal(lookupGuanacoFeeTier(0.5), null);
  assert.equal(lookupGuanacoFeeTier('1'), null);
  assert.equal(lookupGuanacoFeeTier(null), null);
  assert.equal(lookupGuanacoFeeTier(undefined), null);
  assert.equal(lookupGuanacoFeeTier(NaN), null);
});

// ─────────────────────────────────────────────────────────────────────
//  resolveGuanacoConfig
// ─────────────────────────────────────────────────────────────────────

test('resolveGuanacoConfig: null/undefined returns defaults', () => {
  const r1 = resolveGuanacoConfig(null);
  assert.equal(r1.ok, true);
  assert.equal(r1.normalized.indexerUrl, null);
  assert.equal(r1.normalized.sdkModule, null);
  assert.equal(r1.normalized.defaultFeeTier, 1);

  const r2 = resolveGuanacoConfig(undefined);
  assert.equal(r2.ok, true);
  assert.equal(r2.normalized.indexerUrl, null);
});

test('resolveGuanacoConfig: empty object returns defaults', () => {
  const r = resolveGuanacoConfig({});
  assert.equal(r.ok, true);
  assert.equal(r.normalized.indexerUrl, null);
  assert.equal(r.normalized.sdkModule, null);
  assert.equal(r.normalized.defaultFeeTier, 1);
  assert.equal(r.normalized.buybackPkh, GUANACO_BUYBACK_PKH);
  assert.equal(r.normalized.requestTimeoutMs, 10_000);
});

test('resolveGuanacoConfig: full override honored', () => {
  const r = resolveGuanacoConfig({
    indexer_url: 'https://indexer.guanaco.fi/v1',
    sdk_module: '/opt/guanaco/sdk.mjs',
    default_fee_tier: 2,
    buyback_pkh: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    request_timeout_ms: 15_000,
  });
  assert.equal(r.ok, true);
  assert.equal(r.normalized.indexerUrl, 'https://indexer.guanaco.fi/v1');
  assert.equal(r.normalized.sdkModule, '/opt/guanaco/sdk.mjs');
  assert.equal(r.normalized.defaultFeeTier, 2);
  assert.equal(r.normalized.buybackPkh, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(r.normalized.requestTimeoutMs, 15_000);
});

test('resolveGuanacoConfig: non-object cfg returns ok:false', () => {
  assert.equal(resolveGuanacoConfig('string').ok, false);
  assert.equal(resolveGuanacoConfig(42).ok, false);
  assert.equal(resolveGuanacoConfig(true).ok, false);
});

test('resolveGuanacoConfig: bad indexer_url returns ok:false', () => {
  // Empty string after undefined/null pass = wrong_type
  assert.equal(resolveGuanacoConfig({ indexer_url: '' }).ok, false);
  assert.equal(resolveGuanacoConfig({ indexer_url: 42 }).ok, false);
  // Invalid URL
  const r1 = resolveGuanacoConfig({ indexer_url: 'not-a-url' });
  assert.equal(r1.ok, false);
  assert.equal(r1.error.code, 'bad_url');
  // Wrong protocol
  const r2 = resolveGuanacoConfig({ indexer_url: 'ftp://indexer.guanaco.fi' });
  assert.equal(r2.ok, false);
  assert.equal(r2.error.code, 'wrong_protocol');
  const r3 = resolveGuanacoConfig({ indexer_url: 'file:///etc/passwd' });
  assert.equal(r3.ok, false);
});

test('resolveGuanacoConfig: bad sdk_module returns ok:false', () => {
  assert.equal(resolveGuanacoConfig({ sdk_module: '' }).ok, false);
  assert.equal(resolveGuanacoConfig({ sdk_module: 42 }).ok, false);
});

test('resolveGuanacoConfig: bad default_fee_tier returns ok:false', () => {
  assert.equal(resolveGuanacoConfig({ default_fee_tier: -1 }).ok, false);
  assert.equal(resolveGuanacoConfig({ default_fee_tier: 4 }).ok, false);
  assert.equal(resolveGuanacoConfig({ default_fee_tier: 0.5 }).ok, false);
  assert.equal(resolveGuanacoConfig({ default_fee_tier: '1' }).ok, false);
});

test('resolveGuanacoConfig: bad buyback_pkh returns ok:false (wrong length / non-hex)', () => {
  assert.equal(resolveGuanacoConfig({ buyback_pkh: '' }).ok, false);
  assert.equal(resolveGuanacoConfig({ buyback_pkh: 'not-hex' }).ok, false);
  // 39 chars (too short)
  assert.equal(resolveGuanacoConfig({ buyback_pkh: 'a'.repeat(39) }).ok, false);
  // 40 chars, but contains non-hex chars
  assert.equal(resolveGuanacoConfig({ buyback_pkh: 'z'.repeat(40) }).ok, false);
  // 41 chars (too long)
  assert.equal(resolveGuanacoConfig({ buyback_pkh: 'a'.repeat(41) }).ok, false);
});

test('resolveGuanacoConfig: bad request_timeout_ms returns ok:false', () => {
  assert.equal(resolveGuanacoConfig({ request_timeout_ms: 0 }).ok, false);
  assert.equal(resolveGuanacoConfig({ request_timeout_ms: -1 }).ok, false);
  assert.equal(resolveGuanacoConfig({ request_timeout_ms: 'ten' }).ok, false);
  assert.equal(resolveGuanacoConfig({ request_timeout_ms: NaN }).ok, false);
  assert.equal(resolveGuanacoConfig({ request_timeout_ms: Infinity }).ok, false);
});

// ─────────────────────────────────────────────────────────────────────
//  Error class shape
// ─────────────────────────────────────────────────────────────────────

test('errors: GuanacoNotConfiguredError extends DexAdapterError with stable code', () => {
  const e = new GuanacoNotConfiguredError('missing config', { code: 'not_set', missing: ['indexer_url'] });
  assert.equal(e.name, 'GuanacoNotConfiguredError');
  assert.equal(e.code, 'not_set');
  assert.equal(e.id, null);
  assert.ok(e instanceof DexAdapterError);
  assert.ok(e instanceof Error);
  assert.deepEqual(e.missing, ['indexer_url']);
});

test('errors: GuanacoNotImplementedError extends DexAdapterError with default code', () => {
  const e = new GuanacoNotImplementedError('pending');
  assert.equal(e.name, 'GuanacoNotImplementedError');
  assert.equal(e.code, 'guanaco_not_implemented');
  assert.ok(e instanceof DexAdapterError);
  assert.ok(e instanceof Error);
});

// ─────────────────────────────────────────────────────────────────────
//  Registry
// ─────────────────────────────────────────────────────────────────────

test('registry: guanaco is registered alongside cauldron / cauldron_safe_mode', () => {
  assert.equal(isKnownDexId('guanaco'), true);
  assert.ok(DEX_REGISTRY.guanaco);
  assert.equal(DEX_REGISTRY.guanaco.displayName, 'Guanaco');
  assert.equal(DEX_REGISTRY.guanaco.safeMode, false);
  assert.equal(typeof DEX_REGISTRY.guanaco.factory, 'function');
  // listKnownDexIds includes it
  const ids = listKnownDexIds();
  assert.ok(ids.includes('guanaco'));
  assert.ok(ids.includes('cauldron'));
  assert.ok(ids.includes('cauldron_safe_mode'));
});

test('registry: lookupDexRegistryEntry returns guanaco entry', () => {
  const entry = lookupDexRegistryEntry('guanaco');
  assert.ok(entry);
  assert.equal(entry.displayName, 'Guanaco');
  assert.equal(entry.safeMode, false);
});

test('registry: DEX_REGISTRY + guanaco entry are frozen', () => {
  assert.equal(Object.isFrozen(DEX_REGISTRY), true);
  assert.equal(Object.isFrozen(DEX_REGISTRY.guanaco), true);
});

// ─────────────────────────────────────────────────────────────────────
//  createGuanacoAdapter — shape, isReady, typed errors
// ─────────────────────────────────────────────────────────────────────

test('createGuanacoAdapter: default (no config) returns scaffold with isReady=false', async () => {
  const a = createGuanacoAdapter();
  assert.equal(a.id, 'guanaco');
  assert.equal(a.displayName, 'Guanaco');
  assert.equal(a.safeMode, false);
  assert.equal(a.indexerUrl, null);
  // Every method is the expected shape
  assert.equal(typeof a.isReady, 'function');
  assert.equal(typeof a.getPoolsAndMeta, 'function');
  assert.equal(typeof a.getTokenStats, 'function');
  assert.equal(typeof a.listPools, 'function');
  assert.equal(typeof a.getBcmr, 'function');
  assert.equal(typeof a.prepareAndBuildSwap, 'function');
  assert.equal(typeof a.broadcastTx, 'function');
  assert.equal(typeof a.verifyTrade, 'function');
  assert.equal(typeof a.constants, 'object');
  // isReady() reflects the missing-dependency state
  assert.equal(await a.isReady(), false);
  // frozen
  assert.equal(Object.isFrozen(a), true);
});

test('createGuanacoAdapter: constants expose the frozen V1 doc values', () => {
  const a = createGuanacoAdapter();
  assert.equal(a.constants.BUYBACK_PKH, GUANACO_BUYBACK_PKH);
  assert.equal(a.constants.BUYBACK_LOCKING_BYTECODE, GUANACO_BUYBACK_LOCKING_BYTECODE);
  assert.equal(a.constants.FEE_TIERS, GUANACO_FEE_TIERS);
  assert.equal(a.constants.DEFAULT_FEE_TIER, 1);
  assert.equal(a.constants.REQUEST_TIMEOUT_MS, 10_000);
  assert.equal(a.constants.INDEXER_DISCOVERY_DOCS, 'https://github.com/guanaco-fi/docs');
});

test('createGuanacoAdapter: every method throws GuanacoNotImplementedError', async () => {
  const a = createGuanacoAdapter();
  const methods = [
    ['getPoolsAndMeta', () => a.getPoolsAndMeta({ tokenId: 'x' })],
    ['getTokenStats', () => a.getTokenStats({ tokenId: 'x' })],
    ['listPools', () => a.listPools({ tokenId: 'x' })],
    ['getBcmr', () => a.getBcmr({ tokenId: 'x' })],
    ['prepareAndBuildSwap', () => a.prepareAndBuildSwap({ tokenId: 'x', sats: 1000n })],
    ['broadcastTx', () => a.broadcastTx({ txHex: '00' })],
    ['verifyTrade', () => a.verifyTrade({ txid: 'a'.repeat(64) })],
  ];
  for (const [name, call] of methods) {
    let caught = null;
    try {
      await call();
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, `${name} should have thrown`);
    assert.ok(caught instanceof GuanacoNotImplementedError, `${name} should throw GuanacoNotImplementedError, got ${caught && caught.constructor && caught.constructor.name}`);
    assert.equal(caught.code, 'guanaco_not_implemented');
    assert.match(caught.message, new RegExp(`guanaco\\.${name}`));
    assert.match(caught.message, /pending_public_indexer_and_sdk/);
  }
});

test('createGuanacoAdapter: isReady flips to true when indexer_url + sdk_module both set', async () => {
  const a = createGuanacoAdapter({
    guanaco: {
      indexer_url: 'https://indexer.guanaco.fi/v1',
      sdk_module: '/opt/guanaco/sdk.mjs',
    },
  });
  assert.equal(await a.isReady(), true);
  // Even when isReady=true, swap methods still throw (no SDK actually loaded)
  let caught = null;
  try {
    await a.getPoolsAndMeta({ tokenId: 'x' });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof GuanacoNotImplementedError);
});

test('createGuanacoAdapter: isReady=false when only indexer_url is set (sdk_module still null)', async () => {
  const a = createGuanacoAdapter({
    guanaco: { indexer_url: 'https://indexer.guanaco.fi/v1' },
  });
  assert.equal(await a.isReady(), false);
});

test('createGuanacoAdapter: isReady=false when only sdk_module is set (indexer_url still null)', async () => {
  const a = createGuanacoAdapter({
    guanaco: { sdk_module: '/opt/guanaco/sdk.mjs' },
  });
  assert.equal(await a.isReady(), false);
});

test('createGuanacoAdapter: invalid config throws GuanacoNotConfiguredError', () => {
  let caught = null;
  try {
    createGuanacoAdapter({ guanaco: { indexer_url: 'not-a-url' } });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof GuanacoNotConfiguredError);
  assert.equal(caught.code, 'bad_url');
  assert.match(caught.message, /dex\.guanaco\.indexer_url/);
});

test('createGuanacoAdapter: config at top-level (no `guanaco:` wrapper) is also accepted', () => {
  const a = createGuanacoAdapter({
    indexer_url: 'https://indexer.guanaco.fi/v1',
    sdk_module: '/opt/guanaco/sdk.mjs',
  });
  assert.equal(a.indexerUrl, 'https://indexer.guanaco.fi/v1');
});

// ─────────────────────────────────────────────────────────────────────
//  createDexAdapter integration (guanaco via the unified factory)
// ─────────────────────────────────────────────────────────────────────

test('createDexAdapter: guanaco id returns the scaffold via the unified factory', async () => {
  const r = createDexAdapter({ id: 'guanaco' });
  assert.equal(r.ok, true);
  assert.equal(r.adapter.id, 'guanaco');
  assert.equal(r.adapter.displayName, 'Guanaco');
  assert.equal(r.adapter.safeMode, false);
  assert.equal(await r.adapter.isReady(), false);
});

test('createDexAdapter: invalid guanaco config surfaces typed ok:false via factory', () => {
  const r = createDexAdapter({
    id: 'guanaco',
    config: { guanaco: { indexer_url: 'ftp://wrong' } },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'factory_threw');
  assert.match(r.error.message, /guanaco/);
  // The underlying cause is preserved in the error message (typed envelope)
  assert.match(r.error.message, /wrong_protocol|factory/i);
});

test('bootDexAdapters: guanaco in active list without config boots the scaffold (isReady=false)', async () => {
  // The scaffold is always bootable — boot.ok is true because the
  // factory returns the scaffold (every method just throws
  // GuanacoNotImplementedError). The "not ready" state surfaces at
  // isReady() time, which the trader loop's multi-DEX routing layer
  // (T57-3) is responsible for checking.
  const boot = bootDexAdapters({ active: ['cauldron', 'guanaco'], safeModeActive: false });
  assert.equal(boot.ok, true);
  assert.equal(boot.adapters.length, 2);
  assert.equal(boot.failed.length, 0);
  const guanaco = boot.adapters.find((a) => a.id === 'guanaco');
  assert.ok(guanaco);
  assert.equal(await guanaco.isReady(), false);
});

test('bootDexAdapters: guanaco boots successfully with full config', () => {
  const boot = bootDexAdapters(
    { active: ['cauldron', 'guanaco'], safeModeActive: false },
    {
      config: {
        guanaco: {
          indexer_url: 'https://indexer.guanaco.fi/v1',
          sdk_module: '/opt/guanaco/sdk.mjs',
        },
      },
    }
  );
  assert.equal(boot.ok, true);
  assert.equal(boot.adapters.length, 2);
  const ids = boot.adapters.map((a) => a.id);
  assert.deepEqual(ids, ['cauldron', 'guanaco']);
});

test('bootDexAdapters: guanaco factory error does NOT abort the tick (cauldron still boots)', () => {
  // Confirms the QUALITY BAR contract: a single failed adapter
  // must not stop the rest of the dex layer from booting.
  const boot = bootDexAdapters(
    { active: ['guanaco', 'cauldron'], safeModeActive: false },
    {
      config: { guanaco: { indexer_url: 'ftp://wrong' } },
    }
  );
  assert.equal(boot.ok, false); // guanaco failed
  assert.equal(boot.adapters.length, 1);
  assert.equal(boot.adapters[0].id, 'cauldron');
  assert.equal(boot.failed.length, 1);
  assert.equal(boot.failed[0].id, 'guanaco');
});
