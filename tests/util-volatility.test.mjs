#!/usr/bin/env node
/**
 * Unit tests for src/util/volatility.mjs (T38).
 *
 * Pure-function tests. No I/O, no logger, no process state. Run via:
 *   npm test
 *
 * Covers:
 *   - realizedDailyVolatilityPct: math, bad-input tolerance, edge cases
 *   - dynamicTakeProfitPct: multiplier + clamping
 *   - dynamicStopLossPct: same
 *   - computeDynamicExitPcts: end-to-end + bad-input fallback
 *   - GUARD: every knob comes from input, never hard-coded literals
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  realizedDailyVolatilityPct,
  dynamicTakeProfitPct,
  dynamicStopLossPct,
  computeDynamicExitPcts,
} from '../src/util/volatility.mjs';

// ────────────────────────────────────────────────────────────────────
//  realizedDailyVolatilityPct
// ────────────────────────────────────────────────────────────────────

test('realizedDailyVolatilityPct: null/empty → null result', () => {
  for (const bad of [null, undefined, [], 'string', 0, 42, {}]) {
    const r = realizedDailyVolatilityPct(bad);
    assert.equal(r.daily_vol_pct, null);
    assert.equal(r.step_std, null);
    assert.equal(r.return_count, 0);
    // steps_per_day falls back to the indexer default (29/7 ≈ 4.14).
    assert.ok(Math.abs(r.steps_per_day - 29 / 7) < 1e-9);
  }
});

test('realizedDailyVolatilityPct: single point → null result', () => {
  const r = realizedDailyVolatilityPct([1.0]);
  assert.equal(r.daily_vol_pct, null);
  assert.equal(r.return_count, 0);
});

test('realizedDailyVolatilityPct: two flat points → zero daily vol', () => {
  // No variation → std = 0 → daily vol = 0.
  const r = realizedDailyVolatilityPct([0.5, 0.5]);
  assert.equal(r.daily_vol_pct, 0);
  assert.equal(r.step_std, 0);
  assert.equal(r.return_count, 1);
});

test('realizedDailyVolatilityPct: two-point +50% step', () => {
  // p[0]=0.5, p[1]=0.75 → return = 0.5.
  // step_std = 0 (only one return, population std of [0.5] = 0).
  // daily_vol_pct = 0 * sqrt(29/7) * 100 = 0.
  const r = realizedDailyVolatilityPct([0.5, 0.75]);
  assert.equal(r.daily_vol_pct, 0);
  assert.equal(r.return_count, 1);
});

test('realizedDailyVolatilityPct: high-vol token (FEW-like)', () => {
  // Hand-crafted normalized series with a daily std ≈ 0.09 on the
  // normalized scale → daily_vol_pct ≈ 0.09 * sqrt(29/7) * 100 ≈ 18%.
  // 29 points oscillating ±0.09 around 0.5:
  const series = [];
  for (let i = 0; i < 29; i++) {
    series.push(0.5 + 0.09 * Math.sin(i * 0.7));
  }
  const r = realizedDailyVolatilityPct(series);
  // We computed something in the rough ballpark of 18% — assert a wide
  // range so the test isn't fragile across rounding, but tight enough
  // to catch an off-by-2x bug.
  assert.ok(r.daily_vol_pct !== null, 'expected a finite daily_vol_pct');
  assert.ok(r.daily_vol_pct > 5 && r.daily_vol_pct < 50,
    `expected FEW-like daily vol in (5, 50)%, got ${r.daily_vol_pct}`);
  assert.equal(r.return_count, 28);
});

test('realizedDailyVolatilityPct: low-vol token (QBTC-like)', () => {
  // Tiny ±0.001 wiggle around 1.0 → daily vol should be sub-1%.
  const series = [];
  for (let i = 0; i < 29; i++) {
    series.push(1.0 + 0.001 * Math.sin(i * 0.3));
  }
  const r = realizedDailyVolatilityPct(series);
  assert.ok(r.daily_vol_pct !== null, 'expected a finite daily_vol_pct');
  assert.ok(r.daily_vol_pct < 5,
    `expected QBTC-like daily vol < 5%, got ${r.daily_vol_pct}`);
  assert.equal(r.return_count, 28);
});

test('realizedDailyVolatilityPct: tolerates mixed null/NaN/zero entries', () => {
  // 8 entries: 0.5, 0.55, null, NaN, 0, 0.6, 0.65, 0.7.
  // Valid pairs (each adjacent pair where both are finite + positive):
  //   (0.5 → 0.55, r=+0.10)   valid
  //   (0.55 → null)            skipped (curr is null)
  //   (null → NaN)             skipped (prev is null)
  //   (NaN → 0)                skipped (prev is NaN)
  //   (0 → 0.6)                skipped (prev <= 0, div-by-zero guard)
  //   (0.6 → 0.65, r≈+0.083)  valid
  //   (0.65 → 0.7, r≈+0.077)  valid
  // Three valid step returns.
  const series = [0.5, 0.55, null, NaN, 0, 0.6, 0.65, 0.7];
  const r = realizedDailyVolatilityPct(series);
  assert.equal(r.return_count, 3);
  assert.ok(r.daily_vol_pct !== null);
});

test('realizedDailyVolatilityPct: tolerates string + bigint entries', () => {
  const bigZero = BigInt(0);
  const big7 = BigInt(7) / BigInt(10); // 0.7n is actually invalid — use string instead
  const r = realizedDailyVolatilityPct(['0.5', 0.6, '0.7', big7.toString()]);
  // p[0]=0.5, p[1]=0.6 (r=0.2), p[2]=0.7 (r≈0.167), p[3]=0.7 (r=0).
  // Population std of [0.2, 0.167, 0].
  assert.equal(r.return_count, 3);
  assert.ok(r.daily_vol_pct !== null);
  assert.ok(r.daily_vol_pct > 0);
  // Suppress unused-var lint complaint.
  void bigZero;
});

test('realizedDailyVolatilityPct: custom pointsPerWindow + daysInWindow', () => {
  // 12 points over 2 days → steps_per_day = 6 → sqrt = 2.449.
  const series = [0.5, 0.6, 0.5, 0.7, 0.55, 0.65, 0.5, 0.7, 0.55, 0.65, 0.5, 0.7];
  const r = realizedDailyVolatilityPct(series, { pointsPerWindow: 12, daysInWindow: 2 });
  assert.ok(Math.abs(r.steps_per_day - 6) < 1e-9);
  // Just verify it's a finite number — the exact magnitude depends on
  // the synthetic series we chose.
  assert.ok(Number.isFinite(r.daily_vol_pct));
});

test('realizedDailyVolatilityPct: all-zero series → zero daily vol', () => {
  const r = realizedDailyVolatilityPct([0, 0, 0, 0, 0]);
  // Every prev is 0 → divide-by-zero guard skips every step.
  assert.equal(r.return_count, 0);
  assert.equal(r.daily_vol_pct, null);
});

// ────────────────────────────────────────────────────────────────────
//  dynamicTakeProfitPct
// ────────────────────────────────────────────────────────────────────

test('dynamicTakeProfitPct: bad input → null', () => {
  assert.equal(dynamicTakeProfitPct(null, 2), null);
  assert.equal(dynamicTakeProfitPct(undefined, 2), null);
  assert.equal(dynamicTakeProfitPct(NaN, 2), null);
  assert.equal(dynamicTakeProfitPct('banana', 2), null);
  assert.equal(dynamicTakeProfitPct(5, null), null);
  assert.equal(dynamicTakeProfitPct(5, 0), null);
  assert.equal(dynamicTakeProfitPct(5, -1), null);
});

test('dynamicTakeProfitPct: linear scaling', () => {
  // 1% daily vol * multiplier 2 → 2% (above 2% floor) → 2%.
  assert.equal(dynamicTakeProfitPct(1.0, 2.0), 2.0);
  // 3% daily vol * mult 2 → 6% → 6%.
  assert.equal(dynamicTakeProfitPct(3.0, 2.0), 6.0);
  // 18% daily vol * mult 2 → 36% → 36%.
  assert.equal(dynamicTakeProfitPct(18.0, 2.0), 36.0);
});

test('dynamicTakeProfitPct: floor clamping', () => {
  // 0.5% daily vol * mult 2 → 1% → below 2% floor → clamped to 2%.
  assert.equal(dynamicTakeProfitPct(0.5, 2.0), 2.0);
  // Custom floor: 1% → 0.5% * 2 = 1% → below 1% floor → 1%.
  assert.equal(dynamicTakeProfitPct(0.5, 2.0, { floor: 1.0 }), 1.0);
});

test('dynamicTakeProfitPct: ceiling clamping', () => {
  // 50% daily vol * mult 2 → 100% → above 80% ceiling → 80%.
  assert.equal(dynamicTakeProfitPct(50.0, 2.0), 80.0);
  // Custom ceiling: 100% → 50% * 2 = 100% → clamped to 100% (no-op).
  assert.equal(dynamicTakeProfitPct(50.0, 2.0, { ceiling: 100.0 }), 100.0);
});

test('dynamicTakeProfitPct: floor >= ceiling → broken clamp falls back to default ceiling', () => {
  // Misconfigured knob: floor=20, ceiling=10. The clamp range is
  // broken (ceiling <= floor) — we silently fall back to the
  // default ceiling (80) and enforce it. Raw=40 < 80 → no upper
  // clamp → return 40. (Without the fallback we'd clamp to user's
  // ceiling=10, which is the dangerous default.)
  const result = dynamicTakeProfitPct(20.0, 2.0, { floor: 20, ceiling: 10 });
  assert.equal(result, 40);
});

test('dynamicTakeProfitPct: tolerates string inputs', () => {
  // Strings that parse to finite numbers are accepted.
  assert.equal(dynamicTakeProfitPct('3.0', '2.0'), 6.0);
});

// ────────────────────────────────────────────────────────────────────
//  dynamicStopLossPct
// ────────────────────────────────────────────────────────────────────

test('dynamicStopLossPct: bad input → null', () => {
  assert.equal(dynamicStopLossPct(null, 1), null);
  assert.equal(dynamicStopLossPct(5, null), null);
  assert.equal(dynamicStopLossPct(5, 0), null);
  assert.equal(dynamicStopLossPct(5, -1), null);
  assert.equal(dynamicStopLossPct('banana', 1), null);
});

test('dynamicStopLossPct: linear scaling (1σ default)', () => {
  assert.equal(dynamicStopLossPct(3.0, 1.0), 3.0);
  assert.equal(dynamicStopLossPct(18.0, 1.0), 18.0);
});

test('dynamicStopLossPct: floor clamping', () => {
  // 0.2% daily vol * mult 1 → 0.2% → below 1% floor → 1%.
  assert.equal(dynamicStopLossPct(0.2, 1.0), 1.0);
  assert.equal(dynamicStopLossPct(0.2, 1.0, { floor: 0.5 }), 0.5);
});

test('dynamicStopLossPct: ceiling clamping', () => {
  // 30% daily vol * mult 1 → 30% → above 50% ceiling? No, 30 < 50, so 30.
  assert.equal(dynamicStopLossPct(30.0, 1.0), 30.0);
  // 60% * 1 → 60% → above 50% ceiling → 50%.
  assert.equal(dynamicStopLossPct(60.0, 1.0), 50.0);
  // Custom ceiling.
  assert.equal(dynamicStopLossPct(60.0, 1.0, { ceiling: 40.0 }), 40.0);
});

// ────────────────────────────────────────────────────────────────────
//  computeDynamicExitPcts (end-to-end)
// ────────────────────────────────────────────────────────────────────

test('computeDynamicExitPcts: FEW-like high vol → wide TP/SL', () => {
  const series = [];
  for (let i = 0; i < 29; i++) {
    series.push(0.5 + 0.09 * Math.sin(i * 0.7));
  }
  const r = computeDynamicExitPcts(series, {
    tp_vol_multiplier: 2.0,
    sl_vol_multiplier: 1.0,
    tp_vol_floor_pct: 2.0,
    tp_vol_ceiling_pct: 80.0,
    sl_vol_floor_pct: 1.0,
    sl_vol_ceiling_pct: 50.0,
  });
  assert.ok(r.daily_vol_pct !== null);
  assert.ok(r.tp !== null && r.sl !== null);
  // Both TP and SL should be wider than the 5%/3% defaults because
  // this is a high-vol token.
  assert.ok(r.tp > 5.0, `TP ${r.tp} should be > 5% for high-vol token`);
  assert.ok(r.sl > 3.0, `SL ${r.sl} should be > 3% for high-vol token`);
  // TP should be ~2x SL (per the multipliers).
  assert.ok(Math.abs(r.tp / r.sl - 2.0) < 0.01,
    `TP/SL ratio should be ~2 (mult diff), got ${(r.tp / r.sl).toFixed(3)}`);
});

test('computeDynamicExitPcts: QBTC-like low vol → tight TP/SL', () => {
  const series = [];
  for (let i = 0; i < 29; i++) {
    series.push(1.0 + 0.001 * Math.sin(i * 0.3));
  }
  const r = computeDynamicExitPcts(series, {
    tp_vol_multiplier: 2.0,
    sl_vol_multiplier: 1.0,
    tp_vol_floor_pct: 2.0,
    tp_vol_ceiling_pct: 80.0,
    sl_vol_floor_pct: 1.0,
    sl_vol_ceiling_pct: 50.0,
  });
  assert.ok(r.daily_vol_pct !== null);
  // Floor clamping: TP must be at least 2%, SL at least 1%.
  assert.ok(r.tp >= 2.0);
  assert.ok(r.sl >= 1.0);
});

test('computeDynamicExitPcts: missing series → null fallback', () => {
  const r = computeDynamicExitPcts(null, {
    tp_vol_multiplier: 2.0,
    sl_vol_multiplier: 1.0,
  });
  assert.equal(r.tp, null);
  assert.equal(r.sl, null);
  assert.equal(r.daily_vol_pct, null);
});

test('computeDynamicExitPcts: zero-mult config → null fallback', () => {
  const r = computeDynamicExitPcts([0.5, 0.6, 0.7], {
    tp_vol_multiplier: 0,
    sl_vol_multiplier: 0,
  });
  // Multiplier 0 → not > 0 → guard returns null for both.
  assert.equal(r.tp, null);
  assert.equal(r.sl, null);
  // But daily_vol_pct IS computed (the guard only blocks the pcts).
  assert.ok(r.daily_vol_pct !== null);
});

test('computeDynamicExitPcts: bad cfg object → daily vol computed, pcts null', () => {
  // The cfg can be null/undefined — volResult still works (it doesn't
  // read cfg), but the multipliers default to NaN → pcts return null.
  const r = computeDynamicExitPcts([0.5, 0.6, 0.7], null);
  assert.equal(r.tp, null);
  assert.equal(r.sl, null);
  assert.ok(r.daily_vol_pct !== null);
});

test('computeDynamicExitPcts: return_count flows through', () => {
  const r = computeDynamicExitPcts([0.5, 0.6, 0.7, 0.8, 0.6], {
    tp_vol_multiplier: 2.0,
    sl_vol_multiplier: 1.0,
  });
  assert.equal(r.return_count, 4);
});

// ────────────────────────────────────────────────────────────────────
//  GUARD: knobs are inputs, not hard-coded
// ────────────────────────────────────────────────────────────────────

test('GUARD: realizedDailyVolatilityPct defaults are overrideable via opts', () => {
  // Pass custom pointsPerWindow + daysInWindow and verify the
  // resulting daily_vol_pct uses those (not hard-coded 29/7).
  const series = [0.5, 0.6, 0.5, 0.6, 0.5, 0.6, 0.5, 0.6, 0.5, 0.6];
  const defaultRun = realizedDailyVolatilityPct(series);
  const customRun = realizedDailyVolatilityPct(series, {
    pointsPerWindow: 10, daysInWindow: 1, // 10 steps/day, sqrt = 3.16
  });
  // Same step std but different sqrt scaling → different daily vol %.
  assert.ok(Math.abs(defaultRun.daily_vol_pct - customRun.daily_vol_pct) > 1e-6);
});

test('GUARD: dynamicTakeProfitPct floor + ceiling are inputs', () => {
  // The default floor is 2% but caller can override to 10%.
  const r = dynamicTakeProfitPct(1.0, 2.0, { floor: 10.0 });
  assert.equal(r, 10.0);
  // Default ceiling is 80% but caller can override to 5%.
  const r2 = dynamicTakeProfitPct(50.0, 2.0, { ceiling: 5.0 });
  assert.equal(r2, 5.0);
});
