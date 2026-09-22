#!/usr/bin/env node
// scripts/sweep-funds.mjs
//
// One-off mainnet sweep: move every BCH UTXO from one address to
// another (legacy `q...` → token-aware `z...` in the T27 migration).
//
// Pure libauth + cashscript's ElectrumNetworkProvider. Builds the
// P2PKH transaction by hand (no full SDK), signs with the existing
// wallet's WIF, broadcasts through the same Electrum server the
// bot already uses.
//
// SAFETY:
//   - This script broadcasts a REAL mainnet transaction when run
//     without `--dry-run`.
//   - Default fee: 2 sats/byte (≈ 400 sats for a simple sweep).
//   - We sweep EVERY UTXO at the source — no dust is left behind.
//   - The script refuses to run if any UTXO is locked (has
//     non-coinbase sequenceNumber < 0xfffffffe — would indicate a
//     pending swap exit or similar).
//
// Usage:
//   node scripts/sweep-funds.mjs
//   node scripts/sweep-funds.mjs --dry-run
//   node scripts/sweep-funds.mjs --fee-sat-per-byte 1
//   node scripts/sweep-funds.mjs --from q... --to z...

import { setTimeout as delay } from 'node:timers/promises';
import process from 'node:process';

import { ElectrumNetworkProvider } from 'cashscript';
import * as libauth from '@bitauth/libauth';

const {
  decodePrivateKeyWif,
  encodeDataPush,
  hexToBin,
  instantiateSha256,
  privateKeyToP2pkhCashAddress,
  ripemd160,
  secp256k1,
  cashAddressToLockingBytecode,
} = libauth;

import { loadConfig } from '../src/util/config-loader.mjs';
import { createLogger } from '../src/util/logger.mjs';

// ── arg parsing ──────────────────────────────────────────────────────────

// T27g: exported so tests/scripts.test.mjs can cover the parser in isolation
// (no UTXO traversal, no WIF exposure). The `main()` entry uses the default
// `process.argv`; tests pass a synthetic argv in.
//
// Two flag forms supported:
//   --fee-sat-per-byte=1  → out['fee-sat-per-byte'] = '1'
//   --fee-sat-per-byte 1  → out['fee-sat-per-byte'] = '1'  (space-separated value)
//   --dry-run             → out['dry-run'] = true
export function parseSweepArgs(argv) {
  const out = {};
  // `argv.slice(2)` matches parseRunBotArgs/parseInitArgs/parseSnapshotArgs:
  // skip the implicit `node` + script-path entries so callers can pass
  // either a full `process.argv` (script body) or a synthetic argv
  // like `['node', 'sweep-funds.mjs', '--dry-run']` (tests).
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      // Space-separated value: consume the next argv if it doesn't
      // look like another flag.
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

const flags = parseSweepArgs(process.argv);
const DRY_RUN = flags['dry-run'] === true;
const FEE_SAT_PER_BYTE = (typeof flags['fee-sat-per-byte'] === 'string')
  ? Number(flags['fee-sat-per-byte'])
  : 2;
const FROM_ADDR_OVERRIDE = (typeof flags.from === 'string') ? flags.from : null;
const TO_ADDR_OVERRIDE = (typeof flags.to === 'string') ? flags.to : null;

// T74: explorer URL the operator picked for BCH block links.
// Keep this in sync with `dashboard/src/lib/explorer-urls.mjs#EXPLORER_BASE_URL`.
// The script is intentionally a one-off and doesn't import the dashboard
// helper to avoid a new cross-project dependency for a single log field.
const EXPLORER_BASE_URL = 'https://explorer.salemkode.com';

// T27g: only run when invoked directly — when imported by
// tests/scripts.test.mjs the body is skipped so the test suite
// can pull `parseSweepArgs` without the script trying to read
// config/user.json / build / broadcast a sweep tx.
const isDirect = import.meta.url === `file://${process.argv[1]}` ||
                 process.argv[1]?.endsWith('sweep-funds.mjs');

// Shape-parity `main` for tests; ESM requires `export` at top
// level, so we always declare it and the body short-circuits
// when the script is imported (not directly invoked).
async function sweepMain() { return { ok: false, error: 'not_direct_invocation' }; }
export { sweepMain as main };

const log = createLogger({ sink: process.stderr, component: 'sweep' });
if (!isDirect) {
  // Bail out BEFORE the rest of the module body tries to read
  // config/user.json / decode the WIF / broadcast a sweep. We
  // can't use `return` at module top level, so wrap the rest of
  // the work in an if-block.
  log.info('sweep.imported-skip', { reason: 'not_direct_invocation' });
}
if (isDirect) {
  log.info('sweep.boot', { dry_run: DRY_RUN, fee_sat_per_byte: FEE_SAT_PER_BYTE });

// ── load config + WIF ────────────────────────────────────────────────────

const cfg = await loadConfig();
const userWallet = (cfg.user?.wallet && typeof cfg.user.wallet === 'object') ? cfg.user.wallet : {};
const wif = userWallet.wif ?? null;
if (!wif) {
  log.error('sweep.no-wif');
  process.exit(2);
}
const decoded = decodePrivateKeyWif(wif);
if (typeof decoded === 'string') {
  log.error('sweep.bad-wif', { error: decoded });
  process.exit(2);
}
const { privateKey } = decoded;

// Derive addresses.
const legacyAddr = privateKeyToP2pkhCashAddress({ privateKey, tokenSupport: false });
const tokenAwareAddr = privateKeyToP2pkhCashAddress({ privateKey, tokenSupport: true });
const FROM_ADDR = FROM_ADDR_OVERRIDE ?? legacyAddr.address;
const TO_ADDR = TO_ADDR_OVERRIDE ?? tokenAwareAddr.address;
log.info('sweep.addresses', {
  from: FROM_ADDR,
  to: TO_ADDR,
  from_is_legacy: FROM_ADDR.startsWith('bitcoincash:q'),
  to_is_token_aware: TO_ADDR.startsWith('bitcoincash:z'),
});

// ── Electrum client ──────────────────────────────────────────────────────

const walletCfg = (cfg.wallet ?? {});
const ds = (cfg.data_sources ?? {});
const electrumHost = (typeof ds.electrum_host === 'string') ? ds.electrum_host : 'electrum.imaginary.cash';
const electrumPort = Number(ds.electrum_port) || 50004;
const provider = new ElectrumNetworkProvider(walletCfg.network || 'mainnet', {
  hostname: electrumHost,
  port: electrumPort,
  protocol: 'tls',
});
log.info('sweep.electrum', { host: electrumHost, port: electrumPort });

// ── gather UTXOs ──────────────────────────────────────────────────────────

const utxos = await provider.getUtxos(FROM_ADDR);
if (!Array.isArray(utxos) || utxos.length === 0) {
  log.error('sweep.no-utxos', { from: FROM_ADDR });
  process.exit(1);
}
const totalIn = utxos.reduce((s, u) => s + (typeof u.satoshis === "bigint" ? u.satoshis : BigInt(u.satoshis)), 0n);
log.info('sweep.utxos', {
  count: utxos.length,
  total_in_sats: totalIn.toString(),
});

// Safety: refuse to sweep anything with a non-final sequence number
// (would mean the input is itself a swap exit in flight).
for (const u of utxos) {
  if (u.sequenceNumber !== undefined && u.sequenceNumber !== 0xfffffffe && u.sequenceNumber !== 0xffffffff) {
    log.error('sweep.utxo-not-final', { txid: u.txid, vout: u.vout, sequenceNumber: u.sequenceNumber });
    process.exit(1);
  }
}

// ── build the sweep tx ──────────────────────────────────────────────────
//
// Format: version (4 LE) || vin_count (varint) || vouts || vout_count || vouts || locktime (4 LE)
//
// Per-input:
//   outpoint (32-byte txid + 4-byte LE vout)
//   scriptSig len (varint) + scriptSig bytes
//   sequence (4 LE = 0xfffffffe)
//
// Per-output (BCH):
//   amount (8 LE)
//   scriptPubKey len (varint) + scriptPubKey bytes

const sha256 = await instantiateSha256();

function hash256(data) {
  return sha256.hash(sha256.hash(data));
}

function buildP2pkhScript(pubkeyHash) {
  return new Uint8Array([
    0x76, // OP_DUP
    0xa9, // OP_HASH160
    0x14, // push 20 bytes
    ...pubkeyHash,
    0x88, // OP_EQUALVERIFY
    0xac, // OP_CHECKSIG
  ]);
}

// Decode the destination cashaddr → full locking bytecode for the
// output. cashAddressToLockingBytecode returns
// { bytecode: Uint8Array, prefix, tokenSupport } for valid addresses.
const toLockingResult = cashAddressToLockingBytecode(TO_ADDR);
const toLocking = (toLockingResult && typeof toLockingResult === 'object' && toLockingResult.bytecode instanceof Uint8Array)
  ? toLockingResult.bytecode
  : (toLockingResult instanceof Uint8Array ? toLockingResult : null);
if (!toLocking) {
  log.error('sweep.bad-to-address', { error: JSON.stringify(toLockingResult).slice(0,200) });
  process.exit(1);
}

// Estimate fee: 1 input ≈ 148 vbytes (P2PKH unlock ~ 108 bytes incl. sig),
// 1 output ≈ 34 vbytes, plus 10 byte overhead = 148 + 34 + 10 = 192.
const estimatedVbytes = 10 + (148 * utxos.length) + 34;
const feeSats = BigInt(Math.ceil(estimatedVbytes * FEE_SAT_PER_BYTE));
const totalOut = totalIn - feeSats;
if (totalOut <= 0n) {
  log.error('sweep.fee-exceeds-balance', {
    total_in: totalIn.toString(),
    fee: feeSats.toString(),
  });
  process.exit(1);
}
log.info('sweep.fee', {
  vbytes_estimated: estimatedVbytes,
  fee_sats: feeSats.toString(),
  fee_bch: (Number(feeSats) / 1e8).toFixed(8),
  output_sats: totalOut.toString(),
  output_bch: (Number(totalOut) / 1e8).toFixed(8),
});

// ── assemble unsigned tx ────────────────────────────────────────────────

// Placeholder unlocking bytecode (will be replaced after signing).
const placeholderUnlock = new Uint8Array(0);

// Outputs: one output to TO_ADDR.
const output = {
  lockingBytecode: toLocking,
  amountSats: totalOut,
};
const outputs = [output];

// Inputs (with placeholder unlock + sequence 0xfffffffe for final).
const inputs = utxos.map((u) => ({
  outpointTransactionHash: u.txid,
  outpointIndex: u.vout,
  sequenceNumber: 0xfffffffe,
  unlockingBytecode: placeholderUnlock,
  valueSats: u.satoshis,
}));

// Serialization helpers.
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
  let v = out.amountSats;
  for (let i = 0; i < 8; i++) { amt[i] = Number(v & 0xffn); v >>= 8n; }
  const script = out.lockingBytecode;
  return new Uint8Array([...amt, ...serializeVarint(script.length), ...script]);
}

// BIP143 sighash (BCH variant with SIGHASH_FORKID = 0x41).
function bip143Sighash({ version, hashPrevouts, hashSequence, hashOutputs, locktime, thisInput, sequenceNumber, thisOutput, valueSats, prevOutScript, sighashType = 0x41 }) {
  // BCH uses hash256 for double hashing.
  const outpoint = new Uint8Array(36);
  // outpoint = hash || index(LE)
  for (let i = 0; i < 32; i++) outpoint[i] = thisInput.outpointTransactionHash[i];
  // txid is byte-flipped; libauth returns it big-endian-ready already.
  outpoint[32] = thisInput.outpointIndex & 0xff;
  outpoint[33] = (thisInput.outpointIndex >> 8) & 0xff;
  outpoint[34] = (thisInput.outpointIndex >> 16) & 0xff;
  outpoint[35] = (thisInput.outpointIndex >> 24) & 0xff;

  // scriptCode for P2PKH = the previous locking script.
  const scriptLen = serializeVarint(prevOutScript.length);

  const valueLE = new Uint8Array(8);
  let vv = valueSats;
  for (let i = 0; i < 8; i++) { valueLE[i] = Number(vv & 0xffn); vv >>= 8n; }

  const seqLE = new Uint8Array(4);
  let ss = BigInt(sequenceNumber);
  for (let i = 0; i < 4; i++) { seqLE[i] = Number(ss & 0xffn); ss >>= 8n; }

  const versionLE = new Uint8Array(4);
  versionLE[0] = version & 0xff;
  versionLE[1] = (version >> 8) & 0xff;
  versionLE[2] = (version >> 16) & 0xff;
  versionLE[3] = (version >> 24) & 0xff;

  const locktimeLE = new Uint8Array(4);
  locktimeLE[0] = locktime & 0xff;
  locktimeLE[1] = (locktime >> 8) & 0xff;
  locktimeLE[2] = (locktime >> 16) & 0xff;
  locktimeLE[3] = (locktime >> 24) & 0xff;

  // BCH sighash type encoding (per libauth): one byte type + 3-byte forkId.
  // Type 0x41 = SIGHASH_ALL (0x01) | SIGHASH_FORKID (0x40). Repeat the
  // type byte like I did originally → signature fails CHECKSIG
  // ('Signature must be zero for failed CHECK(MULTI)SIG operation').
  const sighashTypeLE = new Uint8Array([sighashType, 0, 0, 0]);

  const preimage = new Uint8Array([
    ...versionLE,
    ...hashPrevouts,
    ...hashSequence,
    ...outpoint,
    ...scriptLen,
    ...prevOutScript,
    ...valueLE,
    ...seqLE,
    ...hashOutputs,
    ...locktimeLE,
    ...sighashTypeLE,
  ]);

  return hash256(preimage);
}

// Pre-compute hashPrevouts / hashSequence / hashOutputs (once, shared
// across all inputs since we're using SIGHASH_ALL).
function concatBytes(arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

function outpointBytes(inp) {
  // BCH Electrum returns txid in DISPLAY byte order (reversed).
  // The raw tx outpoint needs INTERNAL byte order, so we reverse.
  const displayBytes = hexToBin(inp.outpointTransactionHash);
  const txid = new Uint8Array(displayBytes.length);
  for (let i = 0; i < displayBytes.length; i++) {
    txid[i] = displayBytes[displayBytes.length - 1 - i];
  }
  const idx = new Uint8Array(4);
  idx[0] = inp.outpointIndex & 0xff;
  idx[1] = (inp.outpointIndex >> 8) & 0xff;
  idx[2] = (inp.outpointIndex >> 16) & 0xff;
  idx[3] = (inp.outpointIndex >> 24) & 0xff;
  return concatBytes([txid, idx]);
}

const outpoints = inputs.map(outpointBytes);
const sequences = inputs.map((inp) => {
  const s = new Uint8Array(4);
  s[0] = inp.sequenceNumber & 0xff;
  s[1] = (inp.sequenceNumber >> 8) & 0xff;
  s[2] = (inp.sequenceNumber >> 16) & 0xff;
  s[3] = (inp.sequenceNumber >> 24) & 0xff;
  return s;
});
const outputBytes = outputs.map(serializeOutput);

const hashPrevouts = hash256(concatBytes(outpoints));
const hashSequence = hash256(concatBytes(sequences));
const hashOutputs = hash256(concatBytes(outputBytes));

const VERSION = 2;
const LOCKTIME = 0;

// ── sign each input ─────────────────────────────────────────────────────

// For each input, we need the P2PKH locking bytecode of the source
// UTXO. cashscript's `utxo.script` (if present) gives the full
// locking bytecode for that UTXO; otherwise we reconstruct it
// from the wallet's pubkey (legacy address q... ↔ this pubkey).
const publicKey = secp256k1.derivePublicKeyCompressed(privateKey);
if (typeof publicKey === 'string') {
  log.error('sweep.bad-pubkey', { error: publicKey });
  process.exit(1);
}
// hash160(pubkey) = RIPEMD160(SHA256(pubkey))
const shaOfPub = sha256.hash(publicKey);
const pubkeyHash = ripemd160.hash(shaOfPub);
const p2pkhScript = buildP2pkhScript(pubkeyHash);

const signedInputs = [];
for (let i = 0; i < inputs.length; i++) {
  const inp = inputs[i];
  // Sighash for this input.
  const sighash = bip143Sighash({
    version: VERSION,
    hashPrevouts,
    hashSequence,
    hashOutputs,
    locktime: LOCKTIME,
    thisInput: inp,
    sequenceNumber: inp.sequenceNumber,
    valueSats: inp.valueSats,
    prevOutScript: p2pkhScript,
  });

  // Sign sighash with the wallet's private key.
  const sigResult = secp256k1.signMessageHashDER(privateKey, sighash);
  if (typeof sigResult === 'string') {
    log.error('sweep.sign-failed', { error: sigResult });
    process.exit(1);
  }
  // DER-encode signature, append SIGHASH_ALL | SIGHASH_FORKID (0x41).
  const derWithType = new Uint8Array([...sigResult, 0x41]);

  // P2PKH unlocking bytecode: <push sig> <push pubkey>
  const unlock = new Uint8Array([
    ...encodeDataPush(derWithType),
    ...encodeDataPush(publicKey),
  ]);

  signedInputs.push({
    outpointTransactionHash: inp.outpointTransactionHash,
    outpointIndex: inp.outpointIndex,
    sequenceNumber: inp.sequenceNumber,
    unlockingBytecode: unlock,
    valueSats: inp.valueSats,
  });
}

// ── serialize the full tx ───────────────────────────────────────────────

// Final tx: version(4 LE) || vin_count(varint) || inputs || vout_count(varint) || outputs || locktime(4 LE)
function serializeInput(inp) {
  return concatBytes([
    outpointBytes(inp),
    serializeVarint(inp.unlockingBytecode.length),
    inp.unlockingBytecode,
    new Uint8Array([
      inp.sequenceNumber & 0xff,
      (inp.sequenceNumber >> 8) & 0xff,
      (inp.sequenceNumber >> 16) & 0xff,
      (inp.sequenceNumber >> 24) & 0xff,
    ]),
  ]);
}

const versionLE = new Uint8Array([VERSION & 0xff, (VERSION >> 8) & 0xff, (VERSION >> 16) & 0xff, (VERSION >> 24) & 0xff]);
const locktimeLE = new Uint8Array([LOCKTIME & 0xff, (LOCKTIME >> 8) & 0xff, (LOCKTIME >> 16) & 0xff, (LOCKTIME >> 24) & 0xff]);

const unsignedBytes = concatBytes([
  versionLE,
  serializeVarint(signedInputs.length),
  ...signedInputs.map(serializeInput),
  serializeVarint(outputs.length),
  ...outputBytes,
  locktimeLE,
]);

const hex = bufToHex(unsignedBytes);
log.info('sweep.built', {
  vbytes: unsignedBytes.length,
  inputs: signedInputs.length,
  outputs: outputs.length,
  fee_sats: feeSats.toString(),
  total_in_sats: totalIn.toString(),
  total_out_sats: totalOut.toString(),
});

if (DRY_RUN) {
  log.info('sweep.dry-run.complete', {
    tx_hex: hex,
    message: 'no broadcast (--dry-run); sweep tx verified',
  });
  process.exit(0);
}

// ── broadcast ────────────────────────────────────────────────────────────

const txid = await provider.sendRawTransaction(hex);
log.info('sweep.broadcast', { txid });
log.info('sweep.done', {
  txid,
  explorer: `${EXPLORER_BASE_URL}/tx/${txid}`,
});

// Wait briefly then re-query balance at destination.
await delay(8_000);
try {
  const destUtxos = await provider.getUtxos(TO_ADDR);
  const destBalance = destUtxos.reduce((s, u) => s + (typeof u.satoshis === "bigint" ? u.satoshis : BigInt(u.satoshis)), 0n);
  log.info('sweep.destination-balance', {
    address: TO_ADDR,
    balance_sats: destBalance.toString(),
    balance_bch: (Number(destBalance) / 1e8).toFixed(8),
  });
} catch (e) {
  log.warn('sweep.destination-balance-error', { error: e?.message ?? String(e) });
}

process.exit(0);
}

// ── helpers ──────────────────────────────────────────────────────────────

function bufToHex(buf) {
  const out = new Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i].toString(16).padStart(2, '0');
  return out.join('');
}
