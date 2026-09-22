#!/usr/bin/env node
/**
 * Unit tests for src/trader/pool-shape.mjs — the pre-flight helpers
 * that detect Cauldron pools whose liquidity shape would cause the
 * SDK to construct a swap transaction that cashscript rejects with
 * "Implicit burning of fungible tokens for category <X>".
 *
 * Pure-function tests; no I/O, no SDK imports, no logging.
 *
 * Locks the contracts:
 *   - `ceilDiv` matches BigInt ceiling math (3/2 → 2, 6/3 → 2).
 *   - `simulateSdkNewTokensOutput` replays the SDK's `newTokensOutput`
 *     formula in pure form.
 *   - `wouldSdkImplicitBurn` returns true for the canonical ROACH-class
 *     failure (tokens=110000, sats=100000, demand=11 → deficit=1)
 *     and false for a healthy pool (where K is divisible by newTokens).
 *   - `analyzePlanForImplicitBurn` aggregates per-pool checks and
 *     surfaces the exact deficit.
 *   - `filterSwapablePools` strips only the burning pools.
 *   - Every helper tolerates null / undefined / non-bigint garbage
 *     (defensive — see swap.mjs `preFlightCheck` for the contract).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ceilDiv,
  simulateSdkNewTokensOutput,
  wouldSdkImplicitBurn,
  analyzePlanForImplicitBurn,
  filterSwapablePools,
} from '../../src/trader/pool-shape.mjs';

// ─────────────────────────────────────────────────────────────────
//  Canonical test inputs — a known-bad pool shape + a known-good one.
//  Found by brute-force search:
//
//  BURN SHAPE: tokens=110000, sats=100000, demand=11
//    → newTokens = 109989
//    → K = 11_000_000_000
//    → newSatsExclFee = ceil(11e9 / 109989) = 100010
//    → newTokensOutput = ceil(11e9 / 100010) = 109988
//    → newTokensOutput + demand = 109988 + 11 = 109999
//    → deficit = 110000 - 109999 = 1 ✓ (cashscript catches the shortfall)
//
//  HEALTHY SHAPE: tokens=1000, sats=9, demand=100
//    → newTokens = 900
//    → K = 9000 (divisible by newTokens=900)
//    → newSatsExclFee = ceil(9000 / 900) = 10
//    → newTokensOutput = ceil(9000 / 10) = 900
//    → newTokensOutput + demand = 900 + 100 = 1000 = tokens exactly. ✓
// ─────────────────────────────────────────────────────────────────

const CANONICAL_BURN_POOL = { tokens: 110000n, sats: 100000n };
const CANONICAL_BURN_DEMAND = 11n;
const CANONICAL_HEALTHY_POOL = { tokens: 1000n, sats: 9n };
const CANONICAL_HEALTHY_DEMAND = 100n; // K=9000 divisible by newTokens=900

// ─────────────────────────────────────────────────────────────────
//  ceilDiv
// ─────────────────────────────────────────────────────────────────

test('ceilDiv: integer result when divisible', () => {
  assert.equal(ceilDiv(6n, 3n), 2n);
  assert.equal(ceilDiv(10n, 5n), 2n);
});

test('ceilDiv: rounds up when not divisible', () => {
  assert.equal(ceilDiv(7n, 2n), 4n);
  assert.equal(ceilDiv(1n, 2n), 1n);   // ceil(0.5) = 1
  assert.equal(ceilDiv(99n, 10n), 10n); // ceil(9.9) = 10
});

test('ceilDiv: zero for zero numerator', () => {
  assert.equal(ceilDiv(0n, 5n), 0n);
});

test('ceilDiv: zero for non-positive denominator', () => {
  assert.equal(ceilDiv(10n, 0n), 0n);
  assert.equal(ceilDiv(10n, -1n), 0n);
});

test('ceilDiv: throws on non-bigint args', () => {
  assert.throws(() => ceilDiv(6, 3), /BigInt/);
  assert.throws(() => ceilDiv(6n, 3), /BigInt/);
  assert.throws(() => ceilDiv('6', '3'), /BigInt/);
});

// ─────────────────────────────────────────────────────────────────
//  simulateSdkNewTokensOutput
// ─────────────────────────────────────────────────────────────────

test('simulateSdkNewTokensOutput: produces deficit for the canonical burn shape', () => {
  const out = simulateSdkNewTokensOutput({
    tokens: CANONICAL_BURN_POOL.tokens,
    sats: CANONICAL_BURN_POOL.sats,
    demandAmount: CANONICAL_BURN_DEMAND,
  });
  // The exact value depends on the ceiling math, but the key
  // property is that out + demand < tokens (deficit > 0).
  assert.ok(out > 0n, 'should produce a positive output');
  assert.ok(out + CANONICAL_BURN_DEMAND < CANONICAL_BURN_POOL.tokens,
    `out + demand (${out + CANONICAL_BURN_DEMAND}) should be < tokens (${CANONICAL_BURN_POOL.tokens})`);
});

test('simulateSdkNewTokensOutput: matches demand exactly for the canonical healthy shape', () => {
  // K = 9000 divisible by newTokens = 900 → newSatsExclFee = 10 exactly
  // → newTokensOutput = ceil(9000/10) = 900 = newTokens = pool.tokens − demand
  // → newTokensOutput + demand = pool.tokens exactly (no deficit)
  const out = simulateSdkNewTokensOutput({
    tokens: CANONICAL_HEALTHY_POOL.tokens,
    sats: CANONICAL_HEALTHY_POOL.sats,
    demandAmount: CANONICAL_HEALTHY_DEMAND,
  });
  const newTokens = CANONICAL_HEALTHY_POOL.tokens - CANONICAL_HEALTHY_DEMAND;
  assert.equal(out, newTokens);
});

test('simulateSdkNewTokensOutput: 0n when demand depletes the pool', () => {
  const out = simulateSdkNewTokensOutput({ tokens: 1000n, sats: 100000n, demandAmount: 1500n });
  assert.equal(out, 0n);
});

test('simulateSdkNewTokensOutput: 0n for non-positive tokens/sats', () => {
  assert.equal(simulateSdkNewTokensOutput({ tokens: 0n, sats: 100n, demandAmount: 1n }), 0n);
  assert.equal(simulateSdkNewTokensOutput({ tokens: 100n, sats: 0n, demandAmount: 1n }), 0n);
  assert.equal(simulateSdkNewTokensOutput({ tokens: -5n, sats: 100n, demandAmount: 1n }), 0n);
});

test('simulateSdkNewTokensOutput: accepts Number + string args', () => {
  // Use the canonical healthy pool — tokens=1000, sats=9, demand=100.
  // With Number + string inputs, the function should still produce
  // the right output (900n).
  const out = simulateSdkNewTokensOutput({
    tokens: '1000',
    sats: 9,
    demandAmount: '100',
  });
  assert.equal(out, 900n);
});

test('simulateSdkNewTokensOutput: 0n for null/undefined/garbage inputs', () => {
  assert.equal(simulateSdkNewTokensOutput({ tokens: null, sats: 100n, demandAmount: 1n }), 0n);
  assert.equal(simulateSdkNewTokensOutput({ tokens: undefined, sats: 100n, demandAmount: 1n }), 0n);
  assert.equal(simulateSdkNewTokensOutput({ tokens: 'bogus', sats: 100n, demandAmount: 1n }), 0n);
  assert.equal(simulateSdkNewTokensOutput({}), 0n);
});

// ─────────────────────────────────────────────────────────────────
//  wouldSdkImplicitBurn
// ─────────────────────────────────────────────────────────────────

test('wouldSdkImplicitBurn: true for the canonical burn shape', () => {
  assert.equal(wouldSdkImplicitBurn(CANONICAL_BURN_POOL, CANONICAL_BURN_DEMAND), true);
});

test('wouldSdkImplicitBurn: false when newTokensOutput + demand === pool.tokens exactly', () => {
  // The canonical healthy pool: K=9000 divisible by newTokens=900
  // → newTokensOutput = newTokens exactly → no deficit.
  assert.equal(wouldSdkImplicitBurn(CANONICAL_HEALTHY_POOL, CANONICAL_HEALTHY_DEMAND), false);
});

test('wouldSdkImplicitBurn: false when demand would deplete pool', () => {
  // demand > tokens → simulateSdkNewTokensOutput returns 0n → false
  const pool = { tokens: 100n, sats: 1000n };
  assert.equal(wouldSdkImplicitBurn(pool, 200n), false);
});

test('wouldSdkImplicitBurn: false for null/garbage pool', () => {
  assert.equal(wouldSdkImplicitBurn(null, 1n), false);
  assert.equal(wouldSdkImplicitBurn(undefined, 1n), false);
  assert.equal(wouldSdkImplicitBurn('garbage', 1n), false);
  assert.equal(wouldSdkImplicitBurn({ sats: 100n }, 1n), false); // missing tokens
  assert.equal(wouldSdkImplicitBurn({ tokens: 100n }, 1n), false); // missing sats
});

test('wouldSdkImplicitBurn: tolerates Number demandAmount', () => {
  const result = wouldSdkImplicitBurn(CANONICAL_BURN_POOL, Number(CANONICAL_BURN_DEMAND));
  assert.equal(result, true);
  const result2 = wouldSdkImplicitBurn(CANONICAL_HEALTHY_POOL, Number(CANONICAL_HEALTHY_DEMAND));
  assert.equal(result2, false);
});

// ─────────────────────────────────────────────────────────────────
//  analyzePlanForImplicitBurn
// ─────────────────────────────────────────────────────────────────

test('analyzePlanForImplicitBurn: detects single burning pool', () => {
  const allocations = [{
    pool: { pool_id: 'pool-1', ...CANONICAL_BURN_POOL },
    demandAmount: CANONICAL_BURN_DEMAND,
  }];
  const result = analyzePlanForImplicitBurn(allocations);
  assert.equal(result.burns, true);
  assert.equal(result.badPools.length, 1);
  assert.equal(result.badPools[0].pool.pool_id, 'pool-1');
  assert.ok(result.badPools[0].deficit > 0n);
  assert.equal(result.totalInputTokens, CANONICAL_BURN_POOL.tokens);
  assert.ok(result.deficit > 0n);
});

test('analyzePlanForImplicitBurn: empty/garbage allocations', () => {
  const empty = analyzePlanForImplicitBurn([]);
  assert.equal(empty.burns, false);
  assert.deepEqual(empty.badPools, []);
  assert.equal(empty.totalInputTokens, 0n);

  const nullResult = analyzePlanForImplicitBurn(null);
  assert.equal(nullResult.burns, false);

  const garbage = analyzePlanForImplicitBurn([null, undefined, 'garbage', 42, {}]);
  assert.equal(garbage.burns, false);
});

test('analyzePlanForImplicitBurn: healthy plan returns burns=false', () => {
  const allocations = [
    { pool: { pool_id: 'a', ...CANONICAL_HEALTHY_POOL }, demandAmount: CANONICAL_HEALTHY_DEMAND },
    { pool: { pool_id: 'b', tokens: 2000n, sats: 4n }, demandAmount: 1000n },
    // K = 8000, newTokens = 1000, 8000/1000 = 8 exact → newSatsExclFee=8, newTokensOutput=1000, no deficit.
  ];
  const result = analyzePlanForImplicitBurn(allocations);
  assert.equal(result.burns, false);
  assert.equal(result.badPools.length, 0);
  assert.equal(result.deficit, 0n);
});

test('analyzePlanForImplicitBurn: aggregates multiple bad pools', () => {
  const allocations = [
    { pool: { pool_id: 'x', ...CANONICAL_BURN_POOL }, demandAmount: CANONICAL_BURN_DEMAND },
    { pool: { pool_id: 'y', ...CANONICAL_BURN_POOL }, demandAmount: CANONICAL_BURN_DEMAND },
  ];
  const result = analyzePlanForImplicitBurn(allocations);
  assert.equal(result.burns, true);
  assert.equal(result.badPools.length, 2);
  // Each pool has the same deficit (since they're identical inputs),
  // so total deficit = 2 × per-pool deficit.
  assert.equal(result.deficit, 2n * result.badPools[0].deficit);
});

test('analyzePlanForImplicitBurn: mixed plan (some healthy, some burn) still reports burns=true', () => {
  const allocations = [
    { pool: { pool_id: 'healthy', ...CANONICAL_HEALTHY_POOL }, demandAmount: CANONICAL_HEALTHY_DEMAND },
    { pool: { pool_id: 'burn', ...CANONICAL_BURN_POOL }, demandAmount: CANONICAL_BURN_DEMAND },
  ];
  const result = analyzePlanForImplicitBurn(allocations);
  assert.equal(result.burns, true);
  assert.equal(result.badPools.length, 1);
  assert.equal(result.badPools[0].pool.pool_id, 'burn');
});

// ─────────────────────────────────────────────────────────────────
//  filterSwapablePools
// ─────────────────────────────────────────────────────────────────

test('filterSwapablePools: drops only the burning pool', () => {
  const pools = [
    { pool_id: 'healthy', ...CANONICAL_HEALTHY_POOL },
    { pool_id: 'burn', ...CANONICAL_BURN_POOL },
  ];
  const demandByPoolId = {
    healthy: CANONICAL_HEALTHY_DEMAND,
    burn: CANONICAL_BURN_DEMAND,
  };
  const filtered = filterSwapablePools(pools, demandByPoolId);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].pool_id, 'healthy');
});

test('filterSwapablePools: Map-based demand lookup', () => {
  // Use the healthy pool with the healthy demand — both pools
  // pass the burn check, so both survive filtering.
  const pools = [
    { pool_id: 'p1', ...CANONICAL_HEALTHY_POOL },
    { pool_id: 'p2', ...CANONICAL_HEALTHY_POOL },
  ];
  const demandByPoolId = new Map([
    ['p1', CANONICAL_HEALTHY_DEMAND],
    ['p2', CANONICAL_HEALTHY_DEMAND],
  ]);
  const filtered = filterSwapablePools(pools, demandByPoolId);
  assert.equal(filtered.length, 2);
});

test('filterSwapablePools: empty/garbage inputs return []', () => {
  assert.deepEqual(filterSwapablePools([], {}), []);
  assert.deepEqual(filterSwapablePools(null, {}), []);
  assert.deepEqual(filterSwapablePools(undefined, {}), []);
  // Filters out garbage entries (null / undefined / non-objects).
  const filtered = filterSwapablePools([null, undefined, 'garbage'], {});
  assert.equal(filtered.length, 0);
});

test('filterSwapablePools: zero demand → all pools pass the burn check', () => {
  const pools = [
    { pool_id: 'a', ...CANONICAL_HEALTHY_POOL },
    { pool_id: 'b', ...CANONICAL_BURN_POOL },
  ];
  // With demand=0, both pools pass (newTokensOutput = pool.tokens so
  // output + 0 = pool.tokens exactly, no deficit).
  const filtered = filterSwapablePools(pools, { a: 0n, b: 0n });
  assert.equal(filtered.length, 2);
});

// ─────────────────────────────────────────────────────────────────
//  SELL-side coverage (the SDK pathology is symmetric)
// ─────────────────────────────────────────────────────────────────

test('wouldSdkImplicitBurn: SELL also catches the ROACH-class deficit', () => {
  // For SELL on the same ROACH shape: newTokens = pool.tokens + demand.
  // Math: K=11e9, newTokens=110011, newSatsExclFee=ceil(11e9/110011)=99991,
  // newTokensOutput=ceil(11e9/99991)=110010 — deficit=1 (output < newTokens).
  // Per-pool cashscript check: newTokensOutput − demandAmount < pool.tokens.
  const pool = { tokens: 110000n, sats: 100000n };
  assert.equal(wouldSdkImplicitBurn(pool, 11n, 'sell'), true);
  assert.equal(wouldSdkImplicitBurn(pool, 11n, 'buy'), true); // same shape, BUY also burns
});

test('wouldSdkImplicitBurn: SELL on a SELL-healthy pool passes (K divisible by pool.tokens + demand)', () => {
  // For SELL the relevant divisor is `pool.tokens + demandAmount`. Pick a
  // pool where K is divisible by (pool.tokens + demand) so the
  // ceiling math closes exactly. K = 9000, pool.tokens=900, demand=100
  // → newTokens=1000, newSatsExclFee=ceil(9000/1000)=9, newTokensOutput=
  // ceil(9000/9)=1000. For SELL: 1000 − 100 = 900 = pool.tokens exactly
  // (no deficit).
  const pool = { tokens: 900n, sats: 10n };
  assert.equal(wouldSdkImplicitBurn(pool, 100n, 'sell'), false);
});

test('analyzePlanForImplicitBurn: SELL surfaces the same ROACH-class deficit', () => {
  const allocations = [{
    pool: { pool_id: 'roach', tokens: 110000n, sats: 100000n },
    demandAmount: 11n,
  }];
  const buyResult = analyzePlanForImplicitBurn(allocations, 'buy');
  assert.equal(buyResult.burns, true);
  assert.equal(buyResult.side, 'buy');
  const sellResult = analyzePlanForImplicitBurn(allocations, 'sell');
  assert.equal(sellResult.burns, true);
  assert.equal(sellResult.side, 'sell');
  // Both sides agree on the deficit (different per-pool math, same answer).
  assert.ok(sellResult.badPools[0].deficit > 0n);
});
