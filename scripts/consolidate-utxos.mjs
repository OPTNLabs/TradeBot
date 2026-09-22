#!/usr/bin/env node
// scripts/consolidate-utxos.mjs
//
// T60 — manual UTXO consolidation CLI.
//
// Pure libauth + cashscript's ElectrumNetworkProvider. Mirrors
// `scripts/sweep-funds.mjs` shape (P2PKH tx by hand, signs with
// the existing wallet's WIF, broadcasts through the same Electrum
// server the bot already uses) but is SCOPED to consolidating the
// ABOVE-DUST subset of the wallet's UTXOs into a single output
// (sweep-funds collapses EVERYTHING — this script leaves dust
// alone).
//
// SAFETY:
//   - Default fee: 1 sat/byte (≈ 200 sats for a 10-input consolidation;
//     cheaper than sweep-funds because consolidation is a normal op).
//   - Dust UTXOs (≤ `risk.utxo_consolidation_dust_sats`, default 1000 sats)
//     are EXCLUDED from the consolidation set — sweeping dust would
//     just move the bloat around.
//   - Below `risk.utxo_consolidation_min_balance_bch` (default 0.01 BCH)
//     we refuse to consolidate — the wallet is in reserve territory,
//     not fragmentation territory.
//   - If the wallet has only 1 above-dust UTXO, we no-op (you can't
//     consolidate a single input into itself).
//   - `--dry-run` skips BOTH the wallet boot AND the broadcast so a
//     CI / smoke run can never accidentally fire a real tx.
//
// T69 subset 1 adds an EXPORTED orchestrator `executeConsolidationTx`
// so the trader loop can call the same code path without spawning a
// child process. The function takes the broadcast + provider seams as
// injected parameters (mirrors the `scripts/sweep-funds.mjs` test
// pattern) and returns an enriched envelope the loop can surface as a
// `utxo_consolidation_auto` history event in T70.
//
// Usage:
//   node scripts/consolidate-utxos.mjs
//   node scripts/consolidate-utxos.mjs --dry-run
//   node scripts/consolidate-utxos.mjs --fee-sat-per-byte 2
//   node scripts/consolidate-utxos.mjs --dust-sats 500
//   node scripts/consolidate-utxos.mjs --min-sats 50000
//   node scripts/consolidate-utxos.mjs --quiet
//   node scripts/consolidate-utxos.mjs --json
//   node scripts/consolidate-utxos.mjs --chipnet

import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

import { ElectrumNetworkProvider } from 'cashscript';
import * as libauth from '@bitauth/libauth';

const {
  decodePrivateKeyWif,
  encodeDataPush,
  hexToBin,
  privateKeyToP2pkhCashAddress,
  ripemd160,
  secp256k1,
  cashAddressToLockingBytecode,
} = libauth;

import { loadConfig } from '../src/util/config-loader.mjs';
import { createLogger } from '../src/util/logger.mjs';
import {
  analyzeUtxoFragmentation,
  aboveDustUtxos,
  estimateConsolidationFeeForSet,
  totalUtxoSats,
} from '../src/wallet/utxo-consolidation.mjs';

// ── arg parsing ────────────────────────────────────────────────────────

/**
 * Parse `argv` into a flat flag bag. Mirrors the
 * `parseSweepFundsArgs` shape — `--key=value` and `--key value` both
 * supported, `--` ends parsing, `--flag` becomes `true` when no value
 * follows.
 *
 * Recognised flags:
 *   --dry-run                  skip wallet boot + broadcast (default false)
 *   --fee-sat-per-byte N       override the default 1 sat/byte fee
 *   --dust-sats N              override the dust threshold (default 1000)
 *   --min-sats N               minimum sat value to consider an above-dust
 *                              UTXO eligible (overrides --dust-sats when
 *                              larger; default = --dust-sats)
 *   --min-balance-bch N        override the wallet min-balance floor
 *                              (default 0.01 BCH)
 *   --quiet                    suppress the human-readable summary, only
 *                              print the JSON output (if --json) or
 *                              nothing on success
 *   --json                     print the analysis as JSON (machine-readable)
 *   --chipnet                  connect to chipnet instead of mainnet
 *
 * Exported so tests/scripts.test.mjs can cover the parser in
 * isolation (no UTXO traversal, no WIF exposure).
 */
export function parseConsolidateArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue;
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq >= 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  // Normalise boolean short forms.
  if (out['dry-run'] === true || out.dry === true || out.n === true) out['dry-run'] = true;
  if (out.quiet === true || out.q === true) out.quiet = true;
  if (out.json === true || out.j === true) out.json = true;
  if (out.chipnet === true) out.chipnet = true;
  return out;
}

// ── P2PKH tx builder (mirror of scripts/sweep-funds.mjs) ──────────────

/**
 * Build + sign + (optionally) broadcast a P2PKH consolidation tx
 * that collapses `inputs` into a single output at `outputAddress`.
 *
 * T69 EXPORTED this as `executeConsolidationTx` so the trader loop
 * can call the same code path without spawning a child process. The
 * function takes the broadcast + provider seams as injected
 * parameters (mirrors the `scripts/sweep-funds.mjs` test pattern) so
 * tests can stub the network roundtrip without ever touching
 * Electrum.
 *
 * Defensive against:
 *   - non-positive fee (returns `{ok:false, error:'fee_invalid'}`)
 *   - empty inputs (returns `{ok:false, error:'no_inputs'}`)
 *   - decode-WIF failure (returns `{ok:false, error:'wif_decode:<msg>'}`)
 *   - WIF/network mismatch (returns `{ok:false, error:'wif_network:<type>'}`)
 *   - total-in ≤ fee (returns `{ok:false, error:'total_below_fee'}`)
 *   - decode-output-address failure
 *   - sighash / sign / encode failures
 *   - broadcast throw (returns `{ok:false, error:'broadcast:<msg>'}`)
 *
 * Enriched envelope (T69):
 *   `{ ok, txid, fee_sats, output_sats, total_in_sats,
 *      input_count, output_count, broadcast_ms, source, error? }`
 * where `source:'dry-run'` means the caller asked for a build without
 * broadcast (no `broadcast` callback supplied) and `'broadcast'` means
 * a real network broadcast was attempted. `broadcast_ms` is 0 in
 * dry-run and the wall-clock duration of the broadcast call
 * otherwise (so the loop can log latency).
 *
 * Returns `{ok, txid?, error?, feeSats?, outputSats?}`.
 */
export async function executeConsolidationTx({
  inputs,
  outputAddress,
  feeSatPerByte,
  wif,
  network,
  broadcast,
  providerFactory,
  logger,
  nowMs,
}) {
  const safeNow = (typeof nowMs === 'function') ? nowMs : (() => Date.now());
  const safeLog = (logger && typeof logger.info === 'function')
    ? logger
    : { info() {}, warn() {}, error() {} };
  if (!Array.isArray(inputs) || inputs.length === 0) {
    return { ok: false, error: 'no_inputs' };
  }
  if (!Number.isFinite(feeSatPerByte) || feeSatPerByte <= 0) {
    return { ok: false, error: 'fee_invalid' };
  }
  if (typeof outputAddress !== 'string' || outputAddress.length === 0) {
    return { ok: false, error: 'output_address_missing' };
  }
  if (typeof wif !== 'string' || wif.length < 40) {
    return { ok: false, error: 'wif_missing_or_short' };
  }
  const decodedWif = decodePrivateKeyWif(wif);
  if (typeof decodedWif === 'string') {
    return { ok: false, error: `wif_decode:${decodedWif}` };
  }
  if (decodedWif.type !== network) {
    return { ok: false, error: `wif_network:${decodedWif.type}` };
  }
  const privateKey = decodedWif.privateKey;

  // Estimate fee (P2PKH input ~180 bytes, P2PKH output ~34 bytes, +10 bytes header).
  const sizeBytes = 10 + (inputs.length * 180) + 34;
  const feeSats = BigInt(Math.ceil(sizeBytes * feeSatPerByte));
  const totalIn = inputs.reduce((acc, u) => acc + BigInt(u.satoshies ?? u.sats ?? 0), 0n);
  if (totalIn <= feeSats) {
    return { ok: false, error: 'total_below_fee', total_in_sats: totalIn.toString(), fee_sats: feeSats.toString() };
  }
  const outputSats = totalIn - feeSats;

  // Build outputs.
  const outputLock = cashAddressToLockingBytecode(outputAddress);
  if (typeof outputLock === 'string') {
    return { ok: false, error: `address_decode:${outputLock}` };
  }
  // libauth 3.x uses `valueSatoshis` (no -ies typo). My BIP143 helper
  // reads `valueSatoshies ?? amountSats ?? 0` so this is compatible
  // with both names.
  const output = {
    lockingBytecode: outputLock.bytecode,
    valueSatoshis: outputSats,
  };

  // Build inputs (libauth's `encodeTransaction` shape).
  // `outpointTransactionHash` must be the DISPLAY-order txid — the
  // encoder reverses it for the wire (internal byte order).
  const txInputs = inputs.map((u) => {
    let txidBin;
    if (u.txid instanceof Uint8Array) {
      txidBin = u.txid;
    } else if (typeof u.txid === 'string' && u.txid.length > 0) {
      txidBin = hexToBin(u.txid);
    } else {
      txidBin = new Uint8Array(0);
    }
    return {
      outpointTransactionHash: txidBin,
      outpointIndex: Number(u.vout ?? 0),
      sequenceNumber: 0xfffffffe,
      unlockingBytecode: new Uint8Array(0), // filled in during sign loop
    };
  });

  const transaction = {
    inputs: txInputs,
    outputs: [output],
    locktime: 0, // libauth's encodeTransactionCommon expects a number
    version: 2,
  };

  // Compute the source address's pkh (we use it to compute the sighash
  // preimage and to build the unlocking script template).
  const sourceAddrObj = privateKeyToP2pkhCashAddress({ privateKey, prefix: network === 'mainnet' ? 'bitcoincash' : 'bchtest' });
  const sourceAddress = (sourceAddrObj && typeof sourceAddrObj === 'object' && typeof sourceAddrObj.address === 'string')
    ? sourceAddrObj.address
    : (typeof sourceAddrObj === 'string' ? sourceAddrObj : null);
  if (!sourceAddress) {
    return { ok: false, error: 'source_address_decode:empty' };
  }
  const sourceLock = cashAddressToLockingBytecode(sourceAddress);
  if (typeof sourceLock === 'string') {
    return { ok: false, error: `source_address_decode:${sourceLock}` };
  }

  // Sign each input.
  for (let i = 0; i < txInputs.length; i++) {
    const utxo = inputs[i];
    const inputValue = BigInt(utxo.satoshies ?? utxo.sats ?? 0);
    const sighash = computeBchSighash({
      transaction,
      inputIndex: i,
      inputValue,
      sourceLockingBytecode: sourceLock.bytecode,
    });
    if (typeof sighash === 'string') {
      return { ok: false, error: `sighash:${sighash}` };
    }
    const signature = secp256k1.signMessageHashCompact(sighash, privateKey);
    if (typeof signature === 'string') {
      return { ok: false, error: `sign:${signature}` };
    }
    // low-S enforcement (BCH requires it).
    const sigLowS = forceLowS(signature);
    const sigWithHashtype = new Uint8Array(sigLowS.length + 1);
    sigWithHashtype.set(sigLowS, 0);
    sigWithHashtype[sigLowS.length] = 0x41; // SIGHASH_ALL|FORKID
    const unlockingBytecode = encodeDataPush(sigWithHashtype);
    txInputs[i].unlockingBytecode = unlockingBytecode;
  }

  // Serialise.
  const serialized = libauth.encodeTransaction(transaction);
  if (typeof serialized === 'string') {
    return { ok: false, error: `encode:${serialized}` };
  }
  const hex = libauth.binToHex(serialized);

  // Determine the broadcast source flag.
  // - `providerFactory` only matters if the caller wants the
  //   function to construct a default Electrum provider (legacy
  //   path). The trader loop (T70) supplies its own `broadcast`
  //   seam so this stays a no-op.
  // - If `broadcast` is supplied and the caller wants a real
  //   network roundtrip, the source is 'broadcast'; otherwise
  //   'dry-run'.
  const wantBroadcast = typeof broadcast === 'function';
  let txid = null;
  let broadcastMs = 0;
  let source = 'dry-run';
  if (wantBroadcast) {
    source = 'broadcast';
    const t0 = safeNow();
    try {
      txid = await broadcast({ hex, providerFactory });
    } catch (e) {
      safeLog.warn('consolidate.broadcast.error', {
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
        input_count: inputs.length,
      });
      return {
        ok: false,
        error: `broadcast:${e?.message ?? String(e)}`,
        fee_sats: feeSats.toString(),
        output_sats: outputSats.toString(),
        total_in_sats: totalIn.toString(),
        input_count: inputs.length,
        output_count: 1,
        broadcast_ms: safeNow() - t0,
        source,
      };
    }
    broadcastMs = safeNow() - t0;
  }

  return {
    ok: true,
    txid,
    fee_sats: feeSats.toString(),
    output_sats: outputSats.toString(),
    total_in_sats: totalIn.toString(),
    input_count: inputs.length,
    output_count: 1,
    broadcast_ms: broadcastMs,
    source,
  };
}

// Backward-compatible alias for the original CLI code path (kept so
// the T60-era sweep through `main()` doesn't need to change). New
// callers should prefer `executeConsolidationTx`.
export const broadcastConsolidation = executeConsolidationTx;

// Re-implementations of the BCH sighash + low-S helpers. Kept local
// because scripts/sweep-funds.mjs doesn't export them — extracting
// into a shared helper is its own refactor.
function computeBchSighash({ transaction, inputIndex, inputValue, sourceLockingBytecode }) {
  // BIP143 sighash (BCH variant with SIGHASH_FORKID = 0x41).
  //
  // The original T60-era helper relied on libauth's
  // `generateSigningSerialization`, which was REMOVED in libauth
  // 3.x (only the legacy `hash256(...)` + manual BIP143 wrapper
  // remain). T69 subset 1 ports the BIP143 implementation from
  // `scripts/sweep-funds.mjs` so live broadcasts actually sign a
  // valid tx. Same FORKID byte (0x41), same P2PKH preimage layout,
  // same `hash256` double-hash.
  //
  // Mirrors `scripts/sweep-funds.mjs#bip143Sighash` exactly so the
  // two scripts stay parallel — the manual broadcast in either
  // path produces a signature the other would accept.
  const inputs = Array.isArray(transaction.inputs) ? transaction.inputs : [];
  const outputs = Array.isArray(transaction.outputs) ? transaction.outputs : [];
  const outpoints = inputs.map((inp) => outpointBytes(inp));
  const sequences = inputs.map((inp) => {
    const s = new Uint8Array(4);
    const seq = BigInt(typeof inp.sequenceNumber === 'bigint' ? inp.sequenceNumber : (inp.sequenceNumber ?? 0xfffffffe));
    s[0] = Number(seq & 0xffn);
    s[1] = Number((seq >> 8n) & 0xffn);
    s[2] = Number((seq >> 16n) & 0xffn);
    s[3] = Number((seq >> 24n) & 0xffn);
    return s;
  });
  const outputBytes = outputs.map(serializeOutput);

  const hashPrevouts = libauth.hash256(concatBytes(outpoints));
  const hashSequence = libauth.hash256(concatBytes(sequences));
  const hashOutputs = libauth.hash256(concatBytes(outputBytes));

  const VERSION = 2;
  const LOCKTIME = 0;
  const sighashTypeLE = new Uint8Array([0x41, 0, 0, 0]); // SIGHASH_ALL | SIGHASH_FORKID

  const inp = inputs[inputIndex];
  if (!inp) return 'input_index_out_of_range';

  const outpoint = outpointBytes(inp);
  const scriptLen = serializeVarint(sourceLockingBytecode.length);

  const valueLE = new Uint8Array(8);
  let vv = BigInt(inputValue);
  for (let i = 0; i < 8; i++) { valueLE[i] = Number(vv & 0xffn); vv >>= 8n; }

  const seqLE = new Uint8Array(4);
  let ss = BigInt(typeof inp.sequenceNumber === 'bigint' ? inp.sequenceNumber : (inp.sequenceNumber ?? 0xfffffffe));
  for (let i = 0; i < 4; i++) { seqLE[i] = Number(ss & 0xffn); ss >>= 8n; }

  const versionLE = new Uint8Array(4);
  versionLE[0] = VERSION & 0xff;
  versionLE[1] = (VERSION >> 8) & 0xff;
  versionLE[2] = (VERSION >> 16) & 0xff;
  versionLE[3] = (VERSION >> 24) & 0xff;

  const locktimeLE = new Uint8Array(4);
  locktimeLE[0] = LOCKTIME & 0xff;
  locktimeLE[1] = (LOCKTIME >> 8) & 0xff;
  locktimeLE[2] = (LOCKTIME >> 16) & 0xff;
  locktimeLE[3] = (LOCKTIME >> 24) & 0xff;

  const preimage = new Uint8Array([
    ...versionLE,
    ...hashPrevouts,
    ...hashSequence,
    ...outpoint,
    ...scriptLen,
    ...sourceLockingBytecode,
    ...valueLE,
    ...seqLE,
    ...hashOutputs,
    ...locktimeLE,
    ...sighashTypeLE,
  ]);
  return libauth.hash256(preimage);
}

// Re-implementations of the BCH BIP143 sighash helpers. Kept local
// because `scripts/sweep-funds.mjs` doesn't export them — extracting
// into a shared helper is its own refactor (T60-3 was the
// same recommendation for sweep-funds).

function outpointBytes(inp) {
  // BCH outpoint = txid-internal-bytes (LE display) || vout (LE 4)
  // cashscript/electrum returns `txid` in DISPLAY byte order
  // (reversed). The raw tx outpoint needs INTERNAL byte order.
  let txidBytes;
  if (inp.txid instanceof Uint8Array) {
    txidBytes = new Uint8Array(inp.txid.length);
    for (let i = 0; i < inp.txid.length; i++) txidBytes[i] = inp.txid[inp.txid.length - 1 - i];
  } else if (typeof inp.txid === 'string') {
    const decoded = hexToBin(inp.txid);
    txidBytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) txidBytes[i] = decoded[decoded.length - 1 - i];
  } else {
    return 'txid_missing';
  }
  const idx = new Uint8Array(4);
  const v = Number(inp.vout ?? 0);
  idx[0] = v & 0xff;
  idx[1] = (v >> 8) & 0xff;
  idx[2] = (v >> 16) & 0xff;
  idx[3] = (v >> 24) & 0xff;
  return concatBytes([txidBytes, idx]);
}

function concatBytes(arrays) {
  let total = 0;
  for (const a of arrays) {
    if (!(a instanceof Uint8Array)) return 'concat_bytes_invalid';
    total += a.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

function serializeVarint(n) {
  const out = [];
  let v = BigInt(n);
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return new Uint8Array(out);
}

function serializeOutput(out) {
  // BCH: amount (8 LE) || scriptPubKeyLen (varint) || scriptPubKey
  const amt = new Uint8Array(8);
  let v = BigInt(out.valueSatoshies ?? out.amountSats ?? 0);
  for (let i = 0; i < 8; i++) { amt[i] = Number(v & 0xffn); v >>= 8n; }
  const script = out.lockingBytecode;
  return new Uint8Array([...amt, ...serializeVarint(script.length), ...script]);
}

function forceLowS(sig64) {
  // sig64 is a 64-byte compact signature (r || s). If s > n/2 we
  // negate it (s = n - s). n is the secp256k1 curve order.
  const n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
  const halfN = n >> 1n;
  const s = bytesToBigInt(sig64.slice(32, 64));
  if (s <= halfN) return sig64;
  const newS = n - s;
  const out = new Uint8Array(sig64.length);
  out.set(sig64.slice(0, 32), 0);
  out.set(bigIntToBytes(newS, 32), 32);
  return out;
}

function bytesToBigInt(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}
function bigIntToBytes(n, len) {
  const out = new Uint8Array(len);
  let v = n;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

// ── entry point ─────────────────────────────────────────────────────────

/**
 * Pure-shape main so tests can exercise every path with a mocked
 * wallet + provider. Default `argv` is `process.argv`.
 *
 * @param {object} [deps]
 * @param {Function} [deps.argv]       full argv (default process.argv)
 * @param {Function} [deps.loadConfig] config loader (default loadConfig)
 * @param {Function} [deps.bootWallet] wallet boot fn; receives `{cfg, logger}`
 *                                       and returns `{listUtxos, getAddress}`.
 *                                       Default: `bootLibAuthBchWallet` below.
 * @param {Function} [deps.provider]   ElectrumNetworkProvider factory
 * @param {Function} [deps.broadcast]  async ({hex}) -> txid
 * @param {object}   [deps.logger]     structured logger
 * @param {number}   [deps.nowMs]      injected clock for tests
 * @returns {Promise<number>}           process exit code (0 ok / 1 found+acted / 2 wallet-error / 3 bad-args / 4 below-min-balance / 5 no-action-needed)
 */
export async function main(deps = {}) {
  const argv = deps.argv ?? process.argv;
  const args = parseConsolidateArgs(argv);

  // Injectable defaults — keep the production wiring identical to
  // sweep-funds.mjs so the two scripts stay parallel.
  const loadConfigFn = deps.loadConfig ?? loadConfig;
  const logger = deps.logger ?? createLogger({ level: args.quiet ? 'warn' : 'info', name: 'consolidate-utxos' });
  const nowMs = deps.nowMs ?? Date.now();

  // Resolve fee / dust / min-balance defaults from config + flag overrides.
  let cfg;
  try {
    cfg = await loadConfigFn();
  } catch (e) {
    logger.error('consolidate.config.error', { err_message: e?.message ?? String(e) });
    if (args.json) console.log(JSON.stringify({ ok: false, error: 'config_load_failed' }));
    return 2;
  }

  const riskCfg = (cfg && typeof cfg.risk === 'object') ? cfg.risk : {};
  const dustSats = (() => {
    const v = args['dust-sats'];
    if (v !== undefined) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) return BigInt(Math.floor(n));
    }
    if (typeof riskCfg.utxo_consolidation_dust_sats === 'number' && Number.isFinite(riskCfg.utxo_consolidation_dust_sats)) {
      return BigInt(Math.floor(riskCfg.utxo_consolidation_dust_sats));
    }
    return 1000n;
  })();
  const minSats = (() => {
    const v = args['min-sats'];
    if (v !== undefined) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) return BigInt(Math.floor(n));
    }
    return dustSats; // min-sats defaults to dust-sats (same gate)
  })();
  const minBalanceBch = (() => {
    const v = args['min-balance-bch'];
    if (v !== undefined) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) return n;
    }
    if (typeof riskCfg.utxo_consolidation_min_balance_bch === 'number' && Number.isFinite(riskCfg.utxo_consolidation_min_balance_bch)) {
      return riskCfg.utxo_consolidation_min_balance_bch;
    }
    return 0.01;
  })();
  const minBalanceSats = BigInt(Math.floor(minBalanceBch * 1e8));
  const feeSatPerByte = (() => {
    const v = args['fee-sat-per-byte'];
    if (v !== undefined) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return 1;
  })();
  const dryRun = args['dry-run'] === true;
  const useJson = args.json === true;
  const network = args.chipnet ? 'chipnet' : 'mainnet';
  const electrumUrl = args.chipnet ? (cfg.chipnet_electrum_url ?? cfg.electrum_url) : cfg.electrum_url;
  if (!electrumUrl) {
    logger.error('consolidate.config.electrum.missing', {});
    if (useJson) console.log(JSON.stringify({ ok: false, error: 'electrum_url_missing' }));
    return 2;
  }

  // Boot the wallet lazily (only when we'll broadcast). Dry-run
  // parses + analyses + prints without ever touching the WIF.
  let wallet = null;
  if (!dryRun) {
    try {
      wallet = await (deps.bootWallet ?? bootLibAuthBchWallet)({ cfg, logger, electrumUrl, network });
    } catch (e) {
      logger.error('consolidate.wallet.boot.error', { err_message: e?.message ?? String(e) });
      if (useJson) console.log(JSON.stringify({ ok: false, error: 'wallet_boot_failed', err_message: e?.message ?? String(e) }));
      return 2;
    }
  }

  // Fetch UTXOs (we still need them in dry-run for the analysis).
  let utxos;
  try {
    utxos = wallet
      ? await wallet.listUtxos()
      : await fetchUtxosViaProvider({
          cfg, electrumUrl, network,
          address: cfg.wallet?.address,
          logger,
          providerFactory: deps.provider,
        });
  } catch (e) {
    logger.error('consolidate.utxos.error', { err_message: e?.message ?? String(e) });
    if (useJson) console.log(JSON.stringify({ ok: false, error: 'utxos_failed', err_message: e?.message ?? String(e) }));
    return 2;
  }
  if (!Array.isArray(utxos)) {
    logger.error('consolidate.utxos.invalid', {});
    if (useJson) console.log(JSON.stringify({ ok: false, error: 'utxos_not_array' }));
    return 2;
  }

  // Run the analysis with `minSats` (the operator's explicit
  // floor for "above-dust + above-min") so a CLI override trumps
  // the dust default.
  const analysis = analyzeUtxoFragmentation(utxos, {
    requiredSats: null, // CLI is informational — caller decides whether to consolidate
    dustThresholdSats: dustSats,
    minBalanceSats,
  });

  // Filter further with minSats (CLI-only — distinct from dust so
  // the operator can run `--dust-sats 500 --min-sats 50000` to
  // ignore everything below 50k sats).
  const consolidatedSet = analysis.consolidatedUtxos.filter((u) => BigInt(u.satoshies ?? u.sats ?? 0) >= minSats);
  const consolidatedCount = consolidatedSet.length;

  // Decision tree.
  if (analysis.reason === 'below_min_balance') {
    if (!args.quiet) {
      console.log(`[consolidate] refusing: wallet total ${(Number(analysis.totalSats) / 1e8).toFixed(8)} BCH is below the ${minBalanceBch} BCH reserve floor.`);
    }
    if (useJson) console.log(JSON.stringify({ ok: false, reason: analysis.reason, total_sats: analysis.totalSats.toString(), min_balance_sats: minBalanceSats.toString() }));
    return 4;
  }

  if (consolidatedCount < 2) {
    if (!args.quiet) {
      console.log(`[consolidate] no action: ${consolidatedCount} above-${minSats}-sat UTXO${consolidatedCount === 1 ? '' : 's'} (need ≥ 2 to consolidate). wallet total: ${(Number(analysis.totalSats) / 1e8).toFixed(8)} BCH across ${utxos.length} UTXO${utxos.length === 1 ? '' : 's'} (${analysis.dustCount} dust).`);
    }
    if (useJson) {
      console.log(JSON.stringify({
        ok: true,
        action: 'none',
        reason: consolidatedCount === 0 ? 'no_above_min_utxos' : 'single_above_min_utxo',
        total_sats: analysis.totalSats.toString(),
        largest_sats: analysis.largestSats.toString(),
        dust_count: analysis.dustCount,
        consolidated_count: consolidatedCount,
      }));
    }
    return 5;
  }

  const feeEstimate = estimateConsolidationFeeForSet(consolidatedSet, feeSatPerByte);
  const totalInSats = totalUtxoSats(consolidatedSet);
  const projectedOutputSats = totalInSats - feeEstimate;

  if (projectedOutputSats <= 0n) {
    if (!args.quiet) {
      console.log(`[consolidate] refusing: above-${minSats}-sat set sums to ${totalInSats.toString()} sats but fee estimate is ${feeEstimate.toString()} sats at ${feeSatPerByte} sat/byte. Lower --fee-sat-per-byte or raise --min-sats.`);
    }
    if (useJson) console.log(JSON.stringify({ ok: false, reason: 'total_below_fee', total_sats: totalInSats.toString(), fee_estimate_sats: feeEstimate.toString() }));
    return 4;
  }

  if (dryRun) {
    if (!args.quiet) {
      console.log(`[consolidate] DRY-RUN: would consolidate ${consolidatedCount} UTXO${consolidatedCount === 1 ? '' : 's'} (${totalInSats.toString()} sats) → single output of ${projectedOutputSats.toString()} sats (fee: ${feeEstimate.toString()} sats at ${feeSatPerByte} sat/byte). wallet address: ${cfg.wallet?.address}.`);
    }
    if (useJson) {
      console.log(JSON.stringify({
        ok: true,
        action: 'dry_run',
        consolidated_count: consolidatedCount,
        total_sats: totalInSats.toString(),
        fee_estimate_sats: feeEstimate.toString(),
        projected_output_sats: projectedOutputSats.toString(),
        fee_sat_per_byte: feeSatPerByte,
        wallet_address: cfg.wallet?.address,
      }));
    }
    return 0;
  }

  // Broadcast.
  const broadcastFn = deps.broadcast ?? (async ({ hex }) => {
    const provider = deps.provider ? deps.provider({ electrumUrl, network }) : new ElectrumNetworkProvider(electrumUrl, network);
    return provider.broadcast(hex);
  });

  const result = await executeConsolidationTx({
    inputs: consolidatedSet,
    outputAddress: cfg.wallet.address,
    feeSatPerByte,
    wif: wallet.wif,
    network,
    broadcast: broadcastFn,
    logger,
  });
  if (!result.ok) {
    logger.error('consolidate.broadcast.failed', { error: result.error });
    if (useJson) console.log(JSON.stringify({ ok: false, error: result.error }));
    return 2;
  }
  if (!args.quiet) {
    console.log(`[consolidate] broadcast txid=${result.txid ?? '(no provider broadcast)'} — ${consolidatedCount} inputs (${totalInSats.toString()} sats) → ${result.output_sats} sat output, fee=${result.fee_sats} sat (broadcast ${result.broadcast_ms}ms).`);
  }
  if (useJson) {
    console.log(JSON.stringify({
      ok: true,
      action: 'broadcast',
      txid: result.txid,
      consolidated_count: consolidatedCount,
      total_sats: totalInSats.toString(),
      fee_sats: result.fee_sats,
      output_sats: result.output_sats,
      broadcast_ms: result.broadcast_ms,
      source: result.source,
    }));
  }
  return 1; // 1 = "found fragmented, consolidated"
}

// ── production wallet boot (kept here so tests don't import libauth) ────

async function bootLibAuthBchWallet({ cfg, logger, electrumUrl, network }) {
  const { LibAuthBchWallet } = await import('../src/wallet/libauth.mjs');
  const w = new LibAuthBchWallet({
    cfg: cfg.wallet,
    logger,
    electrumUrl,
    network,
    timeoutMs: 10000,
  });
  await w.init();
  return w;
}

async function fetchUtxosViaProvider({ electrumUrl, network, address, logger, providerFactory }) {
  const provider = providerFactory ? providerFactory({ electrumUrl, network }) : new ElectrumNetworkProvider(electrumUrl, network);
  if (!address) {
    throw new Error('consolidate: cfg.wallet.address missing — cannot fetch UTXOs in dry-run');
  }
  const utxos = await provider.getUtxos(address);
  return Array.isArray(utxos) ? utxos : [];
}

// Only run when invoked directly (not when imported by tests).
const isDirectInvocation = (() => {
  try {
    const arg0 = process.argv[1] ?? '';
    return import.meta.url === `file://${arg0}` || arg0.endsWith('consolidate-utxos.mjs');
  } catch { return false; }
})();
if (isDirectInvocation) {
  main().then((code) => {
    process.exit(code);
  }, (e) => {
    console.error('[consolidate] unexpected error:', e?.message ?? String(e));
    process.exit(2);
  });
}
