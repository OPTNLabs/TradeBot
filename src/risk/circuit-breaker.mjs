#!/usr/bin/env node
// src/risk/circuit-breaker.mjs
//
// Stateful circuit breaker for TradeBot.
//
// Three independent trips halt the bot:
//
//   1. **Daily-loss trip** — the bot's realized P&L over the last
//      `lookbackHours` is worse than `-max_daily_loss_bch` (defaults:
//      0.005 BCH). The bot refuses to open new positions until the
//      window rolls forward.
//
//   2. **Consecutive-loss trip** — the bot closed the last N trades
//      in a row at a loss (`max_consecutive_losses`, default 3).
//
//   3. **Loss-cooldown trip** — the bot just exited a position via
//      stop-loss (`recordResult({exitKind: 'stop_loss', pnlSats: <0>})`).
//      The bot pauses new entries for `loss_cooldown_minutes` (default 30)
//      on the theory that the market condition which triggered the
//      stop-loss is still in play. Take-profit / trailing-stop / time-stop
//      exits do NOT start a cooldown (those represent a normal exit, not
//      a market rejection). A non-finite / non-positive
//      `loss_cooldown_minutes` disables the cooldown entirely.
//
// Trips #1 and #2 share `cooldownHours` (`circuit_breaker_cooldown_hours`)
// after which the breaker auto-resets. Trip #3 uses
// `loss_cooldown_minutes` (much shorter — it's a soft pause, not a halt).
// A manual reset is also possible (`reset()`); useful after the operator
// verifies the on-chain state.
//
// Design rules (also see docs/ARCHITECTURE.md §4.4 + §5.2):
//
//   1. **State is in-memory only.** Persistence to disk would require
//      a write per trade — too noisy for a bot that polls every
//      minute. A restart resets the daily-loss counter (which is
//      fine, since the cooldown protects us during a hot restart).
//      The trader loop's `loop.mjs` reads the closed-positions file
//      back on boot, so the consecutive-loss counter also rebuilds.
//
//   2. **All thresholds read from `cfg.risk`.** No hard-coded literals
//      in this file. Defaults are exposed as `DEFAULT_RISK_CONFIG` for
//      the test suite only.
//
//   3. **Pure decision functions + impure class.** The class holds
//      the state; pure helpers (`tripKind`, `cooldownRemainingMs`,
//      etc.) are exported for unit tests and dashboard introspection.
//
//   4. **`recordResult(...)` is append-only.** You can never undo a
//      record. This matches the "audit trail" rule: every close is a
//      fact, and we don't rewrite history.
//
//   5. **Never throws on policy rejection.** `evaluate(...)` returns
//      `{ allow: boolean, tripKind, reason }`. Throws only on input
//      validation bugs.
//
//   6. **The breaker is OPTIONAL.** Callers that want to bypass it
//      (e.g. dry-run backtests) can construct the breaker without
//      ever calling `evaluate` and just inspect `state` for metrics.
//
// Origin: original code for TradeBot. ARCHITECTURE.md §3 places this
// module on the stateful layer (it holds in-memory state, but no I/O).

// ─────────────────────────────────────────────────────────────────────
//  Defaults
// ─────────────────────────────────────────────────────────────────────

/**
 * Defaults mirror `config/default.json` → `risk`. The real config
 * always wins when the caller passes a value; these only fire on
 * missing/garbage input (programmer bug).
 */
export const DEFAULT_RISK_CONFIG = Object.freeze({
  max_daily_loss_bch: 0.005,
  max_consecutive_losses: 3,
  circuit_breaker_cooldown_hours: 6,
  min_wallet_balance_bch: 0.005,
  // T34: loss cooldown. After a stop-loss exit, the bot pauses new
  // entries for this many minutes. Non-finite / non-positive DISABLES
  // the cooldown (matches the T32/T33 0/negative sentinel pattern).
  loss_cooldown_minutes: 30,
});

/**
 * Window (in hours) the daily-loss check looks back over. The user
 * chose `max_daily_loss_bch=0.005` in the small-balance preset, so
 * the natural unit is "1 calendar day" — but we make it configurable
 * to support backtests (a backtester might want a 6h window).
 */
export const DEFAULT_DAILY_LOOKBACK_HOURS = 24;

/**
 * Coerce a config's `risk` block to the canonical shape. Same pattern
 * as `limits.resolveRiskConfig`. Exported here too for the test suite
 * (limits + circuit-breaker both use this same coercion).
 *
 * @param {Object|undefined|null} input
 * @returns {{
 *   max_daily_loss_bch: number,
 *   max_consecutive_losses: number,
 *   circuit_breaker_cooldown_hours: number,
 *   min_wallet_balance_bch: number,
 *   loss_cooldown_minutes: number,
 * }}
 */
export function resolveRiskConfig(input) {
  const base = DEFAULT_RISK_CONFIG;
  if (!input || typeof input !== 'object') return { ...base };
  /** @type {ReturnType<typeof resolveRiskConfig>} */
  const out = { ...base };
  for (const k of Object.keys(base)) {
    const v = input[k];
    if (v === undefined || v === null) continue;
    const n = Number(v);
    if (Number.isFinite(n)) out[k] = n;
  }
  if (out.max_daily_loss_bch < 0) out.max_daily_loss_bch = base.max_daily_loss_bch;
  if (out.max_consecutive_losses < 0) out.max_consecutive_losses = base.max_consecutive_losses;
  if (out.circuit_breaker_cooldown_hours < 0) out.circuit_breaker_cooldown_hours = base.circuit_breaker_cooldown_hours;
  if (out.min_wallet_balance_bch < 0) out.min_wallet_balance_bch = base.min_wallet_balance_bch;
  // T34: loss_cooldown_minutes passes through verbatim. A non-finite
  // value falls back to the default (covers `null` / `undefined` /
  // missing); but `0` / negative are KEPT so they can act as an
  // explicit opt-out (matches the T32/T33 sentinel pattern). The
  // breaker's `recordResult` treats `loss_cooldown_minutes > 0` as
  // "cooldown enabled" and otherwise leaves the state untouched.
  if (!Number.isFinite(out.loss_cooldown_minutes)) {
    out.loss_cooldown_minutes = base.loss_cooldown_minutes;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
//  Pure helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Classify a realized P&L value as a `win` (positive), `loss`
 * (negative), or `breakeven` (zero). Returns `null` on missing /
 * non-numeric input.
 *
 * Pure.
 *
 * @param {unknown} pnlSats
 * @returns {'win'|'loss'|'breakeven'|null}
 */
export function classifyPnl(pnlSats) {
  if (typeof pnlSats === 'bigint') {
    if (pnlSats > 0n) return 'win';
    if (pnlSats < 0n) return 'loss';
    return 'breakeven';
  }
  if (typeof pnlSats === 'number' && Number.isFinite(pnlSats)) {
    if (pnlSats > 0) return 'win';
    if (pnlSats < 0) return 'loss';
    return 'breakeven';
  }
  if (typeof pnlSats === 'string' && pnlSats.length > 0) {
    const n = Number(pnlSats);
    if (Number.isFinite(n)) {
      if (n > 0) return 'win';
      if (n < 0) return 'loss';
      return 'breakeven';
    }
  }
  return null;
}

/**
 * Compute the time remaining until the cooldown expires. Pure.
 * Returns 0 when already cooled down (or no trip recorded).
 *
 * @param {number|null|undefined} tripTsMs
 * @param {number} cooldownHours
 * @param {number} nowMs
 * @returns {number} ms remaining (>= 0)
 */
export function cooldownRemainingMs(tripTsMs, cooldownHours, nowMs) {
  if (tripTsMs === null || tripTsMs === undefined) return 0;
  if (!Number.isFinite(cooldownHours) || cooldownHours <= 0) return 0;
  if (!Number.isFinite(nowMs)) return 0;
  const cooldownMs = cooldownHours * 3_600_000;
  const elapsed = nowMs - tripTsMs;
  if (elapsed < 0) return cooldownMs;
  const remaining = cooldownMs - elapsed;
  return remaining > 0 ? remaining : 0;
}

/**
 * Compute the time remaining until the loss cooldown expires. Pure.
 * Mirrors `cooldownRemainingMs` but uses minutes instead of hours so the
 * T34 default of `loss_cooldown_minutes: 30` can be enforced without
 * turning minutes into fractional hours (which would round to 0 and
 * silently disable the cooldown).
 *
 * @param {number|null|undefined} tripTsMs
 * @param {number} cooldownMinutes
 * @param {number} nowMs
 * @returns {number} ms remaining (>= 0)
 */
export function lossCooldownRemainingMs(tripTsMs, cooldownMinutes, nowMs) {
  if (tripTsMs === null || tripTsMs === undefined) return 0;
  if (!Number.isFinite(cooldownMinutes) || cooldownMinutes <= 0) return 0;
  if (!Number.isFinite(nowMs)) return 0;
  const cooldownMs = cooldownMinutes * 60_000;
  const elapsed = nowMs - tripTsMs;
  if (elapsed < 0) return cooldownMs;
  const remaining = cooldownMs - elapsed;
  return remaining > 0 ? remaining : 0;
}

/**
 * Pick the canonical trip-kind for a given breaker state. Returns
 * `null` when neither breaker is currently tripped. Pure.
 *
 * Priority: `daily_loss` > `consecutive_losses` > `loss_cooldown`
 * (a daily-loss trip is the hardest to recover from and we want it
 * surfaced first; the loss-cooldown is the softest pause, so it sits
 * at the bottom of the priority order).
 *
 * @param {Object} state
 * @param {number|null} state.dailyLossTripTsMs
 * @param {number|null} state.consecutiveLossesTripTsMs
 * @param {number|null} [state.stopLossCooldownTripTsMs]    T34
 * @param {number} state.dailyLossCooldownHours
 * @param {number} state.consecutiveLossesCooldownHours
 * @param {number} [state.lossCooldownMinutes]              T34
 * @param {number} state.nowMs
 * @returns {'daily_loss'|'consecutive_losses'|'loss_cooldown'|null}
 */
export function tripKind(state) {
  if (!state || typeof state !== 'object') return null;
  const dRem = cooldownRemainingMs(state.dailyLossTripTsMs, state.dailyLossCooldownHours, state.nowMs);
  if (dRem > 0) return 'daily_loss';
  const cRem = cooldownRemainingMs(state.consecutiveLossesTripTsMs, state.consecutiveLossesCooldownHours, state.nowMs);
  if (cRem > 0) return 'consecutive_losses';
  // T34: loss cooldown is the lowest-priority trip. A non-finite /
  // non-positive `lossCooldownMinutes` leaves it dormant — same
  // sentinel pattern as the T32/T33 opt-out knobs. We treat both
  // missing AND ≤ 0 as "cooldown disabled" so operators can turn it
  // off with `loss_cooldown_minutes: 0` in user.json.
  const lCooldown = Number.isFinite(Number(state.lossCooldownMinutes))
    ? Number(state.lossCooldownMinutes)
    : 0;
  const lRem = lCooldown > 0
    ? lossCooldownRemainingMs(state.stopLossCooldownTripTsMs ?? null, lCooldown, state.nowMs)
    : 0;
  if (lRem > 0) return 'loss_cooldown';
  return null;
}

// ─────────────────────────────────────────────────────────────────────
//  CircuitBreaker class
// ─────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} CircuitBreakerOpts
 * @property {Object} cfg               merged default+user config (we read cfg.risk)
 * @property {Object} [logger]          structured logger
 * @property {number} [now]             () => ms — test seam (default: Date.now)
 * @property {number} [dailyLookbackHours=24]  window for the daily P&L rollup
 */

/**
 * Stateful circuit breaker. Construction is cheap; the first call
 * to `recordResult(...)` or `evaluate(...)` does any work.
 *
 * The class holds NO disk state by design (see the module header).
 * A restart resets everything; that's acceptable because the
 * consecutive-loss counter rebuilds from `positions.json` on the
 * next `evaluate(...)` call.
 */
export class CircuitBreaker {
  /**
   * @param {CircuitBreakerOpts} opts
   */
  constructor(opts) {
    if (opts === undefined || opts === null) {
      throw new TypeError('CircuitBreaker: opts is required');
    }
    if (typeof opts !== 'object') {
      throw new TypeError(`CircuitBreaker: opts must be an object; got ${typeof opts}`);
    }
    if (!opts.cfg || typeof opts.cfg !== 'object') {
      throw new TypeError('CircuitBreaker: cfg is required');
    }
    this.cfg = opts.cfg;
    this.logger = opts.logger ?? null;
    this._now = (typeof opts.now === 'function') ? opts.now : (() => Date.now());
    this._dailyLookbackHours = Number.isFinite(opts.dailyLookbackHours) ? opts.dailyLookbackHours : DEFAULT_DAILY_LOOKBACK_HOURS;
    /**
     * T53.2: optional AlertRouter seam. When provided, the breaker
     * dispatches a `breaker_trip` event when it trips and a
     * `wallet_floor`-flavored event when the loss cooldown starts
     * (the cooldown pauses new entries, which is the wallet-floor
     * concern from the operator's POV). Dispatch is fire-and-forget
     * and NEVER throws — a Telegram outage cannot kill the loop.
     * Default = `null` (no alerts; the legacy behavior).
     * @private
     */
    this._safeAlertDispatch = (typeof opts.safeAlertDispatch === 'function')
      ? opts.safeAlertDispatch
      : null;
    /**
     * T53.2: optional alerts NDJSON writer seam. Same contract as
     * `safeAlertDispatch`: never throws, returns a typed envelope.
     * Independent from the router so operators can disable channel
     * routing (e.g. telegram-bot maintenance) without losing the
     * audit trail. Default = `null`.
     * @private
     */
    this._alertsAppend = (typeof opts.alertsAppend === 'function')
      ? opts.alertsAppend
      : null;
    /** @private — most recent trade results (newest first). */
    this._results = [];
    /** @private — when each breaker last tripped (null = never). */
    this._dailyLossTripTsMs = null;
    this._consecutiveLossesTripTsMs = null;
    /** @private — T34: when the most recent stop-loss exit occurred (null = never). */
    this._stopLossCooldownTripTsMs = null;
  }

  /**
   * Read-only view of the breaker's current state. Useful for the
   * dashboard's "Settings → Circuit Breaker" panel.
   *
   * @returns {{
   *   dailyLossTripTsMs: number|null,
   *   consecutiveLossesTripTsMs: number|null,
   *   stopLossCooldownTripTsMs: number|null,
   *   dailyLossCooldownHours: number,
   *   consecutiveLossesCooldownHours: number,
   *   lossCooldownMinutes: number,
   *   maxDailyLossBch: number,
   *   maxConsecutiveLosses: number,
   *   consecutiveLosses: number,
   *   recentDailyPnlSats: number,
   *   nowMs: number,
   *   isTripped: boolean,
   *   tripKind: string|null,
   *   lossCooldownRemainingMs: number,
   * }}
   */
  state() {
    const risk = resolveRiskConfig(this.cfg.risk);
    const nowMs = this._now();
    const recentDailyPnlSats = this._recentPnlSats(nowMs);
    const consecutive = this._consecutiveLosses();
    return {
      dailyLossTripTsMs: this._dailyLossTripTsMs,
      consecutiveLossesTripTsMs: this._consecutiveLossesTripTsMs,
      stopLossCooldownTripTsMs: this._stopLossCooldownTripTsMs,
      dailyLossCooldownHours: risk.circuit_breaker_cooldown_hours,
      consecutiveLossesCooldownHours: risk.circuit_breaker_cooldown_hours,
      lossCooldownMinutes: risk.loss_cooldown_minutes,
      maxDailyLossBch: risk.max_daily_loss_bch,
      maxConsecutiveLosses: risk.max_consecutive_losses,
      consecutiveLosses: consecutive,
      recentDailyPnlSats,
      nowMs,
      isTripped: this.isTripped(nowMs),
      tripKind: this.tripKind(nowMs),
      lossCooldownRemainingMs: lossCooldownRemainingMs(
        this._stopLossCooldownTripTsMs,
        risk.loss_cooldown_minutes,
        nowMs,
      ),
    };
  }

  /**
   * Is the breaker currently tripped?
   *
   * @param {number} [nowMs]   defaults to `this._now()`
   * @returns {boolean}
   */
  isTripped(nowMs = this._now()) {
    return tripKind({
      dailyLossTripTsMs: this._dailyLossTripTsMs,
      consecutiveLossesTripTsMs: this._consecutiveLossesTripTsMs,
      stopLossCooldownTripTsMs: this._stopLossCooldownTripTsMs,
      dailyLossCooldownHours: resolveRiskConfig(this.cfg.risk).circuit_breaker_cooldown_hours,
      consecutiveLossesCooldownHours: resolveRiskConfig(this.cfg.risk).circuit_breaker_cooldown_hours,
      lossCooldownMinutes: resolveRiskConfig(this.cfg.risk).loss_cooldown_minutes,
      nowMs,
    }) !== null;
  }

  /**
   * Which trip is currently active? `null` when not tripped.
   *
   * @param {number} [nowMs]
   * @returns {'daily_loss'|'consecutive_losses'|'loss_cooldown'|null}
   */
  tripKind(nowMs = this._now()) {
    return tripKind({
      dailyLossTripTsMs: this._dailyLossTripTsMs,
      consecutiveLossesTripTsMs: this._consecutiveLossesTripTsMs,
      stopLossCooldownTripTsMs: this._stopLossCooldownTripTsMs,
      dailyLossCooldownHours: resolveRiskConfig(this.cfg.risk).circuit_breaker_cooldown_hours,
      consecutiveLossesCooldownHours: resolveRiskConfig(this.cfg.risk).circuit_breaker_cooldown_hours,
      lossCooldownMinutes: resolveRiskConfig(this.cfg.risk).loss_cooldown_minutes,
      nowMs,
    });
  }

  /**
   * Record a single trade result. Triggers a daily-loss or
   * consecutive-loss trip when thresholds are crossed.
   *
   * T34 — pass `exitKind: 'stop_loss'` to start a loss cooldown
   * (`loss_cooldown_minutes`, default 30) on top of the usual trips.
   * Other exit kinds (`take_profit`, `trailing_stop`, `time_stop`) do
   * NOT start the cooldown — they represent normal exits, not market
   * rejection. `exitKind: null` / undefined also skips the cooldown,
   * which means existing callers that only pass `{pnlSats, tsMs,
   * tokenId}` get exactly the prior behaviour.
   *
   * @param {Object} args
   * @param {number|bigint|string} args.pnlSats   signed sat delta
   * @param {number} [args.tsMs]                 defaults to `this._now()`
   * @param {string} [args.tokenId]              for the audit log
   * @param {'stop_loss'|'take_profit'|'trailing_stop'|'time_stop'|null} [args.exitKind]
   *                                               T34: gates the loss cooldown
   * @returns {{
   *   recorded: true,
   *   pnlSats: number,
   *   kind: 'win'|'loss'|'breakeven',
   *   tripped: boolean,
   *   tripKind: 'daily_loss'|'consecutive_losses'|null,
   *   lossCooldownStarted: boolean,
   * }}
   */
  recordResult({ pnlSats, tsMs, tokenId, exitKind } = {}) {
    if (typeof pnlSats !== 'number' && typeof pnlSats !== 'bigint' && typeof pnlSats !== 'string') {
      throw new TypeError('CircuitBreaker.recordResult: pnlSats must be number|bigint|string');
    }
    const ts = (tsMs !== undefined && Number.isFinite(tsMs)) ? Number(tsMs) : this._now();
    let pnlNumber;
    if (typeof pnlSats === 'bigint') pnlNumber = Number(pnlSats);
    else if (typeof pnlSats === 'string') pnlNumber = Number(pnlSats);
    else pnlNumber = Number(pnlSats);
    if (!Number.isFinite(pnlNumber)) {
      throw new TypeError(`CircuitBreaker.recordResult: pnlSats not finite (${pnlSats})`);
    }
    const kind = classifyPnl(pnlNumber);
    if (kind === null) {
      throw new TypeError(`CircuitBreaker.recordResult: pnlSats must be a finite number; got ${pnlSats}`);
    }
    this._results.unshift({ pnlSats: pnlNumber, tsMs: ts, kind, tokenId: tokenId ?? null });

    let tripped = false;
    /** @type {'daily_loss'|'consecutive_losses'|null} */
    let triggeredTrip = null;
    let lossCooldownStarted = false;

    const risk = resolveRiskConfig(this.cfg.risk);
    // 1. Consecutive-losses check. A loss was just recorded — count
    //    trailing losses from the head.
    if (kind === 'loss' && this._consecutiveLosses() >= risk.max_consecutive_losses
        && this._consecutiveLossesTripTsMs === null) {
      this._consecutiveLossesTripTsMs = ts;
      tripped = true;
      triggeredTrip = 'consecutive_losses';
    }
    // 2. Daily-loss check. Look at the last `dailyLookbackHours` of
    //    results; if their SUM is worse than -max_daily_loss_bch, trip.
    const recentSats = this._recentPnlSats(ts);
    const maxLossSats = -risk.max_daily_loss_bch * 1e8;
    if (recentSats <= maxLossSats && this._dailyLossTripTsMs === null) {
      this._dailyLossTripTsMs = ts;
      tripped = true;
      triggeredTrip = triggeredTrip ?? 'daily_loss';
    }
    // 3. T34: Loss cooldown. A stop-loss exit with a realized loss
    //    starts a soft `loss_cooldown_minutes` pause on NEW entries.
    //    We always stamp the timestamp (it's overwritten by the next
    //    stop-loss, which is correct — the cooldown is "from the most
    //    recent stop-loss", not cumulative). Take-profit / time-stop
    //    exits explicitly do NOT restart the cooldown — only stop-loss
    //    exits mark the market as currently rejecting our position.
    if (exitKind === 'stop_loss' && kind === 'loss'
        && Number.isFinite(risk.loss_cooldown_minutes)
        && risk.loss_cooldown_minutes > 0) {
      this._stopLossCooldownTripTsMs = ts;
      lossCooldownStarted = true;
    }

    if (this.logger) {
      this.logger.info('circuit_breaker.record', {
        pnl_sats: pnlNumber,
        kind,
        token_id: tokenId ?? null,
        exit_kind: exitKind ?? null,
        consecutive_losses: this._consecutiveLosses(),
        recent_daily_pnl_sats: recentSats,
        tripped,
        trip_kind: triggeredTrip,
        loss_cooldown_started: lossCooldownStarted,
        loss_cooldown_minutes: risk.loss_cooldown_minutes,
        ts,
      });
      if (tripped) {
        this.logger.warn('circuit_breaker.tripped', {
          trip_kind: triggeredTrip,
          ts,
          cooldown_hours: risk.circuit_breaker_cooldown_hours,
          max_daily_loss_bch: risk.max_daily_loss_bch,
          max_consecutive_losses: risk.max_consecutive_losses,
          consecutive_losses: this._consecutiveLosses(),
          recent_daily_pnl_sats: recentSats,
        });
      }
      if (lossCooldownStarted) {
        this.logger.warn('circuit_breaker.loss_cooldown_started', {
          ts,
          loss_cooldown_minutes: risk.loss_cooldown_minutes,
          token_id: tokenId ?? null,
          pnl_sats: pnlNumber,
        });
      }
    }

    // T53.2: outbound alerts. When the breaker trips, dispatch a
    // `breaker_trip` event so the operator's Telegram / log
    // subscribers see it. When the loss cooldown starts, dispatch
    // a `wallet_floor`-flavored event (the cooldown is the
    // wallet-floor concern from the operator's POV — new entries
    // are paused for `loss_cooldown_minutes` after a stop-loss).
    // Both are fire-and-forget; a dispatch failure cannot kill
    // the trader loop.
    if (tripped && triggeredTrip) {
      void this._dispatchBreakerTrip({
        kind: triggeredTrip,
        ts,
        pnl_sats: pnlNumber,
        token_id: tokenId ?? null,
        exit_kind: exitKind ?? null,
        cooldown_hours: risk.circuit_breaker_cooldown_hours,
        max_daily_loss_bch: risk.max_daily_loss_bch,
        max_consecutive_losses: risk.max_consecutive_losses,
        consecutive_losses: this._consecutiveLosses(),
        recent_daily_pnl_sats: recentSats,
      });
    }
    if (lossCooldownStarted) {
      void this._dispatchLossCooldown({
        ts,
        loss_cooldown_minutes: risk.loss_cooldown_minutes,
        token_id: tokenId ?? null,
        pnl_sats: pnlNumber,
      });
    }

    return {
      recorded: true,
      pnlSats: pnlNumber,
      kind,
      tripped,
      tripKind: triggeredTrip,
      lossCooldownStarted,
    };
  }

  /**
   * Should we open a new position right now? Returns
   * `{ allow: false, reason, tripKind }` when tripped; otherwise
   * `{ allow: true }`.
   *
   * Pure w.r.t. inputs — only `this._now()` provides non-determinism.
   *
   * @param {Object} [args]
   * @param {number} [args.nowMs]    override the breaker's clock (test seam)
   * @returns {{ allow: boolean, reason?: string, tripKind?: string, cooldownRemainingMs?: number }}
   */
  evaluate(args = {}) {
    const nowMs = (args && Number.isFinite(Number(args.nowMs))) ? Number(args.nowMs) : this._now();
    const kind = this.tripKind(nowMs);
    if (kind === null) return { allow: true };
    const risk = resolveRiskConfig(this.cfg.risk);
    let remaining = 0;
    let reason;
    if (kind === 'daily_loss' || kind === 'consecutive_losses') {
      remaining = cooldownRemainingMs(
        kind === 'daily_loss' ? this._dailyLossTripTsMs : this._consecutiveLossesTripTsMs,
        risk.circuit_breaker_cooldown_hours,
        nowMs,
      );
      const cooldownHours = (remaining / 3_600_000).toFixed(2);
      reason = kind === 'daily_loss'
        ? `circuit breaker (daily_loss): ${cooldownHours}h cooldown remaining`
        : `circuit breaker (consecutive_losses): ${cooldownHours}h cooldown remaining`;
    } else if (kind === 'loss_cooldown') {
      // T34: minutes-based cooldown. Format `Xm` (or `Xm Ys` if we want
      // sub-minute precision in the future) so the operator log line is
      // readable. The default 30 minutes would round to 0.5h — which is
      // less legible than `30m`.
      remaining = lossCooldownRemainingMs(
        this._stopLossCooldownTripTsMs,
        risk.loss_cooldown_minutes,
        nowMs,
      );
      const mins = Math.floor(remaining / 60_000);
      const secs = Math.floor((remaining % 60_000) / 1_000);
      reason = `circuit breaker (loss_cooldown): ${mins}m ${secs}s cooldown remaining (paused after stop-loss exit)`;
    } else {
      reason = `circuit breaker (${kind})`;
    }
    return {
      allow: false,
      tripKind: kind,
      reason,
      cooldownRemainingMs: remaining,
    };
  }

  /**
   * Manually reset the breaker. Useful when the operator verifies
   * the on-chain state and decides the bot can resume. Logs the
   * reset so the audit trail shows it.
   *
   * @param {Object} [opts]
   * @param {string} [opts.reason]   why the operator reset (free text)
   * @param {number} [opts.tsMs]     defaults to `this._now()`
   */
  reset(opts = {}) {
    const ts = (opts && Number.isFinite(opts.tsMs)) ? Number(opts.tsMs) : this._now();
    const wasTripped = this.isTripped(ts);
    const prevTrip = this.tripKind(ts);
    this._dailyLossTripTsMs = null;
    this._consecutiveLossesTripTsMs = null;
    this._stopLossCooldownTripTsMs = null;
    if (this.logger && wasTripped) {
      this.logger.info('circuit_breaker.reset', {
        previous_trip_kind: prevTrip,
        reason: opts?.reason ?? null,
        ts,
      });
    }
    return { wasTripped, previousTripKind: prevTrip, resetAtMs: ts };
  }

  /**
   * Erase the recorded trade history. Tests use this to make each
   * test deterministic. Does NOT clear an active trip — that's what
   * `reset()` is for.
   */
  _clearResults() {
    this._results = [];
  }

  /**
   * @private — sum the recorded P&L over the daily lookback window.
   * @returns {number} signed sats
   */
  _recentPnlSats(nowMs) {
    const cutoff = nowMs - this._dailyLookbackHours * 3_600_000;
    let total = 0;
    for (const r of this._results) {
      if (!r || typeof r !== 'object') continue;
      if (typeof r.tsMs !== 'number' || r.tsMs < cutoff) continue;
      total += r.pnlSats;
    }
    return total;
  }

  /**
   * @private — count trailing losses in the recorded history.
   * @returns {number}
   */
  _consecutiveLosses() {
    let count = 0;
    for (const r of this._results) {
      if (!r || typeof r !== 'object') continue;
      if (r.kind === 'loss') count += 1;
      else break;
    }
    return count;
  }

  /**
   * T53.2 — fire a `breaker_trip` AlertEvent through the
   * configured channels + NDJSON writer. Never throws: dispatch
   * failures are logged structured and swallowed so a Telegram
   * outage cannot poison the trader loop.
   *
   * @private
   * @param {Object} ctx
   */
  async _dispatchBreakerTrip(ctx) {
    const kind = (ctx && typeof ctx.kind === 'string') ? ctx.kind : 'breaker_trip';
    const ts = (ctx && Number.isFinite(ctx.ts)) ? Number(ctx.ts) : this._now();
    const event = {
      kind: 'breaker_trip',
      severity: 'error',
      title: `circuit_breaker_${kind}`,
      body: `circuit breaker tripped (${kind}); new entries paused for ${ctx.cooldown_hours ?? '?'}h`,
      context: {
        trip_kind: kind,
        token_id: ctx.token_id ?? null,
        exit_kind: ctx.exit_kind ?? null,
        pnl_sats: ctx.pnl_sats ?? null,
        consecutive_losses: ctx.consecutive_losses ?? null,
        recent_daily_pnl_sats: ctx.recent_daily_pnl_sats ?? null,
        max_daily_loss_bch: ctx.max_daily_loss_bch ?? null,
        max_consecutive_losses: ctx.max_consecutive_losses ?? null,
        cooldown_hours: ctx.cooldown_hours ?? null,
        ts,
      },
      ts,
    };
    await this._dispatchAlert(event, 'breaker.dispatch');
  }

  /**
   * T53.2 — fire a `wallet_floor` AlertEvent when the loss cooldown
   * starts. The cooldown pauses new entries for
   * `loss_cooldown_minutes` after a stop-loss exit, which from the
   * operator's POV is the wallet-floor concern (the bot is not
   * allowed to enter). Never throws.
   *
   * @private
   * @param {Object} ctx
   */
  async _dispatchLossCooldown(ctx) {
    const ts = (ctx && Number.isFinite(ctx.ts)) ? Number(ctx.ts) : this._now();
    const event = {
      kind: 'wallet_floor',
      severity: 'warn',
      title: 'loss_cooldown_started',
      body: `loss cooldown started: new entries paused for ${ctx.loss_cooldown_minutes ?? '?'}m after stop-loss exit`,
      context: {
        trip_kind: 'loss_cooldown',
        token_id: ctx.token_id ?? null,
        pnl_sats: ctx.pnl_sats ?? null,
        loss_cooldown_minutes: ctx.loss_cooldown_minutes ?? null,
        ts,
      },
      ts,
    };
    await this._dispatchAlert(event, 'breaker.dispatch');
  }

  /**
   * T53.2 — common dispatch helper. Routes through `_safeAlertDispatch`
   * (channel router) AND `_alertsAppend` (NDJSON writer); both are
   * independent and both never throw. A failure in either side
   * gets logged structured and swallowed.
   *
   * @private
   * @param {Object} event
   * @param {string} logEvent
   */
  async _dispatchAlert(event, logEvent) {
    // 1. NDJSON persistence — the audit trail must survive a bot
    //    restart even when the Telegram channel is disabled.
    if (this._alertsAppend) {
      try {
        await this._alertsAppend(event);
      } catch (e) {
        if (this.logger && typeof this.logger.warn === 'function') {
          this.logger.warn('circuit_breaker.alerts_persist.failed', {
            event: logEvent,
            error: e?.message ?? String(e),
            kind: event?.kind ?? null,
          });
        }
      }
    }
    // 2. Channel routing — the operator-visible notification.
    if (this._safeAlertDispatch) {
      try {
        await this._safeAlertDispatch(event);
      } catch (e) {
        if (this.logger && typeof this.logger.warn === 'function') {
          this.logger.warn('circuit_breaker.alerts_dispatch.failed', {
            event: logEvent,
            error: e?.message ?? String(e),
            kind: event?.kind ?? null,
          });
        }
      }
    }
  }
}

export const _internals = {
  classifyPnl,
  cooldownRemainingMs,
  lossCooldownRemainingMs,
  DEFAULT_DAILY_LOOKBACK_HOURS,
};