#!/usr/bin/env node
/**
 * Unit tests for src/risk/circuit-breaker.mjs.
 *
 * Covers:
 *   - resolveRiskConfig: defaults + overrides + bad input
 *   - classifyPnl: win / loss / breakeven / null
 *   - cooldownRemainingMs: 0 when cooled, full cooldown when fresh
 *   - tripKind: daily_loss > consecutive_losses priority
 *   - CircuitBreaker:
 *     - construction, state()
 *     - isTripped / tripKind after no records
 *     - recordResult: win / loss / breakeven / null handling
 *     - daily_loss trip when sum exceeds -max_daily_loss_bch
 *     - consecutive_loss trip at max_consecutive_losses
 *     - cooldown expires → not tripped
 *     - evaluate() returns allow + reason
 *     - reset() clears both trips + logs
 *   - GUARD: knobs come from config, never hard-coded literals
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_RISK_CONFIG,
  resolveRiskConfig,
  classifyPnl,
  cooldownRemainingMs,
  tripKind,
  CircuitBreaker,
} from '../src/risk/circuit-breaker.mjs';

// ────────────────────────────────────────────────────────────────────
//  Fixtures
// ────────────────────────────────────────────────────────────────────

const NOW_MS = Date.UTC(2026, 8, 11, 0, 0, 0);

function baseConfig(overrides = {}) {
  return {
    risk: { ...DEFAULT_RISK_CONFIG },
    ...overrides,
  };
}

/** Build a deterministic clock for the breaker. */
function clockFromFixedStart(startMs) {
  let cur = startMs;
  return {
    now: () => cur,
    advance: (ms) => { cur += ms; },
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
  }
});

test('resolveRiskConfig: clamps negative values', () => {
  const c = resolveRiskConfig({ max_daily_loss_bch: -1 });
  assert.equal(c.max_daily_loss_bch, DEFAULT_RISK_CONFIG.max_daily_loss_bch);
});

// ────────────────────────────────────────────────────────────────────
//  classifyPnl
// ────────────────────────────────────────────────────────────────────

test('classifyPnl: positive → win', () => {
  assert.equal(classifyPnl(100), 'win');
  assert.equal(classifyPnl(100n), 'win');
  assert.equal(classifyPnl('100'), 'win');
});

test('classifyPnl: negative → loss', () => {
  assert.equal(classifyPnl(-100), 'loss');
  assert.equal(classifyPnl(-100n), 'loss');
  assert.equal(classifyPnl('-100'), 'loss');
});

test('classifyPnl: zero → breakeven', () => {
  assert.equal(classifyPnl(0), 'breakeven');
  assert.equal(classifyPnl(0n), 'breakeven');
});

test('classifyPnl: missing/non-numeric → null', () => {
  assert.equal(classifyPnl(null), null);
  assert.equal(classifyPnl(undefined), null);
  assert.equal(classifyPnl('garbage'), null);
  assert.equal(classifyPnl(NaN), null);
});

// ────────────────────────────────────────────────────────────────────
//  cooldownRemainingMs / tripKind
// ────────────────────────────────────────────────────────────────────

test('cooldownRemainingMs: no trip → 0', () => {
  assert.equal(cooldownRemainingMs(null, 6, NOW_MS), 0);
  assert.equal(cooldownRemainingMs(undefined, 6, NOW_MS), 0);
});

test('cooldownRemainingMs: fresh trip → full cooldown', () => {
  assert.equal(cooldownRemainingMs(NOW_MS, 6, NOW_MS), 6 * 3_600_000);
});

test('cooldownRemainingMs: halfway → half cooldown', () => {
  const tripTs = NOW_MS;
  const remaining = cooldownRemainingMs(tripTs, 6, NOW_MS + 3 * 3_600_000);
  assert.equal(remaining, 3 * 3_600_000);
});

test('cooldownRemainingMs: cooled down → 0', () => {
  const tripTs = NOW_MS;
  assert.equal(cooldownRemainingMs(tripTs, 6, NOW_MS + 7 * 3_600_000), 0);
});

test('cooldownRemainingMs: bad input → 0', () => {
  assert.equal(cooldownRemainingMs(NOW_MS, 0, NOW_MS), 0);
  assert.equal(cooldownRemainingMs(NOW_MS, -1, NOW_MS), 0);
  assert.equal(cooldownRemainingMs(NOW_MS, 6, NaN), 0);
});

test('tripKind: daily_loss > consecutive_losses priority', () => {
  const s = {
    dailyLossTripTsMs: NOW_MS,
    consecutiveLossesTripTsMs: NOW_MS,
    dailyLossCooldownHours: 6,
    consecutiveLossesCooldownHours: 6,
    nowMs: NOW_MS,
  };
  assert.equal(tripKind(s), 'daily_loss');
});

test('tripKind: only consecutive_losses', () => {
  const s = {
    dailyLossTripTsMs: null,
    consecutiveLossesTripTsMs: NOW_MS,
    dailyLossCooldownHours: 6,
    consecutiveLossesCooldownHours: 6,
    nowMs: NOW_MS,
  };
  assert.equal(tripKind(s), 'consecutive_losses');
});

test('tripKind: nothing tripped → null', () => {
  const s = {
    dailyLossTripTsMs: null,
    consecutiveLossesTripTsMs: null,
    dailyLossCooldownHours: 6,
    consecutiveLossesCooldownHours: 6,
    nowMs: NOW_MS,
  };
  assert.equal(tripKind(s), null);
});

test('tripKind: cooled-down trips → null', () => {
  const s = {
    dailyLossTripTsMs: NOW_MS - 100 * 3_600_000,
    consecutiveLossesTripTsMs: NOW_MS - 100 * 3_600_000,
    dailyLossCooldownHours: 6,
    consecutiveLossesCooldownHours: 6,
    nowMs: NOW_MS,
  };
  assert.equal(tripKind(s), null);
});

// ────────────────────────────────────────────────────────────────────
//  CircuitBreaker — basic
// ────────────────────────────────────────────────────────────────────

test('CircuitBreaker: construction is cheap; state() never throws', () => {
  const cb = new CircuitBreaker({ cfg: baseConfig(), now: () => NOW_MS });
  const s = cb.state();
  assert.equal(s.dailyLossTripTsMs, null);
  assert.equal(s.consecutiveLossesTripTsMs, null);
  assert.equal(s.isTripped, false);
  assert.equal(s.tripKind, null);
});

test('CircuitBreaker: requires cfg + now options', () => {
  assert.throws(() => new CircuitBreaker(), /opts is required/);
  assert.throws(() => new CircuitBreaker({}), /cfg is required/);
});

test('CircuitBreaker: bad pnlSats in recordResult → throws', () => {
  const cb = new CircuitBreaker({ cfg: baseConfig(), now: () => NOW_MS });
  assert.throws(() => cb.recordResult({}), /pnlSats/);
  assert.throws(() => cb.recordResult({ pnlSats: 'banana' }), /pnlSats/);
  assert.throws(() => cb.recordResult({ pnlSats: null }), /pnlSats/);
});

// ────────────────────────────────────────────────────────────────────
//  CircuitBreaker — daily_loss trip
// ────────────────────────────────────────────────────────────────────

test('CircuitBreaker: daily_loss trips when sum <= -max_daily_loss_bch', () => {
  const cb = new CircuitBreaker({ cfg: baseConfig(), now: () => NOW_MS });
  // First loss: -0.0025 BCH (under the 0.005 BCH cap). No trip.
  cb.recordResult({ pnlSats: -250_000, tsMs: NOW_MS - 60_000 });
  assert.equal(cb.isTripped(NOW_MS), false);

  // Second loss pushes past -0.005 BCH (sum = -0.0055 BCH) → trip.
  // Note: 2 consecutive losses is below the default `max_consecutive_losses=3`,
  // so this trip must be daily_loss, not consecutive_losses.
  const r = cb.recordResult({ pnlSats: -300_000, tsMs: NOW_MS });
  assert.equal(r.tripped, true);
  assert.equal(r.tripKind, 'daily_loss');
  assert.equal(cb.isTripped(NOW_MS), true);
  assert.equal(cb.tripKind(NOW_MS), 'daily_loss');
});

test('CircuitBreaker: daily_loss trip does not re-trip on subsequent losses', () => {
  // Tighten the consecutive-loss cap so the trip we trigger is the
  // daily-loss one, not the consecutive-loss one.
  const cb = new CircuitBreaker({
    cfg: baseConfig({ risk: { max_consecutive_losses: 99 } }),
    now: () => NOW_MS,
  });
  // Trip daily_loss on the first record (sum = -0.001 BCH... need > 0.005).
  cb.recordResult({ pnlSats: -550_000, tsMs: NOW_MS }); // -0.0055 BCH → trip
  assert.equal(cb.isTripped(NOW_MS), true);
  // Subsequent loss within the window: still tripped, but recordResult
  // must NOT report a fresh trip (we already tripped).
  const r1 = cb.recordResult({ pnlSats: -10_000, tsMs: NOW_MS });
  assert.equal(r1.tripped, false);
  assert.equal(cb.isTripped(NOW_MS), true);
});

test('CircuitBreaker: daily_loss looks back across 24h by default', () => {
  // Custom 12h lookback so the test runs fast.
  const cb = new CircuitBreaker({ cfg: baseConfig(), now: () => NOW_MS, dailyLookbackHours: 12 });
  cb.recordResult({ pnlSats: -50_000, tsMs: NOW_MS - 13 * 3_600_000 }); // outside window
  const r = cb.recordResult({ pnlSats: -10_000, tsMs: NOW_MS });
  // Inside-window loss = -10_000 sats. Outside-window loss is excluded.
  assert.equal(r.tripped, false);
});

test('CircuitBreaker: wins offset losses inside the daily window', () => {
  const cb = new CircuitBreaker({ cfg: baseConfig(), now: () => NOW_MS });
  cb.recordResult({ pnlSats: -30_000, tsMs: NOW_MS - 3_600_000 });
  cb.recordResult({ pnlSats: 20_000,  tsMs: NOW_MS - 30 * 60_000 }); // offset
  cb.recordResult({ pnlSats: -10_000, tsMs: NOW_MS }); // net = -20_000, not at cap yet
  assert.equal(cb.isTripped(NOW_MS), false);
  const r = cb.recordResult({ pnlSats: -400_000, tsMs: NOW_MS });
  // net = -20_000 - 400_000 = -420_000 sats = -0.0042 BCH — still under cap.
  assert.equal(r.tripped, false);
});

// ────────────────────────────────────────────────────────────────────
//  CircuitBreaker — consecutive_losses trip
// ────────────────────────────────────────────────────────────────────

test('CircuitBreaker: consecutive_losses trips at max_consecutive_losses', () => {
  const cb = new CircuitBreaker({ cfg: baseConfig(), now: () => NOW_MS });
  cb.recordResult({ pnlSats: -1_000, tsMs: NOW_MS - 3 * 60_000 });
  cb.recordResult({ pnlSats: -1_000, tsMs: NOW_MS - 2 * 60_000 });
  assert.equal(cb.isTripped(NOW_MS), false);
  const r = cb.recordResult({ pnlSats: -1_000, tsMs: NOW_MS - 60_000 });
  assert.equal(r.tripped, true);
  assert.equal(r.tripKind, 'consecutive_losses');
});

test('CircuitBreaker: a win between losses breaks the consecutive streak', () => {
  const cb = new CircuitBreaker({ cfg: baseConfig(), now: () => NOW_MS });
  cb.recordResult({ pnlSats: -1_000, tsMs: NOW_MS - 4 * 60_000 });
  cb.recordResult({ pnlSats: -1_000, tsMs: NOW_MS - 3 * 60_000 });
  cb.recordResult({ pnlSats: 500,   tsMs: NOW_MS - 2 * 60_000 }); // win
  cb.recordResult({ pnlSats: -1_000, tsMs: NOW_MS - 60_000 });
  cb.recordResult({ pnlSats: -1_000, tsMs: NOW_MS });
  assert.equal(cb.isTripped(NOW_MS), false);
  // state.consecutiveLosses should be 2 (last two losses).
  assert.equal(cb.state().consecutiveLosses, 2);
});

test('CircuitBreaker: breakeven also breaks the streak', () => {
  const cb = new CircuitBreaker({ cfg: baseConfig(), now: () => NOW_MS });
  cb.recordResult({ pnlSats: -1_000, tsMs: NOW_MS - 2 * 60_000 });
  cb.recordResult({ pnlSats: 0,     tsMs: NOW_MS - 60_000 });
  cb.recordResult({ pnlSats: -1_000, tsMs: NOW_MS });
  // Only one loss in a row (the last).
  assert.equal(cb.state().consecutiveLosses, 1);
  assert.equal(cb.isTripped(NOW_MS), false);
});

test('CircuitBreaker: state().consecutiveLosses reflects current streak', () => {
  const cb = new CircuitBreaker({ cfg: baseConfig(), now: () => NOW_MS });
  assert.equal(cb.state().consecutiveLosses, 0);
  cb.recordResult({ pnlSats: -1_000, tsMs: NOW_MS });
  assert.equal(cb.state().consecutiveLosses, 1);
  cb.recordResult({ pnlSats: -1_000, tsMs: NOW_MS });
  assert.equal(cb.state().consecutiveLosses, 2);
  cb.recordResult({ pnlSats: 1_000,  tsMs: NOW_MS });
  assert.equal(cb.state().consecutiveLosses, 0);
});

// ────────────────────────────────────────────────────────────────────
//  CircuitBreaker — cooldown
// ────────────────────────────────────────────────────────────────────

test('CircuitBreaker: cooldown expires → not tripped', () => {
  const clock = clockFromFixedStart(NOW_MS);
  // Tighten the consecutive-loss cap so the trip is the daily_loss
  // one (with default `max_consecutive_losses=3` a single big loss
  // wouldn't trip anything).
  const cb = new CircuitBreaker({
    cfg: baseConfig({ risk: { max_consecutive_losses: 99 } }),
    now: clock.now,
  });
  cb.recordResult({ pnlSats: -550_000, tsMs: clock.now() }); // -0.0055 BCH → trip
  assert.equal(cb.isTripped(clock.now()), true);
  clock.advance(7 * 3_600_000); // 6h cooldown + 1h
  assert.equal(cb.isTripped(clock.now()), false);
});

test('CircuitBreaker: state().recentDailyPnlSats reflects in-window sum', () => {
  const cb = new CircuitBreaker({ cfg: baseConfig(), now: () => NOW_MS });
  cb.recordResult({ pnlSats: -10_000, tsMs: NOW_MS - 3_600_000 });
  cb.recordResult({ pnlSats: 5_000,   tsMs: NOW_MS - 30 * 60_000 });
  assert.equal(cb.state().recentDailyPnlSats, -5_000);
});

// ────────────────────────────────────────────────────────────────────
//  CircuitBreaker — evaluate
// ────────────────────────────────────────────────────────────────────

test('evaluate: not tripped → allow:true', () => {
  const cb = new CircuitBreaker({ cfg: baseConfig(), now: () => NOW_MS });
  const r = cb.evaluate({ nowMs: NOW_MS });
  assert.equal(r.allow, true);
  assert.equal(r.tripKind, undefined);
});

test('evaluate: tripped → allow:false, reason + cooldownRemainingMs', () => {
  const cb = new CircuitBreaker({
    cfg: baseConfig({ risk: { max_consecutive_losses: 99 } }),
    now: () => NOW_MS,
  });
  cb.recordResult({ pnlSats: -550_000, tsMs: NOW_MS }); // daily_loss trip
  const r = cb.evaluate({ nowMs: NOW_MS + 3_600_000 });
  assert.equal(r.allow, false);
  assert.equal(r.tripKind, 'daily_loss');
  assert.ok(r.reason.includes('circuit breaker'));
  assert.ok(r.reason.includes('cooldown'));
  assert.equal(typeof r.cooldownRemainingMs, 'number');
  assert.ok(r.cooldownRemainingMs > 0);
});

// ────────────────────────────────────────────────────────────────────
//  CircuitBreaker — reset
// ────────────────────────────────────────────────────────────────────

test('reset: clears both trips, returns previous state', () => {
  const cb = new CircuitBreaker({
    cfg: baseConfig({ risk: { max_consecutive_losses: 99 } }),
    now: () => NOW_MS,
  });
  cb.recordResult({ pnlSats: -550_000, tsMs: NOW_MS }); // daily_loss trip
  const r = cb.reset({ reason: 'manual override', tsMs: NOW_MS + 60_000 });
  assert.equal(r.wasTripped, true);
  assert.equal(r.previousTripKind, 'daily_loss');
  assert.equal(cb.isTripped(NOW_MS + 60_000), false);
});

test('reset: no-op when not tripped', () => {
  const cb = new CircuitBreaker({ cfg: baseConfig(), now: () => NOW_MS });
  const r = cb.reset({ tsMs: NOW_MS });
  assert.equal(r.wasTripped, false);
  assert.equal(r.previousTripKind, null);
});

test('reset: emits structured log when logger provided', () => {
  const logged = [];
  const logger = {
    info: (msg, fields) => logged.push({ msg, fields }),
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    child: () => logger,
    setLevel: () => {},
    get level() { return 30; },
  };
  const cb = new CircuitBreaker({
    cfg: baseConfig({ risk: { max_consecutive_losses: 99 } }),
    now: () => NOW_MS,
    logger,
  });
  cb.recordResult({ pnlSats: -550_000, tsMs: NOW_MS });
  logged.length = 0; // clear the trip log
  cb.reset({ reason: 'manual', tsMs: NOW_MS });
  const resetLog = logged.find((l) => l.msg === 'circuit_breaker.reset');
  assert.ok(resetLog, 'expected circuit_breaker.reset log entry');
  assert.equal(resetLog.fields.previous_trip_kind, 'daily_loss');
  assert.equal(resetLog.fields.reason, 'manual');
});

// ────────────────────────────────────────────────────────────────────
//  GUARD: knobs come from config, not hard-coded
// ────────────────────────────────────────────────────────────────────

test('GUARD: max_daily_loss_bch=0.0001 trips earlier', () => {
  const cb = new CircuitBreaker({ cfg: baseConfig({ risk: { max_daily_loss_bch: 0.0001 } }), now: () => NOW_MS });
  const r = cb.recordResult({ pnlSats: -15_000, tsMs: NOW_MS });
  // -0.00015 BCH <= -0.0001 BCH cap → trip.
  assert.equal(r.tripped, true);
  assert.equal(r.tripKind, 'daily_loss');
});

test('GUARD: max_consecutive_losses=1 trips on first loss', () => {
  const cb = new CircuitBreaker({ cfg: baseConfig({ risk: { max_consecutive_losses: 1 } }), now: () => NOW_MS });
  const r = cb.recordResult({ pnlSats: -100, tsMs: NOW_MS });
  assert.equal(r.tripped, true);
  assert.equal(r.tripKind, 'consecutive_losses');
});

test('GUARD: circuit_breaker_cooldown_hours=1 expires after 1h', () => {
  const clock = clockFromFixedStart(NOW_MS);
  const cb = new CircuitBreaker({
    cfg: baseConfig({ risk: { circuit_breaker_cooldown_hours: 1, max_consecutive_losses: 99 } }),
    now: clock.now,
  });
  cb.recordResult({ pnlSats: -550_000, tsMs: clock.now() });
  assert.equal(cb.isTripped(clock.now()), true);
  clock.advance(2 * 3_600_000);
  assert.equal(cb.isTripped(clock.now()), false);
});

test('GUARD: defaults file (config/default.json) risk block is honored', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const cfgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../config/default.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  assert.equal(cfg.risk.max_daily_loss_bch, 0.005);
  assert.equal(cfg.risk.max_consecutive_losses, 3);
  assert.equal(cfg.risk.circuit_breaker_cooldown_hours, 6);

  const cb = new CircuitBreaker({ cfg, now: () => NOW_MS });
  const state = cb.state();
  assert.equal(state.maxDailyLossBch, 0.005);
  assert.equal(state.maxConsecutiveLosses, 3);
  assert.equal(state.dailyLossCooldownHours, 6);
  assert.equal(state.consecutiveLossesCooldownHours, 6);
});
// ────────────────────────────────────────────────────────────────────
//  T34 — Loss cooldown
//
// After a stop-loss exit, the breaker pauses new entries for
// `loss_cooldown_minutes` (default 30). Other exit kinds (take-profit,
// trailing-stop, time-stop) do NOT start the cooldown.
// ────────────────────────────────────────────────────────────────────

import { lossCooldownRemainingMs, _internals } from '../src/risk/circuit-breaker.mjs';

test('T34: loss_cooldown_minutes default = 30 in DEFAULT_RISK_CONFIG', () => {
  assert.equal(DEFAULT_RISK_CONFIG.loss_cooldown_minutes, 30);
});

test('T34: resolveRiskConfig — loss_cooldown_minutes non-finite → default', () => {
  for (const bad of [NaN, Infinity, -Infinity, 'x', null, undefined]) {
    const c = resolveRiskConfig({ loss_cooldown_minutes: bad });
    assert.equal(c.loss_cooldown_minutes, 30,
      `bad input ${JSON.stringify(bad)} should fall back to default 30, got ${c.loss_cooldown_minutes}`);
  }
});

test('T34: resolveRiskConfig — loss_cooldown_minutes ≤ 0 passes through (opt-out sentinel)', () => {
  // 0 / negative are valid opt-out values: the breaker's recordResult
  // skips starting the cooldown, and the tripKind helper treats ≤ 0
  // as "cooldown disabled". resolveRiskConfig must NOT clamp these.
  for (const v of [0, -1, -30, -1440]) {
    const c = resolveRiskConfig({ loss_cooldown_minutes: v });
    assert.equal(c.loss_cooldown_minutes, v,
      `value ${v} should pass through verbatim, got ${c.loss_cooldown_minutes}`);
  }
});

test('T34: resolveRiskConfig — loss_cooldown_minutes passes through positive values', () => {
  for (const v of [1, 5, 30, 60, 1440]) {
    const c = resolveRiskConfig({ loss_cooldown_minutes: v });
    assert.equal(c.loss_cooldown_minutes, v);
  }
});

test('T34: lossCooldownRemainingMs — pure helper', () => {
  // No trip → 0.
  assert.equal(lossCooldownRemainingMs(null, 30, NOW_MS), 0);
  assert.equal(lossCooldownRemainingMs(undefined, 30, NOW_MS), 0);
  // Fresh trip → full cooldown (30 minutes in ms).
  assert.equal(lossCooldownRemainingMs(NOW_MS, 30, NOW_MS), 30 * 60_000);
  // Halfway → half.
  assert.equal(lossCooldownRemainingMs(NOW_MS, 30, NOW_MS + 15 * 60_000), 15 * 60_000);
  // Cooled down → 0.
  assert.equal(lossCooldownRemainingMs(NOW_MS, 30, NOW_MS + 31 * 60_000), 0);
  // Negative cooldown → 0 (disabled).
  assert.equal(lossCooldownRemainingMs(NOW_MS, 0, NOW_MS), 0);
  assert.equal(lossCooldownRemainingMs(NOW_MS, -1, NOW_MS), 0);
  // NaN now → 0.
  assert.equal(lossCooldownRemainingMs(NOW_MS, 30, NaN), 0);
});

test('T34: tripKind — priority daily_loss > consecutive_losses > loss_cooldown', () => {
  const s = {
    dailyLossTripTsMs: NOW_MS,
    consecutiveLossesTripTsMs: NOW_MS,
    stopLossCooldownTripTsMs: NOW_MS,
    dailyLossCooldownHours: 6,
    consecutiveLossesCooldownHours: 6,
    lossCooldownMinutes: 30,
    nowMs: NOW_MS,
  };
  // All three tripped → daily_loss wins.
  assert.equal(tripKind(s), 'daily_loss');
  // Drop daily_loss → consecutive_losses wins.
  s.dailyLossTripTsMs = null;
  assert.equal(tripKind(s), 'consecutive_losses');
  // Drop consecutive_losses → loss_cooldown wins.
  s.consecutiveLossesTripTsMs = null;
  assert.equal(tripKind(s), 'loss_cooldown');
  // Drop loss_cooldown → null.
  s.stopLossCooldownTripTsMs = null;
  assert.equal(tripKind(s), null);
});

test('T34: CircuitBreaker — stop_loss + loss starts the cooldown', () => {
  const cb = new CircuitBreaker({ cfg: baseConfig(), now: () => NOW_MS });
  assert.equal(cb.isTripped(NOW_MS), false);
  const r = cb.recordResult({
    pnlSats: -1_000,
    tsMs: NOW_MS,
    tokenId: 'tok1',
    exitKind: 'stop_loss',
  });
  // Small loss — neither daily_loss (cap = 0.005 BCH = 500_000 sats)
  // nor consecutive_losses (need 3 in a row) trips. Only the loss
  // cooldown should start.
  assert.equal(r.tripped, false);
  assert.equal(r.tripKind, null);
  assert.equal(r.lossCooldownStarted, true);
  assert.equal(cb.isTripped(NOW_MS), true);
  assert.equal(cb.tripKind(NOW_MS), 'loss_cooldown');
});

test('T34: CircuitBreaker — take_profit + loss does NOT start the cooldown', () => {
  const cb = new CircuitBreaker({ cfg: baseConfig(), now: () => NOW_MS });
  const r = cb.recordResult({
    pnlSats: -500,        // could be a take-profit rounding artifact — does NOT matter; exitKind gates the cooldown
    tsMs: NOW_MS,
    tokenId: 'tok1',
    exitKind: 'take_profit',
  });
  assert.equal(r.lossCooldownStarted, false);
  assert.equal(cb.isTripped(NOW_MS), false);
});

test('T34: CircuitBreaker — trailing_stop + time_stop do NOT start the cooldown', () => {
  for (const ek of ['trailing_stop', 'time_stop']) {
    const cb = new CircuitBreaker({ cfg: baseConfig(), now: () => NOW_MS });
    const r = cb.recordResult({ pnlSats: -1_000, tsMs: NOW_MS, tokenId: 'tok1', exitKind: ek });
    assert.equal(r.lossCooldownStarted, false, `${ek} must not start the cooldown`);
    assert.equal(cb.isTripped(NOW_MS), false);
  }
});

test('T34: CircuitBreaker — stop_loss + win does NOT start the cooldown (sanity guard)', () => {
  // Defensive: a "stop-loss" with a positive pnlSats means the
  // position actually recovered by the time it closed; that's not a
  // market rejection, so no cooldown. This locks in the current
  // semantics so a future refactor can't accidentally drop the
  // `kind === 'loss'` guard.
  const cb = new CircuitBreaker({ cfg: baseConfig(), now: () => NOW_MS });
  const r = cb.recordResult({
    pnlSats: 1_000,
    tsMs: NOW_MS,
    tokenId: 'tok1',
    exitKind: 'stop_loss',
  });
  assert.equal(r.lossCooldownStarted, false);
  assert.equal(cb.isTripped(NOW_MS), false);
});

test('T34: CircuitBreaker — exitKind:null skips the cooldown (back-compat)', () => {
  // Existing callers pass only {pnlSats, tsMs, tokenId}. Must behave
  // exactly like before T34.
  const cb = new CircuitBreaker({ cfg: baseConfig(), now: () => NOW_MS });
  const r = cb.recordResult({ pnlSats: -1_000, tsMs: NOW_MS });
  assert.equal(r.lossCooldownStarted, false);
  assert.equal(cb.isTripped(NOW_MS), false);
});

test('T34: CircuitBreaker — cooldown expires after loss_cooldown_minutes', () => {
  const clock = clockFromFixedStart(NOW_MS);
  const cb = new CircuitBreaker({
    cfg: baseConfig({ risk: { loss_cooldown_minutes: 30 } }),
    now: clock.now,
  });
  cb.recordResult({ pnlSats: -1_000, tsMs: clock.now(), exitKind: 'stop_loss' });
  assert.equal(cb.isTripped(clock.now()), true);
  assert.equal(cb.tripKind(clock.now()), 'loss_cooldown');
  // 29 minutes later — still tripped.
  clock.advance(29 * 60_000);
  assert.equal(cb.isTripped(clock.now()), true);
  // 1 more minute → 30 minutes elapsed → cooldown expired.
  clock.advance(1 * 60_000);
  assert.equal(cb.isTripped(clock.now()), false);
  assert.equal(cb.tripKind(clock.now()), null);
});

test('T34: CircuitBreaker — loss_cooldown_minutes=0 disables the cooldown', () => {
  // resolveRiskConfig clamps 0 to default, so to test "disabled" we
  // must use a negative number (which is the documented opt-out).
  const cb = new CircuitBreaker({
    cfg: baseConfig({ risk: { loss_cooldown_minutes: -1 } }),
    now: () => NOW_MS,
  });
  const r = cb.recordResult({
    pnlSats: -1_000,
    tsMs: NOW_MS,
    exitKind: 'stop_loss',
  });
  assert.equal(r.lossCooldownStarted, false,
    'non-positive loss_cooldown_minutes must skip the cooldown');
  assert.equal(cb.isTripped(NOW_MS), false);
});

test('T34: CircuitBreaker — successive stop-losses refresh the cooldown timestamp', () => {
  const clock = clockFromFixedStart(NOW_MS);
  const cb = new CircuitBreaker({
    cfg: baseConfig({ risk: { loss_cooldown_minutes: 30 } }),
    now: clock.now,
  });
  cb.recordResult({ pnlSats: -1_000, tsMs: clock.now(), exitKind: 'stop_loss' });
  // 25 min later — another stop-loss. Cooldown must restart from 30m.
  clock.advance(25 * 60_000);
  cb.recordResult({ pnlSats: -1_000, tsMs: clock.now(), exitKind: 'stop_loss' });
  assert.equal(cb.isTripped(clock.now()), true);
  // 6 min after the second stop-loss (31 min total) — first stop-loss
  // would have expired, but the second one only has 24 min on the
  // clock, so we should still be tripped.
  clock.advance(6 * 60_000);
  assert.equal(cb.isTripped(clock.now()), true);
  // 25 more min → 55 min total since first, 31 min since second →
  // second cooldown expired.
  clock.advance(25 * 60_000);
  assert.equal(cb.isTripped(clock.now()), false);
});

test('T34: CircuitBreaker — evaluate() surfaces loss_cooldown with minutes-formatted reason', () => {
  const cb = new CircuitBreaker({
    cfg: baseConfig({ risk: { loss_cooldown_minutes: 30 } }),
    now: () => NOW_MS,
  });
  cb.recordResult({ pnlSats: -1_000, tsMs: NOW_MS, exitKind: 'stop_loss' });
  const ev = cb.evaluate({ nowMs: NOW_MS });
  assert.equal(ev.allow, false);
  assert.equal(ev.tripKind, 'loss_cooldown');
  assert.match(ev.reason, /loss_cooldown/);
  assert.match(ev.reason, /30m/);
  assert.equal(ev.cooldownRemainingMs, 30 * 60_000);
});

test('T34: CircuitBreaker — state() exposes stopLossCooldownTripTsMs + lossCooldownMinutes', () => {
  const cb = new CircuitBreaker({
    cfg: baseConfig({ risk: { loss_cooldown_minutes: 45 } }),
    now: () => NOW_MS,
  });
  let s = cb.state();
  assert.equal(s.stopLossCooldownTripTsMs, null);
  assert.equal(s.lossCooldownMinutes, 45);
  assert.equal(s.lossCooldownRemainingMs, 0);
  cb.recordResult({ pnlSats: -1_000, tsMs: NOW_MS, exitKind: 'stop_loss' });
  s = cb.state();
  assert.equal(s.stopLossCooldownTripTsMs, NOW_MS);
  assert.equal(s.lossCooldownRemainingMs, 45 * 60_000);
  assert.equal(s.isTripped, true);
  assert.equal(s.tripKind, 'loss_cooldown');
});

test('T34: CircuitBreaker — reset() clears the loss cooldown too', () => {
  const cb = new CircuitBreaker({
    cfg: baseConfig({ risk: { loss_cooldown_minutes: 30 } }),
    now: () => NOW_MS,
  });
  cb.recordResult({ pnlSats: -1_000, tsMs: NOW_MS, exitKind: 'stop_loss' });
  assert.equal(cb.isTripped(NOW_MS), true);
  const r = cb.reset({ reason: 'manual', tsMs: NOW_MS });
  assert.equal(r.wasTripped, true);
  assert.equal(r.previousTripKind, 'loss_cooldown');
  assert.equal(cb.isTripped(NOW_MS), false);
  // state() must show a null timestamp after reset.
  assert.equal(cb.state().stopLossCooldownTripTsMs, null);
});

test('T34: CircuitBreaker — loss_cooldown sits below daily_loss in priority', () => {
  // Construct a breaker with both a daily_loss trip AND a fresh
  // stop-loss cooldown. evaluate() should report daily_loss, not
  // loss_cooldown, because daily_loss is the harder trip.
  const clock = clockFromFixedStart(NOW_MS);
  const cb = new CircuitBreaker({
    cfg: baseConfig({
      risk: {
        loss_cooldown_minutes: 30,
        max_consecutive_losses: 99, // so the daily_loss trip doesn't get masked
      },
    }),
    now: clock.now,
  });
  // First a stop-loss to start the cooldown.
  cb.recordResult({ pnlSats: -1_000, tsMs: clock.now(), exitKind: 'stop_loss' });
  assert.equal(cb.tripKind(clock.now()), 'loss_cooldown');
  // Then a fat loss to trip daily_loss on top of it.
  clock.advance(60_000);
  cb.recordResult({ pnlSats: -550_000, tsMs: clock.now() });
  assert.equal(cb.tripKind(clock.now()), 'daily_loss');
  // Evaluate() must surface daily_loss, with the hour-formatted reason.
  const ev = cb.evaluate({ nowMs: clock.now() });
  assert.equal(ev.tripKind, 'daily_loss');
  assert.match(ev.reason, /daily_loss/);
  assert.match(ev.reason, /h cooldown/);
});

test('T34: CircuitBreaker — _internals exports lossCooldownRemainingMs', () => {
  assert.equal(typeof _internals.lossCooldownRemainingMs, 'function');
  assert.equal(_internals.lossCooldownRemainingMs(null, 30, NOW_MS), 0);
});

test('T34: GUARD — config/default.json includes loss_cooldown_minutes', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const cfgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../config/default.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  assert.equal(cfg.risk.loss_cooldown_minutes, 30,
    'config/default.json risk block must carry loss_cooldown_minutes=30');
});
