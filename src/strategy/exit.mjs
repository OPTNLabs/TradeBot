#!/usr/bin/env node
// src/strategy/exit.mjs
//
// Pure exit-side decision: take-profit / stop-loss / trailing-stop /
// time-stop. The trader loop calls `shouldExit(position, market, cfg)`
// on every open position every tick.
//
// Design rules (also see docs/ARCHITECTURE.md §4.3 + §5):
//
//   1. **Pure.** No I/O. No logger. Same inputs → same outputs.
//      The bot's restart-resilience comes from this: the exit decision
//      is purely a function of (position, market, config, now), so a
//      fresh process picks up exactly where a crashed one left off.
//
//   2. **All knobs read from `cfg.exit`.** No literal thresholds in
//      this file. If a knob is missing, fall back to
//      `DEFAULT_EXIT_CONFIG` (small-balance tuned).
//
//   3. **Trailing-stop math is exposed.** The function returns the
//      proposed trailing-stop `price_sats_per_token` AND the
//      updated high-water mark. The trader loop writes the HWM back
//      to `positions.json` (positions.updateHighWaterMark) and the
//      swap executor uses the trail price as its `expectedRateSats`
//      input — so the price the swap is *expected* to clear is the
//      price we'd be happy exiting at.
//
//   4. **Priority order matters.** When multiple conditions fire on
//      the same tick we report the FIRST in this priority: stop-loss,
//      take-profit, trailing-stop, time-stop. We log all that fired
//      (see `all_triggered[]`) so the auditor can see why.
//
//   5. **Missing evidence ⇒ no exit (yet).** If `market.price_now_sats`
//      is null or the indexer is unreachable, the function returns
//      `{ exit: false, reason: 'no_price_evidence' }`. The trader
//      loop SKIPS the position until next tick; we never force an
//      exit based on stale or missing data.
//
// Origin: original code for TradeBot. ARCHITECTURE.md §3 places this
// module on the pure layer.

import { isPricePlausibleVsEntry } from '../util/price-sanity.mjs';
import { computeDynamicExitPcts } from '../util/volatility.mjs';
import { realizedPnlSats } from '../portfolio/pnl.mjs';

// ─────────────────────────────────────────────────────────────────────
//  Defaults
// ─────────────────────────────────────────────────────────────────────

/**
 * Defaults that mirror `config/default.json` → `exit` for the
 * `small_balance_startup` preset. The real config wins when present.
 */
export const DEFAULT_EXIT_CONFIG = Object.freeze({
  take_profit_pct: 5.0,
  stop_loss_pct: 3.0,
  time_stop_hours: 24,
  // T28b: shorter time-stop for chain-synced positions (`source:
  // 'on-chain-sync'`) — the bot didn't open these, so the regular
  // 24h window is too generous when the AMM rate keeps the entry
  // price unresolved. 6h gives the bot ~one trading session to
  // either exit via HWM-based thresholds or fall back to the
  // time-stop close.
  time_stop_hours_synced: 6,
  // T28d: paranoid price-vs-entry ratio. If the indexer's
  // `price_now_sats` is > this many times the entry price (or <
  // 1/this fraction), the indexer is almost certainly stale or
  // wrong (e.g. low-liquidity pools with zero recent trades have
  // reference prices that drift arbitrarily). Reject the price and
  // fall back to time-stop only — much better than firing take-
  // profit on a bogus price and spam-failing pre-flight slippage
  // every tick. 1000x is high enough that no legitimate 7d pump on
  // an entered token gets rejected, but low enough to cap the
  // QBTC-class "indexer is 100,000,000x off" pathology.
  max_price_vs_entry_ratio_x: 1000,
  trailing_stop_pct: 2.0,
  trailing_stop_activation_pct: 2.0,
  // T38: dynamic TP/SL based on 7d realized volatility. When the
  // caller passes a `price_series_7d` (via `opts.priceSeries7d` or
  // `opts.market?.price_series_7d`), the exit decision computes the
  // per-token daily volatility and applies TP at `entry * (1 + tp_vol_multiplier * daily_vol_pct / 100)`
  // / SL at `entry * (1 - sl_vol_multiplier * daily_vol_pct / 100)`.
  // Falls back to the fixed `take_profit_pct` / `stop_loss_pct` when
  // no series is available, the series is too short, or the multiplier
  // is misconfigured. The bounds prevent runaway values (a 100%+ TP
  // is just "never take profit", which is a bug).

  // T43: per-trade realized-profit floor. When a `time_stop` exit
  // would yield a realized P&L below this floor (AND the P&L is
  // positive — losing positions still close), the bot extends the
  // time-stop by `time_stop_extension_hours` and reconsiders on the
  // next tick. The extension is single-shot — after the second
  // time-stop fires the bot closes regardless, so a dead-flat
  // position can't get trapped. Operator can opt out by setting
  // `min_realized_pnl_enabled: false` or by setting the floor to 0.
  //
  // 0 → guard DISABLED (no extension; trades close on schedule).
  // positive finite → floor in sats.
  // negative / non-finite → guard DISABLED.
  min_realized_pnl_sats: 3000,
  time_stop_extension_hours: 6,
  min_realized_pnl_enabled: true,
  //
  // Defaults: TP at +2σ daily move, SL at -1σ daily move, with sane
  // floors/ceilings. The defaults are designed so:
  //   - low-vol tokens (1% daily σ) get tight 2%/1% TP/SL (clamped
  //     to the floor — never tighter than the configured min)
  //   - mid-vol tokens (5% daily σ) get 10%/5% TP/SL (the original
  //     small-balance defaults are now expressed as a 5% daily vol token)
  //   - high-vol tokens (20% daily σ) get 40%/20% TP/SL (clamped well
  //     below the ceiling — a 100%+ TP would mean "never exit at profit")
  //
  // Operator opt-out: setting `tp_vol_multiplier: 0` (or negative,
  // non-finite) disables dynamic TP — the fixed `take_profit_pct`
  // applies. Same for `sl_vol_multiplier` + `stop_loss_pct`.
  tp_vol_multiplier: 2.0,
  sl_vol_multiplier: 1.0,
  tp_vol_floor_pct: 2.0,
  tp_vol_ceiling_pct: 80.0,
  sl_vol_floor_pct: 1.0,
  sl_vol_ceiling_pct: 50.0,
});

/**
 * Coerce an input to a valid `ExitConfig`. Same pattern as
 * `resolveEntryConfig`. Missing / bad values fall back to defaults.
 *
 * @param {Object|undefined|null} input
 * @returns {{
 *   take_profit_pct: number,
 *   stop_loss_pct: number,
 *   time_stop_hours: number,
 *   time_stop_hours_synced: number,
 *   trailing_stop_pct: number,
 *   trailing_stop_activation_pct: number,
 *   max_price_vs_entry_ratio_x: number,
 *   tp_vol_multiplier: number,
 *   sl_vol_multiplier: number,
 *   tp_vol_floor_pct: number,
 *   tp_vol_ceiling_pct: number,
 *   sl_vol_floor_pct: number,
 *   sl_vol_ceiling_pct: number,
 *   min_realized_pnl_sats: number,
 *   time_stop_extension_hours: number,
 *   min_realized_pnl_enabled: boolean,
 * }}
 */
export function resolveExitConfig(input) {
  const base = DEFAULT_EXIT_CONFIG;
  if (!input || typeof input !== 'object') return { ...base };
  /** @type {ReturnType<typeof resolveExitConfig>} */
  const out = { ...base };
  const num = (k) => {
    const v = input[k];
    if (v === undefined || v === null) return;
    const n = Number(v);
    if (Number.isFinite(n)) out[k] = n;
  };
  num('take_profit_pct');
  num('stop_loss_pct');
  num('time_stop_hours');
  num('time_stop_hours_synced');
  num('trailing_stop_pct');
  num('trailing_stop_activation_pct');
  num('max_price_vs_entry_ratio_x');        // T28d
  // T38: dynamic TP/SL knobs.
  num('tp_vol_multiplier');
  num('sl_vol_multiplier');
  num('tp_vol_floor_pct');
  num('tp_vol_ceiling_pct');
  num('sl_vol_floor_pct');
  num('sl_vol_ceiling_pct');
  // T43: per-trade profit floor.
  num('min_realized_pnl_sats');
  num('time_stop_extension_hours');
  // min_realized_pnl_enabled is a boolean toggle — accept true/false
  // directly rather than coercing through Number() (which would turn
  // `true` into 1 and `false` into 0, then default to `out.enabled`).
  if (typeof input.min_realized_pnl_enabled === 'boolean') {
    out.min_realized_pnl_enabled = input.min_realized_pnl_enabled;
  } else if (input.min_realized_pnl_enabled !== undefined) {
    // Anything truthy enables; anything falsy disables.
    out.min_realized_pnl_enabled = Boolean(input.min_realized_pnl_enabled);
  }
  // Negative thresholds are config bugs — fall back.
  for (const k of Object.keys(out)) {
    if (typeof out[k] === 'number' && !Number.isFinite(out[k])) out[k] = base[k];
  }
  // Disable the floor when explicitly opted-out (0 or negative).
  if (typeof out.min_realized_pnl_sats === 'number' && out.min_realized_pnl_sats <= 0) {
    out.min_realized_pnl_enabled = false;
  }
  return out;
}

/**
 * @typedef {Object} ExitDecision
 * @property {boolean}    exit
 * @property {string}     [reason]            human-readable when exit=true
 * @property {string}     [kind]              machine code ('take_profit' | 'stop_loss' | 'trailing_stop' | 'time_stop')
 * @property {string[]}   [all_triggered]     every condition that fired (priority-ordered)
 * @property {bigint|number} [newHighWaterMarkSats]  updated HWM (number; trader coerces to bigint)
 * @property {bigint|number} [trailPriceSats]        current trailing-stop level (when trailing fires)
 * @property {Object}     [snapshot]          full snapshot of price/HWM/time for the audit log
 */

// ─────────────────────────────────────────────────────────────────────
//  Pure helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Compute the trailing-stop price from the high-water mark.
 *
 *   trailPrice = hwm * (1 - trailing_stop_pct / 100)
 *
 * Returns `null` on bad input rather than 0 — the caller treats null
 * as "skip the trailing-stop check" rather than triggering a phantom
 * exit at 0.
 *
 * @param {number} hwmSats
 * @param {number} trailingStopPct
 * @returns {number|null}
 */
export function trailingStopPrice(hwmSats, trailingStopPct) {
  if (!Number.isFinite(hwmSats) || hwmSats <= 0) return null;
  if (!Number.isFinite(trailingStopPct) || trailingStopPct <= 0) return null;
  return hwmSats * (1 - trailingStopPct / 100);
}

/**
 * Compute the take-profit price from the entry price.
 *
 *   tpPrice = entryPrice * (1 + take_profit_pct / 100)
 *
 * @param {number} entryPriceSats
 * @param {number} takeProfitPct
 * @returns {number|null}
 */
export function takeProfitPrice(entryPriceSats, takeProfitPct) {
  if (!Number.isFinite(entryPriceSats) || entryPriceSats <= 0) return null;
  if (!Number.isFinite(takeProfitPct)) return null;
  return entryPriceSats * (1 + takeProfitPct / 100);
}

/**
 * Compute the stop-loss price from the entry price.
 *
 *   slPrice = entryPrice * (1 - stop_loss_pct / 100)
 *
 * @param {number} entryPriceSats
 * @param {number} stopLossPct
 * @returns {number|null}
 */
export function stopLossPrice(entryPriceSats, stopLossPct) {
  if (!Number.isFinite(entryPriceSats) || entryPriceSats <= 0) return null;
  if (!Number.isFinite(stopLossPct) || stopLossPct <= 0) return null;
  return entryPriceSats * (1 - stopLossPct / 100);
}

/**
 * Time-stop helper. Returns the milliseconds-since-epoch cutoff
 * (entry-opened + time_stop_hours). Pure.
 *
 * @param {string} openedAtIso
 * @param {number} timeStopHours
 * @returns {number|null}
 */
export function timeStopCutoffMs(openedAtIso, timeStopHours) {
  if (typeof openedAtIso !== 'string' || openedAtIso.length === 0) return null;
  const opened = Date.parse(openedAtIso);
  if (!Number.isFinite(opened)) return null;
  if (!Number.isFinite(timeStopHours) || timeStopHours <= 0) return null;
  return opened + timeStopHours * 3_600_000;
}

/**
 * Pull the per-token spot price out of a market snapshot.
 * Accepts the indexer's `PoolStats` shape (sats per DISPLAY unit) and
 * the raw `pool`-shaped records (sats per BASE unit). Returns null
 * when no usable price is present.
 *
 * @param {Object|undefined|null} market
 * @returns {number|null}
 */
export function priceFromMarket(market) {
  if (!market || typeof market !== 'object') return null;
  // Preferred path: PoolStats.price_now_sats (sats per DISPLAY unit).
  const p1 = market.price_now_sats;
  if (Number.isFinite(p1) && p1 > 0) return Number(p1);
  // Fallback: raw pool spot rate (sats per base unit).
  const spot = market.spotRateSatsPerToken;
  if (Number.isFinite(spot) && spot > 0) return Number(spot);
  // Fallback: pool-only `sats / tokens` (sats per base unit).
  if (Number.isFinite(market.sats) && Number.isFinite(market.tokens) && market.tokens > 0) {
    return Number(market.sats) / Number(market.tokens);
  }
  return null;
}

/**
 * Pull the entry price out of a position. Tolerates both
 * `entry.price_sats_per_token` (canonical) and the older alias
 * `entry.entry_price_sats_per_token`.
 *
 * @param {Object} position
 * @returns {number|null}
 */
export function priceFromEntry(position) {
  const e = position?.entry ?? {};
  const p = e.price_sats_per_token ?? e.entry_price_sats_per_token;
  if (!Number.isFinite(p) || p <= 0) return null;
  return Number(p);
}

/**
 * Pull the high-water mark out of a position. The trader loop writes
 * the HWM back to `position.high_water_mark_sats_per_token` (bigint-
 * serialized as string). We coerce bigint | number | string.
 *
 * @param {Object} position
 * @returns {number}  defaults to entry price (no HWM yet → use entry)
 */
export function highWaterMarkFromPosition(position) {
  const hwm = position?.high_water_mark_sats_per_token;
  if (typeof hwm === 'bigint') return Number(hwm);
  if (typeof hwm === 'number' && Number.isFinite(hwm)) return hwm;
  if (typeof hwm === 'string' && hwm.length > 0) {
    const n = Number(hwm);
    if (Number.isFinite(n)) return n;
  }
  // No HWM yet — fall back to the entry price.
  return priceFromEntry(position) ?? 0;
}

// ─────────────────────────────────────────────────────────────────────
//  Main exit decision
// ─────────────────────────────────────────────────────────────────────

/**
 * T43: compute whether a time-stop exit would yield a realized P&L
 * below the configured per-trade profit floor. If so, propose a
 * single-shot time-stop extension so the bot has one more chance to
 * reach the floor before being forced to close.
 *
 * Pure — no I/O. The trader loop is responsible for stamping
 * `entry.time_stop_extended_at` on the position when this returns
 * `{shouldExtend: true}`; `shouldExit` will then use that as the
 * new cutoff on subsequent ticks.
 *
 * Returns `null` when the guard is disabled (operator opt-out,
 * zero floor, no current price evidence, missing position fields)
 * so the caller can simply skip the check.
 *
 * Negative P&L never extends — losing positions still close on
 * the regular time-stop. The floor only applies to UNDER-floor
 * POSITIVE exits (e.g. FURU 2026-09-16: +368 sats profit on a flat
 * +1% move where 24h time-stop fired; the floor says "this
 * wasn't worth a trade — give it more time").
 *
 * @param {Object} position
 * @param {number} currentPriceSats   the indexer/AMM spot rate at the time the time-stop fires
 * @param {Object} cfg
 * @param {Object} [opts]
 * @param {number} [opts.nowMs]       ms since epoch (defaults to Date.now)
 * @returns {{shouldExtend: boolean, pnlSats: bigint, floorSats: number, newCutoffMs: number, reason: string}|null}
 */
export function evaluateProfitFloor(position, currentPriceSats, cfg, opts = {}) {
  if (!position || typeof position !== 'object') return null;
  if (!cfg || typeof cfg !== 'object') return null;
  const exitCfg = resolveExitConfig(cfg.exit);
  if (!exitCfg.min_realized_pnl_enabled) return null;
  if (!Number.isFinite(currentPriceSats) || currentPriceSats <= 0) return null;
  const floorSats = exitCfg.min_realized_pnl_sats;
  if (!Number.isFinite(floorSats) || floorSats <= 0) return null;
  // Single-shot: don't keep extending forever. The previous tick
  // stamped `entry.time_stop_extended_at` when it extended; if that
  // timestamp is in the future we treat it as "already extended,
  // close on the next time-stop regardless".
  const extendedRaw = position?.entry?.time_stop_extended_at;
  if (extendedRaw !== undefined && extendedRaw !== null) return null;
  // Project the exit block using the current spot price. The
  // sell-side economics: sell `token_amount_base` tokens at the
  // current rate, deduct a conservative ~3000-sat exit fee
  // (matches the round-trip fee pattern the bot has historically
  // seen in the on-chain settlements). Pass the projected
  // received_sats through to `realizedPnlSats` so its
  // `received - spent - fees` arithmetic fires correctly.
  const tokenAmountBaseRaw = position?.entry?.token_amount_base;
  let tokenAmountBase = null;
  if (typeof tokenAmountBaseRaw === 'bigint') tokenAmountBase = tokenAmountBaseRaw;
  else if (typeof tokenAmountBaseRaw === 'string' && tokenAmountBaseRaw.length > 0) {
    try { tokenAmountBase = BigInt(tokenAmountBaseRaw); } catch { /* ignore */ }
  } else if (typeof tokenAmountBaseRaw === 'number' && Number.isFinite(tokenAmountBaseRaw)) {
    tokenAmountBase = BigInt(Math.round(tokenAmountBaseRaw));
  }
  if (tokenAmountBase === null || tokenAmountBase <= 0n) return null;
  // Conservative projected exit fee: matches the average of the
  // 2026-09-13–15 settlements (3,071 / 6,600 / 1,811 / 3,068 / 2,285).
  // The estimate is intentionally pessimistic — an underestimate of
  // exit fees would under-report P&L and over-extend, which the
  // operator would rather not have (the floor exists to AVOID
  // marginal exits, not to chase them).
  const PROJECTED_EXIT_FEE_SATS = 3000n;
  // Slippage estimate: small-balance preset positions on cauldron
  // pools of depth ~1.3 BCH see ~2% round-trip slippage at the
  // typical swap size. The 2026-09-16 FURU close at price 391.7
  // (entry 387.6) had actual slippage of ~1.5%; rounding to 2%
  // gives a slightly conservative projection that biases toward
  // extension over closing. The estimate is intentionally
  // pessimistic for the same reason the fee is — under-estimating
  // slippage would over-extend positions the operator wanted to
  // close on schedule.
  const PROJECTED_SLIPPAGE_PCT = 2;  // 2% round-trip
  const slippageMultiplier = BigInt(100 - PROJECTED_SLIPPAGE_PCT) * 10000n / 10000n; // 0.98 in fixed-point
  // Floor of 1n to keep the AMM-implied received BCH positive even
  // when the math rounds to zero — important for the entry-cost-0
  // (chain-synced) orphan case where any tiny positive number
  // beats a negative one.
  const grossReceived = tokenAmountBase * BigInt(Math.round(currentPriceSats));
  // (grossReceived * 98) / 100 in bigint arithmetic — slippage.
  const projectedReceived = grossReceived * BigInt(100 - PROJECTED_SLIPPAGE_PCT) / 100n;
  const projectedReceivedNet = projectedReceived > PROJECTED_EXIT_FEE_SATS
    ? projectedReceived - PROJECTED_EXIT_FEE_SATS
    : 0n;
  const projectedExit = {
    price_sats_per_token: Number(currentPriceSats),
    bch_received_sats: projectedReceivedNet.toString(),
    fee_sats: PROJECTED_EXIT_FEE_SATS.toString(),
    ts: new Date((opts && Number.isFinite(opts.nowMs)) ? Number(opts.nowMs) : Date.now()).toISOString(),
    reason: 'time_stop_projected',
  };
  const pnl = realizedPnlSats(position, projectedExit);
  if (pnl.net === null) return null;
  const pnlSats = pnl.net;
  // Negative P&L: time-stop closes anyway (floor is for under-floor
  // wins, not for capping losses).
  if (pnlSats < 0n) return null;
  // Floor met → no extension needed.
  if (pnlSats >= BigInt(floorSats)) return null;
  // Extension proposal.
  const nowMs = (opts && Number.isFinite(opts.nowMs)) ? Number(opts.nowMs) : Date.now();
  const extensionMs = Math.max(1, exitCfg.time_stop_extension_hours) * 3600 * 1000;
  return {
    shouldExtend: true,
    pnlSats,
    floorSats,
    newCutoffMs: nowMs + extensionMs,
    reason: `below_floor_profit_floor_${pnlSats.toString()}_of_${floorSats}`,
  };
}

/**
 * Decide whether to exit an open position. Pure.
 *
 * @param {Object} position     a `PositionEntry` (see portfolio/positions.mjs)
 * @param {Object} market       the current PoolStats (from the indexer) for position.token_id
 * @param {Object} cfg          merged default+user config
 * @param {Object} [opts]
 * @param {number} [opts.nowMs] ms since epoch (defaults to Date.now)
 * @param {Array<number|string|bigint>} [opts.priceSeries7d]  29-point normalized 7d price series; when provided AND the entry was opened with this series (i.e. T38 was active for THIS position), the exit decision uses dynamic TP/SL thresholds derived from its daily volatility instead of the fixed `take_profit_pct` / `stop_loss_pct`. Falls back to `market.price_series_7d` when not supplied directly.
 * @returns {ExitDecision}
 */
export function shouldExit(position, market, cfg, opts = {}) {
  // 1. Validate inputs.
  if (!position || typeof position !== 'object') {
    return { exit: false, reason: 'position not an object', all_triggered: [] };
  }
  if (!cfg || typeof cfg !== 'object') {
    return { exit: false, reason: 'cfg not an object', all_triggered: [] };
  }
  const exitCfg = resolveExitConfig(cfg.exit);
  const nowMs = (opts && Number.isFinite(Number(opts.nowMs)))
    ? Number(opts.nowMs)
    : Date.now();

  // 2. Pull the prices.
  //
  // T28b: when the entry price is unknown (chain-synced positions,
  // `entry.price_sats_per_token === 0`), fall back to the high-water
  // mark as the entry-price proxy. Without this, take-profit /
  // stop-loss / trailing-stop all compute to null and the position
  // gets stuck on `no_exit_condition` until the (24h) time-stop
  // fires — by which point the AMM has usually drifted well past
  // anything salvageable. Using HWM as the floor lets the regular
  // 5%/3%/2% thresholds fire on chain-synced positions too: e.g.
  // a position with HWM 35 sats/token + current 36.75 will take-profit.
  //
  // Trade-off: if the bot just opened the position and HWM is the
  // entry price, this collapses to the same thresholds as a normal
  // entry — no harm. The only edge case is when HWM is artificially
  // inflated by an outlier tick, in which case the trailing-stop will
  // still re-arm as the price falls back.
  const entryPriceRaw = priceFromEntry(position);
  const entryPriceUnknown = entryPriceRaw === null;
  const entryPriceProxy = entryPriceRaw
    ?? highWaterMarkFromPosition(position);
  const entryPrice = (Number.isFinite(entryPriceProxy) && entryPriceProxy > 0)
    ? entryPriceProxy
    : null;
  const currentPrice = priceFromMarket(market);

  // T28d: paranoid price sanity check. Some tokens have a wildly
  // wrong indexer price_now_sats (often 100,000,000x off from the
  // actual AMM-implied rate, because the indexer's reference price
  // is based on stale / zero-trade pools). If the indexer's price is
  // orders of magnitude off from our entry price (which IS
  // trustworthy — it came from an actual AMM swap), reject the
  // indexer price and fall through to time-stop. Without this, every
  // tick the take-profit trigger fires on the bogus indexer price,
  // the AMM-only-realistic-rate is far below the expected trail, and
  // the pre-flight slippage check rejects every attempt — flooding
  // the log with exit_failed events until the regular time-stop fires
  // 24h later.
  //
  // T28e: the plausibility check is shared with `pnl.mjs
  // #unrealizedPnlSats` via `src/util/price-sanity.mjs
  // #isPricePlausibleVsEntry`. Without sharing, the unrealized
  // P&L layer silently emitted $20M+ "gains" on bogus-indexer-
  // price positions (commit 9561393 fixed this file but missed
  // the snapshot + dashboard path).
  const maxRatio = Number.isFinite(Number(exitCfg.max_price_vs_entry_ratio_x))
    ? Number(exitCfg.max_price_vs_entry_ratio_x)
    : 1000;
  const currentPriceRejected = !isPricePlausibleVsEntry(
    entryPrice,
    currentPrice,
    maxRatio,
  );
  // Use a separate variable for downstream consumers so the
  // proposed-HWM / TP / SL / trailing-stop checks all see the
  // rejected-as-null price. The audit snapshot still records
  // `currentPrice` (raw) + a new `current_price_rejected` flag so
  // operators understand what happened.
  const effectiveCurrentPrice = currentPriceRejected ? null : currentPrice;

  // 3. Compute every threshold.
  //
  // T38: dynamic TP/SL from 7d realized volatility. When the caller
  // passes a price series (via `opts.priceSeries7d` or
  // `market.price_series_7d`), compute the per-token daily vol and
  // override the fixed `take_profit_pct` / `stop_loss_pct` with the
  // dynamic values. The dynamic values are PER-POSITION — they're
  // stamped onto the position's `entry.reasoning.thresholds` at entry
  // time (see `shouldEnter`) and replayed here so a config change
  // between entry and exit doesn't retroactively change the
  // thresholds that fired.
  //
  // Operator opt-out: if `opts.priceSeries7d` AND `market.price_series_7d`
  // are both missing / null / too-short, fall back to the fixed
  // `take_profit_pct` / `stop_loss_pct` (no dynamic adjustment).
  // Same fallback when `tp_vol_multiplier` / `sl_vol_multiplier` are
  // 0 / negative / non-finite.
  const priceSeries = (() => {
    if (opts && Array.isArray(opts.priceSeries7d) && opts.priceSeries7d.length >= 2) {
      return opts.priceSeries7d;
    }
    if (market && Array.isArray(market.price_series_7d) && market.price_series_7d.length >= 2) {
      return market.price_series_7d;
    }
    return null;
  })();
  const dynamicPcts = priceSeries
    ? computeDynamicExitPcts(priceSeries, exitCfg)
    : { tp: null, sl: null, daily_vol_pct: null, step_std: null, return_count: 0 };
  // `dynamicPcts.tp` is `null` when the multiplier is misconfigured
  // (0 / negative / non-finite). When non-null, it has already been
  // clamped to `[tp_vol_floor_pct, tp_vol_ceiling_pct]`. Same for SL.
  const tpPctEffective = (dynamicPcts.tp !== null)
    ? dynamicPcts.tp
    : exitCfg.take_profit_pct;
  const slPctEffective = (dynamicPcts.sl !== null)
    ? dynamicPcts.sl
    : exitCfg.stop_loss_pct;
  const tpPrice = takeProfitPrice(entryPrice, tpPctEffective);
  const slPrice = stopLossPrice(entryPrice, slPctEffective);
  // The high-water mark grows during the trade; we propose the new
  // HWM in the result so the trader loop writes it back atomically.
  const prevHwm = highWaterMarkFromPosition(position);
  const proposedHwm = (effectiveCurrentPrice !== null && effectiveCurrentPrice > prevHwm)
    ? effectiveCurrentPrice
    : prevHwm;
  const trailPrice = trailingStopPrice(proposedHwm, exitCfg.trailing_stop_pct);
  // Trailing-stop is "armed" only after the price has moved up by
  // `trailing_stop_activation_pct` from entry.
  const trailArmedPrice = (entryPrice !== null)
    ? entryPrice * (1 + exitCfg.trailing_stop_activation_pct / 100)
    : null;
  const cutoffMs = (() => {
    // T28b: chain-synced positions get a SHORTER time-stop. The bot
    // didn't open these — the operator (or an earlier bot run, or a
    // different trading system) put them here, and there's no
    // guaranteed entry price to anchor the regular thresholds.
    // Burning the full 24h waiting for the price to "maybe come
    // back" ties up exposure budget and stalls new entries. 6h is
    // enough for one trading session; if HWM-based thresholds
    // haven't fired by then, the position isn't likely to ever
    // exit at a profit and we cut the loss.
    const positionSource = position?.entry?.source ?? null;
    const isChainSynced = positionSource === 'on-chain-sync';
    const hours = isChainSynced
      ? Math.min(exitCfg.time_stop_hours, exitCfg.time_stop_hours_synced)
      : exitCfg.time_stop_hours;
    const baseCutoff = timeStopCutoffMs(position.opened_at, hours);
    // T43: profit-floor extension. When a previous tick's time_stop
    // saw P&L below `min_realized_pnl_sats` and granted an extension
    // (stamping `entry.time_stop_extended_at`), we now use THAT as
    // the cutoff — single-shot, no further extensions granted.
    // `Math.max` ensures the extended cutoff never beats the base
    // cutoff (defends against bad timestamps in the position record).
    const extendedRaw = position?.entry?.time_stop_extended_at;
    const extendedMs = (typeof extendedRaw === 'number' && Number.isFinite(extendedRaw))
      ? extendedRaw
      : (typeof extendedRaw === 'string' && extendedRaw.length > 0)
        ? Date.parse(extendedRaw)
        : null;
    if (extendedMs !== null && Number.isFinite(extendedMs)) {
      return Math.max(baseCutoff, extendedMs);
    }
    return baseCutoff;
  })();
  // The actual hours used for the cutoff (always 24h for normal
  // entries, may be `time_stop_hours_synced` for chain-synced
  // positions). Used by the audit-log `reason` so operators see
  // the real value that fired, not a misleading default.
  const timeStopHoursActual = (() => {
    const positionSource = position?.entry?.source ?? null;
    const isChainSynced = positionSource === 'on-chain-sync';
    return isChainSynced
      ? Math.min(exitCfg.time_stop_hours, exitCfg.time_stop_hours_synced)
      : exitCfg.time_stop_hours;
  })();

  /** @type {string[]} */
  const triggered = [];

  // 4. Evaluate each condition. Order matters for the `kind` we
  //    surface to the trader loop: stop-loss > take-profit >
  //    trailing-stop > time-stop. We collect ALL triggered
  //    conditions in `all_triggered` so the audit log can show
  //    every reason we considered.

  // 4a. Stop-loss: price ≤ entry × (1 - stop_loss_pct / 100).
  if (slPrice !== null && effectiveCurrentPrice !== null && effectiveCurrentPrice <= slPrice) {
    triggered.push('stop_loss');
  }
  // 4b. Take-profit: price ≥ entry × (1 + take_profit_pct / 100).
  if (tpPrice !== null && effectiveCurrentPrice !== null && effectiveCurrentPrice >= tpPrice) {
    triggered.push('take_profit');
  }
  // 4c. Trailing-stop: armed (price ≥ trailArmedPrice) AND price has
  //     fallen to trailPrice (= hwm * (1 - trailing_stop_pct/100))
  //     or below. We don't require the HWM to have moved THIS tick —
  //     a trailing-stop still fires on subsequent ticks if the
  //     earlier HWM-based trail price is breached.
  if (
    trailPrice !== null
    && effectiveCurrentPrice !== null
    && trailArmedPrice !== null
    && effectiveCurrentPrice >= trailArmedPrice
    && effectiveCurrentPrice <= trailPrice
  ) {
    triggered.push('trailing_stop');
  }
  // 4d. Time-stop: now ≥ cutoffMs.
  if (cutoffMs !== null && Number.isFinite(nowMs) && nowMs >= cutoffMs) {
    triggered.push('time_stop');
  }

  // 5a. idea_operator_position-prevent-stop-loss-with-profit-target_20260917:
  //     Operator-set exit overrides. When `exit_overrides.prevent_stop_loss`
  //     is true on this position, EVERY exit kind is gated on the
  //     position being in profit by at least `profit_target_pct`.
  //     The bot will hold the position (skipping all stop_loss /
  //     trailing_stop / time_stop / take_profit triggers) until the
  //     operator's profit target is cleared.
  //
  //     This is a per-position override, not a global config knob —
  //     the operator sets it via the PORTFOLIO view's expanded-row
  //     toggle + field. Cleared positions get the original behavior
  //     back on the very next tick.
  //
  //     P&L computation: prefer the strategy's `effectiveCurrentPrice`
  //     (already T28d-sanitized vs the entry anchor); fall back to
  //     the indexer's raw `currentPrice`; fall back to `null` (no
  //     gate applies when we have no fresh price evidence — don't
  //     block the exit on missing data, since `effectiveCurrentPrice
  //     === null` already drops the bot to time-stop-only behavior
  //     in the upstream logic).
  const exitOverrides = (position && typeof position === 'object' && position.exit_overrides)
    ? position.exit_overrides
    : null;
  let profitGatePct = null; // fraction (e.g. 0.10 for 10%) — null = gate inactive
  let profitGateTargetPct = null; // percent value echoed on the audit snapshot
  let profitGateActualPct = null; // current realized-or-unrealized P&L vs entry, in pct
  let profitGateDecision = null; // string describing the gate's decision
  if (exitOverrides && exitOverrides.prevent_stop_loss === true && Number.isFinite(Number(exitOverrides.profit_target_pct))) {
    const targetPct = Number(exitOverrides.profit_target_pct);
    if (targetPct >= 0) {
      profitGateTargetPct = targetPct;
      // Compute current P&L %.
      const refPrice = (effectiveCurrentPrice !== null) ? effectiveCurrentPrice : currentPrice;
      const refEntry = (entryPrice !== null) ? entryPrice : null;
      if (refPrice !== null && refPrice > 0 && refEntry !== null && refEntry > 0) {
        // entry_price = sats per BASE token at entry time. current
        // price = sats per BASE token now. P&L fraction = (current -
        // entry) / entry for a long_token position (the v1 side).
        profitGateActualPct = ((refPrice - refEntry) / refEntry) * 100;
        if (profitGateActualPct >= targetPct) {
          // Profit target cleared — allow the exit (don't gate).
          profitGatePct = profitGateActualPct / 100;
          profitGateDecision = 'cleared';
        } else {
          // Hold the position. Drop every triggered kind.
          profitGatePct = profitGateActualPct / 100;
          profitGateDecision = 'blocked';
          triggered.length = 0; // clear the array; don't exit this tick
        }
      } else {
        // No fresh price evidence — the upstream `effectiveCurrentPrice
        // === null` case. Don't block the exit on missing data
        // (otherwise the bot could be wedged by an indexer outage
        // even when the operator wants to be able to exit manually
        // via the manual-trade CLI). Leave triggered[] intact and
        // mark the gate as 'no_data'.
        profitGateDecision = 'no_data';
      }
    }
  }

  // 5. Decide. Priority order: stop_loss, take_profit, trailing_stop, time_stop.
  let exit = false;
  /** @type {string|undefined} */
  let kind;
  /** @type {string|undefined} */
  let reason;
  if (triggered.length > 0) {
    exit = true;
    const first = triggered[0];
    kind = first;
    reason = describeTrigger(first, {
      currentPrice, tpPrice, slPrice, trailPrice, proposedHwm,
      timeStopHours: timeStopHoursActual,
      entryPriceUnknown,
    });
  }

  /** @type {ExitDecision} */
  const out = {
    exit,
    kind,
    reason,
    all_triggered: triggered,
  };
  if (proposedHwm > prevHwm) out.newHighWaterMarkSats = proposedHwm;
  if (trailPrice !== null) out.trailPriceSats = trailPrice;
  out.snapshot = {
    now_ms: nowMs,
    entry_price_sats: entryPrice,
    entry_price_unknown: entryPriceUnknown,
    current_price_sats: currentPrice,
    // T28d: 1 when the indexer price was rejected as wildly off
    // the entry price; 0 otherwise. When 1, downstream consumers
    // know that `effectiveCurrentPrice` was null even though the
    // raw price was set.
    current_price_rejected: currentPriceRejected ? 1 : 0,
    effective_current_price_sats: effectiveCurrentPrice,
    prev_hwm_sats: prevHwm,
    proposed_hwm_sats: proposedHwm,
    take_profit_price_sats: tpPrice,
    stop_loss_price_sats: slPrice,
    trailing_stop_price_sats: trailPrice,
    trailing_arm_price_sats: trailArmedPrice,
    time_stop_cutoff_ms: cutoffMs,
    position_source: position?.entry?.source ?? null,
    // O03 (idea_operator_position-prevent-stop-loss-with-profit-target_20260917):
    // surface the operator-set exit-override gate state so the
    // dashboard REASONING view + audit history can show
    // "prevent_stop_loss=ON, target=10%, actual=2% (blocked)" for
    // every tick where the gate is active. null when no override
    // is set (the common case).
    exit_overrides_gate: (exitOverrides && exitOverrides.prevent_stop_loss === true)
      ? {
          target_pct: profitGateTargetPct,
          actual_pct: profitGateActualPct,
          decision: profitGateDecision,
        }
      : null,
    thresholds: {
      take_profit_pct: exitCfg.take_profit_pct,
      stop_loss_pct: exitCfg.stop_loss_pct,
      trailing_stop_pct: exitCfg.trailing_stop_pct,
      trailing_stop_activation_pct: exitCfg.trailing_stop_activation_pct,
      time_stop_hours: exitCfg.time_stop_hours,
      time_stop_hours_synced: exitCfg.time_stop_hours_synced,
      // T38: dynamic-TP/SL knobs + the effective per-position
      // percentages that actually fired this tick. `dynamic_*` shows
      // the raw dynamic computation (null when no series was
      // supplied); `effective_take_profit_pct` / `effective_stop_loss_pct`
      // show what was ACTUALLY used (the dynamic value OR the fixed
      // fallback). Operator audit can see "this 0.2%-vol token was
      // evaluated against TP=2%/SL=1% (both at the floor)" without
      // having to re-derive the math.
      tp_vol_multiplier: exitCfg.tp_vol_multiplier,
      sl_vol_multiplier: exitCfg.sl_vol_multiplier,
      tp_vol_floor_pct: exitCfg.tp_vol_floor_pct,
      tp_vol_ceiling_pct: exitCfg.tp_vol_ceiling_pct,
      sl_vol_floor_pct: exitCfg.sl_vol_floor_pct,
      sl_vol_ceiling_pct: exitCfg.sl_vol_ceiling_pct,
      dynamic_daily_vol_pct: dynamicPcts.daily_vol_pct,
      dynamic_step_std: dynamicPcts.step_std,
      dynamic_return_count: dynamicPcts.return_count,
      effective_take_profit_pct: tpPctEffective,
      effective_stop_loss_pct: slPctEffective,
    },
  };
  return out;
}

/**
 * @private — render a human-readable reason for a fired exit trigger.
 *
 * `ctx` only carries the fields actually consumed by the human-
 * readable template below (`currentPrice`, `tpPrice`, `slPrice`,
 * `trailPrice`, `proposedHwm`, `timeStopHours`, `entryPriceUnknown`).
 * Callers shouldn't pass `entryPrice` / `trailArmedPrice` / `cutoffMs`
 * / `nowMs` — they're snapshot-only and not used in the rendered
 * string. Stripping them out keeps the audit message crisp and
 * avoids accidental drift between the snapshot and the reason.
 */
function describeTrigger(kind, ctx) {
  // T28b: when entry price is unknown we used the HWM as the
  // entry-price proxy. Annotate the reason so operators know the
  // threshold they hit isn't vs. a real entry.
  const proxyNote = ctx.entryPriceUnknown ? ' [HWM as entry-price proxy]' : '';
  switch (kind) {
    case 'stop_loss':
      return `stop-loss hit (price ${ctx.currentPrice} ≤ ${ctx.slPrice} sats/token)${proxyNote}`;
    case 'take_profit':
      return `take-profit hit (price ${ctx.currentPrice} ≥ ${ctx.tpPrice} sats/token)${proxyNote}`;
    case 'trailing_stop':
      return `trailing-stop hit (price ${ctx.currentPrice} ≤ trail ${ctx.trailPrice} sats/token; HWM ${ctx.proposedHwm})${proxyNote}`;
    case 'time_stop':
      return `time-stop (${ctx.timeStopHours}h elapsed since entry)${proxyNote}`;
    default:
      return `exit (${kind})`;
  }
}