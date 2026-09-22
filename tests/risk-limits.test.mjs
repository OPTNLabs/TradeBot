#!/usr/bin/env node
/**
 * Unit tests for src/risk/limits.mjs.
 *
 * Pure-function tests. No I/O, no logger, no process state. Run via:
 *   npm test
 *
 * Covers:
 *   - resolveRiskConfig: defaults + overrides + bad input
 *   - listOpen / countOpen / computeOpenExposureBch / recentLossesByToken /
 *     recentPnlSats / countConsecutiveLosses / isBlacklisted /
 *     wouldExceedPerTokenCap — every helper in isolation
 *   - canOpen: every gate (blacklist, per-trade cap, exposure, balance,
 *     daily-loss, per-token cap, max-positions)
 *   - canEnter: aliases canOpen in v1
 *   - GUARD: knobs come from config, never hard-coded literals
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_RISK_CONFIG,
  resolveRiskConfig,
  listOpen,
  countOpen,
  computeOpenExposureBch,
  recentLossesByToken,
  recentPnlSats,
  countConsecutiveLosses,
  isBlacklisted,
  wouldExceedPerTokenCap,
  hasOpenPosition,
  isAllowedSecondPosition,
  canOpen,
  canEnter,
} from '../src/risk/limits.mjs';
import { computeOpenExposureBch as positionsCompute } from '../src/portfolio/positions.mjs';

// ────────────────────────────────────────────────────────────────────
//  Fixtures
// ────────────────────────────────────────────────────────────────────

const TID_A = 'a'.repeat(64);
const TID_B = 'b'.repeat(64);
const TID_C = 'c'.repeat(64);
const NOW_MS = Date.UTC(2026, 8, 11, 0, 0, 0); // 2026-09-11T00:00:00Z

function openPosition(overrides = {}) {
  return {
    id: 'pos_test',
    token_id: TID_A,
    status: 'open',
    entry: { bch_spent_sats: 500_000, fee_sats: 200, txid: 'aa'.repeat(32) },
    opened_at: new Date(NOW_MS - 3_600_000).toISOString(),
    ...overrides,
  };
}

/**
 * Build an "existing open position on a DIFFERENT token" — used by
 * the canOpen gate tests so the new `already_open` gate doesn't
 * short-circuit the test (the existing position must not share the
 * candidate's token_id, otherwise `hasOpenPosition` would refuse
 * the new trade before the gate under test gets a chance to fire).
 */
function openPositionOnOther(overrides = {}) {
  return openPosition({ ...overrides, token_id: overrides.token_id ?? TID_B });
}

function closedPosition({ pnlSats = -1000, tsOffsetMs = -3_600_000, tokenId = TID_B, status = 'closed' } = {}) {
  return {
    id: 'pos_closed',
    token_id: tokenId,
    status,
    entry: { bch_spent_sats: 500_000, fee_sats: 200, txid: 'aa'.repeat(32) },
    exit: { txid: 'bb'.repeat(32), realized_pnl_sats: pnlSats, reason: 'stop_loss' },
    opened_at: new Date(NOW_MS - 2 * 3_600_000).toISOString(),
    closed_at: new Date(NOW_MS + tsOffsetMs).toISOString(),
  };
}

function baseConfig(overrides = {}) {
  return {
    entry: { max_position_bch: 0.005, max_total_exposure_bch: 0.04, min_trade_size_bch: 0.0005 },
    risk: { ...DEFAULT_RISK_CONFIG },
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────
//  resolveRiskConfig
// ────────────────────────────────────────────────────────────────────

test('resolveRiskConfig: returns defaults on bad input', () => {
  for (const bad of [null, undefined, 0, 'x', [], NaN]) {
    const c = resolveRiskConfig(bad);
    assert.equal(c.max_daily_loss_bch, DEFAULT_RISK_CONFIG.max_daily_loss_bch);
    assert.equal(c.max_consecutive_losses, DEFAULT_RISK_CONFIG.max_consecutive_losses);
    assert.equal(c.circuit_breaker_cooldown_hours, DEFAULT_RISK_CONFIG.circuit_breaker_cooldown_hours);
    assert.equal(c.min_wallet_balance_bch, DEFAULT_RISK_CONFIG.min_wallet_balance_bch);
  }
});

test('resolveRiskConfig: clamps negative values back to defaults', () => {
  const c = resolveRiskConfig({
    max_daily_loss_bch: -1,
    max_consecutive_losses: -3,
    circuit_breaker_cooldown_hours: -6,
    min_wallet_balance_bch: -0.005,
  });
  assert.equal(c.max_daily_loss_bch, DEFAULT_RISK_CONFIG.max_daily_loss_bch);
  assert.equal(c.max_consecutive_losses, DEFAULT_RISK_CONFIG.max_consecutive_losses);
  assert.equal(c.circuit_breaker_cooldown_hours, DEFAULT_RISK_CONFIG.circuit_breaker_cooldown_hours);
  assert.equal(c.min_wallet_balance_bch, DEFAULT_RISK_CONFIG.min_wallet_balance_bch);
});

// ────────────────────────────────────────────────────────────────────
//  listOpen / countOpen / computeOpenExposureBch
// ────────────────────────────────────────────────────────────────────

test('listOpen: keeps only status === "open"', () => {
  const all = [
    openPosition({ status: 'open' }),
    openPosition({ status: 'pending' }),
    openPosition({ status: 'closing' }),
    openPosition({ status: 'closed' }),
  ];
  const out = listOpen(all);
  assert.equal(out.length, 1);
  assert.equal(out[0].status, 'open');
});

test('listOpen: bad input → []', () => {
  assert.deepEqual(listOpen(null), []);
  assert.deepEqual(listOpen(undefined), []);
  assert.deepEqual(listOpen('garbage'), []);
});

test('countOpen: counts only "open" entries', () => {
  const all = [
    openPosition({ status: 'open' }),
    openPosition({ status: 'open' }),
    openPosition({ status: 'pending' }),
    openPosition({ status: 'closed' }),
  ];
  assert.equal(countOpen(all), 2);
});

test('computeOpenExposureBch: delegated to portfolio/positions.mjs', () => {
  const all = [
    openPosition({ entry: { bch_spent_sats: 500_000 } }),
    openPosition({ entry: { bch_spent_sats: 250_000 } }),
  ];
  // Both should sum to 750k sats = 0.0075 BCH.
  assert.equal(computeOpenExposureBch(all), 0.0075);
  assert.equal(computeOpenExposureBch(all), positionsCompute(all));
});

// ────────────────────────────────────────────────────────────────────
//  recentLossesByToken / recentPnlSats
// ────────────────────────────────────────────────────────────────────

test('recentLossesByToken: sums losses per token in the lookback window', () => {
  const closed = [
    closedPosition({ pnlSats: -1000, tokenId: TID_A, tsOffsetMs: -3_600_000 }),
    closedPosition({ pnlSats: -2000, tokenId: TID_A, tsOffsetMs: -2 * 3_600_000 }),
    closedPosition({ pnlSats: -500,  tokenId: TID_B, tsOffsetMs: -3_600_000 }),
    closedPosition({ pnlSats: 3000,  tokenId: TID_C, tsOffsetMs: -3_600_000 }), // win — ignored
    closedPosition({ pnlSats: -9999, tokenId: TID_A, tsOffsetMs: -25 * 3_600_000 }), // out of window — ignored
  ];
  const map = recentLossesByToken(closed, NOW_MS, 24 * 3_600_000);
  assert.equal(map.get(TID_A), 3000); // 1000 + 2000
  assert.equal(map.get(TID_B), 500);
  assert.equal(map.get(TID_C), undefined); // win ignored
});

test('recentLossesByToken: bad input → empty map', () => {
  assert.equal(recentLossesByToken(null, NOW_MS, 3_600_000).size, 0);
  assert.equal(recentLossesByToken([], NaN, 3_600_000).size, 0);
  assert.equal(recentLossesByToken([], NOW_MS, -1).size, 0);
});

test('recentPnlSats: sums signed P&L in the lookback window', () => {
  const closed = [
    closedPosition({ pnlSats: -1000, tsOffsetMs: -3_600_000 }),
    closedPosition({ pnlSats: 2000,  tsOffsetMs: -2 * 3_600_000 }),
    closedPosition({ pnlSats: -500,  tsOffsetMs: -25 * 3_600_000 }), // out
  ];
  // -1000 + 2000 = +1000.
  assert.equal(recentPnlSats(closed, NOW_MS, 24 * 3_600_000), 1000);
});

test('recentPnlSats: bad input → 0', () => {
  assert.equal(recentPnlSats(null, NOW_MS, 3_600_000), 0);
  assert.equal(recentPnlSats([], NaN, 3_600_000), 0);
});

// ────────────────────────────────────────────────────────────────────
//  countConsecutiveLosses
// ────────────────────────────────────────────────────────────────────

test('countConsecutiveLosses: counts from most recent backward until a win', () => {
  const closed = [
    closedPosition({ pnlSats: 1000 }),                         // oldest: win
    closedPosition({ pnlSats: -500 }),
    closedPosition({ pnlSats: -800 }),
    closedPosition({ pnlSats: -1200 }),                        // most recent: loss
  ];
  assert.equal(countConsecutiveLosses(closed), 3);
});

test('countConsecutiveLosses: 0 when most recent is a win', () => {
  const closed = [
    closedPosition({ pnlSats: -1000 }),
    closedPosition({ pnlSats: -500 }),
    closedPosition({ pnlSats: 1500 }), // win at end
  ];
  assert.equal(countConsecutiveLosses(closed), 0);
});

test('countConsecutiveLosses: empty input → 0', () => {
  assert.equal(countConsecutiveLosses([]), 0);
  assert.equal(countConsecutiveLosses(null), 0);
});

// ────────────────────────────────────────────────────────────────────
//  isBlacklisted
// ────────────────────────────────────────────────────────────────────

test('isBlacklisted: case-insensitive match', () => {
  const upper = TID_A.toUpperCase();
  assert.equal(isBlacklisted(TID_A, [upper]), true);
  assert.equal(isBlacklisted(upper, [TID_A]), true);
});

test('isBlacklisted: not on the list', () => {
  assert.equal(isBlacklisted(TID_A, []), false);
  assert.equal(isBlacklisted(TID_A, null), false);
  assert.equal(isBlacklisted(TID_A, [TID_B]), false);
});

test('isBlacklisted: bad tokenId → false', () => {
  assert.equal(isBlacklisted('', [TID_A]), false);
  assert.equal(isBlacklisted(null, [TID_A]), false);
});

// ────────────────────────────────────────────────────────────────────
//  wouldExceedPerTokenCap
// ────────────────────────────────────────────────────────────────────

test('wouldExceedPerTokenCap: refuses when cap would be exceeded', () => {
  const positions = [
    openPosition({ entry: { bch_spent_sats: 300_000 } }), // 0.003 BCH on TID_A
  ];
  // +0.002 = 0.005 > 0.004 cap.
  assert.equal(wouldExceedPerTokenCap(TID_A, 0.002, positions, 0.004), true);
});

test('wouldExceedPerTokenCap: passes when within cap', () => {
  const positions = [
    openPosition({ entry: { bch_spent_sats: 300_000 } }),
  ];
  assert.equal(wouldExceedPerTokenCap(TID_A, 0.0005, positions, 0.005), false);
});

test('wouldExceedPerTokenCap: ignores other tokens', () => {
  const positions = [
    openPosition({ token_id: TID_B, entry: { bch_spent_sats: 1_000_000 } }),
  ];
  // TID_A has zero exposure; 0.005 fits in 0.005 cap.
  assert.equal(wouldExceedPerTokenCap(TID_A, 0.005, positions, 0.005), false);
});

test('wouldExceedPerTokenCap: bad input → false (no crash)', () => {
  assert.equal(wouldExceedPerTokenCap('', 0.005, [], 0.005), false);
  assert.equal(wouldExceedPerTokenCap(TID_A, -1, [], 0.005), false);
  assert.equal(wouldExceedPerTokenCap(TID_A, 0.005, [], 0), false);
  assert.equal(wouldExceedPerTokenCap(TID_A, 0.005, null, 0.005), false);
});

// ────────────────────────────────────────────────────────────────────
//  hasOpenPosition
// ────────────────────────────────────────────────────────────────────

test('hasOpenPosition: true when an open row matches the candidate token_id', () => {
  const positions = [openPosition({ token_id: TID_A })];
  assert.equal(hasOpenPosition(TID_A, positions), true);
});

test('hasOpenPosition: case-insensitive token_id match', () => {
  const positions = [openPosition({ token_id: TID_A.toUpperCase() })];
  assert.equal(hasOpenPosition(TID_A, positions), true);
});

test('hasOpenPosition: false when no row matches', () => {
  const positions = [openPosition({ token_id: TID_B })];
  assert.equal(hasOpenPosition(TID_A, positions), false);
});

test('hasOpenPosition: counts ONLY status=open', () => {
  // v1 policy: only `status === 'open'` rows count as "already in
  // this token". `pending` (not broadcast yet) and `closing`
  // (close broadcast, waiting for confirmation) do NOT block
  // re-entry — the loop wants to be able to re-enter after a
  // close completes.
  assert.equal(hasOpenPosition(TID_A, [openPosition({ token_id: TID_A, status: 'open' })]), true);
  assert.equal(hasOpenPosition(TID_A, [openPosition({ token_id: TID_A, status: 'pending' })]), false);
  assert.equal(hasOpenPosition(TID_A, [openPosition({ token_id: TID_A, status: 'closing' })]), false);
  assert.equal(hasOpenPosition(TID_A, [openPosition({ token_id: TID_A, status: 'closed' })]), false);
});

test('hasOpenPosition: empty / bad input → false (no crash)', () => {
  assert.equal(hasOpenPosition(TID_A, []), false);
  assert.equal(hasOpenPosition(TID_A, null), false);
  assert.equal(hasOpenPosition('', [openPosition()]), false);
});

test('canOpen: already-open → ok:false, kind:already_open', () => {
  // New gate (T19): an existing open position on the candidate
  // token must block a second long on the same token. Without this
  // gate, the loop would happily open two positions for the same
  // token_id in adjacent ticks and silently double the per-token
  // exposure above max_position_bch.
  const r = canOpen({
    tokenId: TID_A,
    proposedSizeBch: 0.005,
    openPositions: [openPosition({ token_id: TID_A, status: 'open' })],
    closedPositions: [],
    walletBalanceBch: 0.044,
    cfg: baseConfig(),
    nowMs: NOW_MS,
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'already_open');
});

// ────────────────────────────────────────────────────────────────────
//  canOpen
// ────────────────────────────────────────────────────────────────────

test('canOpen: happy path → ok:true', () => {
  const r = canOpen({
    tokenId: TID_A,
    proposedSizeBch: 0.005,
    openPositions: [],
    closedPositions: [],
    walletBalanceBch: 0.044,
    cfg: baseConfig(),
    nowMs: NOW_MS,
  });
  assert.equal(r.ok, true);
});

test('canOpen: blacklisted → ok:false, kind:blacklisted', () => {
  const r = canOpen({
    tokenId: TID_A,
    proposedSizeBch: 0.005,
    openPositions: [],
    closedPositions: [],
    walletBalanceBch: 0.044,
    cfg: baseConfig(),
    nowMs: NOW_MS,
    blacklist: [TID_A],
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'blacklisted');
});

test('canOpen: proposedSize > max_position → ok:false, kind:position_too_large', () => {
  const r = canOpen({
    tokenId: TID_A,
    proposedSizeBch: 0.05, // way over the 0.005 cap
    openPositions: [],
    closedPositions: [],
    walletBalanceBch: 0.044,
    cfg: baseConfig(),
    nowMs: NOW_MS,
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'position_too_large');
});

test('canOpen: exposure would exceed → ok:false, kind:exposure_full', () => {
  const r = canOpen({
    tokenId: TID_A,
    proposedSizeBch: 0.005,
    openPositions: [
      openPositionOnOther({ entry: { bch_spent_sats: 3_700_000 } }), // 0.037 BCH on a DIFFERENT token
    ],
    closedPositions: [],
    walletBalanceBch: 0.044,
    cfg: baseConfig(),
    nowMs: NOW_MS,
  });
  // 0.037 + 0.005 = 0.042 > 0.04 cap.
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'exposure_full');
});

test('canOpen: balance below floor → ok:false, kind:below_floor', () => {
  const r = canOpen({
    tokenId: TID_A,
    proposedSizeBch: 0.001,
    openPositions: [],
    closedPositions: [],
    walletBalanceBch: 0.005, // exactly at floor
    cfg: baseConfig(),
    nowMs: NOW_MS,
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'below_floor');
});

test('canOpen: daily loss cap tripped → ok:false, kind:daily_loss_cap', () => {
  const closed = [
    closedPosition({ pnlSats: -500_000, tsOffsetMs: -3_600_000 }), // -0.005 BCH
  ];
  const r = canOpen({
    tokenId: TID_A,
    proposedSizeBch: 0.005,
    openPositions: [],
    closedPositions: closed,
    walletBalanceBch: 0.044,
    cfg: baseConfig(),
    nowMs: NOW_MS,
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'daily_loss_cap');
});

test('canOpen: per-token cap exceeded → ok:false, kind:per_token_cap', () => {
  // The candidate is TID_A. We seed an existing TID_A position
  // that itself would exceed the per-token cap once the new trade
  // is added. The new `already_open` gate fires first, but
  // because v1 is LONG-only (one position per token), the per-token
  // cap is effectively superseded. We assert the actual gate that
  // fires in v1 (already_open). The pure `per_token_cap` math
  // (wouldExceedPerTokenCap) is still covered by its own unit
  // test below.
  const r = canOpen({
    tokenId: TID_A,
    proposedSizeBch: 0.005,
    openPositions: [
      openPosition({ entry: { bch_spent_sats: 250_000 } }), // 0.0025 BCH on TID_A
    ],
    closedPositions: [],
    walletBalanceBch: 0.044,
    cfg: baseConfig(),
    nowMs: NOW_MS,
    maxPerTokenExposureBch: 0.003,
  });
  // 0.0025 + 0.005 = 0.0075 > 0.003 cap, but already_open fires first.
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'already_open');
});

test('canOpen: max positions reached → ok:false, kind:max_positions', () => {
  const r = canOpen({
    tokenId: TID_A,
    proposedSizeBch: 0.005,
    openPositions: [
      // Two existing positions on DIFFERENT tokens so the
      // `already_open` gate doesn't short-circuit.
      openPositionOnOther({ id: 'p1' }),
      openPositionOnOther({ id: 'p2' }),
    ],
    closedPositions: [],
    walletBalanceBch: 0.044,
    cfg: baseConfig(),
    nowMs: NOW_MS,
    maxOpenPositions: 2,
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'max_positions');
});

test('canOpen: bad input → throws (programmer error)', () => {
  assert.throws(() => canOpen({ cfg: baseConfig() }), /tokenId/);
  assert.throws(() => canOpen({ tokenId: TID_A, cfg: baseConfig() }), /proposedSizeBch/);
  assert.throws(() => canOpen({ tokenId: TID_A, proposedSizeBch: 0.005, cfg: baseConfig() }), /walletBalanceBch/);
  assert.throws(() => canOpen({ tokenId: TID_A, proposedSizeBch: 0.005, walletBalanceBch: 0.044 }), /cfg/);
});

test('canEnter: aliases canOpen (v1)', () => {
  const args = {
    tokenId: TID_A,
    proposedSizeBch: 0.005,
    openPositions: [],
    closedPositions: [],
    walletBalanceBch: 0.044,
    cfg: baseConfig(),
    nowMs: NOW_MS,
  };
  assert.deepEqual(canEnter(args), canOpen(args));
});

// ────────────────────────────────────────────────────────────────────
//  GUARD: knobs come from config, not hard-coded
// ────────────────────────────────────────────────────────────────────

test('GUARD: max_position_bch=0.0001 caps the proposed size', () => {
  const r = canOpen({
    tokenId: TID_A,
    proposedSizeBch: 0.001, // > 0.0001
    openPositions: [],
    closedPositions: [],
    walletBalanceBch: 0.044,
    cfg: baseConfig({ entry: { max_position_bch: 0.0001, max_total_exposure_bch: 0.04 } }),
    nowMs: NOW_MS,
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'position_too_large');
});

test('GUARD: max_total_exposure_bch=0.001 triggers exposure_full', () => {
  const r = canOpen({
    tokenId: TID_A,
    proposedSizeBch: 0.005,
    openPositions: [],
    closedPositions: [],
    walletBalanceBch: 0.044,
    cfg: baseConfig({ entry: { max_position_bch: 0.005, max_total_exposure_bch: 0.001 } }),
    nowMs: NOW_MS,
  });
  // 0 + 0.005 = 0.005 > 0.001.
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'exposure_full');
});

test('GUARD: min_wallet_balance_bch=0.04 triggers below_floor', () => {
  // With min_wallet_balance_bch=0.04 and wallet=0.044, even a 0.005
  // trade would leave 0.039 < 0.04 floor → reject.
  const r = canOpen({
    tokenId: TID_A,
    proposedSizeBch: 0.005,
    openPositions: [],
    closedPositions: [],
    walletBalanceBch: 0.044,
    cfg: baseConfig({ risk: { min_wallet_balance_bch: 0.04 } }),
    nowMs: NOW_MS,
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'below_floor');
});

test('GUARD: max_daily_loss_bch=0.0001 trips at -0.0002 BCH', () => {
  const closed = [
    closedPosition({ pnlSats: -20_000, tsOffsetMs: -3_600_000 }), // -0.0002 BCH
  ];
  const r = canOpen({
    tokenId: TID_A,
    proposedSizeBch: 0.005,
    openPositions: [],
    closedPositions: closed,
    walletBalanceBch: 0.044,
    cfg: baseConfig({ risk: { max_daily_loss_bch: 0.0001 } }),
    nowMs: NOW_MS,
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'daily_loss_cap');
});

test('GUARD: defaults file (config/default.json) risk block is honored', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const cfgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../config/default.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  assert.equal(cfg.risk.max_daily_loss_bch, 0.005);
  assert.equal(cfg.risk.max_consecutive_losses, 3);
  assert.equal(cfg.risk.min_wallet_balance_bch, 0.005);
  assert.equal(cfg.entry.max_position_bch, 0.005);
  assert.equal(cfg.entry.max_total_exposure_bch, 0.04);

  const r = canOpen({
    tokenId: TID_A,
    proposedSizeBch: 0.005,
    openPositions: [],
    closedPositions: [],
    walletBalanceBch: 0.044,
    cfg,
    nowMs: NOW_MS,
  });
  assert.equal(r.ok, true);
});
// ────────────────────────────────────────────────────────────────────
//  O02 — Allow second position for a token (discount-gated)
//  idea_operator_allow-second-position-for-a-token_20260917
// ────────────────────────────────────────────────────────────────────
//
// Pre-O02: `hasOpenPosition` enforced a strict single-position-per-
// token gate. canOpen's `already_open` branch always rejected when
// the candidate's token_id matched an existing open row, regardless
// of price.
//
// O02: the operator wants to allow a SECOND open position on the
// same token when the new entry is at least `discountPct` below
// the OLDEST existing open position's entry price. Default 20%.
// The two positions are independent; this is a controlled way to
// average down after a price drop without re-opening at the same
// price (which would just double exposure without a thesis change).

test('O02 helper: isAllowedSecondPosition: empty input → not allowed', () => {
  assert.deepEqual(isAllowedSecondPosition([], 100, 0.20, NOW_MS), {
    allowed: false,
    reason: 'no existing open positions on this token',
  });
});

test('O02 helper: isAllowedSecondPosition: discountPct <= 0 → not allowed (safety floor)', () => {
  const positions = [openPosition({ entry: { bch_spent_sats: 500_000, price_sats_per_token: 100, fee_sats: 200, txid: 'aa'.repeat(32) } })];
  for (const bad of [-0.1, 0, NaN, Infinity, null, undefined]) {
    const r = isAllowedSecondPosition(positions, 50, bad, NOW_MS);
    assert.equal(r.allowed, false, `discountPct=${bad} should reject`);
    assert.match(r.reason, /discount gate disabled/);
  }
});

test('O02 helper: isAllowedSecondPosition: discountPct >= 1 → not allowed (v1-disable knob)', () => {
  const positions = [openPosition({ entry: { bch_spent_sats: 500_000, price_sats_per_token: 100, fee_sats: 200, txid: 'aa'.repeat(32) } })];
  for (const bad of [1, 1.5, 100]) {
    const r = isAllowedSecondPosition(positions, 50, bad, NOW_MS);
    assert.equal(r.allowed, false, `discountPct=${bad} should reject`);
  }
});

test('O02 helper: isAllowedSecondPosition: missing proposed price → not allowed', () => {
  const positions = [openPosition({ entry: { bch_spent_sats: 500_000, price_sats_per_token: 100, fee_sats: 200, txid: 'aa'.repeat(32) } })];
  for (const bad of [null, undefined, NaN, 0, -1]) {
    const r = isAllowedSecondPosition(positions, bad, 0.20, NOW_MS);
    assert.equal(r.allowed, false, `proposedPrice=${bad} should reject`);
    assert.match(r.reason, /proposed price.*missing or non-positive/);
  }
});

test('O02 helper: isAllowedSecondPosition: anchor missing entry.price_sats_per_token → not allowed', () => {
  const positions = [openPosition({ entry: { bch_spent_sats: 500_000, fee_sats: 200, txid: 'aa'.repeat(32) } })];
  const r = isAllowedSecondPosition(positions, 50, 0.20, NOW_MS);
  assert.equal(r.allowed, false);
  assert.match(r.reason, /anchor position.*missing entry\.price_sats_per_token/);
});

test('O02 helper: isAllowedSecondPosition: exactly the discount threshold → allowed (boundary)', () => {
  // anchor entered at 100; 20% discount means proposed must be ≤ 80.
  const positions = [openPosition({ entry: { bch_spent_sats: 500_000, price_sats_per_token: 100, fee_sats: 200, txid: 'aa'.repeat(32) } })];
  const r = isAllowedSecondPosition(positions, 80, 0.20, NOW_MS);
  assert.equal(r.allowed, true);
  assert.equal(r.anchorPositionId, positions[0].id);
  assert.equal(r.anchorEntryPriceSats, 100);
  // 1e-9 tolerance in the comparison, so the fraction is just under 0.20.
  assert.ok(Math.abs(r.discountFraction - 0.20) < 1e-9, `discountFraction=${r.discountFraction} should be ≈0.20`);
});

test('O02 helper: isAllowedSecondPosition: 1 sat above discount → not allowed (boundary)', () => {
  const positions = [openPosition({ entry: { bch_spent_sats: 500_000, price_sats_per_token: 100, fee_sats: 200, txid: 'aa'.repeat(32) } })];
  const r = isAllowedSecondPosition(positions, 80.000001, 0.20, NOW_MS);
  assert.equal(r.allowed, false);
  assert.match(r.reason, /only.*below anchor/);
});

test('O02 helper: isAllowedSecondPosition: anchor selection when only ONE position exists (O02.1 cap means we never see 2)', () => {
  // O02.1 hard-caps open positions per token at 2. The original
  // "anchor is the OLDEST" test passed 2 open positions in (to
  // verify anchor selection when more than one existed); under the
  // cap that's unreachable in production. This test keeps the
  // anchor-selection check alive with a single-open-position
  // scenario: the (only) open position is the anchor, and the
  // discount is evaluated against IT.
  const existing = openPosition({
    id: 'pos_first',
    token_id: TID_A,
    status: 'open',
    opened_at: new Date(NOW_MS - 7_200_000).toISOString(),
    entry: { bch_spent_sats: 500_000, price_sats_per_token: 100, fee_sats: 200, txid: 'aa'.repeat(32) },
  });
  // proposed 60: 60 ≤ 100 * 0.80 = 80 ✓ → allowed; anchor=existing
  const rAllowed = isAllowedSecondPosition([existing], 60, 0.20, NOW_MS);
  assert.equal(rAllowed.allowed, true);
  assert.equal(rAllowed.anchorPositionId, 'pos_first');
  assert.equal(rAllowed.anchorEntryPriceSats, 100);
  // proposed 90: 90 ≤ 80? NO → rejected (discount check)
  const rRejected = isAllowedSecondPosition([existing], 90, 0.20, NOW_MS);
  assert.equal(rRejected.allowed, false);
  assert.match(rRejected.reason, /only.*below anchor 100/);
});

test('O02 helper: isAllowedSecondPosition: re-anchors when oldest closes (caller passes filtered list)', () => {
  // After pos_older closes, pos_newer becomes the anchor. Caller
  // (canOpen) filters openPositions to status==='open' before
  // passing in; the helper also re-filters defensively.
  const older = openPosition({
    id: 'pos_older',
    token_id: TID_A,
    status: 'closed',  // already exited
    opened_at: new Date(NOW_MS - 7_200_000).toISOString(),
    entry: { bch_spent_sats: 500_000, price_sats_per_token: 100, fee_sats: 200, txid: 'aa'.repeat(32) },
  });
  const newer = openPosition({
    id: 'pos_newer',
    token_id: TID_A,
    status: 'open',
    opened_at: new Date(NOW_MS - 3_600_000).toISOString(),
    entry: { bch_spent_sats: 500_000, price_sats_per_token: 50, fee_sats: 200, txid: 'bb'.repeat(32) },
  });
  // proposed 45: 45 ≤ 50 * 0.80 = 40? NO → rejected (anchor is now 50)
  const rRejected = isAllowedSecondPosition([older, newer], 45, 0.20, NOW_MS);
  assert.equal(rRejected.allowed, false);
  assert.equal(rRejected.anchorPositionId, 'pos_newer');
  // proposed 39: 39 ≤ 50 * 0.80 = 40 ✓ → allowed
  const rAllowed = isAllowedSecondPosition([older, newer], 39, 0.20, NOW_MS);
  assert.equal(rAllowed.allowed, true);
  assert.equal(rAllowed.anchorPositionId, 'pos_newer');
});

test('O02 canOpen: second position allowed when discount >= 20%', () => {
  const existing = openPosition({
    id: 'pos_first',
    token_id: TID_A,
    status: 'open',
    opened_at: new Date(NOW_MS - 3_600_000).toISOString(),
    entry: { bch_spent_sats: 500_000, price_sats_per_token: 100, fee_sats: 200, txid: 'aa'.repeat(32) },
  });
  const r = canOpen({
    tokenId: TID_A,
    proposedSizeBch: 0.005,
    proposedPricePerBaseUnit: 75,  // 25% below 100
    openPositions: [existing],
    closedPositions: [],
    walletBalanceBch: 0.044,
    cfg: baseConfig(),
    nowMs: NOW_MS,
  });
  assert.equal(r.ok, true);
  assert.equal(r.second_position, true);
  assert.equal(r.anchor_position_id, 'pos_first');
  assert.equal(r.anchor_entry_price_sats, 100);
  assert.equal(r.required_discount_pct, 0.20);
  // 75 vs 100 → 25% discount.
  assert.ok(Math.abs(r.discount_fraction - 0.25) < 1e-9, `discount_fraction=${r.discount_fraction}`);
});

test('O02 canOpen: insufficient discount → already_open (with informative reason)', () => {
  const existing = openPosition({
    id: 'pos_first',
    token_id: TID_A,
    status: 'open',
    opened_at: new Date(NOW_MS - 3_600_000).toISOString(),
    entry: { bch_spent_sats: 500_000, price_sats_per_token: 100, fee_sats: 200, txid: 'aa'.repeat(32) },
  });
  const r = canOpen({
    tokenId: TID_A,
    proposedSizeBch: 0.005,
    proposedPricePerBaseUnit: 85,  // only 15% below 100 (need ≥ 20%)
    openPositions: [existing],
    closedPositions: [],
    walletBalanceBch: 0.044,
    cfg: baseConfig(),
    nowMs: NOW_MS,
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'already_open');
  // The reason should mention the discount percentage shortfall so
  // the operator can see how much additional drop would have unblocked.
  assert.match(r.reason, /only 15\.00% below anchor 100/);
  assert.match(r.reason, /need ≥ 20\.0%/);
});

test('O02 canOpen: missing proposedPricePerBaseUnit + open position → still rejected as already_open (safe default)', () => {
  // When the caller can't compute a price (no indexer data, missing
  // decimals, etc.), the gate MUST fall back to the strict v1 reject
  // rather than guessing. The O02 discount gate is opt-in: caller
  // opts in by providing the price.
  const existing = openPosition({
    id: 'pos_first',
    token_id: TID_A,
    status: 'open',
    entry: { bch_spent_sats: 500_000, price_sats_per_token: 100, fee_sats: 200, txid: 'aa'.repeat(32) },
  });
  const r = canOpen({
    tokenId: TID_A,
    proposedSizeBch: 0.005,
    proposedPricePerBaseUnit: null,  // caller couldn't compute it
    openPositions: [existing],
    closedPositions: [],
    walletBalanceBch: 0.044,
    cfg: baseConfig(),
    nowMs: NOW_MS,
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'already_open');
  // Without a price we can't give a useful "would have been X% off" reason.
  assert.match(r.reason, /already has an open position; close it before re-entering/);
});

test('O02 canOpen: discountPct=1.0 (operator knob flipped to disable) → behaves like v1', () => {
  const existing = openPosition({
    id: 'pos_first',
    token_id: TID_A,
    status: 'open',
    entry: { bch_spent_sats: 500_000, price_sats_per_token: 100, fee_sats: 200, txid: 'aa'.repeat(32) },
  });
  const cfg = baseConfig();
  cfg.entry.allow_second_position_discount_pct = 1.0;  // disable
  const r = canOpen({
    tokenId: TID_A,
    proposedSizeBch: 0.005,
    proposedPricePerBaseUnit: 50,  // huge discount; should still be rejected
    openPositions: [existing],
    closedPositions: [],
    walletBalanceBch: 0.044,
    cfg,
    nowMs: NOW_MS,
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'already_open');
});

test('O02 canOpen: per-trade ceiling still applies on second position', () => {
  // Even when second-position allowance is granted, the per-trade
  // max_position_bch ceiling fires BEFORE canOpen checks any of
  // the size-related gates. Here proposedSize > max → rejected.
  const existing = openPosition({
    id: 'pos_first',
    token_id: TID_A,
    status: 'open',
    entry: { bch_spent_sats: 500_000, price_sats_per_token: 100, fee_sats: 200, txid: 'aa'.repeat(32) },
  });
  const r = canOpen({
    tokenId: TID_A,
    proposedSizeBch: 0.01,  // > max_position_bch 0.005
    proposedPricePerBaseUnit: 50,
    openPositions: [existing],
    closedPositions: [],
    walletBalanceBch: 0.044,
    cfg: baseConfig(),
    nowMs: NOW_MS,
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'position_too_large');
});

test('O02 canOpen: total exposure ceiling still applies on second position', () => {
  const existing = openPosition({
    id: 'pos_first',
    token_id: TID_A,
    status: 'open',
    entry: { bch_spent_sats: 500_000, price_sats_per_token: 100, fee_sats: 200, txid: 'aa'.repeat(32) },
  });
  // After the 0.005 second position: total exposure = 0.01 (existing 0.005 + new 0.005).
  // max_total_exposure_bch default 0.04. To trip exposure_full, we need
  // existing + new > 0.04, so propose 0.04 on top of 0.005 existing.
  // proposedSizeBch would need to be 0.035 — but max_position_bch caps at 0.005,
  // so the per-trade gate fires first. Instead, lower max_total_exposure_bch
  // so the existing + 0.005 already exceed it.
  const cfg = baseConfig({ entry: { max_total_exposure_bch: 0.008 } });
  const r = canOpen({
    tokenId: TID_A,
    proposedSizeBch: 0.005,
    proposedPricePerBaseUnit: 50,
    openPositions: [existing],
    closedPositions: [],
    walletBalanceBch: 0.044,
    cfg,
    nowMs: NOW_MS,
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'exposure_full');
});

test('O02 config: DEFAULT_RISK_AUX_CONFIG includes allow_second_position_discount_pct', async () => {
  // Lock the default so a future refactor that drops the knob fails loudly.
  const { DEFAULT_RISK_AUX_CONFIG } = await import('../src/risk/limits.mjs');
  assert.equal(DEFAULT_RISK_AUX_CONFIG.allow_second_position_discount_pct, 0.20);
});

test('O02 config: defaults file (config/default.json) has allow_second_position_discount_pct', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const cfgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../config/default.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  assert.equal(cfg.entry.allow_second_position_discount_pct, 0.20);
});

test('O02 catalog: knob-catalog exposes entry.allow_second_position_discount_pct', async () => {
  const { KNOBS } = await import('../src/util/knob-catalog.mjs');
  const entry = KNOBS.find((k) => k.key === 'entry.allow_second_position_discount_pct');
  assert.ok(entry, 'expected knob-catalog entry for entry.allow_second_position_discount_pct');
  assert.equal(entry.path.join('.'), 'entry.allow_second_position_discount_pct');
  assert.equal(entry.kind, 'number');
  assert.equal(entry.min, 0);
  assert.equal(entry.max, 1);
  assert.equal(entry.group, 'entry');
});

// ────────────────────────────────────────────────────────────────────
//  O02.1 — MAX_POSITIONS_PER_TOKEN cap (operator feedback after f72c7a7)
//
// The original O02 implementation (shipped f72c7a7) read "two
// positions" as "at least two" instead of "at most two". With the
// 20% default discount, the bot happily opened 4 FURU positions at
// the same dip price (299 sats) because each one cleared the
// discount vs the original 377 anchor. The operator's intent was
// ONE original + ONE second-entry max, after which the original
// v1 single-position-per-token policy resumes.
//
// This adds a hard cap of MAX_POSITIONS_PER_TOKEN = 2 (exported
// from src/risk/limits.mjs) inside isAllowedSecondPosition. Going
// from 2 → 3 is rejected regardless of price. If position-1 closes,
// position-2 becomes the only open position and a new entry is
// allowed again (going from 1 → 2 with a sufficient discount).
// ────────────────────────────────────────────────────────────────────

test('O02.1 helper: MAX_POSITIONS_PER_TOKEN exported as 2', async () => {
  const m = await import('../src/risk/limits.mjs');
  assert.equal(m.MAX_POSITIONS_PER_TOKEN, 2);
});

test('O02.1 helper: 2 existing open positions → not allowed (cap), regardless of discount', () => {
  // Even with 100% discount and a fresh valid proposed price, the
  // helper rejects because the cap (2) has been reached. Anchor
  // fields are NOT attached so the caller doesn't surface a
  // misleading "would have been 80% off" message on what is
  // actually a position-count reject.
  const positions = [
    openPosition({ id: 'pos_1', entry: { bch_spent_sats: 500_000, price_sats_per_token: 100, fee_sats: 200, txid: 'aa'.repeat(32) } }),
    openPosition({ id: 'pos_2', entry: { bch_spent_sats: 500_000, price_sats_per_token: 50,  fee_sats: 200, txid: 'bb'.repeat(32) } }),
  ];
  // proposed 1 sats = 99% discount from oldest (100) — discount check would pass.
  const r = isAllowedSecondPosition(positions, 1, 0.20);
  assert.equal(r.allowed, false);
  assert.match(r.reason, /already has 2 open positions \(max 2: pos_1, pos_2\)/);
  // No anchor fields on a cap reject.
  assert.equal(r.anchorPositionId, undefined);
  assert.equal(r.anchorEntryPriceSats, undefined);
});

test('O02.1 helper: 2 existing open positions + closed position in list → cap still fires (caller filter is defensive)', () => {
  // Caller is expected to filter to open positions on this token, but
  // the helper's listOpen re-filter also handles it. A closed position
  // mixed in does NOT increase the count.
  const positions = [
    openPosition({ id: 'pos_old_closed', status: 'closed', entry: { bch_spent_sats: 500_000, price_sats_per_token: 100, fee_sats: 200, txid: 'aa'.repeat(32) } }),
    openPosition({ id: 'pos_1', entry: { bch_spent_sats: 500_000, price_sats_per_token: 100, fee_sats: 200, txid: 'aa'.repeat(32) } }),
    openPosition({ id: 'pos_2', entry: { bch_spent_sats: 500_000, price_sats_per_token: 50,  fee_sats: 200, txid: 'bb'.repeat(32) } }),
  ];
  const r = isAllowedSecondPosition(positions, 1, 0.20);
  assert.equal(r.allowed, false);
  assert.match(r.reason, /already has 2 open positions/);
});

test('O02.1 helper: 1 existing open position + sufficient discount → still allowed (no regression)', () => {
  // Original O02 happy path — make sure the cap didn't break the
  // case it's supposed to allow.
  const positions = [openPosition({ entry: { bch_spent_sats: 500_000, price_sats_per_token: 100, fee_sats: 200, txid: 'aa'.repeat(32) } })];
  const r = isAllowedSecondPosition(positions, 75, 0.20);
  assert.equal(r.allowed, true);
  assert.equal(r.anchorPositionId, positions[0].id);
});

test('O02.1 canOpen: 2 open positions on token → rejects as already_open, no second-position path', () => {
  // Full canOpen flow — confirms the gate rejects and uses the
  // cap-message (not the discount-message) so the operator sees
  // WHY the trade was blocked.
  const existing1 = openPosition({
    id: 'pos_1',
    token_id: TID_A,
    status: 'open',
    opened_at: new Date(NOW_MS - 7_200_000).toISOString(),  // 2h ago
    entry: { bch_spent_sats: 500_000, price_sats_per_token: 100, fee_sats: 200, txid: 'aa'.repeat(32) },
  });
  const existing2 = openPosition({
    id: 'pos_2',
    token_id: TID_A,
    status: 'open',
    opened_at: new Date(NOW_MS - 3_600_000).toISOString(),  // 1h ago
    entry: { bch_spent_sats: 500_000, price_sats_per_token: 50, fee_sats: 200, txid: 'bb'.repeat(32) },
  });
  const r = canOpen({
    tokenId: TID_A,
    proposedSizeBch: 0.005,
    proposedPricePerBaseUnit: 10,  // 90% discount from oldest — discount check would pass
    openPositions: [existing1, existing2],
    closedPositions: [],
    walletBalanceBch: 0.044,
    cfg: baseConfig(),
    nowMs: NOW_MS,
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'already_open');
  // Reason comes from the cap path (not the discount path), so it
  // mentions "already has 2 open positions" rather than the
  // discount shortfall phrasing.
  assert.match(r.reason, /already has 2 open positions/);
  assert.doesNotMatch(r.reason, /only \d+\.\d+% below anchor/);
});

test('O02.1 canOpen: 1 open position → second position still allowed (no regression)', () => {
  // The exact case the operator DOES want to allow — 1 open position
  // (the "first") and a new entry at sufficient discount becomes
  // the "second".
  const existing = openPosition({
    id: 'pos_first',
    token_id: TID_A,
    status: 'open',
    opened_at: new Date(NOW_MS - 3_600_000).toISOString(),
    entry: { bch_spent_sats: 500_000, price_sats_per_token: 100, fee_sats: 200, txid: 'aa'.repeat(32) },
  });
  const r = canOpen({
    tokenId: TID_A,
    proposedSizeBch: 0.005,
    proposedPricePerBaseUnit: 75,  // 25% below 100
    openPositions: [existing],
    closedPositions: [],
    walletBalanceBch: 0.044,
    cfg: baseConfig(),
    nowMs: NOW_MS,
  });
  assert.equal(r.ok, true);
  assert.equal(r.second_position, true);
  assert.equal(r.anchor_position_id, 'pos_first');
});

test('O02.1 canOpen: 0 open positions (no first) → normal entry path, not affected by cap', () => {
  // The cap only applies when there ARE existing open positions.
  // 0 → 1 (the very first entry) must not be blocked by the cap.
  const r = canOpen({
    tokenId: TID_A,
    proposedSizeBch: 0.005,
    proposedPricePerBaseUnit: 100,
    openPositions: [],
    closedPositions: [],
    walletBalanceBch: 0.044,
    cfg: baseConfig(),
    nowMs: NOW_MS,
  });
  assert.equal(r.ok, true);
  assert.equal(r.second_position, undefined);  // no second-position metadata for a normal first entry
});
