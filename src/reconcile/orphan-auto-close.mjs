// src/reconcile/orphan-auto-close.mjs
//
// T62 — Auto-reconcile orphan positions from inside the trader loop.
//
// Why this exists
// ────────────────
// T47 (`src/reconcile/positions-vs-chain.mjs`) ships a pure diff
// that classifies every open position vs. the wallet's live UTXO
// set. One of its finding kinds is `on_disk_only` (severity
// `high`): a position is recorded as `open` in `data/positions.json`
// but the wallet holds ZERO tokens for that token_category. That
// is the canonical "orphan position" — the bot thinks it's
// holding tokens, but the on-chain receipt UTXO is gone (likely
// sold off-chain, swept by an external wallet, lost during a
// partial sweep, or never confirmed after a failed broadcast).
//
// T59 wires the alert: every tick surfaces a Telegram + NDJSON
// `orphan_position` event so the operator knows about it. T29
// ships `scripts/reconcile-position.mjs` — the manual close path
// the operator runs after handling the alert.
//
// T62 closes the loop: when the operator opts in via
// `alerts.orphan_auto_reconcile_enabled:true`, the trader loop
// automatically closes the on-disk `open` record for each orphan
// finding that has been stale for at least
// `alerts.orphan_auto_reconcile_min_age_minutes` minutes, so the
// bot stops trying to exit a position that has no on-chain
// tokens.
//
// Safety contract
// ────────────────
//   - DEFAULT OFF (`alerts.orphan_auto_reconcile_enabled:false`)
//     so a fresh install can never silently close positions.
//   - Min-age gate (`alerts.orphan_auto_reconcile_min_age_minutes`
//     default 60) protects against UTXO-scan races: a position
//     that has been "orphan" for <60s is left alone because the
//     wallet provider may just be slow to surface the latest
//     UTXO set.
//   - The close uses the SAME `Positions.close()` API the trader
//     loop uses for real exits — no special manual path. The
//     audit row carries `kind:'orphan_auto_reconcile'` +
//     `source:'loop.orphan_auto_reconcile'` so the dashboard /
//     P&L roll-ups surface the synthetic close distinctly from
//     on-chain exits.
//   - Realized PnL is set to `-entry.fee_sats` so the operator's
//     P&L accurately captures the entry fee that was paid but
//     never recovered. (If the entry fee is unavailable, we use
//     a documented sentinel `-MAX_FALLBACK_PNL_SATS` so the
//     dashboard at least shows a clearly-attributed loss.)
//   - The synthetic exit envelope has `txid:''`,
//     `bch_received_sats:0`, `fee_sats:0`, `reason:'orphan_auto_reconcile'`
//     — there was NO on-chain exit, so the txid is empty and
//     zero sats "returned" (the on-chain tokens were already
//     gone before the bot noticed).
//   - Every code path is wrapped in defensive try/catch in the
//     loop so a positions-store blip or a single malformed plan
//     cannot kill the tick.
//
// Origin: `data/feature-ideas.json#idea_reconcile_position_in_loop_20260919`.
// Depends on: T47 (the underlying diff helper) + T59 (the orphan
// alert path) + T29 (the manual close shape).

// ─── Constants ──────────────────────────────────────────────────────────

/**
 * History-event `kind` stamped on the synthetic close emitted by
 * `executeOrphanAutoClose`. Mirrors the convention used by
 * `scripts/reconcile-position.mjs` (which uses
 * `kind:'manual_exit'`) but distinctly attributes the close to
 * the auto-reconcile path so the dashboard / P&L roll-ups can
 * filter the two.
 */
export const ORPHAN_AUTO_CLOSE_KIND = 'orphan_auto_reconcile';

/**
 * Audit-trail `source` for the history event. Distinct from
 * `manual_exit` so a future filter / roll-up can attribute the
 * synthetic close to the loop's auto-reconcile path.
 */
export const ORPHAN_AUTO_CLOSE_SOURCE = 'loop.orphan_auto_reconcile';

/**
 * Default minimum age (in minutes) before an orphan finding is
 * considered "closeable". Guards against UTXO-scan races: a
 * freshly-opened position that hasn't yet appeared in the
 * wallet's UTXO snapshot must NOT be auto-closed.
 */
export const DEFAULT_MIN_AGE_MINUTES = 60;

/**
 * Finding kind that triggers an auto-close. Sourced from
 * `src/reconcile/positions-vs-chain.mjs#FINDING_KINDS`.
 */
export const ORPHAN_AUTO_CLOSE_FINDING_KIND = 'on_disk_only';

/**
 * Realized-PnL fallback when the position's `entry.fee_sats` is
 * missing or non-finite. We pick a clearly-negative sentinel
 * rather than `0` so the operator's P&L roll-up shows the
 * orphan as an unattributed loss — better to over-report a
 * loss than to silently zero out a position close.
 */
export const MAX_FALLBACK_PNL_SATS = -1_000_000;

// ─── Pure helpers ───────────────────────────────────────────────────────

/**
 * Coerce a "minutes" knob to a finite millisecond budget.
 *
 *  - `undefined` / `null` → `DEFAULT_MIN_AGE_MINUTES * 60_000`.
 *  - non-finite / NaN → `DEFAULT_MIN_AGE_MINUTES * 60_000`
 *    (defensive; the caller is supposed to validate).
 *  - `0` / negative → `0` (operator opts out of the age gate —
 *    closeable immediately; mirrors the opt-out pattern used by
 *    T32 / T33 / T35 / T36).
 *
 * @param {unknown} minutes
 * @returns {number}
 */
export function ageGateMsFromMinutes(minutes) {
  if (minutes === undefined || minutes === null) {
    return DEFAULT_MIN_AGE_MINUTES * 60_000;
  }
  const n = Number(minutes);
  if (!Number.isFinite(n)) {
    return DEFAULT_MIN_AGE_MINUTES * 60_000;
  }
  if (n <= 0) return 0;
  return Math.floor(n * 60_000);
}

/**
 * Resolve the entry timestamp of a position to an epoch-ms
 * number, or `null` when the position is malformed. Pure.
 *
 * Accepts the same shapes the rest of the codebase uses:
 * `position.entry.ts` as a numeric ms, an ISO-8601 string, or a
 * `Date.parse`-able string. Missing/bad values return `null`
 * (defensive — the caller decides whether to skip the finding).
 *
 * @param {unknown} position
 * @returns {number|null}
 */
export function positionEntryMs(position) {
  if (!position || typeof position !== 'object') return null;
  const p = /** @type {any} */ (position);
  const entry = (p.entry && typeof p.entry === 'object') ? p.entry : null;
  if (!entry) return null;
  const ts = entry.ts;
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  if (typeof ts === 'string' && ts.length > 0) {
    const parsed = Date.parse(ts);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Predicate: is this orphan finding closeable? Returns true
 * when:
 *
 *   - The finding is well-formed (has a string `position_id`,
 *     `kind:'on_disk_only'`, `severity:'high'`).
 *   - The matching position exists in `positionIndex` and is
 *     `status:'open'`.
 *   - The position is at least `minAgeMs` old (or the gate is
 *     `0`).
 *   - `nowMs` is finite.
 *
 * Pure: no I/O, no clock beyond the injected `nowMs`.
 *
 * @param {unknown} finding
 * @param {Map<string, unknown>|null} positionIndex
 * @param {{nowMs: number, minAgeMs: number}} opts
 * @returns {boolean}
 */
export function isOrphanFindingCloseable(finding, positionIndex, { nowMs, minAgeMs } = {}) {
  if (!finding || typeof finding !== 'object') return false;
  const f = /** @type {any} */ (finding);
  if (f.kind !== ORPHAN_AUTO_CLOSE_FINDING_KIND) return false;
  if (f.severity !== 'high') return false;
  if (typeof f.position_id !== 'string' || f.position_id.length === 0) return false;
  if (!Number.isFinite(nowMs)) return false;
  if (!Number.isFinite(minAgeMs) || minAgeMs < 0) return false;
  if (!positionIndex || typeof positionIndex.get !== 'function') return false;
  const position = positionIndex.get(f.position_id);
  if (!position || typeof position !== 'object') return false;
  const p = /** @type {any} */ (position);
  if (p.status !== 'open') return false;
  if (minAgeMs === 0) return true;
  const entryMs = positionEntryMs(position);
  if (entryMs === null) {
    // Without an entry ts we cannot prove age. Conservative posture
    // (matching T31-T36's "missing evidence → guard SKIPPED"): if
    // the operator set a non-zero min-age gate, refuse to close.
    return false;
  }
  const ageMs = nowMs - entryMs;
  if (!Number.isFinite(ageMs)) return false;
  return ageMs >= minAgeMs;
}

/**
 * Filter a `findings[]` array down to the subset that
 * `executeOrphanAutoClose` will actually attempt to close.
 * Pure; preserves the input order.
 *
 * @param {Array<unknown>} findings
 * @param {Map<string, unknown>|null} positionIndex
 * @param {{nowMs: number, minAgeMs: number}} opts
 * @returns {Array<{finding: any, position: any}>}
 */
export function pickOrphanAutoCloseableFindings(findings, positionIndex, { nowMs, minAgeMs } = {}) {
  if (!Array.isArray(findings)) return [];
  const out = [];
  for (const f of findings) {
    if (!isOrphanFindingCloseable(f, positionIndex, { nowMs, minAgeMs })) continue;
    const position = positionIndex.get(/** @type {any} */ (f).position_id);
    out.push({ finding: /** @type {any} */ (f), position });
  }
  return out;
}

/**
 * Build the synthetic exit envelope for an orphan auto-close.
 * There was NO on-chain exit — the wallet never held the tokens
 * in the first place (or they were swept before the bot noticed).
 * Pure: same input → same output.
 *
 * Output shape mirrors the `{txid, price_sats_per_token,
 * bch_received_sats, fee_sats, ts, reason}` envelope that
 * `Positions.close()` accepts:
 *
 *   - `txid`                    → `''` (no on-chain exit)
 *   - `price_sats_per_token`    → `position.entry.price_sats_per_token`
 *                                  (best-known reference price; falls
 *                                  back to `0` when missing — the
 *                                  audit row already says "no exit")
 *   - `bch_received_sats`       → `0` (no BCH returned)
 *   - `fee_sats`                → `0` (no exit fee)
 *   - `ts`                      → ISO-8601 of `nowMs`
 *   - `reason`                  → `'orphan_auto_reconcile'`
 *
 * @param {Object} opts
 * @param {Object} opts.finding
 * @param {Object} opts.position
 * @param {number} opts.nowMs
 * @returns {{
 *   txid: string,
 *   price_sats_per_token: number,
 *   bch_received_sats: number,
 *   fee_sats: number,
 *   ts: string,
 *   reason: string,
 * }}
 */
export function buildOrphanAutoCloseExit({ finding, position, nowMs } = {}) {
  if (!finding || typeof finding !== 'object') {
    throw new TypeError('buildOrphanAutoCloseExit: finding must be a plain object');
  }
  if (!position || typeof position !== 'object') {
    throw new TypeError('buildOrphanAutoCloseExit: position must be a plain object');
  }
  if (!Number.isFinite(nowMs)) {
    throw new TypeError(`buildOrphanAutoCloseExit: nowMs must be a finite number; got ${typeof nowMs}`);
  }
  const p = /** @type {any} */ (position);
  const entry = (p.entry && typeof p.entry === 'object') ? p.entry : {};
  const entryPriceRaw = entry.price_sats_per_token;
  let priceSats = 0;
  if (typeof entryPriceRaw === 'number' && Number.isFinite(entryPriceRaw)) {
    priceSats = Math.max(0, Math.floor(entryPriceRaw));
  } else if (typeof entryPriceRaw === 'string' && entryPriceRaw.length > 0) {
    const parsed = Number(entryPriceRaw);
    if (Number.isFinite(parsed)) priceSats = Math.max(0, Math.floor(parsed));
  }

  return {
    txid: '',
    price_sats_per_token: priceSats,
    bch_received_sats: 0,
    fee_sats: 0,
    ts: new Date(nowMs).toISOString(),
    reason: ORPHAN_AUTO_CLOSE_KIND,
  };
}

/**
 * Compute the realized-PnL sat delta for the synthetic close.
 *
 *  - If `position.entry.fee_sats` is a finite positive number,
 *    return `-fee_sats` (the operator paid a fee on entry and
 *    never recovered anything — so the position closed at a
 *    loss equal to the entry fee).
 *  - If the entry fee is missing or non-positive, fall back to
 *    `MAX_FALLBACK_PNL_SATS` so the operator's P&L roll-up at
 *    least shows a clearly-attributed loss rather than silently
 *    zeroing out the close.
 *
 * Pure: same input → same output.
 *
 * @param {Object} opts
 * @param {Object} opts.position
 * @returns {number}
 */
export function computeOrphanAutoCloseRealizedPnlSats({ position } = {}) {
  if (!position || typeof position !== 'object') {
    throw new TypeError('computeOrphanAutoCloseRealizedPnlSats: position must be a plain object');
  }
  const p = /** @type {any} */ (position);
  const entry = (p.entry && typeof p.entry === 'object') ? p.entry : {};
  const feeRaw = entry.fee_sats;
  let feeSats = 0;
  if (typeof feeRaw === 'number' && Number.isFinite(feeRaw)) {
    feeSats = Math.floor(feeRaw);
  } else if (typeof feeRaw === 'string' && feeRaw.length > 0) {
    const parsed = Number(feeRaw);
    if (Number.isFinite(parsed)) feeSats = Math.floor(parsed);
  }
  if (feeSats > 0) return -feeSats;
  return MAX_FALLBACK_PNL_SATS;
}

/**
 * Build the typed envelope for `executeOrphanAutoClose`. Pure;
 * no I/O. The I/O wrapper below (`executeOrphanAutoClose`)
 * consumes this and threads it through `Positions.close()`.
 *
 * Output:
 *   - `positionId`         — the position to close.
 *   - `exit`               — the synthetic exit envelope.
 *   - `realizedPnlSats`    — the sat delta to record.
 *   - `tokenId`            — lowercased token category id (for audit).
 *   - `tokenSymbol`        — best-known symbol (for audit; may be null).
 *   - `ageMs`              — age of the position in ms.
 *   - `reason`             — short audit string for the structured log.
 *
 * @param {Object} opts
 * @param {{finding: any, position: any}} opts.pair
 * @param {number} opts.nowMs
 * @returns {{
 *   positionId: string,
 *   exit: ReturnType<typeof buildOrphanAutoCloseExit>,
 *   realizedPnlSats: number,
 *   tokenId: string|null,
 *   tokenSymbol: string|null,
 *   ageMs: number|null,
 *   reason: string,
 * }}
 */
export function buildOrphanAutoClosePlan({ pair, nowMs } = {}) {
  if (!pair || typeof pair !== 'object') {
    throw new TypeError('buildOrphanAutoClosePlan: pair must be a plain object');
  }
  if (!Number.isFinite(nowMs)) {
    throw new TypeError(`buildOrphanAutoClosePlan: nowMs must be a finite number; got ${typeof nowMs}`);
  }
  const { finding, position } = pair;
  const positionId = (typeof finding.position_id === 'string') ? finding.position_id : '';
  if (positionId.length === 0) {
    throw new TypeError('buildOrphanAutoClosePlan: finding.position_id required');
  }
  const tokenId = (typeof finding.token_id === 'string') ? finding.token_id.toLowerCase() : null;
  const tokenSymbol = (typeof finding.token_symbol === 'string') ? finding.token_symbol : null;
  const ageMs = (() => {
    const entryMs = positionEntryMs(position);
    if (entryMs === null) return null;
    const age = nowMs - entryMs;
    if (!Number.isFinite(age) || age < 0) return 0;
    return Math.floor(age);
  })();
  return {
    positionId,
    exit: buildOrphanAutoCloseExit({ finding, position, nowMs }),
    realizedPnlSats: computeOrphanAutoCloseRealizedPnlSats({ position }),
    tokenId,
    tokenSymbol,
    ageMs,
    reason: ORPHAN_AUTO_CLOSE_KIND,
  };
}

// ─── I/O wrapper ────────────────────────────────────────────────────────

/**
 * Execute a single orphan auto-close: calls
 * `positions.close(positionId, exit, realizedPnlSats)` and
 * returns a typed envelope. NEVER throws — every failure
 * surfaces in the per-position `error` field so the trader
 * loop can log structured + continue.
 *
 * @param {Object} opts
 * @param {ReturnType<typeof buildOrphanAutoClosePlan>} opts.plan
 * @param {{close: (id: string, exit: Object, pnlSats: number) => Promise<any>}} opts.positions
 * @param {number} opts.nowMs
 * @param {{warn?: Function, info?: Function}|null} [opts.logger]
 * @returns {Promise<{
 *   ok: boolean,
 *   positionId: string,
 *   error: string|null,
 * }>}
 */
export async function executeOrphanAutoClose({ plan, positions, nowMs, logger = null } = {}) {
  if (!plan || typeof plan !== 'object') {
    return { ok: false, positionId: '<unknown>', error: 'plan_missing' };
  }
  const positionId = (typeof plan.positionId === 'string') ? plan.positionId : '<unknown>';
  if (!positions || typeof positions.close !== 'function') {
    return { ok: false, positionId, error: 'positions_close_unavailable' };
  }
  const safeWarn = (logger && typeof logger.warn === 'function')
    ? logger.warn.bind(logger)
    : () => {};

  try {
    const closed = await positions.close(plan.positionId, plan.exit, plan.realizedPnlSats);
    if (closed && typeof closed === 'object' && closed.id === plan.positionId) {
      return { ok: true, positionId, error: null };
    }
    // `Positions.close()` returns the closed entry. If the id
    // doesn't match, something is very wrong (race? bad refactor?)
    // — surface it but don't crash the tick.
    return { ok: false, positionId, error: 'close_returned_mismatch' };
  } catch (e) {
    const errMsg = (e && typeof e === 'object' && typeof e.message === 'string') ? e.message : String(e);
    safeWarn('reconcile.orphan_auto_close.execute.error', {
      event: 'reconcile.orphan_auto_close.execute',
      position_id: positionId,
      err_name: e?.name ?? 'Error',
      err_message: errMsg,
    });
    return { ok: false, positionId, error: errMsg };
  }
}

/**
 * Build the typed history-event record for one auto-close. Pure;
 * the caller JSON-stringifies + appends via the existing
 * `atomicAppendNdjson` seam. Shape mirrors the `manual_exit`
 * audit row emitted by `scripts/reconcile-position.mjs` so the
 * dashboard / P&L roll-ups recognize the close, but the `kind`
 * + `source` fields distinguish the auto-path from a manual
 * operator action.
 *
 * @param {Object} opts
 * @param {ReturnType<typeof buildOrphanAutoClosePlan>} opts.plan
 * @param {Awaited<ReturnType<typeof executeOrphanAutoClose>>} opts.result
 * @param {number} opts.nowMs
 * @returns {{
 *   kind: string,
 *   source: string,
 *   ts: string,
 *   position_id: string,
 *   token_id: string|null,
 *   token_symbol: string|null,
 *   age_ms: number|null,
 *   exit: ReturnType<typeof buildOrphanAutoCloseExit>,
 *   realized_pnl_sats: number,
 *   ok: boolean,
 *   error: string|null,
 * }}
 */
export function buildOrphanAutoCloseAuditRecord({ plan, result, nowMs } = {}) {
  if (!plan || typeof plan !== 'object') {
    throw new TypeError('buildOrphanAutoCloseAuditRecord: plan required');
  }
  if (!result || typeof result !== 'object') {
    throw new TypeError('buildOrphanAutoCloseAuditRecord: result required');
  }
  if (!Number.isFinite(nowMs)) {
    throw new TypeError(`buildOrphanAutoCloseAuditRecord: nowMs must be a finite number; got ${typeof nowMs}`);
  }
  return {
    kind: ORPHAN_AUTO_CLOSE_KIND,
    source: ORPHAN_AUTO_CLOSE_SOURCE,
    ts: new Date(nowMs).toISOString(),
    position_id: plan.positionId,
    token_id: plan.tokenId ?? null,
    token_symbol: plan.tokenSymbol ?? null,
    age_ms: plan.ageMs ?? null,
    exit: plan.exit,
    realized_pnl_sats: plan.realizedPnlSats,
    ok: result.ok === true,
    error: result.ok === true ? null : (typeof result.error === 'string' ? result.error : 'unknown'),
  };
}
