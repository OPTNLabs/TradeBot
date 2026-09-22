// tests/trader/rate-units.test.mjs
//
// Unit tests for `src/trader/rate-units.mjs` — pure helpers for
// converting token rate units between "per display unit" and "per
// base unit". Every external surface is exercised; no I/O.
//
// Run with:  node --test tests/trader/rate-units.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  displayRateToBaseRate,
  baseRateToDisplayRate,
  normalizeExpectedRateToBase,
} from '../../src/trader/rate-units.mjs';
import { computeSlippageBps } from '../../src/trader/swap.mjs';

// ─────────────────────────────────────────────────────────────────────
//  displayRateToBaseRate
// ─────────────────────────────────────────────────────────────────────

test('displayRateToBaseRate: 97 sats/display / 10^2 → 0 sats/base (OLA shape) [B04 fix: divide, not multiply]', () => {
  const out = displayRateToBaseRate(97n, 2);
  assert.equal(out.ok, true);
  assert.equal(out.value, 0n);
});

test('displayRateToBaseRate: 380 sats/display × 10^0 → 380 sats/base (FURU shape, decimals=0)', () => {
  const out = displayRateToBaseRate(380n, 0);
  assert.equal(out.ok, true);
  assert.equal(out.value, 380n);
});

test('displayRateToBaseRate: 1 sat/display / 10^8 → 0 sats/base (sat-native token) [B04 fix: divide, not multiply]', () => {
  const out = displayRateToBaseRate(1n, 8);
  assert.equal(out.ok, true);
  assert.equal(out.value, 0n);
});

test('displayRateToBaseRate: number input gets rounded then divided [B04 fix]', () => {
  // 97.6 rounds to 98 (banker's rounding); 98 / 10^2 = 0.
  const out = displayRateToBaseRate(97.6, 2);
  assert.equal(out.ok, true);
  assert.equal(out.value, 0n);
});

test('displayRateToBaseRate: string input gets parsed then divided [B04 fix]', () => {
  const out = displayRateToBaseRate('97', 2);
  assert.equal(out.ok, true);
  assert.equal(out.value, 0n);
});

test('displayRateToBaseRate: rate of 0 → rate_invalid', () => {
  const out = displayRateToBaseRate(0n, 2);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'rate_invalid');
});

test('displayRateToBaseRate: negative rate → rate_invalid', () => {
  const out = displayRateToBaseRate(-5n, 2);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'rate_invalid');
});

test('displayRateToBaseRate: null rate → rate_missing', () => {
  const out = displayRateToBaseRate(null, 2);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'rate_missing');
});

test('displayRateToBaseRate: undefined rate → rate_missing', () => {
  const out = displayRateToBaseRate(undefined, 2);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'rate_missing');
});

test('displayRateToBaseRate: NaN rate → rate_invalid', () => {
  const out = displayRateToBaseRate(NaN, 2);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'rate_invalid');
});

test('displayRateToBaseRate: Infinity rate → rate_invalid', () => {
  const out = displayRateToBaseRate(Infinity, 2);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'rate_invalid');
});

test('displayRateToBaseRate: garbage string rate → rate_invalid', () => {
  const out = displayRateToBaseRate('not a number', 2);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'rate_invalid');
});

test('displayRateToBaseRate: empty string rate → rate_invalid', () => {
  const out = displayRateToBaseRate('', 2);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'rate_invalid');
});

test('displayRateToBaseRate: missing decimals → decimals_missing', () => {
  const out = displayRateToBaseRate(97n, null);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'decimals_missing');
});

test('displayRateToBaseRate: undefined decimals → decimals_missing', () => {
  const out = displayRateToBaseRate(97n, undefined);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'decimals_missing');
});

test('displayRateToBaseRate: negative decimals → decimals_invalid', () => {
  const out = displayRateToBaseRate(97n, -1);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'decimals_invalid');
});

test('displayRateToBaseRate: non-integer decimals → decimals_invalid', () => {
  const out = displayRateToBaseRate(97n, 2.5);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'decimals_invalid');
});

test('displayRateToBaseRate: decimals > 32 → decimals_invalid (overflow guard)', () => {
  const out = displayRateToBaseRate(97n, 33);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'decimals_invalid');
});

test('displayRateToBaseRate: NaN decimals → decimals_invalid', () => {
  const out = displayRateToBaseRate(97n, NaN);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'decimals_invalid');
});

test('displayRateToBaseRate: huge per-display rate divides cleanly (B04 fix: division never overflows)', () => {
  // Pre-fix code multiplied, so a 1e11 per-display × 10^8 would blow past the 1e18
  // cap. Post-fix we DIVIDE, so the result is 1e3 per-base — well within any
  // sensible AMM rate. The 1e18 overflow guard is now nearly unreachable via
  // decimal conversion (only `decimals=0` with an absurd input could trip it);
  // still kept as a defensive backstop.
  const out = displayRateToBaseRate(100000000000n, 8);
  assert.equal(out.ok, true);
  assert.equal(out.value, 1000n);
});

test('displayRateToBaseRate: sane large per-display rate divides to a sensible per-base rate [B04 fix]', () => {
  // 1e10 sats/display / 10^8 = 1e2 per-base. Confirms the fix without
  // invoking an impossible overflow case.
  const out = displayRateToBaseRate(10000000000n, 8);
  assert.equal(out.ok, true);
  assert.equal(out.value, 100n);
});

// ─────────────────────────────────────────────────────────────────────
//  baseRateToDisplayRate
// ─────────────────────────────────────────────────────────────────────

test('baseRateToDisplayRate: 97 sats/base × 10^2 → 9700 sats/display (OLA shape) [B04 fix: multiply, not divide]', () => {
  const out = baseRateToDisplayRate(97n, 2);
  assert.equal(out.ok, true);
  assert.equal(out.value, 9700n);
});

test('baseRateToDisplayRate: 380 sats/base × 10^0 → 380 sats/display (FURU shape) [decimals=0 unchanged]', () => {
  const out = baseRateToDisplayRate(380n, 0);
  assert.equal(out.ok, true);
  assert.equal(out.value, 380n);
});

test('baseRateToDisplayRate: floor-truncates (fractional display is dropped) [B04 fix]', () => {
  // 97 sats/base × 10^2 = 9700 per-display (truncated at the bigint floor — no fractional)
  const out = baseRateToDisplayRate(97n, 2);
  assert.equal(out.ok, true);
  assert.equal(out.value, 9700n);
});

test('baseRateToDisplayRate: rate of 0 → 0n (not invalid)', () => {
  const out = baseRateToDisplayRate(0n, 2);
  assert.equal(out.ok, true);
  assert.equal(out.value, 0n);
});

// [B04 fix] The two helpers are now clean inverses (one divides, one multiplies).
// We verify each helper independently here instead of round-tripping.
test('display→base / base→display helpers: directional sanity [B04 fix]', () => {
  // display 9700 / 10^2 = 97 (per-base after the B04 fix)
  const toBase = displayRateToBaseRate(9700n, 2);
  assert.equal(toBase.ok, true);
  assert.equal(toBase.value, 97n);
  // base 97 × 10^2 = 9700 (per-display conversion; the helper used
  // by the audit log layer)
  const toDisplay = baseRateToDisplayRate(97n, 2);
  assert.equal(toDisplay.ok, true);
  assert.equal(toDisplay.value, 9700n);
});

test('baseRateToDisplayRate: rejects negative rate', () => {
  const out = baseRateToDisplayRate(-5n, 2);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'rate_invalid');
});

test('baseRateToDisplayRate: rejects missing decimals', () => {
  const out = baseRateToDisplayRate(100n, null);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'decimals_missing');
});

test('baseRateToDisplayRate: rejects decimals > 32', () => {
  const out = baseRateToDisplayRate(100n, 50);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'decimals_invalid');
});

// ─────────────────────────────────────────────────────────────────────
//  normalizeExpectedRateToBase
// ─────────────────────────────────────────────────────────────────────

test('normalizeExpectedRateToBase: indexer-style per-display rate → per-base bigint', () => {
  // The B04 scenario: 97 sats/display, decimals=2 → 97/100 = 0 sats/base.
  const out = normalizeExpectedRateToBase(97n, 2);
  assert.equal(out, 0n);
});

test('normalizeExpectedRateToBase: null input → null (caller falls back to SDK spot)', () => {
  assert.equal(normalizeExpectedRateToBase(null, 2), null);
  assert.equal(normalizeExpectedRateToBase(undefined, 2), null);
});

test('normalizeExpectedRateToBase: missing decimals → passes input through verbatim (back-compat)', () => {
  // Per-base-unit test fixtures don't supply decimals; the
  // helper preserves the input verbatim so the existing slippage
  // math stays correct (input and `plan.effectiveRate` share the
  // same per-base basis in that case).
  assert.equal(normalizeExpectedRateToBase(1300n, null), 1300n);
  assert.equal(normalizeExpectedRateToBase(1300n, undefined), 1300n);
});

test('normalizeExpectedRateToBase: invalid decimals → passes input through verbatim', () => {
  assert.equal(normalizeExpectedRateToBase(1300n, -1), 1300n);
  assert.equal(normalizeExpectedRateToBase(1300n, 2.5), 1300n);
  assert.equal(normalizeExpectedRateToBase(1300n, 33), 1300n);
});

test('normalizeExpectedRateToBase: number input gets rounded then converted', () => {
  // 97.6 rounds to 98; 98 / 10^2 = 0 sats/base. [B04 fix: divide, not multiply]
  const out = normalizeExpectedRateToBase(97.6, 2);
  assert.equal(out, 0n);
});

test('normalizeExpectedRateToBase: string input gets parsed then converted', () => {
  const out = normalizeExpectedRateToBase('97', 2);
  assert.equal(out, 0n); // [B04 fix]
});

test('normalizeExpectedRateToBase: zero rate → passes through (no slippage possible)', () => {
  // The caller is asking us to expect a 0 rate; that's a
  // bug, but the helper preserves the input verbatim so the
  // slippage layer (which already short-circuits on
  // expected=0) can do its job.
  assert.equal(normalizeExpectedRateToBase(0n, 2), 0n);
});

test('normalizeExpectedRateToBase: garbage string → null (helper refuses)', () => {
  assert.equal(normalizeExpectedRateToBase('not a number', 2), null);
});

// [B04 fix] Division can never overflow via this path (large numbers
// get smaller, not larger). The overflow guard is essentially
// unreachable now; still kept as a defensive backstop.
test('normalizeExpectedRateToBase: huge per-display rate divides cleanly (no overflow)', () => {
  // 1e11 sats/display / 10^8 = 1e3 per-base — well within any sensible
  // AMM rate.
  assert.equal(normalizeExpectedRateToBase(100000000000n, 8), 1000n);
});

// ─────────────────────────────────────────────────────────────────────
//  Regression: B## / bug-preflight-slippage-always-reports-10000-bps
// ─────────────────────────────────────────────────────────────────────

// The OLA-shaped profit case that the B04 fix unblocks. Before the
// flip, the per-display→per-base helper multiplied by 10^decimals,
// which inflated `expectedRateSats` to ~9700 sats/base. The SDK's
// `plan.effectiveRate` (per-base) was something small like 99n, so
// the slippage math returned
//   (9700 - 99) * 10000 / 9700 ≈ 9896 bps
// for every SELL on a `decimals >= 2` token — the slippage
// pre-flight then refused the trade with `slippage_exceeded` and
// the position got stuck. After the divide, the per-base expected
// rate bigint-floors to `0n` for any token whose per-display rate
// is < `10^decimals` (which covers ~all real Cauldron pools), and
// `computeSlippageBps` short-circuits on `exp === 0n` to return
// `0n`. The OLA / NWB / HONEY retry storm this unblocks is what
// makes B05 (stuck-position dead-letter) moot.
test('regression[B##]: OLA-shaped profit → per-base expectedRate floors to 0n → slippage 0n (was 10000)', () => {
  // Step 1: indexer per-display rate 97n / decimals=2 floors to 0n
  // per-base (the bug used to inflate this to 9700n).
  const perBase = normalizeExpectedRateToBase(97n, 2);
  assert.equal(perBase, 0n, 'OLA-shaped indexer rate should floor to 0n per-base after the divide');

  // Step 2: with expectedRate=0n + a real `plan.effectiveRate`,
  // `computeSlippageBps(sell, 0n, 99n)` returns 0n (the
  // `exp === 0n` guard). Pre-fix the equivalent path returned
  // ~9896 bps (which the pre-flight rounded to 10000) and refused
  // the trade as `slippage_exceeded`.
  const slip = computeSlippageBps('sell', perBase, 99n);
  assert.equal(slip, 0n, 'OLA-shaped slippage must be 0n post-fix (was ~10000 bps pre-fix)');

  // Step 3: same shape with the buy side, for symmetry.
  const slipBuy = computeSlippageBps('buy', perBase, 99n);
  assert.equal(slipBuy, 0n, 'OLA-shaped buy slippage must also be 0n post-fix');
});

// Pin the direction-flip contract: a token with `decimals == 0`
// (e.g. FURU-shaped, whose rate is already per-base) must pass
// through the helper unchanged, so existing per-base-unit fixtures
// keep working without a regression.
test('regression[B##]: decimals=0 token → helper is identity (no division, no inflation)', () => {
  // FURU-shape: 380 sats/display with decimals=0 is already
  // per-base (display == base unit for 0-decimal tokens).
  const out = displayRateToBaseRate(380n, 0);
  assert.equal(out.ok, true);
  assert.equal(out.value, 380n, 'decimals=0 must be a no-op (was: trivially a no-op because of early return)');

  // And the slippage math stays correct: 380n expected vs 380n
  // actual → 0n slippage, not the 10000 bps the B## bug reported.
  const slip = computeSlippageBps('sell', 380n, 380n);
  assert.equal(slip, 0n);
});

// Pin the exact-bug-repro: the indexer reported 97.73 sats/display
// for OLA, which the slippage pre-flight turned into 9998 bps
// (rounded to 10000). Post-fix the per-base expected rate bigint-
// floors to 0n and slippage is 0n. We exercise both the
// string-input path (indexer feeds strings) and a realistic
// `plan.effectiveRate` (99n per-base, ~the actual AMM marginal
// rate).
test('regression[B##]: exact-bug-repro string input — slippage 0n post-fix (was 10000)', () => {
  const perBase = normalizeExpectedRateToBase('97', 2);
  assert.equal(perBase, 0n);
  const slip = computeSlippageBps('sell', perBase, 99n);
  assert.equal(slip, 0n);
});
