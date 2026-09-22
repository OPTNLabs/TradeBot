// tests/positions-dust-close.test.mjs
//
// T87 — Dust-position auto-close pure-math tests.
//
// Coverage targets (every public export exhaustively):
//   - DEFAULT_DUST_CONFIG is frozen + canonical defaults
//   - DUST_CLOSE_REASON is the canonical label
//   - resolveDustConfig: every knob (fallback / override / out-of-range)
//   - computeCloseCostSats: happy / null / zero / negative / oversize / bigint-coercion
//   - isDustPosition: clean / dust-by-fees / dust-by-ratio / exact-breakeven /
//                     prevent_stop_loss / on_chain_sync / missing-price / missing-amount
//   - findDustPositions: empty / single-dust / mixed / null-position / missing-price
//   - buildDustCloseExitBlock: shape / realized-pnl / preserves-token-id / nowMs injection

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_DUST_CONFIG,
  DUST_CLOSE_REASON,
  resolveDustConfig,
  computeCloseCostSats,
  isDustPosition,
  findDustPositions,
  buildDustCloseExitBlock,
  _internals,
} from '../src/positions/dust-close.mjs';

// ─── DEFAULT_DUST_CONFIG ────────────────────────────────────────
test('DEFAULT_DUST_CONFIG: object is frozen', () => {
  assert.equal(Object.isFrozen(DEFAULT_DUST_CONFIG), true);
});

test('DEFAULT_DUST_CONFIG: canonical defaults', () => {
  assert.equal(DEFAULT_DUST_CONFIG.tx_fee_sats, 1500);
  assert.equal(DEFAULT_DUST_CONFIG.slippage_bps, 100);
  assert.equal(DEFAULT_DUST_CONFIG.margin_bps, 50);
  assert.equal(DEFAULT_DUST_CONFIG.budget_multiplier, 1.5);
  assert.equal(DEFAULT_DUST_CONFIG.min_token_amount, null);
});

test('DUST_CLOSE_REASON: canonical label', () => {
  assert.equal(DUST_CLOSE_REASON, 'dust_position_auto_close');
});

// ─── resolveDustConfig ──────────────────────────────────────────
test('resolveDustConfig: null cfg → defaults + applied:all-true', () => {
  const r = resolveDustConfig(null);
  assert.equal(r.ok, true);
  assert.deepEqual(r.config, {
    tx_fee_sats: 1500,
    slippage_bps: 100,
    margin_bps: 50,
    budget_multiplier: 1.5,
    min_token_amount: null,
  });
  assert.deepEqual(r.applied, {
    tx_fee_sats: true,
    slippage_bps: true,
    margin_bps: true,
    budget_multiplier: true,
    min_token_amount: true,
  });
});

test('resolveDustConfig: undefined cfg → defaults', () => {
  const r = resolveDustConfig(undefined);
  assert.equal(r.ok, true);
  assert.equal(r.config.tx_fee_sats, 1500);
});

test('resolveDustConfig: full override → applied:all-false', () => {
  const r = resolveDustConfig({
    risk: {
      dust_position_close_tx_fee_sats: 2500,
      dust_position_close_slippage_bps: 200,
      dust_position_close_margin_bps: 75,
      dust_position_close_budget_multiplier: 2.0,
      dust_position_close_min_token_amount: 100,
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.config.tx_fee_sats, 2500);
  assert.equal(r.config.slippage_bps, 200);
  assert.equal(r.config.margin_bps, 75);
  assert.equal(r.config.budget_multiplier, 2.0);
  assert.equal(r.config.min_token_amount, 100);
  assert.deepEqual(r.applied, {
    tx_fee_sats: false,
    slippage_bps: false,
    margin_bps: false,
    budget_multiplier: false,
    min_token_amount: false,
  });
});

test('resolveDustConfig: opts.risk wins over cfg.risk', () => {
  const r = resolveDustConfig({ risk: { dust_position_close_tx_fee_sats: 5000 } }, { risk: { dust_position_close_tx_fee_sats: 2500 } });
  assert.equal(r.config.tx_fee_sats, 2500);
});

test('resolveDustConfig: out-of-range tx_fee_sats clamps to max', () => {
  const r = resolveDustConfig({ risk: { dust_position_close_tx_fee_sats: 999_999_999 } });
  assert.equal(r.config.tx_fee_sats, 100_000);
});

test('resolveDustConfig: negative tx_fee_sats falls back to default (not clamp-to-min)', () => {
  // Negative is "invalid input" not "out-of-range [0, 100000]";
  // safeNumber returns the fallback rather than clamping to 0.
  // The catalog-side validation already rejects negatives before
  // the runtime config reaches this module.
  const r = resolveDustConfig({ risk: { dust_position_close_tx_fee_sats: -100 } });
  assert.equal(r.config.tx_fee_sats, 1500);
});

test('resolveDustConfig: budget_multiplier clamps to [1.0, 10.0]', () => {
  const lo = resolveDustConfig({ risk: { dust_position_close_budget_multiplier: 0.5 } });
  const hi = resolveDustConfig({ risk: { dust_position_close_budget_multiplier: 100 } });
  assert.equal(lo.config.budget_multiplier, 1.0);
  assert.equal(hi.config.budget_multiplier, 10.0);
});

test('resolveDustConfig: NaN/non-number falls back to default', () => {
  const r = resolveDustConfig({ risk: { dust_position_close_tx_fee_sats: NaN, dust_position_close_slippage_bps: 'bad' } });
  assert.equal(r.config.tx_fee_sats, 1500);
  assert.equal(r.config.slippage_bps, 100);
  assert.equal(r.applied.tx_fee_sats, true);
  assert.equal(r.applied.slippage_bps, true);
});

test('resolveDustConfig: missing risk block → defaults', () => {
  const r = resolveDustConfig({ unrelated: 'yes' });
  assert.equal(r.config.tx_fee_sats, 1500);
});

test('resolveDustConfig: min_token_amount floors to integer', () => {
  const r = resolveDustConfig({ risk: { dust_position_close_min_token_amount: 100.7 } });
  assert.equal(r.config.min_token_amount, 100);
});

test('resolveDustConfig: min_token_amount null → default null', () => {
  const r = resolveDustConfig({ risk: { dust_position_close_min_token_amount: null } });
  assert.equal(r.config.min_token_amount, null);
  assert.equal(r.applied.min_token_amount, true);
});

// ─── _internals.coerceTokenAmountBase ───────────────────────────
test('_internals.coerceTokenAmountBase: number/floor/negative/null', () => {
  const { coerceTokenAmountBase } = _internals;
  assert.equal(coerceTokenAmountBase(100), 100);
  assert.equal(coerceTokenAmountBase(100.9), 100);
  assert.equal(coerceTokenAmountBase('250'), 250);
  assert.equal(coerceTokenAmountBase(' 17 '), 17);
  assert.equal(coerceTokenAmountBase(null), null);
  assert.equal(coerceTokenAmountBase(undefined), null);
  assert.equal(coerceTokenAmountBase(-1), null);
  assert.equal(coerceTokenAmountBase('abc'), null);
  assert.equal(coerceTokenAmountBase(NaN), null);
  assert.equal(coerceTokenAmountBase(Infinity), null);
  assert.equal(coerceTokenAmountBase(0), 0);
  assert.equal(coerceTokenAmountBase({}), null);
  assert.equal(coerceTokenAmountBase([]), null);
});

test('_internals.coerceTokenAmountBase: bigint → number', () => {
  const { coerceTokenAmountBase } = _internals;
  assert.equal(coerceTokenAmountBase(12345n), 12345);
  assert.equal(coerceTokenAmountBase(0n), 0);
});

// ─── _internals.coercePriceSats ─────────────────────────────────
test('_internals.coercePriceSats: number/string/zero/null/negative/NaN', () => {
  const { coercePriceSats } = _internals;
  assert.equal(coercePriceSats(100), 100);
  assert.equal(coercePriceSats('250'), 250);
  assert.equal(coercePriceSats(' 17 '), 17);
  assert.equal(coercePriceSats(0), null, 'zero is treated as no-quote-available (matches dashboard convention)');
  assert.equal(coercePriceSats(null), null);
  assert.equal(coercePriceSats(undefined), null);
  assert.equal(coercePriceSats(-1), null);
  assert.equal(coercePriceSats(NaN), null);
  assert.equal(coercePriceSats(Infinity), null);
  assert.equal(coercePriceSats({}), null);
});

// ─── computeCloseCostSats ───────────────────────────────────────
test('computeCloseCostSats: happy path', () => {
  const r = computeCloseCostSats({
    tokenAmountBase: 1000,
    currentPriceSatsPerBase: 100,
    txFeeSats: 1500,
    slippageBps: 100,
  });
  assert.equal(r.ok, true);
  assert.equal(r.proceeds_sats, 100_000);
  assert.equal(r.slippage_cost_sats, 1_000);  // 100_000 * 100/10_000
  assert.equal(r.tx_fee_sats, 1500);
  assert.equal(r.total_cost_sats, 2_500);
  assert.equal(r.net_recoverable_sats, 97_500);
  assert.equal(r.ratio_cost_to_proceeds, 0.025);
});

test('computeCloseCostSats: string-amount coerces', () => {
  const r = computeCloseCostSats({
    tokenAmountBase: '1000',
    currentPriceSatsPerBase: 100,
  });
  assert.equal(r.ok, true);
  assert.equal(r.proceeds_sats, 100_000);
});

test('computeCloseCostSats: bigint-amount coerces', () => {
  const r = computeCloseCostSats({
    tokenAmountBase: 1000n,
    currentPriceSatsPerBase: 100,
  });
  assert.equal(r.ok, true);
  assert.equal(r.proceeds_sats, 100_000);
});

test('computeCloseCostSats: invalid token amount → ok:false', () => {
  const r = computeCloseCostSats({
    tokenAmountBase: null,
    currentPriceSatsPerBase: 100,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid_token_amount');
  assert.equal(r.tx_fee_sats, 1500);  // default tx fee still surfaces
});

test('computeCloseCostSats: invalid price → ok:false', () => {
  const r = computeCloseCostSats({
    tokenAmountBase: 1000,
    currentPriceSatsPerBase: null,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid_price');
});

test('computeCloseCostSats: zero price → ok:false', () => {
  const r = computeCloseCostSats({
    tokenAmountBase: 1000,
    currentPriceSatsPerBase: 0,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid_price');
});

test('computeCloseCostSats: negative price → ok:false', () => {
  const r = computeCloseCostSats({
    tokenAmountBase: 1000,
    currentPriceSatsPerBase: -5,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid_price');
});

test('computeCloseCostSats: 100% slippage consumes all proceeds', () => {
  const r = computeCloseCostSats({
    tokenAmountBase: 1000,
    currentPriceSatsPerBase: 100,
    txFeeSats: 0,
    slippageBps: 10_000,
  });
  assert.equal(r.ok, true);
  assert.equal(r.net_recoverable_sats, 0);
  assert.equal(r.ratio_cost_to_proceeds, 1);
});

test('computeCloseCostSats: missing opts → uses defaults', () => {
  const r = computeCloseCostSats({
    tokenAmountBase: 1000,
    currentPriceSatsPerBase: 100,
  });
  assert.equal(r.ok, true);
  assert.equal(r.tx_fee_sats, 1500);  // DEFAULT_DUST_CONFIG.tx_fee_sats
  assert.equal(r.slippage_cost_sats, 1_000);  // 100_000 * 100/10_000
});

test('computeCloseCostSats: ratio is Infinity when proceeds=0', () => {
  const r = computeCloseCostSats({
    tokenAmountBase: 1000,
    currentPriceSatsPerBase: 0,
  });
  assert.equal(r.ok, false);
  assert.equal(r.ratio_cost_to_proceeds, Infinity);
});

// ─── isDustPosition ─────────────────────────────────────────────
test('isDustPosition: clean position at healthy price → not dust', () => {
  const p = { id: 'p1', token_id: 'T1', entry: { token_amount_base: 1000, fee_sats: 100 } };
  const r = isDustPosition(p, 100);
  assert.equal(r.is_dust, false);
  assert.equal(r.blocked_reason, null);
  assert.equal(r.current_value_sats, 100_000);
  assert.equal(r.proceeds_sats, 100_000);
});

test('isDustPosition: tiny position → dust by ratio', () => {
  // 10 base units * 100 sats = 1000 sats. total_cost = 1500 + 10 = 1510. 1510 * 1.5 = 2265 > 1000 → dust.
  const p = { id: 'p1', token_id: 'T1', entry: { token_amount_base: 10, fee_sats: 0 } };
  const r = isDustPosition(p, 100);
  assert.equal(r.is_dust, true);
  assert.equal(r.blocked_reason, null);
  assert.deepEqual(r.reasons, [
    'cost_ratio_exceeds_budget:1.5100>=1.5',
  ]);
});

test('isDustPosition: prevent_stop_loss overrides dust detection', () => {
  const p = {
    id: 'p1', token_id: 'T1',
    entry: { token_amount_base: 10, fee_sats: 0 },
    exit_overrides: { prevent_stop_loss: true, profit_target_pct: 10 },
  };
  const r = isDustPosition(p, 100);
  assert.equal(r.is_dust, false);
  assert.equal(r.blocked_reason, 'prevent_stop_loss');
  assert.deepEqual(r.reasons, ['operator_set_prevent_stop_loss']);
});

test('isDustPosition: on-chain-sync source → not evaluated', () => {
  const p = {
    id: 'p1', token_id: 'T1',
    entry: { token_amount_base: 10, fee_sats: 0, source: 'on-chain-sync' },
  };
  const r = isDustPosition(p, 100);
  assert.equal(r.is_dust, false);
  assert.equal(r.blocked_reason, 'on_chain_sync');
});

test('isDustPosition: missing token_amount_base → blocked', () => {
  const p = { id: 'p1', token_id: 'T1', entry: { fee_sats: 100 } };
  const r = isDustPosition(p, 100);
  assert.equal(r.is_dust, false);
  assert.equal(r.blocked_reason, 'invalid_input');
});

test('isDustPosition: missing price → blocked', () => {
  const p = { id: 'p1', token_id: 'T1', entry: { token_amount_base: 1000, fee_sats: 100 } };
  const r = isDustPosition(p, null);
  assert.equal(r.is_dust, false);
  assert.equal(r.blocked_reason, 'invalid_input');
});

test('isDustPosition: exact breakeven → not dust (strict less-than)', () => {
  // 1000 base * X sats = N. Need total_cost * 1.5 == N. total_cost = 1500 + N*100/10_000.
  // Solve: N = 1.5 * (1500 + N * 0.01). N - 0.015*N = 2250. N = 2250 / 0.985 ≈ 2284.26
  // That's not exactly achievable with integers. Use a clean exact: pick a price that puts it AT
  // the budget threshold. Easiest is to use cfg.budget_multiplier=1.0 + total_cost == proceeds.
  // We construct manually:
  const p = { id: 'p1', token_id: 'T1', entry: { token_amount_base: 1000, fee_sats: 0 } };
  // Use cfg with budget_multiplier=1.0 + slippageBps=0 + txFeeSats=1500 → total_cost=1500.
  // Pick a price so proceeds_sats = 1500 → price=1.5 sats.
  const r = isDustPosition(p, 1.5, { config: { tx_fee_sats: 1500, slippage_bps: 0, margin_bps: 0, budget_multiplier: 1.0, min_token_amount: null } });
  assert.equal(r.is_dust, false, 'exact breakeven with multiplier=1 must not be dust');
});

test('isDustPosition: min_token_amount config fires independently', () => {
  const cfg = {
    tx_fee_sats: 1500, slippage_bps: 100, margin_bps: 50,
    budget_multiplier: 1.5, min_token_amount: 100_000,
  };
  const p = { id: 'p1', token_id: 'T1', entry: { token_amount_base: 99_999, fee_sats: 0 } };
  const r = isDustPosition(p, 1000, { config: cfg });
  assert.equal(r.is_dust, true);
  assert.ok(r.reasons.some((s) => s.startsWith('token_amount_below_min:')));
});

test('isDustPosition: null position → invalid_input', () => {
  const r = isDustPosition(null, 100);
  assert.equal(r.is_dust, false);
  assert.equal(r.blocked_reason, 'invalid_input');
});

test('isDustPosition: string token_amount_base coerces', () => {
  const p = { id: 'p1', token_id: 'T1', entry: { token_amount_base: '10', fee_sats: 0 } };
  const r = isDustPosition(p, 100);
  assert.equal(r.is_dust, true);
});

test('isDustPosition: budget_threshold_sats is computed correctly', () => {
  const cfg = {
    tx_fee_sats: 1000, slippage_bps: 100, margin_bps: 0,
    budget_multiplier: 2.0, min_token_amount: null,
  };
  const p = { id: 'p1', token_id: 'T1', entry: { token_amount_base: 1000, fee_sats: 0 } };
  const r = isDustPosition(p, 100, { config: cfg });
  // proceeds = 100_000, slippage = 1_000, total_cost = 2_000, threshold = 4_000. 100_000 > 4_000 → not dust.
  assert.equal(r.is_dust, false);
  assert.equal(r.total_cost_sats, 2_000);
  assert.equal(r.budget_threshold_sats, 4_000);
});

// ─── findDustPositions ──────────────────────────────────────────
test('findDustPositions: empty array → empty result', () => {
  assert.deepEqual(findDustPositions([], {}), []);
});

test('findDustPositions: null positions → empty result', () => {
  assert.deepEqual(findDustPositions(null, {}), []);
});

test('findDustPositions: single dust position', () => {
  const positions = [
    { id: 'p1', token_id: 'TOKEN_LOWER', entry: { token_amount_base: 10, fee_sats: 0 } },
  ];
  const priceIndex = { token_lower: 100 };
  const r = findDustPositions(positions, priceIndex);
  assert.equal(r.length, 1);
  assert.equal(r[0].position.id, 'p1');
  assert.equal(r[0].skipped, undefined);
  assert.equal(r[0].dust_info.is_dust, true);
});

test('findDustPositions: mixed dust + clean', () => {
  const positions = [
    { id: 'p_dust', token_id: 'T_DUST', entry: { token_amount_base: 10, fee_sats: 0 } },
    { id: 'p_clean', token_id: 'T_CLEAN', entry: { token_amount_base: 10000, fee_sats: 0 } },
  ];
  const priceIndex = { t_dust: 100, t_clean: 100 };
  const r = findDustPositions(positions, priceIndex);
  assert.equal(r.length, 1);
  assert.equal(r[0].position.id, 'p_dust');
});

test('findDustPositions: missing price in index → skipped:true', () => {
  const positions = [
    { id: 'p1', token_id: 'T_NO_PRICE', entry: { token_amount_base: 10, fee_sats: 0 } },
  ];
  const r = findDustPositions(positions, {});
  assert.equal(r.length, 1);
  assert.equal(r[0].skipped, true);
  assert.equal(r[0].skip_reason, 'no_price_in_index');
});

test('findDustPositions: prevent_stop_loss blocks dust detection', () => {
  const positions = [
    { id: 'p1', token_id: 'T1', entry: { token_amount_base: 10, fee_sats: 0 },
      exit_overrides: { prevent_stop_loss: true, profit_target_pct: 10 } },
  ];
  const r = findDustPositions(positions, { t1: 100 });
  assert.equal(r.length, 0, 'prevent_stop_loss position is filtered out, not surfaced as dust');
});

test('findDustPositions: nulls/garbage in array skipped silently', () => {
  const positions = [
    null, undefined, 'string', 42,
    { id: 'p1', token_id: 'T1', entry: { token_amount_base: 10, fee_sats: 0 } },
  ];
  const r = findDustPositions(positions, { t1: 100 });
  assert.equal(r.length, 1);
  assert.equal(r[0].position.id, 'p1');
});

test('findDustPositions: empty price index → all skipped', () => {
  const positions = [
    { id: 'p1', token_id: 'T1', entry: { token_amount_base: 10, fee_sats: 0 } },
    { id: 'p2', token_id: 'T2', entry: { token_amount_base: 20, fee_sats: 0 } },
  ];
  const r = findDustPositions(positions, null);
  assert.equal(r.length, 2);
  assert.ok(r.every((entry) => entry.skipped === true));
});

// ─── buildDustCloseExitBlock ────────────────────────────────────
test('buildDustCloseExitBlock: shape contract', () => {
  const p = {
    id: 'p1', token_id: 'T1',
    entry: { token_amount_base: 10, fee_sats: 500 },
  };
  const dust = {
    is_dust: true,
    total_cost_sats: 1510,
    blocked_reason: null,
    reasons: ['cost_ratio_exceeds_budget:1.5100>=1.5'],
    proceeds_sats: 1000,
    slippage_cost_sats: 10,
    tx_fee_sats: 1500,
    net_recoverable_sats: -510,
    ratio_cost_to_proceeds: 1.51,
    budget_threshold_sats: 2265,
    current_value_sats: 1000,
  };
  const exit = buildDustCloseExitBlock(p, dust, { nowMs: 1_700_000_000_000 });
  assert.equal(exit.txid, '');
  assert.equal(exit.bch_received_sats, 0);
  assert.equal(exit.fee_sats, 1510);
  assert.equal(exit.ts, '2023-11-14T22:13:20.000Z');
  assert.equal(exit.reason, DUST_CLOSE_REASON);
  // realized = -1 * (500 + 1510) = -2010
  assert.equal(exit.realized_pnl_sats, -2010);
});

test('buildDustCloseExitBlock: missing entry fee_sats → 0', () => {
  const p = { id: 'p1', token_id: 'T1', entry: { token_amount_base: 10 } };
  const dust = {
    total_cost_sats: 1500,
    net_recoverable_sats: -1500,
    proceeds_sats: 0,
    slippage_cost_sats: 0,
    tx_fee_sats: 1500,
    ratio_cost_to_proceeds: Infinity,
    budget_threshold_sats: 2250,
    current_value_sats: 0,
    is_dust: true,
    blocked_reason: null,
    reasons: [],
  };
  const exit = buildDustCloseExitBlock(p, dust, { nowMs: 1_700_000_000_000 });
  assert.equal(exit.realized_pnl_sats, -1500);
  assert.equal(exit.fee_sats, 1500);
});

test('buildDustCloseExitBlock: missing dust_info.total_cost_sats → fee_sats:0', () => {
  const p = { id: 'p1', token_id: 'T1', entry: { token_amount_base: 10, fee_sats: 100 } };
  const exit = buildDustCloseExitBlock(p, null, { nowMs: 1_700_000_000_000 });
  assert.equal(exit.fee_sats, 0);
  assert.equal(exit.realized_pnl_sats, -100);
  assert.equal(exit.reason, DUST_CLOSE_REASON);
});

test('buildDustCloseExitBlock: nowMs injection produces deterministic ts', () => {
  const p = { id: 'p1', token_id: 'T1', entry: { token_amount_base: 10, fee_sats: 100 } };
  const dust = { total_cost_sats: 1500 };
  const exit = buildDustCloseExitBlock(p, dust, { nowMs: 1_700_000_000_000 });
  assert.equal(exit.ts, '2023-11-14T22:13:20.000Z');
});

test('buildDustCloseExitBlock: fractional fee_sats rounds to int', () => {
  const p = { id: 'p1', token_id: 'T1', entry: { token_amount_base: 10, fee_sats: 100 } };
  const dust = { total_cost_sats: 1500.6 };
  const exit = buildDustCloseExitBlock(p, dust, { nowMs: 1_700_000_000_000 });
  assert.equal(exit.fee_sats, 1501);
});
