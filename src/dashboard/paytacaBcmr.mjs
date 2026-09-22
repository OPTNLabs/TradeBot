// src/dashboard/paytacaBcmr.mjs
//
// T26c — Paytaca BCMR client for the dashboard.
//
// The dashboard shows a lot of token_ids (raw 32-byte category
// ids) in trade history, activity, reasoning, and positions. Those
// are unreadable on their own. The Paytaca BCMR (Bitcoin Cash
// Metadata Registry) exposes the human-readable metadata — name,
// symbol, decimals, icon URL, website — for any registered
// category id.
//
// This module wraps that lookup with:
//   - a single shared HTTP fetch (Node 18+ global `fetch`)
//   - an in-memory cache with TTL (default 1 hour)
//   - a small normalization layer (Paytaca's response shape is
//     `{name, uris, token, description, ...}`; we project a flat
//     shape the dashboard can render directly)
//   - clean error mapping (404 / 502 / timeout)
//
// The HTTP layer is fully injectable (`fetchImpl` + `now`) so
// tests can swap in a stub without monkey-patching globals.
//
// URL discovery (2026-09-12): the public endpoint is
//   https://bcmr.paytaca.com/api/tokens/{category_id}/
// The trailing slash matters — without it the server 301s and
// some HTTP clients lose the body. The trailing-slash variant
// returns 200 directly with `application/json`.

import { URL } from 'node:url';

/**
 * @typedef {Object} PaytacaBcmrOptions
 * @property {string} [baseUrl]      default 'https://bcmr.paytaca.com/api'
 * @property {number} [ttlMs=3600000]     cache TTL in ms (1 hour default)
 * @property {number} [timeoutMs=8000]    per-request timeout in ms
 * @property {number} [maxRetries=1]      retry count on transient errors
 * @property {(url:string, init:RequestInit) => Promise<Response>} [fetchImpl]
 * @property {() => number} [now]         clock injection for tests
 * @property {typeof console.warn|Function} [log]
 */

/**
 * Normalize a raw Paytaca BCMR response into the dashboard's
 * flat shape. Pure — exported for tests.
 *
 * Paytaca's payload (verified 2026-09-12 against PUSD):
 *   {
 *     "name": "ParyonUSD",
 *     "description": "...",
 *     "uris": {"icon": "...", "web": "...", ...},
 *     "token": {
 *       "category": "2469acc5...",
 *       "decimals": 2,
 *       "symbol": "PUSD"
 *     },
 *     "nfts": {...}
 *   }
 *
 * Some tokens don't register `symbol` or `decimals` — we surface
 * `null` for those rather than swallowing the field.
 *
 * @param {string} tokenId
 * @param {Object} raw
 * @returns {{
 *   token_id: string,
 *   name: string|null,
 *   symbol: string|null,
 *   description: string|null,
 *   decimals: number|null,
 *   icon_url: string|null,
 *   web_url: string|null,
 *   source: 'paytaca-bcmr',
 *   fetched_at: string
 * }}
 */
export function normalizePaytacaBcmr(tokenId, raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      token_id: String(tokenId || '').toLowerCase(),
      name: null,
      symbol: null,
      description: null,
      decimals: null,
      icon_url: null,
      web_url: null,
      source: 'paytaca-bcmr',
      fetched_at: '',
    };
  }
  const token = (raw.token && typeof raw.token === 'object') ? raw.token : {};
  const uris = (raw.uris && typeof raw.uris === 'object') ? raw.uris : {};
  const decimals = (typeof token.decimals === 'number' && Number.isFinite(token.decimals))
    ? token.decimals
    : null;
  return {
    token_id: String(tokenId || '').toLowerCase(),
    name: (typeof raw.name === 'string') ? raw.name : null,
    symbol: (typeof token.symbol === 'string') ? token.symbol
          : (typeof raw.symbol === 'string') ? raw.symbol
          : null,
    description: (typeof raw.description === 'string') ? raw.description : null,
    decimals,
    icon_url: (typeof uris.icon === 'string') ? uris.icon : null,
    web_url: (typeof uris.web === 'string') ? uris.web : null,
    source: 'paytaca-bcmr',
    // filled by caller (fetched_at ms); kept here as a placeholder
    // so the shape stays flat for tests that build a fixture.
    fetched_at: '',
  };
}

/**
 * Build the canonical lookup URL for a token id. Always emits
 * the trailing slash so we skip the 301 redirect on every request.
 *
 * @param {string} baseUrl
 * @param {string} tokenId
 * @returns {string}
 */
export function buildBcmrUrl(baseUrl, tokenId) {
  const trimmed = String(baseUrl || '').replace(/\/+$/, '');
  return `${trimmed}/tokens/${encodeURIComponent(String(tokenId).toLowerCase())}/`;
}

/**
 * Validate a token id before doing any network work. BCMR
 * category ids are 64-char hex strings (32 bytes); reject anything
 * else early to avoid hitting the registry with garbage and
 * polluting the cache.
 *
 * @param {unknown} tokenId
 * @returns {boolean}
 */
export function isValidTokenId(tokenId) {
  if (typeof tokenId !== 'string') return false;
  if (tokenId.length !== 64) return false;
  return /^[0-9a-f]{64}$/.test(tokenId);
}

/**
 * Construct a BCMR client. Wires up caching + retry, but does NOT
 * pre-fetch anything. Use `lookup(tokenId)` to fetch on demand.
 *
 * @param {PaytacaBcmrOptions} [opts]
 * @returns {{
 *   lookup: (tokenId: string) => Promise<{ ok: true, record: Object } | { ok: false, error: string, status: number }>,
 *   cached: (tokenId: string) => Object | null,
 *   stats: () => { hits: number, misses: number, errors: number },
 *   cacheSize: () => number,
 * }}
 */
export function createPaytacaBcmrClient(opts = {}) {
  const baseUrl = (typeof opts.baseUrl === 'string' && opts.baseUrl.length > 0)
    ? opts.baseUrl
    : 'https://bcmr.paytaca.com/api';
  const ttlMs = (typeof opts.ttlMs === 'number' && opts.ttlMs > 0) ? opts.ttlMs : 3_600_000;
  const timeoutMs = (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0) ? opts.timeoutMs : 8_000;
  const maxRetries = (typeof opts.maxRetries === 'number' && opts.maxRetries >= 0) ? Math.floor(opts.maxRetries) : 1;
  const fetchImpl = (typeof opts.fetchImpl === 'function') ? opts.fetchImpl : fetch;
  const now = (typeof opts.now === 'function') ? opts.now : Date.now;
  const log = (typeof opts.log === 'function') ? opts.log
            : ((msg, meta) => { try { console.warn(msg, meta); } catch (_) { /* noop */ } });

  // token_id → { record, expiresAt }
  const cache = new Map();
  // pending lookups (de-dupe concurrent requests for the same id)
  const inflight = new Map();
  const stats = { hits: 0, misses: 0, errors: 0 };

  /** @param {string} tokenId */
  function cached(tokenId) {
    const id = String(tokenId || '').toLowerCase();
    const e = cache.get(id);
    if (!e) return null;
    if (e.expiresAt <= now()) {
      cache.delete(id);
      return null;
    }
    return e.record;
  }

  /**
   * @param {string} tokenId
   * @param {number} attempt
   * @returns {Promise<{ ok: true, record: Object } | { ok: false, error: string, status: number }>}
   */
  async function fetchOnce(tokenId, attempt) {
    const url = buildBcmrUrl(baseUrl, tokenId);
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(new Error('bcmr-timeout')), timeoutMs);
    try {
      const resp = await fetchImpl(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: ac.signal,
        redirect: 'follow',
      });
      clearTimeout(t);
      if (resp.status === 404) return { ok: false, error: 'not_found', status: 404 };
      if (resp.status >= 500) return { ok: false, error: `upstream_${resp.status}`, status: resp.status };
      if (!resp.ok) return { ok: false, error: `upstream_${resp.status}`, status: resp.status };
      const body = await resp.json().catch(() => null);
      if (!body || typeof body !== 'object') {
        return { ok: false, error: 'bad_body', status: 502 };
      }
      const record = normalizePaytacaBcmr(tokenId, body);
      record.fetched_at = new Date(now()).toISOString();
      return { ok: true, record };
    } catch (e) {
      clearTimeout(t);
      const msg = (e && e.name === 'AbortError') ? 'timeout' : (e?.message || String(e));
      if (attempt < maxRetries) {
        // exponential backoff with jitter
        const backoffMs = 200 * (attempt + 1) + Math.floor(Math.random() * 100);
        await new Promise((r) => setTimeout(r, backoffMs));
        return fetchOnce(tokenId, attempt + 1);
      }
      return { ok: false, error: msg, status: 0 };
    }
  }

  /**
   * @param {string} tokenId
   * @returns {Promise<{ ok: true, record: Object } | { ok: false, error: string, status: number }>}
   */
  async function lookup(tokenId) {
    const id = String(tokenId || '').toLowerCase();
    if (!isValidTokenId(id)) {
      return { ok: false, error: 'invalid_token_id', status: 400 };
    }
    const e = cache.get(id);
    if (e && e.expiresAt > now()) {
      stats.hits += 1;
      return { ok: true, record: e.record };
    }
    if (inflight.has(id)) {
      return inflight.get(id);
    }
    stats.misses += 1;
    const p = (async () => {
      try {
        const r = await fetchOnce(id, 0);
        if (r.ok) {
          cache.set(id, { record: r.record, expiresAt: now() + ttlMs });
        } else {
          stats.errors += 1;
          log('paytaca-bcmr.lookup.failed', { token_id: id, error: r.error, status: r.status });
        }
        return r;
      } finally {
        inflight.delete(id);
      }
    })();
    inflight.set(id, p);
    return p;
  }

  function cacheSize() { return cache.size; }

  return {
    lookup,
    cached,
    stats: () => ({ ...stats }),
    cacheSize,
  };
}

/**
 * Validate a configured BCMR base URL. Used by the dashboard
 * server boot to fail-fast on misconfiguration.
 *
 * @param {unknown} v
 * @returns {string|null}
 */
export function normalizeBcmrBaseUrl(v) {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim().replace(/\/+$/, '');
  if (trimmed.length === 0) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return trimmed;
  } catch (_) {
    return null;
  }
}
