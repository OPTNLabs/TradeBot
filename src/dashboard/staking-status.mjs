#!/usr/bin/env node
// src/dashboard/staking-status.mjs
//
// T58 subset 4 + subset 6 — `GET /api/staking/status` handler.
//
// Powers the Dashboard's "BadgerCoin Staking" tile so the
// operator can see at-a-glance:
//
//   1. lockNFT state in the wallet (count + total locked BCH +
//      per-lock decoded commitment fields — userPkh / stakeBlocks
//      / BCH sat value / lock_block_height).
//   2. Last 10 stake alerts from `data/alerts.jsonl` filtered to
//      `kind: stake_locked | stake_unlock | stake_failed`.
//   3. The current staking knobs (`enabled` / `simulation_only` /
//      `auto_lock_enabled` / `auto_unlock_enabled`).
//   4. T58 subset 6: per-lock maturity envelope (matures in X
//      blocks + percent complete + a "READY NOW" indicator when
//      the timelock has elapsed) + the current chain tip height
//      with a TTL-bounded cache so the dashboard doesn't hammer
//      Electrum on every 60s refresh tick.
//
// Design rules:
//
//   - **Pure core, I/O at the edges.** The pure helpers
//     (`buildLockNftSummaries`, `buildLockMaturity`,
//     `summarizeLockMaturities`, `filterStakeAlerts`,
//     `summarizeKnobs`, `buildStakingStatusResponse`,
//     `tipHeightSeverity`) take already-fetched inputs; only
//     `buildStakingStatus(ctx)` does the I/O (UTXO fetch + alerts
//     log read + tip-height fetch with caching).
//
//   - **Graceful degrade.** When the wallet isn't wired (`ctx.wallet
//     === null`) the response still returns the knobs + the alerts
//     tail + a `tip_height_source: 'unavailable'` — just with
//     `lockNfts: { count: 0, total_bch: 0, total_bch_sats: '0',
//     items: [], error: 'wallet_not_configured' }`. The Dashboard
//     renders the "wallet unavailable" pill instead of blanking
//     the whole tile.
//
//   - **Chain tip call goes through a TTL cache.** T58 subset 6
//     ships `withCachedTipHeight({...})` so a 60s refresh tick on
//     the dashboard doesn't trigger 60s round-trips to Electrum.
//     Default TTL is `staking.dashboard_tip_height_cache_ms`
//     (30000ms = 30s); operators dial it via the Settings view.
//     The cache is module-scoped + reset via `resetTipHeightCache`
//     for test isolation.
//
//   - **Same atomic-write pattern as the rest of the dashboard.**
//     `readNdjsonFile` (from `src/util/atomic-write.mjs`) handles
//     ENOENT cleanly; the endpoint returns an empty `recent_alerts`
//     array on a cold-start bot.
//
// Wire shape (consumed by `dashboard/src/views/staking-status-helpers.mjs`):
//
//   {
//     schema: 'tradebot.dashboard.staking-status/v1',
//     ts: <iso>,
//     wallet_configured: <bool>,
//     lockNfts: {
//       count: <int>,
//       total_bch: <number>,
//       total_bch_sats: <bigint-as-string>,
//       items: [
//         {
//           txid: <string>,
//           vout: <number>,
//           value_sats: <bigint-as-string>,
//           value_bch: <number>,
//           stake_blocks: <number|null>,
//           stake_blocks_approx_days: <number|null>,
//           user_pkh_hex: <string|null>,
//           lock_block_height: <number|null>,
//           // T58 subset 6 maturity envelope (always present):
//           maturity: 'mature'|'premature'|'never'|'unknown',
//           next_mature_block: <number|null>,
//           blocks_remaining: <number>,
//           approx_seconds_remaining: <number>,
//           percent_complete: <number>,     // 0..1
//         }
//       ],
//       error: <string|null>,
//     },
//     knobs: {
//       enabled: <bool>,
//       simulation_only: <bool>,
//       auto_lock_enabled: <bool>,
//       auto_unlock_enabled: <bool>,
//     },
//     recent_alerts: [ <10 most-recent stake alerts> ],
//     recent_alerts_source: 'data/alerts.jsonl',
//     load_errors: [ <parse errors from alerts.jsonl read> ],
//     // T58 subset 6 tip-height envelope:
//     tip_height: <number|null>,
//     tip_height_fetched_at: <iso|null>,
//     tip_height_age_ms: <number|null>,
//     tip_height_source: 'fresh'|'cache'|'unavailable',
//     tip_height_error: <string|null>,
//   }
//
// Origin: T58 subset 4 (operator-approved via
// `data/feature-ideas.json#idea_operator_add-badgercoin-staking_20260917`)
// + T58 subset 6 (per-lock maturity + tip-height cache).
// Depends on: T58 subset 2 (`decodeLockNftCommitment` /
// `countLockNfts` / `sumLockNftValue` in
// `src/staking/badger-stake.mjs`), T58 subset 3
// (alert-shape conventions from `src/staking/stake-alert-dispatch.mjs`),
// T53 (`/api/alerts/recent` alerts-log shape from
// `src/dashboard/alerts-recent.mjs`), T58 subset 5
// (`wallet.getBlockHeight()` in `src/wallet/libauth.mjs`).

import { readNdjsonFile } from '../util/atomic-write.mjs';
import {
  decodeLockNftCommitment,
  getCommitment,
  getSatoshis,
} from '../staking/badger-stake.mjs';
import { SATS_PER_BCH } from '../data/types.mjs';

// ─── Constants ──────────────────────────────────────────────────────────

/** T58 subset 6 — BCH target blocks-per-day (matches the
 * `stakeBlocksToApproxDays` heuristic already in this module and
 * the trader-loop's graceBlocks math in `src/trader/loop.mjs`).
 * Centralised so the dashboard and the trader loop can never
 * disagree on "how long until this lock matures". */
export const BCH_BLOCKS_PER_DAY = 144;

/** T58 subset 6 — Default for `staking.dashboard_tip_height_cache_ms`
 * when the operator hasn't flipped it. 30s is a reasonable
 * middle-ground: short enough that the React tile's "tip: 826142 ·
 * 14s ago" pill stays fresh; long enough that the dashboard's
 * 60s auto-refresh tick doesn't hammer Electrum. Operators who
 * want tighter polling dial it down via the Settings view. */
export const DEFAULT_TIP_HEIGHT_CACHE_MS = 30_000;

/** T58 subset 6 — Default grace seconds when the operator hasn't
 * flipped `staking.lock_unlock_grace_seconds`. Matches the existing
 * default in config/default.json + the trader-loop's per-lock
 * grace math. */
export const DEFAULT_LOCK_GRACE_SECONDS = 60;

/** T58 subset 6 — Maturity bucket returned by `buildLockMaturity`. */
export const MATURITY_MATURE = 'mature';
export const MATURITY_PREMATURE = 'premature';
export const MATURITY_NEVER = 'never';
export const MATURITY_UNKNOWN = 'unknown';

/** Schema version for `/api/staking/status` responses. */
export const STAKING_STATUS_SCHEMA = 'tradebot.dashboard.staking-status/v1';

/** Default on-disk path for the alerts log. Mirrors `data/alerts.jsonl` across the codebase. */
export const DEFAULT_STAKING_ALERTS_FILE = 'data/alerts.jsonl';

/** Cap on the `recent_alerts` tail. Kept low so a single dashboard refresh
 * doesn't have to parse a multi-megabyte alerts file. */
export const DEFAULT_STAKING_ALERTS_MAX = 10;

/** AlertKind prefixes that count as "stake alerts" for the dashboard tile. */
export const STAKE_ALERT_KINDS = ['stake_locked', 'stake_unlock', 'stake_failed'];

/** Knobs surfaced on the dashboard tile. The operator flip-on/off toggle
 * calls `PUT /api/config` with these paths; the dashboard reads them
 * here so it never touches `config/user.json` directly. */
export const STAKING_KNOBS = ['enabled', 'simulation_only', 'auto_lock_enabled', 'auto_unlock_enabled'];

// ─── Error classes ──────────────────────────────────────────────────────

export class StakingStatusError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'StakingStatusError';
    if (opts && opts.cause) this.cause = opts.cause;
  }
}

export class StakingStatusConfigError extends StakingStatusError {
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = 'StakingStatusConfigError';
  }
}

// ─── Pure helpers ───────────────────────────────────────────────────────

/**
 * Coerce an unknown value into a boolean, treating only literal
 * `true` / `false` as truthy. Anything else (null / undefined /
 * 'true' / 1 / etc.) returns the supplied fallback. The dashboard
 * uses this so a missing knob renders as the default and a
 * type-coerced "truthy" string doesn't accidentally flip the
 * auto-stake mode on.
 *
 * @param {unknown} v
 * @param {boolean} fallback
 * @returns {boolean}
 */
export function asBool(v, fallback) {
  if (v === true) return true;
  if (v === false) return false;
  return fallback;
}

/**
 * Coerce an unknown value into a non-negative integer, treating
 * non-integer / negative / NaN / non-numeric input as 0. Used by
 * the dashboard to decode the `stake_blocks` field out of a lockNFT
 * commitment — a malformed commitment shows "0 blocks" rather than
 * blanking the row.
 *
 * @param {unknown} v
 * @returns {number}
 */
export function asNonNegInt(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && Number.isInteger(v)) return v;
  if (typeof v === 'string' && v.length > 0) {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0 && Number.isInteger(n)) return n;
  }
  return 0;
}

/**
 * Approximate a `stake_blocks` count into days, using the
 * BCH mainnet's ~144 blocks/day target. Pure; never throws on
 * non-finite input (returns null).
 *
 * @param {number|null|undefined} stakeBlocks
 * @returns {number|null}
 */
export function stakeBlocksToApproxDays(stakeBlocks) {
  if (!Number.isFinite(stakeBlocks) || stakeBlocks <= 0) return null;
  return Math.round((stakeBlocks / 144) * 10) / 10;
}

/**
 * Build the per-lockNFT summary rows that the Dashboard tile
 * renders. Pure: takes the already-fetched UTXOs and returns the
 * typed shape. Defensive: bad commitments become `{stake_blocks:
 * null, user_pkh_hex: null}` so the dashboard can render the row
 * without crashing the whole tile.
 *
 * T58 subset 6: each row also carries `lock_block_height`
 * (the block height when the lockNFT was committed, as decoded
 * from the on-chain UTXO shape — defaults to 0 when the wallet
 * doesn't surface it, which means "never mature" so the trader
 * loop's grace math stays conservative). The maturity helper
 * (`buildLockMaturity`) needs this field to compute
 * `blocks_remaining` + `next_mature_block`.
 *
 * @param {Array<any>} lockUtxos
 * @returns {Array<{
 *   txid: string,
 *   vout: number,
 *   value_sats: string,
 *   value_bch: number,
 *   stake_blocks: number|null,
 *   stake_blocks_approx_days: number|null,
 *   user_pkh_hex: string|null,
 *   lock_block_height: number|null,
 * }>}
 */
export function buildLockNftSummaries(lockUtxos) {
  if (!Array.isArray(lockUtxos)) return [];
  const out = [];
  for (const u of lockUtxos) {
    if (!u || typeof u !== 'object') continue;
    const txid = (typeof u.txid === 'string' && u.txid.length > 0) ? u.txid : (typeof u.tx_hash === 'string' ? u.tx_hash : '');
    const vout = (typeof u.vout === 'number' && Number.isInteger(u.vout) && u.vout >= 0) ? u.vout
      : (typeof u.index === 'number' && Number.isInteger(u.index) && u.index >= 0) ? u.index
      : 0;
    const valueSats = (() => {
      try {
        return getSatoshis(u).toString();
      } catch {
        return '0';
      }
    })();
    const valueBch = Number(valueSats) / Number(SATS_PER_BCH);
    let stakeBlocks = null;
    let userPkhHex = null;
    try {
      const commitment = getCommitment(u);
      if (typeof commitment === 'string' && commitment.length > 0) {
        const decoded = decodeLockNftCommitment(commitment);
        stakeBlocks = asNonNegInt(decoded.stakeBlocks);
        userPkhHex = (typeof decoded.userPkhHex === 'string') ? decoded.userPkhHex : null;
        if (stakeBlocks === 0) stakeBlocks = null;
      }
    } catch {
      // Malformed commitment — leave stakeBlocks + userPkhHex as null.
    }
    // T58 subset 6: the libauth wallet's `lockUtxo.lockBlockHeight`
    // is the block height when the lockNFT was committed; the
    // trader loop reads it as `lockUtxo.lockBlockHeight ?? 0`. We
    // default to `null` here so the maturity helper can render
    // an "unknown lock_block_height" pill instead of falsely
    // claiming the lock started at genesis (which would
    // immediately read as "mature" and confuse the operator).
    const lockBlockHeight = (typeof u.lockBlockHeight === 'number' && Number.isInteger(u.lockBlockHeight) && u.lockBlockHeight >= 0)
      ? u.lockBlockHeight
      : (typeof u.lock_block_height === 'number' && Number.isInteger(u.lock_block_height) && u.lock_block_height >= 0)
        ? u.lock_block_height
        : null;
    out.push({
      txid,
      vout,
      value_sats: valueSats,
      value_bch: valueBch,
      stake_blocks: stakeBlocks,
      stake_blocks_approx_days: stakeBlocksToApproxDays(stakeBlocks),
      user_pkh_hex: userPkhHex,
      lock_block_height: lockBlockHeight,
    });
  }
  return out;
}

/**
 * T58 subset 6 — convert a grace-seconds knob value into the
 * equivalent block count at the BCH target cadence
 * (~600s/block on mainnet). Mirrors the trader-loop's
 * `Math.ceil(graceSeconds / 600)` math in `src/trader/loop.mjs` so
 * the dashboard and the trader loop can never disagree about
 * "when does this lock mature?". Defensive: negative / NaN /
 * non-numeric inputs coerce to 0 (so a missing knob produces a
 * *stricter* check, not a permissive one).
 *
 * @param {unknown} graceSeconds
 * @returns {number}
 */
export function graceSecondsToBlocks(graceSeconds) {
  const n = (typeof graceSeconds === 'number' && Number.isFinite(graceSeconds)) ? graceSeconds : Number(graceSeconds);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.ceil(n / 600);
}

/**
 * T58 subset 6 — compute the maturity envelope for a single
 * lockNFT, given its decoded timelock + the current chain tip.
 * Pure; defensive about every input. Returns the typed shape
 * that the React tile renders as a countdown pill + a
 * progress bar.
 *
 *   maturity = 'mature'     — blocksElapsed >= stakeBlocks + graceBlocks
 *   maturity = 'premature'  — stakeBlocks known + tipHeight > lockBlockHeight + 0 < blocksRemaining
 *   maturity = 'never'      — stakeBlocks known + tipHeight <= lockBlockHeight + stakeBlocks=0
 *                             (the lock's effective start is in the future OR the timelock is
 *                             zero blocks — same outcome from the dashboard's POV)
 *   maturity = 'unknown'    — stakeBlocks missing / tipHeight missing / lockBlockHeight missing
 *
 * `blocks_remaining` is `Math.max(0, next_mature_block - tip_height)`
 * so the React pill can render "READY NOW (0 blocks)" without
 * returning a negative number. `percent_complete` is the
 * fraction of `stakeBlocks + graceBlocks` that has elapsed,
 * clamped to [0, 1] so a fresh lock renders 0% and a long-
 * running lock renders 100% once mature.
 *
 * @param {Object} params
 * @param {number|null|undefined} params.stakeBlocks
 * @param {number|null|undefined} params.lockBlockHeight
 * @param {number|null|undefined} params.tipHeight
 * @param {number} [params.graceBlocks=0]
 * @param {number} [params.blocksPerDay=BCH_BLOCKS_PER_DAY]
 * @returns {{
 *   maturity: 'mature'|'premature'|'never'|'unknown',
 *   next_mature_block: number|null,
 *   blocks_remaining: number,
 *   approx_seconds_remaining: number,
 *   percent_complete: number,
 * }}
 */
export function buildLockMaturity({ stakeBlocks, lockBlockHeight, tipHeight, graceBlocks = 0, blocksPerDay = BCH_BLOCKS_PER_DAY } = {}) {
  // Use a stricter coerce that returns `null` for invalid input
  // (so we can distinguish "unknown" from "0 blocks"). Tolerates
  // numeric strings ('100' -> 100) since the libauth wallet's
  // `lockUtxo.lockBlockHeight` can arrive as a string-coerced
  // number when callers serialise the UTXO through JSON.
  const coerceNonNegInt = (v) => {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && Number.isInteger(v)) return v;
    if (typeof v === 'string' && v.length > 0) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0 && Number.isInteger(n)) return n;
    }
    return null;
  };
  const sb = coerceNonNegInt(stakeBlocks);
  const lbh = coerceNonNegInt(lockBlockHeight);
  const tip = coerceNonNegInt(tipHeight);
  const gb = (typeof graceBlocks === 'number' && Number.isFinite(graceBlocks) && graceBlocks >= 0) ? Math.floor(graceBlocks) : 0;
  const bpd = (typeof blocksPerDay === 'number' && Number.isFinite(blocksPerDay) && blocksPerDay > 0) ? blocksPerDay : BCH_BLOCKS_PER_DAY;

  // Not enough info to compute maturity — every field falls back to a
  // safe default so the React tile can render "unknown" without crashing.
  if (sb === null || lbh === null || tip === null) {
    return {
      maturity: MATURITY_UNKNOWN,
      next_mature_block: null,
      blocks_remaining: 0,
      approx_seconds_remaining: 0,
      percent_complete: 0,
    };
  }

  // `stakeBlocks === 0` — the lock has no timelock. Treat as
  // "immediately mature" from the dashboard's POV; the trader
  // loop's actual `executeUnlock` path is what enforces the
  // graceBlocks buffer.
  if (sb === 0) {
    return {
      maturity: MATURITY_MATURE,
      next_mature_block: lbh,
      blocks_remaining: 0,
      approx_seconds_remaining: 0,
      percent_complete: 1,
    };
  }

  const totalBlocksNeeded = sb + gb;
  const nextMatureBlock = lbh + totalBlocksNeeded;
  const blocksElapsed = tip - lbh;
  const blocksRemainingRaw = nextMatureBlock - tip;
  const blocksRemaining = blocksRemainingRaw > 0 ? blocksRemainingRaw : 0;
  // BCH mainnet target is 600s/block; multiply by the blocksPerDay
  // knob if the operator retunes it. Floor to integer seconds so
  // the React pill renders whole numbers.
  const approxSecondsRemaining = blocksRemaining * Math.round(86_400 / bpd);
  const percentRaw = totalBlocksNeeded > 0 ? (blocksElapsed / totalBlocksNeeded) : 0;
  const percentComplete = Math.max(0, Math.min(1, percentRaw));

  // Tip is below the lock's start height — the lock is in the
  // future relative to the chain (shouldn't happen on mainnet,
  // but defensive for chipnet / regtest / clock-skew edge cases).
  if (tip < lbh) {
    return {
      maturity: MATURITY_NEVER,
      next_mature_block: nextMatureBlock,
      blocks_remaining: nextMatureBlock - tip,
      approx_seconds_remaining: (nextMatureBlock - tip) * Math.round(86_400 / bpd),
      percent_complete: 0,
    };
  }

  if (blocksRemaining === 0) {
    return {
      maturity: MATURITY_MATURE,
      next_mature_block: nextMatureBlock,
      blocks_remaining: 0,
      approx_seconds_remaining: 0,
      percent_complete: Math.max(percentComplete, 1),
    };
  }

  return {
    maturity: MATURITY_PREMATURE,
    next_mature_block: nextMatureBlock,
    blocks_remaining: blocksRemaining,
    approx_seconds_remaining: approxSecondsRemaining,
    percent_complete: percentComplete,
  };
}

/**
 * T58 subset 6 — map over the lockItem rows and decorate each
 * with the maturity envelope. Pure: takes the already-built
 * items + the already-fetched tipHeight + the grace-seconds
 * knob and returns a NEW array (the caller is responsible for
 * not mutating the source items). Items missing the maturity
 * inputs (no stake_blocks / no lock_block_height) get an
 * `maturity: 'unknown'` envelope so the React tile can render
 * a neutral pill without crashing the row.
 *
 * The dashboard fetches the tipHeight ONCE per request via
 * `withCachedTipHeight`, then maps over every item — so a
 * wallet with 5 lockNFTs doesn't pay for 5 chain-tip round
 * trips.
 *
 * @param {Object} params
 * @param {Array<{stake_blocks: number|null, lock_block_height: number|null}>} params.items
 * @param {number|null|undefined} params.tipHeight
 * @param {number} [params.graceSeconds=DEFAULT_LOCK_GRACE_SECONDS]
 * @param {number} [params.blocksPerDay=BCH_BLOCKS_PER_DAY]
 * @returns {Array<Object>}
 */
export function summarizeLockMaturities({ items, tipHeight, graceSeconds = DEFAULT_LOCK_GRACE_SECONDS, blocksPerDay = BCH_BLOCKS_PER_DAY } = {}) {
  if (!Array.isArray(items)) return [];
  const gb = graceSecondsToBlocks(graceSeconds);
  return items.map((it) => {
    if (!it || typeof it !== 'object') {
      return {
        maturity: MATURITY_UNKNOWN,
        next_mature_block: null,
        blocks_remaining: 0,
        approx_seconds_remaining: 0,
        percent_complete: 0,
      };
    }
    const mat = buildLockMaturity({
      stakeBlocks: it.stake_blocks,
      lockBlockHeight: it.lock_block_height,
      tipHeight,
      graceBlocks: gb,
      blocksPerDay,
    });
    return { ...it, ...mat };
  });
}

/**
 * Filter an alerts-log array down to the stake-relevant kinds.
 * Pure; defensive about non-array input.
 *
 * @param {Array<any>} events
 * @returns {Array<any>}
 */
export function filterStakeAlerts(events) {
  if (!Array.isArray(events)) return [];
  const out = [];
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    if (typeof e.kind !== 'string') continue;
    if (!STAKE_ALERT_KINDS.includes(e.kind)) continue;
    out.push(e);
  }
  // Newest first — the dashboard renders a tail so the operator
  // sees the most recent dispatch at the top.
  out.sort((a, b) => {
    const at = (typeof a.ts === 'number') ? a.ts : Date.parse(a.ts ?? '');
    const bt = (typeof b.ts === 'number') ? b.ts : Date.parse(b.ts ?? '');
    if (!Number.isFinite(at) && !Number.isFinite(bt)) return 0;
    if (!Number.isFinite(at)) return 1;
    if (!Number.isFinite(bt)) return -1;
    return bt - at;
  });
  return out;
}

/**
 * Pick the four operator-facing staking knobs out of the merged
 * cfg. Pure; returns the typed shape with safe defaults so a
 * missing `cfg.staking` block renders as "all off" rather than
 * crashing.
 *
 * @param {Object|null|undefined} cfg
 * @returns {{
 *   enabled: boolean,
 *   simulation_only: boolean,
 *   auto_lock_enabled: boolean,
 *   auto_unlock_enabled: boolean,
 * }}
 */
export function summarizeKnobs(cfg) {
  const staking = (cfg && typeof cfg === 'object' && cfg.staking && typeof cfg.staking === 'object')
    ? cfg.staking
    : {};
  return {
    enabled: asBool(staking.enabled, false),
    simulation_only: asBool(staking.simulation_only, true),
    auto_lock_enabled: asBool(staking.auto_lock_enabled, false),
    auto_unlock_enabled: asBool(staking.auto_unlock_enabled, false),
  };
}

/**
 * Build the typed response envelope. Pure — caller supplies the
 * already-computed pieces and we shape the wire format. Mirrors
 * the `alerts-recent/v1` + `risk-panel/v1` schema patterns so
 * `fetchStakingStatus`-style clients can version-check.
 *
 * T58 subset 6: response now carries `tip_height` /
 * `tip_height_fetched_at` / `tip_height_age_ms` /
 * `tip_height_source` + `tip_height_error` so the React tile can
 * render the chain-tip pill (and so the operator can tell at a
 * glance whether the dashboard is talking to the chain or
 * showing stale data). All four are optional — if the caller
 * (e.g. an old test) doesn't pass them, the response still
 * round-trips a `{tip_height: null, ...}` envelope so client
 * parsers don't break.
 *
 * @param {Object} parts
 * @param {number} parts.nowMs
 * @param {boolean} parts.walletConfigured
 * @param {Object} parts.lockNfts
 * @param {Object} parts.knobs
 * @param {Array<any>} parts.recentAlerts
 * @param {Array<{file:string,line:number,error:string}>} parts.loadErrors
 * @param {string} [parts.alertsSource]
 * @param {Object} [parts.tipHeight]        T58 subset 6 — { tipHeight, fetchedAtMs, ageMs, source, error }
 * @returns {Object}
 */
export function buildStakingStatusResponse(parts = {}) {
  const nowMs = Number.isFinite(parts.nowMs) ? parts.nowMs : Date.now();
  const t = (parts.tipHeight && typeof parts.tipHeight === 'object') ? parts.tipHeight : {};
  return {
    schema: STAKING_STATUS_SCHEMA,
    ts: new Date(nowMs).toISOString(),
    wallet_configured: parts.walletConfigured === true,
    lockNfts: parts.lockNfts ?? { count: 0, total_bch: 0, total_bch_sats: '0', items: [], error: null },
    knobs: parts.knobs ?? summarizeKnobs({}),
    recent_alerts: Array.isArray(parts.recentAlerts) ? parts.recentAlerts : [],
    recent_alerts_source: (typeof parts.alertsSource === 'string' && parts.alertsSource.length > 0)
      ? parts.alertsSource
      : DEFAULT_STAKING_ALERTS_FILE,
    load_errors: Array.isArray(parts.loadErrors) ? parts.loadErrors : [],
    tip_height: (typeof t.tipHeight === 'number' && Number.isFinite(t.tipHeight) && t.tipHeight >= 0) ? Math.floor(t.tipHeight) : null,
    tip_height_fetched_at: (typeof t.fetchedAtMs === 'number' && Number.isFinite(t.fetchedAtMs) && t.fetchedAtMs > 0)
      ? new Date(t.fetchedAtMs).toISOString()
      : null,
    tip_height_age_ms: (typeof t.ageMs === 'number' && Number.isFinite(t.ageMs) && t.ageMs >= 0) ? Math.floor(t.ageMs) : null,
    tip_height_source: (typeof t.source === 'string' && t.source.length > 0) ? t.source : 'unavailable',
    tip_height_error: (typeof t.error === 'string' && t.error.length > 0) ? t.error : null,
  };
}

// ─── I/O wrapper ────────────────────────────────────────────────────────

/**
 * Fetch the lockNFT UTXO set from `ctx.wallet.listUtxos()`,
 * filter down to lockNFT-shaped UTXOs (via the Badger masterCat +
 * capability + commitment-length heuristic), and sum / shape the
 * results.
 *
 * Defensive: any failure (wallet not wired, Electrum outage, UTXO
 * shape not an array) becomes a typed `{ count:0, total_bch:0,
 * total_bch_sats:'0', items:[], error:<msg> }` so the dashboard
 * can render an "unavailable" pill without crashing the tile.
 *
 * @param {Object|null|undefined} wallet
 * @param {{info?: Function, warn?: Function}|null} [logger]
 * @returns {Promise<{
 *   count: number,
 *   total_bch: number,
 *   total_bch_sats: string,
 *   items: Array<any>,
 *   error: string|null,
 * }>}
 */
export async function fetchLockNftUtxos(wallet, logger = null) {
  const safeInfo = (logger && typeof logger.info === 'function') ? logger.info.bind(logger) : () => {};
  const safeWarn = (logger && typeof logger.warn === 'function') ? logger.warn.bind(logger) : () => {};

  if (!wallet || typeof wallet.listUtxos !== 'function') {
    return { count: 0, total_bch: 0, total_bch_sats: '0', items: [], error: 'wallet_not_configured' };
  }

  let utxos;
  try {
    utxos = await wallet.listUtxos();
  } catch (e) {
    const msg = (e && typeof e === 'object' && typeof e.message === 'string') ? e.message : String(e);
    safeWarn('dashboard.staking.status.listUtxos.failed', {
      err_name: e?.name ?? 'Error',
      err_message: msg,
    });
    return { count: 0, total_bch: 0, total_bch_sats: '0', items: [], error: `wallet_utxo_lookup_failed: ${msg}` };
  }

  if (!Array.isArray(utxos)) {
    safeWarn('dashboard.staking.status.listUtxos.not_array', {
      utxo_type: typeof utxos,
    });
    return { count: 0, total_bch: 0, total_bch_sats: '0', items: [], error: 'wallet_listUtxos_returned_non_array' };
  }

  // Filter down to lockNFT-shaped UTXOs. We reuse the same
  // heuristic as `countLockNfts` (masterCat + capability +
  // commitment-length) so the dashboard and the trader loop can
  // never disagree about what counts as a lockNFT.
  const lockUtxos = [];
  let totalSats = 0n;
  for (const u of utxos) {
    if (!u || typeof u !== 'object') continue;
    const tc = (typeof u.token?.category === 'string') ? u.token.category.toLowerCase() : '';
    const cap = u.token?.capability;
    const cmt = (typeof u.token?.commitment === 'string') ? u.token.commitment.toLowerCase() : '';
    if (typeof tc !== 'string' || tc.length < 64) continue;
    // MASTER_CAT prefix check (32-byte cat id is 64 hex chars;
    // the Badger stake contract emits lockNFTs whose category is
    // exactly MASTER_CAT, so we compare the full 64-char prefix).
    if (tc.slice(0, 64) !== 'd7ff0a63d5c1cbe1ced509314fe3caca563a73095be37734744c40dbce6e2f24') continue;
    if (cap !== 'mutable' && cap !== '0x01' && cap !== 1) continue;
    if (cmt.length !== 80) continue;
    lockUtxos.push(u);
    totalSats += getSatoshis(u);
  }

  const items = buildLockNftSummaries(lockUtxos);
  const totalBch = Number(totalSats) / Number(SATS_PER_BCH);
  safeInfo('dashboard.staking.status.lockNfts', {
    event: 'dashboard.staking.status',
    lock_nft_count: items.length,
    total_bch: totalBch,
  });
  return {
    count: items.length,
    total_bch: totalBch,
    total_bch_sats: totalSats.toString(),
    items,
    error: null,
  };
}

/**
 * Read + filter the alerts log down to the stake-relevant tail.
 * Pure-ish — only I/O is `readNdjsonFile`, which handles ENOENT
 * cleanly. Returns `{ alerts, loadErrors }`; the caller shapes
 * the wire envelope.
 *
 * @param {Object} opts
 * @param {string} [opts.file]
 * @param {number} [opts.max]
 * @param {{warn?: Function}|null} [opts.logger]
 * @returns {Promise<{
 *   alerts: Array<any>,
 *   loadErrors: Array<{file:string,line:number,error:string}>,
 * }>}
 */
export async function loadStakeAlertsTail({ file, max, logger = null } = {}) {
  const targetFile = (typeof file === 'string' && file.length > 0) ? file : DEFAULT_STAKING_ALERTS_FILE;
  const targetMax = (Number.isFinite(max) && max > 0) ? Math.floor(max) : DEFAULT_STAKING_ALERTS_MAX;
  const safeWarn = (logger && typeof logger.warn === 'function') ? logger.warn.bind(logger) : () => {};

  let allEvents = [];
  let loadErrors = [];
  try {
    const { lines, errors } = await readNdjsonFile(targetFile);
    allEvents = lines;
    loadErrors = errors;
  } catch (e) {
    if (e && typeof e === 'object' && /** @type {any} */ (e).code === 'ENOENT') {
      // Cold-start bot — no alerts yet. Return empty tail.
      return { alerts: [], loadErrors: [] };
    }
    const msg = (e && typeof e === 'object' && typeof e.message === 'string') ? e.message : String(e);
    safeWarn('dashboard.staking.status.alerts_read.failed', {
      err_name: e?.name ?? 'Error',
      err_message: msg,
    });
    return { alerts: [], loadErrors: [{ file: targetFile, line: 0, error: msg }] };
  }

  const filtered = filterStakeAlerts(allEvents);
  return { alerts: filtered.slice(0, targetMax), loadErrors };
}

/**
 * Build the typed response envelope for `GET /api/staking/status`.
 * I/O wrapper: fetches the lockNFT UTXOs, reads the alerts tail,
 * pulls the cached chain tip, and shapes the wire envelope
 * using the pure helpers.
 *
 * T58 subset 6: the tip-height pull + the maturity-summary
 * projection happen HERE (not in `fetchLockNftUtxos`) because
 * the maturity math depends on the tip-height being known
 * first, AND the tip-height cache is shared across requests
 * (see `_tipHeightCache`). Splitting it across the two
 * functions would either double-fetch or force us to thread
 * the tip through every call.
 *
 * Error model:
 *   - missing `ctx` / `ctx.cfg` → 500-shaped throw (caller maps to
 *     a typed 500 response). The dashboard renders an error pill.
 *   - wallet-not-wired → graceful degrade (`lockNfts.error: 'wallet_not_configured'`).
 *   - alerts log missing → graceful degrade (empty tail).
 *   - tip-height fetcher missing / threw → graceful degrade
 *     (`tip_height_source: 'unavailable'`, every item gets
 *     `maturity: 'unknown'`). The tile renders "tip: unavailable"
 *     + a neutral pill for every lock.
 *
 * @param {Object} ctx
 * @returns {Promise<Object>}
 */
export async function buildStakingStatus(ctx) {
  if (!ctx || typeof ctx !== 'object') {
    throw new StakingStatusConfigError('buildStakingStatus: ctx required');
  }
  if (!ctx.cfg || typeof ctx.cfg !== 'object') {
    throw new StakingStatusConfigError('buildStakingStatus: ctx.cfg required');
  }
  const nowMs = (typeof ctx.clock === 'function') ? ctx.clock() : Date.now();
  const wallet = ctx.wallet ?? null;
  const walletConfigured = !!(wallet && typeof wallet.listUtxos === 'function');

  const alertsFile = (typeof ctx.alertsFile === 'string' && ctx.alertsFile.length > 0)
    ? ctx.alertsFile
    : DEFAULT_STAKING_ALERTS_FILE;
  const alertsMax = (Number.isFinite(ctx.alertsMax) && ctx.alertsMax > 0)
    ? ctx.alertsMax
    : DEFAULT_STAKING_ALERTS_MAX;
  const tipCacheMs = (Number.isFinite(ctx.tipHeightCacheMs) && ctx.tipHeightCacheMs > 0)
    ? Math.floor(ctx.tipHeightCacheMs)
    : DEFAULT_TIP_HEIGHT_CACHE_MS;
  const graceSeconds = (ctx.cfg && ctx.cfg.staking && Number.isFinite(ctx.cfg.staking.lock_unlock_grace_seconds))
    ? ctx.cfg.staking.lock_unlock_grace_seconds
    : DEFAULT_LOCK_GRACE_SECONDS;

  // Fetch the lockNFT UTXOs + alerts tail + tip-height in parallel.
  // The tip-height cache means the chain call is amortised across
  // requests; in steady-state only the first dashboard refresh
  // after the TTL expires actually round-trips to Electrum.
  const [lockNfts, tail, tip] = await Promise.all([
    fetchLockNftUtxos(wallet, ctx.logger ?? null),
    loadStakeAlertsTail({ file: alertsFile, max: alertsMax, logger: ctx.logger ?? null }),
    withCachedTipHeight({
      wallet,
      nowMs,
      cacheMs: tipCacheMs,
      logger: ctx.logger ?? null,
    }),
  ]);

  // Decorate each lockItem with the maturity envelope. The pure
  // helper is a no-op for items missing the maturity inputs (the
  // React tile gets `maturity:'unknown'` + a neutral pill).
  if (lockNfts && Array.isArray(lockNfts.items)) {
    lockNfts.items = summarizeLockMaturities({
      items: lockNfts.items,
      tipHeight: tip.tipHeight,
      graceSeconds,
    });
  }

  return buildStakingStatusResponse({
    nowMs,
    walletConfigured,
    lockNfts,
    knobs: summarizeKnobs(ctx.cfg),
    recentAlerts: tail.alerts,
    loadErrors: tail.loadErrors,
    alertsSource: alertsFile,
    tipHeight: tip,
  });
}

// ─── Tip-height cache (T58 subset 6) ──────────────────────────────────────

/**
 * T58 subset 6 — module-scoped in-memory cache for the chain
 * tip height. The dashboard's `GET /api/staking/status`
 * endpoint can be hit on every refresh tick (default 60s); we
 * don't want to round-trip to Electrum each time just to know
 * the tip. The cache is keyed only by epoch — the wallet is
 * the dashboard's, the operator runs a single dashboard at a
 * time, so a single key suffices.
 *
 * Cache shape:
 *   { tipHeight: <number>, fetchedAtMs: <number>, lastError: <string|null> }
 *
 * `lastError` is held so a transient Electrum outage doesn't
 * silently turn into "always unavailable" — the next successful
 * fetch overwrites it. The cache is reset via `resetTipHeightCache`
 * so tests can start from a clean slate without leaking state
 * across runs.
 *
 * @type {{ tipHeight: number|null, fetchedAtMs: number, lastError: string|null }}
 */
const _tipHeightCache = {
  tipHeight: null,
  fetchedAtMs: 0,
  lastError: null,
};

/**
 * T58 subset 6 — reset the module-scoped tip-height cache.
 * Exported so the test suite can ensure isolation across cases
 * (one test's stale tip height doesn't leak into the next).
 */
export function resetTipHeightCache() {
  _tipHeightCache.tipHeight = null;
  _tipHeightCache.fetchedAtMs = 0;
  _tipHeightCache.lastError = null;
}

/**
 * T58 subset 6 — fetch the current chain tip from the wallet
 * (or a custom fetcher for tests), with a TTL-bounded cache so
 * repeated dashboard refreshes don't hammer Electrum.
 *
 *   source: 'fresh'      — just fetched, tipHeight is the new value
 *   source: 'cache'      — cache hit (within `cacheMs`), tipHeight is the cached value
 *   source: 'unavailable'— fetcher missing OR fetcher threw; tipHeight is null
 *
 * Returns a typed envelope so the caller can populate the
 * response's `tip_height` / `tip_height_fetched_at` /
 * `tip_height_age_ms` / `tip_height_source` fields without
 * re-deriving the math. The cache writes happen after the
 * fetcher resolves — a throw leaves the previous cache value
 * in place (so a single failed Electrum call doesn't wipe the
 * last-known good tip).
 *
 * @param {Object} opts
 * @param {Object|null|undefined} opts.wallet
 * @param {Function} [opts.getTipHeight]  custom fetcher — tests inject this.
 *                                        Defaults to `wallet.getBlockHeight()`
 *                                        when wallet has that method.
 * @param {number} [opts.nowMs]           injected for tests; defaults to Date.now()
 * @param {number} [opts.cacheMs=DEFAULT_TIP_HEIGHT_CACHE_MS]
 * @param {{warn?: Function}|null} [opts.logger]
 * @returns {Promise<{ tipHeight: number|null, fetchedAtMs: number, ageMs: number, source: 'fresh'|'cache'|'unavailable', error: string|null }>}
 */
export async function withCachedTipHeight({ wallet = null, getTipHeight = null, nowMs = null, cacheMs = DEFAULT_TIP_HEIGHT_CACHE_MS, logger = null } = {}) {
  const safeWarn = (logger && typeof logger.warn === 'function') ? logger.warn.bind(logger) : () => {};
  const ts = (typeof nowMs === 'number' && Number.isFinite(nowMs)) ? nowMs : Date.now();
  const ttl = (typeof cacheMs === 'number' && Number.isFinite(cacheMs) && cacheMs > 0) ? Math.floor(cacheMs) : DEFAULT_TIP_HEIGHT_CACHE_MS;

  // Pick the fetcher: explicit injection wins, then wallet.getBlockHeight,
  // then 'unavailable'. We don't fall back to anything that could
  // accidentally talk to a different wallet.
  let fetcher = null;
  if (typeof getTipHeight === 'function') fetcher = getTipHeight;
  else if (wallet && typeof wallet.getBlockHeight === 'function') fetcher = () => wallet.getBlockHeight();

  // Cache hit — within TTL + previous fetch was successful.
  if (_tipHeightCache.tipHeight !== null && _tipHeightCache.lastError === null && (ts - _tipHeightCache.fetchedAtMs) < ttl) {
    return {
      tipHeight: _tipHeightCache.tipHeight,
      fetchedAtMs: _tipHeightCache.fetchedAtMs,
      ageMs: Math.max(0, ts - _tipHeightCache.fetchedAtMs),
      source: 'cache',
      error: null,
    };
  }

  // Cache miss (or stale) — fetch fresh.
  if (!fetcher) {
    _tipHeightCache.lastError = 'tip_height_fetcher_unavailable';
    return {
      tipHeight: null,
      fetchedAtMs: ts,
      ageMs: 0,
      source: 'unavailable',
      error: _tipHeightCache.lastError,
    };
  }

  try {
    const height = await fetcher();
    if (typeof height !== 'number' || !Number.isFinite(height) || height < 0 || !Number.isInteger(height)) {
      _tipHeightCache.lastError = `tip_height_invalid:${typeof height}`;
      safeWarn('dashboard.staking.status.tip_height.invalid', {
        height_type: typeof height,
        height_value: String(height),
      });
      return {
        tipHeight: _tipHeightCache.tipHeight, // keep stale value
        fetchedAtMs: _tipHeightCache.fetchedAtMs || ts,
        ageMs: _tipHeightCache.fetchedAtMs ? Math.max(0, ts - _tipHeightCache.fetchedAtMs) : 0,
        source: 'unavailable',
        error: _tipHeightCache.lastError,
      };
    }
    _tipHeightCache.tipHeight = height;
    _tipHeightCache.fetchedAtMs = ts;
    _tipHeightCache.lastError = null;
    return {
      tipHeight: height,
      fetchedAtMs: ts,
      ageMs: 0,
      source: 'fresh',
      error: null,
    };
  } catch (e) {
    const msg = (e && typeof e === 'object' && typeof e.message === 'string') ? e.message : String(e);
    _tipHeightCache.lastError = `tip_height_fetch_failed:${msg}`;
    safeWarn('dashboard.staking.status.tip_height.failed', {
      err_name: e?.name ?? 'Error',
      err_message: msg,
    });
    return {
      tipHeight: _tipHeightCache.tipHeight, // keep stale value
      fetchedAtMs: _tipHeightCache.fetchedAtMs || ts,
      ageMs: _tipHeightCache.fetchedAtMs ? Math.max(0, ts - _tipHeightCache.fetchedAtMs) : 0,
      source: 'unavailable',
      error: _tipHeightCache.lastError,
    };
  }
}

/**
 * T58 subset 6 — severity bucket for the tip-height pill on the
 * React tile. Mirrors the patterns in
 * `risk-panel-helpers.mjs` so the operator gets a familiar
 * visual vocabulary.
 *
 *   fresh         — source='fresh' OR (source='cache' AND age < 2x cache TTL)
 *   stale         — source='cache' AND age >= 2x cache TTL
 *   unavailable   — source='unavailable' (wallet not wired OR fetcher threw)
 *   unknown       — defensive fallback
 *
 * @param {{ source: string, ageMs: number, tipHeight: number|null }|null|undefined} sample
 * @param {number} [staleMs]
 * @returns {'fresh'|'stale'|'unavailable'|'unknown'}
 */
export function tipHeightSeverity(sample, staleMs = DEFAULT_TIP_HEIGHT_CACHE_MS * 2) {
  if (!sample || typeof sample !== 'object') return 'unknown';
  if (sample.source === 'unavailable') return 'unavailable';
  if (sample.source === 'fresh') return 'fresh';
  if (sample.source === 'cache') {
    if (typeof sample.ageMs !== 'number' || !Number.isFinite(sample.ageMs)) return 'unknown';
    if (sample.ageMs >= staleMs) return 'stale';
    return 'fresh';
  }
  return 'unknown';
}

// ─── Test seam ──────────────────────────────────────────────────────────

export const _internals = {
  STAKE_ALERT_KINDS,
  STAKING_KNOBS,
  DEFAULT_STAKING_ALERTS_FILE,
  DEFAULT_STAKING_ALERTS_MAX,
  STAKING_STATUS_SCHEMA,
  BCH_BLOCKS_PER_DAY,
  DEFAULT_TIP_HEIGHT_CACHE_MS,
  DEFAULT_LOCK_GRACE_SECONDS,
  MATURITY_MATURE,
  MATURITY_PREMATURE,
  MATURITY_NEVER,
  MATURITY_UNKNOWN,
};
