// dashboard/src/lib/api.mjs
//
// Tiny fetch wrapper for the T16 dashboard backend. The dashboard
// is read-only by default — the only write endpoints are
// `PUT /api/config` and `POST /api/risk/reset`, both gated by
// `dashboard.api_token` in `config/user.json`.
//
// This module is pure ESM, zero dependencies, and works in both
// browser (Vite build) and Node (so the test suite under
// `dashboard/tests/` can use it with `node --test` + `node:fetch`).
//
// Design notes:
//   - Every public function takes an optional `token` arg. When
//     supplied, it is sent as `Authorization: Bearer <token>`. The
//     backend ignores it for read endpoints and requires it for
//     write endpoints.
//   - Errors come back as a typed `Result` object
//     (`{ ok:false, error, status, code }`) rather than throwing.
//     React components branch on `result.ok`; this keeps the
//     render path free of try/catch noise.
//   - All endpoints have explicit timeouts (the dashboard's
//     `request_timeout_ms` knob defaults to 10s — we mirror it
//     client-side so a hung backend can't lock up the UI).
//
// Pure (no DOM, no module-scope state) — easy to test.

/**
 * @typedef {Object} ApiResult
 * @property {boolean} ok
 * @property {any} [data]
 * @property {string} [error]
 * @property {number} [status]
 * @property {string} [code]
 * @property {number} [durationMs]
 */

/**
 * Build the absolute URL for an API request. When `baseUrl` is
 * falsy, returns the path as-is — Vite's dev proxy (configured in
 * `vite.config.js`) handles routing `/api/*` → the backend, and
 * the built bundle is served behind a same-origin reverse proxy
 * (see `scripts/start-dashboard.mjs`).
 *
 * @param {string} path          e.g. `/api/summary`
 * @param {string|undefined} baseUrl  e.g. `http://127.0.0.1:8787` (test/dev override)
 * @returns {string}
 */
export function buildUrl(path, baseUrl) {
  if (!baseUrl || typeof baseUrl !== 'string') return path;
  // Tolerate trailing slash on baseUrl.
  const trimmed = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  if (!path.startsWith('/')) return `${trimmed}/${path}`;
  return `${trimmed}${path}`;
}

/**
 * Build the `Authorization` header value for a given token, or
 * `null` if no token was supplied. Empty / whitespace-only tokens
 * are treated as "no token" — same as Node's `bearerTokens` helper
 * in `src/dashboard/server.mjs`.
 *
 * @param {string|undefined|null} token
 * @returns {string|null}
 */
export function authHeader(token) {
  if (typeof token !== 'string') return null;
  const trimmed = token.trim();
  if (trimmed.length === 0) return null;
  return `Bearer ${trimmed}`;
}

/**
 * Wrap `fetch` with a timeout, JSON parsing, and a typed result.
 * Never throws on HTTP failure — surfaces everything via `ok`.
 *
 * On AbortError (timeout) the result is
 * `{ ok:false, error:'timeout after Nms', code:'TIMEOUT', status:0 }`.
 *
 * @param {string} url
 * @param {RequestInit} init
 * @param {number} timeoutMs
 * @returns {Promise<ApiResult>}
 */
export async function request(url, init, timeoutMs) {
  const start = (typeof performance !== 'undefined' && performance.now)
    ? performance.now()
    : Date.now();
  const ms = (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0)
    ? Math.floor(timeoutMs)
    : 10_000;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    const text = await res.text();
    /** @type {any} */
    let parsed = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch (_) {
        // Server returned non-JSON (shouldn't happen for /api/*).
        parsed = null;
      }
    }
    const duration = ((typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now()) - start;
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, data: parsed, status: res.status, durationMs: duration };
    }
    /** @type {string} */
    const errMsg = (parsed && typeof parsed === 'object' && typeof parsed.error === 'string')
      ? parsed.error
      : `HTTP ${res.status}`;
    /** @type {string|undefined} */
    const code = (parsed && typeof parsed === 'object' && typeof parsed.code === 'string')
      ? parsed.code
      : undefined;
    return { ok: false, error: errMsg, status: res.status, code, durationMs: duration };
  } catch (e) {
    const isAbort = (e && typeof e === 'object' && (/** @type {any} */ (e)).name === 'AbortError');
    const duration = ((typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now()) - start;
    return {
      ok: false,
      error: isAbort ? `timeout after ${ms}ms` : ((e && /** @type {any} */ (e).message) || String(e)),
      code: isAbort ? 'TIMEOUT' : 'NETWORK',
      status: 0,
      durationMs: duration,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Construct an `ApiClient` bound to a base URL + optional bearer
 * token. All methods return `ApiResult`; they never throw on
 * network / HTTP errors.
 *
 * @param {Object} opts
 * @param {string} [opts.baseUrl]    empty = same-origin (Vite proxy in dev, reverse proxy in prod)
 * @param {string} [opts.token]      bearer token for write endpoints
 * @param {number} [opts.timeoutMs]  default 10000
 */
export function createApiClient(opts) {
  const baseUrl = (opts && typeof opts.baseUrl === 'string') ? opts.baseUrl : '';
  const token = (opts && typeof opts.token === 'string') ? opts.token : '';
  const timeoutMs = (opts && typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0)
    ? Math.floor(opts.timeoutMs)
    : 10_000;
  const headers = {
    'Accept': 'application/json',
  };
  const auth = authHeader(token);
  if (auth) headers['Authorization'] = auth;

  /**
   * @param {string} path
   * @param {RequestInit} [init]
   * @returns {Promise<ApiResult>}
   */
  function call(path, init) {
    const url = buildUrl(path, baseUrl);
    const merged = { ...init, headers: { ...headers, ...(init && init.headers ? init.headers : {}) } };
    return request(url, merged, timeoutMs);
  }

  return {
    baseUrl,
    token: token || null,
    timeoutMs,

    /** GET /healthz */
    healthz() { return call('/healthz', { method: 'GET' }); },

    /**
     * GET /metrics (Prometheus text format). The /metrics
     * endpoint serves text/plain Prometheus exposition format,
     * NOT JSON — so we hand-roll a raw-text fetch and return
     * `{ok, text, status, durationMs}` (NOT `{ok, data}`).
     * Defensive: a network / HTTP error returns the same
     * `{ok:false, error, ...}` shape as the JSON clients.
     */
    async metricsText() {
      const start = (typeof performance !== 'undefined' && performance.now)
        ? performance.now()
        : Date.now();
      const ms = (typeof this.timeoutMs === 'number' && Number.isFinite(this.timeoutMs) && this.timeoutMs > 0)
        ? Math.floor(this.timeoutMs)
        : 10_000;
      const url = buildUrl('/metrics', this.baseUrl);
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), ms);
      try {
        const res = await fetch(url, {
          method: 'GET',
          signal: ctl.signal,
          headers: { ...headers },
        });
        const text = await res.text();
        const duration = ((typeof performance !== 'undefined' && performance.now)
          ? performance.now()
          : Date.now()) - start;
        if (res.status >= 200 && res.status < 300) {
          return { ok: true, text, status: res.status, durationMs: duration };
        }
        return { ok: false, error: `HTTP ${res.status}`, status: res.status, text: '', durationMs: duration };
      } catch (e) {
        const isAbort = (e && typeof e === 'object' && (/** @type {any} */ (e)).name === 'AbortError');
        const duration = ((typeof performance !== 'undefined' && performance.now)
          ? performance.now()
          : Date.now()) - start;
        return {
          ok: false,
          error: isAbort ? `timeout after ${ms}ms` : ((e && /** @type {any} */ (e).message) || String(e)),
          code: isAbort ? 'TIMEOUT' : 'NETWORK',
          status: 0,
          text: '',
          durationMs: duration,
        };
      } finally {
        clearTimeout(timer);
      }
    },

    /** GET /api/summary */
    summary() { return call('/api/summary', { method: 'GET' }); },

    /** GET /api/positions?status=open|pending|closing|closed|all */
    positions(status) {
      const qs = (status && typeof status === 'string') ? `?status=${encodeURIComponent(status)}` : '';
      return call(`/api/positions${qs}`, { method: 'GET' });
    },

    /**
     * PUT /api/positions/:id/overrides — requires token.
     * O03 (idea_operator_position-prevent-stop-loss-with-profit-target_20260917):
     * set the per-position `prevent_stop_loss` toggle + `profit_target_pct`
     * field. Returns the updated summarized position on success
     * (so the dashboard can re-render without a re-fetch).
     * Body: { prevent_stop_loss: <bool>, profit_target_pct: <number|null>, set_by?: <string> }.
     */
    updatePositionOverrides(positionId, body) {
      if (typeof positionId !== 'string' || positionId.length === 0) {
        return Promise.resolve({ ok: false, error: 'invalid_position_id', status: 400 });
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return Promise.resolve({ ok: false, error: 'body must be a JSON object', status: 400 });
      }
      return call(`/api/positions/${encodeURIComponent(positionId)}/overrides`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    },

    /** GET /api/history?range=...&kind=...&limit=... */
    history(opts) {
      const params = new URLSearchParams();
      if (opts && typeof opts.range === 'string') params.set('range', opts.range);
      if (opts && typeof opts.kind === 'string') params.set('kind', opts.kind);
      if (opts && typeof opts.limit === 'number') params.set('limit', String(opts.limit));
      const qs = params.toString().length > 0 ? `?${params.toString()}` : '';
      return call(`/api/history${qs}`, { method: 'GET' });
    },

    /** GET /api/snapshots?range=...&limit=...&token_id=... */
    snapshots(opts) {
      const params = new URLSearchParams();
      if (opts && typeof opts.range === 'string') params.set('range', opts.range);
      if (opts && typeof opts.limit === 'number') params.set('limit', String(opts.limit));
      if (opts && typeof opts.tokenId === 'string') params.set('token_id', opts.tokenId);
      const qs = params.toString().length > 0 ? `?${params.toString()}` : '';
      return call(`/api/snapshots${qs}`, { method: 'GET' });
    },

    /**
     * GET /api/snapshots/aggregate?range=...&token_id=...
     * T65: pre-aggregated snapshot rollup. Returns a compact
     * stats envelope (min/max/mean/latest for balance, exposure,
     * unrealized_pnl, open_position_count + drawdown) instead of
     * the full 1800-row snapshot list. Served from an mtime-keyed
     * TTL cache on the server so repeat polls are O(1).
     */
    snapshotStats(opts) {
      const params = new URLSearchParams();
      if (opts && typeof opts.range === 'string') params.set('range', opts.range);
      if (opts && typeof opts.tokenId === 'string') params.set('token_id', opts.tokenId);
      const qs = params.toString().length > 0 ? `?${params.toString()}` : '';
      return call(`/api/snapshots/aggregate${qs}`, { method: 'GET' });
    },

    /**
     * GET /api/positions/dust[?knob=<true|false>]
     * T88: per-position dust-flag preview. Mirrors the shape of
     * `api.snapshotStats({})` but for the dust-position tile. The
     * server runs the same `findDustPositions` math the trader
     * loop uses on every tick, so the dashboard's view of "what
     * is dust" is byte-identical to the loop's view. The optional
     * `knob:true` query param forces a preview of the dust array
     * even when `risk.dust_position_auto_close_enabled` is OFF
     * (so the operator can audit what would be dust before
     * flipping the knob). Response envelope (from
     * `src/dashboard/dust-positions.mjs`):
     *   { schema, ts, generated_at_ms, ok, dust_position_auto_close_enabled,
     *     config: { tx_fee_sats, slippage_bps, margin_bps,
     *               budget_multiplier, min_token_amount },
     *     open_position_count, checked_count, dust_count,
     *     skipped_count, skipped_overrides, skipped_no_price,
     *     dust: [...], skipped: [...], load_warnings?: [...] }
     *
     * @param {Object} [opts]
     * @param {boolean} [opts.knobOverride]  when true, appends
     *   `?knob=true` so the server computes the dust array as if
     *   the knob were ON (preview mode).
     */
    dustPositions(opts) {
      const params = new URLSearchParams();
      if (opts && opts.knobOverride === true) params.set('knob', 'true');
      const qs = params.toString().length > 0 ? `?${params.toString()}` : '';
      return call(`/api/positions/dust${qs}`, { method: 'GET' });
    },

    /**
     * GET /api/tokens/summary[?token_id=<64-hex>]
     * T68: per-token P&L attribution sourced from
     * `data/history.jsonl` + `data/positions.json`. Without
     * `tokenId`, returns the rollup list (one row per token the
     * bot has touched, sorted by realized P&L DESC). With
     * `tokenId`, returns the full per-token envelope
     * (closed_trades[] + open_positions[]) for the drill-down view.
     * Server returns the typed `TradeLogArgError` envelope as 400
     * on bad input — the client surfaces it via `r.error`.
     */
    tokensSummary(opts) {
      const params = new URLSearchParams();
      if (opts && typeof opts.tokenId === 'string' && opts.tokenId.length > 0) {
        params.set('token_id', opts.tokenId);
      }
      const qs = params.toString().length > 0 ? `?${params.toString()}` : '';
      return call(`/api/tokens/summary${qs}`, { method: 'GET' });
    },

    /**
     * GET /api/fees/breakdown[?token_id=<64-hex>]
     * T71: per-token fee breakdown with LP / tx / slippage split.
     * Without `tokenId`, returns the rollup list (one row per token
     * the bot has touched, sorted by `fees_paid_sats_total` DESC,
     * plus a cross-token `totals` aggregate). With `tokenId`,
     * returns the full per-token envelope including the
     * `trades[]` per-trade attribution array for the drill-down view.
     * Server returns the typed `FeeBreakdownArgError` envelope as
     * 400 on bad input — the client surfaces it via `r.error`.
     */
    feesBreakdown(opts) {
      const params = new URLSearchParams();
      if (opts && typeof opts.tokenId === 'string' && opts.tokenId.length > 0) {
        params.set('token_id', opts.tokenId);
      }
      const qs = params.toString().length > 0 ? `?${params.toString()}` : '';
      return call(`/api/fees/breakdown${qs}`, { method: 'GET' });
    },

    /**
     * GET /api/pnl-timeseries?range=...&token_id=...&limit=...
     * T39: cumulative realized P&L over time, sourced from
     * `positions.json#closed[]`. The response includes `rows`
     * (each row has `ts`, `cumulative_realized_pnl_sats`,
     * `cumulative_realized_pnl_bch`, `kind`, `realized_pnl_sats`,
     * `token_id`, `position_id`, `reason` etc.) plus summary fields
     * (`realized_total_sats`, `realized_total_bch`,
     * `first_close_ts`, `last_close_ts`, `trades_count`,
     * `skipped`, `limit`, `skip_breakdown`).
     */
    pnlTimeseries(opts) {
      const params = new URLSearchParams();
      if (opts && typeof opts.range === 'string') params.set('range', opts.range);
      if (opts && typeof opts.tokenId === 'string') params.set('token_id', opts.tokenId);
      if (opts && typeof opts.limit === 'number') params.set('limit', String(opts.limit));
      const qs = params.toString().length > 0 ? `?${params.toString()}` : '';
      return call(`/api/pnl-timeseries${qs}`, { method: 'GET' });
    },

    /** GET /api/config */
    getConfig() { return call('/api/config', { method: 'GET' }); },

    /**
     * GET /api/config/defaults — T43c. Returns the pristine
     * `config/default.json` content (no user.json merge). Used by
     * the Settings view's per-knob reset-to-default link + help
     * popover baseline field — the merged `/api/config` payload
     * would mask any operator override, making reset a no-op.
     * Returns `{ ok, data, error }` like every other typed
     * endpoint; `data` is `{ defaults, path, reason }`.
     */
    getConfigDefaults() { return call('/api/config/defaults', { method: 'GET' }); },

    /** GET /api/risk */
    getRisk() { return call('/api/risk', { method: 'GET' }); },

    /**
     * GET /api/risk-panel — T41 live risk panel envelope.
     * Returns `{ ok, data, error }` like every other typed
     * endpoint. The `data` shape has `exposure` /
     * `daily_loss` / `drawdown` / `concentration` /
     * `circuit_breaker` sub-objects; see
     * `src/dashboard/risk-panel.mjs#buildRiskPanel` for the
     * authoritative wire shape.
     */
    riskPanel() { return call('/api/risk-panel', { method: 'GET' }); },

    /**
     * GET /api/staking/status (T58 subset 4)
     * Powers the Dashboard's "BadgerCoin Staking" tile. Returns
     * the wallet's current lockNFT state (count + total BCH +
     * per-lock decoded commitment fields) + the last 10 stake
     * alerts from `data/alerts.jsonl` + the four operator-
     * facing staking knobs. Read-only (the knob-toggle flip
     * goes through `putConfig` so the existing validation +
     * restart-banner plumbing keeps working). Mirrors
     * `riskPanel()`'s envelope shape — typed `ApiResult`, never
     * throws on HTTP failure.
     */
    stakingStatus() {
      return call('/api/staking/status', { method: 'GET' });
    },

    /**
     * T70-3: GET /api/staking/log?limit=N
     * Powers the BadgerCoin Staking card's collapsible Status
     * div. Returns the most-recent stake-attempt rows (lock +
     * unlock) with attempt/success/failed phase + txid + error
     * code, sourced from `data/stake-attempts.jsonl`. Read-only,
     * no auth, never throws on HTTP failure (typed Result).
     *
     * @param {Object} [opts]
     * @param {number} [opts.limit]  default 50, server clamps to 500
     */
    stakeLog(opts) {
      const qs = (opts && Number.isFinite(opts.limit) && opts.limit > 0)
        ? `?limit=${encodeURIComponent(String(Math.floor(opts.limit)))}`
        : '';
      return call(`/api/staking/log${qs}`, { method: 'GET' });
    },

    /** GET /api/activity?limit=... */
    activity(limit) {
      const qs = (typeof limit === 'number') ? `?limit=${encodeURIComponent(String(limit))}` : '';
      return call(`/api/activity${qs}`, { method: 'GET' });
    },

    /**
     * GET /api/reasoning?limit=...&decisions=...
     * T25b: per-tick decision tree — surfaces what the bot is
     * actually thinking each tick (candidates, scores, skip reasons)
     * so operators can see at a glance whether the bot is making
     * decisions and WHY it's not entering positions right now.
     */
    reasoning(opts) {
      const params = new URLSearchParams();
      if (opts && typeof opts.limit === 'number') params.set('limit', String(opts.limit));
      if (opts && typeof opts.decisions === 'number') params.set('decisions', String(opts.decisions));
      const qs = params.toString().length > 0 ? `?${params.toString()}` : '';
      return call(`/api/reasoning${qs}`, { method: 'GET' });
    },

    /**
     * GET /api/token/:tokenId  (T26c)
     * Paytaca BCMR lookup for a single category id. Returns the
     * normalized metadata record (name / symbol / icon_url /
     * description / decimals). The backend caches for 1h by
     * default, so a refresh from the UI doesn't hit the network
     * for already-seen tokens.
     */
    tokenMetadata(tokenId) {
      if (typeof tokenId !== 'string' || tokenId.length === 0) {
        return Promise.resolve({ ok: false, error: 'invalid_token_id', status: 400 });
      }
      return call(`/api/token/${encodeURIComponent(tokenId)}`, { method: 'GET' });
    },

    /**
     * GET /api/token/:tokenId/holders[?refresh=true][?holders=<json>]
     * T76 subset 2c: token holder-concentration envelope. Mirrors
     * the shape of `api.tokenMetadata(tokenId)` but with two
     * optional query flags:
     *   - `refresh: true`  → appends `?refresh=true` so the
     *     backend flushes the scanner cache before resolving
     *     (only effective when `scoring.concentration_rug_enabled`
     *     is ON). Response carries `cache_flushed:true` so the
     *     React tile can show a "manually refreshed" badge.
     *   - `fixture: <json-array-string>` → appends `?holders=...`
     *     so the operator can test the math layer against a
     *     hand-built array without hitting the upstream.
     * Both flags are mutually exclusive in practice (`?holders=`
     * short-circuits on the server side).
     *
     * Response envelope (subset 2c shape):
     *   { ok, schema, token_id, ts, error?, message?,
     *     fixture?, source, holders_count, top_n, top_n_pct,
     *     total_supply_base, total_supply_human, total_holders,
     *     is_rug_pattern, rug_pattern, rug_pattern_top_n,
     *     rug_pattern_threshold_pct, epsilon_pct,
     *     holders:[{address, balance_base, balance_human,
     *               pct_of_supply, is_top_n, nft_count,
     *               snapshot_at_unix_s}], top_n_holders,
     *     snapshot_at_unix_s, upstream, cached, cache_age_ms,
     *     cache_flushed, dropped_rows? }
     */
    tokenHolders(opts) {
      const tokenId = opts && typeof opts.tokenId === 'string' ? opts.tokenId : '';
      if (tokenId.length === 0) {
        return Promise.resolve({ ok: false, error: 'invalid_token_id', status: 400 });
      }
      const params = new URLSearchParams();
      if (opts && opts.refresh === true) params.set('refresh', 'true');
      if (opts && typeof opts.fixture === 'string' && opts.fixture.length > 0) {
        params.set('holders', opts.fixture);
      }
      const qs = params.toString().length > 0 ? `?${params.toString()}` : '';
      return call(`/api/token/${encodeURIComponent(tokenId)}/holders${qs}`, { method: 'GET' });
    },

    /**
     * GET /api/trade-history?range=...&until=...&event_kind=...&token_id=...&side=...&pnl=...&limit=...
     * T42: dedicated trade history (entry+exit events flattened from
     * `positions.json`). Response shape:
     *   { schema, ts, range, since_ms, until_ms, token_id, side,
     *     event_kind, pnl, limit, count, total_count, events:[...] }
     * Each event is `{kind:'entry'|'exit', ts, token_id, token_symbol,
     * side, position_id, status, pnl_sign, txid:{entry,exit},
     * amounts:{...}, pnl:{realized_pnl_sats}, exit_reason}`.
     */
    tradeHistory(opts) {
      const params = new URLSearchParams();
      if (opts && typeof opts.range === 'string') params.set('range', opts.range);
      if (opts && typeof opts.until === 'string') params.set('until', opts.until);
      if (opts && typeof opts.eventKind === 'string') params.set('event_kind', opts.eventKind);
      if (opts && typeof opts.tokenId === 'string') params.set('token_id', opts.tokenId);
      if (opts && typeof opts.side === 'string') params.set('side', opts.side);
      if (opts && typeof opts.pnl === 'string') params.set('pnl', opts.pnl);
      if (opts && typeof opts.limit === 'number') params.set('limit', String(opts.limit));
      const qs = params.toString().length > 0 ? `?${params.toString()}` : '';
      return call(`/api/trade-history${qs}`, { method: 'GET' });
    },

    /**
     * GET /api/wallet/balance  (T27e)
     * Live on-chain wallet state: BCH balance + every fungible-token
     * category the bot's wallet address currently holds. The
     * backend queries Electrum directly (not the snapshots file)
     * so the operator always sees truth, even after manual trades
     * that bypassed positions.open().
     */
    walletBalance() {
      return call('/api/wallet/balance', { method: 'GET' });
    },

    /**
     * GET /api/pools/top?limit=N  (T45b)
     * Powers the manual-trade UI's token autocomplete. Returns
     * the indexer discovery list (top-N pools by TVL) projected
     * onto `{token_id, symbol, decimals, name, tvl_sats, trade_volume}`.
     * 503 when no fetcher is wired (the dashboard was booted
     * without indexer access); the UI surfaces a "no pool list"
     * pill in that case.
     */
    poolsTop(opts) {
      const params = new URLSearchParams();
      if (opts && typeof opts.limit === 'number' && Number.isFinite(opts.limit)) {
        params.set('limit', String(Math.max(1, Math.min(200, Math.floor(opts.limit)))));
      }
      const qs = params.toString().length > 0 ? `?${params.toString()}` : '';
      return call(`/api/pools/top${qs}`, { method: 'GET' });
    },

    /**
     * POST /api/trade/manual  (T45 subset 1; T45b surfaces the UI).
     * Body: `{token_id, side, amount_bch, dry_run?, expected_rate_sats_per_token?}`.
     * Returns the swap envelope (including slippage / lpFee /
     * networkFee / balance-after / txid on success, or
     * `errorKind` / `error` on refusal). Requires `dashboard.api_token`
     * to be set in `user.json`.
     */
    tradeManual(body) {
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return Promise.resolve({ ok: false, error: 'body must be a JSON object', status: 400 });
      }
      return call('/api/trade/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    },

    /** PUT /api/config — requires token. */
    putConfig(body) {
      return call('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    },

    /** POST /api/risk/reset — requires token. */
    postRiskReset(reason) {
      return call('/api/risk/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason || 'manual dashboard reset' }),
      });
    },

    // ─── feature-ideas (T30) ─────────────────────────────────────
    //
    // Proposals tab. The backend serves /api/feature-ideas/* and
    // writes a TODO entry to TODO.md on approve so the supervisor
    // picks the work up. The dashboard view is `Proposals.jsx`.

    /**
     * GET /api/feature-ideas?status=...&category=...
     * List ideas. Optional query filters: status (pending|approved|rejected|shipped),
     * category (edge-case-protection|decision-logic|dashboard|observability|performance).
     */
    featureIdeas(opts) {
      const params = new URLSearchParams();
      if (opts && typeof opts.status === 'string') params.set('status', opts.status);
      if (opts && typeof opts.category === 'string') params.set('category', opts.category);
      const qs = params.toString().length > 0 ? `?${params.toString()}` : '';
      return call(`/api/feature-ideas${qs}`, { method: 'GET' });
    },

    /**
     * GET /api/feature-ideas/meta
     * Counters + last_research_at. Used by the Proposals header
     * to show "last research: 3h ago".
     */
    featureIdeasMeta() {
      return call('/api/feature-ideas/meta', { method: 'GET' });
    },

    /**
     * POST /api/feature-ideas/:ideaId/status — requires token.
     * Body: { status: 'pending'|'approved'|'rejected'|'shipped', shipped_in?: string }.
     * Approval appends a TODO entry to TODO.md (visible in the `todo` field of the response).
     */
    updateFeatureIdeaStatus(ideaId, body) {
      if (typeof ideaId !== 'string' || ideaId.length === 0) {
        return Promise.resolve({ ok: false, error: 'invalid_idea_id', status: 400 });
      }
      return call(`/api/feature-ideas/${encodeURIComponent(ideaId)}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
    },

    /**
     * POST /api/feature-ideas/:ideaId/notes — requires token.
     * Body: { body: string, author?: string, ts?: string }.
     */
    addFeatureIdeaNote(ideaId, body) {
      if (typeof ideaId !== 'string' || ideaId.length === 0) {
        return Promise.resolve({ ok: false, error: 'invalid_idea_id', status: 400 });
      }
      return call(`/api/feature-ideas/${encodeURIComponent(ideaId)}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
    },

    /**
     * POST /api/feature-ideas — create a new idea. Requires token.
     * Body shape: { title, category, rationale, evidence?, effort, impact, category_tags? }.
     * The backend returns the generated idea (with id, source='operator',
     * status='pending', timestamps) + the updated meta envelope.
     */
    createFeatureIdea(body) {
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return Promise.resolve({ ok: false, error: 'body must be a JSON object', status: 400 });
      }
      return call('/api/feature-ideas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    },

    /**
     * GET /api/research-runs?limit=N&range=7d
     * T30c: tail of the structured history events of kind
     * 'research_cron_run'. Used by the Proposals tab header to
     * show "last 5 cron runs" + "since last research" without
     * reading the script logs.
     */
    researchRuns(opts) {
      const params = new URLSearchParams();
      if (opts && typeof opts.limit === 'number') params.set('limit', String(opts.limit));
      if (opts && typeof opts.range === 'string') params.set('range', opts.range);
      const qs = params.toString().length > 0 ? `?${params.toString()}` : '';
      return call(`/api/research-runs${qs}`, { method: 'GET' });
    },

    /**
     * T44: bugs tab. Mirrors the featureIdeas API surface but
     * exposes the operator-facing CRUD on `data/bugs.json`.
     */
    bugs(opts) {
      const params = new URLSearchParams();
      if (opts && typeof opts.status === 'string') params.set('status', opts.status);
      if (opts && typeof opts.category === 'string') params.set('category', opts.category);
      if (opts && typeof opts.severity === 'string') params.set('severity', opts.severity);
      const qs = params.toString().length > 0 ? `?${params.toString()}` : '';
      return call(`/api/bugs${qs}`, { method: 'GET' });
    },

    bugsMeta() {
      return call('/api/bugs/meta', { method: 'GET' });
    },

    bug(bugId) {
      return call(`/api/bugs/${encodeURIComponent(bugId)}`, { method: 'GET' });
    },

    createBug(body) {
      return call('/api/bugs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    },

    updateBugStatus(bugId, body) {
      return call(`/api/bugs/${encodeURIComponent(bugId)}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
    },

    reorderBug(bugId, newPriority) {
      return call(`/api/bugs/${encodeURIComponent(bugId)}/reorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_priority: newPriority }),
      });
    },

    addBugNote(bugId, body) {
      return call(`/api/bugs/${encodeURIComponent(bugId)}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
    },

    deleteBug(bugId) {
      return call(`/api/bugs/${encodeURIComponent(bugId)}`, { method: 'DELETE' });
    },

    // First-run setup wizard endpoints. Not auth-gated on the
    // server side — the operator has no token before the wizard
    // finishes. `setupStatus()` is read-only and safe to poll.
    // `setupApply(body)` posts the wizard payload; on success the
    // response includes the auto-generated API token so the
    // wizard can store it in sessionStorage and reload into a
    // write-enabled Settings view.
    setupStatus() {
      return call('/api/setup/status', { method: 'GET' });
    },

    setupApply(body) {
      return call('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
    },
  };
}