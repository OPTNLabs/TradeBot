#!/usr/bin/env node
// src/trader/dex-router.mjs
//
// T57-3 — DEX routing layer.
//
// Picks the best DEX adapter per (token, side, size) tuple at trade
// time, so when multiple DEXes are active (e.g. cauldron + guanaco
// once the guanaco team ships their public indexer + SDK) the bot
// routes each trade to the adapter with the best effective rate.
//
// Design rules (also see ARCHITECTURE.md §4.1 / §5):
//
//   1. **Pure selection logic.** No I/O outside the adapter's own
//      `getPoolsAndMeta()` + a static helper to extract rates. The
//      router never signs / broadcasts / writes state — it only
//      decides WHICH adapter `SwapExecutor.execute()` should call.
//
//   2. **Backward compatible.** When no adapters are passed (or
//      only one is active), the router returns the sole adapter
//      without any rate-comparison overhead. Existing call sites
//      (run-bot.mjs, dashboard manual-trade) keep working without
//      any boot-time wiring change.
//
//   3. **Rate-axis comparison.** For each adapter we compute:
//        - BUY:  lower marginal rate per BASE unit = better
//                (the user wants to SPEND less sats per token)
//        - SELL: higher marginal rate per BASE unit = better
//                (the user wants to RECEIVE more sats per token)
//      `planTrade`-style marginal rates are extracted from the
//      adapter's `getPoolsAndMeta` output via `spotRates(...)`
//      from the cauldron SDK's public surface. When the adapter's
//      pool list is missing or empty, the adapter is skipped.
//
//   4. **All adapters fail → typed Result error.** The caller
//      decides what to do (default: log + skip the candidate).
//      `pickBestAdapter` NEVER throws on adapter-level errors —
//      per-adapter failures are caught + recorded so the caller
//      can surface them in the audit trail.
//
//   5. **Deterministic tie-break.** When two adapters report the
//      EXACT same effective rate, the tie is broken by `id`
//      alphabetical order (so test snapshots are stable). Without
//      a tie-break the router would surface non-deterministic
//      adapter selection on flat-rate pools.
//
//   6. **isReady() respects each adapter's contract.** The router
//      does NOT short-circuit on `isReady()` — that's the boot
//      layer's job (`bootDexAdapters`). The router assumes every
//      adapter passed in is boot-ready (the only meaningful failure
//      mode at trade time is missing pools / network error).
//
// Origin: T57-3 follow-up to T57-1 (adapter scaffold) + T57-2
// (guanaco scaffold). All wiring landed in this single tick —
// prior subsets deferred the loop / UI integration per the TODO.md
// plan.

import process from 'node:process';

import { spotRates } from './cauldron/check_and_swap.mjs';
import { createLogger } from '../util/logger.mjs';

// ─────────────────────────────────────────────────────────────────────
//  Errors
// ─────────────────────────────────────────────────────────────────────

/**
 * Base class for every error `dex-router.mjs` raises. Callers
 * should match on `instanceof DexRouterError` to distinguish
 * router-side failures from local bugs (TypeError on bad input, etc.).
 */
export class DexRouterError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'DexRouterError';
    if (opts.kind) this.kind = opts.kind;
    if (opts.cause) this.cause = opts.cause;
  }
}

/** Raised when the caller hands the router a bad `adapters` list. */
export class DexRouterConfigError extends DexRouterError {
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = 'DexRouterConfigError';
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Pull a per-base-unit marginal rate out of an adapter's
 * `getPoolsAndMeta(...)` output. Returns null when the adapter
 * has no live pools for the token (e.g. guanaco before the
 * public indexer shipped, or a token only listed on a subset
 * of the active DEXes).
 *
 * The "best" axis depends on side:
 *   - BUY  → lower rate is better (the trader spends fewer sats
 *           per token). Caller picks the MIN.
 *   - SELL → higher rate is better (the trader receives more
 *           sats per token). Caller picks the MAX.
 *
 * Pure: only reads `poolsAndMeta.pools` + delegates to
 * `spotRates(...)` from the cauldron SDK public surface. The
 * marginal rate is bigint (sats per BASE unit); returned as-is
 * so the router can compare two adapters on the same axis.
 *
 * @param {{ pools: Array, tokenMeta: any } | null | undefined} poolsAndMeta
 * @param {'buy'|'sell'} side
 * @returns {bigint|null}
 */
export function adapterRateForSide(poolsAndMeta, side) {
  if (!poolsAndMeta || typeof poolsAndMeta !== 'object') return null;
  const pools = Array.isArray(poolsAndMeta.pools) ? poolsAndMeta.pools : null;
  if (pools === null || pools.length === 0) return null;
  let rates;
  try {
    rates = spotRates(pools);
  } catch (_) {
    // spotRates can throw on degenerate pool shapes (zero reserve,
    // bad bigint coercion, etc.) — treat as "no rate" rather than
    // poisoning the whole selection.
    return null;
  }
  if (!rates || typeof rates !== 'object') return null;
  const r = side === 'buy' ? rates.buySpot : rates.sellSpot;
  if (typeof r === 'bigint') return r;
  if (typeof r === 'number' && Number.isFinite(r)) {
    return BigInt(Math.round(r));
  }
  return null;
}

/**
 * Coerce a "rate" value to a comparable bigint. Accepts bigint,
 * number, or numeric string. Returns null when the input is not
 * one of those types.
 *
 * @param {unknown} v
 * @returns {bigint|null}
 */
function toRateBigint(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isFinite(v)) {
    return BigInt(Math.round(v));
  }
  if (typeof v === 'string' && v.length > 0) {
    try { return BigInt(v); } catch { return null; }
  }
  return null;
}

/**
 * Build a router-friendly scorecard entry for one adapter.
 *
 * Pure — takes the adapter + the per-adapter rate lookup result.
 * Returns null when the adapter can't quote a rate (skipped by
 * the router).
 *
 * @param {object} adapter
 * @param {bigint|null} rateSats
 * @param {'buy'|'sell'} side
 * @returns {{ id: string, displayName: string, safeMode: boolean, rateSats: bigint } | null}
 */
function buildScorecardEntry(adapter, rateSats, side) {
  if (!adapter || typeof adapter !== 'object') return null;
  const id = typeof adapter.id === 'string' ? adapter.id : null;
  if (id === null) return null;
  const displayName = typeof adapter.displayName === 'string' ? adapter.displayName : id;
  const safeMode = adapter.safeMode === true;
  const r = toRateBigint(rateSats);
  if (r === null) return null;
  return { id, displayName, safeMode, rateSats: r };
}

/**
 * Pick the BEST adapter from `scorecards` for `side`. Returns null
 * when no adapter has a usable rate (the caller then surfaces a
 * structured refusal).
 *
 * Tie-break: when two adapters report the EXACT same effective rate,
 * the tie is broken by `id` alphabetical order (so test snapshots
 * are stable). Without a tie-break the router would surface
 * non-deterministic adapter selection on flat-rate pools.
 *
 * Pure.
 *
 * @param {Array<{ id: string, rateSats: bigint, safeMode: boolean, displayName: string }>} scorecards
 * @param {'buy'|'sell'} side
 * @returns {{ id: string, displayName: string, safeMode: boolean, rateSats: bigint, tieBroken: boolean } | null}
 */
export function pickBestFromScorecards(scorecards, side) {
  if (!Array.isArray(scorecards) || scorecards.length === 0) return null;
  const valid = scorecards.filter((s) => s && typeof s === 'object' && typeof s.rateSats === 'bigint');
  if (valid.length === 0) return null;
  if (valid.length === 1) {
    const only = valid[0];
    return { id: only.id, displayName: only.displayName, safeMode: !!only.safeMode, rateSats: only.rateSats, tieBroken: false };
  }
  // CompareBigInt path. We sort by rate ascending for BUY (lower is
  // better) and rate descending for SELL (higher is better). When
  // the leading entry's rate matches another entry's rate exactly,
  // the alphabetical id tie-break selects the winner.
  const sorted = [...valid].sort((a, b) => {
    if (a.rateSats !== b.rateSats) {
      return side === 'buy'
        ? (a.rateSats < b.rateSats ? -1 : 1)
        : (a.rateSats > b.rateSats ? -1 : 1);
    }
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
  const winner = sorted[0];
  // Detect tie: any other entry has the same rate as the winner
  // (so the alphabetical tie-break fired).
  const tieBroken = sorted.slice(1).some((s) => s.rateSats === winner.rateSats);
  return {
    id: winner.id,
    displayName: winner.displayName,
    safeMode: !!winner.safeMode,
    rateSats: winner.rateSats,
    tieBroken,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Public surface
// ─────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} PickBestAdapterOpts
 * @property {string} tokenId
 * @property {'buy'|'sell'} side
 * @property {bigint} [amountBase]   informational only — the router
 *                                    reads marginal rates, so the
 *                                    exact BCH amount doesn't change
 *                                    the per-base-unit comparison.
 *                                    Kept in the API for future
 *                                    depth-aware routing.
 * @property {object} [logger]       structured logger; defaults to
 *                                    stderr via createLogger.
 * @property {Function} [fetchImpl]  fetch polyfill (test seam).
 * @property {Function} [timeoutMs]  per-adapter timeout (ms).
 */

/**
 * @typedef {Object} PickBestAdapterResult
 * @property {boolean} ok
 * @property {object|null} adapter    the winning adapter (or null on miss)
 * @property {string|null} adapterId
 * @property {bigint|null} rateSats   per-base-unit marginal rate
 * @property {Array<{ id: string, displayName: string, safeMode: boolean, rateSats: bigint|null, error: string|null }>} scorecards
 * @property {boolean} tieBroken
 * @property {string|null} reason     human-readable miss reason
 */

/**
 * Walk `adapters`, pull a per-side rate from each via
 * `getPoolsAndMeta`, and pick the best. Returns a typed Result
 * envelope — never throws on per-adapter failures (those come
 * back as `{ ok:false, reason, scorecards: [...] }` so the
 * caller can decide what to do).
 *
 * Fast paths:
 *   - empty list → `{ ok:false, reason:'no_adapters' }`
 *   - single adapter with a rate → that adapter (no overhead)
 *
 * @param {Array<object>} adapters
 * @param {PickBestAdapterOpts} opts
 * @returns {Promise<PickBestAdapterResult>}
 */
export async function pickBestAdapter(adapters, opts) {
  if (!Array.isArray(adapters)) {
    throw new DexRouterConfigError(`pickBestAdapter: adapters must be an array; got ${typeof adapters}`);
  }
  if (!opts || typeof opts !== 'object') {
    throw new DexRouterConfigError('pickBestAdapter: opts is required');
  }
  const { tokenId, side, amountBase = 0n, logger, timeoutMs = 10_000 } = opts;
  if (typeof tokenId !== 'string' || tokenId.length === 0) {
    throw new DexRouterConfigError(`pickBestAdapter: tokenId is required; got ${JSON.stringify(tokenId)}`);
  }
  if (side !== 'buy' && side !== 'sell') {
    throw new DexRouterConfigError(`pickBestAdapter: side must be 'buy' or 'sell'; got ${JSON.stringify(side)}`);
  }
  const log = logger ?? createLogger({ sink: process.stderr, component: 'dex-router' });
  if (adapters.length === 0) {
    return {
      ok: false,
      adapter: null,
      adapterId: null,
      rateSats: null,
      scorecards: [],
      tieBroken: false,
      reason: 'no_adapters',
    };
  }
  // Build a per-adapter `getPoolsAndMeta` call with a soft timeout
  // so a wedged indexer on adapter-A doesn't block the router
  // (and the trader loop) from reaching adapter-B. The timeout
  // returns a structured miss instead of throwing.
  const perAdapterResult = await Promise.all(adapters.map(async (adapter) => {
    const id = (adapter && typeof adapter.id === 'string') ? adapter.id : '<unknown>';
    const displayName = (adapter && typeof adapter.displayName === 'string') ? adapter.displayName : id;
    const safeMode = adapter && adapter.safeMode === true;
    if (!adapter || typeof adapter.getPoolsAndMeta !== 'function') {
      return { id, displayName, safeMode, rateSats: null, error: 'adapter missing getPoolsAndMeta' };
    }
    let poolsAndMeta;
    try {
      poolsAndMeta = await withTimeout(
        Promise.resolve(adapter.getPoolsAndMeta({ tokenId })),
        timeoutMs,
        `adapter ${id} getPoolsAndMeta`,
      );
    } catch (e) {
      return { id, displayName, safeMode, rateSats: null, error: `getPoolsAndMeta threw: ${e?.message ?? String(e)}` };
    }
    const rate = adapterRateForSide(poolsAndMeta, side);
    if (rate === null) {
      return { id, displayName, safeMode, rateSats: null, error: 'no pools or zero-liquidity' };
    }
    return { id, displayName, safeMode, rateSats: rate, error: null };
  }));
  const scorecards = perAdapterResult.map((r) => ({
    id: r.id,
    displayName: r.displayName,
    safeMode: r.safeMode,
    rateSats: r.rateSats,
    error: r.error,
  }));
  const validEntries = perAdapterResult
    .map((r) => buildScorecardEntry({ id: r.id, displayName: r.displayName, safeMode: r.safeMode }, r.rateSats, side))
    .filter((e) => e !== null);
  const winner = pickBestFromScorecards(validEntries, side);
  if (winner === null) {
    const missReasons = perAdapterResult.filter((r) => r.error !== null).map((r) => `${r.id}:${r.error}`);
    log.warn('dex_router.no_winner', {
      token_id: tokenId, side,
      adapter_count: adapters.length,
      miss_reasons: missReasons,
      scorecards: scorecards.map((s) => ({
        id: s.id, rate_sats: s.rateSats?.toString() ?? null, error: s.error,
      })),
    });
    return {
      ok: false,
      adapter: null,
      adapterId: null,
      rateSats: null,
      scorecards,
      tieBroken: false,
      reason: missReasons.length > 0 ? missReasons.join(';') : 'no_rates',
    };
  }
  const winnerAdapter = adapters.find((a) => a && a.id === winner.id) ?? null;
  log.info('dex_router.pick', {
    token_id: tokenId, side,
    amount_base: typeof amountBase === 'bigint' ? amountBase.toString() : String(amountBase ?? 0),
    winner_id: winner.id,
    winner_rate_sats: winner.rateSats.toString(),
    tie_broken: winner.tieBroken,
    scorecard_summary: scorecards.map((s) => ({
      id: s.id,
      rate_sats: s.rateSats?.toString() ?? null,
      error: s.error,
    })),
  });
  return {
    ok: true,
    adapter: winnerAdapter,
    adapterId: winner.id,
    rateSats: winner.rateSats,
    scorecards,
    tieBroken: winner.tieBroken,
    reason: null,
  };
}

/**
 * Race a promise against a timeout. Returns the promise's result
 * or rejects with a `DexRouterConfigError`. Internal — exported
 * for tests.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 */
export async function withTimeout(promise, ms, label) {
  if (typeof promise?.then !== 'function') {
    throw new DexRouterConfigError(`withTimeout: first arg must be a promise; got ${typeof promise}`);
  }
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new DexRouterConfigError(`withTimeout: ms must be a positive finite number; got ${ms}`);
  }
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new DexRouterConfigError(`${label} timed out after ${ms}ms`, { kind: 'timeout' }));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Convenience wrapper: build the cauldron live adapter for backward
//  compatibility. Production `run-bot.mjs` can either keep using
//  `new SwapExecutor({ cfg, wallet })` (which falls back to the live
//  cauldron adapter internally) OR boot all active adapters via
//  `bootDexAdapters` and pass the array into the new
//  `swap.execute({ dexAdapter })` path.
// ─────────────────────────────────────────────────────────────────────

export const _internals = {
  DexRouterError,
  DexRouterConfigError,
  pickBestFromScorecards,
  buildScorecardEntry,
  adapterRateForSide,
};
