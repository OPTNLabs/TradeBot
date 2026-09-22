// tests/trader-slippage-cap.test.mjs
//
// Unit tests for `src/trader/slippage-cap.mjs` — the T55 per-token
// slippage cap helper. Pure functions; no I/O.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computePerTokenSlippageCapBps,
  resolveSlippageCapBps,
} from '../src/trader/slippage-cap.mjs';

// ─────────────────────────────────────────────────────────────────────
//  computePerTokenSlippageCapBps — happy path
// ─────────────────────────────────────────────────────────────────────

test('computePerTokenSlippageCapBps: deep pool (5 BCH, 0.005 BCH size) → clamps to min 30bps', () => {
  const r = computePerTokenSlippageCapBps({
    sizeBch: 0.005,
    poolDepthBch: 5,
    baseCapBps: 100,
    minBps: 30,
    maxBps: 250,
    multiplier: 2.0,
  });
  assert.ok(r !== null);
  // size_pct = 0.1, est = 10 bps, target = 20 bps, clamped to min 30
  assert.equal(r.capBps, 30n);
  assert.equal(r.clampKind, 'clamped_to_min');
  assert.equal(r.sizePctOfDepth, 0.1);
  assert.equal(r.baseCapBps, 100n);
});

test('computePerTokenSlippageCapBps: 0.5 BCH pool → 202 bps (above flat)', () => {
  const r = computePerTokenSlippageCapBps({
    sizeBch: 0.005,
    poolDepthBch: 0.5,
    baseCapBps: 100,
  });
  assert.ok(r !== null);
  // size_pct = 1.0, est ≈ 101 bps, target = 202 bps, no clamp
  assert.equal(r.capBps, 202n);
  assert.equal(r.clampKind, 'ok');
});

test('computePerTokenSlippageCapBps: 0.2 BCH pool → clamps to max 250bps', () => {
  const r = computePerTokenSlippageCapBps({
    sizeBch: 0.005,
    poolDepthBch: 0.2,
    baseCapBps: 100,
  });
  assert.ok(r !== null);
  // size_pct = 2.5, est ≈ 256 bps, target = 513 bps, clamped to max 250
  assert.equal(r.capBps, 250n);
  assert.equal(r.clampKind, 'clamped_to_max');
});

test('computePerTokenSlippageCapBps: size > depth → clamps to max (no Infinity leak)', () => {
  const r = computePerTokenSlippageCapBps({
    sizeBch: 1.0,
    poolDepthBch: 0.5,
    baseCapBps: 100,
  });
  assert.ok(r !== null);
  // size_pct = 200%, denom < 0 → est = Infinity → target = Infinity
  // → clamped to maxBps 250
  assert.equal(r.capBps, 250n);
  assert.equal(r.clampKind, 'clamped_to_max');
  assert.equal(r.estSlippageBps, Number.POSITIVE_INFINITY);
});

test('computePerTokenSlippageCapBps: 10 BCH pool → clamps to min (super-deep)', () => {
  const r = computePerTokenSlippageCapBps({
    sizeBch: 0.005,
    poolDepthBch: 10,
    baseCapBps: 100,
  });
  assert.ok(r !== null);
  // size_pct = 0.05%, est = 5 bps, target = 10 bps, clamped to min 30
  assert.equal(r.capBps, 30n);
  assert.equal(r.clampKind, 'clamped_to_min');
});

// ─────────────────────────────────────────────────────────────────────
//  Defaults
// ─────────────────────────────────────────────────────────────────────

test('computePerTokenSlippageCapBps: defaults to minBps=30, maxBps=250, multiplier=2.0', () => {
  const r = computePerTokenSlippageCapBps({
    sizeBch: 0.005,
    poolDepthBch: 5,
    baseCapBps: 100,
  });
  assert.ok(r !== null);
  assert.equal(r.minBps, 30);
  assert.equal(r.maxBps, 250);
  assert.equal(r.multiplier, 2.0);
  assert.equal(r.capBps, 30n); // clamped to min
});

test('computePerTokenSlippageCapBps: custom multiplier applied', () => {
  const r1 = computePerTokenSlippageCapBps({
    sizeBch: 0.005, poolDepthBch: 0.5, baseCapBps: 100, multiplier: 1.5,
  });
  assert.ok(r1 !== null);
  // size_pct = 1.0, est ≈ 101.01 bps, target = 151.51 bps, floor = 151
  assert.equal(r1.capBps, 151n);
  assert.equal(r1.multiplier, 1.5);
  assert.equal(r1.clampKind, 'ok');
});

// ─────────────────────────────────────────────────────────────────────
//  Failure modes (return null)
// ─────────────────────────────────────────────────────────────────────

test('computePerTokenSlippageCapBps: enabled=false → null', () => {
  assert.equal(
    computePerTokenSlippageCapBps({
      sizeBch: 0.005, poolDepthBch: 5, baseCapBps: 100, enabled: false,
    }),
    null,
  );
});

test('computePerTokenSlippageCapBps: sizeBch <= 0 → null', () => {
  assert.equal(
    computePerTokenSlippageCapBps({ sizeBch: 0, poolDepthBch: 5, baseCapBps: 100 }),
    null,
  );
  assert.equal(
    computePerTokenSlippageCapBps({ sizeBch: -1, poolDepthBch: 5, baseCapBps: 100 }),
    null,
  );
  assert.equal(
    computePerTokenSlippageCapBps({ sizeBch: NaN, poolDepthBch: 5, baseCapBps: 100 }),
    null,
  );
});

test('computePerTokenSlippageCapBps: poolDepthBch <= 0 → null', () => {
  assert.equal(
    computePerTokenSlippageCapBps({ sizeBch: 0.005, poolDepthBch: 0, baseCapBps: 100 }),
    null,
  );
  assert.equal(
    computePerTokenSlippageCapBps({ sizeBch: 0.005, poolDepthBch: -1, baseCapBps: 100 }),
    null,
  );
});

test('computePerTokenSlippageCapBps: baseCapBps <= 0 → null', () => {
  assert.equal(
    computePerTokenSlippageCapBps({ sizeBch: 0.005, poolDepthBch: 5, baseCapBps: 0 }),
    null,
  );
});

test('computePerTokenSlippageCapBps: inconsistent knobs (min > max) → null', () => {
  assert.equal(
    computePerTokenSlippageCapBps({
      sizeBch: 0.005, poolDepthBch: 5, baseCapBps: 100, minBps: 300, maxBps: 100,
    }),
    null,
  );
});

test('computePerTokenSlippageCapBps: bad multiplier (zero / negative / NaN / huge) → null', () => {
  assert.equal(
    computePerTokenSlippageCapBps({ sizeBch: 0.005, poolDepthBch: 5, baseCapBps: 100, multiplier: 0 }),
    null,
  );
  assert.equal(
    computePerTokenSlippageCapBps({ sizeBch: 0.005, poolDepthBch: 5, baseCapBps: 100, multiplier: -1 }),
    null,
  );
  assert.equal(
    computePerTokenSlippageCapBps({ sizeBch: 0.005, poolDepthBch: 5, baseCapBps: 100, multiplier: NaN }),
    null,
  );
  // >100 is treated as a typo
  assert.equal(
    computePerTokenSlippageCapBps({ sizeBch: 0.005, poolDepthBch: 5, baseCapBps: 100, multiplier: 200 }),
    null,
  );
});

test('computePerTokenSlippageCapBps: undefined args → null', () => {
  assert.equal(computePerTokenSlippageCapBps(), null);
  assert.equal(computePerTokenSlippageCapBps({}), null);
});

// ─────────────────────────────────────────────────────────────────────
//  resolveSlippageCapBps (convenience wrapper)
// ─────────────────────────────────────────────────────────────────────

test('resolveSlippageCapBps: with depth → returns per-token cap', () => {
  const cap = resolveSlippageCapBps({
    baseCapBps: 100n, sizeBch: 0.005, poolDepthBch: 5,
  });
  assert.equal(cap, 30n);
});

test('resolveSlippageCapBps: shallow pool → cap can exceed baseCap (loosens flat)', () => {
  const cap = resolveSlippageCapBps({
    baseCapBps: 100n, sizeBch: 0.005, poolDepthBch: 0.5,
  });
  assert.equal(cap, 202n);
});

test('resolveSlippageCapBps: missing size/depth → falls back to baseCap', () => {
  assert.equal(resolveSlippageCapBps({ baseCapBps: 100n }), 100n);
  assert.equal(resolveSlippageCapBps({ baseCapBps: 100n, sizeBch: 0.005 }), 100n);
});

test('resolveSlippageCapBps: enabled=false → falls back to baseCap', () => {
  assert.equal(
    resolveSlippageCapBps({ baseCapBps: 100n, sizeBch: 0.005, poolDepthBch: 5, enabled: false }),
    100n,
  );
});

test('resolveSlippageCapBps: bad baseCapBps (non-bigint / zero / negative) → uses 100 fallback AS THE BASE', () => {
  // baseCapBps=0 falls back to base=100, then per-token cap clamps to min=30 on a 5 BCH pool
  assert.equal(resolveSlippageCapBps({ baseCapBps: 0n, sizeBch: 0.005, poolDepthBch: 5 }), 30n);
  // baseCapBps missing entirely → same fallback path
  assert.equal(resolveSlippageCapBps({ sizeBch: 0.005, poolDepthBch: 5 }), 30n);
  // Without size/depth, baseCapBps=0 falls back to base=100 (no per-token applied)
  assert.equal(resolveSlippageCapBps({ baseCapBps: 0n }), 100n);
  assert.equal(resolveSlippageCapBps({ baseCapBps: -50n }), 100n);
});

test('resolveSlippageCapBps: clamps to min/max on deep/tiny pools', () => {
  // Deep pool: clamps to min
  assert.equal(
    resolveSlippageCapBps({ baseCapBps: 100n, sizeBch: 0.005, poolDepthBch: 100 }),
    30n,
  );
  // Tiny pool: clamps to max
  assert.equal(
    resolveSlippageCapBps({ baseCapBps: 100n, sizeBch: 0.005, poolDepthBch: 0.05 }),
    250n,
  );
});

test('resolveSlippageCapBps: respects custom min/max/multiplier', () => {
  // multiplier=3.0 on a 0.5 BCH pool: target = 303, clamps to 300
  const cap = resolveSlippageCapBps({
    baseCapBps: 100n, sizeBch: 0.005, poolDepthBch: 0.5,
    minBps: 10, maxBps: 300, multiplier: 3.0,
  });
  assert.equal(cap, 300n);
});

// ─────────────────────────────────────────────────────────────────────
//  Audit-trail shape sanity
// ─────────────────────────────────────────────────────────────────────

test('computePerTokenSlippageCapBps: result shape is complete', () => {
  const r = computePerTokenSlippageCapBps({
    sizeBch: 0.005, poolDepthBch: 0.5, baseCapBps: 100,
  });
  assert.ok(r !== null);
  for (const k of [
    'capBps', 'baseCapBps', 'sizeBch', 'poolDepthBch', 'sizePctOfDepth',
    'estSlippageBps', 'targetCapBps', 'minBps', 'maxBps', 'multiplier',
    'clampKind', 'enabled',
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(r, k), `missing field: ${k}`);
  }
  assert.ok(typeof r.capBps === 'bigint');
  assert.ok(typeof r.baseCapBps === 'bigint');
  assert.ok(['ok', 'clamped_to_min', 'clamped_to_max'].includes(r.clampKind));
});