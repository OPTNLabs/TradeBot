#!/usr/bin/env node
// tests/alerts.test.mjs
//
// T53.1 — Unit tests for the alerts subsystem foundation.
//
// Covers:
//   - src/alerts/router.mjs          (createAlertRouter, normalizeAlertEvent,
//                                     buildDedupeKey, compareSeverity,
//                                     resolveAlertsConfig, getDefaultAlertRouter)
//   - src/alerts/channels/noop.mjs   (basic shape + record-on-send behavior)
//   - src/alerts/channels/console.mjs (NDJSON line shape + backpressure-safe)
//   - src/alerts/channels/telegram.mjs (formatter + MarkdownV2 escape +
//                                     disabled-by-default isReady behavior,
//                                     mocked fetch scenarios for happy / 429 /
//                                     HTTP error / timeout / getMe probe)
//   - src/alerts/index.mjs           (createConfiguredAlertRouter wired from
//                                     config — disabled default wires noop,
//                                     enabled wires channels from
//                                     `alerts.channels` array)
//   - src/dashboard/alerts-recent.mjs (pure helpers: parseAlertsFilters,
//                                     rangeToAlertsMs, parseAlertsLimit,
//                                     filterAlertsEvents,
//                                     buildAlertsRecentResponse)
//
// Run via:
//   node --test tests/alerts.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';

import {
  createAlertRouter,
  resolveAlertsConfig,
  normalizeAlertEvent,
  buildDedupeKey,
  compareSeverity,
  isValidSeverity,
  getDefaultAlertRouter,
  _resetDefaultAlertRouter,
} from '../src/alerts/router.mjs';
import { createNoopChannel } from '../src/alerts/channels/noop.mjs';
import { createConsoleChannel } from '../src/alerts/channels/console.mjs';
import {
  createTelegramChannel,
  formatTelegramMessage,
  escapeMarkdownV2,
} from '../src/alerts/channels/telegram.mjs';
import { createConfiguredAlertRouter } from '../src/alerts/index.mjs';
import {
  parseAlertsFilters,
  rangeToAlertsMs,
  parseAlertsLimit,
  filterAlertsEvents,
  buildAlertsRecentResponse,
  DEFAULT_ALERTS_FILE,
  DEFAULT_ALERTS_MAX,
} from '../src/dashboard/alerts-recent.mjs';

// ─────────────────────────────────────────────────────────────────────
//  router.mjs — normalizeAlertEvent
// ─────────────────────────────────────────────────────────────────────

test('normalizeAlertEvent: accepts a complete event, defaults ts=null', () => {
  const r = normalizeAlertEvent({
    kind: 'slippage_spike',
    severity: 'warn',
    title: 'slippage 420bps',
    body: 'actual > tolerance',
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.event.kind, 'slippage_spike');
  assert.equal(r.event.severity, 'warn');
  assert.equal(r.event.title, 'slippage 420bps');
  assert.equal(r.event.body, 'actual > tolerance');
  assert.equal(r.event.context, null);
  assert.equal(r.event.ts, null);
});

test('normalizeAlertEvent: rejects non-object', () => {
  assert.equal(normalizeAlertEvent(null).ok, false);
  assert.equal(normalizeAlertEvent(42).ok, false);
  assert.equal(normalizeAlertEvent('hello').ok, false);
});

test('normalizeAlertEvent: rejects missing/bad kind, severity, title, body', () => {
  assert.equal(normalizeAlertEvent({ severity: 'info', title: 't', body: 'b' }).ok, false);
  assert.equal(normalizeAlertEvent({ kind: 'k', title: 't', body: 'b' }).ok, false);
  assert.equal(normalizeAlertEvent({ kind: 'k', severity: 'info', body: 'b' }).ok, false);
  assert.equal(normalizeAlertEvent({ kind: 'k', severity: 'info', title: 't' }).ok, false);
  assert.equal(normalizeAlertEvent({ kind: 'k', severity: 'unknown', title: 't', body: 'b' }).ok, false);
  assert.equal(normalizeAlertEvent({ kind: 'k', severity: 'info', title: 't', body: 'b', context: 'not-object' }).ok, false);
});

// ─────────────────────────────────────────────────────────────────────
//  router.mjs — compareSeverity / isValidSeverity / buildDedupeKey
// ─────────────────────────────────────────────────────────────────────

test('compareSeverity: critical > error > warn > info', () => {
  assert.ok(compareSeverity('critical', 'error') > 0);
  assert.ok(compareSeverity('error', 'warn') > 0);
  assert.ok(compareSeverity('warn', 'info') > 0);
  assert.equal(compareSeverity('info', 'info'), 0);
  assert.ok(compareSeverity('info', 'error') < 0);
});

test('isValidSeverity: accepts only the 4 canonical values', () => {
  assert.equal(isValidSeverity('info'), true);
  assert.equal(isValidSeverity('warn'), true);
  assert.equal(isValidSeverity('error'), true);
  assert.equal(isValidSeverity('critical'), true);
  assert.equal(isValidSeverity('INFO'), false);
  assert.equal(isValidSeverity('debug'), false);
  assert.equal(isValidSeverity(null), false);
});

test('buildDedupeKey: defaults to `${kind}::${title}`', () => {
  assert.equal(buildDedupeKey({ kind: 'breach', title: 'wallet floor' }), 'breach::wallet floor');
  assert.equal(buildDedupeKey({ kind: 'k', title: 't', dedupe_key: 'OVERRIDE' }), 'OVERRIDE');
});

// ─────────────────────────────────────────────────────────────────────
//  router.mjs — resolveAlertsConfig
// ─────────────────────────────────────────────────────────────────────

test('resolveAlertsConfig: returns the documented defaults on null/undefined/empty', () => {
  for (const v of [null, undefined, {}, { alerts: null }, { alerts: 'bad' }]) {
    const r = resolveAlertsConfig(v);
    assert.equal(r.enabled, false);
    assert.deepEqual(r.channels, ['console']);
    assert.equal(r.dedup_window_ms, 60000);
    assert.equal(r.telegram_chat_id, null);
  }
});

test('resolveAlertsConfig: accepts overrides + filters bad sub-types', () => {
  const r = resolveAlertsConfig({
    alerts: {
      enabled: true,
      channels: ['telegram', 42, 'noop'],
      dedup_window_ms: 30000,
      telegram_chat_id: '@tradebot_alerts',
      telegram_min_severity: 'error',
    },
  });
  assert.equal(r.enabled, true);
  assert.deepEqual(r.channels, ['telegram', 'noop']);
  assert.equal(r.dedup_window_ms, 30000);
  assert.equal(r.telegram_chat_id, '@tradebot_alerts');
  assert.equal(r.telegram_min_severity, 'error');
});

test('resolveAlertsConfig: rejects invalid severity strings', () => {
  const r = resolveAlertsConfig({
    alerts: {
      telegram_min_severity: 'critical-on-fire',
      console_min_severity: 'urgent',
    },
  });
  // The bad values fall back to the documented defaults.
  assert.equal(r.telegram_min_severity, 'warn');
  assert.equal(r.console_min_severity, 'info');
});

test('resolveAlertsConfig: result is frozen', () => {
  const r = resolveAlertsConfig({});
  assert.equal(Object.isFrozen(r), true);
});

// ─────────────────────────────────────────────────────────────────────
//  router.mjs — createAlertRouter dispatch behavior
// ─────────────────────────────────────────────────────────────────────

test('router: dispatches to every ready channel', async () => {
  const a = createNoopChannel();
  const b = createNoopChannel({ id: 'b' });
  const router = createAlertRouter({ channels: [a, b] });
  const r = await router.dispatch({
    kind: 'risk_threshold',
    severity: 'warn',
    title: 'breaker trip',
    body: '5 losses in a row',
  });
  assert.equal(r.ok, true);
  assert.equal(r.dispatched, 2);
  assert.equal(r.channels_ready, 2);
  assert.equal(a.sent.length, 1);
  assert.equal(b.sent.length, 1);
  assert.equal(a.sent[0].title, 'breaker trip');
});

test('router: dedup-suppresses within window; second dispatch returns dispatched:0, deduped:1', async () => {
  const ch = createNoopChannel();
  let now = 1000;
  const router = createAlertRouter({
    channels: [ch],
    dedup_window_ms: 5000,
    nowMs: () => now,
  });
  const ev = { kind: 'breaker_trip', severity: 'error', title: 'cooldown hit', body: 'x' };
  const r1 = await router.dispatch({ ...ev, ts: now });
  assert.equal(r1.dispatched, 1);
  now += 1000;
  const r2 = await router.dispatch({ ...ev, ts: now });
  assert.equal(r2.dispatched, 0);
  assert.equal(r2.deduped, 1);
  now += 6000; // past the window
  const r3 = await router.dispatch({ ...ev, ts: now });
  assert.equal(r3.dispatched, 1);
  assert.equal(r3.deduped, 0);
});

test('router: severity floor per channel skips below-floor events but counts in dropped', async () => {
  const a = createNoopChannel({ min_severity: 'info' });
  const b = createNoopChannel({ min_severity: 'critical', id: 'b' });
  const router = createAlertRouter({ channels: [a, b] });
  const r = await router.dispatch({
    kind: 'wallet_floor',
    severity: 'warn',
    title: 'low',
    body: 'below floor',
  });
  assert.equal(r.dispatched, 1);
  assert.equal(r.dropped, 1);
  assert.equal(a.sent.length, 1);
  assert.equal(b.sent.length, 0);
});

test('router: never throws on channel send failure (Telegram outage cannot kill the bot)', async () => {
  /** @type {import('../src/alerts/router.mjs').AlertChannel} */
  const broken = {
    id: 'broken',
    displayName: 'Broken',
    min_severity: 'info',
    isReady: () => true,
    send: async () => {
      throw new Error('network is down');
    },
  };
  const ok = createNoopChannel();
  const logs = [];
  const router = createAlertRouter({
    channels: [broken, ok],
    logger: (rec) => logs.push(rec),
  });
  const r = await router.dispatch({
    kind: 'tx_failure',
    severity: 'error',
    title: 'broadcast failed',
    body: 'Electrum returned 502',
  });
  assert.equal(r.ok, true); // the noop channel succeeded
  assert.equal(r.dispatched, 1);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].channel, 'broken');
  assert.ok(logs.some((l) => l.event === 'alerts.send.failed' && l.channel === 'broken'));
});

test('router: isReady=false skips the channel without errors', async () => {
  /** @type {import('../src/alerts/router.mjs').AlertChannel} */
  const offline = {
    id: 'offline',
    displayName: 'Offline',
    min_severity: 'info',
    isReady: () => false,
    send: async () => { throw new Error('should not be called'); },
  };
  const ok = createNoopChannel();
  const router = createAlertRouter({ channels: [offline, ok] });
  const r = await router.dispatch({
    kind: 'stall',
    severity: 'warn',
    title: 'bot stall',
    body: 'no ticks for 600s',
  });
  assert.equal(r.dispatched, 1);
  assert.equal(r.channels_ready, 1);
  assert.equal(ok.sent.length, 1);
});

test('router: isReady that throws is captured + surfaced as an error', async () => {
  /** @type {import('../src/alerts/router.mjs').AlertChannel} */
  const flaky = {
    id: 'flaky',
    displayName: 'Flaky',
    min_severity: 'info',
    isReady: () => { throw new Error('isReady blew up'); },
    send: async () => {},
  };
  const ok = createNoopChannel();
  const router = createAlertRouter({ channels: [flaky, ok] });
  const r = await router.dispatch({
    kind: 'custom',
    severity: 'info',
    title: 'flaky',
    body: 'b',
  });
  assert.equal(r.dispatched, 1);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].channel, 'flaky');
});

test('router: invalid event returns ok:false without calling any channel', async () => {
  const ch = createNoopChannel();
  const router = createAlertRouter({ channels: [ch] });
  const r = await router.dispatch({ not: 'an event' });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 1);
  assert.equal(ch.sent.length, 0);
});

test('router: forgetDedupe clears the entry so the next dispatch re-fires', async () => {
  const ch = createNoopChannel();
  let now = 1000;
  const router = createAlertRouter({ channels: [ch], nowMs: () => now, dedup_window_ms: 1e9 });
  await router.dispatch({ kind: 'breaker_trip', severity: 'error', title: 'cooldown hit', body: 'x', ts: now });
  router.forgetDedupe('breaker_trip', 'cooldown hit');
  const r = await router.dispatch({ kind: 'breaker_trip', severity: 'error', title: 'cooldown hit', body: 'x', ts: now + 100 });
  assert.equal(r.dispatched, 1);
});

test('router: recentDedupe returns the index for debug', async () => {
  const ch = createNoopChannel();
  const router = createAlertRouter({ channels: [ch], nowMs: () => 12345 });
  await router.dispatch({ kind: 'k1', severity: 'info', title: 'one', body: 'b' });
  await router.dispatch({ kind: 'k2', severity: 'info', title: 'two', body: 'b' });
  const recent = router.recentDedupe();
  assert.equal(recent.length, 2);
  assert.ok(recent.find((r) => r.key === 'k1::one'));
  assert.ok(recent.find((r) => r.key === 'k2::two'));
  assert.equal(recent[0].last_ts_ms, 12345);
});

test('router: state shape is exposed + frozen', () => {
  const router = createAlertRouter({ channels: [createNoopChannel()], dedup_window_ms: 12345 });
  assert.equal(router.state.dedup_window_ms, 12345);
  assert.equal(Object.isFrozen(router.state), true);
});

test('router: addChannel appends a new channel at runtime', async () => {
  const a = createNoopChannel();
  const router = createAlertRouter({ channels: [a] });
  const b = createNoopChannel({ id: 'b' });
  router.addChannel(b);
  const r = await router.dispatch({
    kind: 'breaker_trip',
    severity: 'warn',
    title: 't',
    body: 'b',
  });
  assert.equal(r.dispatched, 2);
});

// ─────────────────────────────────────────────────────────────────────
//  channels/noop.mjs
// ─────────────────────────────────────────────────────────────────────

test('noop channel: accepts every event, never throws, records sent[]', async () => {
  const ch = createNoopChannel({ id: 'n1', min_severity: 'info' });
  assert.equal(ch.id, 'n1');
  assert.equal(ch.displayName, 'No-op');
  await ch.send(ch, { kind: 'k', severity: 'warn', title: 't', body: 'b', context: { x: 1 }, ts: 100 });
  assert.equal(ch.sent.length, 1);
  assert.equal(ch.sent[0].kind, 'k');
});

// ─────────────────────────────────────────────────────────────────────
//  channels/console.mjs
// ─────────────────────────────────────────────────────────────────────

test('console channel: writes one JSON object per line', async () => {
  /** @type {string[]} */
  const lines = [];
  const sink = { write: (line) => { lines.push(line); return true; } };
  const ch = createConsoleChannel({ sink });
  await ch.send(ch, { kind: 'k', severity: 'info', title: 'hello', body: 'world', ts: 1234 });
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0].trim());
  assert.equal(parsed.event, 'alerts.received');
  assert.equal(parsed.kind, 'k');
  assert.equal(parsed.severity, 'info');
  assert.equal(parsed.title, 'hello');
  assert.equal(parsed.body, 'world');
  assert.equal(parsed.ts, 1234);
});

test('console channel: formatEvent is exposed for tests', () => {
  const ch = createConsoleChannel({ sink: { write: () => true } });
  const line = ch.formatEvent({ kind: 'k', severity: 'warn', title: 't', body: 'b', ts: 9999 });
  assert.match(line, /"event":"alerts.received"/);
  assert.match(line, /"ts":9999/);
});

test('console channel: a sink that throws surfaces as an error to the router', async () => {
  const ch = createConsoleChannel({ sink: { write: () => { throw new Error('epipe'); } } });
  await assert.rejects(() => ch.send(ch, { kind: 'k', severity: 'info', title: 't', body: 'b', ts: 1 }), /console channel/);
});

// ─────────────────────────────────────────────────────────────────────
//  channels/telegram.mjs — pure + disabled-by-default + mocked fetch
// ─────────────────────────────────────────────────────────────────────

test('escapeMarkdownV2: escapes the Telegram reserved chars', () => {
  assert.equal(escapeMarkdownV2('hello.world'), 'hello\\.world');
  assert.equal(escapeMarkdownV2('*bold*'), '\\*bold\\*');
  assert.equal(escapeMarkdownV2('plain'), 'plain');
  assert.equal(escapeMarkdownV2(''), '');
  assert.equal(escapeMarkdownV2(null), '');
});

test('formatTelegramMessage: title wrapped in bold + severity header + ts', () => {
  const msg = formatTelegramMessage({
    kind: 'breaker_trip',
    severity: 'error',
    title: 'hot',
    body: 'context',
    context: { token_id: 'abc' },
    event_id: 'evt-1',
    ts: 1700000000000,
  });
  // Title is wrapped in literal Telegram bold markers *…* (the
  // markers themselves are part of MarkdownV2 syntax; the content
  // inside is title-escaped). No special chars → no escapes needed
  // inside the title.
  assert.match(msg, /^\*hot\*/);
  // The severity + kind header goes through escapeMarkdownV2 so
  // brackets + underscores come out escaped (`\\[ERROR\\] …`).
  assert.match(msg, /\\\[ERROR\\\] breaker\\_trip/);
  assert.match(msg, /context/);
  assert.match(msg, /token\\_id: abc/);
  assert.match(msg, /id:\*/);
  assert.match(msg, /evt\\-1/);
  // Verify it's a string of sane length (no undefined slots).
  assert.ok(msg.length < 4096);
});

test('formatTelegramMessage: long bodies are truncated', () => {
  const huge = 'X'.repeat(5000);
  const msg = formatTelegramMessage({
    kind: 'custom', severity: 'info', title: 't', body: huge, ts: 1,
  });
  assert.ok(msg.length <= 4096);
  assert.match(msg, /truncated/);
});

test('telegram channel: disabled-by-default (no token, no chat)', async () => {
  const ch = createTelegramChannel({});
  assert.equal(ch.isConfigured(), false);
  assert.equal(await ch.isReady(), false);
  const err = await ch.send(ch, { kind: 'k', severity: 'info', title: 't', body: 'b' }).then(() => null).catch((e) => e);
  assert.ok(err);
  assert.match(err.message, /bot_token or chat_id not configured/);
});

test('telegram channel: sendMessage happy path via mocked fetch', async () => {
  /** @type {Array<{url: string, init: any}>} */
  const calls = [];
  /** @type {typeof globalThis.fetch} */
  // eslint-disable-next-line require-await
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/getMe')) {
      return new Response(JSON.stringify({ ok: true, result: { id: 1, is_bot: true } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const ch = createTelegramChannel({
    bot_token: 'TESTTOKEN',
    chat_id: '12345',
    fetchImpl,
  });
  // First isReady triggers getMe; second call memoizes for ttl.
  assert.equal(await ch.isReady(), true);
  await ch.send(ch, { kind: 'breaker_trip', severity: 'error', title: 't', body: 'b', ts: 123 });
  assert.equal(ch.lastSent().length, 1);
  assert.equal(ch.lastSent()[0].chat_id, '12345');
  // Two recorded calls: getMe + sendMessage.
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/getMe$/);
  assert.match(calls[1].url, /\/sendMessage$/);
  const body = JSON.parse(calls[1].init.body);
  assert.equal(body.chat_id, '12345');
  assert.equal(body.parse_mode, 'MarkdownV2');
  assert.match(body.text, /^\*t\*/);
});

test('telegram channel: 429 rate-limit surfaces in the error message', async () => {
  /** @type {typeof globalThis.fetch} */
  // eslint-disable-next-line require-await
  const fetchImpl = async (url) => {
    if (url.endsWith('/getMe')) return new Response('{"ok":true,"result":{}}', { status: 200 });
    return new Response('{"ok":false,"description":"retry after 30","parameters":{"retry_after":30}}', { status: 429 });
  };
  const ch = createTelegramChannel({ bot_token: 'T', chat_id: 'C', fetchImpl });
  await ch.isReady();
  const err = await ch.send(ch, { kind: 'k', severity: 'warn', title: 't', body: 'b', ts: 1 }).then(() => null).catch((e) => e);
  assert.ok(err);
  assert.match(err.message, /429/);
});

test('telegram channel: HTTP error from sendMessage throws with the status', async () => {
  /** @type {typeof globalThis.fetch} */
  // eslint-disable-next-line require-await
  const fetchImpl = async (url) => {
    if (url.endsWith('/getMe')) return new Response('{"ok":true,"result":{}}', { status: 200 });
    return new Response('bad gateway', { status: 502 });
  };
  const ch = createTelegramChannel({ bot_token: 'T', chat_id: 'C', fetchImpl });
  await ch.isReady();
  const err = await ch.send(ch, { kind: 'k', severity: 'warn', title: 't', body: 'b', ts: 1 }).then(() => null).catch((e) => e);
  assert.ok(err);
  assert.match(err.message, /HTTP 502/);
});

test('telegram channel: getMe returning ok:false → isReady=false', async () => {
  /** @type {typeof globalThis.fetch} */
  // eslint-disable-next-line require-await
  const fetchImpl = async () => new Response('{"ok":false,"description":"bot not found"}', { status: 401 });
  const ch = createTelegramChannel({ bot_token: 'wrong', chat_id: 'c', fetchImpl });
  assert.equal(await ch.isReady(), false);
});

test('telegram channel: timeout aborts the request (timer path)', async () => {
  /** @type {typeof globalThis.fetch} */
  // eslint-disable-next-line require-await
  const fetchImpl = async (url, init) => {
    // Honor the abort signal so the test returns deterministically.
    if (init && init.signal) {
      return await new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    return new Response('{"ok":false}', { status: 500 });
  };
  const ch = createTelegramChannel({ bot_token: 'T', chat_id: 'C', fetchImpl, timeout_ms: 10 });
  // isReady → getMe throws (aborted) → returns false
  const ready = await ch.isReady();
  assert.equal(ready, false);
});

// ─────────────────────────────────────────────────────────────────────
//  index.mjs — createConfiguredAlertRouter
// ─────────────────────────────────────────────────────────────────────

test('createConfiguredAlertRouter: when alerts.enabled=false, dispatched events hit noop only', async () => {
  const cfg = { alerts: { enabled: false, channels: ['console', 'telegram'] }, telegram: { bot_token: 'X' } };
  const router = createConfiguredAlertRouter(cfg);
  const r = await router.dispatch({
    kind: 'breaker_trip',
    severity: 'warn',
    title: 't',
    body: 'b',
  });
  assert.equal(r.dispatched, 1);
  // The single channel is the noop-disabled.
  assert.equal(router.listChannels()[0].id, 'noop-disabled');
});

test('createConfiguredAlertRouter: when alerts.enabled=true + channels=console, wires the console channel', async () => {
  const lines = [];
  const sink = { write: (l) => { lines.push(l); return true; } };
  const cfg = {
    alerts: { enabled: true, channels: ['console'], console_min_severity: 'info' },
  };
  const router = createConfiguredAlertRouter(cfg, { deps: { sink } });
  const r = await router.dispatch({
    kind: 'breaker_trip',
    severity: 'warn',
    title: 't',
    body: 'b',
  });
  assert.equal(r.dispatched, 1);
  assert.equal(lines.length, 1);
});

test('createConfiguredAlertRouter: unknown channel ids are silently skipped', async () => {
  const cfg = { alerts: { enabled: true, channels: ['console', 'telegram', 'made-up-channel'] }, telegram: { bot_token: null } };
  const router = createConfiguredAlertRouter(cfg);
  const ids = router.listChannels().map((c) => c.id);
  // `console` + `telegram` are wired; the unknown id is dropped.
  assert.deepEqual(ids.sort(), ['console', 'telegram']);
});

// ─────────────────────────────────────────────────────────────────────
//  alerts-recent.mjs — pure helpers
// ─────────────────────────────────────────────────────────────────────

test('parseAlertsFilters: defaults to 24h window, no severity/kind, full cap', () => {
  const f = parseAlertsFilters(new URLSearchParams(''));
  assert.equal(f.range, '24h');
  assert.equal(f.sinceMs !== null && f.sinceMs > 0, true);
  assert.equal(f.severity, null);
  assert.equal(f.kind, null);
  assert.equal(f.limit, DEFAULT_ALERTS_MAX);
});

test('parseAlertsFilters: range + severity + kind + limit honored', () => {
  const qs = new URLSearchParams('range=7d&severity=warn&kind=breaker_trip&limit=15');
  const f = parseAlertsFilters(qs, { default_max: 100 });
  assert.equal(f.range, '7d');
  assert.equal(f.severity, 'warn');
  assert.equal(f.kind, 'breaker_trip');
  assert.equal(f.limit, 15);
});

test('rangeToAlertsMs: maps unit suffixes', () => {
  assert.equal(rangeToAlertsMs('30s'), 30 * 1000);
  assert.equal(rangeToAlertsMs('5m'), 5 * 60 * 1000);
  assert.equal(rangeToAlertsMs('2h'), 2 * 60 * 60 * 1000);
  assert.equal(rangeToAlertsMs('1d'), 24 * 60 * 60 * 1000);
  assert.equal(rangeToAlertsMs('1w'), 7 * 24 * 60 * 60 * 1000);
  assert.equal(rangeToAlertsMs('all'), null);
  assert.equal(rangeToAlertsMs('junk'), null);
});

test('parseAlertsLimit: clamps to max + coerces bad input to max', () => {
  assert.equal(parseAlertsLimit(new URLSearchParams(''), 50), 50);
  assert.equal(parseAlertsLimit(new URLSearchParams('limit=10'), 50), 10);
  assert.equal(parseAlertsLimit(new URLSearchParams('limit=999'), 50), 50);
  assert.equal(parseAlertsLimit(new URLSearchParams('limit=-3'), 50), 50);
  assert.equal(parseAlertsLimit(new URLSearchParams('limit=banana'), 50), 50);
});

test('filterAlertsEvents: drops below-range + non-matching severity + non-matching kind + enforces limit', () => {
  const now = Date.now();
  const events = [
    { ts: now, severity: 'warn', kind: 'breaker_trip', title: 'a' },
    { ts: now - 60 * 60 * 1000, severity: 'warn', kind: 'breaker_trip', title: 'old' },
    { ts: now - 1000, severity: 'info', kind: 'breaker_trip', title: 'b' },
    { ts: now - 1000, severity: 'warn', kind: 'wallet_floor', title: 'c' },
    { ts: now - 1000, severity: 'warn', kind: 'breaker_trip', title: 'd' },
  ];
  const f = { sinceMs: 30 * 60 * 1000, severity: 'warn', kind: 'breaker_trip', limit: 1, range: '30m' };
  const out = filterAlertsEvents(events, f);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'a');
});

test('filterAlertsEvents: invalid ts entries are dropped when range is set', () => {
  const now = Date.now();
  const events = [
    { ts: 'not-a-date', severity: 'warn', kind: 'breaker_trip', title: 'a' },
    { ts: now, severity: 'warn', kind: 'breaker_trip', title: 'b' },
  ];
  const f = { sinceMs: 60_000, severity: null, kind: null, limit: 10, range: '1m' };
  const out = filterAlertsEvents(events, f);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'b');
});

test('buildAlertsRecentResponse: envelope shape mirrors /api/trade-history', () => {
  const url = new URL('http://localhost/api/alerts/recent?range=24h');
  const events = [{ ts: 1, severity: 'warn', kind: 'breaker_trip', title: 't' }];
  const filters = { sinceMs: 1000, severity: null, kind: null, limit: 100, range: '24h' };
  const env = buildAlertsRecentResponse(url, events, filters, { total_count: events.length });
  assert.equal(env.schema, 'tradebot.dashboard.alerts-recent/v1');
  assert.equal(env.range, '24h');
  assert.equal(env.severity, null);
  assert.equal(env.kind, null);
  assert.equal(env.limit, 100);
  assert.equal(env.count, 1);
  assert.equal(env.total_count, 1);
});

test('DEFAULT_ALERTS_FILE + DEFAULT_ALERTS_MAX sanity', () => {
  assert.equal(DEFAULT_ALERTS_FILE, 'data/alerts.jsonl');
  assert.equal(DEFAULT_ALERTS_MAX, 200);
});

// ─────────────────────────────────────────────────────────────────────
//  getDefaultAlertRouter singleton lifecycle
// ─────────────────────────────────────────────────────────────────────

test('getDefaultAlertRouter: returns the same instance on repeat call; _reset clears it', () => {
  _resetDefaultAlertRouter();
  const a = getDefaultAlertRouter();
  const b = getDefaultAlertRouter();
  assert.equal(a, b);
  _resetDefaultAlertRouter();
  const c = getDefaultAlertRouter();
  assert.notEqual(a, c);
});

// ─────────────────────────────────────────────────────────────────────
//  Smoke integration — the full pipeline writes NDJSON + filter pipeline
// ─────────────────────────────────────────────────────────────────────

test('integration: console channel + filterAlertsEvents end-to-end', async () => {
  const lines = [];
  const sink = { write: (l) => { lines.push(l); return true; } };
  const ch = createConsoleChannel({ sink });
  const router = createAlertRouter({
    channels: [ch],
    // Use the actual wall clock so the dispatched event's ts is
    // within the filter's `sinceMs` window when the test runs.
    nowMs: () => Date.now(),
    dedup_window_ms: 1,
  });
  await router.dispatch({ kind: 'breaker_trip', severity: 'error', title: 'cooldown hit', body: 'x', context: { token_id: 'abc' } });
  // Re-hydrate each NDJSON line as if it were written to disk +
  // read back by the filter pipeline.
  const events = lines.map((l) => JSON.parse(l.trim()));
  const out = filterAlertsEvents(events, { sinceMs: 60_000, severity: null, kind: null, limit: 100, range: '1m' });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'breaker_trip');
});
