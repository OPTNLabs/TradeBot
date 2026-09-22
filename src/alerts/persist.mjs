#!/usr/bin/env node
// src/alerts/persist.mjs
//
// T53.2 — Alerts NDJSON writer.
//
// Why this exists
// ────────────────
// The router (`src/alerts/router.mjs`) and the channels
// (`src/alerts/channels/*.mjs`) handle channel routing — they
// decide WHICH channels receive an event, with what dedup + severity
// floors. None of them currently persist the event to disk. That's
// by design: the alerts subsystem should not write a 30MB NDJSON
// file unless the operator opts in (or the trader loop wires the
// default appender explicitly).
//
// But the operator's audit trail requirement is the same as for
// `data/history.jsonl`: every dispatch must be recoverable across a
// bot restart, with the same atomic-write guarantees (no half-written
// lines, no torn writes on SIGKILL). So T53.2 adds an appender
// module that:
//
//   1. Wraps `atomicAppendNdjson` from `src/util/atomic-write.mjs`
//      (same crash-safe write semantics as the rest of the bot).
//
//   2. Serializes the `AlertEvent` via `safeStringify` (BigInt-safe,
//      circular-safe) so every line is a self-contained JSON object
//      the dashboard's `/api/alerts/recent` endpoint can parse
//      without any cross-line context.
//
//   3. NEVER throws on write failure. A disk-full or EROFS must not
//      kill the trader loop or the swap executor. The appender
//      returns `{ok:false, error}` and the caller's `_safeAlertDispatch`
//      helper logs the structured warning.
//
//   4. Is testable in isolation via `opts.deps.append` / `opts.deps.fs`.
//      Tests inject a memory-backed appender so the suite stays
//      deterministic without touching the real `data/alerts.jsonl`.
//
// Design rules (also see src/alerts/router.mjs §"Design rules"):
//
//   - **Pure factory + impure bind.** `appendAlertEvent` is the
//     pure one-shot helper (file path in, serialized line out, write
//     attempt, typed envelope back); `createAlertsAppender` returns
//     a bound function that captures the file path + logger so
//     call sites stay readable (`await alertsLog(event)`).
//
//   - **BigInt-safe serialization.** The router's `event.ts` is
//     always a number (epoch ms); but the caller's `context` may
//     carry `bch_in_or_out` / `sats` as BigInt (the QUALITY BAR
//     rule for entry/exit audit events). `safeStringify` is reused
//     here so BigInts stringify as decimal strings.
//
//   - **Appender is silent on success.** The trader loop calls
//     `dispatch()` thousands of times per tick (one per candidate);
//     a per-line log line would flood the operator's logs. The
//     appender only logs on failure.
//
// Origin: T53.2 (operator-filed via
// `data/feature-ideas.json#idea_seed_structured_alerts`).
// Foundation (T53.1) shipped the router + channels + the
// `GET /api/alerts/recent` endpoint; this module wires the
// NDJSON persistence side.

import process from 'node:process';
import { atomicAppendNdjson } from '../util/atomic-write.mjs';

/**
 * Default location for the alerts log file. Matches
 * `src/dashboard/alerts-recent.mjs#DEFAULT_ALERTS_FILE` so the
 * dashboard reads what the trader loop writes. Ignored in
 * `.gitignore` (the `data/*.jsonl` catch-all covers it).
 */
export const DEFAULT_ALERTS_LOG_FILE = 'data/alerts.jsonl';

/**
 * BigInt-safe JSON serializer (compact, no indent) for NDJSON
 * output. Mirrors `safeStringify` from `src/util/atomic-write.mjs`
 * but WITHOUT the `indent=2` formatting — full-file rewrites want
 * pretty-print for human readability, NDJSON lines want compact so
 * each event is one line (every `readAlertsLog` consumer splits on
 * `\n`).
 *
 * Exported for the test seam (`deps.stringify` override). Treat as
 * private — callers should use `createAlertsAppender` instead.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function safeStringifyCompact(value) {
  const seen = new WeakSet();
  const out = JSON.stringify(value, (_k, v) => {
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'function') return undefined;
    if (typeof v === 'undefined') return undefined;
    if (v && typeof v === 'object') {
      if (seen.has(v)) return '[Circular]';
      seen.add(v);
    }
    return v;
  });
  if (typeof out !== 'string') {
    throw new TypeError('safeStringifyCompact: JSON.stringify returned non-string');
  }
  return out;
}

/**
 * Append one `AlertEvent` to the alerts log as a single NDJSON
 * line. Returns a typed envelope; never throws on write failure.
 *
 * @param {Object} args
 * @param {Object} args.event                  The AlertEvent to persist. Must be a plain object.
 * @param {string} [args.file]                 On-disk path; defaults to `DEFAULT_ALERTS_LOG_FILE`.
 * @param {Object} [args.deps]                 Test seams.
 * @param {Function} [args.deps.append]        Override the underlying append function (defaults to
 *                                             `atomicAppendNdjson`). Useful for tests that want a
 *                                             captured-array appender.
 * @param {Object} [args.deps.fs]              Override `fs/promises` for the underlying append.
 * @param {Function} [args.deps.stringify]     Override serialization (defaults to `safeStringify`).
 * @returns {Promise<{ok: boolean, line?: string, file: string, error?: {message: string, code?: string}, event_id?: string|null}>}
 */
export async function appendAlertEvent({ event, file = DEFAULT_ALERTS_LOG_FILE, deps = {} } = {}) {
  const targetFile = (typeof file === 'string' && file.length > 0) ? file : DEFAULT_ALERTS_LOG_FILE;
  if (!event || typeof event !== 'object') {
    return {
      ok: false,
      file: targetFile,
      error: { message: `appendAlertEvent: event must be a plain object; got ${typeof event}` },
    };
  }
  const stringify = (deps && typeof deps.stringify === 'function') ? deps.stringify : safeStringifyCompact;
  const append = (deps && typeof deps.append === 'function') ? deps.append : atomicAppendNdjson;
  /** @type {string} */
  let line;
  try {
    line = stringify(event);
  } catch (e) {
    return {
      ok: false,
      file: targetFile,
      error: { message: `serialize: ${e?.message ?? String(e)}` },
    };
  }
  if (typeof line !== 'string' || line.length === 0) {
    return {
      ok: false,
      file: targetFile,
      error: { message: 'appendAlertEvent: serialize returned non-string / empty line' },
    };
  }
  // `atomicAppendNdjson` requires no trailing newline. `safeStringify`
  // (via the JSON helper) appends `\n` for human-friendliness on full
  // rewrites — but `atomicAppendNdjson` enforces "no trailing newline"
  // on the input line. Strip trailing newlines defensively so the
  // appender is robust to either helper.
  const trimmed = line.endsWith('\n') ? line.slice(0, -1) : line;
  try {
    await append(targetFile, trimmed, deps.fs ?? undefined);
  } catch (e) {
    return {
      ok: false,
      file: targetFile,
      error: {
        message: `append: ${e?.message ?? String(e)}`,
        code: (e && typeof e === 'object' && typeof /** @type {any} */ (e).code === 'string')
          ? /** @type {any} */ (e).code
          : undefined,
      },
    };
  }
  return {
    ok: true,
    line: trimmed,
    file: targetFile,
    event_id: (event && typeof event === 'object' && typeof event.event_id === 'string') ? event.event_id : null,
  };
}

/**
 * Build a bound appender: `await appender(event)` returns the same
 * typed envelope as `appendAlertEvent`. Mirrors `createHistoryAppender`
 * from `src/trader/loop.mjs` so the call site stays a one-liner.
 *
 * The `logger` argument is OPTIONAL — when present, the appender
 * logs a structured `alerts.persist.failed` warning on every write
 * failure (so the operator's existing log pipeline catches them).
 * When absent, the failure is silently swallowed (the caller's
 * `_safeAlertDispatch` helper is responsible for surfacing it).
 *
 * @param {Object} [opts]
 * @param {string} [opts.file]
 * @param {Object} [opts.logger]
 * @param {Object} [opts.deps]
 * @returns {(event: Object) => Promise<{ok: boolean, line?: string, file: string, error?: Object, event_id?: string|null}>}
 */
export function createAlertsAppender({ file = DEFAULT_ALERTS_LOG_FILE, logger = null, deps = {} } = {}) {
  const targetFile = (typeof file === 'string' && file.length > 0) ? file : DEFAULT_ALERTS_LOG_FILE;
  return async function alertsAppender(event) {
    const result = await appendAlertEvent({ event, file: targetFile, deps });
    if (!result.ok && logger && typeof logger.warn === 'function') {
      logger.warn('alerts.persist.failed', {
        file: result.file,
        error: result.error?.message ?? 'unknown',
        error_code: result.error?.code ?? null,
        event_kind: (event && typeof event === 'object' && typeof event.kind === 'string') ? event.kind : null,
      });
    }
    return result;
  };
}

/**
 * Build a no-op appender for tests + the operator-disabled default.
 * Always returns `{ok:true, line:'', event_id:null}`. Exported as a
 * factory (not a constant) so tests can verify the call signature
 * without relying on identity equality.
 *
 * @returns {(event: Object) => Promise<{ok: boolean, line: string, file: string, event_id: null}>}
 */
export function createNoopAlertsAppender() {
  return async function noopAlertsAppender(_event) {
    return { ok: true, line: '', file: '<noop>', event_id: null };
  };
}

/**
 * Test seam: read the alerts log via `readNdjsonFile` and return
 * the parsed lines. Wrapped here so the trader-loop tests don't
 * have to import from `src/util/atomic-write.mjs` directly.
 *
 * @param {string} [file=DEFAULT_ALERTS_LOG_FILE]
 * @param {typeof import('node:fs/promises')} [fs]
 * @returns {Promise<{lines: Array<Object>, errors: Array<{line: number, error: string}>, total: number}>}
 */
export async function readAlertsLog(file = DEFAULT_ALERTS_LOG_FILE, fs) {
  // Lazy import to keep the cold-start cost of the alerts
  // subsystem minimal when only the appender surface is used.
  const { readNdjsonFile } = await import('../util/atomic-write.mjs');
  return readNdjsonFile(file, { fs: fs ?? undefined });
}

export const _internals = { appendAlertEvent, safeStringifyCompact, DEFAULT_ALERTS_LOG_FILE };
