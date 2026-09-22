#!/usr/bin/env node
/**
 * tests/data/top20.test.mjs (DT08)
 *
 * Validates the composite-score computation + ranking used by
 * scripts/pull-data.mjs --top20 against known fixtures.
 *
 * The composite formula is:
 *   score = trade_volume_sats * tvl_sats * (1 + |change_24h_bp| / 10000)
 *
 * Where:
 *   - trade_volume_sats = 24h volume in sats (BCH-denominated)
 *   - tvl_sats = token-side TVL in sats
 *   - change_24h_bp = 24h price delta in integer basis points (absolute)
 *
 * Higher score = more attractive. The top-20 is then written to
 * data/top-tokens.json. This test file locks in the scoring behavior
 * so a future change to the formula must be intentional.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

// Import the helpers from the production script (DT05).
import { compositeScore, rankTokens } from '../../scripts/pull-data.mjs';

// ─── Fixtures ────────────────────────────────────────────────────────────────

/**
 * Build a minimal PoolStats record with sensible defaults for ranking tests.
 * @param {Object} overrides
 */
function makeStats(overrides) {
  return {
    token_id: 'a'.repeat(64),
    name: null,
    symbol: null,
    decimals: null,
    decimals_warn: null,
    price_now_sats: null,
    price_now_usd: null,
    price_24h_sats: null,
    price_7d_sats: null,
    change_24h_bp: null,
    change_24h_usd_bp: null,
    change_7d_bp: null,
    change_7d_usd_bp: null,
    trade_count: null,
    trade_volume_sats: null,
    tvl_sats: null,
    tvl_tokens: null,
    apy_30d_bp: null,
    score: null,
    score_rank: null,
    ...overrides,
  };
}

// ─── compositeScore tests ────────────────────────────────────────────────────

describe('compositeScore (DT08 fixture: known inputs → known outputs)', () => {
  test('basic: non-null fields', () => {
    // vol=1000, tvl=2000, chg=100bp → factor (1 + 100/10000) = 1.01
    // score = 1000 * 2000 * 1.01 = 2_020_000
    const stats = {
      token_id: 'a'.repeat(64),
      trade_volume_sats: 1000,
      tvl_sats: 2000,
      change_24h_bp: 100,
    };
    assert.strictEqual(compositeScore(stats), 1000 * 2000 * (1 + 100 / 10000));
  });

  test('null volume → treated as 0 (zero score)', () => {
    const stats = {
      token_id: 'a'.repeat(64),
      trade_volume_sats: null,
      tvl_sats: 2000,
      change_24h_bp: 100,
    };
    assert.strictEqual(compositeScore(stats), 0);
  });

  test('null tvl → treated as 0 (zero score)', () => {
    const stats = {
      token_id: 'a'.repeat(64),
      trade_volume_sats: 1000,
      tvl_sats: null,
      change_24h_bp: 100,
    };
    assert.strictEqual(compositeScore(stats), 0);
  });

  test('null change → neutral factor of 1', () => {
    const stats = {
      token_id: 'a'.repeat(64),
      trade_volume_sats: 1000,
      tvl_sats: 2000,
      change_24h_bp: null,
    };
    assert.strictEqual(compositeScore(stats), 1000 * 2000 * 1);
  });

  test('negative change → uses absolute value (volatility bonus)', () => {
    const stats = {
      token_id: 'a'.repeat(64),
      trade_volume_sats: 1000,
      tvl_sats: 2000,
      change_24h_bp: -500,
    };
    // |−500| = 500
    assert.strictEqual(compositeScore(stats), 1000 * 2000 * (1 + 500 / 10000));
  });

  test('zero volume and tvl → score 0', () => {
    const stats = {
      token_id: 'a'.repeat(64),
      trade_volume_sats: 0,
      tvl_sats: 0,
      change_24h_bp: null,
    };
    assert.strictEqual(compositeScore(stats), 0);
  });

  test('realistic fixture: PUSD-like numbers', () => {
    // 24h volume = 5_000_000_000 sats (50 BCH)
    // TVL = 100_000_000_000 sats (1000 BCH)
    // 24h change = 250 bp (2.5%)
    // expected score = 5e9 * 1e11 * (1 + 250/10000)
    //                = 5e20 * 1.025
    //                = 5.125e20
    const stats = {
      token_id: 'a'.repeat(64),
      trade_volume_sats: 5_000_000_000,
      tvl_sats: 100_000_000_000,
      change_24h_bp: 250,
    };
    const expected = 5_000_000_000 * 100_000_000_000 * (1 + 250 / 10000);
    assert.strictEqual(compositeScore(stats), expected);
  });
});

// ─── rankTokens tests ──────────────────────────────────────────────────────

describe('rankTokens (DT08 fixture: known input list → known ranking)', () => {
  test('sorts descending by composite score', () => {
    const tokens = [
      makeStats({ token_id: 'a'.repeat(64), symbol: 'LOW', trade_volume_sats: 100, tvl_sats: 100, change_24h_bp: 0 }),
      makeStats({ token_id: 'b'.repeat(64), symbol: 'HIGH', trade_volume_sats: 1000, tvl_sats: 1000, change_24h_bp: 0 }),
      makeStats({ token_id: 'c'.repeat(64), symbol: 'MID', trade_volume_sats: 500, tvl_sats: 500, change_24h_bp: 0 }),
    ];
    const ranked = rankTokens(tokens);
    assert.strictEqual(ranked[0].symbol, 'HIGH');
    assert.strictEqual(ranked[1].symbol, 'MID');
    assert.strictEqual(ranked[2].symbol, 'LOW');
  });

  test('assigns ranks 1..N (rank is 1-indexed)', () => {
    const tokens = [
      makeStats({ token_id: 'a'.repeat(64), trade_volume_sats: 1, tvl_sats: 1, change_24h_bp: 0 }),
      makeStats({ token_id: 'b'.repeat(64), trade_volume_sats: 2, tvl_sats: 2, change_24h_bp: 0 }),
      makeStats({ token_id: 'c'.repeat(64), trade_volume_sats: 3, tvl_sats: 3, change_24h_bp: 0 }),
    ];
    const ranked = rankTokens(tokens);
    assert.strictEqual(ranked[0].rank, 1);
    assert.strictEqual(ranked[1].rank, 2);
    assert.strictEqual(ranked[2].rank, 3);
  });

  test('filters out records missing token_id', () => {
    const tokens = [
      makeStats({ token_id: 'a'.repeat(64), trade_volume_sats: 1, tvl_sats: 1, change_24h_bp: 0 }),
      { token_id: '', trade_volume_sats: 999, tvl_sats: 999, change_24h_bp: 0 }, // falsy token_id
      makeStats({ token_id: 'c'.repeat(64), trade_volume_sats: 3, tvl_sats: 3, change_24h_bp: 0 }),
    ];
    const ranked = rankTokens(tokens);
    assert.strictEqual(ranked.length, 2);
    assert.strictEqual(ranked[0].rank, 1);
    assert.strictEqual(ranked[1].rank, 2);
  });

  test('stable: same score keeps original relative order', () => {
    const tokens = [
      makeStats({ token_id: 'a'.repeat(64), symbol: 'FIRST', trade_volume_sats: 100, tvl_sats: 100, change_24h_bp: 0 }),
      makeStats({ token_id: 'b'.repeat(64), symbol: 'SECOND', trade_volume_sats: 100, tvl_sats: 100, change_24h_bp: 0 }),
    ];
    const ranked = rankTokens(tokens);
    // Both have score 100*100*1 = 10000. Sort is stable, so FIRST should come before SECOND.
    assert.strictEqual(ranked[0].symbol, 'FIRST');
    assert.strictEqual(ranked[1].symbol, 'SECOND');
  });

  test('returns 0 tokens for empty array', () => {
    const ranked = rankTokens([]);
    assert.strictEqual(ranked.length, 0);
  });

  test('volatility bonus: token with big 24h move ranks higher', () => {
    // Two tokens with identical volume * tvl product, but one has a big move
    const tokens = [
      makeStats({ token_id: 'a'.repeat(64), symbol: 'FLAT',   trade_volume_sats: 1000, tvl_sats: 1000, change_24h_bp: 0 }),
      makeStats({ token_id: 'b'.repeat(64), symbol: 'VOLATILE', trade_volume_sats: 1000, tvl_sats: 1000, change_24h_bp: 1000 }), // 10% move
    ];
    const ranked = rankTokens(tokens);
    // VOLATILE: 1000*1000*1.10 = 1_100_000; FLAT: 1000*1000*1.0 = 1_000_000
    assert.strictEqual(ranked[0].symbol, 'VOLATILE');
    assert.strictEqual(ranked[1].symbol, 'FLAT');
    assert.strictEqual(ranked[0].score, 1_100_000);
    assert.strictEqual(ranked[1].score, 1_000_000);
  });

  test('top-20 slicing: with 25 entries, returns top 20', () => {
    // Synthetic 25-entry list, descending order pre-rank
    const tokens = [];
    for (let i = 25; i >= 1; i--) {
      tokens.push(makeStats({
        token_id: String(i).padStart(64, 'a'),
        symbol: `T${i}`,
        trade_volume_sats: i,
        tvl_sats: i,
        change_24h_bp: 0,
      }));
    }
    const ranked = rankTokens(tokens);
    assert.strictEqual(ranked.length, 25, 'rankTokens itself returns all ranked entries');
    const top20 = ranked.slice(0, 20);
    assert.strictEqual(top20.length, 20);
    assert.strictEqual(top20[0].symbol, 'T25');
    assert.strictEqual(top20[19].symbol, 'T6');
  });
});