#!/usr/bin/env node
// src/portfolio/positions.mjs
//
// Open / closed / closing position store for TradeBot.
//
// One file on disk (`positions.json` at the repo root by default)
// holds the bot's view of every position it ever opened. Reads are
// cheap; writes are atomic so a SIGKILL mid-write can't leave the
// file half-written. The shape mirrors `docs/ARCHITECTURE.md §5.1`
// and is consumed by:
//
//   - `pnl.mjs`         — realized + unrealized P&L
//   - `snapshots.mjs`   — periodic balance + position snapshots
//   - `trader/loop.mjs` — opens new positions on a successful entry,
//                         closes them on a successful exit, and
//                         promotes pending → open on confirmation
//   - `dashboard/*`     — PORTFOLIO view (live read of the file)
//
// Design rules (also see docs/ARCHITECTURE.md §2.3):
//
//   1. **All writes are atomic.** We write to `<file>.tmp` and
//      `rename` it into place. A SIGKILL between `open(2)` and
//      `write(2)` would normally truncate the live file; the
//      tmpfile pattern avoids that entirely. This is the ONLY
//      safe pattern for a long-running bot that could be killed
//      at any moment.
//
//   2. **No `console.log`.** All log lines go through `util/logger`.
//      Logs are emitted on every CRUD call so the audit trail
//      (one NDJSON line per state change) lines up with
//      `history.jsonl` (which the trader loop appends on the
//      on-chain confirmation).
//
//   3. **Pure helpers stay pure.** `deriveStatus()`, `computeOpenExposure()`,
//      `*Id()` ID generators, etc. take no I/O and are exported
//      so the test suite can exercise them directly.
//
//   4. **`positions.json` is the source of truth.** No in-memory
//      cache is held; every read re-loads the file. With the
//      file size we're talking about (KB-range) this is fine and
//      eliminates the cache-staleness / restart-rebuild risk.
//
//   5. **No hard-coded knobs.** Position IDs use a monotonic
//      counter seeded from `Date.now()` (collision-free across
//      rapid restarts since the counter is bumped on every load
//      if the existing high-water mark is older than now).
//
//   6. **Mutators return the new state** (or a typed `Result` on
//      failure). Callers never have to re-read the file to learn
//      the post-write state.
//
// Origin: original code for TradeBot. ARCHITECTURE.md §3 places
// this module on the impure layer (it touches disk) but it imports
// the pure helpers from `data/types.mjs` and `util/atomic-write.mjs`.

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  atomicWriteJson,
  readJsonFile,
  ensureDirForFile,
} from '../util/atomic-write.mjs';
import { normalizeTokenId, SATS_PER_BCH } from '../data/types.mjs';
import { createLogger } from '../util/logger.mjs';

// ─────────────────────────────────────────────────────────────────────
//  Errors
// ─────────────────────────────────────────────────────────────────────

/**
 * Base class for every error `positions.mjs` raises. Callers should
 * match on `instanceof PositionsError` to distinguish portfolio-side
 * failures from local bugs (TypeError, ENOENT, etc.).
 */
export class PositionsError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'PositionsError';
    if (opts.kind) this.kind = opts.kind;
    if (opts.cause) this.cause = opts.cause;
  }
}

/** Input shape / config problem (programmer error — fail fast). */
export class PositionsConfigError extends PositionsError {
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = 'PositionsConfigError';
  }
}

/** Position not found / lookup miss. */
export class PositionsNotFoundError extends PositionsError {
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = 'PositionsNotFoundError';
  }
}

/** State conflict (e.g. closing a position that's already closed). */
export class PositionsStateError extends PositionsError {
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = 'PositionsStateError';
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Defaults + shape
// ─────────────────────────────────────────────────────────────────────

/**
 * Default file location. `/data/` is gitignored (see `.gitignore`
 * line `/data/positions.json`). The constructor accepts an
 * override for tests + for users who want to point the bot at a
 * USB stick / second disk.
 */
export const DEFAULT_POSITIONS_FILE = 'data/positions.json';

/** Initial empty-state schema. Written on first read if the file is missing. */
export const POSITIONS_VERSION = 1;

/**
 * @typedef {Object} PositionEntry
 * @property {string}  id             ULID-ish, monotonic via `_newPositionId()`
 * @property {string}  token_id       64-char lowercase hex
 * @property {string}  [token_symbol] resolved from BCMR at open time
 * @property {string}  [token_decimals]
 * @property {'long_token'} side      v1: only "long_token" (BCH → token)
 * @property {Object}  entry          fill details (see ARCHITECTURE.md §5.1)
 * @property {Object}  [exit]         fill details when closed
 * @property {bigint}  [high_water_mark_sats_per_token] for trailing stop
 * @property {Object}  reasoning      stamped at open (audit trail)
 * @property {string}  opened_at      ISO timestamp
 * @property {string}  [closed_at]    ISO timestamp
 * @property {string}  [updated_at]   ISO timestamp (status flips etc.)
 * @property {'pending'|'open'|'closing'|'closed'} status
 */

/**
 * @typedef {Object} PositionsFile
 * @property {number} version
 * @property {string} updated_at
 * @property {PositionEntry[]} open
 * @property {PositionEntry[]} closed
 * @property {Object} [meta]      counters, schema version, etc.
 */

// ─────────────────────────────────────────────────────────────────────
//  Pure helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Coerce an input into a valid `PositionEntry.status`. Throws on
 * unknown values so the file never accumulates typo'd rows.
 *
 * @param {unknown} s
 * @returns {'pending'|'open'|'closing'|'closed'}
 */
export function normalizeStatus(s) {
  if (s === 'pending' || s === 'open' || s === 'closing' || s === 'closed') return s;
  throw new PositionsConfigError(`normalizeStatus: unknown status ${JSON.stringify(s)}`);
}

/**
 * Sum the BCH exposure of a list of positions. Pending + open +
 * closing all count toward exposure — only `closed` is excluded.
 * Pure — exported for use by `risk/limits.mjs` and `pnl.mjs`.
 *
 * Reads `entry.bch_spent_sats` first, falling back to
 * `entry.bch_spent` (legacy alias). Tolerates bigint / number /
 * string; missing or malformed values are skipped.
 *
 * @param {PositionEntry[]} positions
 * @returns {number} BCH (sats converted via SATS_PER_BCH); 0 for empty list
 */
export function computeOpenExposureBch(positions) {
  if (!Array.isArray(positions)) return 0;
  let sats = 0n;
  for (const p of positions) {
    if (!p || typeof p !== 'object') continue;
    if (p.status === 'closed') continue;
    const spent = p?.entry?.bch_spent_sats ?? p?.entry?.bch_spent;
    if (typeof spent === 'number' && Number.isFinite(spent)) {
      sats += BigInt(Math.round(spent));
    } else if (typeof spent === 'bigint') {
      sats += spent;
    } else if (typeof spent === 'string' && spent.length > 0) {
      try { sats += BigInt(spent); } catch { /* ignore malformed */ }
    }
  }
  return Number(sats) / SATS_PER_BCH;
}

/**
 * Sum the open exposure grouped by token_id. Useful for the
 * dashboard's "this token currently has N open positions" view
 * and for the risk module's per-token exposure cap.
 *
 * @param {PositionEntry[]} positions
 * @returns {Record<string, number>} token_id → BCH exposure
 */
export function computeExposureByToken(positions) {
  /** @type {Record<string, number>} */
  const out = {};
  if (!Array.isArray(positions)) return out;
  for (const p of positions) {
    if (!p || typeof p !== 'object') continue;
    if (p.status === 'closed') continue;
    if (typeof p.token_id !== 'string') continue;
    const spent = p?.entry?.bch_spent_sats ?? p?.entry?.bch_spent;
    let sats = 0n;
    if (typeof spent === 'number' && Number.isFinite(spent)) sats = BigInt(Math.round(spent));
    else if (typeof spent === 'bigint') sats = spent;
    else if (typeof spent === 'string' && spent.length > 0) {
      try { sats = BigInt(spent); } catch { continue; }
    } else continue;
    const cur = out[p.token_id] ?? 0;
    out[p.token_id] = cur + (Number(sats) / SATS_PER_BCH);
  }
  return out;
}

/**
 * Make a sortable, time-ordered ID. Format:
 *
 *   pos_<base36-seconds-since-epoch><base36-ms>_XXXX
 *
 * The counter is per-millisecond so a hot loop creating many IDs
 * in the same millisecond won't collide. The `pos_` prefix sorts
 * before any other id kind in audit logs.
 *
 * Module-level state (`_moduleCounter`) backs the per-millisecond
 * counter so back-to-back calls always produce unique IDs even if
 * the caller forgets to thread the `nextCounter` return value. The
 * explicit `counter` argument is treated as a *seed* — the actual
 * counter used is `max(counter, _moduleCounter)`, so callers can't
 * accidentally roll the counter backwards. Pass `counter` only on
 * the first call (e.g. when seeding from `maxCounterFromIds()`).
 *
 * @param {Object} [opts]
 * @param {number} [opts.nowMs=Date.now()]
 * @param {number} [opts.counter]  seed the counter; the actual value used is `max(counter, _moduleCounter)`
 * @returns {{ id: string, nextCounter: number }}
 */
let _moduleCounter = 0;
export function newPositionId(opts = {}) {
  // Validate `nowMs` strictly. We don't silently fall back to
  // Date.now() on bad input — that hides programmer bugs.
  let nowMs;
  if (opts.nowMs !== undefined) {
    if (typeof opts.nowMs !== 'number' || !Number.isFinite(opts.nowMs) || opts.nowMs < 0) {
      throw new PositionsConfigError(`newPositionId: invalid nowMs ${JSON.stringify(opts.nowMs)}`);
    }
    nowMs = Math.floor(opts.nowMs);
  } else {
    nowMs = Date.now();
  }
  // Validate `counter` strictly.
  let seedCounter = null;
  if (opts.counter !== undefined && opts.counter !== null) {
    if (!Number.isInteger(opts.counter) || opts.counter < 0) {
      throw new PositionsConfigError(`newPositionId: invalid counter ${JSON.stringify(opts.counter)}`);
    }
    seedCounter = opts.counter;
  }
  // Resolve the actual counter: max(seed, _moduleCounter). This
  // means callers can re-seed safely without breaking the
  // monotonic property.
  const counter = seedCounter !== null ? Math.max(seedCounter, _moduleCounter) : _moduleCounter;
  _moduleCounter = counter + 1;

  const secs = Math.floor(nowMs / 1000);
  const ms = nowMs % 1000;
  const id = 'pos_' + secs.toString(36) + ms.toString(36).padStart(2, '0') + '_' + counter.toString(16).padStart(4, '0');
  return { id, nextCounter: counter + 1 };
}

/**
 * Test seam: reset the module-level counter. Used by the test
 * suite to make each test deterministic.
 *
 * @param {number} [n=0]
 */
export function _resetModuleCounter(n = 0) {
  _moduleCounter = n;
}

/**
 * Find the highest counter suffix observed in a set of existing
 * position IDs, so a freshly-restarted bot doesn't collide with
 * the previous run's IDs. Returns `0` if no IDs are found.
 *
 * Accepts both canonical IDs (`pos_<base36>_<hex>`) and the older
 * hand-rolled seed format (`pos_<any>XXXX`) by extracting the last
 * 4 hex chars before the end-of-string. This keeps the seed
 * fixture in the test suite stable.
 *
 * @param {PositionEntry[]|undefined|null} positions
 * @returns {number}
 */
export function maxCounterFromIds(positions) {
  if (!Array.isArray(positions)) return 0;
  let max = 0;
  // Match the canonical "pos_<base36>_<4-hex>" form first.
  const canonical = /^pos_[0-9a-z]+_([0-9a-f]{4})$/;
  // Fallback: any id ending with 4 hex chars.
  const trailingHex = /([0-9a-f]{4})$/;
  for (const p of positions) {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string') continue;
    let m = canonical.exec(p.id);
    if (!m) m = trailingHex.exec(p.id);
    if (!m) continue;
    const n = parseInt(m[1], 16);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

/**
 * Lightweight shape check for a `PositionEntry`. We deliberately
 * don't validate every nested field — the trader loop writes the
 * canonical shape, and we trust its output. The shape check is
 * only here to catch hand-edited / corrupted files.
 *
 * @param {unknown} obj
 * @returns {boolean}
 */
export function isValidPosition(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const p = /** @type {Record<string, unknown>} */ (obj);
  if (typeof p.id !== 'string' || p.id.length === 0) return false;
  if (typeof p.token_id !== 'string' || p.token_id.length === 0) return false;
  if (p.status !== 'pending' && p.status !== 'open' && p.status !== 'closing' && p.status !== 'closed') return false;
  if (!p.entry || typeof p.entry !== 'object') return false;
  if (typeof p.opened_at !== 'string' || p.opened_at.length === 0) return false;
  return true;
}

/**
 * Drop a position from the `open` bucket into the `closed` bucket
 * with the supplied exit fields. Pure — used internally by the
 * `Positions.close()` method.
 *
 * Returns a NEW file-shaped object; never mutates `file` in place.
 *
 * @param {PositionsFile} file
 * @param {string} positionId
 * @param {Object} exit         { txid, price_sats_per_token, bch_received_sats, fee_sats, ts, reason }
 * @param {number} realizedPnlSats   signed sat delta (BCH out minus BCH in)
 * @returns {PositionsFile}
 */
export function applyClose(file, positionId, exit, realizedPnlSats) {
  if (!file || typeof file !== 'object') throw new PositionsConfigError('applyClose: file required');
  if (!Array.isArray(file.open)) throw new PositionsConfigError('applyClose: file.open missing');
  if (!Array.isArray(file.closed)) file.closed = [];
  const idx = file.open.findIndex((p) => p && p.id === positionId);
  if (idx === -1) throw new PositionsNotFoundError(`applyClose: position ${positionId} not in open[]`);
  const now = new Date().toISOString();
  const closed = {
    ...file.open[idx],
    status: 'closed',
    exit: {
      ...exit,
      realized_pnl_sats: realizedPnlSats,
    },
    closed_at: now,
    updated_at: now,
  };
  const newOpen = file.open.slice();
  newOpen.splice(idx, 1);
  return {
    ...file,
    version: POSITIONS_VERSION,
    updated_at: now,
    open: newOpen,
    closed: [...file.closed, closed],
    meta: { ...(file.meta ?? {}), total_closed: (file.meta?.total_closed ?? 0) + 1 },
  };
}

/**
 * Move a `pending` position to `open` (we got confirmation). Pure.
 *
 * Refuses to re-open a `closed` position — that would silently
 * re-write the audit trail. Throws `PositionsStateError` on
 * status conflicts, `PositionsNotFoundError` when the id isn't
 * in either bucket.
 *
 * @param {PositionsFile} file
 * @param {string} positionId
 * @returns {PositionsFile}
 */
export function applyConfirm(file, positionId) {
  if (!file || typeof file !== 'object') throw new PositionsConfigError('applyConfirm: file required');
  if (!Array.isArray(file.open)) throw new PositionsConfigError('applyConfirm: file.open missing');
  if (!Array.isArray(file.closed)) file.closed = [];
  const openIdx = file.open.findIndex((p) => p && p.id === positionId);
  if (openIdx === -1) {
    // Distinguish "closed, can't reopen" from "never existed".
    const closedIdx = file.closed.findIndex((p) => p && p.id === positionId);
    if (closedIdx !== -1) {
      throw new PositionsStateError(`applyConfirm: cannot confirm a closed position (${positionId})`);
    }
    throw new PositionsNotFoundError(`applyConfirm: position ${positionId} not in open[] or closed[]`);
  }
  const cur = file.open[openIdx];
  if (cur.status === 'open') return file; // idempotent
  if (cur.status !== 'pending') {
    throw new PositionsStateError(`applyConfirm: cannot confirm a ${cur.status} position (${positionId})`);
  }
  const now = new Date().toISOString();
  const updated = { ...cur, status: 'open', updated_at: now };
  const newOpen = file.open.slice();
  newOpen[openIdx] = updated;
  return { ...file, updated_at: now, open: newOpen };
}

/**
 * Move an `open` position to `closing` (we kicked off the exit tx
 * but it hasn't confirmed yet). Pure.
 *
 * @param {PositionsFile} file
 * @param {string} positionId
 * @returns {PositionsFile}
 */
export function applyStartClosing(file, positionId) {
  if (!file || typeof file !== 'object') throw new PositionsConfigError('applyStartClosing: file required');
  if (!Array.isArray(file.open)) throw new PositionsConfigError('applyStartClosing: file.open missing');
  const idx = file.open.findIndex((p) => p && p.id === positionId);
  if (idx === -1) throw new PositionsNotFoundError(`applyStartClosing: position ${positionId} not in open[]`);
  const cur = file.open[idx];
  if (cur.status === 'closing') return file; // idempotent
  if (cur.status !== 'open') {
    throw new PositionsStateError(`applyStartClosing: cannot start closing a ${cur.status} position (${positionId})`);
  }
  const now = new Date().toISOString();
  const updated = { ...cur, status: 'closing', updated_at: now };
  const newOpen = file.open.slice();
  newOpen[idx] = updated;
  return { ...file, updated_at: now, open: newOpen };
}

/**
 * Remove a `pending` / `open` / `closing` position from `open[]`
 * WITHOUT moving it to `closed[]`. Pure — used internally by
 * `Positions.delete()`.
 *
 * Refuses to touch `closed` positions: those represent real
 * on-chain exits and removing them would silently rewrite the
 * audit trail. For those, `applyClose()` is the right tool.
 *
 * Throws `PositionsNotFoundError` when the id is missing from
 * either bucket, `PositionsStateError` when the id lives in
 * `closed[]` (refuses to delete completed positions).
 *
 * Bumps `meta.total_deleted` so operators can grep the audit
 * trail for the counter and notice any unusual spikes.
 *
 * @param {PositionsFile} file
 * @param {string} positionId
 * @returns {PositionsFile}
 */
export function applyDelete(file, positionId) {
  if (!file || typeof file !== 'object') throw new PositionsConfigError('applyDelete: file required');
  if (!Array.isArray(file.open)) throw new PositionsConfigError('applyDelete: file.open missing');
  if (!Array.isArray(file.closed)) file.closed = [];
  const idx = file.open.findIndex((p) => p && p.id === positionId);
  if (idx === -1) {
    const closedIdx = file.closed.findIndex((p) => p && p.id === positionId);
    if (closedIdx !== -1) {
      throw new PositionsStateError(`applyDelete: cannot delete a closed position (${positionId}); use applyClose for audit-trail moves`);
    }
    throw new PositionsNotFoundError(`applyDelete: position ${positionId} not in open[] or closed[]`);
  }
  const now = new Date().toISOString();
  const newOpen = file.open.slice();
  newOpen.splice(idx, 1);
  return {
    ...file,
    version: POSITIONS_VERSION,
    updated_at: now,
    open: newOpen,
    meta: {
      ...(file.meta ?? {}),
      total_deleted: (file.meta?.total_deleted ?? 0) + 1,
    },
  };
}

/**
 * idea_operator_position-prevent-stop-loss-with-profit-target_20260917:
 * apply operator-set exit overrides (`prevent_stop_loss` +
 * `profit_target_pct`) to an open position. Pure — the caller
 * (the `Positions` class's `updateOverrides` method) writes the
 * returned file atomically. Updates an open position only; closed
 * positions are immutable (the override would be meaningless after
 * the position has already exited).
 *
 * Input contract:
 *   - `prevent_stop_loss`: boolean (required, NOT null/undefined).
 *     `false` clears the override entirely (`profit_target_pct` is
 *     also dropped — they travel together).
 *   - `profit_target_pct`: number ≥ 0, or `null` (cleared). Treated
 *     as a percent (e.g. 10 means "≥10% unrealized profit"). The
 *     validation range is [0, 10000] — anything above 10000% is
 *     obviously a typo and rejected. The exit decision converts
 *     this to a fraction via /100.
 *
 * If the override values are unchanged from the current state,
 * the file is returned with only `updated_at` bumped (idempotent).
 *
 * @param {PositionsFile} file
 * @param {string} positionId
 * @param {{ prevent_stop_loss: boolean, profit_target_pct: number|null }} overrides
 * @returns {PositionsFile}
 */
export function applyOverrides(file, positionId, overrides) {
  if (!file || typeof file !== 'object') throw new PositionsConfigError('applyOverrides: file required');
  if (!Array.isArray(file.open)) throw new PositionsConfigError('applyOverrides: file.open missing');
  if (!overrides || typeof overrides !== 'object') {
    throw new PositionsConfigError('applyOverrides: overrides required');
  }
  if (typeof overrides.prevent_stop_loss !== 'boolean') {
    throw new PositionsConfigError(
      `applyOverrides: prevent_stop_loss must be a boolean (got ${typeof overrides.prevent_stop_loss})`,
    );
  }
  const pct = overrides.profit_target_pct;
  if (overrides.prevent_stop_loss) {
    // When the toggle is on, profit_target_pct must be a finite
    // number in [0, 10000]. null/undefined means "default to 5%"
    // (a sane fallback so a freshly-toggled-on position doesn't
    // accidentally block forever).
    let resolvedPct = pct;
    if (resolvedPct === null || resolvedPct === undefined) {
      resolvedPct = 5;
    }
    if (typeof resolvedPct !== 'number' || !Number.isFinite(resolvedPct) || resolvedPct < 0 || resolvedPct > 10000) {
      throw new PositionsConfigError(
        `applyOverrides: profit_target_pct must be a finite number in [0, 10000] when prevent_stop_loss is true (got ${pct})`,
      );
    }
  } else if (pct !== null && pct !== undefined) {
    // Toggle is off but a percent was supplied — accept the value
    // as metadata (the operator may be pre-staging for a future
    // toggle-on) but require it to be valid.
    if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 10000) {
      throw new PositionsConfigError(
        `applyOverrides: profit_target_pct must be a finite number in [0, 10000] or null (got ${pct})`,
      );
    }
  }

  const idx = file.open.findIndex((p) => p && p.id === positionId);
  if (idx === -1) {
    // Check closed[] to give an actionable error.
    const inClosed = Array.isArray(file.closed) && file.closed.some((p) => p && p.id === positionId);
    if (inClosed) {
      throw new PositionsStateError(
        `applyOverrides: cannot set overrides on a closed position (${positionId}); close-time overrides are not meaningful`,
      );
    }
    throw new PositionsNotFoundError(`applyOverrides: position ${positionId} not in open[]`);
  }
  const cur = file.open[idx];
  const now = new Date().toISOString();

  // Build the override object to write.
  let nextOverride;
  if (overrides.prevent_stop_loss) {
    nextOverride = {
      prevent_stop_loss: true,
      profit_target_pct: (pct === null || pct === undefined) ? 5 : pct,
      set_at: now,
      set_by: overrides.set_by ?? null,
    };
  } else {
    // Toggle off: explicitly clear (rather than leave stale) so
    // the dashboard doesn't show a leftover % profit when the
    // toggle is off.
    nextOverride = {
      prevent_stop_loss: false,
      profit_target_pct: (pct === null || pct === undefined) ? null : pct,
      cleared_at: now,
      cleared_by: overrides.set_by ?? null,
    };
  }

  // Idempotency: if the existing override matches the new one
  // AND set_by is the same, don't bump updated_at — keep the
  // audit trail clean (no noise on dashboard refreshes).
  const prev = cur.exit_overrides ?? null;
  const isUnchanged =
    prev !== null
    && prev.prevent_stop_loss === nextOverride.prevent_stop_loss
    && (prev.profit_target_pct ?? null) === (nextOverride.profit_target_pct ?? null);
  if (isUnchanged) {
    return file;
  }

  const updated = { ...cur, exit_overrides: nextOverride, updated_at: now };
  const newOpen = file.open.slice();
  newOpen[idx] = updated;
  return {
    ...file,
    version: POSITIONS_VERSION,
    updated_at: now,
    open: newOpen,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Positions class
// ─────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} PositionsOpts
 * @property {string} [file=DEFAULT_POSITIONS_FILE]
 * @property {Object} [logger]         structured logger (default: stderr)
 * @property {Function} [fs]            fs/promises — test seam
 * @property {Function} [now]           () => Date — test seam
 */

/**
 * Stateful wrapper around `positions.json`. Every mutator reads the
 * current file, applies the change via a pure helper, then atomically
 * writes the new state. The class holds no cache.
 *
 * Construction is cheap (no I/O); the first `load()` (or any mutator)
 * reads the file.
 */
export class Positions {
  /**
   * @param {PositionsOpts} [opts]
   */
  constructor(opts = {}) {
    this.file = opts.file ?? DEFAULT_POSITIONS_FILE;
    this.logger = opts.logger ?? createLogger({ sink: process.stderr });
    /** @private */
    this._fs = opts.fs ?? fsp;
    /** @private */
    this._now = opts.now ?? (() => new Date());
    /** @private — counter state, bumped on every `open()`. */
    this._counter = 0;
    /** @private — set true after the first successful read. */
    this._loaded = false;
  }

  /**
   * Read `positions.json` and parse it. Creates an empty file if
   * one doesn't exist. NEVER overwrites an existing file's contents
   * just because it's empty.
   *
   * @returns {Promise<PositionsFile>}
   */
  async load() {
    await ensureDirForFile(this.file, this._fs);
    /** @type {PositionsFile} */
    let file;
    try {
      file = await readJsonFile(this.file, this._fs);
    } catch (e) {
      if (e && typeof e === 'object' && /** @type {any} */ (e).code === 'ENOENT') {
        file = {
          version: POSITIONS_VERSION,
          updated_at: new Date().toISOString(),
          open: [],
          closed: [],
          meta: { total_opened: 0, total_closed: 0, created_at: new Date().toISOString() },
        };
        await atomicWriteJson(this.file, file, this._fs);
      } else {
        throw e;
      }
    }
    // Defensive: fill missing buckets.
    if (!Array.isArray(file.open)) file.open = [];
    if (!Array.isArray(file.closed)) file.closed = [];
    if (!file.meta) file.meta = {};
    if (typeof file.version !== 'number') file.version = POSITIONS_VERSION;

    // Never downgrade the in-memory counter: `max()` ensures we
    // don't roll backwards if the on-disk file is older than the
    // instance (e.g. a fast restart where another Positions instance
    // already wrote a higher counter via _withFile). BOTH counters
    // (per-instance + module-level) get bumped because `newPositionId`
    // resolves `max(seed, _moduleCounter)` — a stale `_moduleCounter`
    // would let a fresh instance reuse an ID from a long-gone run.
    const fromDisk = maxCounterFromIds([...file.open, ...file.closed]) + 1;
    this._counter = Math.max(this._counter, fromDisk);
    _moduleCounter = Math.max(_moduleCounter, fromDisk);
    this._loaded = true;
    return file;
  }

  /**
   * @private — wrap the read-modify-write cycle.
   * @param {(file: PositionsFile) => PositionsFile} mutator
   * @returns {Promise<PositionsFile>}
   */
  async _withFile(mutator) {
    const file = this._loaded ? await this.load() : await this.load();
    const next = mutator(file);
    await atomicWriteJson(this.file, next, this._fs);
    this._loaded = true;
    return next;
  }

  /**
   * List all positions in a given status bucket. Returns a SHALLOW
   * copy so callers can't mutate the on-disk state.
   *
   * For `bucket === 'open'`, only strictly-open positions are
   * returned; `pending` and `closing` live alongside `open` in the
   * file (per schema §5.1) and are filtered to their own buckets.
   *
   * @param {'open'|'closed'|'pending'|'closing'|'all'} [bucket='open']
   * @returns {Promise<PositionEntry[]>}
   */
  async list(bucket = 'open') {
    const file = await this.load();
    if (bucket === 'all') {
      return [...file.open, ...file.closed].map((p) => ({ ...p }));
    }
    if (bucket === 'pending' || bucket === 'closing') {
      return file.open
        .filter((p) => p && normalizeStatus(p.status) === bucket)
        .map((p) => ({ ...p }));
    }
    if (bucket === 'open') {
      // Strict: only `status === 'open'` — pending + closing are
      // filtered out (caller must use list('pending' | 'closing')).
      return file.open
        .filter((p) => p && p.status === 'open')
        .map((p) => ({ ...p }));
    }
    if (bucket === 'closed') return file.closed.map((p) => ({ ...p }));
    // Unknown bucket — treat as 0-length list rather than throwing,
    // so a dashboard typo can't kill the API.
    return [];
  }

  /**
   * Find a single position by id. Searches both `open` and `closed`
   * so callers can ask "what happened to this position?" regardless
   * of its current state.
   *
   * @param {string} id
   * @returns {Promise<PositionEntry|null>}
   */
  async findById(id) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new PositionsConfigError(`Positions.findById: id required`);
    }
    const file = await this.load();
    const all = [...file.open, ...file.closed];
    const hit = all.find((p) => p && p.id === id);
    return hit ? { ...hit } : null;
  }

  /**
   * Open a new position. Returns the persisted entry. The shape
   * of `entry` matches ARCHITECTURE.md §5.1: `{ txid, price_sats_per_token,
   * bch_spent_sats, token_amount_base, fee_sats, broadcast_ms, ts }`.
   *
   * @param {Object} args
   * @param {string} args.tokenId
   * @param {string} [args.tokenSymbol]
   * @param {number|string} [args.tokenDecimals]
   * @param {Object}  args.entry
   * @param {Object}  args.reasoning        ranker output snapshot
   * @param {string}  [args.initialStatus]   'pending' (default) or 'open'
   * @returns {Promise<PositionEntry>}
   */
  async open(args) {
    if (!args || typeof args !== 'object') {
      throw new PositionsConfigError(`Positions.open: args required`);
    }
    const tokenId = normalizeTokenId(args.tokenId);
    if (!args.entry || typeof args.entry !== 'object') {
      throw new PositionsConfigError(`Positions.open: entry required`);
    }
    // Entry must carry the two fields we cannot recover later:
    //   - txid              — the on-chain proof of fill
    //   - bch_spent_sats    — drives position sizing + P&L
    // Anything else can be back-filled from the indexer. Missing
    // either of these two is a programmer bug — fail loudly instead
    // of silently writing a row that breaks every downstream read.
    if (typeof args.entry.txid !== 'string' || args.entry.txid.length === 0) {
      throw new PositionsConfigError(`Positions.open: entry.txid (string) required`);
    }
    if (typeof args.entry.bch_spent_sats !== 'number'
        || !Number.isFinite(args.entry.bch_spent_sats)
        || args.entry.bch_spent_sats < 0) {
      throw new PositionsConfigError(`Positions.open: entry.bch_spent_sats (non-negative finite number) required`);
    }
    if (!args.reasoning || typeof args.reasoning !== 'object') {
      throw new PositionsConfigError(`Positions.open: reasoning required`);
    }
    const initialStatus = args.initialStatus ?? 'pending';
    normalizeStatus(initialStatus); // throws on bad input
    if (initialStatus !== 'pending' && initialStatus !== 'open') {
      throw new PositionsConfigError(`Positions.open: initialStatus must be 'pending' or 'open'; got ${initialStatus}`);
    }

    const { id, nextCounter } = newPositionId({
      nowMs: this._now().getTime(),
      counter: this._counter,
    });
    this._counter = nextCounter;

    /** @type {PositionEntry} */
    const position = {
      id,
      token_id: tokenId,
      token_symbol: args.tokenSymbol ?? null,
      token_decimals: args.tokenDecimals ?? null,
      side: 'long_token',
      entry: { ...args.entry },
      reasoning: { ...args.reasoning },
      opened_at: this._now().toISOString(),
      updated_at: this._now().toISOString(),
      status: initialStatus,
    };

    const file = await this._withFile((f) => {
      /** @type {PositionsFile} */
      const next = {
        ...f,
        version: POSITIONS_VERSION,
        updated_at: position.opened_at,
        open: [...f.open, position],
        meta: { ...(f.meta ?? {}), total_opened: (f.meta?.total_opened ?? 0) + 1 },
      };
      return next;
    });

    this.logger.info('positions.open', {
      position_id: position.id,
      token_id: position.token_id,
      token_symbol: position.token_symbol,
      side: position.side,
      status: position.status,
      txid: position.entry?.txid ?? null,
      bch_spent: position.entry?.bch_spent_sats ?? null,
      token_amount_base: position.entry?.token_amount_base ?? null,
      price_sats_per_token: position.entry?.price_sats_per_token ?? null,
      fee_sats: position.entry?.fee_sats ?? null,
      score: position.reasoning?.score ?? null,
      rank: position.reasoning?.rank ?? null,
      open_count: file.open.length,
      ts: position.opened_at,
    });
    return { ...position };
  }

  /**
   * Mark a pending position as confirmed. Idempotent.
   *
   * @param {string} positionId
   * @returns {Promise<PositionEntry>}
   */
  async confirm(positionId) {
    if (typeof positionId !== 'string' || positionId.length === 0) {
      throw new PositionsConfigError(`Positions.confirm: positionId required`);
    }
    const file = await this._withFile((f) => applyConfirm(f, positionId));
    const updated = file.open.find((p) => p && p.id === positionId);
    if (!updated) {
      throw new PositionsNotFoundError(`Positions.confirm: position ${positionId} not in open[]`);
    }
    this.logger.info('positions.confirm', {
      position_id: positionId,
      token_id: updated.token_id,
      status: updated.status,
      ts: new Date().toISOString(),
    });
    return { ...updated };
  }

  /**
   * Mark an open position as `closing` (we kicked off the exit
   * swap). Idempotent.
   *
   * @param {string} positionId
   * @returns {Promise<PositionEntry>}
   */
  async startClosing(positionId) {
    if (typeof positionId !== 'string' || positionId.length === 0) {
      throw new PositionsConfigError(`Positions.startClosing: positionId required`);
    }
    const file = await this._withFile((f) => applyStartClosing(f, positionId));
    const updated = file.open.find((p) => p && p.id === positionId);
    if (!updated) {
      throw new PositionsNotFoundError(`Positions.startClosing: position ${positionId} not in open[]`);
    }
    this.logger.info('positions.start_closing', {
      position_id: positionId,
      token_id: updated.token_id,
      status: updated.status,
      ts: new Date().toISOString(),
    });
    return { ...updated };
  }

  /**
   * Update the trailing-stop high-water-mark for an open position.
   * Pure write — never downgrades a previous HWM.
   *
   * @param {string} positionId
   * @param {bigint|number|string} hwmSats  per-token sats
   * @returns {Promise<PositionEntry>}
   */
  async updateHighWaterMark(positionId, hwmSats) {
    if (typeof positionId !== 'string' || positionId.length === 0) {
      throw new PositionsConfigError(`Positions.updateHighWaterMark: positionId required`);
    }
    let newHwm;
    if (typeof hwmSats === 'bigint') newHwm = hwmSats;
    else if (typeof hwmSats === 'number' && Number.isFinite(hwmSats)) newHwm = BigInt(Math.round(hwmSats));
    else if (typeof hwmSats === 'string' && hwmSats.length > 0) {
      try { newHwm = BigInt(hwmSats); } catch {
        throw new PositionsConfigError(`Positions.updateHighWaterMark: hwmSats not bigint-coercible (${hwmSats})`);
      }
    } else {
      throw new PositionsConfigError(`Positions.updateHighWaterMark: hwmSats must be bigint/number/string; got ${typeof hwmSats}`);
    }

    const file = await this._withFile((f) => {
      if (!Array.isArray(f.open)) throw new PositionsConfigError('Positions.updateHighWaterMark: file.open missing');
      const idx = f.open.findIndex((p) => p && p.id === positionId);
      if (idx === -1) throw new PositionsNotFoundError(`Positions.updateHighWaterMark: position ${positionId} not in open[]`);
      const cur = f.open[idx];
      const prevHwm = cur.high_water_mark_sats_per_token != null
        ? BigInt(cur.high_water_mark_sats_per_token)
        : 0n;
      // Never downgrade.
      const finalHwm = prevHwm > newHwm ? prevHwm : newHwm;
      const now = new Date().toISOString();
      const updated = { ...cur, high_water_mark_sats_per_token: finalHwm.toString(), updated_at: now };
      const newOpen = f.open.slice();
      newOpen[idx] = updated;
      return { ...f, updated_at: now, open: newOpen };
    });
    const updated = file.open.find((p) => p && p.id === positionId);
    if (!updated) {
      throw new PositionsNotFoundError(`Positions.updateHighWaterMark: position ${positionId} disappeared after write`);
    }
    this.logger.info('positions.hwm_update', {
      position_id: positionId,
      token_id: updated.token_id,
      hwm_sats_per_token: updated.high_water_mark_sats_per_token,
      ts: new Date().toISOString(),
    });
    return { ...updated };
  }

  /**
   * idea_operator_position-prevent-stop-loss-with-profit-target_20260917:
   * apply operator-set exit overrides (`prevent_stop_loss` +
   * `profit_target_pct`) to an open position. Mutates
   * `positions.json` atomically (same _withFile pattern as the
   * other write paths) and returns the post-write position record
   * so callers can echo the new state back to the dashboard
   * without a re-read.
   *
   * Idempotent — repeated writes with the same override values
   * are no-ops (no updated_at bump) so dashboard refreshes
   * don't flood the audit log.
   *
   * Closed positions are rejected (PositionsStateError) — the
   * override would be meaningless after the position has
   * already exited, and writing would silently rewrite the
   * audit trail.
   *
   * @param {string} positionId
   * @param {{ prevent_stop_loss: boolean, profit_target_pct: number|null, set_by?: string|null }} overrides
   * @returns {Promise<PositionEntry>}
   */
  async updateOverrides(positionId, overrides) {
    if (typeof positionId !== 'string' || positionId.length === 0) {
      throw new PositionsConfigError(`Positions.updateOverrides: positionId required`);
    }
    const file = await this._withFile((f) => applyOverrides(f, positionId, overrides));
    const updated = file.open.find((p) => p && p.id === positionId);
    if (!updated) {
      throw new PositionsNotFoundError(`Positions.updateOverrides: position ${positionId} disappeared after write`);
    }
    // Log the change (only when something actually changed —
    // applyOverrides returns the same file when the values are
    // unchanged, so we can compare updated_at to detect).
    if (file.updated_at && file.updated_at !== (file.open.find((p) => p && p.id === positionId)?.updated_at ?? null)) {
      this.logger.info('positions.override_update', {
        position_id: positionId,
        token_id: updated.token_id,
        exit_overrides: updated.exit_overrides ?? null,
        ts: file.updated_at,
      });
    }
    return { ...updated };
  }

  /**
   * T43: stamp the profit-floor extension timestamp on an open
   * position's entry block. The exit strategy reads
   * `entry.time_stop_extended_at` (ms since epoch) and uses
   * `max(baseCutoff, extended_at)` as the new time-stop cutoff.
   * Single-shot — `evaluateProfitFloor` returns null once this
   * field is non-null, so subsequent ticks close on the next
   * time-stop fire regardless of the projected P&L.
   *
   * Stored alongside the entry so the field travels with the
   * position record (no separate state file to keep in sync).
   * Defends against bad inputs: requires finite positive ms,
   * throws on missing position, refuses to downgrade an existing
   * extension.
   *
   * @param {string} positionId
   * @param {number} cutoffMs   new cutoff (ms since epoch) — must be > existing
   * @returns {Promise<Object>} the updated position
   */
  async setTimeStopExtension(positionId, cutoffMs) {
    if (typeof positionId !== 'string' || positionId.length === 0) {
      throw new PositionsConfigError(`Positions.setTimeStopExtension: positionId required`);
    }
    if (typeof cutoffMs !== 'number' || !Number.isFinite(cutoffMs) || cutoffMs <= 0) {
      throw new PositionsConfigError(`Positions.setTimeStopExtension: cutoffMs must be a positive finite number; got ${cutoffMs}`);
    }
    const file = await this._withFile((f) => {
      if (!Array.isArray(f.open)) throw new PositionsConfigError('Positions.setTimeStopExtension: file.open missing');
      const idx = f.open.findIndex((p) => p && p.id === positionId);
      if (idx === -1) throw new PositionsNotFoundError(`Positions.setTimeStopExtension: position ${positionId} not in open[]`);
      const cur = f.open[idx];
      const entry = (cur && typeof cur.entry === 'object' && cur.entry !== null) ? cur.entry : {};
      const prevExtendedMs = (() => {
        const raw = entry.time_stop_extended_at;
        if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
        if (typeof raw === 'string' && raw.length > 0) {
          const parsed = Date.parse(raw);
          return Number.isFinite(parsed) ? parsed : null;
        }
        return null;
      })();
      // Refuse to downgrade — the exit strategy only ever sees the
      // latest stamp, so rewriting it earlier would be a bug.
      if (prevExtendedMs !== null && cutoffMs < prevExtendedMs) {
        return f;  // no-op; caller still gets the original
      }
      const updatedEntry = Object.freeze({ ...entry, time_stop_extended_at: cutoffMs });
      const updatedPos = Object.freeze({ ...cur, entry: updatedEntry });
      const newOpen = f.open.slice();
      newOpen[idx] = updatedPos;
      const now = new Date().toISOString();
      return Object.freeze({ ...f, updated_at: now, open: newOpen });
    });
    const updated = file.open.find((p) => p && p.id === positionId);
    if (!updated) {
      throw new PositionsNotFoundError(`Positions.setTimeStopExtension: position ${positionId} disappeared after write`);
    }
    if (typeof updated.entry?.time_stop_extended_at === 'number') {
      this.logger.info('positions.time_stop_extension', {
        position_id: positionId,
        token_id: updated.token_id,
        time_stop_extended_at: updated.entry.time_stop_extended_at,
        ts: new Date().toISOString(),
      });
    }
    return { ...updated };
  }

  /**
   * Move a position from `open` to `closed`. The `exit` block is
   * merged into the position record before it moves; realized P&L
   * is computed in `pnl.mjs` and passed in here.
   *
   * @param {string} positionId
   * @param {Object} exit            { txid, price_sats_per_token, bch_received_sats, fee_sats, ts, reason }
   * @param {number} realizedPnlSats signed sat delta
   * @returns {Promise<PositionEntry>}
   */
  async close(positionId, exit, realizedPnlSats) {
    if (typeof positionId !== 'string' || positionId.length === 0) {
      throw new PositionsConfigError(`Positions.close: positionId required`);
    }
    if (!exit || typeof exit !== 'object') {
      throw new PositionsConfigError(`Positions.close: exit required`);
    }
    if (typeof realizedPnlSats !== 'number' || !Number.isFinite(realizedPnlSats)) {
      throw new PositionsConfigError(`Positions.close: realizedPnlSats must be a finite number; got ${realizedPnlSats}`);
    }
    const file = await this._withFile((f) => applyClose(f, positionId, exit, Math.round(realizedPnlSats)));
    const closed = file.closed[file.closed.length - 1];
    if (!closed) {
      throw new PositionsNotFoundError(`Positions.close: position ${positionId} missing after write`);
    }
    this.logger.info('positions.close', {
      position_id: positionId,
      token_id: closed.token_id,
      side: closed.side,
      exit_txid: closed.exit?.txid ?? null,
      exit_reason: closed.exit?.reason ?? null,
      bch_received: closed.exit?.bch_received_sats ?? null,
      realized_pnl_sats: closed.exit?.realized_pnl_sats ?? null,
      realized_pnl_bch: (closed.exit?.realized_pnl_sats ?? 0) / SATS_PER_BCH,
      open_count: file.open.length,
      closed_count: file.closed.length,
      ts: closed.closed_at,
    });
    return { ...closed };
  }

  /**
   * Remove a `pending` / `open` / `closing` position record from
   * `open[]` WITHOUT moving it to `closed[]`. Use case: the entry
   * never actually landed on chain (a pre-flight slippage refusal
   * that recorded an entry block in the bug window but never
   * broadcast a tx), so there's nothing real to close — only a
   * stuck local record the bot keeps retrying against.
   *
   * Refuses to delete `closed` positions: those represent real
   * on-chain exits and removing them would silently rewrite the
   * audit trail. For those, `Positions.close()` is the right tool
   * (which appends an exit block + history event).
   *
   * The caller is expected to append a `kind:'manual_delete'`
   * history event separately — this method doesn't fabricate one
   * because the deletion reason lives in the operator's CLI
   * invocation, not the bot's strategy layer.
   *
   * @param {string} positionId
   * @param {string} [reason]   operator note — surfaced in the logger event
   * @returns {Promise<{ removed: PositionEntry, file: PositionsFile }>}
   */
  async delete(positionId, reason = 'operator_manual_delete') {
    if (typeof positionId !== 'string' || positionId.length === 0) {
      throw new PositionsConfigError(`Positions.delete: positionId required`);
    }
    let removed = null;
    const file = await this._withFile((f) => {
      // Pre-mutation read so we can return the removed row in
      // the response. The pure helper throws on not-found /
      // closed-only; we re-throw unchanged.
      const idx = f.open.findIndex((p) => p && p.id === positionId);
      if (idx === -1) {
        // Mirror applyDelete's ordering: check closed first so a
        // closed-only position surfaces as a state error rather
        // than a not-found error.
        const closedIdx = f.closed.findIndex((p) => p && p.id === positionId);
        if (closedIdx !== -1) {
          throw new PositionsStateError(`Positions.delete: cannot delete a closed position (${positionId}); use Positions.close for audit-trail moves`);
        }
        throw new PositionsNotFoundError(`Positions.delete: position ${positionId} not in open[] or closed[]`);
      }
      removed = { ...f.open[idx] };
      return applyDelete(f, positionId);
    });
    this.logger.info('positions.delete', {
      position_id: positionId,
      token_id: removed?.token_id ?? null,
      side: removed?.side ?? null,
      reason,
      open_count: file.open.length,
      closed_count: file.closed.length,
      meta_total_deleted: file.meta?.total_deleted ?? null,
      ts: new Date().toISOString(),
    });
    return { removed, file };
  }
}

/**
 * Export the on-disk schema constants + helpers used by the test
 * suite. Internal `_withFile` / `_fs` are deliberately not exported.
 */
export const _internals = {
  applyClose,
  applyConfirm,
  applyStartClosing,
  applyDelete,
  isValidPosition,
  maxCounterFromIds,
  normalizeStatus,
};
