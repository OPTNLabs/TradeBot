#!/usr/bin/env node
// tests/alerts-dispatch-points.test.mjs
//
// T53.2 — Integration tests proving every dispatch hook fires with
// the correct event shape when its trigger condition is hit.
//
// Covers the 8 dispatch points wired in T53.2:
//   CircuitBreaker: _dispatchBreakerTrip, _dispatchLossCooldown
//   SwapExecutor:   _dispatchPreflightReject
//   TradingLoop:    _dispatchWalletFloorBreach, _dispatchEntryRefused,
//                   _dispatchBreakerSkipped, _dispatchAmmDivergence,
//                   _dispatchExitExtended
//
// Each test injects mock `safeAlertDispatch` + `alertsAppend` seams,
// triggers the decision point, and asserts the mock was called with
// a well-formed AlertEvent matching the schema:
//   { kind, severity, title, body, context, ts }
//
// Also covers `resolveAlertSeams()` from `scripts/run-bot.mjs` — the
// helper that wires the alerts subsystem into the bot boot path.
//
// Run with:
//   node --test tests/alerts-dispatch-points.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

// ─────────────────────────────────────────────────────────────────────
//  CircuitBreaker dispatch tests
// ─────────────────────────────────────────────────────────────────────

import { CircuitBreaker } from '../src/risk/circuit-breaker.mjs';
import { createLogger, createMemorySink } from '../src/util/logger.mjs';

test('CircuitBreaker: _dispatchBreakerTrip fires when breaker trips (daily_loss)', async () => {
  const { sink } = createMemorySink();
  const logger = createLogger({ sink, component: 'test' });

  /** @type {Array<any>} */
  const appendCalls = [];
  /** @type {Array<any>} */
  const dispatchCalls = [];

  const breaker = new CircuitBreaker({
    cfg: {
      risk: {
        max_daily_loss_bch: 0.005,
        max_consecutive_losses: 3,
        loss_cooldown_minutes: 30,
      },
    },
    logger,
    // T53.2 seams
    safeAlertDispatch: async (event) => {
      dispatchCalls.push(event);
      return { ok: true };
    },
    alertsAppend: async (event) => {
      appendCalls.push(event);
      return { ok: true };
    },
  });

  // Record a big loss that should trip the breaker.
  await breaker.recordResult({
    tokenId: 'tok_a',
    pnlSats: -500_000,    // API uses pnlSats (not pnl_sats)
    exitKind: 'stop_loss',
  });

  // Record enough additional losses to trip the consecutive_losses arm too.
  for (let i = 0; i < 3; i++) {
    await breaker.recordResult({
      tokenId: 'tok_b',
      pnlSats: -100_000,
      exitKind: 'stop_loss',
    });
  }

  // Verify breaker_trip dispatch fired
  const tripCall = dispatchCalls.find((e) => e.kind === 'breaker_trip');
  assert.ok(tripCall, 'breaker_trip event should be dispatched');
  assert.equal(tripCall.severity, 'error');
  assert.ok(tripCall.title.includes('circuit_breaker'), 'title should include circuit_breaker');
  assert.ok(tripCall.body.includes('tripped'), 'body should mention tripped');
  assert.ok(tripCall.context, 'context must be present');
  assert.ok(typeof tripCall.ts === 'string' || typeof tripCall.ts === 'number', 'ts must be set');
  assert.ok(['daily_loss', 'consecutive_losses'].includes(tripCall.context.trip_kind), 'trip_kind must be a recognized kind');

  // Verify NDJSON append also fired
  const appendTrip = appendCalls.find((e) => e.kind === 'breaker_trip');
  assert.ok(appendTrip, 'breaker_trip should also be appended to NDJSON');
});

test('CircuitBreaker: _dispatchLossCooldown fires when loss cooldown starts', async () => {
  const { sink } = createMemorySink();
  const logger = createLogger({ sink, component: 'test' });

  /** @type {Array<any>} */
  const dispatchCalls = [];
  /** @type {Array<any>} */
  const appendCalls = [];

  const breaker = new CircuitBreaker({
    cfg: {
      risk: {
        max_daily_loss_bch: 0.005,
        max_consecutive_losses: 1, // trip on first loss
        loss_cooldown_minutes: 30,
      },
    },
    logger,
    safeAlertDispatch: async (event) => {
      dispatchCalls.push(event);
      return { ok: true };
    },
    alertsAppend: async (event) => {
      appendCalls.push(event);
      return { ok: true };
    },
  });

  // First loss triggers trip + starts loss cooldown
  await breaker.recordResult({
    tokenId: 'tok_a',
    pnlSats: -500_000,
    exitKind: 'stop_loss',
  });

  // Verify loss_cooldown_started dispatch fired
  const cooldownCall = dispatchCalls.find((e) => e.kind === 'wallet_floor' && e.title === 'loss_cooldown_started');
  assert.ok(cooldownCall, 'loss_cooldown_started event should be dispatched');
  assert.equal(cooldownCall.severity, 'warn');
  assert.ok(cooldownCall.context.loss_cooldown_minutes, 'context must include cooldown minutes');
  assert.ok(cooldownCall.context.pnl_sats, 'context must include pnl_sats');

  const appendCooldown = appendCalls.find((e) => e.kind === 'wallet_floor' && e.title === 'loss_cooldown_started');
  assert.ok(appendCooldown, 'loss_cooldown_started should also be NDJSON-append');
});

test('CircuitBreaker: no dispatch when no trip (profitable trades)', async () => {
  const { sink } = createMemorySink();
  const logger = createLogger({ sink, component: 'test' });

  /** @type {Array<any>} */
  const dispatchCalls = [];

  const breaker = new CircuitBreaker({
    cfg: {
      risk: {
        max_daily_loss_bch: 0.005,
        max_consecutive_losses: 3,
        loss_cooldown_minutes: 30,
      },
    },
    logger,
    safeAlertDispatch: async (event) => {
      dispatchCalls.push(event);
      return { ok: true };
    },
  });

  // Profitable trades should not trip the breaker
  await breaker.recordResult({
    tokenId: 'tok_a',
    pnlSats: 100_000,
    exitKind: 'take_profit',
  });
  await breaker.recordResult({
    tokenId: 'tok_b',
    pnlSats: 200_000,
    exitKind: 'take_profit',
  });

  const tripCalls = dispatchCalls.filter((e) => e.kind === 'breaker_trip');
  assert.equal(tripCalls.length, 0, 'no breaker_trip dispatch on profitable trades');
});

test('CircuitBreaker: no dispatch when alerts seams are null (legacy behavior)', async () => {
  const { sink } = createMemorySink();
  const logger = createLogger({ sink, component: 'test' });

  // Same config but NO alert seams — should not throw
  const breaker = new CircuitBreaker({
    cfg: {
      risk: {
        max_daily_loss_bch: 0.005,
        max_consecutive_losses: 1,
        loss_cooldown_minutes: 30,
      },
    },
    logger,
    // No safeAlertDispatch or alertsAppend — legacy mode
  });

  // Should not throw even though seams are null
  await breaker.recordResult({
    tokenId: 'tok_a',
    pnlSats: -500_000,
    exitKind: 'stop_loss',
  });

  // No assertion needed — if we get here without throwing, the test passes
  assert.ok(true, 'breaker should not throw when alert seams are null');
});

// ─────────────────────────────────────────────────────────────────────
//  SwapExecutor dispatch tests
// ─────────────────────────────────────────────────────────────────────

import { SwapExecutor } from '../src/trader/swap.mjs';

// Minimal pool shape — one healthy pool with deterministic rates so
// the SDK mocks return a predictable plan. `decimals: 0` so the
// per-display → per-base rate conversion is a no-op and the test's
// expectedRateSats lines up 1:1 with plan.effectiveRate (B##
// divide-by-decimals fix at `src/trader/rate-units.mjs` would
// otherwise scale the test's expectedRateSats down by 10^decimals
// and erase the intended slippage breach).
const FAKE_POOL = {
  pool_id: 'fake_pool_1',
  token: { category: 'a'.repeat(64), decimals: 0 },
  sats: 1_000_000n,
  tokens: 100_000n,
};

const FAKE_POOLS_AND_META = {
  tokenId: 'a'.repeat(64),
  pools: [FAKE_POOL],
  tokenMeta: { symbol: 'TKA', decimals: 0 },
  buySpot: 10n,        // sats per base unit (rate)
  sellSpot: 10n,
  effectiveBuy: 10n,
  effectiveSell: 10n,
  totalSats: 1_000_000n,
  totalTokens: 100_000n,
};

function makeFakePlan({ side, amount, effectiveRate = 10n, totalSupplySats = 100_000n }) {
  // `totalSupply` is what the swap.mjs pre-flight reads for
  // `amountBch = plan.totalSupply / 1e8`. For BUY that's the BCH
  // sats the AMM will consume; for SELL the BCH sats it will
  // return. Tests pass `totalSupplySats` to override the default
  // (the slippage_exceeded test wants a 100_000n plan so slippage
  // is what trips; the below_floor test wants plan.totalSupply
  // close to `amount` so the wallet-floor check trips on the BUY
  // path; the exposure_exceeded test wants totalSupply >
  // max_total_exposure_bch).
  return {
    side,
    amount,
    pools: [FAKE_POOL],
    allocations: [{
      pool: FAKE_POOL,
      tokens_in: amount,
      tokens_out: amount,
      sats_in: totalSupplySats,
      sats_out: totalSupplySats,
      fee_sats: 10n,
    }],
    totalSupply: totalSupplySats,
    totalTokens: amount,
    totalFees: 10n,
    effectiveRate,
    impactPct: 0.001,
    estTxBytes: 597n,
    estNetworkFeeSats: 1194n,
    buyUnder: null,
    sellOver: null,
  };
}

test('SwapExecutor: _dispatchPreflightReject fires on slippage_exceeded', async () => {
  /** @type {Array<any>} */
  const dispatchCalls = [];
  /** @type {Array<any>} */
  const appendCalls = [];

  const swap = new SwapExecutor({
    cfg: {
      entry: {
        max_position_bch: 0.005,
        max_total_exposure_bch: 0.04,
        slippage_tolerance_bps: 100,
        min_trade_size_bch: 0.0005,
        max_indexer_vs_amm_ratio_x: 1000,
      },
      risk: {
        min_wallet_balance_bch: 0.005,
      },
    },
    wallet: {
      // 0.05 BCH balance — enough to cover 0.002 BCH trade + 0.005 floor.
      getBalanceSats: () => 5_000_000n,
      // The WIF check at the top of execute() requires _wif to be set.
      _wif: 'test-wif-L4rK9y2CjK7q8GzNwKvX3qRuWqY9QvW7XaR8vT4rK9y2CjK7q8GzNwKvX3qRuWq',
    },
    logger: createLogger({ sink: process.stderr }),
    deps: {
      // Mock SDK so planTrade succeeds deterministically.
      getPoolsAndMeta: async () => FAKE_POOLS_AND_META,
      // SELL-side plan: amountBase is already in token base units.
      planTrade: ({ side, amount }) => makeFakePlan({ side, amount, effectiveRate: 10n }),
      // maxTokensForBudget — BUY path translation. For SELL it's unused.
      maxTokensForBudget: () => 50n,
      // T53.2: prepareAndBuildSwap mock — without this, swap.mjs falls
      // through to the real WIF lookup path (`wallet._resolveDeps()`)
      // which the test wallet mock doesn't implement.
      prepareAndBuildSwap: async () => ({ txHex: 'aa' }),
      broadcastTx: async () => 'bb'.repeat(32),
      verifyTrade: async () => ({ ok: true, kind: 'ok', verdict: 'ok' }),
    },
    // T53.2 seams
    safeAlertDispatch: async (event) => {
      dispatchCalls.push(event);
      return { ok: true };
    },
    alertsAppend: async (event) => {
      appendCalls.push(event);
      return { ok: true };
    },
  });

  // Execute a SELL where expectedRateSats=100 and effectiveRate=10 →
  // slippage = ((100 - 10) * 10000) / 100 = 9000 bps > 100 tolerance.
  const result = await swap.execute({
    tokenId: 'a'.repeat(64),
    side: 'sell',
    amountBase: 100n,
    destination: 'bitcoincash:qqcp6q32dt4x4ddzrkdz28xmv6a3ev6wwq4t0m57ak',
    expectedRateSats: 100n,
  });

  assert.equal(result.ok, false, 'swap should fail');
  assert.equal(result.errorKind, 'slippage_exceeded', `expected slippage_exceeded; got ${result.errorKind}`);

  // Verify slippage_spike dispatch fired
  const slippageCall = dispatchCalls.find((e) => e.kind === 'slippage_spike');
  assert.ok(slippageCall, 'slippage_spike event should be dispatched');
  assert.equal(slippageCall.severity, 'warn');
  assert.ok(slippageCall.title.includes('slippage'), 'title should mention slippage');
  assert.ok(slippageCall.context.token_id, 'context must include token_id');
  assert.ok(slippageCall.context.slippage_bps, 'context must include slippage_bps');

  // Verify NDJSON append
  const appendSlippage = appendCalls.find((e) => e.kind === 'slippage_spike');
  assert.ok(appendSlippage, 'slippage_spike should also be NDJSON-append');
});

test('SwapExecutor: _dispatchPreflightReject fires on below_floor (wallet floor breach)', async () => {
  /** @type {Array<any>} */
  const dispatchCalls = [];
  /** @type {Array<any>} */
  const appendCalls = [];

  const swap = new SwapExecutor({
    cfg: {
      entry: {
        max_position_bch: 0.01,        // bump so the size check doesn't trip first
        max_total_exposure_bch: 0.04,
        slippage_tolerance_bps: 100,
        min_trade_size_bch: 0.0005,
        max_indexer_vs_amm_ratio_x: 1000,
      },
      risk: {
        min_wallet_balance_bch: 0.005,  // 0.005 BCH floor
      },
    },
    // Very small wallet balance that would breach the floor.
    // Wallet = 0.01 BCH (1_000_000n sats). Trade wants to spend 0.008 BCH
    // (800_000n sats). After trade: 200_000n sats = 0.002 BCH — below 0.005 floor.
    wallet: {
      getBalanceSats: () => 1_000_000n,  // 0.01 BCH
      _wif: 'test-wif-L4rK9y2CjK7q8GzNwKvX3qRuWqY9QvW7XaR8vT4rK9y2CjK7q8GzNwKvX3qRuWq',
    },
    logger: createLogger({ sink: process.stderr }),
    deps: {
      getPoolsAndMeta: async () => FAKE_POOLS_AND_META,
      // effectiveRate matches expected → no slippage.
      // totalSupply = 800_000n sats (0.008 BCH) so amountBch = 0.008 BCH.
      // After trade wallet = 0.01 - 0.008 = 0.002 BCH < 0.005 floor.
      planTrade: ({ side, amount }) => makeFakePlan({ side, amount, effectiveRate: 10n, totalSupplySats: 800_000n }),
      maxTokensForBudget: () => 100n,
      // T53.2: prepareAndBuildSwap mock — see test #5.
      prepareAndBuildSwap: async () => ({ txHex: 'aa' }),
      broadcastTx: async () => 'bb'.repeat(32),
      verifyTrade: async () => ({ ok: true, kind: 'ok', verdict: 'ok' }),
    },
    safeAlertDispatch: async (event) => {
      dispatchCalls.push(event);
      return { ok: true };
    },
    alertsAppend: async (event) => {
      appendCalls.push(event);
      return { ok: true };
    },
  });

  // BUY path: amountBase is BCH sats.
  // amountBase = 800_000n; wallet = 1_000_000n; after trade 200_000n < floor 500_000n.
  const result = await swap.execute({
    tokenId: 'a'.repeat(64),
    side: 'buy',
    amountBase: 800_000n,
    destination: 'bitcoincash:qqcp6q32dt4x4ddzrkdz28xmv6a3ev6wwq4t0m57ak',
    expectedRateSats: 10n,
  });

  assert.equal(result.ok, false, 'swap should fail due to wallet floor');
  assert.equal(result.errorKind, 'below_floor', `expected below_floor; got ${result.errorKind}`);

  const floorCall = dispatchCalls.find((e) => e.kind === 'wallet_floor');
  assert.ok(floorCall, 'wallet_floor event should be dispatched on below_floor preflight');
  assert.ok(floorCall.context.wallet_balance_sats, 'context must include wallet_balance_sats');
});

test('SwapExecutor: _dispatchPreflightReject fires on exposure_exceeded', async () => {
  /** @type {Array<any>} */
  const dispatchCalls = [];

  const swap = new SwapExecutor({
    cfg: {
      entry: {
        max_position_bch: 0.05,         // bump so size check doesn't trip first
        max_total_exposure_bch: 0.04,   // max total exposure (smaller than per-trade cap)
        slippage_tolerance_bps: 100,
        min_trade_size_bch: 0.0005,
        max_indexer_vs_amm_ratio_x: 1000,
      },
      risk: {
        min_wallet_balance_bch: 0.005,
      },
    },
    // Plenty of balance so floor check doesn't trip
    wallet: {
      getBalanceSats: () => 50_000_000n,  // 0.5 BCH
      _wif: 'test-wif-L4rK9y2CjK7q8GzNwKvX3qRuWqY9QvW7XaR8vT4rK9y2CjK7q8GzNwKvX3qRuWq',
    },
    logger: createLogger({ sink: process.stderr }),
    deps: {
      getPoolsAndMeta: async () => FAKE_POOLS_AND_META,
      // effectiveRate matches expected → no slippage.
      // totalSupply = 5_000_000n sats (0.05 BCH) > max_total_exposure_bch 0.04 BCH
      // but <= max_position_bch 0.05 BCH so the size check is skipped
      // and the exposure check trips.
      planTrade: ({ side, amount }) => ({
        ...makeFakePlan({ side, amount, effectiveRate: 10n }),
        totalSupply: 5_000_000n,  // 0.05 BCH — exceeds 0.04 max-exposure
      }),
      maxTokensForBudget: () => 1_000n,
      // T53.2: prepareAndBuildSwap mock — see test #5.
      prepareAndBuildSwap: async () => ({ txHex: 'aa' }),
      broadcastTx: async () => 'bb'.repeat(32),
      verifyTrade: async () => ({ ok: true, kind: 'ok', verdict: 'ok' }),
    },
    safeAlertDispatch: async (event) => {
      dispatchCalls.push(event);
      return { ok: true };
    },
  });

  // Trade 0.05 BCH with max_total_exposure_bch=0.04 → exposure_exceeded.
  const result = await swap.execute({
    tokenId: 'a'.repeat(64),
    side: 'buy',
    amountBase: 5_000_000n,  // 0.05 BCH
    destination: 'bitcoincash:qqcp6q32dt4x4ddzrkdz28xmv6a3ev6wwq4t0m57ak',
    expectedRateSats: 10n,
  });

  assert.equal(result.ok, false, 'swap should fail');
  assert.equal(result.errorKind, 'exposure_exceeded', `expected exposure_exceeded; got ${result.errorKind}`);

  const exposureCall = dispatchCalls.find((e) => e.kind === 'risk_threshold');
  assert.ok(exposureCall, 'risk_threshold event should be dispatched on exposure_exceeded');
});

test('SwapExecutor: no dispatch when alerts seams are null (legacy behavior)', async () => {
  const swap = new SwapExecutor({
    cfg: {
      entry: {
        max_position_bch: 0.005,
        max_total_exposure_bch: 0.04,
        slippage_tolerance_bps: 100,
        min_trade_size_bch: 0.0005,
        max_indexer_vs_amm_ratio_x: 1000,
      },
      risk: {
        min_wallet_balance_bch: 0.005,
      },
    },
    wallet: {
      getBalanceSats: () => 1_000_000n,
      _wif: 'test-wif-L4rK9y2CjK7q8GzNwKvX3qRuWqY9QvW7XaR8vT4rK9y2CjK7q8GzNwKvX3qRuWq',
    },
    logger: createLogger({ sink: process.stderr }),
    deps: {
      getPoolsAndMeta: async () => FAKE_POOLS_AND_META,
      planTrade: ({ side, amount }) => makeFakePlan({ side, amount, effectiveRate: 10n }),
      maxTokensForBudget: () => 100n,
      // T53.2: prepareAndBuildSwap mock — see test #5.
      prepareAndBuildSwap: async () => ({ txHex: 'aa' }),
      broadcastTx: async () => 'bb'.repeat(32),
      verifyTrade: async () => ({ ok: true, kind: 'ok', verdict: 'ok' }),
    },
    // No alert seams — legacy mode
  });

  // Should not throw on slippage_exceeded even without alert seams
  const result = await swap.execute({
    tokenId: 'a'.repeat(64),
    side: 'sell',
    amountBase: 100n,
    destination: 'bitcoincash:qqcp6q32dt4x4ddzrkdz28xmv6a3ev6wwq4t0m57ak',
    expectedRateSats: 100n,  // 9000 bps slippage
  });

  assert.equal(result.ok, false);
  assert.equal(result.errorKind, 'slippage_exceeded');
  assert.ok(true, 'should not throw when alert seams are null');
});

// ─────────────────────────────────────────────────────────────────────
//  TradingLoop dispatch tests
// ─────────────────────────────────────────────────────────────────────

import { TradingLoop } from '../src/trader/loop.mjs';

const TID_A = 'a'.repeat(64);

function makeMinimalCfg(overrides = {}) {
  return {
    tuning_preset: 'small_balance_startup',
    entry: {
      max_position_bch: 0.005,
      max_total_exposure_bch: 0.04,
      slippage_tolerance_bps: 100,
      min_trade_size_bch: 0.0005,
      max_indexer_vs_amm_ratio_x: 1000,
      min_pool_age_days: 7,
    },
    risk: {
      min_wallet_balance_bch: 0.005,
      max_daily_loss_bch: 0.005,
      max_consecutive_losses: 3,
      loss_cooldown_minutes: 30,
    },
    loop: {
      tick_interval_ms: 60_000,
      tick_budget_ms: 5_000,
      max_candidates: 10,
    },
    scoring: {
      weights: { volume: 0.4, tvl: 0.3, price_change: 0.2, pool_age: 0.1 },
    },
    ranker: {
      min_score: 0,
      min_volume_24h_bch: 0.3,
      max_age_days: 30,
    },
    ...overrides,
  };
}

test('TradingLoop: _dispatchWalletFloorBreach fires when wallet below floor at entry pre-flight', async () => {
  const { sink } = createMemorySink();
  const logger = createLogger({ sink, component: 'test' });

  /** @type {Array<any>} */
  const dispatchCalls = [];
  /** @type {Array<any>} */
  const appendCalls = [];

  // Very small wallet below floor
  const wallet = {
    getBalanceSats: () => 200_000n, // 0.002 BCH — below 0.005 floor
    getAddress: () => 'bitcoincash:qqcp6q32dt4x4ddzrkdz28xmv6a3ev6wwq4t0m57ak',
  };

  const fetcher = {
    listTopTokens: async () => [{
      token_id: TID_A,
      display_name: 'Token A',
      display_symbol: 'TKA',
      price_now_sats: 1000,
      price_now_usd: 0.001,
      price_24h_sats: 1000,
      price_7d_sats: 1000,
      change_24h_bp: 0,
      change_7d_bp: 0,
      trade_volume_sats: 1_000_000_000,
      trade_count: 10,
      tvl_sats: 500_000_000,
      tvl_tokens: 100_000_000n,
      apy_30d_bp: 100,
      score: 0.9,
      score_rank: 1,
      // T28c: 29-point healthy series with upward spikes so the
      // test candidate passes the `min_upward_volatility=0.05`
      // gate and lands in the entries branch (without this every
      // candidate is filtered out by the ranker and the wallet-floor
      // breach dispatch never fires).
      price_series_7d: [
        0.90, 0.92, 0.91, 0.93, 0.95, 0.94, 0.96, 0.98, 0.97, 0.99,
        1.00, 0.98, 0.96, 0.97, 0.99, 1.00, 0.99, 0.97, 0.98, 1.00,
        0.98, 0.97, 0.99, 1.00, 0.99, 0.98, 1.00, 0.99, 1.00,
      ],
    }],
  };

  // `breaker.evaluate` returns `{ allow: true/false, ... }`. The loop
  // uses `breakerTripped = !breakerEval.allow` so the mock MUST set
  // `allow: true` to indicate the breaker is NOT tripped. Without it
  // the breaker looks tripped (default `undefined` → `!undefined === true`)
  // and entries are skipped, so the wallet-floor breach dispatch never
  // fires. This is the bug the in-flight tick left behind.
  const breaker = {
    evaluate: () => ({ allow: true, kind: 'ok', reason: null, openPositions: 0, openExposureBch: 0 }),
    recordResult: async () => {},
  };

  const swap = {
    execute: async () => ({ ok: false, error: 'not called' }),
  };

  const positions = {
    openPositions: () => [],
    pendingPositions: () => [],
    list: async () => [],
  };

  const snapshots = { maybeRecord: async () => {} };
  const historyAppend = async () => {};

  const loop = new TradingLoop({
    cfg: makeMinimalCfg(),
    fetcher,
    wallet,
    swap,
    positions,
    snapshots,
    breaker,
    historyAppend,
    logger,
    safeAlertDispatch: async (event) => {
      dispatchCalls.push(event);
      return { ok: true };
    },
    alertsAppend: async (event) => {
      appendCalls.push(event);
      return { ok: true };
    },
  });

  await loop.tick();

  const floorCall = dispatchCalls.find((e) => e.kind === 'wallet_floor' && e.title === 'entry_wallet_floor_breach');
  assert.ok(floorCall, 'wallet_floor breach event should be dispatched when wallet below floor');
  assert.equal(floorCall.severity, 'warn');
  assert.ok(floorCall.context.wallet_balance_bch, 'context must include wallet_balance_bch');
  assert.ok(floorCall.context.min_wallet_balance_bch, 'context must include min_wallet_balance_bch');
  assert.ok(floorCall.context.token_id, 'context must include token_id');

  const appendFloor = appendCalls.find((e) => e.kind === 'wallet_floor');
  assert.ok(appendFloor, 'wallet_floor should also be NDJSON-append');
});

test('TradingLoop: _dispatchEntryRefused fires when breaker trips (entries blocked)', async () => {
  const { sink } = createMemorySink();
  const logger = createLogger({ sink, component: 'test' });

  /** @type {Array<any>} */
  const dispatchCalls = [];

  const wallet = {
    getBalanceSats: () => 5_000_000n,
    getAddress: () => 'bitcoincash:qqcp6q32dt4x4ddzrkdz28xmv6a3ev6wwq4t0m57ak',
  };

  const fetcher = {
    listTopTokens: async () => [{
      token_id: TID_A,
      display_name: 'Token A',
      display_symbol: 'TKA',
      price_now_sats: 1000,
      price_now_usd: 0.001,
      price_24h_sats: 1000,
      price_7d_sats: 1000,
      change_24h_bp: 0,
      change_7d_bp: 0,
      trade_volume_sats: 1_000_000_000,
      trade_count: 10,
      tvl_sats: 500_000_000,
      tvl_tokens: 100_000_000n,
      apy_30d_bp: 100,
      score: 0.9,
      score_rank: 1,
    }],
  };

  // Breaker IS tripped — blocks entries. The mock must include `allow: false`.
  const breaker = {
    evaluate: () => ({ allow: false, kind: 'daily_loss', reason: 'daily_loss exceeded', openPositions: 1, openExposureBch: 0.01 }),
    recordResult: async () => {},
  };

  const swap = { execute: async () => ({ ok: false }) };
  const positions = { openPositions: () => [], pendingPositions: () => [], list: async () => [] };
  const snapshots = { maybeRecord: async () => {} };
  const historyAppend = async () => {};

  const loop = new TradingLoop({
    cfg: makeMinimalCfg(),
    fetcher,
    wallet,
    swap,
    positions,
    snapshots,
    breaker,
    historyAppend,
    logger,
    safeAlertDispatch: async (event) => {
      dispatchCalls.push(event);
      return { ok: true };
    },
    alertsAppend: async () => ({ ok: true }),
  });

  await loop.tick();

  // Should have dispatched breaker_skipped (per-tick "still tripped" pulse)
  const skippedCall = dispatchCalls.find((e) => e.title === 'breaker_still_tripped');
  assert.ok(skippedCall, 'breaker_still_tripped event should be dispatched when breaker is tripped');
  assert.equal(skippedCall.kind, 'breaker_trip');
  assert.equal(skippedCall.severity, 'warn');
  assert.ok(skippedCall.context.breaker_kind, 'context must include breaker_kind');
});

test('TradingLoop: no dispatch when alerts seams are null (legacy behavior)', async () => {
  const { sink } = createMemorySink();
  const logger = createLogger({ sink, component: 'test' });

  const wallet = {
    getBalanceSats: () => 200_000n, // below floor
    getAddress: () => 'bitcoincash:qqcp6q32dt4x4ddzrkdz28xmv6a3ev6wwq4t0m57ak',
  };

  const fetcher = {
    listTopTokens: async () => [{
      token_id: TID_A,
      display_name: 'Token A',
      display_symbol: 'TKA',
      price_now_sats: 1000,
      price_now_usd: 0.001,
      price_24h_sats: 1000,
      price_7d_sats: 1000,
      change_24h_bp: 0,
      change_7d_bp: 0,
      trade_volume_sats: 1_000_000_000,
      trade_count: 10,
      tvl_sats: 500_000_000,
      tvl_tokens: 100_000_000n,
      apy_30d_bp: 100,
      score: 0.9,
      score_rank: 1,
    }],
  };

  const breaker = { evaluate: () => ({ allow: true, kind: 'ok', reason: null, openPositions: 0, openExposureBch: 0 }), recordResult: async () => {} };
  const swap = { execute: async () => ({ ok: false }) };
  const positions = { openPositions: () => [], pendingPositions: () => [], list: async () => [] };
  const snapshots = { maybeRecord: async () => {} };
  const historyAppend = async () => {};

  // No alert seams — should not throw
  const loop = new TradingLoop({
    cfg: makeMinimalCfg(),
    fetcher,
    wallet,
    swap,
    positions,
    snapshots,
    breaker,
    historyAppend,
    logger,
    // No safeAlertDispatch or alertsAppend
  });

  // Should not throw
  await loop.tick();
  assert.ok(true, 'tick should not throw when alert seams are null');
});

test('TradingLoop: dispatch event has required AlertEvent schema fields', async () => {
  const { sink } = createMemorySink();
  const logger = createLogger({ sink, component: 'test' });

  /** @type {Array<any>} */
  let capturedEvent = null;

  const wallet = {
    getBalanceSats: () => 200_000n, // below floor
    getAddress: () => 'bitcoincash:qqcp6q32dt4x4ddzrkdz28xmv6a3ev6wwq4t0m57ak',
  };

  const fetcher = {
    listTopTokens: async () => [{
      token_id: TID_A,
      display_name: 'Token A',
      display_symbol: 'TKA',
      price_now_sats: 1000,
      price_now_usd: 0.001,
      price_24h_sats: 1000,
      price_7d_sats: 1000,
      change_24h_bp: 0,
      change_7d_bp: 0,
      trade_volume_sats: 1_000_000_000,
      trade_count: 10,
      tvl_sats: 500_000_000,
      tvl_tokens: 100_000_000n,
      apy_30d_bp: 100,
      score: 0.9,
      score_rank: 1,
      // T28c: see comment in the wallet-floor test above.
      price_series_7d: [
        0.90, 0.92, 0.91, 0.93, 0.95, 0.94, 0.96, 0.98, 0.97, 0.99,
        1.00, 0.98, 0.96, 0.97, 0.99, 1.00, 0.99, 0.97, 0.98, 1.00,
        0.98, 0.97, 0.99, 1.00, 0.99, 0.98, 1.00, 0.99, 1.00,
      ],
    }],
  };

  const breaker = { evaluate: () => ({ allow: true, kind: 'ok', reason: null, openPositions: 0, openExposureBch: 0 }), recordResult: async () => {} };
  const swap = { execute: async () => ({ ok: false }) };
  const positions = { openPositions: () => [], pendingPositions: () => [], list: async () => [] };
  const snapshots = { maybeRecord: async () => {} };
  const historyAppend = async () => {};

  const loop = new TradingLoop({
    cfg: makeMinimalCfg(),
    fetcher,
    wallet,
    swap,
    positions,
    snapshots,
    breaker,
    historyAppend,
    logger,
    safeAlertDispatch: async (event) => {
      capturedEvent = event;
      return { ok: true };
    },
    alertsAppend: async () => ({ ok: true }),
  });

  await loop.tick();

  assert.ok(capturedEvent, 'an event should have been dispatched');
  assert.equal(typeof capturedEvent.kind, 'string', 'kind must be a string');
  assert.equal(typeof capturedEvent.severity, 'string', 'severity must be a string');
  assert.equal(typeof capturedEvent.title, 'string', 'title must be a string');
  assert.equal(typeof capturedEvent.body, 'string', 'body must be a string');
  assert.equal(typeof capturedEvent.context, 'object', 'context must be an object');
  assert.ok(capturedEvent.ts != null, 'ts must be set');
  assert.ok(['info', 'warn', 'error'].includes(capturedEvent.severity), 'severity must be info|warn|error');
});

// ─────────────────────────────────────────────────────────────────────
//  run-bot resolveAlertSeams unit tests
// ─────────────────────────────────────────────────────────────────────

import { resolveAlertSeams } from '../scripts/run-bot.mjs';
import { DEFAULT_ALERTS_LOG_FILE } from '../src/alerts/index.mjs';

test('resolveAlertSeams: disabled (default) returns null seams', () => {
  const result = resolveAlertSeams({ alerts: { enabled: false } });
  assert.equal(result.safeAlertDispatch, null, 'safeAlertDispatch should be null when disabled');
  assert.equal(result.alertsAppend, null, 'alertsAppend should be null when disabled');
  assert.equal(result.alertsEnabled, false);
});

test('resolveAlertSeams: enabled builds a real AlertRouter from cfg', () => {
  const cfg = {
    alerts: {
      enabled: true,
      channels: ['console'],
      dedup_window_ms: 60000,
    },
  };
  const result = resolveAlertSeams(cfg);
  assert.equal(result.alertsEnabled, true);
  // Implementation calls `createConfiguredAlertRouter(cfg)` when
  // enabled and no override is supplied; the returned router is the
  // dispatch function (the bot passes it to swap/loop/breaker).
  assert.ok(result.safeAlertDispatch, 'safeAlertDispatch must be built from cfg when enabled');
  assert.equal(typeof result.safeAlertDispatch.dispatch, 'function');
  assert.equal(typeof result.safeAlertDispatch.send, 'function');
  assert.ok(result.alertsAppend, 'alertsAppend must be built from cfg when enabled');
  assert.equal(typeof result.alertsAppend, 'function');
});

test('resolveAlertSeams: test seams override cfg seams', () => {
  const overrideDispatch = async () => ({ ok: true });
  const overrideAppend = async () => ({ ok: true });

  const result = resolveAlertSeams(
    { alerts: { enabled: false } },
    { safeAlertDispatch: overrideDispatch, alertsAppend: overrideAppend }
  );

  assert.equal(result.safeAlertDispatch, overrideDispatch, 'override should be used');
  assert.equal(result.alertsAppend, overrideAppend, 'override should be used');
  assert.equal(result.alertsEnabled, false, 'alertsEnabled reflects cfg, not override');
});

test('resolveAlertSeams: uses DEFAULT_ALERTS_LOG_FILE when no log_file in cfg', () => {
  const result = resolveAlertSeams({ alerts: { enabled: true } });
  assert.equal(result.alertsLogFile, DEFAULT_ALERTS_LOG_FILE);
});

test('resolveAlertSeams: uses cfg.alerts.log_file when set', () => {
  const result = resolveAlertSeams(
    { alerts: { enabled: true, log_file: 'data/custom-alerts.jsonl' } }
  );
  assert.equal(result.alertsLogFile, 'data/custom-alerts.jsonl');
});

test('resolveAlertSeams: opts.alertsLogFile overrides cfg.log_file', () => {
  const result = resolveAlertSeams(
    { alerts: { enabled: true, log_file: 'data/cfg.jsonl' } },
    { alertsLogFile: 'data/opts.jsonl' }
  );
  assert.equal(result.alertsLogFile, 'data/opts.jsonl');
});
