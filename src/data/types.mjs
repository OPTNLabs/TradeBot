#!/usr/bin/env node
// src/data/types.mjs
//
// Canonical type definitions + tiny pure helpers for the bot's read-side
// data layer. Everything that talks to the Cauldron indexer, BCMR cache,
// and pool SDK eventually lands as a `Token`, `Pool`, or `PoolStats` —
// these are the shapes the strategy / portfolio / dashboard layers
// consume downstream.
//
// Design rules (also see docs/ARCHITECTURE.md §5):
//   1. This file is a JSDoc typedef surface + a handful of pure helpers.
//      No I/O. No side effects. Safe to import from anywhere.
//   2. Sats are always `number` unless they're a UTXO amount (in which
//      case the source field is `bigint`; `Pool.tokens` is intentionally
//      `string | number | bigint` to accommodate the SDK's actual shape
//      and the indexer's pre-decimals strings).
//   3. Percent fields (`*_pct`) are decimal percentages (5.0 = 5%).
//      Basis-point fields (`*_bp`) are integer basis points (500 = 5%).
//      The indexer uses bp; the config uses pct. Helpers `bpsToPct` /
//      `pctToBps` bridge the two.
//   4. `price_now_sats` is per DISPLAY unit, not per base unit. Multiply
//      by 10^decimals to get the per-base-unit rate. The
//      `decimals_warn` flag in `PoolStats` is the indexer's own warning
//      when BCMR decimals are missing — callers must not silently trust
//      `price_now_sats` as a per-base-unit price.
//
// The pure helpers in this file are intentionally trivial — they exist
// so downstream modules have ONE place to import them from, and so the
// test file has a real surface to exercise. Anything non-trivial lives
// in `data/fetcher.mjs` (T06) or `strategy/scoring.mjs` (T07).

// ─────────────────────────────────────────────────────────────────────
//  JSDoc typedefs
// ─────────────────────────────────────────────────────────────────────

/**
 * A CashToken's metadata. Resolved from BCMR (best-effort; many fields
 * may be missing for tokens without an authchain commitment). `name`
 * and `symbol` are the canonical BCMR values; `display_name` /
 * `display_symbol` are indexer-side fallbacks used by the UI.
 *
 * @typedef {Object} Token
 * @property {string}  token_id        64-char lowercase hex (32 bytes)
 * @property {string}  [name]          Canonical token name (BCMR)
 * @property {string}  [symbol]        Canonical token symbol (BCMR.token.symbol)
 * @property {number}  [decimals]      Decimal places for the base unit
 * @property {string}  [description]
 * @property {Array<Object>} [uris]
 * @property {Object}  [filemeta]
 * @property {string}  [display_name]  UI-resolved name (falls back to `name`)
 * @property {string}  [display_symbol] UI-resolved symbol (falls back to `symbol`)
 */

/**
 * A single active Cauldron liquidity pool. The pool itself is a single
 * UTXO whose script commits to a (sats, tokens) reserve pair; the SDK
 * surfaces those reserves plus the UTXO outpoint so the bot can route
 * a swap through the pool that gives the best spot rate.
 *
 * `tokens` is intentionally `string | number | bigint`: the indexer
 * returns strings for raw base-unit amounts, the SDK returns numbers,
 * and `bigint` is the safe form for very large reserves. Use
 * `Number(pool.tokens)` for arithmetic and `BigInt(pool.tokens)` only
 * when the value may exceed `Number.MAX_SAFE_INTEGER` (≈9e15 base units).
 *
 * @typedef {Object} Pool
 * @property {string} pool_id            Indexer's pool id
 * @property {string} token_id           The CashToken this pool holds
 * @property {number} sats               BCH reserves (sats)
 * @property {string|number|bigint} tokens Token reserves (base units, BCMR decimals applied)
 * @property {string} owner_p2pkh_addr   P2PKH address of the pool creator
 * @property {string} txid               Funding txid (UTXO outpoint)
 * @property {number} tx_pos             Output index in the funding tx
 */

/**
 * Time-series stats for a token's main pool, sourced from the Cauldron
 * indexer's discovery cache. Mirrors the shape produced by
 * `AI_Skills/skills/cauldron/scripts/get_token_stats.mjs` → `buildStatsRecord`.
 *
 * All numeric fields are nullable — a fresh / niche token may have no
 * 24h volume, no APY yet, etc. The scoring engine (T07) MUST treat
 * `null` as "missing evidence" and not as a numeric 0; otherwise a
 * brand-new token with no stats would always score 0 on volume.
 *
 * @typedef {Object} PoolStats
 * @property {string} token_id
 * @property {string} [name]
 * @property {string} [symbol]
 * @property {number} [decimals]
 * @property {string|null} [decimals_warn] Indexer warning when BCMR decimals are missing
 * @property {number|null} price_now_sats       Current spot rate, sats per DISPLAY unit
 * @property {number|null} price_now_usd
 * @property {number|null} price_24h_sats       Price 24h ago
 * @property {number|null} price_7d_sats        Price 7d ago
 * @property {number|null} change_24h_bp        24h price delta, basis points
 * @property {number|null} change_24h_usd_bp    24h USD price delta, basis points
 * @property {number|null} change_7d_bp         7d price delta, basis points
 * @property {number|null} change_7d_usd_bp     7d USD price delta, basis points
 * @property {number|null} trade_count          24h trade count
 * @property {number|null} trade_volume_sats    24h volume, sats (BCH-denominated)
 * @property {number|null} tvl_sats             Token-side TVL, sats
 * @property {number|null} tvl_tokens           Token-side TVL, base units
 * @property {number|null} apy_30d_bp           30d APY, basis points
 * @property {number|null} score                Indexer's discovery score (0..1, higher is better)
 * @property {number|null} score_rank           Indexer's rank (1 = highest score)
 * @property {number|null} [first_seen_ts_ms]   T37: ms-since-epoch of the token's oldest active pool.
 *                                              Sourced from the indexer's `first_pool_ts` field
 *                                              (UNIX seconds) and converted to ms by
 *                                              `Fetcher.buildStatsRecord`. Used by the ranker's
 *                                              `filterByMaxAge` and the entry gate's
 *                                              `min_pool_age_days` knob.
 */

/**
 * Raw shape returned by `GET /cauldron/tokens/list_cached?limit=N` on
 * the Cauldron indexer. `fetchData()` (T06) maps these into the
 * normalized `PoolStats` shape above; downstream code should never
 * consume `RawIndexerEntry` directly.
 *
 * @typedef {Object} RawIndexerEntry
 * @property {string} token_id
 * @property {string} [display_name]
 * @property {string} [display_symbol]
 * @property {Object} [bcmr]
 * @property {Object} [bcmr.token]
 * @property {string} [bcmr.token.symbol]
 * @property {number} [bcmr.token.decimals]
 * @property {string} [bcmr.name]
 * @property {number|null} [price_now]
 * @property {number|null} [price_now_usd]
 * @property {number|null} [price_24h]
 * @property {number|null} [price_7d]
 * @property {number|null} [change_24h_bp]
 * @property {number|null} [change_24h_usd_bp]
 * @property {number|null} [change_7d_bp]
 * @property {number|null} [change_7d_usd_bp]
 * @property {number|null} [trade_count]
 * @property {number|null} [trade_volume]
 * @property {number|null} [tvl_sats]
 * @property {number|null} [tvl_tokens]
 * @property {number|null} [apy_30d_bp]
 * @property {number|null} [score]
 * @property {number|null} [score_rank]
 * @property {number|null} [first_pool_ts]      T37: UNIX-seconds timestamp of the token's oldest
 *                                              active pool, as exposed by the indexer's
 *                                              `list_cached` discovery endpoint. Translated to
 *                                              `first_seen_ts_ms` (ms-since-epoch) by
 *                                              `Fetcher.buildStatsRecord`.
 * @property {Array<number>|null} [price_series_7d]   T28c: 29-point 7-day
 *                            normalized price series (current/max).
 *                            Indexer 1.0 = the max price seen in the
 *                            window, 0.0+ = a fraction of it. Used by
 *                            the scoring layer's `upwardVolatilityScore`
 *                            to distinguish "all-down" tokens from
 *                            "downtrend + upward spikes" tokens.
 */

/**
 * Sentinel "missing value" for stats fields. We use `null` (not
 * `undefined`, not `NaN`) so JSON serialization is explicit and so
 * downstream code can use `=== null` checks without tripping on the
 * `"undefined" === undefined` gotcha.
 *
 * @typedef {null} NullableStat
 */

// ─────────────────────────────────────────────────────────────────────
//  Pure helpers
// ─────────────────────────────────────────────────────────────────────

/** Match a 64-char lowercase hex string (32 bytes), optionally `0x`-prefixed. */
const TOKEN_ID_RE = /^(0x)?[0-9a-f]{64}$/;

/**
 * Canonicalize a token_id to 64 lowercase hex chars (no `0x` prefix).
 * Throws `TypeError` on bad input — callers that want a boolean should
 * use `isValidTokenId` instead.
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizeTokenId(raw) {
  if (typeof raw !== 'string') {
    throw new TypeError(`normalizeTokenId: expected string, got ${typeof raw}`);
  }
  const s = raw.toLowerCase().replace(/^0x/, '').trim();
  if (!TOKEN_ID_RE.test(s)) {
    throw new TypeError(
      `normalizeTokenId: expected 64-char hex (32 bytes), got "${raw.slice(0, 16)}…"` +
      ` (len=${raw.length})`,
    );
  }
  return s;
}

/**
 * Boolean form of `normalizeTokenId`. Returns `true` iff `raw` is a
 * well-formed token_id; never throws.
 *
 * @param {unknown} raw
 * @returns {boolean}
 */
export function isValidTokenId(raw) {
  if (typeof raw !== 'string') return false;
  const s = raw.toLowerCase().replace(/^0x/, '').trim();
  return TOKEN_ID_RE.test(s);
}

/**
 * Convert an integer basis-point value to a decimal percentage.
 * 500 bp → 5.0 (%). Safe for `null`/`undefined`/`NaN` — returns `null`
 * so callers don't accidentally treat missing data as 0.
 *
 * @param {number|null|undefined} bp
 * @returns {number|null}
 */
export function bpsToPct(bp) {
  if (bp === null || bp === undefined) return null;
  const n = Number(bp);
  if (!Number.isFinite(n)) return null;
  return n / 100;
}

/**
 * Convert a decimal percentage to integer basis points.
 * 5.0 (%) → 500 bp. Rounded to nearest integer.
 *
 * @param {number|null|undefined} pct
 * @returns {number|null}
 */
export function pctToBps(pct) {
  if (pct === null || pct === undefined) return null;
  const n = Number(pct);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/** Sats per BCH. Defined here so the constant lives next to its only consumers. */
export const SATS_PER_BCH = 100_000_000;

/**
 * Sats → BCH. Pure conversion. Returns `null` for nullish / non-finite
 * inputs (matches the `bpsToPct` policy).
 *
 * @param {number|null|undefined} sats
 * @returns {number|null}
 */
export function bchFromSats(sats) {
  if (sats === null || sats === undefined) return null;
  const n = Number(sats);
  if (!Number.isFinite(n)) return null;
  return n / SATS_PER_BCH;
}

/**
 * BCH → sats. Pure conversion. Returns `null` for nullish / non-finite.
 *
 * @param {number|null|undefined} bch
 * @returns {number|null}
 */
export function satsFromBch(bch) {
  if (bch === null || bch === undefined) return null;
  const n = Number(bch);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * SATS_PER_BCH);
}

/**
 * Spot buy rate (sats per token) for a pool. Returns `Infinity` when
 * `tokens ≤ 0` so the pool sorts to the BOTTOM in `Array.sort` — a
 * pool with no token reserves cannot be a buy target.
 *
 * Accepts `tokens` as `string | number | bigint` (the SDK / indexer
 * use mixed shapes); coerces via `Number()`. Returns `NaN` (which also
 * sorts to the bottom) for non-numeric inputs so callers don't have
 * to special-case them.
 *
 * @param {{ sats: number, tokens: string|number|bigint }} pool
 * @returns {number}
 */
export function spotRateSatsPerToken(pool) {
  if (!pool || typeof pool !== 'object') return NaN;
  const sats = Number(pool.sats);
  const tokens = Number(pool.tokens);
  if (!Number.isFinite(sats) || !Number.isFinite(tokens)) return NaN;
  if (tokens <= 0) return Infinity;
  if (sats < 0) return NaN;
  return sats / tokens;
}

/**
 * Shallow shape check for a `Pool` record. Used by the fetcher (T06)
 * to filter out malformed records before they reach the strategy
 * layer. Does NOT validate the hex token_id — call `isValidTokenId`
 * separately if you need that.
 *
 * @param {unknown} obj
 * @returns {boolean}
 */
export function isValidPool(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const p = /** @type {Record<string, unknown>} */ (obj);
  return (
    typeof p.pool_id === 'string' &&
    typeof p.token_id === 'string' &&
    Number.isFinite(Number(p.sats)) &&
    p.tokens !== undefined && p.tokens !== null &&
    typeof p.owner_p2pkh_addr === 'string' &&
    typeof p.txid === 'string' &&
    Number.isFinite(Number(p.tx_pos))
  );
}

/**
 * Shallow shape check for a `PoolStats` record. Only verifies that
 * `token_id` is a string; nullable numeric fields are allowed to be
 * `null` (the indexer's standard "missing" sentinel).
 *
 * @param {unknown} obj
 * @returns {boolean}
 */
export function isValidPoolStats(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const s = /** @type {Record<string, unknown>} */ (obj);
  return typeof s.token_id === 'string';
}

/**
 * Shallow shape check for a `Token` record. Same policy as
 * `isValidPoolStats` — only `token_id` is required.
 *
 * @param {unknown} obj
 * @returns {boolean}
 */
export function isValidToken(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const t = /** @type {Record<string, unknown>} */ (obj);
  return typeof t.token_id === 'string';
}
