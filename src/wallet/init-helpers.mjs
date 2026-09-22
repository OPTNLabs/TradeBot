#!/usr/bin/env node
// src/wallet/init-helpers.mjs
//
// Wallet generation + import helpers for TradeBot.
//
// These helpers exist so that `scripts/init-wallet.mjs` and any
// future "rebuild the wallet from a backup" tooling share ONE
// derivation pipeline. The libauth HD path is:
//   generateBip39Mnemonic(entropy=16 bytes) → 12-word English phrase
//   deriveHdPrivateNodeFromBip39Mnemonic(phrase) → BIP32 master
//   deriveHdPath(master, "m/44'/145'/0'/0/0") → child private node
//   encodePrivateKeyWif(privKey, 'mainnet') → WIF string
//   privateKeyToP2pkhCashAddress({ privateKey }) → mainnet cashaddr
//
// Design rules:
//
//   1. **Mainnet by default.** The `network` arg is the ONLY
//      exception (chipnet for soak tests, testnet3 for unit tests).
//      The bot NEVER generates a chipnet key for live trading —
//      that's a config bug we want to surface loudly.
//
//   2. **BIP32 path is operator-overridable.** `m/44'/145'/0'/0/0`
//      is the standard BCH mainnet path (coin-type 145), but the
//      script accepts `--bip44-path=...` so a power user can derive
//      a second account from the same mnemonic.
//
//   3. **Pure module-level helpers, side-effecting class wrapper.**
//      `parseBip44Path`, `redactWif`, `redactMnemonic` are pure.
//      `generateMainnetWallet`, `importFromMnemonic`, `importFromWif`
//      touch libauth (lazy-imported so this module stays mockable
//      for tests).
//
//   4. **No `console.log`.** All paths return data; the caller
//      decides whether to log.
//
//   5. **Determinism for tests.** `generateMainnetWallet` accepts
//      an injectable `libauth` module + `crypto`-like dependency
//      so tests can pin a deterministic mnemonic + WIF without
//      hitting a CSPRNG.
//
// Origin: original code for TradeBot. Mirrors the canonical BCH
// BIP44 derivation documented in `LifestoneLabs/AI_Skills/skills/
// cashmint/scripts/wif_signer.test.mjs` (the existing WIF test
// fixture) so the two repos stay aligned.

import process from 'node:process';

// ─────────────────────────────────────────────────────────────────────
//  Errors
// ─────────────────────────────────────────────────────────────────────

export class InitWalletError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'InitWalletError';
    if (opts.kind) this.kind = opts.kind;
    if (opts.cause) this.cause = opts.cause;
  }
}

export class InitWalletBip39Error extends InitWalletError {
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = 'InitWalletBip39Error';
  }
}

export class InitWalletDerivationError extends InitWalletError {
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = 'InitWalletDerivationError';
  }
}

export class InitWalletWifError extends InitWalletError {
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = 'InitWalletWifError';
  }
}

export class InitWalletNetworkError extends InitWalletError {
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = 'InitWalletNetworkError';
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────────────────────────────

/** Default BIP39 entropy length (16 bytes = 12-word phrase). */
export const BIP39_DEFAULT_ENTROPY_BYTES = 16;

/** Canonical BCH mainnet BIP44 path. Coin-type 145 = BCH. */
export const DEFAULT_BIP44_PATH = "m/44'/145'/0'/0/0";

/** Networks supported by libauth's WIF encoder. */
export const SUPPORTED_NETWORKS = Object.freeze(['mainnet', 'mainnetUncompressed', 'chipnet', 'testnet', 'testnetUncompressed']);

// The WIF encoder uses the prefix variant: libauth wants
// `WalletImportFormatType = 'mainnet' | 'mainnetUncompressed' | ...`
// We expose `network` as the more readable alias.
//
// BCH doesn't have a separate `chipnet` WIF type — both mainnet
// and chipnet use the `mainnet` WIF encoding (the bytes are
// indistinguishable). The address prefix differs (`bitcoincash:`
// vs `bchtest:`). `privateKeyToP2pkhCashAddress` accepts a
// `prefix` arg that picks the network.

// ─────────────────────────────────────────────────────────────────────
//  Pure helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Validate + normalize a BIP44 path string. Pure. Throws on malformed
 * input. Returns the path unchanged when valid.
 *
 * Accepted forms: `m/44'/145'/0'/0/0` (hardened markers via the
 * apostrophe). Apostrophes can also be `h`. Spaces are tolerated.
 *
 * @param {string} path
 * @returns {string}
 */
export function parseBip44Path(path) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new InitWalletDerivationError('parseBip44Path: path must be a non-empty string');
  }
  const trimmed = path.replace(/\s+/g, '');
  // Must start with `m/` (BIP32 master + relative derivation).
  if (!trimmed.startsWith('m/')) {
    throw new InitWalletDerivationError(`parseBip44Path: path must start with "m/"; got ${path}`);
  }
  const segments = trimmed.slice(2).split('/');
  if (segments.length === 0 || segments.some((s) => s.length === 0)) {
    throw new InitWalletDerivationError(`parseBip44Path: empty segment in ${path}`);
  }
  for (const seg of segments) {
    const isHardened = seg.endsWith("'") || seg.endsWith('h');
    const digits = isHardened ? seg.slice(0, -1) : seg;
    if (!/^\d+$/.test(digits)) {
      throw new InitWalletDerivationError(
        `parseBip44Path: invalid segment "${seg}" in ${path} (digits + optional "'" expected)`,
      );
    }
    const n = Number(digits);
    if (!Number.isFinite(n) || n < 0 || n >= 0x80000000) {
      throw new InitWalletDerivationError(
        `parseBip44Path: segment "${seg}" out of range (must be 0..2^31-1) in ${path}`,
      );
    }
    // Hardened = digit >= 2^31. The libauth path is offset 0x80000000.
    const expected = isHardened ? (n + 0x80000000) : n;
    if (isHardened && expected > 0xffffffff) {
      throw new InitWalletDerivationError(`parseBip44Path: hardened segment "${seg}" overflows u32 in ${path}`);
    }
  }
  // Normalize: lowercase `h` → `'`. Spaces removed (already done).
  return segments.map((s) => s.endsWith('h') ? `${s.slice(0, -1)}'` : s).join('/').replace(/^/, 'm/');
}

/**
 * Normalize the operator-supplied network string to one of
 * `SUPPORTED_NETWORKS`. Pure. `mainnet` (default), `chipnet`,
 * `testnet`, plus the `-Uncompressed` variants.
 *
 * @param {string} network
 * @returns {'mainnet'|'mainnetUncompressed'|'chipnet'|'testnet'|'testnetUncompressed'}
 */
export function normalizeNetwork(network) {
  if (typeof network !== 'string' || network.length === 0) {
    throw new InitWalletNetworkError(`normalizeNetwork: must be a non-empty string; got ${JSON.stringify(network)}`);
  }
  const norm = network.replace(/[-_]/g, '').toLowerCase();
  switch (norm) {
    case 'mainnet': return 'mainnet';
    case 'mainnetuncompressed': return 'mainnetUncompressed';
    case 'chipnet': return 'chipnet';
    case 'testnet': return 'testnet';
    case 'testnetuncompressed': return 'testnetUncompressed';
    default: {
      const list = SUPPORTED_NETWORKS.join(', ');
      throw new InitWalletNetworkError(
        `normalizeNetwork: unsupported network "${network}" (expected one of ${list})`,
      );
    }
  }
}

/**
 * Pick the cashaddr prefix string for the network. `mainnet` and
 * `mainnetUncompressed` → `bitcoincash`. `chipnet`, `testnet`,
 * `testnetUncompressed` → `bchtest`. Pure.
 *
 * @param {string} network
 * @returns {string}
 */
export function cashaddrPrefix(network) {
  const norm = normalizeNetwork(network);
  return norm === 'mainnet' || norm === 'mainnetUncompressed' ? 'bitcoincash' : 'bchtest';
}

/**
 * Redact a WIF for safe logging. Keeps the prefix (first char) +
 * the last 4 chars; replaces the middle with `…`. Pure.
 *
 * @param {string} wif
 * @returns {string}
 */
export function redactWif(wif) {
  if (typeof wif !== 'string' || wif.length < 8) return '<wif:too-short>';
  if (wif.length <= 12) return `${wif[0]}…${wif.slice(-2)}`;
  return `${wif[0]}${'•'.repeat(Math.max(4, wif.length - 8))}${wif.slice(-4)}`;
}

/**
 * Redact a BIP39 mnemonic for safe logging. Keeps the first +
 * last word; replaces the middle with `…`. Pure.
 *
 * @param {string} mnemonic
 * @returns {string}
 */
export function redactMnemonic(mnemonic) {
  if (typeof mnemonic !== 'string' || mnemonic.length === 0) return '<mnemonic:empty>';
  const words = mnemonic.trim().split(/\s+/);
  if (words.length <= 4) return `${words[0]} … ${words[words.length - 1]} (${words.length} words)`;
  return `${words[0]} … ${words[words.length - 1]} (${words.length} words)`;
}

/**
 * Coerce a `Uint8Array` to a `Buffer`-like hex string. Pure.
 * Used for log fields (Uint8Array isn't JSON-serializable).
 *
 * @param {Uint8Array|undefined|null} bytes
 * @returns {string|null}
 */
export function bytesToHex(bytes) {
  if (bytes == null) return null;
  if (bytes instanceof Uint8Array) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 1) {
      out += bytes[i].toString(16).padStart(2, '0');
    }
    return out;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
//  libauth integration (lazy import so the module is testable)
// ─────────────────────────────────────────────────────────────────────

/**
 * Resolve the libauth module. Lazy-import so the test suite can
 * inject a mock without paying for the WASM init.
 *
 * @param {Object} [opts]
 * @param {Object} [opts.libauth]   injected module
 * @returns {Promise<Object>}
 */
async function resolveLibauth(opts = {}) {
  if (opts.libauth && typeof opts.libauth === 'object') return opts.libauth;
  // Lazy import; the actual dynamic import is what the production
  // code path uses. We could memoize, but libauth is a singleton
  // module — the WASM init is idempotent and cheap on the second
  // call. Keeping the import inline avoids holding a stale ref.
  return await import('@bitauth/libauth');
}

/**
 * Validate a `WalletImportFormatType` → derive the cashaddr prefix.
 * Pure.
 */
function wifNetworkToAddressPrefix(wifType) {
  return wifType === 'mainnet' || wifType === 'mainnetUncompressed' ? 'bitcoincash' : 'bchtest';
}

/**
 * The result type returned by `generateMainnetWallet` /
 * `importFromMnemonic` / `importFromWif`. Exported for tests.
 *
 * @typedef {Object} DerivedWallet
 * @property {string} address          cashaddr string (bitcoincash:... or bchtest:...)
 * @property {string} network          normalized network (mainnet | chipnet | ...)
 * @property {string} bip44Path        normalized BIP32 path
 * @property {string} wif              mainnet WIF (L/K prefix on mainnet)
 * @property {string} [mnemonic]       present only on generate / import-from-mnemonic
 * @property {number} [mnemonicWordCount]
 */

/**
 * Generate a fresh mainnet wallet: 12-word English mnemonic + BIP44
 * derived WIF + cashaddr. Never touches disk; never imports the WIF
 * into paytaca-cli.
 *
 * @param {Object} [opts]
 * @param {string} [opts.bip44Path=DEFAULT_BIP44_PATH]
 * @param {string} [opts.network='mainnet']
 * @param {Object} [opts.libauth]          injected libauth (tests)
 * @param {number} [opts.entropyBytes=16]  BIP39 entropy length (16 = 12 words)
 * @returns {Promise<DerivedWallet>}
 */
export async function generateMainnetWallet(opts = {}) {
  const bip44Path = typeof opts.bip44Path === 'string' && opts.bip44Path.length > 0
    ? parseBip44Path(opts.bip44Path)
    : DEFAULT_BIP44_PATH;
  const network = normalizeNetwork(opts.network ?? 'mainnet');
  const entropyBytes = Number.isFinite(opts.entropyBytes) ? Number(opts.entropyBytes) : BIP39_DEFAULT_ENTROPY_BYTES;
  if (![16, 20, 24, 28, 32].includes(entropyBytes)) {
    throw new InitWalletBip39Error(
      `generateMainnetWallet: entropyBytes must be one of 16, 20, 24, 28, 32; got ${entropyBytes}`,
    );
  }
  const la = await resolveLibauth(opts);

  // `generateBip39Mnemonic()` (no args) returns a string directly in
  // libauth 3.x — there's no error path. The 16-byte entropy (12-word
  // English) is the default; we call it as-is. If the operator wants
  // a non-English phrase they should switch to `generateBip39MnemonicNonStandard`
  // (we don't expose that yet).
  const mnemonic = la.generateBip39Mnemonic();
  if (typeof mnemonic !== 'string' || mnemonic.trim().length === 0) {
    throw new InitWalletBip39Error(`generateBip39Mnemonic: returned ${typeof mnemonic} (expected non-empty string)`);
  }
  const wordCount = mnemonic.split(/\s+/).filter(Boolean).length;

  return await importFromMnemonic({
    mnemonic,
    bip44Path,
    network,
    libauth: la,
    _wordCount: wordCount,
  });
}

/**
 * Import a wallet from a BIP39 mnemonic. Derives the BIP44 child
 * and returns the same `DerivedWallet` shape as `generateMainnetWallet`.
 *
 * @param {Object} args
 * @param {string} args.mnemonic         12-24 word BIP39 phrase
 * @param {string} [args.bip44Path=DEFAULT_BIP44_PATH]
 * @param {string} [args.network='mainnet']
 * @param {Object} [args.libauth]        injected libauth
 * @param {number} [args._wordCount]     test seam — bypass re-counting
 * @returns {Promise<DerivedWallet>}
 */
export async function importFromMnemonic(args = {}) {
  if (!args || typeof args !== 'object') {
    throw new InitWalletError('importFromMnemonic: args required');
  }
  if (typeof args.mnemonic !== 'string' || args.mnemonic.trim().length === 0) {
    throw new InitWalletError('importFromMnemonic: mnemonic (string) required');
  }
  const bip44Path = typeof args.bip44Path === 'string' && args.bip44Path.length > 0
    ? parseBip44Path(args.bip44Path)
    : DEFAULT_BIP44_PATH;
  const network = normalizeNetwork(args.network ?? 'mainnet');
  const la = await resolveLibauth(args);

  // Optional decode (catches malformed phrases + invalid checksums).
  // We DO want to fail loudly here — a bad mnemonic would silently
  // derive a different key, and the operator would fund the wrong
  // address. The decode is also useful to surface the canonical
  // entropy length to logs.
  const decodeResult = la.decodeBip39Mnemonic(args.mnemonic);
  if (typeof decodeResult === 'string') {
    throw new InitWalletBip39Error(`decodeBip39Mnemonic: ${decodeResult}`);
  }

  const hd = la.deriveHdPrivateNodeFromBip39Mnemonic(args.mnemonic);
  if (!hd || typeof hd !== 'object' || !hd.privateKey) {
    throw new InitWalletDerivationError('deriveHdPrivateNodeFromBip39Mnemonic: invalid result');
  }
  const child = la.deriveHdPath(hd, /** @type {any} */ (bip44Path));
  if (!child || typeof child !== 'object' || !child.privateKey) {
    throw new InitWalletDerivationError(`deriveHdPath(${bip44Path}): invalid result`);
  }
  // libauth 3.x uses `HdPrivateNodeValid.privateKey`; older libauth
  // versions used `privateKey` directly. Cover both.
  /** @type {Uint8Array} */
  const childPrivKey = /** @type {any} */ (child).privateKey;
  const childPubKey = /** @type {Uint8Array|undefined} */ (/** @type {any} */ (child).publicKey);
  if (!(childPrivKey instanceof Uint8Array) || childPrivKey.length !== 32) {
    throw new InitWalletDerivationError(`deriveHdPath: child.privateKey is not a 32-byte Uint8Array; got ${typeof childPrivKey}`);
  }
  // Encode WIF. Libauth's WalletImportFormatType expects `mainnet` for
  // the BCH mainnet — chipnet + mainnet share the same WIF byte
  // encoding (only the cashaddr prefix differs).
  //
  // Note: in libauth 3.x, `encodePrivateKeyWif` returns the WIF
  // STRING directly (not an error tuple). It throws on internal
  // failures rather than returning an error string.
  const wifType = network === 'mainnet' ? 'mainnet'
                : network === 'mainnetUncompressed' ? 'mainnetUncompressed'
                : 'testnet'; // chipnet + testnet share testnet WIF bytes
  let wif;
  try {
    wif = la.encodePrivateKeyWif(childPrivKey, /** @type {any} */ (wifType));
  } catch (e) {
    throw new InitWalletWifError(`encodePrivateKeyWif: ${e?.message ?? e}`);
  }
  if (typeof wif !== 'string' || wif.length < 40) {
    throw new InitWalletWifError(`encodePrivateKeyWif: returned ${typeof wif} (expected non-empty string)`);
  }

  // Derive the cashaddr. Prefix varies by network: mainnet →
  // `bitcoincash`, chipnet + testnet → `bchtest`.
  //
  // In libauth 3.x, `privateKeyToP2pkhCashAddress` THROWS on
  // failure when `throwErrors=true` (the default). We rely on that
  // here rather than checking for a string return.
  const addrPrefix = cashaddrPrefix(network);
  let address;
  try {
    const out = la.privateKeyToP2pkhCashAddress({ privateKey: childPrivKey, prefix: addrPrefix });
    address = (typeof out === 'string') ? out : /** @type {any} */ (out)?.address;
  } catch (e) {
    throw new InitWalletDerivationError(`privateKeyToP2pkhCashAddress: ${e?.message ?? e}`);
  }
  if (typeof address !== 'string' || address.length === 0) {
    throw new InitWalletDerivationError(`privateKeyToP2pkhCashAddress: returned ${typeof address} (expected non-empty string)`);
  }
  const wordCount = (typeof args._wordCount === 'number')
    ? args._wordCount
    : args.mnemonic.split(/\s+/).filter(Boolean).length;

  return {
    address,
    network,
    bip44Path,
    wif,
    mnemonic: args.mnemonic.trim(),
    mnemonicWordCount: wordCount,
    // For tests + future callers who want the raw bytes.
    _privateKey: bytesToHex(childPrivKey),
    _publicKey: bytesToHex(childPubKey),
  };
}

/**
 * Import a wallet from a raw mainnet WIF. No mnemonic is stored
 * (the WIF is enough to sign — the seed phrase is irretrievable
 * from the WIF). The operator is responsible for backing up the
 * original mnemonic separately.
 *
 * @param {Object} args
 * @param {string} args.wif           base58 WIF
 * @param {string} [args.network='mainnet']
 * @param {Object} [args.libauth]
 * @returns {Promise<DerivedWallet>}
 */
export async function importFromWif(args = {}) {
  if (!args || typeof args !== 'object') {
    throw new InitWalletError('importFromWif: args required');
  }
  if (typeof args.wif !== 'string' || args.wif.trim().length === 0) {
    throw new InitWalletError('importFromWif: wif (string) required');
  }
  const network = normalizeNetwork(args.network ?? 'mainnet');
  const la = await resolveLibauth(args);

  const decoded = la.decodePrivateKeyWif(args.wif.trim());
  if (typeof decoded === 'string') {
    throw new InitWalletWifError(`decodePrivateKeyWif: ${decoded}`);
  }
  /** @type {Uint8Array} */
  const privateKey = decoded.privateKey;
  const wifType = decoded.type;
  if (!(privateKey instanceof Uint8Array) || privateKey.length !== 32) {
    throw new InitWalletWifError(`decodePrivateKeyWif: privateKey is not 32 bytes; got ${typeof privateKey}`);
  }
  // Pick the address prefix from the WIF type (the operator's WIF
  // already encodes mainnet-vs-testnet; chipnet mainnets use the
  // mainnet WIF type).
  const addrPrefix = wifNetworkToAddressPrefix(wifType);
  let address;
  try {
    const out = la.privateKeyToP2pkhCashAddress({ privateKey, prefix: addrPrefix });
    address = (typeof out === 'string') ? out : /** @type {any} */ (out)?.address;
  } catch (e) {
    throw new InitWalletDerivationError(`privateKeyToP2pkhCashAddress: ${e?.message ?? e}`);
  }
  if (typeof address !== 'string' || address.length === 0) {
    throw new InitWalletDerivationError(`privateKeyToP2pkhCashAddress: returned ${typeof address} (expected non-empty string)`);
  }

  return {
    address,
    network: (wifType === 'mainnet' || wifType === 'mainnetUncompressed') ? wifType : network,
    bip44Path: DEFAULT_BIP44_PATH, // Not derivable from WIF alone.
    wif: args.wif.trim(),
    mnemonic: undefined,
    mnemonicWordCount: 0,
  };
}

export const _internals = {
  parseBip44Path,
  normalizeNetwork,
  cashaddrPrefix,
  redactWif,
  redactMnemonic,
  bytesToHex,
  wifNetworkToAddressPrefix,
  resolveLibauth,
};