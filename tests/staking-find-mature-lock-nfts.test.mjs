// tests/staking-find-mature-lock-nfts.test.mjs
//
// T58 subset 5 — Unit tests for the unlock-cron fallback helper.
//
// Exercises every public surface of `src/staking/find-mature-lock-nfts.mjs`:
//   - `isLockUtxoMature({tipHeight, lockBlockHeight, stakeBlocks, graceBlocks})`
//     → pure maturity predicate with full defensive guards.
//   - `findMatureLockNfts(utxos, {tipHeight, graceBlocks, maxPerRun})`
//     → scan + classify + cap + deterministic sort.
//   - `pickMatureLockNft(utxos, opts)` → convenience wrapper.
//   - `graceSecondsToBlocks(seconds)` → pure conversion.
//
// The fixtures re-use the `lockNftUtxo` shape from
// `tests/trader/loop.test.mjs` (tokenId/category/capability/
// commitment/lockBlockHeight). We deliberately don't import that
// file (it's a test-only helper); the fixtures are duplicated
// inline so this test file is self-contained.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isLockUtxoMature,
  findMatureLockNfts,
  pickMatureLockNft,
  graceSecondsToBlocks,
  DEFAULT_LOCK_BLOCK_HEIGHT,
  DEFAULT_MAX_UNLOCKS_PER_RUN,
} from '../src/staking/find-mature-lock-nfts.mjs';
import {
  MASTER_CAT,
  CAPABILITY_MUTABLE,
  COMMITMENT_LEN_HEX,
  countLockNfts,
} from '../src/staking/badger-stake.mjs';

// ─── Fixtures ────────────────────────────────────────────────────────────

const SAMPLE_USER_PKH_HEX = '11'.repeat(20); // 40 hex chars = 20 bytes

/**
 * Build a 40-byte lockNFT commitment matching BadgerStake.cash L23:
 * `userPkh[20] + reserved[18 zero] + stakeBlocks[2 BE]`.
 */
function buildLockCommitment({ userPkhHex = SAMPLE_USER_PKH_HEX, stakeBlocks = 1440 } = {}) {
  const userPkh = Buffer.from(userPkhHex, 'hex');
  const reserved = Buffer.alloc(18, 0);
  const stake = Buffer.from([(stakeBlocks >> 8) & 0xff, stakeBlocks & 0xff]);
  return Buffer.concat([userPkh, reserved, stake]).toString('hex');
}

/**
 * Build a lockNFT UTXO. Shape matches the libauth `listUtxos()`
 * output (txid, vout, satoshis: bigint, token: {tokenId, capability,
 * commitment, amount}) so the helper's tokenId/capability reads
 * work without modification.
 */
function lockNftUtxo({
  satoshis = 50000n,
  stakeBlocks = 1440,
  lockBlockHeight = 0,
  txidSuffix = '00',
  userPkhHex = SAMPLE_USER_PKH_HEX,
  tokenIdCapability = CAPABILITY_MUTABLE,
} = {}) {
  const commitment = buildLockCommitment({ userPkhHex, stakeBlocks });
  return {
    txid: ('aa'.repeat(31)) + txidSuffix,
    vout: 0,
    satoshis: BigInt(satoshis),
    token: {
      tokenId: MASTER_CAT + tokenIdCapability.toString(16).padStart(2, '0'),
      capability: '0x' + tokenIdCapability.toString(16).padStart(2, '0'),
      commitment,
      amount: 1n,
    },
    lockBlockHeight,
  };
}

/**
 * A non-NFT BCH UTXO so the helper's tokenId prefix check skips it.
 */
function bchOnlyUtxo(sats) {
  return {
    txid: 'bb'.repeat(32),
    vout: 0,
    satoshis: BigInt(sats),
  };
}

// ─── isLockUtxoMature ────────────────────────────────────────────────────

test('T58-5: isLockUtxoMature happy path (tip - lock >= stake + grace)', () => {
  const r = isLockUtxoMature({ tipHeight: 2000, lockBlockHeight: 100, stakeBlocks: 1440, graceBlocks: 1 });
  assert.equal(r.mature, true);
  assert.equal(r.blocksElapsed, 1900);
  assert.equal(r.blocksRequired, 1441);
  assert.equal(r.reason, undefined);
});

test('T58-5: isLockUtxoMature at the boundary (elapsed == required)', () => {
  const r = isLockUtxoMature({ tipHeight: 1441, lockBlockHeight: 0, stakeBlocks: 1440, graceBlocks: 1 });
  assert.equal(r.mature, true);
  assert.equal(r.blocksElapsed, 1441);
  assert.equal(r.blocksRequired, 1441);
});

test('T58-5: isLockUtxoMature refuses when timelock not yet elapsed', () => {
  const r = isLockUtxoMature({ tipHeight: 1000, lockBlockHeight: 0, stakeBlocks: 1440, graceBlocks: 1 });
  assert.equal(r.mature, false);
  assert.equal(r.reason, 'timelock_not_elapsed');
  assert.equal(r.blocksElapsed, 1000);
  assert.equal(r.blocksRequired, 1441);
});

test('T58-5: isLockUtxoMature defaults lockBlockHeight to 0 (matches trader loop)', () => {
  const r = isLockUtxoMature({ tipHeight: 2000, stakeBlocks: 1440, graceBlocks: 1 });
  assert.equal(r.mature, true);
  assert.equal(r.blocksElapsed, 2000);
});

test('T58-5: isLockUtxoMature rejects invalid tipHeight', () => {
  assert.equal(isLockUtxoMature({ tipHeight: -1, stakeBlocks: 1440 }).mature, false);
  assert.equal(isLockUtxoMature({ tipHeight: NaN, stakeBlocks: 1440 }).mature, false);
  assert.equal(isLockUtxoMature({ tipHeight: 'bad', stakeBlocks: 1440 }).mature, false);
});

test('T58-5: isLockUtxoMature rejects non-positive stakeBlocks', () => {
  assert.equal(isLockUtxoMature({ tipHeight: 2000, stakeBlocks: 0 }).mature, false);
  assert.equal(isLockUtxoMature({ tipHeight: 2000, stakeBlocks: -10 }).mature, false);
});

test('T58-5: isLockUtxoMature refuses negative blocksElapsed (tip < lockBlockHeight)', () => {
  // Defensive: shouldn't happen on chain (tip can't go below lockBlockHeight
  // because lockBlockHeight was a past block), but be safe.
  const r = isLockUtxoMature({ tipHeight: 50, lockBlockHeight: 100, stakeBlocks: 1440, graceBlocks: 1 });
  // blocksElapsed is clamped to 0 by Math.max(0, ...), so it falls
  // through to timelock_not_elapsed.
  assert.equal(r.mature, false);
  assert.equal(r.reason, 'timelock_not_elapsed');
  assert.equal(r.blocksElapsed, 0);
});

test('T58-5: isLockUtxoMature coerces negative graceBlocks to 0', () => {
  const r = isLockUtxoMature({ tipHeight: 1440, lockBlockHeight: 0, stakeBlocks: 1440, graceBlocks: -5 });
  assert.equal(r.mature, true);
  assert.equal(r.blocksRequired, 1440);
});

// ─── graceSecondsToBlocks ────────────────────────────────────────────────

test('T58-5: graceSecondsToBlocks defaults + boundary cases', () => {
  assert.equal(graceSecondsToBlocks(60), 1);    // 60s / 600s = 0.1 → ceil = 1
  assert.equal(graceSecondsToBlocks(600), 1);   // exactly 1 block
  assert.equal(graceSecondsToBlocks(601), 2);   // ceil(601/600) = 2
  assert.equal(graceSecondsToBlocks(0), 0);     // explicit zero
  assert.equal(graceSecondsToBlocks(-1), 1);    // defensive fallback
  assert.equal(graceSecondsToBlocks(NaN), 1);   // defensive fallback
  assert.equal(graceSecondsToBlocks(undefined), 1);
});

// ─── findMatureLockNfts ──────────────────────────────────────────────────

test('T58-5: findMatureLockNfts with empty utxos returns empty lists', () => {
  const r = findMatureLockNfts([], { tipHeight: 100_000 });
  assert.equal(r.mature.length, 0);
  assert.equal(r.premature.length, 0);
  assert.equal(r.undecodable.length, 0);
  assert.equal(r.totalLockNftCount, 0);
  assert.equal(r.skippedCap, 0);
});

test('T58-5: findMatureLockNfts with no lockNFTs (only BCH UTXOs) returns nothing', () => {
  const utxos = [bchOnlyUtxo(500000n), bchOnlyUtxo(1000000n)];
  const r = findMatureLockNfts(utxos, { tipHeight: 100_000 });
  assert.equal(r.mature.length, 0);
  assert.equal(r.premature.length, 0);
  assert.equal(r.undecodable.length, 0);
  assert.equal(r.totalLockNftCount, 0);
});

test('T58-5: findMatureLockNfts classifies mature vs premature', () => {
  const utxos = [
    bchOnlyUtxo(1_000_000n),
    lockNftUtxo({ lockBlockHeight: 100, stakeBlocks: 1440, txidSuffix: '01' }),  // mature (tip=10000, elapsed=9900)
    lockNftUtxo({ lockBlockHeight: 100_000, stakeBlocks: 1440, txidSuffix: '02' }),  // premature
  ];
  const r = findMatureLockNfts(utxos, { tipHeight: 10000, graceBlocks: 1 });
  assert.equal(r.totalLockNftCount, 2);
  assert.equal(r.mature.length, 1);
  assert.equal(r.premature.length, 1);
  assert.equal(r.mature[0].txid.endsWith('01'), true);
  assert.equal(r.mature[0]._maturity.blocksElapsed, 9900);
  assert.equal(r.premature[0].txid.endsWith('02'), true);
  assert.equal(r.premature[0]._maturity.reason, 'timelock_not_elapsed');
});

test('T58-5: findMatureLockNfts caps mature list to maxPerRun (default 1)', () => {
  const utxos = [
    lockNftUtxo({ lockBlockHeight: 100, stakeBlocks: 1440, txidSuffix: '01' }),
    lockNftUtxo({ lockBlockHeight: 100, stakeBlocks: 1440, txidSuffix: '02' }),
    lockNftUtxo({ lockBlockHeight: 100, stakeBlocks: 1440, txidSuffix: '03' }),
  ];
  const r = findMatureLockNfts(utxos, { tipHeight: 10_000, graceBlocks: 1 });
  assert.equal(r.mature.length, 1);
  assert.equal(r.skippedCap, 2);
});

test('T58-5: findMatureLockNfts respects explicit maxPerRun=2', () => {
  const utxos = [
    lockNftUtxo({ lockBlockHeight: 100, stakeBlocks: 1440, txidSuffix: '01' }),
    lockNftUtxo({ lockBlockHeight: 100, stakeBlocks: 1440, txidSuffix: '02' }),
    lockNftUtxo({ lockBlockHeight: 100, stakeBlocks: 1440, txidSuffix: '03' }),
  ];
  const r = findMatureLockNfts(utxos, { tipHeight: 10_000, graceBlocks: 1, maxPerRun: 2 });
  assert.equal(r.mature.length, 2);
  assert.equal(r.skippedCap, 1);
});

test('T58-5: findMatureLockNfts sorts mature by lockBlockHeight ASC (oldest first)', () => {
  const utxos = [
    lockNftUtxo({ lockBlockHeight: 1000, stakeBlocks: 1440, txidSuffix: '01' }),
    lockNftUtxo({ lockBlockHeight: 100, stakeBlocks: 1440, txidSuffix: '02' }),
    lockNftUtxo({ lockBlockHeight: 500, stakeBlocks: 1440, txidSuffix: '03' }),
  ];
  const r = findMatureLockNfts(utxos, { tipHeight: 10_000, graceBlocks: 1, maxPerRun: 10 });
  assert.equal(r.mature.length, 3);
  // Tied at lockBlockHeight=1000 in txidSuffix order (01 first); then
  // 500, then 100. Sort by lockBlockHeight ASC = oldest first.
  assert.equal(r.mature[0].txid.endsWith('02'), true);  // lockBlockHeight=100
  assert.equal(r.mature[1].txid.endsWith('03'), true);  // lockBlockHeight=500
  assert.equal(r.mature[2].txid.endsWith('01'), true);  // lockBlockHeight=1000
});

test('T58-5: findMatureLockNfts handles missing lockBlockHeight (defaults to 0)', () => {
  // Caller passes UTXOs without lockBlockHeight — same seam as the
  // trader loop default.
  const utxo = lockNftUtxo({ stakeBlocks: 1440, txidSuffix: '01' });
  delete utxo.lockBlockHeight;
  const r = findMatureLockNfts([utxo], { tipHeight: 2000, graceBlocks: 1 });
  assert.equal(r.mature.length, 1);
  assert.equal(r.mature[0]._maturity.lockBlockHeight, DEFAULT_LOCK_BLOCK_HEIGHT);
  assert.equal(r.mature[0]._maturity.blocksElapsed, 2000);
});

test('T58-5: findMatureLockNfts treats malformed commitment as undecodable', () => {
  const utxo = lockNftUtxo({ stakeBlocks: 1440, txidSuffix: '01' });
  utxo.token.commitment = 'zzzz'; // wrong length + non-hex
  const r = findMatureLockNfts([utxo], { tipHeight: 10_000 });
  assert.equal(r.mature.length, 0);
  assert.equal(r.undecodable.length, 1);
  assert.equal(r.undecodable[0].utxo.txid, utxo.txid);
  assert.match(r.undecodable[0].error, /bytes != 40/);
  assert.equal(r.reasonCounts.decode_failed, 1);
});

test('T58-5: findMatureLockNfts skips non-mutable UTXOs', () => {
  // capByte != 0x01 (mutable) → skip. Minting = 0x02; None = 0x00.
  const utxos = [
    lockNftUtxo({ tokenIdCapability: 0x02, stakeBlocks: 1440, txidSuffix: '01' }),  // minting master
    lockNftUtxo({ tokenIdCapability: 0x00, stakeBlocks: 1440, txidSuffix: '02' }),  // FT
  ];
  const r = findMatureLockNfts(utxos, { tipHeight: 10_000 });
  assert.equal(r.mature.length, 0);
  assert.equal(r.premature.length, 0);
  assert.equal(r.totalLockNftCount, 0); // countLockNfts only counts mutable
});

test('T58-5: findMatureLockNfts skips UTXOs with no token field', () => {
  const utxos = [
    bchOnlyUtxo(1_000_000n),
    { txid: 'cc'.repeat(32), vout: 0, satoshis: 1000n, token: null }, // no token
  ];
  const r = findMatureLockNfts(utxos, { tipHeight: 10_000 });
  assert.equal(r.mature.length, 0);
  assert.equal(r.premature.length, 0);
  assert.equal(r.undecodable.length, 0);
});

test('T58-5: findMatureLockNfts with invalid tipHeight returns empty', () => {
  const utxos = [lockNftUtxo({ stakeBlocks: 1440 })];
  const r = findMatureLockNfts(utxos, { tipHeight: -1 });
  assert.equal(r.mature.length, 0);
  assert.equal(r.premature.length, 0);
  assert.equal(r.reasonCounts.invalid_tip_height, 1);
});

test('T58-5: findMatureLockNfts coerces non-numeric maxPerRun to default', () => {
  const utxos = [
    lockNftUtxo({ lockBlockHeight: 100, stakeBlocks: 1440, txidSuffix: '01' }),
    lockNftUtxo({ lockBlockHeight: 100, stakeBlocks: 1440, txidSuffix: '02' }),
  ];
  const r = findMatureLockNfts(utxos, { tipHeight: 10_000, maxPerRun: 'wat' });
  assert.equal(r.mature.length, 1);
  assert.equal(r.skippedCap, 1);
});

test('T58-5: findMatureLockNfts reason_counts aggregates premature reasons', () => {
  // stakeBlocks=0 → invalid_stake_blocks; tip=-1 handled separately.
  const utxos = [
    lockNftUtxo({ stakeBlocks: 0, txidSuffix: '01' }),  // malformed commitment decoded will throw → undecodable
  ];
  // Actually stakeBlocks=0 still encodes to a valid 40-byte commitment,
  // and decodeLockNftCommitment accepts stakeBlocks:0. The maturity
  // check then refuses with invalid_stake_blocks.
  const r = findMatureLockNfts(utxos, { tipHeight: 10_000 });
  assert.equal(r.premature.length, 1);
  assert.equal(r.reasonCounts.invalid_stake_blocks, 1);
});

test('T58-5: findMatureLockNfts reason_counts tracks multiple timelock_not_elapsed locks', () => {
  const utxos = [
    lockNftUtxo({ lockBlockHeight: 100_000, stakeBlocks: 1440, txidSuffix: '01' }),
    lockNftUtxo({ lockBlockHeight: 100_000, stakeBlocks: 1440, txidSuffix: '02' }),
  ];
  const r = findMatureLockNfts(utxos, { tipHeight: 1000 });
  assert.equal(r.premature.length, 2);
  assert.equal(r.reasonCounts.timelock_not_elapsed, 2);
});

// ─── pickMatureLockNft ───────────────────────────────────────────────────

test('T58-5: pickMatureLockNft returns the first mature lock', () => {
  const utxos = [
    lockNftUtxo({ lockBlockHeight: 100, stakeBlocks: 1440, txidSuffix: '01' }),
    lockNftUtxo({ lockBlockHeight: 100, stakeBlocks: 1440, txidSuffix: '02' }),
  ];
  const picked = pickMatureLockNft(utxos, { tipHeight: 10_000, graceBlocks: 1 });
  assert.ok(picked);
  assert.equal(picked.txid.endsWith('01'), true);
  assert.equal(picked._maturity.blocksElapsed, 9900);
});

test('T58-5: pickMatureLockNft returns null when no mature lock exists', () => {
  const utxos = [
    lockNftUtxo({ lockBlockHeight: 100_000, stakeBlocks: 1440 }),
  ];
  const picked = pickMatureLockNft(utxos, { tipHeight: 1000 });
  assert.equal(picked, null);
});

test('T58-5: pickMatureLockNft returns null on empty utxos', () => {
  assert.equal(pickMatureLockNft([], { tipHeight: 100_000 }), null);
});

// ─── Module shape ────────────────────────────────────────────────────────

test('T58-5: helper exports DEFAULT_LOCK_BLOCK_HEIGHT=0 (matches trader loop)', () => {
  assert.equal(DEFAULT_LOCK_BLOCK_HEIGHT, 0);
});

test('T58-5: helper exports DEFAULT_MAX_UNLOCKS_PER_RUN=1 (one-at-a-time drain)', () => {
  assert.equal(DEFAULT_MAX_UNLOCKS_PER_RUN, 1);
});

test('T58-5: countLockNfts integration: findMatureLockNfts respects countLockNfts semantics', () => {
  // Sanity: totalLockNftCount uses countLockNfts which only counts
  // mutable capability. Minting master + FT should not bump it.
  const utxos = [
    lockNftUtxo({ tokenIdCapability: 0x02, txidSuffix: '01' }),  // minting master (not counted)
    lockNftUtxo({ tokenIdCapability: 0x01, txidSuffix: '02' }),  // mutable lockNFT (counted)
    lockNftUtxo({ tokenIdCapability: 0x01, txidSuffix: '03' }),  // mutable lockNFT (counted)
  ];
  assert.equal(countLockNfts(utxos), 2);
  const r = findMatureLockNfts(utxos, { tipHeight: 10_000 });
  assert.equal(r.totalLockNftCount, 2);
});
