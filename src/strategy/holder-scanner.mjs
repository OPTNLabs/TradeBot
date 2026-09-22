#!/usr/bin/env node
// src/strategy/holder-scanner.mjs
//
// T76 subset 2 — Live holder-concentration scanner.
//
// Wraps `https://tokenstork.com/api/tokens/<hex>/holders` (the only
// public BCH FT-UTXO holders endpoint discovered as of 2026-09-20
// — verified with curl: cauldron indexer + watchtower + cashtokenmarkets
// all 404 on the holders path) and maps the upstream envelope into
// the `validateHoldersInput` shape that `computeHolderConcentration()`
// already understands.
//
// The scanner is pure-shape + injected-IO: `fetchImpl` and `nowMs` are
// optional injection seams so tests can mock the upstream without
// touching the network. The cache is a SEPARATE module
// (`holder-scanner-cache.mjs`) — this file owns the fetch+map+shape
// surface, the cache owns the per-token TTL memoization.
//
// Wire shape (the public JSON the upstream returns, verified 2026-09-20):
//   {
//     "category": "<64-hex lowercase>",
//     "holders": [
//       { "address": "<cashaddr|pkh>",
//         "balance": "<decimal-string base units, BigInt-safe>",
//         "nftCount": <number>,
//         "snapshotAt": <unix-seconds> },
//       ...
//     ]
//   }
// On unknown / not-yet-indexed tokens:
//   { "message": "This token is not available." }
//
// Source verified live 2026-09-20 with three repeat calls returning
// identical bodies + a different-token call returning a different
// holders array + a non-existent-token call returning the
// "not available" envelope. No public API key required (GET-only).

import {
  validateHoldersInput,
  computeHolderConcentration,
  isRugPatternByHolders,
  resolveHolderConcentrationConfig,
} from './holder-concentration.mjs';

// ─────────────────────────────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────────────────────────────

/**
 * Default upstream base URL. The `tokenstork.com` public holders
 * endpoint. Verified reachable + JSON-shaped on 2026-09-20.
 *
 * Override via `scoring.concentration_rug_provider_url` in config
 * (knob catalog row registered in subset 2) — operators who mirror
 * the upstream behind a corp proxy / cache can set this without a
 * code change.
 */
export const DEFAULT_HOLDERS_SCANNER_BASE_URL = 'https://tokenstork.com';

/**
 * Default per-request timeout (ms). 5s is enough for a small JSON
 * payload; the upstream typically returns <1s. If the bot is on a
 * satellite link or behind a corp VPN, operators can raise this via
 * `scoring.concentration_rug_timeout_ms`.
 */
export const DEFAULT_HOLDERS_SCANNER_TIMEOUT_MS = 5000;

/**
 * Default per-token cache TTL (ms). Holder distribution is a slow-
 * changing signal — even a hot rug-pull token sees the holder set
 * move by <5% per hour. 5 minutes balances "fresh enough to catch
 * a dump" against "don't re-fetch on every tick".
 */
export const DEFAULT_HOLDERS_SCANNER_CACHE_MS = 300000;

/**
 * Max permitted cache TTL (sanity clamp). One hour is way more than
 * any operator would want; keeps a typo'd knob from disabling the
 * cache for a day.
 */
export const MAX_HOLDERS_SCANNER_CACHE_MS = 3600000;

/**
 * Max permitted fetch timeout (sanity clamp). 60s is way more than
 * any operator would want; keeps a typo'd knob from hanging a tick.
 */
export const MAX_HOLDERS_SCANNER_TIMEOUT_MS = 60000;

/**
 * Schema constant for the scanner envelope. Mirror'd in the
 * `src/dashboard/token-holders.mjs` response shape so the dashboard
 * can branch on a single field.
 */
export const HOLDERS_SCANNER_SCHEMA = 'tradebot.strategy.holder-scanner/v1';

/** Sources the scanner envelope surfaces on the wire. */
export const HOLDERS_SCANNER_SOURCE_TOKENSTORK = 'tokenstork';
export const HOLDERS_SCANNER_SOURCE_CACHE = 'cache';

// ─────────────────────────────────────────────────────────────────────
//  Typed errors
// ─────────────────────────────────────────────────────────────────────

export class HoldersScannerError extends Error {
  /**
   * @param {string} message
   * @param {{
   *   kind: string,
   *   token_id?: string|null,
   *   http_status?: number|null,
   *   upstream?: string|null,
   *   cause?: Error|null,
   * }} meta
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'HoldersScannerError';
    this.kind = meta.kind || 'unknown';
    this.token_id = meta.token_id ?? null;
    this.http_status = meta.http_status ?? null;
    this.upstream = meta.upstream ?? null;
    if (meta.cause) this.cause = meta.cause;
  }
}

export class HoldersScannerConfigError extends HoldersScannerError {
  constructor(message, meta = {}) {
    super(message, { ...meta, kind: meta.kind || 'config_invalid' });
    this.name = 'HoldersScannerConfigError';
  }
}

export class HoldersScannerFetchError extends HoldersScannerError {
  constructor(message, meta = {}) {
    super(message, { ...meta, kind: meta.kind || 'fetch_failed' });
    this.name = 'HoldersScannerFetchError';
  }
}

export class HoldersScannerParseError extends HoldersScannerError {
  constructor(message, meta = {}) {
    super(message, { ...meta, kind: meta.kind || 'parse_failed' });
    this.name = 'HoldersScannerParseError';
  }
}

export class HoldersScannerShapeError extends HoldersScannerError {
  constructor(message, meta = {}) {
    super(message, { ...meta, kind: meta.kind || 'shape_invalid' });
    this.name = 'HoldersScannerShapeError';
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Pure helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Validate the upstream TokenStork response shape. Pure: takes the
 * parsed JSON body, returns a typed envelope.
 *
 * Accepts:
 *   - { category: <64-hex>, holders: [{address, balance, nftCount?, snapshotAt?}, ...] }
 *   - { message: <string> }  (treated as `token_not_found`)
 *
 * Rejects everything else with `{ok:false, error:'shape_invalid'}`.
 *
 * @param {any} body  parsed JSON from the upstream
 * @returns {{ok: true, kind: 'holders_envelope', category: string, holders: Array} | {ok: true, kind: 'token_not_found', message: string} | {ok: false, error: string, message: string}}
 */
export function validateTokenStorkHoldersResponse(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'shape_invalid', message: 'upstream body must be a JSON object' };
  }
  // Not-found envelope — `{"message": "..."}` per the upstream.
  if (typeof body.message === 'string' && body.holders === undefined) {
    return { ok: true, kind: 'token_not_found', message: body.message };
  }
  // Holders envelope — must have `category` (64-hex) + `holders` (array).
  if (typeof body.category !== 'string') {
    return { ok: false, error: 'shape_invalid', message: 'upstream body missing `category` (string)' };
  }
  if (!/^[0-9a-f]{64}$/i.test(body.category)) {
    return { ok: false, error: 'shape_invalid', message: 'upstream `category` is not 64-hex' };
  }
  if (!Array.isArray(body.holders)) {
    return { ok: false, error: 'shape_invalid', message: 'upstream `holders` is not an array' };
  }
  return {
    ok: true,
    kind: 'holders_envelope',
    category: body.category.toLowerCase(),
    holders: body.holders,
  };
}

/**
 * Validate one upstream holder row. Pure. Drops bad rows (returns
 * `{ok:false, dropped:true, reason}` so the caller can decide to
 * keep counting them in a `_dropped` audit). Does NOT throw.
 *
 * @param {any} row
 * @returns {{ok: true, address: string, balance: string, nftCount: number, snapshotAt: number|null} | {ok: false, dropped: true, reason: string}}
 */
export function validateTokenStorkHolderRow(row) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    return { ok: false, dropped: true, reason: 'row_not_object' };
  }
  if (typeof row.address !== 'string' || row.address.length === 0) {
    return { ok: false, dropped: true, reason: 'address_missing_or_empty' };
  }
  // The upstream returns balance as a decimal STRING (BigInt-safe).
  // Accept number too for forward-compat (in case they switch to
  // JSON-numeric representation) but coerce to string for the
  // BigInt path. Reject NaN/Infinity/scientific that won't survive
  // BigInt coercion.
  let balanceStr;
  if (typeof row.balance === 'string') {
    balanceStr = row.balance.trim();
  } else if (typeof row.balance === 'number' && Number.isFinite(row.balance) && row.balance >= 0) {
    balanceStr = String(row.balance);
  } else if (typeof row.balance === 'bigint') {
    balanceStr = row.balance.toString();
  } else {
    return { ok: false, dropped: true, reason: 'balance_missing_or_invalid' };
  }
  if (!/^\d+$/.test(balanceStr)) {
    return { ok: false, dropped: true, reason: 'balance_not_unsigned_integer_string' };
  }
  // nftCount is optional. If present, must be a non-negative integer.
  let nftCount = 0;
  if (row.nftCount !== undefined && row.nftCount !== null) {
    if (typeof row.nftCount === 'number' && Number.isInteger(row.nftCount) && row.nftCount >= 0) {
      nftCount = row.nftCount;
    } else if (typeof row.nftCount === 'bigint') {
      nftCount = Number(row.nftCount);
    } else {
      // Malformed nftCount — default to 0 (T76 math doesn't use it).
      nftCount = 0;
    }
  }
  // snapshotAt is optional. Upstream returns unix-seconds. We keep
  // it as-is on the wire; the dashboard tile renders it.
  let snapshotAt = null;
  if (row.snapshotAt !== undefined && row.snapshotAt !== null) {
    if (typeof row.snapshotAt === 'number' && Number.isFinite(row.snapshotAt)) {
      snapshotAt = row.snapshotAt;
    } else if (typeof row.snapshotAt === 'bigint') {
      snapshotAt = Number(row.snapshotAt);
    }
  }
  return {
    ok: true,
    address: row.address,
    balance: balanceStr,
    nftCount,
    snapshotAt,
  };
}

/**
 * Map an upstream holders envelope (post `validateTokenStorkHoldersResponse`)
 * to the `{address, balance_base}` shape that `validateHoldersInput`
 * accepts in `src/strategy/holder-concentration.mjs`. Pure. Drops
 * malformed rows and counts them in `_dropped` for the audit row.
 *
 * @param {Array} upstreamHolders
 * @returns {{ok: true, holders: Array<{address: string, balance_base: string}>, _dropped: Array<{row_index: number, reason: string}>}}
 */
export function mapTokenStorkHoldersToHoldersInput(upstreamHolders) {
  if (!Array.isArray(upstreamHolders)) {
    return { ok: true, holders: [], _dropped: [{ row_index: -1, reason: 'upstream_holders_not_array' }] };
  }
  const out = [];
  const dropped = [];
  for (let i = 0; i < upstreamHolders.length; i++) {
    const v = validateTokenStorkHolderRow(upstreamHolders[i]);
    if (v.ok) {
      out.push({ address: v.address, balance_base: v.balance });
    } else {
      dropped.push({ row_index: i, reason: v.reason });
    }
  }
  return { ok: true, holders: out, _dropped: dropped };
}

/**
 * Build the upstream URL for a token. Pure.
 *
 * @param {string} tokenId  validated lowercase 64-hex
 * @param {string} [baseUrl]  override (default DEFAULT_HOLDERS_SCANNER_BASE_URL)
 * @returns {string}
 */
export function buildHoldersScannerUrl(tokenId, baseUrl = DEFAULT_HOLDERS_SCANNER_BASE_URL) {
  const base = (typeof baseUrl === 'string' && baseUrl.length > 0) ? baseUrl : DEFAULT_HOLDERS_SCANNER_BASE_URL;
  // Strip trailing slash so we can append `/api/tokens/<id>/holders`
  // deterministically. Don't trust upstream to tolerate either form.
  const trimmed = base.replace(/\/+$/, '');
  return `${trimmed}/api/tokens/${tokenId}/holders`;
}

/**
 * Resolve the runtime config (base URL + timeout + cache TTL) from
 * a raw config object. Defensive: bad values are silently replaced
 * with the defaults; an `applied` audit map tells the caller what
 * ended up in use. Pure.
 *
 * @param {Object} [cfg]
 * @returns {{
 *   baseUrl: string,
 *   timeoutMs: number,
 *   cacheMs: number,
 *   applied: { baseUrl: string, timeoutMs: number, cacheMs: number, baseUrl_source: string, timeoutMs_source: string, cacheMs_source: string }
 * }}
 */
export function resolveHoldersScannerConfig(cfg = {}) {
  const raw = (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) ? cfg : {};
  const sc = (raw.scoring && typeof raw.scoring === 'object' && !Array.isArray(raw.scoring)) ? raw.scoring : {};
  // baseUrl
  let baseUrl = DEFAULT_HOLDERS_SCANNER_BASE_URL;
  let baseUrlSource = 'default';
  if (typeof sc.concentration_rug_provider_url === 'string' && sc.concentration_rug_provider_url.length > 0) {
    try {
      const u = new URL(sc.concentration_rug_provider_url);
      if ((u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.length > 0) {
        baseUrl = sc.concentration_rug_provider_url.replace(/\/+$/, '');
        baseUrlSource = 'config';
      }
    } catch {
      // Bad URL → silently keep the default; knob-catalog UI
      // already validates but operators CAN hand-edit user.json.
    }
  }
  // timeoutMs
  let timeoutMs = DEFAULT_HOLDERS_SCANNER_TIMEOUT_MS;
  let timeoutMsSource = 'default';
  if (typeof sc.concentration_rug_timeout_ms === 'number' && Number.isFinite(sc.concentration_rug_timeout_ms) && sc.concentration_rug_timeout_ms > 0) {
    timeoutMs = Math.min(MAX_HOLDERS_SCANNER_TIMEOUT_MS, sc.concentration_rug_timeout_ms);
    timeoutMsSource = 'config';
  }
  // cacheMs (0 = disabled is allowed)
  let cacheMs = DEFAULT_HOLDERS_SCANNER_CACHE_MS;
  let cacheMsSource = 'default';
  if (typeof sc.concentration_rug_cache_ms === 'number' && Number.isFinite(sc.concentration_rug_cache_ms) && sc.concentration_rug_cache_ms >= 0) {
    cacheMs = Math.min(MAX_HOLDERS_SCANNER_CACHE_MS, sc.concentration_rug_cache_ms);
    cacheMsSource = 'config';
  }
  return {
    baseUrl,
    timeoutMs,
    cacheMs,
    applied: {
      baseUrl,
      timeoutMs,
      cacheMs,
      baseUrl_source: baseUrlSource,
      timeoutMs_source: timeoutMsSource,
      cacheMs_source: cacheMsSource,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
//  I/O wrapper: fetch + parse + map + shape
// ─────────────────────────────────────────────────────────────────────

/**
 * Fetch holders for a token from the upstream TokenStork endpoint.
 * Pure-shape I/O wrapper: takes injected `fetcher` + `nowMs` so
 * tests can mock the network without monkey-patching globalThis.
 *
 * NEVER throws on the hot path — every failure mode returns a
 * typed envelope the caller (cache / dashboard / loop) can branch
 * on without try/catch.
 *
 * @param {Object} args
 * @param {string} args.tokenId                          validated lowercase 64-hex
 * @param {typeof globalThis.fetch} [args.fetcher]       test seam (default globalThis.fetch)
 * @param {string} [args.baseUrl]                        override default upstream
 * @param {number} [args.timeoutMs]                      per-request timeout (default DEFAULT_HOLDERS_SCANNER_TIMEOUT_MS)
 * @param {() => number} [args.nowMs]                    clock (default Date.now)
 * @returns {Promise<
 *   | {ok: true, source: 'tokenstork', category: string, holders: Array<{address: string, balance_base: string, nft_count: number, snapshot_at_unix_s: number|null}>, snapshot_at_unix_s: number|null, fetched_at_ms: number, upstream: string}
 *   | {ok: true, source: 'tokenstork', category: string, holders: [], token_not_found: true, message: string, fetched_at_ms: number, upstream: string}
 *   | {ok: false, error: 'config_invalid'|'fetch_failed'|'parse_failed'|'shape_invalid'|'token_not_found_unexpected'|'http_error'|'timeout', message: string, http_status: number|null, upstream: string, fetched_at_ms: number}
 * >}
 */
export async function fetchTokenHoldersFromTokenStork(args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return {
      ok: false,
      error: 'config_invalid',
      message: 'fetchTokenHoldersFromTokenStork: args object required',
      http_status: null,
      upstream: DEFAULT_HOLDERS_SCANNER_BASE_URL,
      fetched_at_ms: Date.now(),
    };
  }
  const tokenId = typeof args.tokenId === 'string' ? args.tokenId.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(tokenId)) {
    return {
      ok: false,
      error: 'config_invalid',
      message: 'fetchTokenHoldersFromTokenStork: tokenId must be a 64-char hex string',
      http_status: null,
      upstream: typeof args.baseUrl === 'string' ? args.baseUrl : DEFAULT_HOLDERS_SCANNER_BASE_URL,
      fetched_at_ms: Date.now(),
    };
  }
  const baseUrl = (typeof args.baseUrl === 'string' && args.baseUrl.length > 0)
    ? args.baseUrl.replace(/\/+$/, '')
    : DEFAULT_HOLDERS_SCANNER_BASE_URL;
  const timeoutMs = (typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0)
    ? Math.min(MAX_HOLDERS_SCANNER_TIMEOUT_MS, args.timeoutMs)
    : DEFAULT_HOLDERS_SCANNER_TIMEOUT_MS;
  const fetcher = (typeof args.fetcher === 'function') ? args.fetcher : ((url, init) => globalThis.fetch(url, init));
  const nowMs = (typeof args.nowMs === 'function') ? args.nowMs : (() => Date.now());
  const url = `${baseUrl}/api/tokens/${tokenId}/holders`;

  // Acquire the fetch via AbortController so we can race against a
  // timeout without leaking timers.
  let res;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
    try {
      res = await fetcher(url, {
        method: 'GET',
        headers: { 'accept': 'application/json' },
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    const isAbort = (e && (e.name === 'AbortError' || /abort/i.test(String(e?.message || ''))));
    return {
      ok: false,
      error: isAbort ? 'timeout' : 'fetch_failed',
      message: (e && e.message) ? `fetch threw: ${e.message}` : 'fetch threw an unknown error',
      http_status: null,
      upstream: baseUrl,
      fetched_at_ms: nowMs(),
      token_id: tokenId,
    };
  }
  if (!res || typeof res !== 'object') {
    return {
      ok: false,
      error: 'fetch_failed',
      message: 'fetch returned a non-response value (network-layer returned null/undefined)',
      http_status: null,
      upstream: baseUrl,
      fetched_at_ms: nowMs(),
      token_id: tokenId,
    };
  }
  const httpStatus = typeof res.status === 'number' ? res.status : null;
  if (httpStatus === 404) {
    // Some upstreams return 404 instead of `{"message":"..."}`. Treat
    // as token_not_found for consistency.
    return {
      ok: true,
      source: 'tokenstork',
      category: tokenId,
      holders: [],
      token_not_found: true,
      message: `upstream returned HTTP 404 for ${tokenId}`,
      http_status: 404,
      fetched_at_ms: nowMs(),
      upstream: baseUrl,
    };
  }
  if (httpStatus !== null && (httpStatus < 200 || httpStatus >= 300)) {
    return {
      ok: false,
      error: 'http_error',
      message: `upstream returned HTTP ${httpStatus}`,
      http_status: httpStatus,
      upstream: baseUrl,
      fetched_at_ms: nowMs(),
      token_id: tokenId,
    };
  }
  // Parse the JSON body.
  let body;
  try {
    body = await res.json();
  } catch (e) {
    return {
      ok: false,
      error: 'parse_failed',
      message: (e && e.message) ? `upstream body is not valid JSON: ${e.message}` : 'upstream body is not valid JSON',
      http_status: httpStatus,
      upstream: baseUrl,
      fetched_at_ms: nowMs(),
      token_id: tokenId,
    };
  }
  // Validate shape.
  const shapeCheck = validateTokenStorkHoldersResponse(body);
  if (!shapeCheck.ok) {
    return {
      ok: false,
      error: 'shape_invalid',
      message: shapeCheck.message,
      http_status: httpStatus,
      upstream: baseUrl,
      fetched_at_ms: nowMs(),
      token_id: tokenId,
    };
  }
  // Token not found — surface as a successful empty envelope so
  // the caller doesn't have to branch on `error` to know the token
  // is just unindexed.
  if (shapeCheck.kind === 'token_not_found') {
    return {
      ok: true,
      source: 'tokenstork',
      category: tokenId,
      holders: [],
      token_not_found: true,
      message: shapeCheck.message,
      http_status: httpStatus,
      fetched_at_ms: nowMs(),
      upstream: baseUrl,
    };
  }
  // Map to the holders-input shape + flatten per-row metadata.
  const mapped = mapTokenStorkHoldersToHoldersInput(shapeCheck.holders);
  const holders = [];
  for (let i = 0; i < mapped.holders.length; i++) {
    const src = mapped.holders[i];
    // Re-derive nftCount + snapshotAt for each row (the mapper
    // dropped them when projecting to `validateHoldersInput`'s
    // minimal shape — they're only used on the wire envelope).
    const raw = validateTokenStorkHolderRow(shapeCheck.holders[i]);
    holders.push({
      address: src.address,
      balance_base: src.balance_base,
      nft_count: raw.ok ? raw.nftCount : 0,
      snapshot_at_unix_s: raw.ok ? raw.snapshotAt : null,
    });
  }
  // The upstream snapshots at one timestamp per call. Use the first
  // holder row's snapshotAt as the wire-level "snapshot_at_unix_s"
  // (if present); otherwise null.
  const firstSnapshot = holders.length > 0 && holders[0].snapshot_at_unix_s !== null
    ? holders[0].snapshot_at_unix_s
    : null;
  return {
    ok: true,
    source: 'tokenstork',
    category: shapeCheck.category,
    holders,
    snapshot_at_unix_s: firstSnapshot,
    fetched_at_ms: nowMs(),
    upstream: baseUrl,
    dropped_rows: mapped._dropped.length > 0 ? mapped._dropped : undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Concentration pass — single-token convenience wrapper
// ─────────────────────────────────────────────────────────────────────

/**
 * Convenience: fetch holders + run them through the existing
 * `computeHolderConcentration` math. Returns either a concentration
 * envelope (same shape `buildHoldersEnvelopeFromFixture` returns,
 * ready for the dashboard wire) OR a typed error envelope. The
 * optional `concentrationOpts` mirrors the knobs (rug_top_n,
 * rug_threshold_pct, epsilon_pct) so the operator can tune the
 * per-token check via the same knobs the fixture path honors.
 *
 * @param {Object} args
 * @param {string} args.tokenId
 * @param {Object} [args.concentrationOpts]  {rug_top_n, rug_threshold_pct, epsilon_pct}
 * @param {Object} [args.scannerOpts]        forwarded to fetchTokenHoldersFromTokenStork
 * @returns {Promise<{
 *   ok: boolean,
 *   schema: string,
 *   token_id: string,
 *   ts: number,
 *   error?: string,
 *   message?: string,
 *   fixture?: false,
 *   source?: string,
 *   holders_count?: number,
 *   top_n_count?: number,
 *   top_n_pct_of_supply?: number|null,
 *   total_supply_base?: string|null,
 *   is_rug_pattern?: boolean,
 *   config_applied?: object,
 *   snapshot_at_unix_s?: number|null,
 *   upstream?: string,
 *   cached?: boolean,
 *   cache_age_ms?: number,
 * }>}
 */
export async function fetchAndComputeHolderConcentration(args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return {
      ok: false,
      schema: HOLDERS_SCANNER_SCHEMA,
      token_id: null,
      ts: Date.now(),
      error: 'config_invalid',
      message: 'fetchAndComputeHolderConcentration: args object required',
    };
  }
  const tokenId = typeof args.tokenId === 'string' ? args.tokenId.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(tokenId)) {
    return {
      ok: false,
      schema: HOLDERS_SCANNER_SCHEMA,
      token_id: null,
      ts: Date.now(),
      error: 'invalid_token_id',
      message: 'token_id must be a 64-char lowercase hex string',
    };
  }
  const scannerOpts = (args.scannerOpts && typeof args.scannerOpts === 'object' && !Array.isArray(args.scannerOpts))
    ? args.scannerOpts
    : {};
  const fetched = await fetchTokenHoldersFromTokenStork({ tokenId, ...scannerOpts });
  if (!fetched.ok) {
    return {
      ok: false,
      schema: HOLDERS_SCANNER_SCHEMA,
      token_id: tokenId,
      ts: Date.now(),
      error: fetched.error,
      message: fetched.message,
      upstream: fetched.upstream,
      http_status: fetched.http_status,
    };
  }
  if (fetched.token_not_found) {
    return {
      ok: false,
      schema: HOLDERS_SCANNER_SCHEMA,
      token_id: tokenId,
      ts: Date.now(),
      error: 'token_not_found',
      message: fetched.message || 'upstream has not indexed this token yet',
      upstream: fetched.upstream,
      holders_count: 0,
    };
  }
  // Map holders back into the {address, balance} shape that
  // `computeHolderConcentration` accepts via `validateHoldersInput`.
  const holderInput = fetched.holders.map((h) => ({ address: h.address, balance: h.balance_base }));
  const validation = validateHoldersInput(holderInput);
  if (!validation.ok) {
    return {
      ok: false,
      schema: HOLDERS_SCANNER_SCHEMA,
      token_id: tokenId,
      ts: Date.now(),
      error: validation.error || 'validation_failed',
      message: validation.message || 'mapped holders failed validation',
      upstream: fetched.upstream,
    };
  }
  const concentrationOpts = (args.concentrationOpts && typeof args.concentrationOpts === 'object' && !Array.isArray(args.concentrationOpts))
    ? args.concentrationOpts
    : {};
  const envelope = computeHolderConcentration({
    token_id: tokenId,
    holders: validation.holders,
    decimals: null,
    opts: concentrationOpts,
  });
  // Compute the rug predicate with the same resolved config.
  const configResolved = resolveHolderConcentrationConfig(concentrationOpts);
  const rug = isRugPatternByHolders(validation.holders, concentrationOpts);
  return {
    ok: true,
    schema: HOLDERS_SCANNER_SCHEMA,
    token_id: tokenId,
    ts: Date.now(),
    fixture: false,
    source: fetched.source,
    holders_count: fetched.holders.length,
    top_n_count: envelope.top_n,
    top_n_pct_of_supply: envelope.top_n_pct,
    total_supply_base: envelope.total_supply_base,
    is_rug_pattern: rug,
    config_applied: configResolved.applied,
    snapshot_at_unix_s: fetched.snapshot_at_unix_s,
    upstream: fetched.upstream,
    envelope, // full concentration envelope (top-holders, pct, human-readable rows)
    dropped_rows: fetched.dropped_rows,
  };
}
