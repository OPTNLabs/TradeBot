// tests/trader-loop-stake.test.mjs
//
// T75 — Tests for the loop's `_maybeAutoLock` path.
//
// Operator spec (2026-09-19 22:58 PDT):
//   1. Single BadgerStake position max (already enforced by the
//      `lockNftCount !== 0` short-circuit + `executeLock`'s
//      `STALE_LOCK_EXISTS` guard + `max_active_stakes: 1`).
//   2. Lock amount = half of the wallet's available BCH (computed
//      from the live UTXO set on every tick).
//   3. Open trading positions do NOT factor in (the previous
//      `allow_when_positions_open` guard was removed).
//
// The tests below construct a TradingLoop instance with stub seams
// (no real wallet, no real Electrum) and assert each guard fires
// the expected way.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TradingLoop } from '../src/trader/loop.mjs';

// ─── Stub helpers ───────────────────────────────────────────────────────

function makeLogger() {
  const events = [];
  const log = (level) => (event, payload) => events.push({ level, event, payload });
  return {
    events,
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    debug: log('debug'),
  };
}

function makeWallet({ utxos = [], getBlockHeightValue = 850000 } = {}) {
  return {
    listUtxos: async () => utxos,
    getBlockHeight: async () => getBlockHeightValue,
    getWif: () => 'L1aW4aubDFB7yfras2S1mKx8fHE7E1kz9c2x7d9b8e3b1a4c5d6e7f8a9b0c1d2e',
    getPkh: () => new Uint8Array(20).fill(7),
    wif: 'L1aW4aubDFB7yfras2S1mKx8fHE7E1kz9c2x7d9b8e3b1a4c5d6e7f8a9b0c1d2e',
    _resolveDeps: async () => ({
      provider: {
        sendRawTransaction: async () => 'stub-txid',
        getBlockHeight: async () => getBlockHeightValue,
      },
    }),
  };
}

function makeCfg(overrides = {}) {
  return {
    staking: {
      enabled: true,
      simulation_only: false,
      auto_lock_enabled: true,
      auto_unlock_enabled: true,
      lock_min_balance_bch: 0.005,
      stake_blocks: 1440,
      max_active_stakes: 1,
      // legacy knobs (kept for backward-compat, loop ignores them now):
      lock_amount_sats: 500000,
      allow_when_positions_open: false,
      ...overrides,
    },
    entry: { max_position_bch: 0.005 },
    ...overrides,
  };
}

/**
 * Build a TradingLoop instance with stub seams wired, then call
 * `_maybeAutoLock` directly with a chosen UTXO set + lockNftCount.
 * Returns the dispatch result envelope + captured executeLock call args.
 */
async function runAutoLock({
  cfg = makeCfg(),
  utxos = [],
  lockNftCount = 0,
  positions = [],
  walletOverrides = {},
}) {
  const logger = makeLogger();
  const wallet = makeWallet(walletOverrides);

  // Stub executeLock — capture args, return a synthetic envelope.
  let lockCallArgs = null;
  const stakingLockExecute = async (args) => {
    lockCallArgs = args;
    return {
      ok: true,
      kind: 'lock',
      txid: 'stub-lock-txid',
      code: 'OK',
    };
  };

  const loop = new TradingLoop({
    cfg,
    wallet,
    fetcher: { listTopTokens: async () => [] },
    positions: { list: async () => positions },
    logger,
    dryRun: false,
    // Required TradingLoop seams (the loop's ctor asserts each one).
    // We don't exercise swap / snapshots / breaker in this test path,
    // so minimal stubs are enough.
    swap: { execute: async () => ({ ok: true, txid: 'stub-swap' }) },
    snapshots: { record: async () => null },
    breaker: { evaluate: () => ({ tripped: false }) },
    historyAppend: async () => null,
    stakingProvider: { sendRawTransaction: async () => 'stub' },
    stakingLockExecute,
    stakingUnlockExecute: async () => ({ ok: true, txid: 'stub-unlock' }),
    stakingDispatch: async () => ({ ok: true, dispatched: 0, persisted: 0, failed: 0 }),
    stakingGetBlockHeight: async () => 850000,
  });

  const result = await loop._maybeAutoLock({
    stakeCfg: cfg.staking,
    utxos,
    lockNftCount,
    nowMs: Date.now(),
  });

  return { result, lockCallArgs, logger };
}

// ─── Tests ──────────────────────────────────────────────────────────────

test('T75: half-of-balance — lock amount is wallet_balance / 2 with BigInt floor', async () => {
  // 0.04827 BCH → 4826872 sats → half = 2413436 sats (= 0.02413436 BCH)
  const utxos = [{ satoshis: 4826872 }];
  const { result, lockCallArgs } = await runAutoLock({ utxos });

  assert.ok(result, 'expected a dispatch result envelope');
  assert.equal(result.ok, true);
  assert.equal(lockCallArgs.amountSats, '2413436'); // BigInt floor of 4826872/2
  assert.equal(lockCallArgs.stakeBlocks, 1440);
});

test('T75: half-of-balance — odd-satoshi balance uses BigInt floor (no over-lock)', async () => {
  // 0.02000001 BCH = 2000001 sats; half = 1000000 sats. Reserve
  // = 500000 sats, so 1000000 >= 500000 → fires.
  // (Earlier I tried 100001 sats but 50000 < 500000 reserve → below_min.)
  const utxos = [{ satoshis: 2000001 }];
  const { result, lockCallArgs } = await runAutoLock({ utxos });

  assert.ok(result, 'expected the lock attempt to fire');
  assert.equal(result.ok, true);
  assert.equal(lockCallArgs.amountSats, '1000000'); // BigInt floor of 2000001/2
});

test('T75: balance below 2×reserve short-circuits with below_min_balance', async () => {
  // 0.001 BCH = 100000 sats; reserve = 0.005 BCH = 500000 sats
  // 100000 < 2 * 500000 = 1000000 → refuse
  const utxos = [{ satoshis: 100000 }];
  const { result, lockCallArgs, logger } = await runAutoLock({ utxos });

  assert.equal(result, null, 'should skip');
  assert.equal(lockCallArgs, null, 'executeLock should not be called');
  const skipEvent = logger.events.find(
    (e) => e.event === 'loop.stake.lock.skipped' && e.payload.reason === 'below_min_balance'
  );
  assert.ok(skipEvent, 'expected below_min_balance skip event');
  assert.equal(skipEvent.payload.reserve_sats, '500000');
});

test('T75: empty wallet short-circuits with empty_wallet', async () => {
  const { result, lockCallArgs, logger } = await runAutoLock({ utxos: [] });
  assert.equal(result, null);
  assert.equal(lockCallArgs, null);
  const skipEvent = logger.events.find((e) => e.payload.reason === 'empty_wallet');
  assert.ok(skipEvent, 'expected empty_wallet skip event');
});

test('T75: lockNFT already present short-circuits (single-position invariant)', async () => {
  const utxos = [{ satoshis: 1000000 }];
  const { result, lockCallArgs, logger } = await runAutoLock({ utxos, lockNftCount: 1 });
  assert.equal(result, null);
  assert.equal(lockCallArgs, null);
  const skipEvent = logger.events.find(
    (e) => e.event === 'loop.stake.lock.skipped' && e.payload.reason === 'lockNFT already present'
  );
  assert.ok(skipEvent, 'expected lockNFT-already-present skip event');
  assert.equal(skipEvent.payload.lock_nft_count, 1);
});

test('T75: open trading positions do NOT gate the lock attempt', async () => {
  // 8 open positions, plenty of balance — the old guard would have
  // skipped with reason='positions_open'; the new spec says positions
  // are irrelevant. The lock should fire with amountSats = balance/2.
  const utxos = [{ satoshis: 4826872 }];
  const positions = Array.from({ length: 8 }, (_, i) => ({ id: `pos-${i}`, status: 'open' }));
  const { result, lockCallArgs, logger } = await runAutoLock({ utxos, positions });

  assert.ok(result, 'expected the lock attempt to fire despite open positions');
  assert.equal(result.ok, true);
  assert.equal(lockCallArgs.amountSats, '2413436');
  // No positions_open skip event should appear
  const positionsSkip = logger.events.find(
    (e) => e.event === 'loop.stake.lock.skipped' && e.payload.reason === 'positions_open'
  );
  assert.equal(positionsSkip, undefined, 'positions guard should be gone');
});

test('T75: amountSats passed to executeLock is the BigInt string (no precision loss)', async () => {
  // Balance large enough that the BigInt representation matters.
  // 21 BCH = 2_100_000_000 sats → half = 1_050_000_000 sats
  const utxos = [{ satoshis: '2100000000' }]; // string, like Electrum returns
  const { lockCallArgs } = await runAutoLock({ utxos });
  assert.equal(lockCallArgs.amountSats, '1050000000');
});

test('T75: legacy `lock_amount_sats` config knob is ignored (spec: half-of-balance wins)', async () => {
  // Even if the operator leaves the legacy `lock_amount_sats: 500000`
  // knob set, the live wire computes `wallet_balance / 2`.
  const utxos = [{ satoshis: 4826872 }];
  const cfg = makeCfg({ lock_amount_sats: 999999999 });
  const { lockCallArgs } = await runAutoLock({ cfg, utxos });
  assert.equal(lockCallArgs.amountSats, '2413436', 'lock_amount_sats knob must be ignored');
});

test('T75: max_active_stakes:1 + STALE_LOCK_EXISTS layer keep the single-position invariant', async () => {
  // The loop's surface guard (lockNftCount !== 0) is the FIRST layer.
  // The executeLock STALE_LOCK_EXISTS guard is the SECOND.
  // We assert the surface layer fires here; the second is exercised
  // in tests/staking-badger-stake-tx.test.mjs (already passes).
  const utxos = [{ satoshis: 1000000 }];
  const { result } = await runAutoLock({ utxos, lockNftCount: 1 });
  assert.equal(result, null);
});
