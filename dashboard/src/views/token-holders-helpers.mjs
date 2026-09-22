#!/usr/bin/env node
// dashboard/src/views/token-holders-helpers.mjs
//
// T76 subset 2c — pure formatting helpers for the Dashboard's
// `TokenHoldersCard` tile. Mirrors the patterns from
// `token-summary-helpers.mjs` (T68), `fee-breakdown-helpers.mjs`
// (T71), and `staking-status-helpers.mjs` (T58-4) — every helper
// is dependency-free, no DOM, no module-scope state, no I/O.
//
// Helpers project the `GET /api/token/:tokenId/holders` response
// envelope (live-wire + stub + fixture + token_not_found +
// scanner_failed) into the shapes the React tile needs: header
// card fields, per-row display rows, severity pills, cache badges.
//
// The envelope can come from one of three paths:
//   1. **Live (default)** — when `scoring.concentration_rug_enabled=true`
//      the dashboard resolves through the in-process scanner +
//      cache and returns the math-layer envelope translated to the
//      wire shape (`computeHolderConcentration` + `isRugPatternByHolders`
//      + the per-row `nft_count` / `snapshot_at_unix_s` extension).
//   2. **Stub (subset 1)** — when the gate is OFF and no `?holders=`
//      fixture is provided, the dashboard returns
//      `{ok:false, error:'scanner_not_implemented', ...}`. The
//      tile surfaces this as an amber pill with the remediation hint.
//   3. **Fixture (`?holders=<json>`)** — operator-testing affordance
//      that runs the math against a hand-built array. Returns the
//      same envelope shape as the live path but with `fixture:true`.

const SATS_PER_BCH_NUM = 100_000_000;

// ─────────────────────────────────────────────────────────────────────
// Numeric coercion + formatting
// ─────────────────────────────────────────────────────────────────────

/**
 * Coerce a value to a finite non-negative number. Returns `null`
 * for null/undefined/NaN/Infinity/strings/blanks/non-finite floats.
 * Used for `pct_of_supply` + `top_n_pct` + cache-age math where
 * the upstream can be float, string, bigint-stringified, or null.
 *
 *   pctToNumber(null)       → null
 *   pctToNumber(undefined)  → null
 *   pctToNumber(50)         → 50
 *   pctToNumber('80')       → 80
 *   pctToNumber(NaN)        → null
 *   pctToNumber(Infinity)   → null
 *   pctToNumber(-1)         → null  (pcts are never negative)
 *   pctToNumber('abc')      → null
 *
 * @param {*} v
 * @returns {number|null}
 */
export function pctToNumber(v) {
  if (v === null || v === undefined) return null;
  let n;
  if (typeof v === 'number') {
    n = v;
  } else if (typeof v === 'string') {
    const trimmed = v.trim();
    if (trimmed.length === 0) return null;
    n = Number(trimmed);
  } else if (typeof v === 'bigint') {
    // BigInt pcts are unusual but not impossible; coerce via toString.
    n = Number(v.toString());
  } else {
    return null;
  }
  if (!Number.isFinite(n)) return null;
  if (n < 0) return null;
  return n;
}

/**
 * Format a percentage as a 1-decimal float string. Returns `'—'`
 * (em dash) on null/non-finite/negative — same convention as the
 * rest of the dashboard.
 *
 *   pctFormat(null)        → '—'
 *   pctFormat(undefined)   → '—'
 *   pctFormat(50)          → '50.0%'
 *   pctFormat(80.5)        → '80.5%'
 *   pctFormat(0)           → '0.0%'
 *   pctFormat(100)         → '100.0%'
 *   pctFormat(NaN)         → '—'
 *
 * @param {*} v
 * @returns {string}
 */
export function pctFormat(v) {
  const n = pctToNumber(v);
  if (n === null) return '—';
  return `${n.toFixed(1)}%`;
}

/**
 * Classify a percentage into a severity band. Mirrors the rug-pattern
 * threshold (default 80%) so the operator can SEE the band edge
 * in the header pill.
 *
 *   pctOfSupplySeverity(0)     → 'safe'      (green)
 *   pctOfSupplySeverity(49.9)  → 'safe'      (green)
 *   pctOfSupplySeverity(50)    → 'caution'   (amber)
 *   pctOfSupplySeverity(79.9)  → 'caution'   (amber)
 *   pctOfSupplySeverity(80)    → 'danger'    (red)
 *   pctOfSupplySeverity(100)   → 'danger'    (red)
 *   pctOfSupplySeverity(null)  → 'unknown'   (gray)
 *
 * @param {*} v
 * @returns {'safe'|'caution'|'danger'|'unknown'}
 */
export function pctOfSupplySeverity(v) {
  const n = pctToNumber(v);
  if (n === null) return 'unknown';
  if (n >= 80) return 'danger';
  if (n >= 50) return 'caution';
  return 'safe';
}

/**
 * Severity-to-Tailwind class mapping. Mirrors the convention used
 * by `token-summary-helpers.mjs#pnlClass` and
 * `fee-breakdown-helpers.mjs#shareClass`.
 *
 *   pctOfSupplySeverityClass('safe')    → 'text-emerald-400'
 *   pctOfSupplySeverityClass('caution') → 'text-amber-400'
 *   pctOfSupplySeverityClass('danger')  → 'text-rose-400'
 *   pctOfSupplySeverityClass('unknown') → 'text-ash-400'
 *
 * @param {'safe'|'caution'|'danger'|'unknown'} sev
 * @returns {string}
 */
export function pctOfSupplySeverityClass(sev) {
  if (sev === 'safe') return 'text-emerald-400';
  if (sev === 'caution') return 'text-amber-400';
  if (sev === 'danger') return 'text-rose-400';
  return 'text-ash-400';
}

/**
 * Severity-to-pill class mapping (background + border + text).
 * Mirrors `pctOfSupplySeverityClass` but for the larger "pill"
 * component that wraps the severity badge.
 *
 *   pctOfSupplyPillClass('safe')    → 'border-emerald-700/50 bg-emerald-950/30 text-emerald-300'
 *   pctOfSupplyPillClass('caution') → 'border-amber-700/50 bg-amber-950/30 text-amber-300'
 *   pctOfSupplyPillClass('danger')  → 'border-rose-700/50 bg-rose-950/30 text-rose-300'
 *   pctOfSupplyPillClass('unknown') → 'border-ink-700 bg-ink-900/30 text-ash-400'
 *
 * @param {'safe'|'caution'|'danger'|'unknown'} sev
 * @returns {string}
 */
export function pctOfSupplyPillClass(sev) {
  if (sev === 'safe') return 'border-emerald-700/50 bg-emerald-950/30 text-emerald-300';
  if (sev === 'caution') return 'border-amber-700/50 bg-amber-950/30 text-amber-300';
  if (sev === 'danger') return 'border-rose-700/50 bg-rose-950/30 text-rose-300';
  return 'border-ink-700 bg-ink-900/30 text-ash-400';
}

/**
 * Classify the rug-pattern boolean into a severity band. Returns
 * `'danger'` for true (rug detected), `'safe'` for false, `'unknown'`
 * for null (no upstream data yet). Same color mapping as
 * `pctOfSupplySeverity` but with a different threshold (binary).
 *
 *   rugPatternSeverity(true)   → 'danger'
 *   rugPatternSeverity(false)  → 'safe'
 *   rugPatternSeverity(null)   → 'unknown'
 *
 * @param {boolean|null|undefined} v
 * @returns {'safe'|'danger'|'unknown'}
 */
export function rugPatternSeverity(v) {
  if (v === true) return 'danger';
  if (v === false) return 'safe';
  return 'unknown';
}

/**
 * Human-readable label for the rug-pattern pill. Mirrors the
 * convention of `'RUG PATTERN'` for true / `'ok'` for false /
 * `'unknown'` for null.
 *
 *   rugPatternLabel(true)   → 'RUG PATTERN'
 *   rugPatternLabel(false)  → 'ok'
 *   rugPatternLabel(null)   → 'unknown'
 *
 * @param {boolean|null|undefined} v
 * @returns {string}
 */
export function rugPatternLabel(v) {
  if (v === true) return 'RUG PATTERN';
  if (v === false) return 'ok';
  return 'unknown';
}

// ─────────────────────────────────────────────────────────────────────
// Address truncation
// ─────────────────────────────────────────────────────────────────────

/**
 * Truncate a BCH cashaddr to a readable form. Returns the input
 * unchanged when it's not a string OR shorter than the keep-window.
 *
 *   shortAddress(null)                       → '—'
 *   shortAddress(undefined)                  → '—'
 *   shortAddress('')                         → '—'
 *   shortAddress('bitcoincash:qprh2xrn' shortened to 12 chars') → 'bitcoinc…'
 *   shortAddress('abcdefghijklmnopqrstuvwxyz') → 'abcdef…wxyz'
 *
 * @param {string|null|undefined} addr
 * @param {number} [keepStart=6]   chars to keep from the start
 * @param {number} [keepEnd=4]     chars to keep from the end
 * @returns {string}
 */
export function shortAddress(addr, keepStart = 6, keepEnd = 4) {
  if (typeof addr !== 'string') return '—';
  const trimmed = addr.trim();
  if (trimmed.length === 0) return '—';
  if (trimmed.length <= keepStart + keepEnd + 1) return trimmed;
  return `${trimmed.slice(0, keepStart)}…${trimmed.slice(-keepEnd)}`;
}

// ─────────────────────────────────────────────────────────────────────
// BigInt → human-units conversion
// ─────────────────────────────────────────────────────────────────────

/**
 * Convert a token balance expressed in base units (BigInt or
 * numeric string) to a human-readable decimal string. NEVER throws;
 * returns `'—'` for null/invalid input. Mirrors
 * `baseToHumanString` from `src/strategy/holder-concentration.mjs`
 * but with an even simpler `humanFormat` API for the dashboard.
 *
 *   humanFormat(null)          → '—'
 *   humanFormat('1000000')     → '1.000000'  (decimals=6)
 *   humanFormat('1500000')     → '1.500000'  (decimals=6)
 *   humanFormat('100000000')   → '1.00000000' (decimals=8)
 *   humanFormat('50000')       → '50000'     (decimals=0)
 *   humanFormat('abc')         → '—'
 *   humanFormat(0n)            → '0'
 *
 * @param {bigint|string|number|null|undefined} base
 * @param {number|null|undefined} [decimals=0]
 * @returns {string}
 */
export function humanFormat(base, decimals = 0) {
  if (base === null || base === undefined) return '—';
  let big;
  try {
    if (typeof base === 'bigint') {
      big = base;
    } else if (typeof base === 'number') {
      if (!Number.isFinite(base) || !Number.isInteger(base)) return '—';
      big = BigInt(base);
    } else if (typeof base === 'string') {
      const trimmed = base.trim();
      if (trimmed.length === 0 || !/^-?\d+$/.test(trimmed)) return '—';
      big = BigInt(trimmed);
    } else {
      return '—';
    }
  } catch (_e) {
    return '—';
  }
  if (typeof decimals !== 'number' || !Number.isFinite(decimals) || decimals < 0 || decimals > 18) {
    decimals = 0;
  }
  decimals = Math.floor(decimals);
  if (decimals === 0) return big.toString();
  const isNegative = big < 0n;
  const abs = isNegative ? -big : big;
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const frac = abs % divisor;
  if (frac === 0n) return `${isNegative ? '-' : ''}${whole.toString()}`;
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${isNegative ? '-' : ''}${whole.toString()}.${fracStr}`;
}

// ─────────────────────────────────────────────────────────────────────
// Source / cache labels
// ─────────────────────────────────────────────────────────────────────

/**
 * Map the upstream `source` field to a human-readable label. The
 * current scanner only knows `tokenstork` (the default upstream
 * wired in subset 2a) but the field is extensible — future
 * upstreams like `electrum` or `chaingraph` can be added without
 * touching the React tile.
 *
 *   sourceLabel('tokenstork') → 'TokenStork'
 *   sourceLabel(null)         → 'unknown'
 *   sourceLabel('')           → 'unknown'
 *   sourceLabel('electrum')   → 'electrum'
 *   sourceLabel(undefined)    → 'unknown'
 *
 * @param {string|null|undefined} source
 * @returns {string}
 */
export function sourceLabel(source) {
  if (typeof source !== 'string') return 'unknown';
  const trimmed = source.trim();
  if (trimmed.length === 0) return 'unknown';
  if (trimmed === 'tokenstork') return 'TokenStork';
  if (trimmed === 'electrum') return 'Electrum';
  if (trimmed === 'chaingraph') return 'Chaingraph';
  if (trimmed === 'cauldron') return 'Cauldron';
  if (trimmed === 'fixture') return 'fixture';
  return trimmed;
}

/**
 * Build the cache-badge class. The dashboard wants to know whether
 * the envelope was served from the cache or freshly fetched — the
 * live wire carries `{cached: true|false, cache_age_ms}` so we
 * project them into a single badge.
 *
 *   cacheBadgeClass({cached:false})            → 'border-amber-700/50 bg-amber-950/30 text-amber-300'
 *   cacheBadgeClass({cached:true,cache_age_ms:47}) → 'border-emerald-700/50 bg-emerald-950/30 text-emerald-300'
 *   cacheBadgeClass({fixture:true})            → 'border-ink-700 bg-ink-900/30 text-ash-400'
 *
 * @param {{cached?: boolean, cache_age_ms?: number, fixture?: boolean}} env
 * @returns {string}
 */
export function cacheBadgeClass(env) {
  if (!env || typeof env !== 'object') return 'border-ink-700 bg-ink-900/30 text-ash-400';
  if (env.fixture === true) return 'border-ink-700 bg-ink-900/30 text-ash-400';
  if (env.cached === true) return 'border-emerald-700/50 bg-emerald-950/30 text-emerald-300';
  return 'border-amber-700/50 bg-amber-950/30 text-amber-300';
}

/**
 * Build the human-readable cache-badge text. Mirrors the pattern
 * used by `token-summary-helpers.mjs#formatHoldMs`.
 *
 *   cacheBadgeText({cached:false})           → 'fresh fetch'
 *   cacheBadgeText({cached:true,cache_age_ms:47000}) → 'cached 47s ago'
 *   cacheBadgeText({cached:true,cache_age_ms:60000}) → 'cached 1m ago'
 *   cacheBadgeText({cached:true,cache_age_ms:600000}) → 'cached 10m ago'
 *   cacheBadgeText({fixture:true})           → 'fixture'
 *
 * @param {{cached?: boolean, cache_age_ms?: number, fixture?: boolean}} env
 * @returns {string}
 */
export function cacheBadgeText(env) {
  if (!env || typeof env !== 'object') return '—';
  if (env.fixture === true) return 'fixture';
  if (env.cached === true) {
    const age = typeof env.cache_age_ms === 'number' && Number.isFinite(env.cache_age_ms)
      ? Math.max(0, Math.floor(env.cache_age_ms))
      : 0;
    if (age < 1000) return `cached ${age}ms ago`;
    if (age < 60_000) return `cached ${Math.floor(age / 1000)}s ago`;
    if (age < 3_600_000) return `cached ${Math.floor(age / 60_000)}m ago`;
    return `cached ${Math.floor(age / 3_600_000)}h ago`;
  }
  return 'fresh fetch';
}

// ─────────────────────────────────────────────────────────────────────
// Envelope classification
// ─────────────────────────────────────────────────────────────────────

/**
 * Detect the subset-1 stub envelope (the pre-subset-2a response
 * shape). Used by the React tile to surface the "scanner not yet
 * implemented" pill. NEVER throws.
 *
 *   isHoldersStub({error:'scanner_not_implemented'})         → true
 *   isHoldersStub({error:'token_not_found'})                 → false
 *   isHoldersStub(null)                                      → false
 *
 * @param {*} env
 * @returns {boolean}
 */
export function isHoldersStub(env) {
  if (!env || typeof env !== 'object') return false;
  return env.error === 'scanner_not_implemented';
}

/**
 * Detect the fixture envelope. Mirrors `isHoldersStub` but for
 * the `?holders=` branch.
 *
 *   isHoldersFixture({fixture:true})  → true
 *   isHoldersFixture({fixture:false}) → false
 *   isHoldersFixture({})              → false
 *
 * @param {*} env
 * @returns {boolean}
 */
export function isHoldersFixture(env) {
  if (!env || typeof env !== 'object') return false;
  return env.fixture === true;
}

/**
 * Detect any "unavailable" envelope (the dashboard should render
 * an "unavailable" pill rather than the header card). Includes:
 *   - Subset-1 stub (`error: 'scanner_not_implemented'`)
 *   - Scanner cache not wired (`error: 'scanner_cache_not_wired'`)
 *   - Token not found (`error: 'token_not_found'`)
 *   - Scanner failure (`error: 'scanner_failed'`, `fetch_failed`,
 *     `scanner_invalid_envelope`, `resolver_invalid`,
 *     `scanner_unexpected_throw`, `fixture_parse_failed`)
 *   - Any `ok:false` envelope whose `error` is a string
 *
 *   isHoldersUnavailable({ok:false,error:'token_not_found'}) → true
 *   isHoldersUnavailable({ok:true})                           → false
 *   isHoldersUnavailable(null)                                → true  (null is "no data")
 *   isHoldersUnavailable({})                                  → true  (empty is "no data")
 *
 * @param {*} env
 * @returns {boolean}
 */
export function isHoldersUnavailable(env) {
  if (!env || typeof env !== 'object') return true;
  if (env.ok === true) return false;
  // ok:false → unavailable regardless of whether `error` is set.
  // (The React tile uses holderErrorKey() to extract the typed
  // error for the pill body, but the availability decision is
  // made on `ok` alone.)
  if (env.ok === false) return true;
  // No `ok` flag set but `error` is a non-empty string → unavailable.
  if (typeof env.error === 'string' && env.error.length > 0) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────
// Display-row builders
// ─────────────────────────────────────────────────────────────────────

/**
 * Project a single holder row from the live envelope into the
 * display shape the React tile renders. Pure — no DOM, no I/O.
 *
 *   buildHolderRow({
 *     address: 'bitcoincash:qqcp6q32dt4x4ddzrkdz28xmv6a3ev6wwq4t0m57ak',
 *     balance_base: '1500000',
 *     pct_of_supply: 75.0,
 *     is_top_n: true,
 *     nft_count: 5,
 *     snapshot_at_unix_s: 1700000000,
 *   })
 *   → {
 *     address: '...qqcp6q32dt4x4ddzrkdz28xmv6a3ev6wwq4t0m57ak',
 *     address_short: 'bitco…yfh3',
 *     balance_human: '1500000',
 *     pct_of_supply: 75.0,
 *     pct_severity: 'caution',
 *     pct_class: 'text-amber-400',
 *     pct_display: '75.0%',
 *     is_top_n: true,
 *     nft_count: 5,
 *   }
 *
 * @param {Object} row
 * @returns {Object}
 */
export function buildHolderRow(row) {
  if (!row || typeof row !== 'object') {
    return {
      address: '—',
      address_short: '—',
      balance_human: '—',
      pct_of_supply: null,
      pct_severity: 'unknown',
      pct_class: 'text-ash-400',
      pct_display: '—',
      is_top_n: false,
      nft_count: 0,
    };
  }
  const pct = pctToNumber(row.pct_of_supply);
  return {
    address: typeof row.address === 'string' ? row.address : '—',
    address_short: shortAddress(row.address),
    balance_human: humanFormat(row.balance_base ?? row.balance),
    pct_of_supply: pct,
    pct_severity: pctOfSupplySeverity(pct),
    pct_class: pctOfSupplySeverityClass(pctOfSupplySeverity(pct)),
    pct_display: pctFormat(pct),
    is_top_n: row.is_top_n === true,
    nft_count: typeof row.nft_count === 'number' ? row.nft_count : 0,
  };
}

/**
 * Project the holders envelope into a header-card shape the React
 * tile renders. Pure — no DOM, no I/O.
 *
 *   buildHolderHeader(envelope) → {
 *     token_id: '...',
 *     token_id_short: 'abcdef…wxyz',
 *     top_n: 5,
 *     top_n_pct: 85.0,
 *     top_n_pct_display: '85.0%',
 *     top_n_pct_severity: 'danger',
 *     top_n_pct_class: 'text-rose-400',
 *     top_n_pct_pill_class: 'border-rose-700/50 ...',
 *     is_rug_pattern: true,
 *     rug_label: 'RUG PATTERN',
 *     rug_severity: 'danger',
 *     rug_class: 'text-rose-400',
 *     rug_pill_class: 'border-rose-700/50 ...',
 *     total_holders: 12,
 *     total_supply_human: '1000000',
 *     source_label: 'TokenStork',
 *     cache_badge_class: 'border-emerald-700/50 ...',
 *     cache_badge_text: 'cached 47s ago',
 *     cached: true,
 *     cache_age_ms: 47000,
 *     fixture: false,
 *     cache_flushed: false,
 *     ok: true,
 *   }
 *
 * @param {Object|null|undefined} env
 * @returns {Object}
 */
export function buildHolderHeader(env) {
  const empty = {
    token_id: null,
    token_id_short: '—',
    top_n: null,
    top_n_pct: null,
    top_n_pct_display: '—',
    top_n_pct_severity: 'unknown',
    top_n_pct_class: 'text-ash-400',
    top_n_pct_pill_class: 'border-ink-700 bg-ink-900/30 text-ash-400',
    is_rug_pattern: null,
    rug_label: 'unknown',
    rug_severity: 'unknown',
    rug_class: 'text-ash-400',
    rug_pill_class: 'border-ink-700 bg-ink-900/30 text-ash-400',
    total_holders: null,
    total_supply_human: '—',
    source_label: '—',
    cache_badge_class: 'border-ink-700 bg-ink-900/30 text-ash-400',
    cache_badge_text: '—',
    cached: false,
    cache_age_ms: 0,
    fixture: false,
    cache_flushed: false,
    ok: false,
  };
  if (!env || typeof env !== 'object') return empty;
  const topNPct = pctToNumber(env.top_n_pct);
  const topNSev = pctOfSupplySeverity(topNPct);
  const rugV = env.is_rug_pattern === true ? true : (env.is_rug_pattern === false ? false : null);
  const rugSev = rugPatternSeverity(rugV);
  return {
    token_id: typeof env.token_id === 'string' ? env.token_id : null,
    token_id_short: shortAddress(env.token_id),
    top_n: typeof env.top_n === 'number' ? env.top_n : null,
    top_n_pct: topNPct,
    top_n_pct_display: pctFormat(topNPct),
    top_n_pct_severity: topNSev,
    top_n_pct_class: pctOfSupplySeverityClass(topNSev),
    top_n_pct_pill_class: pctOfSupplyPillClass(topNSev),
    is_rug_pattern: rugV,
    rug_label: rugPatternLabel(rugV),
    rug_severity: rugSev,
    rug_class: pctOfSupplySeverityClass(rugSev),
    rug_pill_class: pctOfSupplyPillClass(rugSev),
    total_holders: typeof env.total_holders === 'number' ? env.total_holders
      : (typeof env.holders_count === 'number' ? env.holders_count : null),
    total_supply_human: typeof env.total_supply_human === 'string' ? env.total_supply_human : '—',
    source_label: sourceLabel(env.source),
    cache_badge_class: cacheBadgeClass(env),
    cache_badge_text: cacheBadgeText(env),
    cached: env.cached === true,
    cache_age_ms: typeof env.cache_age_ms === 'number' && Number.isFinite(env.cache_age_ms)
      ? Math.max(0, Math.floor(env.cache_age_ms))
      : 0,
    fixture: env.fixture === true,
    cache_flushed: env.cache_flushed === true,
    ok: env.ok === true,
  };
}

/**
 * Detect the typed-error category from an envelope. Used by the
 * React tile to render a specific remediation hint. Returns the
 * `error` string verbatim, or `'unknown'` for null/missing.
 *
 *   holderErrorKey({error:'token_not_found'})               → 'token_not_found'
 *   holderErrorKey({error:'scanner_not_implemented'})       → 'scanner_not_implemented'
 *   holderErrorKey({error:'scanner_cache_not_wired'})        → 'scanner_cache_not_wired'
 *   holderErrorKey({error:'scanner_failed'})                → 'scanner_failed'
 *   holderErrorKey({error:'fixture_parse_failed'})          → 'fixture_parse_failed'
 *   holderErrorKey({})                                       → 'unknown'
 *
 * @param {*} env
 * @returns {string}
 */
export function holderErrorKey(env) {
  if (!env || typeof env !== 'object') return 'unknown';
  if (typeof env.error === 'string' && env.error.length > 0) return env.error;
  return 'unknown';
}

/**
 * Map a typed-error key to a human-readable remediation hint. The
 * React tile renders these as the body of the "unavailable" pill.
 * Pure — returns `null` when no hint is available.
 *
 *   holderErrorHint('scanner_not_implemented') → 'scanner not yet implemented — flip scoring.concentration_rug_enabled=true after auditing the upstream, or use ?holders=<json> to test the math against a fixture'
 *   holderErrorHint('token_not_found')         → 'upstream has not indexed this token yet — try again in a few minutes, or use ?holders=<json> to test against a fixture'
 *   holderErrorHint('scanner_cache_not_wired') → 'dashboard server is misconfigured — restart it so ctx.holdersScannerCache is wired'
 *   holderErrorHint('unknown')                 → null
 *
 * @param {string} key
 * @returns {string|null}
 */
export function holderErrorHint(key) {
  if (typeof key !== 'string') return null;
  if (key === 'scanner_not_implemented') {
    return 'scanner not yet implemented — flip scoring.concentration_rug_enabled=true after auditing the upstream, or use ?holders=<json> to test the math against a fixture';
  }
  if (key === 'token_not_found') {
    return 'upstream has not indexed this token yet — try again in a few minutes, or use ?holders=<json> to test against a fixture';
  }
  if (key === 'scanner_cache_not_wired') {
    return 'dashboard server is misconfigured — restart it so ctx.holdersScannerCache is wired';
  }
  if (key === 'scanner_failed' || key === 'fetch_failed' || key === 'scanner_invalid_envelope' || key === 'resolver_invalid' || key === 'scanner_unexpected_throw') {
    return 'upstream scanner failed — check network reachability, or retry with ?refresh=true to bypass the cache';
  }
  if (key === 'fixture_parse_failed') {
    return '?holders=<json> could not be parsed — verify the JSON is urlencoded and is an array of {address, balance_base | balance}';
  }
  if (key === 'invalid_token_id') {
    return 'token_id must be a 64-char lowercase hex string';
  }
  if (key === 'unknown') return null;
  return null;
}
