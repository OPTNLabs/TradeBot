#!/usr/bin/env node
// src/dashboard/dust-positions.mjs
//
// T88 — `GET /api/positions/dust` handler. Surfaces every open
// position that the dust-position math (`src/positions/dust-close.mjs`)
// would auto-close at the end of a trader-loop tick. The operator
// can SEE which positions are flagged as dust BEFORE the loop's
// auto-close fires (or that were skipped because of the
// `prevent_stop_loss` operator-override / `on-chain-sync` source
// gate).
//
// Wire shape (consumed by `dashboard/src/views/dust-positions-helpers.mjs`):
//
//   {
//     schema: 'tradebot.dashboard.dust-positions/v1',
//     ts: <iso>,
//     generated_at_ms: <number>,
//     ok: true,
//     dust_position_auto_close_enabled: <bool>,
//     config: {
//       tx_fee_sats, slippage_bps, margin_bps,
//       budget_multiplier, min_token_amount,
//     },
//     open_position_count: <number>,
//     checked_count: <number>,           // positions evaluated
//     dust_count: <number>,              // positions flagged as dust
//     skipped_count: <number>,           // positions skipped (no price / blocked)
//     skipped_overrides: <number>,       // operator prevent_stop_loss overrides
//     skipped_no_price: <number>,        // positions with no live AMM price
//     dust: [
//       {
//         position_id, token_id, token_symbol, token_decimals,
//         entry_ts, entry_bch_spent_sats, entry_price_sats_per_token,
//         current_value_sats, proceeds_sats,
//         total_cost_sats, ratio_cost_to_proceeds,
//         reasons: ['cost_ratio_exceeds_budget:...', 'token_amount_below_min:...'],
//         dust_kind: 'below_cost' | 'below_min_token_amount' | 'below_cost_and_min',
//         blocked_reason: null,
//       },
//       ...
//     ],
//     skipped: [
//       { position_id, token_id, blocked_reason, reasons },
//       ...
//     ],
//   }
//
// Design rules (mirrors the rest of the dashboard layer):
//   - Same math as the trader-loop dust-auto-close (`findDustPositions`).
//     The dashboard math is byte-identical to the loop math — the
//     operator can verify the math by inspecting the wire envelope
//     against `data/history.jsonl`'s `dust_position_auto_close` rows.
//   - Knob-OFF → still returns the envelope but with
//     `dust_position_auto_close_enabled:false` + `dust:[]` +
//     `skipped:[]` (so the dashboard renders the amber "feature is
//     off" info card without 500'ing).
//   - Empty open positions → empty arrays (NOT an error).
//   - No live snapshot (cold-start bot) → empty price index; every
//     position lands in `skipped` with `blocked_reason:'no_price'`.
//   - Every caught error is converted to a typed envelope; the
//     dashboard never sees a thrown error.
//
// Origin: data/feature-ideas.json + the T87 follow-up section in
// TODO.md. Source: research-cron 2026-09-21 16:00Z run.

import {
  DEFAULT_DUST_CONFIG,
  DUST_CLOSE_REASON,
  isDustPosition,
  resolveDustConfig,
} from '../positions/dust-close.mjs';

export const DUST_POSITIONS_SCHEMA = 'tradebot.dashboard.dust-positions/v1';

/**
 * Canonical dust_kind classification. Surfaced on the wire so the
 * dashboard can render a per-row pill without re-deriving the math.
 *
 *   'below_cost'               — total_cost * budget_multiplier > proceeds
 *   'below_min_token_amount'   — token_amount_base < configured min
 *   'below_cost_and_min'       — both triggers fired
 */
export function classifyDustKind(reasons) {
  if (!Array.isArray(reasons) || reasons.length === 0) return 'unknown';
  const belowCost = reasons.some((r) => typeof r === 'string' && r.startsWith('cost_ratio_exceeds_budget'));
  const belowMin = reasons.some((r) => typeof r === 'string' && r.startsWith('token_amount_below_min'));
  if (belowCost && belowMin) return 'below_cost_and_min';
  if (belowCost) return 'below_cost';
  if (belowMin) return 'below_min_token_amount';
  return 'unknown';
}

/**
 * Defensive getter: pull a 64-hex lowercase token_id from a
 * position record. Returns null for null / non-object /
 * non-string token_id.
 *
 * @param {Object|undefined|null} position
 * @returns {string|null}
 */
function safeTokenId(position) {
  if (!position || typeof position !== 'object') return null;
  const tid = position.token_id;
  return (typeof tid === 'string' && tid.length > 0) ? tid.toLowerCase() : null;
}

/**
 * Defensive getter: position id (string) from a position record.
 * Returns null for null / non-object / missing / non-string.
 *
 * @param {Object|undefined|null} position
 * @returns {string|null}
 */
function safePositionId(position) {
  if (!position || typeof position !== 'object') return null;
  const id = position.id;
  return (typeof id === 'string' && id.length > 0) ? id : null;
}

/**
 * Build the typed wire envelope for one dust-flagged position.
 *
 * @param {Object} position
 * @param {Object} dustInfo  the `isDustPosition` envelope
 * @returns {Object}
 */
function projectDustRow(position, dustInfo) {
  const entry = (position && typeof position === 'object' && position.entry && typeof position.entry === 'object')
    ? position.entry
    : {};
  return {
    position_id: safePositionId(position),
    token_id: safeTokenId(position),
    token_symbol: (typeof position.token_symbol === 'string') ? position.token_symbol : null,
    token_decimals: (Number.isFinite(position.token_decimals)) ? position.token_decimals : null,
    entry_ts: (typeof entry.ts === 'string') ? entry.ts : null,
    entry_bch_spent_sats: (Number.isFinite(entry.bch_spent_sats)) ? entry.bch_spent_sats : null,
    entry_price_sats_per_token: (Number.isFinite(entry.price_sats_per_token)) ? entry.price_sats_per_token : null,
    entry_token_amount_base: (entry.token_amount_base === undefined) ? null
      : (typeof entry.token_amount_base === 'string' || typeof entry.token_amount_base === 'number')
        ? entry.token_amount_base
        : String(entry.token_amount_base),
    current_value_sats: dustInfo.current_value_sats,
    proceeds_sats: dustInfo.proceeds_sats,
    slippage_cost_sats: dustInfo.slippage_cost_sats,
    tx_fee_sats: dustInfo.tx_fee_sats,
    total_cost_sats: dustInfo.total_cost_sats,
    net_recoverable_sats: dustInfo.net_recoverable_sats,
    ratio_cost_to_proceeds: dustInfo.ratio_cost_to_proceeds,
    budget_threshold_sats: dustInfo.budget_threshold_sats,
    reasons: dustInfo.reasons,
    dust_kind: classifyDustKind(dustInfo.reasons),
    blocked_reason: null,
  };
}

/**
 * Build a `skipped` row (positions not dust but blocked from
 * evaluation for some operator/sync reason).
 *
 * @param {Object} position
 * @param {string} reason
 * @param {Array<string>} [extraReasons]
 * @returns {Object}
 */
function projectSkippedRow(position, reason, extraReasons = []) {
  return {
    position_id: safePositionId(position),
    token_id: safeTokenId(position),
    token_symbol: (typeof position.token_symbol === 'string') ? position.token_symbol : null,
    blocked_reason: reason,
    reasons: [reason, ...extraReasons],
  };
}

/**
 * Resolve a `{token_id_lower: price_sats_per_token}` map from a
 * snapshot's `meta.market_prices_sats`. Defensive — accepts
 * null / undefined / non-array rows.
 *
 * @param {Object|null|undefined} snapshot
 * @returns {Object<string, number>}
 */
function priceIndexFromSnapshot(snapshot) {
  /** @type {Object<string, number>} */
  const out = {};
  if (!snapshot || typeof snapshot !== 'object') return out;
  const rows = snapshot.meta?.market_prices_sats;
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const tid = row.token_id;
    const price = row.price_sats_per_token;
    if (typeof tid !== 'string' || tid.length === 0) continue;
    if (!Number.isFinite(price) || price <= 0) continue;
    out[tid.toLowerCase()] = Number(price);
  }
  return out;
}

/**
 * Build the typed response envelope for `GET /api/positions/dust`.
 * I/O wrapper: reads open positions + the most-recent snapshot's
 * market price index, runs the same `findDustPositions` pure helper
 * the trader loop uses, and shapes the wire envelope.
 *
 * Defensive:
 *   - Missing `ctx.cfg` → returns a typed `ok:false` envelope
 *     (the dashboard renders a "config unavailable" pill).
 *   - `ctx.positions.list('open')` throws → all positions are
 *     recorded as `skipped` with `blocked_reason:'positions_unavailable'`.
 *   - No live snapshot → empty price index → every position lands
 *     in `skipped` with `blocked_reason:'no_price'`. The
 *     `dust:[]` array stays empty (we don't pretend the indexer
 *     has a price for a token that hasn't been quoted yet).
 *   - Knob-OFF → still returns the envelope but with
 *     `dust_position_auto_close_enabled:false` and `dust:[]`
 *     (the operator can still audit the SKIPPED positions).
 *
 * @param {Object} ctx
 * @param {Object} [opts]
 * @param {Object} [opts.marketIndex]  override the price-index source
 *                                       (for tests). Falls back to
 *                                       the most-recent snapshot's
 *                                       `meta.market_prices_sats`.
 * @param {number} [opts.nowMs]        injected clock for the
 *                                       `generated_at_ms` field.
 * @returns {Promise<Object>}
 */
export async function buildDustPositionsResponse(ctx, opts = {}) {
  const nowMs = (opts && Number.isFinite(opts.nowMs))
    ? opts.nowMs
    : (typeof ctx?.clock === 'function' ? ctx.clock() : Date.now());

  // 1. Resolve config (defensive).
  if (!ctx || typeof ctx !== 'object' || !ctx.cfg || typeof ctx.cfg !== 'object') {
    return {
      schema: DUST_POSITIONS_SCHEMA,
      ts: new Date(nowMs).toISOString(),
      generated_at_ms: nowMs,
      ok: false,
      error: 'cfg_unavailable',
      dust_position_auto_close_enabled: false,
      config: { ...DEFAULT_DUST_CONFIG },
      open_position_count: 0,
      checked_count: 0,
      dust_count: 0,
      skipped_count: 0,
      skipped_overrides: 0,
      skipped_no_price: 0,
      dust: [],
      skipped: [],
    };
  }

  const cfgResolved = resolveDustConfig(ctx.cfg);
  const dustCfg = cfgResolved.config;
  const knobOn = dustCfg && typeof ctx.cfg.risk === 'object' && ctx.cfg.risk.dust_position_auto_close_enabled === true;

  // 2. Resolve positions (defensive).
  let openPositions = [];
  let positionsError = null;
  if (ctx.positions && typeof ctx.positions.list === 'function') {
    try {
      const result = await ctx.positions.list('open');
      if (Array.isArray(result)) {
        openPositions = result.filter((p) => p && typeof p === 'object');
      } else {
        positionsError = 'positions_list_returned_non_array';
      }
    } catch (e) {
      positionsError = e?.message ?? String(e);
    }
  } else {
    positionsError = 'positions_adapter_unavailable';
  }

  // 3. Resolve price index (defensive — accept override, fall back to snapshot).
  let priceIndex = {};
  if (opts && opts.marketIndex && typeof opts.marketIndex === 'object') {
    for (const [k, v] of Object.entries(opts.marketIndex)) {
      if (typeof k === 'string' && k.length > 0 && Number.isFinite(v) && v > 0) {
        priceIndex[k.toLowerCase()] = Number(v);
      }
    }
  } else if (ctx.snapshots && typeof ctx.snapshots.last === 'function') {
    try {
      const snap = await ctx.snapshots.last();
      priceIndex = priceIndexFromSnapshot(snap);
    } catch {
      priceIndex = {};
    }
  }

  // 4. Classify every open position with the same `isDustPosition`
  //    pure helper the loop uses. We DON'T use `findDustPositions`
  //    here because that helper filters non-dust positions out —
  //    the dashboard needs to surface prevent_stop_loss overrides
  //    and on-chain-sync skips too. The math layer is still
  //    byte-identical to the loop.
  /** @type {Array<Object>} */
  const dust = [];
  /** @type {Array<Object>} */
  const skipped = [];
  let skippedOverrides = 0;
  let skippedNoPrice = 0;
  let checkedCount = 0;
  let classifyError = null;

  if (positionsError !== null) {
    // Every open position lands in `skipped` with the I/O error.
    for (const p of openPositions) {
      skipped.push(projectSkippedRow(p, 'positions_unavailable', [positionsError]));
    }
  } else if (openPositions.length > 0) {
    for (const p of openPositions) {
      const tid = safeTokenId(p);
      // Operator intent wins over data availability: a position
      // with `prevent_stop_loss:true` is ALWAYS skipped (loop will
      // never close it), regardless of whether the indexer has a
      // live price. Same for on-chain-sync (orphan-reconcile path).
      // We detect these BEFORE the price check so they show up in
      // `skipped[]` with the right reason even when the indexer
      // hasn't quoted the token yet.
      const overrides = p.exit_overrides;
      if (overrides && typeof overrides === 'object'
          && overrides.prevent_stop_loss === true) {
        skipped.push(projectSkippedRow(p, 'prevent_stop_loss', ['operator_set_prevent_stop_loss']));
        skippedOverrides += 1;
        continue;
      }
      const entry = p.entry;
      if (entry && typeof entry === 'object' && entry.source === 'on-chain-sync') {
        skipped.push(projectSkippedRow(p, 'on_chain_sync', ['on_chain_synced_position']));
        continue;
      }
      if (tid && Object.prototype.hasOwnProperty.call(priceIndex, tid) === false) {
        skipped.push(projectSkippedRow(p, 'no_price'));
        skippedNoPrice += 1;
        continue;
      }
      const price = tid ? priceIndex[tid] : undefined;
      let info;
      try {
        info = isDustPosition(p, price, { config: dustCfg });
      } catch (e) {
        classifyError = e?.message ?? String(e);
        skipped.push(projectSkippedRow(p, 'find_failed', [classifyError]));
        continue;
      }
      checkedCount += 1;
      if (info.is_dust) {
        // Knob ON: this is the live dust the loop will close.
        // Knob OFF: this is a PREVIEW (envelope carries
        // dust_position_auto_close_enabled:false so the UI can
        // render the right "preview only" pill).
        dust.push(projectDustRow(p, info));
      }
    }
  }

  return {
    schema: DUST_POSITIONS_SCHEMA,
    ts: new Date(nowMs).toISOString(),
    generated_at_ms: nowMs,
    ok: true,
    dust_position_auto_close_enabled: knobOn,
    config: { ...dustCfg },
    open_position_count: openPositions.length,
    checked_count: checkedCount,
    dust_count: dust.length,
    skipped_count: skipped.length,
    skipped_overrides: skippedOverrides,
    skipped_no_price: skippedNoPrice,
    dust,
    skipped,
    ...(positionsError !== null ? { load_warnings: [`positions_unavailable:${positionsError}`] } : {}),
  };
}

/**
 * Defensive getter: is the dust-position auto-close knob ON?
 * Pure — does NOT throw on missing cfg. Used by the dashboard's
 * Knob-Off info card.
 *
 * @param {Object|undefined|null} ctx
 * @returns {boolean}
 */
export function isDustPositionAutoCloseEnabled(ctx) {
  if (!ctx || typeof ctx !== 'object' || !ctx.cfg || typeof ctx.cfg !== 'object') return false;
  const risk = ctx.cfg.risk;
  if (!risk || typeof risk !== 'object') return false;
  return risk.dust_position_auto_close_enabled === true;
}

/**
 * Build the canonical config snippet the operator can copy into
 * their `data/user.json` to flip the knob ON. Used by the
 * Knob-Off info card.
 *
 * @returns {string}
 */
export function dustAutoCloseConfigSnippet() {
  return JSON.stringify({ risk: { dust_position_auto_close_enabled: true } }, null, 2);
}

export { DUST_CLOSE_REASON };
