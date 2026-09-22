#!/usr/bin/env node
/**
 * Unit tests for src/strategy/exit.mjs.
 *
 * Pure-function tests. No I/O, no logger, no process state. Run via:
 *   npm test
 *
 * Covers:
 *   - resolveExitConfig: defaults + overrides + bad input
 *   - takeProfitPrice / stopLossPrice / trailingStopPrice math
 *   - timeStopCutoffMs: opens_at parsing + hours math
 *   - priceFromMarket / priceFromEntry / highWaterMarkFromPosition
 *   - shouldExit: every gate (TP / SL / trailing / time)
 *   - GUARD: every knob reads from config, never hard-coded literals
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_EXIT_CONFIG,
  resolveExitConfig,
  takeProfitPrice,
  stopLossPrice,
  trailingStopPrice,
  timeStopCutoffMs,
  priceFromMarket,
  priceFromEntry,
  highWaterMarkFromPosition,
  shouldExit,
} from '../src/strategy/exit.mjs';

// ────────────────────────────────────────────────────────────────────
//  Fixtures
// ────────────────────────────────────────────────────────────────────

const TOKEN_ID = 'b'.repeat(64);
const OPENED_AT = '2026-09-10T18:00:00Z';
const OPENED_MS = Date.parse(OPENED_AT); // 1757527200000

function baseConfig(overrides = {}) {
  return {
    exit: { ...DEFAULT_EXIT_CONFIG },
    ...overrides,
  };
}

function position(overrides = {}) {
  return {
    id: 'pos_test1234abcd',
    token_id: TOKEN_ID,
    status: 'open',
    entry: {
      txid: 'aa'.repeat(32),
      price_sats_per_token: 1000,
      bch_spent_sats: 500_000,
      token_amount_base: 500_000n.toString(),
      fee_sats: 200,
      ts: OPENED_AT,
    },
    opened_at: OPENED_AT,
    ...overrides,
  };
}

function market(overrides = {}) {
  return {
    token_id: TOKEN_ID,
    price_now_sats: 1050, // +5% → exactly at TP
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────
//  resolveExitConfig
// ────────────────────────────────────────────────────────────────────

test('resolveExitConfig: returns defaults on null/undefined/bad input', () => {
  for (const bad of [null, undefined, 0, 'string', [], NaN]) {
    const cfg = resolveExitConfig(bad);
    assert.equal(cfg.take_profit_pct, DEFAULT_EXIT_CONFIG.take_profit_pct);
    assert.equal(cfg.stop_loss_pct, DEFAULT_EXIT_CONFIG.stop_loss_pct);
    assert.equal(cfg.time_stop_hours, DEFAULT_EXIT_CONFIG.time_stop_hours);
    assert.equal(cfg.trailing_stop_pct, DEFAULT_EXIT_CONFIG.trailing_stop_pct);
    assert.equal(cfg.trailing_stop_activation_pct, DEFAULT_EXIT_CONFIG.trailing_stop_activation_pct);
  }
});

test('resolveExitConfig: accepts overrides', () => {
  const cfg = resolveExitConfig({
    take_profit_pct: 10,
    stop_loss_pct: 5,
    time_stop_hours: 12,
    trailing_stop_pct: 3,
    trailing_stop_activation_pct: 4,
  });
  assert.equal(cfg.take_profit_pct, 10);
  assert.equal(cfg.stop_loss_pct, 5);
  assert.equal(cfg.time_stop_hours, 12);
  assert.equal(cfg.trailing_stop_pct, 3);
  assert.equal(cfg.trailing_stop_activation_pct, 4);
});

test('resolveExitConfig: ignores non-numeric overrides', () => {
  const cfg = resolveExitConfig({ take_profit_pct: 'banana' });
  assert.equal(cfg.take_profit_pct, DEFAULT_EXIT_CONFIG.take_profit_pct);
});

// ────────────────────────────────────────────────────────────────────
//  Math helpers
// ────────────────────────────────────────────────────────────────────

test('takeProfitPrice: entry * (1 + pct/100)', () => {
  assert.equal(takeProfitPrice(1000, 5), 1050);
  assert.equal(takeProfitPrice(2000, 2.5), 2050);
});

test('takeProfitPrice: bad input → null', () => {
  assert.equal(takeProfitPrice(null, 5), null);
  assert.equal(takeProfitPrice(1000, NaN), null);
  assert.equal(takeProfitPrice(0, 5), null);
});

test('stopLossPrice: entry * (1 - pct/100)', () => {
  assert.equal(stopLossPrice(1000, 3), 970);
  assert.equal(stopLossPrice(2000, 1.5), 1970);
});

test('stopLossPrice: bad input → null', () => {
  assert.equal(stopLossPrice(null, 5), null);
  assert.equal(stopLossPrice(1000, -1), null);
  assert.equal(stopLossPrice(0, 5), null);
});

test('trailingStopPrice: hwm * (1 - pct/100)', () => {
  assert.equal(trailingStopPrice(1100, 2), 1078);
  assert.equal(trailingStopPrice(1050, 5), 997.5);
});

test('trailingStopPrice: bad input → null', () => {
  assert.equal(trailingStopPrice(null, 2), null);
  assert.equal(trailingStopPrice(0, 2), null);
  assert.equal(trailingStopPrice(1100, -1), null);
});

test('timeStopCutoffMs: opened + hours*3_600_000', () => {
  const cutoff = timeStopCutoffMs(OPENED_AT, 24);
  assert.equal(cutoff, OPENED_MS + 24 * 3_600_000);
});

test('timeStopCutoffMs: bad input → null', () => {
  assert.equal(timeStopCutoffMs(null, 24), null);
  assert.equal(timeStopCutoffMs('not-a-date', 24), null);
  assert.equal(timeStopCutoffMs(OPENED_AT, 0), null);
  assert.equal(timeStopCutoffMs(OPENED_AT, -1), null);
});

// ────────────────────────────────────────────────────────────────────
//  Price extraction helpers
// ────────────────────────────────────────────────────────────────────

test('priceFromMarket: returns price_now_sats when set', () => {
  assert.equal(priceFromMarket({ price_now_sats: 1234 }), 1234);
});

test('priceFromMarket: falls back to spotRateSatsPerToken', () => {
  assert.equal(priceFromMarket({ spotRateSatsPerToken: 4321 }), 4321);
});

test('priceFromMarket: falls back to sats/tokens (raw pool)', () => {
  assert.equal(priceFromMarket({ sats: 100_000, tokens: 100 }), 1000);
});

test('priceFromMarket: returns null on bad input', () => {
  assert.equal(priceFromMarket(null), null);
  assert.equal(priceFromMarket({}), null);
  assert.equal(priceFromMarket({ price_now_sats: 0 }), null);
  assert.equal(priceFromMarket({ price_now_sats: -1 }), null);
});

test('priceFromEntry: reads price_sats_per_token', () => {
  assert.equal(priceFromEntry(position()), 1000);
});

test('priceFromEntry: tolerates legacy alias entry_price_sats_per_token', () => {
  const p = position({ entry: { entry_price_sats_per_token: 2000 } });
  assert.equal(priceFromEntry(p), 2000);
});

test('priceFromEntry: bad input → null', () => {
  assert.equal(priceFromEntry(null), null);
  assert.equal(priceFromEntry({ entry: {} }), null);
  assert.equal(priceFromEntry({ entry: { price_sats_per_token: 0 } }), null);
});

test('highWaterMarkFromPosition: returns stored HWM', () => {
  assert.equal(highWaterMarkFromPosition(position({ high_water_mark_sats_per_token: '1500' })), 1500);
  assert.equal(highWaterMarkFromPosition(position({ high_water_mark_sats_per_token: 1500n })), 1500);
  assert.equal(highWaterMarkFromPosition(position({ high_water_mark_sats_per_token: 1500 })), 1500);
});

test('highWaterMarkFromPosition: falls back to entry price', () => {
  assert.equal(highWaterMarkFromPosition(position()), 1000);
});

test('highWaterMarkFromPosition: no entry price, no HWM → 0', () => {
  assert.equal(highWaterMarkFromPosition({ entry: {} }), 0);
});

// ────────────────────────────────────────────────────────────────────
//  shouldExit
// ────────────────────────────────────────────────────────────────────

test('shouldExit: take-profit fires when price >= entry * (1 + tp%)', () => {
  // entry 1000, TP 5% → fires at >=1050.
  const m = market({ price_now_sats: 1050 });
  const r = shouldExit(position(), m, baseConfig(), { nowMs: OPENED_MS + 1 * 3_600_000 });
  assert.equal(r.exit, true);
  assert.equal(r.kind, 'take_profit');
  assert.deepEqual(r.all_triggered, ['take_profit']);
});

test('shouldExit: take-profit above threshold fires too', () => {
  const m = market({ price_now_sats: 1100 });
  const r = shouldExit(position(), m, baseConfig(), { nowMs: OPENED_MS + 1 * 3_600_000 });
  assert.equal(r.exit, true);
  assert.equal(r.kind, 'take_profit');
});

test('shouldExit: stop-loss fires when price <= entry * (1 - sl%)', () => {
  // entry 1000, SL 3% → fires at <=970.
  const m = market({ price_now_sats: 970 });
  const r = shouldExit(position(), m, baseConfig(), { nowMs: OPENED_MS + 1 * 3_600_000 });
  assert.equal(r.exit, true);
  assert.equal(r.kind, 'stop_loss');
});

test('shouldExit: stop-loss priority over take-profit', () => {
  // Contrived: take_profit_pct=-5 (TP fires on price >= 950) AND
  // stop_loss_pct=4 (SL fires on price <= 960). At price=955 BOTH
  // fire — stop_loss has higher priority in our `kind` decision.
  const m = market({ price_now_sats: 955 });
  const p = position({ entry: { price_sats_per_token: 1000 } });
  const cfg = baseConfig({ exit: { take_profit_pct: -5, stop_loss_pct: 4 } });
  const r = shouldExit(p, m, cfg, { nowMs: OPENED_MS + 1 * 3_600_000 });
  assert.equal(r.exit, true);
  assert.equal(r.kind, 'stop_loss');
  assert.ok(r.all_triggered.includes('stop_loss'));
  assert.ok(r.all_triggered.includes('take_profit'));
});

test('shouldExit: trailing-stop fires only when armed', () => {
  // entry 1000, TP 5% → fires at >=1050. trailing activation 2% →
  // armed at >=1020. HWM 1100, trailing 2% → fires at <=1078.
  // To isolate the trailing-stop path, set take_profit_pct=0 (so
  // TP fires only when price >= entry, i.e. on any non-negative
  // move). With HWM = 1100 and current = 1100, both fire — but
  // the take-profit condition is `currentPrice >= tpPrice` where
  // tpPrice = entry * 1 = 1000. current = 1100 >= 1000 → TP fires.
  // To prevent TP, set take_profit_pct < trailing-activation so TP
  // fires only above the HWM. Actually simpler: take_profit_pct=20
  // (TP at 1200). Then at price=1078, TP doesn't fire.
  const p = position({ high_water_mark_sats_per_token: 1100n.toString() });
  const m = market({ price_now_sats: 1078 });
  const cfg = baseConfig({ exit: { take_profit_pct: 20 } });
  const r = shouldExit(p, m, cfg, { nowMs: OPENED_MS + 1 * 3_600_000 });
  assert.equal(r.exit, true);
  assert.equal(r.kind, 'trailing_stop');
  assert.equal(r.trailPriceSats, 1078);
});

test('shouldExit: trailing-stop NOT armed (price < activation threshold)', () => {
  // entry 1000, HWM = entry (no gain yet). trailing activation 2% → needs >=1020.
  // price = 1010 → below arm threshold → no fire.
  const p = position({ high_water_mark_sats_per_token: 1000 });
  const m = market({ price_now_sats: 1010 });
  const r = shouldExit(p, m, baseConfig(), { nowMs: OPENED_MS + 1 * 3_600_000 });
  assert.equal(r.exit, false);
});

test('shouldExit: trailing-stop updates proposed HWM when price rose', () => {
  // HWM = 1000 (entry), new price 1100 → proposedHwm = 1100.
  const p = position();
  const m = market({ price_now_sats: 1100 });
  const r = shouldExit(p, m, baseConfig(), { nowMs: OPENED_MS + 1 * 3_600_000 });
  assert.equal(r.snapshot.proposed_hwm_sats, 1100);
  assert.equal(r.newHighWaterMarkSats, 1100);
});

test('shouldExit: trailing-stop does NOT downgrade HWM', () => {
  // HWM = 1500, new price 1200 → proposedHwm stays 1500.
  const p = position({ high_water_mark_sats_per_token: 1500 });
  const m = market({ price_now_sats: 1200 });
  const r = shouldExit(p, m, baseConfig(), { nowMs: OPENED_MS + 1 * 3_600_000 });
  assert.equal(r.snapshot.proposed_hwm_sats, 1500);
});

test('shouldExit: time-stop fires when elapsed >= cutoff', () => {
  const m = market({ price_now_sats: 1000 }); // price flat, no TP/SL fire
  const r = shouldExit(position(), m, baseConfig(), { nowMs: OPENED_MS + 25 * 3_600_000 });
  assert.equal(r.exit, true);
  assert.equal(r.kind, 'time_stop');
});

test('shouldExit: time-stop NOT fired when elapsed < cutoff', () => {
  const m = market({ price_now_sats: 1000 });
  const r = shouldExit(position(), m, baseConfig(), { nowMs: OPENED_MS + 12 * 3_600_000 });
  assert.equal(r.exit, false);
});

test('shouldExit: no exit when all conditions are in-range and time not elapsed', () => {
  const m = market({ price_now_sats: 1010 }); // +1% → below TP, above SL, below arm
  const r = shouldExit(position(), m, baseConfig(), { nowMs: OPENED_MS + 1 * 3_600_000 });
  assert.equal(r.exit, false);
  assert.deepEqual(r.all_triggered, []);
});

test('shouldExit: missing market price → TP/SL/trailing skip, time-stop still fires', () => {
  // No price → TP / SL / trailing can't be evaluated. But the
  // time-stop check is price-agnostic — it only compares
  // nowMs against `opened_at + time_stop_hours`. So at +25h,
  // time-stop fires even with null price.
  const r = shouldExit(position(), { price_now_sats: null }, baseConfig(), { nowMs: OPENED_MS + 25 * 3_600_000 });
  assert.equal(r.exit, true);
  assert.equal(r.kind, 'time_stop');
  assert.ok(r.all_triggered.includes('time_stop'));
  assert.ok(!r.all_triggered.includes('take_profit'));
  assert.ok(!r.all_triggered.includes('stop_loss'));
  assert.ok(!r.all_triggered.includes('trailing_stop'));
});

test('shouldExit: bad input → no exit, no throw', () => {
  // Pin `nowMs` to 1h after open — well within the 24h time-stop
  // window — so the time-stop check can't fire spuriously (it's the
  // ONLY exit gate that doesn't require a market price). Without
  // this, the test drifts over time as the real `Date.now()`
  // crosses the position's 24h cutoff.
  const nowMs = OPENED_MS + 3_600_000;
  assert.equal(shouldExit(null, market(), baseConfig(), { nowMs }).exit, false);
  assert.equal(shouldExit(position(), null, baseConfig(), { nowMs }).exit, false);
  assert.equal(shouldExit(position(), market(), null, { nowMs }).exit, false);
});

test('shouldExit: snapshot block carries all thresholds for audit', () => {
  const r = shouldExit(position(), market(), baseConfig(), { nowMs: OPENED_MS + 1 * 3_600_000 });
  assert.equal(r.snapshot.thresholds.take_profit_pct, 5);
  assert.equal(r.snapshot.thresholds.stop_loss_pct, 3);
  assert.equal(r.snapshot.thresholds.trailing_stop_pct, 2);
  assert.equal(r.snapshot.thresholds.trailing_stop_activation_pct, 2);
  assert.equal(r.snapshot.thresholds.time_stop_hours, 24);
});

// ────────────────────────────────────────────────────────────────────
//  GUARD: knobs come from config, not hard-coded
// ────────────────────────────────────────────────────────────────────

test('GUARD: take_profit_pct=1 fires earlier', () => {
  // entry 1000, TP 1% → fires at >=1010.
  const r = shouldExit(
    position(),
    market({ price_now_sats: 1010 }),
    baseConfig({ exit: { take_profit_pct: 1 } }),
    { nowMs: OPENED_MS + 1 * 3_600_000 },
  );
  assert.equal(r.exit, true);
  assert.equal(r.kind, 'take_profit');
});

test('GUARD: stop_loss_pct=10 fires later', () => {
  // entry 1000, SL 10% → fires at <=900. 970 → no fire.
  const r = shouldExit(
    position(),
    market({ price_now_sats: 970 }),
    baseConfig({ exit: { stop_loss_pct: 10 } }),
    { nowMs: OPENED_MS + 1 * 3_600_000 },
  );
  assert.equal(r.exit, false);
});

test('GUARD: time_stop_hours=1 fires after 1 hour', () => {
  const r = shouldExit(
    position(),
    market({ price_now_sats: 1000 }),
    baseConfig({ exit: { time_stop_hours: 1 } }),
    { nowMs: OPENED_MS + 2 * 3_600_000 },
  );
  assert.equal(r.exit, true);
  assert.equal(r.kind, 'time_stop');
});

test('GUARD: trailing_stop_pct=10 with HWM=1100 fires when price falls to trail', () => {
  // entry=1000, HWM=1100, trailing activation=1% (arm at >=1010).
  // trailing stop=10% (trailPrice = 1100 * 0.9 = 990).
  // Tighten take_profit to 999% so TP doesn't fire. Now at
  // current=1000: 1000 >= 1010? No — not armed. At current=1050:
  // armed (1050 >= 1010) AND current <= trail (1050 <= 990)? No.
  // Need current >= arm AND current <= trail. With HWM=1100,
  // arm=1010, trail=990, those never co-occur.
  //
  // Simpler: drop the HWM lower so arm <= trail. HWM=1010 (just
  // above arm 1010), trail=1010*0.9=909. At current=909, both
  // arm (909 >= 1010? No) and trail conditions need to hold.
  //
  // Final: use a position HWM well above the activation. HWM=1500,
  // activation=1% (arm at >=1010), trailing_stop=20% (trail=1200).
  // At current=1100: arm (1100 >= 1010) ✓ AND trail (1100 <= 1200) ✓.
  const p = position({ high_water_mark_sats_per_token: 1500 });
  const r = shouldExit(
    p,
    market({ price_now_sats: 1100 }),
    baseConfig({ exit: { trailing_stop_pct: 20, trailing_stop_activation_pct: 1, take_profit_pct: 999 } }),
    { nowMs: OPENED_MS + 1 * 3_600_000 },
  );
  assert.equal(r.exit, true);
  assert.equal(r.kind, 'trailing_stop');
  // trail = 1500 * (1 - 20/100) = 1200
  assert.equal(r.trailPriceSats, 1200);
});

test('GUARD: defaults file (config/default.json) exit block is honored', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const cfgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../config/default.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  assert.equal(cfg.exit.take_profit_pct, 5.0);
  assert.equal(cfg.exit.stop_loss_pct, 3.0);
  assert.equal(cfg.exit.time_stop_hours, 24);

  // TP fires at +5%: 1050 >= 1050.
  const r = shouldExit(position(), market({ price_now_sats: 1050 }), cfg, { nowMs: OPENED_MS + 1 * 3_600_000 });
  assert.equal(r.exit, true);
  assert.equal(r.kind, 'take_profit');
});



// ─────────────────────────────────────────────────────────────────────
//  T28b: chain-synced positions (unknown entry price)
//
// Without an entry price, take-profit / stop-loss / trailing-stop
// all compute to null and the position gets stuck on `no_exit_condition`
// until the 24h time-stop fires (by which point the AMM has usually
// drifted well past anything salvageable). Fix:
//   - Use the HWM as the entry-price proxy — lets the regular 5%/3%/2%
//     thresholds fire on chain-synced positions too.
//   - Chain-synced positions get a SHORTER time-stop
//     (`time_stop_hours_synced`, default 6h) so they don't sit forever.


// ─────────────────────────────────────────────────────────────────────

function syncedPosition(overrides = {}) {
  return {
    id: 'pos_synced01',
    token_id: TOKEN_ID,
    status: 'open',
    opened_at: OPENED_AT,
    entry: {
      txid: 'bb'.repeat(32),
      price_sats_per_token: 0,   // <-- chain-synced: unknown
      bch_spent_sats: 0,
      token_amount_base: '6000',
      source: 'on-chain-sync',
    },
    high_water_mark_sats_per_token: '35',  // token is at 35 sats/token per the indexer
    ...overrides,
  };
}

test('T28b: chain-synced position with HWM=35 and price=36.75 take-profits', () => {
  const r = shouldExit(
    syncedPosition(),
    market({ price_now_sats: 36.75 }),
    baseConfig(),
    { nowMs: OPENED_MS + 1 * 3_600_000 },
  );
  assert.equal(r.exit, true);
  assert.equal(r.kind, 'take_profit');
  assert.ok(r.reason.includes('take-profit'));
  assert.ok(r.reason.includes('HWM as entry-price proxy'),
    `reason should annotate the proxy: ${r.reason}`);
  // Snapshot carries the unknown flag + position source for audit.
  assert.equal(r.snapshot.entry_price_unknown, true);
  assert.equal(r.snapshot.position_source, 'on-chain-sync');
});

test('T28b: chain-synced position with price below HWM stops out via HWM*0.97', () => {
  // HWM=35, sl=35*0.97=33.95; price 33.9 → stop-loss
  const r = shouldExit(
    syncedPosition(),
    market({ price_now_sats: 33.9 }),
    baseConfig(),
    { nowMs: OPENED_MS + 1 * 3_600_000 },
  );
  assert.equal(r.exit, true);
  assert.equal(r.kind, 'stop_loss');
  assert.ok(r.reason.includes('HWM as entry-price proxy'));
});

test('T28b: chain-synced position time-stop fires after time_stop_hours_synced (not the 24h default)', () => {
  // 6h after open (chain-synced default = 6h) → time-stop fires.
  const r = shouldExit(
    syncedPosition(),
    market({ price_now_sats: 35 }),   // exactly at HWM, no TP/SL/trail
    baseConfig(),
    { nowMs: OPENED_MS + 6 * 3_600_000 + 1_000 },
  );
  assert.equal(r.exit, true);
  assert.equal(r.kind, 'time_stop');
  // Time-stop hours should be the synced value (6), not the default (24).
  assert.equal(r.snapshot.thresholds.time_stop_hours_synced, 6);
});

test('T28b: chain-synced position does NOT fire 24h time-stop when only 12h elapsed', () => {
  const r = shouldExit(
    syncedPosition(),
    market({ price_now_sats: 35 }),
    baseConfig(),
    { nowMs: OPENED_MS + 12 * 3_600_000 },
  );
  // With the synced 6h time-stop, this SHOULD fire — that's the fix.
  assert.equal(r.exit, true, `expected time-stop to fire at 12h; got: ${JSON.stringify(r)}`);
  assert.equal(r.kind, 'time_stop');
});

test('T28b: regular (non-synced) position still uses 24h time-stop', () => {
  // Same scenario but the position was opened by the bot (source
  // missing), so the regular 24h time-stop applies.
  const r = shouldExit(
    position(),
    market({ price_now_sats: 1000 }),  // exactly at entry; no TP/SL/trail
    baseConfig(),
    { nowMs: OPENED_MS + 23 * 3_600_000 },  // 23h elapsed
  );
  assert.equal(r.exit, false,
    `expected no exit at 23h; got: ${JSON.stringify(r)}`);
  // At 25h, the regular 24h time-stop fires.
  const r2 = shouldExit(
    position(),
    market({ price_now_sats: 1000 }),
    baseConfig(),
    { nowMs: OPENED_MS + 25 * 3_600_000 },
  );
  assert.equal(r2.exit, true);
  assert.equal(r2.kind, 'time_stop');
  // Snapshot shows the regular time_stop_hours (24), not synced (6).
  assert.equal(r2.snapshot.thresholds.time_stop_hours, 24);
});

test('T28b: configurable time_stop_hours_synced knob is honored', () => {
  // Override to 2h. At 1h elapsed: no fire. At 3h elapsed: fires.
  const cfg = baseConfig({ exit: { time_stop_hours_synced: 2 } });
  const r1 = shouldExit(syncedPosition(), market({ price_now_sats: 35 }), cfg, {
    nowMs: OPENED_MS + 1 * 3_600_000,
  });
  assert.equal(r1.exit, false);
  const r2 = shouldExit(syncedPosition(), market({ price_now_sats: 35 }), cfg, {
    nowMs: OPENED_MS + 3 * 3_600_000,
  });
  assert.equal(r2.exit, true);
  assert.equal(r2.kind, 'time_stop');
});

test('T28b: chain-synced position with no HWM still eventually time-stops (no zombie positions)', () => {
  // Edge case: synced position has neither entry price NOR HWM.
  // take-profit/stop-loss/trailing all compute null, but the synced
  // time-stop still fires — bot never gets stuck.
  const orphan = syncedPosition({ high_water_mark_sats_per_token: null });
  const r = shouldExit(orphan, market({ price_now_sats: 35 }), baseConfig(), {
    nowMs: OPENED_MS + 7 * 3_600_000,
  });
  assert.equal(r.exit, true);
  assert.equal(r.kind, 'time_stop');
  assert.equal(r.snapshot.entry_price_unknown, true);
});

test('T28b: time-stop reason string reflects actual hours used (not 24h default)', () => {
  // Chain-synced → cutoff is 6h, not 24h. The audit reason must
  // say "6h elapsed" (the actual value), not "24h elapsed" (the
  // misleading default). This is the "dead-arg cleanup" — the
  // describeTrigger receives the actual hours, not the cfg default.
  const r = shouldExit(
    syncedPosition(),
    market({ price_now_sats: 35 }),
    baseConfig(),
    { nowMs: OPENED_MS + 7 * 3_600_000 },
  );
  assert.equal(r.exit, true);
  assert.equal(r.kind, 'time_stop');
  assert.ok(r.reason.includes('6h elapsed'),
    `reason should report 6h, got: ${r.reason}`);
  assert.ok(!r.reason.includes('24h elapsed'),
    `reason should NOT report 24h for a synced position; got: ${r.reason}`);
});

test('T28b: regular (bot-opened) position time-stop reason still says 24h', () => {
  // Bot-opened position with 25h elapsed → time-stop fires with
  // the regular 24h reporting. No regression.
  const r = shouldExit(
    position(),
    market({ price_now_sats: 1000 }),
    baseConfig(),
    { nowMs: OPENED_MS + 25 * 3_600_000 },
  );
  assert.equal(r.exit, true);
  assert.equal(r.kind, 'time_stop');
  assert.ok(r.reason.includes('24h elapsed'),
    `expected 24h in reason; got: ${r.reason}`);
});



// ─────────────────────────────────────────────────────────────────────
//  T28d: paranoid price-vs-entry sanity check.
//
// Real-world reproduction: QBTC (Quantum Bitcoin) on 2026-09-14.
// Indexer reported price_now_sats = 32,668,282,406 (~326 BCH/token).
// Actual AMM rate was 326 sats/token — 100,000,000x off. Without
// T28d, the bogus indexer price wrote a 32.7B HWM into the position,
// then take-profit triggered every tick on the crazy indexer price
// and the pre-flight slippage check rejected each attempt (real
// AMM rate was way below the trail). exit_failed spam every minute
// until the 24h time-stop finally fired.
//
// T28d: if the indexer price is > max_price_vs_entry_ratio_x times
// the entry price (or < 1/x of it), reject it as bogus and let the
// position fall through to time-stop only.


// ─────────────────────────────────────────────────────────────────────

test('T28d: indexer price 100,000,000x above entry → rejected, no TP/SL/trail', () => {
  // QBTC reproduction: entry 327, bogus indexer 32.7B (100M ratio).
  // Default max_price_vs_entry_ratio_x = 1000 → reject.
  // No exit at 23h elapsed → only time-stop would fire at 24h.
  const r = shouldExit(
    position({ price_sats_per_token: 327 }),
    market({ price_now_sats: 32_668_282_406 }),
    baseConfig(),
    { nowMs: OPENED_MS + 23 * 3_600_000 },
  );
  assert.equal(r.exit, false,
    `expected no exit at 23h with rejected price; got: ${JSON.stringify(r)}`);
  assert.equal(r.snapshot.current_price_rejected, 1);
  assert.equal(r.snapshot.effective_current_price_sats, null);
  // HWM proposal should be the prev HWM (not the bogus price).
  assert.equal(r.newHighWaterMarkSats, undefined,
    'shouldExit must NOT propose an HWM update when price was rejected');
});

test('T28d: rejected price + time-stop elapsed → still time-stop fires', () => {
  const r = shouldExit(
    position({ price_sats_per_token: 327 }),
    market({ price_now_sats: 32_668_282_406 }),
    baseConfig(),
    { nowMs: OPENED_MS + 25 * 3_600_000 },
  );
  assert.equal(r.exit, true);
  assert.equal(r.kind, 'time_stop');
  assert.equal(r.snapshot.current_price_rejected, 1);
});

test('T28d: indexer price 10x above entry → still rejected (within 1000x cap)', () => {
  // 10x > 1000x default ratio? No, 10x < 1000x → NOT rejected.
  // This test confirms the default cap is high enough to allow
  // legitimate pumps.
  const r = shouldExit(
    position({ price_sats_per_token: 1000 }),
    market({ price_now_sats: 10_000 }),  // 10x
    baseConfig(),
    { nowMs: OPENED_MS + 1 * 3_600_000 },
  );
  assert.equal(r.snapshot.current_price_rejected, 0,
    '10x pump should NOT trigger T28d rejection (within 1000x cap)');
  // Take-profit fires (price >= 1050).
  assert.equal(r.exit, true);
  assert.equal(r.kind, 'take_profit');
});

test('T28d: indexer price 2000x above entry → rejected (exceeds 1000x cap)', () => {
  const r = shouldExit(
    position({ price_sats_per_token: 1000 }),
    market({ price_now_sats: 2_000_000 }),  // 2000x
    baseConfig(),
    { nowMs: OPENED_MS + 1 * 3_600_000 },
  );
  assert.equal(r.snapshot.current_price_rejected, 1);
  assert.equal(r.exit, false,
    `expected no exit with rejected price at 1h; got: ${JSON.stringify(r)}`);
});

test('T28d: indexer price 0.00001x below entry → rejected (1000x down too)', () => {
  const r = shouldExit(
    position({ entry: { price_sats_per_token: 1_000_000 } }),
    market({ price_now_sats: 10 }),  // 100,000x down
    baseConfig(),
    { nowMs: OPENED_MS + 1 * 3_600_000 },
  );
  assert.equal(r.snapshot.current_price_rejected, 1);
});

test('T28d: configurable max_price_vs_entry_ratio_x knob is honored', () => {
  // Override to 10x. A 20x indexer spike should now be rejected.
  // baseConfig replaces `exit` wholesale, so spread the defaults in
  // and only override the one knob.
  const cfg = baseConfig({
    exit: { ...DEFAULT_EXIT_CONFIG, max_price_vs_entry_ratio_x: 10 },
  });
  const r = shouldExit(
    position({ entry: { price_sats_per_token: 1000 } }),
    market({ price_now_sats: 20_000 }),
    cfg,
    { nowMs: OPENED_MS + 1 * 3_600_000 },
  );
  assert.equal(r.snapshot.current_price_rejected, 1);
  assert.equal(r.exit, false);
});

test('T28d: chain-synced position (no entry price) → sanity check skipped, normal behavior', () => {
  // Synced positions use HWM as the entry proxy. With no real entry
  // price, the sanity check has nothing to compare against. Should
  // fall through to the regular HWM-based thresholds. No regression.
  const r = shouldExit(
    syncedPosition({ high_water_mark_sats_per_token: 35 }),
    market({ price_now_sats: 36.75 }),
    baseConfig(),
    { nowMs: OPENED_MS + 1 * 3_600_000 },
  );
  assert.equal(r.snapshot.current_price_rejected, 0);
  assert.equal(r.exit, true);
  assert.equal(r.kind, 'take_profit');
});
// ────────────────────────────────────────────────────────────────────
//  T38: dynamic TP/SL from 7d realized volatility
// ────────────────────────────────────────────────────────────────────

test('T38: resolveExitConfig surfaces new T38 knobs', () => {
  const cfg = resolveExitConfig({
    tp_vol_multiplier: 3.0,
    sl_vol_multiplier: 1.5,
    tp_vol_floor_pct: 4.0,
    tp_vol_ceiling_pct: 60.0,
    sl_vol_floor_pct: 2.0,
    sl_vol_ceiling_pct: 30.0,
  });
  assert.equal(cfg.tp_vol_multiplier, 3.0);
  assert.equal(cfg.sl_vol_multiplier, 1.5);
  assert.equal(cfg.tp_vol_floor_pct, 4.0);
  assert.equal(cfg.tp_vol_ceiling_pct, 60.0);
  assert.equal(cfg.sl_vol_floor_pct, 2.0);
  assert.equal(cfg.sl_vol_ceiling_pct, 30.0);
});

test('T38: resolveExitConfig defaults surface in DEFAULT_EXIT_CONFIG', () => {
  assert.equal(DEFAULT_EXIT_CONFIG.tp_vol_multiplier, 2.0);
  assert.equal(DEFAULT_EXIT_CONFIG.sl_vol_multiplier, 1.0);
  assert.equal(DEFAULT_EXIT_CONFIG.tp_vol_floor_pct, 2.0);
  assert.equal(DEFAULT_EXIT_CONFIG.tp_vol_ceiling_pct, 80.0);
  assert.equal(DEFAULT_EXIT_CONFIG.sl_vol_floor_pct, 1.0);
  assert.equal(DEFAULT_EXIT_CONFIG.sl_vol_ceiling_pct, 50.0);
});

test('T38: shouldExit falls back to fixed TP/SL when no series supplied', () => {
  // The default 5%/3% applies — TP fires at >= 1050.
  const m = market({ price_now_sats: 1050 });
  const r = shouldExit(position(), m, baseConfig(), { nowMs: OPENED_MS + 1 * 3_600_000 });
  assert.equal(r.exit, true);
  assert.equal(r.kind, 'take_profit');
  assert.equal(r.snapshot.thresholds.effective_take_profit_pct, 5.0);
  assert.equal(r.snapshot.thresholds.effective_stop_loss_pct, 3.0);
  assert.equal(r.snapshot.thresholds.dynamic_daily_vol_pct, null);
});

test('T38: high-vol series widens TP/SL thresholds', () => {
  // Build a FEW-like series: ±0.09 oscillation around 0.5.
  // daily_vol_pct should be ~18% (well above the small-balance 5%/3%
  // defaults), so TP at +2σ = ~36%, SL at -1σ = ~18%.
  const series = [];
  for (let i = 0; i < 29; i++) {
    series.push(0.5 + 0.09 * Math.sin(i * 0.7));
  }
  // Entry 1000, current price at +10% (1100) — should NOT trigger TP
  // under the new 36% threshold (the OLD 5% threshold would have).
  const m = market({ price_now_sats: 1100, price_series_7d: series });
  const r = shouldExit(position(), m, baseConfig(), {
    nowMs: OPENED_MS + 1 * 3_600_000,
    priceSeries7d: series,
  });
  // 1100 is well below the dynamic TP price (~1360), so no exit.
  assert.equal(r.exit, false);
  // And the effective TP/SL percentages in the snapshot reflect the
  // dynamic computation.
  assert.ok(r.snapshot.thresholds.effective_take_profit_pct > 5.0);
  assert.ok(r.snapshot.thresholds.effective_stop_loss_pct > 3.0);
  assert.ok(r.snapshot.thresholds.dynamic_daily_vol_pct !== null);
});

test('T38: high-vol series TP fires at the dynamic threshold, not the fixed one', () => {
  // Same high-vol series. Set price at +50% (1500) — well above the
  // dynamic TP (~36%) → TP fires.
  const series = [];
  for (let i = 0; i < 29; i++) {
    series.push(0.5 + 0.09 * Math.sin(i * 0.7));
  }
  const m = market({ price_now_sats: 1500, price_series_7d: series });
  const r = shouldExit(position(), m, baseConfig(), {
    nowMs: OPENED_MS + 1 * 3_600_000,
    priceSeries7d: series,
  });
  assert.equal(r.exit, true);
  assert.equal(r.kind, 'take_profit');
  assert.ok(r.snapshot.thresholds.effective_take_profit_pct > 5.0);
});

test('T38: low-vol series tightens TP/SL below the fixed defaults', () => {
  // QBTC-like: ±0.001 oscillation around 1.0 → daily_vol_pct ~0.2%.
  // dynamic_tp = 0.2 * 2 = 0.4% → clamped to the 2% floor.
  // dynamic_sl = 0.2 * 1 = 0.2% → clamped to the 1% floor.
  const series = [];
  for (let i = 0; i < 29; i++) {
    series.push(1.0 + 0.001 * Math.sin(i * 0.3));
  }
  // Entry 1000. At +3% price (1030), the OLD 5% TP wouldn't fire,
  // but the new dynamic 2%-floor TP DOES fire.
  const m = market({ price_now_sats: 1030, price_series_7d: series });
  const r = shouldExit(position(), m, baseConfig(), {
    nowMs: OPENED_MS + 1 * 3_600_000,
    priceSeries7d: series,
  });
  assert.equal(r.exit, true);
  assert.equal(r.kind, 'take_profit');
  // Effective TP = floor (2%), not the fixed 5%.
  assert.equal(r.snapshot.thresholds.effective_take_profit_pct, 2.0);
});

test('T38: SL fires at dynamic threshold for low-vol token', () => {
  // QBTC-like series. Drop price to -2% (980) → dynamic SL floor (1%) fires.
  const series = [];
  for (let i = 0; i < 29; i++) {
    series.push(1.0 + 0.001 * Math.sin(i * 0.3));
  }
  const m = market({ price_now_sats: 980, price_series_7d: series });
  const r = shouldExit(position(), m, baseConfig(), {
    nowMs: OPENED_MS + 1 * 3_600_000,
    priceSeries7d: series,
  });
  assert.equal(r.exit, true);
  assert.equal(r.kind, 'stop_loss');
  assert.equal(r.snapshot.thresholds.effective_stop_loss_pct, 1.0);
});

test('T38: priceSeries7d opt takes priority over market.price_series_7d', () => {
  // The opts.priceSeries7d value should be used in preference to
  // market.price_series_7d — explicit caller wins over ambient data.
  const optSeries = [];
  for (let i = 0; i < 29; i++) {
    optSeries.push(1.0 + 0.001 * Math.sin(i * 0.3)); // low-vol
  }
  const marketSeries = [];
  for (let i = 0; i < 29; i++) {
    marketSeries.push(0.5 + 0.09 * Math.sin(i * 0.7)); // high-vol
  }
  const m = market({ price_now_sats: 1030, price_series_7d: marketSeries });
  const r = shouldExit(position(), m, baseConfig(), {
    nowMs: OPENED_MS + 1 * 3_600_000,
    priceSeries7d: optSeries,
  });
  // The opt series is low-vol → dynamic TP at floor (2%) → 1030 fires.
  assert.equal(r.exit, true);
  assert.equal(r.kind, 'take_profit');
  assert.equal(r.snapshot.thresholds.effective_take_profit_pct, 2.0);
});

test('T38: too-short series → falls back to fixed TP/SL', () => {
  // A 1-point series is too short to compute returns.
  const m = market({ price_now_sats: 1050, price_series_7d: [1.0] });
  const r = shouldExit(position(), m, baseConfig(), {
    nowMs: OPENED_MS + 1 * 3_600_000,
    priceSeries7d: [1.0],
  });
  // 1050 >= 1050 (fixed TP at 5%) → TP fires using fixed threshold.
  assert.equal(r.exit, true);
  assert.equal(r.kind, 'take_profit');
  assert.equal(r.snapshot.thresholds.effective_take_profit_pct, 5.0);
});

test('T38: tp_vol_multiplier=0 (opt-out) → falls back to fixed TP', () => {
  const series = [];
  for (let i = 0; i < 29; i++) {
    series.push(0.5 + 0.09 * Math.sin(i * 0.7));
  }
  const cfg = baseConfig({
    exit: { ...DEFAULT_EXIT_CONFIG, tp_vol_multiplier: 0 },
  });
  const m = market({ price_now_sats: 1050, price_series_7d: series });
  const r = shouldExit(position(), m, cfg, {
    nowMs: OPENED_MS + 1 * 3_600_000,
    priceSeries7d: series,
  });
  // TP mult 0 → dynamicPcts.tp is null → falls back to fixed 5%.
  // 1050 >= 1050 → fires.
  assert.equal(r.exit, true);
  assert.equal(r.kind, 'take_profit');
  assert.equal(r.snapshot.thresholds.effective_take_profit_pct, 5.0);
});

test('T38: sl_vol_multiplier=0 (opt-out) → falls back to fixed SL', () => {
  const series = [];
  for (let i = 0; i < 29; i++) {
    series.push(0.5 + 0.09 * Math.sin(i * 0.7));
  }
  const cfg = baseConfig({
    exit: { ...DEFAULT_EXIT_CONFIG, sl_vol_multiplier: 0 },
  });
  const m = market({ price_now_sats: 970, price_series_7d: series });
  const r = shouldExit(position(), m, cfg, {
    nowMs: OPENED_MS + 1 * 3_600_000,
    priceSeries7d: series,
  });
  // SL mult 0 → dynamicPcts.sl is null → falls back to fixed 3%.
  // 970 <= 970 → fires.
  assert.equal(r.exit, true);
  assert.equal(r.kind, 'stop_loss');
  assert.equal(r.snapshot.thresholds.effective_stop_loss_pct, 3.0);
});

test('T38: snapshot records all dynamic state for audit', () => {
  const series = [];
  for (let i = 0; i < 29; i++) {
    series.push(0.5 + 0.09 * Math.sin(i * 0.7));
  }
  const m = market({ price_now_sats: 1100, price_series_7d: series });
  const r = shouldExit(position(), m, baseConfig(), {
    nowMs: OPENED_MS + 1 * 3_600_000,
    priceSeries7d: series,
  });
  // No exit at 1100, but the snapshot still records every T38 field.
  assert.equal(r.exit, false);
  const t = r.snapshot.thresholds;
  assert.equal(typeof t.tp_vol_multiplier, 'number');
  assert.equal(typeof t.sl_vol_multiplier, 'number');
  assert.equal(typeof t.tp_vol_floor_pct, 'number');
  assert.equal(typeof t.tp_vol_ceiling_pct, 'number');
  assert.equal(typeof t.sl_vol_floor_pct, 'number');
  assert.equal(typeof t.sl_vol_ceiling_pct, 'number');
  assert.ok(t.dynamic_daily_vol_pct !== null);
  assert.ok(t.dynamic_step_std !== null);
  assert.equal(t.dynamic_return_count, 28);
  assert.ok(t.effective_take_profit_pct > 0);
  assert.ok(t.effective_stop_loss_pct > 0);
});

test('T38: ceiling clamping prevents runaway TP for crazy-high vol', () => {
  // Build an extreme series. With ±0.5 oscillation around 0.5, daily
  // vol should be in the 90%+ range → dynamic TP would be ~180% if
  // uncapped → clamped to the 80% ceiling.
  const series = [];
  for (let i = 0; i < 29; i++) {
    series.push(0.5 + 0.5 * Math.sin(i * 0.5));
  }
  const m = market({ price_now_sats: 1100, price_series_7d: series });
  const r = shouldExit(position(), m, baseConfig(), {
    nowMs: OPENED_MS + 1 * 3_600_000,
    priceSeries7d: series,
  });
  assert.equal(r.snapshot.thresholds.effective_take_profit_pct, 80.0);
});

test('T38: GUARD — every dynamic TP/SL knob is from cfg, not hard-coded', () => {
  // Override every T38 knob via the config, verify they all flow
  // through into the effective thresholds.
  const cfg = baseConfig({
    exit: {
      ...DEFAULT_EXIT_CONFIG,
      tp_vol_multiplier: 4.0,
      sl_vol_multiplier: 2.0,
      tp_vol_floor_pct: 5.0,
      tp_vol_ceiling_pct: 50.0,
      sl_vol_floor_pct: 3.0,
      sl_vol_ceiling_pct: 25.0,
    },
  });
  const series = [];
  for (let i = 0; i < 29; i++) {
    series.push(0.5 + 0.05 * Math.sin(i * 0.5));
  }
  const m = market({ price_now_sats: 1100, price_series_7d: series });
  const r = shouldExit(position(), m, cfg, {
    nowMs: OPENED_MS + 1 * 3_600_000,
    priceSeries7d: series,
  });
  const t = r.snapshot.thresholds;
  assert.equal(t.tp_vol_multiplier, 4.0);
  assert.equal(t.sl_vol_multiplier, 2.0);
  assert.equal(t.tp_vol_floor_pct, 5.0);
  assert.equal(t.tp_vol_ceiling_pct, 50.0);
  assert.equal(t.sl_vol_floor_pct, 3.0);
  assert.equal(t.sl_vol_ceiling_pct, 25.0);
});

// ───────────────────────────────────────────────────────────────────
//  T43: evaluateProfitFloor — profit-floor gate
//
// The FURU pos_tldpyjk1_0005 close on 2026-09-16 closed at +368 sats
// (price only moved +1% in 24h, the regular TP/SL/trailing-stop
// never fired). The bot wanted 3000+ sats but had no floor gate;
// this test pins the new helper so the same kind of under-floor
// exit triggers a single-shot time-stop extension instead.
// ───────────────────────────────────────────────────────────────────

import { evaluateProfitFloor } from '../src/strategy/exit.mjs';

const profitFloorConfig = () => ({
  exit: {
    take_profit_pct: 5.0,
    stop_loss_pct: 3.0,
    time_stop_hours: 24,
    time_stop_hours_synced: 6,
    trailing_stop_pct: 2.0,
    trailing_stop_activation_pct: 2.0,
    max_price_vs_entry_ratio_x: 1000,
    tp_vol_multiplier: 2.0,
    sl_vol_multiplier: 1.0,
    tp_vol_floor_pct: 2.0,
    tp_vol_ceiling_pct: 80.0,
    sl_vol_floor_pct: 1.0,
    sl_vol_ceiling_pct: 50.0,
    min_realized_pnl_sats: 3000,
    time_stop_extension_hours: 6,
    min_realized_pnl_enabled: true,
  },
});

const profitFloorPos = (overrides = {}) => ({
  id: 'pos_test',
  token_id: '7fa887fd4eac015478b95392c4984721fbe3060223c30b342d43cc06817f07f6',
  opened_at: '2026-09-15T00:00:00.000Z',
  entry: {
    price_sats_per_token: 400,
    token_amount_base: '1282',
    bch_spent_sats: '496873',
    fee_sats: '2285',
    ...(overrides.entry || {}),
  },
  ...overrides,
});

test('T43: evaluateProfitFloor: returns null when min_realized_pnl_enabled is false', () => {
  const cfg = profitFloorConfig();
  cfg.exit.min_realized_pnl_enabled = false;
  assert.equal(evaluateProfitFloor(profitFloorPos(), 410, cfg, { nowMs: Date.parse('2026-09-15T01:00:00Z') }), null);
});

test('T43: evaluateProfitFloor: returns null when floor is 0 (disabled)', () => {
  const cfg = profitFloorConfig();
  cfg.exit.min_realized_pnl_sats = 0;
  assert.equal(evaluateProfitFloor(profitFloorPos(), 410, cfg), null);
});

test('T43: evaluateProfitFloor: returns null when floor is negative (config bug)', () => {
  const cfg = profitFloorConfig();
  cfg.exit.min_realized_pnl_sats = -100;
  assert.equal(evaluateProfitFloor(profitFloorPos(), 410, cfg), null);
});

test('T43: evaluateProfitFloor: returns null when current price is missing', () => {
  // currentPriceSats = null/missing → no price evidence → no extension.
  assert.equal(evaluateProfitFloor(profitFloorPos(), null, profitFloorConfig()), null);
  assert.equal(evaluateProfitFloor(profitFloorPos(), 0, profitFloorConfig()), null);
  assert.equal(evaluateProfitFloor(profitFloorPos(), NaN, profitFloorConfig()), null);
});

test('T43: evaluateProfitFloor: returns null for negative projected P&L (losing positions still close)', () => {
  // Current price 350 → 350/400 - 1 = -12.5% price drop.
  // Projected P&L ≈ -12.5% × 496873 - 2285 (entry fee) ≈ -64,394 sats.
  // Below the 3000-sat floor, but losing → no extension; close anyway.
  const result = evaluateProfitFloor(profitFloorPos(), 350, profitFloorConfig());
  assert.equal(result, null);
});

test('T43: evaluateProfitFloor: returns null when projected P&L meets the floor', () => {
  // Current price 410 → +2.5% price move. Position cost 496,873 sats,
  // so projected gross = 0.025 × 496,873 = +12,422 sats. After entry
  // fee 2,285 → +10,137 sats net. Above the 3000 floor → no extension.
  const result = evaluateProfitFloor(profitFloorPos(), 410, profitFloorConfig());
  assert.equal(result, null);
});

test('T43: evaluateProfitFloor: returns extension when projected P&L is positive but below floor', () => {
  // The FURU scenario: position cost 496,873 sats, current price 404
  // → +1% price move. Projected gross = 0.01 × 496,873 = +4,969 sats.
  // After entry fee 2,285 → +2,684 sats net — below the 3000 floor.
  const result = evaluateProfitFloor(profitFloorPos(), 404, profitFloorConfig(), {
    nowMs: Date.parse('2026-09-16T00:13:55Z'),
  });
  assert.ok(result, 'should return an extension proposal');
  assert.equal(result.shouldExtend, true);
  assert.equal(result.floorSats, 3000);
  assert.equal(result.pnlSats < 3000n, true);
  assert.equal(result.pnlSats > 0n, true);
  // newCutoffMs = nowMs + 6h
  assert.equal(result.newCutoffMs, Date.parse('2026-09-16T00:13:55Z') + 6 * 3600 * 1000);
  assert.match(result.reason, /^below_floor_profit_floor_/);
});

test('T43: evaluateProfitFloor: returns null when position was already extended (single-shot)', () => {
  const alreadyExtended = profitFloorPos({
    entry: { time_stop_extended_at: Date.parse('2026-09-16T06:00:00Z') },
  });
  // Same conditions that would otherwise extend, but the previous
  // tick already stamped the cutoff → null (close on next time_stop).
  assert.equal(evaluateProfitFloor(alreadyExtended, 404, profitFloorConfig()), null);
});

test('T43: evaluateProfitFloor: extension_hours=0 or missing degrades to 1h minimum', () => {
  // Defensive: a config bug (0 hours) must not break the gate —
  // we extend by AT LEAST 1 hour so the position has another
  // chance to reach the floor before the next time-stop fires.
  const cfg = profitFloorConfig();
  cfg.exit.time_stop_extension_hours = 0;
  const nowMs = Date.parse('2026-09-16T00:00:00Z');
  const result = evaluateProfitFloor(profitFloorPos(), 404, cfg, { nowMs });
  assert.ok(result);
  assert.equal(result.newCutoffMs, nowMs + 1 * 3600 * 1000);
});

test('T43: evaluateProfitFloor: zero entry cost (chain-synced anomalies) → null', () => {
  // If the position record has bch_spent_sats: 0 (the T28 orphan
  // pathology where the AMM delivered a real rate but the trader
  // recorded 0), `realizedPnlSats` returns null → no extension.
  const orphan = profitFloorPos({ entry: { bch_spent_sats: '0' } });
  assert.equal(evaluateProfitFloor(orphan, 410, profitFloorConfig()), null);
});

test('T43: evaluateProfitFloor: rejects bad input without throwing', () => {
  assert.equal(evaluateProfitFloor(null, 410, profitFloorConfig()), null);
  assert.equal(evaluateProfitFloor({}, 410, null), null);
  assert.equal(evaluateProfitFloor('not-a-position', 410, profitFloorConfig()), null);
});

test('T43: evaluateProfitFloor: resolveExitConfig enforces enabled=false when floor ≤ 0', () => {
  // Calling out the implicit opt-out behavior: if the operator
  // sets the floor to 0 (intending to disable), the resolver also
  // flips `min_realized_pnl_enabled` to false so a later config
  // change doesn't accidentally enable it. The helper returns null
  // in that case (covered above), so this is belt-and-suspenders.
  const floor0 = profitFloorConfig();
  floor0.exit.min_realized_pnl_sats = 0;
  assert.equal(evaluateProfitFloor(profitFloorPos(), 404, floor0), null);
});

// ────────────────────────────────────────────────────────────────────
//  O03 — Per-position prevent-stop-loss + profit-target gate
//  idea_operator_position-prevent-stop-loss-with-profit-target_20260917
// ────────────────────────────────────────────────────────────────────

function positionWithOverrides(p, overrides) {
  return { ...p, exit_overrides: overrides };
}

// toggle OFF → stop_loss still fires (entry 1000, current 900 → -10%).
test('O03 shouldExit: toggle OFF → normal behavior (stop_loss still fires)', () => {
  const p = position();
  const r = shouldExit(p, market({ price_now_sats: 900 }), baseConfig(), { nowMs: OPENED_MS + 60 * 60 * 1000 });
  assert.equal(r.exit, true);
  assert.equal(r.kind, 'stop_loss');
});

// toggle ON with 10% target. Current 900 = -10% → blocked.
test('O03 shouldExit: toggle ON, P&L below target → stop_loss DROPPED, no exit', () => {
  const p = positionWithOverrides(position(), {
    prevent_stop_loss: true,
    profit_target_pct: 10,
    set_at: OPENED_AT,
  });
  const r = shouldExit(p, market({ price_now_sats: 900 }), baseConfig(), { nowMs: OPENED_MS + 60 * 60 * 1000 });
  assert.equal(r.exit, false, 'prevent_stop_loss + below-target P&L must NOT exit');
  assert.equal(r.all_triggered.length, 0);
  assert.equal(r.snapshot.exit_overrides_gate.decision, 'blocked');
  assert.equal(r.snapshot.exit_overrides_gate.target_pct, 10);
  assert.ok(Math.abs(r.snapshot.exit_overrides_gate.actual_pct - (-10)) < 1e-6);
});

// toggle ON with 20% target. HWM 1100, current 1045 (between TP
// threshold 1050 and TS arm threshold 1020, below trail price 1078).
// No gate → trailing_stop fires (TP doesn't fire because 1045 < 1050).
// With gate at 20% target → +4.5% P&L, below target → blocked.
test('O03 shouldExit: toggle ON, P&L below target → trailing_stop also blocked', () => {
  const p = position({ high_water_mark_sats_per_token: 1100 });
  const pNoGate = p;
  const pOv = positionWithOverrides(p, {
    prevent_stop_loss: true,
    profit_target_pct: 20,
    set_at: OPENED_AT,
  });
  const rNoGate = shouldExit(pNoGate, market({ price_now_sats: 1045 }), baseConfig(), { nowMs: OPENED_MS + 60 * 60 * 1000 });
  assert.equal(rNoGate.exit, true);
  assert.equal(rNoGate.kind, 'trailing_stop');

  const rWithGate = shouldExit(pOv, market({ price_now_sats: 1045 }), baseConfig(), { nowMs: OPENED_MS + 60 * 60 * 1000 });
  assert.equal(rWithGate.exit, false);
  assert.equal(rWithGate.snapshot.exit_overrides_gate.decision, 'blocked');
});

// toggle ON with 5% target. Current 1200 (+20%) → gate cleared →
// take_profit fires (default TP pct=5, threshold = 1000*1.05=1050,
// current 1200 > 1050 → fires).
test('O03 shouldExit: toggle ON, P&L at/above target → exit ALLOWED (take_profit fires)', () => {
  const p = position({ high_water_mark_sats_per_token: 1300 });
  const pOv = positionWithOverrides(p, {
    prevent_stop_loss: true,
    profit_target_pct: 5,
    set_at: OPENED_AT,
  });
  const r = shouldExit(pOv, market({ price_now_sats: 1200 }), baseConfig(), { nowMs: OPENED_MS + 60 * 60 * 1000 });
  assert.equal(r.exit, true);
  assert.equal(r.kind, 'take_profit');
  assert.equal(r.snapshot.exit_overrides_gate.decision, 'cleared');
  assert.ok(Math.abs(r.snapshot.exit_overrides_gate.actual_pct - 20) < 1e-6);
});

// toggle ON with 10% target. Current 800 (-20%) → blocked.
// Current 1150 (+15%) → take_profit fires (gate cleared, TP at 1050).
test('O03 shouldExit: toggle ON, P&L clears target → stop_loss ALSO allowed (no longer blocked)', () => {
  const p = position({ high_water_mark_sats_per_token: 1300 });
  const pOv = positionWithOverrides(p, {
    prevent_stop_loss: true,
    profit_target_pct: 10,
    set_at: OPENED_AT,
  });
  const farFutureMs = OPENED_MS + 30 * 60 * 60 * 1000;
  const rLoss = shouldExit(pOv, market({ price_now_sats: 800 }), baseConfig(), { nowMs: farFutureMs });
  assert.equal(rLoss.exit, false, 'down 20% must be blocked even far past time-stop cutoff');
  assert.equal(rLoss.snapshot.exit_overrides_gate.decision, 'blocked');
  const rProfit = shouldExit(pOv, market({ price_now_sats: 1150 }), baseConfig(), { nowMs: farFutureMs });
  assert.equal(rProfit.exit, true);
  assert.equal(rProfit.kind, 'take_profit');
});

// far-future (time_stop would normally fire). P&L = -10%, below 10%
// target → blocked.
test('O03 shouldExit: toggle ON, time_stop ALSO blocked when P&L below target', () => {
  const p = position();
  const pOv = positionWithOverrides(p, {
    prevent_stop_loss: true,
    profit_target_pct: 10,
    set_at: OPENED_AT,
  });
  const farFutureMs = OPENED_MS + 30 * 60 * 60 * 1000;
  const r = shouldExit(pOv, market({ price_now_sats: 900 }), baseConfig(), { nowMs: farFutureMs });
  assert.equal(r.exit, false, 'time_stop must be blocked when profit gate is open + below target');
  assert.equal(r.snapshot.exit_overrides_gate.decision, 'blocked');
});

// toggle ON with 1% target. Far-future + current 1010 (+1%) →
// gate cleared (1% >= 1%) → time_stop fires (TP threshold 1050
// not crossed since current 1010 < 1050).
test('O03 shouldExit: toggle ON, time_stop fires when P&L is above target (even after long hold)', () => {
  const p = position();
  const pOv = positionWithOverrides(p, {
    prevent_stop_loss: true,
    profit_target_pct: 1,
    set_at: OPENED_AT,
  });
  const farFutureMs = OPENED_MS + 30 * 60 * 60 * 1000;
  const r = shouldExit(pOv, market({ price_now_sats: 1010 }), baseConfig(), { nowMs: farFutureMs });
  assert.equal(r.exit, true);
  assert.equal(r.kind, 'time_stop');
});

// 0% target → must be at break-even or better to clear. At exactly
// entry price 1000, P&L = 0% → cleared. SL fires because price is
// below SL threshold (970). Wait, 1000 == 1000, so price > 970 → no
// SL. But price == entry means no profit AND no loss. Use price
// 1001 → +0.1%, cleared, no SL/TP/TS → only the 1h timestamp
// (not far future) → no exit. To get exit, use a price that clears
// gate but triggers SL — but 0% gate means price >= entry, and SL
// is at 0.97*entry → contradiction. So 0% target means "never exit
// unless time_stop fires" (since SL/TP/TS are all anchored to
// ±entry and a 0% gate blocks anything that would otherwise
// trigger via price).
test('O03 shouldExit: toggle ON, profit_target_pct=0 → gate blocks loss-driven exits', () => {
  // At price 900 (-10%), P&L = -10% < 0% → blocked.
  const p = position();
  const pOv = positionWithOverrides(p, {
    prevent_stop_loss: true,
    profit_target_pct: 0,
    set_at: OPENED_AT,
  });
  const r = shouldExit(pOv, market({ price_now_sats: 900 }), baseConfig(), { nowMs: OPENED_MS + 60 * 60 * 1000 });
  assert.equal(r.exit, false, '0% target + -10% P&L should block SL');
  assert.equal(r.snapshot.exit_overrides_gate.decision, 'blocked');
});

// 0% target + at-entry price → P&L = 0% → cleared. Far future →
// time_stop fires.
test('O03 shouldExit: toggle ON, profit_target_pct=0 → time_stop fires at break-even', () => {
  const p = position();
  const pOv = positionWithOverrides(p, {
    prevent_stop_loss: true,
    profit_target_pct: 0,
    set_at: OPENED_AT,
  });
  const farFutureMs = OPENED_MS + 30 * 60 * 60 * 1000;
  const r = shouldExit(pOv, market({ price_now_sats: 1000 }), baseConfig(), { nowMs: farFutureMs });
  assert.equal(r.exit, true);
  assert.equal(r.kind, 'time_stop');
});

// null market → T28d sanity check rejects → effectiveCurrentPrice
// null → gate is no_data → don't block. 1h after entry isn't past
// the 24h time-stop cutoff → no exit.
test('O03 shouldExit: toggle ON, missing market price → no_data (exit allowed, no gate block)', () => {
  const p = position();
  const pOv = positionWithOverrides(p, {
    prevent_stop_loss: true,
    profit_target_pct: 10,
    set_at: OPENED_AT,
  });
  const r = shouldExit(pOv, null, baseConfig(), { nowMs: OPENED_MS + 60 * 60 * 1000 });
  assert.equal(r.exit, false);
  assert.equal(r.snapshot.exit_overrides_gate.decision, 'no_data');
});

// Toggle explicitly OFF → gate is inactive (snapshot.exit_overrides_gate is null).
test('O03 shouldExit: exit_overrides with prevent_stop_loss=false → gate inactive', () => {
  const p = position();
  const pOv = positionWithOverrides(p, {
    prevent_stop_loss: false,
    profit_target_pct: 10,
    cleared_at: OPENED_AT,
  });
  const r = shouldExit(pOv, market({ price_now_sats: 900 }), baseConfig(), { nowMs: OPENED_MS + 60 * 60 * 1000 });
  assert.equal(r.exit, true);
  assert.equal(r.kind, 'stop_loss');
  assert.equal(r.snapshot.exit_overrides_gate, null);
});
