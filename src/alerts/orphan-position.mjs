#!/usr/bin/env node
// src/alerts/orphan-position.mjs
//
// T59 subset 1 — Orphan-position alert dispatch.
//
// Why this exists
// ────────────────
// T47 (`src/reconcile/positions-vs-chain.mjs`) ships a pure diff
// helper that classifies every open position vs. the wallet's live
// UTXO set. One of its finding kinds is `on_disk_only` (severity
// `high`): a position is recorded as `open` in `data/positions.json`
// but the wallet holds ZERO tokens for that token_category. That is
// the canonical "orphan position" — the bot thinks it's holding
// tokens, but the on-chain receipt UTXO is gone (likely sold off-
// chain, lost during a partial sweep, or never confirmed after a
// failed broadcast). Without an alert, the operator finds out hours
// later via dashboard noise or a stuck-portfolio P&L anomaly.
//
// The T47 diff is run by `scripts/reconcile-positions-vs-chain.mjs`
// on operator demand today. This module turns the high-severity
// `on_disk_only` findings into AlertEvents so the operator gets
// notified via the existing T53 alert pipeline (console + Telegram
// when enabled + the NDJSON audit log at `data/alerts.jsonl`).
//
// Subset 1 ships the pure side (this file) + a manual CLI
// (`scripts/check-orphan-positions.mjs`). Subset 2 (deferred) will
// auto-wire the dispatch into `src/trader/loop.mjs` at the end of
// every tick so the bot self-monitors for orphans without the
// operator running a separate cron job.
//
// Design rules (mirrored across the alerts subsystem):
//
//   1. **Pure core, I/O at the edges.** Every helper that does not
//      touch network / filesystem / router / appender is in this
//      module. `dispatchOrphanAlerts()` accepts the router +
//      appender as DI; tests construct minimal stubs.
//
//   2. **Typed envelopes.** `dispatchOrphanAlerts()` returns
//      `{ok, dispatched, failed, errors}` instead of throwing.
//      Individual alert failures are captured + logged structured;
//      the caller can iterate the per-alert error list to surface
//      them in the audit trail.
//
//   3. **The dispatch NEVER crashes the caller.** Even if every
//      router.send() throws, `dispatchOrphanAlerts()` returns a
//      Result with `ok:false` — no exception escapes to the trader
//      loop. A Telegram outage cannot kill a live orphan scan.
//
//   4. **Findings -> AlertEvent is a pure projection.** `mapFindings`
//      + `buildOrphanAlertEvent` are pure (no I/O, no clock
//      injection beyond `nowMs`). Tests can lock the exact shape
//      without stubbing anything beyond `nowMs`.
//
// Origin: T59 (operator-filed via
// `data/feature-ideas.json#idea_orphan_position_alert_20260918`).
// Depends on: T47 (the underlying diff helper) + T53 (the alert
// router + NDJSON appender).

import process from 'node:process';

// ─── Constants ──────────────────────────────────────────────────────────

/**
 * The AlertKind used for orphan-position alerts. Mirrors the
 * convention from `src/alerts/router.mjs#AlertKind` (JSDoc only;
 * the router itself is permissive on `kind`).
 */
export const ORPHAN_POSITION_ALERT_KIND = 'orphan_position';

/**
 * Finding kind that triggers an orphan alert. Sourced from
 * `src/reconcile/positions-vs-chain.mjs#FINDING_KINDS`.
 */
export const ORPHAN_FINDING_KIND = 'on_disk_only';

/**
 * Severity threshold — only `high` findings are escalated to
 * alerts. The T47 diff uses 'high' for the `on_disk_only` case
 * ("positions disagree on existence") and 'medium' for quantity
 * mismatches; we only fire on the disagreement-on-existence case.
 */
export const ORPHAN_FINDING_SEVERITY = 'high';

// ─── Pure helpers ───────────────────────────────────────────────────────

/**
 * Predicate: does this T47 finding warrant an orphan-position
 * alert? Returns true for `kind:'on_disk_only'` AND
 * `severity:'high'` AND a usable `position_id`.
 *
 * Defensive: returns false for any input that isn't a plain object
 * with the required string fields. Callers can pass the entire
 * `findings[]` array without pre-filtering.
 *
 * @param {unknown} finding
 * @returns {boolean}
 */
export function isOrphanFinding(finding) {
  if (!finding || typeof finding !== 'object') return false;
  const f = /** @type {any} */ (finding);
  if (f.kind !== ORPHAN_FINDING_KIND) return false;
  if (f.severity !== ORPHAN_FINDING_SEVERITY) return false;
  if (typeof f.position_id !== 'string' || f.position_id.length === 0) return false;
  return true;
}

/**
 * Compute the age of a finding in milliseconds, given the original
 * position entry timestamp and the current clock. Pure: both inputs
 * are required, missing/bad values return `null` (so the alert
 * context can omit the field rather than crash).
 *
 * Used to stamp `context.age_ms` + `context.age_hours` on the alert
 * so the operator can see how long the orphan has been sitting.
 *
 * @param {string|number|null|undefined} entryTs
 * @param {number} nowMs
 * @returns {number|null}
 */
export function computeOrphanAgeMs(entryTs, nowMs) {
  if (!Number.isFinite(nowMs)) return null;
  let entryMs = null;
  if (typeof entryTs === 'number' && Number.isFinite(entryTs)) {
    entryMs = entryTs;
  } else if (typeof entryTs === 'string' && entryTs.length > 0) {
    const parsed = Date.parse(entryTs);
    if (Number.isFinite(parsed)) entryMs = parsed;
  }
  if (entryMs === null) return null;
  const age = nowMs - entryMs;
  if (!Number.isFinite(age) || age < 0) return 0;
  return Math.floor(age);
}

/**
 * Build the AlertEvent for one orphan finding. Pure: same input →
 * same output; the timestamp is taken from the injected `nowMs` so
 * tests can lock the contract.
 *
 * Output shape follows the T53 AlertEvent contract (`router.mjs`):
 *   `{ kind, severity, title, body, context, ts, event_id? }`.
 *
 * @param {Object} opts
 * @param {Object} opts.finding         The T47 finding (`on_disk_only` / `high`).
 * @param {Object} [opts.position]      The matching open position (optional; supplies entry ts for `age_ms`).
 * @param {number} opts.nowMs           Epoch ms injected by the caller.
 * @param {string} [opts.event_id]      Optional pre-generated event_id for dedup correlation.
 * @returns {{
 *   kind: string,
 *   severity: 'warn',
 *   title: string,
 *   body: string,
 *   context: Object,
 *   ts: number,
 *   event_id?: string
 * }}
 */
export function buildOrphanAlertEvent({ finding, position, nowMs, event_id } = {}) {
  if (!finding || typeof finding !== 'object') {
    throw new TypeError('buildOrphanAlertEvent: finding must be a plain object');
  }
  if (!Number.isFinite(nowMs)) {
    throw new TypeError(`buildOrphanAlertEvent: nowMs must be a finite number; got ${typeof nowMs}`);
  }
  const f = /** @type {any} */ (finding);
  const positionId = (typeof f.position_id === 'string') ? f.position_id : '<missing>';
  const tokenId = (typeof f.token_id === 'string') ? f.token_id : null;
  const tokenSymbol = (typeof f.token_symbol === 'string') ? f.token_symbol : null;
  const findingKind = (typeof f.kind === 'string') ? f.kind : ORPHAN_FINDING_KIND;
  const findingSeverity = (typeof f.severity === 'string') ? f.severity : ORPHAN_FINDING_SEVERITY;
  const findingSummary = (typeof f.summary === 'string') ? f.summary : '';
  const recommendedAction = (typeof f.recommended_action === 'string') ? f.recommended_action : null;
  const details = (f.details && typeof f.details === 'object') ? f.details : {};

  const entryTs = (position && typeof position === 'object')
    ? (position.entry && typeof position.entry === 'object' ? position.entry.ts : null)
    : null;
  const ageMs = computeOrphanAgeMs(entryTs, nowMs);

  const title = `orphan_position:${positionId}`;
  const bodyLines = [
    `position ${positionId} is recorded as 'open' on disk but the wallet holds zero tokens for ${tokenSymbol || (tokenId ? tokenId.slice(0, 8) + '…' : '<unknown-token>')}.`,
    `This is a canonical orphan — likely sold off-chain, swept by an external wallet, or never confirmed after a failed broadcast.`,
    `Recommended action: ${recommendedAction || 'inspect-position-record'}.`,
  ];
  if (ageMs !== null && Number.isFinite(ageMs)) {
    bodyLines.push(`Position entry ts: ${(typeof entryTs === 'string') ? entryTs : new Date(entryTs).toISOString()} (age ${Math.floor(ageMs / 3600000)}h).`);
  }

  const context = {
    position_id: positionId,
    token_id: tokenId,
    token_symbol: tokenSymbol,
    expected_token_amount_base: (typeof details.expected_token_amount_base === 'string')
      ? details.expected_token_amount_base
      : (details.expected_token_amount_base != null ? String(details.expected_token_amount_base) : null),
    wallet_token_amount_base: (typeof details.wallet_token_amount_base === 'string')
      ? details.wallet_token_amount_base
      : (details.wallet_token_amount_base != null ? String(details.wallet_token_amount_base) : null),
    finding_kind: findingKind,
    finding_severity: findingSeverity,
    finding_summary: findingSummary,
    recommended_action: recommendedAction,
    age_ms: ageMs,
    age_hours: (ageMs !== null && Number.isFinite(ageMs)) ? Math.floor(ageMs / 3600000) : null,
    now_ms: nowMs,
  };

  /** @type {{kind: string, severity: 'warn', title: string, body: string, context: Object, ts: number, event_id?: string}} */
  const event = {
    kind: ORPHAN_POSITION_ALERT_KIND,
    severity: 'warn',
    title,
    body: bodyLines.join(' '),
    context,
    ts: nowMs,
  };
  if (typeof event_id === 'string' && event_id.length > 0) {
    event.event_id = event_id;
  }
  return event;
}

/**
 * Pure projection: take an arbitrary `findings[]` array (e.g. the
 * output of `diffPositionsVsChain`) and produce an array of
 * AlertEvents, one per `on_disk_only` high-severity finding. Order
 * preserved. Malformed entries are silently skipped (defensive —
 * the caller doesn't need to pre-filter).
 *
 * @param {Array<unknown>} findings
 * @param {Object} opts
 * @param {number} opts.nowMs
 * @param {Map<string, Object>|null} [opts.positionIndex]   Optional index of `{position_id -> position}` for age stamping.
 * @returns {Array<{kind: string, severity: 'warn', title: string, body: string, context: Object, ts: number}>}
 */
export function mapFindingsToOrphanAlerts(findings, { nowMs, positionIndex = null } = {}) {
  if (!Array.isArray(findings)) return [];
  if (!Number.isFinite(nowMs)) return [];
  const events = [];
  for (const f of findings) {
    if (!isOrphanFinding(f)) continue;
    let position = null;
    if (positionIndex && typeof positionIndex.get === 'function') {
      const pid = /** @type {any} */ (f).position_id;
      position = positionIndex.get(pid) ?? null;
    }
    events.push(buildOrphanAlertEvent({ finding: /** @type {any} */ (f), position, nowMs }));
  }
  return events;
}

// ─── Dispatch wrapper ───────────────────────────────────────────────────

/**
 * Dispatch orphan alerts through the existing T53 router + NDJSON
 * appender. Mirrors the `_dispatchAlert` pattern from
 * `src/risk/circuit-breaker.mjs`:
 *
 *   - First persists each event via `appender` (audit trail).
 *   - Then routes each event through `router.dispatch()` (operator
 *     notification: console + Telegram when enabled).
 *   - Per-event failures are captured and logged structured; the
 *     outer call NEVER throws so a Telegram outage can't kill the
 *     orphan scan.
 *
 * Either `router` or `appender` may be null — the helper skips the
 * null side and continues with the other. This keeps the surface
 * usable from contexts that only have one side wired (e.g. the
 * manual CLI in subset 1 only uses `appender` for an audit-only
 * run; the trader loop in subset 2 wires both).
 *
 * @param {Object} opts
 * @param {{dispatch: (e: Object) => Promise<any>}|null} [opts.router]
 * @param {(e: Object) => Promise<any>|null} [opts.appender]
 * @param {Array<unknown>} opts.findings
 * @param {number} opts.nowMs
 * @param {Map<string, Object>|null} [opts.positionIndex]
 * @param {{warn?: Function, info?: Function, error?: Function}|null} [opts.logger]
 * @returns {Promise<{
 *   ok: boolean,
 *   events: Array<Object>,
 *   dispatched: number,
 *   persisted: number,
 *   failed: number,
 *   errors: Array<{stage: 'persist'|'dispatch', position_id: string|null, error: string}>,
 * }>}
 */
export async function dispatchOrphanAlerts({
  router = null,
  appender = null,
  findings = [],
  nowMs,
  positionIndex = null,
  logger = null,
} = {}) {
  const events = mapFindingsToOrphanAlerts(findings, { nowMs, positionIndex });

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

  for (const event of events) {
    const positionId = (event.context && typeof event.context.position_id === 'string')
      ? event.context.position_id
      : null;

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
          result.errors.push({ stage: 'persist', position_id: positionId, error: errMsg });
          safeWarn('alerts.orphan_position.persist.failed', {
            event: 'alerts.orphan_position.persist',
            position_id: positionId,
            error: errMsg,
            kind: event.kind,
          });
        } else {
          result.persisted += 1;
        }
      } catch (e) {
        const errMsg = (e && typeof e === 'object' && typeof e.message === 'string') ? e.message : String(e);
        result.failed += 1;
        result.errors.push({ stage: 'persist', position_id: positionId, error: errMsg });
        safeWarn('alerts.orphan_position.persist.failed', {
          event: 'alerts.orphan_position.persist',
          position_id: positionId,
          error: errMsg,
          kind: event.kind,
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
          safeWarn('alerts.orphan_position.dispatch.no_op', {
            event: 'alerts.orphan_position.dispatch',
            position_id: positionId,
            kind: event.kind,
            dispatched: dispatched.dispatched ?? 0,
            channels_ready: dispatched.channels_ready ?? 0,
            errors_count: Array.isArray(dispatched.errors) ? dispatched.errors.length : 0,
          });
        }
        result.dispatched += 1;
        safeInfo('alerts.orphan_position.dispatch', {
          event: 'alerts.orphan_position.dispatch',
          position_id: positionId,
          kind: event.kind,
          severity: event.severity,
          title: event.title,
        });
      } catch (e) {
        const errMsg = (e && typeof e === 'object' && typeof e.message === 'string') ? e.message : String(e);
        result.failed += 1;
        result.errors.push({ stage: 'dispatch', position_id: positionId, error: errMsg });
        safeError('alerts.orphan_position.dispatch.failed', {
          event: 'alerts.orphan_position.dispatch',
          position_id: positionId,
          error: errMsg,
          kind: event.kind,
        });
      }
    }
  }

  if (result.failed > 0) {
    result.ok = false;
  }

  return result;
}

/**
 * Pure helper: index open positions by id so the alert builder
 * can stamp age. Defensive: returns an empty Map for bad input;
 * non-object / non-array inputs yield an empty index.
 *
 * @param {Array<unknown>|null|undefined} positions
 * @returns {Map<string, Object>}
 */
export function indexOpenPositionsById(positions) {
  const idx = new Map();
  if (!Array.isArray(positions)) return idx;
  for (const p of positions) {
    if (!p || typeof p !== 'object') continue;
    const id = /** @type {any} */ (p).id;
    if (typeof id === 'string' && id.length > 0) {
      idx.set(id, p);
    }
  }
  return idx;
}

/**
 * Convenience: filter the open positions to the ones referenced by
 * the orphan findings (so the caller can pass a smaller subset to
 * the wallet lookup, when wallet UTXO fetching is on the hot path).
 * Pure. Order preserved.
 *
 * @param {Array<unknown>} findings
 * @param {Array<unknown>} openPositions
 * @returns {Array<Object>}
 */
export function pickOrphanPositions(findings, openPositions) {
  if (!Array.isArray(findings) || !Array.isArray(openPositions)) return [];
  const wanted = new Set();
  for (const f of findings) {
    if (!isOrphanFinding(f)) continue;
    const pid = /** @type {any} */ (f).position_id;
    if (typeof pid === 'string' && pid.length > 0) wanted.add(pid);
  }
  const out = [];
  for (const p of openPositions) {
    if (!p || typeof p !== 'object') continue;
    const id = /** @type {any} */ (p).id;
    if (typeof id === 'string' && wanted.has(id)) {
      out.push(p);
    }
  }
  return out;
}

// ─── Test seam ──────────────────────────────────────────────────────────
//
// Exported under `_internals` so tests can lock the building blocks
// without depending on the public dispatch wrapper. Mirrors the
// pattern from `src/alerts/persist.mjs#_internals`.
export const _internals = {
  ORPHAN_POSITION_ALERT_KIND,
  ORPHAN_FINDING_KIND,
  ORPHAN_FINDING_SEVERITY,
};

// One-shot logger for `import.meta.main` style invocations; never
// reached when this module is imported by tests / the trader loop.
if (typeof process !== 'undefined' && process.env && process.env.TRADEBOT_ORPHAN_DEBUG === '1') {
  // eslint-disable-next-line no-console
  console.error('[orphan-position.mjs] debug mode active');
}
