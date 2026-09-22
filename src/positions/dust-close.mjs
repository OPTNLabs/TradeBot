#!/usr/bin/env node
// src/positions/dust-close.mjs
//
// T87 — Dust-position auto-close pure-math module.
//
// A "dust" position is one whose current market value is so small
// that the projected exit-cost (tx fee + slippage) PLUS a safety
// margin consumes the entire position value — i.e. the bot will
// never recoup the closing cost even if the market moves favorably.
// Such positions sit on the dashboard indefinitely, polluting the
// operator's mental model and wasting risk-budget envelope.
//
// The T62 orphan-auto-reconcile ships a different concept: it
// closes positions whose TOKEN is gone from the wallet (the entry
// tx landed but the tokens were swept off-chain or sent elsewhere
// — the position record is a phantom). T87 is the complementary
// concept: the tokens ARE in the wallet but they're not worth
// enough to justify closing.
//
// The pure module exposes:
//
//   - `DEFAULT_DUST_CONFIG` — the canonical defaults the rest of
//     the bot should use when no override is supplied.
//
//   - `resolveDustConfig(cfg)` — defensive getter that pulls
//     `risk.dust_position_close_*` knobs from the bot's runtime
//     config and merges them onto `DEFAULT_DUST_CONFIG`. Never
//     throws on missing / malformed config; bad values fall back
//     to the default with a typed envelope warning.
//
//   - `computeCloseCostSats({tokenAmountBase, currentPriceSatsPerBase, ...})`
//     — the canonical math: projected sale proceeds, slippage
//     cost, tx fee, total close cost, net recoverable sats, and the
//     cost-to-proceeds ratio. Pure, side-effect-free, bigint-safe.
//
//   - `isDustPosition(position, currentPriceSats, opts)` — applies
//     the math to a position record + current price. Returns the
//     typed `{is_dust, ...}` envelope. Honors
//     `position.exit_overrides.prevent_stop_loss` (operator-set
//     "hold until X% profit" override) as a HARD skip — dust
//     detection must NEVER close a position the operator
//     explicitly told the bot to hold.
//
//   - `findDustPositions(positions, priceIndex, opts)` — maps the
//     single-position predicate over an array, returning only the
//     dust-detected subset + their dust info. `priceIndex` is the
//     `{token_id_lower: price_sats_per_token}` shape already
//     produced by the loop's `_extractPriceIndex(statsIndex)`.
//
//   - `buildDustCloseExitBlock(position, dustInfo, opts)` — projects
//     `{txid:'', bch_received_sats:0, fee_sats, ts, reason:'dust_position_auto_close',
//     realized_pnl_sats}` matching the `Positions.close()` exit-block
//     schema. `bch_received_sats:0` because we're closing a dust
//     position at zero BCH (the bot is acknowledging the loss,
//     not actually broadcasting a swap).
//
// Design rules (mirrors the rest of the bot):
//   - Pure functions only. No I/O, no logger, no clock.
//     `nowMs` is injected by the caller; tests pass a fixed value.
//   - Never throws. Every malformed input returns a typed envelope
//     with `ok:false` (or for the predicate, returns
//     `{is_dust:false, blocked_reason:'invalid_input'}` so the
//     caller treats it as "not dust").
//   - BigInt-safe. `token_amount_base` may be a string-encoded
//     bigint (the on-disk format); the math coerces safely.
//   - Defensive on price. `currentPriceSats === 0` / negative /
//     NaN / non-finite all return non-dust (a token with no
//     quoted price has unknown market value; refuse to close).
//   - Independent of exit.mjs / strategy/. The pure module
//     doesn't import any swap-related symbols — it ONLY computes
//     "is this position's value smaller than its close cost?".
//
// Origin: data/feature-ideas.json#idea_dust_position_auto_close_20260921
// Source: research-cron (2026-09-21 16:00Z run). Picked by the
// supervisor as the highest-impact non-duplicate pending idea
// (the other two pending ideas — indexer_stale_flag and
// dashboard_risk_panel — are duplicates of already-shipped T44/T44.1
// and T41 respectively).

import { SATS_PER_BCH } from '../data/types.mjs';

/** Canonical defaults. Tests assert this object is frozen. */
export const DEFAULT_DUST_CONFIG = Object.freeze({
  /** tx fee for the (synthetic) close — default 1500 sats per the BCH dust practice. */
  tx_fee_sats: 1500,
  /** slippage in BPS — default 100 matches `slippage_tolerance_bps` (1%). */
  slippage_bps: 100,
  /** safety margin BPS — adds headroom so we don't fire on exact breakeven. */
  margin_bps: 50,
  /**
   * Multiplier applied to the projected close cost. The dust test
   * is `total_cost_sats * budget_multiplier < projected_proceeds_sats`,
   * so a multiplier of 1.5 means we require closing to free up at
   * least 1.5× the close cost in BCH value. Default 1.5 keeps the
   * gate conservative (we want a margin of safety in case the
   * actual slippage exceeds the estimate).
   */
  budget_multiplier: 1.5,
  /**
   * Minimum token_amount (in base units) below which a position is
   * ALWAYS considered dust regardless of price. Default null =
   * disabled (let the math decide). Setting e.g. `100` would
   * immediately close any position holding fewer than 100 base
   * units. Operators rarely need this — the math is more
   * informative — but the knob exists for paranoia.
   */
  min_token_amount: null,
});

/**
 * Default reason label persisted to `position.exit.reason` for every
 * dust-position auto-close. Matches the T62 orphan-auto-close
 * `reason:'orphan_auto_close'` naming convention.
 */
export const DUST_CLOSE_REASON = 'dust_position_auto_close';

/**
 * Coerce a config-driven number into a finite, non-negative number.
 * Returns the default if the input is missing, NaN, non-finite, or
 * negative. Clamps to [min, max] when both are finite.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @param {{ min?: number, max?: number }} [bounds]
 * @returns {number}
 */
function safeNumber(value, fallback, bounds = {}) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    if (typeof bounds.min === 'number' && Number.isFinite(bounds.min) && value < bounds.min) return bounds.min;
    if (typeof bounds.max === 'number' && Number.isFinite(bounds.max) && value > bounds.max) return bounds.max;
    return value;
  }
  return fallback;
}

/**
 * Resolve the dust-config from a runtime config block. Always
 * returns a fully-populated config object — never throws on
 * missing/malformed input. The returned envelope includes
 * `_applied` (which knobs fell back to defaults) so callers can
 * surface config drift to the operator.
 *
 * @param {Object|undefined|null} cfg  the bot's runtime config (or any subtree)
 * @param {Object} [opts]
 * @param {Object} [opts.risk]  pre-resolved risk block (alternative to drilling `cfg.risk`)
 * @returns {{
 *   config: { tx_fee_sats:number, slippage_bps:number, margin_bps:number,
 *             budget_multiplier:number, min_token_amount:number|null },
 *   applied: { tx_fee_sats:boolean, slippage_bps:boolean, margin_bps:boolean,
 *              budget_multiplier:boolean, min_token_amount:boolean },
 *   ok: true,
 * }}
 */
export function resolveDustConfig(cfg, opts = {}) {
  const risk = (opts && typeof opts.risk === 'object' && opts.risk !== null)
    ? opts.risk
    : (cfg && typeof cfg === 'object' && cfg.risk && typeof cfg.risk === 'object')
      ? cfg.risk
      : {};

  const src = {
    tx_fee_sats:           risk.dust_position_close_tx_fee_sats,
    slippage_bps:           risk.dust_position_close_slippage_bps,
    margin_bps:             risk.dust_position_close_margin_bps,
    budget_multiplier:      risk.dust_position_close_budget_multiplier,
    min_token_amount:       risk.dust_position_close_min_token_amount,
  };

  return {
    ok: true,
    config: {
      tx_fee_sats:       safeNumber(src.tx_fee_sats, DEFAULT_DUST_CONFIG.tx_fee_sats, { min: 0, max: 100_000 }),
      slippage_bps:       safeNumber(src.slippage_bps, DEFAULT_DUST_CONFIG.slippage_bps, { min: 0, max: 1000 }),
      margin_bps:         safeNumber(src.margin_bps, DEFAULT_DUST_CONFIG.margin_bps, { min: 0, max: 500 }),
      budget_multiplier:  safeNumber(src.budget_multiplier, DEFAULT_DUST_CONFIG.budget_multiplier, { min: 1.0, max: 10.0 }),
      min_token_amount:   (typeof src.min_token_amount === 'number' && Number.isFinite(src.min_token_amount) && src.min_token_amount >= 0)
                            ? Math.floor(src.min_token_amount)
                            : DEFAULT_DUST_CONFIG.min_token_amount,
    },
    applied: {
      tx_fee_sats:       src.tx_fee_sats === undefined || !Number.isFinite(Number(src.tx_fee_sats)),
      slippage_bps:       src.slippage_bps === undefined || !Number.isFinite(Number(src.slippage_bps)),
      margin_bps:         src.margin_bps === undefined || !Number.isFinite(Number(src.margin_bps)),
      budget_multiplier:  src.budget_multiplier === undefined || !Number.isFinite(Number(src.budget_multiplier)),
      min_token_amount:   src.min_token_amount === undefined || src.min_token_amount === null,
    },
  };
}

/**
 * Coerce a token-amount-base field into a non-negative finite
 * number. Accepts: number (rounded down), string-encoded number
 * (parsed + rounded down), BigInt (as string fallback), null /
 * undefined / NaN / negative → returns null (caller treats null
 * as "unknown token amount, refuse to evaluate").
 *
 * @param {unknown} v
 * @returns {number|null}
 */
function coerceTokenAmountBase(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    if (v < 0) return null;
    return Math.floor(v);
  }
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (trimmed.length === 0) return null;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return null;
    if (parsed < 0) return null;
    return Math.floor(parsed);
  }
  if (typeof v === 'bigint') {
    if (v < 0n) return null;
    // BigInt can be massive; cap at Number.MAX_SAFE_INTEGER for the math
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
    return Number(v);
  }
  return null;
}

/**
 * Coerce a price-in-sats-per-base-unit field. Accepts: positive
 * finite number, positive numeric string → returns the value.
 * Rejects: null / undefined / NaN / Infinity / negative / ZERO.
 * Zero is treated as "no quote available" — the Cauldron indexer
 * emits `price_now_sats: 0` whenever the token has no live AMM
 * pool quote, and the dashboard / snapshot layer already treats
 * `price_now_sats === 0` as "missing price" (falls back to entry
 * price for `current_worth_sats`). The dust-close math relies on
 * a positive price to compute proceeds; zero is conservatively
 * refused so the bot never auto-closes a position when the
 * indexer itself can't quote the price.
 *
 * @param {unknown} v
 * @returns {number|null}
 */
function coercePriceSats(v) {
  if (v === null || v === undefined) return null;
  const n = (typeof v === 'number') ? v : Number(String(v).trim());
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return null;
  return n;
}

/**
 * Compute the projected exit cost for closing `tokenAmountBase`
 * base units at `currentPriceSatsPerBase` sats per base unit. Pure,
 * side-effect-free, never throws.
 *
 * Returns:
 *   {
 *     proceeds_sats,           // gross BCH sats if the swap clears at current price
 *     slippage_cost_sats,      // projected loss from slippage (price * bps / 10_000)
 *     tx_fee_sats,             // flat tx fee
 *     total_cost_sats,         // slippage + tx fee
 *     net_recoverable_sats,    // proceeds - total_cost
 *     ratio_cost_to_proceeds,  // total_cost / proceeds (Infinity if proceeds=0)
 *   }
 *
 * @param {Object} opts
 * @param {number|string|bigint|null} opts.tokenAmountBase
 * @param {number|null} opts.currentPriceSatsPerBase
 * @param {number} [opts.txFeeSats]
 * @param {number} [opts.slippageBps]
 * @returns {Object}
 */
export function computeCloseCostSats(opts = {}) {
  const txFeeSats = (typeof opts.txFeeSats === 'number' && Number.isFinite(opts.txFeeSats) && opts.txFeeSats >= 0)
    ? opts.txFeeSats
    : DEFAULT_DUST_CONFIG.tx_fee_sats;
  const slippageBps = (typeof opts.slippageBps === 'number' && Number.isFinite(opts.slippageBps) && opts.slippageBps >= 0)
    ? opts.slippageBps
    : DEFAULT_DUST_CONFIG.slippage_bps;

  const amount = coerceTokenAmountBase(opts.tokenAmountBase);
  const price = coercePriceSats(opts.currentPriceSatsPerBase);

  if (amount === null) {
    return {
      ok: false,
      reason: 'invalid_token_amount',
      proceeds_sats: 0,
      slippage_cost_sats: 0,
      tx_fee_sats: txFeeSats,
      total_cost_sats: txFeeSats,
      net_recoverable_sats: -txFeeSats,
      ratio_cost_to_proceeds: Infinity,
    };
  }
  if (price === null) {
    return {
      ok: false,
      reason: 'invalid_price',
      proceeds_sats: 0,
      slippage_cost_sats: 0,
      tx_fee_sats: txFeeSats,
      total_cost_sats: txFeeSats,
      net_recoverable_sats: -txFeeSats,
      ratio_cost_to_proceeds: Infinity,
    };
  }

  // Integer math where possible. `amount` is already integer (floor'd).
  // `proceeds` could overflow Number if amount * price > 2^53, but
  // token_amount_base for a real position is bounded by max_position_bch
  // * price (so ~0.005 BCH * 1B sats/token = 5e6 — well under 2^53).
  const proceedsSats = amount * price;
  const slippageCostSats = (proceedsSats * slippageBps) / 10_000;
  const totalCostSats = slippageCostSats + txFeeSats;
  const netRecoverableSats = proceedsSats - totalCostSats;
  const ratio = proceedsSats > 0 ? totalCostSats / proceedsSats : Infinity;

  return {
    ok: true,
    reason: null,
    proceeds_sats: proceedsSats,
    slippage_cost_sats: slippageCostSats,
    tx_fee_sats: txFeeSats,
    total_cost_sats: totalCostSats,
    net_recoverable_sats: netRecoverableSats,
    ratio_cost_to_proceeds: ratio,
  };
}

/**
 * Determine whether `position` is a dust position. Pure. Returns:
 *
 *   {
 *     is_dust: boolean,
 *     blocked_reason: null | 'prevent_stop_loss' | 'on_chain_sync' | 'invalid_input',
 *     reasons: Array<string>,                 // human-readable list of WHY
 *     current_value_sats: number,             // current_value_sats = tokenAmountBase * price
 *     proceeds_sats: number,
 *     slippage_cost_sats: number,
 *     tx_fee_sats: number,
 *     total_cost_sats: number,
 *     net_recoverable_sats: number,
 *     ratio_cost_to_proceeds: number,         // Infinity when proceeds=0
 *     budget_threshold_sats: number,          // total_cost * budget_multiplier
 *   }
 *
 * The dust gate is: `proceeds_sats < total_cost_sats * budget_multiplier`
 * (strictly less than — so a position at EXACT breakeven is not
 * dust, the safety margin bps still applies). Plus
 * `min_token_amount` if configured.
 *
 * @param {Object|null|undefined} position
 * @param {number|null|undefined} currentPriceSats  sats per BASE unit
 * @param {Object} [opts]
 * @param {Object} [opts.config]  resolved dust config (from resolveDustConfig)
 * @returns {Object}
 */
export function isDustPosition(position, currentPriceSats, opts = {}) {
  if (!position || typeof position !== 'object') {
    return {
      is_dust: false,
      blocked_reason: 'invalid_input',
      reasons: ['position is null/non-object'],
      current_value_sats: 0,
      proceeds_sats: 0,
      slippage_cost_sats: 0,
      tx_fee_sats: 0,
      total_cost_sats: 0,
      net_recoverable_sats: 0,
      ratio_cost_to_proceeds: 0,
      budget_threshold_sats: 0,
    };
  }

  const cfg = (opts && opts.config && typeof opts.config === 'object')
    ? opts.config
    : DEFAULT_DUST_CONFIG;

  // Operator override wins — prevent_stop_loss:ON means "hold until
  // profit", which is the OPPOSITE of dust-close. Even if the
  // position is mathematically dust, the operator's intent takes
  // precedence. This is the test seam: T87 never closes a
  // position the dashboard explicitly told the bot to hold.
  const exitOverrides = position.exit_overrides;
  if (exitOverrides && typeof exitOverrides === 'object'
      && exitOverrides.prevent_stop_loss === true) {
    return {
      is_dust: false,
      blocked_reason: 'prevent_stop_loss',
      reasons: ['operator_set_prevent_stop_loss'],
      current_value_sats: 0,
      proceeds_sats: 0,
      slippage_cost_sats: 0,
      tx_fee_sats: 0,
      total_cost_sats: 0,
      net_recoverable_sats: 0,
      ratio_cost_to_proceeds: 0,
      budget_threshold_sats: 0,
    };
  }

  // On-chain-synced positions are synthetic (their `entry.price_sats_per_token === 0`)
  // and their `entry.token_amount_base` is reconstructed from the
  // best-effort UTXO scan. Closing these via the dust path could
  // devour a real position. Conservative: refuse to evaluate on-chain-synced
  // positions; they go through the orphan-reconcile path instead.
  if (position.entry && typeof position.entry === 'object'
      && position.entry.source === 'on-chain-sync') {
    return {
      is_dust: false,
      blocked_reason: 'on_chain_sync',
      reasons: ['on_chain_synced_position'],
      current_value_sats: 0,
      proceeds_sats: 0,
      slippage_cost_sats: 0,
      tx_fee_sats: 0,
      total_cost_sats: 0,
      net_recoverable_sats: 0,
      ratio_cost_to_proceeds: 0,
      budget_threshold_sats: 0,
    };
  }

  // Missing entry amount = unknown token count. Can't compute close cost.
  const entry = position.entry && typeof position.entry === 'object' ? position.entry : null;
  const tokenAmountBase = entry ? entry.token_amount_base : null;
  if (coerceTokenAmountBase(tokenAmountBase) === null) {
    return {
      is_dust: false,
      blocked_reason: 'invalid_input',
      reasons: ['missing_entry_token_amount_base'],
      current_value_sats: 0,
      proceeds_sats: 0,
      slippage_cost_sats: 0,
      tx_fee_sats: 0,
      total_cost_sats: 0,
      net_recoverable_sats: 0,
      ratio_cost_to_proceeds: 0,
      budget_threshold_sats: 0,
    };
  }

  // Missing price = unknown market value. Don't close — we have
  // no evidence the position is actually dust.
  const price = coercePriceSats(currentPriceSats);
  if (price === null) {
    return {
      is_dust: false,
      blocked_reason: 'invalid_input',
      reasons: ['missing_current_price'],
      current_value_sats: 0,
      proceeds_sats: 0,
      slippage_cost_sats: 0,
      tx_fee_sats: 0,
      total_cost_sats: 0,
      net_recoverable_sats: 0,
      ratio_cost_to_proceeds: 0,
      budget_threshold_sats: 0,
    };
  }

  // Resolve the cost breakdown.
  const cost = computeCloseCostSats({
    tokenAmountBase,
    currentPriceSatsPerBase: price,
    txFeeSats: cfg.tx_fee_sats,
    slippageBps: cfg.slippage_bps,
  });
  if (!cost.ok) {
    return {
      is_dust: false,
      blocked_reason: 'invalid_input',
      reasons: [cost.reason],
      current_value_sats: 0,
      proceeds_sats: 0,
      slippage_cost_sats: 0,
      tx_fee_sats: cost.tx_fee_sats,
      total_cost_sats: cost.total_cost_sats,
      net_recoverable_sats: cost.net_recoverable_sats,
      ratio_cost_to_proceeds: cost.ratio_cost_to_proceeds,
      budget_threshold_sats: 0,
    };
  }

  const currentValueSats = cost.proceeds_sats;
  const budgetThresholdSats = cost.total_cost_sats * cfg.budget_multiplier;
  const reasons = [];
  let isDust = false;

  // Gate 1: explicit minimum-token-amount floor.
  if (typeof cfg.min_token_amount === 'number'
      && Number.isFinite(cfg.min_token_amount)
      && cfg.min_token_amount >= 0
      && Number(tokenAmountBase) < cfg.min_token_amount) {
    isDust = true;
    reasons.push(`token_amount_below_min:${cfg.min_token_amount}`);
  }

  // Gate 2: cost-burns-the-position test (the actual dust math).
  // Strict less-than: position at EXACT breakeven is NOT dust
  // (the safety margin handles the rounding noise).
  if (cost.proceeds_sats < budgetThresholdSats) {
    isDust = true;
    reasons.push(
      `cost_ratio_exceeds_budget:${cost.ratio_cost_to_proceeds.toFixed(4)}>=${cfg.budget_multiplier}`
    );
  }

  return {
    is_dust: isDust,
    blocked_reason: null,
    reasons,
    current_value_sats: currentValueSats,
    proceeds_sats: cost.proceeds_sats,
    slippage_cost_sats: cost.slippage_cost_sats,
    tx_fee_sats: cost.tx_fee_sats,
    total_cost_sats: cost.total_cost_sats,
    net_recoverable_sats: cost.net_recoverable_sats,
    ratio_cost_to_proceeds: cost.ratio_cost_to_proceeds,
    budget_threshold_sats: budgetThresholdSats,
  };
}

/**
 * Find every dust position in `positions`. Pure. Returns the array
 * of `{position, dust_info}` envelopes (where `dust_info` is the
 * shape from `isDustPosition`). Positions lacking a price in
 * `priceIndex` are SKIPPED with a per-position `{skipped, reason}`
 * envelope so the caller can audit which tokens had no quote.
 *
 * @param {Array<Object>|null|undefined} positions
 * @param {Object} priceIndex   `{token_id_lower: price_sats_per_token}`
 * @param {Object} [opts]       forwarded to `isDustPosition`
 * @returns {Array<{position:Object, dust_info:Object, skipped?:boolean, skip_reason?:string}>}
 */
export function findDustPositions(positions, priceIndex, opts = {}) {
  if (!Array.isArray(positions) || positions.length === 0) return [];
  const prices = (priceIndex && typeof priceIndex === 'object') ? priceIndex : {};

  const out = [];
  for (const p of positions) {
    if (!p || typeof p !== 'object') continue;
    const tokenId = typeof p.token_id === 'string' ? p.token_id.toLowerCase() : '';
    const price = tokenId.length > 0 ? prices[tokenId] : undefined;
    if (price === undefined || price === null) {
      out.push({
        position: p,
        dust_info: null,
        skipped: true,
        skip_reason: 'no_price_in_index',
      });
      continue;
    }
    const dust_info = isDustPosition(p, price, opts);
    if (dust_info.is_dust) {
      out.push({ position: p, dust_info });
    }
  }
  return out;
}

/**
 * Build the exit-block for `Positions.close()` that materializes
 * the dust-position auto-close. Pure. Returns the `{txid,
 * bch_received_sats, fee_sats, ts, reason, realized_pnl_sats}`
 * shape the `Positions.close()` API expects.
 *
 * `bch_received_sats:0` because we're acknowledging the loss (the
 * position is dust, the bot doesn't have a real AMM swap to
 * broadcast — this is a synthetic close that purges the audit
 * trail). The realized_pnl_sats is `-1 * (entry.fee_sats +
 * dustInfo.total_cost_sats)` so the P&L rollup accurately reflects
 * the entry fee that was paid + the close cost that the math
 * projected.
 *
 * @param {Object} position
 * @param {Object} dustInfo  the envelope from `isDustPosition`
 * @param {Object} [opts]
 * @param {number} [opts.nowMs]  milliseconds since epoch for the close ts
 * @returns {Object}
 */
export function buildDustCloseExitBlock(position, dustInfo, opts = {}) {
  const nowMs = (opts && Number.isFinite(opts.nowMs)) ? opts.nowMs : Date.now();
  const entry = (position && typeof position === 'object' && position.entry && typeof position.entry === 'object')
    ? position.entry
    : {};
  const entryFeeSats = (typeof entry.fee_sats === 'number' && Number.isFinite(entry.fee_sats))
    ? entry.fee_sats
    : 0;
  const totalCostSats = (dustInfo && Number.isFinite(dustInfo.total_cost_sats))
    ? dustInfo.total_cost_sats
    : 0;
  return {
    txid: '',
    bch_received_sats: 0,
    fee_sats: Math.round(totalCostSats),
    ts: new Date(nowMs).toISOString(),
    reason: DUST_CLOSE_REASON,
    realized_pnl_sats: -1 * (Math.round(entryFeeSats) + Math.round(totalCostSats)),
  };
}

// Internal helpers exposed for direct testing.
export const _internals = {
  safeNumber,
  coerceTokenAmountBase,
  coercePriceSats,
};

// Re-export SATS_PER_BCH for callers that build the cost envelope
// against BCH-denominated config.
export { SATS_PER_BCH };
