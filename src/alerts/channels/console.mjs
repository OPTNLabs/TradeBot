#!/usr/bin/env node
// src/alerts/channels/console.mjs
//
// T53.1 — console (structured-log) channel adapter.
//
// The default channel: writes every alert as a structured NDJSON
// line to a writable stream (default `process.stdout`). Mirrors the
// `src/util/logger.mjs` shape so an operator running `journalctl`
// or piping through `jq` gets the same alerting events they get
// from every other bot log line.
//
// Why a writable stream (not `console.log`)? The bot's own rule
// (see src/util/logger.mjs §"Rules of the road") is "NEVER
// `console.log` from src/". The console channel honors that by
// accepting an injected sink; production wiring passes
// `process.stdout`, tests pass a captured buffer.

import process from 'node:process';
import { Writable } from 'node:stream';

/**
 * @typedef {import('../router.mjs').AlertChannel} AlertChannel
 * @typedef {import('../router.mjs').AlertEvent} AlertEvent
 * @typedef {import('../router.mjs').AlertSeverity} AlertSeverity
 */

/**
 * Build a console channel that serializes events to `sink` as
 * one JSON object per line. The returned channel is frozen.
 *
 * @param {{sink?: Writable|{write: (s: string) => boolean}, min_severity?: AlertSeverity, id?: string}} [opts]
 * @returns {AlertChannel & {sink: Writable|{write: (s: string) => boolean}, formatEvent: (event: AlertEvent) => string}}
 */
export function createConsoleChannel(opts = {}) {
  const sink = (opts && opts.sink) || process.stdout;
  const min_severity = (opts && typeof opts.min_severity === 'string') ? opts.min_severity : 'info';
  const id = (opts && typeof opts.id === 'string') ? opts.id : 'console';

  /**
   * Format an event for the NDJSON log line. The shape mirrors
   * `src/util/logger.mjs` so `jq 'select(.event=="alerts.received")'`
   * selects for any alert emitted by the bot.
   *
   * @param {AlertEvent} event
   * @returns {string}
   */
  function formatEvent(event) {
    const record = {
      event: 'alerts.received',
      ts: event.ts ?? Date.now(),
      kind: event.kind,
      severity: event.severity,
      title: event.title,
      body: event.body,
      context: event.context ?? null,
      event_id: event.event_id ?? null,
    };
    try {
      return JSON.stringify(record);
    } catch (_e) {
      // Title or body may contain non-serializable values via the
      // `context` field; stringify a stripped-down shape so the
      // log line never throws.
      return JSON.stringify({
        event: 'alerts.received',
        ts: event.ts ?? Date.now(),
        kind: event.kind,
        severity: event.severity,
        title: String(event.title),
        body: String(event.body),
        context: null,
        event_id: event.event_id ?? null,
        format_error: 'context_non_serializable',
      });
    }
  }

  return Object.freeze({
    id,
    displayName: 'Structured log (stdout / journald)',
    min_severity,
    isReady: () => true,
    send: async (_channel, event) => {
      const line = `${formatEvent(event)}\n`;
      // Writable streams return false on backpressure; we ignore
      // it — the router logger will surface true send failures
      // via its own try/catch.
      try {
        sink.write(line);
      } catch (e) {
        throw new Error(`console channel: sink.write threw: ${e && e.message ? e.message : String(e)}`);
      }
    },
    sink,
    formatEvent,
  });
}
