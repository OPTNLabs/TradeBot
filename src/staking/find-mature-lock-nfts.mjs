#!/usr/bin/env node
// src/staking/find-mature-lock-nfts.mjs
//
// T58 subset 5 — Pure helpers for the unlock-cron fallback.
//
// Why this exists
// ────────────────
// `scripts/check-stale-stakes.mjs` (the unlock-cron fallback that
// ships alongside this module) needs to scan the wallet's UTXO set
// every `staking.unlock_cron_minutes` and fire `executeUnlock` for
// any lockNFT whose timelock has elapsed. The trader loop already
// implements this in `_maybeAutoUnlock`, but only fires when its
// own tick runs — if the trader loop is paused / crashed / restarted
// the unlock won't happen until the next tick.
//
// Subset 5 closes the gap by introducing a dedicated cron that
// drives the SAME maturity check (`tipHeight - lockBlockHeight >=
// stakeBlocks + graceBlocks`) from outside the trader loop. To keep
// the cron testable without booting Electrum, the maturity math is
// factored into this pure module — `findMatureLockNfts` takes the
// wallet UTXO set + a tipHeight + a graceBlocks offset, returns the
// list of mature lockNFTs in deterministic input order, and
// `pickMatureLockNfts` caps the list to ONE entry so the cron
// drains one lockNFT per invocation (mirroring the trader loop's
// "fail-fast per lock; drain over multiple ticks" contract).
//
// The maturity check uses the SAME seam the trader loop uses:
// `lockUtxo.lockBlockHeight ?? 0`. When the lockUTXO doesn't carry
// a `lockBlockHeight` (the cashscript `Utxo` type doesn't include
// it; production needs a side-channel or a libauth-wallet patch),
// the helper defaults to `0` — the SAME default the trader loop
// uses — so the two surfaces behave identically. A future tick
// can lift this default to a side-channel NDJSON file without
// changing the helper's contract.
//
// Pure — no I/O, no clock injection beyond `nowMs`, no logger. The
// orchestrator (the cron script) owns wallet boot + Electrum
// provider lifecycle + alert dispatch.
//
// Origin: T58 subset 5 (operator-approved via
// `data/feature-ideas.json#idea_operator_add-badgercoin-staking_20260917`).
// Depends on: T58 subset 2 (`findLockNftUtxo` + `decodeLockNftCommitment` +
// `getCommitment` in `src/staking/badger-stake.mjs`).

import {
  findLockNftUtxo,
  decodeLockNftCommitment,
  getCommitment,
  countLockNfts,
  MASTER_CAT,
  CAPABILITY_MUTABLE,
  COMMITMENT_LEN_HEX,
  COMMITMENT_LEN_BYTES,
} from './badger-stake.mjs';

// ─── Constants ──────────────────────────────────────────────────────────

/**
 * Sentinel for "no lockBlockHeight present on the UTXO". The trader
 * loop uses the same default (0), so the cron fallback behaves
 * identically when given the same inputs.
 */
export const DEFAULT_LOCK_BLOCK_HEIGHT = 0;

/**
 * Sentinel for the maximum number of mature locks the cron will
 * attempt to unlock in a single invocation. Mirrors the trader
 * loop's "drain over multiple ticks" contract — fail-fast per
 * lock so a downstream broadcast error doesn't strand the rest of
 * the queue.
 */
export const DEFAULT_MAX_UNLOCKS_PER_RUN = 1;

// ─── Pure helpers ───────────────────────────────────────────────────────

/**
 * Determine whether ONE lockUTXO is mature enough to unlock.
 *
 * "Mature" means: `(tipHeight - lockBlockHeight) >= stakeBlocks
 * + graceBlocks`. The caller passes `graceBlocks` pre-derived from
 * `staking.lock_unlock_grace_seconds` (default 60s / 600s block
 * target = 1 block) so this function stays pure with no config
 * awareness.
 *
 * Defensive against:
 * - Missing / non-numeric `tipHeight` → false (refuse to fire).
 * - Missing / non-positive `stakeBlocks` → false (lockNFT with
 *   stakeBlocks:0 is malformed; the contract wouldn't have
 *   accepted it).
 * - Negative `blocksElapsed` → false (tip below lockBlockHeight
 *   shouldn't happen but we refuse rather than risk a premature
 *   unlock that the contract will reject).
 *
 * @param {Object} args
 * @param {number} args.tipHeight       Current chain tip height.
 * @param {number} args.lockBlockHeight Block height when the lock was created (0 if unknown).
 * @param {number} args.stakeBlocks     Stake length from the lockNFT commitment (must be > 0).
 * @param {number} args.graceBlocks     Pre-derived grace buffer (from `lock_unlock_grace_seconds`).
 * @returns {{ mature: boolean, blocksElapsed: number, blocksRequired: number, reason?: string }}
 */
export function isLockUtxoMature({ tipHeight, lockBlockHeight, stakeBlocks, graceBlocks }) {
  if (!Number.isFinite(tipHeight) || tipHeight < 0) {
    return { mature: false, blocksElapsed: 0, blocksRequired: 0, reason: 'invalid_tip_height' };
  }
  if (!Number.isFinite(stakeBlocks) || stakeBlocks <= 0) {
    return { mature: false, blocksElapsed: 0, blocksRequired: 0, reason: 'invalid_stake_blocks' };
  }
  if (!Number.isFinite(graceBlocks) || graceBlocks < 0) {
    // Grace blocks is defensive — a bad value is treated as zero
    // (the lock must still satisfy the timelock).
    graceBlocks = 0;
  }
  const blocksElapsed = Math.max(0, Math.floor(tipHeight) - Math.floor(lockBlockHeight ?? 0));
  const blocksRequired = Math.floor(stakeBlocks) + Math.floor(graceBlocks);
  if (blocksElapsed < 0) {
    return { mature: false, blocksElapsed, blocksRequired, reason: 'tip_below_lock_block_height' };
  }
  if (blocksElapsed < blocksRequired) {
    return { mature: false, blocksElapsed, blocksRequired, reason: 'timelock_not_elapsed' };
  }
  return { mature: true, blocksElapsed, blocksRequired };
}

/**
 * Find every lockNFT in `utxos` whose timelock has elapsed.
 *
 * The helper loops the wallet UTXO set, finds every mutable +
 * masterCat-prefixed UTXO with a 40-byte commitment (the lockNFT
 * shape), decodes the commitment to extract `stakeBlocks`, then
 * applies `isLockUtxoMature` with the supplied `tipHeight` and
 * `graceBlocks`. LockNFTs whose commitment decode throws (malformed
 * 40-byte commitment) are recorded in `undecodable` and skipped —
 * the cron never crashes on a bad UTXO shape.
 *
 * Output order matches input order so the cron's deterministic
 * drain surfaces the OLDEST lock first (assuming the wallet returns
 * UTXOs in insertion order — which Electrum does; not a guarantee
 * but a useful default).
 *
 * @param {Object[]} utxos
 * @param {Object} opts
 * @param {number} opts.tipHeight
 * @param {number} [opts.graceBlocks=1]
 * @param {number} [opts.maxPerRun=DEFAULT_MAX_UNLOCKS_PER_RUN] Cap on returned mature list length.
 * @returns {{
 *   mature: Object[],                  // Mature lockNFTs ready for `executeUnlock` (capped).
 *   premature: Object[],               // LockNFTs still under timelock (informational).
 *   undecodable: Object[],             // LockNFTs whose commitment couldn't be decoded.
 *   totalLockNftCount: number,         // countLockNfts(utxos) at entry.
 *   skippedCap: number,                // How many mature entries were dropped by `maxPerRun`.
 *   reasonCounts: Record<string, number>,
 * }}
 */
export function findMatureLockNfts(utxos, { tipHeight, graceBlocks = 1, maxPerRun = DEFAULT_MAX_UNLOCKS_PER_RUN } = {}) {
  const result = {
    mature: [],
    premature: [],
    undecodable: [],
    totalLockNftCount: countLockNfts(utxos),
    skippedCap: 0,
    reasonCounts: {},
  };
  if (!Array.isArray(utxos) || utxos.length === 0) {
    return result;
  }
  if (!Number.isFinite(tipHeight) || tipHeight < 0) {
    result.reasonCounts.invalid_tip_height = (result.reasonCounts.invalid_tip_height || 0) + 1;
    return result;
  }
  if (!Number.isFinite(maxPerRun) || maxPerRun < 1) {
    maxPerRun = DEFAULT_MAX_UNLOCKS_PER_RUN;
  }

  for (const u of utxos) {
    if (!u || typeof u !== 'object') continue;
    const tid = String(u?.token?.tokenId ?? u?.tokenCategory ?? '').toLowerCase();
    if (tid.slice(0, 64) !== MASTER_CAT.toLowerCase()) continue;
    if (tid.length < 65) continue; // need category + at least 1 capability byte
    const capByte = parseInt(tid.slice(64, 66), 16);
    if (capByte !== CAPABILITY_MUTABLE) continue;
    const commitment = getCommitment(u);

    let decoded;
    if (commitment.length !== COMMITMENT_LEN_HEX) {
      // Mutable + masterCat + wrong commitment length → malformed
      // lockNFT. Surface it to the operator so they can investigate
      // (don't silently skip — a real bad UTXO is a bug worth seeing).
      result.undecodable.push({ utxo: u, error: `commitment length ${commitment.length / 2} bytes != ${COMMITMENT_LEN_BYTES}` });
      result.reasonCounts.decode_failed = (result.reasonCounts.decode_failed || 0) + 1;
      continue;
    }
    try {
      decoded = decodeLockNftCommitment(commitment);
    } catch (e) {
      result.undecodable.push({ utxo: u, error: e?.message ?? String(e) });
      result.reasonCounts.decode_failed = (result.reasonCounts.decode_failed || 0) + 1;
      continue;
    }

    const lockBlockHeight = Number(u.lockBlockHeight ?? DEFAULT_LOCK_BLOCK_HEIGHT);
    const stakeBlocks = Number(decoded.stakeBlocks);
    const maturity = isLockUtxoMature({
      tipHeight,
      lockBlockHeight,
      stakeBlocks,
      graceBlocks,
    });
    if (maturity.mature) {
      // Tag the UTXO with the maturity envelope so the cron's
      // audit line can carry `blocksElapsed` + `blocksRequired`
      // without re-decoding the commitment.
      result.mature.push({
        ...u,
        _maturity: {
          blocksElapsed: maturity.blocksElapsed,
          blocksRequired: maturity.blocksRequired,
          stakeBlocks,
          lockBlockHeight,
        },
      });
    } else {
      result.premature.push({
        ...u,
        _maturity: {
          blocksElapsed: maturity.blocksElapsed,
          blocksRequired: maturity.blocksRequired,
          stakeBlocks,
          lockBlockHeight,
          reason: maturity.reason ?? 'unknown',
        },
      });
      const key = maturity.reason ?? 'unknown';
      result.reasonCounts[key] = (result.reasonCounts[key] || 0) + 1;
    }
  }

  // Deterministic sort by lockBlockHeight ASC (oldest first), tiebreak
  // by txid then vout. This means the cron's "drain one lock per run"
  // surfaces the oldest matured lock, matching the spirit of the
  // trader loop's fail-fast-per-lock contract.
  result.mature.sort((a, b) => {
    const ah = a._maturity.lockBlockHeight;
    const bh = b._maturity.lockBlockHeight;
    if (ah !== bh) return ah - bh;
    const at = String(a?.txid ?? '');
    const bt = String(b?.txid ?? '');
    if (at !== bt) return at < bt ? -1 : at > bt ? 1 : 0;
    return Number(a?.vout ?? 0) - Number(b?.vout ?? 0);
  });
  result.premature.sort((a, b) => a._maturity.blocksElapsed - b._maturity.blocksElapsed);

  // Cap the mature list to `maxPerRun` (default 1) so the cron drains
  // one lock per invocation.
  if (result.mature.length > maxPerRun) {
    result.skippedCap = result.mature.length - maxPerRun;
    result.mature = result.mature.slice(0, maxPerRun);
  }

  return result;
}

/**
 * Pick the FIRST mature lockNFT. Convenience wrapper around
 * `findMatureLockNfts(...).mature[0]` with a defensive null return
 * when no mature lock exists. Pure.
 *
 * @param {Object[]} utxos
 * @param {Object} opts   Same shape as `findMatureLockNfts`.
 * @returns {Object|null}  The first mature lockNFT (with `_maturity` envelope) or null.
 */
export function pickMatureLockNft(utxos, opts) {
  const result = findMatureLockNfts(utxos, opts);
  if (!result.mature || result.mature.length === 0) return null;
  return result.mature[0];
}

/**
 * Convert `lock_unlock_grace_seconds` (config knob, default 60s)
 * into a blocks-offset for the maturity check. BCH block target
 * is 600s; we round up so a 1-second grace still counts as a full
 * block buffer (matches the trader loop's `Math.ceil(graceSeconds /
 * 600)` formula).
 *
 * Defensive:
 * - Non-finite / negative input → 1 (the loop's default).
 * - Zero → 0 (caller explicitly opts out of grace).
 *
 * @param {number} graceSeconds
 * @returns {number}
 */
export function graceSecondsToBlocks(graceSeconds) {
  if (!Number.isFinite(graceSeconds) || graceSeconds < 0) return 1;
  if (graceSeconds === 0) return 0;
  return Math.ceil(graceSeconds / 600);
}

// ─── Exports for tests + downstream consumers ───────────────────────────

export const _internals = Object.freeze({
  isLockUtxoMature,
  graceSecondsToBlocks,
  DEFAULT_LOCK_BLOCK_HEIGHT,
  DEFAULT_MAX_UNLOCKS_PER_RUN,
});

export const _meta = Object.freeze({
  module: 'src/staking/find-mature-lock-nfts.mjs',
  version: 1,
  companion: 'src/staking/badger-stake.mjs (T58 subset 1) + src/staking/badger-stake-tx.mjs (T58 subset 2) + src/staking/stake-alert-dispatch.mjs (T58 subset 3)',
  cronScript: 'scripts/check-stale-stakes.mjs (T58 subset 5)',
});
