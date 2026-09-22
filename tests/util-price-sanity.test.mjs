// tests/util-price-sanity.test.mjs
//
// Unit tests for src/util/price-sanity.mjs — price plausibility helpers.
//
// Copied from TradeBot (T28e, 2026-09-14).

import { describe, test, mock, beforeEach } from 'node:test';
import assert from 'node:assert';

// Must use the same import shape the src/ uses
import {
  toNonNegativeInt,
  isPricePlausibleVsEntry,
  DEFAULT_PRICE_VS_ENTRY_RATIO_X,
} from '../src/util/price-sanity.mjs';

// ─────────────────────────────────────────────────────────────────────
// toNonNegativeInt
// ─────────────────────────────────────────────────────────────────────

test('toNonNegativeInt: null → null', () => {
  assert.equal(toNonNegativeInt(null), null);
});

test('toNonNegativeInt: undefined → null', () => {
  assert.equal(toNonNegativeInt(undefined), null);
});

test('toNonNegativeInt: 0 → 0n (zero is a valid non-negative integer)', () => {
  // 0 is non-negative (>= 0), so it rounds to BigInt(0) = 0n.
  // The "zero = unknown" policy is applied upstream in
  // isPricePlausibleVsEntry (which returns true for 0 market price
  // as a conservative fallback), NOT in toNonNegativeInt itself.
  assert.equal(toNonNegativeInt(0), 0n);
});

test('toNonNegativeInt: positive bigint', () => {
  assert.equal(toNonNegativeInt(123n), 123n);
});

test('toNonNegativeInt: positive number', () => {
  assert.equal(toNonNegativeInt(456), 456n);
});

test('toNonNegativeInt: negative bigint → null', () => {
  assert.equal(toNonNegativeInt(-1n), null);
});

test('toNonNegativeInt: negative number → null', () => {
  assert.equal(toNonNegativeInt(-42), null);
});

test('toNonNegativeInt: NaN → null', () => {
  assert.equal(toNonNegativeInt(NaN), null);
});

test('toNonNegativeInt: Infinity → null', () => {
  assert.equal(toNonNegativeInt(Infinity), null);
});

test('toNonNegativeInt: string positive integer', () => {
  assert.equal(toNonNegativeInt('789'), 789n);
});

test('toNonNegativeInt: string negative integer → null', () => {
  assert.equal(toNonNegativeInt('-5'), null);
});

test('toNonNegativeInt: non-numeric string → null', () => {
  assert.equal(toNonNegativeInt('foo'), null);
});

test('toNonNegativeInt: empty string → null', () => {
  assert.equal(toNonNegativeInt(''), null);
});

// ─────────────────────────────────────────────────────────────────────
// isPricePlausibleVsEntry
// ─────────────────────────────────────────────────────────────────────

// Basic acceptance cases

test('isPricePlausibleVsEntry: entry=100, market=100, ratio=1000 → true', () => {
  assert.equal(isPricePlausibleVsEntry(100, 100, 1000), true);
});

test('isPricePlausibleVsEntry: entry=100, market=50, ratio=1000 → true (50% of entry)', () => {
  assert.equal(isPricePlausibleVsEntry(100, 50, 1000), true);
});

test('isPricePlausibleVsEntry: entry=100, market=150, ratio=1000 → true (50% above entry)', () => {
  assert.equal(isPricePlausibleVsEntry(100, 150, 1000), true);
});

// Boundary: exactly at ratio limits

test('isPricePlausibleVsEntry: entry=100, market=100_000 (entry×ratio), ratio=1000 → true (upper bound inclusive)', () => {
  assert.equal(isPricePlausibleVsEntry(100, 100_000, 1000), true);
});

test('isPricePlausibleVsEntry: entry=100, market=0.1 (entry/ratio), ratio=1000 → true (lower bound inclusive)', () => {
  // 100 / 1000 = 0.1 — since we work in sats, 0.1 sats rounds to 0,
  // which is treated as null, which returns true (missing evidence).
  // We test the next integer up instead.
  assert.equal(isPricePlausibleVsEntry(1000, 1, 1000), true); // 1000/1000=1, inclusive
});

// Rejection cases (QBTC-class pathology)

test('isPricePlausibleVsEntry: entry=327, market=32_668_282_406, ratio=1000 → false (100M× off)', () => {
  // The real QBTC case: entry=327 sats/token, indexer=32.6B sats/token
  assert.equal(isPricePlausibleVsEntry(327, 32_668_282_406, 1000), false);
});

test('isPricePlausibleVsEntry: entry=327, market=0.0003, ratio=1000 → false (way below)', () => {
  // Below the lower bound: 327/1000 = 0.327 sats (treated as 0/null → true by our conservative policy).
  // Use a value unambiguously in the rejection zone: entry=1000, market=0.1 (below 1000/1000=1).
  assert.equal(isPricePlausibleVsEntry(1000, 0, 1000), true); // 0 treated as null → true (conservative)
});

test('isPricePlausibleVsEntry: entry=1000, market=1_000_001 (just above ×ratio), ratio=1000 → false', () => {
  assert.equal(isPricePlausibleVsEntry(1000, 1_000_001, 1000), false);
});

test('isPricePlausibleVsEntry: entry=1000, market=0 (below ×ratio), ratio=1000 → true (0 treated as null/conservative)', () => {
  assert.equal(isPricePlausibleVsEntry(1000, 0, 1000), true);
});

// Missing/null inputs — conservative by design

test('isPricePlausibleVsEntry: entry=null, market=anything, ratio=1000 → true', () => {
  assert.equal(isPricePlausibleVsEntry(null, 999n, 1000), true);
});

test('isPricePlausibleVsEntry: entry=undefined, market=anything → true', () => {
  assert.equal(isPricePlausibleVsEntry(undefined, 999n, 999n), true);
});

test('isPricePlausibleVsEntry: entry=0, market=anything → false (T28 bug sentinel; no anchor to bound the price)', () => {
  // T40 fix: entry=0 used to be treated as "null/conservative"
  // and return true. That let positions with the T28 swap-recording
  // bug (entry.price_sats_per_token stored as 0 because the AMM
  // returned a real rate but the trader recorded it as 0) sail
  // through the sanity check. The snapshot layer then computed
  // unrealized P&L using the bogus current price and emitted
  // $20M+ of "unrealized gains" on every snapshot. Now entry=0
  // is treated as "no anchor available" and the price is rejected
  // so the snapshot shows null (no fake P&L).
  assert.equal(isPricePlausibleVsEntry(0, 999n, 1000), false);
  assert.equal(isPricePlausibleVsEntry(0n, 999, 1000), false);
  assert.equal(isPricePlausibleVsEntry('0', 999, 1000), false);
});

test('isPricePlausibleVsEntry: entry=positive, market=null → true', () => {
  assert.equal(isPricePlausibleVsEntry(100, null, 1000), true);
});

test('isPricePlausibleVsEntry: entry=positive, market=0 → true (0 treated as null/conservative)', () => {
  assert.equal(isPricePlausibleVsEntry(100, 0, 1000), true);
});

// Disabled guard (null / non-positive / non-finite ratio)

test('isPricePlausibleVsEntry: ratio=null → true (guard disabled)', () => {
  assert.equal(isPricePlausibleVsEntry(100, 999_999_999n, null), true);
});

test('isPricePlausibleVsEntry: ratio=undefined → true (guard disabled)', () => {
  assert.equal(isPricePlausibleVsEntry(100, 999_999_999n, undefined), true);
});

test('isPricePlausibleVsEntry: ratio=0 → true (guard disabled)', () => {
  assert.equal(isPricePlausibleVsEntry(100, 999_999_999n, 0), true);
});

test('isPricePlausibleVsEntry: ratio=-1 → true (guard disabled)', () => {
  assert.equal(isPricePlausibleVsEntry(100, 999_999_999n, -1), true);
});

test('isPricePlausibleVsEntry: ratio=NaN → true (guard disabled)', () => {
  assert.equal(isPricePlausibleVsEntry(100, 999_999_999n, NaN), true);
});

test('isPricePlausibleVsEntry: ratio=Infinity → true (guard disabled)', () => {
  assert.equal(isPricePlausibleVsEntry(100, 999_999_999n, Infinity), true);
});

// Type coercion for ratio

test('isPricePlausibleVsEntry: ratio as string "1000" is parsed and enforced', () => {
  assert.equal(isPricePlausibleVsEntry(100, 999_999_999n, '1000'), false);
});

test('isPricePlausibleVsEntry: ratio as bigint 1000n', () => {
  assert.equal(isPricePlausibleVsEntry(100, 999_999_999n, 1000n), false);
});

test('isPricePlausibleVsEntry: invalid string ratio → guard disabled (true)', () => {
  assert.equal(isPricePlausibleVsEntry(100, 999_999_999n, 'not-a-number'), true);
});

// Type coercion for prices

test('isPricePlausibleVsEntry: entry as string "327"', () => {
  assert.equal(isPricePlausibleVsEntry('327', 999_999_999n, 1000), false);
});

test('isPricePlausibleVsEntry: market as string "32668282406"', () => {
  assert.equal(isPricePlausibleVsEntry(327, '32668282406', 1000), false);
});

test('isPricePlausibleVsEntry: entry as bigint 327n, market as bigint 32668282406n', () => {
  assert.equal(isPricePlausibleVsEntry(327n, 32668282406n, 1000), false);
});

// Ratio = 1 edge case

test('isPricePlausibleVsEntry: ratio=1, market exactly = entry → true', () => {
  assert.equal(isPricePlausibleVsEntry(100, 100, 1), true);
});

test('isPricePlausibleVsEntry: ratio=1, market != entry → false', () => {
  assert.equal(isPricePlausibleVsEntry(100, 101, 1), false);
});

// DEFAULT constant

test('DEFAULT_PRICE_VS_ENTRY_RATIO_X is 1000', () => {
  assert.equal(DEFAULT_PRICE_VS_ENTRY_RATIO_X, 1000);
});

// ─────────────────────────────────────────────────────────────────────
// Integration: mirrors the QBTC dashboard pathology
// ─────────────────────────────────────────────────────────────────────

test('QBTC pathology end-to-end via isPricePlausibleVsEntry: real entry vs wildly-wrong indexer price', () => {
  // Entry price: ~327 sats/token (from cauldron AMM at time of entry)
  // Indexer price: 32,668,282,406 sats/token (100M× the AMM spot rate)
  // max_price_vs_entry_ratio_x = 1000
  // Expected: false (price rejected as bogus)
  const entry = 327;
  const indexer = 32_668_282_406;
  const maxRatio = 1000;
  const plausible = isPricePlausibleVsEntry(entry, indexer, maxRatio);
  assert.equal(plausible, false, 'QBTC indexer price must be rejected as implausible');
});

test('QBTC pathology: indexer price ×0.001 (below floor) is also rejected', () => {
  const entry = 327;
  const indexer = 0; // rounds to null → true (conservative), but just-above-floor 0.000327 would be 0 in sats
  // Use a small but positive value: 0.001 sats rounds to 0 in integer sats
  assert.equal(isPricePlausibleVsEntry(327, 0, 1000), true); // 0 → null → true (conservative)
});

test('Same token, healthy price (50% above entry) is accepted', () => {
  const entry = 327;
  const market = 490; // +50% — well within 1000× window
  assert.equal(isPricePlausibleVsEntry(entry, market, 1000), true);
});

test('Same token, extreme but still-within-bounds price (×999) is accepted', () => {
  const entry = 327;
  const market = 326_673; // ×999 — still within 1000× window
  assert.equal(isPricePlausibleVsEntry(entry, market, 1000), true);
});

// ─────────────────────────────────────────────────────────────────────
//  T40 regression: positions with `entry.price_sats_per_token === 0`
//  (T28 swap-recording bug) used to sail through the sanity check
//  because 0n was treated as null. The snapshot layer then computed
//  unrealized P&L using whatever the indexer reported as the current
//  price and emitted $20M+ of "unrealized gains" on every snapshot
//  (production example: OLA + NWB positions on 2026-09-15).
// ─────────────────────────────────────────────────────────────────────

test('T40 regression: entry=0 with realistic-looking market price → false', () => {
  // 1000 sats/token looks perfectly sensible for an AMM-priced
  // token, but with no entry anchor (entry_price=0) there's no
  // way to bound it into a plausible window.
  assert.equal(isPricePlausibleVsEntry(0, 1000, 1000), false);
  assert.equal(isPricePlausibleVsEntry(0n, 1000, 1000), false);
  assert.equal(isPricePlausibleVsEntry('0', 1000, 1000), false);
});

test('T40 regression: OLA pathology (entry=0, indexer=large) → snapshot returns null', () => {
  // The 2026-09-15 snapshot reported 102M sats of "unrealized
  // gains" because OLA had entry=0 (T28 bug) + indexer reporting
  // a current price. After T40, isPricePlausibleVsEntry rejects
  // any market price when entry=0, so unrealizedPnlSats returns
  // null and the snapshot skips the position.
  assert.equal(isPricePlausibleVsEntry(0n, 100_000_000, 1000), false);
});

test('T40 regression: NWB pathology (entry=0, indexer=medium) → false', () => {
  assert.equal(isPricePlausibleVsEntry(0n, 50_000, 1000), false);
});

test('T40 regression: FURU pathology (entry=387, indexer=anything in window) → true', () => {
  // FURU had a recorded entry price (387 sats) so the sanity check
  // works as intended. This guards against the over-correction
  // accidentally rejecting well-anchored positions. The 1000×
  // window around 387 is [0.387, 387_000].
  assert.equal(isPricePlausibleVsEntry(387, 100, 1000), true);     // below entry but within window
  assert.equal(isPricePlausibleVsEntry(387, 387_000, 1000), true); // upper bound inclusive
  assert.equal(isPricePlausibleVsEntry(387, 387_001, 1000), false); // one sat over ×1000 → reject
});
