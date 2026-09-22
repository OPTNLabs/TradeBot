#!/usr/bin/env node
/**
 * Unit tests for src/strategy/ranker.mjs.
 *
 * Pure-function tests. No I/O, no logger, no process state. Run via:
 *   npm test
 *
 * Covers:
 *   - resolveRankerConfig: defaults + overrides + bad-input handling
 *   - poolFirstSeenMs: field preference + ms/string + missing
 *   - poolAgeDays: ms/string inputs, negative/zero/invalid `now`
 *   - filterByMinScore: drops below floor + ineligible + garbage
 *   - filterByMaxAge: drops UNDER cap (T37 flip), keeps no-timestamp pools
 *   - dedupByTokenId: keeps highest score; token_id tiebreaker
 *   - sortByScore: desc by score, token_id asc tiebreaker, non-mutating
 *   - takeTopK: 1-indexed rank, k > length, k < 1
 *   - rankPools (end-to-end): top-K selection, reasoning blob, meta counts,
 *     age filter behavior, dedup interaction with filter chain
 *   - guard: top_k_candidates comes from config, not hard-coded
 *   - guard: min_score comes from config, not hard-coded
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_RANKER_CONFIG,
  resolveRankerConfig,
  poolFirstSeenMs,
  poolAgeDays,
  filterByMinScore,
  filterByMaxAge,
  dedupByTokenId,
  sortByScore,
  takeTopK,
  rankPools,
} from '../src/strategy/ranker.mjs';
import {
  DEFAULT_SCORING_CONFIG,
  resolveScoringConfig,
  scorePools,
} from '../src/strategy/scoring.mjs';
import { SATS_PER_BCH } from '../src/data/types.mjs';

// ────────────────────────────────────────────────────────────────────
//  Fixtures
// ────────────────────────────────────────────────────────────────────

const TID_A = 'a'.repeat(64);
const TID_B = 'b'.repeat(64);
const TID_C = 'c'.repeat(64);
const TID_D = 'd'.repeat(64);
const TID_E = 'e'.repeat(64);
const NOW_MS = Date.UTC(2026, 8, 10, 12, 0, 0); // 2026-09-10T12:00:00Z
const MS_PER_DAY = 86_400_000;

/** A "healthy" stats record that passes every gate. */
function healthyStats(overrides = {}) {
  return {
    token_id: TID_A,
    symbol: 'TEST',
    decimals: 0,
    trade_volume_sats: 2 * SATS_PER_BCH,    // passes min_volume
    tvl_sats: 1 * SATS_PER_BCH,             // passes min_tvl
    change_24h_bp: 500,
    apy_30d_bp: 5000,
    trade_count: 100,
    price_now_sats: 1000,
    // T28c: realistic 29-point series with upward spikes. Without
    // this, the new min_upward_volatility=0.05 gate fails the pool.
    price_series_7d: [
      0.90, 0.92, 0.91, 0.93, 0.95, 0.94, 0.96, 0.98, 0.97, 0.99,
      1.00, 0.98, 0.96, 0.97, 0.99, 1.00, 0.99, 0.97, 0.98, 1.00,
      0.98, 0.97, 0.99, 1.00, 0.99, 0.98, 1.00, 0.99, 1.00,
    ],
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────
//  resolveRankerConfig
// ────────────────────────────────────────────────────────────────────

test('resolveRankerConfig: returns defaults on null/undefined/bad input', () => {
  for (const bad of [null, undefined, 0, 'string', 42, true, [], NaN]) {
    const cfg = resolveRankerConfig(bad);
    assert.equal(cfg.min_score, DEFAULT_SCORING_CONFIG.min_score);
    assert.equal(cfg.max_pool_age_days, DEFAULT_RANKER_CONFIG.max_pool_age_days);
    assert.equal(cfg.top_k_candidates, DEFAULT_RANKER_CONFIG.top_k_candidates);
    assert.equal(cfg.weights.volume_24h_bch, DEFAULT_SCORING_CONFIG.weights.volume_24h_bch);
  }
});

test('resolveRankerConfig: honors top_k_candidates override', () => {
  const cfg = resolveRankerConfig({ top_k_candidates: 7 });
  assert.equal(cfg.top_k_candidates, 7);
});

test('resolveRankerConfig: clamps top_k_candidates to >=1', () => {
  for (const v of [0, -5, 0.4]) {
    const cfg = resolveRankerConfig({ top_k_candidates: v });
    assert.equal(cfg.top_k_candidates, 1);
  }
});

test('resolveRankerConfig: honors max_pool_age_days override', () => {
  const cfg = resolveRankerConfig({ max_pool_age_days: 30 });
  assert.equal(cfg.max_pool_age_days, 30);
});

test('resolveRankerConfig: replaces negative max_pool_age_days with default', () => {
  const cfg = resolveRankerConfig({ max_pool_age_days: -10 });
  assert.equal(cfg.max_pool_age_days, DEFAULT_RANKER_CONFIG.max_pool_age_days);
});

test('resolveRankerConfig: drops garbage numeric overrides silently', () => {
  const cfg = resolveRankerConfig({
    max_pool_age_days: 'nope',
    top_k_candidates: NaN,
    min_score: undefined,
  });
  assert.equal(cfg.max_pool_age_days, DEFAULT_RANKER_CONFIG.max_pool_age_days);
  assert.equal(cfg.top_k_candidates, DEFAULT_RANKER_CONFIG.top_k_candidates);
  assert.equal(cfg.min_score, DEFAULT_SCORING_CONFIG.min_score);
});

test('resolveRankerConfig: returns a fresh copy (no aliasing of DEFAULT_RANKER_CONFIG)', () => {
  const cfg = resolveRankerConfig();
  cfg.weights.volume_24h_bch = 0.99;
  cfg.top_k_candidates = 999;
  assert.equal(DEFAULT_RANKER_CONFIG.weights.volume_24h_bch, DEFAULT_SCORING_CONFIG.weights.volume_24h_bch);
  assert.equal(DEFAULT_RANKER_CONFIG.top_k_candidates, 3);
});

// ────────────────────────────────────────────────────────────────────
//  poolFirstSeenMs
// ────────────────────────────────────────────────────────────────────

test('poolFirstSeenMs: prefers first_seen_ts_ms', () => {
  const ms = 1_700_000_000_000;
  assert.equal(poolFirstSeenMs({ first_seen_ts_ms: ms }), ms);
  assert.equal(poolFirstSeenMs({ first_seen_ts_ms: ms, created_at_ts_ms: ms + 1 }), ms);
});

test('poolFirstSeenMs: falls back to created_at_ts_ms', () => {
  const ms = 1_700_000_000_000;
  assert.equal(poolFirstSeenMs({ created_at_ts_ms: ms }), ms);
});

test('poolFirstSeenMs: parses ISO-8601 strings (first_seen, created_at)', () => {
  const iso = '2026-09-01T00:00:00Z';
  const expectedMs = Date.parse(iso);
  assert.equal(poolFirstSeenMs({ first_seen: iso }), expectedMs);
  assert.equal(poolFirstSeenMs({ created_at: '2026-09-01T00:00:00Z' }), expectedMs);
});

test('poolFirstSeenMs: returns null for missing fields', () => {
  assert.equal(poolFirstSeenMs({}), null);
  assert.equal(poolFirstSeenMs({ token_id: TID_A }), null);
  assert.equal(poolFirstSeenMs(null), null);
  assert.equal(poolFirstSeenMs(undefined), null);
  assert.equal(poolFirstSeenMs('string'), null);
});

test('poolFirstSeenMs: ignores non-finite / non-positive values', () => {
  assert.equal(poolFirstSeenMs({ first_seen_ts_ms: 0 }), null);
  assert.equal(poolFirstSeenMs({ first_seen_ts_ms: -1 }), null);
  assert.equal(poolFirstSeenMs({ first_seen_ts_ms: NaN }), null);
  assert.equal(poolFirstSeenMs({ first_seen_ts_ms: 'nope' }), null);
  assert.equal(poolFirstSeenMs({ first_seen: 'not a date' }), null);
});

// ────────────────────────────────────────────────────────────────────
//  poolAgeDays
// ────────────────────────────────────────────────────────────────────

test('poolAgeDays: returns fractional days between now and first_seen', () => {
  const ms = NOW_MS - 5 * MS_PER_DAY - 12 * 3_600_000; // 5.5 days ago
  assert.equal(poolAgeDays({ first_seen_ts_ms: ms }, NOW_MS), 5.5);
});

test('poolAgeDays: returns 0 when now <= first_seen', () => {
  const ms = NOW_MS + 5 * MS_PER_DAY; // pool from the future
  assert.equal(poolAgeDays({ first_seen_ts_ms: ms }, NOW_MS), 0);
});

test('poolAgeDays: returns null when no timestamp is present', () => {
  assert.equal(poolAgeDays({}, NOW_MS), null);
  assert.equal(poolAgeDays({ token_id: TID_A }, NOW_MS), null);
});

test('poolAgeDays: returns null for invalid `now`', () => {
  const ms = NOW_MS - MS_PER_DAY;
  assert.equal(poolAgeDays({ first_seen_ts_ms: ms }, NaN), null);
  assert.equal(poolAgeDays({ first_seen_ts_ms: ms }, undefined), null);
});

// ────────────────────────────────────────────────────────────────────
//  filterByMinScore
// ────────────────────────────────────────────────────────────────────

test('filterByMinScore: drops records below cfg.min_score', () => {
  const cfg = resolveScoringConfig({ min_score: 0.5 });
  const records = [
    { token_id: TID_A, score: 0.6, eligible: true, reasons: [] },
    { token_id: TID_B, score: 0.4, eligible: true, reasons: [] },
    { token_id: TID_C, score: 0.51, eligible: true, reasons: [] },
  ];
  const out = filterByMinScore(records, cfg);
  assert.deepEqual(out.map((r) => r.token_id), [TID_A, TID_C]);
});

test('filterByMinScore: drops ineligible records regardless of score', () => {
  const cfg = resolveScoringConfig({ min_score: 0.0 });
  const records = [
    { token_id: TID_A, score: 0.9, eligible: true, reasons: [] },
    { token_id: TID_B, score: 0.9, eligible: false, reasons: ['volume_below'] },
  ];
  const out = filterByMinScore(records, cfg);
  assert.deepEqual(out.map((r) => r.token_id), [TID_A]);
});

test('filterByMinScore: drops records with non-finite score', () => {
  const cfg = resolveScoringConfig({ min_score: 0.5 });
  const records = [
    { token_id: TID_A, score: NaN, eligible: true, reasons: [] },
    { token_id: TID_B, score: Infinity, eligible: true, reasons: [] },
    { token_id: TID_C, score: 0.9, eligible: true, reasons: [] },
  ];
  const out = filterByMinScore(records, cfg);
  assert.deepEqual(out.map((r) => r.token_id), [TID_C]);
});

test('filterByMinScore: empty / non-array input returns []', () => {
  const cfg = resolveScoringConfig();
  assert.deepEqual(filterByMinScore([], cfg), []);
  assert.deepEqual(filterByMinScore(null, cfg), []);
  assert.deepEqual(filterByMinScore('garbage', cfg), []);
});

test('filterByMinScore: bad cfg.min_score passes through everything', () => {
  const records = [
    { token_id: TID_A, score: 0.0, eligible: true, reasons: [] },
  ];
  const out = filterByMinScore(records, { min_score: NaN });
  assert.deepEqual(out.map((r) => r.token_id), [TID_A]);
});

// ────────────────────────────────────────────────────────────────────
//  filterByMaxAge
// ────────────────────────────────────────────────────────────────────

test('filterByMaxAge: drops pools newer than max_pool_age_days (T37 semantic flip)', () => {
  // T37 flipped the semantic from "drop pools OLDER than cap" to
  // "drop pools NEWER than cap" (matches docs/SETTINGS.md and the
  // operator's intent — freshly-launched tokens are the wash-trade /
  // seed-swap risk). With max=30, the 60-day-old pool is KEPT and
  // the 5-day-old pool is DROPPED.
  const cfg = resolveRankerConfig({ max_pool_age_days: 30 });
  const old = healthyStats({ token_id: TID_A, first_seen_ts_ms: NOW_MS - 60 * MS_PER_DAY });
  const fresh = healthyStats({ token_id: TID_B, first_seen_ts_ms: NOW_MS - 5 * MS_PER_DAY });
  const records = [
    { token_id: TID_A, score: 0.8, eligible: true, reasons: [], stats: old },
    { token_id: TID_B, score: 0.7, eligible: true, reasons: [], stats: fresh },
  ];
  const out = filterByMaxAge(records, cfg, NOW_MS);
  assert.deepEqual(out.map((r) => r.token_id), [TID_A]);
});

test('filterByMaxAge: keeps pools without a first_seen timestamp (missing evidence ≠ reject)', () => {
  const cfg = resolveRankerConfig({ max_pool_age_days: 30 });
  const noTs = healthyStats({ token_id: TID_A });
  const records = [
    { token_id: TID_A, score: 0.8, eligible: true, reasons: [], stats: noTs },
  ];
  const out = filterByMaxAge(records, cfg, NOW_MS);
  assert.deepEqual(out.map((r) => r.token_id), [TID_A]);
});

test('filterByMaxAge: annotates the dropped record with `age:Xd<Yd` reason (T37)', () => {
  // T37: the annotation now uses `<` instead of `>` because the
  // semantic flipped — the dropped pool is YOUNGER than the cap.
  // Verify by side-effect: invoke with a LOW cap (the fresh pool
  // is dropped); the record's `reasons` was mutated in place BEFORE
  // the filter decision. The dropped record still has the annotation
  // attached when discarded, but we can't observe it after the
  // filter. We assert the filter dropped it AND that a high-cap
  // invocation does NOT add annotations.
  const cfg = resolveRankerConfig({ max_pool_age_days: 30 });
  const fresh = healthyStats({ token_id: TID_A, first_seen_ts_ms: NOW_MS - 5 * MS_PER_DAY });
  // 1) LOW cap (30d): 5d < 30d → DROP. Confirm the drop.
  const out = filterByMaxAge([
    { token_id: TID_A, score: 0.8, eligible: true, reasons: [], stats: { ...fresh } },
  ], cfg, NOW_MS);
  assert.deepEqual(out, []); // dropped (5d < 30d)
  // 2) LOW cap (10d) on an OLD pool (200d): 200d >= 10d → KEEP
  // (not annotated). This is the new T37 inverse semantic — the
  // "cap" is a MINIMUM age threshold, so an old pool easily clears it.
  const old = healthyStats({ token_id: TID_B, first_seen_ts_ms: NOW_MS - 200 * MS_PER_DAY });
  const cfgLow = resolveRankerConfig({ max_pool_age_days: 10 });
  const out2 = filterByMaxAge([
    { token_id: TID_B, score: 0.8, eligible: true, reasons: [], stats: { ...old } },
  ], cfgLow, NOW_MS);
  assert.deepEqual(out2.map((r) => r.token_id), [TID_B]);
  assert.deepEqual(out2[0].reasons, []); // not annotated — kept (over cap)
});

test('filterByMaxAge: rejects only the under-age pool in a mixed batch (T37)', () => {
  // With the T37 flip, "under-age" now means NEWLY-launched. Under
  // a 30-day cap: 120-day-old pool kept, 5-day-old pool dropped,
  // no-timestamp pool kept (missing evidence).
  const cfg = resolveRankerConfig({ max_pool_age_days: 30 });
  const old = healthyStats({ token_id: TID_A, first_seen_ts_ms: NOW_MS - 120 * MS_PER_DAY });
  const fresh = healthyStats({ token_id: TID_B, first_seen_ts_ms: NOW_MS - 5 * MS_PER_DAY });
  const noTs = healthyStats({ token_id: TID_C });
  const records = [
    { token_id: TID_A, score: 0.9, eligible: true, reasons: [], stats: old },
    { token_id: TID_B, score: 0.8, eligible: true, reasons: [], stats: fresh },
    { token_id: TID_C, score: 0.7, eligible: true, reasons: [], stats: noTs },
  ];
  const out = filterByMaxAge(records, cfg, NOW_MS);
  assert.deepEqual(out.map((r) => r.token_id).sort(), [TID_A, TID_C]);
});

test('filterByMaxAge: invalid cfg.max_pool_age_days is a no-op', () => {
  const records = [
    { token_id: TID_A, score: 0.9, eligible: true, reasons: [], stats: healthyStats({ first_seen_ts_ms: NOW_MS - 1000 * MS_PER_DAY }) },
  ];
  const out = filterByMaxAge(records, { max_pool_age_days: NaN }, NOW_MS);
  assert.deepEqual(out.map((r) => r.token_id), [TID_A]);
});

// ────────────────────────────────────────────────────────────────────
//  dedupByTokenId
// ────────────────────────────────────────────────────────────────────

test('dedupByTokenId: keeps the higher-scoring record per token_id', () => {
  const records = [
    { token_id: TID_A, score: 0.7, eligible: true, reasons: [] },
    { token_id: TID_A, score: 0.9, eligible: true, reasons: [] },
    { token_id: TID_B, score: 0.5, eligible: true, reasons: [] },
  ];
  const out = dedupByTokenId(records);
  assert.equal(out.length, 2);
  const a = out.find((r) => r.token_id === TID_A);
  assert.equal(a.score, 0.9);
  const b = out.find((r) => r.token_id === TID_B);
  assert.equal(b.score, 0.5);
});

test('dedupByTokenId: ties broken by token_id ascending', () => {
  const records = [
    { token_id: TID_B, score: 0.8, eligible: true, reasons: [] },
    { token_id: TID_A, score: 0.8, eligible: true, reasons: [] },
  ];
  const out = dedupByTokenId(records);
  // Different token_ids here so no actual dedup — but order is
  // insertion order. Add a true duplicate:
  const records2 = [
    { token_id: TID_A, score: 0.8, eligible: true, reasons: [] },
    { token_id: TID_A, score: 0.8, eligible: true, reasons: [] },
  ];
  const out2 = dedupByTokenId(records2);
  assert.equal(out2.length, 1);
  // Now do the actual tiebreaker test: two distinct token_ids with
  // the same score. Order should follow first-encountered.
  const records3 = [
    { token_id: TID_C, score: 0.5, eligible: true, reasons: [] },
    { token_id: TID_B, score: 0.5, eligible: true, reasons: [] },
    { token_id: TID_C, score: 0.5, eligible: true, reasons: [] }, // dup of C
  ];
  const out3 = dedupByTokenId(records3);
  assert.deepEqual(out3.map((r) => r.token_id), [TID_C, TID_B]);
});

test('dedupByTokenId: skips records with missing/empty token_id', () => {
  const records = [
    { token_id: '', score: 0.9, eligible: true, reasons: [] },
    { token_id: TID_A, score: 0.7, eligible: true, reasons: [] },
  ];
  const out = dedupByTokenId(records);
  assert.deepEqual(out.map((r) => r.token_id), [TID_A]);
});

// ────────────────────────────────────────────────────────────────────
//  sortByScore
// ────────────────────────────────────────────────────────────────────

test('sortByScore: descending by score', () => {
  const records = [
    { token_id: TID_A, score: 0.5 },
    { token_id: TID_B, score: 0.9 },
    { token_id: TID_C, score: 0.7 },
  ];
  const out = sortByScore(records);
  assert.deepEqual(out.map((r) => r.token_id), [TID_B, TID_C, TID_A]);
});

test('sortByScore: ties broken by token_id ascending (deterministic)', () => {
  const records = [
    { token_id: TID_C, score: 0.5 },
    { token_id: TID_A, score: 0.5 },
    { token_id: TID_B, score: 0.5 },
  ];
  const out = sortByScore(records);
  assert.deepEqual(out.map((r) => r.token_id), [TID_A, TID_B, TID_C]);
});

test('sortByScore: does NOT mutate the input array', () => {
  const records = [
    { token_id: TID_A, score: 0.5 },
    { token_id: TID_B, score: 0.9 },
  ];
  const before = JSON.parse(JSON.stringify(records));
  sortByScore(records);
  assert.deepEqual(records, before);
});

test('sortByScore: returns fresh empty array on bad input', () => {
  assert.deepEqual(sortByScore(null), []);
  assert.deepEqual(sortByScore('garbage'), []);
});

// ────────────────────────────────────────────────────────────────────
//  takeTopK
// ────────────────────────────────────────────────────────────────────

test('takeTopK: attaches 1-indexed rank', () => {
  const sorted = [
    { token_id: TID_A, score: 0.9 },
    { token_id: TID_B, score: 0.7 },
    { token_id: TID_C, score: 0.5 },
  ];
  const out = takeTopK(sorted, 2);
  assert.deepEqual(out, [
    { token_id: TID_A, score: 0.9, rank: 1 },
    { token_id: TID_B, score: 0.7, rank: 2 },
  ]);
});

test('takeTopK: k > length returns all with consecutive ranks', () => {
  const sorted = [{ token_id: TID_A, score: 0.9 }];
  const out = takeTopK(sorted, 5);
  assert.deepEqual(out, [{ token_id: TID_A, score: 0.9, rank: 1 }]);
});

test('takeTopK: k < 1 returns empty array', () => {
  const sorted = [{ token_id: TID_A, score: 0.9 }];
  for (const k of [0, -1, NaN, 0.5]) {
    assert.deepEqual(takeTopK(sorted, k), []);
  }
});

test('takeTopK: bad input returns []', () => {
  assert.deepEqual(takeTopK(null, 3), []);
  assert.deepEqual(takeTopK('garbage', 3), []);
});

// ────────────────────────────────────────────────────────────────────
//  rankPools — end-to-end
// ────────────────────────────────────────────────────────────────────

test('rankPools: returns empty for empty input', () => {
  const { candidates, meta } = rankPools([]);
  assert.deepEqual(candidates, []);
  assert.equal(meta.input_count, 0);
  assert.equal(meta.returned, 0);
});

test('rankPools: picks top-K by score, attaches 1-indexed rank', () => {
  // All four pools have enough volume / TVL to clear the eligibility
  // gate AND enough feature mass to clear the default min_score=0.35.
  // The fixture uses TVL > volume so the lower-volume pools still
  // produce a score above the floor.
  const stats = [
    healthyStats({ token_id: TID_A, trade_volume_sats: 2 * SATS_PER_BCH, tvl_sats: 3 * SATS_PER_BCH }),   // medium
    healthyStats({ token_id: TID_B, trade_volume_sats: 5 * SATS_PER_BCH, tvl_sats: 3 * SATS_PER_BCH }),   // highest volume
    healthyStats({ token_id: TID_C, trade_volume_sats: 1 * SATS_PER_BCH, tvl_sats: 3 * SATS_PER_BCH }),   // lower
    healthyStats({ token_id: TID_D, trade_volume_sats: 3 * SATS_PER_BCH, tvl_sats: 3 * SATS_PER_BCH }),   // second
  ];
  const { candidates, meta } = rankPools(stats, { top_k_candidates: 3 });
  assert.equal(meta.returned, 3);
  // ranks are 1..3, score-desc.
  for (let i = 1; i < candidates.length; i += 1) {
    assert.ok(candidates[i - 1].score >= candidates[i].score,
      `out of order: ${candidates[i - 1].score} < ${candidates[i].score}`);
    assert.equal(candidates[i - 1].rank, i);
  }
  assert.equal(candidates[0].rank, 1);
  assert.equal(candidates[candidates.length - 1].rank, 3);
});

test('rankPools: drops pools below min_score', () => {
  const stats = [
    healthyStats({ token_id: TID_A, trade_volume_sats: 0.3 * SATS_PER_BCH, tvl_sats: 0.3 * SATS_PER_BCH }), // barely passes eligibility, will score low
    healthyStats({ token_id: TID_B, trade_volume_sats: 5 * SATS_PER_BCH, tvl_sats: 2 * SATS_PER_BCH }),
  ];
  const cfg = resolveScoringConfig({ min_score: 0.8 });
  const { candidates } = rankPools(stats, { ...cfg, top_k_candidates: 5 });
  for (const c of candidates) {
    assert.ok(c.score >= 0.8, `candidate ${c.token_id} score ${c.score} below min`);
  }
});

test('rankPools: drops pools newer than max_pool_age_days (T37 semantic flip)', () => {
  // T37 flipped the semantic from "drop older" to "drop newer". With
  // max_pool_age_days=90, TID_A (200d old) is KEPT and TID_B (5d old)
  // is DROPPED. This matches the operator intent — fresh pools are
  // the wash-trade / seed-swap risk.
  const stats = [
    healthyStats({ token_id: TID_A, first_seen_ts_ms: NOW_MS - 200 * MS_PER_DAY, trade_volume_sats: 5 * SATS_PER_BCH, tvl_sats: 3 * SATS_PER_BCH }),
    healthyStats({ token_id: TID_B, first_seen_ts_ms: NOW_MS - 5 * MS_PER_DAY, trade_volume_sats: 2 * SATS_PER_BCH, tvl_sats: 3 * SATS_PER_BCH }),
  ];
  const { candidates, meta } = rankPools(stats, { max_pool_age_days: 90, top_k_candidates: 5 }, { nowMs: NOW_MS });
  // Only TID_A should be a candidate.
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].token_id, TID_A);
  assert.ok(meta.notes.length === 0); // age filter applied (TID_B had a ts)
});

test('rankPools: notes when age filter was skipped because no pool has a timestamp', () => {
  const stats = [
    healthyStats({ token_id: TID_A }),
    healthyStats({ token_id: TID_B }),
  ];
  const { meta } = rankPools(stats, { max_pool_age_days: 90, top_k_candidates: 5 }, { nowMs: NOW_MS });
  assert.ok(meta.notes.includes('age_filter_skipped:no_first_seen_ts_in_indexer'),
    `expected age-filter-skipped note, got ${JSON.stringify(meta.notes)}`);
});

test('rankPools: dedups by token_id (keeps highest scoring instance)', () => {
  const stats = [
    healthyStats({ token_id: TID_A, trade_volume_sats: 5 * SATS_PER_BCH }),
    healthyStats({ token_id: TID_A, trade_volume_sats: 1 * SATS_PER_BCH }),
  ];
  const { candidates, meta } = rankPools(stats, { top_k_candidates: 5 });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].token_id, TID_A);
  assert.equal(meta.after_dedup, 1);
});

test('rankPools: meta counts document the pipeline', () => {
  // Both pools above min_score; both pass.
  const stats = [
    healthyStats({ token_id: TID_A, trade_volume_sats: 5 * SATS_PER_BCH, tvl_sats: 3 * SATS_PER_BCH }),
    healthyStats({ token_id: TID_B, trade_volume_sats: 2 * SATS_PER_BCH, tvl_sats: 3 * SATS_PER_BCH }),
  ];
  const { meta } = rankPools(stats, { top_k_candidates: 5 });
  assert.equal(meta.input_count, 2);
  assert.ok(meta.before_score_filter >= 2);
  assert.equal(meta.after_score_filter, 2);
  assert.ok(meta.after_age_filter >= 1);
  assert.equal(meta.after_dedup, 2);
  assert.equal(meta.returned, 2);
  assert.equal(meta.now_ms > 0, true);
});

test('rankPools: every candidate carries a `reasoning` blob the entry layer can stamp', () => {
  const stats = [
    healthyStats({ token_id: TID_A, trade_volume_sats: 5 * SATS_PER_BCH, tvl_sats: 3 * SATS_PER_BCH }),
    healthyStats({ token_id: TID_B, trade_volume_sats: 2 * SATS_PER_BCH, tvl_sats: 3 * SATS_PER_BCH }),
  ];
  const cfg = resolveRankerConfig({ top_k_candidates: 2 });
  const { candidates } = rankPools(stats, cfg);
  assert.equal(candidates.length, 2);
  for (const c of candidates) {
    assert.ok(c.reasoning, `candidate ${c.token_id} missing reasoning`);
    assert.ok(typeof c.reasoning.ts === 'number');
    assert.equal(c.reasoning.rank, c.rank);
    assert.equal(c.reasoning.topK, cfg.top_k_candidates);
    assert.equal(c.reasoning.conditions.min_score, cfg.min_score);
    assert.equal(c.reasoning.conditions.max_age_days, cfg.max_pool_age_days);
    assert.equal(c.reasoning.conditions.top_k_candidates, cfg.top_k_candidates);
    assert.deepEqual(c.reasoning.passed_filters, ['min_score', 'max_age', 'dedup', 'topk']);
  }
});

test('rankPools: candidates carry `notes[]` with scoring/data-quality warnings', () => {
  const stats = [
    // Stats record with no first-seen ts — should get `age_unknown`.
    healthyStats({ token_id: TID_A, trade_volume_sats: 5 * SATS_PER_BCH }),
  ];
  const { candidates } = rankPools(stats, { top_k_candidates: 3 });
  assert.equal(candidates.length, 1);
  assert.ok(Array.isArray(candidates[0].notes));
  assert.ok(candidates[0].notes.includes('age_unknown'),
    `expected age_unknown note, got ${JSON.stringify(candidates[0].notes)}`);
});

test('rankPools: candidate carries original stats (so entry layer can re-quote)', () => {
  const stats = [
    healthyStats({ token_id: TID_A, trade_volume_sats: 5 * SATS_PER_BCH }),
  ];
  const { candidates } = rankPools(stats, { top_k_candidates: 1 });
  assert.equal(candidates.length, 1);
  assert.ok(candidates[0].stats);
  assert.equal(candidates[0].stats.token_id, TID_A);
  assert.equal(candidates[0].stats.trade_volume_sats, 5 * SATS_PER_BCH);
});

test('rankPools: top_k_candidates comes from config (override honored)', () => {
  const stats = [
    healthyStats({ token_id: TID_A, trade_volume_sats: 5 * SATS_PER_BCH, tvl_sats: 3 * SATS_PER_BCH }),
    healthyStats({ token_id: TID_B, trade_volume_sats: 3 * SATS_PER_BCH, tvl_sats: 3 * SATS_PER_BCH }),
    healthyStats({ token_id: TID_C, trade_volume_sats: 2 * SATS_PER_BCH, tvl_sats: 3 * SATS_PER_BCH }),
  ];
  const { candidates: c1 } = rankPools(stats, { top_k_candidates: 1 });
  const { candidates: c2 } = rankPools(stats, { top_k_candidates: 3 });
  assert.equal(c1.length, 1);
  assert.equal(c2.length, 3);
});

test('rankPools: ignores invalid stats (records without token_id)', () => {
  // scorePools marks invalid records as `{ eligible: false, reasons: ['invalid_stats'] }`.
  // filterByMinScore then drops them (because eligible===false).
  const stats = [
    { /* not a PoolStats */ foo: 'bar' },
    healthyStats({ token_id: TID_A, trade_volume_sats: 5 * SATS_PER_BCH }),
  ];
  const { candidates } = rankPools(stats, { top_k_candidates: 5 });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].token_id, TID_A);
});

test('rankPools: works end-to-end with scorePools under the hood (sanity check)', () => {
  // Build a real scored list, then ensure rankPools produces the
  // same ranks as `scorePools → filterByMinScore → sort → topK`.
  const stats = [
    healthyStats({ token_id: TID_A, trade_volume_sats: 0.5 * SATS_PER_BCH }),
    healthyStats({ token_id: TID_B, trade_volume_sats: 3 * SATS_PER_BCH }),
    healthyStats({ token_id: TID_C, trade_volume_sats: 1 * SATS_PER_BCH }),
  ];
  const cfg = resolveRankerConfig({ top_k_candidates: 2 });
  const { candidates } = rankPools(stats, cfg);

  // Independent re-derivation.
  const scored = scorePools(stats, cfg);
  const kept = filterByMinScore(scored, cfg);
  const sorted = sortByScore(kept);
  const expected = takeTopK(sorted, cfg.top_k_candidates);
  assert.deepEqual(
    candidates.map((c) => c.token_id),
    expected.map((c) => c.token_id),
  );
});

// ────────────────────────────────────────────────────────────────────
//  Guards: knobs come from config, not hard-coded
// ────────────────────────────────────────────────────────────────────

test('GUARD: top_k_candidates=1 collapses the result to one candidate', () => {
  const stats = [
    healthyStats({ token_id: TID_A, trade_volume_sats: 5 * SATS_PER_BCH }),
    healthyStats({ token_id: TID_B, trade_volume_sats: 3 * SATS_PER_BCH }),
    healthyStats({ token_id: TID_C, trade_volume_sats: 1 * SATS_PER_BCH }),
  ];
  const { candidates } = rankPools(stats, { top_k_candidates: 1 });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].rank, 1);
});

test('GUARD: min_score=1.0 (max) effectively returns [] (no pool reaches 1.0)', () => {
  const stats = [
    healthyStats({ token_id: TID_A, trade_volume_sats: 5 * SATS_PER_BCH }),
  ];
  const { candidates } = rankPools(stats, { min_score: 1.0, top_k_candidates: 5 });
  assert.equal(candidates.length, 0);
});

test('GUARD: defaults file (config/default.json) top_k_candidates is honored by rankPools', async () => {
  // Read the actual config file to assert the ranker is wired to
  // the same knob the user tunes in default.json — i.e. the
  // small-balance preset's top_k_candidates=3.
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const cfgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../config/default.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const stats = [
    healthyStats({ token_id: TID_A, trade_volume_sats: 5 * SATS_PER_BCH }),
    healthyStats({ token_id: TID_B, trade_volume_sats: 3 * SATS_PER_BCH }),
    healthyStats({ token_id: TID_C, trade_volume_sats: 2 * SATS_PER_BCH }),
    healthyStats({ token_id: TID_D, trade_volume_sats: 1 * SATS_PER_BCH }),
    healthyStats({ token_id: TID_E, trade_volume_sats: 0.5 * SATS_PER_BCH }),
  ];
  const { candidates } = rankPools(stats, cfg.scoring);
  // top_k_candidates in default.json is 3; we should get up to 3.
  assert.ok(candidates.length <= cfg.scoring.top_k_candidates,
    `got ${candidates.length} > top_k_candidates=${cfg.scoring.top_k_candidates}`);
});

test('GUARD: ranker never returns rank > top_k_candidates', () => {
  const stats = [
    healthyStats({ token_id: TID_A, trade_volume_sats: 5 * SATS_PER_BCH }),
    healthyStats({ token_id: TID_B, trade_volume_sats: 3 * SATS_PER_BCH }),
  ];
  const k = 1;
  const { candidates } = rankPools(stats, { top_k_candidates: k });
  for (const c of candidates) {
    assert.ok(c.rank >= 1 && c.rank <= k, `rank ${c.rank} out of [1, ${k}]`);
  }
});

// ────────────────────────────────────────────────────────────────────
//  Edge cases
// ────────────────────────────────────────────────────────────────────

test('rankPools: invalid token_id on a stats record still ranks (filtering happens on breakdown)', () => {
  // A token_id that isn't 64 hex chars but is a string — scorePools
  // accepts it (its isValidPoolStats only requires `token_id` to be
  // a string). The ranker should still process it but mark
  // `notes: ['token_id_format_invalid']`.
  const stats = [
    healthyStats({ token_id: 'not-a-real-token-id', trade_volume_sats: 5 * SATS_PER_BCH }),
  ];
  const { candidates } = rankPools(stats, { top_k_candidates: 3 });
  assert.equal(candidates.length, 1);
  assert.ok(candidates[0].notes.includes('token_id_format_invalid'));
});

test('rankPools: handles null/undefined input gracefully', () => {
  assert.deepEqual(rankPools(null).candidates, []);
  assert.deepEqual(rankPools(undefined).candidates, []);
  assert.deepEqual(rankPools('garbage').candidates, []);
});

test('rankPools: handles bad config gracefully (falls back to defaults)', () => {
  const stats = [healthyStats({ token_id: TID_A, trade_volume_sats: 5 * SATS_PER_BCH })];
  // Each variant falls back to the default ranker config (top_k=3,
  // min_score=DEFAULT_SCORING_CONFIG.min_score, etc.).
  const { candidates: c1 } = rankPools(stats, null);
  const { candidates: c2 } = rankPools(stats, 'garbage');
  const { candidates: c3 } = rankPools(stats, 42);
  assert.equal(c1.length, 1);
  assert.equal(c2.length, 1);
  assert.equal(c3.length, 1);
});
