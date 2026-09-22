#!/usr/bin/env node
// src/util/atomic-write.mjs
//
// Crash-safe file I/O for TradeBot state.
//
// The bot persists three artifacts (`positions.json`, `history.jsonl`,
// `snapshots.jsonl`) and is killable at any moment — OOM-killer,
// SIGTERM, power loss, restart. A normal `fs.writeFile()` truncates
// the destination BEFORE writing the new content, which means a
// SIGKILL between `truncate` and `write` leaves the user with an
// empty file. The bot would then refuse to boot (we treat a corrupt
// file as a fatal startup error to avoid making trades against a
// hallucinated history).
//
// The fix is the standard POSIX write-tmp-then-rename pattern:
//
//     write to `<file>.tmp`
//     fsync the tmpfile
//     rename `<file>.tmp` -> `<file>`  (atomic on the same filesystem)
//
// `rename` is atomic on POSIX — at any instant, the destination is
// either the old content or the new content, never a half-written
// hybrid. After the rename, the kernel guarantees the file is on
// disk before `rename(2)` returns (on `fs.rename` in Node — same
// guarantee).
//
// Design rules (also see docs/ARCHITECTURE.md §2.3):
//
//   1. JSON mode: `atomicWriteJson` serializes with `JSON.stringify`
//      and a trailing newline (so the file is friendly to `jq` /
//      `cat` for debugging). Writes a `.tmp` first, then renames.
//
//   2. NDJSON mode: `atomicAppendNdjson` appends a single
//      pre-serialized JSON line to a `.jsonl` file WITHOUT
//      rewriting the whole file. Append-mode is itself atomic on
//      POSIX for writes <= `PIPE_BUF` (4096 bytes on Linux).
//      Every TradeBot audit line is small (<1 KB), so this is the
//      safe + fast path. For larger appends, we fall back to
//      write-tmp + rename.
//
//   3. `readJsonFile` returns the parsed JSON, throws a typed
//      `AtomicReadError` on bad input. Callers (positions.mjs,
//      snapshots.mjs, dashboard server) catch + handle.
//
//   4. `ensureDirForFile` creates the parent dir if missing. We
//      don't crash on EEXIST. Test fixtures use this to set up
//      throw-away tmp dirs.
//
//   5. All functions take an injectable `fs` (defaults to
//      `node:fs/promises`) for testability — no monkey-patching
//      `fs` from the test suite.
//
// Origin: original code for TradeBot. The write-tmp+rename
// pattern is universal but the implementation here matches
// ARCHITECTURE.md §2.3 (atomic writes for `data/positions.json`).

import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { randomBytes } from 'node:crypto';

// ─────────────────────────────────────────────────────────────────────
//  Errors
// ─────────────────────────────────────────────────────────────────────

/**
 * Base class for every error this module raises. Callers should
 * match on `instanceof AtomicWriteError` to distinguish I/O-side
 * failures from programmer errors (TypeError on bad input, etc.).
 */
export class AtomicWriteError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'AtomicWriteError';
    if (opts.path) this.path = opts.path;
    if (opts.cause) this.cause = opts.cause;
  }
}

/** `readJsonFile` could not parse / validate the file's contents. */
export class AtomicReadError extends AtomicWriteError {
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = 'AtomicReadError';
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Pure helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Sanitize a JSON value for atomic-write. Rejects non-JSON-safe
 * primitives (BigInt is not JSON-serializable; circular refs throw
 * synchronously from `JSON.stringify`). The caller is expected to
 * have already coerced / normalized its data; this is a defense
 * in depth.
 *
 * Pure — exported so the test suite can exercise the policy.
 *
 * @param {unknown} value
 * @returns {string} serialized JSON
 */
export function safeStringify(value) {
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
  }, 2);
  if (typeof out !== 'string') {
    throw new AtomicWriteError('safeStringify: JSON.stringify returned non-string');
  }
  return out + '\n';
}

/**
 * Compute the tmpfile name for a given destination. `<file>.tmp`
 * keeps the rename atomic and keeps debug output (`ls data/`)
 * tidy.
 *
 * Pure — exported so the test suite can pin the convention.
 *
 * NOTE: this is the *deterministic* helper used by external callers
 * that want to know exactly where the tmpfile will land. The
 * internal `atomicWriteJson` / `atomicAppendNdjson` paths use a
 * unique-suffixed variant (`uniqueTmpFileName`) to avoid races when
 * multiple writers hit the same destination concurrently — a single
 * shared `<file>.tmp` would let writer B truncate A's content before
 * A's `rename`, causing A's rename to ENOENT.
 *
 * @param {string} file
 * @returns {string}
 */
export function tmpFileName(file) {
  if (typeof file !== 'string' || file.length === 0) {
    throw new AtomicWriteError(`tmpFileName: file must be a non-empty string; got ${JSON.stringify(file)}`);
  }
  return file + '.tmp';
}

/**
 * Compute a process-unique tmpfile name. Suffix is an 8-hex-char
 * random tag drawn from `crypto.randomBytes` — collisions are
 * statistically impossible for any realistic bot workload, but
 * even a collision is benign: only one writer can hold the rename
 * to `<file>` at a time, and the loser's tmpfile gets cleaned up.
 *
 * Used internally by `atomicWriteJson` / `atomicAppendNdjson` to
 * serialize concurrent writes without forcing the callers to
 * coordinate.
 *
 * Pure-ish — only I/O is the random-bytes call, which is
 * effectively free.
 *
 * @param {string} file
 * @returns {string}
 */
export function uniqueTmpFileName(file) {
  const base = tmpFileName(file);
  const tag = randomBytes(4).toString('hex');
  return `${base}.${tag}`;
}

// ─────────────────────────────────────────────────────────────────────
//  Mutators
// ─────────────────────────────────────────────────────────────────────

/**
 * Make sure the parent directory of `file` exists. Idempotent.
 * Wraps `fs.mkdir({ recursive: true })` and swallows EEXIST.
 *
 * @param {string} file
 * @param {typeof fsp} [fs=fsp]
 * @returns {Promise<string>} the directory path that was ensured
 */
export async function ensureDirForFile(file, fs = fsp) {
  if (typeof file !== 'string' || file.length === 0) {
    throw new AtomicWriteError(`ensureDirForFile: file must be a non-empty string; got ${JSON.stringify(file)}`);
  }
  const dir = path.dirname(path.resolve(file));
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (e) {
    if (!e || /** @type {any} */ (e).code !== 'EEXIST') throw e;
  }
  return dir;
}

/**
 * Atomically write `value` (JSON-serialized) to `file`. Writes to
 * `<file>.tmp`, then renames. On error, attempts to clean up the
 * tmpfile but does NOT swallow the error.
 *
 * @param {string} file
 * @param {unknown} value
 * @param {typeof fsp} [fs=fsp]
 * @returns {Promise<void>}
 */
export async function atomicWriteJson(file, value, fs = fsp) {
  if (typeof file !== 'string' || file.length === 0) {
    throw new AtomicWriteError(`atomicWriteJson: file must be a non-empty string; got ${JSON.stringify(file)}`);
  }
  await ensureDirForFile(file, fs);
  const tmp = uniqueTmpFileName(file);
  let bytes;
  try {
    const body = safeStringify(value);
    bytes = Buffer.from(body, 'utf8');
  } catch (e) {
    throw new AtomicWriteError(
      `atomicWriteJson: failed to serialize ${file}: ${e?.message ?? e}`,
      { path: file, cause: e },
    );
  }
  // Write tmp + best-effort fsync + rename. We swallow ENOENT on the
  // unlink (tmpfile may not exist if write failed before open).
  try {
    const fh = await fs.open(tmp, 'w', 0o600);
    try {
      await fh.writeFile(bytes);
      // fsync so the bytes are on disk before rename. Without this,
      // a power loss between rename and disk flush could surface an
      // empty file on next boot.
      try { await fh.sync(); } catch { /* fsync unavailable on some FS — ignore */ }
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, file);
  } catch (e) {
    // Best-effort cleanup. Don't shadow the original error.
    try { await fs.unlink(tmp); } catch { /* ignore */ }
    throw new AtomicWriteError(
      `atomicWriteJson: failed to write ${file}: ${e?.message ?? e}`,
      { path: file, cause: e },
    );
  }
}

/**
 * Append a single NDJSON line to `file`. Uses `O_APPEND` so the
 * kernel guarantees atomic writes for sizes <= PIPE_BUF (4096
 * bytes on Linux). Larger payloads fall back to write-tmp +
 * rename via `atomicWriteJson` (we rewrite the whole file —
 * acceptable for the bot's small history file).
 *
 * The caller is responsible for serializing `line` to a JSON
 * string (we don't re-serialize — it lets the caller pre-format
 * timestamps, bigints as strings, etc., before we touch disk).
 *
 * @param {string} file
 * @param {string} line     pre-serialized JSON object (must NOT include a trailing newline)
 * @param {typeof fsp} [fs=fsp]
 * @returns {Promise<void>}
 */
export async function atomicAppendNdjson(file, line, fs = fsp) {
  if (typeof file !== 'string' || file.length === 0) {
    throw new AtomicWriteError(`atomicAppendNdjson: file must be a non-empty string; got ${JSON.stringify(file)}`);
  }
  if (typeof line !== 'string') {
    throw new AtomicWriteError(`atomicAppendNdjson: line must be a string; got ${typeof line}`);
  }
  if (line.endsWith('\n')) {
    throw new AtomicWriteError(`atomicAppendNdjson: line must not end with newline; got len=${line.length}`);
  }
  await ensureDirForFile(file, fs);

  const PIPE_BUF = 4096;
  const bytes = Buffer.from(line + '\n', 'utf8');

  if (bytes.length <= PIPE_BUF) {
    // Fast path: O_APPEND is atomic for small writes.
    try {
      const fh = await fs.open(file, 'a');
      try {
        await fh.writeFile(bytes);
        try { await fh.sync(); } catch { /* ignore */ }
      } finally {
        await fh.close();
      }
      return;
    } catch (e) {
      // Fall through to slow path on any error (e.g. ENOENT on first run).
      if (!e || /** @type {any} */ (e).code !== 'ENOENT') {
        // Real I/O error — propagate.
        throw new AtomicWriteError(
          `atomicAppendNdjson: append failed for ${file}: ${e?.message ?? e}`,
          { path: file, cause: e },
        );
      }
    }
  }

  // Slow path: read existing content (if any), concat, write-tmp+rename.
  // NOTE: we write raw bytes here (NOT via atomicWriteJson which JSON-stringifies).
  /** @type {string} */
  let existing = '';
  try {
    existing = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (!e || /** @type {any} */ (e).code !== 'ENOENT') throw e;
  }
  const body = existing + line + '\n';
  const bodyBytes = Buffer.from(body, 'utf8');
  const tmp = uniqueTmpFileName(file);
  try {
    const fh = await fs.open(tmp, 'w', 0o600);
    try {
      await fh.writeFile(bodyBytes);
      try { await fh.sync(); } catch { /* ignore */ }
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, file);
  } catch (e) {
    try { await fs.unlink(tmp); } catch { /* ignore */ }
    throw new AtomicWriteError(
      `atomicAppendNdjson: slow-path write failed for ${file}: ${e?.message ?? e}`,
      { path: file, cause: e },
    );
  }
}

/**
 * Read `file` as JSON. Throws `AtomicReadError` on parse failure
 * or ENOENT-with-no-fallback. The caller (`positions.mjs`) handles
 * ENOENT by creating a fresh empty file; this function does NOT
 * do that — it just reports.
 *
 * @param {string} file
 * @param {typeof fsp} [fs=fsp]
 * @returns {Promise<unknown>}
 */
export async function readJsonFile(file, fs = fsp) {
  if (typeof file !== 'string' || file.length === 0) {
    throw new AtomicReadError(`readJsonFile: file must be a non-empty string; got ${JSON.stringify(file)}`);
  }
  let body;
  try {
    body = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e && typeof e === 'object' && /** @type {any} */ (e).code === 'ENOENT') {
      // Re-throw with the same code so callers can branch on it.
      const err = new AtomicReadError(`readJsonFile: ${file} not found`, { path: file, cause: e });
      /** @type {any} */ (err).code = 'ENOENT';
      throw err;
    }
    throw new AtomicReadError(
      `readJsonFile: failed to read ${file}: ${e?.message ?? e}`,
      { path: file, cause: e },
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new AtomicReadError(
      `readJsonFile: ${file} contains invalid JSON: ${e?.message ?? e}`,
      { path: file, cause: e },
    );
  }
  return parsed;
}

/**
 * Read a `.jsonl` file as an array of parsed JSON objects. Empty
 * lines are skipped silently. Lines that fail to parse are
 * returned in `errors` so the caller (snapshots.mjs, dashboard)
 * can surface "history.jsonl is corrupt at line N".
 *
 * Pure-ish — only I/O is the file read.
 *
 * @param {string} file
 * @param {Object} [opts]
 * @param {typeof fsp} [opts.fs=fsp]
 * @param {number} [opts.maxLines=Infinity]  cap to avoid loading huge files
 * @returns {Promise<{ lines: unknown[], errors: Array<{ line: number, error: string }>, total: number }>}
 */
export async function readNdjsonFile(file, opts = {}) {
  const fs = opts.fs ?? fsp;
  const maxLines = opts.maxLines ?? Infinity;
  if (typeof file !== 'string' || file.length === 0) {
    throw new AtomicReadError(`readNdjsonFile: file must be a non-empty string; got ${JSON.stringify(file)}`);
  }
  let body;
  try {
    body = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e && typeof e === 'object' && /** @type {any} */ (e).code === 'ENOENT') {
      const err = new AtomicReadError(`readNdjsonFile: ${file} not found`, { path: file, cause: e });
      /** @type {any} */ (err).code = 'ENOENT';
      throw err;
    }
    throw new AtomicReadError(
      `readNdjsonFile: failed to read ${file}: ${e?.message ?? e}`,
      { path: file, cause: e },
    );
  }
  const lines = body.split('\n');
  /** @type {unknown[]} */
  const out = [];
  /** @type {Array<{ line: number, error: string }>} */
  const errors = [];
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw === '' || raw == null) continue;
    try {
      out.push(JSON.parse(raw));
      total += 1; // only count lines that successfully parsed
    } catch (e) {
      errors.push({ line: i + 1, error: e?.message ?? String(e) });
    }
    if (out.length >= maxLines) break;
  }
  return { lines: out, errors, total };
}

/**
 * Test seam: write `body` directly to `file` without the
 * tmpfile dance. NEVER use this in production code — it's
 * exported only for the test suite to seed fixtures.
 *
 * @param {string} file
 * @param {string} body
 * @param {typeof fsp} [fs=fsp]
 * @returns {Promise<void>}
 */
export async function _unsafeDirectWrite(file, body, fs = fsp) {
  await ensureDirForFile(file, fs);
  await fs.writeFile(file, body, 'utf8');
}

export const _internals = { safeStringify, tmpFileName, uniqueTmpFileName };
