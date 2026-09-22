// src/staking/badger-stake-tx.mjs
//
// T58 subset 2 — BadgerCoin Staking sign-and-broadcast path.
//
// Wraps `src/staking/badger-stake.mjs` (subset 1, shipped in
// d62e81e) with the cashscript + libauth glue needed to actually
// MOVE BCH into the BadgersStake contract. Subset 1 was read-only
// (inspection + simulation); subset 2 is the production path.
//
// Architecture
// ────────────
// Three layers, each pure-shape so tests can mock the underlying
// cashscript / libauth / Electrum without spinning up a real SDK:
//
//   1. `buildLockTx` / `buildUnlockTx`
//      Pure orchestration: take the simulateLock / simulateUnlock
//      envelope from subset 1, instantiate a cashscript Contract
//      for the BadgerStake artifact, drive a cashscript
//      TransactionBuilder through the contract's `lock()` /
//      `unlock()` unlockers + the user's SignatureTemplate P2PKH
//      unlocker. Returns a typed envelope `{ok, tx, txHex, fee}`.
//
//   2. `signLockTx` / `signUnlockTx`
//      Thin convenience: cashscript@0.13 already signs inside
//      `TransactionBuilder.build()`. The signers exist for
//      symmetry with the rest of the codebase (and so a future
//      libauth-direct path can drop in here without rewriting
//      the callers). Returns `{ok, txHex}`. Never logs the WIF.
//
//   3. `broadcastLockTx` / `broadcastUnlockTx`
//      Injected Electrum provider (same shape as
//      `scripts/consolidate-utxos.mjs#broadcastConsolidation`).
//      Returns `{ok, txid}`. Defensive against provider throws.
//
//   4. `executeLock` / `executeUnlock`
//      End-to-end orchestrator: wallet boot + WIF read +
//      fetchMasterState + simulateLock + buildLockTx +
//      signLockTx + broadcastLockTx. The CLI (`scripts/stake.mjs`)
//      is the operator-facing surface; `executeLock` is what
//      T58-3 (auto-mode) will call from inside the trader loop.
//
// Failure envelope
// ────────────────
// Every entry point returns the same typed envelope on failure:
//
//   {ok: false, code: '...', error: '...', cause?: Error}
//
// `code` is one of a stable set so callers (CLI exit codes,
// trader-loop audit events, dashboard toast) can switch on the
// machine-readable reason WITHOUT scraping the human message:
//
//   'CONFIG_LOAD'        — `loadConfig` failed
//   'ELECTRUM_URL'       — `cfg.electrum_url` missing
//   'WALLET_BOOT'        — wallet boot threw
//   'WIF_MISSING'        — wallet has no WIF (init not run / env unset)
//   'NETWORK_MISMATCH'   — WIF is for testnet but cfg says mainnet (or vice versa)
//   'PROVIDER'           — injected Electrum provider threw
//   'ARTIFACT_LOAD'      — badger-stake-artifact.json missing / malformed
//   'SIMULATE_VIOLATIONS'— simulateLock / simulateUnlock returned violations
//   'NO_MASTER'          — contract master UTXO not found on-chain
//   'NO_LOCK_UTXO'       — caller-supplied lock UTXO not on-chain
//   'NO_USER_INPUT'      — no BCH UTXO large enough for lock amount + fee
//   'BELOW_MIN_BALANCE'  — wallet total below `lock_min_balance_bch` reserve
//   'STALE_LOCK_EXISTS'  — wallet already holds an unlockable lockNFT
//                          (we refuse to stack two BadgerStake positions)
//   'BUILD'              — cashscript TransactionBuilder.build() threw
//   'SIGN'               — signature verification failed (WIF mismatch?)
//   'BROADCAST'          — Electrum broadcast threw / returned no txid
//   'CONTRACT_NOT_READY' — contract isReady() returned false (master reward > balance)
//   'ALREADY_EXISTS'     — executeLock called twice without intervening unlock
//
// On success every envelope carries:
//   {ok: true, txHex, fee?, totalIn?, outputSats?, txid?, simulation: {...}}

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

import {
  DEFAULT_STAKING_CONFIG,
  resolveStakingConfig,
  simulateLock,
  simulateUnlock,
  computeStakeAllocation,
  MASTER_CAT,
  CAPABILITY_MUTABLE,
  CONTRACT_ADDRESS,
  fetchMasterState,
  findMasterBadger,
  countLockNfts,
  PKH_LEN_HEX,
  isHex20,
  getTokenId,
  getCapability,
  getCommitment,
  getSatoshis,
  getTokenAmount,
} from './badger-stake.mjs';

// ─────────────────────────────────────────────────────────────────────
// Artifact loading (inlined from LifestoneLabs/BadgerSurvivors)
// ─────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ARTIFACT_PATH = resolvePath(__dirname, 'badger-stake-artifact.json');

/**
 * Load the BadgerStake cashscript artifact (inlined from
 * LifestoneLabs/BadgerSurvivors/src/contracts/BadgerStake.json).
 * Pure-shape `loadArtifact({path})` so tests can stub the file.
 *
 * @param {Object} [opts]
 * @param {string} [opts.path=DEFAULT_ARTIFACT_PATH]
 * @param {Function} [opts.readFileImpl] — injectable for tests
 * @returns {Promise<Object>} artifact JSON
 */
export async function loadArtifact({ path = DEFAULT_ARTIFACT_PATH, readFileImpl = readFile } = {}) {
  let raw;
  try {
    raw = await readFileImpl(path, 'utf8');
  } catch (e) {
    const err = new Error(`loadArtifact: cannot read ${path}: ${e.message}`);
    err.code = 'ARTIFACT_LOAD';
    err.cause = e;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    const err = new Error(`loadArtifact: malformed JSON in ${path}: ${e.message}`);
    err.code = 'ARTIFACT_LOAD';
    err.cause = e;
    throw err;
  }
}

/**
 * Minimal artifact sanity check. Returns `{ok, error?}`.
 * Pure — doesn't throw. Used at boot to surface a broken artifact
 * BEFORE the trader loop tries to build a tx on every tick.
 *
 * @param {Object} artifact
 * @returns {{ok: boolean, error?: string, code?: string}}
 */
export function validateArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object') {
    return { ok: false, error: 'artifact must be an object', code: 'ARTIFACT_INVALID' };
  }
  if (artifact.contractName !== 'BadgerStake') {
    return { ok: false, error: `contractName ${artifact.contractName} != BadgerStake`, code: 'ARTIFACT_INVALID' };
  }
  if (!Array.isArray(artifact.abi)) {
    return { ok: false, error: 'abi must be an array', code: 'ARTIFACT_INVALID' };
  }
  const abiNames = artifact.abi.map((f) => f?.name).filter(Boolean);
  for (const required of ['lock', 'unlock']) {
    if (!abiNames.includes(required)) {
      return { ok: false, error: `abi missing function ${required}`, code: 'ARTIFACT_INVALID' };
    }
  }
  if (typeof artifact.bytecode !== 'string' || artifact.bytecode.length === 0) {
    return { ok: false, error: 'bytecode must be a non-empty string', code: 'ARTIFACT_INVALID' };
  }
  if (!Array.isArray(artifact.constructorInputs)) {
    return { ok: false, error: 'constructorInputs must be an array', code: 'ARTIFACT_INVALID' };
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────
// Tx builders (cashscript + libauth injected for testability)
// ─────────────────────────────────────────────────────────────────────

/**
 * Build the lock tx (BadgerStake `lock(amount, stakeBlocks, pubkeyhash)`).
 * Pure orchestration — caller passes a `simulateLock` envelope and
 * the injected cashscript + SignatureTemplate. Returns the
 * typed envelope.
 *
 * @param {Object} args
 * @param {Object} args.sim            — output of `simulateLock({...})`
 * @param {Object} args.cashscript     — injected `cashscript` namespace (so
 *                                       tests can pass a stub). Defaults to
 *                                       the real `cashscript` module.
 * @param {Object} args.signatureTemplate — SignatureTemplate instance for
 *                                       the user's P2PKH unlocker.
 * @param {number} [args.feeSatPerByte=1]
 * @returns {Promise<
 *   {ok: true, txHex: string, fee?: bigint, totalIn?: bigint,
 *    outputSats?: bigint, simulation: object}
 *   | {ok: false, code: string, error: string, cause?: Error}
 * >}
 */
export async function buildLockTx({ sim, cashscript, signatureTemplate, feeSatPerByte = 1 }) {
  if (!sim || sim.ok !== true) {
    return { ok: false, code: 'SIMULATE_VIOLATIONS', error: 'simulateLock returned non-ok envelope', sim };
  }
  if (!cashscript || typeof cashscript.Contract !== 'function' || typeof cashscript.TransactionBuilder !== 'function') {
    return { ok: false, code: 'BUILD', error: 'cashscript namespace missing Contract/TransactionBuilder' };
  }
  if (!signatureTemplate || typeof signatureTemplate.unlockP2PKH !== 'function') {
    return { ok: false, code: 'SIGN', error: 'signatureTemplate missing unlockP2PKH()' };
  }
  // cashscript Contract expects constructor args (none for BadgerStake —
  // the `BadgerStake()` constructor takes zero args) + provider.
  // We build a placeholder provider stub; the actual UTXO fetch +
  // tx-build happens against the supplied userUtxos + masterUtxo.
  const providerStub = {
    getNetwork: () => ({ network: 'mainnet' }),
    getUtxos: async () => [],
    getBlockHeight: async () => 0,
    sendRawTransaction: async () => '',
  };
  let contract;
  try {
    contract = new cashscript.Contract(sim.artifact ?? null, [], { provider: providerStub });
  } catch (e) {
    // The caller is expected to have pre-loaded the artifact. If
    // `sim.artifact` is null/undefined the contract ctor throws
    // "artifact required" — surface that as ARTIFACT_LOAD so the
    // operator can fix the config.
    return { ok: false, code: 'ARTIFACT_LOAD', error: `Contract ctor threw: ${e.message}`, cause: e };
  }
  if (!sim.userInput || !sim.userInput.txid) {
    return { ok: false, code: 'NO_USER_INPUT', error: 'simulateLock did not pick a user input UTXO' };
  }
  if (!sim.masterUtxo || !sim.masterUtxo.txid) {
    return { ok: false, code: 'NO_MASTER', error: 'simulateLock did not pick a master UTXO' };
  }

  // Build the cashscript Utxo shape for the master + user inputs.
  const masterCat = MASTER_CAT;
  const masterTokenCat = masterCat + (typeof sim.masterUtxo.capability === 'string'
    ? capabilityByte(sim.masterUtxo.capability)
    : CAPABILITY_MUTABLE);
  // The lockNFT output's tokenCategory is `<cat> + 0x01` (mutable).
  const lockNftTokenCat = masterCat + '01';

  const masterUtxoCs = {
    txid: sim.masterUtxo.txid,
    vout: Number(sim.masterUtxo.vout ?? 0),
    satoshis: BigInt(sim.masterUtxo.satoshis ?? 0),
    token: {
      category: masterCat,
      amount: BigInt(sim.masterUtxo.tokenAmount ?? 0),
      nft: {
        capability: 'minting',
        commitment: sim.masterUtxo.commitment ?? '',
      },
    },
  };
  const userUtxoCs = {
    txid: sim.userInput.txid,
    vout: Number(sim.userInput.vout ?? 0),
    satoshis: BigInt(sim.userInput.satoshis ?? 0),
  };

  // Build the lock() unlocker.
  let lockUnlocker;
  try {
    lockUnlocker = contract.unlock.lock(
      BigInt(sim.amountSats ?? sim.amount ?? 0),
      Number(sim.stakeBlocks ?? 0),
      sim.userPkh,
    );
  } catch (e) {
    return { ok: false, code: 'BUILD', error: `contract.unlock.lock threw: ${e.message}`, cause: e };
  }

  // TransactionBuilder expects Outputs of shape `{to, amount, token?}`.
  const masterOutSats = BigInt(sim.outputs?.[0]?.value ?? sim.amountSats ?? 0);
  const lockNftOutSats = BigInt(sim.outputs?.[1]?.value ?? sim.amountSats ?? 0);
  const changeSats = BigInt(sim.changeSats ?? 0);
  const outputs = [
    {
      to: contract.tokenAddress,
      amount: masterOutSats,
      token: {
        category: masterCat,
        amount: masterUtxoCs.token.amount - BigInt(sim.reward ?? sim.stakeReward ?? 0),
        nft: { capability: 'minting', commitment: masterUtxoCs.token.nft.commitment },
      },
    },
    {
      to: contract.tokenAddress,
      amount: lockNftOutSats,
      token: {
        category: lockNftTokenCat,
        amount: BigInt(sim.reward ?? sim.stakeReward ?? 0),
        nft: { capability: 'mutable', commitment: sim.lockNftCommitment ?? '' },
      },
    },
  ];
  if (changeSats > 0n) {
    const userAddress = sim.userInput.lockingBytecode ?? sim.userPkhAddress ?? null;
    outputs.push({
      to: userAddress,
      amount: changeSats,
    });
  }

  // Build the tx.
  let txHex;
  let tx;
  let fee = 0n;
  try {
    tx = new cashscript.TransactionBuilder({
      provider: providerStub,
      maximumFeeSatsPerByte: Math.max(1, Number(feeSatPerByte)),
    });
    tx.addInput(masterUtxoCs, lockUnlocker);
    tx.addInput(userUtxoCs, signatureTemplate.unlockP2PKH());
    for (const o of outputs) tx.addOutput(o);
    const built = tx.build();
    if (typeof built === 'string') {
      txHex = built;
    } else if (built && typeof built.toUint8Array === 'function') {
      txHex = bufferToHex(built.toUint8Array());
    } else if (built instanceof Uint8Array) {
      txHex = bufferToHex(built);
    } else {
      return { ok: false, code: 'BUILD', error: 'cashscript build() returned non-string non-Uint8Array' };
    }
    // tx.fee is undefined in cashscript@0.13; compute it manually from
    // inputs/outputs + the size of the built hex.
    const totalIn = masterUtxoCs.satoshis + userUtxoCs.satoshis;
    const totalOut = outputs.reduce((acc, o) => acc + o.amount, 0n);
    fee = totalIn - totalOut;
  } catch (e) {
    return { ok: false, code: 'BUILD', error: `TransactionBuilder.build threw: ${e.message}`, cause: e };
  }

  return {
    ok: true,
    txHex,
    fee,
    totalIn: BigInt(sim.userInput.satoshis ?? 0) + BigInt(sim.masterUtxo.satoshis ?? 0),
    outputSats: lockNftOutSats,
    simulation: sim,
  };
}

/**
 * Build the unlock tx (BadgerStake `unlock()`).
 *
 * @param {Object} args
 * @param {Object} args.sim           — output of `simulateUnlock({...})`
 * @param {Object} args.cashscript    — injected `cashscript` namespace
 * @param {Object} args.signatureTemplate — the user's P2PKH SignatureTemplate
 *                                       (unlock pays back to the user's
 *                                       payout address, so we still need
 *                                       a P2PKH signer for the change
 *                                       output if present)
 * @param {number} [args.feeSatPerByte=1]
 * @returns {Promise<
 *   {ok: true, txHex, fee, simulation}
 *   | {ok: false, code, error, cause?}
 * >}
 */
export async function buildUnlockTx({ sim, cashscript, signatureTemplate, feeSatPerByte = 1 }) {
  if (!sim || sim.ok !== true) {
    return { ok: false, code: 'SIMULATE_VIOLATIONS', error: 'simulateUnlock returned non-ok envelope', sim };
  }
  if (!cashscript || typeof cashscript.Contract !== 'function' || typeof cashscript.TransactionBuilder !== 'function') {
    return { ok: false, code: 'BUILD', error: 'cashscript namespace missing Contract/TransactionBuilder' };
  }
  if (!sim.lockUtxo || !sim.lockUtxo.txid) {
    return { ok: false, code: 'NO_LOCK_UTXO', error: 'simulateUnlock did not receive a lock UTXO' };
  }
  const providerStub = {
    getNetwork: () => ({ network: 'mainnet' }),
    getUtxos: async () => [],
    getBlockHeight: async () => 0,
    sendRawTransaction: async () => '',
  };
  let contract;
  try {
    contract = new cashscript.Contract(sim.artifact ?? null, [], { provider: providerStub });
  } catch (e) {
    return { ok: false, code: 'ARTIFACT_LOAD', error: `Contract ctor threw: ${e.message}`, cause: e };
  }
  // The lock UTXO's tokenCategory = masterCat + '01' (mutable lockNFT).
  const masterCat = MASTER_CAT;
  const lockUtxoCs = {
    txid: sim.lockUtxo.txid,
    vout: Number(sim.lockUtxo.vout ?? 0),
    satoshis: BigInt(sim.lockUtxo.satoshis ?? 0),
    token: {
      category: masterCat,
      amount: BigInt(sim.lockUtxo.tokenAmount ?? 0),
      nft: {
        capability: 'mutable',
        commitment: sim.lockUtxo.commitment ?? '',
      },
    },
  };

  let unlockUnlocker;
  try {
    unlockUnlocker = contract.unlock.unlock();
  } catch (e) {
    return { ok: false, code: 'BUILD', error: `contract.unlock.unlock threw: ${e.message}`, cause: e };
  }

  // 3 outputs: BadgerCoin FT + Honey NFT + BCH payout.
  const outputs = (sim.outputs ?? []).map((o) => {
    if (o.tokenCategory && /^[a-f0-9]{64}$/i.test(o.tokenCategory)) {
      // FT output (BadgerCoin OR Honey NFT — same category, no capability
      // for the FT, minting for the NFT).
      const isNft = o.capability === 'minting';
      return {
        to: contract.tokenAddress,
        amount: BigInt(o.value ?? 0),
        token: {
          category: masterCat,
          amount: BigInt(o.tokenAmount ?? 0),
          ...(isNft ? { nft: { capability: 'minting', commitment: o.commitment ?? '' } } : {}),
        },
      };
    }
    // BCH payout (p2pkh to user).
    return {
      to: o.lockingBytecode ?? null,
      amount: BigInt(o.value ?? 0),
    };
  });

  let txHex;
  let fee = 0n;
  try {
    const tx = new cashscript.TransactionBuilder({
      provider: providerStub,
      maximumFeeSatsPerByte: Math.max(1, Number(feeSatPerByte)),
    });
    tx.addInput(lockUtxoCs, unlockUnlocker);
    for (const o of outputs) tx.addOutput(o);
    const built = tx.build();
    if (typeof built === 'string') {
      txHex = built;
    } else if (built && typeof built.toUint8Array === 'function') {
      txHex = bufferToHex(built.toUint8Array());
    } else if (built instanceof Uint8Array) {
      txHex = bufferToHex(built);
    } else {
      return { ok: false, code: 'BUILD', error: 'cashscript build() returned non-string non-Uint8Array' };
    }
    const totalIn = lockUtxoCs.satoshis;
    const totalOut = outputs.reduce((acc, o) => acc + o.amount, 0n);
    fee = totalIn - totalOut;
  } catch (e) {
    return { ok: false, code: 'BUILD', error: `TransactionBuilder.build (unlock) threw: ${e.message}`, cause: e };
  }

  return {
    ok: true,
    txHex,
    fee,
    totalIn: lockUtxoCs.satoshis,
    simulation: sim,
  };
}

/**
 * Sign + return tx hex. Convenience wrapper — cashscript@0.13
 * already signs inside `TransactionBuilder.build()`. The signer
 * exists for symmetry with the rest of the codebase + for a
 * future libauth-direct fallback. Returns `{ok: true, txHex}`
 * (always succeeds when given a valid hex). Never logs the WIF.
 *
 * @param {Object} args
 * @param {string} args.txHex
 * @returns {{ok: true, txHex: string} | {ok: false, code: string, error: string}}
 */
export function signLockTx({ txHex }) {
  if (typeof txHex !== 'string' || txHex.length === 0) {
    return { ok: false, code: 'SIGN', error: 'signLockTx: txHex must be a non-empty string' };
  }
  return { ok: true, txHex };
}
export const signUnlockTx = signLockTx; // same signature shape for both

/**
 * Broadcast a signed tx hex via the injected Electrum provider.
 * Pure — no I/O of its own.
 *
 * @param {Object} args
 * @param {string} args.txHex
 * @param {Object} args.provider      — ElectrumNetworkProvider (or stub)
 * @returns {Promise<{ok: true, txid: string} | {ok: false, code: 'BROADCAST', error, cause?}>}
 */
export async function broadcastLockTx({ txHex, provider }) {
  if (typeof txHex !== 'string' || txHex.length === 0) {
    return { ok: false, code: 'BROADCAST', error: 'broadcastLockTx: txHex must be a non-empty string' };
  }
  if (!provider || typeof provider.sendRawTransaction !== 'function') {
    return { ok: false, code: 'BROADCAST', error: 'broadcastLockTx: provider.sendRawTransaction missing' };
  }
  let txid;
  try {
    txid = await provider.sendRawTransaction(txHex);
  } catch (e) {
    return { ok: false, code: 'BROADCAST', error: `sendRawTransaction threw: ${e.message}`, cause: e };
  }
  if (typeof txid !== 'string' || txid.length === 0) {
    return { ok: false, code: 'BROADCAST', error: `sendRawTransaction returned non-string txid (${typeof txid})` };
  }
  return { ok: true, txid };
}
export const broadcastUnlockTx = broadcastLockTx;

// ─────────────────────────────────────────────────────────────────────
// End-to-end orchestrators (used by CLI + future T58-3 auto-mode)
// ─────────────────────────────────────────────────────────────────────

/**
 * End-to-end lock execution. Boot wallet, read WIF, fetch master
 * state, simulateLock, buildLockTx, broadcastLockTx. Returns
 * the full envelope so the caller (CLI or trader loop) can
 * decide what to do with success/failure.
 *
 * @param {Object} args
 * @param {Object} args.cfg
 * @param {Object} args.wallet         — LibAuthBchWallet instance (or stub with
 *                                       `listUtxos`, `getWif`, `getAddress`)
 * @param {Object} args.provider       — ElectrumNetworkProvider (or stub)
 * @param {bigint} [args.amountSats]
 * @param {number} [args.stakeBlocks]
 * @param {Object} [args.logger]
 * @param {Object} [args.deps]         — injectable deps: `cashscript`,
 *                                       `SignatureTemplate`, `fetchMasterState`,
 *                                       `artifact`, `simulateLock`, `nowMs`
 * @returns {Promise<Object>}
 */
export async function executeLock({
  cfg, wallet, provider, amountSats, stakeBlocks, logger, deps = {},
}) {
  const stakeCfg = resolveStakingConfig(cfg?.staking ?? {});
  const log = logger ?? { info: () => {}, warn: () => {}, error: () => {} };
  const nowMs = deps.nowMs ?? Date.now();

  // Guard 1: wallet must expose the surface we need.
  if (!wallet || typeof wallet.listUtxos !== 'function') {
    return { ok: false, code: 'WALLET_BOOT', error: 'wallet.listUtxos missing' };
  }
  if (typeof wallet.getWif !== 'function' && typeof wallet.wif !== 'string' && !(typeof deps.wif === 'string' && deps.wif.length > 0)) {
    return { ok: false, code: 'WIF_MISSING', error: 'wallet has no WIF (neither getWif() nor .wif) and deps.wif not provided' };
  }

  // Guard 2: balance must be above the reserve floor.
  const minBalanceBch = Number(stakeCfg.lock_min_balance_bch ?? DEFAULT_STAKING_CONFIG.lock_min_balance_bch);
  let walletUtxos;
  try {
    walletUtxos = await wallet.listUtxos();
  } catch (e) {
    return { ok: false, code: 'PROVIDER', error: `wallet.listUtxos threw: ${e.message}`, cause: e };
  }
  if (!Array.isArray(walletUtxos)) {
    return { ok: false, code: 'WALLET_BOOT', error: 'wallet.listUtxos returned non-array' };
  }
  const walletBalanceSats = walletUtxos.reduce((acc, u) => acc + BigInt(u.satoshis ?? u.sats ?? 0), 0n);
  const minBalanceSats = BigInt(Math.floor(minBalanceBch * 1e8));
  if (walletBalanceSats < minBalanceSats) {
    return {
      ok: false,
      code: 'BELOW_MIN_BALANCE',
      error: `wallet ${(Number(walletBalanceSats) / 1e8).toFixed(8)} BCH < ${minBalanceBch} BCH reserve`,
      wallet_balance_sats: walletBalanceSats.toString(),
      min_balance_bch: minBalanceBch,
    };
  }

  // Guard 3: refuse to stack a second BadgerStake position.
  // The wallet may already hold an unlockable lockNFT (the bot
  // staked before; lock has matured but operator hasn't unlocked
  // yet). We refuse to stack rather than risk losing the user's
  // prior position to a sloppy re-stake.
  const lockNftCount = countLockNfts(walletUtxos);
  if (lockNftCount > 0) {
    return {
      ok: false,
      code: 'STALE_LOCK_EXISTS',
      error: `wallet already holds ${lockNftCount} lockNFT — unlock first`,
      lock_nft_count: lockNftCount,
    };
  }

  // Guard 4: provider must be alive.
  if (!provider || typeof provider.sendRawTransaction !== 'function') {
    return { ok: false, code: 'PROVIDER', error: 'provider.sendRawTransaction missing' };
  }

  // Guard 5: load artifact (cached after first call).
  let artifact;
  try {
    artifact = deps.artifact ?? await loadArtifact();
  } catch (e) {
    return { ok: false, code: 'ARTIFACT_LOAD', error: e.message, cause: e.cause };
  }
  const artifactCheck = validateArtifact(artifact);
  if (!artifactCheck.ok) {
    return { ok: false, code: 'ARTIFACT_INVALID', error: artifactCheck.error };
  }

  // Step 1: fetch master state from the contract address via the
  // wallet's Electrum provider. T70-2: electrum-only path (the
  // operator spec removes the watchtower.cash dependency entirely).
  // The provider queries the contract address directly and returns
  // CashToken UTXOs in cashscript's native shape; `findMasterBadger`
  // then picks the one with `category === badgerCoinCategory` AND
  // `capability === 'minting'` (CashTokens fungible + 0x02).
  let masterUtxo = null;
  let userUtxos = walletUtxos;
  let fetchMasterError = null;
  let contractUtxos = null;
  try {
    const fetchImpl = deps.fetchMasterState ?? fetchMasterState;
    const master = await fetchImpl({
      cfg: stakeCfg,
      provider: provider && typeof provider.getUtxos === 'function' ? provider : null,
    });
    if (master && master.ok === true) {
      // The summarized envelope doesn't carry the raw UTXO array;
      // re-query the contract address (single round-trip — the
      // provider already pooled the connection) so downstream
      // `simulateLock` gets the cashscript-native UTXO shape.
      contractUtxos = await provider.getUtxos(stakeCfg.contract_address);
      masterUtxo = findMasterBadger(Array.isArray(contractUtxos) ? contractUtxos : []);
    } else if (master && master.ok === false) {
      // T70-2: surface the upstream reason so the operator can
      // tell "master truly missing" from "electrum unreachable".
      fetchMasterError = `${master.code ?? 'unknown'}: ${master.error ?? 'unknown'}`;
      log.warn?.('stake.execute_lock.fetch_master.failed', {
        err_name: 'FetchMasterState',
        err_message: master.error ?? 'unknown',
        code: master.code ?? null,
      });
    }
  } catch (e) {
    log.warn?.('stake.execute_lock.fetch_master.error', { err_message: e?.message ?? String(e) });
    fetchMasterError = e?.message ?? String(e);
  }
  if (!masterUtxo) {
    // Fallback: search the user's UTXOs in case the master is at
    // their own address (it shouldn't be, but defensive). If we
    // truly can't find a master, abort — without master the lock
    // tx is impossible.
    const localMaster = findMasterBadger(walletUtxos);
    if (localMaster) masterUtxo = localMaster;
  }
  if (!masterUtxo) {
    return {
      ok: false,
      code: 'NO_MASTER',
      error: `no masterBadger UTXO found at contract address${fetchMasterError ? ` (electrum: ${fetchMasterError})` : ''}`,
    };
  }

  // Step 2: simulate lock with the picked inputs.
  const simulateFn = deps.simulateLock ?? simulateLock;
  const lockAmount = BigInt(amountSats ?? stakeCfg.lock_amount_sats ?? DEFAULT_STAKING_CONFIG.lock_amount_sats);
  const lockBlocks = Number(stakeBlocks ?? stakeCfg.stake_blocks ?? DEFAULT_STAKING_CONFIG.stake_blocks);
  const userAddress = wallet.getAddress ? wallet.getAddress() : (typeof wallet.wif === 'string' ? '(derived from wif)' : null);
  // userPkh = 20-byte hash160 of the address. We need the actual bytes;
  // if the wallet exposes a `getPkh` helper, use it, else return a
  // typed error so the caller can pre-compute.
  let userPkh;
  if (typeof wallet.getPkh === 'function') {
    userPkh = wallet.getPkh();
  } else {
    return { ok: false, code: 'WIF_MISSING', error: 'wallet.getPkh() missing; cannot derive userPkh for lock()' };
  }
  if (!isHex20(userPkh)) {
    return { ok: false, code: 'WIF_MISSING', error: `wallet.getPkh() returned ${userPkh?.length} chars (expected ${PKH_LEN_HEX})` };
  }

  let sim;
  try {
    sim = simulateFn({
      amountSats: lockAmount,
      stakeBlocks: lockBlocks,
      userPkh,
      masterUtxo,
      userUtxos,
    });
  } catch (e) {
    return { ok: false, code: 'SIMULATE_VIOLATIONS', error: `simulateLock threw: ${e.message}`, cause: e };
  }
  if (!sim || sim.ok !== true) {
    return {
      ok: false,
      code: 'SIMULATE_VIOLATIONS',
      error: sim?.error ?? 'simulateLock returned non-ok envelope',
      violations: sim?.violations ?? [],
    };
  }

  // Step 3: build the lock tx.
  let cashscriptMod;
  try {
    cashscriptMod = deps.cashscript ?? await import('cashscript');
  } catch (e) {
    return { ok: false, code: 'ARTIFACT_LOAD', error: `cashscript import threw: ${e.message}`, cause: e };
  }
  let signatureTemplate;
  try {
    const SignatureTemplate = deps.SignatureTemplate ?? cashscriptMod.SignatureTemplate;
    const wif = (typeof wallet.getWif === 'function')
      ? wallet.getWif()
      : (typeof wallet.wif === 'string')
        ? wallet.wif
        : (typeof deps.wif === 'string' ? deps.wif : null);
    if (!wif) {
      return { ok: false, code: 'WIF_MISSING', error: 'could not resolve WIF from wallet or deps' };
    }
    signatureTemplate = new SignatureTemplate(wif);
  } catch (e) {
    return { ok: false, code: 'SIGN', error: `SignatureTemplate ctor threw: ${e.message}`, cause: e };
  }

  const buildEnv = await buildLockTx({
    sim: { ...sim, artifact },
    cashscript: cashscriptMod,
    signatureTemplate,
    feeSatPerByte: Number(stakeCfg.fee_sat_per_byte ?? 1),
  });
  if (!buildEnv.ok) {
    return buildEnv;
  }

  // Step 4: broadcast.
  const broadcastEnv = await broadcastLockTx({ txHex: buildEnv.txHex, provider });
  if (!broadcastEnv.ok) {
    return {
      ok: false,
      code: broadcastEnv.code,
      error: broadcastEnv.error,
      txHex: buildEnv.txHex,
      fee: buildEnv.fee?.toString(),
      cause: broadcastEnv.cause,
    };
  }

  log.info?.('stake.execute_lock.success', {
    txid: broadcastEnv.txid,
    amount_sats: lockAmount.toString(),
    stake_blocks: lockBlocks,
    fee_sats: buildEnv.fee?.toString() ?? null,
    user_address: userAddress,
    ts: nowMs,
  });

  return {
    ok: true,
    txid: broadcastEnv.txid,
    txHex: buildEnv.txHex,
    fee: buildEnv.fee?.toString(),
    amountSats: lockAmount.toString(),
    stakeBlocks: lockBlocks,
    simulation: { ...sim, artifact: undefined },
  };
}

/**
 * End-to-end unlock execution. Boot wallet, read WIF, find the
 * lock UTXO in the wallet's UTXO set, simulateUnlock,
 * buildUnlockTx, broadcastUnlockTx.
 *
 * @param {Object} args
 * @param {Object} args.cfg
 * @param {Object} args.wallet
 * @param {Object} args.provider
 * @param {Object} args.lockUtxo       — the lockNFT UTXO (required, on-chain)
 * @param {Object} [args.logger]
 * @param {Object} [args.deps]
 * @returns {Promise<Object>}
 */
export async function executeUnlock({ cfg, wallet, provider, lockUtxo, logger, deps = {} }) {
  const stakeCfg = resolveStakingConfig(cfg?.staking ?? {});
  const log = logger ?? { info: () => {}, warn: () => {}, error: () => {} };

  if (!wallet || typeof wallet.listUtxos !== 'function') {
    return { ok: false, code: 'WALLET_BOOT', error: 'wallet.listUtxos missing' };
  }
  if (!lockUtxo || !lockUtxo.txid) {
    return { ok: false, code: 'NO_LOCK_UTXO', error: 'lockUtxo required (txid + vout + commitment + tokenAmount)' };
  }
  if (typeof wallet.getWif !== 'function' && typeof wallet.wif !== 'string' && !(typeof deps.wif === 'string' && deps.wif.length > 0)) {
    return { ok: false, code: 'WIF_MISSING', error: 'wallet has no WIF and deps.wif not provided' };
  }
  if (typeof wallet.getPkh !== 'function') {
    return { ok: false, code: 'WIF_MISSING', error: 'wallet.getPkh() missing; cannot derive userPkh for unlock payout' };
  }

  const userPkh = wallet.getPkh();
  if (!isHex20(userPkh)) {
    return { ok: false, code: 'WIF_MISSING', error: 'wallet.getPkh() invalid length' };
  }

  let artifact;
  try {
    artifact = deps.artifact ?? await loadArtifact();
  } catch (e) {
    return { ok: false, code: 'ARTIFACT_LOAD', error: e.message };
  }
  if (!validateArtifact(artifact).ok) {
    return { ok: false, code: 'ARTIFACT_INVALID', error: 'inlined artifact failed sanity check' };
  }

  let sim;
  try {
    const simulateFn = deps.simulateUnlock ?? simulateUnlock;
    sim = simulateFn({ lockUtxo, userPkh });
  } catch (e) {
    return { ok: false, code: 'SIMULATE_VIOLATIONS', error: e.message, cause: e };
  }
  if (!sim || sim.ok !== true) {
    return { ok: false, code: 'SIMULATE_VIOLATIONS', error: sim?.error ?? 'simulateUnlock non-ok', violations: sim?.violations ?? [] };
  }

  let cashscriptMod;
  try {
    cashscriptMod = deps.cashscript ?? await import('cashscript');
  } catch (e) {
    return { ok: false, code: 'ARTIFACT_LOAD', error: `cashscript import threw: ${e.message}` };
  }
  let signatureTemplate;
  try {
    const SignatureTemplate = deps.SignatureTemplate ?? cashscriptMod.SignatureTemplate;
    const wif = (typeof wallet.getWif === 'function')
      ? wallet.getWif()
      : (typeof wallet.wif === 'string')
        ? wallet.wif
        : (typeof deps.wif === 'string' ? deps.wif : null);
    if (!wif) {
      return { ok: false, code: 'WIF_MISSING', error: 'could not resolve WIF from wallet or deps' };
    }
    signatureTemplate = new SignatureTemplate(wif);
  } catch (e) {
    return { ok: false, code: 'SIGN', error: `SignatureTemplate ctor threw: ${e.message}` };
  }

  const buildEnv = await buildUnlockTx({
    sim: { ...sim, artifact },
    cashscript: cashscriptMod,
    signatureTemplate,
    feeSatPerByte: Number(stakeCfg.fee_sat_per_byte ?? 1),
  });
  if (!buildEnv.ok) return buildEnv;

  const broadcastEnv = await broadcastUnlockTx({ txHex: buildEnv.txHex, provider });
  if (!broadcastEnv.ok) {
    return { ok: false, code: broadcastEnv.code, error: broadcastEnv.error, txHex: buildEnv.txHex, cause: broadcastEnv.cause };
  }

  log.info?.('stake.execute_unlock.success', {
    txid: broadcastEnv.txid,
    lock_txid: lockUtxo.txid,
    lock_vout: lockUtxo.vout,
    fee_sats: buildEnv.fee?.toString() ?? null,
    ts: Date.now(),
  });

  return {
    ok: true,
    txid: broadcastEnv.txid,
    txHex: buildEnv.txHex,
    fee: buildEnv.fee?.toString(),
    unlockedSats: sim.unlockedBchSats?.toString(),
    badgerCoinAmount: sim.badgerCoinAmount?.toString(),
    simulation: { ...sim, artifact: undefined },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function capabilityByte(cap) {
  if (cap === 'minting') return '02';
  if (cap === 'mutable') return '01';
  return '00';
}

function bufferToHex(buf) {
  if (!buf) return '';
  let hex = '';
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i] & 0xff;
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}

// ─────────────────────────────────────────────────────────────────────
// Exports for tests + downstream consumers
// ─────────────────────────────────────────────────────────────────────

export const _internals = Object.freeze({
  capabilityByte,
  bufferToHex,
  DEFAULT_ARTIFACT_PATH,
});

export const _meta = Object.freeze({
  module: 'src/staking/badger-stake-tx.mjs',
  version: 1,
  companion: 'src/staking/badger-stake.mjs (subset 1, shipped d62e81e)',
  artifact: 'src/staking/badger-stake-artifact.json (copied from LifestoneLabs/BadgerSurvivors/src/contracts/BadgerStake.json)',
  deferred: ['T58-3 trader-loop auto-wire', 'T58-4 dashboard tile', 'T58-5 unlock-cron'],
});
