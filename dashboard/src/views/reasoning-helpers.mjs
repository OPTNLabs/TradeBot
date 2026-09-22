// dashboard/src/views/reasoning-helpers.mjs
//
// T40: pure helpers for the REASONING view's decision-detail panel.
// Separated from Reasoning.jsx so Node's test runner can exercise
// the formatting + grouping logic without bundling JSX.
//
// The view's expanded "decision trace" panel renders the full
// reasoning blob (the same one the trading loop stamps onto
// `positions.json#entry.reasoning`) for every per-candidate event:
//   • entry_skipped    — has `decision.reasoning` from shouldEnter
//   • entry_rejected   — has the strategy-layer reasoning + the
//                        risk-layer reject reason (operator sees
//                        BOTH: "why strategy said yes AND why risk
//                        said no")
//   • entry / exit     — has the position's `entry.reasoning` (linked
//                        via position_id)
//
// The blob shape is documented in `src/strategy/entry.mjs#_entryReasoning`
// and includes: `decision` (the per-candidate decision body),
// `conditions` (the configured thresholds), `breakdown` /
// `passed_filters` / `notes` / `score` / `rank` etc.

/**
 * Group the entries of a reasoning blob into ordered sections the
 * UI can render as collapsible groups. Order is curated so the most
 * decision-relevant info (why) shows up first.
 *
 * Sections:
 *   • why            — `decision.*` (the per-gate decision body,
 *                       including the live wallet/exposure snapshot
 *                       and the post-decision size)
 *   • conditions     — `conditions.*` (the configured thresholds:
 *                       each gate's threshold vs. the live value)
 *   • scoring        — `score` / `rank` / `topK` / `breakdown` /
 *                       `passed_filters` / `notes`
 *   • meta           — `ts` / `ts_iso` / `token_id` /
 *                       `eligible_for_trade`
 *
 * Unknown top-level keys land in `meta` (defensive — the blob
 * shape evolves over time, and we don't want to silently drop new
 * fields).
 *
 * @param {Object|null|undefined} reasoning
 * @returns {Array<{ id: string, label: string, entries: Array<[string, any]> }>}
 */
export function groupReasoningEntries(reasoning) {
  const WHY_KEYS = new Set([
    'decision',
  ]);
  const CONDITIONS_KEYS = new Set([
    'conditions',
  ]);
  const SCORING_KEYS = new Set([
    'score',
    'rank',
    'topK',
    'breakdown',
    'passed_filters',
    'notes',
  ]);
  const META_KEYS = new Set([
    'ts',
    'ts_iso',
    'token_id',
    'eligible_for_trade',
  ]);

  if (!reasoning || typeof reasoning !== 'object') return [];
  const entries = Object.entries(reasoning);
  const buckets = {
    why: [],
    conditions: [],
    scoring: [],
    meta: [],
  };
  for (const [k, v] of entries) {
    if (WHY_KEYS.has(k)) buckets.why.push([k, v]);
    else if (CONDITIONS_KEYS.has(k)) buckets.conditions.push([k, v]);
    else if (SCORING_KEYS.has(k)) buckets.scoring.push([k, v]);
    else if (META_KEYS.has(k)) buckets.meta.push([k, v]);
    else buckets.meta.push([k, v]); // unknown → meta
  }

  const out = [];
  if (buckets.why.length > 0) {
    out.push({ id: 'why', label: 'Why', entries: buckets.why });
  }
  if (buckets.conditions.length > 0) {
    out.push({ id: 'conditions', label: 'Conditions (configured thresholds)', entries: buckets.conditions });
  }
  if (buckets.scoring.length > 0) {
    out.push({ id: 'scoring', label: 'Scoring', entries: buckets.scoring });
  }
  if (buckets.meta.length > 0) {
    out.push({ id: 'meta', label: 'Meta', entries: buckets.meta });
  }
  return out;
}

/**
 * Decide whether the UI should offer a "details" expand toggle for a
 * given decision row. Returns `true` when the event carries a
 * reasoning blob with at least one recognized key.
 *
 * @param {Object|null|undefined} reasoning
 * @returns {boolean}
 */
export function hasReasoningDetails(reasoning) {
  if (!reasoning || typeof reasoning !== 'object') return false;
  return groupReasoningEntries(reasoning).length > 0;
}

/**
 * Format a single reasoning value for the expanded panel. Numbers
 * and strings pass through with light coercion; objects render as
 * a short JSON preview. Booleans render as `true` / `false`.
 * `null` / `undefined` render as `—` (em-dash) for visual rhythm.
 *
 * Numbers render with thousands separators (e.g., `1 234`) but no
 * leading `+` for positive values — the field's name + context
 * (`change_24h_bp: 1500` is clearly positive, not a signed delta)
 * disambiguates sign. Negative values keep their `-` prefix.
 *
 * @param {any} value
 * @returns {string}
 */
export function formatReasoningValue(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '—';
    return formatNumeric(value);
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[${value.length} item${value.length === 1 ? '' : 's'}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    return `{${keys.length} field${keys.length === 1 ? '' : 's'}}`;
  }
  return String(value);
}

/**
 * Render a number with thousands separators. Falls back to em-dash
 * for non-finite inputs. Floats cap at 6 decimals with trailing
 * zeros stripped (`0.00500000` → `0.005`). Negative numbers keep
 * the leading `-`; positive numbers get no prefix (the operator
 * can tell `change_24h_bp: 1500` is positive from context).
 *
 * Pure, no deps.
 *
 * @param {number} n
 * @returns {string}
 */
function formatNumeric(n) {
  if (!Number.isFinite(n)) return '—';
  const isInt = Math.trunc(n) === n;
  const fixed = isInt ? n.toString() : Number(n.toFixed(6)).toString();
  const [intPart, fracPart] = fixed.split('.');
  const withSep = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return fracPart ? `${withSep}.${fracPart}` : withSep;
}

/**
 * Pretty-format a sat amount as "N NNN NNN sat (X.XXXX BCH)". Used
 * for any reasoning field whose key ends in `_sats` (or whose
 * value is a known bigint sats field like `bch_budget_sats`).
 *
 * @param {string|number|bigint|null|undefined} v
 * @returns {string|null} — returns `null` for null/undefined so the
 *                          caller can decide whether to render the
 *                          row at all.
 */
export function formatSatsValue(v) {
  if (v === null || v === undefined) return null;
  let n;
  try {
    if (typeof v === 'bigint') n = v;
    else if (typeof v === 'number') n = BigInt(Math.trunc(v));
    else if (typeof v === 'string') n = BigInt(v);
    else return null;
  } catch {
    return null;
  }
  if (n < 0n) {
    const abs = -n;
    const bch = Number(abs) / 1e8;
    return `-${abs.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} sat (${bch.toFixed(8)} BCH)`;
  }
  const bch = Number(n) / 1e8;
  return `${n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} sat (${bch.toFixed(8)} BCH)`;
}

/**
 * Whether a reasoning key looks like a sat amount (so the caller
 * can route it through `formatSatsValue`). Pure, exported for tests.
 *
 * @param {string} key
 * @returns {boolean}
 */
export function isSatsKey(key) {
  if (typeof key !== 'string') return false;
  return key === 'sats'
      || key.endsWith('_sats')
      || key === 'hwm_sats'
      || key === 'bch_budget_sats'
      || key === 'bch_spent_sats'
      || key === 'bch_received_sats';
}

/**
 * Decide whether a field is sensitive (mnemonic / WIF / xprv etc.)
 * and should be redacted before rendering. Conservative — any
 * field whose key matches the secret-pattern set is replaced with
 * `***redacted***`.
 *
 * @param {string} key
 * @returns {boolean}
 */
const SECRET_KEY_RE = /(wif|mnemonic|seed|priv|secret|xprv|private[_-]?key|passphrase)/i;
export function isSensitiveKey(key) {
  if (typeof key !== 'string') return false;
  return SECRET_KEY_RE.test(key);
}