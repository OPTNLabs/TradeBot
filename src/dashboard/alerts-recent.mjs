#!/usr/bin/env node
// src/dashboard/alerts-recent.mjs
//
// T53.1 — `GET /api/alerts/recent` handler.
//
// Returns a structured envelope `{schema, ts, count, total_count, events}`
// describing the alerts the router has emitted recently. The
// source of truth is an in-process ring buffer that the trader
// loop appends to (T53.2 — deferred) — for T53.1 the dashboard
// reads from a JSON-line history file `data/alerts.jsonl`, the
// same atomic-write pattern `data/history.jsonl` uses.
//
// Why a JSONL history file instead of the router's in-memory
// dedupe index? The dashboard MUST survive a bot restart. The
// alerts subsystem can re-bootstrap from the file on cold start;
// the in-memory dedupe index is for runtime suppression only.
//
// Design rules:
//
//   1. **Pure filter pipeline.** `listRecentAlerts(ctx, url)`
//      validates the request, reads the file via the same
//      `createHistoryReader`-style pattern the rest of the
//      dashboard uses, filters by `?range=` + `?severity=` +
//      `?kind=` + `?limit=`, and returns the typed envelope.
//
//   2. **No network, no bot-side state.** The handler reads the
//      alerts log; it never asks the trader loop "what's your
//      current dedupe index". That indirection would require
//      IPC and complicates tests.
//
//   3. **Envelope matches the other GET endpoints.** `{schema:
//      "tradebot.dashboard.alerts-recent/v1", ts, range, since_ms,
//      until_ms, severity, kind, limit, count, total_count,
//      events: [...]}`. Mirrors `/api/trade-history`'s shape.
//
//   4. **Backpressure-safe.** `?limit` is capped at `alerts_max`
//      (default 200) — same pattern as `/api/bugs`.

import process from 'node:process';
import { readNdjsonFile } from '../util/atomic-write.mjs';

/**
 * Default location for the alerts log file. Mirrors the on-disk
 * path the trader loop will append to (T53.2). Ignored in
 * `.gitignore` so operator-only data never lands in git.
 */
export const DEFAULT_ALERTS_FILE = 'data/alerts.jsonl';

/**
 * Default cap for `?limit` on the alerts-recent endpoint. Mirrors
 * `trade_history_max_events` / `bugs_max_events` style defaults
 * across the dashboard.
 */
export const DEFAULT_ALERTS_MAX = 200;

/**
 * @typedef {Object} AlertsRecentContext
 * @property {Object} cfg
 * @property {string} [alertsFile]
 * @property {number} [alertsMax]
 * @property {Object} [fs]
 * @property {() => number} clock
 */

/**
 * @typedef {Object} ParsedAlertsFilters
 * @property {number|null} sinceMs
 * @property {string|null} severity
 * @property {string|null} kind
 * @property {number} limit
 * @property {string|null} range
 */

/**
 * Parse the `?range=...&severity=...&kind=...&limit=...` query
 * string into a typed shape. Mirrors `parseTradeHistoryFilters`
 * (range semantics) + `parseBugsFilters` (severity/kind filters).
 *
 * @param {URLSearchParams} qs
 * @param {{default_range?: string, default_max?: number}} [defaults]
 * @returns {ParsedAlertsFilters}
 */
export function parseAlertsFilters(qs, defaults = {}) {
  const defaultRange = (typeof defaults.default_range === 'string' && defaults.default_range.length > 0) ? defaults.default_range : '24h';
  const defaultMax = (Number.isFinite(defaults.default_max) && defaults.default_max > 0) ? defaults.default_max : DEFAULT_ALERTS_MAX;
  const rangeRaw = qs.get('range');
  const range = (rangeRaw && rangeRaw.length > 0) ? rangeRaw : defaultRange;
  const sinceMs = rangeToAlertsMs(range);
  const severityRaw = qs.get('severity');
  const severity = (severityRaw && severityRaw.length > 0) ? severityRaw.toLowerCase() : null;
  const kindRaw = qs.get('kind');
  const kind = (kindRaw && kindRaw.length > 0) ? kindRaw.toLowerCase() : null;
  const limit = parseAlertsLimit(qs, defaultMax);
  return { sinceMs, severity, kind, limit, range };
}

/**
 * Map an `?range=` string to milliseconds. Same semantics as
 * `rangeToMs` in `server.mjs` — keep them in sync if one grows.
 *
 * @param {string} range
 * @returns {number|null}
 */
export function rangeToAlertsMs(range) {
  if (typeof range !== 'string') return null;
  const m = range.match(/^(\d+)([smhdw])$/);
  if (!m) {
    if (range === 'all' || range === '24h') {
      if (range === 'all') return null;
      // 24h default for backwards compat with the trade-history shape.
      return 24 * 60 * 60 * 1000;
    }
    return null;
  }
  const n = Number(m[1]);
  const unit = m[2];
  const mult = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000, w: 7 * 24 * 60 * 60 * 1000 };
  return n * mult[unit];
}

/**
 * @param {URLSearchParams} qs
 * @param {number} max
 */
export function parseAlertsLimit(qs, max) {
  const raw = qs.get('limit');
  if (raw === null || raw === '') return max;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return max;
  return Math.min(Math.floor(n), max);
}

/**
 * Filter a list of events by the parsed filters. Pure.
 *
 * @param {Array<any>} events
 * @param {ParsedAlertsFilters} filters
 */
export function filterAlertsEvents(events, filters) {
  /** @type {Array<any>} */
  const out = [];
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    if (filters.sinceMs !== null) {
      const ts = typeof e.ts === 'number' ? e.ts : (typeof e.ts === 'string' ? Date.parse(e.ts) : NaN);
      if (!Number.isFinite(ts) || ts < (Date.now() - filters.sinceMs)) continue;
    }
    if (filters.severity !== null && typeof e.severity === 'string' && e.severity.toLowerCase() !== filters.severity) continue;
    if (filters.kind !== null && typeof e.kind === 'string' && e.kind.toLowerCase() !== filters.kind) continue;
    out.push(e);
  }
  out.sort((a, b) => (b?.ts ?? 0) - (a?.ts ?? 0));
  return out.slice(0, filters.limit);
}

/**
 * Build the response envelope for `GET /api/alerts/recent`.
 *
 * @param {URL} url
 * @param {Array<any>} events
 * @param {ParsedAlertsFilters} filters
 * @param {{total_count: number}} meta
 */
export function buildAlertsRecentResponse(url, events, filters, meta) {
  return {
    schema: 'tradebot.dashboard.alerts-recent/v1',
    ts: new Date().toISOString(),
    range: filters.range,
    since_ms: filters.sinceMs,
    until_ms: Date.now(),
    severity: filters.severity,
    kind: filters.kind,
    limit: filters.limit,
    count: events.length,
    total_count: meta && Number.isFinite(meta.total_count) ? meta.total_count : events.length,
    events,
  };
}

/**
 * Core handler. Reads the alerts log, filters by URL params,
 * returns the typed envelope. `ctx` mirrors the rest of the
 * dashboard's hand-rolled pattern.
 *
 * @param {AlertsRecentContext} ctx
 * @param {URL} url
 */
export async function listRecentAlerts(ctx, url) {
  if (ctx === null || typeof ctx !== 'object') throw new TypeError('listRecentAlerts: ctx required');
  const file = (ctx.alertsFile && typeof ctx.alertsFile === 'string') ? ctx.alertsFile : DEFAULT_ALERTS_FILE;
  const max = (typeof ctx.alertsMax === 'number' && ctx.alertsMax > 0) ? ctx.alertsMax : DEFAULT_ALERTS_MAX;
  const fsImpl = ctx.fs || undefined;
  const filters = parseAlertsFilters(url.searchParams, { default_range: '24h', default_max: max });
  /** @type {Array<{ file: string, line: number, error: string }>} */
  let loadErrors = [];
  /** @type {Array<any>} */
  let allEvents = [];
  try {
    const { lines, errors } = await readNdjsonFile(file, { fs: fsImpl });
    allEvents = lines;
    loadErrors = errors;
  } catch (e) {
    if (e && typeof e === 'object' && e.code === 'ENOENT') {
      // File doesn't exist yet — the trader loop hasn't dispatched
      // any alerts (or T53.2 hasn't shipped). Return an empty
      // envelope rather than 5xx — the dashboard renders the
      // empty state cleanly.
      allEvents = [];
      loadErrors = [];
    } else {
      throw e;
    }
  }
  const matched = filterAlertsEvents(allEvents, filters);
  return {
    ...buildAlertsRecentResponse(url, matched, filters, { total_count: matched.length }),
    load_errors: loadErrors,
  };
}
