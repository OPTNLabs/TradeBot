// src/reconcile/positions-vs-chain.mjs
//
// T47: pure helper that diffs `data/positions.json` (open positions)
// against the wallet's live UTXO set and produces a structured
// report the operator can act on.
//
// The diff surfaces four finding kinds:
//
//   - `consensus`        — every open position has matching on-chain
//                          tokens at the wallet (sum of UTXO amounts
//                          per token_category matches the position's
//                          `entry.token_amount_base`).
//   - `on_disk_only`     — positions.json says the position is open
//                          BUT the wallet holds zero tokens for that
//                          token_category. Subtype `sold_off_chain`
//                          captures the FEW pos_tlbiuvh6_0002 case
//                          where a position was closed off-band and
//                          the bot never reconciled; subtype `dust`
//                          captures the partial-dust case where the
//                          wallet holds some tokens but much less
//                          than the position claims.
//   - `on_chain_only`    — the wallet holds tokens for a category
//                          that has NO open position. Subtype
//                          `untracked_tokens` covers both manual
//                          trades that bypassed positions.open() and
//                          airdrops / accidental receipts.
//   - `quantity_mismatch`— the position claims `entry.token_amount_base`
//                          tokens but the wallet UTXOs for that
//                          category sum to a different amount (still
//                          non-zero on both sides). Captures the
//                          "partial sweep / odd-lot remainder" case.
//
// Plus a `note` finding kind for informational items (wallet has 0
// BCH balance, positions file is empty, etc.) so the operator gets
// context without false-alarm severity.
//
// Every finding carries:
//   - `kind`            — one of the strings above
//   - `severity`        — `'high'` (positions disagree on
//                          existence), `'medium'` (positions
//                          disagree on quantity), `'low'`
//                          (informational note).
//   - `token_id`        — 64-hex category id (lower-cased) or null
//                          for file-wide notes.
//   - `position_id`     — open-position id (when the finding is
//                          tied to a specific position).
//   - `summary`         — one-line human-readable description
//                          suitable for the dashboard / CLI / alert.
//   - `details`         — structured diagnostic fields for the
//                          remediation path.
//   - `recommended_action` — which existing operator script to run
//                          (e.g. `'scripts/reconcile-position.mjs'`,
//                          `'scripts/sync-wallet-holdings.mjs'`,
//                          `'scripts/reconcile-stuck-position.mjs'`).
//
// The helper is PURE — no I/O, no clock, no wallet adapter. The
// caller (CLI / dashboard / future cron) provides the positions
// array + UTXO array. That keeps it cheap to test every diff kind
// without touching Electrum or the filesystem.
//
// Status filter: only `status === 'open'` positions are compared.
// `pending` / `closing` are skipped because the bot is mid-flight
// on those and the UTXO set hasn't settled yet — including them
// would produce noise findings every tick.

import { normalizeStatus } from '../portfolio/positions.mjs';

// ─── Constants ────────────────────────────────────────────────────────

/** Schema version for the report — bumps if `findings[]` shape changes. */
export const RECONCILE_REPORT_VERSION = 1;

/** Findings a single position-vs-UTXO comparison can produce. */
export const FINDING_KINDS = Object.freeze([
  'consensus',
  'on_disk_only',
  'on_chain_only',
  'quantity_mismatch',
  'note',
]);

/** Severity assigned to each finding kind. */
const SEVERITY_BY_KIND = Object.freeze({
  consensus: 'low',
  on_disk_only: 'high',
  on_chain_only: 'medium',
  quantity_mismatch: 'medium',
  note: 'low',
});

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Lowercase a 64-hex token_category. Tolerates null / undefined /
 * non-string by returning null so the caller can skip non-token
 * UTXOs. Returns the normalized form (always 64 lowercase hex
 * characters) so positions and UTXOs that disagree on case still
 * match — Electrum servers are not consistent about returning
 * category ids in lower vs upper case.
 *
 * @param {unknown} id
 * @returns {string|null}
 */
export function normalizeTokenId(id) {
  if (typeof id !== 'string') return null;
  const trimmed = id.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Group UTXOs by token_category and sum the per-category token
 * amounts. BCH-only UTXOs (no `token` field, or token with no
 * category) are bucketed separately under key `null` so the diff
 * helper can ignore them — they never match a position.
 *
 * Returns `{ perCategory: Map<string, bigint>, bchUtxoCount: number,
 * bchBalanceSats: bigint }`. UTXOs with token.amount not a BigInt
 * are coerced via BigInt() (the cashscript library returns BigInt
 * amounts in practice, but defensive coercion here keeps the diff
 * helper from blowing up if a future wallet adapter returns
 * number/string).
 *
 * @param {Array} utxos
 * @returns {{ perCategory: Map<string, bigint>, bchUtxoCount: number, bchBalanceSats: bigint }}
 */
export function bucketUtxosByTokenCategory(utxos) {
  const perCategory = new Map();
  let bchUtxoCount = 0;
  let bchBalanceSats = 0n;
  if (!Array.isArray(utxos)) return { perCategory, bchUtxoCount, bchBalanceSats };

  for (const u of utxos) {
    if (!u || typeof u !== 'object') continue;
    // BCH side: count the UTXO toward wallet BCH balance regardless
    // of whether it also carries a token (a UTXO can carry both —
    // the standard cauldron output shape). Only count UTXOs that
    // actually carry satoshis; empty placeholders / sentinel objects
    // (no `satoshis` field) are skipped so the no_bch note doesn't
    // misfire on garbage entries.
    let hasSats = false;
    if (typeof u.satoshis === 'bigint') {
      bchBalanceSats += u.satoshis;
      hasSats = true;
    } else if (Number.isFinite(Number(u.satoshis))) {
      bchBalanceSats += BigInt(Number(u.satoshis));
      hasSats = true;
    }
    const tok = u.token;
    if (!tok || typeof tok !== 'object') {
      if (hasSats) bchUtxoCount += 1;
      continue;
    }
    const cat = normalizeTokenId(tok.category);
    if (!cat) {
      if (hasSats) bchUtxoCount += 1;
      continue;
    }
    let amount;
    if (typeof tok.amount === 'bigint') amount = tok.amount;
    else if (Number.isFinite(Number(tok.amount))) amount = BigInt(Number(tok.amount));
    else amount = 0n;
    perCategory.set(cat, (perCategory.get(cat) ?? 0n) + amount);
    if (hasSats) bchUtxoCount += 1;
  }
  return { perCategory, bchUtxoCount, bchBalanceSats };
}

/**
 * Defensive BigInt coercion for `entry.token_amount_base`. The
 * position store persists amounts as decimal strings (to preserve
 * precision across JSON round-trips), so `BigInt(str)` is the
 * canonical path. Tolerates already-bigint, number-string, plain
 * number, and returns null for anything we can't safely convert
 * (NaN, Infinity, undefined, object) so the diff helper can
 * gracefully downgrade the position to a finding kind.
 *
 * @param {unknown} raw
 * @returns {bigint|null}
 */
export function positionAmountAsBigInt(raw) {
  if (typeof raw === 'bigint') return raw;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || !Number.isInteger(raw)) return null;
    return BigInt(raw);
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    if (!/^-?\d+$/.test(trimmed)) return null;
    try {
      return BigInt(trimmed);
    } catch {
      return null;
    }
  }
  return null;
}

// ─── Pure diff ────────────────────────────────────────────────────────

/**
 * Run the full positions-vs-UTXO diff and return a structured
 * report. The function is PURE — same inputs always yield the
 * same report (with `generated_at` set by the caller for stamping).
 *
 * Edge cases the diff explicitly handles:
 *   - empty positions + empty UTXOs → single `note` finding
 *     ("both sides empty") with `severity:low`. No false alarm.
 *   - empty positions + non-empty UTXOs → one `on_chain_only`
 *     finding per token category the wallet holds.
 *   - non-empty positions + empty UTXOs → one `on_disk_only`
 *     finding per open position.
 *   - duplicate open positions for the same token_category (the
 *     bot's `hasOpenPosition` gate prevents this in production but
 *     legacy files might still have it) → findings are emitted
 *     per-position-id so the operator can identify which record
 *     is stale.
 *   - case-mismatched token_category (Electrum returns upper-case,
 *     positions.json lower-case) → normalized via `normalizeTokenId`
 *     so they still match.
 *   - position missing `entry.token_amount_base` → downgraded to
 *     `on_disk_only` with a `details.malformed_amount:true` flag.
 *
 * @param {Array} positions
 * @param {Array} utxos
 * @param {Object} [opts]
 * @param {string} [opts.generatedAt] — ISO timestamp for the report.
 *   Defaults to null so the helper stays pure when no clock is
 *   provided; the caller stamps it in the CLI / endpoint so the
 *   helper is trivially testable.
 * @returns {{ version: number, generated_at: string|null, summary: { open_positions: number, on_chain_tokens: number, findings: number, high: number, medium: number, low: number }, findings: Array }}
 */
export function diffPositionsVsChain(positions, utxos, opts = {}) {
  const generatedAt = typeof opts.generatedAt === 'string' ? opts.generatedAt : null;

  const { perCategory, bchUtxoCount, bchBalanceSats } = bucketUtxosByTokenCategory(utxos);

  const openPositions = Array.isArray(positions)
    ? positions.filter((p) => p && p.status === 'open' && normalizeStatus(p.status) === 'open')
    : [];

  const findings = [];

  // Index open positions by token_category so a single category
  // can have multiple positions (legacy files; the gate normally
  // blocks this in production).
  /** @type {Map<string, Array<object>>} */
  const positionsByCategory = new Map();
  for (const p of openPositions) {
    const cat = normalizeTokenId(p.token_id);
    if (!cat) {
      findings.push({
        kind: 'on_disk_only',
        severity: 'high',
        token_id: null,
        position_id: p.id ?? null,
        token_symbol: typeof p.token_symbol === 'string' ? p.token_symbol : null,
        summary: `position ${p.id ?? '<no-id>'} has malformed token_id — cannot reconcile`,
        details: {
          reason: 'malformed_token_id',
          raw_token_id: p.token_id ?? null,
        },
        recommended_action: 'inspect-position-record',
      });
      continue;
    }
    const arr = positionsByCategory.get(cat) ?? [];
    arr.push(p);
    positionsByCategory.set(cat, arr);
  }

  // Compare every position to the wallet's UTXO set.
  for (const [cat, list] of positionsByCategory.entries()) {
    const walletAmount = perCategory.get(cat) ?? 0n;
    for (const p of list) {
      const posAmount = positionAmountAsBigInt(p.entry?.token_amount_base);
      const baseDetails = {
        expected_token_amount_base: posAmount !== null ? posAmount.toString() : null,
        wallet_token_amount_base: walletAmount.toString(),
        token_symbol: typeof p.token_symbol === 'string' ? p.token_symbol : null,
        malformed_amount: posAmount === null,
      };

      if (walletAmount === 0n) {
        findings.push({
          kind: 'on_disk_only',
          severity: 'high',
          token_id: cat,
          position_id: p.id ?? null,
          token_symbol: baseDetails.token_symbol,
          summary: `position ${p.id ?? '<no-id>'} is open but wallet holds 0 tokens for ${baseDetails.token_symbol ?? cat.slice(0, 8) + '…'} — likely sold off-chain`,
          details: { ...baseDetails, subtype: 'sold_off_chain' },
          recommended_action: 'scripts/reconcile-position.mjs --position-id ' + (p.id ?? '<missing>'),
        });
        continue;
      }

      if (posAmount === null) {
        findings.push({
          kind: 'on_disk_only',
          severity: 'high',
          token_id: cat,
          position_id: p.id ?? null,
          token_symbol: baseDetails.token_symbol,
          summary: `position ${p.id ?? '<no-id>'} has malformed token_amount_base — cannot verify against wallet (wallet holds ${walletAmount.toString()} base units)`,
          details: { ...baseDetails, subtype: 'malformed_amount' },
          recommended_action: 'inspect-position-record',
        });
        continue;
      }

      if (posAmount === walletAmount) {
        findings.push({
          kind: 'consensus',
          severity: 'low',
          token_id: cat,
          position_id: p.id ?? null,
          token_symbol: baseDetails.token_symbol,
          summary: `position ${p.id ?? '<no-id>'} agrees with wallet (${posAmount.toString()} base units)`,
          details: { ...baseDetails, agreement: 'exact' },
          recommended_action: null,
        });
        continue;
      }

      // Non-zero on both sides but not equal. Could be a partial
      // sweep (most tokens sold, dust remains) or a position amount
      // that was rounded wrong at entry. Either way it's actionable
      // and warrants operator attention.
      const ratioNum = walletAmount > 0n ? Number(walletAmount) / Number(posAmount) : 0;
      findings.push({
        kind: 'quantity_mismatch',
        severity: 'medium',
        token_id: cat,
        position_id: p.id ?? null,
        token_symbol: baseDetails.token_symbol,
        summary: `position ${p.id ?? '<no-id>'} claims ${posAmount.toString()} base units, wallet holds ${walletAmount.toString()} (${(ratioNum * 100).toFixed(1)}% of expected)`,
        details: { ...baseDetails, ratio: Number.isFinite(ratioNum) ? ratioNum : null },
        recommended_action: 'scripts/reconcile-position.mjs --position-id ' + (p.id ?? '<missing>'),
      });
    }
  }

  // Categories the wallet holds but no position tracks. These are
  // candidates for `scripts/sync-wallet-holdings.mjs` (T27e) — i.e.
  // tokens the bot never recorded because they came in off-band.
  for (const [cat, amount] of perCategory.entries()) {
    if (positionsByCategory.has(cat)) continue;
    findings.push({
      kind: 'on_chain_only',
      severity: 'medium',
      token_id: cat,
      position_id: null,
      token_symbol: null,
      summary: `wallet holds ${amount.toString()} base units of untracked token ${cat.slice(0, 8) + '…'} — no open position for this category`,
      details: {
        wallet_token_amount_base: amount.toString(),
        subtype: 'untracked_tokens',
      },
      recommended_action: 'scripts/sync-wallet-holdings.mjs',
    });
  }

  // Notes — informational only.
  if (openPositions.length === 0) {
    findings.push({
      kind: 'note',
      severity: 'low',
      token_id: null,
      position_id: null,
      token_symbol: null,
      summary: 'no open positions in data/positions.json',
      details: { reason: 'no_open_positions' },
      recommended_action: null,
    });
  }
  if (perCategory.size === 0 && openPositions.length > 0) {
    // Only emit this if we ALSO found at least one on_disk_only
    // finding above (so the note doesn't add noise on a clean tree).
    const sawOnDiskOnly = findings.some((f) => f.kind === 'on_disk_only');
    if (sawOnDiskOnly) {
      findings.push({
        kind: 'note',
        severity: 'low',
        token_id: null,
        position_id: null,
        token_symbol: null,
        summary: 'wallet holds no token UTXOs — every open position is in disagreement with the chain',
        details: { reason: 'no_token_utxos' },
        recommended_action: null,
      });
    }
  }
  if (bchBalanceSats === 0n || bchUtxoCount === 0) {
    findings.push({
      kind: 'note',
      severity: 'low',
      token_id: null,
      position_id: null,
      token_symbol: null,
      summary: 'wallet holds 0 BCH (or has no UTXOs at all) — bot cannot enter new positions',
      details: {
        reason: 'no_bch',
        bch_balance_sats: bchBalanceSats.toString(),
        bch_utxo_count: bchUtxoCount,
      },
      recommended_action: 'fund-wallet',
    });
  }

  const summary = {
    open_positions: openPositions.length,
    on_chain_tokens: perCategory.size,
    findings: findings.length,
    high: findings.filter((f) => f.severity === 'high').length,
    medium: findings.filter((f) => f.severity === 'medium').length,
    low: findings.filter((f) => f.severity === 'low').length,
  };

  return {
    version: RECONCILE_REPORT_VERSION,
    generated_at: generatedAt,
    summary,
    findings,
  };
}
