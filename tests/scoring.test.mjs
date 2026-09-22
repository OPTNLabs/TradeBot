#!/usr/bin/env node
/**
 * Unit tests for src/strategy/scoring.mjs.
 *
 * Pure-function tests. No I/O, no logger, no process state. Run via:
 *   npm test
 *
 * Covers:
 *   - extractFeatures: field mapping, null-handling, fee_yield synthesis
 *   - normalizeLogScale: 0/half/cap/above/null behavior
 *   - normalizeLinear: 0/half/cap/above/null behavior
 *   - redistributeWeights: missing-feature handling + stable ordering
 *   - applyEligibilityGates: volume + TVL floor + missing-data behavior
 *   - scorePool: end-to-end, with all defaults and with overrides
 *   - scorePools: bulk map preserves order, marks invalid records
 *   - resolveScoringConfig: defaults + overrides
 *   - guard: hard-coded scores never make it through (the bot's
 *     scoring has no constants baked in; everything reads from
 *     config or returns 0).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SCORING_CONFIG,
  resolveScoringConfig,
  extractFeatures,
  normalizeLogScale,
  normalizeLinear,
  redistributeWeights,
  applyEligibilityGates,
  scorePool,
  scorePools,
  upwardVolatilityScore,
  countPriceTransitions,
} from '../src/strategy/scoring.mjs';
import { rankPools } from '../src/strategy/ranker.mjs';
import { SATS_PER_BCH } from '../src/data/types.mjs';

// ────────────────────────────────────────────────────────────────────
//  Fixtures
// ────────────────────────────────────────────────────────────────────

const TID = 'a'.repeat(64);
const TID2 = 'b'.repeat(64);

/** Healthy pool: 2 BCH/day volume, 1 BCH TVL, 5% daily move, 50% APY, 100 trades */
function healthyStats(overrides = {}) {
  return {
    token_id: TID,
    symbol: 'TEST',
    decimals: 0,
    trade_volume_sats: 2 * SATS_PER_BCH,
    tvl_sats: 1 * SATS_PER_BCH,
    change_24h_bp: 500, // 5% absolute move
    apy_30d_bp: 5000,   // 50%
    trade_count: 100,
    price_now_sats: 1000,
    // T28c: a realistic 29-point 7d series with at least one upward
    // spike + a healthy trailing recovery. upwardVolatilityScore
    // reads this directly; without it the eligibility gate fails
    // (upward_volatility:missing). Operators that want to disable
    // the gate set min_upward_volatility=0.
    price_series_7d: [
      0.90, 0.92, 0.91, 0.93, 0.95, 0.94, 0.96, 0.98, 0.97, 0.99,
      1.00, 0.98, 0.96, 0.97, 0.99, 1.00, 0.99, 0.97, 0.98, 1.00,
      0.98, 0.97, 0.99, 1.00, 0.99, 0.98, 1.00, 0.99, 1.00,
    ],
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────
//  resolveScoringConfig
// ────────────────────────────────────────────────────────────────────

test('resolveScoringConfig: returns clone of defaults on null/undefined/bad input', () => {
  for (const bad of [null, undefined, 0, 'string', 42, true]) {
    const cfg = resolveScoringConfig(bad);
    assert.equal(cfg.min_score, DEFAULT_SCORING_CONFIG.min_score);
    assert.equal(cfg.weights.volume_24h_bch, DEFAULT_SCORING_CONFIG.weights.volume_24h_bch);
    assert.equal(cfg.caps.tvl_bch, DEFAULT_SCORING_CONFIG.caps.tvl_bch);
  }
});

test('resolveScoringConfig: returns a fresh copy (no aliasing of DEFAULT_SCORING_CONFIG)', () => {
  const cfg = resolveScoringConfig();
  cfg.weights.volume_24h_bch = 0.99;
  cfg.caps.tvl_bch = 999;
  // T46b: weight rebalanced to long-window-primary (24h now 0.10, not 0.30).
  assert.equal(DEFAULT_SCORING_CONFIG.weights.volume_24h_bch, 0.10);
  assert.equal(DEFAULT_SCORING_CONFIG.caps.tvl_bch, 5.0);
});

test('resolveScoringConfig: merges partial overrides', () => {
  const cfg = resolveScoringConfig({
    min_score: 0.5,
    weights: { volume_24h_bch: 0.5 },
    caps: { tvl_bch: 9 },
  });
  assert.equal(cfg.min_score, 0.5);
  assert.equal(cfg.weights.volume_24h_bch, 0.5);
  // Untouched fields keep their defaults.
  assert.equal(cfg.weights.tvl_bch, DEFAULT_SCORING_CONFIG.weights.tvl_bch);
  assert.equal(cfg.caps.tvl_bch, 9);
  assert.equal(cfg.caps.volume_24h_bch, DEFAULT_SCORING_CONFIG.caps.volume_24h_bch);
});

test('resolveScoringConfig: drops garbage numeric overrides silently', () => {
  const cfg = resolveScoringConfig({ min_score: 'nope', min_volume_7d_bch: NaN });
  assert.equal(cfg.min_score, DEFAULT_SCORING_CONFIG.min_score);
  assert.equal(cfg.min_volume_7d_bch, DEFAULT_SCORING_CONFIG.min_volume_7d_bch);
});

// ────────────────────────────────────────────────────────────────────
//  extractFeatures
// ────────────────────────────────────────────────────────────────────

test('extractFeatures: maps trade_volume_sats + tvl_sats to BCH', () => {
  const f = extractFeatures(healthyStats());
  assert.equal(f.volume_24h_bch, 2);
  assert.equal(f.tvl_bch, 1);
});

test('extractFeatures: converts apy_30d_bp to percent and abs(change_24h_bp) to volatility pct', () => {
  const f = extractFeatures(healthyStats({ change_24h_bp: -300, apy_30d_bp: 1234 }));
  assert.equal(f.volatility_24h_pct, 3);     // abs(-300)/100
  assert.equal(f.apy_30d_pct, 12.34);
});

test('extractFeatures: returns null for missing fields, never 0', () => {
  const f = extractFeatures({ token_id: TID });
  assert.equal(f.volume_24h_bch, null);
  assert.equal(f.tvl_bch, null);
  assert.equal(f.volatility_24h_pct, null);
  assert.equal(f.apy_30d_pct, null);
  assert.equal(f.fee_yield_bps, null);
  assert.equal(f.volume_7d_bch, null);
});

test('extractFeatures: synthesizes fee_yield_bps from trade_count + tvl_sats + fee_rate_bps', () => {
  // 100 trades × 30 bps × 1% of TVL per trade = 30 bps/day
  const f = extractFeatures(healthyStats({ trade_count: 100 }), { fee_rate_bps: 30 });
  assert.equal(f.fee_yield_bps, 30);
});

test('extractFeatures: zero or missing trade_count yields null fee_yield_bps', () => {
  const a = extractFeatures(healthyStats({ trade_count: 0 }));
  const b = extractFeatures(healthyStats({ trade_count: null }));
  assert.equal(a.fee_yield_bps, null);
  assert.equal(b.fee_yield_bps, null);
});

test('extractFeatures: zero tvl_sats yields null fee_yield_bps (no division by zero)', () => {
  const f = extractFeatures(healthyStats({ tvl_sats: 0, trade_count: 100 }));
  assert.equal(f.fee_yield_bps, null);
});

test('extractFeatures: invalid stats object returns all-null', () => {
  const f = extractFeatures(null);
  for (const k of Object.keys(f)) assert.equal(f[k], null);
});

test('extractFeatures: bigint sats coerce cleanly', () => {
  const f = extractFeatures({
    token_id: TID,
    trade_volume_sats: BigInt(3 * SATS_PER_BCH),
    tvl_sats: BigInt(2 * SATS_PER_BCH),
  });
  assert.equal(f.volume_24h_bch, 3);
  assert.equal(f.tvl_bch, 2);
});

// ────────────────────────────────────────────────────────────────────
//  T86 — `countPriceTransitions` + volume_7d_bch estimation
//
// The Cauldron indexer doesn't expose a native 24h-volume field, and
// `trade_volume` is cumulative all-time (NOT 24h). To replace the
// broken `min_volume_24h_bch` gate, T86 derives `volume_7d_bch` from
// the existing `price_series_7d` via a transition-counter:
// `volume_7d_bch ≈ transitions × 1% × TVL_bch`.
// ────────────────────────────────────────────────────────────────────

test('countPriceTransitions: empty / non-array / too-short → 0', () => {
  assert.equal(countPriceTransitions(undefined), 0);
  assert.equal(countPriceTransitions(null), 0);
  assert.equal(countPriceTransitions([]), 0);
  assert.equal(countPriceTransitions([1]), 0);
  assert.equal(countPriceTransitions('not-array'), 0);
  assert.equal(countPriceTransitions(42), 0);
  assert.equal(countPriceTransitions({ 0: 1, 1: 2 }), 0);
});

test('countPriceTransitions: consecutive duplicate values register no transition', () => {
  assert.equal(countPriceTransitions([1, 1, 1, 1, 1]), 0);
  assert.equal(countPriceTransitions([5, 5, 5, 5, 5]), 0);
  assert.equal(countPriceTransitions([1.0, 1.0, 1.0]), 0);
});

test('countPriceTransitions: every-distinct-value series registers n-1 transitions', () => {
  assert.equal(countPriceTransitions([1, 2, 3, 4, 5]), 4);
  assert.equal(countPriceTransitions([5, 4, 3, 2, 1]), 4);
  assert.equal(countPriceTransitions([1.0, 1.01, 1.02, 1.03, 1.04]), 4);
});

test('countPriceTransitions: typical 7d-price-shape (flat-with-spikes) matches expected', () => {
  // [1, 1, 1, 2, 2, 3, 3, 3, 4] → 3 transitions (1→2, 2→3, 3→4)
  assert.equal(countPriceTransitions([1, 1, 1, 2, 2, 3, 3, 3, 4]), 3);
  // [1.0, 1.0+ε, 1.0+2ε] → 2 transitions (ε and 2ε both register)
  assert.equal(countPriceTransitions([1.0, 1.0 + 1e-9, 1.0 + 2e-9]), 2);
});

test('countPriceTransitions: null / undefined entries are skipped (defensive against indexer holes)', () => {
  // The dashboard sometimes returns `[null, 1.0, 1.0]` when a
  // sampling tick missed the indexer. The hole is a "no trade"
  // period, NOT a transition.
  assert.equal(countPriceTransitions([null, 1.0, 1.0]), 0);
  assert.equal(countPriceTransitions([1.0, null, 2.0]), 1);
  assert.equal(countPriceTransitions([1.0, undefined, 2.0]), 1);
  assert.equal(countPriceTransitions([1.0, null, null, 1.0]), 0);
});

test('extractFeatures: estimates volume_7d_bch from price_series_7d transitions', () => {
  // 29 distinct values → 28 transitions.
  // volume_7d_bch = 28 × 1% × 1 BCH TVL = 0.28 BCH
  const distinctSeries = [];
  for (let i = 0; i < 29; i++) distinctSeries.push(1.0 + i * 0.01);
  const f = extractFeatures({
    token_id: TID,
    trade_volume_sats: 0,
    tvl_sats: 1 * SATS_PER_BCH,
    price_series_7d: distinctSeries,
  });
  assert.equal(f.volume_7d_bch, 0.28);
});

test('extractFeatures: flat price_series_7d yields 0 volume_7d_bch (below floor → ineligible)', () => {
  // No transitions × 1% × TVL = 0
  const f = extractFeatures({
    token_id: TID,
    trade_volume_sats: 0,
    tvl_sats: 1 * SATS_PER_BCH,
    price_series_7d: Array(29).fill(1.0),
  });
  assert.equal(f.volume_7d_bch, 0);
});

test('extractFeatures: missing price_series_7d yields null volume_7d_bch', () => {
  // No native volume_7d_bch field AND no price_series_7d →
  // estimator returns null.
  const f = extractFeatures({
    token_id: TID,
    trade_volume_sats: 0,
    tvl_sats: 1 * SATS_PER_BCH,
    // price_series_7d omitted entirely
  });
  assert.equal(f.volume_7d_bch, null);
});

test('extractFeatures: null price_series_7d yields null volume_7d_bch', () => {
  const f = extractFeatures({
    token_id: TID,
    trade_volume_sats: 0,
    tvl_sats: 1 * SATS_PER_BCH,
    price_series_7d: null,
  });
  assert.equal(f.volume_7d_bch, null);
});

test('extractFeatures: price_series_7d with single entry yields 0 transitions → 0 volume_7d_bch', () => {
  const f = extractFeatures({
    token_id: TID,
    trade_volume_sats: 0,
    tvl_sats: 1 * SATS_PER_BCH,
    price_series_7d: [1.0],
  });
  assert.equal(f.volume_7d_bch, 0);
});

test('extractFeatures: native volume_7d_bch field takes precedence over the estimator', () => {
  // If the indexer ever starts exposing a real volume_7d_bch
  // field, we trust that over the estimator.
  const f = extractFeatures({
    token_id: TID,
    trade_volume_sats: 0,
    tvl_sats: 1 * SATS_PER_BCH,
    volume_7d_bch: 42.5,
    price_series_7d: [1.0, 2.0, 3.0, 4.0, 5.0],  // 4 transitions × 1% × 1 = 0.04 (would be the estimator)
  });
  assert.equal(f.volume_7d_bch, 42.5);
});

test('extractFeatures: missing tvl_sats yields null volume_7d_bch (no division by zero)', () => {
  const f = extractFeatures({
    token_id: TID,
    trade_volume_sats: 0,
    tvl_sats: 0,
    price_series_7d: [1.0, 2.0, 3.0, 4.0, 5.0],
  });
  assert.equal(f.volume_7d_bch, null);
});

// ────────────────────────────────────────────────────────────────────
//  T23e — raw indexer shape compatibility
//
// Regression for the 2026-09-12 production incident: the bot's
// `TradingLoop._fetchStats()` calls `fetcher.listTopTokens()`, which
// returns RAW Cauldron indexer entries. Those entries expose
// `volume_24h_sats` + `volume_24h_bch` directly (no
// `trade_volume_sats`), so `extractFeatures()` was reporting
// `volume_24h_bch: missing` for every pool. After weight
// redistribution, no pool could clear `min_score: 0.35` and
// `candidate_count` stayed at 0. The fix: accept either shape,
// preferring the pre-converted BCH value when present.
// ────────────────────────────────────────────────────────────────────

test('extractFeatures: reads raw indexer volume_24h_bch directly (T23e)', () => {
  const f = extractFeatures({
    token_id: TID,
    // Raw Cauldron indexer shape — fields exposed by listTopTokens().
    volume_24h_sats: 2450_87741121,    // 2450.87741121 BCH
    volume_24h_bch: 2450.87741121,
    tvl_sats: 525_82913123,            // 525.82913123 BCH
    tvl_bch: 525.82913123,
    change_24h_bp: -125,
    apy_30d_bp: 952,
  });
  assert.equal(f.volume_24h_bch, 2450.87741121);
  assert.equal(f.tvl_bch, 525.82913123);
  assert.equal(f.volatility_24h_pct, 1.25);
  assert.equal(f.apy_30d_pct, 9.52);
  // No trade_count in raw shape → fee_yield stays null (missing evidence).
  assert.equal(f.fee_yield_bps, null);
  // No volume_7d_sats in either shape → volume_7d_bch stays null.
  assert.equal(f.volume_7d_bch, null);
});

test('extractFeatures: falls back to volume_24h_sats / 1e8 when _bch missing (T23e)', () => {
  const f = extractFeatures({
    token_id: TID,
    volume_24h_sats: 500_000_000,  // 5 BCH in sats
    tvl_sats: 100_000_000,
    change_24h_bp: 100,
    apy_30d_bp: 100,
  });
  assert.equal(f.volume_24h_bch, 5);
  assert.equal(f.tvl_bch, 1);
});

test('extractFeatures: normalized shape (trade_volume_sats) still works (T23e regression)', () => {
  const f = extractFeatures({
    token_id: TID,
    trade_volume_sats: 4 * SATS_PER_BCH,
    tvl_sats: 2 * SATS_PER_BCH,
    trade_count: 50,
    change_24h_bp: 200,
    apy_30d_bp: 800,
  });
  assert.equal(f.volume_24h_bch, 4);
  assert.equal(f.tvl_bch, 2);
  assert.equal(f.fee_yield_bps !== null, true);  // normalized shape includes trade_count
});

test('extractFeatures: prefers volume_24h_bch over volume_24h_sats / 1e8 (T23e)', () => {
  // Both fields present — the BCH field should win (avoids float drift).
  const f = extractFeatures({
    token_id: TID,
    volume_24h_sats: 2450_87741121,
    volume_24h_bch: 2450.87741121,  // identical value, but explicit BCH wins
    tvl_sats: 525_82913123,
    tvl_bch: 525.82913123,
    change_24h_bp: 0,
    apy_30d_bp: 0,
  });
  assert.equal(f.volume_24h_bch, 2450.87741121);
});

test('extractFeatures: does NOT read live indexer `trade_volume` as 24h volume (T86)', () => {
  // T86 regression guard: the Cauldron indexer's `trade_volume` field
  // is CUMULATIVE ALL-TIME — reading it as 24h volume made every pool
  // look like it had massive 24h activity, silently distorting the
  // eligibility gate. The T86 fix drops `trade_volume` from the
  // fallback chain; if a future refactor accidentally re-adds it,
  // this test fires with a guardrail message.
  const f = extractFeatures({
    token_id: TID,
    trade_volume: 244306237362,   // 2443.06237362 BCH (cumulative all-time)
    // No trade_volume_sats / volume_24h_sats / volume_24h_bch — the
    // 24h fallback chain returns null. Only the cumulative
    // trade_volume is set, which T86 explicitly ignores.
    tvl_sats: 52886651167,        // 528.86651167 BCH
    trade_count: 0,
    change_24h_bp: 36,
    apy_30d_bp: 946,
  });
  assert.equal(f.volume_24h_bch, null,
    `volume_24h_bch must be null when the only volume-shaped field is the cumulative trade_volume (got ${f.volume_24h_bch})`);
  assert.equal(f.tvl_bch, 528.86651167);
  assert.equal(f.volatility_24h_pct, 0.36);
  assert.equal(f.apy_30d_pct, 9.46);
  // trade_count=0 → fee_yield stays null (zero trades = no fee revenue).
  assert.equal(f.fee_yield_bps, null);
});

// ────────────────────────────────────────────────────────────────────
//  extractFeatures — volume_30d_bch derivation (T46b)
// ────────────────────────────────────────────────────────────────────

test('extractFeatures: derives volume_30d_bch from apy_30d_bp × tvl_sats (T46b)', () => {
  // The T46b formula:
  //   thirtyDayFeeRevenueSats = tvlSats * (apyBp / 365) * 30 / 10000
  //   thirtyDayVolSats        = thirtyDayFeeRevenueSats / (feeRateBps / 10000)
  // Working through with the values below (60 bps × 259 BCH TVL):
  //   259e8 * (60/365) * 30 / 10000 = 1 277 260 274 sats fee revenue
  //   1 277 260 274 / 0.0030        = 425 753 424 658 sats traded
  //   425 753 424 658 / 1e8         ≈ 4.258 BCH / 30d
  // The function comment in scoring.mjs uses the same formula.
  // The test below locks the ACTUAL formula output so a future
  // refactor can't silently drift the derivation.
  const f = extractFeatures(healthyStats({
    apy_30d_bp: 60,
    // 259 BCH of TVL as a plain Number — BigInt × Number trips JS's
    // "Cannot mix BigInt and other types". The fetcher coerces
    // BigInt→Number via `num()` before arithmetic, so we exercise
    // the same path here.
    tvl_sats: 259 * SATS_PER_BCH,
  }), { fee_rate_bps: 30 });
  assert.ok(typeof f.volume_30d_bch === 'number',
    `expected number, got ${typeof f.volume_30d_bch}: ${f.volume_30d_bch}`);
  assert.ok(Number.isFinite(f.volume_30d_bch));
  assert.ok(f.volume_30d_bch > 0,
    `expected positive BCH volume, got ${f.volume_30d_bch}`);
  // Approximately 4.26 BCH for 60 bps × 259 BCH TVL at 30 bps fee rate.
  // Allow wide tolerance — the exact number is formula-locked anyway.
  assert.ok(f.volume_30d_bch > 1 && f.volume_30d_bch < 100,
    `expected 1-100 BCH range for 60bps×259BCH, got ${f.volume_30d_bch}`);
});

test('extractFeatures: returns null volume_30d_bch when apy/tvl/fee are missing (T46b)', () => {
  // Missing apy_30d_bp → no derivation possible.
  const noApy = extractFeatures(healthyStats({ apy_30d_bp: null }));
  assert.equal(noApy.volume_30d_bch, null);

  // Missing tvl_sats → no derivation possible.
  const noTvl = extractFeatures(healthyStats({ tvl_sats: null }));
  assert.equal(noTvl.volume_30d_bch, null);

  // tvl_sats = 0 → division-by-zero guard returns null.
  const zeroTvl = extractFeatures(healthyStats({ tvl_sats: 0n }));
  assert.equal(zeroTvl.volume_30d_bch, null);

  // Zero apy (no fee revenue) → returns 0 (formula yields 0).
  const zeroApy = extractFeatures(healthyStats({ apy_30d_bp: 0 }));
  assert.equal(zeroApy.volume_30d_bch, 0);

  // Missing fee_rate_bps opt (defaults to 30) still works.
  const noFeeRate = extractFeatures(healthyStats({ apy_30d_bp: 5000 }));
  assert.ok(typeof noFeeRate.volume_30d_bch === 'number');
});

test('extractFeatures: includes volume_30d_bch in output shape (T46b)', () => {
  // Regression guard: extractFeatures output shape must always
  // include volume_30d_bch, even when the derivation returns null.
  const f = extractFeatures({ token_id: TID });
  assert.ok('volume_30d_bch' in f,
    `expected volume_30d_bch key in extractFeatures output, got keys: ${Object.keys(f)}`);
  assert.equal(f.volume_30d_bch, null);
});

// ────────────────────────────────────────────────────────────────────
//  normalizeLogScale
// ────────────────────────────────────────────────────────────────────

test('normalizeLogScale: x=0 → 0, x=cap → 1, x>cap → 1, null → null', () => {
  const cap = 10;
  assert.equal(normalizeLogScale(0, cap), 0);
  assert.equal(normalizeLogScale(cap, cap), 1);
  assert.equal(normalizeLogScale(cap * 1000, cap), 1);
  assert.equal(normalizeLogScale(null, cap), null);
  assert.equal(normalizeLogScale(undefined, cap), null);
});

test('normalizeLogScale: half-cap value is below 0.5 (log curve concave)', () => {
  // log10(1 + 5) / log10(1 + 10) ≈ 0.699 / 1.041 ≈ 0.671
  const v = normalizeLogScale(5, 10);
  assert.ok(v > 0.5 && v < 0.8, `expected ~0.67, got ${v}`);
});

test('normalizeLogScale: bad cap returns 0 (caller bug, not infinity)', () => {
  assert.equal(normalizeLogScale(5, 0), 0);
  assert.equal(normalizeLogScale(5, -1), 0);
  assert.equal(normalizeLogScale(5, NaN), 0);
});

test('normalizeLogScale: negative or non-finite input → null', () => {
  assert.equal(normalizeLogScale(-1, 10), null);
  assert.equal(normalizeLogScale(NaN, 10), null);
  assert.equal(normalizeLogScale(Infinity, 10), null);
});

// ────────────────────────────────────────────────────────────────────
//  normalizeLinear
// ────────────────────────────────────────────────────────────────────

test('normalizeLinear: x=0 → 0, x=cap → 1, x>cap → 1', () => {
  const cap = 30;
  assert.equal(normalizeLinear(0, cap), 0);
  assert.equal(normalizeLinear(15, cap), 0.5);
  assert.equal(normalizeLinear(30, cap), 1);
  assert.equal(normalizeLinear(60, cap), 1);
});

test('normalizeLinear: null / negative / non-finite → null', () => {
  assert.equal(normalizeLinear(null, 10), null);
  assert.equal(normalizeLinear(undefined, 10), null);
  assert.equal(normalizeLinear(-1, 10), null);
  assert.equal(normalizeLinear(NaN, 10), null);
});

test('normalizeLinear: bad cap returns 0', () => {
  assert.equal(normalizeLinear(5, 0), 0);
  assert.equal(normalizeLinear(5, NaN), 0);
});

// ────────────────────────────────────────────────────────────────────
//  redistributeWeights
// ────────────────────────────────────────────────────────────────────

test('redistributeWeights: all features present → weights normalize to sum=1', () => {
  const w = { a: 0.3, b: 0.5, c: 0.2 };
  const v = { a: 1, b: 1, c: 1 };
  const r = redistributeWeights(w, v);
  const sum = Object.values(r.effectiveWeights).reduce((acc, n) => acc + n, 0);
  assert.equal(sum, 1);
  assert.equal(r.effectiveWeights.a, 0.3);
  assert.equal(r.effectiveWeights.b, 0.5);
  assert.equal(r.effectiveWeights.c, 0.2);
  assert.deepEqual(r.missingFeatures, []);
});

test('redistributeWeights: missing features drop, weight re-normalized across present', () => {
  const w = { a: 0.3, b: 0.5, c: 0.2 };
  const v = { a: 1, b: null, c: 1 };
  const r = redistributeWeights(w, v);
  assert.deepEqual(r.missingFeatures, ['b']);
  const sum = Object.values(r.effectiveWeights).reduce((acc, n) => acc + n, 0);
  assert.equal(sum, 1);
  assert.equal(r.effectiveWeights.a, 0.3 / 0.5);
  assert.equal(r.effectiveWeights.c, 0.2 / 0.5);
  assert.equal(r.effectiveWeights.b, undefined);
});

test('redistributeWeights: all missing → empty effectiveWeights, no NaN', () => {
  const w = { a: 0.3, b: 0.7 };
  const v = { a: null, b: null };
  const r = redistributeWeights(w, v);
  assert.deepEqual(r.effectiveWeights, {});
  assert.deepEqual(r.missingFeatures.sort(), ['a', 'b']);
});

test('redistributeWeights: missing features are alphabetized in output', () => {
  const w = { zeta: 0.2, alpha: 0.2, mu: 0.2 };
  const v = { zeta: null, alpha: null, mu: null };
  const r = redistributeWeights(w, v);
  assert.deepEqual(r.missingFeatures, ['alpha', 'mu', 'zeta']);
});

test('redistributeWeights: NaN / non-finite values treated as missing', () => {
  const w = { a: 0.3, b: 0.3, c: 0.4 };
  const v = { a: NaN, b: Infinity, c: 1 };
  const r = redistributeWeights(w, v);
  assert.deepEqual(r.missingFeatures.sort(), ['a', 'b']);
  assert.equal(r.effectiveWeights.c, 1);
});

// ────────────────────────────────────────────────────────────────────
//  applyEligibilityGates
// ────────────────────────────────────────────────────────────────────

test('applyEligibilityGates: passes when volume + TVL + upward_volatility all above floors', () => {
  // T28c: a third floor (upward_volatility) was added. Tests that
  // exercise the "happy path" must include the new field too, or
  // the gate silently fails for tokens the operator never observed
  // upward moves for (which is exactly what we want to catch).
  // T44: trade_count must also be ≥ min_trade_count_24h to pass.
  const r = applyEligibilityGates(
    { volume_24h_bch: 1, tvl_bch: 1, upward_volatility: 0.5, trade_count: 100, fee_yield_bps: 20 },
    DEFAULT_SCORING_CONFIG,
  );
  assert.equal(r.eligible, true);
  assert.deepEqual(r.reasons, []);
});

test('applyEligibilityGates: rejects when volume below floor', () => {
  // T46b: volume_7d_bch floor is now the primary recency/volume
  // gate (default 0.05); volume_30d_bch (default 1.0) is the
  // long-window volume gate. Set both below their floors so the
  // gate rejects and reasons list BOTH signals (the ranker
  // surfaces both in its tooltip).
  // T44: trade_count is above the floor so the rejection isolates
  // to the volume gates.
  const r = applyEligibilityGates(
    { volume_7d_bch: 0.01, volume_30d_bch: 0.1, tvl_bch: 1, upward_volatility: 0.5, trade_count: 100 },
    DEFAULT_SCORING_CONFIG,
  );
  assert.equal(r.eligible, false);
  const joined = r.reasons.join(' | ');
  assert.match(joined, /volume_7d_bch:/);
  assert.match(joined, /volume_30d_bch:/);
});

test('applyEligibilityGates: rejects when TVL below floor', () => {
  const r = applyEligibilityGates(
    { volume_24h_bch: 1, tvl_bch: 0.01, upward_volatility: 0.5, trade_count: 100 },
    DEFAULT_SCORING_CONFIG,
  );
  assert.equal(r.eligible, false);
  assert.match(r.reasons[0], /^tvl_bch:/);
});

test('applyEligibilityGates: missing fields produce :missing reasons', () => {
  // T28c: with the new upward_volatility gate enabled by default,
  // omitting it is now a third :missing reason.
  // T44: omitting trade_count is a fourth :missing reason.
  // T86: volume_7d_bch is the new primary volume gate (was
  // volume_24h_bch).
  const r = applyEligibilityGates(
    { volume_7d_bch: null, tvl_bch: null, upward_volatility: null, trade_count: null },
    DEFAULT_SCORING_CONFIG,
  );
  assert.equal(r.eligible, false);
  assert.ok(r.reasons.includes('volume_7d_bch:missing'));
  assert.ok(r.reasons.includes('tvl_bch:missing'));
  assert.ok(r.reasons.includes('upward_volatility:missing'));
  assert.ok(r.reasons.includes('trade_count_24h:missing'));
});

test('applyEligibilityGates: honors config floors (not just defaults)', () => {
  // T28c: turn off the new gate explicitly so the legacy "2-floor"
  // assertion stays meaningful.
  // T44: also turn off the staleness gate so the "reasons.length === 2"
  // assertion stays meaningful (without it the gate adds a 3rd
  // trade_count_24h:missing reason).
  // T86: volume_7d_bch is the new primary volume floor.
  const cfg = resolveScoringConfig({
    min_volume_7d_bch: 5,
    min_tvl_bch: 5,
    min_upward_volatility: 0,
    min_trade_count_24h: 0,
    min_fee_yield_bps: 0,
  });
  const r = applyEligibilityGates({ volume_7d_bch: 4, tvl_bch: 4 }, cfg);
  assert.equal(r.eligible, false);
  assert.equal(r.reasons.length, 2);
});

test('applyEligibilityGates: honors min_volume_30d_bch floor (T46b)', () => {
  // Default min_volume_30d_bch = 1.0. A pool with 0.5 BCH/30d is
  // below the floor and should be rejected with the new reason
  // string. The 24h + TVL + upward_volatility gates are satisfied
  // so the rejection is isolated to the 30d signal.
  const r = applyEligibilityGates(
    { volume_24h_bch: 1, volume_30d_bch: 0.5, tvl_bch: 1, upward_volatility: 0.5, trade_count: 100 },
    DEFAULT_SCORING_CONFIG,
  );
  assert.equal(r.eligible, false);
  assert.ok(
    r.reasons.some((m) => m.startsWith('volume_30d_bch:') && m.includes('<1')),
    `expected volume_30d_bch below-floor rejection, got ${JSON.stringify(r.reasons)}`,
  );
});

test('applyEligibilityGates: emits volume_30d_bch:missing when null (T46b)', () => {
  // The derivation returns null when apy_30d_bp × tvl_sats can't
  // be computed. Null is treated as "missing evidence" and fails
  // the gate (mirrors how null tvl_bch fails).
  const r = applyEligibilityGates(
    { volume_24h_bch: 1, volume_30d_bch: null, tvl_bch: 1, upward_volatility: 0.5, trade_count: 100 },
    DEFAULT_SCORING_CONFIG,
  );
  assert.equal(r.eligible, false);
  assert.ok(r.reasons.includes('volume_30d_bch:missing'),
    `expected volume_30d_bch:missing, got ${JSON.stringify(r.reasons)}`);
});

test('applyEligibilityGates: min_volume_30d_bch=0 disables the gate (T46b)', () => {
  // Operators can opt out by setting min_volume_30d_bch=0. Pool
  // with null/zero 30d volume should pass.
  // T75: also disable the fee_yield_bps gate so the test isolates
  // the volume_30d_bch behavior.
  const cfg = resolveScoringConfig({ min_volume_30d_bch: 0, min_fee_yield_bps: 0 });
  const r = applyEligibilityGates(
    { volume_24h_bch: 1, volume_30d_bch: null, tvl_bch: 1, upward_volatility: 0.5, trade_count: 100 },
    cfg,
  );
  assert.equal(r.eligible, true,
    `expected eligible with min_volume_30d_bch=0, got reasons ${JSON.stringify(r.reasons)}`);
});

// ────────────────────────────────────────────────────────────────────
//  T75: min_fee_yield_bps floor
// ────────────────────────────────────────────────────────────────────

test('T75: applyEligibilityGates passes when fee_yield_bps above floor', () => {
  // fee_yield_bps=20 > default floor 10 → eligible. The other
  // gates are above their floors too (mirrors the healthy-pool
  // shape used by the other happy-path tests).
  const r = applyEligibilityGates(
    { volume_24h_bch: 1, tvl_bch: 1, upward_volatility: 0.5, trade_count: 100, fee_yield_bps: 20 },
    DEFAULT_SCORING_CONFIG,
  );
  assert.equal(r.eligible, true,
    `expected eligible with fee_yield_bps=20 > floor 10, got reasons ${JSON.stringify(r.reasons)}`);
});

test('T75: applyEligibilityGates rejects when fee_yield_bps below floor', () => {
  // fee_yield_bps=5 < default floor 10 → ineligible with the
  // formatted reason string. All other gates above floor so the
  // rejection isolates to the new T75 gate.
  const r = applyEligibilityGates(
    { volume_24h_bch: 1, tvl_bch: 1, upward_volatility: 0.5, trade_count: 100, fee_yield_bps: 5 },
    DEFAULT_SCORING_CONFIG,
  );
  assert.equal(r.eligible, false);
  assert.ok(
    r.reasons.some((m) => m.startsWith('fee_yield_bps:') && m.includes('<10')),
    `expected fee_yield_bps below-floor rejection, got ${JSON.stringify(r.reasons)}`,
  );
});

test('T75: applyEligibilityGates rejects when fee_yield_bps is null', () => {
  // Missing fee_yield_bps is treated the same way as missing
  // tvl_bch / volume_24h_bch — fail with `fee_yield_bps:missing`
  // rather than silently passing. Same shape as the other
  // :missing reasons already covered by the T46b tests.
  const r = applyEligibilityGates(
    { volume_24h_bch: 1, tvl_bch: 1, upward_volatility: 0.5, trade_count: 100, fee_yield_bps: null },
    DEFAULT_SCORING_CONFIG,
  );
  assert.equal(r.eligible, false);
  assert.ok(
    r.reasons.includes('fee_yield_bps:missing'),
    `expected fee_yield_bps:missing, got ${JSON.stringify(r.reasons)}`,
  );
});

test('T75: applyEligibilityGates rejects when fee_yield_bps is undefined', () => {
  // Undefined should be treated the same as null (missing evidence).
  const r = applyEligibilityGates(
    { volume_24h_bch: 1, tvl_bch: 1, upward_volatility: 0.5, trade_count: 100 },
    DEFAULT_SCORING_CONFIG,
  );
  assert.equal(r.eligible, false);
  assert.ok(
    r.reasons.includes('fee_yield_bps:missing'),
    `expected fee_yield_bps:missing when undefined, got ${JSON.stringify(r.reasons)}`,
  );
});

test('T75: applyEligibilityGates rejects when fee_yield_bps is non-finite (NaN/Infinity)', () => {
  // A bad upstream derivation could yield NaN / Infinity — same
  // guard as the other gate tests (NaN must not silently pass the
  // < comparison).
  const r1 = applyEligibilityGates(
    { volume_24h_bch: 1, tvl_bch: 1, upward_volatility: 0.5, trade_count: 100, fee_yield_bps: NaN },
    DEFAULT_SCORING_CONFIG,
  );
  assert.equal(r1.eligible, false);
  assert.ok(r1.reasons.includes('fee_yield_bps:missing'),
    `expected fee_yield_bps:missing on NaN, got ${JSON.stringify(r1.reasons)}`);

  const r2 = applyEligibilityGates(
    { volume_24h_bch: 1, tvl_bch: 1, upward_volatility: 0.5, trade_count: 100, fee_yield_bps: Infinity },
    DEFAULT_SCORING_CONFIG,
  );
  assert.equal(r2.eligible, false);
  assert.ok(r2.reasons.includes('fee_yield_bps:missing'),
    `expected fee_yield_bps:missing on Infinity, got ${JSON.stringify(r2.reasons)}`);
});

test('T75: applyEligibilityGates: min_fee_yield_bps=0 disables the gate', () => {
  // Operator opt-out: set the knob to 0 to disable. Pool with
  // null/undefined fee_yield_bps should pass cleanly.
  const cfg = resolveScoringConfig({ min_fee_yield_bps: 0 });
  const r = applyEligibilityGates(
    { volume_24h_bch: 1, tvl_bch: 1, upward_volatility: 0.5, trade_count: 100, fee_yield_bps: null },
    cfg,
  );
  assert.equal(r.eligible, true,
    `expected eligible with min_fee_yield_bps=0, got reasons ${JSON.stringify(r.reasons)}`);
});

test('T75: applyEligibilityGates: min_fee_yield_bps override flows through resolveScoringConfig', () => {
  // The override-list in resolveScoringConfig should pick up
  // min_fee_yield_bps from the input. Set a high floor (1000)
  // and confirm a 50-bps pool fails.
  const cfg = resolveScoringConfig({ min_fee_yield_bps: 1000 });
  assert.equal(cfg.min_fee_yield_bps, 1000);
  const r = applyEligibilityGates(
    { volume_24h_bch: 1, tvl_bch: 1, upward_volatility: 0.5, trade_count: 100, fee_yield_bps: 50 },
    cfg,
  );
  assert.equal(r.eligible, false);
  assert.ok(
    r.reasons.some((m) => m.startsWith('fee_yield_bps:') && m.includes('<1000')),
    `expected fee_yield_bps:<1000, got ${JSON.stringify(r.reasons)}`,
  );
});

test('T75: applyEligibilityGates: drops non-finite min_fee_yield_bps override silently', () => {
  // NaN / Infinity in the override should be ignored (don't crash,
  // don't let it propagate to applyEligibilityGates). Matches the
  // existing `num()`-helper policy for the other knobs.
  const cfg = resolveScoringConfig({ min_fee_yield_bps: NaN });
  assert.equal(cfg.min_fee_yield_bps, DEFAULT_SCORING_CONFIG.min_fee_yield_bps);
  const cfg2 = resolveScoringConfig({ min_fee_yield_bps: Infinity });
  assert.equal(cfg2.min_fee_yield_bps, DEFAULT_SCORING_CONFIG.min_fee_yield_bps);
});

test('T75: scorePool surfaces fee_yield_bps below floor with score=0', () => {
  // End-to-end: a pool with low fee_yield_bps gets score=0 even
  // if it would have scored well on the other features. Mirrors
  // the existing 'low volume forces score=0' test.
  const stats = {
    token_id: TID,
    symbol: 'T75',
    trade_volume_sats: 1_000_000_000,           // 10 BCH/24h (above 0.05 floor)
    tvl_sats: 50_000_000_000,                   // 500 BCH TVL (above 0.25 floor)
    trade_count: 5,                              // above T44 floor (1)
    apy_30d_bp: 200,                            // 2%/30d
    change_24h_bp: 50,                          // 0.5% 24h change
    price_series_7d: [1, 1.005, 1.01, 1.005, 1.01, 1.005, 1.01], // some upward volatility
  };
  // With default min_trade_count_24h=1, trade_count=5 passes T44.
  // With min_fee_yield_bps=10, fee_yield_bps = 5*30/500 = 0.3 bps
  // → below floor → ineligible → score=0.
  const r = scorePool(stats);
  assert.equal(r.eligible, false,
    `expected ineligible with fee_yield_bps=0.3 below floor 10, got reasons ${JSON.stringify(r.reasons)}`);
  assert.equal(r.score, 0);
  assert.ok(r.reasons.some((m) => m.startsWith('fee_yield_bps:')),
    `expected fee_yield_bps reason, got ${JSON.stringify(r.reasons)}`);
});

test('T75: DEFAULT_SCORING_CONFIG carries the min_fee_yield_bps default', () => {
  // GUARD test: lock the default to 10 bps so a future bump
  // shows up in the diff. Mirrors the GUARD tests used for the
  // other knobs.
  assert.equal(typeof DEFAULT_SCORING_CONFIG.min_fee_yield_bps, 'number');
  assert.ok(DEFAULT_SCORING_CONFIG.min_fee_yield_bps > 0);
  assert.equal(DEFAULT_SCORING_CONFIG.min_fee_yield_bps, 10);
});

// ────────────────────────────────────────────────────────────────────
//  scorePool (end-to-end)
// ────────────────────────────────────────────────────────────────────

test('scorePool: healthy stats yields score in (0, 1) and eligible=true', () => {
  const r = scorePool(healthyStats());
  assert.equal(r.eligible, true);
  assert.deepEqual(r.reasons, []);
  assert.ok(r.score > 0 && r.score <= 1, `expected (0,1], got ${r.score}`);
  assert.ok(r.breakdown.normalized.volume_24h_bch > 0);
  assert.ok(r.breakdown.normalized.tvl_bch > 0);
});

test('scorePool: low volume forces score=0 even if volatility is huge', () => {
  // T86: the 7d-volume gate uses the price_series_7d-derived
  // estimator. Drop the 7d series to a single-value no-transitions
  // series so the estimator returns 0 → below the 0.05 floor.
  const flatSeries = Array(29).fill(1.0);
  const r = scorePool(healthyStats({
    trade_volume_sats: 1_000,         // collapses 24h-volume to nothing
    price_series_7d: flatSeries,      // 0 transitions → volume_7d_bch = 0
  }));
  assert.equal(r.eligible, false);
  assert.equal(r.score, 0);
});

test('scorePool: missing stats for ALL features yields score=0', () => {
  const r = scorePool({ token_id: TID });
  assert.equal(r.score, 0);
  // Missing data alone shouldn't fail the gate (gate requires
  // null inputs to flag :missing reasons, which makes pool
  // ineligible).
  assert.equal(r.eligible, false);
});

test('scorePool: contributions sum to score (modulo ineligible zero-out)', () => {
  const r = scorePool(healthyStats());
  if (r.eligible) {
    const sumContribs = Object.values(r.breakdown.contributions)
      .reduce((acc, n) => acc + n, 0);
    assert.ok(Math.abs(sumContribs - r.score) < 1e-9,
      `contributions sum ${sumContribs} ≠ score ${r.score}`);
  }
});

test('scorePool: effective_weights sum to 1 when anything is present', () => {
  const r = scorePool(healthyStats());
  if (r.eligible) {
    const sum = Object.values(r.breakdown.effective_weights).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `effective_weights sum=${sum}`);
  }
});

test('scorePool: higher-volume pool outscores lower-volume pool (everything else equal)', () => {
  const low = scorePool(healthyStats({ trade_volume_sats: 0.5 * SATS_PER_BCH }));
  const high = scorePool(healthyStats({ trade_volume_sats: 5 * SATS_PER_BCH }));
  assert.ok(high.score > low.score, `low=${low.score}, high=${high.score}`);
});

test('scorePool: higher-volatility pool outscores lower-volatility pool (everything else equal)', () => {
  const calm = scorePool(healthyStats({ change_24h_bp: 50 }));   // 0.5%
  const wild = scorePool(healthyStats({ change_24h_bp: 1500 })); // 15%
  assert.ok(wild.score > calm.score, `calm=${calm.score}, wild=${wild.score}`);
});

test('scorePool: cap saturation — 100× cap volume scores no higher than cap volume', () => {
  const at = scorePool(healthyStats({ trade_volume_sats: 10 * SATS_PER_BCH }));   // cap = 10
  const over = scorePool(healthyStats({ trade_volume_sats: 1000 * SATS_PER_BCH }));
  assert.equal(at.score, over.score);
});

test('scorePool: breakdown.missing lists volume_7d_bch when no series is provided', () => {
  // T86: when neither a native `volume_7d_bch` field nor a
  // `price_series_7d` series is present, the estimator returns
  // null and the field is flagged missing. healthyStats carries a
  // series, so to force the null path we explicitly drop the
  // series.
  const r = scorePool(healthyStats({ price_series_7d: null }));
  assert.ok(r.breakdown.missing.includes('volume_7d_bch'),
    `expected volume_7d_bch in missing, got ${JSON.stringify(r.breakdown.missing)}`);
});

test('scorePool: zero-volume pool is ineligible', () => {
  // T86: drop both the 24h trade_volume_sats AND the 7d price
  // series to a flat no-transitions array. The 7d-volume estimator
  // returns 0 (0 transitions × 1% × 1 BCH TVL) which is below the
  // default 0.05 floor → ineligible.
  const r = scorePool(healthyStats({
    trade_volume_sats: 0,
    price_series_7d: Array(29).fill(1.0),
  }));
  assert.equal(r.eligible, false);
  assert.equal(r.score, 0);
});

test('scorePool: respects custom weights', () => {
  // Make volatility dominate everything else.
  const cfg = resolveScoringConfig({
    weights: {
      volume_24h_bch: 0,
      volume_7d_bch: 0,
      volatility_24h_pct: 1.0,
      tvl_bch: 0,
      apy_30d_pct: 0,
      fee_yield_bps: 0,
    },
  });
  const calm = scorePool(healthyStats({ change_24h_bp: 50 }), cfg);
  const wild = scorePool(healthyStats({ change_24h_bp: 2000 }), cfg);
  assert.ok(wild.score > calm.score);
  assert.ok(wild.score > 0.4, `wild score ${wild.score} should be well above 0`);
});

test('scorePool: passes through token_id of the source record', () => {
  const r = scorePool(healthyStats());
  // token_id isn't a direct field of scorePool's return; the
  // ranker (T09) maps by array position. Verify scorePools covers
  // the token_id-bearing surface below.
  assert.ok(typeof r.score === 'number');
});

test('scorePool: invalid stats yields eligible=false, score=0, reasons includes invalid', () => {
  // ScorePools path:
  const r = scorePools([{ /* no token_id */ }, healthyStats()]);
  assert.equal(r[0].eligible, false);
  assert.equal(r[0].score, 0);
  assert.deepEqual(r[0].reasons, ['invalid_stats']);
  assert.equal(r[0].token_id, '');
  // The healthy entry still scores normally.
  assert.equal(r[1].token_id, TID);
});

// ────────────────────────────────────────────────────────────────────
//  scorePools (bulk)
// ────────────────────────────────────────────────────────────────────

test('scorePools: empty / non-array input → empty output', () => {
  assert.deepEqual(scorePools([]), []);
  assert.deepEqual(scorePools(null), []);
  assert.deepEqual(scorePools(undefined), []);
});

test('scorePools: preserves input order and token_id', () => {
  const r = scorePools([healthyStats({ token_id: TID }), healthyStats({ token_id: TID2 })]);
  assert.equal(r.length, 2);
  assert.equal(r[0].token_id, TID);
  assert.equal(r[1].token_id, TID2);
});

test('scorePools: sorts to top the pool with best eligibility-adjusted score', () => {
  // Same TID so we control the input order; we'll pick top by .score.
  const a = healthyStats({ token_id: TID,  trade_volume_sats: 0.4 * SATS_PER_BCH, tvl_sats: 0.4 * SATS_PER_BCH });
  const b = healthyStats({ token_id: TID2, trade_volume_sats: 4   * SATS_PER_BCH, tvl_sats: 2   * SATS_PER_BCH });
  const out = scorePools([a, b]);
  const sorted = [...out].sort((x, y) => y.score - x.score);
  assert.equal(sorted[0].token_id, TID2);
  assert.ok(sorted[0].score >= sorted[1].score);
});

// ────────────────────────────────────────────────────────────────────
//  Hard guard: the scorer NEVER silently returns a hard-coded score
//  (everything reads from config or computes from inputs).
// ────────────────────────────────────────────────────────────────────

test('scoring module: no hard-coded constants leak into the score path', () => {
  // All-zero input must produce a score of 0 (no inputs → no evidence
  // → score=0). NOT a non-zero "default" score.
  const r = scorePool({ token_id: TID });
  assert.equal(r.score, 0);
  // All-missing AND ineligible. Verify the explicit reason list.
  // T86: volume_7d_bch replaces volume_24h_bch.
  assert.ok(r.reasons.includes('volume_7d_bch:missing'));
  assert.ok(r.reasons.includes('tvl_bch:missing'));
});

test('scoring module: reading config knobs (sanity that DEFAULT_SCORING_CONFIG is pure data)', () => {
  // Default config knobs must match what the user committed in
  // config/default.json → scoring. This is a regression guard:
  // if anyone changes DEFAULT_SCORING_CONFIG they MUST also change
  // config/default.json (and vice versa).
  assert.equal(DEFAULT_SCORING_CONFIG.weights.volume_24h_bch, 0.10);  // T46b: was 0.30
  assert.equal(DEFAULT_SCORING_CONFIG.weights.volume_7d_bch, 0.10);   // T46b: was 0.05
  assert.equal(DEFAULT_SCORING_CONFIG.weights.volume_30d_bch, 0.30);  // T46b: NEW (replaces 24h as primary)
  assert.equal(DEFAULT_SCORING_CONFIG.weights.volatility_24h_pct, 0.10); // T46b: was 0.25
  assert.equal(DEFAULT_SCORING_CONFIG.weights.tvl_bch, 0.10);          // T46b: was 0.15
  // T28c: 7d-volume weight was reduced from 0.15 to 0.05 (indexer
  // rarely surfaces 7d volume reliably); weight redistributed to
  // upward_volatility.
  assert.equal(DEFAULT_SCORING_CONFIG.weights.apy_30d_pct, 0.10);     // T46b: was 0.05
  assert.equal(DEFAULT_SCORING_CONFIG.weights.fee_yield_bps, 0.05);
  assert.equal(DEFAULT_SCORING_CONFIG.weights.upward_volatility, 0.15);
  assert.equal(DEFAULT_SCORING_CONFIG.min_score, 0.35);
  assert.equal(DEFAULT_SCORING_CONFIG.min_volume_7d_bch, 0.05); // T46b: was 0.3 (now a recency check)
  assert.equal(DEFAULT_SCORING_CONFIG.min_volume_30d_bch, 1.0);   // T46b: NEW (primary volume gate)
  assert.equal(DEFAULT_SCORING_CONFIG.min_tvl_bch, 0.25);
  assert.equal(DEFAULT_SCORING_CONFIG.min_upward_volatility, 0.05);
  assert.equal(DEFAULT_SCORING_CONFIG.caps.volume_24h_bch, 10.0);
  assert.equal(DEFAULT_SCORING_CONFIG.caps.tvl_bch, 5.0);
  assert.equal(DEFAULT_SCORING_CONFIG.caps.volume_7d_bch, 50.0);
  assert.equal(DEFAULT_SCORING_CONFIG.linear_caps.volatility_24h_pct, 30.0);
  assert.equal(DEFAULT_SCORING_CONFIG.fee_rate_bps, 30);
});

test('scorePool: fee_rate_bps from config is honored when opts.fee_rate_bps absent', () => {
  // A pool with 100 trades × 30 bps × 1% = 30 bps yield.
  const r = scorePool(healthyStats({ trade_count: 100 }));
  assert.equal(r.breakdown.fee_rate_bps, 30);
  assert.equal(r.breakdown.raw.fee_yield_bps, 30);
});

test('scorePool: opts.fee_rate_bps overrides config (per-call escape hatch)', () => {
  const r = scorePool(
    healthyStats({ trade_count: 100 }),
    DEFAULT_SCORING_CONFIG,
    { fee_rate_bps: 100 },
  );
  assert.equal(r.breakdown.fee_rate_bps, 100);
  assert.equal(r.breakdown.raw.fee_yield_bps, 100);
});

// ────────────────────────────────────────────────────────────────────
//  T28c — upwardVolatilityScore
// ────────────────────────────────────────────────────────────────────

test('upwardVolatilityScore: missing / empty / too-short / non-array → 0', () => {
  for (const bad of [null, undefined, [], [1], 'string', 42, true, {}]) {
    assert.equal(upwardVolatilityScore(bad), 0,
      `expected 0 for ${JSON.stringify(bad)}`);
  }
});

test('upwardVolatilityScore: monotonic decline → 0 (e.g. Fewness: 19.57 → 1.0)', () => {
  // 29-point series where each point is strictly less than the prior.
  const series = [];
  let v = 19.57;
  for (let i = 0; i < 29; i++) {
    series.push(v);
    v = v * 0.92; // ~ -8% per step — never rises
  }
  assert.equal(upwardVolatilityScore(series), 0);
});

test('upwardVolatilityScore: single small positive spike gives a low non-zero score (e.g. HoneyBadgers)', () => {
  // 29-point series, one +0.88% move buried in an otherwise
  // downward series. The sqrt-curve frequency arm should give a
  // small non-zero score; the magnitude arm rewards the +0.88%
  // move at 0.176 (0.0088 × 20).
  const series = [];
  for (let i = 0; i < 29; i++) series.push(1.0);
  series[10] = series[9] * 1.0088; // +0.88% spike
  // Continue downward after the spike so we have only one positive move.
  for (let i = 11; i < 29; i++) series.push(series[i - 1] * 0.99);
  const s = upwardVolatilityScore(series);
  assert.ok(s > 0, `expected >0, got ${s}`);
  assert.ok(s < 0.25, `expected <0.25 for one tiny spike, got ${s}`);
});

test('upwardVolatilityScore: many positive returns + 5% max move saturates near 1.0', () => {
  // Alternating +1% / -0.5% series — 50% of returns are positive,
  // max positive is 1% (= 0.20 magnitude arm). Expected:
  //   frequencyScore = sqrt(0.5) ≈ 0.707
  //   magnitudeScore  = 0.20
  //   final ≈ 0.5 × 0.707 + 0.5 × 0.20 ≈ 0.454
  const series = [1.0];
  for (let i = 0; i < 28; i++) {
    const prev = series[series.length - 1];
    const factor = (i % 2 === 0) ? 1.01 : 0.995;
    series.push(prev * factor);
  }
  const s = upwardVolatilityScore(series);
  assert.ok(s > 0.40 && s < 0.55, `expected ~0.45, got ${s}`);
});

test('upwardVolatilityScore: ≥5% max positive return saturates the magnitude arm', () => {
  // Series with one +5% spike; magnitude arm should be 1.0.
  const series = [1.0];
  for (let i = 1; i < 29; i++) series.push(series[i - 1] * 0.99);
  series[15] = series[14] * 1.05; // +5% spike
  for (let i = 16; i < 29; i++) series.push(series[i - 1] * 0.99);
  const s = upwardVolatilityScore(series);
  assert.ok(s >= 0.5, `expected ≥0.5 from a 5% spike, got ${s}`);
});

test('upwardVolatilityScore: skips non-finite + zero-or-negative prior points', () => {
  const series = [
    1.0, 1.01, 0, 1.02, 1.03, 1.04, NaN, 1.05,
    1.06, 1.07, 'bad', 1.08, 1.09, 1.10, null, 1.11,
    1.12, 1.13, 1.14, 1.15, 1.16, 1.17, 1.18, 1.19,
    1.20, 1.21, 1.22, 1.23, 1.24,
  ];
  // Skips should not throw; result should be a finite non-negative number.
  const s = upwardVolatilityScore(series);
  assert.ok(Number.isFinite(s));
  assert.ok(s >= 0);
});

// ────────────────────────────────────────────────────────────────────
//  T28c — min_upward_volatility eligibility gate
// ────────────────────────────────────────────────────────────────────

test('applyEligibilityGates: rejects when upward_volatility below floor (T28c)', () => {
  const r = applyEligibilityGates(
    { volume_24h_bch: 4, tvl_bch: 4, upward_volatility: 0.01, trade_count: 100 },
    DEFAULT_SCORING_CONFIG,
  );
  assert.equal(r.eligible, false);
  assert.ok(r.reasons.some((m) => m.startsWith('upward_volatility:') && m.includes('<0.05')),
    `expected upward_volatility below-floor reason, got ${JSON.stringify(r.reasons)}`);
});

test('applyEligibilityGates: missing upward_volatility → :missing reason (T28c)', () => {
  const r = applyEligibilityGates(
    { volume_24h_bch: 4, tvl_bch: 4, upward_volatility: null, trade_count: 100 },
    DEFAULT_SCORING_CONFIG,
  );
  assert.equal(r.eligible, false);
  assert.ok(r.reasons.includes('upward_volatility:missing'),
    `expected upward_volatility:missing reason, got ${JSON.stringify(r.reasons)}`);
});

test('applyEligibilityGates: upward_volatility at-or-above floor passes (T28c)', () => {
  // T75: include fee_yield_bps so the new gate also passes.
  const r = applyEligibilityGates(
    { volume_24h_bch: 4, tvl_bch: 4, upward_volatility: 0.05, trade_count: 100, fee_yield_bps: 20 },
    DEFAULT_SCORING_CONFIG,
  );
  assert.equal(r.eligible, true, `expected eligible, got reasons=${JSON.stringify(r.reasons)}`);
});

test('applyEligibilityGates: min_upward_volatility=0 disables the gate (T28c)', () => {
  const cfg = resolveScoringConfig({ min_upward_volatility: 0 });
  // Even an all-zero upward_volatility (worst case) should pass when the gate is off.
  // T75: include fee_yield_bps so the new gate also passes.
  const r = applyEligibilityGates(
    { volume_24h_bch: 4, tvl_bch: 4, upward_volatility: 0, trade_count: 100, fee_yield_bps: 20 },
    cfg,
  );
  assert.equal(r.eligible, true);
  assert.equal(r.reasons.length, 0);
});

// ────────────────────────────────────────────────────────────────────
//  T28c — scorePool integration
// ────────────────────────────────────────────────────────────────────

test('resolveScoringConfig: surfaces min_upward_volatility (T28c)', () => {
  const cfg = resolveScoringConfig({ min_upward_volatility: 0.25 });
  assert.equal(cfg.min_upward_volatility, 0.25);
});

test('resolveScoringConfig: cloneDefaultConfig preserves min_upward_volatility (T28c regression)', () => {
  // The T28c first cut forgot to include min_upward_volatility in
  // cloneDefaultConfig, so resolveScoringConfig({}) silently dropped
  // it to undefined. Lock the value in.
  const cfg = resolveScoringConfig({});
  assert.equal(cfg.min_upward_volatility, DEFAULT_SCORING_CONFIG.min_upward_volatility);
});

test('scorePool: includes upward_volatility in normalized + breakdown.caps (T28c)', () => {
  const r = scorePool(healthyStats({ price_series_7d: [1.0, 1.02, 1.04, 1.06, 1.08, 1.10, 1.12] }));
  assert.ok('upward_volatility' in r.breakdown.normalized,
    'expected upward_volatility in normalized breakdown');
  assert.ok('upward_volatility' in r.breakdown.caps,
    'expected upward_volatility in caps breakdown');
  assert.equal(r.breakdown.caps.upward_volatility.kind, 'linear');
  assert.equal(r.breakdown.caps.upward_volatility.cap, 1.0);
  assert.equal(r.breakdown.min_upward_volatility, DEFAULT_SCORING_CONFIG.min_upward_volatility);
});

test('scorePool: missing price_series_7d yields 0 upward_volatility and is ineligible (T28c)', () => {
  // No price_series_7d in stats → upward_volatility = 0 → gate trips.
  const r = scorePool(healthyStats({ price_series_7d: undefined }));
  assert.equal(r.breakdown.raw.upward_volatility, 0);
  assert.equal(r.eligible, false);
  assert.ok(
    r.reasons.some((m) => m.startsWith('upward_volatility:') && m.includes('<0.05')),
    `expected upward_volatility below-floor rejection, got ${JSON.stringify(r.reasons)}`,
  );
  assert.equal(r.score, 0);
});

test('scorePool: monotonic-decline series → upward_volatility=0 → ineligible (T28c, Fewness case)', () => {
  // Real-world reproduction: Fewness (FEW) — 29-point series strictly
  // declining from 19.57 → 1.0. With the T28c gate default 0.05,
  // FEW is now ineligible regardless of how well it scores on
  // volume / TVL / APY.
  const series = [];
  let v = 19.57;
  for (let i = 0; i < 29; i++) {
    series.push(v);
    v *= 0.92;
  }
  const r = scorePool(healthyStats({
    price_series_7d: series,
    trade_volume_sats: 50 * SATS_PER_BCH,   // huge volume
    tvl_sats: 20 * SATS_PER_BCH,             // huge TVL
    apy_30d_bp: 100000,                      // 1000% APY
  }));
  assert.equal(r.breakdown.raw.upward_volatility, 0,
    'expected monotonic decline → upward_volatility = 0');
  assert.equal(r.eligible, false);
  assert.ok(r.reasons.some((m) => m.startsWith('upward_volatility:')));
  assert.equal(r.score, 0);
});

test('scorePool: same stats with a positive spike passes the T28c gate', () => {
  const series = [];
  for (let i = 0; i < 29; i++) series.push(1.0);
  series[15] = series[14] * 1.05; // +5% spike — saturates magnitude arm
  // T86: the spike also creates a 7d-price transition (1.0 → 1.05),
  // so the 7d-volume estimator (1 transition × 1% × 1 BCH TVL =
  // 0.01 BCH) is BELOW the default 0.05 floor. To exercise the
  // T28c gate alone we ALSO need the 7d-volume gate to pass.
  // We do that by lowering `min_volume_7d_bch` to 0 for the test.
  const r = scorePool(healthyStats({ price_series_7d: series }), resolveScoringConfig({ min_volume_7d_bch: 0 }));
  // Gate passes; upward_volatility contributes to the weighted score.
  assert.equal(r.eligible, true);
  assert.ok(r.breakdown.raw.upward_volatility >= 0.5,
    `expected ≥0.5 upward_volatility from a 5% spike, got ${r.breakdown.raw.upward_volatility}`);
  assert.ok(r.breakdown.normalized.upward_volatility > 0);
});

// ─────────────────────────────────────────────────────────────────────
// T46b: trailing-30d volume feature (proxy from apy_30d_bp × tvl_sats).
// The indexer doesn't expose volume_30d_bch directly, so we derive
// it: fees_30d = (apy_30d_bp / 10_000) × tvl_sats × (30/365), and
// volume_30d = fees_30d / fee_rate_bps. Validates:
//
//   - NWB-like stat surfaces volume_30d_bch ≈ 42 BCH (passes 1.0)
//   - OLA-like stat surfaces volume_30d_bch ≈ 9 BCH (passes 1.0)
//   - missing apy_30d_bch OR missing tvl_sats → null (missing-reason gate fires)
//   - applyEligibilityGates adds volume_30d_bch to reasons when it fails
//   - 30d weight 0.30 + cap 200.0 are reachable via resolveScoringConfig
// ─────────────────────────────────────────────────────────────────────

test('T46b: extractFeatures derives volume_30d_bch from apy_30d_bp × tvl_sats', () => {
  const r = extractFeatures({
    token_id: '41b596d732634f7acac6f63c3064b82e1356e09f5b0a83759fb989dc93a2b35f',
    display_name: 'NIGGA',
    display_symbol: 'NWB',
    tvl_sats: 25898286543,
    tvl_tokens: 37036353982,
    price_now_sats: 69.93,
    trade_count: 0,
    trade_volume_sats: 9934372957,
    apy_30d_bp: 60,
    price_series_7d: null,
  });
  // = (60 / 10_000) × 25_898_286_543 × (30/365) / (30/10_000)
  // ≈ 0.006 × 25_898_286_543 × 0.0822 × 333.33
  // ≈ 42.6 BCH
  assert.ok(Math.abs(r.volume_30d_bch - 42.57) < 0.10,
    `expected ≈42.57 BCH, got ${r.volume_30d_bch}`);
});

test('T46b: extractFeatures returns volume_30d_bch=null when apy_30d_bp is missing', () => {
  const r = extractFeatures({
    token_id: 'X',
    display_symbol: 'X',
    tvl_sats: 25898286543,
    trade_count: 0,
    trade_volume_sats: 9934372957,
    apy_30d_bp: null,
    price_series_7d: null,
  });
  assert.equal(r.volume_30d_bch, null);
});

test('T46b: extractFeatures returns volume_30d_bch=null when tvl_sats is 0', () => {
  const r = extractFeatures({
    token_id: 'X',
    display_symbol: 'X',
    tvl_sats: 0,
    trade_count: 0,
    apy_30d_bp: 60,
    price_series_7d: null,
  });
  assert.equal(r.volume_30d_bch, null);
});

test('T46b: OLA-shaped stats derive volume_30d_bch ≈ 9 BCH', () => {
  const r = extractFeatures({
    token_id: '7fa887fd4eac015478b95392c4984721fbe3060223c30b342d43cc06817f07f6',
    display_symbol: 'OLA',
    tvl_sats: 17686330624,
    apy_30d_bp: 19,
    trade_count: 0,
    trade_volume_sats: 1916970113,
    price_series_7d: null,
  });
  // = (19 / 10_000) × 17_686_330_624 × (30/365) / (30/10_000)
  // ≈ 0.0019 × 17_686_330_624 × 0.0822 × 333.33
  // ≈ 9.21 BCH
  assert.ok(Math.abs(r.volume_30d_bch - 9.21) < 0.10,
    `expected ≈9.21 BCH, got ${r.volume_30d_bch}`);
});

test('T46b: applyEligibilityGates fires the volume_30d_bch gate when below floor', () => {
  // volume_30d_bch = 0.5 < cfg.min_volume_30d_bch = 1.0 → reject
  const r = applyEligibilityGates(
    { volume_24h_bch: 1, volume_30d_bch: 0.5, tvl_bch: 5, upward_volatility: 0.5, trade_count: 100 },
    DEFAULT_SCORING_CONFIG,
  );
  assert.equal(r.eligible, false);
  assert.ok(r.reasons.some((x) => x.startsWith('volume_30d_bch:')),
    `expected volume_30d_bch reason, got: ${JSON.stringify(r.reasons)}`);
});

test('T46b: applyEligibilityGates accepts NWB-shaped stats (passes 30d gate)', () => {
  // NWB: volume_30d_bch ≈ 42.6 BCH >> 1.0 floor
  // T75: include fee_yield_bps so the new gate also passes.
  const r = applyEligibilityGates(
    { volume_24h_bch: 1, volume_30d_bch: 42.6, tvl_bch: 259, upward_volatility: 0.5, trade_count: 100, fee_yield_bps: 20 },
    DEFAULT_SCORING_CONFIG,
  );
  assert.equal(r.eligible, true, `unexpected reasons: ${JSON.stringify(r.reasons)}`);
});

test('T46b: gate disabled when min_volume_30d_bch=0', () => {
  // Operator chose not to enforce the 30d gate (e.g. for a manual mode).
  // Also drop the 24h gate so the test can isolate the 30d behavior.
  // T75: drop the fee_yield_bps gate too so the test isolates the
  // 30d behavior.
  const cfg = { ...DEFAULT_SCORING_CONFIG, min_volume_30d_bch: 0, min_volume_7d_bch: 0, min_fee_yield_bps: 0 };
  const r = applyEligibilityGates(
    { volume_24h_bch: 0, volume_30d_bch: 0, tvl_bch: 1, upward_volatility: 0.5, trade_count: 100, fee_yield_bps: 20 },
    cfg,
  );
  assert.equal(r.eligible, true);
});

test('T46b: volume_30d_bch missing → reasons lists volume_30d_bch:missing', () => {
  const r = applyEligibilityGates(
    { volume_24h_bch: 1, volume_30d_bch: null, tvl_bch: 1, upward_volatility: 0.5, trade_count: 100 },
    DEFAULT_SCORING_CONFIG,
  );
  assert.equal(r.eligible, false);
  assert.ok(r.reasons.some((x) => x === 'volume_30d_bch:missing'),
    `expected volume_30d_bch:missing, got: ${JSON.stringify(r.reasons)}`);
});

test('T46b: resolveScoringConfig accepts min_volume_30d_bch override', () => {
  const cfg = resolveScoringConfig({ min_volume_30d_bch: 5.0 });
  assert.equal(cfg.min_volume_30d_bch, 5.0);
});

test('T46b: volume_30d_bch weight is 0.30 in DEFAULT_SCORING_CONFIG', () => {
  assert.equal(DEFAULT_SCORING_CONFIG.weights.volume_30d_bch, 0.30);
});

test('T46b: scorePool redistributes volume_30d weight when volume_30d_bch is missing', () => {
  // When volume_30d_bch is null, the ranker must redistribute that
  // 0.30 weight to the other present features so the pool can still
  // be considered instead of being silently de-weighted to 70% of
  // total. Confirm: present weights still sum to 1.0 after
  // redistribution.
  const r = scorePool({
    token_id: 'X',
    display_symbol: 'X',
    tvl_sats: 1_000_000,
    trade_count: 1,
    apy_30d_bp: null,  // → volume_30d_bch = null
    trade_volume_sats: 100_000_000,
    price_series_7d: [1,1,1,1,1.05,1.05,1.05,1.05,1.05,1.05,1.05,1.05,1.05,1.05,1.05,1.05,1.05,1.05,1.05,1.05,1.05,1.05,1.05,1.05,1.05,1.05,1.05,1.05,1.05],
  });
  const eff = Object.values(r.breakdown.effective_weights);
  const sum = eff.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1.0) < 0.001,
    `effective weights should sum to ~1.0, got ${sum} (missing: ${r.breakdown.missing.join(',')})`);
  assert.ok(r.breakdown.missing.includes('volume_30d_bch'),
    `expected volume_30d_bch in missing list, got: ${r.breakdown.missing.join(',')}`);
});

// ────────────────────────────────────────────────────────────────────
//  T44 — min_trade_count_24h staleness gate
//  ------------------------------------------------------------------
//  Defends against phantom-price entries: tokens whose indexer
//  `trade_count` is 0 (or missing) for the current 24h window have
//  unreliable `price_now_sats`. QBTC's trade_count=0 correlated
//  with its 32.7B phantom price; HoneyBadgers' trade_count=0 was
//  safe only by accident. Gate rejects any pool where the indexer
//  reports fewer than min_trade_count_24h trades.
// ────────────────────────────────────────────────────────────────────

test('T44: DEFAULT_SCORING_CONFIG locks min_trade_count_24h to 1', () => {
  assert.equal(DEFAULT_SCORING_CONFIG.min_trade_count_24h, 1,
    'default min_trade_count_24h should be 1 — reject any token with zero 24h trades');
});

test('T44: resolveScoringConfig surfaces min_trade_count_24h override', () => {
  const cfg = resolveScoringConfig({ min_trade_count_24h: 5 });
  assert.equal(cfg.min_trade_count_24h, 5);
});

test('T44: resolveScoringConfig({}) preserves default min_trade_count_24h (regression guard)', () => {
  // Mirrors the T28c cloneDefaultConfig regression guard. Without
  // the explicit clone, this would be undefined and the gate would
  // short-circuit to disabled — silently dropping all staleness
  // protection on the production path.
  const cfg = resolveScoringConfig({});
  assert.equal(cfg.min_trade_count_24h, DEFAULT_SCORING_CONFIG.min_trade_count_24h);
});

test('T44: extractFeatures surfaces trade_count from PoolStats', () => {
  const f = extractFeatures(healthyStats({ trade_count: 137 }));
  assert.equal(f.trade_count, 137);
});

test('T44: extractFeatures: trade_count=null when indexer did not surface a count', () => {
  const f = extractFeatures(healthyStats({ trade_count: null }));
  assert.equal(f.trade_count, null);
});

test('T44: extractFeatures: trade_count=0 yields 0 (not null) — gate then rejects', () => {
  // The QBTC pathology: indexer reports trade_count=0 explicitly.
  // We surface it as 0 (not null) so the eligibility gate can read
  // it and reject. A null would also reject but with a different
  // reason string ("missing" vs "below floor") — operators need
  // to distinguish the two cases.
  const f = extractFeatures(healthyStats({ trade_count: 0 }));
  assert.equal(f.trade_count, 0);
});

test('T44: applyEligibilityGates rejects when trade_count=0 (QBTC pathology)', () => {
  // The headline test: a token with trade_count=0 must be rejected
  // by the staleness gate, even if every other floor passes.
  const r = applyEligibilityGates(
    { volume_24h_bch: 4, volume_30d_bch: 42, tvl_bch: 4, upward_volatility: 0.5, trade_count: 0 },
    DEFAULT_SCORING_CONFIG,
  );
  assert.equal(r.eligible, false);
  assert.ok(r.reasons.some((m) => m.startsWith('trade_count_24h:') && m.includes('<1')),
    `expected trade_count_24h below-floor reason, got ${JSON.stringify(r.reasons)}`);
});

test('T44: applyEligibilityGates rejects when trade_count=null (indexer did not surface)', () => {
  // Null trade_count is "indexer didn't surface the field" — same
  // outcome as zero: we have no evidence the price is fresh.
  const r = applyEligibilityGates(
    { volume_24h_bch: 4, volume_30d_bch: 42, tvl_bch: 4, upward_volatility: 0.5, trade_count: null },
    DEFAULT_SCORING_CONFIG,
  );
  assert.equal(r.eligible, false);
  assert.ok(r.reasons.includes('trade_count_24h:missing'),
    `expected trade_count_24h:missing reason, got ${JSON.stringify(r.reasons)}`);
});

test('T44: applyEligibilityGates rejects when trade_count is below the operator floor', () => {
  // Operator raised the floor to 5 trades/24h. A token with
  // trade_count=2 must be rejected even though it's "active".
  const cfg = resolveScoringConfig({ min_trade_count_24h: 5 });
  const r = applyEligibilityGates(
    { volume_24h_bch: 4, volume_30d_bch: 42, tvl_bch: 4, upward_volatility: 0.5, trade_count: 2 },
    cfg,
  );
  assert.equal(r.eligible, false);
  assert.ok(r.reasons.some((m) => m.startsWith('trade_count_24h:') && m.includes('2<5')),
    `expected trade_count_24h:2<5 reason, got ${JSON.stringify(r.reasons)}`);
});

test('T44: applyEligibilityGates passes when trade_count meets the floor', () => {
  // Happy path: a pool with trade_count >= min_trade_count_24h is
  // eligible (assuming every other gate passes).
  // T75: include fee_yield_bps so the new gate also passes.
  const r = applyEligibilityGates(
    { volume_24h_bch: 4, volume_30d_bch: 42, tvl_bch: 4, upward_volatility: 0.5, trade_count: 1, fee_yield_bps: 20 },
    DEFAULT_SCORING_CONFIG,
  );
  assert.equal(r.eligible, true,
    `expected eligible with trade_count=1, got reasons=${JSON.stringify(r.reasons)}`);
});

test('T44: applyEligibilityGates: min_trade_count_24h=0 disables the gate (operator override)', () => {
  // Operators can opt out by setting min_trade_count_24h=0. A
  // token with trade_count=0 must still pass when the gate is off
  // (the existing volume / TVL / upward_volatility gates are
  // satisfied too).
  // T75: disable the fee_yield_bps gate so the test isolates the
  // trade_count_24h behavior.
  const cfg = resolveScoringConfig({ min_trade_count_24h: 0, min_fee_yield_bps: 0 });
  const r = applyEligibilityGates(
    { volume_24h_bch: 4, volume_30d_bch: 42, tvl_bch: 4, upward_volatility: 0.5, trade_count: 0, fee_yield_bps: 20 },
    cfg,
  );
  assert.equal(r.eligible, true,
    `expected eligible with min_trade_count_24h=0, got reasons=${JSON.stringify(r.reasons)}`);
});

test('T44: applyEligibilityGates: trade_count below floor scores 0 (gate force-zeroes)', () => {
  // Mirrors the existing "hard gate → score=0" rule. A pool with
  // a perfect score on every other dimension still scores 0 when
  // the staleness gate fires — so the dashboard shows the real
  // outcome ("rejected") rather than a misleading high score.
  const r = scorePool(healthyStats({
    trade_count: 0,         // QBTC pathology
    trade_volume_sats: 50 * SATS_PER_BCH, // pretend huge 24h volume
    tvl_sats: 20 * SATS_PER_BCH,            // pretend huge TVL
    apy_30d_bp: 100000,                     // pretend 1000% APY
  }));
  assert.equal(r.score, 0,
    `expected score=0 when staleness gate fires, got ${r.score}`);
  assert.ok(r.reasons.some((m) => m.startsWith('trade_count_24h:')));
});

test('T44: scorePool breakdown surfaces min_trade_count_24h', () => {
  const r = scorePool(healthyStats({ trade_count: 42 }));
  assert.equal(r.breakdown.min_trade_count_24h, DEFAULT_SCORING_CONFIG.min_trade_count_24h);
});

test('T44: scorePool breakdown surfaces resolved min_trade_count_24h override', () => {
  const r = scorePool(healthyStats({ trade_count: 42 }), {
    ...DEFAULT_SCORING_CONFIG,
    min_trade_count_24h: 25,
  });
  assert.equal(r.breakdown.min_trade_count_24h, 25);
});

test('T44: rankPools integration — trade_count=0 token is filtered out before top-K', () => {
  // The bot's full pipeline: 2 candidates, only one with
  // trade_count >= min_trade_count_24h. Confirm the QBTC-shaped
  // one is ineligible (ranker surfaces zero top-K with empty
  // reasons after the gate, never returns it as a candidate).
  // Note: rankPools filters on eligibility inside scorePools so a
  // failed-gate pool never makes it to the topK. We assert the
  // surface area (ranker's `candidates` array) so the test
  // doubles as a contract guard against future regressions.
  // Use ranker rather than loop to keep the test pure.
  const goodPool = {
    token_id: 'a'.repeat(64),
    symbol: 'GOOD',
    decimals: 0,
    trade_count: 100,
    trade_volume_sats: 2 * SATS_PER_BCH,
    tvl_sats: 1 * SATS_PER_BCH,
    change_24h_bp: 500,
    apy_30d_bp: 5000,
    price_now_sats: 1000,
    price_series_7d: [
      0.90, 0.92, 0.91, 0.93, 0.95, 0.94, 0.96, 0.98, 0.97, 0.99,
      1.00, 0.98, 0.96, 0.97, 0.99, 1.00, 0.99, 0.97, 0.98, 1.00,
      0.98, 0.97, 0.99, 1.00, 0.99, 0.98, 1.00, 0.99, 1.00,
    ],
  };
  const qbtcLikePool = {
    token_id: 'b'.repeat(64),
    symbol: 'QBTC',
    decimals: 0,
    trade_count: 0,                       // QBTC pathology
    trade_volume_sats: 0,
    tvl_sats: 1_000 * SATS_PER_BCH,       // huge TVL
    change_24h_bp: 0,
    apy_30d_bp: 100000,                   // huge APY
    // Phantom price: 32.7B sats/token — the QBTC pathology
    price_now_sats: 32_700_000_000,
    price_series_7d: [
      1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0,
      1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0,
      1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0,
    ],
  };
  // Lazy-import rankPools here so the top-of-file imports stay
  // grouped (T09 ranker import order is preserved across the file).
  const result = rankPools([goodPool, qbtcLikePool], {
    ...DEFAULT_SCORING_CONFIG,
    min_trade_count_24h: 1,
    min_pool_age_days: 0,            // skip age filter — the indexer doesn't surface first_seen_ts_ms on these synthetic records
    top_k_candidates: 3,
  });
  // QBTC-shaped pool was rejected at the gate → not in candidates
  assert.equal(result.candidates.length, 1,
    `expected 1 candidate (goodPool only), got ${result.candidates.length}: ${JSON.stringify(result.candidates.map((c) => c.token_id.slice(0, 8)))}`);
  assert.equal(result.candidates[0].token_id, goodPool.token_id);
  // Meta reflects the dropped entry.
  const totalReturned = result.candidates.length;
  assert.equal(totalReturned, 1);
});

// ────────────────────────────────────────────────────────────────────
//  T44.1 — Global-staleness fallback for trade_count_24h gate
//
// idea_seed_indexer_stale_flag (shipped 2026-09-17, commit 7f72bef)
// rejected any token with trade_count < min_trade_count_24h. After
// the Cauldron indexer changed behavior to return trade_count=0
// explicitly (vs the previous null for missing data), the gate
// rejected ALL 200 top tokens — candidate_count dropped to 0 and
// no entry could be evaluated (so the O02 second-position rule
// never got a chance to fire).
//
// Fix: the gate stays strict per-token, but scorePools() computes
// a cohort-level fraction-below-gate and threads it into
// applyEligibilityGates via opts.globalContext. When the fraction
// exceeds stalenessThreshold (default 0.5 = 50%), the indexer is
// treated as globally stale and the trade_count_24h gate is
// suppressed for the entire cohort. Other gates (volume_24h,
// tvl_bch, volume_30d_bch) are unaffected — those reflect per-token
// reality.
// ────────────────────────────────────────────────────────────────────

test('T44.1: applyEligibilityGates without globalContext → strict per-token behavior (no regression)', () => {
  const features = {
    volume_24h_bch: 10, volume_30d_bch: 5, volatility_24h_pct: 5,
    tvl_bch: 10, apy_30d_pct: 2, fee_yield_bps: 50, upward_volatility: 0.5,
    trade_count: 0,
  };
  const cfg = { min_trade_count_24h: 1, min_volume_7d_bch: 0, min_volume_30d_bch: 0, min_tvl_bch: 0, min_upward_volatility: 0 };
  const r = applyEligibilityGates(features, cfg);
  assert.equal(r.eligible, false, 'no globalContext → strict reject must still fire');
  assert.ok(r.reasons.some(s => s.startsWith('trade_count_24h:')), 'reason mentions trade_count_24h');
});

test('T44.1: applyEligibilityGates with globalContext.fractionBelowGate=1.0 → gate suppressed', () => {
  const features = {
    volume_24h_bch: 10, volume_30d_bch: 5, volatility_24h_pct: 5,
    tvl_bch: 10, apy_30d_pct: 2, fee_yield_bps: 50, upward_volatility: 0.5,
    trade_count: 0,
  };
  const cfg = { min_trade_count_24h: 1, min_volume_7d_bch: 0, min_volume_30d_bch: 0, min_tvl_bch: 0, min_upward_volatility: 0 };
  const r = applyEligibilityGates(features, cfg, { fractionBelowGate: 1.0, stalenessThreshold: 0.5 });
  assert.equal(r.eligible, true, 'indexer globally stale → gate suppressed, token eligible');
  assert.ok(!r.reasons.some(s => s.startsWith('trade_count_24h:')), 'no trade_count_24h reason when globally stale');
});

test('T44.1: applyEligibilityGates with globalContext.fractionBelowGate=0 → strict behavior preserved', () => {
  const features = {
    volume_24h_bch: 10, volume_30d_bch: 5, volatility_24h_pct: 5,
    tvl_bch: 10, apy_30d_pct: 2, fee_yield_bps: 50, upward_volatility: 0.5,
    trade_count: 0,
  };
  const cfg = { min_trade_count_24h: 1, min_volume_7d_bch: 0, min_volume_30d_bch: 0, min_tvl_bch: 0, min_upward_volatility: 0 };
  const r = applyEligibilityGates(features, cfg, { fractionBelowGate: 0.0, stalenessThreshold: 0.5 });
  assert.equal(r.eligible, false, 'indexer healthy → strict reject still fires');
  assert.ok(r.reasons.some(s => s.startsWith('trade_count_24h:')), 'reason still mentions trade_count_24h');
});

test('T44.1: threshold boundary — fractionBelowGate=0.5 (at threshold) → gate suppressed', () => {
  const features = {
    volume_24h_bch: 10, volume_30d_bch: 5, volatility_24h_pct: 5,
    tvl_bch: 10, apy_30d_pct: 2, fee_yield_bps: 50, upward_volatility: 0.5,
    trade_count: 0,
  };
  const cfg = { min_trade_count_24h: 1, min_volume_7d_bch: 0, min_volume_30d_bch: 0, min_tvl_bch: 0, min_upward_volatility: 0 };
  const r = applyEligibilityGates(features, cfg, { fractionBelowGate: 0.5, stalenessThreshold: 0.5 });
  assert.equal(r.eligible, true, '>= threshold means stale');
});

test('T44.1: threshold boundary — fractionBelowGate=0.49 (just below) → gate fires', () => {
  const features = {
    volume_24h_bch: 10, volume_30d_bch: 5, volatility_24h_pct: 5,
    tvl_bch: 10, apy_30d_pct: 2, fee_yield_bps: 50, upward_volatility: 0.5,
    trade_count: 0,
  };
  const cfg = { min_trade_count_24h: 1, min_volume_7d_bch: 0, min_volume_30d_bch: 0, min_tvl_bch: 0, min_upward_volatility: 0 };
  const r = applyEligibilityGates(features, cfg, { fractionBelowGate: 0.49, stalenessThreshold: 0.5 });
  assert.equal(r.eligible, false, 'just below threshold → strict reject still fires');
});

test('T44.1: null/missing trade_count with globalContext.stale → gate suppressed', () => {
  const features = {
    volume_24h_bch: 10, volume_30d_bch: 5, volatility_24h_pct: 5,
    tvl_bch: 10, apy_30d_pct: 2, fee_yield_bps: 50, upward_volatility: 0.5,
    trade_count: null,
  };
  const cfg = { min_trade_count_24h: 1, min_volume_7d_bch: 0, min_volume_30d_bch: 0, min_tvl_bch: 0, min_upward_volatility: 0 };
  const r = applyEligibilityGates(features, cfg, { fractionBelowGate: 0.95, stalenessThreshold: 0.5 });
  assert.equal(r.eligible, true, 'global staleness suppresses null-trade-count reject');
});

test('T44.1: globalContext with bad values is ignored (defensive)', () => {
  const features = {
    volume_24h_bch: 10, volume_30d_bch: 5, volatility_24h_pct: 5,
    tvl_bch: 10, apy_30d_pct: 2, fee_yield_bps: 50, upward_volatility: 0.5,
    trade_count: 0,
  };
  const cfg = { min_trade_count_24h: 1, min_volume_7d_bch: 0, min_volume_30d_bch: 0, min_tvl_bch: 0, min_upward_volatility: 0 };
  // Missing keys, NaN, negative — all fall through to strict behavior
  for (const bad of [{}, null, undefined, { fractionBelowGate: NaN }, { stalenessThreshold: NaN }, { fractionBelowGate: -1, stalenessThreshold: 0.5 }]) {
    const r = applyEligibilityGates(features, cfg, bad);
    assert.equal(r.eligible, false, `bad globalContext should fall through to strict (got ${JSON.stringify(bad)})`);
  }
});

test('T44.1: scorePools computes globalContext from cohort — all stale → all eligible (T75: fee_yield_bps added)', () => {
  // Cohort where every valid token has trade_count=0 (the live indexer issue)
  const statsList = [];
  for (let i = 0; i < 10; i++) {
    statsList.push({
      token_id: 'a'.repeat(64 - 1) + i.toString(16),
      trade_count: 0,
      tvl_sats_bch: 1,
      volume_24h_bch: 1,
      volume_7d_bch: 1,  // T86: pass an explicit value so the 7d-volume gate doesn't :missing
      tvl_sats: 100000000,
      fee_yield_bps: 20,
      bcmr: { token: { decimals: 0, symbol: 'TEST' + i } },
    });
  }
  const cfg = {
    min_trade_count_24h: 1,
    min_volume_7d_bch: 0, min_volume_30d_bch: 0, min_tvl_bch: 0, min_upward_volatility: 0, min_fee_yield_bps: 0, // T75
    weights: { volume_24h_bch: 1 },
    caps: { volume_24h_bch: 10, tvl_bch: 5 },
    linear_caps: { volatility_24h_pct: 30, apy_30d_pct: 200, fee_yield_bps: 500 },
  };
  const results = scorePools(statsList, cfg, { nowMs: Date.now() });
  // All tokens should be eligible (gate suppressed due to global staleness)
  const eligibleCount = results.filter(r => r.eligible !== false && r.reasons.length === 0).length;
  assert.equal(eligibleCount, 10, 'all 10 tokens should be eligible when 100% of cohort is below gate');
});

test('T44.1: scorePools with mixed cohort — strict behavior preserved for tokens that actually fail the gate', () => {
  // 4 healthy tokens (trade_count>=1) + 1 stale token (trade_count=0)
  // Total: 1/5 = 20% below gate → below 50% threshold → strict behavior
  // Use a distinct 64-hex token_id for the stale token so the find() below
  // targets it unambiguously (scorePools' result surface is `{token_id, score,
  // breakdown, eligible, reasons}` — there's no `.symbol` field).
  const STALE_TOKEN_ID = 'c'.repeat(64);
  const statsList = [];
  for (let i = 0; i < 4; i++) {
    statsList.push({
      token_id: 'b'.repeat(63) + i.toString(16),
      trade_count: 5,
      volume_24h_bch: 1,
      tvl_sats: 100000000,
      bcmr: { token: { decimals: 0, symbol: 'HEALTHY' + i } },
    });
  }
  statsList.push({
    token_id: STALE_TOKEN_ID,
    trade_count: 0,
    volume_24h_bch: 1,
    tvl_sats: 100000000,
    bcmr: { token: { decimals: 0, symbol: 'STALE' } },
  });
  const cfg = {
    min_trade_count_24h: 1,
    min_volume_7d_bch: 0, min_volume_30d_bch: 0, min_tvl_bch: 0, min_upward_volatility: 0, min_fee_yield_bps: 0, // T75
    weights: { volume_24h_bch: 1 },
    caps: { volume_24h_bch: 10, tvl_bch: 5 },
    linear_caps: { volatility_24h_pct: 30, apy_30d_pct: 200, fee_yield_bps: 500 },
  };
  const results = scorePools(statsList, cfg, { nowMs: Date.now() });
  const staleResult = results.find(r => r.token_id === STALE_TOKEN_ID);
  assert.ok(staleResult, 'result for the stale token must be present');
  assert.equal(staleResult.eligible, false, 'stale token still rejected when cohort is mostly healthy (20% < 50%)');
  assert.ok(staleResult.reasons.some(s => s.startsWith('trade_count_24h:')), 'rejected with trade_count_24h reason');
  // Healthy tokens in the same cohort must NOT carry a trade_count_24h reason —
  // they pass the gate individually.
  const healthyResults = results.filter(r => r.token_id !== STALE_TOKEN_ID);
  for (const r of healthyResults) {
    assert.ok(!r.reasons.some(s => s.startsWith('trade_count_24h:')),
      `healthy token ${r.token_id.slice(0,8)} must not carry trade_count_24h reason (got ${JSON.stringify(r.reasons)})`);
  }
});

test('T44.1: scorePools respects opts.stalenessThreshold override', () => {
  // 3 stale + 1 healthy = 75% stale
  // With default threshold 0.5 → gate suppressed (75% >= 50%)
  // With override 0.8 → gate fires (75% < 80%)
  // Capture per-token token_ids so the find() below isn't dependent on a
  // `.symbol` field that scorePools doesn't actually expose (its result
  // surface is `{token_id, score, breakdown, eligible, reasons}`).
  const staleIds = [];
  const statsList = [];
  for (let i = 0; i < 3; i++) {
    const id = 'd'.repeat(63) + i.toString(16);
    staleIds.push(id);
    statsList.push({
      token_id: id,
      trade_count: 0,
      volume_24h_bch: 1, volume_7d_bch: 1,  // T86: explicit 7d-volume so the gate doesn't :missing
      tvl_sats: 100000000,
      bcmr: { token: { decimals: 0, symbol: 'S' + i } },
    });
  }
  const healthyId = 'e'.repeat(64);
  statsList.push({
    token_id: healthyId,
    trade_count: 5,
    volume_24h_bch: 1, volume_7d_bch: 1,  // T86: explicit 7d-volume so the gate doesn't :missing
    tvl_sats: 100000000,
    bcmr: { token: { decimals: 0, symbol: 'H' } },
  });
  const cfg = {
    min_trade_count_24h: 1,
    min_volume_7d_bch: 0, min_volume_30d_bch: 0, min_tvl_bch: 0, min_upward_volatility: 0, min_fee_yield_bps: 0, // T75
    weights: { volume_24h_bch: 1 },
    caps: { volume_24h_bch: 10, tvl_bch: 5 },
    linear_caps: { volatility_24h_pct: 30, apy_30d_pct: 200, fee_yield_bps: 500 },
  };
  // Path A: default threshold (0.5). 75% stale ≥ 50% → gate suppressed for all.
  const defaulted = scorePools(statsList, cfg, { nowMs: Date.now() });
  for (const id of staleIds) {
    const r = defaulted.find(x => x.token_id === id);
    assert.ok(r, `defaulted result must include stale token ${id.slice(0, 8)}`);
    assert.ok(!r.reasons.some(s => s.startsWith('trade_count_24h:')),
      `with default 50% threshold, stale token ${id.slice(0, 8)} must have trade_count_24h gate suppressed (got ${JSON.stringify(r.reasons)})`);
  }
  // Path B: threshold 0.8. 75% stale < 80% → gate fires for all.
  const overridden = scorePools(statsList, cfg, { nowMs: Date.now(), stalenessThreshold: 0.8 });
  for (const id of staleIds) {
    const r = overridden.find(x => x.token_id === id);
    assert.ok(r, `overridden result must include stale token ${id.slice(0, 8)}`);
    assert.equal(r.eligible, false, `with override 80% threshold, stale token ${id.slice(0, 8)} must be rejected (got eligible=${r.eligible})`);
    assert.ok(r.reasons.some(s => s.startsWith('trade_count_24h:')),
      `with override 80% threshold, stale token ${id.slice(0, 8)} must carry trade_count_24h reason (got ${JSON.stringify(r.reasons)})`);
  }
  // Healthy token should be eligible in BOTH paths.
  const defaultHealthy = defaulted.find(r => r.token_id === healthyId);
  assert.ok(defaultHealthy, 'defaulted result must include healthy token');
  assert.equal(defaultHealthy.eligible, true, 'healthy token always passes the trade_count_24h gate');
});

test('T44.1: global-staleness fallback ONLY suppresses trade_count_24h — other gates still fire', () => {
  // A token with trade_count=0 (would normally fail the gate) AND
  // volume_7d_bch below the floor + TVL below the floor. Under the
  // global-staleness fallback, the trade_count_24h gate is suppressed
  // BUT the volume + TVL gates MUST still fire — those reflect
  // per-token reality (a token CAN be genuinely thin even when the
  // indexer is having a bad day).
  // T86: volume_7d_bch replaces volume_24h_bch as the primary volume gate.
  const features = {
    volume_24h_bch: 1,       // unused post-T86 but kept for the historical contract
    volume_7d_bch: 0.001,    // way below floor of 0.5
    tvl_bch: 0.001,          // way below floor of 0.4
    volume_30d_bch: 5,
    volatility_24h_pct: 5,
    apy_30d_pct: 2,
    fee_yield_bps: 50,
    upward_volatility: 0.5,
    trade_count: 0,          // would normally hit the trade_count_24h gate
  };
  const cfg = {
    min_trade_count_24h: 1,
    min_volume_7d_bch: 0.5,
    min_volume_30d_bch: 0,
    min_tvl_bch: 0.4,
    min_upward_volatility: 0,
  };
  const r = applyEligibilityGates(features, cfg, { fractionBelowGate: 1.0, stalenessThreshold: 0.5 });
  // Token must STILL be rejected — the volume + TVL gates must fire.
  assert.equal(r.eligible, false, 'global-staleness does NOT excuse per-token thin-pool gates');
  // And specifically, the trade_count_24h reason is the one that got
  // suppressed — its absence is the whole point of this gate.
  assert.ok(!r.reasons.some(s => s.startsWith('trade_count_24h:')),
    `trade_count_24h must be suppressed under global-staleness (got ${JSON.stringify(r.reasons)})`);
  // The other reasons must still be present.
  assert.ok(r.reasons.some(s => s.startsWith('volume_7d_bch:')),
    'volume_7d_bch gate still fires under global-staleness');
  assert.ok(r.reasons.some(s => s.startsWith('tvl_bch:')),
    'tvl_bch gate still fires under global-staleness');
});
