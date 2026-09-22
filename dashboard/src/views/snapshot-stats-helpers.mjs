#!/usr/bin/env node
// dashboard/src/views/snapshot-stats-helpers.mjs
//
// T65 — pure formatting helpers for the Dashboard's SnapshotStats
// tile. Kept separate from the JSX component so they're importable
// from `node --test` (Node can't parse .jsx files without a loader).
//
// The helpers project the T64 aggregate envelope
// (`/api/snapshots/aggregate` response) into the shapes the React
// tile needs: stats-bar lines, sparkline points, drawdown formatting,
// cache-source label.
//
// Every helper is dependency-free and has no side effects.

/**
 * Format a BCH value (as a JS number or sat-string) to a
 * fixed-precision string. Tolerates null / NaN / undefined / string
 * input. Returns '—' for null/undefined/NaN inputs.
 *
 * @param {number|string|null|undefined} v
 * @param {number} [decimals=6]
 * @returns {string}
 */
export function formatBch(v, decimals = 6) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number' && !Number.isFinite(v)) return '—';
  if (typeof v === 'string' && v.trim().length === 0) return '—';
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(decimals);
}

/**
 * Convert a sat value (bigint / string / number / null) to a BCH
 * number. Returns null for null/undefined/unparseable inputs.
 *
 * @param {bigint|number|string|null|undefined} sats
 * @returns {number|null}
 */
export function satsToBchNumber(sats) {
  if (sats === null || sats === undefined) return null;
  let n = null;
  if (typeof sats === 'bigint') n = Number(sats) / 1e8;
  else if (typeof sats === 'number') n = sats / 1e8;
  else if (typeof sats === 'string' && sats.trim().length > 0) {
    const parsed = Number(sats);
    if (Number.isFinite(parsed)) n = parsed / 1e8;
  }
  if (n === null || !Number.isFinite(n)) return null;
  return n;
}

/**
 * Format a sat-string (or number / bigint) to a BCH string with
 * the requested decimals. Returns '—' for null/undefined/unparseable.
 *
 * @param {bigint|number|string|null|undefined} sats
 * @param {number} [decimals=6]
 * @returns {string}
 */
export function satsToBch(sats, decimals = 6) {
  const n = satsToBchNumber(sats);
  if (n === null) return '—';
  return n.toFixed(decimals);
}

/**
 * Severity / color label for a drawdown value.
 *   positive — balance grew from first to last → green
 *   negative — balance shrank from first to last → red
 *   zero     — no change → gray
 *   null     — not enough data → gray
 *
 * @param {string|number|null|undefined} drawdownSats
 * @returns {'positive'|'negative'|'neutral'|'unknown'}
 */
export function drawdownSeverity(drawdownSats) {
  const n = satsToBchNumber(drawdownSats);
  if (n === null) return 'unknown';
  if (n > 0) return 'positive';
  if (n < 0) return 'negative';
  return 'neutral';
}

/**
 * Tailwind text class for drawdown severity.
 *
 * @param {string} severity
 * @returns {string}
 */
export function drawdownClass(severity) {
  switch (severity) {
    case 'positive': return 'text-emerald-400';
    case 'negative': return 'text-red-400';
    case 'neutral':  return 'text-ash-400';
    default:          return 'text-ash-500';
  }
}

/**
 * Format a drawdown value as a signed BCH string with sign.
 * e.g. "+0.001200 BCH" / "-0.000500 BCH" / "— BCH"
 *
 * @param {string|number|null|undefined} drawdownSats
 * @returns {string}
 */
export function formatDrawdownBch(drawdownSats) {
  if (drawdownSats === null || drawdownSats === undefined) return '—';
  const n = satsToBchNumber(drawdownSats);
  if (n === null) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(6)} BCH`;
}

/**
 * Build the "stats bar" lines for the snapshot aggregate tile.
 * Each line is a label + formatted value pair ready to render.
 *
 * Returns an array of { label, value, unit, highlight } objects.
 * highlight is true when the field is the "latest" balance.
 *
 * @param {Object|null|undefined} agg  — the /api/snapshots/aggregate response
 * @param {Object} [opts]
 * @param {number} [opts.decimals=6]  — BCH decimal places
 * @returns {Array<{label: string, value: string, unit: string, highlight: boolean}>}
 */
export function buildStatsBarLines(agg, opts = {}) {
  const decimals = (typeof opts.decimals === 'number' && Number.isFinite(opts.decimals)) ? opts.decimals : 6;
  const lines = [];

  if (!agg || typeof agg !== 'object') {
    return [
      { label: 'balance min',   value: '—', unit: 'BCH', highlight: false },
      { label: 'balance max',   value: '—', unit: 'BCH', highlight: false },
      { label: 'balance mean',  value: '—', unit: 'BCH', highlight: false },
      { label: 'balance latest', value: '—', unit: 'BCH', highlight: true  },
      { label: 'drawdown',       value: '—', unit: 'BCH', highlight: false },
      { label: 'open positions', value: '—', unit: '',    highlight: false },
    ];
  }

  const bal = agg.balance_sats;
  const exp = agg.total_exposure_sats;
  const pnl = agg.unrealized_pnl_sats;
  const cnt = agg.open_position_count;

  const latestBal = (bal && typeof bal === 'object' && bal.latest_bch != null) ? Number(bal.latest_bch) : null;

  // Balance min
  lines.push({
    label: 'balance min',
    value: (bal && bal.min_bch != null) ? Number(bal.min_bch).toFixed(decimals) : '—',
    unit: 'BCH',
    highlight: false,
  });

  // Balance max
  lines.push({
    label: 'balance max',
    value: (bal && bal.max_bch != null) ? Number(bal.max_bch).toFixed(decimals) : '—',
    unit: 'BCH',
    highlight: false,
  });

  // Balance mean
  lines.push({
    label: 'balance mean',
    value: (bal && bal.mean_bch != null) ? Number(bal.mean_bch).toFixed(decimals) : '—',
    unit: 'BCH',
    highlight: false,
  });

  // Balance latest (highlighted)
  lines.push({
    label: 'balance latest',
    value: (bal && bal.latest_bch != null) ? Number(bal.latest_bch).toFixed(decimals) : '—',
    unit: 'BCH',
    highlight: true,
  });

  // Drawdown
  const ddSev = drawdownSeverity(agg.drawdown_sats);
  const ddClass = drawdownClass(ddSev);
  lines.push({
    label: 'drawdown',
    value: formatDrawdownBch(agg.drawdown_sats),
    unit: '',
    highlight: false,
    severity: ddSev,
    valueClass: ddClass,
  });

  // Open positions (latest)
  const posLatest = (cnt && typeof cnt === 'object' && cnt.latest != null) ? String(cnt.latest) : '—';
  lines.push({
    label: 'open positions',
    value: posLatest,
    unit: '',
    highlight: false,
  });

  return lines;
}

/**
 * Build sparkline data points from the aggregate envelope.
 * Returns an array of { ts: number, value: number } for recharts,
 * or an empty array when there's insufficient data.
 *
 * The sparkline uses balance_sats.mean_bch per bucket so the
 * operator can spot a sweep at a glance without needing the raw
 * 1800-row dataset.
 *
 * @param {Object|null|undefined} agg
 * @returns {Array<{ts: number, value: number}>}
 */
export function buildSparklinePoints(agg) {
  if (!agg || typeof agg !== 'object') return [];
  // The aggregate envelope doesn't carry per-bucket means — it only
  // carries the rollup. For the sparkline we render the latest balance
  // value from the aggregate. The real per-bucket sparkline will come
  // from the /api/snapshots/buckets endpoint (T65 deferred / future).
  // For now, return a single point at the latest timestamp so the
  // sparkline slot isn't empty — the operator sees the current balance.
  const bal = agg.balance_sats;
  if (!bal || typeof bal !== 'object') return [];
  const latestBal = (bal.latest_bch != null) ? Number(bal.latest_bch) : null;
  const lastTs = typeof agg.last_ts === 'string' ? new Date(agg.last_ts).getTime() : null;
  if (latestBal === null || !Number.isFinite(latestBal) || lastTs === null) return [];
  return [{ ts: lastTs, value: latestBal }];
}

/**
 * Cache-source label for the stats tile badge.
 * Returns e.g. "cached 12s ago" or "fresh" or "—".
 *
 * @param {Object|null|undefined} agg
 * @returns {string}
 */
export function cacheSourceLabel(agg) {
  if (!agg || typeof agg !== 'object') return '—';
  const source = agg.source;
  if (source === 'cache') {
    const age = agg.cache_age_ms;
    if (typeof age === 'number' && Number.isFinite(age)) {
      const s = Math.floor(age / 1000);
      if (s < 60) return `cached ${s}s ago`;
      const m = Math.floor(s / 60);
      return `cached ${m}m ago`;
    }
    return 'cached';
  }
  if (source === 'fresh') return 'fresh';
  return '—';
}

/**
 * Check whether the aggregate envelope represents a degraded / error
 * state that should render the "stats unavailable" pill.
 *
 * @param {Object|null|undefined} agg
 * @returns {boolean}
 */
export function isAggregateUnavailable(agg) {
  if (!agg || typeof agg !== 'object') return true;
  const err = agg.error;
  if (typeof err === 'string' && err.length > 0) return true;
  return false;
}

/**
 * Error message to show in the unavailable pill.
 *
 * @param {Object|null|undefined} agg
 * @returns {string}
 */
export function aggregateErrorMessage(agg) {
  if (!agg || typeof agg !== 'object') return 'stats unavailable';
  if (typeof agg.message === 'string' && agg.message.length > 0) return agg.message;
  if (typeof agg.error === 'string' && agg.error.length > 0) return agg.error;
  return 'stats unavailable';
}

/**
 * Bucket count label for the stats tile.
 *
 * @param {Object|null|undefined} agg
 * @returns {string}
 */
export function bucketCountLabel(agg) {
  if (!agg || typeof agg !== 'object') return '0 snapshots';
  const n = agg.bucket_count;
  if (typeof n !== 'number' || !Number.isFinite(n)) return '0 snapshots';
  return n === 1 ? '1 snapshot' : `${n} snapshots`;
}
