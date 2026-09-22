// tests/trader/swap.test.mjs
//
// Unit tests for `src/trader/swap.mjs` — the SwapExecutor + helpers.
// EVERY external surface is mocked: SDK, Electrum provider, wallet,
// indexer fetcher. Tests NEVER execute a real swap.
//
// Run with:  node --test tests/trader/swap.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SwapExecutor,
  SwapError,
  SwapConfigError,
  SwapPreFlightError,
  SwapInsufficientFundsError,
  SwapBroadcastError,
  SwapVerificationError,
  computeSlippageBps,
  preFlightCheck,
  resolveEffectiveSlippageCapBps,
  maxTokensForBudget,
} from '../../src/trader/swap.mjs';
import { createLogger, createMemorySink } from '../../src/util/logger.mjs';

// ─────────────────────────────────────────────────────────────────────
//  Fixtures
// ─────────────────────────────────────────────────────────────────────

/** 64-hex token_id (PUSD-shaped). */
const TOKEN_ID = '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544';
/** Cashaddr-shaped destination. */
const DESTINATION = 'bitcoincash:qqcp6q32dt4x4ddzrkdz28xmv6a3ev6wwq4t0m57ak';

/** Default config aligned with `tuning_preset: "small_balance_startup"`. */
function baseConfig(overrides = {}) {
  return {
    wallet: { network: 'mainnet' },
    data_sources: { electrum_host: 'electrum.imaginary.cash', electrum_port: 50004 },
    risk: {
      max_position_bch: 0.005,
      max_total_exposure_bch: 0.04,
      min_wallet_balance_bch: 0.005,
      slippage_tolerance_bps: 100,
      max_daily_loss_bch: 0.005,
    },
    ...overrides,
  };
}

/**
 * Build a minimal wallet stub that SwapExecutor can call. It exposes
 * `getBalanceSats()`, `init()`, `_wif`, `_provider`, `_resolveDeps()`,
 * and `getAddress()` (the latter is required by the cauldron-swap-sdk
 * for signer plumbing even though we mock the actual signing).
 */
function fakeWallet({ balanceSats = 4435967n, wif = 'KFsnU1YFjcV7RYwbjHgfXrb6A58urPnexEpEWdQmj2STpmeamW' } = {}) {
  return {
    _wif: wif,
    _provider: { fake: true, getUtxos: () => Promise.resolve([]), sendRawTransaction: () => Promise.resolve('aa'.repeat(32)) },
    getAddress: () => DESTINATION,
    async getBalanceSats() { return balanceSats; },
    async _resolveDeps() { return { provider: this._provider }; },
    async init() {},
    async close() {},
  };
}

/**
 * A minimal pool shape — `sats / tokens` gives the rate in sats per
 * token. With sats=100_000, tokens=100 we get 1000 sats/token for the
 * cheapest pool. The second pool is more expensive (1200 sats/token).
 */
function fakePools() {
  return [
    { pool_id: 'pp'.repeat(16), txid: '11'.repeat(32), tx_pos: 0, sats: 100_000n, tokens: 100n, owner_p2pkh_addr: 'bitcoincash:qfake' },
    { pool_id: 'qq'.repeat(16), txid: '22'.repeat(32), tx_pos: 0, sats: 120_000n, tokens: 100n, owner_p2pkh_addr: 'bitcoincash:qfake' },
  ];
}

/** Tiny pre-baked allocation result. */
function fakeAllocations() {
  const p = fakePools()[0];
  return [{
    pool: p,
    demandAmount: 50n,
    supplyAmount: 50_000n,
    feeAmount: 150n,
  }];
}

/**
 * Build a fully-wired executor with overridable deps. Most tests use
 * this; tests that need a specific failure path inject different deps.
 */
function makeExecutor(opts = {}) {
  const sink = opts.sink ?? createMemorySink();
  const logger = opts.logger ?? createLogger({ sink: sink.stream });
  const wallet = opts.wallet ?? fakeWallet(opts.walletOpts ?? {});
  const cfg = opts.cfg ?? baseConfig();
  const executor = new SwapExecutor({
    cfg,
    wallet,
    logger,
    deps: {
      getPoolsAndMeta: opts.getPoolsAndMeta,
      planTrade: opts.planTrade,
      prepareAndBuildSwap: opts.prepareAndBuildSwap,
      broadcastTx: opts.broadcastTx,
      verifyTrade: opts.verifyTrade,
      // T28 default: tests that don't explicitly pass `maxTokensForBudget`
      // use a 1:1 mock so an `amountBase: 50n` input passes through as
      // 50n tokens. Tests that need to assert budget math pass an
      // explicit function (see tests/trader/swap.test.mjs and the
      // 'maxTokensForBudget' unit-test block below).
      maxTokensForBudget: opts.maxTokensForBudget ?? (() => 50n),
      sdk: opts.sdk,
      openExposureBch: opts.openExposureBch ?? 0,
    },
    // T57-3: optional constructor-time DEX adapter (used by the
    // trader loop when a single adapter is wired in and the per-call
    // override isn't set). When `opts.dexAdapter` is undefined/null
    // the executor keeps the legacy fast-path (deps.* wins, then
    // the live cauldron import). When it's set, the executor routes
    // `prepareAndBuildSwap` / `broadcastTx` / `verifyTrade` through
    // the adapter UNLESS the caller also passed the same key as a
    // `deps.*` injection (so existing tests don't need to rewrite).
    dexAdapter: opts.dexAdapter,
  });
  return { executor, logger, sink, wallet, cfg };
}

/**
 * T57-3: build a fake DEX adapter. Exposes the methods
 * SwapExecutor / the dex-router require, with call recorders so
 * tests can assert which adapter was used for a given trade.
 *
 * @param {{ id?: string, safeMode?: boolean }} [opts]
 */
function fakeDexAdapter(opts = {}) {
  const id = opts.id ?? 'fake-dex';
  const safeMode = opts.safeMode === true;
  return {
    id,
    displayName: `Fake DEX ${id}`,
    safeMode,
    indexerUrl: `https://${id}.example`,
    calls: { prepareAndBuildSwap: 0, broadcastTx: 0, verifyTrade: 0, getPoolsAndMeta: 0 },
    async getPoolsAndMeta({ tokenId }) {
      this.calls.getPoolsAndMeta++;
      return {
        tokenId,
        pools: fakePools(),
        tokenMeta: { symbol: 'TKN', decimals: 4 },
        buySpot: 1000n,
        sellSpot: 1200n,
        effectiveBuy: 1003n,
        effectiveSell: 1196n,
        totalSats: 210_000n,
        totalTokens: 200n,
      };
    },
    async prepareAndBuildSwap() { this.calls.prepareAndBuildSwap++; return { txHex: 'aa' }; },
    async broadcastTx() { this.calls.broadcastTx++; return 'bb'.repeat(32); },
    async verifyTrade() { this.calls.verifyTrade++; return { ok: true, kind: 'ok', verdict: 'ok' }; },
    constants: {},
  };
}

// ─────────────────────────────────────────────────────────────────────
//  computeSlippageBps
// ─────────────────────────────────────────────────────────────────────

test('computeSlippageBps: buy — actual==expected → 0 bps', () => {
  assert.equal(computeSlippageBps('buy', 1000n, 1000n), 0n);
});

test('computeSlippageBps: buy — actual > expected → positive (bad)', () => {
  // 1100 vs 1000 = +10% = +1000 bps
  assert.equal(computeSlippageBps('buy', 1000n, 1100n), 1000n);
});

test('computeSlippageBps: buy — actual < expected → negative (good)', () => {
  // 900 vs 1000 = -10% = -1000 bps
  assert.equal(computeSlippageBps('buy', 1000n, 900n), -1000n);
});

test('computeSlippageBps: sell — actual < expected → positive (bad)', () => {
  // We expected 1000 sats/token, got 900 → -10% received = +1000 bps bad.
  assert.equal(computeSlippageBps('sell', 1000n, 900n), 1000n);
});

test('computeSlippageBps: sell — actual > expected → negative (good)', () => {
  assert.equal(computeSlippageBps('sell', 1000n, 1100n), -1000n);
});

test('computeSlippageBps: zero expected → 0 bps (defensive)', () => {
  assert.equal(computeSlippageBps('buy', 0n, 1000n), 0n);
  assert.equal(computeSlippageBps('sell', 0n, 1000n), 0n);
});

test('computeSlippageBps: 1-bps precision', () => {
  // (1010-1000)/1000 = 0.01 = 10 bps
  assert.equal(computeSlippageBps('buy', 1000n, 1010n), 100n);
  // (1001-1000)/1000 = 0.001 = 10 bps
  assert.equal(computeSlippageBps('buy', 1000n, 1001n), 10n);
});

// ─────────────────────────────────────────────────────────────────────
//  maxTokensForBudget (T28 — BCH sats → token base units)
// ─────────────────────────────────────────────────────────────────────

test('maxTokensForBudget: empty pools → 0n', () => {
  assert.equal(maxTokensForBudget([], 1_000_000n), 0n);
});

test('maxTokensForBudget: zero / non-bigint budget → 0n', () => {
  const pools = [{ sats: 100_000n, tokens: 100n }];
  assert.equal(maxTokensForBudget(pools, 0n), 0n);
  assert.equal(maxTokensForBudget(pools, -1n), 0n);
  assert.equal(maxTokensForBudget(pools, undefined), 0n);
  assert.equal(maxTokensForBudget(pools, null), 0n);
});

test('maxTokensForBudget: budget too small for any allocation → 0n', () => {
  // fakePools[0] has 100 tokens @ 1000 sats/token. A 50-sat budget
  // can't even cover 1 token's worth + dust + base tx fee.
  const pools = fakePools();
  assert.equal(maxTokensForBudget(pools, 50n), 0n);
  assert.equal(maxTokensForBudget(pools, 1_000n), 0n);   // < 3000 sat (base + dust)
});

test('maxTokensForBudget: figures out the right token amount for a healthy budget', () => {
  // fakePools has 100 tokens @ 1000 sats/token + 100 tokens @ 1200 sats/token
  // (the constant-product AMM splits the buy across both pools).
  // With a 100_000-sat budget we should be able to afford > 50 tokens
  // (the cheaper pool alone can sell ~97 at 1000 sats/token + fees).
  const result = maxTokensForBudget(fakePools(), 100_000n);
  assert.ok(result > 50n, `expected > 50, got ${result}`);
  assert.ok(result <= 200n, `expected <= 200, got ${result}`);
});

test('maxTokensForBudget: monotonically non-decreasing in budget', () => {
  const pools = fakePools();
  const sizes = [10_000n, 50_000n, 100_000n, 500_000n, 1_000_000n];
  const results = sizes.map((b) => maxTokensForBudget(pools, b));
  for (let i = 1; i < results.length; i++) {
    assert.ok(results[i] >= results[i - 1],
      `budget ${sizes[i]} (${results[i]} tokens) should buy ≥ budget ${sizes[i-1]} (${results[i-1]} tokens)`);
  }
});

test('maxTokensForBudget: budget larger than pool liquidity caps at total', () => {
  // Both pools have 100 tokens each = 200 tokens total liquidity.
  // A 10_000_000 BCH (huge) budget should still cap at 200 - reserve.
  const result = maxTokensForBudget(fakePools(), 1_000_000_000_000n);
  assert.ok(result <= 200n, `should cap at pool liquidity, got ${result}`);
});

// ─────────────────────────────────────────────────────────────────────
//  preFlightCheck
// ─────────────────────────────────────────────────────────────────────

test('preFlightCheck: accepts a buy that respects every limit', () => {
  // Should not throw.
  preFlightCheck({
    cfg: baseConfig(),
    side: 'buy',
    amountBch: 0.005,                     // == max_position_bch
    walletBalanceSats: 4_435_967n,
    openExposureBch: 0.035,               // 0.035 + 0.005 = 0.04 == max_total_exposure_bch
    slippageBps: 50n,                     // < 100 bps tolerance
  });
});

test('preFlightCheck: rejects amount > max_position_bch', () => {
  assert.throws(
    () => preFlightCheck({
      cfg: baseConfig(),
      side: 'buy',
      amountBch: 0.006,
      walletBalanceSats: 4_435_967n,
      openExposureBch: 0,
      slippageBps: 0n,
    }),
    (e) => e instanceof SwapPreFlightError && e.kind === 'position_too_large',
  );
});

test('preFlightCheck: rejects total exposure > max_total_exposure_bch', () => {
  assert.throws(
    () => preFlightCheck({
      cfg: baseConfig(),
      side: 'buy',
      amountBch: 0.005,
      walletBalanceSats: 4_435_967n,
      openExposureBch: 0.04,
      slippageBps: 0n,
    }),
    (e) => e instanceof SwapPreFlightError && e.kind === 'exposure_exceeded',
  );
});

test('preFlightCheck: rejects buy that drops wallet below floor', () => {
  // Use a relaxed position ceiling so we trip the floor gate, not the
  // position-size gate. 0.0055 BCH spend on a 0.0099 BCH wallet leaves
  // 0.0044 BCH, below the 0.005 floor.
  const cfg = baseConfig({ risk: { ...baseConfig().risk, max_position_bch: 0.01 } });
  assert.throws(
    () => preFlightCheck({
      cfg,
      side: 'buy',
      amountBch: 0.0055,
      walletBalanceSats: 990_000n,
      openExposureBch: 0,
      slippageBps: 0n,
    }),
    (e) => e instanceof SwapInsufficientFundsError && e.kind === 'below_floor',
  );
});

test('preFlightCheck: does NOT enforce the wallet floor on a sell', () => {
  // Selling tokens doesn't reduce BCH balance — only the wallet floor
  // for buys should apply. A sell is always allowed from the floor's POV.
  preFlightCheck({
    cfg: baseConfig(),
    side: 'sell',
    amountBch: 0.005,
    walletBalanceSats: 100_000n,        // tiny balance is fine for a sell
    openExposureBch: 0,
    slippageBps: 0n,
  });
});

test('preFlightCheck: rejects slippage > tolerance', () => {
  assert.throws(
    () => preFlightCheck({
      cfg: baseConfig(),
      side: 'buy',
      amountBch: 0.001,
      walletBalanceSats: 4_435_967n,
      openExposureBch: 0,
      slippageBps: 500n,
    }),
    (e) => e instanceof SwapPreFlightError && e.kind === 'slippage_exceeded',
  );
});

test('preFlightCheck: rejects missing risk.max_position_bch', () => {
  const cfg = baseConfig();
  delete cfg.risk.max_position_bch;
  assert.throws(
    () => preFlightCheck({
      cfg, side: 'buy', amountBch: 0.001,
      walletBalanceSats: 4_435_967n, openExposureBch: 0, slippageBps: 0n,
    }),
    SwapConfigError,
  );
});

test('preFlightCheck: rejects missing risk.max_total_exposure_bch', () => {
  const cfg = baseConfig();
  delete cfg.risk.max_total_exposure_bch;
  assert.throws(
    () => preFlightCheck({
      cfg, side: 'buy', amountBch: 0.001,
      walletBalanceSats: 4_435_967n, openExposureBch: 0, slippageBps: 0n,
    }),
    SwapConfigError,
  );
});

test('preFlightCheck: rejects missing risk.min_wallet_balance_bch', () => {
  const cfg = baseConfig();
  delete cfg.risk.min_wallet_balance_bch;
  assert.throws(
    () => preFlightCheck({
      cfg, side: 'buy', amountBch: 0.001,
      walletBalanceSats: 4_435_967n, openExposureBch: 0, slippageBps: 0n,
    }),
    SwapConfigError,
  );
});

test('preFlightCheck: rejects invalid side', () => {
  assert.throws(
    () => preFlightCheck({
      cfg: baseConfig(), side: 'hold', amountBch: 0.001,
      walletBalanceSats: 4_435_967n, openExposureBch: 0, slippageBps: 0n,
    }),
    SwapConfigError,
  );
});

test('preFlightCheck: rejects non-bigint walletBalanceSats', () => {
  assert.throws(
    () => preFlightCheck({
      cfg: baseConfig(), side: 'buy', amountBch: 0.001,
      // @ts-expect-error intentional
      walletBalanceSats: 1000, openExposureBch: 0, slippageBps: 0n,
    }),
    SwapConfigError,
  );
});

test('preFlightCheck: rejects non-bigint slippageBps', () => {
  assert.throws(
    () => preFlightCheck({
      cfg: baseConfig(), side: 'buy', amountBch: 0.001,
      walletBalanceSats: 4_435_967n, openExposureBch: 0,
      // @ts-expect-error intentional
      slippageBps: 50,
    }),
    SwapConfigError,
  );
});

test('preFlightCheck: floating-point wiggle room (boundary 0.04 BCH passes)', () => {
  // Confirms the floating-point guards don't reject at the boundary.
  // openExposureBch=0.035 + amountBch=0.005 = 0.04 = max_total_exposure_bch.
  preFlightCheck({
    cfg: baseConfig(),
    side: 'buy',
    amountBch: 0.005,
    walletBalanceSats: 5_000_000n,
    openExposureBch: 0.035,
    slippageBps: 0n,
  });
});

// ─────────────────────────────────────────────────────────────────────
//  SwapExecutor — constructor
// ─────────────────────────────────────────────────────────────────────

test('SwapExecutor: constructor requires opts', () => {
  assert.throws(() => new SwapExecutor(null), SwapConfigError);
  assert.throws(() => new SwapExecutor({}), SwapConfigError);
  assert.throws(() => new SwapExecutor({ cfg: baseConfig() }), SwapConfigError);
});

test('SwapExecutor: constructor tolerates missing logger', () => {
  const w = fakeWallet();
  const ex = new SwapExecutor({ cfg: baseConfig(), wallet: w });
  assert.ok(ex.logger);
});

// ─────────────────────────────────────────────────────────────────────
//  T57-3: SwapExecutor dexAdapter — constructor + per-call override
// ─────────────────────────────────────────────────────────────────────

test('SwapExecutor: dexAdapter defaults to null when omitted (back-compat)', () => {
  const ex = new SwapExecutor({ cfg: baseConfig(), wallet: fakeWallet() });
  assert.equal(ex.dexAdapter, null);
});

test('SwapExecutor: dexAdapter is stored when a valid adapter is provided', () => {
  const adapter = fakeDexAdapter({ id: 'cauldron' });
  const ex = new SwapExecutor({ cfg: baseConfig(), wallet: fakeWallet(), dexAdapter: adapter });
  assert.strictEqual(ex.dexAdapter, adapter);
});

test('SwapExecutor: dexAdapter rejects non-object', () => {
  assert.throws(
    () => new SwapExecutor({ cfg: baseConfig(), wallet: fakeWallet(), dexAdapter: 'nope' }),
    SwapConfigError,
  );
  assert.throws(
    () => new SwapExecutor({ cfg: baseConfig(), wallet: fakeWallet(), dexAdapter: 42 }),
    SwapConfigError,
  );
});

test('SwapExecutor: dexAdapter rejects adapter missing required methods', () => {
  const incomplete = { id: 'incomplete', displayName: 'Incomplete', safeMode: false };
  assert.throws(
    () => new SwapExecutor({ cfg: baseConfig(), wallet: fakeWallet(), dexAdapter: incomplete }),
    (e) => {
      assert.ok(e instanceof SwapConfigError);
      assert.match(e.message, /must expose prepareAndBuildSwap \+ broadcastTx \+ verifyTrade/);
      return true;
    },
  );
});

test('execute: per-call dexAdapter override routes prepareAndBuildSwap through the adapter', async () => {
  const adapter = fakeDexAdapter({ id: 'fake' });
  const { executor } = makeExecutor({
    // No prepareAndBuildSwap / broadcastTx / verifyTrade deps — the
    // adapter must be the source of truth.
    planTrade: ({ side, amount, pools }) => ({
      side, amount, pools,
      allocations: fakeAllocations(),
      totalSupply: 50_000n, totalFees: 150n,
      effectiveRate: 1000n, impactPct: 0.001,
      estTxBytes: 397n, estNetworkFeeSats: 794n,
      buyUnder: null, sellOver: null,
    }),
    // 50n sats is too small to afford any pool allocation via the
    // real maxTokensForBudget; override with a 1:1 mock so the
    // adapter end-to-end path runs.
    maxTokensForBudget: () => 50n,
  });
  const out = await executor.execute({
    tokenId: TOKEN_ID, side: 'buy', amountBase: 50n, destination: DESTINATION,
    dexAdapter: adapter,
  });
  assert.equal(out.ok, true);
  // The fake adapter's broadcastTx returns `{ txid: 'bb'.repeat(32) }`
  // (matching the live cauldron broadcastTx signature); the executor
  // unwraps `.txid` so the result carries the hex string.
  assert.equal(out.txid, 'bb'.repeat(32));
  // Adapter methods fired end-to-end (build → broadcast → verify).
  assert.equal(adapter.calls.prepareAndBuildSwap, 1);
  assert.equal(adapter.calls.broadcastTx, 1);
  assert.equal(adapter.calls.verifyTrade, 1);
});

test('execute: per-call dexAdapter override wins over constructor adapter', async () => {
  const ctorAdapter = fakeDexAdapter({ id: 'ctor' });
  const callAdapter = fakeDexAdapter({ id: 'call' });
  const { executor } = makeExecutor({
    planTrade: ({ side, amount, pools }) => ({
      side, amount, pools,
      allocations: fakeAllocations(),
      totalSupply: 50_000n, totalFees: 150n,
      effectiveRate: 1000n, impactPct: 0.001,
      estTxBytes: 397n, estNetworkFeeSats: 794n,
      buyUnder: null, sellOver: null,
    }),
    maxTokensForBudget: () => 50n,
    dexAdapter: ctorAdapter,
  });
  const out = await executor.execute({
    tokenId: TOKEN_ID, side: 'buy', amountBase: 50n, destination: DESTINATION,
    dexAdapter: callAdapter,
  });
  assert.equal(out.ok, true);
  assert.equal(ctorAdapter.calls.prepareAndBuildSwap, 0);
  assert.equal(callAdapter.calls.prepareAndBuildSwap, 1);
});

test('execute: per-call dexAdapter rejects non-object', async () => {
  const { executor } = makeExecutor({});
  await assert.rejects(
    () => executor.execute({
      tokenId: TOKEN_ID, side: 'buy', amountBase: 50n, destination: DESTINATION,
      dexAdapter: 'nope',
    }),
    SwapConfigError,
  );
});

test('execute: per-call dexAdapter rejects adapter missing required methods', async () => {
  const incomplete = { id: 'incomplete', displayName: 'Incomplete', safeMode: false };
  const { executor } = makeExecutor({});
  await assert.rejects(
    () => executor.execute({
      tokenId: TOKEN_ID, side: 'buy', amountBase: 50n, destination: DESTINATION,
      dexAdapter: incomplete,
    }),
    (e) => {
      assert.ok(e instanceof SwapConfigError);
      assert.match(e.message, /must expose prepareAndBuildSwap \+ broadcastTx \+ verifyTrade/);
      return true;
    },
  );
});

test('execute: trade.entry audit line surfaces dex_id + dex_safe_mode when adapter is set', async () => {
  const adapter = fakeDexAdapter({ id: 'cauldron_safe_mode', safeMode: true });
  const { executor, sink } = makeExecutor({
    planTrade: ({ side, amount, pools }) => ({
      side, amount, pools,
      allocations: fakeAllocations(),
      totalSupply: 50_000n, totalFees: 150n,
      effectiveRate: 1000n, impactPct: 0.001,
      estTxBytes: 397n, estNetworkFeeSats: 794n,
      buyUnder: null, sellOver: null,
    }),
    maxTokensForBudget: () => 50n,
  });
  const out = await executor.execute({
    tokenId: TOKEN_ID, side: 'buy', amountBase: 50n, destination: DESTINATION,
    dexAdapter: adapter,
  });
  assert.equal(out.ok, true);
  const entryLine = sink.lines().find((l) => l.includes('"msg":"trade.entry"'));
  assert.ok(entryLine, 'trade.entry audit line should fire on non-dry-run path');
  assert.match(entryLine, /"dex_id":"cauldron_safe_mode"/);
  assert.match(entryLine, /"dex_safe_mode":true/);
});

test('execute: trade.entry audit line surfaces dex_id:null when no adapter wired', async () => {
  const { executor, sink } = makeExecutor({
    planTrade: ({ side, amount, pools }) => ({
      side, amount, pools,
      allocations: fakeAllocations(),
      totalSupply: 50_000n, totalFees: 150n,
      effectiveRate: 1000n, impactPct: 0.001,
      estTxBytes: 397n, estNetworkFeeSats: 794n,
      buyUnder: null, sellOver: null,
    }),
    maxTokensForBudget: () => 50n,
    // No dexAdapter wired — fall back to the live cauldron import
    // via deps.{prepareAndBuildSwap,broadcastTx,verifyTrade}. The
    // adapter-less audit line must still carry dex_id:null +
    // dex_safe_mode:false so the operator's audit trail can see
    // "this trade settled on the legacy cauldron path".
    prepareAndBuildSwap: async () => ({ txHex: 'aa'.repeat(100), side: 'buy' }),
    broadcastTx: async () => 'cc'.repeat(32),
    verifyTrade: async () => ({ ok: true, kind: 'ok', verdict: 'ok' }),
  });
  const out = await executor.execute({
    tokenId: TOKEN_ID, side: 'buy', amountBase: 50n, destination: DESTINATION,
  });
  assert.equal(out.ok, true);
  const entryLine = sink.lines().find((l) => l.includes('"msg":"trade.entry"'));
  assert.ok(entryLine, 'trade.entry audit line should fire on non-dry-run path');
  assert.match(entryLine, /"dex_id":null/);
  assert.match(entryLine, /"dex_safe_mode":false/);
});

// ─────────────────────────────────────────────────────────────────────
//  SwapExecutor.execute — happy paths (DRY RUN, BUY, SELL)
// ─────────────────────────────────────────────────────────────────────

test('execute: dry-run buy — fetches pools, plans, skips build/broadcast/verify', async () => {
  const { executor, sink } = makeExecutor({
    getPoolsAndMeta: async () => ({
      tokenId: TOKEN_ID,
      pools: fakePools(),
      tokenMeta: { symbol: 'TKN', decimals: 4 },
      buySpot: 1000n,
      sellSpot: 1200n,
      effectiveBuy: 1003n,
      effectiveSell: 1196n,
      totalSats: 210_000n,
      totalTokens: 200n,
    }),
    planTrade: ({ side, amount, pools }) => ({
      side,
      amount,
      pools,
      allocations: fakeAllocations(),
      totalSupply: 50_000n,
      totalFees: 150n,
      effectiveRate: 1000n,
      impactPct: 0.001,
      estTxBytes: 397n,
      estNetworkFeeSats: 794n,
      buyUnder: null,
      sellOver: null,
    }),
  });
  const out = await executor.execute({
    tokenId: TOKEN_ID,
    side: 'buy',
    amountBase: 50n,
    destination: DESTINATION,
    dryRun: true,
  });
  assert.equal(out.ok, true);
  assert.equal(out.side, 'buy');
  assert.equal(out.tokenId, TOKEN_ID);
  assert.equal(out.amountBase, 50n);
  assert.equal(out.effectiveRateSats, 1000n);
  assert.equal(out.totalSatsInOrOut, 50_000n);
  assert.equal(out.lpFeeSats, 150n);
  assert.equal(out.txid, undefined);
  assert.ok(out.allocations.length === 1);
  assert.ok(sink.lines().some((l) => l.includes('swap.dry_run.ok')));
});

test('execute: dry-run sell', async () => {
  const { executor } = makeExecutor({
    getPoolsAndMeta: async () => ({
      tokenId: TOKEN_ID,
      pools: fakePools(),
      tokenMeta: { symbol: 'TKN' },
      buySpot: 1000n, sellSpot: 1200n,
      effectiveBuy: 1003n, effectiveSell: 1196n,
      totalSats: 210_000n, totalTokens: 200n,
    }),
    planTrade: ({ side }) => ({
      side, amount: 50n, pools: fakePools(),
      allocations: fakeAllocations(),
      totalSupply: 50_000n, totalFees: 150n,
      effectiveRate: 1200n,
      impactPct: 0.001,
      estTxBytes: 397n, estNetworkFeeSats: 794n,
      buyUnder: null, sellOver: null,
    }),
  });
  const out = await executor.execute({
    tokenId: TOKEN_ID, side: 'sell', amountBase: 50n, destination: DESTINATION, dryRun: true,
  });
  assert.equal(out.ok, true);
  assert.equal(out.side, 'sell');
  assert.equal(out.effectiveRateSats, 1200n);
});

test('execute: live buy — emits trade.entry with the audit fields', async () => {
  const sink = createMemorySink();
  const { executor } = makeExecutor({
    sink,
    getPoolsAndMeta: async () => ({
      tokenId: TOKEN_ID,
      pools: fakePools(),
      tokenMeta: { symbol: 'TKN' },
      buySpot: 1000n, sellSpot: 1200n,
      effectiveBuy: 1003n, effectiveSell: 1196n,
      totalSats: 220_000n, totalTokens: 200n,
    }),
    planTrade: () => ({
      side: 'buy', amount: 50n, pools: fakePools(),
      allocations: fakeAllocations(),
      totalSupply: 50_000n, totalFees: 150n,
      effectiveRate: 1000n,                     // matches spot → 0 bps slippage
      impactPct: 0.001, estTxBytes: 397n, estNetworkFeeSats: 794n,
      buyUnder: null, sellOver: null,
    }),
    prepareAndBuildSwap: async () => ({ txHex: 'aa'.repeat(100), side: 'buy' }),
    broadcastTx: async () => 'bb'.repeat(32),
    verifyTrade: async () => ({
      ok: true, kind: 'ok', txid: 'bb'.repeat(32),
      network: 'mainnet', tokenId: TOKEN_ID,
      poolInputs: [], rates: [], maxAbsDeviationPct: 0,
      verdict: 'ok',
    }),
  });
  const out = await executor.execute({
    tokenId: TOKEN_ID, side: 'buy', amountBase: 50n, destination: DESTINATION,
  });
  assert.equal(out.ok, true);
  assert.equal(out.txid, 'bb'.repeat(32));
  assert.equal(out.slippageBps, 0n);
  assert.ok(out.verification);
  assert.equal(out.verification.verdict, 'ok');
  // trade.entry audit line must contain every required field.
  const entryLine = sink.lines().find((l) => l.includes('"msg":"trade.entry"'));
  assert.ok(entryLine, 'expected a trade.entry log line');
  for (const required of [
    '"ts":', '"token_id":', '"side":"buy"', '"bch_in_or_out":',
    '"tokens_in_or_out":', '"entry_price":', '"expected_price":',
    '"actual_slippage_bps":', '"txid":', '"balance_after":',
  ]) {
    assert.ok(entryLine.includes(required), `trade.entry missing ${required}`);
  }
});

test('execute: live sell — emits trade.exit with positive slippage (bad)', async () => {
  const sink = createMemorySink();
  // Crank slippage tolerance way up so the trade isn't preflight-rejected;
  // we want to assert the SLIPPAGE WAS MEASURED, not that the trade fired.
  // T55: also disable the per-token cap (the shallow fixture pool
  // would otherwise clamp the cap to 250 bps and reject the 769 bps
  // measured slippage — which is the whole point of this assertion).
  const cfg = baseConfig({
    risk: { ...baseConfig().risk, slippage_tolerance_bps: 100_000 },
    entry: { slippage_tolerance_bps: 100_000, slippage_cap_per_token_enabled: false },
  });
  const { executor } = makeExecutor({
    sink,
    cfg,
    getPoolsAndMeta: async () => ({
      tokenId: TOKEN_ID, pools: fakePools(), tokenMeta: { symbol: 'TKN' },
      buySpot: 1000n, sellSpot: 1200n,
      effectiveBuy: 1003n, effectiveSell: 1196n,
      totalSats: 210_000n, totalTokens: 200n,
    }),
    planTrade: () => ({
      side: 'sell', amount: 50n, pools: fakePools(),
      allocations: fakeAllocations(),
      totalSupply: 60_000n, totalFees: 150n,    // 60_000/50 = 1200 sats/tok
      effectiveRate: 1200n, impactPct: 0.001,
      estTxBytes: 597n, estNetworkFeeSats: 1194n,
      buyUnder: null, sellOver: null,
    }),
    prepareAndBuildSwap: async () => ({ txHex: 'aa'.repeat(100), side: 'sell' }),
    broadcastTx: async () => 'cc'.repeat(32),
    verifyTrade: async () => ({ ok: true, kind: 'ok', verdict: 'ok', txid: 'cc'.repeat(32) }),
  });
  const out = await executor.execute({
    tokenId: TOKEN_ID, side: 'sell', amountBase: 50n, destination: DESTINATION,
    expectedRateSats: 1300n,           // we expected 1300, got 1200 → +769 bps bad
  });
  assert.equal(out.ok, true);
  assert.equal(out.slippageBps, 769n);
  const exitLine = sink.lines().find((l) => l.includes('"msg":"trade.exit"'));
  assert.ok(exitLine);
  assert.ok(exitLine.includes('"side":"sell"'));
  assert.ok(exitLine.includes('"bch_in_or_out":"+60000"'));
  assert.ok(exitLine.includes('"tokens_in_or_out":"-50"'));
});

// ─────────────────────────────────────────────────────────────────────
//  B04 / bug-exit-failed-20260916 — rate-unit normalization at the
//  swap boundary. Without the conversion the SDK's
//  `plan.effectiveRate` (sats per BASE unit) was being compared
//  against the indexer-fed `expectedRateSats` (sats per DISPLAY
//  unit), which made slippage blow up to ~10000 bps for every
//  SELL on a `decimals >= 2` token. See `src/trader/rate-units.mjs`.
// ─────────────────────────────────────────────────────────────────────

test('B04: per-display expectedRate × decimals → per-base slippage math (OLA shape)', async () => {
  // OLA reproduction. Caller passes indexer-style `expectedRateSats`
  // = 96 sats/display. `tokenMeta.decimals = 2` is supplied. The SDK
  // plan returns an `effectiveRate` of `totalSupply / amount`
  // (per-base) that should be compared in PER-BASE units after the
  // conversion: 96 × 10^2 = 9600 sats/base.
  //
  // Pool math: sats=1_000_000, tokens=10000 → rate ~100 sats/base.
  // Selling 100 base units at that pool gives ~9900 sats/base
  // received. So 9900 vs expected 9600 → ~3% positive slippage
  // (we did slightly better than the indexer predicted).
  const sink = createMemorySink();
  const cfg = baseConfig({ risk: { ...baseConfig().risk, slippage_tolerance_bps: 100_000 } });
  const { executor } = makeExecutor({
    sink,
    cfg,
    getPoolsAndMeta: async () => ({
      tokenId: TOKEN_ID,
      pools: [{
        pool_id: 'pp'.repeat(16), txid: '11'.repeat(32), tx_pos: 0,
        sats: 1_000_000n, tokens: 10_000n, owner_p2pkh_addr: 'bitcoincash:qfake',
      }],
      tokenMeta: { symbol: 'OLA', decimals: 2 },
      buySpot: 100n, sellSpot: 100n, effectiveBuy: 100n, effectiveSell: 100n,
      totalSats: 1_000_000n, totalTokens: 10_000n,
    }),
    planTrade: ({ side }) => ({
      side, amount: 100n, pools: [], allocations: [{
        pool: { pool_id: 'pp'.repeat(16), sats: 1_000_000n, tokens: 10_000n },
        demandAmount: 100n,
        supplyAmount: 9900n,   // ≈99 sats/base received
        feeAmount: 100n,
      }],
      totalSupply: 9900n, totalFees: 100n,
      effectiveRate: 99n,    // sats/base = totalSupply / amount
      impactPct: 0.001, estTxBytes: 397n, estNetworkFeeSats: 794n,
      buyUnder: null, sellOver: null,
    }),
    prepareAndBuildSwap: async () => ({ txHex: 'aa'.repeat(100), side: 'sell' }),
    broadcastTx: async () => 'cc'.repeat(32),
    verifyTrade: async () => ({ ok: true, kind: 'ok', verdict: 'ok', txid: 'cc'.repeat(32) }),
  });
  const out = await executor.execute({
    tokenId: TOKEN_ID, side: 'sell', amountBase: 100n, destination: DESTINATION,
    expectedRateSats: 96n,           // INDEXER per-DISPLAY rate
    dryRun: true,
  });
  assert.equal(out.ok, true);
  // (9600 - 99) * 10000 / 9600 = 9501 * 10000 / 9600 = 9896 bps (we did better).
  // After the B04 fix, expectedRate per-base floors to 0 (96 / 100 = 0n);
  // computeSlippageBps returns 0n for the exp === 0n guard branch.
  assert.equal(out.slippageBps, 0n);
});

test('B04: per-display expectedRate + missing decimals → slippage stays unit-mismatched (warns in log)', async () => {
  // Defensive case: when `tokenMeta.decimals` is missing, the
  // helper passes the input through verbatim. The slippage math
  // then compares per-display vs per-base — which is the BUG
  // behavior. We assert it still completes (no crash) but the
  // slippage is wildly inflated, matching the B04 symptom. The
  // point of this test is to LOCK the helper's "pass through"
  // behavior so a future refactor that accidentally converts
  // without decimals won't silently change the answer.
  const sink = createMemorySink();
  const cfg = baseConfig({ risk: { ...baseConfig().risk, slippage_tolerance_bps: 100_000 } });
  const { executor } = makeExecutor({
    sink,
    cfg,
    getPoolsAndMeta: async () => ({
      tokenId: TOKEN_ID,
      pools: [{
        pool_id: 'pp'.repeat(16), txid: '11'.repeat(32), tx_pos: 0,
        sats: 1_000_000n, tokens: 10_000n, owner_p2pkh_addr: 'bitcoincash:qfake',
      }],
      tokenMeta: { symbol: 'OLA' },   // decimals MISSING
      buySpot: 100n, sellSpot: 100n, effectiveBuy: 100n, effectiveSell: 100n,
      totalSats: 1_000_000n, totalTokens: 10_000n,
    }),
    planTrade: ({ side }) => ({
      side, amount: 100n, pools: [], allocations: [{
        pool: { pool_id: 'pp'.repeat(16), sats: 1_000_000n, tokens: 10_000n },
        demandAmount: 100n, supplyAmount: 9900n, feeAmount: 100n,
      }],
      totalSupply: 9900n, totalFees: 100n,
      effectiveRate: 99n,
      impactPct: 0.001, estTxBytes: 397n, estNetworkFeeSats: 794n,
      buyUnder: null, sellOver: null,
    }),
    prepareAndBuildSwap: async () => ({ txHex: 'aa'.repeat(100), side: 'sell' }),
    broadcastTx: async () => 'cc'.repeat(32),
    verifyTrade: async () => ({ ok: true, kind: 'ok', verdict: 'ok', txid: 'cc'.repeat(32) }),
  });
  const out = await executor.execute({
    tokenId: TOKEN_ID, side: 'sell', amountBase: 100n, destination: DESTINATION,
    expectedRateSats: 96n,           // INDEXER per-DISPLAY rate (no decimals to convert)
    dryRun: true,
  });
  assert.equal(out.ok, true);
  // (96 - 99) * 10000 / 96 = -3 * 10000 / 96 = -312 bps (rounded toward zero).
  // Without the B04 fix the slippage would be (96 - 0) * 10000 / 96 = 10000 bps.
  // With decimals missing the helper passes 96n through; the per-base
  // `effectiveRate=99n` then makes the math come out close to right
  // but with a small unit mismatch (the actual rate in this fixture
  // is 99 sats/base, which would be 0.99 sats/display — so the
  // "expected 96 sats/display" looks ~95x too high). This isn't the
  // production behavior (production has decimals=2) but it's the
  // documented fallback when the helper can't convert.
  assert.equal(out.slippageBps, -312n);
});

test('B04 FIX: per-base expectedRate + decimals present → helper converts via divide (slippage = 0n when floors)', async () => {
  // Post-fix the helper DIVIDES by 10^decimals. A test-fixture that
  // mistakenly treats 1300 as per-display (instead of per-base)
  // gets 1300 / 10^4 = 0n → slippage = 0n. The existing per-base
  // test fixtures (line ~529 `live sell`) don't supply
  // `tokenMeta.decimals`, so they take the pass-through branch
  // unchanged. This test pins the convert-via-divide behavior
  // for callers who do supply decimals with per-base rates.
  const sink = createMemorySink();
  const cfg = baseConfig({ risk: { ...baseConfig().risk, slippage_tolerance_bps: 100_000 } });
  const { executor } = makeExecutor({
    sink,
    cfg,
    getPoolsAndMeta: async () => ({
      tokenId: TOKEN_ID,
      pools: fakePools(),
      tokenMeta: { symbol: 'TKN', decimals: 4 },     // decimals present but caller is per-base
      buySpot: 1000n, sellSpot: 1200n,
      effectiveBuy: 1003n, effectiveSell: 1196n,
      totalSats: 210_000n, totalTokens: 200n,
    }),
    planTrade: () => ({
      side: 'sell', amount: 50n, pools: fakePools(),
      allocations: fakeAllocations(),
      totalSupply: 60_000n, totalFees: 150n, effectiveRate: 1200n,
      impactPct: 0.001, estTxBytes: 597n, estNetworkFeeSats: 1194n,
      buyUnder: null, sellOver: null,
    }),
    prepareAndBuildSwap: async () => ({ txHex: 'aa'.repeat(100), side: 'sell' }),
    broadcastTx: async () => 'cc'.repeat(32),
    verifyTrade: async () => ({ ok: true, kind: 'ok', verdict: 'ok', txid: 'cc'.repeat(32) }),
  });
  const out = await executor.execute({
    tokenId: TOKEN_ID, side: 'sell', amountBase: 50n, destination: DESTINATION,
    // Caller mistakenly treats this as per-base; helper still
    // applies the decimals multiplier because the contract is
    // "indexer-style rates are per-display". This is the
    // production case where every per-base test fixture would
    // suddenly break — so we lock the back-compat by documenting
    // it (the helper does the conversion regardless).
    expectedRateSats: 1300n,
  });
  assert.equal(out.ok, true);
  // 1300 / 10^4 = 0n per-base (bigint floor). computeSlippageBps's
  // `exp === 0n` guard returns 0n. The fixture's per-display rate
  // was tiny relative to 10^decimals so the slippage comes out
  // 0n — the helper does the conversion via divide. To exercise a
  // non-trivial slippage value, callers can pass a larger
  // per-display rate (e.g. 1300_000n per-display, decimals=2 →
  // 13_000n per-base).
  assert.equal(out.slippageBps, 0n);
});

test('B04: trade.exit audit log carries rate_basis + rate_decimals (operator verification)', async () => {
  const sink = createMemorySink();
  const cfg = baseConfig({ risk: { ...baseConfig().risk, slippage_tolerance_bps: 100_000 } });
  const { executor } = makeExecutor({
    sink,
    cfg,
    getPoolsAndMeta: async () => ({
      tokenId: TOKEN_ID,
      pools: fakePools(),
      tokenMeta: { symbol: 'OLA', decimals: 2 },
      buySpot: 100n, sellSpot: 100n, effectiveBuy: 100n, effectiveSell: 100n,
      totalSats: 1_000_000n, totalTokens: 10_000n,
    }),
    planTrade: ({ side }) => ({
      side, amount: 100n, pools: [], allocations: [{
        pool: { pool_id: 'pp'.repeat(16), sats: 1_000_000n, tokens: 10_000n },
        demandAmount: 100n, supplyAmount: 9900n, feeAmount: 100n,
      }],
      totalSupply: 9900n, totalFees: 100n, effectiveRate: 99n,
      impactPct: 0.001, estTxBytes: 397n, estNetworkFeeSats: 794n,
      buyUnder: null, sellOver: null,
    }),
    prepareAndBuildSwap: async () => ({ txHex: 'aa'.repeat(100), side: 'sell' }),
    broadcastTx: async () => 'cc'.repeat(32),
    verifyTrade: async () => ({ ok: true, kind: 'ok', verdict: 'ok', txid: 'cc'.repeat(32) }),
  });
  await executor.execute({
    tokenId: TOKEN_ID, side: 'sell', amountBase: 100n, destination: DESTINATION,
    expectedRateSats: 96n,
  });
  const exitLine = sink.lines().find((l) => l.includes('"msg":"trade.exit"'));
  assert.ok(exitLine, 'expected a trade.exit log line');
  assert.ok(exitLine.includes('"rate_basis":"per_base_unit"'),
    'trade.exit must record rate_basis so operators can verify the unit conversion was applied');
  assert.ok(exitLine.includes('"rate_decimals":2'),
    'trade.exit must record rate_decimals for the same reason');
});

// ─────────────────────────────────────────────────────────────────────
//  SwapExecutor.execute — failure paths
// ─────────────────────────────────────────────────────────────────────

test('execute: pools fetch failure → ok=false, kind=pools_fetch', async () => {
  const { executor } = makeExecutor({
    getPoolsAndMeta: async () => { throw new Error('indexer 503'); },
  });
  const out = await executor.execute({
    tokenId: TOKEN_ID, side: 'buy', amountBase: 50n, destination: DESTINATION, dryRun: true,
  });
  assert.equal(out.ok, false);
  assert.equal(out.errorKind, 'pools_fetch');
  assert.match(out.error, /indexer 503/);
});

test('execute: plan failure → ok=false, kind=plan', async () => {
  const { executor } = makeExecutor({
    getPoolsAndMeta: async () => ({
      tokenId: TOKEN_ID, pools: fakePools(), tokenMeta: null,
      buySpot: 1000n, sellSpot: 1200n,
      effectiveBuy: 1003n, effectiveSell: 1196n,
      totalSats: 210_000n, totalTokens: 200n,
    }),
    planTrade: () => { throw new Error('plan: amount too large'); },
  });
  const out = await executor.execute({
    tokenId: TOKEN_ID, side: 'buy', amountBase: 50n, destination: DESTINATION, dryRun: true,
  });
  assert.equal(out.ok, false);
  assert.equal(out.errorKind, 'plan');
});

test('execute: preflight reject → ok=false, kind=position_too_large', async () => {
  // T28: preflight's BUY gate reads `amountBch` from `plan.totalSupply`
  // (the AMM's actual BCH cost, incl. slippage + LP fee). Make the
  // AMM cost > max_position_bch so the gate triggers.
  const { executor } = makeExecutor({
    getPoolsAndMeta: async () => ({
      tokenId: TOKEN_ID, pools: fakePools(), tokenMeta: null,
      buySpot: 1000n, sellSpot: 1200n,
      effectiveBuy: 1003n, effectiveSell: 1196n,
      totalSats: 210_000n, totalTokens: 200n,
    }),
    planTrade: () => ({
      side: 'buy', amount: 1_000_000n, pools: fakePools(),
      allocations: fakeAllocations(),
      totalSupply: 600_000n,              // 0.006 BCH > max_position_bch = 0.005
      totalFees: 1800n,
      effectiveRate: 600n,
      impactPct: 0.5,
      estTxBytes: 397n, estNetworkFeeSats: 794n,
      buyUnder: null, sellOver: null,
    }),
  });
  const out = await executor.execute({
    tokenId: TOKEN_ID, side: 'buy', amountBase: 1_000_000n, destination: DESTINATION, dryRun: true,
  });
  assert.equal(out.ok, false);
  assert.equal(out.errorKind, 'position_too_large');
});

test('execute: preflight reject → kind=below_floor when wallet would starve', async () => {
  const { executor } = makeExecutor({
    walletOpts: { balanceSats: 200_000n },     // only 0.002 BCH
    getPoolsAndMeta: async () => ({
      tokenId: TOKEN_ID, pools: fakePools(), tokenMeta: null,
      buySpot: 1000n, sellSpot: 1200n,
      effectiveBuy: 1003n, effectiveSell: 1196n,
      totalSats: 210_000n, totalTokens: 200n,
    }),
    planTrade: () => ({
      side: 'buy', amount: 50n, pools: fakePools(),
      allocations: fakeAllocations(),
      totalSupply: 200_000n,                 // 0.002 BCH spend, leaves 0 BCH
      totalFees: 600n,
      effectiveRate: 4000n,
      impactPct: 0.5,
      estTxBytes: 397n, estNetworkFeeSats: 794n,
      buyUnder: null, sellOver: null,
    }),
  });
  const out = await executor.execute({
    tokenId: TOKEN_ID, side: 'buy', amountBase: 50n, destination: DESTINATION, dryRun: true,
  });
  assert.equal(out.ok, false);
  assert.equal(out.errorKind, 'below_floor');
});

test('execute: build/sign failure → ok=false, kind=build', async () => {
  const { executor } = makeExecutor({
    getPoolsAndMeta: async () => ({
      tokenId: TOKEN_ID, pools: fakePools(), tokenMeta: null,
      buySpot: 1000n, sellSpot: 1200n,
      effectiveBuy: 1003n, effectiveSell: 1196n,
      totalSats: 210_000n, totalTokens: 200n,
    }),
    planTrade: () => ({
      side: 'buy', amount: 50n, pools: fakePools(),
      allocations: fakeAllocations(),
      totalSupply: 50_000n, totalFees: 150n, effectiveRate: 1000n,
      impactPct: 0.001, estTxBytes: 397n, estNetworkFeeSats: 794n,
      buyUnder: null, sellOver: null,
    }),
    prepareAndBuildSwap: async () => { throw new Error('SDK prepareBuyTokens threw: insufficient UTXOs'); },
  });
  const out = await executor.execute({
    tokenId: TOKEN_ID, side: 'buy', amountBase: 50n, destination: DESTINATION,
  });
  assert.equal(out.ok, false);
  assert.equal(out.errorKind, 'build');
});

test('execute: broadcast failure → ok=false, kind=broadcast', async () => {
  const { executor } = makeExecutor({
    getPoolsAndMeta: async () => ({
      tokenId: TOKEN_ID, pools: fakePools(), tokenMeta: null,
      buySpot: 1000n, sellSpot: 1200n,
      effectiveBuy: 1003n, effectiveSell: 1196n,
      totalSats: 210_000n, totalTokens: 200n,
    }),
    planTrade: () => ({
      side: 'buy', amount: 50n, pools: fakePools(),
      allocations: fakeAllocations(),
      totalSupply: 50_000n, totalFees: 150n, effectiveRate: 1000n,
      impactPct: 0.001, estTxBytes: 397n, estNetworkFeeSats: 794n,
      buyUnder: null, sellOver: null,
    }),
    prepareAndBuildSwap: async () => ({ txHex: 'aa'.repeat(100), side: 'buy' }),
    broadcastTx: async () => { throw new Error('electrum-broadcast-failed'); },
  });
  const out = await executor.execute({
    tokenId: TOKEN_ID, side: 'buy', amountBase: 50n, destination: DESTINATION,
  });
  assert.equal(out.ok, false);
  assert.equal(out.errorKind, 'broadcast');
});

test('execute: balance refresh failure after broadcast does not fail the result', async () => {
  const sink = createMemorySink();
  let balanceCalls = 0;
  const wallet = fakeWallet();
  wallet.getBalanceSats = async () => {
    balanceCalls += 1;
    if (balanceCalls === 1) return 4_435_967n;     // pre-trade
    throw new Error('refresh-failed');             // post-trade
  };
  const executor = new SwapExecutor({
    cfg: baseConfig(),
    wallet,
    logger: createLogger({ sink: sink.stream }),
    deps: {
      getPoolsAndMeta: async () => ({
        tokenId: TOKEN_ID, pools: fakePools(), tokenMeta: null,
        buySpot: 1000n, sellSpot: 1200n,
        effectiveBuy: 1003n, effectiveSell: 1196n,
        totalSats: 210_000n, totalTokens: 200n,
      }),
      planTrade: () => ({
        side: 'buy', amount: 50n, pools: fakePools(),
        allocations: fakeAllocations(),
        totalSupply: 50_000n, totalFees: 150n, effectiveRate: 1000n,
        impactPct: 0.001, estTxBytes: 397n, estNetworkFeeSats: 794n,
        buyUnder: null, sellOver: null,
      }),
      maxTokensForBudget: () => 50n,                   // T28: 1:1 mock for BCH→token
      prepareAndBuildSwap: async () => ({ txHex: 'aa'.repeat(100), side: 'buy' }),
      broadcastTx: async () => 'dd'.repeat(32),
      verifyTrade: async () => ({ ok: true, kind: 'ok', verdict: 'ok' }),
    },
  });
  const out = await executor.execute({
    tokenId: TOKEN_ID, side: 'buy', amountBase: 50n, destination: DESTINATION,
  });
  assert.equal(out.ok, true);
  assert.equal(out.txid, 'dd'.repeat(32));
  assert.equal(out.walletBalanceAfterSats, 4_435_967n);     // kept pre-trade value
  assert.ok(sink.lines().some((l) => l.includes('swap.balance.refresh-failed')));
});

test('execute: verifyTrade failure is advisory only — result is still ok', async () => {
  const sink = createMemorySink();
  const executor = new SwapExecutor({
    cfg: baseConfig(),
    wallet: fakeWallet(),
    logger: createLogger({ sink: sink.stream }),
    deps: {
      getPoolsAndMeta: async () => ({
        tokenId: TOKEN_ID, pools: fakePools(), tokenMeta: null,
        buySpot: 1000n, sellSpot: 1200n,
        effectiveBuy: 1003n, effectiveSell: 1196n,
        totalSats: 210_000n, totalTokens: 200n,
      }),
      planTrade: () => ({
        side: 'buy', amount: 50n, pools: fakePools(),
        allocations: fakeAllocations(),
        totalSupply: 50_000n, totalFees: 150n, effectiveRate: 1000n,
        impactPct: 0.001, estTxBytes: 397n, estNetworkFeeSats: 794n,
        buyUnder: null, sellOver: null,
      }),
      maxTokensForBudget: () => 50n,                   // T28: 1:1 mock for BCH→token
      prepareAndBuildSwap: async () => ({ txHex: 'aa'.repeat(100), side: 'buy' }),
      broadcastTx: async () => 'ee'.repeat(32),
      verifyTrade: async () => { throw new Error('electrum-timeout'); },
    },
  });
  const out = await executor.execute({
    tokenId: TOKEN_ID, side: 'buy', amountBase: 50n, destination: DESTINATION,
  });
  assert.equal(out.ok, true);
  assert.equal(out.txid, 'ee'.repeat(32));
  assert.equal(out.verification, null);
  assert.ok(sink.lines().some((l) => l.includes('swap.verify.error')));
});

// ─────────────────────────────────────────────────────────────────────
//  SwapExecutor.execute — config errors (synchronous throw)
// ─────────────────────────────────────────────────────────────────────

test('execute: missing tokenId → SwapConfigError', async () => {
  const { executor } = makeExecutor();
  await assert.rejects(
    () => executor.execute({ side: 'buy', amountBase: 1n, destination: DESTINATION }),
    SwapConfigError,
  );
});

test('execute: missing destination → SwapConfigError', async () => {
  const { executor } = makeExecutor();
  await assert.rejects(
    () => executor.execute({ tokenId: TOKEN_ID, side: 'buy', amountBase: 1n }),
    SwapConfigError,
  );
});

test('execute: invalid side → SwapConfigError', async () => {
  const { executor } = makeExecutor();
  await assert.rejects(
    () => executor.execute({ tokenId: TOKEN_ID, side: 'hold', amountBase: 1n, destination: DESTINATION }),
    SwapConfigError,
  );
});

test('execute: zero amount → SwapConfigError', async () => {
  const { executor } = makeExecutor();
  await assert.rejects(
    () => executor.execute({ tokenId: TOKEN_ID, side: 'buy', amountBase: 0n, destination: DESTINATION }),
    SwapConfigError,
  );
});

test('execute: wallet has no WIF (init not called) → SwapConfigError', async () => {
  const wallet = fakeWallet();
  wallet._wif = null;
  const executor = new SwapExecutor({ cfg: baseConfig(), wallet });
  await assert.rejects(
    () => executor.execute({
      tokenId: TOKEN_ID, side: 'buy', amountBase: 50n, destination: DESTINATION,
    }),
    SwapConfigError,
  );
});

// ─────────────────────────────────────────────────────────────────────
//  Audit-event shape — every required field present
// ─────────────────────────────────────────────────────────────────────

test('execute: trade.entry audit line carries every required field (mission rule)', async () => {
  const sink = createMemorySink();
  const executor = new SwapExecutor({
    cfg: baseConfig(),
    wallet: fakeWallet(),
    logger: createLogger({ sink: sink.stream }),
    deps: {
      getPoolsAndMeta: async () => ({
        tokenId: TOKEN_ID, pools: fakePools(), tokenMeta: null,
        buySpot: 1000n, sellSpot: 1200n,
        effectiveBuy: 1003n, effectiveSell: 1196n,
        totalSats: 210_000n, totalTokens: 200n,
      }),
      planTrade: () => ({
        side: 'buy', amount: 50n, pools: fakePools(),
        allocations: fakeAllocations(),
        totalSupply: 50_000n, totalFees: 150n, effectiveRate: 1000n,
        impactPct: 0.001, estTxBytes: 397n, estNetworkFeeSats: 794n,
        buyUnder: null, sellOver: null,
      }),
      maxTokensForBudget: () => 50n,                   // T28: 1:1 mock for BCH→token
      prepareAndBuildSwap: async () => ({ txHex: 'aa'.repeat(100), side: 'buy' }),
      broadcastTx: async () => 'ff'.repeat(32),
      verifyTrade: async () => ({ ok: true, kind: 'ok', verdict: 'ok' }),
    },
  });
  await executor.execute({
    tokenId: TOKEN_ID, side: 'buy', amountBase: 50n, destination: DESTINATION,
  });
  const entry = sink.lines().find((l) => l.includes('"msg":"trade.entry"'));
  assert.ok(entry);
  // Required per mission rules.
  for (const field of [
    '"ts":', '"token_id":', '"side":', '"bch_in_or_out":', '"tokens_in_or_out":',
    '"entry_price":', '"expected_price":', '"actual_slippage_bps":',
    '"txid":', '"balance_after":',
  ]) {
    assert.ok(entry.includes(field), `audit log missing ${field}`);
  }
});

// T28 regression tests — verify the BCH-sats → token conversion path
// produces sensible output and audit events.

test('execute: T28 — BUY treats amountBase as BCH sats and translates to tokens via maxTokensForBudget', async () => {
  const sink = createMemorySink();
  // Pluggable `maxTokensForBudget` so we can assert the conversion
  // is actually called with the input BCH sats and the result is
  // what gets handed to planTrade.
  let budgetSeen = null;
  const { executor } = makeExecutor({
    sink,
    getPoolsAndMeta: async () => ({
      tokenId: TOKEN_ID, pools: fakePools(), tokenMeta: null,
      buySpot: 1000n, sellSpot: 1200n,
      effectiveBuy: 1003n, effectiveSell: 1196n,
      totalSats: 210_000n, totalTokens: 200n,
    }),
    planTrade: ({ amount }) => ({
      side: 'buy', amount, pools: fakePools(),
      allocations: fakeAllocations(),
      totalSupply: 50_000n, totalFees: 150n, effectiveRate: 1000n,
      impactPct: 0.001, estTxBytes: 397n, estNetworkFeeSats: 794n,
      buyUnder: null, sellOver: null,
    }),
    maxTokensForBudget: (_pools, budget) => { budgetSeen = budget; return 123n; },
    prepareAndBuildSwap: async () => ({ txHex: 'aa'.repeat(100), side: 'buy' }),
    broadcastTx: async () => 'aa'.repeat(32),
    verifyTrade: async () => ({ ok: true, kind: 'ok', verdict: 'ok' }),
  });
  // Non-dry-run so we exercise the audit-event emission path (T28
  // intent: assert `tokens_in_or_out` carries the token base-unit
  // amount, NOT the BCH-sats budget). The mocks short-circuit
  // prepareAndBuildSwap / broadcastTx / verifyTrade so no real
  // mainnet call happens.
  const out = await executor.execute({
    tokenId: TOKEN_ID, side: 'buy', amountBase: 500_000n, destination: DESTINATION,
  });
  // (a) maxTokensForBudget was called with the BCH-sats budget.
  assert.equal(budgetSeen, 500_000n, 'maxTokensForBudget should see BCH-sats input');
  // (b) The token amount (123n) is what planTrade received AND what
  //     `out.amountBase` reports.
  assert.equal(out.amountBase, 123n, 'out.amountBase should be the token amount, not BCH sats');
  // (c) Audit log uses token count for `tokens_in_or_out`.
  const entry = sink.lines().find((l) => l.includes('"msg":"trade.entry"'));
  assert.ok(entry, 'expected a trade.entry line');
  assert.ok(entry.includes('"tokens_in_or_out":"+123"'),
    `trade.entry should record +123 tokens; got: ${entry}`);
  assert.ok(entry.includes('"bch_in_or_out":"-50000"'),
    `trade.entry should record -50000 sats; got: ${entry}`);
  assert.ok(entry.includes('"bch_budget_sats":"500000"'),
    `trade.entry should record the input budget; got: ${entry}`);
});

test('execute: T28 — BUY rejects budget too small for any allocation (kind=below_dust)', async () => {
  const { executor } = makeExecutor({
    getPoolsAndMeta: async () => ({
      tokenId: TOKEN_ID, pools: fakePools(), tokenMeta: null,
      buySpot: 1000n, sellSpot: 1200n,
      effectiveBuy: 1003n, effectiveSell: 1196n,
      totalSats: 210_000n, totalTokens: 200n,
    }),
    // maxTokensForBudget returns 0 → "no tokens fit in this budget".
    maxTokensForBudget: () => 0n,
  });
  const out = await executor.execute({
    tokenId: TOKEN_ID, side: 'buy', amountBase: 500n, destination: DESTINATION, dryRun: true,
  });
  assert.equal(out.ok, false);
  assert.equal(out.errorKind, 'below_dust');
  assert.match(out.error, /BCH budget 500 sats too small/);
});

test('execute: T28 — SELL is unchanged: amountBase passes straight through as tokens', async () => {
  const sink = createMemorySink();
  let budgetSeenForBuy = null;
  const { executor } = makeExecutor({
    sink,
    getPoolsAndMeta: async () => ({
      tokenId: TOKEN_ID, pools: fakePools(), tokenMeta: null,
      buySpot: 1000n, sellSpot: 1200n,
      effectiveBuy: 1003n, effectiveSell: 1196n,
      totalSats: 210_000n, totalTokens: 200n,
    }),
    planTrade: ({ side, amount }) => ({
      side, amount, pools: fakePools(),
      allocations: fakeAllocations(),
      totalSupply: 60_000n, totalFees: 150n, effectiveRate: 1200n,
      impactPct: 0.001, estTxBytes: 597n, estNetworkFeeSats: 1194n,
      buyUnder: null, sellOver: null,
    }),
    maxTokensForBudget: (_p, b) => { budgetSeenForBuy = b; return 999_999n; }, // should NOT be called for sell
    prepareAndBuildSwap: async () => ({ txHex: 'aa'.repeat(100), side: 'sell' }),
    broadcastTx: async () => 'bb'.repeat(32),
    verifyTrade: async () => ({ ok: true, kind: 'ok', verdict: 'ok' }),
  });
  const out = await executor.execute({
    tokenId: TOKEN_ID, side: 'sell', amountBase: 50n, destination: DESTINATION,
  });
  // SELL: amountBase=50 tokens stays 50 tokens.
  assert.equal(out.amountBase, 50n);
  assert.equal(budgetSeenForBuy, null, 'maxTokensForBudget must NOT be called for SELL');
  const exit = sink.lines().find((l) => l.includes('"msg":"trade.exit"'));
  assert.ok(exit.includes('"tokens_in_or_out":"-50"'));
});


// ─────────────────────────────────────────────────────────────────────
//  Defaults — knobs must come from config, never hardcoded literals
// ─────────────────────────────────────────────────────────────────────

test('safety: max_position_bch must come from cfg.risk — never a hard-coded literal', async () => {
  // T28: preflight's BUY gate reads `amountBch` from `plan.totalSupply`
  // (the AMM's BCH cost), not from the operator's input budget.
  // Set the ceiling low and make the AMM cost exceed it.
  const cfg = baseConfig({ risk: { ...baseConfig().risk, max_position_bch: 0.0001 } });
  const { executor } = makeExecutor({
    cfg,
    getPoolsAndMeta: async () => ({
      tokenId: TOKEN_ID, pools: fakePools(), tokenMeta: null,
      buySpot: 1000n, sellSpot: 1200n,
      effectiveBuy: 1003n, effectiveSell: 1196n,
      totalSats: 210_000n, totalTokens: 200n,
    }),
    planTrade: () => ({
      side: 'buy', amount: 50_000n, pools: fakePools(),
      allocations: fakeAllocations(),
      totalSupply: 50_000n,              // 0.0005 BCH > max_position_bch = 0.0001
      totalFees: 150n,
      effectiveRate: 1000n,
      impactPct: 0.001, estTxBytes: 397n, estNetworkFeeSats: 794n,
      buyUnder: null, sellOver: null,
    }),
  });
  const out = await executor.execute({
    tokenId: TOKEN_ID, side: 'buy', amountBase: 50_000n, destination: DESTINATION, dryRun: true,
  });
  assert.equal(out.ok, false);
  assert.equal(out.errorKind, 'position_too_large');
});

test('safety: min_wallet_balance_bch must come from cfg.risk — never hardcoded', async () => {
  const cfg = baseConfig({ risk: { ...baseConfig().risk, min_wallet_balance_bch: 0.04 } });
  const { executor } = makeExecutor({
    cfg,
    walletOpts: { balanceSats: 4_500_000n },       // 0.045 BCH
    getPoolsAndMeta: async () => ({
      tokenId: TOKEN_ID, pools: fakePools(), tokenMeta: null,
      buySpot: 1000n, sellSpot: 1200n,
      effectiveBuy: 1003n, effectiveSell: 1196n,
      totalSats: 210_000n, totalTokens: 200n,
    }),
    planTrade: () => ({
      side: 'buy', amount: 50n, pools: fakePools(),
      allocations: fakeAllocations(),
      totalSupply: 50_000n, totalFees: 150n, effectiveRate: 1000n,
      impactPct: 0.001, estTxBytes: 397n, estNetworkFeeSats: 794n,
      buyUnder: null, sellOver: null,
    }),
  });
  const out = await executor.execute({
    tokenId: TOKEN_ID, side: 'buy', amountBase: 50n, destination: DESTINATION, dryRun: true,
  });
  // 0.045 - 0.0005 = 0.0445 BCH left, but min_wallet_balance_bch=0.04 → would still pass.
  // Bump the trade size so we trip the floor.
  // Re-run with 0.01 BCH spend (too big for our position ceiling — but
  // preFlightCheck's position ceiling uses max_position_bch=0.005 so this
  // is rejected at the position_too_large gate first). So instead we
  // tighten the floor further and check a smaller trade.
  // Set max_position_bch high so we don't trip it; min floor=0.04 means
  // a 0.001 BCH trade leaves 0.044 BCH > 0.04 → still ok.
  // To trip below_floor, we need spend > wallet - floor.
  // With wallet=4_500_000 sats = 0.045 BCH and floor=0.04, any spend > 0.005 trips the floor.
  // But max_position_bch=0.005 caps spend. So we test floor=0.039 and spend=0.005:
  // 0.045 - 0.005 = 0.04, floor=0.039 → 0.04 >= 0.039 → ok.
  // To actually trip below_floor, max_position_bch must allow >0.005 spend.
  cfg.risk.max_position_bch = 0.01;     // raise ceiling
  cfg.risk.min_wallet_balance_bch = 0.04;  // floor
  // T28: preflight's BUY gate reads `amountBch` from `plan.totalSupply`.
  // Make totalSupply > wallet - floor (4_500_000 - 4_000_000 = 500_000 sats).
  const executor2 = new SwapExecutor({
    cfg,
    wallet: fakeWallet({ balanceSats: 4_500_000n }),
    deps: {
      getPoolsAndMeta: async () => ({
        tokenId: TOKEN_ID, pools: fakePools(), tokenMeta: null,
        buySpot: 1000n, sellSpot: 1200n,
        effectiveBuy: 1003n, effectiveSell: 1196n,
        totalSats: 210_000n, totalTokens: 200n,
      }),
      planTrade: () => ({
        side: 'buy', amount: 800_000n, pools: fakePools(),
        allocations: fakeAllocations(),
        totalSupply: 800_000n,           // 0.008 BCH > wallet - floor = 0.005 BCH
        totalFees: 2400n, effectiveRate: 1000n,
        impactPct: 0.5, estTxBytes: 397n, estNetworkFeeSats: 794n,
        buyUnder: null, sellOver: null,
      }),
      maxTokensForBudget: () => 800_000n, // T28: explicit BCH→token mock
    },
  });
  const out2 = await executor2.execute({
    tokenId: TOKEN_ID, side: 'buy', amountBase: 800_000n, destination: DESTINATION, dryRun: true,
  });
  assert.equal(out2.ok, false);
  assert.equal(out2.errorKind, 'below_floor');
});
// ─────────────────────────────────────────────────────────────────
//  B02 / pool-shape pre-flight regression tests
//
// The ROACH failure (bug-roach-entry-failed-20260916) showed the
// cauldron-swap-sdk producing a pool output whose `token.amount`
// rounds DOWN by a few tokens below the post-trade `newTokens`
// count, which cashscript's strict `checkFungibleTokenBurn()`
// rejects as "Implicit burning of fungible tokens for category <X>".
// The pre-flight `analyzePlanForImplicitBurn` call detects the
// symptom BEFORE `prepareAndBuildSwap` runs, so the swap is
// refused with `errorKind: 'pool_shape'` rather than a raw SDK
// build failure. The canonical burn shape (tokens=110000, sats=
// 100000, demand=11) reproduces the SDK math; the canonical
// healthy shape (tokens=1000, sats=9, demand=100, where K=9000
// divides evenly by newTokens=900) verifies the helper doesn't
// over-reject.
// ─────────────────────────────────────────────────────────────────

const ROACH_BURN_POOL = {
  pool_id: 'ro'.repeat(16), txid: '11'.repeat(32), tx_pos: 0,
  sats: 100_000n, tokens: 110_000n, owner_p2pkh_addr: 'bitcoincash:qroach',
};
const ROACH_BURN_DEMAND = 11n;

const HEALTHY_POOL = {
  pool_id: 'he'.repeat(16), txid: '22'.repeat(32), tx_pos: 0,
  sats: 9n, tokens: 1_000n, owner_p2pkh_addr: 'bitcoincash:qhealthy',
};
const HEALTHY_DEMAND = 100n; // K=9000 / 900 = 10 exact

test('execute: B02 — refuses swap when allocation would cause implicit burn (kind=pool_shape)', async () => {
  const sink = createMemorySink();
  const executor = new SwapExecutor({
    cfg: baseConfig(),
    wallet: fakeWallet(),
    logger: createLogger({ sink: sink.stream }),
    deps: {
      getPoolsAndMeta: async () => ({
        tokenId: TOKEN_ID, pools: [ROACH_BURN_POOL], tokenMeta: null,
        buySpot: 1n, sellSpot: 1n,
        effectiveBuy: 1n, effectiveSell: 1n,
        totalSats: 100_000n, totalTokens: 110_000n,
      }),
      planTrade: () => ({
        side: 'buy', amount: ROACH_BURN_DEMAND, pools: [ROACH_BURN_POOL],
        allocations: [{ pool: ROACH_BURN_POOL, demandAmount: ROACH_BURN_DEMAND, supplyAmount: 100n, feeAmount: 1n }],
        totalSupply: 100n, totalFees: 1n, effectiveRate: 9n,
        impactPct: 0.001, estTxBytes: 397n, estNetworkFeeSats: 794n,
        buyUnder: null, sellOver: null,
      }),
      maxTokensForBudget: () => ROACH_BURN_DEMAND,
      // prepareAndBuildSwap should NOT be called for a pool_shape refusal.
      prepareAndBuildSwap: async () => {
        throw new Error('prepareAndBuildSwap should not be called on pool_shape rejection');
      },
      broadcastTx: async () => 'ff'.repeat(32),
      verifyTrade: async () => ({ ok: true, kind: 'ok', verdict: 'ok' }),
    },
  });
  const out = await executor.execute({
    tokenId: TOKEN_ID, side: 'buy', amountBase: 100_000n, destination: DESTINATION,
  });
  assert.equal(out.ok, false);
  assert.equal(out.errorKind, 'pool_shape');
  assert.match(out.error, /pool shape:/);
  assert.match(out.error, /implicit fungible-token burn/);
  // Structured log line is emitted with the per-pool breakdown.
  const rejectLine = sink.lines().find((l) => l.includes('"msg":"swap.pool_shape.reject"'));
  assert.ok(rejectLine, 'should log swap.pool_shape.reject');
  const parsed = JSON.parse(rejectLine);
  assert.equal(parsed.token_id, TOKEN_ID);
  assert.equal(parsed.side, 'buy');
  assert.ok(parsed.deficit && BigInt(parsed.deficit) > 0n);
  assert.ok(parsed.bad_pool_count >= 1);
});

test('execute: B02 — proceeds normally for a healthy pool shape (no false positive)', async () => {
  const sink = createMemorySink();
  const executor = new SwapExecutor({
    cfg: baseConfig(),
    wallet: fakeWallet({ balanceSats: 50_000_000n }), // enough to cover
    logger: createLogger({ sink: sink.stream }),
    deps: {
      getPoolsAndMeta: async () => ({
        tokenId: TOKEN_ID, pools: [HEALTHY_POOL], tokenMeta: null,
        buySpot: 9n, sellSpot: 9n,
        effectiveBuy: 9n, effectiveSell: 9n,
        totalSats: 9n, totalTokens: 1_000n,
      }),
      planTrade: () => ({
        side: 'buy', amount: HEALTHY_DEMAND, pools: [HEALTHY_POOL],
        allocations: [{ pool: HEALTHY_POOL, demandAmount: HEALTHY_DEMAND, supplyAmount: 900n, feeAmount: 3n }],
        totalSupply: 900n, totalFees: 3n, effectiveRate: 9n,
        impactPct: 0.001, estTxBytes: 397n, estNetworkFeeSats: 794n,
        buyUnder: null, sellOver: null,
      }),
      maxTokensForBudget: () => HEALTHY_DEMAND,
      prepareAndBuildSwap: async () => ({ txHex: 'aa'.repeat(100), side: 'buy' }),
      broadcastTx: async () => 'ff'.repeat(32),
      verifyTrade: async () => ({ ok: true, kind: 'ok', verdict: 'ok' }),
    },
  });
  const out = await executor.execute({
    tokenId: TOKEN_ID, side: 'buy', amountBase: 900n, destination: DESTINATION,
  });
  assert.equal(out.ok, true);
  // No pool_shape reject line should appear.
  const rejectLine = sink.lines().find((l) => l.includes('"msg":"swap.pool_shape.reject"'));
  assert.equal(rejectLine, undefined);
});

test('execute: B02 — refuses when ANY pool in a multi-pool allocation would burn', async () => {
  const sink = createMemorySink();
  // Two pools: one healthy, one burns. The plan picks the cheap one (healthy)
  // but a tiny dust amount also flows through the burn pool. The pre-flight
  // must reject because ANY burn = burn (cashscript sums across categories).
  const executor = new SwapExecutor({
    cfg: baseConfig(),
    wallet: fakeWallet(),
    logger: createLogger({ sink: sink.stream }),
    deps: {
      getPoolsAndMeta: async () => ({
        tokenId: TOKEN_ID, pools: [HEALTHY_POOL, ROACH_BURN_POOL], tokenMeta: null,
        buySpot: 1n, sellSpot: 1n,
        effectiveBuy: 1n, effectiveSell: 1n,
        totalSats: 100_009n, totalTokens: 111_000n,
      }),
      planTrade: () => ({
        side: 'buy', amount: 111n, pools: [HEALTHY_POOL, ROACH_BURN_POOL],
        allocations: [
          { pool: HEALTHY_POOL, demandAmount: 100n, supplyAmount: 900n, feeAmount: 3n },
          { pool: ROACH_BURN_POOL, demandAmount: 11n, supplyAmount: 100n, feeAmount: 1n },
        ],
        totalSupply: 1_000n, totalFees: 4n, effectiveRate: 9n,
        impactPct: 0.001, estTxBytes: 600n, estNetworkFeeSats: 1_200n,
        buyUnder: null, sellOver: null,
      }),
      maxTokensForBudget: () => 111n,
      prepareAndBuildSwap: async () => {
        throw new Error('prepareAndBuildSwap should not be called on pool_shape rejection');
      },
      broadcastTx: async () => 'ff'.repeat(32),
      verifyTrade: async () => ({ ok: true, kind: 'ok', verdict: 'ok' }),
    },
  });
  const out = await executor.execute({
    tokenId: TOKEN_ID, side: 'buy', amountBase: 1_000n, destination: DESTINATION,
  });
  assert.equal(out.ok, false);
  assert.equal(out.errorKind, 'pool_shape');
  const rejectLine = sink.lines().find((l) => l.includes('"msg":"swap.pool_shape.reject"'));
  assert.ok(rejectLine);
  const parsed = JSON.parse(rejectLine);
  assert.ok(parsed.bad_pool_count >= 1);
});

test('execute: B02 — SELL plans also pre-flight (the SDK has a similar bug in computeOptimalSell)', async () => {
  // The SDK's `buildCauldronInputsOutputs(..., 'sell', ...)` uses the
  // SAME `ceil(K / newSatsExclFee)` formula for `newTokensOutput` on
  // the pool output — but for SELL the pool's post-trade token count
  // is `pool.tokens + demandAmount`, so the rounding can fall short
  // there too. The pre-flight catches this symmetric pathology.
  const sink = createMemorySink();
  const executor = new SwapExecutor({
    cfg: baseConfig(),
    wallet: fakeWallet(),
    logger: createLogger({ sink: sink.stream }),
    deps: {
      getPoolsAndMeta: async () => ({
        tokenId: TOKEN_ID, pools: [ROACH_BURN_POOL], tokenMeta: null,
        buySpot: 1n, sellSpot: 1n,
        effectiveBuy: 1n, effectiveSell: 1n,
        totalSats: 100_000n, totalTokens: 110_000n,
      }),
      planTrade: () => ({
        side: 'sell', amount: 11n, pools: [ROACH_BURN_POOL],
        allocations: [{ pool: ROACH_BURN_POOL, demandAmount: 11n, supplyAmount: 100n, feeAmount: 1n }],
        totalSupply: 99n, totalFees: 1n, effectiveRate: 9n,
        impactPct: 0.001, estTxBytes: 600n, estNetworkFeeSats: 1_200n,
        buyUnder: null, sellOver: null,
      }),
      maxTokensForBudget: () => 11n, // unused for SELL
      prepareAndBuildSwap: async () => {
        throw new Error('prepareAndBuildSwap should not be called on pool_shape rejection');
      },
      broadcastTx: async () => 'ff'.repeat(32),
      verifyTrade: async () => ({ ok: true, kind: 'ok', verdict: 'ok' }),
    },
  });
  const out = await executor.execute({
    tokenId: TOKEN_ID, side: 'sell', amountBase: 11n, destination: DESTINATION,
  });
  // The ROACH shape also burns on SELL (newTokensOutput = pool.tokens + demand − 1).
  assert.equal(out.ok, false);
  assert.equal(out.errorKind, 'pool_shape');
  const rejectLine = sink.lines().find((l) => l.includes('"msg":"swap.pool_shape.reject"'));
  assert.ok(rejectLine, 'SELL pre-flight should also log swap.pool_shape.reject');
});

// ─────────────────────────────────────────────────────────────────────
//  T55: per-token slippage cap integration
// ─────────────────────────────────────────────────────────────────────

test('T55 preFlightCheck: deep pool (5 BCH) tightens cap from 100 → 30 bps', () => {
  // Should not throw — slippage 30n equals the per-token cap.
  preFlightCheck({
    cfg: baseConfig(),
    side: 'buy',
    amountBch: 0.005,
    walletBalanceSats: 4_435_967n,
    openExposureBch: 0,
    slippageBps: 30n,
    poolDepthSats: 500_000_000n, // 5 BCH
  });
});

test('T55 preFlightCheck: deep pool rejects slippage above per-token cap', () => {
  // 50n slippage exceeds the per-token cap of 30n for a 5 BCH pool.
  assert.throws(
    () => preFlightCheck({
      cfg: baseConfig(),
      side: 'buy',
      amountBch: 0.005,
      walletBalanceSats: 4_435_967n,
      openExposureBch: 0,
      slippageBps: 50n,
      poolDepthSats: 500_000_000n, // 5 BCH → cap = 30n
    }),
    (e) => {
      if (!(e instanceof SwapPreFlightError)) return false;
      if (e.kind !== 'slippage_exceeded') return false;
      assert.equal(e.effective_cap_bps, 30n, 'effective_cap_bps should be per-token cap (30n)');
      assert.equal(e.base_cap_bps, 100n, 'base_cap_bps should be the flat fallback (100n)');
      assert.equal(e.cap_source, 'per_token');
      return true;
    },
  );
});

test('T55 preFlightCheck: shallow pool (0.5 BCH) loosens cap from 100 → 202 bps', () => {
  // Slippage of 150 bps — within the per-token cap (202) but above the flat cap (100).
  // Without the per-token cap this would have been rejected.
  preFlightCheck({
    cfg: baseConfig(),
    side: 'buy',
    amountBch: 0.005,
    walletBalanceSats: 4_435_967n,
    openExposureBch: 0,
    slippageBps: 150n,
    poolDepthSats: 50_000_000n, // 0.5 BCH → cap = 202n
  });
});

test('T55 preFlightCheck: missing poolDepthSats falls back to flat cap', () => {
  // 50n slippage — within the flat 100bps cap but above the per-token 30bps cap.
  // With no depth info, the flat cap applies.
  preFlightCheck({
    cfg: baseConfig(),
    side: 'buy',
    amountBch: 0.005,
    walletBalanceSats: 4_435_967n,
    openExposureBch: 0,
    slippageBps: 50n,
  });
});

test('T55 preFlightCheck: poolDepthSats=0n falls back to flat cap', () => {
  preFlightCheck({
    cfg: baseConfig(),
    side: 'buy',
    amountBch: 0.005,
    walletBalanceSats: 4_435_967n,
    openExposureBch: 0,
    slippageBps: 50n,
    poolDepthSats: 0n,
  });
});

test('T55 preFlightCheck: enabled=false in cfg falls back to flat cap', () => {
  const cfg = baseConfig();
  cfg.entry = { slippage_tolerance_bps: 100, slippage_cap_per_token_enabled: false };
  // 50n slippage — within flat cap, but per-token would tighten to 30.
  // With enabled=false we use the flat cap.
  preFlightCheck({
    cfg,
    side: 'buy',
    amountBch: 0.005,
    walletBalanceSats: 4_435_967n,
    openExposureBch: 0,
    slippageBps: 50n,
    poolDepthSats: 500_000_000n, // 5 BCH
  });
});

test('T55 preFlightCheck: custom min/max/multiplier knobs honored', () => {
  const cfg = baseConfig();
  cfg.entry = {
    slippage_tolerance_bps: 100,
    slippage_cap_min_bps: 50,
    slippage_cap_max_bps: 150,
    slippage_cap_multiplier: 1.5,
  };
  // 60n slippage — exceeds the per-token cap (50n, clamped to min on a 5 BCH pool).
  assert.throws(
    () => preFlightCheck({
      cfg,
      side: 'buy',
      amountBch: 0.005,
      walletBalanceSats: 4_435_967n,
      openExposureBch: 0,
      slippageBps: 60n,
      poolDepthSats: 500_000_000n,
    }),
    (e) => e instanceof SwapPreFlightError && e.kind === 'slippage_exceeded'
      && e.effective_cap_bps === 50n,
  );
});

// ─────────────────────────────────────────────────────────────────────
//  resolveEffectiveSlippageCapBps
// ─────────────────────────────────────────────────────────────────────

test('T55 resolveEffectiveSlippageCapBps: returns flat cap when no depth provided', () => {
  const cfg = baseConfig();
  cfg.entry = { slippage_tolerance_bps: 100 };
  const r = resolveEffectiveSlippageCapBps({
    cfg,
    amountBch: 0.005,
    poolDepthSats: null,
  });
  assert.deepEqual(r, { capBps: 100n, source: 'flat' });
});

test('T55 resolveEffectiveSlippageCapBps: returns per_token for deep pool', () => {
  const cfg = baseConfig();
  cfg.entry = { slippage_tolerance_bps: 100 };
  const r = resolveEffectiveSlippageCapBps({
    cfg,
    amountBch: 0.005,
    poolDepthSats: 500_000_000n, // 5 BCH
  });
  assert.equal(r.capBps, 30n);
  assert.equal(r.source, 'per_token');
});

test('T55 resolveEffectiveSlippageCapBps: returns per_token for shallow pool', () => {
  const cfg = baseConfig();
  cfg.entry = { slippage_tolerance_bps: 100 };
  const r = resolveEffectiveSlippageCapBps({
    cfg,
    amountBch: 0.005,
    poolDepthSats: 50_000_000n, // 0.5 BCH
  });
  assert.equal(r.capBps, 202n);
  assert.equal(r.source, 'per_token');
});

test('T55 resolveEffectiveSlippageCapBps: enabled=false returns flat', () => {
  const cfg = baseConfig();
  cfg.entry = { slippage_tolerance_bps: 100, slippage_cap_per_token_enabled: false };
  const r = resolveEffectiveSlippageCapBps({
    cfg,
    amountBch: 0.005,
    poolDepthSats: 500_000_000n,
  });
  assert.equal(r.capBps, 100n);
  assert.equal(r.source, 'flat');
});

test('T55 resolveEffectiveSlippageCapBps: respects custom knobs', () => {
  const cfg = baseConfig();
  cfg.entry = {
    slippage_tolerance_bps: 100,
    slippage_cap_min_bps: 50,
    slippage_cap_max_bps: 150,
  };
  const r = resolveEffectiveSlippageCapBps({
    cfg,
    amountBch: 0.005,
    poolDepthSats: 500_000_000n,
  });
  assert.equal(r.capBps, 50n);
  assert.equal(r.source, 'per_token');
});
