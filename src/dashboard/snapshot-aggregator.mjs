#!/usr/bin/env node
// src/dashboard/snapshot-aggregator.mjs
//
// T64 — Snapshot aggregator with in-memory cache.
//
// Today `/api/snapshots` re-reads + re-parses every snapshot NDJSON
// file on every dashboard refresh. With the 7 daily files
// accumulating as of 2026-09-19 (~1847 records), every dashboard
// refresh pays a 50-200ms parse cost. This module ships a small
// pure-function aggregator that the route handler calls when
// computing the new `/api/snapshots/aggregate` endpoint — and a
// tiny `SnapshotAggregator` class that wraps an mtime-keyed TTL
// cache so the dashboard can poll the endpoint at high frequency
// without re-paying the parse cost.
//
// Design rules (also see docs/ARCHITECTURE.md §3 — pure helpers
// live above the dashboard / network layers):
//
//   1. **Pure.** `aggregateSnapshots` is a pure function: no I/O,
//      no `Date.now()`, no module-scope state. `nowMs` is threaded
//      in by the caller so the test suite stays deterministic.
//
//   2. **BigInt-friendly.** All sat values arrive as stringified
//      bigints from disk (see src/portfolio/snapshots.mjs). We
//      accept string / bigint / number / null and normalize via
//      `safeBigIntFromString` — matches the on-disk convention
//      that mirrors src/dashboard/pnl-timeseries.mjs#toSatsBig.
//
//   3. **Sort stable, deterministic.** `sinceMs` windowing is
//      applied AFTER aggregation (so the "first/last" pair always
//      reflects the truthful window edge, never a truncated
//      inside-window record).
//
//   4. **No silent data loss.** A record missing `ts` is excluded
//      (counted via `bucket_skipped`). A record with unparseable
//      sat fields is treated as null (counted via
//      `bucket_skipped`). The route handler exposes the skip
//      counts so the operator can audit.
//
//   5. **Token-id filter is case-folded.** 64-hex tokens are
//      stored lowercase; the query string is folded before
//      comparison.
//
//   6. **Defensive by construction.** empty records, missing dir,
//      single record, bad range, malformed token-id, non-array
//      records, NaN/Infinity sat values are all handled —
//      `aggregateSnapshots` returns a typed envelope with all-null
//      rollups rather than throwing. Callers can detect "no data"
//      via `bucket_count === 0`.

import { SATS_PER_BCH } from '../data/types.mjs';

// ─────────────────────────────────────────────────────────────────────
//  Constants + errors
// ─────────────────────────────────────────────────────────────────────

export const SNAPSHOTS_AGGREGATE_SCHEMA = 'tradebot.dashboard.snapshots-aggregate/v1';

export const DEFAULT_SNAPSHOT_AGGREGATE_CACHE_MS = 30000;
export const MIN_SNAPSHOT_AGGREGATE_CACHE_MS = 100;
export const MAX_SNAPSHOT_AGGREGATE_CACHE_MS = 300000;

/**
 * Base class for snapshot-aggregator errors. The route handler
 * maps `SnapshotAggregatorConfigError` to HTTP 400 and anything
 * else to 500; the dashboard's request dispatcher honors
 * `err.statusCode` if set.
 */
export class SnapshotAggregatorError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'SnapshotAggregatorError';
    if (opts.kind) this.kind = opts.kind;
    if (opts.statusCode) this.statusCode = opts.statusCode;
    if (opts.cause) this.cause = opts.cause;
  }
}

/** Bad input — caller passed something that isn't a usable record list. */
export class SnapshotAggregatorConfigError extends SnapshotAggregatorError {
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = 'SnapshotAggregatorConfigError';
    this.statusCode = opts.statusCode ?? 400;
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Pure helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Coerce a sat-string / bigint / number / null to a bigint, or
 * null for null / undefined / unparseable / negative values.
 *
 * Mirrors `src/dashboard/pnl-timeseries.mjs#toSatsBig` so the
 * on-disk convention is uniform across dashboard endpoints.
 *
 * Pure — exported for tests.
 *
 * @param {unknown} v
 * @returns {bigint|null}
 */
export function safeBigIntFromString(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    return BigInt(Math.round(v));
  }
  if (typeof v === 'string') {
    const t = v.trim();
    if (t.length === 0) return null;
    if (!/^-?\d+$/.test(t)) return null;
    try {
      return BigInt(t);
    } catch (_) {
      return null;
    }
  }
  return null;
}

/**
 * Parse an ISO-8601 `ts` string to ms-since-epoch. Returns `null`
 * for missing / unparseable inputs.
 *
 * Pure — exported for tests.
 *
 * @param {unknown} iso
 * @returns {number|null}
 */
export function parseSnapshotTs(iso) {
  if (typeof iso !== 'string') return null;
  const t = iso.trim();
  if (t.length === 0) return null;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Case-fold a token-id filter. Lowercases 64-hex inputs, leaves
 * non-hex strings untouched so the route handler can reject them
 * with a clear error.
 *
 * Pure.
 *
 * @param {unknown} tokenId
 * @returns {string|null}
 */
export function normalizeTokenFilter(tokenId) {
  if (tokenId === null || tokenId === undefined) return null;
  if (typeof tokenId !== 'string') return null;
  const t = tokenId.trim();
  if (t.length === 0) return null;
  return t.toLowerCase();
}

/**
 * Convert a bigint sat value to a BCH number (rounded to 8
 * decimals). Returns `null` for null/undefined inputs. The 8-decimal
 * cap matches the standard BCH precision floor (100M sats/BCH ×
 * 1e-8 = 8 decimals).
 *
 * Pure — exported for tests.
 *
 * @param {bigint|null|undefined} sats
 * @returns {number|null}
 */
export function satsToBchNumber(sats) {
  if (sats === null || sats === undefined) return null;
  // BigInt-to-Number can lose precision above 2^53; the dashboard
  // displays BCH via `formatBch()` anyway which uses bigint math.
  // For the JSON envelope we return a Number so consumers can do
  // arithmetic without re-parsing strings.
  const n = Number(sats) / Number(SATS_PER_BCH);
  return Number.isFinite(n) ? n : null;
}

/**
 * Compute min/max/mean/latest over a list of bigint sat values,
 * skipping nulls. Returns all-nulls when the list is empty.
 *
 * Pure — exported for tests.
 *
 * @param {Array<bigint|null|undefined>} values
 * @returns {{ min: bigint|null, max: bigint|null, mean: bigint|null, latest: bigint|null, count: number, skipped: number }}
 */
export function satsStats(values) {
  if (!Array.isArray(values)) {
    return { min: null, max: null, mean: null, latest: null, count: 0, skipped: 0 };
  }
  let min = null;
  let max = null;
  let sum = 0n;
  let nonNull = 0;
  let skipped = 0;
  for (const v of values) {
    const b = safeBigIntFromString(v);
    if (b === null) {
      skipped += 1;
      continue;
    }
    nonNull += 1;
    sum += b;
    if (min === null || b < min) min = b;
    if (max === null || b > max) max = b;
  }
  if (nonNull === 0) {
    return { min: null, max: null, mean: null, latest: null, count: 0, skipped };
  }
  // Integer-mean (bigint division truncates). For sat values this
  // matches operator intuition (we don't carry fractional sats).
  const mean = sum / BigInt(nonNull);
  const latest = values.length > 0 ? safeBigIntFromString(values[values.length - 1]) : null;
  return { min, max, mean, latest, count: nonNull, skipped };
}

/**
 * Compute the drawdown between the first and last non-null sat
 * value. Returns `first - last` as a bigint (so a positive number
 * means the balance shrunk). Returns null when either side is
 * missing.
 *
 * Pure — exported for tests.
 *
 * @param {Array<bigint|null|undefined>} values
 * @returns {bigint|null}
 */
export function drawdownSats(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  let first = null;
  let last = null;
  for (const v of values) {
    const b = safeBigIntFromString(v);
    if (b === null) continue;
    if (first === null) first = b;
    last = b;
  }
  if (first === null || last === null) return null;
  return first - last;
}

/**
 * Build the standard envelope for a single numeric field
 * (min/max/mean/latest + delta-from-first + bch-format sidecar).
 * Pure — exported for tests.
 *
 * @param {Array<bigint|null|undefined>} values
 * @returns {{
 *   min: string|null, max: string|null, mean: string|null, latest: string|null,
 *   count: number, skipped: number,
 *   min_bch: number|null, max_bch: number|null, mean_bch: number|null, latest_bch: number|null
 * }}
 */
export function buildSatsField(values) {
  const stats = satsStats(values);
  return {
    min: stats.min === null ? null : stats.min.toString(),
    max: stats.max === null ? null : stats.max.toString(),
    mean: stats.mean === null ? null : stats.mean.toString(),
    latest: stats.latest === null ? null : stats.latest.toString(),
    count: stats.count,
    skipped: stats.skipped,
    min_bch: satsToBchNumber(stats.min),
    max_bch: satsToBchNumber(stats.max),
    mean_bch: satsToBchNumber(stats.mean),
    latest_bch: satsToBchNumber(stats.latest),
  };
}

/**
 * Build a numeric (non-sat) field envelope — for `open_position_count`
 * which is an integer, not sats. Returns min/max/mean/latest over
 * non-null numeric values.
 *
 * Pure — exported for tests.
 *
 * @param {Array<number|null|undefined>} values
 * @returns {{ min: number|null, max: number|null, mean: number|null, latest: number|null, count: number, skipped: number }}
 */
export function buildIntField(values) {
  if (!Array.isArray(values)) {
    return { min: null, max: null, mean: null, latest: null, count: 0, skipped: 0 };
  }
  let min = null;
  let max = null;
  let sum = 0;
  let nonNull = 0;
  let skipped = 0;
  for (const v of values) {
    if (v === null || v === undefined) {
      skipped += 1;
      continue;
    }
    const n = Number(v);
    if (!Number.isFinite(n)) {
      skipped += 1;
      continue;
    }
    nonNull += 1;
    sum += n;
    if (min === null || n < min) min = n;
    if (max === null || n > max) max = n;
  }
  if (nonNull === 0) {
    return { min: null, max: null, mean: null, latest: null, count: 0, skipped };
  }
  const mean = sum / nonNull;
  const latest = values.length > 0 ? (() => {
    const last = values[values.length - 1];
    if (last === null || last === undefined) return null;
    const n = Number(last);
    return Number.isFinite(n) ? n : null;
  })() : null;
  return { min, max, mean, latest, count: nonNull, skipped };
}

// ─────────────────────────────────────────────────────────────────────
//  Core: aggregateSnapshots
// ─────────────────────────────────────────────────────────────────────

/**
 * Aggregate a list of snapshot records into a single envelope.
 * Pure — exported for tests.
 *
 * Filter args:
 *   - `sinceMs` (number|null): drops records with `ts_ms < sinceMs`.
 *     When null, all records are included.
 *   - `nowMs` (number): included in the response so the client
 *     can detect stale responses. Required if `sinceMs` is set,
 *     so the caller can compute `clock() - parseRange(...)`.
 *   - `tokenId` (string|null): if set, only records for that
 *     token pass (case-folded).
 *
 * The `sinceMs` windowing is applied AFTER aggregation — the
 * `first_record` / `last_record` in the response reflects the
 * truthful window edge. This matches the pnl-timeseries.mjs
 * semantics so the dashboard renders both charts consistently.
 *
 * @param {Array<Object>|null|undefined} records
 * @param {Object} [opts]
 * @param {number} [opts.sinceMs]
 * @param {number} [opts.nowMs]
 * @param {string} [opts.tokenId]
 * @returns {{
 *   schema: string, ts: string, now_ms: number|null,
 *   range_ms: number|null, range_label: string,
 *   token_id: string|null,
 *   bucket_count: number, bucket_skipped: number,
 *   first_record: Object|null, last_record: Object|null,
 *   first_ts: string|null, last_ts: string|null,
 *   balance_sats: Object, total_exposure_sats: Object,
 *   unrealized_pnl_sats: Object, open_position_count: Object,
 *   drawdown_sats: string|null, drawdown_bch: number|null
 * }}
 */
export function aggregateSnapshots(records, opts = {}) {
  const ts = new Date().toISOString();
  if (!Array.isArray(records)) {
    throw new SnapshotAggregatorConfigError('aggregateSnapshots: records must be an array');
  }
  const onSkip = typeof opts.onSkip === 'function' ? opts.onSkip : null;
  const sinceMs = (typeof opts.sinceMs === 'number' && Number.isFinite(opts.sinceMs)) ? opts.sinceMs : null;
  const nowMs = (typeof opts.nowMs === 'number' && Number.isFinite(opts.nowMs)) ? opts.nowMs : null;
  const tokenFilter = normalizeTokenFilter(opts.tokenId);
  const rangeMs = sinceMs;
  const rangeLabel = formatRangeLabel(sinceMs, nowMs);

  /** @type {Array<{ record: Object, ts_ms: number }>} */
  const sortable = [];
  let skipped = 0;

  for (let i = 0; i < records.length; i += 1) {
    const r = records[i];
    if (!r || typeof r !== 'object') {
      skipped += 1;
      if (onSkip) onSkip('not_an_object', r);
      continue;
    }
    if (tokenFilter !== null) {
      const recTid = (typeof r.token_id === 'string') ? r.token_id.toLowerCase() : null;
      if (recTid !== tokenFilter) {
        skipped += 1;
        if (onSkip) onSkip('token_filter_miss', r);
        continue;
      }
    }
    const rTs = parseSnapshotTs(r.ts);
    if (rTs === null) {
      skipped += 1;
      if (onSkip) onSkip('missing_or_unparseable_ts', r);
      continue;
    }
    if (sinceMs !== null && rTs < sinceMs) {
      skipped += 1;
      if (onSkip) onSkip('before_window', r);
      continue;
    }
    sortable.push({ record: r, ts_ms: rTs });
  }

  // Sort ASC by ts_ms (the route handler emits the envelope in
  // chronological order — matches the dashboard's balance chart).
  sortable.sort((a, b) => {
    if (a.ts_ms !== b.ts_ms) return a.ts_ms - b.ts_ms;
    return 0;
  });

  const balanceValues = [];
  const exposureValues = [];
  const pnlValues = [];
  const countValues = [];
  for (const { record } of sortable) {
    balanceValues.push(safeBigIntFromString(record.bch_balance_sats));
    exposureValues.push(safeBigIntFromString(record.total_exposure_sats));
    pnlValues.push(safeBigIntFromString(record.unrealized_pnl_sats));
    countValues.push(record.open_position_count);
  }

  const balanceField = buildSatsField(balanceValues);
  const exposureField = buildSatsField(exposureValues);
  const pnlField = buildSatsField(pnlValues);
  const countField = buildIntField(countValues);

  const drawdown = drawdownSats(balanceValues);

  return {
    schema: SNAPSHOTS_AGGREGATE_SCHEMA,
    ts,
    now_ms: nowMs,
    range_ms: rangeMs,
    range_label: rangeLabel,
    token_id: tokenFilter,
    bucket_count: sortable.length,
    bucket_skipped: skipped,
    first_record: sortable.length > 0 ? sortable[0].record : null,
    last_record: sortable.length > 0 ? sortable[sortable.length - 1].record : null,
    first_ts: sortable.length > 0 ? sortable[0].record.ts : null,
    last_ts: sortable.length > 0 ? sortable[sortable.length - 1].record.ts : null,
    balance_sats: balanceField,
    total_exposure_sats: exposureField,
    unrealized_pnl_sats: pnlField,
    open_position_count: countField,
    drawdown_sats: drawdown === null ? null : drawdown.toString(),
    drawdown_bch: satsToBchNumber(drawdown),
  };
}

/**
 * Format a human-readable range label. Mirrors the existing
 * `listSnapshots` envelope's `range` field shape (e.g. "30d",
 * "all", "3600s") so the dashboard can render both endpoints
 * consistently.
 *
 * Pure — exported for tests.
 *
 * @param {number|null} sinceMs
 * @param {number|null} nowMs
 * @returns {string}
 */
export function formatRangeLabel(sinceMs, nowMs) {
  if (sinceMs === null) return 'all';
  if (nowMs === null || !Number.isFinite(nowMs)) {
    return `${Math.round(sinceMs / 1000)}s`;
  }
  const durMs = Math.max(0, nowMs - sinceMs);
  const durS = Math.round(durMs / 1000);
  if (durS < 60) return `${durS}s`;
  if (durS < 3600) return `${Math.round(durS / 60)}m`;
  if (durS < 86400) return `${Math.round(durS / 3600)}h`;
  return `${Math.round(durS / 86400)}d`;
}

/**
 * Build the HTTP response envelope. Wraps the aggregation result
 * with the cache metadata (source, cache_age_ms, mtime_ms) so the
 * dashboard can render "cached" vs "fresh" + last-invalidation
 * timestamps.
 *
 * Pure — exported for tests.
 *
 * @param {Object} aggregate            the result of `aggregateSnapshots`
 * @param {Object} [opts]
 * @param {'cache'|'fresh'} [opts.source]
 * @param {number} [opts.cacheAgeMs]
 * @param {number|null} [opts.mtimeMs]
 * @returns {Object}
 */
export function buildAggregateResponse(aggregate, opts = {}) {
  if (!aggregate || typeof aggregate !== 'object') {
    throw new SnapshotAggregatorConfigError('buildAggregateResponse: aggregate required');
  }
  const source = opts.source === 'cache' ? 'cache' : 'fresh';
  const cacheAgeMs = (typeof opts.cacheAgeMs === 'number' && Number.isFinite(opts.cacheAgeMs)) ? Math.max(0, Math.floor(opts.cacheAgeMs)) : 0;
  const mtimeMs = (typeof opts.mtimeMs === 'number' && Number.isFinite(opts.mtimeMs)) ? opts.mtimeMs : null;
  return {
    schema: aggregate.schema,
    ts: aggregate.ts,
    source,
    cache_age_ms: cacheAgeMs,
    mtime_ms: mtimeMs,
    range_ms: aggregate.range_ms,
    range_label: aggregate.range_label,
    token_id: aggregate.token_id,
    bucket_count: aggregate.bucket_count,
    bucket_skipped: aggregate.bucket_skipped,
    first_ts: aggregate.first_ts,
    last_ts: aggregate.last_ts,
    balance_sats: aggregate.balance_sats,
    total_exposure_sats: aggregate.total_exposure_sats,
    unrealized_pnl_sats: aggregate.unrealized_pnl_sats,
    open_position_count: aggregate.open_position_count,
    drawdown_sats: aggregate.drawdown_sats,
    drawdown_bch: aggregate.drawdown_bch,
    first_record: aggregate.first_record,
    last_record: aggregate.last_record,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  SnapshotAggregator (mtime-keyed TTL cache wrapper)
// ─────────────────────────────────────────────────────────────────────

/**
 * A tiny mtime-keyed TTL cache wrapping `aggregateSnapshots`.
 * Key shape: `(dir, mtimeMs, rangeMs, tokenId)`. The mtime key
 * means a snapshot-record write from the trader loop invalidates
 * the cache instantly without needing an explicit flush knob.
 *
 * The `cacheMs` knob (default 30000) caps the cache lifetime even
 * when the file mtime hasn't changed — protects against very-fresh
 * records that haven't yet hit disk + gives operators a knob to
 * force-fresh on demand (set cacheMs<=0 to disable caching).
 *
 * Pure in the sense that the underlying `aggregateSnapshots` is
 * pure — the cache itself is a thin memoization layer with no I/O.
 */
export class SnapshotAggregator {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.cacheMs]                 TTL in ms (default DEFAULT_SNAPSHOT_AGGREGATE_CACHE_MS)
   * @param {Function|null} [opts.nowMs]            injectable clock returning ms-since-epoch (default Date.now())
   */
  constructor(opts = {}) {
    const rawCacheMs = (typeof opts.cacheMs === 'number' && Number.isFinite(opts.cacheMs)) ? opts.cacheMs : DEFAULT_SNAPSHOT_AGGREGATE_CACHE_MS;
    let cacheMs = rawCacheMs;
    if (cacheMs > MAX_SNAPSHOT_AGGREGATE_CACHE_MS) cacheMs = MAX_SNAPSHOT_AGGREGATE_CACHE_MS;
    if (cacheMs < 0) cacheMs = 0;
    this.cacheMs = cacheMs;
    this.nowMs = (typeof opts.nowMs === 'function') ? opts.nowMs : null;
    /** @type {{ key: string, value: Object, computedAtMs: number, mtimeMs: number|null, source: string }|null} */
    this._cache = null;
  }

  /**
   * @returns {number} the current time in ms
   */
  _now() {
    if (this.nowMs !== null) return this.nowMs();
    return Date.now();
  }

  /**
   * Clear the cache. Useful in tests + for operator-triggered
   * flush via an admin endpoint.
   */
  invalidate() {
    this._cache = null;
  }

  /**
   * Look up the cached envelope. Returns `null` on cache miss.
   *
   * @param {Object} args
   * @param {string} [args.dir]
   * @param {number|null} [args.mtimeMs]
   * @param {number|null} [args.rangeMs]
   * @param {string|null} [args.tokenId]
   * @returns {{ value: Object, cacheAgeMs: number, mtimeMs: number|null }|null}
   */
  peek(args = {}) {
    if (this.cacheMs <= 0) return null;
    if (!this._cache) return null;
    const key = this._cacheKey(args);
    if (this._cache.key !== key) return null;
    const now = this._now();
    const age = now - this._cache.computedAtMs;
    if (age < 0 || age > this.cacheMs) return null;
    return {
      value: this._cache.value,
      cacheAgeMs: age,
      mtimeMs: this._cache.mtimeMs,
    };
  }

  /**
   * Compute (or return cached) the aggregate for the given args.
   * Cache hit returns `{value, cached:true, cacheAgeMs}`; miss
   * (or mtime-change / TTL expiry / cacheMs<=0) re-computes and
   * stores the result.
   *
   * @param {Object} args
   * @param {Array<Object>} args.records            raw snapshot records (parsed from disk)
   * @param {string} [args.dir]                     snapshot dir (cache key dimension)
   * @param {number|null} [args.mtimeMs]            file mtime — bumping invalidates the cache
   * @param {number|null} args.rangeMs              window size (or null for all)
   * @param {string|null} args.tokenId              token filter (or null for all)
   * @returns {{ value: Object, cached: boolean, cacheAgeMs: number, mtimeMs: number|null }}
   */
  compute(args = {}) {
    if (!args || typeof args !== 'object') {
      throw new SnapshotAggregatorConfigError('SnapshotAggregator.compute: args required');
    }
    if (!Array.isArray(args.records)) {
      throw new SnapshotAggregatorConfigError('SnapshotAggregator.compute: args.records must be an array');
    }
    const mtimeMs = (typeof args.mtimeMs === 'number' && Number.isFinite(args.mtimeMs)) ? args.mtimeMs : null;
    const rangeMs = (typeof args.rangeMs === 'number' && Number.isFinite(args.rangeMs)) ? args.rangeMs : null;
    const tokenId = typeof args.tokenId === 'string' ? args.tokenId : null;
    const dir = typeof args.dir === 'string' ? args.dir : '';

    const hit = this.peek({ dir, mtimeMs, rangeMs, tokenId });
    if (hit !== null) {
      return {
        value: hit.value,
        cached: true,
        cacheAgeMs: hit.cacheAgeMs,
        mtimeMs: hit.mtimeMs,
      };
    }

    const nowMs = this._now();
    const sinceMs = rangeMs === null ? null : nowMs - rangeMs;
    const value = aggregateSnapshots(args.records, {
      sinceMs,
      nowMs,
      tokenId,
    });

    if (this.cacheMs > 0) {
      this._cache = {
        key: this._cacheKey({ dir, mtimeMs, rangeMs, tokenId }),
        value,
        computedAtMs: nowMs,
        mtimeMs,
        source: 'fresh',
      };
    }
    return {
      value,
      cached: false,
      cacheAgeMs: 0,
      mtimeMs,
    };
  }

  /**
   * @private
   */
  _cacheKey(args) {
    const dir = typeof args.dir === 'string' ? args.dir : '';
    const mtimeMs = (typeof args.mtimeMs === 'number' && Number.isFinite(args.mtimeMs)) ? args.mtimeMs : 'null';
    const rangeMs = (typeof args.rangeMs === 'number' && Number.isFinite(args.rangeMs)) ? args.rangeMs : 'null';
    const tokenId = typeof args.tokenId === 'string' ? args.tokenId : 'null';
    return `${dir}|mtime=${mtimeMs}|range=${rangeMs}|token=${tokenId}`;
  }
}

/**
 * Coerce a config-supplied cacheMs to a safe positive integer in
 * the supported range. Pure — exported for tests + the knob
 * catalog's clamp-on-blur path.
 *
 * 0 means "disable caching" (always-fresh). Negative values are
 * clamped to 0. Values in [1..MIN_SNAPSHOT_AGGREGATE_CACHE_MS) are
 * floored to MIN to prevent pathological values that defeat the
 * cache (e.g. 1ms TTL on a 200ms handler).
 *
 * @param {unknown} v
 * @returns {number}
 */
export function clampSnapshotAggregateCacheMs(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_SNAPSHOT_AGGREGATE_CACHE_MS;
  const n = Math.floor(v);
  if (n <= 0) return 0;
  if (n < MIN_SNAPSHOT_AGGREGATE_CACHE_MS) return MIN_SNAPSHOT_AGGREGATE_CACHE_MS;
  if (n > MAX_SNAPSHOT_AGGREGATE_CACHE_MS) return MAX_SNAPSHOT_AGGREGATE_CACHE_MS;
  return n;
}

/**
 * @returns {Object} the default aggregator config shape that the
 *   route handler can `Object.assign` onto its `dashboardCfg`.
 */
export function defaultSnapshotAggregatorConfig() {
  return Object.freeze({
    cache_ms: DEFAULT_SNAPSHOT_AGGREGATE_CACHE_MS,
  });
}