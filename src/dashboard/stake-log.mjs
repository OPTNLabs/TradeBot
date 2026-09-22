#!/usr/bin/env node
// src/dashboard/stake-log.mjs
//
// T70-3 — `GET /api/staking/log` handler. Returns the most-recent
// stake-attempt rows from `data/stake-attempts.jsonl` so the
// Dashboard's "BadgerCoin Staking" card can show a collapsible
// status div at the bottom (operator's request 2026-09-20).
//
// Wire shape (consumed by `dashboard/src/views/staking-status-helpers.mjs`):
//
//   {
//     schema: 'tradebot.dashboard.staking-log/v1',
//     ts: <iso>,
//     file: <string>,                  // resolved NDJSON path
//     attempts: [
//       {
//         v: 1,
//         ts: <iso>,
//         ts_ms: <number>,
//         tick_id: <number|null>,
//         kind: 'lock'|'unlock',
//         phase: 'attempt'|'success'|'failed',
//         ok: <bool>,
//         txid: <string|null>,
//         code: <string|null>,
//         error: <string|null>,
//         amount_sats: <bigint-as-string|null>,
//         stake_blocks: <number|null>,
//         lock_utxo: <string|null>,
//         wallet_balance_sats: <bigint-as-string|null>,
//         contract_address: <string|null>,
//         tried: <array|null>,
//       },
//       ...
//     ],
//     count: <number>,                  // attempts.length
//     max: <number>,                    // cap used
//     load_errors: [
//       { file, line, error }
//     ],
//     config: {
//       attempt_log_file: <string|null>,
//       attempt_log_max: <number|null>,
//     },
//   }

import {
  DEFAULT_STAKE_ATTEMPT_LOG_FILE,
  DEFAULT_STAKE_ATTEMPT_LOG_TAIL,
  readStakeAttemptsTail,
} from '../staking/stake-attempt-log.mjs';

export const STAKING_LOG_SCHEMA = 'tradebot.dashboard.staking-log/v1';

/**
 * Build the typed response envelope for `GET /api/staking/log`.
 * I/O wrapper: reads the NDJSON tail + shapes the wire envelope
 * using `readStakeAttemptsTail` (which already handles ENOENT +
 * per-line parse errors).
 *
 * Defensive:
 * - Missing `ctx.cfg` → throws `StakingLogConfigError`.
 * - File doesn't exist (cold-start bot) → graceful degrade
 *   (empty tail + `load_errors:[]`).
 * - Invalid `limit` query param → falls back to the
 *   `cfg.staking.attempt_log_max` knob, then to
 *   `DEFAULT_STAKE_ATTEMPT_LOG_TAIL`.
 *
 * @param {Object} ctx
 * @param {Object} ctx.cfg
 * @param {Object} [ctx.url]
 * @param {Object} [ctx.clock]
 * @returns {Promise<Object>}
 */
export async function buildStakingLogResponse(ctx) {
  if (!ctx || typeof ctx !== 'object') {
    const err = new Error('buildStakingLogResponse: ctx required');
    err.name = 'StakingLogConfigError';
    throw err;
  }
  if (!ctx.cfg || typeof ctx.cfg !== 'object') {
    const err = new Error('buildStakingLogResponse: ctx.cfg required');
    err.name = 'StakingLogConfigError';
    throw err;
  }
  const nowMs = (typeof ctx.clock === 'function') ? ctx.clock() : Date.now();
  // Resolve file path: query-string ?file= override → cfg knob → default.
  const cfgFile = (ctx.cfg.staking && typeof ctx.cfg.staking.attempt_log_file === 'string')
    ? ctx.cfg.staking.attempt_log_file
    : null;
  let file = DEFAULT_STAKE_ATTEMPT_LOG_FILE;
  try {
    const url = ctx.url;
    if (url && typeof URL !== 'undefined' && typeof url === 'object' && url.searchParams) {
      const q = url.searchParams.get('file');
      if (typeof q === 'string' && q.length > 0 && q.length < 1024) file = q;
    }
  } catch {
    /* swallow — query-param override is best-effort */
  }
  if (file === DEFAULT_STAKE_ATTEMPT_LOG_FILE && cfgFile) file = cfgFile;
  // Resolve max: query-string ?limit= override → cfg knob → default.
  const cfgMax = (ctx.cfg.staking && Number.isFinite(ctx.cfg.staking.attempt_log_max))
    ? ctx.cfg.staking.attempt_log_max
    : null;
  let max = cfgMax ?? DEFAULT_STAKE_ATTEMPT_LOG_TAIL;
  try {
    const url = ctx.url;
    if (url && typeof URL !== 'undefined' && typeof url === 'object' && url.searchParams) {
      const q = url.searchParams.get('limit');
      if (typeof q === 'string' && q.length > 0) {
        const n = Number(q);
        if (Number.isFinite(n) && n > 0) max = Math.floor(n);
      }
    }
  } catch {
    /* swallow */
  }
  // Clamp to a sane upper bound so a malformed query can't ask for 1B rows.
  const cappedMax = Math.min(Math.max(1, max), 500);
  const tail = await readStakeAttemptsTail({ file, max: cappedMax });
  return {
    schema: STAKING_LOG_SCHEMA,
    ts: new Date(nowMs).toISOString(),
    file,
    attempts: tail.attempts,
    count: tail.attempts.length,
    max: cappedMax,
    load_errors: tail.loadErrors,
    config: {
      attempt_log_file: cfgFile,
      attempt_log_max: cfgMax,
    },
  };
}
