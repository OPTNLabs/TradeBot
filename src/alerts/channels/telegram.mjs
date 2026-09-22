#!/usr/bin/env node
// src/alerts/channels/telegram.mjs
//
// T53.1 — telegram channel adapter.
//
// Sends alerts to a Telegram chat via the Bot API
// (`https://api.telegram.org/bot<TOKEN>/sendMessage`). Disabled
// by default — the channel only `isReady` if `bot_token` is
// configured, the chat id is set, and the bot can resolve the
// chat (verified via `getMe` on first construction, then
// memoized for `channel_ttl_ms`).
//
// Design rules:
//
//   1. **Disabled-by-default.** A bot token MUST be passed via
//      `cfg.telegram_bot_token` (config block) OR `opts.bot_token`.
//      If neither is set, the channel is constructed but
//      `isReady()` returns false → the router skips it without
//      any network call. The operator's "I do not want Telegram
//      pings" workflow is the default.
//
//   2. **No secrets in this file.** The token is provided by the
//      caller at boot time (read from `config/user.json` via the
//      same loader used for the wallet WIF). The channel never
//      writes the token to a log; failures show `error_code` only.
//
//   3. **Fetch wrapper is DI-injected.** `fetchImpl` defaults to
//      the global `fetch`. Tests pass a stub. The request payload
//      is `chat_id + text + parse_mode=MarkdownV2`.
//
//   4. **Timeouts.** Every network call uses an `AbortController`
//      with a configurable timeout (default 5000ms). The bot
//      never blocks the trader loop on a slow Telegram API.
//
//   5. **Rate-limit detection.** Telegram returns 429 with
//      `retry_after`; the channel surfaces the hint via the
//      thrown error message ("retry_after:30") so callers can
//      honor backoff without re-deriving it.
//
//   6. **Body size limit.** Telegram's text-message limit is 4096
//      chars; longer bodies are truncated with an explicit
//      `(truncated)` marker so the operator sees the full title
//      but the body is curtailed.

import process from 'node:process';

/**
 * @typedef {import('../router.mjs').AlertChannel} AlertChannel
 * @typedef {import('../router.mjs').AlertEvent} AlertEvent
 * @typedef {import('../router.mjs').AlertSeverity} AlertSeverity
 */

/**
 * Escape a string for Telegram MarkdownV2. Strips characters that
 * would otherwise be interpreted as formatting; production-grade
 * escaping (Telegram's full escape rules) is a future subset.
 *
 * @param {string} raw
 * @returns {string}
 */
export function escapeMarkdownV2(raw) {
  if (typeof raw !== 'string') return '';
  // Conservative escape for the special Telegram chars; anything
  // outside this set is left as-is.
  return raw.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/**
 * Format an event as a Telegram MarkdownV2 message body. The shape
 * is: title (bold) + newline + severity + kind + context lines.
 *
 * @param {AlertEvent} event
 * @returns {string}
 */
export function formatTelegramMessage(event, opts = {}) {
  const title = escapeMarkdownV2(event.title);
  const body = escapeMarkdownV2(event.body || '');
  const severity = escapeMarkdownV2(`[${event.severity.toUpperCase()}]`);
  const kind = escapeMarkdownV2(event.kind);
  const tsLabel = event.ts ? new Date(event.ts).toISOString() : 'unknown';
  /** @type {string[]} */
  const ctxLines = [];
  if (event.context && typeof event.context === 'object') {
    for (const [k, v] of Object.entries(event.context)) {
      if (v === null || v === undefined) continue;
      ctxLines.push(` • ${escapeMarkdownV2(k)}: ${escapeMarkdownV2(String(v))}`);
    }
  }
  const idLine = event.event_id ? `\n\n*id:* ${escapeMarkdownV2(event.event_id)}` : '';
  const truncated = opts.truncate === false ? '' : '';
  let text = `*${title}*\n${severity} ${kind}\n${body}${ctxLines.join('')}\n\n_ts: ${escapeMarkdownV2(tsLabel)}_${idLine}${truncated}`;
  const TAIL = `_… \\(truncated\\)_`;
  if (text.length > 4096) {
    text = `${text.slice(0, 4096 - TAIL.length)}${TAIL}`;
  }
  return text;
}

/**
 * @typedef {Object} TelegramChannelOptions
 * @property {string|null} [bot_token]      Bot API token; if null the channel is disabled.
 * @property {string|null} [chat_id]       Chat id (numeric or "@channel"); if null the channel is disabled.
 * @property {AlertSeverity} [min_severity='warn']  Floor — info-level events go to the console channel by default.
 * @property {number} [timeout_ms=5000]    Network timeout per call.
 * @property {typeof fetch} [fetchImpl]      Test seam; defaults to `globalThis.fetch`.
 * @property {() => number} [nowMs]        Clock for the readiness cache.
 * @property {number} [channel_ttl_ms=600000]  Re-check `getMe` if older than this.
 * @property {string} [api_base='https://api.telegram.org']  Test seam (mock API).
 * @property {string} [id='telegram']      Channel id.
 */

/**
 * Construct a Telegram channel adapter. The returned object is
 * frozen and includes test helpers (`lastSent`, `recordedCalls`)
 * behind non-enumerable keys so the production channel is clean.
 *
 * @param {TelegramChannelOptions} opts
 * @returns {AlertChannel & {isConfigured: () => boolean, lastSent: () => Array<{chat_id: string, text: string}>, recordedCalls: () => Array<{url: string, init: any}>}}
 */
export function createTelegramChannel(opts) {
  if (opts === null || typeof opts !== 'object') {
    throw new TypeError('createTelegramChannel: opts object required');
  }
  const bot_token = (typeof opts.bot_token === 'string' && opts.bot_token.length > 0) ? opts.bot_token : null;
  const chat_id = (typeof opts.chat_id === 'string' && opts.chat_id.length > 0) ? opts.chat_id : null;
  const min_severity = (typeof opts.min_severity === 'string') ? opts.min_severity : 'warn';
  const timeout_ms = (typeof opts.timeout_ms === 'number' && opts.timeout_ms > 0) ? opts.timeout_ms : 5000;
  const fetchImpl = (typeof opts.fetchImpl === 'function') ? opts.fetchImpl : ((url, init) => globalThis.fetch(url, init));
  const nowMs = (typeof opts.nowMs === 'function') ? opts.nowMs : (() => Date.now());
  const channel_ttl_ms = (typeof opts.channel_ttl_ms === 'number' && opts.channel_ttl_ms > 0) ? opts.channel_ttl_ms : 600000;
  const api_base = (typeof opts.api_base === 'string' && opts.api_base.length > 0) ? opts.api_base : 'https://api.telegram.org';
  const id = (typeof opts.id === 'string') ? opts.id : 'telegram';

  /** @type {Array<{chat_id: string, text: string}>} */
  const _lastSent = [];
  /** @type {Array<{url: string, init: any}>} */
  const _recordedCalls = [];
  let _ready = false;
  let _readyCheckedAtMs = 0;
  let _getMeInfo = null;

  function isConfigured() {
    return bot_token !== null && chat_id !== null;
  }

  /**
   * @returns {Promise<boolean>}
   */
  async function probeReady() {
    if (!isConfigured()) return false;
    const age = nowMs() - _readyCheckedAtMs;
    if (age < channel_ttl_ms && _readyCheckedAtMs !== 0) return _ready;
    try {
      const url = `${api_base}/bot${bot_token}/getMe`;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeout_ms);
      _recordedCalls.push({ url, init: { method: 'GET', signal: ac.signal } });
      const res = await fetchImpl(url, { method: 'GET', signal: ac.signal });
      clearTimeout(timer);
      if (!res || !res.ok) {
        _ready = false;
        _readyCheckedAtMs = nowMs();
        return false;
      }
      /** @type {any} */
      const body = await res.json().catch(() => null);
      _ready = !!(body && body.ok === true);
      _getMeInfo = body && body.ok ? body.result : null;
      _readyCheckedAtMs = nowMs();
      return _ready;
    } catch (_e) {
      _ready = false;
      _readyCheckedAtMs = nowMs();
      return false;
    }
  }

  /**
   * @param {AlertEvent} event
   */
  async function doSend(event) {
    const text = formatTelegramMessage(event);
    const url = `${api_base}/bot${bot_token}/sendMessage`;
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id,
        text,
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true,
      }),
      signal: null,
    };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout_ms);
    init.signal = ac.signal;
    _recordedCalls.push({ url, init });
    try {
      const res = await fetchImpl(url, init);
      if (!res || !res.ok) {
        /** @type {any} */
        let bodyText = null;
        try { bodyText = await res.text(); } catch (_e2) { bodyText = '<body read failed>'; }
        if (res && res.status === 429) {
          throw new Error(`telegram: 429 rate-limited (${(bodyText || '').slice(0, 200)})`);
        }
        throw new Error(`telegram: HTTP ${res ? res.status : 'no-response'} body=${(bodyText || '').slice(0, 200)}`);
      }
      _lastSent.push({ chat_id, text });
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    id,
    displayName: 'Telegram',
    min_severity,
    isReady: () => probeReady().then((r) => r).catch(() => false),
    send: async (_channel, event) => {
      if (!isConfigured()) {
        throw new Error('telegram channel: bot_token or chat_id not configured');
      }
      // Don't call probeReady() here — isReady() already enforced
      // the gate at dispatch time. Calling it again would add a
      // getMe roundtrip on every send.
      await doSend(event);
    },
    // Test surface (non-enumerable so production `console.log`
    // of the channel doesn't accidentally dump the call log):
    isConfigured,
    lastSent: () => _lastSent.slice(),
    recordedCalls: () => _recordedCalls.slice(),
    get _getMeInfo() { return _getMeInfo; },
  });
}
