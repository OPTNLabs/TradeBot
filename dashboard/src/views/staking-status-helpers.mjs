#!/usr/bin/env node
// dashboard/src/views/staking-status-helpers.mjs
//
// T58 subset 4 + subset 6 — pure formatting helpers for the
// Dashboard's "BadgerCoin Staking" tile. Kept separate from the
// JSX component so they're importable from `node --test`
// (Node can't parse .jsx files without a loader). Mirrors the
// `risk-panel-helpers.mjs` / `proposals-helpers.mjs` split.
//
// Subset 6 adds the maturity + tip-height helpers
// (`maturitySeverity` / `maturityClass` / `maturityLabel` /
// `maturityBarClass` / `formatPercentComplete` /
// `formatBlocksToApproxDuration` / `tipHeightSeverity` /
// `tipHeightClass` / `tipHeightLabel`) so the React tile can
// project per-lock maturity + the chain-tip pill without
// re-deriving the math client-side.
//
// Every helper is dependency-free and has no side effects.

/**
 * Format a BCH value (as a JS number) to a fixed-precision
 * string. Tolerates null / NaN / undefined / string input.
 *
 * @param {number|string|null|undefined} v
 * @param {number} [decimals=6]
 * @returns {string}
 */
export function formatBch(v, decimals = 6) {
  if (typeof v === 'number' && Number.isFinite(v)) return v.toFixed(decimals);
  if (typeof v === 'string' && v.length > 0) {
    const n = Number(v);
    if (Number.isFinite(n)) return n.toFixed(decimals);
  }
  return (0).toFixed(decimals);
}

/**
 * Format a sat value (bigint / string / number) to a BCH string
 * with the requested decimals. Tolerates non-finite input.
 *
 * @param {bigint|number|string|null|undefined} sats
 * @param {number} [decimals=6]
 * @returns {string}
 */
export function satsToBch(sats, decimals = 6) {
  let n = null;
  if (typeof sats === 'bigint') n = Number(sats) / 1e8;
  else if (typeof sats === 'number' && Number.isFinite(sats)) n = sats / 1e8;
  else if (typeof sats === 'string' && sats.length > 0) {
    const parsed = Number(sats);
    if (Number.isFinite(parsed)) n = parsed / 1e8;
  }
  if (n === null) return (0).toFixed(decimals);
  return n.toFixed(decimals);
}

/**
 * Severity bucket for the lockNFT count tile.
 *
 *   empty      — count === 0
 *   single     — count === 1
 *   multiple   — count >= 2
 *   unknown    — count is null / NaN / non-integer
 *
 * @param {number|null|undefined} count
 * @returns {'empty'|'single'|'multiple'|'unknown'}
 */
export function lockNftCountSeverity(count) {
  if (!Number.isFinite(count) || !Number.isInteger(count) || count < 0) return 'unknown';
  if (count === 0) return 'empty';
  if (count === 1) return 'single';
  return 'multiple';
}

/**
 * Tailwind class for the lockNFT count tile severity. Mirrors
 * the `severityClass` pattern in `risk-panel-helpers.mjs`.
 *
 * @param {string} severity
 * @returns {string}
 */
export function lockNftCountClass(severity) {
  if (severity === 'empty') return 'border-ink-700 bg-ink-900/40 text-ash-300';
  if (severity === 'single') return 'border-bch-500/40 bg-bch-500/10 text-bch-300';
  if (severity === 'multiple') return 'border-bch-400/60 bg-bch-500/15 text-bch-200';
  return 'border-amber-700/60 bg-amber-950/30 text-amber-200';
}

/**
 * Severity bucket for the auto-stake readiness tile. Mirrors the
 * "should I expect BCH to start moving?" question the operator
 * asks on a glance:
 *
 *   armed      — enabled:true + simulation_only:false +
 *                (auto_lock_enabled OR auto_unlock_enabled):true
 *   dry_run    — enabled:true + simulation_only:true (anywhere
 *                in the chain)
 *   disabled   — enabled:false
 *   partial    — enabled:true + simulation_only:false but BOTH
 *                auto_lock_enabled + auto_unlock_enabled are false
 *                (the loop will not fire until the operator opts
 *                in to the sub-mode knobs)
 *   unknown    — anything else (defensive fallback)
 *
 * @param {Object|null|undefined} knobs
 * @returns {'armed'|'dry_run'|'disabled'|'partial'|'unknown'}
 */
export function autoStakeSeverity(knobs) {
  if (!knobs || typeof knobs !== 'object') return 'unknown';
  const enabled = knobs.enabled === true;
  const sim = knobs.simulation_only === true;
  const lock = knobs.auto_lock_enabled === true;
  const unlock = knobs.auto_unlock_enabled === true;
  if (!enabled) return 'disabled';
  if (sim) return 'dry_run';
  if (lock || unlock) return 'armed';
  return 'partial';
}

/**
 * Tailwind class for the auto-stake readiness pill.
 *
 * @param {string} severity
 * @returns {string}
 */
export function autoStakeClass(severity) {
  if (severity === 'armed') return 'border-emerald-700/60 bg-emerald-950/40 text-emerald-200';
  if (severity === 'dry_run') return 'border-amber-700/60 bg-amber-950/30 text-amber-200';
  if (severity === 'partial') return 'border-ash-700 bg-ink-800 text-ash-200';
  if (severity === 'disabled') return 'border-ink-700 bg-ink-900/40 text-ash-400';
  return 'border-ash-700 bg-ink-800 text-ash-300';
}

/**
 * Human-friendly label for the auto-stake severity bucket.
 *
 * @param {string} severity
 * @returns {string}
 */
export function autoStakeLabel(severity) {
  if (severity === 'armed') return 'armed — will move BCH';
  if (severity === 'dry_run') return 'dry-run — simulation only';
  if (severity === 'partial') return 'armed, but sub-modes off';
  if (severity === 'disabled') return 'disabled';
  return 'unknown';
}

/**
 * Severity bucket for an individual stake alert.
 *
 *   info      — stake_locked / stake_unlock success
 *   warn      — stake_failed
 *   unknown   — anything else (defensive)
 *
 * @param {string|null|undefined} kind
 * @param {string|null|undefined} severity
 * @returns {'info'|'warn'|'unknown'}
 */
export function stakeAlertSeverity(kind, severity) {
  if (severity === 'warn' || severity === 'error' || kind === 'stake_failed') return 'warn';
  if (severity === 'info' || kind === 'stake_locked' || kind === 'stake_unlock') return 'info';
  return 'unknown';
}

/**
 * Tailwind class for a stake alert pill.
 *
 * @param {'info'|'warn'|'unknown'} severity
 * @returns {string}
 */
export function stakeAlertClass(severity) {
  if (severity === 'info') return 'border-bch-500/40 bg-bch-500/10 text-bch-300';
  if (severity === 'warn') return 'border-amber-700/60 bg-amber-950/30 text-amber-200';
  return 'border-ink-700 bg-ink-900/40 text-ash-300';
}

/**
 * Human-friendly label for a stake-alert kind.
 *
 * @param {string|null|undefined} kind
 * @returns {string}
 */
export function stakeAlertKindLabel(kind) {
  if (kind === 'stake_locked') return 'lock';
  if (kind === 'stake_unlock') return 'unlock';
  if (kind === 'stake_failed') return 'failed';
  return 'unknown';
}

/**
 * Truncate a hex string into a friendly `0xABCD…1234` shape.
 * Tolerates non-string / short input.
 *
 * @param {string|null|undefined} hex
 * @param {number} [head=8]
 * @param {number} [tail=6]
 * @returns {string}
 */
export function shortHex(hex, head = 8, tail = 6) {
  if (typeof hex !== 'string' || hex.length === 0) return '—';
  if (hex.length <= head + tail + 1) return hex;
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

/**
 * Format a stake-alert's amount_sats from the alert's context
 * envelope into a BCH string. Tolerates missing / null / non-
 * numeric context.
 *
 * @param {Object|null|undefined} event
 * @returns {string}
 */
export function alertAmountBch(event) {
  if (!event || typeof event !== 'object') return '0.000000';
  const ctx = (event.context && typeof event.context === 'object') ? event.context : null;
  if (!ctx) return '0.000000';
  const raw = ctx.amount_sats;
  if (typeof raw === 'bigint') return satsToBch(raw);
  if (typeof raw === 'string' && raw.length > 0) return satsToBch(raw);
  if (typeof raw === 'number' && Number.isFinite(raw)) return satsToBch(raw);
  return '0.000000';
}

/**
 * Build the knob-toggle patch the dashboard sends to
 * `PUT /api/config` when the operator flips a staking knob.
 *
 * Pure projection: takes the current knobs envelope and the
 * requested changes; returns the deep-merge-friendly patch
 * `{ staking: { ...changes } }` with ONLY the four staking
 * knobs present (so WIF / mnemonic / unrelated keys on
 * `currentKnobs` can never accidentally leak through).
 *
 * The backend's PUT handler is responsible for merging onto the
 * existing config (so the WIF + mnemonic + every other key in
 * `config/user.json` stay untouched). The dashboard hands back
 * a minimal patch — the operator's toggle should change the
 * ONE knob they flipped, not the entire knobs envelope.
 *
 * @param {Object|null|undefined} currentKnobs
 * @param {Object} changes          e.g. `{ auto_lock_enabled: true }`
 * @returns {Object}                `{ staking: { ...changes } }`
 */
const STAKING_PATCH_KEYS = ['enabled', 'simulation_only', 'auto_lock_enabled', 'auto_unlock_enabled'];
export function buildStakingKnobPatch(currentKnobs, changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return { staking: {} };
  const out = {};
  for (const k of STAKING_PATCH_KEYS) {
    if (Object.prototype.hasOwnProperty.call(changes, k)) {
      out[k] = changes[k];
    } else if (currentKnobs && typeof currentKnobs === 'object' && Object.prototype.hasOwnProperty.call(currentKnobs, k)) {
      out[k] = currentKnobs[k];
    }
  }
  return { staking: out };
}

/**
 * Compose a "no lockNFTs / wallet unavailable" empty-state label.
 * The dashboard renders this in the tile body when there's
 * nothing to show.
 *
 * @param {Object|null|undefined} status
 * @returns {string}
 */
export function emptyStateLabel(status) {
  if (!status || typeof status !== 'object') return 'staking state unavailable';
  if (status.lockNfts && typeof status.lockNfts.error === 'string' && status.lockNfts.error.length > 0) {
    return `wallet unavailable: ${status.lockNfts.error}`;
  }
  if (status.wallet_configured === false) {
    return 'wallet not configured — only knobs + alerts shown';
  }
  if (!status.lockNfts || status.lockNfts.count === 0) {
    return 'no active lockNFTs in the wallet';
  }
  return '';
}

// ─── T58 subset 6: maturity + tip-height helpers ───────────────────

/**
 * T58 subset 6 — severity bucket for the per-lock maturity pill.
 * Mirrors the visual vocabulary of `autoStakeSeverity` so the
 * operator can read the tile in one glance.
 *
 *   mature       — timelock has elapsed (READY NOW)
 *   premature    — timelock has not yet elapsed (countdown active)
 *   never        — tip below lock's start (shouldn't happen on mainnet;
 *                  chipnet / regtest / clock-skew edge case)
 *   unknown      — defensive fallback (missing maturity input fields)
 *
 * @param {string|null|undefined} maturity
 * @returns {'mature'|'premature'|'never'|'unknown'}
 */
export function maturitySeverity(maturity) {
  if (maturity === 'mature') return 'mature';
  if (maturity === 'premature') return 'premature';
  if (maturity === 'never') return 'never';
  return 'unknown';
}

/**
 * T58 subset 6 — Tailwind class for the per-lock maturity pill.
 *
 * @param {string} severity
 * @returns {string}
 */
export function maturityClass(severity) {
  if (severity === 'mature') return 'border-emerald-700/60 bg-emerald-950/40 text-emerald-200';
  if (severity === 'premature') return 'border-ash-700 bg-ink-800 text-ash-200';
  if (severity === 'never') return 'border-amber-700/60 bg-amber-950/30 text-amber-200';
  return 'border-ink-700 bg-ink-900/40 text-ash-400';
}

/**
 * T58 subset 6 — friendly label for a lock's maturity state.
 * Combines the bucket with the actual countdown so the operator
 * sees "READY NOW" or "matures in 12 blocks (~2h)" without having
 * to cross-reference two columns.
 *
 * @param {Object|null|undefined} parts
 * @returns {string}
 */
export function maturityLabel(parts) {
  if (!parts || typeof parts !== 'object') return '—';
  const m = parts.maturity;
  if (m === 'mature') return 'READY NOW';
  if (m === 'never') return 'never (tip below lock height)';
  if (m === 'premature') {
    const blocks = (typeof parts.blocks_remaining === 'number' && Number.isFinite(parts.blocks_remaining) && parts.blocks_remaining >= 0)
      ? parts.blocks_remaining
      : null;
    if (blocks === null) return 'premature';
    if (blocks === 0) return 'READY NOW';
    return `matures in ${formatBlocksToApproxDuration(blocks)} (${blocks} blocks)`;
  }
  // Anything else (missing / null / unknown / unrecognised) → 'unknown'.
  return 'unknown';
}

/**
 * T58 subset 6 — friendly duration string for a block count.
 * Uses ~600s/block on BCH mainnet (so 144 blocks/day) as the
 * default. Pure; never throws on non-finite input.
 *
 *   0    -> 'now'
 *   1    -> '~10m'
 *   10   -> '~1h 40m'
 *   144  -> '~1d'
 *   2880 -> '~20d'
 *   null -> '—'
 *
 * @param {number|null|undefined} blocks
 * @param {number} [secondsPerBlock=600]
 * @returns {string}
 */
export function formatBlocksToApproxDuration(blocks, secondsPerBlock = 600) {
  if (typeof blocks !== 'number' || !Number.isFinite(blocks) || blocks < 0) return '—';
  if (blocks === 0) return 'now';
  const secondsPerBlockNum = (typeof secondsPerBlock === 'number' && Number.isFinite(secondsPerBlock) && secondsPerBlock > 0)
    ? secondsPerBlock
    : 600;
  const totalSeconds = Math.floor(blocks * secondsPerBlockNum);
  const days = Math.floor(totalSeconds / 86_400);
  const remAfterDays = totalSeconds - days * 86_400;
  const hours = Math.floor(remAfterDays / 3_600);
  const remAfterHours = remAfterDays - hours * 3_600;
  const minutes = Math.floor(remAfterHours / 60);
  if (days > 0) return hours > 0 ? `~${days}d ${hours}h` : `~${days}d`;
  if (hours > 0) return minutes > 0 ? `~${hours}h ${minutes}m` : `~${hours}h`;
  if (minutes > 0) return `~${minutes}m`;
  // < 1m: still sub-minute — show seconds
  return `~${totalSeconds}s`;
}

/**
 * T58 subset 6 — severity bucket for the chain-tip-height pill.
 * Mirrors `tipHeightSeverity` in the backend; duplicated here
 * so the React layer doesn't need to re-derive the bucket on
 * every render (and so the helper is testable in isolation).
 *
 *   fresh        — source='fresh' OR (source='cache' AND age < staleMs)
 *   stale        — source='cache' AND age >= staleMs
 *   unavailable  — source='unavailable' (wallet not wired OR fetcher threw)
 *   unknown      — defensive fallback
 *
 * @param {Object|null|undefined} tip
 * @param {number} [staleMs=60000]
 * @returns {'fresh'|'stale'|'unavailable'|'unknown'}
 */
export function tipHeightSeverity(tip, staleMs = 60_000) {
  if (!tip || typeof tip !== 'object') return 'unknown';
  if (tip.tip_height_source === 'unavailable' || tip.source === 'unavailable') return 'unavailable';
  if (tip.tip_height_source === 'fresh' || tip.source === 'fresh') return 'fresh';
  if (tip.tip_height_source === 'cache' || tip.source === 'cache') {
    const age = (typeof tip.tip_height_age_ms === 'number') ? tip.tip_height_age_ms : tip.ageMs;
    if (typeof age !== 'number' || !Number.isFinite(age)) return 'unknown';
    if (age >= staleMs) return 'stale';
    return 'fresh';
  }
  return 'unknown';
}

/**
 * T58 subset 6 — Tailwind class for the chain-tip-height pill.
 *
 * @param {string} severity
 * @returns {string}
 */
export function tipHeightClass(severity) {
  if (severity === 'fresh') return 'border-bch-500/40 bg-bch-500/10 text-bch-300';
  if (severity === 'stale') return 'border-amber-700/60 bg-amber-950/30 text-amber-200';
  if (severity === 'unavailable') return 'border-ink-700 bg-ink-900/40 text-ash-400';
  return 'border-ink-700 bg-ink-900/40 text-ash-400';
}

/**
 * T58 subset 6 — friendly label for the chain-tip-height pill.
 * Combines the tip + age + source into a single readable string
 * the React tile renders as the header pill body.
 *
 *   { tip_height: 826142, tip_height_age_ms: 14000, tip_height_source: 'cache' }
 *     -> 'tip: 826142 · 14s ago'
 *   { tip_height_source: 'unavailable' }
 *     -> 'tip: unavailable'
 *   { tip_height_source: 'fresh', tip_height_age_ms: 0 }
 *     -> 'tip: 826142 · just now'
 *
 * @param {Object|null|undefined} tip
 * @returns {string}
 */
export function tipHeightLabel(tip) {
  if (!tip || typeof tip !== 'object') return 'tip: unknown';
  const src = tip.tip_height_source ?? tip.source;
  if (src === 'unavailable') return 'tip: unavailable';
  const h = (typeof tip.tip_height === 'number' && Number.isFinite(tip.tip_height)) ? tip.tip_height : null;
  const age = (typeof tip.tip_height_age_ms === 'number' && Number.isFinite(tip.tip_height_age_ms)) ? tip.tip_height_age_ms : null;
  if (h === null) return 'tip: unavailable';
  if (age === null) return `tip: ${h.toLocaleString()}`;
  if (age === 0) return `tip: ${h.toLocaleString()} · just now`;
  // Round to seconds; render as "14s ago" / "2m ago" / "1h ago".
  const ageS = Math.floor(age / 1000);
  if (ageS < 60) return `tip: ${h.toLocaleString()} · ${ageS}s ago`;
  const ageM = Math.floor(ageS / 60);
  if (ageM < 60) return `tip: ${h.toLocaleString()} · ${ageM}m ago`;
  const ageH = Math.floor(ageM / 60);
  return `tip: ${h.toLocaleString()} · ${ageH}h ago`;
}

/**
 * T58 subset 6 — format a 0..1 fraction into a friendly percentage
 * with the requested decimals. Tolerates null / NaN / out-of-range
 * input (returns '—' for null, clamps to [0, 1] for out-of-range
 * fractions so the React tile never renders "150% complete").
 *
 * @param {number|null|undefined} pct
 * @param {number} [decimals=0]
 * @returns {string}
 */
export function formatPercentComplete(pct, decimals = 0) {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return '—';
  const clamped = Math.max(0, Math.min(1, pct));
  return `${(clamped * 100).toFixed(decimals)}%`;
}

/**
 * T58 subset 6 — Tailwind class for the per-lock progress bar
 * (the thin horizontal bar under the maturity pill that fills
 * up as the lock matures). Matches the maturity pill colour
 * so the operator's eye flows from pill -> bar naturally.
 *
 * @param {string} maturity
 * @returns {string}
 */
export function maturityBarClass(maturity) {
  if (maturity === 'mature') return 'bg-emerald-500';
  if (maturity === 'never') return 'bg-amber-500';
  if (maturity === 'premature') return 'bg-bch-500';
  return 'bg-ink-600';
}

// ─── T70-3: stake-attempt log formatting helpers ────────────────────────

/**
 * T70-3: classify a single attempt row into a tone bucket
 * ('success' / 'failed' / 'attempt' / 'info'). The collapsible
 * Status div renders each row in a tone-coloured strip so the
 * operator can scan the recent activity without reading every
 * entry.
 *
 *   phase === 'success'   → 'success' (green)
 *   phase === 'failed'    → 'failed'  (red)
 *   phase === 'attempt'   → 'attempt' (blue)
 *   anything else         → 'info'    (grey)
 *
 * @param {{phase?: string, ok?: boolean}|null|undefined} attempt
 * @returns {'success'|'failed'|'attempt'|'info'}
 */
export function attemptTone(attempt) {
  if (!attempt || typeof attempt !== 'object') return 'info';
  if (attempt.phase === 'success' || attempt.ok === true) return 'success';
  if (attempt.phase === 'failed' || attempt.ok === false) return 'failed';
  if (attempt.phase === 'attempt') return 'attempt';
  return 'info';
}

/**
 * T70-3: Tailwind class for the attempt row's left border +
 * background. Mirrors the maturity-class vocabulary so the
 * operator's visual vocabulary is shared across the card.
 *
 * @param {string} tone  One of the buckets from `attemptTone`.
 * @returns {string}
 */
export function attemptToneClass(tone) {
  if (tone === 'success') return 'border-l-2 border-emerald-500 bg-emerald-500/5';
  if (tone === 'failed')  return 'border-l-2 border-rose-500 bg-rose-500/5';
  if (tone === 'attempt') return 'border-l-2 border-bch-500 bg-bch-500/5';
  return 'border-l-2 border-ink-600 bg-ink-700/30';
}

/**
 * T70-3: one-line summary of an attempt row. Combines the kind
 * (`lock` / `unlock`), the phase, the txid (or short error code),
 * and the amount. Used as the visible row text inside the
 * collapsible Status div.
 *
 * Defensive: tolerates missing / malformed fields.
 *
 * @param {Object|null|undefined} attempt
 * @returns {string}
 */
export function attemptSummary(attempt) {
  if (!attempt || typeof attempt !== 'object') return 'unknown attempt';
  const kind = attempt.kind === 'unlock' ? 'Unlock' : 'Lock';
  const phase = attempt.phase ?? (attempt.ok === true ? 'success' : attempt.ok === false ? 'failed' : 'attempt');
  let tail;
  if (attempt.txid) tail = `txid ${String(attempt.txid).slice(0, 14)}…`;
  else if (attempt.code) tail = `${attempt.code}${attempt.error ? `: ${String(attempt.error).slice(0, 80)}` : ''}`;
  else if (attempt.error) tail = String(attempt.error).slice(0, 100);
  else tail = 'no result';
  const amt = (typeof attempt.amount_sats === 'string' && attempt.amount_sats.length > 0)
    ? ` ${(Number(attempt.amount_sats) / 1e8).toFixed(6)} BCH`
    : '';
  const blocks = (typeof attempt.stake_blocks === 'number') ? ` ${attempt.stake_blocks} blk` : '';
  return `${kind} [${phase}]${amt}${blocks} — ${tail}`;
}

/**
 * T70-3: short timestamp for an attempt row. Mirrors the
 * `recent_alerts` rendering (HH:MM:SS, 24h) so the operator
 * can correlate with the run-bot log timestamps without
 * timezone math.
 *
 * @param {Object|null|undefined} attempt
 * @returns {string}
 */
export function attemptTimestamp(attempt) {
  if (!attempt || typeof attempt !== 'object') return '';
  const raw = (typeof attempt.ts === 'string') ? attempt.ts : (typeof attempt.ts_ms === 'number' ? new Date(attempt.ts_ms).toISOString() : null);
  if (!raw) return '';
  // Try Date.parse first; fall back to the raw ISO string if
  // the parser dislikes the format (defensive).
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return raw.slice(11, 19) ?? raw;
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/**
 * T70-3: severity bucket for the Status div header badge so the
 * operator can tell at a glance whether the last N attempts are
 * healthy. Mirrors `autoStakeSeverity`'s vocabulary.
 *
 *   healthy  — last attempt phase=success
 *   warning  — last attempt phase=attempt (in-flight) OR mix
 *   error    — last attempt phase=failed OR last 3+ are all failed
 *   idle     — empty log
 *
 * @param {Array<{phase?: string, ok?: boolean}>|null|undefined} attempts
 * @returns {'healthy'|'warning'|'error'|'idle'}
 */
export function attemptsSeverity(attempts) {
  if (!Array.isArray(attempts) || attempts.length === 0) return 'idle';
  const last = attempts[0];
  if (last?.phase === 'failed' || last?.ok === false) return 'error';
  if (last?.phase === 'success' || last?.ok === true) return 'healthy';
  if (last?.phase === 'attempt') return 'warning';
  // Fallback: count fails in the recent 3.
  const recent = attempts.slice(0, 3);
  const fails = recent.filter((a) => a?.phase === 'failed' || a?.ok === false).length;
  if (fails >= 2) return 'error';
  if (fails >= 1) return 'warning';
  return 'idle';
}

/**
 * T70-3: Tailwind class for the Status div header pill.
 *
 * @param {string} severity
 * @returns {string}
 */
export function attemptsSeverityClass(severity) {
  if (severity === 'healthy') return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30';
  if (severity === 'warning') return 'bg-amber-500/15 text-amber-400 border-amber-500/30';
  if (severity === 'error')   return 'bg-rose-500/15 text-rose-400 border-rose-500/30';
  return 'bg-ink-700 text-ink-400 border-ink-600';
}

/**
 * T70-3: short label for the severity pill.
 *
 * @param {string} severity
 * @returns {string}
 */
export function attemptsSeverityLabel(severity) {
  if (severity === 'healthy') return 'last attempt OK';
  if (severity === 'warning') return 'attempt in-flight / mixed';
  if (severity === 'error')   return 'last attempt FAILED';
  return 'no attempts yet';
}
