// src/wallet/utxo-consolidation.mjs
//
// T60 — pre-trade UTXO fragmentation detection.
//
// Pure helpers that classify a wallet's live UTXO set against a
// candidate trade size. No I/O, no wallet boot, no SDK import.
// Caller passes the `Utxo[]` it already has (libauth's
// `LibAuthBchWallet.listUtxos()` returns a cashscript `Utxo[]`),
// the helper returns an analysis the loop / CLI / dashboard can
// surface.
//
// Three problems this solves:
//
//   1. Fragmentation invisibility. A 0.04 BCH wallet split across
//      8 dust UTXOs (e.g., from many small `sweep-funds` runs) may
//      not be able to fund a 0.005 BCH buy because no single UTXO
//      + fee fits. The bot currently surfaces this as `below_floor`
//      and skips — a spurious "insufficient funds" rejection.
//
//   2. Multi-input fee bloat. Even when the wallet CAN fund the buy
//      via N inputs, the tx size grows linearly with input count,
//      eating the position. Pre-trade consolidation prevents the
//      fee-bloat path by collapsing N inputs into 1 before the buy.
//
//   3. Operator visibility. The current audit trail hides the
//      fragmentation gap — the operator sees a skip with no hint
//      that the wallet has plenty of TOTAL BCH. `analyzeUtxoFragmentation`
//      surfaces `{largestSats, totalSats, dustCount, consolidatedCount,
//      reason}` so REASONING + history events carry the actual numbers.
//
// Exported as `src/wallet/utxo-consolidation.mjs` (pure module) so
// the trader loop, the CLI, and the dashboard all share one
// definition of "fragmented". Tests live in
// `tests/wallet-utxo-consolidation.test.mjs`.

// ── low-level shape helpers ────────────────────────────────────────────

/**
 * Extract the sat value of a single UTXO. cashscript's `Utxo`
 * shape uses `satoshies` (long-standing typo in the SDK); some
 * upstream forks use `sats`. Accept both so callers don't have to
 * normalize before they get here. Returns 0n for missing / malformed
 * inputs (defensive — the caller's loop should never see those but
 * we don't want to throw inside the entry hot path).
 *
 * @param {object|null|undefined} u
 * @returns {bigint}
 */
export function utxoSats(u) {
  if (!u || typeof u !== 'object') return 0n;
  const raw = (typeof u.satoshies === 'number' || typeof u.satoshies === 'string' || typeof u.satoshies === 'bigint')
    ? u.satoshies
    : ((typeof u.sats === 'number' || typeof u.sats === 'string' || typeof u.sats === 'bigint') ? u.sats : null);
  if (raw === null) return 0n;
  try {
    const n = (typeof raw === 'bigint') ? raw : BigInt(raw);
    return n < 0n ? 0n : n;
  } catch {
    return 0n;
  }
}

/**
 * Sum the sat values of every entry in `utxos`. Null / non-object
 * entries are skipped (defensive). Empty / null input returns 0n.
 *
 * @param {Array<object|null|undefined>|null|undefined} utxos
 * @returns {bigint}
 */
export function totalUtxoSats(utxos) {
  if (!Array.isArray(utxos)) return 0n;
  let sum = 0n;
  for (const u of utxos) sum += utxoSats(u);
  return sum;
}

/**
 * Return the sat value of the single largest UTXO in `utxos`. Empty
 * / null input returns 0n. Ties resolve to the FIRST entry (stable
 * order, mirrors `aboveDustUtxos`).
 *
 * @param {Array<object|null|undefined>|null|undefined} utxos
 * @returns {bigint}
 */
export function largestUtxoSats(utxos) {
  if (!Array.isArray(utxos) || utxos.length === 0) return 0n;
  let max = 0n;
  for (const u of utxos) {
    const s = utxoSats(u);
    if (s > max) max = s;
  }
  return max;
}

/**
 * Is this UTXO below `thresholdSats`? Anything at or below the
 * threshold counts as dust (the dust threshold is a hard cutoff —
 * `>=` is "dust"). Defensive against null / non-object / negative
 * / non-bigint thresholds.
 *
 * @param {object|null|undefined} u
 * @param {bigint|number|string} thresholdSats
 * @returns {boolean}
 */
export function isDustUtxo(u, thresholdSats) {
  const t = (typeof thresholdSats === 'bigint') ? thresholdSats : (() => {
    if (typeof thresholdSats === 'number' && Number.isFinite(thresholdSats)) return BigInt(Math.max(0, Math.floor(thresholdSats)));
    if (typeof thresholdSats === 'string' && thresholdSats.length > 0) {
      try { return BigInt(thresholdSats); } catch { return 0n; }
    }
    return 0n;
  })();
  if (t <= 0n) return false; // threshold of zero or negative means "no dust filter"
  return utxoSats(u) <= t;
}

/**
 * Filter `utxos` down to the entries that are above the dust
 * threshold. Stable order (preserves the caller's input order so the
 * consolidation tx inputs match the operator's intuition). Returns a
 * new array; does not mutate.
 *
 * @param {Array<object|null|undefined>|null|undefined} utxos
 * @param {bigint|number|string} thresholdSats
 * @returns {Array<object>}
 */
export function aboveDustUtxos(utxos, thresholdSats) {
  if (!Array.isArray(utxos)) return [];
  const out = [];
  for (const u of utxos) {
    if (!u || typeof u !== 'object') continue;
    if (!isDustUtxo(u, thresholdSats)) out.push(u);
  }
  return out;
}

// ── fragmentation analysis ─────────────────────────────────────────────

/**
 * Reason codes returned by `analyzeUtxoFragmentation`. The reason
 * is stable (a string literal the loop can match on) and human-
 * readable (the CLI prints it verbatim).
 *
 *   'clean'                         — every above-dust UTXO is
 *                                     smaller than required but
 *                                     `totalSats >= requiredSats`
 *                                     AND `largestSats + fee fits`,
 *                                     meaning the bot CAN fund the
 *                                     trade without consolidation.
 *                                     Wait, no — re-read the spec:
 *                                     `clean` means NO consolidation
 *                                     is recommended because the
 *                                     single largest UTXO already
 *                                     fits the requirement.
 *   'largest_below_required'        — single largest UTXO is below
 *                                     `requiredSats` + fee headroom.
 *                                     Consolidation is recommended
 *                                     if `totalSats >= requiredSats`.
 *   'no_above_dust_utxos'           — every UTXO is dust; nothing
 *                                     to consolidate; loop should
 *                                     skip the entry (no point
 *                                     trying to fund a buy from
 *                                     dust).
 *   'below_min_balance'             — total wallet balance is below
 *                                     `minBalanceSats` reserve; the
 *                                     trade is unsafe to attempt
 *                                     regardless of UTXO shape
 *                                     (this is the same gate as
 *                                     `risk.min_wallet_balance_bch`
 *                                     but exposed here so the
 *                                     analysis is a single source of
 *                                     truth).
 *   'no_required'                   — caller didn't supply
 *                                     `requiredSats`; analysis is
 *                                     informational only and we
 *                                     don't recommend
 *                                     consolidation.
 */
export const FRAGMENT_REASONS = Object.freeze({
  CLEAN: 'clean',
  LARGEST_BELOW_REQUIRED: 'largest_below_required',
  NO_ABOVE_DUST_UTXOS: 'no_above_dust_utxos',
  BELOW_MIN_BALANCE: 'below_min_balance',
  NO_REQUIRED: 'no_required',
});

/**
 * Classify the wallet's UTXO set against a candidate trade size.
 * Returns an analysis object — pure, no side effects, no throws
 * (defensive against malformed input).
 *
 * @param {Array<object|null|undefined>|null|undefined} utxos
 * @param {object} opts
 * @param {bigint|number|string|null|undefined} [opts.requiredSats]
 *        The minimum sat value a single UTXO must reach to fund
 *        the trade (typically `entry.max_position_bch * 1e8 +
 *        fee_estimate_sats`). Optional — when missing, the
 *        analysis reports shape but never recommends consolidation.
 * @param {bigint|number|string} [opts.dustThresholdSats=1000n]
 *        UTXOs at or below this sat value are treated as dust and
 *        excluded from the "consolidatable" set. Default 1,000
 *        sats — conservative enough that consolidating won't sweep
 *        worthless dust, generous enough that a few UTXOs of 1k
 *        each won't trigger the gate on a 0.005 BCH trade.
 * @param {bigint|number|string|null|undefined} [opts.minBalanceSats=null]
 *        If the total wallet balance is BELOW this value, the
 *        reason is `below_min_balance` and `needsConsolidation` is
 *        false (no point consolidating into a reserve breach).
 *        Optional — null/undefined means "no min-balance gate" and
 *        the caller is responsible for the wallet-floor check
 *        elsewhere.
 * @returns {{
 *   totalSats: bigint,
 *   largestSats: bigint,
 *   dustCount: number,
 *   consolidatedCount: number,
 *   needsConsolidation: boolean,
 *   reason: string,
 *   requiredSats: bigint|null,
 *   feeHeadroomSats: bigint|null,
 *   consolidatedUtxos: Array<object>,
 * }}
 */
export function analyzeUtxoFragmentation(utxos, opts = {}) {
  const safeList = Array.isArray(utxos) ? utxos : [];
  const totalSats = totalUtxoSats(safeList);
  const largestSats = largestUtxoSats(safeList);
  const dustCount = safeList.filter((u) => u && typeof u === 'object' && isDustUtxo(u, opts.dustThresholdSats ?? 1000n)).length;
  const consolidatedUtxos = aboveDustUtxos(safeList, opts.dustThresholdSats ?? 1000n);
  const consolidatedCount = consolidatedUtxos.length;

  const reqRaw = opts.requiredSats;
  let requiredSats = null;
  if (typeof reqRaw === 'bigint') requiredSats = reqRaw >= 0n ? reqRaw : null;
  else if (typeof reqRaw === 'number' && Number.isFinite(reqRaw)) requiredSats = reqRaw >= 0 ? BigInt(Math.floor(reqRaw)) : null;
  else if (typeof reqRaw === 'string' && reqRaw.length > 0) {
    try { const n = BigInt(reqRaw); requiredSats = n >= 0n ? n : null; } catch { requiredSats = null; }
  }

  const minRaw = opts.minBalanceSats;
  let minBalanceSats = null;
  if (typeof minRaw === 'bigint') minBalanceSats = minRaw >= 0n ? minRaw : null;
  else if (typeof minRaw === 'number' && Number.isFinite(minRaw)) minBalanceSats = minRaw >= 0 ? BigInt(Math.floor(minRaw)) : null;
  else if (typeof minRaw === 'string' && minRaw.length > 0) {
    try { const n = BigInt(minRaw); minBalanceSats = n >= 0n ? n : null; } catch { minBalanceSats = null; }
  }

  // feeHeadroom: how much room the LARGEST UTXO has above the
  // required size (can be negative). null when no required size
  // was supplied — the analysis is informational only.
  const feeHeadroomSats = (requiredSats === null) ? null : (largestSats - requiredSats);

  let reason;
  let needsConsolidation = false;

  // Order matters: structural checks (min-balance, dust-only) come
  // first so the caller gets a precise reason even when `requiredSats`
  // is null (the CLI's informational path). `no_required` is the
  // fallback for "the caller didn't supply a target size".
  if (minBalanceSats !== null && totalSats < minBalanceSats) {
    // Below reserve: consolidation can't help (would sweep into a
    // floor breach). Flag the gate so the loop can surface it.
    reason = FRAGMENT_REASONS.BELOW_MIN_BALANCE;
  } else if (consolidatedCount === 0) {
    // All dust: nothing to consolidate. The trade can't be funded
    // because dust alone never sums to a useful input.
    reason = FRAGMENT_REASONS.NO_ABOVE_DUST_UTXOS;
  } else if (requiredSats === null) {
    // Caller didn't supply a target size — analysis is
    // informational only.
    reason = FRAGMENT_REASONS.NO_REQUIRED;
  } else if (largestSats >= requiredSats) {
    // Clean: the largest single UTXO already funds the trade. No
    // consolidation recommended.
    reason = FRAGMENT_REASONS.CLEAN;
  } else {
    // Fragmented: total BCH >= required (otherwise BELOW_MIN_BALANCE
    // would have caught it), largest < required. Consolidation is
    // recommended IF there are at least 2 above-dust UTXOs to
    // collapse; a single sub-required UTXO can't be consolidated
    // into itself, so the gate stays false in that edge case.
    reason = FRAGMENT_REASONS.LARGEST_BELOW_REQUIRED;
    needsConsolidation = consolidatedCount >= 2;
  }

  return {
    totalSats,
    largestSats,
    dustCount,
    consolidatedCount,
    needsConsolidation,
    reason,
    requiredSats,
    feeHeadroomSats,
    consolidatedUtxos,
  };
}

// ── fee estimation ─────────────────────────────────────────────────────

/**
 * Estimate the on-chain fee (in sats) for a consolidation
 * transaction that collapses `inputCount` UTXOs into `outputCount`
 * outputs at `feeSatPerByte` sat/byte. The size formula is the
 * conservative BCH P2PKH rule of thumb (~180 bytes per P2PKH
 * input, ~34 bytes per P2PKH output, plus 10 bytes for the tx
 * header + locktime). Same shape `scripts/sweep-funds.mjs` uses
 * for its fee estimate, kept here so the consolidation CLI doesn't
 * have to reach into the sweep script for math.
 *
 * Pure — no network calls, no signing, no validation that
 * `feeSatPerByte` is reasonable. Defensive: returns 0n for
 * non-positive inputs so callers can short-circuit on
 * `estimateConsolidationFeeSats(...) === 0n`.
 *
 * @param {number} inputCount
 * @param {number} outputCount
 * @param {number} [feeSatPerByte=1]
 * @returns {bigint}
 */
export function estimateConsolidationFeeSats(inputCount, outputCount, feeSatPerByte = 1) {
  const i = (Number.isFinite(inputCount) && inputCount > 0) ? Math.floor(inputCount) : 0;
  const o = (Number.isFinite(outputCount) && outputCount > 0) ? Math.floor(outputCount) : 0;
  const f = (Number.isFinite(feeSatPerByte) && feeSatPerByte > 0) ? feeSatPerByte : 0;
  // No inputs = no tx = no fee. Defensive against negative /
  // NaN / Infinity / non-numeric — those clamp to 0 above and the
  // 0-input shortcut catches the degenerate case.
  if (i === 0) return 0n;
  const sizeBytes = 10 + (i * 180) + (o * 34);
  return BigInt(Math.ceil(sizeBytes * f));
}

/**
 * Convenience wrapper: estimate the fee for collapsing the
 * `aboveDust` set into a single output at `feeSatPerByte`.
 *
 * @param {Array<object>} aboveDust
 * @param {number} feeSatPerByte
 * @returns {bigint}
 */
export function estimateConsolidationFeeForSet(aboveDust, feeSatPerByte) {
  return estimateConsolidationFeeSats(Array.isArray(aboveDust) ? aboveDust.length : 0, 1, feeSatPerByte);
}
