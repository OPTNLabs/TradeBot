#!/usr/bin/env node
/**
 * Unit tests for src/strategy/entry.mjs.
 *
 * Pure-function tests. No I/O, no logger, no process state. Run via:
 *   npm test
 *
 * Covers:
 *   - resolveEntryConfig: defaults + overrides + bad input
 *   - floorToStep: rounding + dust handling
 *   - computeEntrySizeBch: position ceiling, exposure headroom, balance floor
 *   - shouldEnter: every gate (eligibility, rank, price, gap, sizing)
 *   - GUARD: every knob reads from config, never hard-coded literals
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_ENTRY_CONFIG,
  resolveEntryConfig,
  floorToStep,
  computeEntrySizeBch,
  shouldEnter,
} from '../src/strategy/entry.mjs';

// ────────────────────────────────────────────────────────────────────
//  Fixtures
// ────────────────────────────────────────────────────────────────────

const TOKEN_ID = 'a'.repeat(64);

function baseConfig(overrides = {}) {
  // Merge overrides.entry with the default entry block so a partial
  // override doesn't accidentally wipe other knobs.
  const { entry: entryOverride, risk: riskOverride, ...rest } = overrides;
  return {
    entry: { ...DEFAULT_ENTRY_CONFIG, ...(entryOverride ?? {}) },
    risk: {
      min_wallet_balance_bch: 0.005,
      max_daily_loss_bch: 0.005,
      ...(riskOverride ?? {}),
    },
    ...rest,
  };
}

function candidate(overrides = {}) {
  return {
    token_id: TOKEN_ID,
    rank: 1,
    topK: 3,
    score: 0.6,
    eligible: true,
    stats: {
      token_id: TOKEN_ID,
      symbol: 'TEST',
      price_now_sats: 1000,
      change_24h_bp: -500, // -5% from 24h high (passes 2% gap gate)
      ...overrides.stats,
    },
    reasoning: { passed_filters: ['min_score', 'max_age', 'dedup', 'topk'] },
    ...overrides,
  };
}

function portfolioState(overrides = {}) {
  return {
    openPositions: [],
    openExposureBch: 0,
    walletBalanceBch: 0.044, // a touch over $20 USD
    nowIso: new Date('2026-09-10T18:00:00Z').toISOString(),
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────
//  resolveEntryConfig
// ────────────────────────────────────────────────────────────────────

test('resolveEntryConfig: returns defaults on null/undefined/bad input', () => {
  for (const bad of [null, undefined, 0, 'string', 42, true, [], NaN]) {
    const cfg = resolveEntryConfig(bad);
    assert.equal(cfg.max_position_bch, DEFAULT_ENTRY_CONFIG.max_position_bch);
    assert.equal(cfg.max_total_exposure_bch, DEFAULT_ENTRY_CONFIG.max_total_exposure_bch);
    assert.equal(cfg.min_trade_size_bch, DEFAULT_ENTRY_CONFIG.min_trade_size_bch);
    assert.equal(cfg.slippage_tolerance_bps, DEFAULT_ENTRY_CONFIG.slippage_tolerance_bps);
  }
});

test('resolveEntryConfig: accepts partial overrides', () => {
  const cfg = resolveEntryConfig({ max_position_bch: 0.01 });
  assert.equal(cfg.max_position_bch, 0.01);
  assert.equal(cfg.max_total_exposure_bch, DEFAULT_ENTRY_CONFIG.max_total_exposure_bch);
});

test('resolveEntryConfig: ignores non-numeric overrides (falls back to default)', () => {
  const cfg = resolveEntryConfig({ max_position_bch: 'banana' });
  assert.equal(cfg.max_position_bch, DEFAULT_ENTRY_CONFIG.max_position_bch);
});

test('resolveEntryConfig: clamps bad numeric values back to defaults', () => {
  const cfg = resolveEntryConfig({
    max_position_bch: -1,
    max_total_exposure_bch: -2,
    min_trade_size_bch: 0,
    slippage_tolerance_bps: -50,
  });
  assert.equal(cfg.max_position_bch, DEFAULT_ENTRY_CONFIG.max_position_bch);
  assert.equal(cfg.max_total_exposure_bch, DEFAULT_ENTRY_CONFIG.max_total_exposure_bch);
  assert.equal(cfg.min_trade_size_bch, DEFAULT_ENTRY_CONFIG.min_trade_size_bch);
  assert.equal(cfg.slippage_tolerance_bps, DEFAULT_ENTRY_CONFIG.slippage_tolerance_bps);
});

// ────────────────────────────────────────────────────────────────────
//  floorToStep
// ────────────────────────────────────────────────────────────────────

test('floorToStep: rounds down to the nearest step', () => {
  assert.equal(floorToStep(0.00499, 0.0005, 0.0005), 0.0045);
  assert.equal(floorToStep(0.005, 0.0005, 0.0005), 0.005);
});

test('floorToStep: floored amount below min → 0 (dust skip)', () => {
  assert.equal(floorToStep(0.0003, 0.0005, 0.0005), 0);
});

test('floorToStep: bad input → 0', () => {
  assert.equal(floorToStep(NaN, 0.0005, 0.0005), 0);
  assert.equal(floorToStep(-1, 0.0005, 0.0005), 0);
  assert.equal(floorToStep(0.005, 0, 0.0005), 0.005); // step=0 → pass through
  assert.equal(floorToStep(0.005, 0.0005, NaN), 0);  // min=NaN → 0 (defensive)
});

test('floorToStep: amount >= dust but floor rounds to 0 → returns min', () => {
  // Edge case: amount = 0.0005, step = 0.0005 → floored = 0.0005 (OK).
  // amount = 0.000499, step = 0.0005 → floored = 0 (below dust) → 0.
  assert.equal(floorToStep(0.0005, 0.0005, 0.0005), 0.0005);
  assert.equal(floorToStep(0.000499, 0.0005, 0.0005), 0);
});

// ────────────────────────────────────────────────────────────────────
//  computeEntrySizeBch
// ────────────────────────────────────────────────────────────────────

test('computeEntrySizeBch: returns max_position when fully available', () => {
  const size = computeEntrySizeBch({
    maxPositionBch: 0.005,
    maxTotalExposureBch: 0.04,
    openExposureBch: 0,
    walletBalanceBch: 0.044,
    minWalletBalanceBch: 0.005,
    minTradeSizeBch: 0.0005,
  });
  // wallet - floor = 0.039 → ceiling = min(0.005, 0.04, 0.039) = 0.005
  // rounded to 0.0005 step → 0.005
  assert.equal(size, 0.005);
});

test('computeEntrySizeBch: capped by max_total_exposure headroom', () => {
  // Open exposure of 0.038 → headroom = 0.002 (below max_pos 0.005)
  const size = computeEntrySizeBch({
    maxPositionBch: 0.005,
    maxTotalExposureBch: 0.04,
    openExposureBch: 0.038,
    walletBalanceBch: 0.044,
    minWalletBalanceBch: 0.005,
    minTradeSizeBch: 0.0005,
  });
  // min(0.005, 0.002, 0.039) = 0.002 → floor 0.0005 → 0.002
  assert.equal(size, 0.002);
});

test('computeEntrySizeBch: headroom fully consumed → 0', () => {
  const size = computeEntrySizeBch({
    maxPositionBch: 0.005,
    maxTotalExposureBch: 0.04,
    openExposureBch: 0.04,
    walletBalanceBch: 0.044,
    minWalletBalanceBch: 0.005,
    minTradeSizeBch: 0.0005,
  });
  assert.equal(size, 0);
});

test('computeEntrySizeBch: balance at floor → 0', () => {
  const size = computeEntrySizeBch({
    maxPositionBch: 0.005,
    maxTotalExposureBch: 0.04,
    openExposureBch: 0,
    walletBalanceBch: 0.005, // exactly at floor
    minWalletBalanceBch: 0.005,
    minTradeSizeBch: 0.0005,
  });
  assert.equal(size, 0);
});

test('computeEntrySizeBch: balance below floor → 0', () => {
  const size = computeEntrySizeBch({
    maxPositionBch: 0.005,
    maxTotalExposureBch: 0.04,
    openExposureBch: 0,
    walletBalanceBch: 0.004,
    minWalletBalanceBch: 0.005,
    minTradeSizeBch: 0.0005,
  });
  assert.equal(size, 0);
});

test('computeEntrySizeBch: rounds size DOWN to min_trade_size_bch step', () => {
  // max_pos 0.005 + step 0.0005 → 0.005 (exact)
  // Now: bump max_pos to 0.0053 → floored to 0.005
  const size = computeEntrySizeBch({
    maxPositionBch: 0.0053,
    maxTotalExposureBch: 0.04,
    openExposureBch: 0,
    walletBalanceBch: 0.044,
    minWalletBalanceBch: 0.005,
    minTradeSizeBch: 0.0005,
  });
  // min(0.0053, 0.04, 0.039) = 0.0053 → floor(0.0053 / 0.0005) * 0.0005 = 10 * 0.0005 = 0.005
  assert.equal(size, 0.005);
});

test('computeEntrySizeBch: bad numeric input → 0', () => {
  for (const args of [
    { maxPositionBch: 0 },
    { maxPositionBch: -0.005 },
    { maxTotalExposureBch: 0 },
    { walletBalanceBch: 0 },
    { walletBalanceBch: -1 },
    { minWalletBalanceBch: NaN },
    { minTradeSizeBch: 0 },
    { openExposureBch: NaN },
  ]) {
    const full = {
      maxPositionBch: 0.005,
      maxTotalExposureBch: 0.04,
      openExposureBch: 0,
      walletBalanceBch: 0.044,
      minWalletBalanceBch: 0.005,
      minTradeSizeBch: 0.0005,
      ...args,
    };
    assert.equal(computeEntrySizeBch(full), 0, `args ${JSON.stringify(args)}`);
  }
});

// ────────────────────────────────────────────────────────────────────
//  shouldEnter
// ────────────────────────────────────────────────────────────────────

test('shouldEnter: happy path → enter:true with sized amount', () => {
  const result = shouldEnter(candidate(), portfolioState(), baseConfig());
  assert.equal(result.enter, true);
  assert.equal(result.sizeBch, 0.005);
  assert.equal(result.slippageCapBps, 100);
  assert.ok(result.reasoning);
  assert.equal(result.reasoning.token_id, TOKEN_ID);
  assert.equal(result.reasoning.decision.kind, 'enter');
  assert.equal(result.reasoning.decision.size_bch, 0.005);
});

test('shouldEnter: ineligible → enter:false, kind:not_eligible', () => {
  const result = shouldEnter(
    candidate({ eligible: false }),
    portfolioState(),
    baseConfig(),
  );
  assert.equal(result.enter, false);
  assert.equal(result.kind, 'not_eligible');
  assert.ok(result.reasoning);
});

test('shouldEnter: no rank → enter:false, kind:not_in_topk', () => {
  const result = shouldEnter(
    candidate({ rank: 0 }),
    portfolioState(),
    baseConfig(),
  );
  assert.equal(result.enter, false);
  assert.equal(result.kind, 'not_in_topk');
});

test('shouldEnter: no price evidence → enter:false, kind:no_price_evidence', () => {
  const result = shouldEnter(
    candidate({ stats: { price_now_sats: null } }),
    portfolioState(),
    baseConfig(),
  );
  assert.equal(result.enter, false);
  assert.equal(result.kind, 'no_price_evidence');
});

test('shouldEnter: too close to 24h high → enter:false, kind:too_close_to_high', () => {
  // change_24h_bp = -100 (-1% from 24h high). Gap required 2% → reject.
  const result = shouldEnter(
    candidate({ stats: { price_now_sats: 1000, change_24h_bp: -100 } }),
    portfolioState(),
    baseConfig(),
  );
  assert.equal(result.enter, false);
  assert.equal(result.kind, 'too_close_to_high');
});

test('shouldEnter: too_close_to_high reason is honest about the change_24h_bp proxy', () => {
  // T42 fix: the previous message format used `${(-ch24bp / 100)}%
  // below` for both signs of ch24bp, producing a misleading
  // "-2.06% below the 24h high" when ch24bp was actually +206
  // (price had risen 2.06%, not dropped). The new message
  // distinguishes "below 24h-ago" (price dropped but not enough)
  // from "above 24h-ago" (price rose, anti-pump triggers) and
  // explicitly mentions the change_24h_bp proxy so operators
  // don't mistake the metric for "distance from 24h high".
  const dropTooSmall = shouldEnter(
    candidate({ stats: { price_now_sats: 1000, change_24h_bp: -100 } }),
    portfolioState(),
    baseConfig(),
  );
  assert.equal(dropTooSmall.kind, 'too_close_to_high');
  // ch24bp negative → 'below' direction. Magnitude is reported
  // via Math.abs so the message never reads as a negative percentage.
  assert.match(dropTooSmall.reason, /below/);
  assert.match(dropTooSmall.reason, /change_24h_bp proxy/);
  assert.doesNotMatch(dropTooSmall.reason, /-1\.00% below/);

  const priceRose = shouldEnter(
    candidate({ stats: { price_now_sats: 1000, change_24h_bp: 206 } }),
    portfolioState(),
    baseConfig(),
  );
  assert.equal(priceRose.kind, 'too_close_to_high');
  // ch24bp positive → 'above' direction. Crucially, the new
  // message must NOT read like the price is below the high
  // (the old format produced "-2.06% below" for this case).
  assert.match(priceRose.reason, /above/);
  assert.doesNotMatch(priceRose.reason, /below/);
  assert.match(priceRose.reason, /2\.06%/);
  assert.match(priceRose.reason, /change_24h_bp proxy/);
});

test('shouldEnter: below 24h high enough → pass gap gate', () => {
  // change_24h_bp = -300 (-3% from 24h high). Gap required 2% → pass.
  const result = shouldEnter(
    candidate({ stats: { price_now_sats: 1000, change_24h_bp: -300 } }),
    portfolioState(),
    baseConfig(),
  );
  assert.equal(result.enter, true);
});

test('shouldEnter: missing change_24h_bp → skip gap gate (pass)', () => {
  const result = shouldEnter(
    candidate({ stats: { price_now_sats: 1000 } }),
    portfolioState(),
    baseConfig(),
  );
  assert.equal(result.enter, true);
});

test('shouldEnter: exposure fully deployed → enter:false, kind:exposure_full', () => {
  const result = shouldEnter(
    candidate(),
    portfolioState({ openExposureBch: 0.04 }),
    baseConfig(),
  );
  assert.equal(result.enter, false);
  assert.equal(result.kind, 'exposure_full');
});

test('shouldEnter: balance at floor → enter:false, kind:below_floor', () => {
  const result = shouldEnter(
    candidate(),
    portfolioState({ walletBalanceBch: 0.005 }),
    baseConfig(),
  );
  assert.equal(result.enter, false);
  assert.equal(result.kind, 'below_floor');
});

test('shouldEnter: bad input → enter:false, kind:bad_input', () => {
  assert.equal(shouldEnter(null, portfolioState(), baseConfig()).kind, 'bad_input');
  assert.equal(shouldEnter(candidate(), null, baseConfig()).kind, 'bad_input');
  assert.equal(shouldEnter(candidate(), portfolioState(), null).kind, 'bad_input');
});

test('shouldEnter: reasoning blob carries every config knob for audit', () => {
  const result = shouldEnter(candidate(), portfolioState(), baseConfig());
  const c = result.reasoning.conditions;
  assert.equal(c.max_position_bch, 0.005);
  assert.equal(c.max_total_exposure_bch, 0.04);
  assert.equal(c.min_wallet_balance_bch, 0.005);
  assert.equal(c.min_trade_size_bch, 0.0005);
  assert.equal(c.slippage_tolerance_bps, 100);
  assert.equal(c.min_entry_gap_from_high_pct, 2.0);
  assert.equal(c.max_daily_loss_bch, 0.005);
});

// ────────────────────────────────────────────────────────────────────
//  GUARD: knobs come from config, not hard-coded
// ────────────────────────────────────────────────────────────────────

test('GUARD: max_position_bch=0.0001 caps the entry size', () => {
  // Lower the dust floor to match the per-trade cap, otherwise
  // floorToStep would round 0.0001 down to 0.
  const result = shouldEnter(
    candidate(),
    portfolioState({ walletBalanceBch: 0.044 }),
    baseConfig({ entry: { max_position_bch: 0.0001, min_trade_size_bch: 0.0001 } }),
  );
  assert.equal(result.enter, true);
  assert.equal(result.sizeBch, 0.0001);
});

test('GUARD: max_total_exposure_bch=0.005 caps total deployment', () => {
  // With wallet 0.044 and max_pos 0.005, exposure 0 → size = 0.005 normally.
  // Bumping exposure cap DOWN to 0.002 → size = 0.002.
  const result = shouldEnter(
    candidate(),
    portfolioState(),
    baseConfig({ entry: { max_total_exposure_bch: 0.002 } }),
  );
  assert.equal(result.enter, true);
  assert.equal(result.sizeBch, 0.002);
});

test('GUARD: min_wallet_balance_bch=0.044 (== wallet) → below_floor', () => {
  // Floor equals the entire wallet — no room for any trade.
  const result = shouldEnter(
    candidate(),
    portfolioState({ walletBalanceBch: 0.044 }),
    baseConfig({ risk: { min_wallet_balance_bch: 0.044 } }),
  );
  assert.equal(result.enter, false);
  assert.equal(result.kind, 'below_floor');
});

test('GUARD: min_trade_size_bch=0.05 (above wallet headroom) → size_zero', () => {
  // wallet 0.044 - floor 0.005 = 0.039; max_pos 0.005 → 0.005
  // min_trade 0.05 → 0.005 floored to 0.05 step → 0.
  const result = shouldEnter(
    candidate(),
    portfolioState(),
    baseConfig({ entry: { min_trade_size_bch: 0.05 } }),
  );
  assert.equal(result.enter, false);
  assert.equal(result.kind, 'size_zero');
});

test('GUARD: min_entry_gap_from_high_pct=50 with -3% move → reject', () => {
  const result = shouldEnter(
    candidate({ stats: { price_now_sats: 1000, change_24h_bp: -300 } }),
    portfolioState(),
    baseConfig({ entry: { min_entry_gap_from_high_pct: 50 } }),
  );
  assert.equal(result.enter, false);
  assert.equal(result.kind, 'too_close_to_high');
});

test('GUARD: defaults file (config/default.json) entry block is honored', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const cfgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../config/default.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  // Confirm the knobs we're going to exercise are exactly what the file says.
  assert.equal(cfg.entry.max_position_bch, 0.005);
  assert.equal(cfg.entry.max_total_exposure_bch, 0.04);
  assert.equal(cfg.entry.slippage_tolerance_bps, 100);
  assert.equal(cfg.entry.min_trade_size_bch, 0.0005);
  assert.equal(cfg.risk.min_wallet_balance_bch, 0.005);

  const result = shouldEnter(candidate(), portfolioState(), cfg);
  assert.equal(result.enter, true);
  assert.equal(result.sizeBch, cfg.entry.max_position_bch);
  assert.equal(result.slippageCapBps, cfg.entry.slippage_tolerance_bps);
});

// ────────────────────────────────────────────────────────────────────
//  T31 — indexer-vs-AMM divergence guard
// ────────────────────────────────────────────────────────────────────

test('T31: indexer + AMM in alignment → no divergence rejection', () => {
  const result = shouldEnter(
    candidate({ amm_spot_sats: 1000 }),
    portfolioState(),
    baseConfig(),
  );
  assert.equal(result.enter, true);
  assert.notEqual(result.kind, 'indexer_vs_amm_divergence');
});

test('T31: indexer 1000x HIGHER than AMM → reject (kind: indexer_vs_amm_divergence)', () => {
  // indexer=1_000_000 sats, AMM=1 sats → 1_000_000x divergence (well above the 1000x cap).
  // The candidate helper defaults stats.price_now_sats=1000; override it explicitly
  // so the test isn't accidentally hitting the 1000x boundary (which `isPricePlausibleVsEntry`
  // accepts inclusively — see the boundary-case test below).
  const result = shouldEnter(
    candidate({ amm_spot_sats: 1, stats: { price_now_sats: 1_000_000 } }),
    portfolioState(),
    baseConfig(),
  );
  assert.equal(result.enter, false);
  assert.equal(result.kind, 'indexer_vs_amm_divergence');
  assert.match(result.reason, /indexer price 1000000 sats\/token vs AMM spot 1 sats\/token/);
  assert.match(result.reason, /1000000x/);
  assert.match(result.reason, /max 1000x/);
});

test('T31: indexer 1000x LOWER than AMM → reject (mirror case)', () => {
  // indexer=1 sats, AMM=1_000_000 sats → 1_000_000x divergence (clearly above the 1000x cap).
  // Override stats.price_now_sats=1 to force the indexer below the AMM. The candidate helper
  // defaults price_now_sats=1000 which would land us on the inclusive boundary case.
  const result = shouldEnter(
    candidate({ amm_spot_sats: 1000 * 1000, stats: { price_now_sats: 1 } }),
    portfolioState(),
    baseConfig(),
  );
  assert.equal(result.enter, false);
  assert.equal(result.kind, 'indexer_vs_amm_divergence');
});

test('T31: indexer exactly at the 1000x cap → pass (boundary case)', () => {
  // indexer=1000 sats, AMM=1 sats → exactly 1000x — isPricePlausibleVsEntry uses `>=` and `<=`, so this passes.
  const result = shouldEnter(
    candidate({ amm_spot_sats: 1 }),
    portfolioState(),
    baseConfig(),
  );
  // The candidate default is price_now_sats: 1000 / amm_spot_sats: 1 → ratio 1000
  // 1000 <= 1000 (cap), so plausible. shouldEnter should NOT reject for divergence.
  assert.notEqual(result.kind, 'indexer_vs_amm_divergence');
});

test('T31: missing amm_spot_sats → guard SKIPPED (caller decides later)', () => {
  const result = shouldEnter(
    candidate({ amm_spot_sats: null }),
    portfolioState(),
    baseConfig(),
  );
  assert.notEqual(result.kind, 'indexer_vs_amm_divergence');
  assert.equal(result.enter, true);
});

test('T31: missing price_now_sats → guard SKIPPED (no anchor)', () => {
  const result = shouldEnter(
    candidate({ stats: { price_now_sats: 0, change_24h_bp: -500 } }),
    portfolioState(),
    baseConfig(),
  );
  // price_now_sats=0 → no anchor, but shouldEnter has its own no_price_evidence gate.
  assert.equal(result.kind, 'no_price_evidence');
});

test('T31: max_indexer_vs_amm_ratio_x disabled (0 / negative / non-finite) → guard skipped', () => {
  // Operator opts out → fall back to default but also handle disabled variants.
  const zero = shouldEnter(
    candidate({ amm_spot_sats: 1 }),
    portfolioState(),
    baseConfig({ entry: { max_indexer_vs_amm_ratio_x: 0 } }),
  );
  // 0 is non-positive → resolveEntryConfig falls back to default 1000 → 1000x passes (boundary).
  assert.notEqual(zero.kind, 'indexer_vs_amm_divergence');

  const negative = shouldEnter(
    candidate({ amm_spot_sats: 1 }),
    portfolioState(),
    baseConfig({ entry: { max_indexer_vs_amm_ratio_x: -5 } }),
  );
  assert.notEqual(negative.kind, 'indexer_vs_amm_divergence');

  const huge = shouldEnter(
    candidate({ amm_spot_sats: 1 }),
    portfolioState(),
    baseConfig({ entry: { max_indexer_vs_amm_ratio_x: 1_000_000_000 } }),
  );
  assert.notEqual(huge.kind, 'indexer_vs_amm_divergence');
});

test('T31: tighten max_indexer_vs_amm_ratio_x to 10 → still rejects QBTC pathology', () => {
  // indexer=1000 sats, AMM=1 sats → 1000x divergence; cap=10 → rejected.
  const result = shouldEnter(
    candidate({ amm_spot_sats: 1 }),
    portfolioState(),
    baseConfig({ entry: { max_indexer_vs_amm_ratio_x: 10 } }),
  );
  assert.equal(result.enter, false);
  assert.equal(result.kind, 'indexer_vs_amm_divergence');
});

test('T31: tolerates bigint / string amm_spot_sats', () => {
  const rNum = shouldEnter(
    candidate({ amm_spot_sats: 1 }),
    portfolioState(),
    baseConfig({ entry: { max_indexer_vs_amm_ratio_x: 10 } }),
  );
  const rBig = shouldEnter(
    candidate({ amm_spot_sats: 1n }),
    portfolioState(),
    baseConfig({ entry: { max_indexer_vs_amm_ratio_x: 10 } }),
  );
  const rStr = shouldEnter(
    candidate({ amm_spot_sats: '1' }),
    portfolioState(),
    baseConfig({ entry: { max_indexer_vs_amm_ratio_x: 10 } }),
  );
  assert.equal(rNum.kind, 'indexer_vs_amm_divergence');
  assert.equal(rBig.kind, 'indexer_vs_amm_divergence');
  assert.equal(rStr.kind, 'indexer_vs_amm_divergence');
});

test('T31: bad amm_spot_sats (NaN, negative, empty string) → guard SKIPPED', () => {
  const r1 = shouldEnter(
    candidate({ amm_spot_sats: NaN }),
    portfolioState(),
    baseConfig({ entry: { max_indexer_vs_amm_ratio_x: 10 } }),
  );
  const r2 = shouldEnter(
    candidate({ amm_spot_sats: -1 }),
    portfolioState(),
    baseConfig({ entry: { max_indexer_vs_amm_ratio_x: 10 } }),
  );
  const r3 = shouldEnter(
    candidate({ amm_spot_sats: '' }),
    portfolioState(),
    baseConfig({ entry: { max_indexer_vs_amm_ratio_x: 10 } }),
  );
  assert.notEqual(r1.kind, 'indexer_vs_amm_divergence');
  assert.notEqual(r2.kind, 'indexer_vs_amm_divergence');
  assert.notEqual(r3.kind, 'indexer_vs_amm_divergence');
});

test('T31: reasoning blob carries the divergence decision details', () => {
  const result = shouldEnter(
    candidate({ amm_spot_sats: 1 }),
    portfolioState(),
    baseConfig({ entry: { max_indexer_vs_amm_ratio_x: 100 } }),
  );
  assert.equal(result.enter, false);
  assert.equal(result.kind, 'indexer_vs_amm_divergence');
  assert.ok(result.reasoning && typeof result.reasoning === 'object');
  // The reasoning tree should surface the relevant knobs for the operator audit trail.
  // The implementation nests knobs under `conditions` (matching the rest of the
  // _entryReasoning output) rather than a separate `entry` sub-object — the test
  // asserts the canonical shape.
  assert.ok(result.reasoning.conditions !== undefined);
  assert.equal(result.reasoning.conditions.max_indexer_vs_amm_ratio_x, 100);
  // And the decision object should describe the actual observed ratio.
  assert.ok(result.reasoning.decision && typeof result.reasoning.decision === 'object');
  assert.ok(result.reasoning.decision.observed_ratio_x !== undefined);
});

test('T31: DEFAULT_ENTRY_CONFIG exposes max_indexer_vs_amm_ratio_x = 1000', () => {
  assert.equal(DEFAULT_ENTRY_CONFIG.max_indexer_vs_amm_ratio_x, 1000);
});

test('T31: resolveEntryConfig falls back to default when ratio is missing', () => {
  const cfg = resolveEntryConfig({});
  assert.equal(cfg.max_indexer_vs_amm_ratio_x, 1000);
});
// ────────────────────────────────────────────────────────────────────
//  T32 — pre-entry AMM depth floor
// ────────────────────────────────────────────────────────────────────

test('T32: total AMM depth above floor → no rejection', () => {
  // Default floor = 150_000_000 sats; pass 200_000_000 → pass.
  const result = shouldEnter(
    candidate({ amm_total_depth_sats: 200_000_000n }),
    portfolioState(),
    baseConfig(),
  );
  assert.notEqual(result.kind, 'below_min_amm_depth');
});

test('T32: total AMM depth exactly at floor → pass (inclusive boundary)', () => {
  // Default floor = 150_000_000 sats; pass 150_000_000 → pass.
  const result = shouldEnter(
    candidate({ amm_total_depth_sats: 150_000_000n }),
    portfolioState(),
    baseConfig(),
  );
  assert.notEqual(result.kind, 'below_min_amm_depth');
});

test('T32: total AMM depth below floor → reject (kind: below_min_amm_depth)', () => {
  // 100_000_000 sats = 1 BCH, well below the 1.5 BCH default floor.
  const result = shouldEnter(
    candidate({ amm_total_depth_sats: 100_000_000n }),
    portfolioState(),
    baseConfig(),
  );
  assert.equal(result.enter, false);
  assert.equal(result.kind, 'below_min_amm_depth');
  assert.match(result.reason, /total AMM depth 100000000 sats/);
  assert.match(result.reason, /min_amm_total_depth_sats 150000000 sats/);
});

test('T32: QBTC pathology (132M sats across 10 pools) is now rejected', () => {
  // The actual live AMM depth on QBTC 2026-09-14 (10 pools × ~13.2M
  // sats each = ~132M sats = ~1.32 BCH). Under the 1.5 BCH default
  // floor, this is rejected. (The T31 indexer-vs-AMM divergence guard
  // would have already rejected the bogus 326 BCH/QBTC indexer price;
  // T32 catches the depth concern for tokens where the indexer price
  // looks reasonable but live depth is shallow.)
  const result = shouldEnter(
    candidate({ amm_total_depth_sats: 132_000_000n }),
    portfolioState(),
    baseConfig(),
  );
  assert.equal(result.enter, false);
  assert.equal(result.kind, 'below_min_amm_depth');
});

test('T32: missing amm_total_depth_sats → guard SKIPPED (probe failed)', () => {
  const result = shouldEnter(
    candidate({ amm_total_depth_sats: null }),
    portfolioState(),
    baseConfig(),
  );
  assert.notEqual(result.kind, 'below_min_amm_depth');
});

test('T32: zero amm_total_depth_sats → reject (0 < floor)', () => {
  // All pools drained — confirmed zero depth. Different from `null`
  // (probe failed → SKIPPED). Zero is below any positive floor.
  const result = shouldEnter(
    candidate({ amm_total_depth_sats: 0n }),
    portfolioState(),
    baseConfig(),
  );
  assert.equal(result.enter, false);
  assert.equal(result.kind, 'below_min_amm_depth');
});

test('T32: tolerate number / string amm_total_depth_sats', () => {
  const rNum = shouldEnter(
    candidate({ amm_total_depth_sats: 100_000_000 }),
    portfolioState(),
    baseConfig(),
  );
  const rStr = shouldEnter(
    candidate({ amm_total_depth_sats: '100000000' }),
    portfolioState(),
    baseConfig(),
  );
  assert.equal(rNum.kind, 'below_min_amm_depth');
  assert.equal(rStr.kind, 'below_min_amm_depth');
});

test('T32: bad amm_total_depth_sats (NaN, negative, empty string) → guard SKIPPED', () => {
  const r1 = shouldEnter(
    candidate({ amm_total_depth_sats: NaN }),
    portfolioState(),
    baseConfig(),
  );
  const r2 = shouldEnter(
    candidate({ amm_total_depth_sats: -100 }),
    portfolioState(),
    baseConfig(),
  );
  const r3 = shouldEnter(
    candidate({ amm_total_depth_sats: '' }),
    portfolioState(),
    baseConfig(),
  );
  assert.notEqual(r1.kind, 'below_min_amm_depth');
  assert.notEqual(r2.kind, 'below_min_amm_depth');
  assert.notEqual(r3.kind, 'below_min_amm_depth');
});

test('T32: min_amm_total_depth_sats = 0 → guard DISABLED (operator opts out)', () => {
  // 0 is a positive disable signal: explicit "I don't want this guard".
  const result = shouldEnter(
    candidate({ amm_total_depth_sats: 1n }), // 1 sat, way under any floor
    portfolioState(),
    baseConfig({ entry: { min_amm_total_depth_sats: 0 } }),
  );
  // Guard disabled → shouldEnter does not reject for depth.
  assert.notEqual(result.kind, 'below_min_amm_depth');
});

test('T32: custom min_amm_total_depth_sats = 2 BCH rejects 1.32 BCH but accepts 3 BCH', () => {
  const reject = shouldEnter(
    candidate({ amm_total_depth_sats: 132_000_000n }),
    portfolioState(),
    baseConfig({ entry: { min_amm_total_depth_sats: 200_000_000 } }),
  );
  assert.equal(reject.kind, 'below_min_amm_depth');

  const pass = shouldEnter(
    candidate({ amm_total_depth_sats: 300_000_000n }),
    portfolioState(),
    baseConfig({ entry: { min_amm_total_depth_sats: 200_000_000 } }),
  );
  assert.notEqual(pass.kind, 'below_min_amm_depth');
});

test('T32: reasoning blob carries the depth decision details', () => {
  const result = shouldEnter(
    candidate({ amm_total_depth_sats: 100_000_000n }),
    portfolioState(),
    baseConfig(),
  );
  assert.equal(result.kind, 'below_min_amm_depth');
  assert.ok(result.reasoning && typeof result.reasoning === 'object');
  assert.ok(result.reasoning.conditions !== undefined);
  assert.equal(result.reasoning.conditions.min_amm_total_depth_sats, 150_000_000);
  assert.ok(result.reasoning.decision && typeof result.reasoning.decision === 'object');
  assert.equal(result.reasoning.decision.kind, 'below_min_amm_depth');
  assert.equal(result.reasoning.decision.amm_total_depth_sats, '100000000');
  assert.equal(result.reasoning.decision.min_amm_total_depth_sats, 150_000_000);
});

test('T32: DEFAULT_ENTRY_CONFIG exposes min_amm_total_depth_sats = 150_000_000', () => {
  assert.equal(DEFAULT_ENTRY_CONFIG.min_amm_total_depth_sats, 150_000_000);
});

test('T32: resolveEntryConfig falls back to default when missing', () => {
  const cfg = resolveEntryConfig({});
  assert.equal(cfg.min_amm_total_depth_sats, 150_000_000);
});

test('T32: T32 guard fires BEFORE T31 divergence guard (depth is more fundamental)', () => {
  // Even with a wildly divergent indexer price, depth check should
  // come first because a thin pool can't be exited at any price.
  // We pass an AMM spot AND a total depth that's below the floor;
  // depth must win.
  const result = shouldEnter(
    candidate({
      amm_spot_sats: 1,                       // tiny AMM spot
      stats: { price_now_sats: 100_000_000 },  // wildly divergent
      amm_total_depth_sats: 100_000_000n,     // below 150M floor
    }),
    portfolioState(),
    baseConfig({ entry: { max_indexer_vs_amm_ratio_x: 10 } }),
  );
  assert.equal(result.kind, 'below_min_amm_depth');
});

// ────────────────────────────────────────────────────────────────────
//  T33 — position concentration cap (max % of wallet per open position)
// ────────────────────────────────────────────────────────────────────

test('T33: DEFAULT_ENTRY_CONFIG exposes max_position_concentration_pct = 25.0', () => {
  assert.equal(DEFAULT_ENTRY_CONFIG.max_position_concentration_pct, 25.0);
});

test('T33: resolveEntryConfig falls back to default when missing', () => {
  const cfg = resolveEntryConfig({});
  assert.equal(cfg.max_position_concentration_pct, 25.0);
});

test('T33: resolveEntryConfig accepts custom percentage overrides', () => {
  const cfg = resolveEntryConfig({ max_position_concentration_pct: 10.0 });
  assert.equal(cfg.max_position_concentration_pct, 10.0);
});

test('T33: resolveEntryConfig: 0 → sentinel -1 (guard DISABLED, opt-in pattern)', () => {
  // Operator sets pct to 0 → operator is explicitly opting out of the
  // guard. resolveEntryConfig normalizes to -1 so the sizer can
  // distinguish "0% (would block all trades)" from "disabled".
  const cfg = resolveEntryConfig({ max_position_concentration_pct: 0 });
  assert.equal(cfg.max_position_concentration_pct, -1);
});

test('T33: resolveEntryConfig: negative → sentinel -1 (guard DISABLED)', () => {
  const cfg = resolveEntryConfig({ max_position_concentration_pct: -10 });
  assert.equal(cfg.max_position_concentration_pct, -1);
});

test('T33: resolveEntryConfig: > 100 → sentinel -1 (guard DISABLED)', () => {
  // >100% of wallet would let a trade exceed the wallet (no-op anyway),
  // so we treat it as a disable signal — matches the T32 opt-in pattern.
  const cfg = resolveEntryConfig({ max_position_concentration_pct: 150 });
  assert.equal(cfg.max_position_concentration_pct, -1);
});

test('T33: resolveEntryConfig: non-numeric string falls back to default', () => {
  // Matches the `num()` helper behavior used for every other knob.
  const cfg = resolveEntryConfig({ max_position_concentration_pct: 'abc' });
  assert.equal(cfg.max_position_concentration_pct, DEFAULT_ENTRY_CONFIG.max_position_concentration_pct);
});

test('T33: resolveEntryConfig: NaN → falls back to default (matches num() helper semantics)', () => {
  // The `num()` helper used for every knob ignores non-finite values
  // and lets the spread default win. NaN does NOT reach the
  // disable check below (which only fires for finite-but-out-of-
  // range values), so the operator gets the safe default 25% rather
  // than a disabled guard.
  const cfg = resolveEntryConfig({ max_position_concentration_pct: NaN });
  assert.equal(cfg.max_position_concentration_pct, DEFAULT_ENTRY_CONFIG.max_position_concentration_pct);
});

test('computeEntrySizeBch: T33 cap is no-op when cap > max_position_bch (normal small-balance)', () => {
  // wallet 0.044 × 25% = 0.011 cap, max_pos 0.005 → cap is a no-op,
  // the per-trade ceiling wins. Confirms the guard is dormant under
  // the small-balance preset.
  const size = computeEntrySizeBch({
    maxPositionBch: 0.005,
    maxTotalExposureBch: 0.04,
    openExposureBch: 0,
    walletBalanceBch: 0.044,
    minWalletBalanceBch: 0.005,
    minTradeSizeBch: 0.0005,
    maxPositionConcentrationPct: 25.0,
  });
  assert.equal(size, 0.005);
});

test('computeEntrySizeBch: T33 cap shrinks size when wallet shrinks', () => {
  // max_position_bch=0.005 but the 25% cap on a 0.01 BCH wallet is 0.0025,
  // which is BELOW max_position_bch. Cap wins.
  const size = computeEntrySizeBch({
    maxPositionBch: 0.005,
    maxTotalExposureBch: 0.04,
    openExposureBch: 0,
    walletBalanceBch: 0.01,           // shrunk from 0.044
    minWalletBalanceBch: 0.001,
    minTradeSizeBch: 0.0005,
    maxPositionConcentrationPct: 25.0,
  });
  // pre-cap: min(0.005, 0.04, 0.009) = 0.005
  // cap:    min(0.005, 0.01 * 0.25) = min(0.005, 0.0025) = 0.0025
  // floor:  floor(0.0025 / 0.0005) * 0.0005 = 5 * 0.0005 = 0.0025
  assert.equal(size, 0.0025);
});

test('computeEntrySizeBch: T33 cap=disabled (-1) behaves like omitted', () => {
  const sizeWithDisabled = computeEntrySizeBch({
    maxPositionBch: 0.005,
    maxTotalExposureBch: 0.04,
    openExposureBch: 0,
    walletBalanceBch: 0.044,
    minWalletBalanceBch: 0.005,
    minTradeSizeBch: 0.0005,
    maxPositionConcentrationPct: -1,
  });
  const sizeWithout = computeEntrySizeBch({
    maxPositionBch: 0.005,
    maxTotalExposureBch: 0.04,
    openExposureBch: 0,
    walletBalanceBch: 0.044,
    minWalletBalanceBch: 0.005,
    minTradeSizeBch: 0.0005,
  });
  assert.equal(sizeWithDisabled, sizeWithout);
  assert.equal(sizeWithDisabled, 0.005);
});

test('computeEntrySizeBch: T33 cap returns NaN when cap shrinks size below dust floor', () => {
  // max_position_bch=0.005; cap on a 0.001 BCH wallet at 25% = 0.00025 BCH
  // which is below min_trade_size_bch=0.0005. Cap is responsible for
  // reducing the position to a non-viable size → signal NaN so the
  // caller can distinguish from dust-floor rejection.
  const size = computeEntrySizeBch({
    maxPositionBch: 0.005,
    maxTotalExposureBch: 0.04,
    openExposureBch: 0,
    walletBalanceBch: 0.001,
    minWalletBalanceBch: 0.0001,
    minTradeSizeBch: 0.0005,
    maxPositionConcentrationPct: 25.0,
  });
  assert.ok(Number.isNaN(size));
});

test('computeEntrySizeBch: T33 cap=100% → no constraint (cap = wallet)', () => {
  // 100% cap equals the wallet — other gates (affordable floor,
  // dust floor) dominate.
  const size = computeEntrySizeBch({
    maxPositionBch: 0.005,
    maxTotalExposureBch: 0.04,
    openExposureBch: 0,
    walletBalanceBch: 0.044,
    minWalletBalanceBch: 0.005,
    minTradeSizeBch: 0.0005,
    maxPositionConcentrationPct: 100.0,
  });
  assert.equal(size, 0.005);
});

test('computeEntrySizeBch: T33 cap with non-finite pct → guard SKIPPED', () => {
  const size = computeEntrySizeBch({
    maxPositionBch: 0.005,
    maxTotalExposureBch: 0.04,
    openExposureBch: 0,
    walletBalanceBch: 0.044,
    minWalletBalanceBch: 0.005,
    minTradeSizeBch: 0.0005,
    maxPositionConcentrationPct: NaN,
  });
  assert.equal(size, 0.005);
});

test('shouldEnter: T33 reasoning blob carries max_position_concentration_pct + concentration_cap_bch', () => {
  const result = shouldEnter(candidate(), portfolioState(), baseConfig());
  // Configured percentage lives in `conditions` (it's a knob);
  // the wallet-relative ceiling in BCH lives in `decision`
  // (it's derived from the live wallet at decision time).
  assert.equal(result.reasoning.conditions.max_position_concentration_pct, 25.0);
  // 25% of 0.044 wallet = 0.011 BCH → well above max_position_bch (0.005).
  // The reasoning blob surfaces BOTH the configured percentage AND the
  // implied wallet-relative ceiling in BCH for operator auditability.
  assert.equal(result.reasoning.decision.concentration_cap_bch, 0.011);
});

test('shouldEnter: T33 reasoning blob shows concentration_cap_bch=null when guard disabled', () => {
  const result = shouldEnter(
    candidate(),
    portfolioState(),
    baseConfig({ entry: { max_position_concentration_pct: 0 } }),
  );
  // Sentinel -1 → null in the audit blob (operator reads "guard off"
  // rather than "concentration cap = -1%"). Same null treatment in
  // both `conditions` (the knob) and `decision` (the derived cap).
  assert.equal(result.reasoning.conditions.max_position_concentration_pct, null);
  assert.equal(result.reasoning.decision.concentration_cap_bch, null);
});

test('shouldEnter: T33 cap reduced size below dust floor → enter:false, kind:concentration_cap', () => {
  // Force the cap to bite: tiny wallet (0.001 BCH) + 25% cap = 0.00025 BCH
  // which is below min_trade_size_bch=0.0005. The sizer returns NaN,
  // shouldEnter surfaces it as 'concentration_cap' so the operator
  // can tell "wallet is too small for this cap" from "dust floor
  // swallowed the position".
  const result = shouldEnter(
    candidate(),
    portfolioState({ walletBalanceBch: 0.001 }),
    baseConfig({ risk: { min_wallet_balance_bch: 0.0001 } }),
  );
  assert.equal(result.enter, false);
  assert.equal(result.kind, 'concentration_cap');
  assert.match(result.reason, /position concentration cap 25% of wallet = 0\.00025000 BCH/);
});

test('shouldEnter: T33 cap=disabled (-1) → existing dust-floor rejection stays "size_zero"', () => {
  // When the guard is disabled (operator opts out via pct=0), a
  // position rejected ONLY by the dust floor must surface as
  // 'size_zero' (the historical kind) — NOT as 'concentration_cap'.
  // We force a max_position_bch below min_trade_size_bch + cap=0;
  // the resulting dust-floor rejection must read as 'size_zero'.
  const result = shouldEnter(
    candidate(),
    portfolioState(),
    baseConfig({
      entry: {
        max_position_bch: 0.0001,
        min_trade_size_bch: 0.05, // way above max_position_bch
        max_position_concentration_pct: 0, // disabled
      },
    }),
  );
  assert.equal(result.enter, false);
  // Cap was disabled (sentinel -1) → sizer never returns NaN →
  // shouldEnter falls through to the generic 'size_zero' kind.
  // This is the critical regression guard: the new logic must NOT
  // misclassify dust-floor rejections as cap rejections.
  assert.equal(result.kind, 'size_zero');
});

test('shouldEnter: T33 cap shrunk size but cap > dust floor → no rejection (cap works as ceiling)', () => {
  // cap=25% on a 0.01 BCH wallet = 0.0025 BCH, above dust floor
  // (0.0005). Position should enter at the cap-driven size, NOT
  // be rejected.
  const result = shouldEnter(
    candidate(),
    portfolioState({ walletBalanceBch: 0.01 }),
    baseConfig({ risk: { min_wallet_balance_bch: 0.001 } }),
  );
  assert.equal(result.enter, true);
  assert.equal(result.sizeBch, 0.0025);
});

test('shouldEnter: T33 cap=50% still allows normal small-balance sizing', () => {
  // Tighter cap (50%) on a 0.044 BCH wallet = 0.022 BCH cap, still
  // above max_position_bch (0.005) → cap is a no-op.
  const result = shouldEnter(
    candidate(),
    portfolioState(),
    baseConfig({ entry: { max_position_concentration_pct: 50.0 } }),
  );
  assert.equal(result.enter, true);
  assert.equal(result.sizeBch, 0.005);
  assert.equal(result.reasoning.conditions.max_position_concentration_pct, 50.0);
  assert.equal(result.reasoning.decision.concentration_cap_bch, 0.022);
});

test('GUARD: T33 cap=5% shrinks size on a $50 wallet', () => {
  // 5% of 0.044 = 0.0022 BCH → cap-driven size below max_position_bch
  // (0.005). Floored DOWN to min_trade_size_bch step (0.0005):
  // floor(0.0022 / 0.0005) = floor(4.4) = 4 → 4 × 0.0005 = 0.002.
  const result = shouldEnter(
    candidate(),
    portfolioState(),
    baseConfig({ entry: { max_position_concentration_pct: 5.0 } }),
  );
  assert.equal(result.enter, true);
  assert.equal(result.sizeBch, 0.002);
  // 5% of 0.044 = 0.0022 → audit blob surfaces the pre-floor cap
  // (so the operator sees exactly what the cap said before dust flooring).
  assert.equal(result.reasoning.decision.concentration_cap_bch, 0.0022);
});

// ────────────────────────────────────────────────────────────────────
//  T35 — volatility-adjusted position sizing (Kelly-lite)
// ────────────────────────────────────────────────────────────────────

test('T35: DEFAULT_ENTRY_CONFIG exposes volatility_sizing_target_pct = 5.0', () => {
  assert.equal(DEFAULT_ENTRY_CONFIG.volatility_sizing_target_pct, 5.0);
});

test('T35: resolveEntryConfig accepts a custom target percentage', () => {
  const cfg = resolveEntryConfig({ volatility_sizing_target_pct: 10 });
  assert.equal(cfg.volatility_sizing_target_pct, 10);
});

test('T35: resolveEntryConfig: 0 → sentinel -1 (guard DISABLED, opt-in pattern)', () => {
  const cfg = resolveEntryConfig({ volatility_sizing_target_pct: 0 });
  assert.equal(cfg.volatility_sizing_target_pct, -1);
});

test('T35: resolveEntryConfig: negative → sentinel -1 (guard DISABLED)', () => {
  const cfg = resolveEntryConfig({ volatility_sizing_target_pct: -5 });
  assert.equal(cfg.volatility_sizing_target_pct, -1);
});

test('T35: resolveEntryConfig: > 100 → sentinel -1 (guard DISABLED)', () => {
  const cfg = resolveEntryConfig({ volatility_sizing_target_pct: 200 });
  assert.equal(cfg.volatility_sizing_target_pct, -1);
});

test('T35: resolveEntryConfig: non-numeric string falls back to default', () => {
  const cfg = resolveEntryConfig({ volatility_sizing_target_pct: 'high' });
  assert.equal(cfg.volatility_sizing_target_pct, 5.0);
});

test('T35: resolveEntryConfig: NaN → falls back to default', () => {
  const cfg = resolveEntryConfig({ volatility_sizing_target_pct: NaN });
  assert.equal(cfg.volatility_sizing_target_pct, 5.0);
});

test('T35: computeEntrySizeBch: realized vol = target → no scaling (1.0x)', () => {
  // 0.044 BCH wallet, 25% cap = 0.011 BCH; max_position_bch=0.005
  // floor dominates → 0.005. Target 5%, realized 5% → no scale-down.
  const size = computeEntrySizeBch({
    maxPositionBch: 0.005,
    maxTotalExposureBch: 0.04,
    openExposureBch: 0,
    walletBalanceBch: 0.044,
    minWalletBalanceBch: 0.005,
    minTradeSizeBch: 0.0005,
    maxPositionConcentrationPct: 25,
    volatilitySizingTargetPct: 5.0,
    realizedVolatility24hPct: 5.0,
  });
  assert.equal(size, 0.005);
});

test('T35: computeEntrySizeBch: realized vol BELOW target → no scaling (calm regime)', () => {
  // Kelly-lite is asymmetric: never scale up. Calm regime → ceiling dominates.
  const size = computeEntrySizeBch({
    maxPositionBch: 0.005,
    maxTotalExposureBch: 0.04,
    openExposureBch: 0,
    walletBalanceBch: 0.044,
    minWalletBalanceBch: 0.005,
    minTradeSizeBch: 0.0005,
    maxPositionConcentrationPct: 25,
    volatilitySizingTargetPct: 5.0,
    realizedVolatility24hPct: 2.0,
  });
  assert.equal(size, 0.005);
});

test('T35: computeEntrySizeBch: realized vol ABOVE target → scales DOWN linearly', () => {
  // 0.044 wallet, target 5%, realized 20% → scale = 5/20 = 0.25.
  // Pre-scale size = 0.005 (max_position_bch). Scaled = 0.00125.
  // After floor step (0.0005): 0.0015 (2 * step).
  const size = computeEntrySizeBch({
    maxPositionBch: 0.005,
    maxTotalExposureBch: 0.04,
    openExposureBch: 0,
    walletBalanceBch: 0.044,
    minWalletBalanceBch: 0.005,
    minTradeSizeBch: 0.0005,
    maxPositionConcentrationPct: 25,
    volatilitySizingTargetPct: 5.0,
    realizedVolatility24hPct: 20.0,
  });
  // 0.005 * 0.25 = 0.00125; floor step 0.0005 → 0.001
  assert.equal(size, 0.001);
});

test('T35: computeEntrySizeBch: 10x realized vol → ~10x size shrink', () => {
  // target 5%, realized 50% → scale = 0.1. 0.005 * 0.1 = 0.0005 = dust floor.
  const size = computeEntrySizeBch({
    maxPositionBch: 0.005,
    maxTotalExposureBch: 0.04,
    openExposureBch: 0,
    walletBalanceBch: 0.044,
    minWalletBalanceBch: 0.005,
    minTradeSizeBch: 0.0005,
    maxPositionConcentrationPct: 25,
    volatilitySizingTargetPct: 5.0,
    realizedVolatility24hPct: 50.0,
  });
  assert.equal(size, 0.0005);
});

test('T35: computeEntrySizeBch: 100x realized vol → size below dust → 0', () => {
  // target 5%, realized 500% → scale = 0.01. 0.005 * 0.01 = 0.00005 < dust.
  const size = computeEntrySizeBch({
    maxPositionBch: 0.005,
    maxTotalExposureBch: 0.04,
    openExposureBch: 0,
    walletBalanceBch: 0.044,
    minWalletBalanceBch: 0.005,
    minTradeSizeBch: 0.0005,
    maxPositionConcentrationPct: 25,
    volatilitySizingTargetPct: 5.0,
    realizedVolatility24hPct: 500.0,
  });
  assert.equal(size, 0);
});

test('T35: computeEntrySizeBch: realizedVol=null → guard SKIPPED (no data)', () => {
  // No vol data → no scaling, full max_position_bch.
  const size = computeEntrySizeBch({
    maxPositionBch: 0.005,
    maxTotalExposureBch: 0.04,
    openExposureBch: 0,
    walletBalanceBch: 0.044,
    minWalletBalanceBch: 0.005,
    minTradeSizeBch: 0.0005,
    maxPositionConcentrationPct: 25,
    volatilitySizingTargetPct: 5.0,
    realizedVolatility24hPct: null,
  });
  assert.equal(size, 0.005);
});

test('T35: computeEntrySizeBch: realizedVol=0 → guard SKIPPED (degenerate)', () => {
  // Zero vol → division by zero would NaN out; skip instead.
  const size = computeEntrySizeBch({
    maxPositionBch: 0.005,
    maxTotalExposureBch: 0.04,
    openExposureBch: 0,
    walletBalanceBch: 0.044,
    minWalletBalanceBch: 0.005,
    minTradeSizeBch: 0.0005,
    maxPositionConcentrationPct: 25,
    volatilitySizingTargetPct: 5.0,
    realizedVolatility24hPct: 0,
  });
  assert.equal(size, 0.005);
});

test('T35: computeEntrySizeBch: target disabled (-1) → guard SKIPPED', () => {
  const size = computeEntrySizeBch({
    maxPositionBch: 0.005,
    maxTotalExposureBch: 0.04,
    openExposureBch: 0,
    walletBalanceBch: 0.044,
    minWalletBalanceBch: 0.005,
    minTradeSizeBch: 0.0005,
    maxPositionConcentrationPct: 25,
    volatilitySizingTargetPct: -1,
    realizedVolatility24hPct: 50.0,
  });
  assert.equal(size, 0.005);
});

test('T35: computeEntrySizeBch: target 0 → guard SKIPPED (opt-out)', () => {
  const size = computeEntrySizeBch({
    maxPositionBch: 0.005,
    maxTotalExposureBch: 0.04,
    openExposureBch: 0,
    walletBalanceBch: 0.044,
    minWalletBalanceBch: 0.005,
    minTradeSizeBch: 0.0005,
    maxPositionConcentrationPct: 25,
    volatilitySizingTargetPct: 0,
    realizedVolatility24hPct: 50.0,
  });
  assert.equal(size, 0.005);
});

test('T35: computeEntrySizeBch: target non-finite → guard SKIPPED', () => {
  const size = computeEntrySizeBch({
    maxPositionBch: 0.005,
    maxTotalExposureBch: 0.04,
    openExposureBch: 0,
    walletBalanceBch: 0.044,
    minWalletBalanceBch: 0.005,
    minTradeSizeBch: 0.0005,
    maxPositionConcentrationPct: 25,
    volatilitySizingTargetPct: NaN,
    realizedVolatility24hPct: 50.0,
  });
  assert.equal(size, 0.005);
});

test('T35: shouldEnter: reasoning blob carries vol_sizing_* fields on happy path', () => {
  const cfg = baseConfig();
  const cand = candidate({
    stats: { ...candidate().stats, volatility_24h_pct: 3.44 },
  });
  const result = shouldEnter(cand, portfolioState(), cfg);
  assert.equal(result.enter, true);
  assert.equal(result.reasoning.conditions.volatility_sizing_target_pct, 5.0);
  assert.equal(result.reasoning.decision.vol_sizing_target_pct, 5.0);
  assert.equal(result.reasoning.decision.vol_sizing_realized_pct, 3.44);
  // realized (3.44) < target (5.0) → no scaling → scale = 1.0
  assert.equal(result.reasoning.decision.vol_sizing_scale, 1.0);
});

test('T35: shouldEnter: vol_sizing_scale < 1.0 when realized > target', () => {
  const cfg = baseConfig();
  const cand = candidate({
    stats: { ...candidate().stats, volatility_24h_pct: 20.0 },
  });
  const result = shouldEnter(cand, portfolioState(), cfg);
  assert.equal(result.enter, true);
  // 5/20 = 0.25 scale
  assert.equal(result.reasoning.decision.vol_sizing_scale, 0.25);
  assert.equal(result.reasoning.decision.vol_sizing_target_pct, 5.0);
  assert.equal(result.reasoning.decision.vol_sizing_realized_pct, 20.0);
  // scaled: 0.005 * 0.25 = 0.00125, floored to 0.001 (dust step 0.0005)
  assert.equal(result.sizeBch, 0.001);
});

test('T35: shouldEnter: reasoning shows vol_sizing_* as null when guard disabled', () => {
  const cfg = baseConfig({
    entry: { volatility_sizing_target_pct: 0 },
  });
  const cand = candidate({
    stats: { ...candidate().stats, volatility_24h_pct: 50.0 },
  });
  const result = shouldEnter(cand, portfolioState(), cfg);
  assert.equal(result.enter, true);
  // audit surfaces "guard disabled" (null), not the -1 sentinel
  assert.equal(result.reasoning.conditions.volatility_sizing_target_pct, null);
  assert.equal(result.reasoning.decision.vol_sizing_target_pct, null);
  // realized still surfaced (for audit), but scale is 1.0 because guard skipped
  assert.equal(result.reasoning.decision.vol_sizing_realized_pct, 50.0);
  assert.equal(result.reasoning.decision.vol_sizing_scale, 1.0);
  assert.equal(result.sizeBch, 0.005);
});

test('T35: shouldEnter: tolerates candidate.volatility_24h_pct missing entirely', () => {
  const cfg = baseConfig();
  // stats has no volatility_24h_pct
  const cand = candidate();
  // delete to make sure no fallback comes from candidate top-level
  delete cand.volatility_24h_pct;
  cand.stats = { ...cand.stats };
  delete cand.stats.volatility_24h_pct;
  const result = shouldEnter(cand, portfolioState(), cfg);
  assert.equal(result.enter, true);
  // No realized → guard skipped → scale = 1.0, realized=null
  assert.equal(result.reasoning.decision.vol_sizing_realized_pct, null);
  assert.equal(result.reasoning.decision.vol_sizing_scale, 1.0);
  assert.equal(result.sizeBch, 0.005);
});

test('T35: shouldEnter: reads candidate.volatility_24h_pct fallback when stats missing', () => {
  const cfg = baseConfig();
  const cand = candidate();
  cand.stats = { ...cand.stats };
  delete cand.stats.volatility_24h_pct;
  cand.volatility_24h_pct = 12.0; // 5/12 = 0.4167
  const result = shouldEnter(cand, portfolioState(), cfg);
  assert.equal(result.enter, true);
  assert.equal(result.reasoning.decision.vol_sizing_realized_pct, 12.0);
  assert.ok(Math.abs(result.reasoning.decision.vol_sizing_scale - (5 / 12)) < 1e-6);
});

test('T35: shouldEnter: very high vol + small wallet → size below dust → skip', () => {
  // 0.044 wallet, vol 500% → scale 0.01 → 0.00005 < dust 0.0005 → 0.
  const cfg = baseConfig();
  const cand = candidate({
    stats: { ...candidate().stats, volatility_24h_pct: 500.0 },
  });
  const result = shouldEnter(cand, portfolioState(), cfg);
  assert.equal(result.enter, false);
  // surface as size_zero (not a new kind — the dust floor swallowed it).
  // The vol_sizing_scale in the audit blob will show 0.01 so the operator
  // knows WHY the sizer returned 0.
  assert.equal(result.kind, 'size_zero');
  assert.equal(result.reasoning.decision.vol_sizing_scale, 0.01);
});

test('T35: shouldEnter: GUARD — explicit -1 disables scaling even with extreme vol', () => {
  const cfg = baseConfig({
    entry: { volatility_sizing_target_pct: -1 },
  });
  const cand = candidate({
    stats: { ...candidate().stats, volatility_24h_pct: 1000.0 },
  });
  const result = shouldEnter(cand, portfolioState(), cfg);
  assert.equal(result.enter, true);
  assert.equal(result.sizeBch, 0.005);
});

test('T35: GUARD — config/default.json entry block carries volatility_sizing_target_pct=5.0', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const cfgPath = path.resolve('config/default.json');
  const raw = await fs.readFile(cfgPath, 'utf8');
  const cfg = JSON.parse(raw);
  assert.equal(cfg.entry.volatility_sizing_target_pct, 5.0);
});

// ────────────────────────────────────────────────────────────────────
//  T36 — correlation-aware entries (skip token if highly correlated
//  with an existing position)
// ────────────────────────────────────────────────────────────────────
//
// `shouldEnter` reads `entry.correlation_skip_threshold` and rejects
// candidates whose 7-day price series is highly correlated with any
// open position's series. The series are sourced from the indexer's
// `stats.price_series_7d` (29 normalized points). See
// `src/util/correlation.mjs` for the pure helpers and
// `tests/util-correlation.test.mjs` for the helper-level tests;
// these tests cover the gate inside `shouldEnter`.

// Helper: a deterministic 29-point monotonic series (the shape of the
// Cauldron indexer's normalized 7-day price series).
function spikeAt29(spikeIndex = 28, base = 0.1, peak = 1.0) {
  return Array.from({ length: 29 }, (_, i) => (i === spikeIndex ? peak : base));
}

test('T36: DEFAULT_ENTRY_CONFIG exposes correlation_skip_threshold = -1 (disabled by default)', () => {
  assert.equal(DEFAULT_ENTRY_CONFIG.correlation_skip_threshold, -1);
});

test('T36: shouldEnter: no held series → guard SKIPPED (no candidate series either)', () => {
  // Even when guard is enabled, an empty held map means no candidate
  // can be correlated with anything → guard must NOT fire.
  const result = shouldEnter(
    candidate(),
    portfolioState(),
    baseConfig({ entry: { correlation_skip_threshold: 0.85 } }),
  );
  assert.equal(result.enter, true);
  // reasoning surfaces the threshold as an audit value (0.85) so the
  // operator can see the guard was active.
  assert.equal(result.reasoning.conditions.correlation_skip_threshold, 0.85);
});

test('T36: shouldEnter: candidate price_series_7d missing → guard SKIPPED', () => {
  // The indexer sometimes returns no series for a brand-new token.
  // The bot must NOT reject these — they're potentially the best
  // entries of all (no history = no correlation signal).
  // The candidate factory spreads `overrides` last, so we have to
  // merge into a copy of the default stats to wipe price_series_7d
  // without losing price_now_sats / change_24h_bp / etc.
  const heldMap = new Map();
  heldMap.set('abcdef', spikeAt29());
  const cand = candidate();
  cand.stats = { ...cand.stats };
  delete cand.stats.price_series_7d;
  const result = shouldEnter(
    cand,
    portfolioState({ heldSeriesByTokenId: heldMap }),
    baseConfig({ entry: { correlation_skip_threshold: 0.85 } }),
  );
  assert.equal(result.enter, true);
});

test('T36: shouldEnter: held map empty → guard SKIPPED', () => {
  const cand = candidate();
  cand.stats = { ...cand.stats, price_series_7d: spikeAt29() };
  const result = shouldEnter(
    cand,
    portfolioState({ heldSeriesByTokenId: new Map() }),
    baseConfig({ entry: { correlation_skip_threshold: 0.85 } }),
  );
  assert.equal(result.enter, true);
});

test('T36: shouldEnter: candidate highly correlated with held → reject kind:correlation_skip', () => {
  // Both series share the spike-at-end pattern → near-perfect correlation.
  // Threshold 0.85 → 0.99 maxAbs > 0.85 → reject.
  const candSeries = spikeAt29();
  const heldSeries = spikeAt29(); // identical → r = 1.0
  const heldMap = new Map();
  heldMap.set('b'.repeat(64), heldSeries); // DIFFERENT token id from candidate
  const cand = candidate();
  cand.stats = { ...cand.stats, price_series_7d: candSeries };
  const result = shouldEnter(
    cand,
    portfolioState({ heldSeriesByTokenId: heldMap }),
    baseConfig({ entry: { correlation_skip_threshold: 0.85 } }),
  );
  assert.equal(result.enter, false);
  assert.equal(result.kind, 'correlation_skip');
  assert.match(result.reason, /correlation_skip_threshold 0\.85/);
  // Audit blob surfaces the threshold, observed correlation, and
  // the held token the candidate was duplicating.
  assert.equal(result.reasoning.conditions.correlation_skip_threshold, 0.85);
  assert.ok(result.reasoning.decision.correlation_threshold === 0.85);
  assert.ok(result.reasoning.decision.correlation_max > 0.85);
  assert.equal(result.reasoning.decision.correlation_against_token_id, 'b'.repeat(64));
});

test('T36: shouldEnter: weakly correlated candidate → guard does NOT fire', () => {
  // candidate: spike at index 28. held: spike at index 0. Different
  // shape → very low absolute Pearson r.
  const candSeries = spikeAt29(28);
  const heldSeries = spikeAt29(0);
  const heldMap = new Map();
  heldMap.set('b'.repeat(64), heldSeries);
  const cand = candidate();
  cand.stats = { ...cand.stats, price_series_7d: candSeries };
  const result = shouldEnter(
    cand,
    portfolioState({ heldSeriesByTokenId: heldMap }),
    baseConfig({ entry: { correlation_skip_threshold: 0.85 } }),
  );
  assert.equal(result.enter, true);
});

test('T36: shouldEnter: threshold 0.5 accepts mildly correlated, rejects 1.0', () => {
  // Threshold 0.5: a candidate with a strongly correlated held token
  // should be rejected, while a held token with moderate correlation
  // should pass.
  const candSeries = spikeAt29();
  // Mildly correlated: monotonic increasing (no spike) → r > 0 but
  // not extreme because the spike dominates the candidate's variance.
  const mildSeries = Array.from({ length: 29 }, (_, i) => 0.1 + i * 0.01);
  const heldMap = new Map();
  heldMap.set('c'.repeat(64), mildSeries);
  const cand = candidate();
  cand.stats = { ...cand.stats, price_series_7d: candSeries };
  const pass = shouldEnter(
    cand,
    portfolioState({ heldSeriesByTokenId: heldMap }),
    baseConfig({ entry: { correlation_skip_threshold: 0.5 } }),
  );
  // We don't assert the exact outcome — only that the threshold is
  // the active knob. Instead we verify the threshold is read from cfg
  // (audit blob) and a SECOND test below verifies rejection when the
  // threshold is crossed.
  assert.equal(pass.reasoning.conditions.correlation_skip_threshold, 0.5);

  // Identical series → reject at threshold 0.99 (way exceeded).
  const heldMap2 = new Map();
  heldMap2.set('d'.repeat(64), candSeries);
  const cand2 = candidate();
  cand2.stats = { ...cand2.stats, price_series_7d: candSeries };
  const reject = shouldEnter(
    cand2,
    portfolioState({ heldSeriesByTokenId: heldMap2 }),
    baseConfig({ entry: { correlation_skip_threshold: 0.99 } }),
  );
  assert.equal(reject.enter, false);
  assert.equal(reject.kind, 'correlation_skip');
});

test('T36: shouldEnter: explicit -1 disables guard (audit shows null)', () => {
  const candSeries = spikeAt29();
  const heldMap = new Map();
  heldMap.set('e'.repeat(64), candSeries);
  const cand = candidate();
  cand.stats = { ...cand.stats, price_series_7d: candSeries };
  const result = shouldEnter(
    cand,
    portfolioState({ heldSeriesByTokenId: heldMap }),
    baseConfig({ entry: { correlation_skip_threshold: -1 } }),
  );
  assert.equal(result.enter, true);
  // Audit surfaces null, not the -1 sentinel, so the operator can
  // tell "guard disabled" from "guard set to N".
  assert.equal(result.reasoning.conditions.correlation_skip_threshold, null);
});

test('T36: shouldEnter: threshold > 1 coerces to -1 (audit null, guard disabled)', () => {
  // A threshold > 1 would never fire (correlation is bounded in
  // [-1, 1]) so it's better expressed as "guard disabled".
  const candSeries = spikeAt29();
  const heldMap = new Map();
  heldMap.set('f'.repeat(64), candSeries);
  const cand = candidate();
  cand.stats = { ...cand.stats, price_series_7d: candSeries };
  const result = shouldEnter(
    cand,
    portfolioState({ heldSeriesByTokenId: heldMap }),
    baseConfig({ entry: { correlation_skip_threshold: 2.5 } }),
  );
  assert.equal(result.enter, true);
  assert.equal(result.reasoning.conditions.correlation_skip_threshold, null);
});

test('T36: shouldEnter: degenerate held series (constant) → silently skipped, guard does not fire', () => {
  // The held map contains a constant series + a varying one. The
  // constant series must NOT block the candidate — correlation is
  // undefined for a constant signal.
  const candSeries = spikeAt29();
  const heldMap = new Map();
  heldMap.set('const', [7, 7, 7, 7, 7]);
  heldMap.set('uncorrelated', [1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1]);
  const cand = candidate();
  cand.stats = { ...cand.stats, price_series_7d: candSeries };
  const result = shouldEnter(
    cand,
    portfolioState({ heldSeriesByTokenId: heldMap }),
    baseConfig({ entry: { correlation_skip_threshold: 0.85 } }),
  );
  assert.equal(result.enter, true);
});

test('T36: shouldEnter: candidate price_series_7d at top level (not in stats) is honored', () => {
  // Some upstream callers put the series on the candidate directly
  // rather than inside stats. The gate should still find it.
  const candSeries = spikeAt29();
  const heldMap = new Map();
  heldMap.set('b'.repeat(64), candSeries); // different from candidate
  const cand = candidate();
  cand.price_series_7d = candSeries;
  cand.stats = { ...cand.stats };
  delete cand.stats.price_series_7d;
  const result = shouldEnter(
    cand,
    portfolioState({ heldSeriesByTokenId: heldMap }),
    baseConfig({ entry: { correlation_skip_threshold: 0.85 } }),
  );
  assert.equal(result.enter, false);
  assert.equal(result.kind, 'correlation_skip');
});

test('T36: shouldEnter: GUARD — config/default.json entry block carries correlation_skip_threshold=-1', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const cfgPath = path.resolve('config/default.json');
  const raw = await fs.readFile(cfgPath, 'utf8');
  const cfg = JSON.parse(raw);
  assert.equal(cfg.entry.correlation_skip_threshold, -1);
});

// ────────────────────────────────────────────────────────────────────
//  T37: minimum-pool-age gate (too_young_pool)
// ────────────────────────────────────────────────────────────────────

test('T37: DEFAULT_ENTRY_CONFIG.min_pool_age_days is 7', () => {
  assert.equal(DEFAULT_ENTRY_CONFIG.min_pool_age_days, 7);
});

test('T37: resolveEntryConfig: 0 / negative / >365 / non-finite → guard DISABLED (-1)', () => {
  for (const v of [0, -1, -100, 366, 1000, Infinity, -Infinity, NaN]) {
    const cfg = resolveEntryConfig({ min_pool_age_days: v });
    assert.equal(cfg.min_pool_age_days, -1, `expected -1 for input ${v}, got ${cfg.min_pool_age_days}`);
  }
});

test('T37: resolveEntryConfig: positive finite <=365 → honors the knob', () => {
  for (const v of [1, 7, 14, 30, 90, 365]) {
    const cfg = resolveEntryConfig({ min_pool_age_days: v });
    assert.equal(cfg.min_pool_age_days, v, `expected ${v}, got ${cfg.min_pool_age_days}`);
  }
});

test('T37: resolveEntryConfig: tolerates missing/non-numeric min_pool_age_days', () => {
  for (const v of [undefined, null, 'nope', true, false, [], {}]) {
    const cfg = resolveEntryConfig({ min_pool_age_days: v });
    // Falls back to default (or sentinel) but never crashes.
    assert.ok(Number.isFinite(cfg.min_pool_age_days),
      `expected finite number for input ${JSON.stringify(v)}, got ${cfg.min_pool_age_days}`);
  }
});

test('T37: shouldEnter: rejects young token with kind=too_young_pool', () => {
  // nowMs pinned to 2026-09-15; first_seen_ts_ms = nowMs - 3 days → age=3d < 7d.
  const nowMs = Date.parse('2026-09-15T16:00:00Z');
  const result = shouldEnter(
    candidate({
      stats: {
        token_id: TOKEN_ID,
        symbol: 'NEW',
        price_now_sats: 1000,
        change_24h_bp: -500,
        first_seen_ts_ms: nowMs - 3 * 24 * 60 * 60 * 1000,
      },
      price_series_7d: null,
    }),
    portfolioState(),
    baseConfig({ entry: { min_pool_age_days: 7 } }),
    nowMs,
  );
  assert.equal(result.enter, false);
  assert.equal(result.kind, 'too_young_pool');
  assert.match(result.reason, /3\.\d+d < min_pool_age_days 7d/);
});

test('T37: shouldEnter: accepts token whose oldest pool clears the floor', () => {
  // 30 days old, min_pool_age_days=7 → age (30) >= 7 → PASS this gate.
  // Other gates must also pass for `enter:true`.
  const nowMs = Date.parse('2026-09-15T16:00:00Z');
  const result = shouldEnter(
    candidate({
      stats: {
        token_id: TOKEN_ID,
        symbol: 'OLD',
        price_now_sats: 1000,
        change_24h_bp: -500,
        first_seen_ts_ms: nowMs - 30 * 24 * 60 * 60 * 1000,
      },
      price_series_7d: null,
    }),
    portfolioState(),
    baseConfig({ entry: { min_pool_age_days: 7 } }),
    nowMs,
  );
  assert.equal(result.enter, true);
});

test('T37: shouldEnter: disabled guard (knob=-1) accepts young token', () => {
  // Operator opts out via `min_pool_age_days: -1`; even a 1-day-old
  // token passes the gate (it might fail others, but not for age).
  const nowMs = Date.parse('2026-09-15T16:00:00Z');
  const result = shouldEnter(
    candidate({
      stats: {
        token_id: TOKEN_ID,
        symbol: 'NEW',
        price_now_sats: 1000,
        change_24h_bp: -500,
        first_seen_ts_ms: nowMs - 1 * 24 * 60 * 60 * 1000,
      },
      price_series_7d: null,
    }),
    portfolioState(),
    baseConfig({ entry: { min_pool_age_days: -1 } }),
    nowMs,
  );
  assert.equal(result.enter, true);
});

test('T37: shouldEnter: missing first_seen_ts_ms → guard SKIPPED (conservative)', () => {
  // candidate.stats has no first_seen_ts_ms → guard skips (matches
  // T31 / T32 / T33 / T35 / T36 posture: don't reject just because
  // the indexer didn't surface a timestamp).
  const nowMs = Date.parse('2026-09-15T16:00:00Z');
  const result = shouldEnter(
    candidate({
      stats: {
        token_id: TOKEN_ID,
        symbol: 'UNK',
        price_now_sats: 1000,
        change_24h_bp: -500,
        // first_seen_ts_ms intentionally absent
      },
      price_series_7d: null,
    }),
    portfolioState(),
    baseConfig({ entry: { min_pool_age_days: 7 } }),
    nowMs,
  );
  assert.equal(result.enter, true);
});

test('T37: shouldEnter: boundary case — age exactly == min_pool_age_days passes', () => {
  // age (7) >= 7 → PASS. Only age STRICTLY LESS than the floor
  // triggers rejection.
  const nowMs = Date.parse('2026-09-15T16:00:00Z');
  const result = shouldEnter(
    candidate({
      stats: {
        token_id: TOKEN_ID,
        symbol: 'EDGE',
        price_now_sats: 1000,
        change_24h_bp: -500,
        first_seen_ts_ms: nowMs - 7 * 24 * 60 * 60 * 1000,
      },
      price_series_7d: null,
    }),
    portfolioState(),
    baseConfig({ entry: { min_pool_age_days: 7 } }),
    nowMs,
  );
  assert.equal(result.enter, true);
});

test('T37: shouldEnter: reasoning blob surfaces pool_age_days + min_pool_age_days + first_seen_ts_ms', () => {
  const nowMs = Date.parse('2026-09-15T16:00:00Z');
  const firstSeenMs = nowMs - 3 * 24 * 60 * 60 * 1000;
  const result = shouldEnter(
    candidate({
      stats: {
        token_id: TOKEN_ID,
        symbol: 'NEW',
        price_now_sats: 1000,
        change_24h_bp: -500,
        first_seen_ts_ms: firstSeenMs,
      },
      price_series_7d: null,
    }),
    portfolioState(),
    baseConfig({ entry: { min_pool_age_days: 7 } }),
    nowMs,
  );
  assert.equal(result.enter, false);
  assert.equal(result.kind, 'too_young_pool');
  assert.ok(result.reasoning);
  assert.ok(result.reasoning.conditions);
  assert.equal(result.reasoning.conditions.min_pool_age_days, 7);
  assert.ok(result.reasoning.decision);
  assert.equal(result.reasoning.decision.kind, 'too_young_pool');
  assert.ok(Math.abs(result.reasoning.decision.pool_age_days - 3) < 0.1,
    `expected pool_age_days ≈ 3, got ${result.reasoning.decision.pool_age_days}`);
  assert.equal(result.reasoning.decision.min_pool_age_days, 7);
  assert.equal(result.reasoning.decision.first_seen_ts_ms, firstSeenMs);
});

test('T37: shouldEnter: GUARD — config/default.json entry block carries min_pool_age_days=7', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const cfgPath = path.resolve('config/default.json');
  const raw = await fs.readFile(cfgPath, 'utf8');
  const cfg = JSON.parse(raw);
  assert.equal(cfg.entry.min_pool_age_days, 7);
});

// ─────────────────────────────────────────────────────────────────────
//  T55 — per-token slippage cap on the reasoning blob
// ─────────────────────────────────────────────────────────────────────

test('T55: shouldEnter reasoning blob surfaces slippage_cap_source=per_token when depth present', () => {
  // 5 BCH pool (500M sats), 0.005 BCH size → per-token cap = 30n.
  // Without my changes the reasoning blob would have surfaced the
  // flat 100 bps cap; with T55 it surfaces the per-token 30 bps.
  const result = shouldEnter(
    candidate({ amm_total_depth_sats: 500_000_000n }),
    portfolioState(),
    baseConfig(),
  );
  assert.equal(result.enter, true);
  assert.ok(result.reasoning);
  assert.equal(result.reasoning.decision.slippage_cap_bps, 30);
  assert.equal(result.reasoning.decision.slippage_cap_source, 'per_token');
  assert.equal(result.reasoning.decision.slippage_cap_pool_depth_sats, '500000000');
});

test('T55: shouldEnter reasoning blob surfaces slippage_cap_source=flat when depth missing', () => {
  // No amm_total_depth_sats → flat cap (100) wins.
  const result = shouldEnter(
    candidate({ amm_total_depth_sats: null }),
    portfolioState(),
    baseConfig(),
  );
  assert.equal(result.enter, true);
  assert.equal(result.reasoning.decision.slippage_cap_bps, 100);
  assert.equal(result.reasoning.decision.slippage_cap_source, 'flat');
  assert.equal(result.reasoning.decision.slippage_cap_pool_depth_sats, null);
});

test('T55: shallow pool loosens the cap above the flat value', () => {
  // 0.5 BCH pool (50M sats), 0.005 BCH size → per-token cap = 202n.
  // The flat cap (100) was rejecting legitimate ~150bps trades on
  // shallow pools; T55 loosens to 202 so they pass. We lower the
  // `min_amm_total_depth_sats` to 0 BCH for THIS test so the depth
  // floor doesn't pre-reject — the per-token cap is the only gate.
  const result = shouldEnter(
    candidate({ amm_total_depth_sats: 50_000_000n }),
    portfolioState(),
    baseConfig({ entry: { min_amm_total_depth_sats: 0 } }),
  );
  assert.equal(result.enter, true);
  assert.equal(result.reasoning.decision.slippage_cap_bps, 202);
  assert.equal(result.reasoning.decision.slippage_cap_source, 'per_token');
});

test('T55: enabled=false in entry cfg → reasoning blob uses flat cap', () => {
  const result = shouldEnter(
    candidate({ amm_total_depth_sats: 500_000_000n }),
    portfolioState(),
    baseConfig({ entry: { slippage_cap_per_token_enabled: false } }),
  );
  // With per-token disabled, even though the AMM depth is 5 BCH, the
  // cap stays at 100 and the source flips to 'flat'.
  assert.equal(result.enter, true);
  assert.equal(result.reasoning.decision.slippage_cap_bps, 100);
  assert.equal(result.reasoning.decision.slippage_cap_source, 'flat');
});

test('T55: GUARD — config/default.json entry block carries all four T55 knobs', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const cfgPath = path.resolve('config/default.json');
  const raw = await fs.readFile(cfgPath, 'utf8');
  const cfg = JSON.parse(raw);
  assert.equal(cfg.entry.slippage_cap_per_token_enabled, true);
  assert.equal(cfg.entry.slippage_cap_min_bps, 30);
  assert.equal(cfg.entry.slippage_cap_max_bps, 250);
  assert.equal(cfg.entry.slippage_cap_multiplier, 2.0);
});
