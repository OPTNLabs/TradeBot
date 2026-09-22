// tests/staking-badger-stake-tx.test.mjs
//
// T58 subset 2 — focused unit tests for the BadgerStake
// sign-and-broadcast surface (`src/staking/badger-stake-tx.mjs`).
//
// Strategy: cover the pure + defensive guards deeply
// (`loadArtifact`, `validateArtifact`, `signLockTx`,
// `broadcastLockTx`, the guard rails inside `executeLock` /
// `executeUnlock`). The cashscript-heavy `buildLockTx` /
// `buildUnlockTx` are tested as a smoke check (caller passes a
// stub `cashscript` namespace + a stub `SignatureTemplate`) so we
// verify the orchestration shape without spinning up the real
// cashscript SDK + a live BCH mainnet UTXO set.
//
// NOTE: this file complements `tests/scripts.test.mjs` (CLI
// integration) and `tests/staking-badger-stake.test.mjs`
// (artifact contract lock). Together they satisfy the T58 subset 2
// test plan.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  loadArtifact,
  validateArtifact,
  signLockTx,
  signUnlockTx,
  broadcastLockTx,
  broadcastUnlockTx,
  executeLock,
  executeUnlock,
  buildLockTx,
  buildUnlockTx,
  _internals as txInternals,
} from '../src/staking/badger-stake-tx.mjs';
import {
  DEFAULT_STAKING_CONFIG,
} from '../src/staking/badger-stake.mjs';

// ─── fixtures ───────────────────────────────────────────────────────────

const FAKE_PKH = 'a1b2c3d4e5f60718293a4b5c6d7e8f9001122334'; // 40 hex chars = 20 bytes
const FAKE_TXID = '11'.repeat(32); // 64 hex chars

function fakeUtxo({ satoshies = 100_000n, vout = 0, txid = FAKE_TXID } = {}) {
  return {
    txid,
    vout,
    satoshies,
    sats: Number(satoshies), // some wallets return a number too
  };
}

function fakeArtifact() {
  return {
    contractName: 'BadgerStake',
    constructorInputs: [],
    abi: [
      { name: 'lock', inputs: [{ name: 'amount', type: 'int' }, { name: 'stakeBlocks', type: 'int' }, { name: 'pubkeyhash', type: 'bytes20' }] },
      { name: 'unlock', inputs: [] },
      { name: 'withdraw', inputs: [{ name: 'newFee', type: 'int' }] },
    ],
    bytecode: 'OP_DUP OP_HASH160 20 0x' + FAKE_PKH + ' OP_EQUALVERIFY OP_CHECKSIG',
  };
}

// Minimal cashscript namespace stub. Just enough to satisfy
// buildLockTx/buildUnlockTx's Contract() + TransactionBuilder() shape.
function fakeCashscript() {
  const calls = { contract: 0, builder: 0 };
  return {
    calls,
    Contract: function FakeContract(artifact, args, address) {
      this.artifact = artifact;
      this.args = args;
      this.address = address || 'bitcoincash:zfake';
      this.functions = {
        lock: function lock() { return { unlock: { sign: async () => ({ txid: 'lock-tx-stub' }) } }; },
        unlock: function unlock() { return { unlock: { sign: async () => ({ txid: 'unlock-tx-stub' }) } }; },
      };
      calls.contract += 1;
    },
    TransactionBuilder: function FakeBuilder({ provider }) {
      this.provider = provider;
      this.inputs = [];
      this.outputs = [];
      calls.builder += 1;
    },
  };
}

// Extend the FakeBuilder prototype with chainable methods.
function attachBuilderProto(cashscriptNs) {
  cashscriptNs.TransactionBuilder.prototype.addInput = function (_idx, _utxo) { return this; };
  cashscriptNs.TransactionBuilder.prototype.addOutput = function (_o) { return this; };
  cashscriptNs.TransactionBuilder.prototype.addOutputs = function (outs) { this.outputs.push(...outs); return this; };
  cashscriptNs.TransactionBuilder.prototype.setLocktime = function (_n) { return this; };
  cashscriptNs.TransactionBuilder.prototype.send = async function () { return 'aabbcc' + '00'.repeat(30); };
  cashscriptNs.TransactionBuilder.prototype.build = async function () { return 'ddee' + 'ff'.repeat(30); };
}

// ─── loadArtifact ───────────────────────────────────────────────────────

test('staking-tx: loadArtifact() reads + parses the inlined artifact JSON', async () => {
  const raw = JSON.stringify(fakeArtifact());
  const artifact = await loadArtifact({ path: '/fake/path.json', readFileImpl: async () => raw });
  assert.equal(artifact.contractName, 'BadgerStake');
  assert.equal(typeof artifact.bytecode, 'string');
  assert.ok(artifact.bytecode.length > 0);
});

test('staking-tx: loadArtifact() re-throws with ARTIFACT_LOAD code on missing file', async () => {
  await assert.rejects(
    () => loadArtifact({ path: '/no/such/file.json', readFileImpl: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } }),
    (err) => err.code === 'ARTIFACT_LOAD' && /cannot read/.test(err.message),
  );
});

test('staking-tx: loadArtifact() re-throws with ARTIFACT_LOAD code on malformed JSON', async () => {
  await assert.rejects(
    () => loadArtifact({ path: '/fake/path.json', readFileImpl: async () => '{ not json' }),
    (err) => err.code === 'ARTIFACT_LOAD' && /malformed JSON/.test(err.message),
  );
});

// ─── validateArtifact ───────────────────────────────────────────────────

test('staking-tx: validateArtifact() accepts the inlined artifact', () => {
  const r = validateArtifact(fakeArtifact());
  assert.deepEqual(r, { ok: true });
});

test('staking-tx: validateArtifact() rejects null', () => {
  const r = validateArtifact(null);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ARTIFACT_INVALID');
});

test('staking-tx: validateArtifact() rejects wrong contractName', () => {
  const r = validateArtifact({ ...fakeArtifact(), contractName: 'WrongStake' });
  assert.equal(r.ok, false);
  assert.match(r.error, /contractName.*!= BadgerStake/);
});

test('staking-tx: validateArtifact() rejects missing abi array', () => {
  const r = validateArtifact({ ...fakeArtifact(), abi: 'not-an-array' });
  assert.equal(r.ok, false);
  assert.match(r.error, /abi must be an array/);
});

test('staking-tx: validateArtifact() rejects abi missing unlock()', () => {
  const a = fakeArtifact();
  a.abi = a.abi.filter((f) => f.name !== 'unlock');
  const r = validateArtifact(a);
  assert.equal(r.ok, false);
  assert.match(r.error, /abi missing function unlock/);
});

test('staking-tx: validateArtifact() rejects abi missing lock()', () => {
  const a = fakeArtifact();
  a.abi = a.abi.filter((f) => f.name !== 'lock');
  const r = validateArtifact(a);
  assert.equal(r.ok, false);
  assert.match(r.error, /abi missing function lock/);
});

test('staking-tx: validateArtifact() rejects empty bytecode', () => {
  const r = validateArtifact({ ...fakeArtifact(), bytecode: '' });
  assert.equal(r.ok, false);
  assert.match(r.error, /bytecode must be a non-empty string/);
});

test('staking-tx: validateArtifact() rejects non-array constructorInputs', () => {
  const r = validateArtifact({ ...fakeArtifact(), constructorInputs: 'nope' });
  assert.equal(r.ok, false);
  assert.match(r.error, /constructorInputs must be an array/);
});

// ─── signLockTx / signUnlockTx ──────────────────────────────────────────

test('staking-tx: signLockTx() returns ok + txHex (cashscript signs inside build())', () => {
  const r = signLockTx({ txHex: 'aabbcc' });
  assert.equal(r.ok, true);
  assert.equal(r.txHex, 'aabbcc');
});

test('staking-tx: signLockTx() rejects empty txHex', () => {
  const r = signLockTx({ txHex: '' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SIGN');
});

test('staking-tx: signLockTx() rejects non-string txHex', () => {
  const r = signLockTx({ txHex: 12345 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SIGN');
});

test('staking-tx: signUnlockTx() is aliased to signLockTx (same surface)', () => {
  assert.equal(signUnlockTx, signLockTx);
});

// ─── broadcastLockTx / broadcastUnlockTx ───────────────────────────────

test('staking-tx: broadcastLockTx() returns ok + txid on success', async () => {
  const provider = { sendRawTransaction: async (_hex) => 'fake-txid-broadcast' };
  const r = await broadcastLockTx({ txHex: 'deadbeef', provider });
  assert.equal(r.ok, true);
  assert.equal(r.txid, 'fake-txid-broadcast');
});

test('staking-tx: broadcastLockTx() catches provider throws → BROADCAST code', async () => {
  const provider = { sendRawTransaction: async (_hex) => { throw new Error('electrum offline'); } };
  const r = await broadcastLockTx({ txHex: 'deadbeef', provider });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'BROADCAST');
  assert.match(r.error, /sendRawTransaction threw: electrum offline/);
  assert.ok(r.cause);
});

test('staking-tx: broadcastLockTx() rejects non-string result → BROADCAST code', async () => {
  const provider = { sendRawTransaction: async (_hex) => null };
  const r = await broadcastLockTx({ txHex: 'deadbeef', provider });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'BROADCAST');
  assert.match(r.error, /non-string txid/);
});

test('staking-tx: broadcastLockTx() rejects missing provider', async () => {
  const r = await broadcastLockTx({ txHex: 'deadbeef', provider: null });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'BROADCAST');
  assert.match(r.error, /provider.sendRawTransaction missing/);
});

test('staking-tx: broadcastLockTx() rejects empty txHex', async () => {
  const r = await broadcastLockTx({ txHex: '', provider: { sendRawTransaction: async () => 'x' } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'BROADCAST');
});

test('staking-tx: broadcastUnlockTx is aliased to broadcastLockTx', () => {
  assert.equal(broadcastUnlockTx, broadcastLockTx);
});

// ─── executeLock guard rails ────────────────────────────────────────────

function minimalCfg(overrides = {}) {
  return {
    staking: {
      ...DEFAULT_STAKING_CONFIG,
      lock_min_balance_bch: 0.005,
      fee_sat_per_byte: 1,
      contract_address: 'bitcoincash:zfakecontract',
      ...overrides,
    },
  };
}

test('staking-tx: executeLock() rejects null wallet → WALLET_BOOT', async () => {
  const r = await executeLock({
    cfg: minimalCfg(),
    wallet: null,
    provider: { sendRawTransaction: async () => 'never-called' },
    amountSats: 5000n,
    stakeBlocks: 144,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'WALLET_BOOT');
  assert.match(r.error, /wallet.listUtxos missing/);
});

test('staking-tx: executeLock() rejects wallet with no WIF → WIF_MISSING', async () => {
  const wallet = { listUtxos: async () => [fakeUtxo()] };
  const r = await executeLock({
    cfg: minimalCfg(),
    wallet,
    provider: { sendRawTransaction: async () => 'never-called' },
    amountSats: 5000n,
    stakeBlocks: 144,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'WIF_MISSING');
});

test('staking-tx: executeLock() rejects when wallet balance < lock_min_balance_bch → BELOW_MIN_BALANCE', async () => {
  const wallet = {
    listUtxos: async () => [fakeUtxo({ satoshies: 100n })], // 0.000001 BCH < 0.005
    getWif: () => 'fake-wif',
    getPkh: () => FAKE_PKH,
    getAddress: () => 'bitcoincash:qfake',
  };
  const r = await executeLock({
    cfg: minimalCfg(),
    wallet,
    provider: { sendRawTransaction: async () => 'never-called' },
    amountSats: 5000n,
    stakeBlocks: 144,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'BELOW_MIN_BALANCE');
  assert.ok(BigInt(r.wallet_balance_sats) < 500_000n);
  assert.equal(r.min_balance_bch, 0.005);
});

test('staking-tx: executeLock() rejects when wallet holds a stale lockNFT → STALE_LOCK_EXISTS', async () => {
  // Construct a UTXO shaped like a lockNFT: 32-byte MASTER_CAT
  // (lower) + capability byte 01 (mutable). subset 1's
  // `countLockNfts` reads `utxo.token.tokenId` + `utxo.token.capability`
  // — we provide both with the right shape so the stale-lock
  // guard fires BEFORE the master search.
  const { MASTER_CAT } = await import('../src/staking/badger-stake.mjs');
  const lockNftCat = MASTER_CAT.toLowerCase() + '01'; // 66-char tokenId
  const wallet = {
    listUtxos: async () => [
      fakeUtxo({ satoshies: 1_000_000n }),                 // 0.01 BCH (above min)
      {
        txid: '22'.repeat(32),
        vout: 0,
        satoshies: 1000n,
        token: { tokenId: lockNftCat, capability: 0x01, amount: 1000n },
      },
    ],
    getWif: () => 'fake-wif',
    getPkh: () => FAKE_PKH,
    getAddress: () => 'bitcoincash:qfake',
  };
  const r = await executeLock({
    cfg: minimalCfg(),
    wallet,
    provider: { sendRawTransaction: async () => 'never-called' },
    amountSats: 5000n,
    stakeBlocks: 144,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'STALE_LOCK_EXISTS');
  assert.ok(r.lock_nft_count >= 1);
});

test('staking-tx: executeLock() rejects when provider.sendRawTransaction missing → PROVIDER', async () => {
  const wallet = {
    listUtxos: async () => [fakeUtxo({ satoshies: 1_000_000n })],
    getWif: () => 'fake-wif',
    getPkh: () => FAKE_PKH,
    getAddress: () => 'bitcoincash:qfake',
  };
  const r = await executeLock({
    cfg: minimalCfg(),
    wallet,
    provider: null,
    amountSats: 5000n,
    stakeBlocks: 144,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PROVIDER');
});

test('staking-tx: executeLock() catches wallet.listUtxos throws → PROVIDER', async () => {
  const wallet = {
    listUtxos: async () => { throw new Error('electrum 503'); },
    getWif: () => 'fake-wif',
    getPkh: () => FAKE_PKH,
  };
  const r = await executeLock({
    cfg: minimalCfg(),
    wallet,
    provider: { sendRawTransaction: async () => 'never-called' },
    amountSats: 5000n,
    stakeBlocks: 144,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PROVIDER');
  assert.match(r.error, /wallet.listUtxos threw: electrum 503/);
});

test('staking-tx: executeLock() catches listUtxos non-array → WALLET_BOOT', async () => {
  const wallet = {
    listUtxos: async () => 'not-an-array',
    getWif: () => 'fake-wif',
    getPkh: () => FAKE_PKH,
  };
  const r = await executeLock({
    cfg: minimalCfg(),
    wallet,
    provider: { sendRawTransaction: async () => 'never-called' },
    amountSats: 5000n,
    stakeBlocks: 144,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'WALLET_BOOT');
});

test('staking-tx: executeLock() returns NO_MASTER when fetchMasterState finds nothing + wallet has no local master', async () => {
  const wallet = {
    listUtxos: async () => [fakeUtxo({ satoshies: 1_000_000n })],
    getWif: () => 'fake-wif',
    getPkh: () => FAKE_PKH,
    getAddress: () => 'bitcoincash:qfake',
  };
  const r = await executeLock({
    cfg: minimalCfg(),
    wallet,
    provider: { sendRawTransaction: async () => 'never-called' },
    amountSats: 5000n,
    stakeBlocks: 144,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    deps: {
      artifact: fakeArtifact(),
      fetchMasterState: async () => ({ ok: false, error: 'not found' }),
      // No local master — the wallet has only a normal BCH UTXO.
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NO_MASTER');
});

test('staking-tx: executeLock() returns WIF_MISSING when wallet.getPkh() missing', async () => {
  const { MASTER_CAT } = await import('../src/staking/badger-stake.mjs');
  const wallet = {
    listUtxos: async () => [fakeUtxo({ satoshies: 1_000_000n })],
    getWif: () => 'fake-wif',
    // no getPkh
    getAddress: () => 'bitcoincash:qfake',
  };
  // T70-2 electrum path: provider.getUtxos returns raw UTXOs at the
  // contract address; findMasterBadger picks the minting-capability
  // one. Shape the master tokenId so getTokenId() returns
  // MASTER_CAT + '02' (matching the 64-char prefix check).
  const fakeMasterUtxo = {
    txid: '33'.repeat(32),
    vout: 0,
    satoshies: 1000n,
    token: { tokenId: MASTER_CAT.toLowerCase() + '02', capability: 0x02, amount: 1000n, commitment: '11'.repeat(40) },
  };
  const r = await executeLock({
    cfg: minimalCfg(),
    wallet,
    provider: {
      sendRawTransaction: async () => 'never-called',
      getUtxos: async () => [fakeMasterUtxo],
    },
    amountSats: 5000n,
    stakeBlocks: 144,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    deps: {
      artifact: fakeArtifact(),
      fetchMasterState: async () => ({
        ok: true,
        master: { found: true, tokenCategory: MASTER_CAT, tokenAmount: 1000n, satoshis: 1000n },
        lockNftCount: 0,
        lockNftBchTotal: 0n,
        rawUtxoCount: 1,
      }),
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'WIF_MISSING');
  assert.match(r.error, /wallet.getPkh\(\) missing/);
});

test('staking-tx: executeLock() returns WIF_MISSING when wallet.getPkh() returns wrong length', async () => {
  const { MASTER_CAT } = await import('../src/staking/badger-stake.mjs');
  const wallet = {
    listUtxos: async () => [fakeUtxo({ satoshies: 1_000_000n })],
    getWif: () => 'fake-wif',
    getPkh: () => 'abc', // not 40 hex chars
    getAddress: () => 'bitcoincash:qfake',
  };
  // Provide a master UTXO via the injected fetchMasterState so
  // the userPkh validation path (which runs AFTER the master
  // search) is reachable.
  const fakeMasterUtxo = {
    txid: '33'.repeat(32),
    vout: 0,
    satoshies: 1000n,
    token: { tokenId: MASTER_CAT.toLowerCase() + '02', capability: 0x02, amount: 1000n, commitment: '11'.repeat(40) },
  };
  const r = await executeLock({
    cfg: minimalCfg(),
    wallet,
    provider: {
      sendRawTransaction: async () => 'never-called',
      getUtxos: async () => [fakeMasterUtxo],
    },
    amountSats: 5000n,
    stakeBlocks: 144,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    deps: {
      artifact: fakeArtifact(),
      fetchMasterState: async () => ({
        ok: true,
        master: { found: true, tokenCategory: MASTER_CAT.toLowerCase() + '02', tokenAmount: 1000n, satoshis: 1000n },
        lockNftCount: 0,
        lockNftBchTotal: 0n,
        rawUtxoCount: 1,
      }),
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'WIF_MISSING');
  assert.match(r.error, /expected 40/);
});

// Use a fake master category for the test above (we don't need
// the real MASTER_CAT — the executeLock path doesn't validate
// the category id, only that *some* master UTXO exists).
const MASTER_CAT_FAKE = 'a'.repeat(64);

// ─── executeUnlock guard rails ──────────────────────────────────────────

test('staking-tx: executeUnlock() rejects when wallet missing → WALLET_BOOT', async () => {
  const r = await executeUnlock({
    cfg: minimalCfg(),
    wallet: null,
    provider: { sendRawTransaction: async () => 'never-called' },
    lockUtxo: fakeUtxo(),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'WALLET_BOOT');
});

test('staking-tx: executeUnlock() rejects when wallet has no WIF → WIF_MISSING', async () => {
  const wallet = { listUtxos: async () => [fakeUtxo()] };
  const r = await executeUnlock({
    cfg: minimalCfg(),
    wallet,
    provider: { sendRawTransaction: async () => 'never-called' },
    lockUtxo: fakeUtxo(),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'WIF_MISSING');
});

test('staking-tx: executeUnlock() rejects when artifact invalid → ARTIFACT_INVALID', async () => {
  const wallet = {
    listUtxos: async () => [fakeUtxo()],
    getWif: () => 'fake-wif',
    getPkh: () => FAKE_PKH,
    getAddress: () => 'bitcoincash:qfake',
  };
  const r = await executeUnlock({
    cfg: minimalCfg(),
    wallet,
    provider: { sendRawTransaction: async () => 'never-called' },
    lockUtxo: fakeUtxo(),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    deps: { artifact: { contractName: 'Wrong', abi: [], bytecode: '' } },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ARTIFACT_INVALID');
});

// ─── _internals exposure ────────────────────────────────────────────────

test('staking-tx: _internals exposes capabilityByte helper', () => {
  assert.equal(typeof txInternals.capabilityByte, 'function');
  assert.equal(txInternals.capabilityByte('minting'), '02');
  assert.equal(txInternals.capabilityByte('mutable'), '01');
  assert.equal(txInternals.capabilityByte(null), '00');
});

test('staking-tx: _internals exposes DEFAULT_ARTIFACT_PATH', () => {
  assert.match(txInternals.DEFAULT_ARTIFACT_PATH, /badger-stake-artifact\.json$/);
});

// ─── buildLockTx / buildUnlockTx smoke checks ──────────────────────────

test('staking-tx: buildLockTx() rejects when sim is non-ok → SIMULATE_VIOLATIONS', async () => {
  const r = await buildLockTx({
    sim: { ok: false, error: 'sim failed' },
    cashscript: fakeCashscript(),
    signatureTemplate: { sign: async () => ({ txid: 'x' }) },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SIMULATE_VIOLATIONS');
});

test('staking-tx: buildLockTx() rejects when cashscript missing Contract → BUILD', async () => {
  const r = await buildLockTx({
    sim: { ok: true, artifact: fakeArtifact() },
    cashscript: null,
    signatureTemplate: { sign: async () => ({ txid: 'x' }) },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'BUILD');
  assert.match(r.error, /cashscript namespace missing Contract/);
});

test('staking-tx: buildUnlockTx() rejects when sim non-ok → SIMULATE_VIOLATIONS', async () => {
  const r = await buildUnlockTx({
    sim: { ok: false },
    cashscript: fakeCashscript(),
    signatureTemplate: { sign: async () => ({ txid: 'x' }) },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SIMULATE_VIOLATIONS');
});

test('staking-tx: buildUnlockTx() rejects when cashscript missing TransactionBuilder → BUILD', async () => {
  const r = await buildUnlockTx({
    sim: { ok: true, artifact: fakeArtifact() },
    cashscript: { Contract: function () {} }, // no TransactionBuilder
    signatureTemplate: { sign: async () => ({ txid: 'x' }) },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'BUILD');
});

// ensure the fake-cashscript helper compiles
attachBuilderProto(fakeCashscript());
