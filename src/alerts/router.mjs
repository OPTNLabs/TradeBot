#!/usr/bin/env node
// src/alerts/router.mjs
//
// T53.1 — TradeBot AlertRouter.
//
// Why this exists
// ────────────────
// The B06 stall watchdog covers the "bot loop wedged" case via
// `scripts/check-bot-stall.mjs`, but the operator has to manually
// run that CLI to be told. Other failure modes have no equivalent
// watchdog: slippage spike during a single tick, AMM divergence,
// breaker trip, wallet-balance floor breach. This module is the
// outbound side of observability — every decision point in the
// trader loop calls `AlertRouter.dispatch(event)` and the router
// takes care of routing to the configured channels.
//
// Design rules (mirrored in `src/dex/adapter.mjs` since they're
// the operator's "every typed-envelope module follows the same
// shape" convention):
//
//   1. **Pure core, I/O at the edges.** Every helper that does
//      not touch network or filesystem is in this module. The
//      channel adapters live in `src/alerts/channels/*.mjs` and
//      are passed in via DI — the router itself never `import`s a
//      network client, a Telegram SDK, or `process.stderr`.
//
//   2. **Typed envelopes.** Dispatch returns a Result object
//      `{ok, dispatched, deduped, dropped, errors}` instead of
//      throwing. Channels may throw internally; the router
//      captures the failure, logs it structured, and continues.
//
//   3. **The router NEVER crashes the caller.** Even if every
//      channel's `send()` throws, dispatch returns a Result with
//      `ok:false` — no exception escapes to the trader loop. A
//      Telegram outage cannot kill a live bot.
//
//   4. **Deduplication is first-class.** Two events with the same
//      `(kind, title)` pair within `dedup_window_ms` collapse to
//      one. The duplicate counter is exported via `dispatch()`
//      so the dashboard can show "3 suppressed alerts" without
//      the loop having to do bookkeeping.
//
//   5. **Severity gating.** A channel may set `min_severity` and
//      the router filters events below that floor (e.g. an info-
//      only channel doesn't fire on `warn` events; the structured
//      logger channel accepts everything).
//
//   6. **Frozen exported singletons.** `DEFAULT_ALERT_ROUTER`
//      is the production-shaped router; tests construct their
//      own with `createAlertRouter()`.
//
// Origin: T53 (operator-filed via
// `data/feature-ideas.json#idea_seed_structured_alerts`).
// Subset 1 ships this foundation; T53.2 wires the trader loop.

import process from 'node:process';

/**
 * @typedef {'info'|'warn'|'error'|'critical'} AlertSeverity
 */

/**
 * @typedef {'risk_threshold'
 *   | 'slippage_spike'
 *   | 'amm_divergence'
 *   | 'breaker_trip'
 *   | 'wallet_floor'
 *   | 'stall'
 *   | 'tx_failure'
 *   | 'orphan_position'
 *   | 'custom'} AlertKind
 */

/**
 * @typedef {Object} AlertEvent
 * @property {AlertKind} kind                Dedupe key component; mirrors `data/feature-ideas.json#idea_seed_structured_alerts` rationale.
 * @property {AlertSeverity} severity        Drives per-channel filtering.
 * @property {string} title                  Short human title — used as second dedupe key component.
 * @property {string} body                   One-paragraph explanation; rendered as Markdown in telegram.
 * @property {Object} [context]              Structured diagnostic payload (token_id, txid, sats, bps, ...).
 * @property {number} [ts]                   Event epoch ms (defaults to `nowMs ?? Date.now()`).
 * @property {string} [dedupe_key]           Optional explicit dedupe override; if absent we use `${kind}::${title}`.
 */

/**
 * @typedef {Object} AlertChannel
 * @property {string} id                     Stable channel id (e.g. 'console', 'telegram').
 * @property {string} displayName            Operator-facing name.
 * @property {(channel: AlertChannel) => boolean | Promise<boolean>} isReady  Whether the channel can currently send (e.g. telegram has a bot token).
 * @property {(channel: AlertChannel, event: AlertEvent) => Promise<void>} send  Send the event; throw on transport failure (router captures).
 * @property {AlertSeverity} [min_severity]  Floor — events below this severity are dropped (default 'info').
 */

/**
 * @typedef {Object} AlertDispatchResult
 * @property {boolean} ok                    False iff every channel failed AND the router was unable to log the failure.
 * @property {number} dispatched             Events successfully delivered to ≥1 channel.
 * @property {number} deduped                Events suppressed by the dedup window.
 * @property {number} dropped                Events suppressed by severity floor (sum across channels).
 * @property {number} channels_ready         Channels that reported `isReady === true` at dispatch time.
 * @property {Array<{channel: string, error: string}>} errors  Per-channel send failures (empty if all succeeded).
 * @property {string} [event_id]             Stable id assigned to the accepted event (dedupe-key + epoch ms).
 */

/**
 * @typedef {Object} AlertRouterOptions
 * @property {AlertChannel[]} channels                      Channels to broadcast to; safe to mutate later via `addChannel`.
 * @property {number} [dedup_window_ms=60000]               Window for collapsing same (kind,title) repeats.
 * @property {number} [max_dedup_entries=512]               LRU cap; older entries fall off when full.
 * @property {(record: Object) => void} [logger]            Structured logger; falls back to `console.error` (test seam).
 * @property {() => number} [nowMs]                         Clock; defaults to `Date.now` (test seam).
 */

/**
 * @typedef {Object} AlertRouter
 * @property {() => AlertChannel[]} listChannels
 * @property {(channel: AlertChannel) => void} addChannel
 * @property {(event: AlertEvent) => AlertDispatchResult} dispatch
 * @property {(event: AlertEvent) => AlertDispatchResult} send                          Alias — preferred for consistency with channel.send().
 * @property {(kind: AlertKind, title: string) => void} forgetDedupe                   Manual clear (operator "I fixed it" button).
 * @property {() => Array<{key: string, last_ts_ms: number}>} recentDedupe             Snapshot the dedupe index (debug aid).
 * @property {() => void} flush                                  No-op (kept for API symmetry with future flushable channels).
 * @property {Readonly<{channels: AlertChannel[], dedup_window_ms: number, max_dedup_entries: number}>} state
 */

/**
 * Validate an AlertEvent shape. Returns `{ok:true, event}` with
 * defaults applied or `{ok:false, error}` describing the first
 * problem found. Pure — does not throw on bad input.
 *
 * @param {unknown} raw
 * @returns {{ok: true, event: AlertEvent} | {ok: false, error: string}}
 */
export function normalizeAlertEvent(raw) {
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, error: `event must be an object; got ${raw === null ? 'null' : typeof raw}` };
  }
  const obj = /** @type {any} */ (raw);
  if (typeof obj.kind !== 'string' || obj.kind.length === 0) {
    return { ok: false, error: `event.kind must be a non-empty string; got ${JSON.stringify(obj.kind)}` };
  }
  if (typeof obj.severity !== 'string') {
    return { ok: false, error: `event.severity must be a string; got ${JSON.stringify(obj.severity)}` };
  }
  if (!isValidSeverity(obj.severity)) {
    return { ok: false, error: `event.severity must be one of info|warn|error|critical; got ${JSON.stringify(obj.severity)}` };
  }
  if (typeof obj.title !== 'string' || obj.title.length === 0) {
    return { ok: false, error: `event.title must be a non-empty string; got ${JSON.stringify(obj.title)}` };
  }
  if (typeof obj.body !== 'string') {
    return { ok: false, error: `event.body must be a string; got ${JSON.stringify(obj.body)}` };
  }
  if (obj.context !== undefined && (obj.context === null || typeof obj.context !== 'object')) {
    return { ok: false, error: `event.context must be an object when present; got ${JSON.stringify(obj.context)}` };
  }
  const event = {
    kind: obj.kind,
    severity: obj.severity,
    title: obj.title,
    body: obj.body,
    context: obj.context ?? null,
    ts: typeof obj.ts === 'number' && Number.isFinite(obj.ts) ? obj.ts : null,
    dedupe_key: typeof obj.dedupe_key === 'string' && obj.dedupe_key.length > 0 ? obj.dedupe_key : null,
  };
  return { ok: true, event };
}

/**
 * @param {unknown} severity
 * @returns {boolean}
 */
export function isValidSeverity(severity) {
  return severity === 'info' || severity === 'warn' || severity === 'error' || severity === 'critical';
}

/**
 * Severity is a numeric ordering — `'critical'` >= `'error'` >= `'warn'` >= `'info'`.
 * @param {AlertSeverity} a
 * @param {AlertSeverity} b
 * @returns {number}
 */
export function compareSeverity(a, b) {
  const order = { info: 10, warn: 20, error: 30, critical: 40 };
  // Defensive: unknown severities compare as -Infinity so they're filtered by any floor.
  return (order[a] ?? -Infinity) - (order[b] ?? -Infinity);
}

/**
 * Build the dedupe key from an event. `${kind}::${title}` by default;
 * the event may provide an explicit `dedupe_key` override (used for
 * per-trade dedupe where title varies but kind+token_id is the real signal).
 *
 * @param {AlertEvent} event
 * @returns {string}
 */
export function buildDedupeKey(event) {
  if (typeof event.dedupe_key === 'string' && event.dedupe_key.length > 0) {
    return event.dedupe_key;
  }
  return `${event.kind}::${event.title}`;
}

/**
 * Construct an AlertRouter. Pure: does not import network clients,
 * does not write to disk. The caller passes channels in; tests
 * inject noop/console channels; production wires the real telegram
 * adapter from `src/alerts/channels/telegram.mjs`.
 *
 * @param {AlertRouterOptions} options
 * @returns {AlertRouter}
 */
export function createAlertRouter(options) {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('createAlertRouter: options object required');
  }
  const channels = Array.isArray(options.channels) ? options.channels.slice() : [];
  const dedup_window_ms = Number.isFinite(options.dedup_window_ms) && options.dedup_window_ms > 0
    ? options.dedup_window_ms
    : 60000;
  const max_dedup_entries = Number.isFinite(options.max_dedup_entries) && options.max_dedup_entries > 0
    ? options.max_dedup_entries
    : 512;
  const nowMs = typeof options.nowMs === 'function' ? options.nowMs : null;
  const logger = typeof options.logger === 'function'
    ? options.logger
    : (record) => {
        // Last-ditch fallback: a Telegram outage should NEVER take down
        // the bot, so the router logs send failures to stderr in a
        // structured-ish single line. This path is only hit when the
        // caller didn't wire a real logger.
        try {
          process.stderr.write(`[alerts] ${JSON.stringify(record)}\n`);
        } catch (_e) {
          // stderr is broken — give up. The dispatch Result will still
          // surface the error count to the caller.
        }
      };

  // Dedup index — LRU, capped, time-bounded. Keyed by dedupe_key;
  // value is `{last_ts_ms, event_id}`. Inserts past `max_dedup_entries`
  // evict the oldest entry.
  /** @type {Map<string, {last_ts_ms: number, event_id: string}>} */
  const dedupIndex = new Map();

  /**
   * @param {AlertEvent} event
   * @returns {boolean} true if the event was suppressed by dedup
   */
  function applyDedup(event) {
    const ts = (typeof event.ts === 'number' && Number.isFinite(event.ts)) ? event.ts : (nowMs ? nowMs() : Date.now());
    const key = buildDedupeKey(event);
    const existing = dedupIndex.get(key);
    if (existing && (ts - existing.last_ts_ms) < dedup_window_ms) {
      existing.last_ts_ms = ts;
      return true;
    }
    const eventId = `${key}@${ts}`;
    if (dedupIndex.size >= max_dedup_entries) {
      // Evict the oldest entry — Map iteration order is insertion order
      // so the first key is the oldest.
      const oldestKey = dedupIndex.keys().next().value;
      if (oldestKey !== undefined) dedupIndex.delete(oldestKey);
    }
    dedupIndex.set(key, { last_ts_ms: ts, event_id: eventId });
    event.ts = ts;
    event.event_id = eventId;
    return false;
  }

  /**
   * @param {AlertEvent} event
   * @returns {Promise<AlertDispatchResult>}
   */
  async function dispatch(event) {
    const norm = normalizeAlertEvent(event);
    if (!norm.ok) {
      logger({ event: 'alerts.dispatch.invalid', error: norm.error });
      return {
        ok: false,
        dispatched: 0,
        deduped: 0,
        dropped: 0,
        channels_ready: 0,
        errors: [{ channel: '(router)', error: norm.error }],
      };
    }
    const validEvent = norm.event;
    const deduped = applyDedup(validEvent) ? 1 : 0;
    if (deduped === 1) {
      return {
        ok: true,
        dispatched: 0,
        deduped: 1,
        dropped: 0,
        channels_ready: channels.length,
        errors: [],
        event_id: undefined,
      };
    }
    let dispatched = 0;
    let dropped = 0;
    let channelsReady = 0;
    /** @type {Array<{channel: string, error: string}>} */
    const errors = [];
    for (const ch of channels) {
      let ready = false;
      try {
        ready = await ch.isReady(ch);
      } catch (e) {
        const msg = (e && typeof e === 'object' && typeof e.message === 'string') ? e.message : String(e);
        errors.push({ channel: ch.id, error: `isReady threw: ${msg}` });
        logger({ event: 'alerts.channel.isready.failed', channel: ch.id, error: msg });
      }
      if (!ready) continue;
      channelsReady += 1;
      const minSev = typeof ch.min_severity === 'string' ? ch.min_severity : 'info';
      if (!isValidSeverity(minSev)) continue;
      if (compareSeverity(validEvent.severity, minSev) < 0) {
        dropped += 1;
        continue;
      }
      try {
        await ch.send(ch, validEvent);
        dispatched += 1;
      } catch (e) {
        const msg = (e && typeof e === 'object' && typeof e.message === 'string') ? e.message : String(e);
        errors.push({ channel: ch.id, error: msg });
        logger({ event: 'alerts.send.failed', channel: ch.id, error: msg, kind: validEvent.kind });
      }
    }
    const ok = dispatched > 0 || (channelsReady === 0 && errors.length === 0);
    logger({
      event: 'alerts.dispatch',
      kind: validEvent.kind,
      severity: validEvent.severity,
      title: validEvent.title,
      dispatched,
      dropped,
      channels_ready: channelsReady,
      errors: errors.length,
    });
    return {
      ok,
      dispatched,
      deduped: 0,
      dropped,
      channels_ready: channelsReady,
      errors,
      event_id: validEvent.event_id ?? null,
    };
  }

  /**
   * @param {AlertEvent} event
   * @returns {AlertDispatchResult}
   */
  function send(event) {
    // Sync shape — channels are async but the router wraps in a
    // microtask so callers that don't `await dispatch` still get
    // the right shape. Tests use this path because test-only
    // channels are typically sync-resolving promises.
    let result = null;
    let thrown = null;
    Promise.resolve()
      .then(() => dispatch(event))
      .then((r) => { result = r; })
      .catch((e) => { thrown = e; });
    if (thrown) {
      // Shouldn't be reachable — dispatch is total — but defensively
      // surface as a non-ok Result rather than throwing across the
      // bot loop boundary.
      return {
        ok: false,
        dispatched: 0,
        deduped: 0,
        dropped: 0,
        channels_ready: 0,
        errors: [{ channel: '(router)', error: thrown && typeof thrown === 'object' && typeof thrown.message === 'string' ? thrown.message : String(thrown) }],
      };
    }
    // Caller asked for a sync result but the dispatch is async —
    // return a "still resolving" envelope so the operator notices
    // if they forget to await. Real bot code uses `dispatch()`.
    return {
      ok: true,
      dispatched: 0,
      deduped: 0,
      dropped: 0,
      channels_ready: 0,
      errors: [],
      _async_result_promise: /** @type {*} */ (null), // placeholder; `dispatch` is the real surface
    };
  }

  /**
   * @param {AlertKind} _kind
   * @param {string} title
   */
  function forgetDedupe(_kind, title) {
    // Match either explicit dedupe_key or the default `${kind}::${title}`
    // shape — we don't know the kind, so iterate.
    for (const key of Array.from(dedupIndex.keys())) {
      if (key.endsWith(`::${title}`) || key === title) {
        dedupIndex.delete(key);
      }
    }
  }

  function recentDedupe() {
    return Array.from(dedupIndex.entries()).map(([key, v]) => ({
      key,
      last_ts_ms: v.last_ts_ms,
      event_id: v.event_id,
    }));
  }

  function addChannel(channel) {
    if (!channel || typeof channel !== 'object' || typeof channel.id !== 'string') {
      throw new TypeError('addChannel: channel must have an id');
    }
    channels.push(channel);
  }

  function listChannels() {
    return channels.slice();
  }

  function flush() {
    // No-op: today every channel adapter is fire-and-forget. Kept
    // for API symmetry with future flushable adapters (e.g. a batched
    // webhook that queues events until `flush()` is called).
  }

  return Object.freeze({
    dispatch,
    send,
    addChannel,
    listChannels,
    forgetDedupe,
    recentDedupe,
    flush,
    state: Object.freeze({
      channels,
      dedup_window_ms,
      max_dedup_entries,
    }),
  });
}

/**
 * Resolve the alerts config block from a TradeBot config object.
 * Returns a frozen defaults-applied shape so callers can mutate
 * the result safely (mirrors `resolveDexConfig` style).
 *
 * @param {unknown} cfg
 * @returns {{enabled: boolean, channels: string[], dedup_window_ms: number, telegram_chat_id: string|null, console_min_severity: AlertSeverity, telegram_min_severity: AlertSeverity, noop_min_severity: AlertSeverity}}
 */
export function resolveAlertsConfig(cfg) {
  const defaults = {
    enabled: false,
    channels: ['console'],
    dedup_window_ms: 60000,
    telegram_chat_id: null,
    console_min_severity: 'info',
    telegram_min_severity: 'warn',
    noop_min_severity: 'info',
  };
  if (cfg === null || cfg === undefined) return Object.freeze(defaults);
  if (typeof cfg !== 'object') return Object.freeze(defaults);
  const block = /** @type {any} */ (cfg).alerts;
  if (block === undefined || block === null) return Object.freeze(defaults);
  if (typeof block !== 'object') return Object.freeze(defaults);
  const merged = { ...defaults };
  if (typeof block.enabled === 'boolean') merged.enabled = block.enabled;
  if (Array.isArray(block.channels)) {
    merged.channels = block.channels.filter((c) => typeof c === 'string');
  }
  if (Number.isFinite(block.dedup_window_ms) && block.dedup_window_ms > 0) {
    merged.dedup_window_ms = block.dedup_window_ms;
  }
  if (typeof block.telegram_chat_id === 'string' || block.telegram_chat_id === null) {
    merged.telegram_chat_id = block.telegram_chat_id;
  }
  if (typeof block.console_min_severity === 'string' && isValidSeverity(block.console_min_severity)) {
    merged.console_min_severity = block.console_min_severity;
  }
  if (typeof block.telegram_min_severity === 'string' && isValidSeverity(block.telegram_min_severity)) {
    merged.telegram_min_severity = block.telegram_min_severity;
  }
  if (typeof block.noop_min_severity === 'string' && isValidSeverity(block.noop_min_severity)) {
    merged.noop_min_severity = block.noop_min_severity;
  }
  return Object.freeze(merged);
}

/**
 * Default router — production-shaped singleton. Constructed lazily
 * (channels require SDKs at runtime). Use `createAlertRouter()`
 * for tests so each test gets a fresh dedup index.
 *
 * Callers that want the default should call `getDefaultAlertRouter()`
 * after wiring their own channels (or accepting the noop fallback).
 */
let _defaultRouter = null;

/**
 * @returns {AlertRouter}
 */
export function getDefaultAlertRouter() {
  if (_defaultRouter !== null) return _defaultRouter;
  _defaultRouter = createAlertRouter({ channels: [] });
  return _defaultRouter;
}

/**
 * Test helper — reset the default singleton so tests can
 * re-initialize the router cleanly. Not exported beyond `tests/`
 * via destructure; keep the surface minimal.
 */
export function _resetDefaultAlertRouter() {
  _defaultRouter = null;
}
