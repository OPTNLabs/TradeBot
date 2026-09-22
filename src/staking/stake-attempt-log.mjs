#!/usr/bin/env node
// src/staking/stake-attempt-log.mjs
//
// T70-3 — NDJSON audit trail for every BadgerCoin staking
// attempt the bot makes. Independent of the global `cfg.alerts`
// subsystem (which is disabled by default and routes through
// `data/alerts.jsonl` via Telegram) so the operator can flip
// `staking.attempt_log_file` to a custom path or read this
// stream without enabling Telegram.
//
// Wire shape (one line per attempt):
//
//   {
//     v: 1,
//     ts: <iso>,
//     ts_ms: <number>,
//     tick_id: <number|null>,
//     kind: 'lock' | 'unlock',
//     phase: 'attempt' | 'success' | 'failed',
//     ok: <bool>,
//     txid: <string|null>,
//     code: <string|null>,
//     error: <string|null>,
//     amount_sats: <bigint-as-string|null>,
//     stake_blocks: <number|null>,
//     lock_utxo: <txid:vout|null>,
//     wallet_balance_sats: <bigint-as-string|null>,
//     contract_address: <string|null>,
//     tried: <array|null>,        // T70-2 upstream audit trail when present
//   }
//
// Pure helpers (`buildStakeAttemptEvent`) do the shaping; the
// I/O wrappers (`appendStakeAttempt`, `readStakeAttemptsTail`)
// stay tiny + atomic-write-friendly.
//
// Defensive contract:
// - Missing file path → no-op (returns `{ok:true, persisted:false}`)
// - Bad shape → drops the line, surfaces a `load_errors` row
// - Atomic write via `src/util/atomic-write.mjs` (same pattern
//   the rest of the dashboard uses for `data/alerts.jsonl`)

import { readNdjsonFile } from '../util/atomic-write.mjs';

export const STAKE_ATTEMPT_LOG_SCHEMA = 'tradebot.staking.attempt-log/v1';

/** Default on-disk path. Mirrors the `data/*.jsonl` convention
 * across the codebase. Operators can override via
 * `cfg.staking.attempt_log_file`. */
export const DEFAULT_STAKE_ATTEMPT_LOG_FILE = 'data/stake-attempts.jsonl';

/** Cap on the returned tail so a single dashboard refresh
 * doesn't have to parse a multi-megabyte file. */
export const DEFAULT_STAKE_ATTEMPT_LOG_TAIL = 50;

// ─── Errors ──────────────────────────────────────────────────────────────

export class StakeAttemptLogError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'StakeAttemptLogError';
    if (opts && opts.cause) this.cause = opts.cause;
  }
}

// ─── Pure helpers ────────────────────────────────────────────────────────

/**
 * Build the typed NDJSON row for a single stake attempt event.
 * Pure; never throws on missing fields (returns a best-effort
 * shape with `null` for every absent value).
 *
 * @param {Object} input
 * @param {'lock'|'unlock'} input.kind
 * @param {'attempt'|'success'|'failed'} input.phase
 * @param {Object|null} [input.result]   executeLock/executeUnlock envelope
 * @param {Object} [input.context]
 * @param {number} [input.context.tick_id]
 * @param {bigint|string|number|null} [input.context.amount_sats]
 * @param {number|null} [input.context.stake_blocks]
 * @param {string|null} [input.context.lock_utxo]   "txid:vout"
 * @param {bigint|string|number|null} [input.context.wallet_balance_sats]
 * @param {string|null} [input.context.contract_address]
 * @param {number} [input.nowMs]
 * @returns {Object}
 */
export function buildStakeAttemptEvent({ kind, phase, result = null, context = {}, nowMs } = {}) {
  const tsMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const r = (result && typeof result === 'object') ? result : {};
  const ctx = (context && typeof context === 'object') ? context : {};
  const bigToStr = (v) => (typeof v === 'bigint') ? v.toString() : ((typeof v === 'number' || typeof v === 'string') ? String(v) : null);
  const intOrNull = (v) => (Number.isFinite(v) && Number.isInteger(v)) ? v : ((typeof v === 'string' && Number.isFinite(Number(v))) ? Math.floor(Number(v)) : null);
  return {
    v: 1,
    ts: new Date(tsMs).toISOString(),
    ts_ms: tsMs,
    tick_id: intOrNull(ctx.tick_id),
    kind: (kind === 'unlock') ? 'unlock' : 'lock',
    phase: (phase === 'success' || phase === 'failed') ? phase : 'attempt',
    ok: r?.ok === true,
    txid: (typeof r?.txid === 'string') ? r.txid : null,
    code: (typeof r?.code === 'string') ? r.code : null,
    error: (typeof r?.error === 'string') ? r.error : null,
    amount_sats: bigToStr(ctx.amount_sats ?? r?.amountSats ?? null),
    stake_blocks: intOrNull(ctx.stake_blocks ?? r?.stakeBlocks ?? null),
    lock_utxo: (typeof ctx.lock_utxo === 'string') ? ctx.lock_utxo : null,
    wallet_balance_sats: bigToStr(ctx.wallet_balance_sats ?? null),
    contract_address: (typeof ctx.contract_address === 'string') ? ctx.contract_address : null,
    tried: Array.isArray(r?.tried) ? r.tried : null,
  };
}

// ─── I/O wrappers ────────────────────────────────────────────────────────

/**
 * Append one stake-attempt event to the NDJSON log. Uses
 * `atomicAppend` from `src/util/atomic-write.mjs` so the write
 * is crash-safe (same pattern as `data/alerts.jsonl`).
 *
 * Defensive:
 * - Missing/empty file path → `{ok:true, persisted:false}` (no-op).
 * - Non-function appender → `{ok:true, persisted:false}`.
 * - Throws → returns `{ok:false, error}`.
 *
 * @param {Object} opts
 * @param {Object} opts.event    The pre-built event row.
 * @param {string} [opts.file]   NDJSON path (default = DEFAULT_STAKE_ATTEMPT_LOG_FILE).
 * @param {Function} [opts.appender]  atomicAppend-compatible function.
 *                                    Defaults to lazy `require()` of atomic-write.
 * @returns {Promise<{ok: boolean, persisted: boolean, error?: string}>}
 */
export async function appendStakeAttempt({ event, file = DEFAULT_STAKE_ATTEMPT_LOG_FILE, appender = null } = {}) {
  if (!event || typeof event !== 'object') {
    return { ok: false, persisted: false, error: 'appendStakeAttempt: event required' };
  }
  if (typeof file !== 'string' || file.length === 0) {
    return { ok: true, persisted: false };
  }
  if (appender !== null && typeof appender !== 'function') {
    return { ok: true, persisted: false };
  }
  let ap = appender;
  if (ap === null) {
    try {
      const mod = await import('../util/atomic-write.mjs');
      ap = mod.atomicAppendNdjson;
    } catch (e) {
      return { ok: false, persisted: false, error: `appendStakeAttempt: cannot load atomic-write: ${e?.message ?? String(e)}` };
    }
  }
  if (typeof ap !== 'function') {
    return { ok: true, persisted: false };
  }
  try {
    const line = JSON.stringify(event) + '\n';
    await ap(file, line);
    return { ok: true, persisted: true };
  } catch (e) {
    return { ok: false, persisted: false, error: e?.message ?? String(e) };
  }
}

/**
 * Read the tail of the stake-attempt NDJSON log. Returns the
 * most-recent `max` lines, newest first.
 *
 * Defensive:
 * - ENOENT → `{attempts:[], loadErrors:[]}` (cold-start bot).
 * - Bad JSON line → dropped, surfaces a `load_errors` row with
 *   line number + error message (same pattern as the alerts log).
 * - Non-array / non-number inputs → defensive defaults.
 *
 * @param {Object} opts
 * @param {string} [opts.file]
 * @param {number} [opts.max]
 * @returns {Promise<{attempts: Array<Object>, loadErrors: Array<{file:string,line:number,error:string}>}>}
 */
export async function readStakeAttemptsTail({ file = DEFAULT_STAKE_ATTEMPT_LOG_FILE, max } = {}) {
  const targetFile = (typeof file === 'string' && file.length > 0) ? file : DEFAULT_STAKE_ATTEMPT_LOG_FILE;
  const targetMax = (Number.isFinite(max) && max > 0) ? Math.floor(max) : DEFAULT_STAKE_ATTEMPT_LOG_TAIL;
  let allEvents = [];
  let loadErrors = [];
  try {
    const { lines, errors } = await readNdjsonFile(targetFile);
    allEvents = lines;
    loadErrors = errors;
  } catch (e) {
    if (e && typeof e === 'object' && /** @type {any} */ (e).code === 'ENOENT') {
      return { attempts: [], loadErrors: [] };
    }
    const msg = (e && typeof e === 'object' && typeof e.message === 'string') ? e.message : String(e);
    return { attempts: [], loadErrors: [{ file: targetFile, line: 0, error: msg }] };
  }
  // Filter down to typed stake-attempt rows + newest first.
  const typed = [];
  for (const e of allEvents) {
    if (!e || typeof e !== 'object') continue;
    if (typeof e.kind !== 'string') continue;
    if (typeof e.phase !== 'string') continue;
    if (e.kind !== 'lock' && e.kind !== 'unlock') continue;
    typed.push(e);
  }
  typed.sort((a, b) => {
    const at = (typeof a.ts_ms === 'number') ? a.ts_ms : Date.parse(a.ts ?? '');
    const bt = (typeof b.ts_ms === 'number') ? b.ts_ms : Date.parse(b.ts ?? '');
    if (!Number.isFinite(at) && !Number.isFinite(bt)) return 0;
    if (!Number.isFinite(at)) return 1;
    if (!Number.isFinite(bt)) return -1;
    return bt - at;
  });
  return { attempts: typed.slice(0, targetMax), loadErrors };
}
