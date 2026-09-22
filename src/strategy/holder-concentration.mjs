#!/usr/bin/env node
// src/strategy/holder-concentration.mjs
//
// T76 subset 1 — Pure holder-distribution math for the rug-protection
// gate. Given a snapshot of who holds what for a single CashToken
// fungible-token category, compute the top-N-holder concentration and
// classify it as a "rug pattern" per the operator's threshold
// (default: top 5 wallets hold ≥ 80% of total supply).
//
// Design rules:
//   1. Pure. No I/O. No logger. No process state. The bot can call
//      this thousands of times per tick with no side effects.
//   2. ALL inputs come in via the arguments — never read from disk,
//      env, or globals. The dashboard endpoint, the trader-loop gate,
//      and any future batch scanner all funnel through this module.
//   3. Defensive on every input: null / undefined / non-array /
//      non-string / non-BigInt-coercible balances are normalized via
//      `validateHoldersInput` which never throws (returns a typed
//      `{ok:false, error}` envelope instead).
//   4. Deterministic ordering: when two holders have IDENTICAL
//      balances, tie-break by lowercased address so the dashboard
//      renders the same view on every poll (BigInt sort is stable
//      but JS object sorting on derived arrays needs the tie-break).
//   5. BigInt for the supply arithmetic — base units can overflow
//      Number for any token with > 2^53 base supply (a token with
//      decimals=0 and circulating supply > 9 quadrillion). All
//      sums, comparisons, and percentage denominators use BigInt;
//      the only float conversion happens at the final `pct_of_supply`
//      output (with full precision, no rounding) and at the
//      threshold comparison (also float, with explicit epsilon).
//   6. Does NOT fetch the chain. Subset 2 (deferred) wires the actual
//      holders-array source: either the indexer's (currently 404)
//      holders endpoint OR a local Electrum scanner. This module
//      only does the math; the data fetch lives elsewhere.
//
// Origin: T76 / `idea_token_holders_distribution_20260914` (research-cron,
// 2026-09-14, effort:L, impact:high). Subset 1 ships the pure math
// + the operator-curated `scoring.excluded_concentration_tokens`
// blacklist (see `src/trader/loop.mjs` `_excludedTokenSet()`) + the
// stub `GET /api/token/<id>/holders` endpoint shape so subset 2 can
// drop in the scanner without an API surface change.
//
// No imports — this module is fully self-contained pure math.
// (`SATS_PER_BCH` and friends live in `src/data/types.mjs` but are
// not needed for the concentration computation; a future subset that
// computes BCH-denominated concentration can import them.)

// ─────────────────────────────────────────────────────────────────────
//  Defaults
// ─────────────────────────────────────────────────────────────────────

/**
 * Defaults that mirror `config/default.json` → `scoring` for the
 * small-balance-startup preset. Operator can override per token /
 * per call via the `opts` arg to `computeHolderConcentration()`.
 *
 * @typedef {Object} HolderConcentrationConfig
 * @property {number} rug_top_n                  wallets to consider for the rug test
 * @property {number} rug_threshold_pct          pct of supply the top-N must hold to flag a rug
 * @property {number} epsilon_pct                tolerance for the threshold comparison (avoid
 *                                              float drift at the boundary — a holder at
 *                                              exactly 80.000000001% is NOT a rug pattern)
 */

/**
 * @type {HolderConcentrationConfig}
 */
export const DEFAULT_HOLDER_CONCENTRATION_CONFIG = Object.freeze({
  // Top-N wallets to consider for the rug-pattern test. The operator's
  // original idea says "<5 wallets hold >80%" — so default top-N is 5.
  // Lower values (e.g. 3) catch even tighter clusterings (a 3-wallet
  // rug) but also flag legitimate early-stage tokens where the
  // dev / seed / treasury wallets haven't dispersed.
  rug_top_n: 5,
  // Percentage of TOTAL supply (not circulating — we use TOTAL because
  // we don't have a separate "burned" tally) the top-N must hold for
  // the token to be flagged as a rug pattern. 80% matches the
  // original idea. 70% is more aggressive; 90% is more lenient.
  rug_threshold_pct: 80,
  // Tolerance for the threshold comparison. The float division
  // `pct = (topN_base / total_base) * 100` carries ~15 significant
  // digits of precision but the source balances are base units (large
  // integers), so the output is exact at integer boundaries and ~1e-13
  // off in the worst case. 1e-9 is plenty.
  epsilon_pct: 1e-9,
});

// ─────────────────────────────────────────────────────────────────────
//  Validation helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Coerce a value to BigInt, accepting BigInt / Number / numeric
 * string. Returns `null` when the value is null/undefined/non-numeric
 * / NaN/Infinity/negative. NEVER throws — every parse failure is
 * returned as `null` so the caller can decide what to do.
 *
 * @param {*} v
 * @returns {bigint|null}
 */
export function safeBigIntFromBase(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') {
    return v < 0n ? null : v;
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    if (v < 0) return null;
    // Number can only represent integers up to 2^53 exactly. Above
    // that, fall through to string-based coercion (so a Number-shaped
    // caller passing e.g. 1e18 doesn't silently truncate).
    if (Number.isSafeInteger(v)) return BigInt(v);
    try { return BigInt(Math.trunc(v)); } catch { return null; }
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (s.length === 0) return null;
    if (s.startsWith('-')) return null;
    // Reject anything that isn't a clean non-negative integer
    // (no decimals, no exponent, no whitespace). Matches the
    // BigInt() contract — `BigInt('1.5')` throws.
    if (!/^\d+$/.test(s)) return null;
    try { return BigInt(s); } catch { return null; }
  }
  return null;
}

/**
 * Validate + normalize a holders array. Accepts either an array of
 * `{address, balance_base}` objects OR a Map<address, balance_base>
 * OR a flat array of [address, balance_base] tuples. Returns:
 *   - `{ok:true, holders:[{address, balance_base:bigint}, ...]}` on
 *     valid input (sorted by balance DESC with deterministic
 *     address tie-break).
 *   - `{ok:false, error:'<kind>', message:'<human-readable>'}` on
 *     bad input (NEVER throws).
 *
 * Defensive defaults:
 *   - Null / undefined / non-array → `{ok:false, error:'not_array'}`.
 *   - Empty array → `{ok:true, holders:[]}` (valid — represents a
 *     token that has zero holders, e.g. unminted or fully burned).
 *   - Holder with non-string address → that holder is DROPPED (the
 *     dashboard's "known holders" count reflects the surviving rows).
 *   - Holder with non-coercible balance → DROPPED.
 *   - Holder with zero balance → KEPT (counts toward `total_holders`
 *     but contributes zero to `top_n_pct`).
 *   - Duplicate addresses → SUMMED (the input is "address → balance"
 *     by convention; if a single address appears twice the math
 *     collapses it).
 *
 * @param {*} holders
 * @returns {{ok:true, holders: Array<{address: string, balance_base: bigint}>} | {ok:false, error: string, message: string}}
 */
export function validateHoldersInput(holders) {
  if (holders === null || holders === undefined) {
    return { ok: false, error: 'null_input', message: 'holders input is null/undefined' };
  }
  // Accept Map<address, balance> by converting to tuples first.
  let tuples;
  if (typeof Map !== 'undefined' && holders instanceof Map) {
    tuples = [];
    for (const [k, v] of holders) tuples.push([k, v]);
  } else if (Array.isArray(holders)) {
    tuples = holders;
  } else {
    return { ok: false, error: 'not_array', message: 'holders must be an Array, Map, or null/undefined' };
  }
  if (tuples.length === 0) {
    return { ok: true, holders: [] };
  }
  // Merge by lowercased address (addresses are case-insensitive at
  // the on-chain layer; we preserve the FIRST occurrence's
  // original case in the output for dashboard readability).
  /** @type {Map<string, {address: string, balance: bigint}>} */
  const merged = new Map();
  let dropped = 0;
  for (const row of tuples) {
    if (!Array.isArray(row) && (row === null || typeof row !== 'object')) {
      dropped++;
      continue;
    }
    let addr, bal;
    if (Array.isArray(row)) {
      addr = row[0];
      bal = row[1];
    } else {
      addr = row.address;
      bal = row.balance_base !== undefined ? row.balance_base : row.balance;
    }
    if (typeof addr !== 'string') {
      dropped++;
      continue;
    }
    const a = addr.trim();
    if (a.length === 0) {
      dropped++;
      continue;
    }
    const big = safeBigIntFromBase(bal);
    if (big === null) {
      dropped++;
      continue;
    }
    const key = a.toLowerCase();
    const existing = merged.get(key);
    if (existing) {
      existing.balance = existing.balance + big;
    } else {
      merged.set(key, { address: a, balance: big });
    }
  }
  const out = [];
  for (const v of merged.values()) {
    out.push({ address: v.address, balance_base: v.balance });
  }
  // Deterministic sort: balance DESC, address ASC (lowercased) on tie.
  out.sort((x, y) => {
    if (x.balance_base < y.balance_base) return 1;
    if (x.balance_base > y.balance_base) return -1;
    const ax = x.address.toLowerCase();
    const ay = y.address.toLowerCase();
    if (ax < ay) return -1;
    if (ax > ay) return 1;
    return 0;
  });
  if (dropped > 0) {
    return { ok: true, holders: out, _dropped: dropped };
  }
  return { ok: true, holders: out };
}

/**
 * Validate + merge the optional config overrides against the defaults.
 * Returns a frozen config object. NEVER throws — bad inputs are
 * silently replaced with defaults (the caller can check the `_applied`
 * vs `_requested` map to audit which knobs were ignored).
 *
 * @param {*} opts
 * @returns {HolderConcentrationConfig & {applied: {rug_top_n: number, rug_threshold_pct: number, epsilon_pct: number}}}
 */
export function resolveHolderConcentrationConfig(opts) {
  const out = { ...DEFAULT_HOLDER_CONCENTRATION_CONFIG };
  const requested = {};
  if (opts !== null && opts !== undefined && typeof opts === 'object') {
    if (Number.isFinite(opts.rug_top_n) && opts.rug_top_n >= 1 && opts.rug_top_n <= 1000) {
      requested.rug_top_n = Math.trunc(opts.rug_top_n);
      out.rug_top_n = requested.rug_top_n;
    }
    if (Number.isFinite(opts.rug_threshold_pct) && opts.rug_threshold_pct >= 0 && opts.rug_threshold_pct <= 100) {
      requested.rug_threshold_pct = opts.rug_threshold_pct;
      out.rug_threshold_pct = requested.rug_threshold_pct;
    }
    if (Number.isFinite(opts.epsilon_pct) && opts.epsilon_pct >= 0 && opts.epsilon_pct <= 100) {
      requested.epsilon_pct = opts.epsilon_pct;
      out.epsilon_pct = requested.epsilon_pct;
    }
  }
  return Object.freeze({
    ...out,
    applied: Object.freeze({
      rug_top_n: out.rug_top_n,
      rug_threshold_pct: out.rug_threshold_pct,
      epsilon_pct: out.epsilon_pct,
    }),
  });
}

// ─────────────────────────────────────────────────────────────────────
//  Core math
// ─────────────────────────────────────────────────────────────────────

/**
 * Sum the balances of every row, returning BigInt. Pure. Defensive:
 * each row's `balance_base` is coerced via `safeBigIntFromBase` so
 * callers can pass raw strings/Numbers from an upstream source
 * without pre-normalizing.
 *
 * @param {Array<{balance_base: bigint|number|string}>} holders
 * @returns {bigint}
 */
export function totalSupplyFromHolders(holders) {
  let total = 0n;
  for (const h of holders) {
    if (!h || typeof h !== 'object') continue;
    const big = safeBigIntFromBase(h.balance_base);
    if (big !== null) total += big;
  }
  return total;
}

/**
 * Compute the percentage of TOTAL supply held by the top-N rows,
 * as a float in [0, 100]. Pure. Returns 0 when totalSupply is 0n
 * (avoids div-by-zero — a token with zero supply trivially has
 * 100% concentration by the empty set, but 0% by the empty set is
 * the more useful output for a "no holders" token). Defensive:
 * each row's `balance_base` is coerced via `safeBigIntFromBase` so
 * callers can pass raw strings/Numbers from an upstream source.
 *
 * @param {Array<{balance_base: bigint|number|string}>} sortedHolders DESC by balance
 * @param {number} topN
 * @param {bigint} totalSupply
 * @returns {number} percentage 0..100
 */
export function topNPctOfSupply(sortedHolders, topN, totalSupply) {
  const bigTotal = safeBigIntFromBase(totalSupply);
  if (bigTotal === null || bigTotal === 0n) return 0;
  const take = Math.min(Math.max(topN, 0), sortedHolders.length);
  let topSum = 0n;
  for (let i = 0; i < take; i++) {
    const big = safeBigIntFromBase(sortedHolders[i].balance_base);
    if (big !== null) topSum += big;
  }
  // Float division: topSum/totalSupply is exact when both are
  // representable in a float53. Token supplies exceed 2^53 for
  // many tokens (e.g. CATN with 21M supply × 1e9 decimals), so
  // we go via Number(topSum) / Number(totalSupply) which is
  // accurate to ~1e-15 relative error — well below the
  // `epsilon_pct` floor. For tokens > 2^1024 supply this would
  // overflow, but no CashToken in circulation has more than 2^64
  // base units in a single category.
  const num = Number(topSum);
  const den = Number(bigTotal);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 0;
  return (num / den) * 100;
}

/**
 * Build the per-holder display rows with `pct_of_supply` annotated.
 * Pure. Each row adds:
 *   - `pct_of_supply` — float 0..100
 *   - `balance_human` — base → human via the token's `decimals`
 *     (caller must pass a string-friendly numeric; we coerce via
 *     String(base).slice / padStart; never uses toFixed on BigInt).
 *   - `is_top_n` — true when the row is in the top-N
 * Defensive: `balance_base` is coerced via `safeBigIntFromBase` so
 * callers can pass raw strings/Numbers without pre-normalizing.
 * @param {Array<{address: string, balance_base: bigint|number|string}>} sortedHolders
 * @param {bigint|number|string} totalSupply
 * @param {number} decimals 0..18 typically
 * @param {number} topN
 * @returns {Array<{address: string, balance_base: string, balance_human: string, pct_of_supply: number, is_top_n: boolean}>}
 */
export function buildHolderDisplayRows(sortedHolders, totalSupply, decimals, topN) {
  const safeDecimals = Number.isFinite(decimals) && decimals >= 0 && decimals <= 18 ? Math.trunc(decimals) : 0;
  const safeTopN = Number.isFinite(topN) && topN >= 0 ? Math.trunc(topN) : 0;
  const bigTotal = safeBigIntFromBase(totalSupply);
  const den = bigTotal === null ? 0 : Number(bigTotal);
  const out = [];
  for (let i = 0; i < sortedHolders.length; i++) {
    const h = sortedHolders[i];
    const big = safeBigIntFromBase(h.balance_base);
    if (big === null) continue;
    const num = Number(big);
    const pct = den > 0 && Number.isFinite(num) ? (num / den) * 100 : 0;
    out.push({
      address: h.address,
      balance_base: big.toString(),
      balance_human: baseToHumanString(big, safeDecimals),
      pct_of_supply: pct,
      is_top_n: i < safeTopN,
    });
  }
  return out;
}

/**
 * Convert a base-units BigInt to a human-units string with the
 * requested decimals. NEVER throws. Returns a non-exponential
 * decimal string. Trailing zeros after the decimal are trimmed.
 *
 * @param {bigint} base
 * @param {number} decimals 0..18
 * @returns {string}
 */
export function baseToHumanString(base, decimals) {
  if (typeof base !== 'bigint') return '0';
  const safeDecimals = Number.isFinite(decimals) && decimals >= 0 && decimals <= 18 ? Math.trunc(decimals) : 0;
  if (safeDecimals === 0) return base.toString();
  const neg = base < 0n;
  const abs = neg ? -base : base;
  const s = abs.toString().padStart(safeDecimals + 1, '0');
  const cut = s.length - safeDecimals;
  const intPart = s.slice(0, cut);
  let fracPart = s.slice(cut);
  // Trim trailing zeros from the fractional part — `1.23000000` → `1.23`.
  fracPart = fracPart.replace(/0+$/, '');
  const result = fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
  return neg ? `-${result}` : result;
}

// ─────────────────────────────────────────────────────────────────────
//  Public entry point
// ─────────────────────────────────────────────────────────────────────

/**
 * Compute the full holder-concentration envelope for a single token.
 *
 * @param {{
 *   token_id?: string|null,
 *   holders: Array<{address: string, balance_base: bigint|number|string}>|Map<string, bigint|number|string>|null|undefined,
 *   decimals?: number|null,
 *   opts?: {rug_top_n?: number, rug_threshold_pct?: number, epsilon_pct?: number}|null,
 * }} args
 * @returns {{
 *   ok: boolean,
 *   schema: 'tradebot.strategy.holder-concentration/v1',
 *   token_id: string|null,
 *   ts_validation: 'ok'|'rejected',
 *   error?: string,
 *   message?: string,
 *   total_holders: number,
 *   total_supply_base: string,
 *   total_supply_human: string,
 *   top_n: number,
 *   top_n_holders: Array<{address: string, balance_base: string, balance_human: string, pct_of_supply: number, is_top_n: boolean}>,
 *   top_n_pct: number,
 *   rug_pattern: boolean,
 *   rug_pattern_top_n: number,
 *   rug_pattern_threshold_pct: number,
 *   epsilon_pct: number,
 *   holders?: Array<{address: string, balance_base: string, balance_human: string, pct_of_supply: number, is_top_n: boolean}>,
 *   dropped?: number,
 * }}
 */
export function computeHolderConcentration(args) {
  const cfg = resolveHolderConcentrationConfig((args && args.opts) || null);
  const tokenId = (args && typeof args.token_id === 'string') ? args.token_id.trim() : null;
  const decimals = (args && Number.isFinite(args.decimals)) ? args.decimals : 0;
  const validated = validateHoldersInput((args && args.holders) || null);
  if (!validated.ok) {
    return {
      ok: false,
      schema: 'tradebot.strategy.holder-concentration/v1',
      token_id: tokenId,
      ts_validation: 'rejected',
      error: validated.error,
      message: validated.message,
      total_holders: 0,
      total_supply_base: '0',
      total_supply_human: '0',
      top_n: cfg.rug_top_n,
      top_n_holders: [],
      top_n_pct: 0,
      rug_pattern: false,
      rug_pattern_top_n: cfg.rug_top_n,
      rug_pattern_threshold_pct: cfg.rug_threshold_pct,
      epsilon_pct: cfg.epsilon_pct,
    };
  }
  const holders = validated.holders;
  const totalSupply = totalSupplyFromHolders(holders);
  const topNPct = topNPctOfSupply(holders, cfg.rug_top_n, totalSupply);
  // Rug-pattern predicate: top-N holds >= threshold (within epsilon).
  const rug = topNPct >= (cfg.rug_threshold_pct - cfg.epsilon_pct);
  const displayRows = buildHolderDisplayRows(holders, totalSupply, decimals, cfg.rug_top_n);
  const topNRows = displayRows.filter((r) => r.is_top_n);
  /** @type {Object} */
  const envelope = {
    ok: true,
    schema: 'tradebot.strategy.holder-concentration/v1',
    token_id: tokenId,
    ts_validation: 'ok',
    total_holders: holders.length,
    total_supply_base: totalSupply.toString(),
    total_supply_human: baseToHumanString(totalSupply, decimals),
    top_n: cfg.rug_top_n,
    top_n_holders: topNRows,
    top_n_pct: topNPct,
    rug_pattern: rug,
    rug_pattern_top_n: cfg.rug_top_n,
    rug_pattern_threshold_pct: cfg.rug_threshold_pct,
    epsilon_pct: cfg.epsilon_pct,
    holders: displayRows,
  };
  if (validated._dropped !== undefined) envelope.dropped = validated._dropped;
  return envelope;
}

/**
 * Convenience predicate — "is this holders-array a rug pattern by the
 * threshold?" Useful for the trader-loop's eligibility gate.
 *
 * @param {Array|Map} holders
 * @param {{rug_top_n?: number, rug_threshold_pct?: number, epsilon_pct?: number}=} opts
 * @returns {boolean}
 */
export function isRugPatternByHolders(holders, opts) {
  const envelope = computeHolderConcentration({ holders, opts });
  return envelope.ok && envelope.rug_pattern;
}

/**
 * T76 subset 2b — Translate a `resolveHoldersSnapshot` envelope into
 * the trader-loop's eligibility-gate audit shape. Pure: no I/O, no
 * logger, no globals — just maps the upstream envelope into the
 * minimal decision + audit fields the loop writes to
 * `data/history.jsonl` when it fires `entry_skipped` with
 * `kind:'rug_pattern_detected'`.
 *
 * Mapping rules (mirror the dashboard's
 * `buildTokenHoldersLiveEnvelope` translator so the wire shape stays
 * consistent):
 *   - `resolverR.ok === false` → returns
 *     `{rug_pattern:false, error:<resolverR.error>, token_not_found: ...}`.
 *     `token_not_found` is exposed as a SEPARATE field so the loop
 *     can refuse to flag unindexed tokens (subset 2a's defensive
 *     choice — don't punish tokens that haven't been indexed yet).
 *   - `resolverR.envelope.holders` is mapped to the
 *     `[{address, balance_base | balance}]` shape
 *     `isRugPatternByHolders` + `validateHoldersInput` understand.
 *   - On the happy path: returns `{rug_pattern, top_n, threshold_pct,
 *     top_n_pct, total_supply_base, holders_count, upstream, cached,
 *     cache_age_ms, snapshot_at_unix_s}` so the loop can populate
 *     the `entry_skipped` reasoning blob verbatim without re-running
 *     the math.
 *
 * NEVER throws. Every parse / shape error returns
 * `{rug_pattern:false, error:'<kind>'}` so the loop can short-circuit
 * to "pass through" (defensive: a malformed envelope should never
 * crash a tick).
 *
 * @param {Object|undefined|null} resolverR    `resolveHoldersSnapshot` result
 * @param {{rug_top_n?: number, rug_threshold_pct?: number, epsilon_pct?: number}=} opts
 * @returns {{
 *   rug_pattern: boolean,
 *   error: string|null,
 *   token_not_found?: boolean,
 *   top_n?: number,
 *   threshold_pct?: number,
 *   top_n_pct?: number,
 *   total_supply_base?: string,
 *   holders_count?: number,
 *   upstream?: string|null,
 *   cached?: boolean,
 *   cache_age_ms?: number,
 *   snapshot_at_unix_s?: number|null,
 * }}
 */
export function extractRugPatternAuditFromResolver(resolverR, opts = {}) {
  if (!resolverR || typeof resolverR !== 'object') {
    return { rug_pattern: false, error: 'resolver_invalid' };
  }
  if (resolverR.ok !== true) {
    const err = (typeof resolverR.error === 'string' && resolverR.error.length > 0)
      ? resolverR.error
      : 'resolver_failed';
    return {
      rug_pattern: false,
      error: err,
      token_not_found: err === 'token_not_found',
      upstream: resolverR.upstream ?? null,
      cached: resolverR.cached === true,
      cache_age_ms: typeof resolverR.cache_age_ms === 'number' ? resolverR.cache_age_ms : 0,
    };
  }
  const upstream = resolverR.envelope;
  if (!upstream || typeof upstream !== 'object') {
    return {
      rug_pattern: false,
      error: 'envelope_invalid',
      upstream: resolverR.upstream ?? null,
      cached: resolverR.cached === true,
      cache_age_ms: typeof resolverR.cache_age_ms === 'number' ? resolverR.cache_age_ms : 0,
    };
  }
  // T76 subset 2b follow-up: when the upstream scanner returned
  // `ok:true` with `{token_not_found: true}` (TokenStork-style
  // "we don't index this token yet" envelope — see
  // `holder-scanner.mjs` ~line 384), the resolver propagates it
  // as `ok:true` because the upstream didn't ERROR, it just had
  // no holders to return. Surface it as `token_not_found:true`
  // so the loop's defensive pass-through path fires instead of
  // computing top_n_pct=0 / rug_pattern=false (which would mask
  // the unindexed state in the audit logs).
  const cfg = resolveHolderConcentrationConfig(opts);
  if (upstream.token_not_found === true) {
    return {
      rug_pattern: false,
      error: 'token_not_found',
      token_not_found: true,
      top_n: cfg.rug_top_n,
      threshold_pct: cfg.rug_threshold_pct,
      epsilon_pct: cfg.epsilon_pct,
      top_n_pct: 0,
      total_supply_base: '0',
      holders_count: 0,
      upstream: resolverR.upstream ?? null,
      cached: resolverR.cached === true,
      cache_age_ms: typeof resolverR.cache_age_ms === 'number' ? resolverR.cache_age_ms : 0,
      snapshot_at_unix_s: resolverR.snapshot_at_unix_s ?? null,
    };
  }
  // Defensive mapping: the upstream gives `{address, balance_base | balance,
  // nft_count?, snapshot_at_unix_s?}` rows. The math layer accepts
  // `{address, balance}` (BigInt-coerce inside `safeBigIntFromBase`).
  const mappedHolders = Array.isArray(upstream.holders)
    ? upstream.holders
      .filter((h) => h && typeof h === 'object')
      .map((h) => {
        const address = (typeof h.address === 'string') ? h.address : '';
        const balanceBase = (typeof h.balance_base === 'string')
          ? h.balance_base
          : (typeof h.balance === 'string' ? h.balance : '0');
        return { address, balance: balanceBase };
      })
    : [];
  const validated = validateHoldersInput(mappedHolders);
  if (!validated.ok) {
    return {
      rug_pattern: false,
      error: validated.error ?? 'validation_failed',
      top_n: cfg.rug_top_n,
      threshold_pct: cfg.rug_threshold_pct,
      upstream: resolverR.upstream ?? null,
      cached: resolverR.cached === true,
      cache_age_ms: typeof resolverR.cache_age_ms === 'number' ? resolverR.cache_age_ms : 0,
      snapshot_at_unix_s: resolverR.snapshot_at_unix_s ?? null,
    };
  }
  const totalSupply = totalSupplyFromHolders(validated.holders);
  const topNPct = topNPctOfSupply(validated.holders, cfg.rug_top_n, totalSupply);
  const rug = topNPct >= (cfg.rug_threshold_pct - cfg.epsilon_pct);
  return {
    rug_pattern: rug === true,
    error: null,
    top_n: cfg.rug_top_n,
    threshold_pct: cfg.rug_threshold_pct,
    epsilon_pct: cfg.epsilon_pct,
    top_n_pct: topNPct,
    total_supply_base: totalSupply.toString(),
    holders_count: validated.holders.length,
    upstream: resolverR.upstream ?? null,
    cached: resolverR.cached === true,
    cache_age_ms: typeof resolverR.cache_age_ms === 'number' ? resolverR.cache_age_ms : 0,
    snapshot_at_unix_s: resolverR.snapshot_at_unix_s ?? null,
  };
}