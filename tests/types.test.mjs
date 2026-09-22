#!/usr/bin/env node
/**
 * Unit tests for src/data/types.mjs.
 *
 * Exercises every exported helper against the shape that the
 * upstream Cauldron indexer (and AI_Skills/skills/cauldron/scripts)
 * actually returns. No I/O, no network — pure-function tests.
 *
 * Run via:
 *   npm test
 * (wired in package.json → "test": "node --test tests/")
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeTokenId,
  isValidTokenId,
  bpsToPct,
  pctToBps,
  bchFromSats,
  satsFromBch,
  spotRateSatsPerToken,
  isValidPool,
  isValidPoolStats,
  isValidToken,
  SATS_PER_BCH,
} from '../src/data/types.mjs';

// ============================================================
// normalizeTokenId
// ============================================================

test('normalizeTokenId: accepts 64-char lowercase hex', () => {
  assert.equal(
    normalizeTokenId('2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544'),
    '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544',
  );
});

test('normalizeTokenId: lowercases mixed-case input', () => {
  assert.equal(
    normalizeTokenId('2469ACC5AFA4B10CB5B5C04AFB89C3A3FFD61C5DA9C01E26D00951CAE2A02544'),
    '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544',
  );
});

test('normalizeTokenId: strips 0x prefix', () => {
  assert.equal(
    normalizeTokenId('0x2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544'),
    '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544',
  );
});

test('normalizeTokenId: throws TypeError on non-string', () => {
  assert.throws(() => normalizeTokenId(123), /expected string/);
  assert.throws(() => normalizeTokenId(null), /expected string/);
  assert.throws(() => normalizeTokenId(undefined), /expected string/);
});

test('normalizeTokenId: throws TypeError on bad length / charset', () => {
  assert.throws(() => normalizeTokenId('not-hex'), /64-char hex/);
  assert.throws(() => normalizeTokenId('a'.repeat(63)), /64-char hex/);
  assert.throws(() => normalizeTokenId('z'.repeat(64)), /64-char hex/);
  assert.throws(() => normalizeTokenId('a'.repeat(64) + 'extra'), /64-char hex/);
});

// ============================================================
// isValidTokenId
// ============================================================

test('isValidTokenId: true for well-formed ids', () => {
  assert.equal(isValidTokenId('2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544'), true);
  assert.equal(isValidTokenId('0x' + 'a'.repeat(64)), true);
  assert.equal(isValidTokenId('A'.repeat(64)), true); // upper-case allowed
});

test('isValidTokenId: false for bad inputs (never throws)', () => {
  assert.equal(isValidTokenId(''), false);
  assert.equal(isValidTokenId(null), false);
  assert.equal(isValidTokenId(undefined), false);
  assert.equal(isValidTokenId(123), false);
  assert.equal(isValidTokenId({}), false);
  assert.equal(isValidTokenId('a'.repeat(63)), false);
  assert.equal(isValidTokenId('a'.repeat(65)), false);
  assert.equal(isValidTokenId('z'.repeat(64)), false);
});

// ============================================================
// bpsToPct / pctToBps
// ============================================================

test('bpsToPct: 500 bp → 5.0', () => {
  assert.equal(bpsToPct(500), 5);
});

test('bpsToPct: negative bp preserves sign', () => {
  assert.equal(bpsToPct(-250), -2.5);
});

test('bpsToPct: returns null for null / undefined / NaN', () => {
  assert.equal(bpsToPct(null), null);
  assert.equal(bpsToPct(undefined), null);
  assert.equal(bpsToPct(NaN), null);
});

test('pctToBps: 5.0 → 500', () => {
  assert.equal(pctToBps(5), 500);
});

test('pctToBps: rounds to nearest integer', () => {
  assert.equal(pctToBps(5.005), 501);
  assert.equal(pctToBps(5.004), 500);
});

test('pctToBps: returns null for nullish / non-finite', () => {
  assert.equal(pctToBps(null), null);
  assert.equal(pctToBps(undefined), null);
  assert.equal(pctToBps(NaN), null);
  assert.equal(pctToBps(Infinity), null);
});

test('bpsToPct / pctToBps round-trip', () => {
  for (const pct of [0, 1, 3.5, 5, 100, -2.5]) {
    assert.equal(bpsToPct(pctToBps(pct)), pct);
  }
});

// ============================================================
// bchFromSats / satsFromBch
// ============================================================

test('bchFromSats: SATS_PER_BCH sats → 1 BCH', () => {
  assert.equal(bchFromSats(SATS_PER_BCH), 1);
  assert.equal(bchFromSats(SATS_PER_BCH * 0.10), 0.10);
  assert.equal(bchFromSats(0), 0);
});

test('bchFromSats: returns null for nullish / non-finite', () => {
  assert.equal(bchFromSats(null), null);
  assert.equal(bchFromSats(undefined), null);
  assert.equal(bchFromSats(NaN), null);
  assert.equal(bchFromSats('not a number'), null);
});

test('satsFromBch: 0.10 BCH → 10_000_000 sats', () => {
  assert.equal(satsFromBch(0.10), 10_000_000);
  assert.equal(satsFromBch(1), SATS_PER_BCH);
  assert.equal(satsFromBch(0), 0);
});

test('satsFromBch: 0.00000001 BCH → exactly 1 sat', () => {
  // 0.00000001 BCH is the smallest BCH amount representable in mainnet
  // sats (1 sat) — no rounding loss.
  assert.equal(satsFromBch(0.00000001), 1);
});

test('satsFromBch: rounds fractional sats to nearest integer', () => {
  // 0.5 BCH = 50_000_000 sats — exactly representable.
  assert.equal(satsFromBch(0.5), 50_000_000);
  // 1.23456789 BCH — exercises the round() (not floor()) in satsFromBch.
  assert.equal(satsFromBch(1.23456789), 123_456_789);
});

test('satsFromBch: returns null for nullish / non-finite', () => {
  assert.equal(satsFromBch(null), null);
  assert.equal(satsFromBch(undefined), null);
  assert.equal(satsFromBch(NaN), null);
});

test('bchFromSats / satsFromBch round-trip (integer values)', () => {
  for (const bch of [0, 0.001, 0.1, 1, 5.5, 100]) {
    assert.equal(bchFromSats(satsFromBch(bch)), bch);
  }
});

// ============================================================
// spotRateSatsPerToken
// ============================================================

test('spotRateSatsPerToken: simple division', () => {
  // 100_000_000 sats / 1_000_000 tokens = 100 sats/token
  assert.equal(spotRateSatsPerToken({ sats: 100_000_000, tokens: 1_000_000 }), 100);
});

test('spotRateSatsPerToken: returns Infinity when tokens = 0', () => {
  assert.equal(spotRateSatsPerToken({ sats: 50_000_000, tokens: 0 }), Infinity);
});

test('spotRateSatsPerToken: returns Infinity when tokens < 0', () => {
  assert.equal(spotRateSatsPerToken({ sats: 50_000_000, tokens: -1 }), Infinity);
});

test('spotRateSatsPerToken: returns NaN for negative sats', () => {
  assert.ok(Number.isNaN(spotRateSatsPerToken({ sats: -1, tokens: 100 })));
});

test('spotRateSatsPerToken: coerces string tokens / bigint tokens', () => {
  assert.equal(spotRateSatsPerToken({ sats: 200, tokens: '4' }), 50);
  assert.equal(spotRateSatsPerToken({ sats: 200, tokens: 4n }), 50);
});

test('spotRateSatsPerToken: returns NaN for non-object input', () => {
  assert.ok(Number.isNaN(spotRateSatsPerToken(null)));
  assert.ok(Number.isNaN(spotRateSatsPerToken(undefined)));
  assert.ok(Number.isNaN(spotRateSatsPerToken('not a pool')));
});

test('spotRateSatsPerToken: returns NaN for non-numeric sats / tokens', () => {
  assert.ok(Number.isNaN(spotRateSatsPerToken({ sats: 'x', tokens: 10 })));
  assert.ok(Number.isNaN(spotRateSatsPerToken({ sats: 10, tokens: 'x' })));
});

// ============================================================
// isValidPool
// ============================================================

test('isValidPool: accepts a fully-formed pool record', () => {
  assert.equal(
    isValidPool({
      pool_id: 'abc123',
      token_id: 'a'.repeat(64),
      sats: 50_000_000,
      tokens: 1_000_000,
      owner_p2pkh_addr: 'bitcoincash:qqqq...',
      txid: '0'.repeat(64),
      tx_pos: 0,
    }),
    true,
  );
});

test('isValidPool: accepts string tokens (indexer raw shape)', () => {
  assert.equal(
    isValidPool({
      pool_id: 'abc123',
      token_id: 'a'.repeat(64),
      sats: 50_000_000,
      tokens: '1000000',
      owner_p2pkh_addr: 'bitcoincash:qqqq...',
      txid: '0'.repeat(64),
      tx_pos: 1,
    }),
    true,
  );
});

test('isValidPool: rejects missing / wrong-typed fields', () => {
  const base = {
    pool_id: 'abc123',
    token_id: 'a'.repeat(64),
    sats: 50_000_000,
    tokens: 1_000_000,
    owner_p2pkh_addr: 'bitcoincash:qqqq...',
    txid: '0'.repeat(64),
    tx_pos: 0,
  };
  for (const k of Object.keys(base)) {
    const bad = { ...base, [k]: undefined };
    assert.equal(isValidPool(bad), false, `should reject when ${k} is undefined`);
  }
  assert.equal(isValidPool(null), false);
  assert.equal(isValidPool(undefined), false);
  assert.equal(isValidPool({}), false);
  assert.equal(isValidPool('not a pool'), false);
});

// ============================================================
// isValidPoolStats
// ============================================================

test('isValidPoolStats: accepts a fully-formed stats record', () => {
  assert.equal(
    isValidPoolStats({
      token_id: 'a'.repeat(64),
      symbol: 'PUSD',
      price_now_sats: 14500,
      trade_volume_sats: 5_000_000_000,
      score: 0.82,
      score_rank: 3,
    }),
    true,
  );
});

test('isValidPoolStats: accepts nullable numeric fields as null', () => {
  assert.equal(
    isValidPoolStats({
      token_id: 'a'.repeat(64),
      price_now_sats: null,
      trade_volume_sats: null,
      apy_30d_bp: null,
    }),
    true,
  );
});

test('isValidPoolStats: rejects non-object / missing token_id', () => {
  assert.equal(isValidPoolStats(null), false);
  assert.equal(isValidPoolStats({}), false);
  assert.equal(isValidPoolStats({ token_id: 123 }), false);
});

// ============================================================
// isValidToken
// ============================================================

test('isValidToken: accepts a BCMR-shaped token', () => {
  assert.equal(
    isValidToken({
      token_id: 'a'.repeat(64),
      symbol: 'PUSD',
      decimals: 2,
      name: 'Paytaca USD',
    }),
    true,
  );
});

test('isValidToken: accepts minimal token record (token_id only)', () => {
  assert.equal(isValidToken({ token_id: 'a'.repeat(64) }), true);
});

test('isValidToken: rejects bad inputs', () => {
  assert.equal(isValidToken(null), false);
  assert.equal(isValidToken({}), false);
  assert.equal(isValidToken({ token_id: 123 }), false);
  assert.equal(isValidToken('token'), false);
});

// ============================================================
// SATS_PER_BCH constant
// ============================================================

test('SATS_PER_BCH === 100_000_000 (mainnet BCH constant)', () => {
  assert.equal(SATS_PER_BCH, 100_000_000);
});
