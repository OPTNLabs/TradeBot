#!/usr/bin/env node
// src/staking/badger-stake.mjs
//
// TradeBot — BadgerCoin Staking foundation (T58 subset 1).
//
// Pure-function helpers around the canonical Sayoshi-Nakamario
// BadgersStake CashScript contract. Nothing in this module touches
// a private key, never broadcasts, never reads the user's WIF —
// it is the read-only + simulation surface that a future "sign +
// broadcast" layer (T58 subset 2) will wrap.
//
// Why this exists
// ───────────────
// 50% of the bot's held-but-inactive BCH is earning nothing. The
// operator wants to send it to the BadgerStake contract, timelock
// it for a configurable period, and earn BadgerCoin fungible
// tokens as a reward. The contract is at
// https://github.com/LifestoneLabs/BadgerStake and the canonical
// simulation scripts live at
// `repos/AI_Skills/skills/badgersstake/scripts/`. This module
// inlines the parts of that skill that the bot actually needs
// (commitment decoders + reward formula + lock-param validator +
// master-state inspector + lock-simulation builder) so the
// supervisor can ship a real, typed, tested foundation in one
// tick.
//
// What this module DOES NOT do
// ───────────────────────────
// - No signing. Signing lives in T58 subset 2 (libauth + cashscript
//   Electrum, mirroring how `src/trader/swap.mjs` wraps
//   `src/trader/cauldron/check_and_swap.mjs`).
// - No trader-loop wiring. Auto-stake is a separate subset so the
//   hot-path budget gets its own tick.
// - No dashboard tile. UI lands in T58 subset 2 alongside the
//   dashboard's existing `/api/stakes` endpoint.
//
// Contract constants (mirror `references/badgerstake_contract.md`)
// ──────────────────────────────────────────────────────────────────
// MASTER_CAT             = d7ff0a63d5c1cbe1ced509314fe3caca563a73095be37734744c40dbce6e2f24
//                          (Badger NFT category; lockNFT = +0x01 mutable;
//                           Honey NFT = same category, no capability;
//                           BadgerCoin FT = same category, no capability)
// MIN_LOCK_AMOUNT_SATS   = 5000          (unlock costs 3000 sats, so < 5000 = uneconomic)
// MAX_STAKE_BLOCKS       = 65536         (~455 days at 600-second target)
// UNLOCK_DUST_FEE_SATS   = 3000          (BadgerCoin 1000 + Honey 1000 + miner 1000)
// WITHDRAW_DUST_FEE_SATS = 2000          (masterBadger dust 1000 + miner 1000)
// REWARD_DIVISOR         = 100_000_000n  (reward = amount * stakeBlocks / 1 BCH in sats)
// MIN_REWARD             = 1n            (contract refuses locks that earn < 1 BadgerCoin)
//
// Commitment layouts
// ──────────────────
// masterBadger:  fee[2] (BE uint16) + reserved[18] + adminPkh[20]    = 40 bytes
// lockNFT:       userPkh[20]          + reserved[18 (zero)] +
//                stakeBlocks[2] (BE uint16)                          = 40 bytes
//
// Origin: derived from `repos/AI_Skills/skills/badgersstake/scripts/`
// (decode_commitment.mjs + simulate_lock.mjs + inspect_stake.mjs).
// Re-implemented inline so the bot doesn't import a sibling repo at
// runtime — a follow-up tick may consolidate by copying the upstream
// files into `src/staking/` if the cross-repo import proves fragile.

import process from 'node:process';

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

/** The Badger NFT category ID (32-byte hex). The lockNFT is the +0x01
 *  mutable variant of this category; the Honey NFT + BadgerCoin FT
 *  share the same category with no capability. */
export const MASTER_CAT = 'd7ff0a63d5c1cbe1ced509314fe3caca563a73095be37734744c40dbce6e2f24';

/** Hardcoded contract minimum lock amount (sats). */
export const MIN_LOCK_AMOUNT_SATS = 5000n;

/** Hardcoded contract maximum stake length (blocks; ~455 days). */
export const MAX_STAKE_BLOCKS = 65536;

/** Total dust cost of an `unlock()` tx (BadgerCoin UTXO 1000 + Honey
 *  UTXO 1000 + miner fee 1000). Subtracted from the locked amount
 *  when computing net BCH returned at unlock time. */
export const UNLOCK_DUST_FEE_SATS = 3000n;

/** Dust cost of an admin `withdraw(newFee)` tx (masterBadger dust
 *  1000 + miner fee 1000). Subtracted from the admin sweep output. */
export const WITHDRAW_DUST_FEE_SATS = 2000n;

/** Reward formula divisor (1 BCH in sats). The contract enforces
 *  `reward = amount * stakeBlocks / REWARD_DIVISOR`. */
export const REWARD_DIVISOR = 100_000_000n;

/** Minimum reward the contract will accept (the contract refuses to
 *  lock if the computed reward would be < 1 BadgerCoin). */
export const MIN_REWARD = 1n;

/** Length of every commitment in the BadgersStake contract (bytes). */
export const COMMITMENT_LEN_BYTES = 40;

/** Length of every commitment as a hex string. */
export const COMMITMENT_LEN_HEX = COMMITMENT_LEN_BYTES * 2;

/** Length of a P2PKH pubkeyhash (bytes). */
export const PKH_LEN_BYTES = 20;

/** Length of a P2PKH pubkeyhash as a hex string. */
export const PKH_LEN_HEX = PKH_LEN_BYTES * 2;

/** Capability byte that marks a master NFT (minting). */
export const CAPABILITY_MINTING = 0x02;

/** Capability byte that marks a lock NFT (mutable). */
export const CAPABILITY_MUTABLE = 0x01;

/** Approximately 144 blocks per day at 600-second BCH block target. */
export const PEER_BLOCKS_PER_DAY = 144;

/** Stake length to use when the operator passes days (default). */
export const DEFAULT_STAKE_BLOCKS = 1440; // ~10 days

/** Default default lock amount when not specified (sats). */
export const DEFAULT_LOCK_AMOUNT_SATS = 500_000n; // 0.005 BCH

/** Canonical contract addresses (precomputed from BadgerStake.json). */
export const CONTRACT_ADDRESS = Object.freeze({
  mainnet: 'bitcoincash:pvgcl3xk6nwqlngkk09e7g67x5vxs57jv6v2q4qm4ct5yv4d3ppfgl3tq982v',
  chipnet: 'bchtest:pvgcl3xk6nwqlngkk09e7g67x5vxs57jv6v2q4qm4ct5yv4d3ppfguk67a5l7',
});

/** Watchtower.cash REST endpoint prefixes for CashToken UTXO lookup. */
export const WATCHTOWER_BASE = Object.freeze({
  mainnet: 'https://watchtower.cash/api/',
  chipnet: 'https://chipnet.watchtower.cash/api/',
});

/** Frozen default config shape (the on-disk `config/default.json`
 *  `staking` block is deep-merged onto this at boot). All numeric
 *  knobs are `number` (not bigint) so the trader-loop can hot-read
 *  them like every other knob; conversion to bigint happens at the
 *  call site. */
export const DEFAULT_STAKING_CONFIG = Object.freeze({
  enabled: false,
  network: 'mainnet',
  contract_address: CONTRACT_ADDRESS.mainnet,
  watchtower_base: WATCHTOWER_BASE.mainnet,
  lock_amount_sats: 500_000,            // 0.005 BCH (matches max_position_bch)
  lock_min_sats: 5_000,                // contract floor
  lock_max_sats: 50_000_000,           // 0.5 BCH ceiling (above this, the user should not auto-stake)
  stake_blocks: 1440,                  // ~10 days
  max_active_stakes: 1,                // one BadgerStake position at a time
  inactive_fraction_to_stake: 0.5,      // user spec: 50% of inactive BCH
  allow_when_positions_open: false,    // conservative: don't stake while trades are mid-flight
  simulation_only: true,               // subset 1 = never broadcast; subset 2 flips to false
  request_timeout_ms: 10_000,
  // T58 subset 2 — sign-and-broadcast knobs (defaults for safe config / no-config paths).
  // Subset 2 ships the lock + unlock tx builders; these three knobs let the
  // operator tune the defensive guards without touching `config/default.json`.
  // Mirrors the small-balance philosophy: refuse to lock below the wallet reserve,
  // require a small grace buffer before the timelock expires the lock can be
  // unlocked, and cap fee rate to keep the dust-tier lock + unlock affordable.
  lock_min_balance_bch: 0.005,         // refuse to lock below this reserve (mirrors risk.min_wallet_balance_bch)
  lock_unlock_grace_seconds: 60,       // buffer before the timelock expires the lock can be unlocked
  fee_sat_per_byte: 1,                 // cashscript TransactionBuilder fee rate (1 sat/B keeps dust-tier affordable)
});

// ─────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────

export class StakingConfigError extends Error {
  /**
   * @param {string} message
   * @param {Object} [opts]
   * @param {Error}  [opts.cause]
   */
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'StakingConfigError';
    this.code = 'STAKING_CONFIG';
    if (cause) this.cause = cause;
  }
}

export class StakingParamError extends Error {
  /**
   * @param {string} message
   * @param {Object} [opts]
   * @param {Error}  [opts.cause]
   */
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'StakingParamError';
    this.code = 'STAKING_PARAM';
    if (cause) this.cause = cause;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Pure helpers — hex / byte utilities
// ─────────────────────────────────────────────────────────────────────

/** Strip a `0x` or `\x` prefix from a hex string. Pure. */
export function stripHexPrefix(s) {
  if (typeof s !== 'string') return '';
  if (s.startsWith('0x') || s.startsWith('\\x')) return s.slice(2);
  return s;
}

/** Is the input an N-character hex string (no prefix)? Pure. */
export function isHexN(s, n) {
  if (typeof s !== 'string') return false;
  const t = stripHexPrefix(s);
  return t.length === n && /^[0-9a-fA-F]+$/.test(t);
}

/** Is the input a 40-char hex string? Pure. */
export function isHex40(s) {
  return isHexN(s, COMMITMENT_LEN_HEX);
}

/** Is the input a 20-char hex string? Pure. */
export function isHex20(s) {
  return isHexN(s, PKH_LEN_HEX);
}

/** Convert a hex string to a Uint8Array. Pure; throws on bad input. */
export function hexToBytes(hex) {
  const t = stripHexPrefix(hex);
  if (t.length % 2 !== 0) throw new StakingParamError(`hexToBytes: odd-length hex: ${hex}`);
  if (!/^[0-9a-fA-F]+$/.test(t)) throw new StakingParamError(`hexToBytes: non-hex chars in: ${hex}`);
  const out = new Uint8Array(t.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(t.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Convert a Uint8Array (or array of numbers) to a lowercase hex string. Pure. */
export function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) {
    s += (bytes[i] & 0xff).toString(16).padStart(2, '0');
  }
  return s;
}

/** Read a big-endian uint16 from a byte array at the given offset. Pure. */
export function readUint16BE(bytes, offset) {
  if (offset < 0 || offset + 2 > bytes.length) {
    throw new StakingParamError(`readUint16BE: offset ${offset} out of range (bytes.length=${bytes.length})`);
  }
  return (bytes[offset] << 8) | bytes[offset + 1];
}

/** Read a 20-byte slice as a hex string. Pure. */
export function readBytes20Hex(bytes, offset) {
  if (offset < 0 || offset + 20 > bytes.length) {
    throw new StakingParamError(`readBytes20Hex: offset ${offset} out of range (bytes.length=${bytes.length})`);
  }
  return bytesToHex(bytes.slice(offset, offset + 20));
}

/** Read an 18-byte slice as a hex string. Pure. */
export function readBytes18Hex(bytes, offset) {
  if (offset < 0 || offset + 18 > bytes.length) {
    throw new StakingParamError(`readBytes18Hex: offset ${offset} out of range (bytes.length=${bytes.length})`);
  }
  return bytesToHex(bytes.slice(offset, offset + 18));
}

// ─────────────────────────────────────────────────────────────────────
// Pure helpers — BigInt coercion
// ─────────────────────────────────────────────────────────────────────

/** Coerce a value to a BigInt, returning 0n for null/undefined/empty.
 *  Throws on strings that are not integers and on non-numeric types. */
export function bigOrZero(v) {
  if (v === null || v === undefined) return 0n;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new StakingParamError(`bigOrZero: non-finite number: ${v}`);
    return BigInt(Math.trunc(v));
  }
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return 0n;
    if (!/^-?\d+$/.test(t)) throw new StakingParamError(`bigOrZero: non-integer string: "${v}"`);
    return BigInt(t);
  }
  throw new StakingParamError(`bigOrZero: unsupported type: ${typeof v}`);
}

// ─────────────────────────────────────────────────────────────────────
// Commitment decoders (40-byte master / 40-byte lock)
// ─────────────────────────────────────────────────────────────────────

/**
 * Decode a masterBadger commitment (40 bytes):
 *   bytes 0-1:   stakeFee (BE uint16; the per-lock fee in sats)
 *   bytes 2-19:  reserved (18 bytes; unused by the contract in this version)
 *   bytes 20-39: adminAddress (20 bytes; the admin's P2PKH pubkeyhash)
 *
 * Pure; throws on wrong-length input.
 *
 * @param {string|Uint8Array} hexOrBytes
 * @returns {{ kind: 'master', stakeFee: number, reserved: string,
 *             adminAddress: Uint8Array, adminAddressHex: string,
 *             commitmentHex: string }}
 */
export function decodeMasterCommitment(hexOrBytes) {
  const bytes = typeof hexOrBytes === 'string' ? hexToBytes(hexOrBytes) : hexOrBytes;
  if (!(bytes instanceof Uint8Array)) {
    throw new StakingParamError(`decodeMasterCommitment: expected string or Uint8Array; got ${typeof hexOrBytes}`);
  }
  if (bytes.length !== COMMITMENT_LEN_BYTES) {
    throw new StakingParamError(
      `decodeMasterCommitment: master commitment must be ${COMMITMENT_LEN_BYTES} bytes; got ${bytes.length}`,
    );
  }
  return {
    kind: 'master',
    stakeFee: readUint16BE(bytes, 0),
    reserved: readBytes18Hex(bytes, 2),
    adminAddress: bytes.slice(20, 40),
    adminAddressHex: readBytes20Hex(bytes, 20),
    commitmentHex: bytesToHex(bytes),
  };
}

/**
 * Decode a lockNFT commitment (40 bytes):
 *   bytes 0-19:  userPkh (20 bytes; the user's P2PKH pubkeyhash)
 *   bytes 20-37: reserved (18 bytes; explicitly zero-filled per the contract `bytes18(0)`)
 *   bytes 38-39: stakeBlocks (BE uint16; the stake length in blocks)
 *
 * Pure; throws on wrong-length input.
 *
 * @param {string|Uint8Array} hexOrBytes
 * @returns {{ kind: 'lock', userPkh: Uint8Array, userPkhHex: string,
 *             reserved: string, reservedIsZero: boolean,
 *             stakeBlocks: number, commitmentHex: string }}
 */
export function decodeLockNftCommitment(hexOrBytes) {
  const bytes = typeof hexOrBytes === 'string' ? hexToBytes(hexOrBytes) : hexOrBytes;
  if (!(bytes instanceof Uint8Array)) {
    throw new StakingParamError(`decodeLockNftCommitment: expected string or Uint8Array; got ${typeof hexOrBytes}`);
  }
  if (bytes.length !== COMMITMENT_LEN_BYTES) {
    throw new StakingParamError(
      `decodeLockNftCommitment: lock commitment must be ${COMMITMENT_LEN_BYTES} bytes; got ${bytes.length}`,
    );
  }
  const reserved = bytes.slice(20, 38);
  let reservedIsZero = true;
  for (let i = 0; i < reserved.length; i += 1) {
    if (reserved[i] !== 0) { reservedIsZero = false; break; }
  }
  return {
    kind: 'lock',
    userPkh: bytes.slice(0, 20),
    userPkhHex: readBytes20Hex(bytes, 0),
    reserved: bytesToHex(reserved),
    reservedIsZero,
    stakeBlocks: readUint16BE(bytes, 38),
    commitmentHex: bytesToHex(bytes),
  };
}

/**
 * Auto-detect the commitment layout by inspecting the bytes:
 *   - If bytes 20-37 are all zero AND bytes 38-39 are non-zero
 *     (stakeBlocks != 0), it's almost certainly a lockNFT commitment.
 *   - Otherwise it's a masterBadger commitment.
 *
 * Pure; throws on wrong-length input.
 *
 * @param {string|Uint8Array} hexOrBytes
 * @returns {{ kind: 'master'|'lock', decoded: object }}
 */
export function decodeCommitmentAuto(hexOrBytes) {
  const bytes = typeof hexOrBytes === 'string' ? hexToBytes(hexOrBytes) : hexOrBytes;
  if (!(bytes instanceof Uint8Array)) {
    throw new StakingParamError(`decodeCommitmentAuto: expected string or Uint8Array; got ${typeof hexOrBytes}`);
  }
  if (bytes.length !== COMMITMENT_LEN_BYTES) {
    throw new StakingParamError(
      `decodeCommitmentAuto: commitment must be ${COMMITMENT_LEN_BYTES} bytes; got ${bytes.length}`,
    );
  }
  // Heuristic: a lockNFT has 18 zero bytes at offset 20 and a
  // non-zero stakeBlocks at offset 38.
  let reservedAllZero = true;
  for (let i = 20; i < 38; i += 1) {
    if (bytes[i] !== 0) { reservedAllZero = false; break; }
  }
  const stakeBlocks = (bytes[38] << 8) | bytes[39];
  if (reservedAllZero && stakeBlocks > 0) {
    return { kind: 'lock', decoded: decodeLockNftCommitment(bytes) };
  }
  return { kind: 'master', decoded: decodeMasterCommitment(bytes) };
}

// ─────────────────────────────────────────────────────────────────────
// Lock-param validation + reward formula
// ─────────────────────────────────────────────────────────────────────

/**
 * Compute the BadgerCoin reward for a given lock. Pure.
 *   reward = amount_sats * stake_blocks / REWARD_DIVISOR
 *
 * @param {bigint|number|string} amountSats
 * @param {number}               stakeBlocks
 * @returns {bigint} the BadgerCoin reward (>= 1n or throws)
 */
export function computeStakeReward(amountSats, stakeBlocks) {
  if (typeof stakeBlocks !== 'number' || !Number.isInteger(stakeBlocks) || stakeBlocks < 0) {
    throw new StakingParamError(
      `computeStakeReward: stakeBlocks must be a non-negative integer; got ${stakeBlocks}`,
    );
  }
  const amount = bigOrZero(amountSats);
  if (amount < MIN_LOCK_AMOUNT_SATS) {
    throw new StakingParamError(
      `computeStakeReward: amount (${amount} sats) below MIN_LOCK_AMOUNT_SATS (${MIN_LOCK_AMOUNT_SATS} sats)`,
    );
  }
  if (stakeBlocks > MAX_STAKE_BLOCKS) {
    throw new StakingParamError(
      `computeStakeReward: stakeBlocks (${stakeBlocks}) exceeds MAX_STAKE_BLOCKS (${MAX_STAKE_BLOCKS})`,
    );
  }
  const reward = (amount * BigInt(stakeBlocks)) / REWARD_DIVISOR;
  if (reward < MIN_REWARD) {
    throw new StakingParamError(
      `computeStakeReward: stakeReward (${reward}) below MIN_REWARD (${MIN_REWARD}); ` +
      `lock ${amount} sats for ${stakeBlocks} blocks earns ${reward} BadgerCoin — ` +
      `increase amount or stake-blocks to earn >= 1 BadgerCoin`,
    );
  }
  return reward;
}

/**
 * Validate a proposed lock. Pure.
 *
 * @param {Object} p
 * @param {bigint|number|string} p.amountSats
 * @param {number}               p.stakeBlocks
 * @param {Object} [p.cfg]          staking config block; used to bound `amountSats`
 * @returns {{ ok: true, amountSats: bigint, stakeBlocks: number, reward: bigint,
 *             amountBch: number, stakeDays: number } |
 *          { ok: false, error: string, code: string }}
 */
export function validateLockParams(p) {
  if (!p || typeof p !== 'object') {
    return { ok: false, error: 'validateLockParams: params object required', code: 'BAD_INPUT' };
  }
  let amount;
  try {
    amount = bigOrZero(p.amountSats);
  } catch (e) {
    return { ok: false, error: e.message, code: 'BAD_AMOUNT' };
  }
  if (typeof p.stakeBlocks !== 'number' || !Number.isInteger(p.stakeBlocks) || p.stakeBlocks < 0) {
    return {
      ok: false,
      error: `validateLockParams: stakeBlocks must be a non-negative integer; got ${p.stakeBlocks}`,
      code: 'BAD_BLOCKS',
    };
  }
  const cfg = p.cfg || {};
  const floor = bigOrZero(cfg.lock_min_sats ?? MIN_LOCK_AMOUNT_SATS);
  const ceiling = bigOrZero(cfg.lock_max_sats ?? 50_000_000);
  if (amount < floor) {
    return {
      ok: false,
      error: `validateLockParams: amount (${amount}) below floor (${floor})`,
      code: 'BELOW_MIN',
    };
  }
  if (amount > ceiling) {
    return {
      ok: false,
      error: `validateLockParams: amount (${amount}) above ceiling (${ceiling})`,
      code: 'ABOVE_MAX',
    };
  }
  if (p.stakeBlocks > MAX_STAKE_BLOCKS) {
    return {
      ok: false,
      error: `validateLockParams: stakeBlocks (${p.stakeBlocks}) above MAX_STAKE_BLOCKS (${MAX_STAKE_BLOCKS})`,
      code: 'ABOVE_MAX_BLOCKS',
    };
  }
  let reward;
  try {
    reward = computeStakeReward(amount, p.stakeBlocks);
  } catch (e) {
    return { ok: false, error: e.message, code: 'BAD_REWARD' };
  }
  return {
    ok: true,
    amountSats: amount,
    stakeBlocks: p.stakeBlocks,
    reward,
    amountBch: Number(amount) / 100_000_000,
    stakeDays: p.stakeBlocks / PEER_BLOCKS_PER_DAY,
  };
}

/**
 * Resolve the staking config block by deep-merging the caller's
 * partial overrides onto DEFAULT_STAKING_CONFIG. Pure.
 *
 * @param {Object} [partial]
 * @returns {Object}
 */
export function resolveStakingConfig(partial = {}) {
  if (partial === null || typeof partial !== 'object' || Array.isArray(partial)) {
    throw new StakingConfigError(`resolveStakingConfig: expected plain object; got ${typeof partial}`);
  }
  /** @type {any} */
  const out = { ...DEFAULT_STAKING_CONFIG };
  for (const k of Object.keys(partial)) {
    out[k] = partial[k];
  }
  // Network-correct contract address when caller supplied a network.
  if (partial.network === 'chipnet') {
    if (partial.contract_address === undefined) out.contract_address = CONTRACT_ADDRESS.chipnet;
    if (partial.watchtower_base === undefined) out.watchtower_base = WATCHTOWER_BASE.chipnet;
  } else if (partial.network === 'mainnet') {
    if (partial.contract_address === undefined) out.contract_address = CONTRACT_ADDRESS.mainnet;
    if (partial.watchtower_base === undefined) out.watchtower_base = WATCHTOWER_BASE.mainnet;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Lock-NFT commitment builder
// ─────────────────────────────────────────────────────────────────────

/**
 * Build the 40-byte lockNFT commitment the contract will check on
 * spend: `userPkh[20] + reserved[18 (zero)] + stakeBlocks[2] (BE)`.
 *
 * Pure. Throws on bad input.
 *
 * @param {string|Uint8Array} userPkh   20-byte P2PKH pubkeyhash
 * @param {number}            stakeBlocks
 * @returns {Uint8Array} 40-byte commitment (matches BadgerStake.cash L23)
 */
export function buildLockNftCommitment(userPkh, stakeBlocks) {
  const pkh = typeof userPkh === 'string' ? hexToBytes(userPkh) : userPkh;
  if (!(pkh instanceof Uint8Array) || pkh.length !== PKH_LEN_BYTES) {
    throw new StakingParamError(`buildLockNftCommitment: userPkh must be 20 bytes; got ${pkh?.length ?? 'n/a'}`);
  }
  if (typeof stakeBlocks !== 'number' || !Number.isInteger(stakeBlocks) || stakeBlocks < 0 || stakeBlocks > MAX_STAKE_BLOCKS) {
    throw new StakingParamError(`buildLockNftCommitment: stakeBlocks must be int 0..${MAX_STAKE_BLOCKS}; got ${stakeBlocks}`);
  }
  const out = new Uint8Array(COMMITMENT_LEN_BYTES);
  out.set(pkh, 0);
  // bytes 20-37 stay zero (reserved)
  out[38] = (stakeBlocks >> 8) & 0xff;
  out[39] = stakeBlocks & 0xff;
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// UTXO helpers (pure, operate on canonicalized UTXO objects)
// ─────────────────────────────────────────────────────────────────────

/**
 * Extract the canonical category+capability tokenId from a watchtower.cash
 * UTXO. Tolerates both newer (`utxo.token.tokenId`) and legacy
 * (`utxo.tokenCategory`) UTXO shapes. Pure.
 *
 * @param {Object|null|undefined} utxo
 * @returns {string} 66-char hex tokenId (32 bytes cat + 1 byte capability), or '' if unknown
 */
export function getTokenId(utxo) {
  if (!utxo) return '';
  const tid = utxo.token?.tokenId ?? utxo.tokenCategory ?? '';
  return String(tid).toLowerCase();
}

/**
 * Extract the capability byte from a UTXO. Pure.
 * @param {Object|null|undefined} utxo
 * @returns {number|null} 0=none, 1=mutable, 2=mitning; null if unknown
 */
export function getCapability(utxo) {
  if (!utxo) return null;
  const cap = utxo.token?.capability ?? utxo.capability;
  if (cap === null || cap === undefined) return null;
  const n = typeof cap === 'string' ? parseInt(cap, 16) : Number(cap);
  return Number.isFinite(n) ? n : null;
}

/**
 * Extract the NFT commitment from a UTXO. Pure.
 * @param {Object|null|undefined} utxo
 * @returns {string} lowercase hex
 */
export function getCommitment(utxo) {
  if (!utxo) return '';
  return String(utxo.token?.commitment ?? utxo.nftCommitment ?? '').toLowerCase();
}

/**
 * Extract the FT amount from a UTXO. Pure.
 * @param {Object|null|undefined} utxo
 * @returns {bigint}
 */
export function getTokenAmount(utxo) {
  if (!utxo) return 0n;
  return bigOrZero(utxo.token?.amount ?? utxo.tokenAmount ?? 0);
}

/**
 * Extract the BCH sat value from a UTXO. Pure.
 * @param {Object|null|undefined} utxo
 * @returns {bigint}
 */
export function getSatoshis(utxo) {
  if (!utxo) return 0n;
  return bigOrZero(utxo.value ?? utxo.satoshis ?? 0);
}

/**
 * Find the masterBadger UTXO in a list of UTXOs. Pure.
 *   - tokenCategory's 32-byte category == MASTER_CAT
 *   - capability = 0x02 (minting)
 *   - commitment is 40 bytes
 *
 * @param {Object[]} utxos
 * @returns {Object|null}
 */
export function findMasterBadger(utxos) {
  if (!Array.isArray(utxos)) return null;
  const masterCat = MASTER_CAT.toLowerCase();
  for (const u of utxos) {
    const tc = getTokenId(u);
    if (tc.slice(0, 64) !== masterCat) continue;
    if (getCapability(u) !== CAPABILITY_MINTING) continue;
    if (getCommitment(u).length !== COMMITMENT_LEN_HEX) continue;
    return u;
  }
  return null;
}

/**
 * Count the lockNFT UTXOs in a list of UTXOs. Pure.
 * @param {Object[]} utxos
 * @returns {number}
 */
export function countLockNfts(utxos) {
  if (!Array.isArray(utxos)) return 0;
  const masterCat = MASTER_CAT.toLowerCase();
  let n = 0;
  for (const u of utxos) {
    const tc = getTokenId(u);
    if (tc.slice(0, 64) !== masterCat) continue;
    if (getCapability(u) !== CAPABILITY_MUTABLE) continue;
    n += 1;
  }
  return n;
}

/**
 * Find the FIRST lockNFT UTXO in a list of UTXOs (mutable
 * capability + masterCat prefix + 40-byte commitment). Returns
 * `null` when no lockNFT is present. Pure; deterministic order
 * follows the input order so the trader loop's auto-unlock path
 * drains one lockNFT per tick (deterministic + fail-fast).
 *
 * T58 subset 3: this is the auto-wire-side helper that picks the
 * lockNFT the loop will pass to `executeUnlock({ lockUtxo })`.
 *
 * @param {Object[]} utxos
 * @returns {Object|null}
 */
export function findLockNftUtxo(utxos) {
  if (!Array.isArray(utxos)) return null;
  const masterCat = MASTER_CAT.toLowerCase();
  for (const u of utxos) {
    if (!u || typeof u !== 'object') continue;
    const tc = getTokenId(u);
    if (tc.slice(0, 64) !== masterCat) continue;
    if (getCapability(u) !== CAPABILITY_MUTABLE) continue;
    if (getCommitment(u).length !== COMMITMENT_LEN_HEX) continue;
    return u;
  }
  return null;
}

/**
 * Sum the BCH value of all lockNFT UTXOs (locked + un-locked).
 * Useful for surfacing total BCH exposure. Pure.
 * @param {Object[]} utxos
 * @returns {bigint}
 */
export function sumLockNftValue(utxos) {
  if (!Array.isArray(utxos)) return 0n;
  const masterCat = MASTER_CAT.toLowerCase();
  let total = 0n;
  for (const u of utxos) {
    const tc = getTokenId(u);
    if (tc.slice(0, 64) !== masterCat) continue;
    if (getCapability(u) !== CAPABILITY_MUTABLE) continue;
    total += getSatoshis(u);
  }
  return total;
}

// ─────────────────────────────────────────────────────────────────────
// Master-state inspector (pure summary of the masterBadger UTXO)
// ─────────────────────────────────────────────────────────────────────

/**
 * Summarize a masterBadger UTXO into a structured envelope.
 * Pure; never throws on missing UTXO.
 *
 * @param {Object|null|undefined} utxo
 * @param {Object} [opts]
 * @param {'mainnet'|'chipnet'} [opts.network='mainnet']
 * @returns {{
 *   found: boolean,
 *   network: 'mainnet'|'chipnet',
 *   reason?: string,
 *   txid?: string,
 *   vout?: number,
 *   value?: bigint,
 *   commitment?: string,
 *   tokenAmount?: bigint,
 *   stakeFee?: number,
 *   adminPkhHex?: string,
 *   adminPkhBytes?: Uint8Array,
 * }}
 */
export function summarizeMasterBadger(utxo, { network = 'mainnet' } = {}) {
  const net = network === 'chipnet' ? 'chipnet' : 'mainnet';
  if (!utxo) {
    return { found: false, network: net, reason: 'No masterBadger UTXO found at the contract address.' };
  }
  const txid = utxo.outpoint || utxo.tx_hash || utxo.txid || '';
  const vout = typeof utxo.outpoint_index === 'number'
    ? utxo.outpoint_index
    : (typeof utxo.vout === 'number' ? utxo.vout : 0);
  const value = getSatoshis(utxo);
  const commitment = getCommitment(utxo);
  const tokenAmount = getTokenAmount(utxo);
  if (commitment.length !== COMMITMENT_LEN_HEX) {
    return {
      found: false,
      network: net,
      reason: `masterBadger UTXO has malformed commitment (length ${commitment.length / 2} bytes, expected ${COMMITMENT_LEN_BYTES})`,
    };
  }
  let decoded;
  try {
    decoded = decodeMasterCommitment(commitment);
  } catch (e) {
    return {
      found: false,
      network: net,
      reason: `masterBadger commitment decode failed: ${e.message}`,
    };
  }
  return {
    found: true,
    network: net,
    txid,
    vout,
    value,
    commitment,
    tokenAmount,
    stakeFee: decoded.stakeFee,
    adminPkhHex: decoded.adminAddressHex,
    adminPkhBytes: decoded.adminAddress,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Lock simulation (build the inputs/outputs layout; never sign)
// ─────────────────────────────────────────────────────────────────────

/**
 * Simulate a `lock(amount, stakeBlocks, pubkeyhash)` call. Pure.
 *
 * Returns the validated inputs/outputs layout + the computed
 * reward, mirroring every `require` clause from BadgerStake.cash
 * lock() so the operator (or the future sign layer) can verify
 * the on-chain invariants BEFORE signing.
 *
 * @param {Object} p
 * @param {bigint|number|string} p.amountSats
 * @param {number}               p.stakeBlocks
 * @param {string|Uint8Array}    p.userPkh            20-byte P2PKH pubkeyhash (hex or bytes)
 * @param {Object}               p.masterUtxo         the masterBadger UTXO (required)
 * @param {Object[]}             p.userUtxos          the user's BCH UTXOs (one will be spent)
 * @returns {{
 *   ok: true,
 *   masterUtxo: Object,
 *   userInput: Object,
 *   outputs: Object[],
 *   reward: bigint,
 *   stakeReward: bigint,
 *   amountSats: bigint,
 *   stakeBlocks: number,
 *   lockNftCommitment: string,
 *   spentSats: bigint,
 *   changeSats: bigint,
 *   estimatedFeeSats: bigint,
 * } | {
 *   ok: false,
 *   error: string,
 *   code: string,
 *   violations: string[],
 * }}
 */
export function simulateLock({ amountSats, stakeBlocks, userPkh, masterUtxo, userUtxos }) {
  const violations = [];
  if (!masterUtxo) {
    return { ok: false, error: 'simulateLock: masterUtxo required', code: 'NO_MASTER', violations: ['masterUtxo missing'] };
  }
  if (!Array.isArray(userUtxos) || userUtxos.length === 0) {
    return { ok: false, error: 'simulateLock: userUtxos required', code: 'NO_USER_UTXOS', violations: ['userUtxos missing'] };
  }
  if (!userPkh) {
    return { ok: false, error: 'simulateLock: userPkh required', code: 'NO_USER_PKH', violations: ['userPkh missing'] };
  }
  let pkhBytes;
  try {
    pkhBytes = typeof userPkh === 'string' ? hexToBytes(userPkh) : userPkh;
  } catch (e) {
    return { ok: false, error: `simulateLock: bad userPkh: ${e.message}`, code: 'BAD_PKH', violations: [e.message] };
  }
  if (!(pkhBytes instanceof Uint8Array) || pkhBytes.length !== PKH_LEN_BYTES) {
    return {
      ok: false,
      error: `simulateLock: userPkh must be 20 bytes; got ${pkhBytes?.length ?? 'n/a'}`,
      code: 'BAD_PKH_LEN',
      violations: [`userPkh length ${pkhBytes?.length ?? 'n/a'} != 20`],
    };
  }

  // Validate lock params + compute reward.
  let amount, reward;
  try {
    amount = bigOrZero(amountSats);
    reward = computeStakeReward(amount, stakeBlocks);
  } catch (e) {
    return { ok: false, error: e.message, code: 'BAD_PARAMS', violations: [e.message] };
  }

  // Validate masterBadger UTXO: tokenCategory's 32-byte category == MASTER_CAT + capability == minting + commitment is 40 bytes
  const masterCat = MASTER_CAT.toLowerCase();
  const masterTid = getTokenId(masterUtxo);
  if (masterTid.slice(0, 64) !== masterCat) {
    violations.push(`masterUtxo.tokenId prefix ${masterTid.slice(0, 64)} != MASTER_CAT ${masterCat}`);
  }
  if (getCapability(masterUtxo) !== CAPABILITY_MINTING) {
    violations.push(`masterUtxo.capability ${getCapability(masterUtxo)} != minting (0x02)`);
  }
  const masterCommitment = getCommitment(masterUtxo);
  if (masterCommitment.length !== COMMITMENT_LEN_HEX) {
    violations.push(`masterUtxo.commitment length ${masterCommitment.length / 2} != ${COMMITMENT_LEN_BYTES}`);
  }
  const masterSats = getSatoshis(masterUtxo);
  const masterTokenAmount = getTokenAmount(masterUtxo);
  if (masterTokenAmount < reward) {
    violations.push(`masterUtxo.tokenAmount ${masterTokenAmount} < reward ${reward} (master can't pay out the reward)`);
  }

  // Build lockNFT commitment.
  const lockNftCommitmentBytes = buildLockNftCommitment(pkhBytes, stakeBlocks);
  const lockNftCommitment = bytesToHex(lockNftCommitmentBytes);

  // Pick the smallest user BCH UTXO that covers amount + estimated fee (1000 sats).
  const ESTIMATED_FEE_SATS = 1000n;
  let userInput = null;
  let userInputIndex = -1;
  for (let i = 0; i < userUtxos.length; i += 1) {
    const u = userUtxos[i];
    if (getTokenId(u) !== '') continue; // user input must be plain BCH (no tokens)
    const s = getSatoshis(u);
    if (s >= amount + ESTIMATED_FEE_SATS) {
      if (userInput === null || s < getSatoshis(userInput)) {
        userInput = u;
        userInputIndex = i;
      }
    }
  }
  if (!userInput) {
    violations.push(`no BCH UTXO found >= amount (${amount}) + fee (${ESTIMATED_FEE_SATS})`);
  }

  const stakeFee = (() => {
    if (masterCommitment.length !== COMMITMENT_LEN_HEX) return 0;
    try { return decodeMasterCommitment(masterCommitment).stakeFee; }
    catch (_e) { return 0; }
  })();

  // Compute change.
  const userInputSats = userInput ? getSatoshis(userInput) : 0n;
  const changeSats = userInput ? (userInputSats - amount - ESTIMATED_FEE_SATS) : 0n;
  if (changeSats < 0n) {
    violations.push(`userInput ${userInputSats} - amount ${amount} - fee ${ESTIMATED_FEE_SATS} < 0`);
  }

  if (violations.length > 0) {
    return {
      ok: false,
      error: `simulateLock: ${violations.length} violation(s); first: ${violations[0]}`,
      code: 'INVALID',
      violations,
    };
  }

  // Construct the 2- or 3-output layout that the contract expects.
  const outputs = [
    {
      // Output 0: masterBadger NFT carry-forward (value += stakeFee, tokenAmount -= reward)
      lockingBytecode: masterUtxo.lockingBytecode ?? masterUtxo.scriptPubKey ?? null,
      value: masterSats + BigInt(stakeFee),
      tokenCategory: masterTid,
      tokenAmount: masterTokenAmount - reward,
      nftCommitment: masterCommitment,
    },
    {
      // Output 1: lockNFT (mutable + 0x01)
      lockingBytecode: masterUtxo.lockingBytecode ?? masterUtxo.scriptPubKey ?? null,
      value: amount,
      tokenCategory: masterCat + '01',
      tokenAmount: reward,
      nftCommitment: lockNftCommitment,
    },
  ];
  if (changeSats > 0n) {
    outputs.push({
      // Output 2: (optional) user change
      lockingBytecode: 'p2pkh:' + bytesToHex(pkhBytes),
      value: changeSats,
      tokenCategory: null,
      tokenAmount: 0n,
    });
  }

  return {
    ok: true,
    masterUtxo,
    userInput: { ...userInput, _index: userInputIndex },
    outputs,
    reward,
    stakeReward: reward,
    amountSats: amount,
    stakeBlocks,
    lockNftCommitment,
    spentSats: amount,
    changeSats,
    estimatedFeeSats: ESTIMATED_FEE_SATS,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Unlock simulation (build the 3-output unlock tx; never sign)
// ─────────────────────────────────────────────────────────────────────

/**
 * Simulate an `unlock()` call. Pure.
 *
 * Validates the lockUTXO commitment layout + computes the
 * 3-output unlock tx (BadgerCoin FT + Honey NFT + unlocked BCH).
 *
 * @param {Object} p
 * @param {Object} p.lockUtxo         the lockNFT UTXO (required)
 * @param {string|Uint8Array} p.userPkh
 * @returns {{
 *   ok: true,
 *   outputs: Object[],
 *   unlockedBchSats: bigint,
 *   badgerCoinAmount: bigint,
 *   honeyNftCapability: number,
 *   spentSats: bigint,
 *   estimatedFeeSats: bigint,
 * } | {
 *   ok: false,
 *   error: string,
 *   code: string,
 *   violations: string[],
 * }}
 */
export function simulateUnlock({ lockUtxo, userPkh }) {
  const violations = [];
  if (!lockUtxo) {
    return { ok: false, error: 'simulateUnlock: lockUtxo required', code: 'NO_LOCK_UTXO', violations: ['lockUtxo missing'] };
  }
  let pkhBytes;
  try {
    pkhBytes = typeof userPkh === 'string' ? hexToBytes(userPkh) : userPkh;
  } catch (e) {
    return { ok: false, error: `simulateUnlock: bad userPkh: ${e.message}`, code: 'BAD_PKH', violations: [e.message] };
  }
  if (!(pkhBytes instanceof Uint8Array) || pkhBytes.length !== PKH_LEN_BYTES) {
    return {
      ok: false,
      error: `simulateUnlock: userPkh must be 20 bytes; got ${pkhBytes?.length ?? 'n/a'}`,
      code: 'BAD_PKH_LEN',
      violations: [`userPkh length ${pkhBytes?.length ?? 'n/a'} != 20`],
    };
  }
  // LockUTXO shape: tokenCategory starts with MASTER_CAT + capability == mutable (0x01)
  const lockTid = getTokenId(lockUtxo);
  const masterCat = MASTER_CAT.toLowerCase();
  if (lockTid.slice(0, 64) !== masterCat) {
    violations.push(`lockUtxo.tokenId prefix ${lockTid.slice(0, 64)} != MASTER_CAT ${masterCat}`);
  }
  if (getCapability(lockUtxo) !== CAPABILITY_MUTABLE) {
    violations.push(`lockUtxo.capability ${getCapability(lockUtxo)} != mutable (0x01)`);
  }
  const lockCommitment = getCommitment(lockUtxo);
  if (lockCommitment.length !== COMMITMENT_LEN_HEX) {
    violations.push(`lockUtxo.commitment length ${lockCommitment.length / 2} != ${COMMITMENT_LEN_BYTES}`);
  }
  let lockDecoded = null;
  if (lockCommitment.length === COMMITMENT_LEN_HEX) {
    try {
      lockDecoded = decodeLockNftCommitment(lockCommitment);
      // reserved field must be all zero (BadgerStake.cash L23)
      if (!lockDecoded.reservedIsZero) {
        violations.push(`lockUtxo.commitment reserved field is not all zero: ${lockDecoded.reserved}`);
      }
      // The userPkh embedded in the commitment must match the supplied userPkh.
      const embeddedHex = lockDecoded.userPkhHex;
      const suppliedHex = bytesToHex(pkhBytes);
      if (embeddedHex !== suppliedHex) {
        violations.push(`lockUtxo.commitment.userPkh ${embeddedHex} != supplied userPkh ${suppliedHex}`);
      }
    } catch (e) {
      violations.push(`lockUtxo.commitment decode failed: ${e.message}`);
    }
  }

  const lockValue = getSatoshis(lockUtxo);
  const badgerCoinAmount = getTokenAmount(lockUtxo);
  if (badgerCoinAmount < 1n) {
    violations.push(`lockUtxo.tokenAmount ${badgerCoinAmount} < 1 (no BadgerCoin to claim)`);
  }

  const ESTIMATED_FEE_SATS = 1000n;
  const unlockedBchSats = lockValue > UNLOCK_DUST_FEE_SATS ? (lockValue - UNLOCK_DUST_FEE_SATS) : 0n;

  if (violations.length > 0) {
    return {
      ok: false,
      error: `simulateUnlock: ${violations.length} violation(s); first: ${violations[0]}`,
      code: 'INVALID',
      violations,
    };
  }

  const pkhHex = bytesToHex(pkhBytes);
  const masterCatHex = MASTER_CAT.toLowerCase();
  const outputs = [
    {
      // 0: BadgerCoin FT (same category, no capability, fungible)
      lockingBytecode: 'p2pkh:' + pkhHex,
      value: 1000n,
      tokenCategory: masterCatHex,
      tokenAmount: badgerCoinAmount,
    },
    {
      // 1: Honey NFT (same category, no capability)
      lockingBytecode: 'p2pkh:' + pkhHex,
      value: 1000n,
      tokenCategory: masterCatHex,
      tokenAmount: 0n,
    },
    {
      // 2: unlocked BCH (to user)
      lockingBytecode: 'p2pkh:' + pkhHex,
      value: unlockedBchSats,
      tokenCategory: null,
      tokenAmount: 0n,
    },
  ];

  return {
    ok: true,
    outputs,
    unlockedBchSats,
    badgerCoinAmount,
    honeyNftCapability: 0,
    spentSats: lockValue,
    estimatedFeeSats: ESTIMATED_FEE_SATS,
    stakeBlocks: lockDecoded ? lockDecoded.stakeBlocks : null,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Async helpers — fetch CashToken UTXOs from watchtower.cash
// ─────────────────────────────────────────────────────────────────────

/**
 * Fetch CashToken UTXOs at the given address via watchtower.cash.
 * Returns { utxos, cumulativeValue }. Async; uses fetchImpl for
 * testability. Never throws on HTTP error — returns the error in
 * a typed envelope.
 *
 * @param {string} address
 * @param {Object} [opts]
 * @param {'mainnet'|'chipnet'} [opts.network='mainnet']
 * @param {number}               [opts.timeoutMs=10_000]
 * @param {typeof fetch}         [opts.fetchImpl]
 * @returns {Promise<
 *   { ok: true, utxos: Object[], cumulativeValue: bigint, network: 'mainnet'|'chipnet' } |
 *   { ok: false, error: string, code: string }
 * >}
 */
export async function fetchCashTokenUtxos(address, { network = 'mainnet', timeoutMs = 10_000, fetchImpl } = {}) {
  const net = network === 'chipnet' ? 'chipnet' : 'mainnet';
  if (typeof address !== 'string' || address.length === 0) {
    return { ok: false, error: 'fetchCashTokenUtxos: address required', code: 'BAD_ADDRESS' };
  }
  const f = fetchImpl || globalThis.fetch;
  if (typeof f !== 'function') {
    return { ok: false, error: 'No fetch available (use Node 18+ or pass fetchImpl)', code: 'NO_FETCH' };
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const url = `${WATCHTOWER_BASE[net]}transactions/get_cashtokens_utxos`;
    const body = {
      address,
      value: 0,
      token: { tokenId: '', amount: 0 },
      options: { confirmed: true, filter_by_min_value: false },
    };
    const resp = await f(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'follow',
      signal: ctl.signal,
    });
    if (!resp.ok) {
      return {
        ok: false,
        error: `watchtower.cash HTTP ${resp.status} ${resp.statusText} for ${address}`,
        code: 'HTTP_ERROR',
      };
    }
    const data = await resp.json();
    return {
      ok: true,
      utxos: Array.isArray(data?.utxos) ? data.utxos : [],
      cumulativeValue: bigOrZero(data?.cumulativeValue ?? 0),
      network: net,
    };
  } catch (e) {
    return { ok: false, error: `fetchCashTokenUtxos: ${e.message}`, code: 'NETWORK_ERROR' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch + decode the masterBadger state at the configured contract
 * address. Async convenience wrapper.
 *
 * @param {Object} [opts]
 * @param {Object} [opts.cfg]               staking config block (defaults to DEFAULT_STAKING_CONFIG)
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {Promise<{
 *   ok: true,
 *   master: ReturnType<typeof summarizeMasterBadger>,
 *   lockNftCount: number,
 *   lockNftBchTotal: bigint,
 *   rawUtxoCount: number,
 * } | { ok: false, error: string, code: string }>}
 */
/**
 * Fetch + decode the masterBadger state at the configured contract
 * address. Async convenience wrapper.
 *
 * T70-2: electrum-only. The previous version routed through
 * watchtower.cash, but the upstream's endpoint shape changed
 * (2026-09-20) and every HTTP call silently 301-redirected into a
 * 405 / timeout, surfacing as a generic `NO_MASTER` to the trader
 * loop. Per operator spec (2026-09-20 12:00 PDT), drop the
 * watchtower path entirely: query the contract address directly via
 * the same Electrum provider the wallet already uses
 * (`electrum.imaginary.cash:50004`), then filter the returned
 * UTXOs for the masterBadger by `category === badgerCoinCategory`
 * AND `capability === 'minting'` (CashTokens spec: fungible +
 * 0x02 = minting capability).
 *
 * The wallet provider (`cashscript.ElectrumNetworkProvider`) is
 * BCH-native, returns CashToken UTXOs in cashscript's native
 * shape, and doesn't suffer the 301-redirect drama that
 * watchtower.cash now does.
 *
 * @param {Object} [opts]
 * @param {Object} [opts.cfg]     staking config block (defaults to DEFAULT_STAKING_CONFIG)
 * @param {{getUtxos: Function}} [opts.provider]  cashscript ElectrumNetworkProvider
 *                                               (optional; required for the live path)
 * @returns {Promise<{
 *   ok: true,
 *   master: ReturnType<typeof summarizeMasterBadger>,
 *   lockNftCount: number,
 *   lockNftBchTotal: bigint,
 *   rawUtxoCount: number,
 * } | { ok: false, error: string, code: string }>}
 */
export async function fetchMasterState({ cfg, provider } = {}) {
  const resolved = resolveStakingConfig(cfg);
  // Defensive: if no provider wired, refuse to fake it. The
  // operator spec says we don't go anywhere near watchtower.
  if (!provider || typeof provider.getUtxos !== 'function') {
    return {
      ok: false,
      error: 'fetchMasterState: provider.getUtxos missing (electrum-only path)',
      code: 'NO_PROVIDER',
    };
  }
  let utxos;
  try {
    utxos = await provider.getUtxos(resolved.contract_address);
  } catch (e) {
    return {
      ok: false,
      error: `fetchMasterState: provider.getUtxos threw: ${e?.message ?? String(e)}`,
      code: 'ELECTRUM_ERROR',
    };
  }
  if (!Array.isArray(utxos)) {
    return {
      ok: false,
      error: `fetchMasterState: provider returned non-array (${typeof utxos})`,
      code: 'ELECTRUM_ERROR',
    };
  }
  const masterUtxo = findMasterBadger(utxos);
  const master = summarizeMasterBadger(masterUtxo, { network: resolved.network });
  return {
    ok: true,
    master,
    lockNftCount: countLockNfts(utxos),
    lockNftBchTotal: sumLockNftValue(utxos),
    rawUtxoCount: utxos.length,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Lock-position sizing for the trader-loop auto-wire (T58 subset 2)
// ─────────────────────────────────────────────────────────────────────

/**
 * Compute how much BCH to stake given the wallet balance + open
 * exposure + the user's inactive-fraction preference.
 *
 * Pure. Returns a typed envelope so the loop can decide without
 * needing to know about the BadgerCoin reward formula.
 *
 * @param {Object} p
 * @param {bigint|number} p.walletBalanceSats    total wallet BCH balance
 * @param {bigint|number} p.openExposureSats    sum of `bch_spent_sats` across open positions
 * @param {bigint|number} p.minReserveSats      from `risk.min_wallet_balance_bch`
 * @param {Object} p.cfg                         staking config block
 * @returns {{
 *   ok: true,
 *   stakeableSats: bigint,
 *   stakeAmountSats: bigint,
 *   stakeAmountBch: number,
 *   inactiveBalanceSats: bigint,
 *   skipReason?: undefined,
 * } | {
 *   ok: false,
 *   skipReason: 'insufficient_inactive' | 'below_floor' | 'config_disabled' | 'no_capacity',
 *   stakeableSats: bigint,
 *   inactiveBalanceSats: bigint,
 * }}
 */
export function computeStakeAllocation({ walletBalanceSats, openExposureSats, minReserveSats, cfg }) {
  if (!cfg) return { ok: false, skipReason: 'config_disabled', stakeableSats: 0n, inactiveBalanceSats: 0n };
  if (cfg.enabled !== true) {
    return { ok: false, skipReason: 'config_disabled', stakeableSats: 0n, inactiveBalanceSats: 0n };
  }
  const balance = bigOrZero(walletBalanceSats);
  const exposure = bigOrZero(openExposureSats);
  const reserve = bigOrZero(minReserveSats);
  const inactive = balance - exposure - reserve;
  if (inactive <= 0n) {
    return { ok: false, skipReason: 'insufficient_inactive', stakeableSats: 0n, inactiveBalanceSats: inactive };
  }
  const fraction = typeof cfg.inactive_fraction_to_stake === 'number'
    ? cfg.inactive_fraction_to_stake
    : DEFAULT_STAKING_CONFIG.inactive_fraction_to_stake;
  if (!(fraction > 0)) {
    return { ok: false, skipReason: 'config_disabled', stakeableSats: 0n, inactiveBalanceSats: inactive };
  }
  let stakeable = bigOrZero(Math.floor(Number(inactive) * fraction));
  const floor = bigOrZero(cfg.lock_min_sats ?? MIN_LOCK_AMOUNT_SATS);
  const ceiling = bigOrZero(cfg.lock_max_sats ?? 50_000_000);
  if (stakeable > ceiling) stakeable = ceiling;
  if (stakeable < floor) {
    return { ok: false, skipReason: 'below_floor', stakeableSats: stakeable, inactiveBalanceSats: inactive };
  }
  return {
    ok: true,
    stakeableSats: stakeable,
    stakeAmountSats: stakeable,
    stakeAmountBch: Number(stakeable) / 100_000_000,
    inactiveBalanceSats: inactive,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Internal exports for tests
// ─────────────────────────────────────────────────────────────────────

export const _internals = Object.freeze({
  bytesToHex,
  hexToBytes,
  readUint16BE,
  readBytes18Hex,
  readBytes20Hex,
  stripHexPrefix,
  isHexN,
  isHex20,
  isHex40,
});

export const _meta = Object.freeze({
  sourceRepo: 'LifestoneLabs/BadgerStake (Sayoshi-Nakamario CashScript contract)',
  sourceSkill: 'LifestoneLabs/AI_Skills/skills/badgersstake',
  contractCommit: 'v1.0.0 (mainnet)',
  moduleVersion: '0.1.0',
  moduleDate: '2026-09-18',
});
