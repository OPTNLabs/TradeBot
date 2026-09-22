#!/usr/bin/env node
// src/dashboard/token-holders.mjs
//
// T76 subset 1 — Stub `GET /api/token/:tokenId/holders` endpoint.
// T76 subset 2a — LIVE scanner wire-up (default OFF via
// `scoring.concentration_rug_enabled`). When the knob is enabled,
// the endpoint resolves via `resolveHoldersSnapshot()` from
// `src/strategy/holder-scanner-cache.mjs` (which composes the
// TokenStork upstream + the in-process per-token TTL cache). The
// wire shape stays the same as the stub — the dashboard React layer
// never has to branch on "stub vs live".
//
// The Cauldron indexer (`https://indexer.cauldron.quest/cauldron/`
// and `https://indexer.riften.net/cauldron/`) does NOT surface a
// token-holders endpoint as of 2026-09-20 — verified via the
// `idea_token_holders_distribution_20260914` idea background (all
// path shapes tried — `/token/holders/<id>`, `/tokens/<id>/holders`,
// `/holders/<id>`, `/holders?token=<id>`, `/token/distribution/<id>`,
// `/distribution/<id>` — every one 404s). To ship the rug-protection
// gate end-to-end we either wait for the indexer team to ship a
// holders endpoint (no public ETA) or build an in-process scanner
// that walks the BCH chain history for every CashTokens FT output
// belonging to a token category. The latter is what T76 subset 2
// will do.
//
// THIS FILE ships the wire shape (`/api/token/<id>/holders` returns
// `{ok:false, error:'scanner_not_implemented', message:'...'}`)
// so subset 2 can drop the scanner in WITHOUT changing the API
// surface. The dashboard tile / chart / whatever subset 2 adds can
// already be wired against this endpoint and just show "scanner
// not yet implemented" until subset 2 lands.
//
// Also ships the *pure* math layer via
// `src/strategy/holder-concentration.mjs` (see T76 subset 1 of
// the TODO queue). This module wires THAT math through a fake
// fixture path that the operator can hit today to verify the
// envelope shape — `?holders=<urlencoded-json>` skips the scanner
// and runs the math directly. This is the same "off-chain fixture"
// affordance T63's `/api/tokens/summary` ships for operator testing.
//
// Design rules:
//   1. **Never throws on the hot path.** Even a bad regex match
//      or unparseable JSON body returns a typed envelope.
//   2. **Defensive token_id validation.** The 64-hex match mirrors
//      `/api/token/:tokenId` — same regex, same error envelope.
//   3. **No state.** Pure module that the route handler dispatches
//      to. The dashboard server.mjs owns the HTTP wiring.
//   4. **Backwards-compatible with subset 2.** When subset 2 wires
//      the real scanner, the response shape stays the same
//      (`{ok, schema, token_id, ...}`) so the dashboard React
//      layer never has to branch on "is this a stub or a real
//      scanner response?".

import {
  computeHolderConcentration,
  isRugPatternByHolders,
  validateHoldersInput,
  resolveHolderConcentrationConfig,
  DEFAULT_HOLDER_CONCENTRATION_CONFIG,
} from '../strategy/holder-concentration.mjs';
import { resolveHoldersSnapshot } from '../strategy/holder-scanner-cache.mjs';

/**
 * Validate a 64-char lowercase hex token_id. Returns the canonical
 * lowercase form, or `null` on bad input. Pure.
 * @param {string|undefined|null} raw
 * @returns {string|null}
 */
export function validateTokenIdForHolders(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (!/^[0-9a-f]{64}$/i.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

/**
 * Build the stub envelope when no scanner is wired (T76 subset 1
 * status). Always returns `ok:false` with `error:'scanner_not_implemented'`
 * and a human-readable message that names the deferred subset. NEVER
 * throws.
 *
 * @param {string} tokenId  validated lowercase 64-hex
 * @param {{request_id?: string, ts?: number}=} _opts  unused; kept for
 *   forward-compat with subset 2's logging seam
 * @returns {{ok: false, schema: 'tradebot.dashboard.token-holders/v1', token_id: string, ts: number, error: 'scanner_not_implemented', message: string, subset: 'T76/1', available_in: 'T76/2'}}
 */
export function buildScannerNotImplementedEnvelope(tokenId, _opts = {}) {
  return {
    ok: false,
    schema: 'tradebot.dashboard.token-holders/v1',
    token_id: tokenId,
    ts: Date.now(),
    error: 'scanner_not_implemented',
    message: 'T76 subset 2 has not landed yet. Token-holders scanning requires a BCH chain-state fetch that the Cauldron indexer does not currently expose. Use `?holders=<urlencoded-json>` to test the math against a fixture, OR add the token_id to `scoring.excluded_concentration_tokens` in config to blacklist it manually.',
    subset: 'T76/1',
    available_in: 'T76/2',
  };
}

/**
 * Build the `?holders=<urlencoded-json>` fixture path. Useful for
 * operator testing: hit `/api/token/<id>/holders?holders=<json>`
 * with a hand-built holders array and the endpoint returns the
 * real concentration envelope without doing any chain work.
 *
 * @param {string} tokenId   validated lowercase 64-hex
 * @param {string} jsonStr   URL-decoded JSON string of the holders array
 * @param {{
 *   decimals?: number|null,
 *   rug_top_n?: number,
 *   rug_threshold_pct?: number,
 *   epsilon_pct?: number,
 *   ts?: number,
 * }=} opts
 * @returns {{ok: boolean, schema: 'tradebot.dashboard.token-holders/v1', token_id: string, ts: number, fixture: true, ...}}
 */
export function buildHoldersEnvelopeFromFixture(tokenId, jsonStr, opts = {}) {
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    return {
      ok: false,
      schema: 'tradebot.dashboard.token-holders/v1',
      token_id: tokenId,
      ts: opts.ts ?? Date.now(),
      fixture: true,
      error: 'fixture_parse_failed',
      message: `Could not parse ?holders=... JSON: ${e && e.message ? e.message : String(e)}`,
    };
  }
  const cfgOpts = {
    rug_top_n: opts.rug_top_n,
    rug_threshold_pct: opts.rug_threshold_pct,
    epsilon_pct: opts.epsilon_pct,
  };
  const envelope = computeHolderConcentration({
    token_id: tokenId,
    holders: parsed,
    decimals: opts.decimals,
    opts: cfgOpts,
  });
  return {
    ...envelope,
    schema: 'tradebot.dashboard.token-holders/v1',
    ts: opts.ts ?? Date.now(),
    fixture: true,
  };
}

/**
 * Read `ctx.cfg.scoring.concentration_rug_enabled` defensively.
 * Returns `false` for missing ctx / missing cfg / missing scoring
 * section / non-boolean values (operator can typo or hand-edit
 * user.json — don't crash the route on it). Pure.
 *
 * @param {{cfg?: any}|undefined|null} ctx
 * @returns {boolean}
 */
export function isConcentrationRugEnabled(ctx) {
  if (!ctx || typeof ctx !== 'object') return false;
  const cfg = ctx.cfg;
  if (!cfg || typeof cfg !== 'object') return false;
  const sc = cfg.scoring;
  if (!sc || typeof sc !== 'object') return false;
  return sc.concentration_rug_enabled === true;
}

/**
 * Read `ctx.cfg.scoring.concentration_rug_provider_url` defensively.
 * Returns `null` for missing ctx / missing cfg / missing scoring
 * section / non-string values. Pure.
 *
 * @param {{cfg?: any}|undefined|null} ctx
 * @returns {string|null}
 */
export function concentrationRugProviderUrl(ctx) {
  if (!ctx || typeof ctx !== 'object') return null;
  const cfg = ctx.cfg;
  if (!cfg || typeof cfg !== 'object') return null;
  const sc = cfg.scoring;
  if (!sc || typeof sc !== 'object') return null;
  const v = sc.concentration_rug_provider_url;
  if (typeof v !== 'string' || v.length === 0) return null;
  return v;
}

/**
 * Read `ctx.cfg.scoring.concentration_rug_timeout_ms` defensively.
 * Returns `null` for missing ctx / missing cfg / non-number values.
 * Pure.
 *
 * @param {{cfg?: any}|undefined|null} ctx
 * @returns {number|null}
 */
export function concentrationRugTimeoutMs(ctx) {
  if (!ctx || typeof ctx !== 'object') return null;
  const cfg = ctx.cfg;
  if (!cfg || typeof cfg !== 'object') return null;
  const sc = cfg.scoring;
  if (!sc || typeof sc !== 'object') return null;
  const v = sc.concentration_rug_timeout_ms;
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v;
}

/**
 * Translate a `resolveHoldersSnapshot` envelope into the wire
 * shape the dashboard React layer already understands (mirrors the
 * `computeHolderConcentration` output so the tile never branches
 * on "stub vs live"). Pure-shape: takes the resolver envelope +
 * the upstream fetched envelope + the validated tokenId + the
 * caller-passed opts (rug_top_n / rug_threshold_pct / epsilon_pct),
 * returns the wire envelope.
 *
 * The upstream envelope (the `envelope` field of the resolver
 * result) carries the holders array + snapshot_at_unix_s +
 * upstream URL. We run THAT through the existing math layer
 * (`computeHolderConcentration` + `isRugPatternByHolders`) using
 * the same `opts` the rest of the dashboard honors.
 *
 * @param {string} tokenId     validated lowercase 64-hex
 * @param {Object} resolverR   `resolveHoldersSnapshot` result
 * @param {{
 *   rug_top_n?: number,
 *   rug_threshold_pct?: number,
 *   epsilon_pct?: number,
 *   ts?: number,
 * }} [opts]
 * @returns {{
 *   ok: boolean,
 *   schema: 'tradebot.dashboard.token-holders/v1',
 *   token_id: string,
 *   ts: number,
 *   fixture: false,
 *   source: string,
 *   holders_count: number,
 *   top_n: number,
 *   top_n_pct: number,
 *   total_supply_base: string,
 *   total_supply_human: string,
 *   total_holders: number,
 *   is_rug_pattern: boolean,
 *   rug_pattern: boolean,
 *   rug_pattern_top_n: number,
 *   rug_pattern_threshold_pct: number,
 *   epsilon_pct: number,
 *   holders: Array<{address: string, balance_base: string, balance_human: string, pct_of_supply: number, is_top_n: boolean, nft_count: number, snapshot_at_unix_s: number|null}>,
 *   top_n_holders: Array<{address: string, balance_base: string, balance_human: string, pct_of_supply: number, is_top_n: boolean, nft_count: number, snapshot_at_unix_s: number|null}>,
 *   config_applied: object,
 *   snapshot_at_unix_s: number|null,
 *   upstream: string|null,
 *   cached: boolean,
 *   cache_age_ms: number,
 *   dropped_rows?: Array<{row_index: number, reason: string}>,
 * }}
 */
export function buildTokenHoldersLiveEnvelope(tokenId, resolverR, opts = {}) {
  const ts = (opts && typeof opts.ts === 'number') ? opts.ts : Date.now();
  if (!resolverR || typeof resolverR !== 'object') {
    return {
      ok: false,
      schema: 'tradebot.dashboard.token-holders/v1',
      token_id: tokenId,
      ts,
      fixture: false,
      error: 'resolver_invalid',
      message: 'resolver envelope was null/undefined',
    };
  }
  if (!resolverR.ok) {
    return {
      ok: false,
      schema: 'tradebot.dashboard.token-holders/v1',
      token_id: tokenId,
      ts,
      fixture: false,
      error: resolverR.error || 'scanner_failed',
      message: resolverR.message || 'live holders scanner returned an error',
      http_status: resolverR.http_status ?? null,
      upstream: resolverR.upstream ?? null,
      cached: resolverR.cached === true,
      cache_age_ms: typeof resolverR.cache_age_ms === 'number' ? resolverR.cache_age_ms : 0,
    };
  }
  const upstream = resolverR.envelope;
  if (!upstream || typeof upstream !== 'object') {
    return {
      ok: false,
      schema: 'tradebot.dashboard.token-holders/v1',
      token_id: tokenId,
      ts,
      fixture: false,
      error: 'scanner_invalid_envelope',
      message: 'scanner returned ok:true but the upstream envelope was empty',
    };
  }
  // token_not_found: the resolver stores the upstream's `ok:true +
  // token_not_found:true` envelope in the cache (so repeat lookups
  // don't re-404 the upstream) but the dashboard should NOT treat
  // "the upstream hasn't indexed this token yet" as a successful
  // rug-check — it's a typed error that the operator can read.
  if (upstream.token_not_found === true) {
    return {
      ok: false,
      schema: 'tradebot.dashboard.token-holders/v1',
      token_id: tokenId,
      ts,
      fixture: false,
      error: 'token_not_found',
      message: upstream.message || 'upstream has not indexed this token yet',
      upstream: resolverR.upstream ?? null,
      cached: resolverR.cached === true,
      cache_age_ms: typeof resolverR.cache_age_ms === 'number' ? resolverR.cache_age_ms : 0,
    };
  }
  // upstream.holders is `[{address, balance_base, nft_count, snapshot_at_unix_s}, ...]`.
  // `computeHolderConcentration` accepts `[{address, balance_base | balance}, ...]`.
  const mappedHolders = Array.isArray(upstream.holders)
    ? upstream.holders.map((h) => {
        const address = (h && typeof h.address === 'string') ? h.address : '';
        const balanceBase = (h && typeof h.balance_base === 'string') ? h.balance_base
          : (typeof h.balance === 'string' ? h.balance : '0');
        return { address, balance: balanceBase };
      })
    : [];
  const concentrationOpts = {
    rug_top_n: opts.rug_top_n,
    rug_threshold_pct: opts.rug_threshold_pct,
    epsilon_pct: opts.epsilon_pct,
  };
  const concentration = computeHolderConcentration({
    token_id: tokenId,
    holders: mappedHolders,
    decimals: null,
    opts: concentrationOpts,
  });
  const configResolved = resolveHolderConcentrationConfig(concentrationOpts);
  const isRug = isRugPatternByHolders(mappedHolders, concentrationOpts);
  return {
    ...concentration,
    schema: 'tradebot.dashboard.token-holders/v1',
    ts,
    fixture: false,
    source: upstream.source || 'tokenstork',
    holders_count: Array.isArray(upstream.holders) ? upstream.holders.length : 0,
    is_rug_pattern: isRug,
    config_applied: configResolved.applied,
    snapshot_at_unix_s: resolverR.snapshot_at_unix_s ?? null,
    upstream: resolverR.upstream ?? null,
    cached: resolverR.cached === true,
    cache_age_ms: typeof resolverR.cache_age_ms === 'number' ? resolverR.cache_age_ms : 0,
    // Wire-format audit: preserve the per-row metadata (nft_count,
    // snapshot_at_unix_s) on each holder row so the dashboard can
    // surface them. The math layer's `holders` array uses a
    // minimal `{address, balance_base, pct_of_supply, ...}` shape;
    // we extend it without dropping the math fields.
    holders: Array.isArray(concentration.holders) ? concentration.holders.map((row, i) => {
      const src = Array.isArray(upstream.holders) ? upstream.holders[i] : null;
      return {
        ...row,
        nft_count: src && typeof src.nft_count === 'number' ? src.nft_count : 0,
        snapshot_at_unix_s: src && typeof src.snapshot_at_unix_s === 'number' ? src.snapshot_at_unix_s : null,
      };
    }) : [],
    top_holders: Array.isArray(concentration.top_holders) ? concentration.top_holders.map((row, i) => {
      // top_holders is a SUBSET of holders; map by address.
      const addr = row && row.address;
      const src = addr && Array.isArray(upstream.holders)
        ? upstream.holders.find((u) => u && u.address === addr)
        : null;
      return {
        ...row,
        nft_count: src && typeof src.nft_count === 'number' ? src.nft_count : 0,
        snapshot_at_unix_s: src && typeof src.snapshot_at_unix_s === 'number' ? src.snapshot_at_unix_s : null,
      };
    }) : [],
    // Wire-format audit: preserve the per-row metadata (nft_count,
    // snapshot_at_unix_s) on each holder row so the dashboard can
    // surface them. The math layer's `holders` array uses a
    // minimal `{address, balance_base, pct_of_supply, ...}` shape;
    // we extend it without dropping the math fields.
    holders: Array.isArray(concentration.holders) ? concentration.holders.map((row, i) => {
      const src = Array.isArray(upstream.holders) ? upstream.holders[i] : null;
      return {
        ...row,
        nft_count: src && typeof src.nft_count === 'number' ? src.nft_count : 0,
        snapshot_at_unix_s: src && typeof src.snapshot_at_unix_s === 'number' ? src.snapshot_at_unix_s : null,
      };
    }) : [],
    top_n_holders: Array.isArray(concentration.top_n_holders) ? concentration.top_n_holders.map((row) => {
      // top_n_holders is a SUBSET of holders; map by address.
      const addr = row && row.address;
      const src = addr && Array.isArray(upstream.holders)
        ? upstream.holders.find((u) => u && u.address === addr)
        : null;
      return {
        ...row,
        nft_count: src && typeof src.nft_count === 'number' ? src.nft_count : 0,
        snapshot_at_unix_s: src && typeof src.snapshot_at_unix_s === 'number' ? src.snapshot_at_unix_s : null,
      };
    }) : [],
    dropped_rows: Array.isArray(upstream.dropped_rows) ? upstream.dropped_rows : undefined,
  };
}

/**
 * Top-level handler for `GET /api/token/:tokenId/holders`. Mirrors
 * the shape of `/api/token/:tokenId` (one route per resource) and
 * the parsing approach of `/api/pools/top` (URL.searchParams on the
 * raw `url` object passed by the router).
 *
 * T76 subset 2a: when `ctx.cfg.scoring.concentration_rug_enabled`
 * is true the handler resolves through the live scanner
 * (`resolveHoldersSnapshot`) and translates the envelope to the
 * same wire shape the subset-1 stub returned. When the knob is
 * OFF (the default for safety) the handler preserves subset-1
 * behavior and returns the stub envelope.
 *
 * @param {{}} ctx   dashboard ctx (the scanner seam — subset 2a reads
 *   `ctx.cfg`, `ctx.holdersScannerCache`, `ctx.fetcher` here).
 * @param {string|undefined} tokenId
 * @param {URL|string} url
 * @returns {Promise<{
 *   ok: boolean,
 *   schema: 'tradebot.dashboard.token-holders/v1',
 *   token_id: string|null,
 *   ts: number,
 *   error?: string,
 *   message?: string,
 *   subset?: string,
 *   available_in?: string,
 *   fixture?: boolean,
 *   [k: string]: any,
 }>}
 */
export async function getTokenHolders(ctx, tokenId, url) {
  const validatedId = validateTokenIdForHolders(tokenId);
  if (validatedId === null) {
    return {
      ok: false,
      schema: 'tradebot.dashboard.token-holders/v1',
      token_id: null,
      ts: Date.now(),
      error: 'invalid_token_id',
      message: 'token_id must be a 64-char lowercase hex string',
    };
  }
  // Parse the URL — server.js hands us either a URL instance or a
  // string. Normalize.
  let urlObj;
  if (typeof url === 'string') {
    try { urlObj = new URL(url, 'http://placeholder.invalid'); } catch { urlObj = new URL('http://placeholder.invalid'); }
  } else if (url && typeof url.searchParams !== 'undefined') {
    urlObj = url;
  } else {
    urlObj = new URL('http://placeholder.invalid');
  }
  // Operator-testing affordance: `?holders=<urlencoded-json>`.
  // Mirrors the `?since=...&limit=...` pattern of /api/tokens/summary.
  // The fixture ALWAYS wins over the live scanner (operator-testing
  // takes priority over production scanning) so the operator can
  // hit a sandbox URL with a hand-built array without flipping
  // the production knob off.
  const holdersParam = urlObj.searchParams.get('holders');
  if (typeof holdersParam === 'string' && holdersParam.length > 0) {
    let decoded;
    try {
      decoded = decodeURIComponent(holdersParam);
    } catch {
      decoded = holdersParam;
    }
    const decimalsRaw = urlObj.searchParams.get('decimals');
    const decimalsParsed = decimalsRaw !== null ? Number(decimalsRaw) : null;
    return buildHoldersEnvelopeFromFixture(validatedId, decoded, {
      decimals: Number.isFinite(decimalsParsed) ? decimalsParsed : null,
      rug_top_n: parseOptionalNumber(urlObj.searchParams.get('top_n')),
      rug_threshold_pct: parseOptionalNumber(urlObj.searchParams.get('threshold_pct')),
      epsilon_pct: parseOptionalNumber(urlObj.searchParams.get('epsilon_pct')),
    });
  }
  // T76 subset 2a: when the operator has opted in via
  // `scoring.concentration_rug_enabled`, resolve through the live
  // scanner (cache + upstream). Default OFF preserves the subset-1
  // stub behavior so an operator who hasn't audited the upstream
  // doesn't accidentally start broadcasting their token IDs to a
  // third party.
  // T76 subset 2c: parse the `?refresh=` query flag here so it's
  // available inside the live branch. The fixture path above
  // short-circuits BEFORE this point so operator-testing wins.
  const refreshRaw = urlObj.searchParams.get('refresh');
  const refreshRequested = refreshRaw !== null && isTruthyString(refreshRaw);
  if (isConcentrationRugEnabled(ctx)) {
    const cache = (ctx && typeof ctx.holdersScannerCache === 'object'
      && ctx.holdersScannerCache !== null
      && typeof ctx.holdersScannerCache.get === 'function'
      && typeof ctx.holdersScannerCache.set === 'function')
      ? ctx.holdersScannerCache
      : null;
    if (cache === null) {
      return {
        ok: false,
        schema: 'tradebot.dashboard.token-holders/v1',
        token_id: validatedId,
        ts: Date.now(),
        error: 'scanner_cache_not_wired',
        message: 'scoring.concentration_rug_enabled is true but ctx.holdersScannerCache is not wired — dashboard server is misconfigured. Set scoring.concentration_rug_enabled=false OR restart the dashboard so the cache seam is constructed.',
      };
    }
    // T76 subset 2c: operator-triggered cache flush. Mirrors the
    // pattern from the snapshot-aggregator subset-1 (T64) — mtime
    // changes invalidate the cache automatically; this is the
    // operator escape hatch for "force-refresh RIGHT NOW without
    // waiting for TTL". The flush happens BEFORE the resolver call
    // so the response carries fresh data on the wire. Only honored
    // when the gate is ON (otherwise the cache isn't being populated
    // anyway and flushing it would just be a misleading no-op).
    let cacheFlushed = false;
    if (refreshRequested) {
      try {
        cache.invalidate(validatedId);
      } catch (_e) {
        // Defensive: a flaky cache shouldn't 500 the route. The
        // next get() will see a miss anyway if the entry was actually
        // removed by the throw; we just continue with cache_flushed
        // set to true so the React tile shows the badge.
      }
      cacheFlushed = true;
    }
    const fetcher = (ctx && typeof ctx.fetcher === 'function') ? ctx.fetcher : undefined;
    const providerUrl = concentrationRugProviderUrl(ctx);
    const timeoutMs = concentrationRugTimeoutMs(ctx);
    const scannerOpts = {
      ...(providerUrl !== null ? { baseUrl: providerUrl } : {}),
      ...(timeoutMs !== null ? { timeoutMs } : {}),
    };
    let resolverR;
    try {
      resolverR = await resolveHoldersSnapshot({
        tokenId: validatedId,
        cache,
        ...(fetcher !== undefined ? { fetcher } : {}),
        scannerOpts,
      });
    } catch (e) {
      // The orchestrator is supposed to NEVER throw, but be defensive
      // — surface a typed envelope instead of letting the route
      // handler bubble to a 500.
      return {
        ok: false,
        schema: 'tradebot.dashboard.token-holders/v1',
        token_id: validatedId,
        ts: Date.now(),
        error: 'scanner_unexpected_throw',
        message: (e && e.message) ? `resolveHoldersSnapshot threw: ${e.message}` : 'resolveHoldersSnapshot threw an unknown error',
        cache_flushed: cacheFlushed,
      };
    }
    // T76 subset 2c: surface the cache-flushed flag on every live
    // envelope so the React tile can render a "manually refreshed"
    // badge. Default `false` (no manual flush happened this tick).
    return {
      ...buildTokenHoldersLiveEnvelope(validatedId, resolverR, {
        rug_top_n: parseOptionalNumber(urlObj.searchParams.get('top_n')),
        rug_threshold_pct: parseOptionalNumber(urlObj.searchParams.get('threshold_pct')),
        epsilon_pct: parseOptionalNumber(urlObj.searchParams.get('epsilon_pct')),
      }),
      cache_flushed: cacheFlushed,
    };
  }
  // Default: stub envelope (subset 1 behaviour preserved). Subset
  // 2a only fires when the operator opts in.
  return buildScannerNotImplementedEnvelope(validatedId, {});
}

function parseOptionalNumber(v) {
  if (v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * T76 subset 2c — coerce a `?refresh=` value to a boolean. Accepts
 * the canonical truthy strings ('true', '1', 'yes', 'on' — case
 * insensitive); treats everything else (`'0'`, `'false'`, `'maybe'`,
 * `'refresh'`, empty string) as `false`. Pure.
 *
 * @param {string|undefined|null} v
 * @returns {boolean}
 */
export function isTruthyString(v) {
  if (typeof v !== 'string') return false;
  const trimmed = v.trim().toLowerCase();
  if (trimmed.length === 0) return false;
  return trimmed === 'true' || trimmed === '1' || trimmed === 'yes' || trimmed === 'on';
}

/**
 * Re-export the pure-math helpers so the dashboard server.mjs can
 * pull them from a single import path. (Subset-2a's
 * `isConcentrationRugEnabled` + `concentrationRugProviderUrl` +
 * `concentrationRugTimeoutMs` + `buildTokenHoldersLiveEnvelope`
 * are already exported via `export function` declarations above
 * — no need to re-list them here.)
 */
export {
  computeHolderConcentration,
  isRugPatternByHolders,
  validateHoldersInput,
  resolveHolderConcentrationConfig,
  DEFAULT_HOLDER_CONCENTRATION_CONFIG,
};