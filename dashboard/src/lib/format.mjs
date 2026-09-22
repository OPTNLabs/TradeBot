// dashboard/src/lib/format.mjs
//
// Pure formatting helpers used across the three dashboard views.
// Every helper is dependency-free so the test suite can pin its
// behaviour with `node --test` without touching DOM globals.
//
// All numeric helpers accept either a `number` or a numeric string
// (the backend serializes sat/BCH fields as strings to avoid
// bigint precision loss). All helpers tolerate `null` / `undefined`
// by returning a placeholder string — the UI never crashes on a
// missing field.

/** @type {number} Sats in 1 BCH. Plain number — formatters never deal with >2^53 sats. */
export const SATS_PER_BCH = 100_000_000;

const PLACEHOLDER = '—';

/**
 * Convert satoshis → BCH. Accepts number, string, bigint, null,
 * or undefined. Returns `null` when the input can't be parsed.
 *
 * @param {number|string|bigint|null|undefined} sats
 * @returns {number|null}
 */
export function satsToBch(sats) {
  if (sats === null || sats === undefined) return null;
  let n;
  if (typeof sats === 'bigint') n = Number(sats);
  else if (typeof sats === 'number') n = sats;
  else if (typeof sats === 'string') {
    if (sats.length === 0) return null;
    const parsed = Number(sats);
    if (!Number.isFinite(parsed)) return null;
    n = parsed;
  } else {
    return null;
  }
  if (!Number.isFinite(n)) return null;
  return n / 100_000_000;
}

/**
 * Format a sat amount as a BCH string with 8 decimals (or fewer
 * when the trailing digits are zero). Used everywhere on the
 * dashboard for sat→BCH conversions.
 *
 * @param {number|string|bigint|null|undefined} sats
 * @param {Object} [opts]
 * @param {number} [opts.maxDecimals=8]
 * @returns {string}
 */
export function formatBch(sats, opts) {
  const bch = satsToBch(sats);
  if (bch === null) return PLACEHOLDER;
  const maxDecimals = (opts && typeof opts.maxDecimals === 'number') ? opts.maxDecimals : 8;
  return `${bch.toFixed(maxDecimals)} BCH`;
}

/**
 * Format a sat amount as the integer + BCH unit shorthand.
 *
 * @param {number|string|bigint|null|undefined} sats
 * @returns {string}
 */
export function formatSats(sats) {
  if (sats === null || sats === undefined) return PLACEHOLDER;
  let n;
  if (typeof sats === 'bigint') n = sats.toString();
  else if (typeof sats === 'number') n = Number.isFinite(sats) ? Math.round(sats).toString() : null;
  else if (typeof sats === 'string') {
    if (!/^-?\d+$/.test(sats.trim())) return PLACEHOLDER;
    n = sats.trim();
  } else {
    return PLACEHOLDER;
  }
  if (n === null) return PLACEHOLDER;
  // Insert thin-space thousand separators (no JS regex lookbehind
  // needed — reverse + chunk + reverse).
  const negative = n.startsWith('-');
  const digits = negative ? n.slice(1) : n;
  const out = digits.replace(/\B(?=(\d{3})+(?!\d))/g, '\u202F');
  return `${negative ? '-' : ''}${out}\u202Fsat`;
}

/**
 * Format a percentage with `decimals` fractional digits. Returns
 * the placeholder when the value isn't a finite number.
 *
 * @param {number|null|undefined} pct
 * @param {number} [decimals=2]
 * @returns {string}
 */
export function formatPct(pct, decimals) {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return PLACEHOLDER;
  const d = (typeof decimals === 'number') ? decimals : 2;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(d)}%`;
}

/**
 * Map a percentage to a Tailwind colour token. Returns
 * `'text-pnl-win'` / `'text-pnl-loss'` / `'text-ash-200'` /
 * `'text-pnl-neutral'`. Defaults to neutral so missing values
 * don't accidentally look green.
 *
 * @param {number|null|undefined} pct
 * @returns {string}
 */
export function pnlClass(pct) {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return 'text-pnl-neutral';
  if (pct > 0) return 'text-pnl-win';
  if (pct < 0) return 'text-pnl-loss';
  return 'text-pnl-neutral';
}

/**
 * Convert a millisecond duration into a human-readable string.
 * Examples:
 *   900       → "900ms"
 *   65_000    → "1m 5s"
 *   3_600_000 → "1h 0m"
 *   90_000_000 → "1d 1h"
 *
 * @param {number|null|undefined} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return PLACEHOLDER;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/**
 * Format an ISO timestamp (or epoch ms) as `YYYY-MM-DD HH:MM:SS`
 * in UTC. Used for the history + snapshots tables where a single
 * timezone keeps the comparison fair.
 *
 * @param {string|number|Date|null|undefined} ts
 * @returns {string}
 */
export function formatUtc(ts) {
  if (ts === null || ts === undefined) return PLACEHOLDER;
  const d = (ts instanceof Date) ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return PLACEHOLDER;
  const pad = (n) => n.toString().padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

/**
 * Format an ISO timestamp (or epoch ms) as `YYYY-MM-DD HH:MM:SS`
 * in the operator's local timezone (the browser's TZ for dashboard
 * renders; the host's TZ in `node --test` runs). The previous
 * version of these surfaces all used `formatUtc`, which labelled
 * UTC-stamped bot events as local — operators looking at the
 * history table at 19:48 PDT saw entries from "23:08" and assumed
 * the bot was either 3 hours in the future or stuck. Reality was
 * just UTC-vs-local drift.
 *
 * If `opts.tz` is supplied, format the timestamp in that specific
 * IANA timezone via `Intl.DateTimeFormat` — useful for tests (lock
 * the contract regardless of CI timezone) and for "show me UTC"
 * tags next to a local-time stamp on a single surface.
 *
 * @param {string|number|Date|null|undefined} ts
 * @param {{tz?: string}} [opts]
 * @returns {string}
 */
export function formatLocal(ts, opts) {
  if (ts === null || ts === undefined) return PLACEHOLDER;
  const d = (ts instanceof Date) ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return PLACEHOLDER;
  if (opts && typeof opts.tz === 'string' && opts.tz.length > 0) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: opts.tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(d);
    const grab = (type) => {
      const p = parts.find((x) => x.type === type);
      return p ? p.value : '';
    };
    return (
      `${grab('year')}-${grab('month')}-${grab('day')} ` +
      `${grab('hour')}:${grab('minute')}:${grab('second')}`
    );
  }
  const pad = (n) => n.toString().padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/**
 * Truncate a string to `max` characters with an ellipsis suffix.
 * Used for displaying long token IDs / txids without breaking the
 * table layout.
 *
 * @param {string|null|undefined} s
 * @param {number} [max=12]
 * @returns {string}
 */
export function truncate(s, max) {
  if (typeof s !== 'string') return PLACEHOLDER;
  const m = (typeof max === 'number' && max > 0) ? Math.floor(max) : 12;
  if (s.length <= m) return s;
  if (m <= 3) return s.slice(0, m);
  return `${s.slice(0, m - 1)}…`;
}

/**
 * Map a status string to a Tailwind badge colour class. Used by
 * the PORTFOLIO table to colour-code open / pending / closing /
 * closed rows.
 *
 * @param {string|null|undefined} status
 * @returns {string}
 */
export function statusClass(status) {
  switch (status) {
    case 'open':    return 'bg-emerald-900/40 text-emerald-200 border-emerald-700/60';
    case 'pending': return 'bg-amber-900/40 text-amber-200 border-amber-700/60';
    case 'closing': return 'bg-sky-900/40 text-sky-200 border-sky-700/60';
    case 'closed':  return 'bg-ink-700/40 text-ash-200 border-ink-500/60';
    default:        return 'bg-ink-700/40 text-ash-200 border-ink-500/60';
  }
}

/**
 * Map a side string (`'buy'` / `'sell'`) to a colour class.
 *
 * @param {string|null|undefined} side
 * @returns {string}
 */
export function sideClass(side) {
  if (side === 'buy')  return 'text-bch-400';
  if (side === 'sell') return 'text-pnl-loss';
  return 'text-ash-200';
}

/**
 * Format a fungible-token base-unit amount as its human-readable
 * display value, using the token's BCMR-reported `decimals`.
 *
 * The chain stores token amounts as integers ("base units" — the
 * smallest indivisible unit). For a token with `decimals: 2` (e.g.
 * Olando), `507044` base units = `5,070.44 OLA`. Without the
 * decimals adjustment the dashboard would show raw `507044`
 * which is off by 100x for a 2-decimal token, 1e8x for an
 * 8-decimal token.
 *
 * Accepts `bigint`, `string`, `number`, `null`, or `undefined`.
 * Returns the placeholder when the input can't be parsed.
 *
 * When `decimals` is missing / `null` / not a finite number, falls
 * back to the raw integer with thin-space thousand separators
 * (the previous behavior — best-effort so the UI doesn't break on
 * a stale or partial BCMR lookup). Callers that want a hard
 * distinction can pass `{ rawOnMissing: false }` to get the
 * placeholder instead.
 *
 * Trailing-zero trimming mirrors `formatBch`: `5,070.44` stays
 * `5,070.44`; `5,070` stays `5,070` (no spurious `.00`).
 *
 * @param {number|string|bigint|null|undefined} rawAmount
 * @param {number|null|undefined} decimals
 * @param {Object} [opts]
 * @param {number} [opts.maxDecimals=8]   cap fractional digits
 * @param {boolean} [opts.rawOnMissing=true]   when decimals is null, return formatted raw int (vs `'—'`)
 * @returns {string}
 */
export function formatTokenAmount(rawAmount, decimals, opts = {}) {
  const maxDecimals = (typeof opts.maxDecimals === 'number' && Number.isFinite(opts.maxDecimals) && opts.maxDecimals >= 0)
    ? Math.floor(opts.maxDecimals)
    : 8;
  const rawOnMissing = (typeof opts.rawOnMissing === 'boolean') ? opts.rawOnMissing : true;
  if (rawAmount === null || rawAmount === undefined) return PLACEHOLDER;
  // Coerce to BigInt for arbitrary-precision base-unit handling.
  let raw;
  try {
    if (typeof rawAmount === 'bigint') raw = rawAmount;
    else if (typeof rawAmount === 'number') {
      if (!Number.isFinite(rawAmount)) return PLACEHOLDER;
      raw = BigInt(Math.trunc(rawAmount));
    } else if (typeof rawAmount === 'string') {
      const trimmed = rawAmount.trim();
      if (trimmed.length === 0 || !/^-?\d+$/.test(trimmed)) return PLACEHOLDER;
      raw = BigInt(trimmed);
    } else {
      return PLACEHOLDER;
    }
  } catch (_e) {
    return PLACEHOLDER;
  }
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  // Missing or invalid decimals → render the raw integer (with
  // thin-space separators) so the operator at least sees the
  // magnitude. Symbol/lack of decimals renders separately via
  // TokenBadge so the false precision is bounded by the
  // placeholder text next to the badge.
  if (typeof decimals !== 'number' || !Number.isFinite(decimals) || decimals < 0) {
    if (!rawOnMissing) return PLACEHOLDER;
    return `${negative ? '-' : ''}${formatSats(abs.toString()).replace(/\s+sat$/, '')}`;
  }
  if (decimals === 0) {
    return `${negative ? '-' : ''}${formatSats(abs.toString()).replace(/\s+sat$/, '')}`;
  }
  // Split into integer + fractional parts using string ops
  // (avoids Number→BigInt precision loss for tokens like QBTC
  // with decimals=8 and balances in the millions of base units).
  const dInt = Math.floor(decimals);
  const padded = abs.toString().padStart(dInt + 1, '0');
  const intPart = padded.slice(0, padded.length - dInt);
  const fracPart = padded.slice(padded.length - dInt);
  // Format the integer part with thin-space thousand separators.
  const intFmt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '\u202F');
  if (maxDecimals === 0 || dInt <= maxDecimals) {
    // No trimming needed (or no fractional digits requested) —
    // strip trailing zeros from the fraction so `5,070.40` becomes
    // `5,070.4` (matches the convention used by `formatBch`).
    const trimmedFrac = fracPart.replace(/0+$/, '');
    if (trimmedFrac.length === 0) return `${negative ? '-' : ''}${intFmt}`;
    return `${negative ? '-' : ''}${intFmt}.${trimmedFrac}`;
  }
  // Truncate fractional digits to maxDecimals and strip trailing
  // zeros. Pads with zeros if needed (e.g. 0.00123 → "0.00123").
  let frac = fracPart.slice(0, maxDecimals);
  if (frac.length < maxDecimals) frac = frac.padEnd(maxDecimals, '0');
  frac = frac.replace(/0+$/, '');
  if (frac.length === 0) return `${negative ? '-' : ''}${intFmt}`;
  return `${negative ? '-' : ''}${intFmt}.${frac}`;
}

/**
 * Parse a BCH-string (e.g. `"0.005"`) to sats as a string. Used
 * by the SETTINGS form when the user types a number into a text
 * field. Returns `null` for unparseable input.
 *
 * @param {string|number|null|undefined} v
 * @returns {string|null}
 */
export function parseBchToSats(v) {
  if (v === null || v === undefined) return null;
  let n;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    n = v;
  } else if (typeof v === 'string') {
    const t = v.trim();
    if (t.length === 0) return null;
    const parsed = Number(t);
    if (!Number.isFinite(parsed)) return null;
    n = parsed;
  } else {
    return null;
  }
  if (n < 0) return null;
  const sats = Math.round(n * 100_000_000);
  return sats.toString();
}

/**
 * Parse a string → number, defaulting to a fallback on failure.
 * Used by sliders / numeric inputs where `''` should mean "leave
 * the default alone" rather than throw.
 *
 * @param {any} v
 * @param {number} fallback
 * @returns {number}
 */
export function parseNumberOr(v, fallback) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t.length === 0) return fallback;
    const n = Number(t);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/**
 * Format a sat amount as "<n> sats (X.XX BCH)". Used as the
 * helper-text annotation next to sat-valued config knobs in the
 * SETTINGS view (e.g. `entry.min_amm_total_depth_sats`) so the
 * operator doesn't have to mentally divide by 1e8 to see what
 * they're configuring. Returns `null` when the input can't be
 * parsed; the call site renders `placeholder` in that case.
 *
 * @param {number|string|bigint|null|undefined} sats
 * @param {Object} [opts]
 * @param {number} [opts.maxDecimals=4]   BCH-side decimal precision
 * @returns {string|null}
 */
export function formatSatsBch(sats, opts) {
  const bch = satsToBch(sats);
  if (bch === null) return null;
  const maxDecimals = (opts && typeof opts.maxDecimals === 'number') ? opts.maxDecimals : 4;
  const bchStr = bch.toFixed(maxDecimals);
  // Use thin-space thousand separators for the sats count (mirrors
  // formatSats) so very large numbers are readable.
  const n = (typeof sats === 'bigint') ? sats.toString()
         : (typeof sats === 'number') ? Math.round(sats).toString()
         : (typeof sats === 'string') ? sats.trim().replace(/^-/, '').replace(/\.\d+$/, '')
         : '';
  const digits = n.replace(/\B(?=(\d{3})+(?!\d))/g, '\u202F');
  return `${digits}\u202Fsat (${bchStr}\u202FBCH)`;
}