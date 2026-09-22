// dashboard/src/views/risk-panel-helpers.mjs
//
// Pure helpers for the Dashboard's "live risk panel" widget
// (T41). The .jsx file (`Dashboard.jsx`) imports these to format
// the wire envelope returned by `GET /api/risk-panel` so that the
// .jsx is kept free of formatting + threshold logic and the
// Node-only test suite can pin every edge case without a JSX
// loader.
//
// The widget surfaces four risk dimensions:
//
//   1. exposure       — current open BCH vs `max_total_exposure_bch`
//   2. daily_loss     — realized P&L in last 24h vs `-max_daily_loss_bch`
//   3. drawdown       — peak balance vs current balance (last 30d)
//   4. concentration  — top open positions ranked by BCH spent
//
// Plus a pass-through of the circuit-breaker state (when wired).

/**
 * Threshold severity buckets for the exposure tile.
 *
 *   ok        — well under the configured limit; < 60% utilized
 *   caution   — 60-80% utilized
 *   warn      — 80-95% utilized
 *   critical  — 95%+ utilized (or current > max when max is set)
 *
 * @param {number|null} utilization   0..1 (null when no limit configured)
 * @returns {'ok'|'caution'|'warn'|'critical'|'unknown'}
 */
export function exposureSeverity(utilization) {
  if (utilization === null || utilization === undefined) return 'unknown';
  if (typeof utilization !== 'number' || !Number.isFinite(utilization)) return 'unknown';
  if (utilization >= 0.95) return 'critical';
  if (utilization >= 0.80) return 'warn';
  if (utilization >= 0.60) return 'caution';
  return 'ok';
}

/**
 * Same severity shape for the daily-loss tile. Negative-realized
 * (a loss) is the concerning direction; positive P&L is always ok.
 *
 *   ok         — realized >= 0 OR no threshold configured
 *   caution    — realized between -threshold and -60% of threshold
 *   warn       — realized between -60% and -90% of threshold
 *   critical   — realized past -90% (or past threshold — `limit_breached`)
 *
 * @param {bigint|number|string|null} realizedSats
 * @param {number|null} thresholdBch
 * @param {boolean} [limitBreached]
 * @returns {'ok'|'caution'|'warn'|'critical'|'unknown'}
 */
export function dailyLossSeverity(realizedSats, thresholdBch, limitBreached = false) {
  if (limitBreached === true) return 'critical';
  if (thresholdBch === null || thresholdBch === undefined) return 'ok';
  if (typeof thresholdBch !== 'number' || !Number.isFinite(thresholdBch) || thresholdBch >= 0) return 'ok';
  const sat = toSafeBigInt(realizedSats);
  if (sat === null) return 'unknown';
  // sat >= 0 means profit; severity is always ok.
  if (sat >= 0n) return 'ok';
  // For losses, ratio = -realized / -threshold.
  const lossSats = -sat;
  const limitSats = BigInt(Math.round(-thresholdBch * 100_000_000));
  if (limitSats <= 0n) return 'ok';
  const ratio = Number(lossSats) / Number(limitSats);
  if (ratio >= 0.9) return 'critical';
  if (ratio >= 0.6) return 'warn';
  if (ratio >= 0.3) return 'caution';
  return 'ok';
}

/**
 * Severity for the drawdown tile. Maps drawdown_pct to buckets.
 *
 *   ok         — 0-5%
 *   caution    — 5-15%
 *   warn       — 15-30%
 *   critical   — 30%+ (or > 50% = catastrophic)
 *
 * @param {number|null} drawdownPct
 * @returns {'ok'|'caution'|'warn'|'critical'|'unknown'}
 */
export function drawdownSeverity(drawdownPct) {
  if (drawdownPct === null || drawdownPct === undefined) return 'unknown';
  if (typeof drawdownPct !== 'number' || !Number.isFinite(drawdownPct)) return 'unknown';
  if (drawdownPct <= 0) return 'ok';
  if (drawdownPct >= 30) return 'critical';
  if (drawdownPct >= 15) return 'warn';
  if (drawdownPct >= 5) return 'caution';
  return 'ok';
}

/**
 * Map a severity bucket to a Tailwind colour class. Mirrors the
 * `pnlClass()` convention from `lib/format.mjs`.
 *
 * @param {'ok'|'caution'|'warn'|'critical'|'unknown'} severity
 * @returns {string}
 */
export function severityClass(severity) {
  switch (severity) {
    case 'ok': return 'text-pnl-win';
    case 'caution': return 'text-amber-300';
    case 'warn': return 'text-orange-400';
    case 'critical': return 'text-pnl-loss';
    case 'unknown':
    default: return 'text-ash-300';
  }
}

/**
 * Map a severity bucket to a bar-fill Tailwind class (for the
 * progress bars). Slightly darker than the text colour for
 * contrast against the dark track.
 */
export function severityBarClass(severity) {
  switch (severity) {
    case 'ok': return 'bg-pnl-win';
    case 'caution': return 'bg-amber-400';
    case 'warn': return 'bg-orange-500';
    case 'critical': return 'bg-pnl-loss';
    case 'unknown':
    default: return 'bg-ash-500';
  }
}

/**
 * Compute the bar-fill width percentage (0..100). Clamps the
 * `pct` arg to [0, 100] and returns `0` for null / invalid input.
 *
 * @param {number|null|undefined} pct   0..100
 * @returns {number}
 */
export function severityBarPct(pct) {
  if (pct === null || pct === undefined) return 0;
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return 0;
  if (pct < 0) return 0;
  if (pct > 100) return 100;
  return pct;
}

/**
 * Format a BCH amount as "X.XXXXXXXX BCH". Defaults to 8 dp
 * (sats-precise) for tiny balances. Tolerant of null/undefined/
 * non-finite/NaN.
 */
export function formatBchAmount(bch) {
  if (bch === null || bch === undefined) return '—';
  if (typeof bch !== 'number' || !Number.isFinite(bch)) return '—';
  return `${bch.toFixed(8)} BCH`;
}

/**
 * Format a sat amount (bigint/string/number) as "N NNN NNN sat
 * (X.XXXXXXXX BCH)". Returns '—' for missing/invalid input.
 */
export function formatSatsAmount(sats) {
  const b = toSafeBigInt(sats);
  if (b === null) return '—';
  const bch = Number(b) / 100_000_000;
  return `${b.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} sat (${bch.toFixed(8)} BCH)`;
}

/**
 * Format a percentage as "+X.XX%" / "-X.XX%" / "0.00%". Tolerant
 * of null/undefined/NaN — returns '—' for invalid input.
 */
export function formatPctSigned(pct) {
  if (pct === null || pct === undefined) return '—';
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return '—';
  const sign = pct > 0 ? '+' : (pct < 0 ? '-' : '');
  return `${sign}${Math.abs(pct).toFixed(2)}%`;
}

/**
 * Format a utilization (0..1) as a percentage string. Returns
 * "—" for null/invalid (e.g. no max configured).
 */
export function utilizationPct(utilization) {
  if (utilization === null || utilization === undefined) return '—';
  if (typeof utilization !== 'number' || !Number.isFinite(utilization)) return '—';
  return `${(utilization * 100).toFixed(1)}%`;
}

/**
 * Compute the relative time string ("3h ago", "5d ago"). Returns
 * null for missing/invalid input (so the caller can render "—"
 * instead of "null ago").
 */
export function relativeTimeAgo(isoTs, nowMs = Date.now()) {
  if (typeof isoTs !== 'string' || isoTs.length === 0) return null;
  const ts = Date.parse(isoTs);
  if (!Number.isFinite(ts)) return null;
  const safeNow = Number.isFinite(nowMs) ? nowMs : Date.now();
  const elapsedMs = safeNow - ts;
  if (elapsedMs < 0) return 'just now';
  if (elapsedMs < 60_000) return 'just now';
  if (elapsedMs < 3_600_000) return `${Math.round(elapsedMs / 60_000)}m ago`;
  if (elapsedMs < 86_400_000) return `${Math.round(elapsedMs / 3_600_000)}h ago`;
  return `${Math.round(elapsedMs / 86_400_000)}d ago`;
}

/**
 * Format the circuit-breaker state for the panel header. Returns
 * one of: 'idle', 'tripped: <kind> (<reason>)'. Returns null for
 * missing state (so the caller can skip the section).
 */
export function circuitBreakerSummary(cbState) {
  if (!cbState || typeof cbState !== 'object') return null;
  // Only treat the state object as a real breaker snapshot when
  // it carries an `isTripped` boolean. An empty `{}` (no breaker
  // state at all) returns null so the caller renders the
  // "circuit breaker: not wired" placeholder instead of a
  // misleading "idle" chip.
  if (typeof cbState.isTripped !== 'boolean') return null;
  if (cbState.isTripped === true) {
    const kind = typeof cbState.tripKind === 'string' ? cbState.tripKind : 'unknown';
    const reason = kind === 'daily_loss'
      ? `recent pnl ${formatSignedSats(cbState.recentDailyPnlSats ?? 0n)} sats`
      : kind === 'consecutive_losses'
        ? `${cbState.consecutiveLosses} stop-losses in a row`
        : kind === 'loss_cooldown'
          ? 'cooldown after stop-loss'
          : 'manual or unknown';
    return { status: 'tripped', kind, reason };
  }
  return { status: 'idle', kind: null, reason: null };
}

// ─────────────────────────────────────────────────────────────────────
//  Tiny utils (no external deps)
// ─────────────────────────────────────────────────────────────────────

function toSafeBigInt(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    return BigInt(Math.round(v));
  }
  if (typeof v === 'string' && v.length > 0) {
    try { return BigInt(v); } catch { return null; }
  }
  return null;
}

function formatSignedSats(sats) {
  const b = toSafeBigInt(sats);
  if (b === null) return '0';
  return b.toString();
}

export const _internals = { toSafeBigInt };