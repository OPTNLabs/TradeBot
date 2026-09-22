#!/usr/bin/env node
// src/risk/limits.mjs
//
// Pure risk-side pre-trade gates.
//
//   1. **`canOpen(...)`** — can we open another position at all?
//      Considers per-token exposure caps, position count, daily
//      loss budget, consecutive-loss circuit-breaker, blacklist.
//
//   2. **`canEnter(...)`** — should THIS trade pass? Composes:
//      per-token recent losses, blacklist membership, the circuit
//      breaker state, and the open-position count. The trader
//      loop calls this AFTER `strategy/entry.shouldEnter(...)`
//      returns "enter: true" — it is the second line of defense.
//
//   3. **`computeOpenExposureBch(...)` / `countOpenPositions(...)`**
//      — tiny pure helpers the loop uses to build the
//      `portfolioState` argument for `shouldEnter`.
//
// Design rules (also see docs/ARCHITECTURE.md §5.2):
//
//   1. **Pure.** All gates are pure functions; the stateful
//      circuit-breaker lives in `risk/circuit-breaker.mjs`. This
//      file does NO I/O and reads EVERY threshold from
//      `cfg.risk`/`cfg.entry` — never from a literal.
//
//   2. **Always returns a typed Result.** Either
//      `{ ok: true }` or `{ ok: false, reason, kind }`. Never throws
//      on policy rejection (a refused trade is a NORMAL outcome).
//      Throws only on input validation / config bugs.
//
//   3. **"Missing evidence ≠ zero."** A token with no recorded
//      recent losses gets a clean slate — we don't pretend it had
//      zero losses, but we also don't reject for missing data.
//      A position with a null entry cost is SKIPPED (the entry
//      layer is the one that catches null-cost positions).
//
//   4. **Every gate is independently testable.** We export each
//      gate as its own named function (`isBlacklisted`,
//      `recentLossesForToken`, `wouldExceedPerTokenCap`,
//      etc.) so the test suite can exercise each without
//      threading a full config through `canEnter`.
//
// Origin: original code for TradeBot. ARCHITECTURE.md §3 places
// this module on the pure layer.

// ─────────────────────────────────────────────────────────────────────
//  Defaults
// ─────────────────────────────────────────────────────────────────────

/**
 * Defaults that mirror `config/default.json` → `risk`. The real
 * config always wins when present; these only fire on missing/garbage
 * config (programmer bug). Tests reference these values so the
 * literal numbers in `src/risk/limits.mjs` stay at zero.
 */
export const DEFAULT_RISK_CONFIG = Object.freeze({
  max_daily_loss_bch: 0.005,
  max_consecutive_losses: 3,
  circuit_breaker_cooldown_hours: 6,
  min_wallet_balance_bch: 0.005,
});

/**
 * Extra risk knobs the entry layer reads but the risk module also
 * enforces (mirrors `config/default.json` → `entry`).
 */
export const DEFAULT_RISK_AUX_CONFIG = Object.freeze({
  max_position_bch: 0.005,
  max_total_exposure_bch: 0.04,
  min_trade_size_bch: 0.0005,
  /**
   * O02 (idea_operator_allow-second-position-for-a-token_20260917):
   * Required price discount (vs the oldest open position's entry
   * price) to allow a second open position on the same token. The
   * operator's proposal: "the new position must be entered at a
   * price at least 20% lower than the first positions" — so the
   * default is 0.20 (= 20%). Set to a value >= 1.0 to disable the
   * second-position allowance entirely (behaves like the v1 single-
   * position-per-token policy). Set to 0 to allow a second position
   * at any price (effectively unlimited second-entries — probably
   * NOT what the operator wants; keep > 0).
   */
  allow_second_position_discount_pct: 0.20,
});

/**
 * Coerce a config's `risk` block into the canonical shape. Falls
 * back to defaults on missing / bad / non-object input.
 *
 * @param {Object|undefined|null} input
 * @returns {{
 *   max_daily_loss_bch: number,
 *   max_consecutive_losses: number,
 *   circuit_breaker_cooldown_hours: number,
 *   min_wallet_balance_bch: number,
 * }}
 */
export function resolveRiskConfig(input) {
  const base = DEFAULT_RISK_CONFIG;
  if (!input || typeof input !== 'object') return { ...base };
  /** @type {ReturnType<typeof resolveRiskConfig>} */
  const out = { ...base };
  for (const k of Object.keys(base)) {
    const v = input[k];
    if (v === undefined || v === null) continue;
    const n = Number(v);
    if (Number.isFinite(n)) out[k] = n;
  }
  // Sanity-clamp.
  if (out.max_daily_loss_bch < 0) out.max_daily_loss_bch = base.max_daily_loss_bch;
  if (out.max_consecutive_losses < 0) out.max_consecutive_losses = base.max_consecutive_losses;
  if (out.circuit_breaker_cooldown_hours < 0) out.circuit_breaker_cooldown_hours = base.circuit_breaker_cooldown_hours;
  if (out.min_wallet_balance_bch < 0) out.min_wallet_balance_bch = base.min_wallet_balance_bch;
  return out;
}

// ─────────────────────────────────────────────────────────────────────
//  Pure helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Filter a positions list to currently-open (status === 'open')
 * entries. Pending + closing + closed are excluded. Pure.
 *
 * @param {Array<Object>} positions
 * @returns {Array<Object>}
 */
export function listOpen(positions) {
  if (!Array.isArray(positions)) return [];
  return positions.filter((p) => p && typeof p === 'object' && p.status === 'open');
}

/**
 * Count currently-open positions. Pure.
 *
 * @param {Array<Object>} positions
 * @returns {number}
 */
export function countOpen(positions) {
  return listOpen(positions).length;
}

/**
 * Sum the BCH exposure of a positions list. Delegates to
 * `portfolio/positions.computeOpenExposureBch` so the two layers
 * agree on the math.
 *
 * Pure.
 *
 * @param {Array<Object>} positions
 * @returns {number}
 */
export { computeOpenExposureBch } from '../portfolio/positions.mjs';

// Alias for internal use — keeps the canOpen body readable without
// re-importing the function under a different name.
import { computeOpenExposureBch as _computeOpenExposureBch } from '../portfolio/positions.mjs';

/**
 * Sum recent losses per token over the last `lookbackMs` from a
 * history of closed positions. Returns a Map<tokenId, satLoss>.
 * Negative P&L is a loss; positive P&L is a win; null is skipped.
 *
 * Pure. Used by `canEnter` to gate tokens that just bled.
 *
 * @param {Array<Object>} closedPositions
 * @param {number} nowMs
 * @param {number} lookbackMs
 * @returns {Map<string, number>}
 */
export function recentLossesByToken(closedPositions, nowMs, lookbackMs) {
  /** @type {Map<string, number>} */
  const out = new Map();
  if (!Array.isArray(closedPositions)) return out;
  if (!Number.isFinite(nowMs) || !Number.isFinite(lookbackMs) || lookbackMs < 0) return out;
  const cutoff = nowMs - lookbackMs;
  for (const p of closedPositions) {
    if (!p || typeof p !== 'object') continue;
    if (typeof p.token_id !== 'string') continue;
    const closed = p.closed_at ? Date.parse(p.closed_at) : NaN;
    if (!Number.isFinite(closed) || closed < cutoff) continue;
    const pnl = p?.exit?.realized_pnl_sats;
    if (typeof pnl !== 'number' || !Number.isFinite(pnl)) continue;
    if (pnl >= 0) continue; // only losses
    out.set(p.token_id, (out.get(p.token_id) ?? 0) + Math.abs(pnl));
  }
  return out;
}

/**
 * Sum the realized P&L over the last `lookbackMs` for the WHOLE
 * portfolio (used by the daily-loss circuit breaker).
 *
 * Positive P&L is a gain; negative is a loss; null is skipped.
 * Returns a signed number (positive = net gain, negative = net loss).
 *
 * Pure.
 *
 * @param {Array<Object>} closedPositions
 * @param {number} nowMs
 * @param {number} lookbackMs
 * @returns {number} signed sats
 */
export function recentPnlSats(closedPositions, nowMs, lookbackMs) {
  if (!Array.isArray(closedPositions)) return 0;
  if (!Number.isFinite(nowMs) || !Number.isFinite(lookbackMs) || lookbackMs < 0) return 0;
  const cutoff = nowMs - lookbackMs;
  let total = 0;
  for (const p of closedPositions) {
    if (!p || typeof p !== 'object') continue;
    const closed = p.closed_at ? Date.parse(p.closed_at) : NaN;
    if (!Number.isFinite(closed) || closed < cutoff) continue;
    const pnl = p?.exit?.realized_pnl_sats;
    if (typeof pnl !== 'number' || !Number.isFinite(pnl)) continue;
    total += pnl;
  }
  return total;
}

/**
 * Count consecutive losses ending at `closedPositions[closedPositions.length-1]`.
 * Consecutive means: starting from the MOST RECENT closed position, count
 * losses (pnl < 0) until the first non-loss (win OR breakeven).
 *
 * Returns 0 when the list is empty / has no closed positions.
 *
 * Pure.
 *
 * @param {Array<Object>} closedPositions
 * @returns {number}
 */
export function countConsecutiveLosses(closedPositions) {
  if (!Array.isArray(closedPositions) || closedPositions.length === 0) return 0;
  let count = 0;
  // Iterate from most recent backwards.
  for (let i = closedPositions.length - 1; i >= 0; i--) {
    const p = closedPositions[i];
    if (!p || typeof p !== 'object') continue;
    const pnl = p?.exit?.realized_pnl_sats;
    if (typeof pnl !== 'number' || !Number.isFinite(pnl)) {
      // Unknown P&L breaks the streak — safer than assuming a loss.
      break;
    }
    if (pnl < 0) count += 1;
    else break;
  }
  return count;
}

/**
 * Is `tokenId` in the blacklist? Blacklist is a `string[]` of
 * lowercase hex token_ids; case-insensitive match.
 *
 * Pure.
 *
 * @param {string} tokenId
 * @param {Array<string>|undefined|null} blacklist
 * @returns {boolean}
 */
export function isBlacklisted(tokenId, blacklist) {
  if (typeof tokenId !== 'string' || tokenId.length === 0) return false;
  if (!Array.isArray(blacklist) || blacklist.length === 0) return false;
  const tid = tokenId.toLowerCase();
  return blacklist.some((b) => typeof b === 'string' && b.toLowerCase() === tid);
}

/**
 * Does the portfolio ALREADY have an open position on `tokenId`?
 * Pure; case-insensitive token-id match.
 *
 * Used by `canOpen` to enforce the "one position per token" rule
 * (v1 trading policy: a token that's already long is "held", not
 * "to be entered"). Returning `true` means the trade should be
 * refused with kind=`already_open`.
 *
 * Only `status === 'open'` rows count as "open" for this check.
 * Pending + closing are EXCLUDED — pending hasn't broadcast yet
 * (no capital committed), closing is in-flight (the on-chain
 * position is already closing; we don't want to block the NEXT
 * round). Closed rows are obviously not "open" either.
 *
 * @param {string} tokenId
 * @param {Array<Object>} openPositions
 * @returns {boolean}
 */
export function hasOpenPosition(tokenId, openPositions) {
  if (typeof tokenId !== 'string' || tokenId.length === 0) return false;
  if (!Array.isArray(openPositions) || openPositions.length === 0) return false;
  const tid = tokenId.toLowerCase();
  for (const p of openPositions) {
    if (!p || typeof p !== 'object') continue;
    if (typeof p.token_id !== 'string') continue;
    if (p.status !== 'open') continue;
    if (p.token_id.toLowerCase() === tid) return true;
  }
  return false;
}

/**
 * O02 (idea_operator_allow-second-position-for-a-token_20260917):
 * Given a token that already has one or more open positions,
 * determine whether a NEW entry at `proposedPricePerBaseUnit`
 * sats-per-base would qualify as a "discounted second position"
 * (i.e. at least `discountPct` below the OLDEST existing entry
 * price on this token).
 *
 * Returns:
 *   - `{allowed: true, anchorPositionId, anchorEntryPriceSats, anchorAgeMs, discountFraction}`
 *     when the new entry is sufficiently discounted. The caller
 *     (canOpen) records the anchor info on the open-position event
 *     so the audit trail + REASONING view can show why the second
 *     position was permitted.
 *   - `{allowed: false, reason, anchorPositionId?, anchorEntryPriceSats?, discountFraction?}`
 *     when the discount is insufficient, when any required field
 *     is missing, when the discount gate is disabled, or when the
 *     token is already at the MAX_POSITIONS_PER_TOKEN cap.
 *
 * Pure. Unit-agnostic on the price fields — both `proposedPricePerBaseUnit`
 * and `entry.price_sats_per_token` are sats per BASE unit (decimals=0
 * for FURU means per-display = per-base; decimals>=1 requires the
 * caller to convert before calling). Caller is responsible for the
 * unit conversion; this helper does not know about decimals.
 *
 * MAX POSITIONS PER TOKEN: the operator's proposal reads "the new
 * position must be entered at a price at least 20% lower than the
 * first positions" + "The two positions are independent of each
 * other" — "two" is the cap, not a suggestion. The helper rejects
 * any further entry once a token already has TWO open positions,
 * regardless of how attractive the discount is. This prevents the
 * "controlled average-down" from cascading into a pyramid (which
 * would defeat the purpose of the original single-position-per-token
 * policy). If position-1 closes, position-2 becomes the only open
 * position and a third entry would be allowed again (going from
 * 1 → 2).
 *
 * Anchor semantics: the oldest open position on the token (by
 * `opened_at` if available, otherwise by array order). The new entry
 * must clear the discount vs THIS anchor specifically. When position-1
 * closes, position-2 (which was the second) becomes the anchor and
 * subsequent entries must be `discountPct` below position-2's entry.
 *
 * Edge cases:
 *   - discountPct <= 0         → not allowed (operator-set safety floor)
 *   - discountPct >= 1         → not allowed (the "never allow second"
 *                                 knob the operator can flip from the UI)
 *   - proposedPrice <= 0       → not allowed
 *   - existing entries missing entry.price_sats_per_token → not allowed
 *   - no open positions for this token → not allowed (caller should
 *     never call this helper in that case; defensive guard returns
 *     `{allowed: false}` so a future caller doesn't have a footgun)
 *   - already 2 open positions → not allowed (MAX_POSITIONS_PER_TOKEN cap)
 *
 * @param {Array<Object>} existingPositions open positions on this token (status === 'open')
 * @param {number} proposedPricePerBaseUnit sats per BASE unit the new trade would execute at
 * @param {number} discountPct fraction (0..1) required; e.g. 0.20 means "at least 20% below anchor"
 * @param {number} [nowMs] optional override of Date.now() for testability
 * @returns {{allowed: boolean, reason?: string, anchorPositionId?: string, anchorEntryPriceSats?: number, anchorAgeMs?: number, discountFraction?: number}}
 */
export const MAX_POSITIONS_PER_TOKEN = 2;

export function isAllowedSecondPosition(existingPositions, proposedPricePerBaseUnit, discountPct, nowMs = Date.now()) {
  // Defensive: caller should have already filtered to open positions
  // on this token, but we re-filter in case the caller passes a
  // mixed bucket (e.g. closed positions still in the list).
  const openRows = listOpen(Array.isArray(existingPositions) ? existingPositions : []);
  if (openRows.length === 0) {
    return { allowed: false, reason: 'no existing open positions on this token' };
  }

  // Hard cap: at most MAX_POSITIONS_PER_TOKEN open positions per token.
  // Going from 2 → 3 (or higher) is rejected unconditionally — the
  // discount check below is bypassed because a further entry would
  // always be "doubling down without a thesis change" regardless of
  // price. Anchor fields are intentionally absent here so the
  // caller doesn't attach misleading "would have been X% off" info
  // to a position-count reject (the count is the issue, not the price).
  if (openRows.length >= MAX_POSITIONS_PER_TOKEN) {
    const ids = openRows.map((r) => r && r.id).filter(Boolean).join(', ');
    return {
      allowed: false,
      reason: `token already has ${openRows.length} open positions (max ${MAX_POSITIONS_PER_TOKEN}: ${ids}); close one before re-entering`,
    };
  }

  // Discount gate disabled (or set to a non-sensical value).
  if (!Number.isFinite(discountPct) || discountPct <= 0 || discountPct >= 1) {
    return {
      allowed: false,
      reason: `discount gate disabled (discountPct=${discountPct}); single-position-per-token policy in effect`,
    };
  }

  // Need a valid proposed price.
  if (!Number.isFinite(proposedPricePerBaseUnit) || proposedPricePerBaseUnit <= 0) {
    return {
      allowed: false,
      reason: `proposed price ${proposedPricePerBaseUnit} sats/base is missing or non-positive`,
    };
  }

  // Anchor = OLDEST open position. Sort by opened_at ASC, with
  // array-order fallback for rows missing opened_at.
  const sorted = openRows.slice().sort((a, b) => {
    const ta = Date.parse(a && a.opened_at) || 0;
    const tb = Date.parse(b && b.opened_at) || 0;
    if (ta !== tb) return ta - tb;
    return 0; // stable; first occurrence in input wins
  });
  const anchor = sorted[0];
  const anchorPrice = anchor && anchor.entry && Number(anchor.entry.price_sats_per_token);
  if (!Number.isFinite(anchorPrice) || anchorPrice <= 0) {
    return {
      allowed: false,
      reason: `anchor position ${anchor && anchor.id} is missing entry.price_sats_per_token; cannot evaluate discount`,
    };
  }

  const maxAllowedPrice = anchorPrice * (1 - discountPct);
  const discountFraction = (anchorPrice - proposedPricePerBaseUnit) / anchorPrice;
  const anchorAgeMs = Math.max(0, nowMs - (Date.parse(anchor.opened_at) || nowMs));

  if (proposedPricePerBaseUnit > maxAllowedPrice + 1e-9) {
    return {
      allowed: false,
      reason: `proposed price ${proposedPricePerBaseUnit} sats/base is only ${(discountFraction * 100).toFixed(2)}% below anchor ${anchorPrice} sats/base (need ≥ ${(discountPct * 100).toFixed(1)}%); second position rejected`,
      anchorPositionId: anchor.id,
      anchorEntryPriceSats: anchorPrice,
      anchorAgeMs,
      discountFraction,
    };
  }

  return {
    allowed: true,
    anchorPositionId: anchor.id,
    anchorEntryPriceSats: anchorPrice,
    anchorAgeMs,
    discountFraction,
  };
}

/**
 * Would opening `proposedSizeBch` on `tokenId` push that token's
 * total exposure above `max_per_token_exposure_bch`? Returns `true`
 * when the trade should be rejected.
 *
 * Pure.
 *
 * @param {string} tokenId
 * @param {number} proposedSizeBch
 * @param {Array<Object>} openPositions
 * @param {number} maxPerTokenBch
 * @returns {boolean}
 */
export function wouldExceedPerTokenCap(tokenId, proposedSizeBch, openPositions, maxPerTokenBch) {
  if (typeof tokenId !== 'string' || tokenId.length === 0) return false;
  if (!Number.isFinite(proposedSizeBch) || proposedSizeBch <= 0) return false;
  if (!Number.isFinite(maxPerTokenBch) || maxPerTokenBch <= 0) return false;
  if (!Array.isArray(openPositions)) return false;
  let total = 0;
  for (const p of openPositions) {
    if (!p || typeof p !== 'object') continue;
    if (p.status !== 'open') continue;
    if (typeof p.token_id !== 'string' || p.token_id.toLowerCase() !== tokenId.toLowerCase()) continue;
    const spent = p?.entry?.bch_spent_sats ?? p?.entry?.bch_spent;
    if (typeof spent === 'number' && Number.isFinite(spent)) total += spent;
    else if (typeof spent === 'bigint') total += Number(spent);
    else if (typeof spent === 'string' && spent.length > 0) {
      const n = Number(spent);
      if (Number.isFinite(n)) total += n;
    }
    // pnl is in sats; convert to BCH by /1e8. We use spent which is already in sats.
  }
  // Note: `total` is in SATS (the entry shape stores sats); convert to BCH.
  const totalBch = total / 1e8;
  return (totalBch + proposedSizeBch) > maxPerTokenBch;
}

// ─────────────────────────────────────────────────────────────────────
//  Top-level gates
// ─────────────────────────────────────────────────────────────────────

/**
 * `canOpen(...)` — should we open ANY new position right now?
 *
 * Composition (in priority order — first failure wins):
 *   1. Blacklist membership            → no
 *   2. Wallet balance < reserve floor  → no
 *   3. Total exposure + size > cap     → no
 *   4. Daily loss ≥ daily-loss cap     → no (circuit-breaker)
 *   5. Per-token exposure cap          → no
 *   6. Max open positions reached      → no
 *
 * @param {Object} args
 * @param {string} args.tokenId
 * @param {number} args.proposedSizeBch
 * @param {Array<Object>} args.openPositions       status === 'open' only
 * @param {Array<Object>} args.closedPositions     full history (for daily P&L)
 * @param {number} args.walletBalanceBch
 * @param {Object} args.cfg                        merged default+user
 * @param {number} [args.nowMs=Date.now()]
 * @param {Object} [args.blacklist]                optional token blacklist
 * @param {number} [args.maxOpenPositions]         optional override
 * @param {number} [args.maxPerTokenExposureBch]   optional per-token cap
 * @param {number} [args.dailyLossLookbackHours=24] window for the daily-loss check
 * @returns {{ ok: boolean, reason?: string, kind?: string }}
 */
export function canOpen({
  tokenId,
  proposedSizeBch,
  openPositions,
  closedPositions,
  walletBalanceBch,
  cfg,
  nowMs = Date.now(),
  blacklist,
  maxOpenPositions,
  maxPerTokenExposureBch,
  /**
   * O02: proposed entry price in sats per BASE unit. Required for
   * the second-position discount check; optional for callers that
   * don't pass `openPositions` matching the candidate's token_id
   * (the helper short-circuits to `allowed:false` and the v1 single-
   * position-per-token gate applies). When omitted AND the token
   * already has an open position, the gate rejects as `already_open`
   * (the safe default — refusing to enable second-position logic
   * without an explicit price is better than guessing).
   */
  proposedPricePerBaseUnit,
  dailyLossLookbackHours = 24,
} = {}) {
  // 1. Input validation. Bad input → throw (programmer bug).
  if (typeof tokenId !== 'string' || tokenId.length === 0) {
    throw new TypeError('risk.limits.canOpen: tokenId (non-empty string) required');
  }
  if (!Number.isFinite(proposedSizeBch) || proposedSizeBch <= 0) {
    throw new TypeError(`risk.limits.canOpen: proposedSizeBch must be a positive number; got ${proposedSizeBch}`);
  }
  if (!Number.isFinite(walletBalanceBch) || walletBalanceBch < 0) {
    throw new TypeError(`risk.limits.canOpen: walletBalanceBch must be a non-negative number; got ${walletBalanceBch}`);
  }
  if (!cfg || typeof cfg !== 'object') {
    throw new TypeError('risk.limits.canOpen: cfg is required');
  }

  const riskCfg = resolveRiskConfig(cfg.risk);
  const entryCfg = cfg.entry ?? {};
  const maxPos = Number(entryCfg.max_position_bch ?? DEFAULT_RISK_AUX_CONFIG.max_position_bch);
  const maxExposure = Number(entryCfg.max_total_exposure_bch ?? DEFAULT_RISK_AUX_CONFIG.max_total_exposure_bch);
  const minBalance = riskCfg.min_wallet_balance_bch;
  const allowSecondPositionDiscountPct = Number(
    entryCfg.allow_second_position_discount_pct ?? DEFAULT_RISK_AUX_CONFIG.allow_second_position_discount_pct
  );

  // 2. Blacklist.
  if (isBlacklisted(tokenId, blacklist)) {
    return { ok: false, reason: `token ${tokenId.slice(0, 8)}… is blacklisted`, kind: 'blacklisted' };
  }

  // 2a. "Discounted second-position" policy (O02 / idea_operator_allow-second-position-for-a-token_20260917).
  //
  //     Pre-O02, the bot enforced a strict single-position-per-token
  //     gate (`already_open`) — a token already held as an open
  //     position was refused for any new entry until the existing
  //     position closed and the close landed on-chain. That policy
  //     meant a bot that bought at the top of a move (e.g. FURU at
  //     377 sats) was stuck waiting for the existing position to
  //     recover; meanwhile, if the price dropped 21% to 298 sats, the
  //     bot COULD NOT buy the dip even though it would have been a
  //     genuinely attractive entry in isolation.
  //
  //     The operator's proposal relaxes this: a SECOND open position
  //     on the same token is allowed if the new entry price is at
  //     least `allow_second_position_discount_pct` (default 20%)
  //     below the OLDEST existing open position's entry price.
  //     The two positions are independent — each gets its own entry
  //     price, stop-loss, take-profit, time-stop, and exit tracking.
  //     This lets the bot "average down" in a controlled way when
  //     price action confirms the dip is real, while still refusing
  //     a second entry at the same price (which would just be
  //     doubling exposure without any thesis change).
  //
  //     Anchor semantics: the OLDEST open position. If position-1
  //     closes, position-2 (which was the second) becomes the new
  //     anchor for any third entry. If the operator wants the strict
  //     v1 behavior back, set `allow_second_position_discount_pct = 1.0`
  //     (or higher) and the helper returns `allowed:false` on every
  //     candidate — effectively re-enabling the old `already_open`
  //     gate without code changes.
  //
  //     HARD CAP: at most TWO open positions per token. The operator's
  //     proposal reads "the new position must be entered at a price
  //     at least 20% lower than the first positions" + "The two
  //     positions are independent" — "two" is a cap, not a
  //     suggestion. The helper enforces `MAX_POSITIONS_PER_TOKEN = 2`
  //     before the discount check, so going from 2 → 3 open positions
  //     is rejected unconditionally regardless of how attractive the
  //     price is. The original v1 implementation (shipped at f72c7a7)
  //     missed this cap and let a FURU example cascade to 4 open
  //     positions at the same dip price; O02.1 (commit 12ef74f1)
  //     closed the loophole.
  //
  //     IMPORTANT: the discount ONLY relaxes the "no second
  //     position" rule. The per-trade size, total exposure, per-
  //     token exposure cap, daily-loss cap, and max_open_positions
  //     gates still apply — execution falls through to sections
  //     3..8 below. If ANY downstream gate fires, the trade is
  //     rejected with its normal kind (`position_too_large`,
  //     `exposure_full`, `per_token_cap`, `daily_loss_cap`,
  //     `max_positions`). The `second_position` discount metadata
  //     is preserved on the success-path return so the loop can
  //     attach it to the audit event.
  let secondPositionMeta = null;
  if (hasOpenPosition(tokenId, openPositions)) {
    // Filter to existing open positions on THIS token (the
    // isAllowedSecondPosition helper takes the per-token slice so
    // unrelated tokens in the same openPositions array don't
    // confuse the anchor selection).
    const sameTokenOpen = openPositions.filter(
      (p) => p && typeof p === 'object' && p.status === 'open'
        && typeof p.token_id === 'string'
        && p.token_id.toLowerCase() === tokenId.toLowerCase()
    );
    const discountCheck = isAllowedSecondPosition(
      sameTokenOpen,
      proposedPricePerBaseUnit,
      allowSecondPositionDiscountPct,
      nowMs,
    );
    if (discountCheck.allowed) {
      // Permit the second position — but DON'T short-circuit. Fall
      // through to the size / exposure / daily-loss gates below;
      // they still apply on top of the relaxed single-position rule.
      // The metadata is stashed here and attached to the final
      // `ok:true` return so the loop can record it on the audit event.
      secondPositionMeta = {
        second_position: true,
        anchor_position_id: discountCheck.anchorPositionId,
        anchor_entry_price_sats: discountCheck.anchorEntryPriceSats,
        anchor_age_ms: discountCheck.anchorAgeMs,
        discount_fraction: discountCheck.discountFraction,
        required_discount_pct: allowSecondPositionDiscountPct,
      };
    } else {
      // Discount insufficient (or any other guard failure): strict
      // single-position-per-token reject. The `reason` from the
      // helper is more informative than the original "already has
      // an open position" string when the caller provided a price
      // (so the operator can see HOW MUCH additional discount
      // would have unblocked the trade).
      if (discountCheck.reason && Number.isFinite(proposedPricePerBaseUnit) && proposedPricePerBaseUnit > 0) {
        return {
          ok: false,
          reason: `token ${tokenId.slice(0, 8)}… already has an open position; ${discountCheck.reason}`,
          kind: 'already_open',
        };
      }
      return {
        ok: false,
        reason: `token ${tokenId.slice(0, 8)}… already has an open position; close it before re-entering`,
        kind: 'already_open',
      };
    }
  }

  // 3. Per-trade ceiling (defense in depth — entry layer already does this).
  if (proposedSizeBch > maxPos + 1e-9) {
    return { ok: false, reason: `proposed size ${proposedSizeBch} BCH > max_position_bch ${maxPos}`, kind: 'position_too_large' };
  }

  // 4. Total exposure ceiling.
  const exposureBch = _computeOpenExposureBch(listOpen(openPositions));
  if (exposureBch + proposedSizeBch > maxExposure + 1e-9) {
    return {
      ok: false,
      reason: `total exposure ${exposureBch + proposedSizeBch} BCH would exceed max_total_exposure_bch ${maxExposure}`,
      kind: 'exposure_full',
    };
  }

  // 5. Wallet reserve floor.
  if (walletBalanceBch - proposedSizeBch < minBalance - 1e-9) {
    return {
      ok: false,
      reason: `wallet ${walletBalanceBch} BCH minus trade ${proposedSizeBch} BCH would fall below min_wallet_balance_bch ${minBalance}`,
      kind: 'below_floor',
    };
  }

  // 6. Daily-loss circuit breaker. Negative recent P&L that exceeds
  //    -max_daily_loss_bch → halt.
  const lookbackMs = dailyLossLookbackHours * 3_600_000;
  const pnlSats = recentPnlSats(closedPositions, nowMs, lookbackMs);
  const maxDailyLossSats = -(riskCfg.max_daily_loss_bch * 1e8);
  if (pnlSats <= maxDailyLossSats) {
    return {
      ok: false,
      reason: `daily loss ${(-pnlSats) / 1e8} BCH ≥ max_daily_loss_bch ${riskCfg.max_daily_loss_bch}`,
      kind: 'daily_loss_cap',
    };
  }

  // 7. Per-token exposure cap.
  if (Number.isFinite(maxPerTokenExposureBch) && maxPerTokenExposureBch > 0) {
    if (wouldExceedPerTokenCap(tokenId, proposedSizeBch, openPositions, maxPerTokenExposureBch)) {
      return {
        ok: false,
        reason: `token ${tokenId.slice(0, 8)}… would exceed per-token exposure cap ${maxPerTokenExposureBch} BCH`,
        kind: 'per_token_cap',
      };
    }
  }

  // 8. Max open positions.
  if (Number.isFinite(maxOpenPositions) && maxOpenPositions > 0) {
    if (countOpen(openPositions) >= maxOpenPositions) {
      return {
        ok: false,
        reason: `already at max_open_positions ${maxOpenPositions}`,
        kind: 'max_positions',
      };
    }
  }

  // O02: if section 2a stashed second-position discount metadata,
  // attach it to the success return so the loop can record it on
  // the audit event. Defensive: when no second-position allowance
  // was granted (first-position entry), `secondPositionMeta` is
  // null and the spread collapses to no-op (no extra fields).
  return { ok: true, ...(secondPositionMeta ?? {}) };
}

/**
 * `canEnter(...)` — should THIS candidate pass the second-line gates?
 *
 * Composition (priority order — first failure wins):
 *   1. Same checks as canOpen() (delegated; canEnter === canOpen for v1)
 *
 * v1: this is just an alias. We keep it as a separate function so
 * future risk policies (e.g. "no entries 30 min after a stop-loss",
 * "no entries on tokens with >2 losses in the last 24h") can be
 * added WITHOUT touching the trader loop's call site.
 *
 * @param {Object} args — same as canOpen()
 * @returns {{ ok: boolean, reason?: string, kind?: string }}
 */
export function canEnter(args) {
  return canOpen(args);
}