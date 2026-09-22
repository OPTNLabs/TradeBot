#!/usr/bin/env node
// src/util/logger.mjs
//
// Structured NDJSON logger. One JSON object per line, written to a
// sink (`WritableStream`, default `process.stdout`). No fancy levels,
// no transports, no buffering — the bot is single-process and reads
// its own logs from disk / journald, so simple wins.
//
// Why NDJSON and not pino / winston / bunyan?
//   - Zero deps. `node --test` runs the bot's test suite with the
//     built-in test runner — pulling in pino would mean adding a
//     dependency for ~80 lines of code.
//   - One JSON object per line is the canonical shape that
//     journald, Loki, Vector, and `jq` all grok natively.
//   - Structured events make audit + dashboard work trivial:
//     every entry/exit logs the full trade as one record.
//
// Rules of the road:
//   - NEVER call `console.log` from src/. Always go through this
//     logger (or accept a logger: object via DI).
//   - The logger MUST NOT throw. Bad input falls back to a safe
//     stringification so a buggy caller can never crash the bot.
//   - The logger MUST NOT block. Writes go to `sink.write` — if
//     `sink.write` is slow, the bot's poll loop is not blocked
//     because Node's stdout is non-blocking for normal writes.
//
// Original code for TradeBot — see docs/ARCHITECTURE.md §6 (data
// model: history.jsonl events share the same NDJSON shape).

import process from 'node:process';
import { Writable } from 'node:stream';

/** Numeric severity ordering — higher = more severe. */
export const LEVELS = Object.freeze({
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
});

/** Default minimum level. Anything below is dropped (not logged). */
const DEFAULT_LEVEL = 'info';

/**
 * Coerce an arbitrary value into a JSON-safe shape. Maps are
 * preserved (logged as plain objects); `Error` instances become
 * `{ name, message, stack }`; `bigint` becomes a string; everything
 * else falls through to JSON.stringify with a replacer that walks
 * circular refs.
 *
 * Exported for the test suite.
 *
 * @param {unknown} value
 * @param {WeakSet<object>} [seen]
 * @returns {unknown}
 */
export function toJsonSafe(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return `[Function: ${value.name || 'anonymous'}]`;
  if (typeof value === 'symbol') return value.toString();
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((v) => toJsonSafe(v, seen));
  }
  const out = {};
  for (const k of Object.keys(value)) {
    try {
      out[k] = toJsonSafe(value[k], seen);
    } catch {
      out[k] = '[Unserializable]';
    }
  }
  return out;
}

/**
 * Build a logger. The returned object has `.trace / .debug / .info /
 * .warn / .error / .fatal(msg, fields?)` plus `.child(component)`
 * for scoped sub-loggers, and `.level` / `.setLevel()` for tuning
 * the threshold at runtime.
 *
 * @param {Object} [opts]
 * @param {keyof typeof LEVELS | number} [opts.level='info']
 *   Minimum severity to emit. Anything below is dropped silently.
 * @param {string} [opts.component='app']
 *   Default `component` field on every record. Overridable per-call.
 * @param {NodeJS.WritableStream} [opts.sink=process.stdout]
 *   Where to write the NDJSON lines. Tests inject a memory stream.
 * @param {(line: string) => void} [opts.write]
 *   Alternative to `sink`: a custom serializer. Wins over `sink`.
 * @returns {Logger}
 */
export function createLogger(opts = {}) {
  const levelName = opts.level ?? DEFAULT_LEVEL;
  const levelNum = typeof levelName === 'number' ? levelName : LEVELS[levelName];
  if (!Number.isFinite(levelNum)) {
    throw new TypeError(`createLogger: unknown level "${levelName}"`);
  }

  let sink = opts.sink ?? process.stdout;
  let writeFn = opts.write ?? ((line) => {
    // Default sink write — never throws on a normal Writable. If
    // `sink.write` returns false (backpressure) we don't wait;
    // the bot's poll cadence is forgiving of a few ms of buffering.
    try { sink.write(line); } catch { /* never throw from logger */ }
  });

  /** @typedef {Object} Logger */
  const logger = {
    /** @type {number} */
    get level() { return levelNum_; },
    /**
     * Re-set the minimum severity. Accepts a name or a number.
     * @param {keyof typeof LEVELS | number} v
     */
    setLevel(v) {
      const n = typeof v === 'number' ? v : LEVELS[v];
      if (!Number.isFinite(n)) {
        throw new TypeError(`logger.setLevel: unknown level "${v}"`);
      }
      levelNum_ = n;
    },
    /**
     * Derive a sub-logger with a default `component` field.
     * @param {string} component
     * @returns {Logger}
     */
    child(component) {
      return createLogger({
        level: levelNum_,
        component,
        sink,
        write: writeFn,
      });
    },
    /**
     * Internal emit. Accepts a numeric level or a level name.
     * @param {number|string} lvl
     * @param {string} msg
     * @param {Object} [fields]
     */
    _emit(lvl, msg, fields) {
      const lvlNum = typeof lvl === 'number' ? lvl : LEVELS[lvl];
      if (!Number.isFinite(lvlNum)) return;
      if (lvlNum < levelNum_) return;
      const lvlName = typeof lvl === 'number'
        ? Object.keys(LEVELS).find((k) => LEVELS[k] === lvl) ?? 'info'
        : lvl;
      const record = {
        ts: new Date().toISOString(),
        level: lvlName,
        component: (fields && typeof fields === 'object' && 'component' in fields)
          ? String(fields.component)
          : (opts.component ?? 'app'),
        msg: typeof msg === 'string' ? msg : toJsonSafe(msg),
      };
      if (fields && typeof fields === 'object') {
        for (const k of Object.keys(fields)) {
          if (k === 'component') continue; // already set above
          try {
            record[k] = toJsonSafe(fields[k]);
          } catch {
            record[k] = '[Unserializable]';
          }
        }
      }
      try {
        writeFn(JSON.stringify(record) + '\n');
      } catch {
        // last-ditch: serialize the record with toJsonSafe and try again
        try {
          writeFn(JSON.stringify(toJsonSafe(record)) + '\n');
        } catch { /* swallow — logger must never throw */ }
      }
    },
  };
  let levelNum_ = levelNum;
  // Bind level helpers for ergonomics: log.info(x, y) vs log._emit('info', x, y)
  /** @type {Record<string, (msg: string, fields?: Object) => void>} */
  const helpers = {};
  for (const name of Object.keys(LEVELS)) {
    helpers[name] = (msg, fields) => logger._emit(name, msg, fields);
  }
  Object.assign(logger, helpers);
  return logger;
}

/**
 * Convenience: build a `Writable` that buffers every NDJSON line
 * written to it. Tests use this to assert on logged events without
 * touching `process.stdout`.
 *
 * @returns {{ stream: NodeJS.WritableStream, lines: () => string[], clear: () => void }}
 */
export function createMemorySink() {
  /** @type {string[]} */
  const buf = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buf.push(String(chunk));
      cb();
    },
  });
  return {
    stream,
    lines: () => buf.map((s) => s.replace(/\n$/, '')).filter(Boolean),
    clear: () => { buf.length = 0; },
  };
}
