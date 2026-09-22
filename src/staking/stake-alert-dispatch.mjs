#!/usr/bin/env node
// src/staking/stake-alert-dispatch.mjs
//
// T58 subset 3 — Stake-lock / stake-unlock alert dispatch.
//
// Why this exists
// ───────────────
// `src/staking/badger-stake-tx.mjs#executeLock` / `executeUnlock`
// return a typed envelope (`{ok, txid, code, error, ...}`). The
// trader loop wants to route every dispatch through the existing
// T53 alert pipeline (channel router + NDJSON appender) so the
// operator gets a `kind:'stake_locked'` / `kind:'stake_unlock'`
// alert in the dashboard's Recent Alerts stream + a row in
// `data/alerts.jsonl`.
//
// This module mirrors `src/alerts/orphan-position.mjs#dispatchOrphanAlerts`
// so the trader loop's per-tick wiring can stay uniform across the
// three end-of-tick dispatch points (orphan check, adaptive-weights,
// staking). Specifically:
//
//   1. **Pure core, I/O at the edges.** `buildStakeAlertEvent` +
//      `mapResultsToStakeAlerts` are pure (no I/O, no clock
//      injection beyond `nowMs`); `dispatchStakeAlert` accepts
//      the router + appender as DI.
//
//   2. **Typed envelopes.** `dispatchStakeAlert` returns
//      `{ok, dispatched, failed, errors}` instead of throwing. A
//      Telegram outage cannot kill the trader loop.
//
//   3. **The dispatch NEVER crashes the caller.** Even if the
//      router throws, `dispatchStakeAlert` returns a Result with
//      `ok:false` — no exception escapes.
//
//   4. **Result envelopes from `executeLock`/`executeUnlock` → AlertEvent.**
//      Pure projection from the typed result envelope. A non-`ok`
//      result still produces a `severity:'warn'` alert so the
//      operator can see in the audit trail why the auto-staking
//      tick rejected the dispatch.
//
// Origin: T58 subset 3 (operator-approved via
// `data/feature-ideas.json#idea_operator_add-badgercoin-staking_20260917`).
// Depends on: T58 subset 2 (`executeLock` / `executeUnlock` in
// `src/staking/badger-stake-tx.mjs`) + T53 (the alert router +
// NDJSON appender in `src/alerts/`).

import process from 'node:process';

// ─── Constants ──────────────────────────────────────────────────────────

/** AlertKind used when a stake-LOCK dispatch returned `ok:true`. */
export const STAKE_LOCK_ALERT_KIND = 'stake_locked';

/** AlertKind used when a stake-UNLOCK dispatch returned `ok:true`. */
export const STAKE_UNLOCK_ALERT_KIND = 'stake_unlock';

/** AlertKind used when a stake dispatch (lock OR unlock) returned `ok:false`. */
export const STAKE_FAILED_ALERT_KIND = 'stake_failed';

/** Severity for successful stake dispatches. */
export const STAKE_SUCCESS_SEVERITY = 'info';
/** Severity for failed stake dispatches (operator-visible warning). */
export const STAKE_FAILED_SEVERITY = 'warn';

// ─── Pure helpers ───────────────────────────────────────────────────────

/**
 * Coerce a stake dispatch result into a `kind` + `ok` pair.
 * Pure. Defensive: returns `{kind:null, ok:false, code:null, error:'no-result'}`
 * for missing / non-object input.
 *
 * @param {unknown} result
 * @returns {{ kind: 'lock'|'unlock'|null, ok: boolean, code: string|null, error: string|null, txid: string|null }}
 */
export function classifyStakeResult(result) {
  if (!result || typeof result !== 'object') {
    return { kind: null, ok: false, code: null, error: 'no-result', txid: null };
  }
  const r = /** @type {any} */ (result);
  const kind = (r.kind === 'lock' || r.kind === 'unlock') ? r.kind : null;
  return {
    kind,
    ok: r.ok === true,
    code: (typeof r.code === 'string') ? r.code : null,
    error: (typeof r.error === 'string') ? r.error : null,
    txid: (typeof r.txid === 'string') ? r.txid : null,
  };
}

/**
 * Build the AlertEvent for ONE stake dispatch result. Pure:
 * `nowMs` is injected so tests can lock the shape.
 *
 * @param {Object} opts
 * @param {Object} opts.result    The `{ok, txid, code, error, kind}` envelope from executeLock/executeUnlock.
 * @param {number} opts.nowMs     Epoch ms.
 * @param {string} [opts.event_id]  Optional dedupe id.
 * @returns {{
 *   kind: 'stake_locked'|'stake_unlock'|'stake_failed',
 *   severity: 'info'|'warn',
 *   title: string,
 *   body: string,
 *   context: Object,
 *   ts: number,
 *   event_id?: string
 * }}
 */
export function buildStakeAlertEvent({ result, nowMs, event_id } = {}) {
  if (!result || typeof result !== 'object') {
    throw new TypeError('buildStakeAlertEvent: result must be a plain object');
  }
  if (!Number.isFinite(nowMs)) {
    throw new TypeError(`buildStakeAlertEvent: nowMs must be a finite number; got ${typeof nowMs}`);
  }
  const r = /** @type {any} */ (result);
  const cls = classifyStakeResult(r);

  // Caller-provided `kind` wins over classification (the trader loop
  // tags the dispatch with its intended kind BEFORE calling, so a
  // failed executeLock still produces a `stake_locked` attempt
  // alert rather than collapsing into `stake_failed`).
  const requestedKind = (r.kind === 'lock' || r.kind === 'unlock') ? r.kind : null;

  let alertKind;
  let severity;
  let title;
  let body;

  if (cls.ok && cls.txid) {
    // Success path — the dispatch returned a real txid.
    alertKind = (requestedKind === 'unlock') ? STAKE_UNLOCK_ALERT_KIND : STAKE_LOCK_ALERT_KIND;
    severity = STAKE_SUCCESS_SEVERITY;
    title = `${alertKind}:${cls.txid.slice(0, 16)}`;
    const verb = (requestedKind === 'unlock') ? 'unlocked' : 'locked';
    body = `stake ${verb} — txid ${cls.txid}.`;
  } else {
    // Failure path — the dispatch refused / threw. We emit a
    // `stake_failed` alert so the operator sees why the auto-tick
    // didn't move BCH (most common reasons: BELOW_MIN_BALANCE,
    // STALE_LOCK_EXISTS, NO_MASTER, SIMULATE_VIOLATIONS).
    alertKind = STAKE_FAILED_ALERT_KIND;
    severity = STAKE_FAILED_SEVERITY;
    title = `${alertKind}:${(requestedKind ?? 'unknown')}_${(cls.code ?? 'unknown').toLowerCase()}`;
    const verb = (requestedKind === 'unlock') ? 'unlock' : 'lock';
    body = `stake ${verb} refused — code ${cls.code ?? 'unknown'}: ${cls.error ?? '<no-error-message>'}.`;
  }

  const context = {
    requested_kind: requestedKind,
    ok: cls.ok,
    txid: cls.txid,
    code: cls.code,
    error: cls.error,
    amount_sats: (typeof r.amountSats === 'string' || typeof r.amountSats === 'bigint')
      ? r.amountSats.toString() : null,
    stake_blocks: (typeof r.stakeBlocks === 'number') ? r.stakeBlocks : null,
    fee_sats: (typeof r.fee === 'string') ? r.fee
      : (typeof r.fee === 'bigint') ? r.fee.toString()
      : (typeof r.fee === 'number') ? r.fee.toString()
      : (typeof r.fee_sats === 'string') ? r.fee_sats
      : (typeof r.fee_sats === 'bigint') ? r.fee_sats.toString()
      : (typeof r.fee_sats === 'number') ? r.fee_sats.toString()
      : null,
    now_ms: nowMs,
  };

  /** @type {{kind: string, severity: 'info'|'warn', title: string, body: string, context: Object, ts: number, event_id?: string}} */
  const event = {
    kind: alertKind,
    severity,
    title,
    body,
    context,
    ts: nowMs,
  };
  if (typeof event_id === 'string' && event_id.length > 0) {
    event.event_id = event_id;
  }
  return event;
}

/**
 * Pure projection: take an array of stake dispatch results and
 * produce an array of AlertEvents. Order preserved. Defensive:
 * null / non-array inputs return [].
 *
 * @param {Array<unknown>} results
 * @param {Object} opts
 * @param {number} opts.nowMs
 * @returns {Array<{kind: string, severity: 'info'|'warn', title: string, body: string, context: Object, ts: number}>}
 */
export function mapResultsToStakeAlerts(results, { nowMs } = {}) {
  if (!Array.isArray(results)) return [];
  if (!Number.isFinite(nowMs)) return [];
  const out = [];
  for (const r of results) {
    if (!r || typeof r !== 'object') continue;
    out.push(buildStakeAlertEvent({ result: /** @type {any} */ (r), nowMs }));
  }
  return out;
}

// ─── Dispatch wrapper ───────────────────────────────────────────────────

/**
 * Dispatch stake-lock / stake-unlock results through the existing
 * T53 alert pipeline. Mirrors `dispatchOrphanAlerts` so the trader
 * loop's per-tick dispatch surface stays uniform across the three
 * end-of-tick decision points.
 *
 * Each result is persisted via `appender` (audit trail) and routed
 * via `router.dispatch()` (operator-visible notification). Per-
 * event failures are captured + logged structured; the outer call
 * NEVER throws so a Telegram outage cannot kill the trader tick.
 *
 * Either `router` or `appender` may be null — the helper skips the
 * null side and continues with the other. This matches the
 * `dispatchOrphanAlerts` contract so the trader loop's auto-wire
 * can keep using a single `_safeAlertDispatch` + `_alertsAppend`
 * pair across all three gates.
 *
 * @param {Object} opts
 * @param {{dispatch: (e: Object) => Promise<any>}|null} [opts.router]
 * @param {(e: Object) => Promise<any>|null} [opts.appender]
 * @param {Array<unknown>} opts.results
 * @param {number} opts.nowMs
 * @param {{warn?: Function, info?: Function, error?: Function}|null} [opts.logger]
 * @returns {Promise<{
 *   ok: boolean,
 *   events: Array<Object>,
 *   dispatched: number,
 *   persisted: number,
 *   failed: number,
 *   errors: Array<{stage: 'persist'|'dispatch', index: number, error: string}>,
 * }>}
 */
export async function dispatchStakeAlert({
  router = null,
  appender = null,
  results = [],
  nowMs,
  logger = null,
} = {}) {
  const events = mapResultsToStakeAlerts(results, { nowMs });

  const result = {
    ok: true,
    events,
    dispatched: 0,
    persisted: 0,
    failed: 0,
    errors: [],
  };

  if (events.length === 0) {
    return result;
  }

  const safeWarn = (logger && typeof logger.warn === 'function')
    ? logger.warn.bind(logger)
    : () => {};
  const safeInfo = (logger && typeof logger.info === 'function')
    ? logger.info.bind(logger)
    : () => {};
  const safeError = (logger && typeof logger.error === 'function')
    ? logger.error.bind(logger)
    : () => {};

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    const eventKind = event.kind;
    const eventTitle = event.title;

    // 1. NDJSON persistence — the audit trail must survive a bot
    //    restart even when the Telegram channel is disabled.
    if (typeof appender === 'function') {
      try {
        const persisted = await appender(event);
        if (persisted && persisted.ok === false) {
          const errMsg = (persisted.error && typeof persisted.error.message === 'string')
            ? persisted.error.message
            : 'appender returned ok:false';
          result.failed += 1;
          result.errors.push({ stage: 'persist', index: i, error: errMsg });
          safeWarn('alerts.stake.persist.failed', {
            event: 'alerts.stake.persist',
            index: i,
            error: errMsg,
            kind: eventKind,
          });
        } else {
          result.persisted += 1;
        }
      } catch (e) {
        const errMsg = (e && typeof e === 'object' && typeof e.message === 'string') ? e.message : String(e);
        result.failed += 1;
        result.errors.push({ stage: 'persist', index: i, error: errMsg });
        safeWarn('alerts.stake.persist.failed', {
          event: 'alerts.stake.persist',
          index: i,
          error: errMsg,
          kind: eventKind,
        });
      }
    }

    // 2. Channel routing — the operator-visible notification.
    if (router && typeof router.dispatch === 'function') {
      try {
        const dispatched = await router.dispatch(event);
        if (dispatched && typeof dispatched === 'object' && dispatched.ok === false) {
          // Router captured the per-channel errors but didn't throw;
          // treat as a non-fatal warning (the persisted row is still
          // the source of truth).
          safeWarn('alerts.stake.dispatch.no_op', {
            event: 'alerts.stake.dispatch',
            kind: eventKind,
            title: eventTitle,
            dispatched: dispatched.dispatched ?? 0,
            channels_ready: dispatched.channels_ready ?? 0,
            errors_count: Array.isArray(dispatched.errors) ? dispatched.errors.length : 0,
          });
        }
        result.dispatched += 1;
        safeInfo('alerts.stake.dispatch', {
          event: 'alerts.stake.dispatch',
          kind: eventKind,
          title: eventTitle,
          severity: event.severity,
        });
      } catch (e) {
        const errMsg = (e && typeof e === 'object' && typeof e.message === 'string') ? e.message : String(e);
        result.failed += 1;
        result.errors.push({ stage: 'dispatch', index: i, error: errMsg });
        safeError('alerts.stake.dispatch.failed', {
          event: 'alerts.stake.dispatch',
          kind: eventKind,
          title: eventTitle,
          error: errMsg,
        });
      }
    }
  }

  if (result.failed > 0) {
    result.ok = false;
  }

  return result;
}

// ─── Test seam ──────────────────────────────────────────────────────────
//
// Exported under `_internals` so tests can lock the building blocks
// without depending on the public dispatch wrapper. Mirrors
// `src/alerts/orphan-position.mjs#_internals`.
export const _internals = {
  STAKE_LOCK_ALERT_KIND,
  STAKE_UNLOCK_ALERT_KIND,
  STAKE_FAILED_ALERT_KIND,
  STAKE_SUCCESS_SEVERITY,
  STAKE_FAILED_SEVERITY,
};

// One-shot logger for `import.meta.main` style invocations; never
// reached when this module is imported by tests / the trader loop.
if (typeof process !== 'undefined' && process.env && process.env.TRADEBOT_STAKE_DISPATCH_DEBUG === '1') {
  // eslint-disable-next-line no-console
  console.error('[stake-alert-dispatch.mjs] debug mode active');
}