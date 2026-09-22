#!/usr/bin/env node
// tests/util-correlation.test.mjs
//
// Unit tests for src/util/correlation.mjs (T36).
//
// Covers:
//   - asNumericSeries input tolerance (null/undefined/array/numbers/strings/NaN/mixed)
//   - pearsonCorrelation happy-path (positive/negative/uncorrelated)
//   - pearsonCorrelation edge cases (length mismatch / zero variance / NaN / <2 points)
//   - pearsonCorrelation self-correlation = 1
//   - pearsonCorrelation symmetry
//   - maxAbsCorrelation vs Map / plain object inputs
//   - maxAbsCorrelation excludes self
//   - maxAbsCorrelation deterministic tie-break (lowest token id wins)
//   - maxAbsCorrelation "no held series" → null
//   - maxAbsCorrelation "all degenerate held series" → null
//   - Real-shape QBTC-style regression: long-stable + tiny last-point spike
//
// Pure tests — no I/O. Run with `node --test tests/util-correlation.test.mjs`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  asNumericSeries,
  pearsonCorrelation,
  maxAbsCorrelation,
} from '../src/util/correlation.mjs';

// ─────────────────────────────────────────────────────────────────────
//  asNumericSeries
// ─────────────────────────────────────────────────────────────────────

test('asNumericSeries: null / undefined / non-array → null', () => {
  assert.equal(asNumericSeries(null), null);
  assert.equal(asNumericSeries(undefined), null);
  assert.equal(asNumericSeries(42), null);
  assert.equal(asNumericSeries('hello'), null);
  assert.equal(asNumericSeries({ 0: 1, length: 1 }), null);
});

test('asNumericSeries: array of numbers → array', () => {
  assert.deepEqual(asNumericSeries([1, 2, 3]), [1, 2, 3]);
  assert.deepEqual(asNumericSeries([0, 0, 0]), [0, 0, 0]);
  assert.deepEqual(asNumericSeries([-1, 0, 1]), [-1, 0, 1]);
});

test('asNumericSeries: array of numeric strings → array of numbers', () => {
  assert.deepEqual(asNumericSeries(['1', '2.5', '3']), [1, 2.5, 3]);
  assert.deepEqual(asNumericSeries(['0', '-1.5']), [0, -1.5]);
});

test('asNumericSeries: array containing NaN / Infinity → null', () => {
  assert.equal(asNumericSeries([1, NaN, 3]), null);
  assert.equal(asNumericSeries([1, Infinity, 3]), null);
  assert.equal(asNumericSeries([1, -Infinity, 3]), null);
});

test('asNumericSeries: array containing non-numeric types → null', () => {
  assert.equal(asNumericSeries([1, 'a', 3]), null);
  assert.equal(asNumericSeries([1, null, 3]), null);
  assert.equal(asNumericSeries([1, undefined, 3]), null);
  assert.equal(asNumericSeries([1, {}, 3]), null);
  assert.equal(asNumericSeries([1, true, 3]), null);
});

test('asNumericSeries: empty array → null', () => {
  assert.equal(asNumericSeries([]), null);
});

// ─────────────────────────────────────────────────────────────────────
//  pearsonCorrelation — happy path
// ─────────────────────────────────────────────────────────────────────

test('pearsonCorrelation: perfectly correlated (positive) → +1', () => {
  const r = pearsonCorrelation([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]);
  assert.ok(Math.abs(r - 1) < 1e-9, `expected r≈1, got ${r}`);
});

test('pearsonCorrelation: perfectly anti-correlated → -1', () => {
  const r = pearsonCorrelation([1, 2, 3, 4, 5], [10, 8, 6, 4, 2]);
  assert.ok(Math.abs(r + 1) < 1e-9, `expected r≈-1, got ${r}`);
});

test('pearsonCorrelation: constant signal vs varying → null (undefined corr)', () => {
  const r = pearsonCorrelation([5, 5, 5, 5], [1, 2, 3, 4]);
  assert.equal(r, null);
});

test('pearsonCorrelation: self-correlation → 1', () => {
  const r = pearsonCorrelation([1.1, 2.5, 3.7, 0.2], [1.1, 2.5, 3.7, 0.2]);
  assert.ok(Math.abs(r - 1) < 1e-9, `expected r≈1, got ${r}`);
});

test('pearsonCorrelation: symmetric (a,b) == (b,a)', () => {
  const a = [1, 2, 3, 4, 5, 6];
  const b = [2, 1, 4, 3, 6, 5];
  const r1 = pearsonCorrelation(a, b);
  const r2 = pearsonCorrelation(b, a);
  assert.ok(Math.abs(r1 - r2) < 1e-12, `expected symmetry, got ${r1} vs ${r2}`);
});

test('pearsonCorrelation: uncorrelated series → r ≈ 0', () => {
  // Construct two deterministic series with ~0 correlation. We pair
  // a monotonic series with one that oscillates around the mean so
  // the covariance washes out. The single-pass Pearson formula is
  // sensitive to any monotonic trend, so we use a longer series and
  // accept a wide tolerance.
  const a = Array.from({ length: 30 }, (_, i) => i + 1);
  // b alternates above and below the mean in a way that produces
  // near-zero covariance with a monotonic a.
  const b = [5, 1, 6, 2, 7, 3, 8, 4, 5, 1, 6, 2, 7, 3, 8, 4, 5, 1, 6, 2, 7, 3, 8, 4, 5, 1, 6, 2, 7, 3];
  const r = pearsonCorrelation(a, b);
  assert.ok(r !== null && Math.abs(r) < 0.5, `expected |r| < 0.5, got ${r}`);
});

test('pearsonCorrelation: length mismatch → null', () => {
  assert.equal(pearsonCorrelation([1, 2, 3], [1, 2]), null);
  assert.equal(pearsonCorrelation([1], [1, 2, 3]), null);
});

test('pearsonCorrelation: single-element series → null', () => {
  assert.equal(pearsonCorrelation([5], [10]), null);
});

test('pearsonCorrelation: zero-length series → null', () => {
  assert.equal(pearsonCorrelation([], []), null);
});

test('pearsonCorrelation: bad input (NaN inside) → null', () => {
  assert.equal(pearsonCorrelation([1, NaN, 3], [1, 2, 3]), null);
  assert.equal(pearsonCorrelation([1, 2, 3], [1, 'x', 3]), null);
});

test('pearsonCorrelation: tolerates numeric strings in series', () => {
  const r = pearsonCorrelation(['1', '2', '3', '4'], ['2', '4', '6', '8']);
  assert.ok(Math.abs(r - 1) < 1e-9, `expected r≈1, got ${r}`);
});

test('pearsonCorrelation: clamps floating-point overshoot to [-1, 1]', () => {
  // A perfectly linear series can produce 1 + epsilon from accumulated
  // round-off. We must clamp rather than return it.
  const a = Array.from({ length: 50 }, (_, i) => i + 1);
  const b = a.map((x) => x * 2);
  const r = pearsonCorrelation(a, b);
  assert.ok(r !== null && r >= -1 && r <= 1, `expected r ∈ [-1,1], got ${r}`);
});

// ─────────────────────────────────────────────────────────────────────
//  maxAbsCorrelation
// ─────────────────────────────────────────────────────────────────────

test('maxAbsCorrelation: null / missing candidate → null result', () => {
  const r = maxAbsCorrelation(null, { abc: [1, 2, 3] });
  assert.deepEqual(r, { maxAbs: null, againstTokenId: null, r: null });
});

test('maxAbsCorrelation: empty / null held map → null result', () => {
  const r = maxAbsCorrelation([1, 2, 3], null);
  assert.deepEqual(r, { maxAbs: null, againstTokenId: null, r: null });
  const r2 = maxAbsCorrelation([1, 2, 3], {});
  assert.deepEqual(r2, { maxAbs: null, againstTokenId: null, r: null });
  const r3 = maxAbsCorrelation([1, 2, 3], new Map());
  assert.deepEqual(r3, { maxAbs: null, againstTokenId: null, r: null });
});

test('maxAbsCorrelation: worst absolute value across multiple held series', () => {
  // candidate is the reference; three held series with different
  // correlations. The most-correlated one (in absolute value) wins.
  const candidate = [1, 2, 3, 4, 5, 6, 7, 8];
  const heldMap = new Map();
  heldMap.set('aaa', candidate); // r = 1, |r| = 1
  heldMap.set('bbb', candidate.slice().reverse()); // r = -1, |r| = 1
  heldMap.set('ccc', [4, 1, 4, 1, 4, 1, 4, 1]); // r ≈ 0
  const r = maxAbsCorrelation(candidate, heldMap);
  assert.ok(Math.abs(r.maxAbs - 1) < 1e-9, `expected |r|≈1, got ${r.maxAbs}`);
  // Tie-break: lowercase 'aaa' < 'bbb' alphabetically → aaa wins
  assert.equal(r.againstTokenId, 'aaa');
  assert.ok(Math.abs(r.r - 1) < 1e-9);
});

test('maxAbsCorrelation: skips degenerate held series (constant)', () => {
  const candidate = [1, 2, 3, 4, 5];
  const heldMap = new Map();
  heldMap.set('const', [7, 7, 7, 7, 7]); // constant → undefined corr → skip
  heldMap.set('good', [5, 4, 3, 2, 1]);  // r = -1, |r| = 1
  const r = maxAbsCorrelation(candidate, heldMap);
  assert.ok(Math.abs(r.maxAbs - 1) < 1e-9);
  assert.equal(r.againstTokenId, 'good');
});

test('maxAbsCorrelation: excludes self via opts.excludeTokenId', () => {
  const candidate = [1, 2, 3, 4, 5];
  const heldMap = new Map();
  heldMap.set('SELF', candidate); // r = 1, but we exclude this
  heldMap.set('other', [5, 4, 3, 2, 1]); // r = -1, |r| = 1
  const r = maxAbsCorrelation(candidate, heldMap, { excludeTokenId: 'self' });
  assert.equal(r.againstTokenId, 'other');
  assert.ok(Math.abs(r.r + 1) < 1e-9);
});

test('maxAbsCorrelation: deterministic tie-break (lowest token id wins)', () => {
  // Two held series with EXACTLY equal |r|. Lowest token id must
  // win so the audit blob is stable across runs. We construct:
  //   - candidate: monotonic
  //   - 'aaa':      candidate → r = +1, |r| = 1
  //   - 'zzz':      reversed candidate → r = -1, |r| = 1
  // Both are tied at |r|=1; the lowercase 'aaa' must win on the
  // lexicographic tie-break.
  const candidate = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const heldMap = new Map();
  heldMap.set('zzz', candidate.slice().reverse());
  heldMap.set('aaa', candidate);
  const r = maxAbsCorrelation(candidate, heldMap);
  assert.equal(r.againstTokenId, 'aaa');
  assert.ok(Math.abs(r.r - 1) < 1e-9);
});

test('maxAbsCorrelation: accepts plain object input (not just Map)', () => {
  const candidate = [1, 2, 3, 4, 5];
  const held = { 'tok1': [5, 4, 3, 2, 1], 'tok2': [1, 1, 1, 1, 1] };
  const r = maxAbsCorrelation(candidate, held);
  assert.equal(r.againstTokenId, 'tok1');
  assert.ok(Math.abs(r.r + 1) < 1e-9);
});

test('maxAbsCorrelation: case-insensitive token id matching', () => {
  const candidate = [1, 2, 3, 4, 5];
  const heldMap = new Map();
  heldMap.set('ABC', [5, 4, 3, 2, 1]); // mixed-case key
  const r = maxAbsCorrelation(candidate, heldMap);
  assert.equal(r.againstTokenId, 'abc');
  assert.ok(Math.abs(r.r + 1) < 1e-9);
});

test('maxAbsCorrelation: degenerate held map (all constant / NaN) → null', () => {
  const candidate = [1, 2, 3, 4, 5];
  const heldMap = new Map();
  heldMap.set('a', [7, 7, 7, 7, 7]);
  heldMap.set('b', [NaN, 2, 3]);
  const r = maxAbsCorrelation(candidate, heldMap);
  assert.deepEqual(r, { maxAbs: null, againstTokenId: null, r: null });
});

test('maxAbsCorrelation: ignores bad keys (non-string / empty)', () => {
  const candidate = [1, 2, 3];
  const heldMap = new Map();
  heldMap.set('', [1, 2, 3]);
  heldMap.set(42, [3, 2, 1]);
  heldMap.set(null, [3, 2, 1]);
  heldMap.set('ok', [3, 2, 1]);
  const r = maxAbsCorrelation(candidate, heldMap);
  assert.equal(r.againstTokenId, 'ok');
});

// ─────────────────────────────────────────────────────────────────────
//  QBTC-style regression (the original T36 motivation)
// ─────────────────────────────────────────────────────────────────────

test('maxAbsCorrelation: long-stable + tiny spike pattern is detectable', () => {
  // The 29-point Cauldron series is normalized against the max in
  // window. For "stable for 28 days, 1-day spike", we'd see something
  // like 28 points at 0.10 + 1 point at 1.0. A second token with the
  // same pattern should be detected as highly correlated.
  const spike = Array.from({ length: 28 }, () => 0.1).concat([1.0]);
  const heldMap = new Map();
  heldMap.set('similar_pattern', spike);
  heldMap.set('unrelated', Array.from({ length: 29 }, (_, i) => (i % 3) / 3));
  const r = maxAbsCorrelation(spike, heldMap);
  assert.ok(r.maxAbs !== null, 'must detect some correlation');
  assert.equal(r.againstTokenId, 'similar_pattern');
  assert.ok(r.maxAbs > 0.9, `expected near-perfect correlation, got ${r.maxAbs}`);
});
