#!/usr/bin/env node
// tests/staking-badger-stake.test.mjs
//
// T58 subset 1 — BadgerCoin Staking foundation unit tests.
//
// Covers:
//   - src/staking/badger-stake.mjs (constants, decoders, validators,
//     simulation helpers, async master-state fetcher with mocked fetch).
//   - scripts/stake-inspect.mjs (arg parser, flag normalizer, main()
//     dispatched over every operation with both happy + error paths).
//
// The module is read-only — no signing, no broadcasting, no WIF
// reads. Tests exercise every pure helper + the async fetcher via
// mocked `fetchImpl` to avoid touching the network.
//
// Test layout mirrors `tests/strategy-adaptive-weights.test.mjs`:
// pure-function tests first, then end-to-end main() tests with
// fixture injection.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  // Constants
  MASTER_CAT,
  MIN_LOCK_AMOUNT_SATS,
  MAX_STAKE_BLOCKS,
  REWARD_DIVISOR,
  MIN_REWARD,
  UNLOCK_DUST_FEE_SATS,
  WITHDRAW_DUST_FEE_SATS,
  COMMITMENT_LEN_BYTES,
  COMMITMENT_LEN_HEX,
  PKH_LEN_BYTES,
  PKH_LEN_HEX,
  CAPABILITY_MINTING,
  CAPABILITY_MUTABLE,
  PEER_BLOCKS_PER_DAY,
  CONTRACT_ADDRESS,
  WATCHTOWER_BASE,
  DEFAULT_STAKING_CONFIG,
  // Errors
  StakingConfigError,
  StakingParamError,
  // Hex helpers
  stripHexPrefix,
  isHexN,
  isHex40,
  isHex20,
  hexToBytes,
  bytesToHex,
  readUint16BE,
  readBytes18Hex,
  readBytes20Hex,
  bigOrZero,
  // Decoders
  decodeMasterCommitment,
  decodeLockNftCommitment,
  decodeCommitmentAuto,
  // Lock params
  computeStakeReward,
  validateLockParams,
  resolveStakingConfig,
  buildLockNftCommitment,
  // UTXO helpers
  getTokenId,
  getCapability,
  getCommitment,
  getTokenAmount,
  getSatoshis,
  findMasterBadger,
  countLockNfts,
  sumLockNftValue,
  summarizeMasterBadger,
  // Simulation
  simulateLock,
  simulateUnlock,
  // Async
  fetchCashTokenUtxos,
  fetchMasterState,
  // Sizing
  computeStakeAllocation,
} from '../src/staking/badger-stake.mjs';

import {
  parseStakeInspectArgs,
  normalizeStakeInspectFlags,
  formatStakeInspectHelp,
  runDecodeCommitment,
  runSimulateLock,
  runSimulateUnlock,
  runSimulateAllocate,
  runInspectMaster,
  main as stakeInspectMain,
} from '../scripts/stake-inspect.mjs';

// ─── Test fixtures ──────────────────────────────────────────────────────

const SAMPLE_MASTER_COMMITMENT_HEX = (() => {
  // fee = 1000 (0x03E8) BE + 18 zero bytes + 20 admin pkh bytes
  const fee = Buffer.from([0x03, 0xe8]);
  const reserved = Buffer.alloc(18, 0);
  const adminPkh = Buffer.alloc(20, 0xab);
  return Buffer.concat([fee, reserved, adminPkh]).toString('hex');
})();

const SAMPLE_LOCK_COMMITMENT_HEX = (() => {
  // userPkh = 20 bytes + 18 zero reserved + stakeBlocks = 1440 BE (0x05A0)
  const userPkh = Buffer.alloc(20, 0xcd);
  const reserved = Buffer.alloc(18, 0);
  const stake = Buffer.from([0x05, 0xa0]);
  return Buffer.concat([userPkh, reserved, stake]).toString('hex');
})();

const SAMPLE_USER_PKH_HEX = 'cd'.repeat(20);

const makeMasterUtxo = (overrides = {}) => ({
  outpoint: 'aa'.repeat(32) + ':0',
  tx_hash: 'aa'.repeat(32),
  vout: 0,
  value: 100_000n,
  tokenCategory: MASTER_CAT + '02', // minting
  capability: '0x02',
  tokenAmount: 10_000n,
  nftCommitment: SAMPLE_MASTER_COMMITMENT_HEX,
  lockingBytecode: 'a914' + 'ab'.repeat(20) + '87', // P2SH20 from admin pkh
  ...overrides,
});

const makeUserUtxo = (overrides = {}) => ({
  outpoint: 'bb'.repeat(32) + ':1',
  tx_hash: 'bb'.repeat(32),
  vout: 1,
  value: 600_000n,
  tokenCategory: '',
  capability: null,
  tokenAmount: 0n,
  nftCommitment: '',
  ...overrides,
});

// ─── Constants ──────────────────────────────────────────────────────────

test('staking-badger-stake: constants match the contract source', () => {
  assert.equal(MASTER_CAT, 'd7ff0a63d5c1cbe1ced509314fe3caca563a73095be37734744c40dbce6e2f24');
  assert.equal(MIN_LOCK_AMOUNT_SATS, 5000n);
  assert.equal(MAX_STAKE_BLOCKS, 65536);
  assert.equal(REWARD_DIVISOR, 100_000_000n);
  assert.equal(MIN_REWARD, 1n);
  assert.equal(UNLOCK_DUST_FEE_SATS, 3000n);
  assert.equal(WITHDRAW_DUST_FEE_SATS, 2000n);
  assert.equal(COMMITMENT_LEN_BYTES, 40);
  assert.equal(COMMITMENT_LEN_HEX, 80);
  assert.equal(PKH_LEN_BYTES, 20);
  assert.equal(PKH_LEN_HEX, 40);
  assert.equal(CAPABILITY_MINTING, 0x02);
  assert.equal(CAPABILITY_MUTABLE, 0x01);
  assert.equal(PEER_BLOCKS_PER_DAY, 144);
  assert.match(CONTRACT_ADDRESS.mainnet, /^bitcoincash:p/);
  assert.match(CONTRACT_ADDRESS.chipnet, /^bchtest:p/);
  assert.match(WATCHTOWER_BASE.mainnet, /^https:\/\/watchtower\.cash\//);
  assert.match(WATCHTOWER_BASE.chipnet, /^https:\/\/chipnet\.watchtower\.cash\//);
});

test('staking-badger-stake: DEFAULT_STAKING_CONFIG is conservative', () => {
  assert.equal(DEFAULT_STAKING_CONFIG.enabled, false);
  assert.equal(DEFAULT_STAKING_CONFIG.network, 'mainnet');
  assert.equal(DEFAULT_STAKING_CONFIG.lock_amount_sats, 500_000);
  assert.equal(DEFAULT_STAKING_CONFIG.lock_min_sats, 5_000);
  assert.equal(DEFAULT_STAKING_CONFIG.stake_blocks, 1440);
  assert.equal(DEFAULT_STAKING_CONFIG.max_active_stakes, 1);
  assert.equal(DEFAULT_STAKING_CONFIG.simulation_only, true);
  // Default config is frozen.
  assert.throws(() => { DEFAULT_STAKING_CONFIG.enabled = true; }, TypeError);
});

// ─── Hex helpers ────────────────────────────────────────────────────────

test('staking-badger-stake: stripHexPrefix handles 0x and \\x and bare', () => {
  assert.equal(stripHexPrefix('0xabcd'), 'abcd');
  assert.equal(stripHexPrefix('\\xabcd'), 'abcd');
  assert.equal(stripHexPrefix('abcd'), 'abcd');
  assert.equal(stripHexPrefix(''), '');
  assert.equal(stripHexPrefix(null), '');
  assert.equal(stripHexPrefix(42), '');
});

test('staking-badger-stake: isHexN / isHex40 / isHex20', () => {
  assert.equal(isHexN('abcd', 4), true);
  assert.equal(isHexN('ABCD', 4), true);
  // 0x prefix is stripped before length check (so '0xabcd' is treated as 'abcd' = 4 chars).
  assert.equal(isHexN('0xabcd', 4), true);
  assert.equal(isHexN('\\xabcd', 4), true);
  assert.equal(isHexN('abc', 4), false);
  assert.equal(isHexN('gghh', 4), false);
  assert.equal(isHex40('a'.repeat(40)), false); // wrong length (40 chars ≠ 80 chars)
  assert.equal(isHex40('a'.repeat(80)), true);
  assert.equal(isHex20('a'.repeat(40)), true);
  assert.equal(isHex20('a'.repeat(80)), false);
});

test('staking-badger-stake: hexToBytes + bytesToHex round-trip + error handling', () => {
  const hex = 'deadbeef';
  const bytes = hexToBytes(hex);
  assert.deepEqual([...bytes], [0xde, 0xad, 0xbe, 0xef]);
  assert.equal(bytesToHex(bytes), 'deadbeef');
  // Odd length → throws.
  assert.throws(() => hexToBytes('abc'), StakingParamError);
  // Non-hex → throws.
  assert.throws(() => hexToBytes('zz'), StakingParamError);
  // Hex with prefix → strips it.
  assert.deepEqual([...hexToBytes('0xdeadbeef')], [0xde, 0xad, 0xbe, 0xef]);
});

test('staking-badger-stake: readUint16BE + readBytes18Hex + readBytes20Hex', () => {
  const bytes = new Uint8Array([0x12, 0x34, ...new Array(18).fill(0), ...new Array(20).fill(0xab)]);
  assert.equal(readUint16BE(bytes, 0), 0x1234);
  assert.equal(readBytes18Hex(bytes, 2), '00'.repeat(18));
  assert.equal(readBytes20Hex(bytes, 20), 'ab'.repeat(20));
  // Out-of-range → throws.
  assert.throws(() => readUint16BE(bytes, 40), StakingParamError);
  assert.throws(() => readBytes20Hex(bytes, 30), StakingParamError);
});

test('staking-badger-stake: bigOrZero handles null/undefined/string/bigint/number', () => {
  assert.equal(bigOrZero(null), 0n);
  assert.equal(bigOrZero(undefined), 0n);
  assert.equal(bigOrZero(''), 0n);
  assert.equal(bigOrZero('123'), 123n);
  assert.equal(bigOrZero('-456'), -456n);
  assert.equal(bigOrZero(789), 789n);
  assert.equal(bigOrZero(7.9), 7n); // trunc
  assert.equal(bigOrZero(0xffn), 255n);
  assert.throws(() => bigOrZero('abc'), StakingParamError);
  assert.throws(() => bigOrZero(NaN), StakingParamError);
  assert.throws(() => bigOrZero(Infinity), StakingParamError);
  assert.throws(() => bigOrZero({}), StakingParamError);
});

// ─── Commitment decoders ────────────────────────────────────────────────

test('staking-badger-stake: decodeMasterCommitment decodes fee + reserved + adminPkh', () => {
  const r = decodeMasterCommitment(SAMPLE_MASTER_COMMITMENT_HEX);
  assert.equal(r.kind, 'master');
  assert.equal(r.stakeFee, 1000);
  assert.equal(r.reserved, '00'.repeat(18));
  assert.equal(r.adminAddressHex, 'ab'.repeat(20));
  assert.equal(r.commitmentHex, SAMPLE_MASTER_COMMITMENT_HEX);
});

test('staking-badger-stake: decodeMasterCommitment throws on wrong length', () => {
  assert.throws(() => decodeMasterCommitment('aa'.repeat(20)), StakingParamError);
  assert.throws(() => decodeMasterCommitment('aa'.repeat(41)), StakingParamError);
  assert.throws(() => decodeMasterCommitment('zz'.repeat(40)), StakingParamError);
});

test('staking-badger-stake: decodeLockNftCommitment decodes userPkh + reserved + stakeBlocks', () => {
  const r = decodeLockNftCommitment(SAMPLE_LOCK_COMMITMENT_HEX);
  assert.equal(r.kind, 'lock');
  assert.equal(r.userPkhHex, 'cd'.repeat(20));
  assert.equal(r.reservedIsZero, true);
  assert.equal(r.stakeBlocks, 1440);
  assert.equal(r.commitmentHex, SAMPLE_LOCK_COMMITMENT_HEX);
});

test('staking-badger-stake: decodeLockNftCommitment rejects non-zero reserved + wrong length', () => {
  // Build a 40-byte commitment with 18 bytes of reserved space where reserved[0]=1.
  const nonZeroReserved = (() => {
    const u = Buffer.alloc(20, 0xcd);
    const reserved = Buffer.alloc(18, 0); // 18 zero bytes (the contract reserves 18 bytes)
    reserved[0] = 1;                      // make reserved non-zero
    const stake = Buffer.from([0x05, 0xa0]);
    return Buffer.concat([u, reserved, stake]).toString('hex');
  })();
  const r = decodeLockNftCommitment(nonZeroReserved);
  assert.equal(r.reservedIsZero, false);
  // Wrong-length commitment → throws.
  assert.throws(() => decodeLockNftCommitment('aa'.repeat(20)), StakingParamError);
});

test('staking-badger-stake: decodeCommitmentAuto picks master when reserved is non-zero OR stakeBlocks is zero', () => {
  // The master commitment has zero stakeBlocks → auto picks master.
  const r1 = decodeCommitmentAuto(SAMPLE_MASTER_COMMITMENT_HEX);
  assert.equal(r1.kind, 'master');
  // The lock commitment has stakeBlocks=1440 → auto picks lock.
  const r2 = decodeCommitmentAuto(SAMPLE_LOCK_COMMITMENT_HEX);
  assert.equal(r2.kind, 'lock');
  // Wrong length → throws.
  assert.throws(() => decodeCommitmentAuto('aa'.repeat(20)), StakingParamError);
  // Bad hex → throws.
  assert.throws(() => decodeCommitmentAuto('zz'.repeat(40)), StakingParamError);
  // Accepts Uint8Array directly.
  const r3 = decodeCommitmentAuto(hexToBytes(SAMPLE_LOCK_COMMITMENT_HEX));
  assert.equal(r3.kind, 'lock');
});

// ─── Reward formula + lock validation ───────────────────────────────────

test('staking-badger-stake: computeStakeReward matches the canonical formula', () => {
  // 1 BCH × 1 day (144 blocks) = 100_000_000 * 144 / 1e8 = 144
  assert.equal(computeStakeReward(100_000_000n, 144), 144n);
  // 0.005 BCH × 1440 blocks = 500_000 * 1440 / 1e8 = 7.2 → 7 BadgerCoin
  assert.equal(computeStakeReward(500_000n, 1440), 7n);
  // 0.001 BCH × 65536 blocks = 100_000 * 65536 / 1e8 = 65 BadgerCoin
  assert.equal(computeStakeReward(100_000n, 65536), 65n);
  // Below min reward: 5000 sats × 1 block = 0 → throws (below MIN_REWARD).
  assert.throws(() => computeStakeReward(5_000n, 1), StakingParamError);
  // Below min amount → throws.
  assert.throws(() => computeStakeReward(4_999n, 1440), StakingParamError);
  // Above max blocks → throws.
  assert.throws(() => computeStakeReward(100_000n, 65537), StakingParamError);
  // Bad stakeBlocks type → throws.
  assert.throws(() => computeStakeReward(100_000n, 1.5), StakingParamError);
  assert.throws(() => computeStakeReward(100_000n, -1), StakingParamError);
  assert.throws(() => computeStakeReward(100_000n, 'abc'), StakingParamError);
});

test('staking-badger-stake: validateLockParams honors cfg floor + ceiling', () => {
  const cfg = { lock_min_sats: 10_000, lock_max_sats: 1_000_000 };
  // In-range → ok.
  const r1 = validateLockParams({ amountSats: 100_000n, stakeBlocks: 1440, cfg });
  assert.equal(r1.ok, true);
  assert.equal(r1.amountBch, 0.001);
  assert.equal(r1.stakeDays, 10);
  assert.equal(r1.reward, 1n); // 100_000 * 1440 / 1e8 = 1.44 → 1
  // Below cfg floor → bad.
  const r2 = validateLockParams({ amountSats: 9_999n, stakeBlocks: 1440, cfg });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'BELOW_MIN');
  // Above cfg ceiling → bad.
  const r3 = validateLockParams({ amountSats: 2_000_000n, stakeBlocks: 1440, cfg });
  assert.equal(r3.ok, false);
  assert.equal(r3.code, 'ABOVE_MAX');
  // Bad blocks → bad.
  const r4 = validateLockParams({ amountSats: 100_000n, stakeBlocks: 70_000, cfg });
  assert.equal(r4.ok, false);
  assert.equal(r4.code, 'ABOVE_MAX_BLOCKS');
  // Reward below MIN_REWARD (1) → bad. Amount clears the cfg.floor (10_000) but reward = 10_000 * 1 / 1e8 = 0.
  const r5 = validateLockParams({ amountSats: 10_000n, stakeBlocks: 1, cfg });
  assert.equal(r5.ok, false);
  assert.equal(r5.code, 'BAD_REWARD');
  // Bad amount string → bad.
  const r6 = validateLockParams({ amountSats: 'not-a-number', stakeBlocks: 1440, cfg });
  assert.equal(r6.ok, false);
  assert.equal(r6.code, 'BAD_AMOUNT');
  // Non-integer blocks → bad.
  const r7 = validateLockParams({ amountSats: 100_000n, stakeBlocks: 1.5, cfg });
  assert.equal(r7.ok, false);
  assert.equal(r7.code, 'BAD_BLOCKS');
  // Null params → bad.
  const r8 = validateLockParams(null);
  assert.equal(r8.ok, false);
  assert.equal(r8.code, 'BAD_INPUT');
});

test('staking-badger-stake: resolveStakingConfig deep-merges + resolves network-specific addresses', () => {
  const r1 = resolveStakingConfig();
  assert.equal(r1.enabled, false);
  assert.equal(r1.network, 'mainnet');
  assert.equal(r1.contract_address, CONTRACT_ADDRESS.mainnet);
  assert.equal(r1.watchtower_base, WATCHTOWER_BASE.mainnet);
  // Override to chipnet.
  const r2 = resolveStakingConfig({ network: 'chipnet' });
  assert.equal(r2.contract_address, CONTRACT_ADDRESS.chipnet);
  assert.equal(r2.watchtower_base, WATCHTOWER_BASE.chipnet);
  // Override to chipnet BUT with explicit contract_address → explicit wins.
  const r3 = resolveStakingConfig({ network: 'chipnet', contract_address: 'bitcoincash:custom' });
  assert.equal(r3.contract_address, 'bitcoincash:custom');
  // Bad input → throws.
  assert.throws(() => resolveStakingConfig(null), StakingConfigError);
  assert.throws(() => resolveStakingConfig([]), StakingConfigError);
  assert.throws(() => resolveStakingConfig('hi'), StakingConfigError);
});

// ─── buildLockNftCommitment ─────────────────────────────────────────────

test('staking-badger-stake: buildLockNftCommitment produces the canonical 40-byte layout', () => {
  const pkh = hexToBytes(SAMPLE_USER_PKH_HEX);
  const c = buildLockNftCommitment(pkh, 1440);
  assert.equal(c.length, COMMITMENT_LEN_BYTES);
  // bytes 0-19 == userPkh
  assert.equal(bytesToHex(c.slice(0, 20)), SAMPLE_USER_PKH_HEX);
  // bytes 20-37 == 18 zero bytes
  assert.equal(bytesToHex(c.slice(20, 38)), '00'.repeat(18));
  // bytes 38-39 == BE uint16 stakeBlocks
  assert.equal(c[38], 0x05);
  assert.equal(c[39], 0xa0);
  // Round-trips through decodeLockNftCommitment.
  const d = decodeLockNftCommitment(c);
  assert.equal(d.userPkhHex, SAMPLE_USER_PKH_HEX);
  assert.equal(d.stakeBlocks, 1440);
  // Bad pkh → throws.
  assert.throws(() => buildLockNftCommitment('aa'.repeat(19), 1440), StakingParamError);
  // Bad blocks → throws.
  assert.throws(() => buildLockNftCommitment(pkh, 70_000), StakingParamError);
  assert.throws(() => buildLockNftCommitment(pkh, -1), StakingParamError);
});

// ─── UTXO helpers ───────────────────────────────────────────────────────

test('staking-badger-stake: UTXO helpers handle new + legacy shapes + missing fields', () => {
  const newer = { token: { tokenId: MASTER_CAT + '02', capability: '0x02', commitment: SAMPLE_MASTER_COMMITMENT_HEX, amount: 1000 } };
  const legacy = { tokenCategory: MASTER_CAT + '02', capability: '0x02', nftCommitment: SAMPLE_MASTER_COMMITMENT_HEX, tokenAmount: 1000 };
  for (const u of [newer, legacy]) {
    assert.equal(getTokenId(u), (MASTER_CAT + '02').toLowerCase());
    assert.equal(getCapability(u), 0x02);
    assert.equal(getCommitment(u), SAMPLE_MASTER_COMMITMENT_HEX);
    assert.equal(getTokenAmount(u), 1000n);
  }
  // Value (sats) from newer (no `value` field) + legacy.
  assert.equal(getSatoshis({ value: 1234 }), 1234n);
  assert.equal(getSatoshis({ satoshis: 5678 }), 5678n);
  // Missing UTXO → empty / 0.
  assert.equal(getTokenId(null), '');
  assert.equal(getCapability(null), null);
  assert.equal(getCommitment(null), '');
  assert.equal(getTokenAmount(null), 0n);
  assert.equal(getSatoshis(null), 0n);
});

test('staking-badger-stake: findMasterBadger picks minting + correct category + correct commitment', () => {
  const utxos = [
    makeUserUtxo({ tokenCategory: '' }),
    { ...makeUserUtxo({ tokenCategory: MASTER_CAT + '01' }), tokenAmount: 100n, nftCommitment: SAMPLE_LOCK_COMMITMENT_HEX, capability: '0x01' },
    makeMasterUtxo(),
  ];
  const m = findMasterBadger(utxos);
  assert.ok(m);
  assert.equal(m.tokenCategory, MASTER_CAT + '02');
  // Non-array input.
  assert.equal(findMasterBadger(null), null);
  assert.equal(findMasterBadger('hi'), null);
});

test('staking-badger-stake: countLockNfts + sumLockNftValue count/sum only mutable+category', () => {
  const utxos = [
    makeMasterUtxo(),
    { ...makeUserUtxo({ tokenCategory: MASTER_CAT + '01' }), capability: '0x01', tokenAmount: 100n, nftCommitment: SAMPLE_LOCK_COMMITMENT_HEX, value: 100_000n },
    { ...makeUserUtxo({ tokenCategory: MASTER_CAT + '01' }), capability: '0x01', tokenAmount: 200n, nftCommitment: SAMPLE_LOCK_COMMITMENT_HEX, value: 200_000n },
    makeUserUtxo({ tokenCategory: '' }),
  ];
  assert.equal(countLockNfts(utxos), 2);
  assert.equal(sumLockNftValue(utxos), 300_000n);
  assert.equal(countLockNfts([]), 0);
  assert.equal(sumLockNftValue(null), 0n);
});

test('staking-badger-stake: summarizeMasterBadger encodes the full envelope', () => {
  const utxo = makeMasterUtxo();
  const r = summarizeMasterBadger(utxo);
  assert.equal(r.found, true);
  assert.equal(r.stakeFee, 1000);
  assert.equal(r.adminPkhHex, 'ab'.repeat(20));
  assert.equal(r.tokenAmount, 10_000n);
  assert.equal(r.value, 100_000n);
  // Missing UTXO → not-found envelope.
  const r2 = summarizeMasterBadger(null);
  assert.equal(r2.found, false);
  assert.match(r2.reason, /No masterBadger/);
  // Malformed commitment → not-found envelope.
  const r3 = summarizeMasterBadger({ ...utxo, nftCommitment: 'aa'.repeat(10) });
  assert.equal(r3.found, false);
  assert.match(r3.reason, /malformed commitment/);
  // Network override.
  const r4 = summarizeMasterBadger(utxo, { network: 'chipnet' });
  assert.equal(r4.network, 'chipnet');
});

// ─── simulateLock ───────────────────────────────────────────────────────

test('staking-badger-stake: simulateLock builds the canonical 3-output layout', () => {
  const masterUtxo = makeMasterUtxo({ tokenAmount: 100n });
  const userUtxos = [makeUserUtxo({ value: 600_000n })];
  const r = simulateLock({
    amountSats: 500_000n,
    stakeBlocks: 1440,
    userPkh: SAMPLE_USER_PKH_HEX,
    masterUtxo,
    userUtxos,
  });
  assert.equal(r.ok, true);
  assert.equal(r.outputs.length, 3); // master + lockNFT + change
  // Output 0: masterBadger carry-forward (value += stakeFee, tokenAmount -= reward).
  assert.equal(r.outputs[0].value, 100_000n + 1000n);
  assert.equal(r.outputs[0].tokenAmount, 100n - 7n);
  // Output 1: lockNFT (value=amount, tokenAmount=reward).
  assert.equal(r.outputs[1].value, 500_000n);
  assert.equal(r.outputs[1].tokenAmount, 7n);
  assert.equal(r.outputs[1].tokenCategory, MASTER_CAT + '01');
  // Output 2: change = 600_000 - 500_000 - 1000 fee.
  assert.equal(r.outputs[2].value, 99_000n);
  // spentSats + changeSats + estimatedFeeSats = userInputSats.
  assert.equal(r.spentSats + r.changeSats + r.estimatedFeeSats, 600_000n);
});

test('staking-badger-stake: simulateLock drops the change output when change is 0', () => {
  const masterUtxo = makeMasterUtxo();
  // User UTXO exactly covers amount + fee → no change.
  const userUtxos = [makeUserUtxo({ value: 501_000n })];
  const r = simulateLock({
    amountSats: 500_000n,
    stakeBlocks: 1440,
    userPkh: SAMPLE_USER_PKH_HEX,
    masterUtxo,
    userUtxos,
  });
  assert.equal(r.ok, true);
  assert.equal(r.outputs.length, 2); // master + lockNFT (no change)
  assert.equal(r.changeSats, 0n);
});

test('staking-badger-stake: simulateLock rejects bad master / bad params / insufficient UTXO', () => {
  // Bad master (wrong category).
  const r1 = simulateLock({
    amountSats: 500_000n,
    stakeBlocks: 1440,
    userPkh: SAMPLE_USER_PKH_HEX,
    masterUtxo: makeMasterUtxo({ tokenCategory: '00'.repeat(32) + '02' }),
    userUtxos: [makeUserUtxo()],
  });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'INVALID');
  assert.ok(r1.violations.some((v) => /MASTER_CAT/.test(v)));

  // Master can't pay out the reward.
  const r2 = simulateLock({
    amountSats: 500_000n,
    stakeBlocks: 1440,
    userPkh: SAMPLE_USER_PKH_HEX,
    masterUtxo: makeMasterUtxo({ tokenAmount: 1n }),
    userUtxos: [makeUserUtxo()],
  });
  assert.equal(r2.ok, false);
  assert.ok(r2.violations.some((v) => /masterUtxo.tokenAmount/.test(v)));

  // Bad params (below min).
  const r3 = simulateLock({
    amountSats: 1_000n,
    stakeBlocks: 1440,
    userPkh: SAMPLE_USER_PKH_HEX,
    masterUtxo: makeMasterUtxo(),
    userUtxos: [makeUserUtxo()],
  });
  assert.equal(r3.ok, false);
  assert.equal(r3.code, 'BAD_PARAMS');

  // No user UTXOs.
  const r4 = simulateLock({
    amountSats: 500_000n,
    stakeBlocks: 1440,
    userPkh: SAMPLE_USER_PKH_HEX,
    masterUtxo: makeMasterUtxo(),
    userUtxos: [],
  });
  assert.equal(r4.ok, false);
  assert.equal(r4.code, 'NO_USER_UTXOS');

  // Bad userPkh length.
  const r5 = simulateLock({
    amountSats: 500_000n,
    stakeBlocks: 1440,
    userPkh: 'aa'.repeat(19),
    masterUtxo: makeMasterUtxo(),
    userUtxos: [makeUserUtxo()],
  });
  assert.equal(r5.ok, false);
  assert.equal(r5.code, 'BAD_PKH_LEN');

  // Missing masterUtxo.
  const r6 = simulateLock({
    amountSats: 500_000n,
    stakeBlocks: 1440,
    userPkh: SAMPLE_USER_PKH_HEX,
    masterUtxo: null,
    userUtxos: [makeUserUtxo()],
  });
  assert.equal(r6.ok, false);
  assert.equal(r6.code, 'NO_MASTER');

  // Insufficient user UTXO value.
  const r7 = simulateLock({
    amountSats: 500_000n,
    stakeBlocks: 1440,
    userPkh: SAMPLE_USER_PKH_HEX,
    masterUtxo: makeMasterUtxo(),
    userUtxos: [makeUserUtxo({ value: 100_000n })],
  });
  assert.equal(r7.ok, false);
  assert.ok(r7.violations.some((v) => /no BCH UTXO/.test(v)));
});

// ─── simulateUnlock ─────────────────────────────────────────────────────

test('staking-badger-stake: simulateUnlock builds the 3-output unlock layout', () => {
  const lockUtxo = {
    token: {
      tokenId: MASTER_CAT + '01',
      capability: '0x01',
      commitment: SAMPLE_LOCK_COMMITMENT_HEX, // userPkh = cd..cd, stakeBlocks = 1440
      amount: 7n,
    },
    value: 500_000n,
  };
  const r = simulateUnlock({ lockUtxo, userPkh: SAMPLE_USER_PKH_HEX });
  assert.equal(r.ok, true);
  assert.equal(r.outputs.length, 3);
  assert.equal(r.badgerCoinAmount, 7n);
  assert.equal(r.unlockedBchSats, 500_000n - UNLOCK_DUST_FEE_SATS);
  assert.equal(r.stakeBlocks, 1440);
  // All three outputs go to userPkh.
  for (const o of r.outputs) {
    assert.match(o.lockingBytecode, new RegExp(`^p2pkh:${SAMPLE_USER_PKH_HEX}$`));
  }
});

test('staking-badger-stake: simulateUnlock rejects bad commitment / wrong userPkh / zero badgerCoin', () => {
  // Bad commitment length.
  const r1 = simulateUnlock({ lockUtxo: {
    token: { tokenId: MASTER_CAT + '01', capability: '0x01', commitment: 'aa'.repeat(20), amount: 7n },
    value: 500_000n,
  }, userPkh: SAMPLE_USER_PKH_HEX });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'INVALID');

  // Wrong userPkh (commitment says cd..cd but caller says ab..ab).
  const r2 = simulateUnlock({ lockUtxo: {
    token: { tokenId: MASTER_CAT + '01', capability: '0x01', commitment: SAMPLE_LOCK_COMMITMENT_HEX, amount: 7n },
    value: 500_000n,
  }, userPkh: 'ab'.repeat(20) });
  assert.equal(r2.ok, false);
  assert.ok(r2.violations.some((v) => /userPkh/.test(v)));

  // Zero BadgerCoin.
  const r3 = simulateUnlock({ lockUtxo: {
    token: { tokenId: MASTER_CAT + '01', capability: '0x01', commitment: SAMPLE_LOCK_COMMITMENT_HEX, amount: 0n },
    value: 500_000n,
  }, userPkh: SAMPLE_USER_PKH_HEX });
  assert.equal(r3.ok, false);
  assert.ok(r3.violations.some((v) => /tokenAmount/.test(v)));

  // Non-mutable capability.
  const r4 = simulateUnlock({ lockUtxo: {
    token: { tokenId: MASTER_CAT + '02', capability: '0x02', commitment: SAMPLE_LOCK_COMMITMENT_HEX, amount: 7n },
    value: 500_000n,
  }, userPkh: SAMPLE_USER_PKH_HEX });
  assert.equal(r4.ok, false);
  assert.ok(r4.violations.some((v) => /capability/.test(v)));

  // Missing lockUtxo.
  const r5 = simulateUnlock({ lockUtxo: null, userPkh: SAMPLE_USER_PKH_HEX });
  assert.equal(r5.ok, false);
  assert.equal(r5.code, 'NO_LOCK_UTXO');

  // Bad userPkh length.
  const r6 = simulateUnlock({ lockUtxo: {
    token: { tokenId: MASTER_CAT + '01', capability: '0x01', commitment: SAMPLE_LOCK_COMMITMENT_HEX, amount: 7n },
    value: 500_000n,
  }, userPkh: 'aa'.repeat(19) });
  assert.equal(r6.ok, false);
  assert.equal(r6.code, 'BAD_PKH_LEN');
});

// ─── Async fetchCashTokenUtxos / fetchMasterState (mocked fetch) ────────

test('staking-badger-stake: fetchCashTokenUtxos surfaces a typed error envelope on bad address', async () => {
  const r = await fetchCashTokenUtxos('', { fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'BAD_ADDRESS');
});

test('staking-badger-stake: fetchCashTokenUtxos propagates HTTP errors', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503, statusText: 'Service Unavailable' });
  const r = await fetchCashTokenUtxos('bitcoincash:fake', { fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'HTTP_ERROR');
  assert.match(r.error, /HTTP 503/);
});

test('staking-badger-stake: fetchCashTokenUtxos happy-path decodes utxos + cumulativeValue', async () => {
  const fetchImpl = async (url, init) => {
    assert.match(url, /watchtower\.cash\/api\/transactions\/get_cashtokens_utxos/);
    assert.equal(init.method, 'POST');
    const body = JSON.parse(init.body);
    assert.equal(body.options.confirmed, true);
    return {
      ok: true,
      json: async () => ({
        utxos: [
          makeMasterUtxo(),
          { ...makeUserUtxo({ tokenCategory: MASTER_CAT + '01' }), tokenAmount: 7n, capability: '0x01', nftCommitment: SAMPLE_LOCK_COMMITMENT_HEX, value: 500_000n },
        ],
        cumulativeValue: 600_000,
      }),
    };
  };
  const r = await fetchCashTokenUtxos('bitcoincash:fake', { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.utxos.length, 2);
  assert.equal(r.cumulativeValue, 600_000n);
});

test('staking-badger-stake: fetchCashTokenUtxos handles AbortController timeout', async () => {
  // fetchImpl that respects the AbortSignal.
  const fetchImpl = async (_url, init) => {
    return await new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      });
    });
  };
  const r = await fetchCashTokenUtxos('bitcoincash:fake', { fetchImpl, timeoutMs: 10 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NETWORK_ERROR');
});

test('staking-badger-stake: fetchMasterState composes findMasterBadger + count + sum (T70-2 electrum path)', async () => {
  const provider = {
    getUtxos: async () => [
      makeMasterUtxo(),
      { ...makeUserUtxo({ tokenCategory: MASTER_CAT + '01' }), tokenAmount: 7n, capability: '0x01', nftCommitment: SAMPLE_LOCK_COMMITMENT_HEX, value: 500_000n },
      { ...makeUserUtxo({ tokenCategory: MASTER_CAT + '01' }), tokenAmount: 8n, capability: '0x01', nftCommitment: SAMPLE_LOCK_COMMITMENT_HEX, value: 700_000n },
    ],
  };
  const r = await fetchMasterState({ provider });
  assert.equal(r.ok, true);
  assert.equal(r.master.found, true);
  assert.equal(r.master.stakeFee, 1000);
  assert.equal(r.master.tokenAmount, 10_000n);
  assert.equal(r.lockNftCount, 2);
  assert.equal(r.lockNftBchTotal, 1_200_000n);
  assert.equal(r.rawUtxoCount, 3);
});

test('staking-badger-stake: fetchMasterState propagates electrum errors (T70-2)', async () => {
  const provider = { getUtxos: async () => { throw new Error('electrum unreachable'); } };
  const r = await fetchMasterState({ provider });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ELECTRUM_ERROR');
  assert.match(r.error, /electrum unreachable/);
});

test('staking-badger-stake: fetchMasterState returns NO_PROVIDER when provider missing (T70-2)', async () => {
  const r = await fetchMasterState({});
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NO_PROVIDER');
});

// ─── computeStakeAllocation (trader-loop sizing) ────────────────────────

test('staking-badger-stake: computeStakeAllocation returns the inactive fraction, clamped to cfg', () => {
  const cfg = { enabled: true, inactive_fraction_to_stake: 0.5, lock_min_sats: 5_000, lock_max_sats: 50_000_000 };
  // wallet = 100k, exposure = 10k, reserve = 5k → inactive = 85k → 50% = 42.5k.
  const r1 = computeStakeAllocation({
    walletBalanceSats: 100_000n,
    openExposureSats: 10_000n,
    minReserveSats: 5_000n,
    cfg,
  });
  assert.equal(r1.ok, true);
  assert.equal(r1.inactiveBalanceSats, 85_000n);
  assert.equal(r1.stakeAmountSats, 42_500n);
  assert.equal(r1.stakeAmountBch, 0.000425);

  // Ceiling clamp: huge inactive.
  const r2 = computeStakeAllocation({
    walletBalanceSats: 100_000_000n,
    openExposureSats: 0n,
    minReserveSats: 0n,
    cfg: { ...cfg, lock_max_sats: 1_000_000 },
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.stakeAmountSats, 1_000_000n); // clamped to ceiling

  // Below floor → skip. floor=5_001 makes stakeable=5_000 < floor, so it skips.
  const r3 = computeStakeAllocation({
    walletBalanceSats: 10_000n,
    openExposureSats: 0n,
    minReserveSats: 0n,
    cfg: { ...cfg, lock_min_sats: 5_001 },
  });
  assert.equal(r3.ok, false);
  assert.equal(r3.skipReason, 'below_floor');

  // Disabled → skip.
  const r4 = computeStakeAllocation({
    walletBalanceSats: 100_000n,
    openExposureSats: 0n,
    minReserveSats: 0n,
    cfg: { ...cfg, enabled: false },
  });
  assert.equal(r4.ok, false);
  assert.equal(r4.skipReason, 'config_disabled');

  // Insufficient inactive (balance <= exposure + reserve).
  const r5 = computeStakeAllocation({
    walletBalanceSats: 10_000n,
    openExposureSats: 5_000n,
    minReserveSats: 5_000n,
    cfg,
  });
  assert.equal(r5.ok, false);
  assert.equal(r5.skipReason, 'insufficient_inactive');

  // No cfg → skip.
  const r6 = computeStakeAllocation({
    walletBalanceSats: 100_000n,
    openExposureSats: 0n,
    minReserveSats: 0n,
  });
  assert.equal(r6.ok, false);
  assert.equal(r6.skipReason, 'config_disabled');
});

// ─── CLI: parseStakeInspectArgs ─────────────────────────────────────────

test('stake-inspect: parseStakeInspectArgs handles --key, --key=value, and boolean flags', () => {
  const r1 = parseStakeInspectArgs(['node', 'stake-inspect.mjs', '--inspect-master']);
  assert.equal(r1.flags['inspect-master'], true);
  const r2 = parseStakeInspectArgs(['node', 'stake-inspect.mjs', '--amount=500000']);
  assert.equal(r2.flags.amount, '500000');
  const r3 = parseStakeInspectArgs(['node', 'stake-inspect.mjs', '--amount', '500000']);
  assert.equal(r3.flags.amount, '500000');
  const r4 = parseStakeInspectArgs(['node', 'stake-inspect.mjs', 'positional-arg']);
  assert.deepEqual(r4.positional, ['positional-arg']);
});

test('stake-inspect: normalizeStakeInspectFlags rejects unknown flags + bad numbers', () => {
  const r1 = normalizeStakeInspectFlags({});
  assert.equal(r1.ok, true);
  assert.equal(r1.opts.inspectMaster, false);
  assert.equal(r1.opts.stakeBlocks, 1440);
  // Unknown flag.
  const r2 = normalizeStakeInspectFlags({ 'totally-unknown': true });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /unknown flag/);
  // Bad amount.
  const r3 = normalizeStakeInspectFlags({ amount: 'abc' });
  assert.equal(r3.ok, false);
  assert.match(r3.error, /amount/);
  // Out-of-range blocks.
  const r4 = normalizeStakeInspectFlags({ blocks: 100_000 });
  assert.equal(r4.ok, false);
  assert.match(r4.error, /blocks/);
  // Negative blocks.
  const r5 = normalizeStakeInspectFlags({ blocks: '-1' });
  assert.equal(r5.ok, false);
  // Float blocks.
  const r6 = normalizeStakeInspectFlags({ blocks: '1.5' });
  assert.equal(r6.ok, false);
  // Chipnet flips network + contract address.
  const r7 = normalizeStakeInspectFlags({ chipnet: true });
  assert.equal(r7.ok, true);
  assert.equal(r7.opts.network, 'chipnet');
  assert.equal(r7.opts.contractAddress, CONTRACT_ADDRESS.chipnet);
  // simulate-lock without --amount/--blocks.
  const r8 = normalizeStakeInspectFlags({ 'simulate-lock': true });
  assert.equal(r8.ok, false);
  assert.match(r8.error, /--simulate-lock/);
  // simulate-unlock without --lock-commitment.
  const r9 = normalizeStakeInspectFlags({ 'simulate-unlock': true });
  assert.equal(r9.ok, false);
  assert.match(r9.error, /--simulate-unlock/);
  // simulate-allocate missing args.
  const r10 = normalizeStakeInspectFlags({ 'simulate-allocate': true });
  assert.equal(r10.ok, false);
  assert.match(r10.error, /--simulate-allocate/);
});

test('stake-inspect: normalizeStakeInspectFlags happy-path with all flags', () => {
  const r = normalizeStakeInspectFlags({
    'inspect-master': true,
    json: true,
    'simulate-lock': true,
    amount: '500000',
    blocks: '1440',
  });
  assert.equal(r.ok, true);
  assert.equal(r.opts.inspectMaster, true);
  assert.equal(r.opts.json, true);
  assert.equal(r.opts.simulateLock, true);
  assert.equal(r.opts.amountSats, 500000);
  assert.equal(r.opts.stakeBlocks, 1440);
});

test('stake-inspect: formatStakeInspectHelp is stable + mentions the canonical flags', () => {
  const h = formatStakeInspectHelp();
  assert.match(h, /--inspect-master/);
  assert.match(h, /--simulate-lock/);
  assert.match(h, /--simulate-unlock/);
  assert.match(h, /--simulate-allocate/);
  assert.match(h, /--decode-commitment/);
  assert.match(h, /--chipnet/);
});

// ─── CLI: handlers ──────────────────────────────────────────────────────

test('stake-inspect: runDecodeCommitment decodes master + lock + rejects bad length', () => {
  // Master commitment.
  const r1 = runDecodeCommitment(SAMPLE_MASTER_COMMITMENT_HEX, true);
  assert.equal(r1.exitCode, 0);
  assert.equal(r1.ok, true);
  const parsed1 = JSON.parse(r1.text);
  assert.equal(parsed1.kind, 'master');
  assert.equal(parsed1.decoded.stakeFee, 1000);
  // Lock commitment.
  const r2 = runDecodeCommitment(SAMPLE_LOCK_COMMITMENT_HEX, true);
  const parsed2 = JSON.parse(r2.text);
  assert.equal(parsed2.kind, 'lock');
  assert.equal(parsed2.decoded.stakeBlocks, 1440);
  // Bad length → exitCode 1.
  const r3 = runDecodeCommitment('aa'.repeat(20), true);
  assert.equal(r3.exitCode, 1);
  const parsed3 = JSON.parse(r3.text);
  assert.equal(parsed3.ok, false);
  assert.equal(parsed3.code, 'BAD_LENGTH');
  // 0x prefix is stripped.
  const r4 = runDecodeCommitment('0x' + SAMPLE_MASTER_COMMITMENT_HEX, true);
  assert.equal(r4.exitCode, 0);
});

test('stake-inspect: runSimulateLock happy-path + layout-builder path', () => {
  // Without masterUtxo/userUtxos → params-only path (still ok).
  const r1 = runSimulateLock({
    amountSats: 500_000,
    stakeBlocks: 1440,
    userPkh: SAMPLE_USER_PKH_HEX,
    json: true,
  });
  assert.equal(r1.exitCode, 0);
  const parsed1 = JSON.parse(r1.text);
  assert.equal(parsed1.ok, true);
  assert.equal(parsed1.reward.badgerCoin, '7');

  // With masterUtxo + userUtxos → full layout.
  const r2 = runSimulateLock({
    amountSats: 500_000,
    stakeBlocks: 1440,
    userPkh: SAMPLE_USER_PKH_HEX,
    json: true,
  }, makeMasterUtxo({ tokenAmount: 100n }), [makeUserUtxo({ value: 600_000n })]);
  assert.equal(r2.exitCode, 0);
  const parsed2 = JSON.parse(r2.text);
  assert.equal(parsed2.ok, true);
  assert.equal(parsed2.layout.outputs.length, 3);
  assert.equal(parsed2.layout.spentSats, '500000');
  assert.equal(parsed2.layout.changeSats, '99000');

  // Bad params → exitCode 1.
  const r3 = runSimulateLock({
    amountSats: 1_000,
    stakeBlocks: 1440,
    userPkh: SAMPLE_USER_PKH_HEX,
    json: true,
  });
  assert.equal(r3.exitCode, 1);

  // Layout with a violating master → exitCode 3.
  const r4 = runSimulateLock({
    amountSats: 500_000,
    stakeBlocks: 1440,
    userPkh: SAMPLE_USER_PKH_HEX,
    json: true,
  }, makeMasterUtxo({ tokenAmount: 1n }), [makeUserUtxo({ value: 600_000n })]);
  assert.equal(r4.exitCode, 3);
});

test('stake-inspect: runSimulateUnlock happy-path + violations', () => {
  const r1 = runSimulateUnlock({
    lockCommitment: SAMPLE_LOCK_COMMITMENT_HEX,
    amountSats: 500_000,
    badgerCoinAmount: 7,
    userPkh: SAMPLE_USER_PKH_HEX,
    json: true,
  });
  assert.equal(r1.exitCode, 0);
  const parsed = JSON.parse(r1.text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.outputs.length, 3);
  assert.equal(parsed.badgerCoinAmount, '7');
  assert.equal(parsed.unlockedBchSats, (500_000 - 3000).toString());

  // Wrong userPkh → exitCode 3.
  const r2 = runSimulateUnlock({
    lockCommitment: SAMPLE_LOCK_COMMITMENT_HEX,
    amountSats: 500_000,
    badgerCoinAmount: 7,
    userPkh: 'ab'.repeat(20),
    json: true,
  });
  assert.equal(r2.exitCode, 3);
});

test('stake-inspect: runSimulateAllocate computes the stake size', () => {
  const cfg = { enabled: true, inactive_fraction_to_stake: 0.5, lock_min_sats: 5_000, lock_max_sats: 50_000_000 };
  // inactiveBalance is the operator-supplied "wallet balance" knob; the script derives
  // inactive = wallet - exposure - reserve, so 100_000 - 10_000 - 5_000 = 85_000.
  const r1 = runSimulateAllocate({
    inactiveBalance: 100_000,
    openExposure: 10_000,
    minReserve: 5_000,
    json: true,
  }, cfg);
  // inactive = 85_000; 50% = 42_500.
  const parsed1 = JSON.parse(r1.text);
  assert.equal(parsed1.ok, true);
  assert.equal(parsed1.stakeAmountSats, '42500');
  assert.equal(parsed1.stakeAmountBch, 0.000425);

  // Disabled → skip.
  const r2 = runSimulateAllocate({
    inactiveBalance: 100_000,
    openExposure: 0,
    minReserve: 0,
    json: true,
  }, { enabled: false, inactive_fraction_to_stake: 0.5, lock_min_sats: 5_000 });
  assert.equal(r2.ok, false);
  assert.equal(JSON.parse(r2.text).skipReason, 'config_disabled');
});

test('stake-inspect: runInspectMaster with mocked electrum provider (T70-2)', async () => {
  const provider = {
    getUtxos: async () => [makeMasterUtxo()],
  };
  const r = await runInspectMaster({ network: 'mainnet', contractAddress: CONTRACT_ADDRESS.mainnet, requestTimeoutMs: 1000, json: true }, { provider });
  assert.equal(r.exitCode, 0);
  assert.equal(r.ok, true);
  const parsed = JSON.parse(r.text);
  assert.equal(parsed.master.found, true);
  assert.equal(parsed.master.stakeFee, 1000);
  assert.equal(parsed.lockNftCount, 0);
  assert.equal(parsed.lockNftBchTotalSats, '0');

  // Electrum error path.
  const providerErr = { getUtxos: async () => { throw new Error('electrum unreachable'); } };
  const r2 = await runInspectMaster({ network: 'mainnet', contractAddress: CONTRACT_ADDRESS.mainnet, requestTimeoutMs: 1000, json: true }, { provider: providerErr });
  assert.equal(r2.exitCode, 2);
  assert.equal(JSON.parse(r2.text).code, 'ELECTRUM_ERROR');
});

// ─── CLI: main() end-to-end ─────────────────────────────────────────────

test('stake-inspect: main() prints help with --help', async () => {
  const r = await stakeInspectMain({ argv: ['node', 'stake-inspect.mjs', '--help'] });
  assert.equal(r.exitCode, 0);
  assert.match(r.text, /--inspect-master/);
});

test('stake-inspect: main() rejects unknown flags', async () => {
  const r = await stakeInspectMain({ argv: ['node', 'stake-inspect.mjs', '--what-is-this'] });
  assert.equal(r.exitCode, 1);
  assert.match(r.text, /unknown flag/);
});

test('stake-inspect: main() with no operation → exitCode 1', async () => {
  const r = await stakeInspectMain({ argv: ['node', 'stake-inspect.mjs'] });
  assert.equal(r.exitCode, 1);
  assert.match(r.text, /no operation specified/);
});

test('stake-inspect: main() drives --decode-commitment end-to-end', async () => {
  const r = await stakeInspectMain({ argv: ['node', 'stake-inspect.mjs', `--decode-commitment=${SAMPLE_LOCK_COMMITMENT_HEX}`, '--json'] });
  assert.equal(r.exitCode, 0);
  const parsed = JSON.parse(r.text);
  assert.equal(parsed.kind, 'lock');
  assert.equal(parsed.decoded.stakeBlocks, 1440);
});

test('stake-inspect: main() drives --simulate-lock happy-path', async () => {
  const r = await stakeInspectMain({
    argv: ['node', 'stake-inspect.mjs', '--simulate-lock', '--amount=500000', '--blocks=1440', '--json'],
    deps: { masterUtxo: makeMasterUtxo({ tokenAmount: 100n }), userUtxos: [makeUserUtxo({ value: 600_000n })] },
  });
  assert.equal(r.exitCode, 0);
  const parsed = JSON.parse(r.text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.reward.badgerCoin, '7');
  assert.equal(parsed.layout.outputs.length, 3);
});

test('stake-inspect: main() drives --simulate-unlock end-to-end', async () => {
  const r = await stakeInspectMain({
    argv: ['node', 'stake-inspect.mjs', '--simulate-unlock', `--lock-commitment=${SAMPLE_LOCK_COMMITMENT_HEX}`, '--amount=500000', '--badger=7', `--user-pkh=${SAMPLE_USER_PKH_HEX}`, '--json'],
  });
  assert.equal(r.exitCode, 0);
  const parsed = JSON.parse(r.text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.badgerCoinAmount, '7');
});

test('stake-inspect: main() drives --simulate-allocate end-to-end', async () => {
  const r = await stakeInspectMain({
    argv: ['node', 'stake-inspect.mjs', '--simulate-allocate', '--inactive-balance=100000', '--open-exposure=10000', '--min-reserve=5000', '--json'],
    cfg: { enabled: true, inactive_fraction_to_stake: 0.5, lock_min_sats: 5_000, lock_max_sats: 50_000_000 },
  });
  assert.equal(r.exitCode, 0);
  const parsed = JSON.parse(r.text);
  assert.equal(parsed.ok, true);
});

test('stake-inspect: main() drives --inspect-master end-to-end (T70-2 mocked provider)', async () => {
  const provider = { getUtxos: async () => [makeMasterUtxo()] };
  const r = await stakeInspectMain({
    argv: ['node', 'stake-inspect.mjs', '--inspect-master', '--json'],
    deps: { provider },
  });
  assert.equal(r.exitCode, 0);
  const parsed = JSON.parse(r.text);
  assert.equal(parsed.master.found, true);
});

test('stake-inspect: main() chipnet flag flips network + address (T70-2 mocked provider)', async () => {
  const provider = { getUtxos: async () => [] };
  const r = await stakeInspectMain({
    argv: ['node', 'stake-inspect.mjs', '--inspect-master', '--chipnet', '--json'],
    deps: { provider },
  });
  assert.equal(r.exitCode, 0);
  const parsed = JSON.parse(r.text);
  assert.equal(parsed.network, 'chipnet');
  assert.equal(parsed.contractAddress, CONTRACT_ADDRESS.chipnet);
});
