#!/usr/bin/env node
// src/portfolio/snapshots.mjs
//
// Periodic balance + position snapshots for TradeBot.
//
// ARCHITECTURE.md §5.3 specifies that `data/snapshots.jsonl` is
// an append-only NDJSON file with one line per snapshot:
//
//   { "ts": "...", "bch_balance_sats": ..., "open_position_count": ...,
//     "total_exposure_sats": ..., "unrealized_pnl_sats": ... }
//
// Snapshots are taken at a fixed cadence (`loop.snapshot_interval_seconds`,
// default 300s = 5min). The dashboard's "balance over time" chart
// reads this file directly — no aggregation needed.
//
// Design rules (also see docs/ARCHITECTURE.md §2.3):
//
//   1. **Append-only.** Snapshots are NEVER rewritten. The trader
//      loop calls `record()` once per tick (gated by
//      `maybeRecord()`). The dashboard reads + replays.
//
//   2. **Atomic append.** `atomicAppendNdjson` handles the I/O —
//      small writes (<=4 KB) go through `O_APPEND` (kernel-level
//      atomic) so a SIGKILL mid-append never truncates the file.
//
//   3. **Pure derivation + impure I/O.** `deriveSnapshot({ ... })`
//      takes all the inputs and returns the snapshot record.
//      `Snapshots.record()` does the I/O. Tests exercise `derive`
//      without touching disk.
//
//   4. **Cadence enforcement.** `maybeRecord()` checks
//      `lastSnapshotTs` and only writes when the configured
//      interval has elapsed. The first call always records.
//
//   5. **Rotation / retention** lives in the loop (T14), not here.
//      This module just writes lines; the operator (or the run-bot
//      loop) is responsible for trimming old lines per
//      `loop.history_retention_days`.
//
//   6. **In-memory cache of last timestamp only.** The full
//      snapshot history is on disk; we don't hold it in RAM.
//
// Origin: original code for TradeBot. ARCHITECTURE.md §3 places
// this module on the impure layer (it touches disk) but it imports
// the pure helpers from `util/atomic-write.mjs` and `portfolio/pnl.mjs`.

import { promises as fsp } from 'node:fs';
import process from 'node:process';

import {
  atomicAppendNdjson,
  readNdjsonFile,
  ensureDirForFile,
} from '../util/atomic-write.mjs';
import { SATS_PER_BCH } from '../data/types.mjs';
import {
  computeOpenExposureBch,
} from './positions.mjs';
import {
  unrealizedPnlSats,
  toSats,
} from './pnl.mjs';
import { createLogger } from '../util/logger.mjs';

// ─────────────────────────────────────────────────────────────────────
//  Errors
// ─────────────────────────────────────────────────────────────────────

/**
 * Base class for snapshot errors. Callers should match on
 * `instanceof SnapshotsError`.
 */
export class SnapshotsError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'SnapshotsError';
    if (opts.kind) this.kind = opts.kind;
    if (opts.cause) this.cause = opts.cause;
  }
}

/** Input shape problem (programmer error — fail fast). */
export class SnapshotsConfigError extends SnapshotsError {
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = 'SnapshotsConfigError';
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Defaults + shape
// ─────────────────────────────────────────────────────────────────────

/**
 * Default file location. `/data/` is gitignored (see `.gitignore`
 * line `/data/snapshots/`). Snapshots are split into one file per
 * UTC day so a 365-day retention never loads a single multi-MB
 * file into memory.
 *
 * Convention: `<data>/snapshots/<YYYY-MM-DD>.jsonl`. The bot
 * derives today's filename from `Date.now()` on every write.
 */
export const DEFAULT_SNAPSHOTS_DIR = 'data/snapshots';

/** Snapshot file version. Bump when the on-disk schema changes. */
export const SNAPSHOT_VERSION = 1;

/**
 * @typedef {Object} SnapshotRecord
 * @property {number} v
 * @property {string} ts                  ISO timestamp
 * @property {bigint|number|string} bch_balance_sats
 * @property {number} open_position_count
 * @property {bigint|number|string} total_exposure_sats
 * @property {bigint|number|string|null} unrealized_pnl_sats
 * @property {string} [token_id]          when the snapshot is per-token
 * @property {Object} [meta]              free-form (cadence, source, etc.)
 */

// ─────────────────────────────────────────────────────────────────────
//  Pure helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Compute the file path for a given date's snapshot NDJSON.
 * Format: `<dir>/<YYYY-MM-DD>.jsonl`. Date is taken in UTC so
 * a bot that crosses midnight twice in one run writes to two
 * different files (clean rollover).
 *
 * Pure — exported so the test suite can pin the format.
 *
 * @param {string} dir
 * @param {Date|number|string} [when=new Date()]
 * @returns {string}
 */
export function snapshotFilePath(dir, when = new Date()) {
  if (typeof dir !== 'string' || dir.length === 0) {
    throw new SnapshotsConfigError(`snapshotFilePath: dir must be a non-empty string; got ${JSON.stringify(dir)}`);
  }
  const d = when instanceof Date ? when : new Date(when);
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) {
    throw new SnapshotsConfigError(`snapshotFilePath: invalid date ${when}`);
  }
  const yyyy = d.getUTCFullYear().toString().padStart(4, '0');
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = d.getUTCDate().toString().padStart(2, '0');
  return `${dir.replace(/\/+$/, '')}/${yyyy}-${mm}-${dd}.jsonl`;
}

/**
 * Compute a snapshot record from inputs. Pure — exported so the
 * trader loop + dashboard can re-derive snapshots without going
 * through the I/O path.
 *
 * @param {Object} args
 * @param {bigint|number|string} args.bchBalanceSats
 * @param {Array<Object>} args.openPositions     a list of PositionEntry (positions.mjs)
 * @param {Record<string, bigint|number|null>} [args.marketPricesSats]   token_id → sats/base-unit price
 * @param {bigint|number|null} [args.estExitFeeSats]  fallback exit fee for unrealized P&L
 * @param {number|bigint|null} [args.maxPriceRatioX=null]  T28e: when set, unrealized P&L for positions whose market price is > this×entry price (or < 1/this×entry) returns null. Shared with `shouldExit`.
 * @param {string} [args.tokenId]     scope the snapshot to a single token (optional)
 * @param {Date|number} [args.now=new Date()]
 * @param {string} [args.source='loop']  free-form tag for audit
 * @returns {SnapshotRecord}
 */
export function deriveSnapshot({
  bchBalanceSats,
  openPositions,
  marketPricesSats,
  estExitFeeSats,
  maxPriceRatioX,
  tokenId,
  now,
  source,
}) {
  if (arguments.length === 0 || typeof bchBalanceSats === 'undefined') {
    throw new SnapshotsConfigError('deriveSnapshot: bchBalanceSats required');
  }
  const balance = toSats(bchBalanceSats);
  if (balance === null) {
    throw new SnapshotsConfigError(`deriveSnapshot: bchBalanceSats must be coercible to non-negative sats; got ${bchBalanceSats}`);
  }
  if (!Array.isArray(openPositions)) {
    throw new SnapshotsConfigError('deriveSnapshot: openPositions must be an array');
  }
  const d = now == null ? new Date() : (now instanceof Date ? now : new Date(now));
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) {
    throw new SnapshotsConfigError(`deriveSnapshot: invalid now ${now}`);
  }

  // Filter positions: if tokenId is given, only include that token's
  // positions. Otherwise include all open positions.
  const positions = tokenId
    ? openPositions.filter((p) => p && p.token_id === tokenId)
    : openPositions;

  // Total exposure = sum of bch_spent across open positions, in sats.
  const exposureBch = computeOpenExposureBch(positions);
  const exposureSats = BigInt(Math.round(exposureBch * SATS_PER_BCH));

  // Unrealized P&L: walk every position, look up market price,
  // sum the net unrealized P&L. Null-priced positions count as 0
  // unrealized contribution (we can't value what we can't price).
  // T28e: positions whose market price is >maxPriceRatioX times
  // (or <1/maxPriceRatioX times) the entry price are treated as
  // null-priced, mirroring the `shouldExit` guard so the snapshot
  // doesn't show absurd $20M+ "gains" on bogus-indexer-price
  // positions.
  const ratioOpt = (maxPriceRatioX !== null && maxPriceRatioX !== undefined
    && Number.isFinite(Number(maxPriceRatioX)) && Number(maxPriceRatioX) > 0)
    ? { maxPriceRatioX: Number(maxPriceRatioX) }
    : null;
  let unrealizedTotalSats = 0n;
  let anyPriced = false;
  for (const p of positions) {
    if (!p || typeof p !== 'object') continue;
    if (p.status === 'closed') continue;
    const tid = typeof p.token_id === 'string' ? p.token_id : null;
    if (!tid) continue;
    const price = marketPricesSats ? marketPricesSats[tid] : null;
    if (price == null) continue;
    const pnl = unrealizedPnlSats(p, price, estExitFeeSats ?? null, ratioOpt);
    if (pnl.net === null) continue;
    anyPriced = true;
    unrealizedTotalSats += pnl.net;
  }

  const ts = d.toISOString();
  /** @type {SnapshotRecord} */
  const record = {
    v: SNAPSHOT_VERSION,
    ts,
    bch_balance_sats: balance.toString(),
    open_position_count: positions.filter((p) => p && p.status !== 'closed').length,
    total_exposure_sats: exposureSats.toString(),
    unrealized_pnl_sats: anyPriced ? unrealizedTotalSats.toString() : null,
    meta: { source: source ?? 'loop' },
  };
  if (tokenId) record.token_id = tokenId;

  // 2026-09-20 fixup: persist the per-token market-price index so
  // the dashboard can render current worth at the LIVE AMM price
  // instead of falling back to entry.price_sats_per_token (which
  // shows the position at +0% P&L forever — a real-world bug
  // because the snapshot was previously discarding
  // `marketPricesSats` after using it only to compute
  // unrealized_pnl_sats).
  //
  // Shape contract — the dashboard (`buildPositionsResponse` /
  // `buildSummary` / `buildRiskPanel` in `src/dashboard/server.mjs`)
  // reads `lastSnapshot.meta.market_prices_sats` as
  //   Array<{ token_id: string, price_sats_per_token: number }>
  // and builds its own O(1) index by token_id. So we serialize to
  // that shape here at the snapshot boundary:
  //
  //   - Token id: lowercased string (matches the indexer shape the
  //     rest of the codebase uses).
  //   - Price: coerced from `bigint | number | null` to a finite
  //     `Number`. Sat prices fit comfortably within Number
  //     precision (sats/token for any reasonable BCH token is
  //     well under 2^53). Drop entries with non-finite prices.
  //
  // We keep the OBJECT form as the input (`marketPricesSats[tid]`
  // above) for the O(1) unrealized-PnL walk and only convert to
  // the array form at the persistence boundary. The full input
  // shape is `Record<string, bigint | number | null>` per the
  // JSDoc above.
  if (marketPricesSats && typeof marketPricesSats === 'object') {
    const rows = [];
    for (const [rawTid, rawPrice] of Object.entries(marketPricesSats)) {
      if (typeof rawTid !== 'string' || rawTid.length === 0) continue;
      let priceNum = null;
      if (typeof rawPrice === 'number' && Number.isFinite(rawPrice)) {
        priceNum = rawPrice;
      } else if (typeof rawPrice === 'bigint') {
        // BigInt(Number(bigint)) is safe for sat prices; any token
        // priced above 9.007e15 sats is de-facto an integer-priced
        // integer token that needs BCMR decimals anyway.
        const asNum = Number(rawPrice);
        if (Number.isFinite(asNum)) priceNum = asNum;
      }
      // null → drop the row (dashboard treats missing row as
      // "fall back to entry price", which is the same behavior
      // as the row being absent).
      if (priceNum === null) continue;
      rows.push({ token_id: rawTid.toLowerCase(), price_sats_per_token: priceNum });
    }
    if (rows.length > 0) {
      record.meta.market_prices_sats = rows;
    }
  }
  return record;
}

/**
 * Decide whether `now` is far enough past `lastTs` to justify a
 * new snapshot. Returns `true` when at least `intervalSeconds`
 * have elapsed. The first call (no prior snapshot) always
 * returns `true`.
 *
 * Pure — exported so tests can pin the cadence.
 *
 * @param {string|number|Date|null|undefined} lastTs  ISO or epoch ms; null = first call
 * @param {number} intervalSeconds
 * @param {Date|number} [now=new Date()]
 * @returns {boolean}
 */
export function shouldRecord(lastTs, intervalSeconds, now = new Date()) {
  if (typeof intervalSeconds !== 'number' || !Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    throw new SnapshotsConfigError(`shouldRecord: intervalSeconds must be a positive finite number; got ${intervalSeconds}`);
  }
  const d = now instanceof Date ? now : new Date(now);
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) {
    throw new SnapshotsConfigError(`shouldRecord: invalid now ${now}`);
  }
  if (lastTs === null || lastTs === undefined) return true;
  const last = typeof lastTs === 'number' ? lastTs : Date.parse(String(lastTs));
  if (!Number.isFinite(last)) return true;
  const elapsedMs = d.getTime() - last;
  return elapsedMs >= intervalSeconds * 1000;
}

// ─────────────────────────────────────────────────────────────────────
//  Snapshots class
// ─────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} SnapshotsOpts
 * @property {string} [dir=DEFAULT_SNAPSHOTS_DIR]
 * @property {Object} [logger]   structured logger (default: stderr)
 * @property {Function} [fs]      fs/promises — test seam
 * @property {Function} [now]     () => Date — test seam
 */

/**
 * Stateful wrapper around the daily `snapshots/YYYY-MM-DD.jsonl`
 * files. Holds the last-record timestamp in memory (cheap) and
 * gates writes through `maybeRecord()`.
 */
export class Snapshots {
  /**
   * @param {SnapshotsOpts} [opts]
   */
  constructor(opts = {}) {
    this.dir = opts.dir ?? DEFAULT_SNAPSHOTS_DIR;
    this.logger = opts.logger ?? createLogger({ sink: process.stderr });
    /** @private */
    this._fs = opts.fs ?? fsp;
    /** @private */
    this._now = opts.now ?? (() => new Date());
    /** @private — ISO ts of the last record we wrote (across rollover). */
    this._lastTs = null;
    /** @private — set true after the first read. */
    this._loaded = false;
  }

  /**
   * Read the last-snapshot timestamp from disk by scanning the
   * most-recent daily file. This is what survives a restart —
   * the trader loop calls `load()` once on boot.
   *
   * @returns {Promise<string|null>} ISO ts of the most recent record, or null
   */
  async load() {
    /** @type {string|null} */
    let latest = null;
    /** @type {string[]} */
    let entries = [];
    try {
      entries = await this._fs.readdir(this.dir);
    } catch (e) {
      if (e && typeof e === 'object' && /** @type {any} */ (e).code === 'ENOENT') {
        await ensureDirForFile(`${this.dir}/_init.jsonl`, this._fs);
        this._loaded = true;
        return null;
      }
      throw e;
    }
    const jsonlFiles = entries.filter((f) => f.endsWith('.jsonl')).sort();
    for (const f of jsonlFiles) {
      try {
        const { lines, errors } = await readNdjsonFile(`${this.dir}/${f}`, { fs: this._fs });
        // Surface corrupt-line warnings to the log without throwing
        // — a corrupt line shouldn't block the bot from booting.
        if (errors && errors.length > 0) {
          this.logger.warn('snapshots.load.corrupt_lines', {
            file: `${this.dir}/${f}`, error_count: errors.length, sample: errors.slice(0, 3),
          });
        }
        for (const line of lines) {
          if (line && typeof line === 'object' && typeof /** @type {any} */ (line).ts === 'string') {
            if (latest === null || /** @type {any} */ (line).ts > latest) {
              latest = /** @type {any} */ (line).ts;
            }
          }
        }
      } catch (e) {
        if (e && typeof e === 'object' && /** @type {any} */ (e).code === 'ENOENT') continue;
        throw e;
      }
    }
    this._lastTs = latest;
    this._loaded = true;
    return latest;
  }

  /**
   * Append a snapshot record to today's NDJSON file. Returns the
   * record as written (with the ts normalized).
   *
   * @param {SnapshotRecord|Object} record
   * @returns {Promise<SnapshotRecord>}
   */
  async record(record) {
    if (!record || typeof record !== 'object') {
      throw new SnapshotsConfigError('Snapshots.record: record required');
    }
    if (typeof record.ts !== 'string') {
      throw new SnapshotsConfigError('Snapshots.record: record.ts must be an ISO string');
    }
    if (record.v !== SNAPSHOT_VERSION) {
      // Don't silently coerce — bad-version records are a programming error.
      throw new SnapshotsConfigError(`Snapshots.record: record.v must be ${SNAPSHOT_VERSION}; got ${record.v}`);
    }
    const when = new Date(record.ts);
    if (Number.isNaN(when.getTime())) {
      throw new SnapshotsConfigError(`Snapshots.record: record.ts unparseable: ${record.ts}`);
    }
    const file = snapshotFilePath(this.dir, when);
    await atomicAppendNdjson(file, JSON.stringify(record), this._fs);
    this._lastTs = record.ts;
    if (!this._loaded) this._loaded = true;
    this.logger.info('snapshots.record', {
      ts: record.ts,
      bch_balance_sats: record.bch_balance_sats,
      open_position_count: record.open_position_count,
      total_exposure_sats: record.total_exposure_sats,
      unrealized_pnl_sats: record.unrealized_pnl_sats,
      token_id: record.token_id ?? null,
      source: record?.meta?.source ?? null,
      file,
    });
    return record;
  }

  /**
   * Convenience wrapper: derive + maybe-record. Returns `null`
   * if no record was written (cadence hasn't elapsed yet),
   * otherwise returns the new record.
   *
   * `args.now` overrides the Snapshots-internal clock. The trader
   * loop passes its own `opts.clock` here so a test that advances
   * the loop clock also advances the snapshot cadence clock — keeps
   * the integration-test clock deterministic.
   *
   * @param {Object} args               same shape as `deriveSnapshot`
   * @param {number} intervalSeconds    `loop.snapshot_interval_seconds`
   * @returns {Promise<SnapshotRecord|null>}
   */
  async maybeRecord(args, intervalSeconds) {
    if (typeof intervalSeconds !== 'number' || !Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
      throw new SnapshotsConfigError(`Snapshots.maybeRecord: intervalSeconds must be a positive finite number; got ${intervalSeconds}`);
    }
    if (!this._loaded) await this.load();
    // Caller-supplied `now` wins over the internal clock — this is
    // the contract the trader loop relies on for restart-safe
    // snapshot cadence under a pinned clock.
    const now = (args && (args.now instanceof Date)) ? args.now : this._now();
    if (!shouldRecord(this._lastTs, intervalSeconds, now)) {
      return null;
    }
    const record = deriveSnapshot({
      ...args,
      now,
      source: args?.source ?? 'loop',
    });
    return this.record(record);
  }

  /**
   * Read snapshots back from disk. Returns the last `limit`
   * records across all daily files (most-recent first), or all
   * records if `limit` is omitted. Used by the dashboard.
   *
   * @param {Object} [opts]
   * @param {number} [opts.limit]    cap on returned records
   * @param {string} [opts.tokenId]  filter by token
   * @returns {Promise<{ records: SnapshotRecord[], errors: Array<{ file: string, line: number, error: string }>, total: number }>}
   */
  async readBack(opts = {}) {
    const fs = this._fs;
    const limit = opts.limit ?? Infinity;
    const tokenId = opts.tokenId ?? null;
    /** @type {string[]} */
    let entries = [];
    try {
      entries = await fs.readdir(this.dir);
    } catch (e) {
      if (e && typeof e === 'object' && /** @type {any} */ (e).code === 'ENOENT') {
        return { records: [], errors: [], total: 0 };
      }
      throw e;
    }
    /** @type {SnapshotRecord[]} */
    const all = [];
    /** @type {Array<{ file: string, line: number, error: string }>} */
    const errors = [];
    let total = 0;
    const files = entries.filter((f) => f.endsWith('.jsonl')).sort();
    for (const f of files) {
      try {
        const { lines, errors: lineErrors } = await readNdjsonFile(`${this.dir}/${f}`, { fs });
        for (const le of lineErrors) errors.push({ file: f, line: le.line, error: le.error });
        for (const line of lines) {
          total += 1;
          if (!line || typeof line !== 'object') continue;
          if (tokenId && /** @type {any} */ (line).token_id !== tokenId) continue;
          all.push(/** @type {SnapshotRecord} */ (line));
        }
      } catch (e) {
        if (e && typeof e === 'object' && /** @type {any} */ (e).code === 'ENOENT') continue;
        throw e;
      }
    }
    // Sort by ts asc then take tail.
    all.sort((a, b) => String(a?.ts ?? '').localeCompare(String(b?.ts ?? '')));
    const tail = all.slice(-Math.min(limit, all.length));
    return { records: tail, errors, total };
  }

  /**
   * Read the most recent snapshot record (if any). Used by the
   * dashboard's "live" panel + by the trader loop's first-tick
   * sanity check.
   *
   * @returns {Promise<SnapshotRecord|null>}
   */
  async last() {
    const { records } = await this.readBack({ limit: 1 });
    return records.length > 0 ? records[0] : null;
  }
}

export const _internals = {
  deriveSnapshot,
  shouldRecord,
  snapshotFilePath,
};
