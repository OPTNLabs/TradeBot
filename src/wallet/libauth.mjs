#!/usr/bin/env node
// src/wallet/libauth.mjs
//
// LibAuth + cashscript-Electrum wallet adapter for TradeBot.
//
// Purpose
// -------
// The bot's wallet owns a single BCH UTXO set. Everything that
// touches the chain (balance, UTXO discovery, address derivation,
// signing) goes through this module so that:
//
//   1. There is exactly ONE place that holds the WIF in memory.
//   2. The WIF never enters `paytaca-cli`'s wallet slot — the bot
//      signs with `@bitauth/libauth` directly. The bot's process
//      never writes the WIF to disk, never logs it, and never ships
//      it to a subprocess.
//   3. UTXO + balance reads go through `cashscript`'s
//      `ElectrumNetworkProvider` (verified working against
//      `electrum.imaginary.cash:50004` in T03a).
//
// Design rules (also see docs/ARCHITECTURE.md §2.2):
//
//   - Loading the WIF
//     Resolution order (first hit wins):
//       (a) `opts.wif`                  — caller already loaded it
//       (b) `process.env.WIF_PRIVKEY`   — convention used by the
//                                         cauldron `check_and_swap`
//                                         CLI; safe to set in
//                                         systemd unit's
//                                         `EnvironmentFile=`
//       (c) `opts.wifFile`              — read file, trim, accept
//                                         only the first line.
//                                         Default = `user.json`'s
//                                         `wallet.wif_file` if
//                                         present, else no path.
//       (d) `userJson.wallet.wif`       — explicit field. We
//                                         tolerate it for back-compat
//                                         but recommend against it.
//     Anything else throws `WalletConfigError`.
//
//   - Memory safety
//     The constructor's `wif` option is stored in a single private
//     field. There is NO method to read it back. The only thing the
//     module exposes is `signHash(...)` which hands the WIF to
//     libauth and returns the resulting signature — never the WIF
//     itself. Use `redactWif(wif)` if you need to render it (e.g.
//     for debug logs).
//
//   - Endpoints
//     - `getBalanceSats()`        — returns bigint total sat balance
//     - `listUtxos()`             — returns cashscript `Utxo[]`
//     - `deriveAddress()`         — mainnet P2PKH cashaddr from WIF
//     - `getNetwork()`            — 'mainnet' (or chipnet in tests)
//     - `getElectrumUrl()`        — for logging + dashboard display
//     - `signHash(hash)`          — ECDSA-secp256k1 over arbitrary
//                                   32-byte digest (used by
//                                   trade execution paths; tests
//                                   verify shape only).
//
//   - Errors
//     Every catch block either rethrows or returns a typed Result.
//     `WalletConfigError`, `WalletWifError`, `WalletElectrumError`,
//     `WalletAddressError`.
//     The structured logger (`this.logger`) is called with the
//     `error` event; the WIF is NEVER included in fields.
//
//   - No I/O surprise
//     - `cashscript`'s `ElectrumNetworkProvider` is created lazily
//       and torn down via `provider.disconnect()` on
//       `wallet.close()`. Idle wallets do not hold sockets open.
//     - Every async call has an explicit timeout (`opts.timeoutMs`,
//       default 20s) implemented with `AbortController`.
//
//   - Tests
//     The class accepts `electrumProvider`, `libauth`, and
//     `cashscript` via constructor opts so the test suite can mock
//     every I/O boundary without touching the network or
//     `node_modules`. Production code passes nothing and resolves
//     the real libs.
//
// Original code for TradeBot. Mirrors the public surface of
// `LifestoneLabs/AI_Skills/skills/cauldron/scripts/check_and_swap.mjs`
// lines 268-335 (sign + broadcast pattern) but exposes an
// in-process API instead of a CLI. The contract: same inputs in
// (WIF + Electrum host), same outputs out (signed hex + txid).

import process from 'node:process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

// ─────────────────────────────────────────────────────────────────────
//  Errors
// ─────────────────────────────────────────────────────────────────────

export class WalletError extends Error {
  /**
   * @param {string} message
   * @param {Object} [opts]
   * @param {Error} [opts.cause]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = 'WalletError';
    if (opts.cause) this.cause = opts.cause;
  }
}

/** Misconfigured wallet — missing WIF, missing host, etc. */
export class WalletConfigError extends WalletError {
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = 'WalletConfigError';
  }
}

/** WIF decoding / key material validation failed. */
export class WalletWifError extends WalletError {
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = 'WalletWifError';
  }
}

/** ElectrumNetworkProvider / UTXO / balance lookup failures. */
export class WalletElectrumError extends WalletError {
  /**
   * @param {string} message
   * @param {Object} [opts]
   * @param {Error}  [opts.cause]
   * @param {string} [opts.electrumUrl]
   */
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = 'WalletElectrumError';
    if (opts.electrumUrl) this.electrumUrl = opts.electrumUrl;
  }
}

/** Address derivation mismatch (WIF does not produce expected P2PKH). */
export class WalletAddressError extends WalletError {
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = 'WalletAddressError';
  }
}

// ─────────────────────────────────────────────────────────────────────
//  WIF helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Trim + sanitize the WIF coming out of `env:` or a file.
 *
 * - Strips leading/trailing whitespace.
 * - Drops blank lines and comment lines (start with `#`).
 * - Returns the FIRST remaining non-empty line.
 *
 * Throws `WalletWifError` on empty input.
 *
 * @param {string} raw
 * @returns {string}
 */
export function sanitizeWif(raw) {
  if (typeof raw !== 'string') {
    throw new WalletWifError(`sanitizeWif: expected string, got ${typeof raw}`);
  }
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (lines.length === 0) {
    throw new WalletWifError('sanitizeWif: WIF file/env was empty after stripping');
  }
  const first = lines[0];
  // Cheap WIF shape gate: base58charset, 51–52 chars (mainnet compressed).
  // We do NOT try to decode here — that requires libauth and we
  // want sanitizeWif to be testable without it.
  if (!/^[1-9A-HJ-NP-Za-km-z]{50,60}$/.test(first)) {
    throw new WalletWifError(
      `sanitizeWif: WIF has wrong shape (${first.length} chars, charset mismatch)`,
    );
  }
  return first;
}

/**
 * Render a redacted form of a WIF for logs / dashboards.
 * Example: `L4r...XJ5 (52 chars)`.
 *
 * @param {string} wif
 * @returns {string}
 */
export function redactWif(wif) {
  if (typeof wif !== 'string' || wif.length < 8) {
    return `[invalid-wif ${typeof wif}]`;
  }
  return `${wif.slice(0, 4)}…${wif.slice(-4)} (${wif.length} chars)`;
}

/**
 * Walk the resolution-order documented in the file header. Returns
 * the WIF string or throws `WalletConfigError` listing what was tried.
 *
 * @param {Object} [opts]
 * @param {string} [opts.wif]        explicit override
 * @param {string} [opts.wifFile]    explicit file path
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @returns {Promise<string>}
 */
export async function resolveWif(opts = {}) {
  const sources = [];
  if (opts.wif) {
    sources.push({ name: 'opts.wif', value: opts.wif });
    return sanitizeWif(opts.wif);
  }
  const fromEnv = (opts.env ?? process.env).WIF_PRIVKEY;
  if (fromEnv) {
    sources.push({ name: 'env.WIF_PRIVKEY', value: fromEnv });
    return sanitizeWif(fromEnv);
  }
  if (opts.wifFile) {
    const raw = await readFile(opts.wifFile, 'utf8');
    sources.push({ name: `file:${opts.wifFile}`, value: raw });
    return sanitizeWif(raw);
  }
  throw new WalletConfigError(
    'resolveWif: no WIF source. Pass `{ wif }`, set `WIF_PRIVKEY`, or ' +
      'provide `{ wifFile }`.',
  );
}

// ─────────────────────────────────────────────────────────────────────
//  Default config (read by TraderBot when no override is supplied)
// ─────────────────────────────────────────────────────────────────────

/**
 * Subset of `config/default.json` + `config/user.json` the wallet
 * needs at boot. The trader's `run-bot.mjs` will hand us the merged
 * config object; here we just acknowledge the keys it reads.
 *
 * @typedef {Object} WalletConfig
 * @property {{ backend: string, bip44_path: string, network: 'mainnet'|'chipnet'|'testnet3' }} wallet
 * @property {{ electrum_host: string, electrum_port: number, user_agent: string }} data_sources
 * @property {number} [min_wallet_balance_bch]
 */

/**
 * Strip a possible scheme prefix + trailing port + tls marker from an
 * Electrum host string. cashscript's `ElectrumNetworkProvider({hostname})`
 * only accepts a bare hostname — its underlying `@electrum-cash/web-socket`
 * ctor (`new ElectrumWebSocket(host, port = 50004, encrypted = true, ...)`)
 * hardcodes port=50004 + TLS. Any scheme or trailing port embedded in the
 * `host` string causes the WebSocket URL to become invalid
 * (`wss://electrum://foo.com:50004:50004`), the connection silently times
 * out after 30 s, and the library throws `undefined`.
 *
 * Accepts any of:
 *   - `'foo.com'`
 *   - `'foo.com:50004'`
 *   - `'electrum://foo.com'`
 *   - `'electrum://foo.com:50004'`
 *   - `'foo.com:50004:tls'` / `'foo.com:50004:tcp'`
 *
 * Always returns the bare hostname. Falls back to the mainnet default
 * (`electrum.imaginary.cash`) for empty/non-string input.
 *
 * Exported for direct unit testing.
 *
 * @param {unknown} host
 * @returns {string}
 */
export function normalizeElectrumHost(host) {
  if (typeof host !== 'string') return 'electrum.imaginary.cash';
  let h = host.trim();
  if (h.length === 0) return 'electrum.imaginary.cash';
  // Strip scheme (e.g. 'electrum://', 'electrums://').
  const schemeIdx = h.indexOf('://');
  if (schemeIdx >= 0) h = h.slice(schemeIdx + 3);
  // Strip trailing `:port` and (if present) a final `:tls` / `:tcp` marker.
  const colonIdx = h.indexOf(':');
  if (colonIdx >= 0) h = h.slice(0, colonIdx);
  return h.length > 0 ? h : 'electrum.imaginary.cash';
}

/**
 * Extract the wallet-relevant knobs from a merged bot config.
 * Pure — easy to test.
 *
 * @param {Object} cfg  merged default+user config
 * @returns {{
 *   network: 'mainnet'|'chipnet'|'testnet3',
 *   bip44Path: string,
 *   electrumHost: string,
 *   electrumPort: number,
 *   electrumUrl: string,
 *   userAgent: string,
 *   declaredAddress: string|undefined,
 *   wifFile: string|undefined,
 *   explicitWif: string|undefined,
 *   minWalletBalanceBch: number|undefined,
 * }}
 */
export function walletConfigFrom(cfg) {
  if (!cfg || typeof cfg !== 'object') {
    throw new WalletConfigError('walletConfigFrom: cfg must be an object');
  }
  const wallet = cfg.wallet ?? {};
  const ds = cfg.data_sources ?? {};
  const net = (wallet.network ?? 'mainnet');
  if (net !== 'mainnet' && net !== 'chipnet' && net !== 'testnet3') {
    throw new WalletConfigError(
      `walletConfigFrom: unsupported network "${net}" (expected mainnet|chipnet|testnet3)`,
    );
  }
  const user = cfg.user && typeof cfg.user === 'object' ? cfg.user : null;
  const userWallet = user?.wallet ?? {};
  // declaredAddress: prefer user.json (operator override), else default.
  const declaredAddress = userWallet.address ?? userWallet.cashaddr ?? wallet.address;
  const wifFile = userWallet.wif_file ?? userWallet.wifFile;
  const explicitWif = (typeof userWallet.wif === 'string') ? userWallet.wif : undefined;
  // T23a: cashscript's `ElectrumNetworkProvider({hostname})` only accepts a
  // BARE hostname — its underlying `@electrum-cash/web-socket` constructor
  // hardcodes port=50004 + TLS, so any scheme or trailing port in the
  // user-supplied host string causes a 30-second silent timeout followed by
  // `throw undefined`. Strip the scheme + trailing port defensively.
  const electrumHost = normalizeElectrumHost(ds.electrum_host);
  const electrumPort = Number(ds.electrum_port) || 50004;
  return {
    network: /** @type {'mainnet'|'chipnet'|'testnet3'} */ (net),
    bip44Path: typeof wallet.bip44_path === 'string'
      ? wallet.bip44_path
      : "m/44'/145'/0'/0/0",
    electrumHost,
    electrumPort,
    // `electrumUrl` is kept as a display string for logs and the
    // `getElectrumUrl()` accessor — it does NOT drive provider creation.
    electrumUrl: `electrum://${electrumHost}:${electrumPort}`,
    userAgent: typeof ds.user_agent === 'string' ? ds.user_agent : 'TradeBot/0.1',
    declaredAddress,
    wifFile,
    explicitWif,
    minWalletBalanceBch: typeof cfg.risk?.min_wallet_balance_bch === 'number'
      ? cfg.risk.min_wallet_balance_bch
      : undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Wallet class
// ─────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} WalletDeps
 * @property {(network: string, opts: Object) => { getUtxos: Function, disconnect: Function }} [electrumProviderFactory]
 * @property {Object} [libauth]              injected for tests
 * @property {Object} [cashscript]           injected for tests
 */

/**
 * @typedef {Object} WalletOpts
 * @property {WalletConfig} cfg
 * @property {string} [wif]                  explicit WIF, skips resolution
 * @property {Object} [logger]               structured logger
 * @property {number} [timeoutMs=20000]
 * @property {WalletDeps} [deps]
 * @property {NodeJS.ProcessEnv} [env]
 */

export class LibAuthBchWallet {
  /**
   * @param {WalletOpts} opts
   */
  constructor(opts) {
    if (!opts || typeof opts !== 'object') {
      throw new WalletConfigError('LibAuthBchWallet: opts is required');
    }
    if (!opts.cfg) {
      throw new WalletConfigError('LibAuthBchWallet: cfg is required');
    }
    const wcfg = walletConfigFrom(opts.cfg); // throws on bad shape
    this.cfg = wcfg;
    this.logger = opts.logger ?? null;
    this.timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 20000;

    /** WIF (held once; never re-exported). */
    this._wif = null;
    if (typeof opts.wif === 'string' && opts.wif.length > 0) {
      this._wif = sanitizeWif(opts.wif);
    }

    /** Resolved deps (real or injected). */
    this._deps = opts.deps ?? null;
    /** Lazily-constructed Electrum provider. */
    this._provider = null;
    /** Cached legacy cashaddr (`bitcoincash:q...`). For BCH-only ops. */
    this._derivedAddress = null;
    /** Cached token-aware cashaddr (`bitcoincash:z...`). For token ops. */
    this._derivedTokenAddress = null;
    /** T58-2: 20-byte pubkey-hash (lowercase hex). For BadgerCoin staking. */
    this._derivedPkhHex = null;
    /** On-chain tip seen on the last `getBalanceSats` call. Useful for dashboards. */
    this._lastTipHeight = null;
  }

  /**
   * Bootstrap: resolve WIF (if not already), verify the key decodes,
   * derive the mainnet cashaddr, and confirm it matches the
   * `wallet.address` field from config (if one was declared). Throws
   * `WalletWifError`/`WalletAddressError` on mismatch.
   *
   * @returns {Promise<{ address: string, network: string, electrumUrl: string }>}
   */
  async init() {
    if (!this._wif) {
      this._wif = await resolveWif({
        wif: this.cfg.explicitWif,
        wifFile: this.cfg.wifFile,
        env: this._deps && this._deps.env,
      });
    }
    // resolveWif short-circuits on opts.wif; explicitWif is undefined
    // when user.json only carries wif_file (or no WIF source at all).
    // sanitize the resolved value here in every path so downstream
    // callers always get a base58-clean string.
    this._wif = sanitizeWif(this._wif);
    // T27f: derive BOTH cashaddr forms in one pass. Same WIF +
    // same hash160 → cashaddr differs only by the leading prefix
    // (`q` vs `z`). Underlying locking bytecode (and therefore the
    // UTXO set) is identical between the two forms. We declare the
    // legacy form against the operator-supplied cashaddr in
    // user.json (the mismatch safety check) and surface the
    // token-aware form via `getTokenAddress()` for swap
    // destinations that need to receive tokens.
    const { libauth: la } = await this._resolveDeps();
    const decoded = la.decodePrivateKeyWif(this._wif);
    if (typeof decoded === 'string') {
      throw new WalletWifError(`init: decodePrivateKeyWif returned an error: ${decoded}`);
    }
    const { privateKey, type } = decoded;
    if (type !== 'mainnet') {
      throw new WalletWifError(`init: WIF declares type="${type}", expected "mainnet"`);
    }
    const legacyResult = la.privateKeyToP2pkhCashAddress({ privateKey, tokenSupport: false });
    if (typeof legacyResult === 'string') {
      throw new WalletAddressError(`init (legacy): ${legacyResult}`);
    }
    const tokenResult = la.privateKeyToP2pkhCashAddress({ privateKey, tokenSupport: true });
    if (typeof tokenResult === 'string') {
      throw new WalletAddressError(`init (token-aware): ${tokenResult}`);
    }
    const legacyAddress = legacyResult.address;
    const tokenAddress = tokenResult.address;
    this._derivedAddress = legacyAddress;
    this._derivedTokenAddress = tokenAddress;
    // T58-2: derive the 20-byte pubkey-hash (lowercase hex) so
    // BadgerCoin staking's `lock(amount, blocks, pubkeyhash)` /
    // `unlock()` calls don't have to re-derive it. We extract the
    // pkh from the legacy address's locking bytecode — the pkh is
    // the 20 bytes between `OP_DUP OP_HASH160` (`76a914`) and
    // `OP_EQUALVERIFY OP_CHECKSIG` (`88ac`).
    const lockResult = la.cashAddressToLockingBytecode(legacyAddress);
    if (typeof lockResult === 'string') {
      throw new WalletAddressError(`init (pkh decode): ${lockResult}`);
    }
    const lockBytes = lockResult.bytecode;
    if (!(lockBytes instanceof Uint8Array) || lockBytes.length < 25
        || lockBytes[0] !== 0x76 || lockBytes[1] !== 0xa9 || lockBytes[2] !== 0x14
        || lockBytes[23] !== 0x88 || lockBytes[24] !== 0xac) {
      throw new WalletAddressError(`init (pkh decode): unexpected P2PKH locking bytecode shape (len=${lockBytes?.length})`);
    }
    this._derivedPkhHex = la.binToHex(lockBytes.slice(3, 23));
    // Safety check: operator-declared address (from user.json's
    // wallet.cashaddr) MUST match the legacy form we just derived
    // — that's the historical BCH address they funded. The
    // token-aware address is NOT safety-checked (it's auto-derived
    // from the same WIF and only differs by one prefix char).
    if (this.cfg.declaredAddress && this.cfg.declaredAddress !== legacyAddress) {
      throw new WalletAddressError(
        `LibAuthBchWallet.init: declared address mismatch — ` +
          `config says "${this.cfg.declaredAddress}", WIF derives "${legacyAddress}". ` +
          `Refusing to boot to avoid sending to the wrong key.`,
      );
    }
    if (this.logger) {
      this.logger.info('wallet.init', {
        network: this.cfg.network,
        address: `${legacyAddress.slice(0, 8)}…${legacyAddress.slice(-6)}`,
        token_address: `${tokenAddress.slice(0, 8)}…${tokenAddress.slice(-6)}`,
        electrum_url: this.cfg.electrumUrl,
        wif: redactWif(this._wif),
      });
    }
    return {
      address: legacyAddress,
      tokenAddress,
      network: this.cfg.network,
      electrumUrl: this.cfg.electrumUrl,
    };
  }

  /**
   * Lazily resolve the underlying libs (cashscript, libauth) and the
   * Electrum provider. We do NOT do this in the constructor — tests
   * inject deps, and we want a usable "config only" wallet for
   * `walletConfigFrom` + `init`'s address derivation path.
   *
   * @returns {Promise<{
   *   cashscript: Object,
   *   libauth: Object,
   *   provider: { getUtxos: Function, disconnect: Function },
   * }>}
   */
  async _resolveDeps() {
    if (this._deps && this._deps.cashscript && this._deps.libauth) {
      const cs = this._deps.cashscript;
      const la = this._deps.libauth;
      if (!this._provider) {
        const factory = this._deps.electrumProviderFactory
          ?? ((net, opts) => new cs.ElectrumNetworkProvider(net, opts));
        // T23a: pass the BARE hostname — see `normalizeElectrumHost`
        // and the walletConfigFrom docblock. The cashscript provider's
        // underlying @electrum-cash/web-socket ctor hardcodes port=50004
        // + TLS, so embedding a scheme or trailing port in `hostname`
        // makes the connection silently time out after 30s and throw
        // a non-Error value (`undefined`).
        this._provider = factory(this.cfg.network, {
          hostname: this.cfg.electrumHost,
        });
      }
      return { cashscript: cs, libauth: la, provider: this._provider };
    }
    // Production path: dynamic import (so this file remains testable).
    const [cs, la] = await Promise.all([
      import('cashscript'),
      import('@bitauth/libauth'),
    ]);
    if (!this._provider) {
      this._provider = new cs.ElectrumNetworkProvider(this.cfg.network, {
        hostname: this.cfg.electrumHost,
      });
    }
    return { cashscript: cs, libauth: la, provider: this._provider };
  }

  // ─── public read API ─────────────────────────────────────────────

  /** @returns {'mainnet'|'chipnet'|'testnet3'} */
  getNetwork() { return this.cfg.network; }

  /** @returns {string} */
  getElectrumUrl() { return this.cfg.electrumUrl; }

  /**
   * T27f: BCH-aware address accessor. Returns the legacy
   * `bitcoincash:q...` cashaddr for BCH-specific operations
   * (balance displays, BCH-only sends, UTXO discovery — the
   * locking bytecode is identical to the token-aware form, so
   * UTXO lookups via either address return the same set). Set
   * after `init()`.
   *
   * @returns {string|null}
   */
  getAddress() { return this._derivedAddress; }

  /**
   * T58-2: 20-byte pubkey-hash accessor. BadgerCoin staking's
   * `lock(amount, stakeBlocks, pubkeyhash)` and `unlock()` both
   * take a `bytes20 pubkeyhash` parameter (the hash160 of the
   * wallet's compressed public key). Stash it at `init()` time
   * so `executeLock` / `executeUnlock` can pass it to the
   * cashscript unlocker without re-deriving. Returns the
   * lowercase hex string. `null` before `init()` resolves.
   *
   * @returns {string|null}
   */
  getPkh() { return this._derivedPkhHex; }

  /**
   * T27f: token-aware address accessor. Returns the
   * `bitcoincash:z...` cashaddr required by token-aware
   * operations (e.g. cauldron-swap-sdk swap destinations that
   * mint fungible / non-fungible tokens to the wallet). Same
   * WIF as `getAddress()`; cashaddr prefix differs by exactly
   * one character. Set after `init()`.
   *
   * @returns {string|null}
   */
  getTokenAddress() { return this._derivedTokenAddress; }

  /**
   * Derive the mainnet cashaddr from the WIF (single shot, no
   * caching — the cost is one HMAC-SHA512 and one RIPEMD160; well
   * under a millisecond on any modern host).
   *
   * @returns {Promise<string>}
   */
  async deriveAddress() {
    if (!this._wif) {
      throw new WalletWifError('deriveAddress: WIF not loaded (call init() first)');
    }
    const { libauth: la } = await this._resolveDeps();
    const decoded = la.decodePrivateKeyWif(this._wif);
    if (typeof decoded === 'string') {
      throw new WalletWifError(`deriveAddress: decodePrivateKeyWif returned an error: ${decoded}`);
    }
    const { privateKey, type } = decoded;
    if (type !== 'mainnet') {
      throw new WalletWifError(
        `deriveAddress: WIF declares type="${type}", expected "mainnet"`,
      );
    }
    // T27b: tokenSupport: true so the derived cashaddr starts
    // with 'z...' (token-aware P2PKH) instead of 'q...' (legacy
    // P2PKH, BCH-only). The cauldron-swap-sdk rejects legacy
    // addresses with 'Address is not a token-aware address' —
    // same WIF produces both, body differs by exactly one prefix
    // char. UTXO scan via getBalanceSats() now targets the z...
    // UTXO set; migrate funds with scripts/sweep-funds.mjs if
    // they still live at the legacy address.
    const addrResult = la.privateKeyToP2pkhCashAddress({ privateKey, tokenSupport: true });
    if (typeof addrResult === 'string') {
      throw new WalletAddressError(`deriveAddress: ${addrResult}`);
    }
    return /** @type {string} */ (addrResult.address);
  }

  /**
   * Sum the satoshi value of every UTXO the wallet currently
   * controls. Returns `0n` (NOT throws) if the address has no
   * UTXOs — this matches `cashscript` semantics where `getUtxos()`
   * resolves `[]` on an empty wallet.
   *
   * @returns {Promise<bigint>}
   */
  async getBalanceSats() {
    const utxos = await this.listUtxos();
    let total = 0n;
    for (const u of utxos) {
      const v = u.satoshis;
      if (typeof v === 'bigint') total += v;
      else if (Number.isFinite(Number(v))) total += BigInt(Number(v));
      else {
        // Defensive: skip rather than coerce garbage. The log line
        // below gives the operator a hint if a UTXO shape drifts.
        if (this.logger) {
          this.logger.warn('wallet.balance.skip-misformed-utxo', {
            utxo: { txid: u.txid, vout: u.vout },
          });
        }
      }
    }
    return total;
  }

  /**
   * Fetch the wallet's UTXO set. Each entry matches the
   * `cashscript` Utxo shape (txid, vout, satoshis: bigint,
   * token?: { ... }).
   *
   * Retries on transient errors (network blip, Electrum restart)
   * with linear backoff + jitter. Total time budget =
   * `timeoutMs`, not attempt count.
   *
   * @param {Object} [opts]
   * @param {number} [opts.maxAttempts=3]
   * @returns {Promise<Array<{ txid: string, vout: number, satoshis: bigint, token?: Object }>>}
   */
  async listUtxos(opts = {}) {
    if (!this._derivedAddress) {
      throw new WalletWifError('listUtxos: address not derived — call init() first');
    }
    const maxAttempts = Number.isFinite(opts.maxAttempts)
      ? Math.max(1, opts.maxAttempts)
      : 3;
    const deadline = Date.now() + this.timeoutMs;
    let lastErr = null;
    let attempt = 0;
    while (attempt < maxAttempts && Date.now() < deadline) {
      attempt += 1;
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(new Error('electrum-timeout')), this.timeoutMs);
      try {
        const { provider } = await this._resolveDeps();
        const utxos = await provider.getUtxos(this._derivedAddress);
        if (!Array.isArray(utxos)) {
          throw new WalletElectrumError(
            `listUtxos: provider returned non-array (${typeof utxos})`,
            { electrumUrl: this.cfg.electrumUrl },
          );
        }
        return utxos;
      } catch (e) {
        lastErr = e;
        if (this.logger) {
          this.logger.warn('wallet.listUtxos.retry', {
            attempt,
            max_attempts: maxAttempts,
            err_name: e?.name ?? 'Error',
            err_message: e?.message ?? String(e),
            address: `${this._derivedAddress.slice(0, 8)}…${this._derivedAddress.slice(-6)}`,
          });
        }
        if (Date.now() >= deadline) break;
        const backoffMs = 250 * attempt + Math.floor(Math.random() * 100);
        await delay(backoffMs);
      } finally {
        clearTimeout(t);
      }
    }
    throw new WalletElectrumError(
      `listUtxos: failed after ${attempt} attempt(s): ${lastErr?.message ?? 'unknown'}`,
      { cause: /** @type {Error} */ (lastErr ?? undefined), electrumUrl: this.cfg.electrumUrl },
    );
  }

  /**
   * T58 subset 5 — Fetch the current BCH chain tip height via the
   * underlying Electrum provider (cashscript's
   * `ElectrumNetworkProvider.getBlockHeight()`). Used by the
   * unlock-cron fallback (`scripts/check-stale-stakes.mjs`) to
   * compute `(tipHeight - lockBlockHeight) >= stakeBlocks +
   * graceBlocks` for each lockNFT.
   *
   * The trader loop's auto-unlock path already uses an injected
   * `stakingGetBlockHeight` seam; this wallet method is the
   * production path the cron wires in. Mirrors the retry + budget
   * semantics of `listUtxos()` so a flapping Electrum connection
   * doesn't immediately fail the cron tick.
   *
   * Defensive:
   * - Throws `WalletElectrumError` when the provider throws or
   *   returns a non-numeric / negative result.
   * - Tests inject the `cashscript` namespace via `_deps` so the
   *   provider call is fully mockable (the test suite passes a
   *   stub `provider.getBlockHeight` via `_deps.electrumProviderFactory`).
   *
   * @param {Object} [opts]
   * @param {number} [opts.maxAttempts=3]
   * @returns {Promise<number>} the current chain tip height.
   */
  async getBlockHeight(opts = {}) {
    const maxAttempts = Number.isFinite(opts.maxAttempts)
      ? Math.max(1, opts.maxAttempts)
      : 3;
    const deadline = Date.now() + this.timeoutMs;
    let lastErr = null;
    let attempt = 0;
    while (attempt < maxAttempts && Date.now() < deadline) {
      attempt += 1;
      try {
        const { provider } = await this._resolveDeps();
        if (!provider || typeof provider.getBlockHeight !== 'function') {
          throw new WalletElectrumError(
            'getBlockHeight: provider.getBlockHeight is not a function',
            { electrumUrl: this.cfg.electrumUrl },
          );
        }
        const height = await provider.getBlockHeight();
        if (typeof height !== 'number' || !Number.isFinite(height) || height < 0) {
          throw new WalletElectrumError(
            `getBlockHeight: provider returned non-positive number (${typeof height}: ${String(height)})`,
            { electrumUrl: this.cfg.electrumUrl },
          );
        }
        return Math.floor(height);
      } catch (e) {
        lastErr = e;
        if (this.logger) {
          this.logger.warn('wallet.getBlockHeight.retry', {
            attempt,
            max_attempts: maxAttempts,
            err_name: e?.name ?? 'Error',
            err_message: e?.message ?? String(e),
            address: this._derivedAddress ? `${this._derivedAddress.slice(0, 8)}…${this._derivedAddress.slice(-6)}` : null,
          });
        }
        if (Date.now() >= deadline) break;
        const backoffMs = 250 * attempt + Math.floor(Math.random() * 100);
        await delay(backoffMs);
      }
    }
    throw new WalletElectrumError(
      `getBlockHeight: failed after ${attempt} attempt(s): ${lastErr?.message ?? 'unknown'}`,
      { cause: /** @type {Error} */ (lastErr ?? undefined), electrumUrl: this.cfg.electrumUrl },
    );
  }

  /**
   * Sign a 32-byte digest using ECDSA-secp256k1 against the WIF's
   * derived key. Returns the 64-byte low-S compact signature
   * (`Uint8Array(64)`). Higher-level transaction builders (cashscript
   * `SignatureTemplate`) wrap this for us — we only expose the raw
   * primitive for callers that want it (e.g. an offline
   * signed-payload path).
   *
   * `@bitauth/libauth@3.x` exposes the signing primitive as
   * `secp256k1.signMessageHashCompact(privateKey, messageHash)` from
   * the top-level package export (the WASM-bound singleton). Older
   * `libauth` versions offered a top-level `signMessageHash(...)`
   * helper; the seam in this file is a single `signMessageHash(hash,
   * privateKey) -> Uint8Array | string` shape so the test mocks can
   * pass a single function without internal-API drift.
   *
   * @param {Uint8Array} hash32
   * @returns {Promise<Uint8Array>}
   */
  async signHash(hash32) {
    if (!(hash32 instanceof Uint8Array) || hash32.length !== 32) {
      throw new WalletWifError('signHash: expected Uint8Array(32) digest');
    }
    if (!this._wif) {
      throw new WalletWifError('signHash: WIF not loaded');
    }
    const { libauth: la } = await this._resolveDeps();
    const decoded = la.decodePrivateKeyWif(this._wif);
    if (typeof decoded === 'string') {
      throw new WalletWifError(`signHash: decode failed: ${decoded}`);
    }
    if (decoded.type !== 'mainnet') {
      throw new WalletWifError(`signHash: WIF type="${decoded.type}", expected mainnet`);
    }
    const signer = await this._resolveSigner(la);
    const sig = signer(decoded.privateKey, hash32);
    if (typeof sig === 'string') {
      throw new WalletWifError(`signHash: ${sig}`);
    }
    return /** @type {Uint8Array} */ (sig);
  }

  /**
   * Resolve a single `signMessageHash(privateKey, messageHash)`
   * helper from whatever `@bitauth/libauth` shape is available:
   *
   *   - tests inject `libauth.signMessageHash = (...) => ...` directly;
   *   - libauth@3 ships a pre-instantiated `secp256k1` named export
   *     exposing `signMessageHashCompact(privateKey, messageHash)`;
   *   - older refactors / shims may park it under `key.messages`.
   *
   * Returns the chosen `signer` so the call site can pass
   * `(privateKey, hash)` positionally and treat it as a string
   * (libauth signals failure by returning a string).
   *
   * @param {Object} la libauth module (real or injected)
   * @returns {Promise<(privateKey: Uint8Array, messageHash: Uint8Array) => Uint8Array|string>}
   */
  async _resolveSigner(la) {
    if (la && typeof la.signMessageHash === 'function') {
      return (pk, h) => la.signMessageHash(h, pk);
    }
    if (la && la.secp256k1 && typeof la.secp256k1.signMessageHashCompact === 'function') {
      const secp = la.secp256k1;
      return (pk, h) => secp.signMessageHashCompact(pk, h);
    }
    // Last-resort search: walk the libauth namespace and grab the
    // first `signMessageHash*` we find on a Secp256k1-like object.
    const fallback =
      (la && la.key && la.key.signMessageHash)
      ?? (la && la.lib && la.lib.key && la.lib.key.signMessageHash)
      ?? (la && la.default && la.default.signMessageHash);
    if (typeof fallback === 'function') {
      return (pk, h) => fallback({ privateKey: pk, messageHash: h });
    }
    // No Secp256k1 helper, but `crypto/secp256k1` may be importable
    // directly. This branch is hit when the caller hands us a
    // top-level module that re-exports only crypto, not the
    // singleton.
    try {
      const secpMod = await import('@bitauth/libauth/crypto/secp256k1.js')
        .catch(() => null);
      const inst = secpMod && secpMod.instantiateSecp256k1;
      if (typeof inst === 'function') {
        const secp = await inst();
        return (pk, h) => secp.signMessageHashCompact(pk, h);
      }
    } catch (_) { /* fall through */ }
    throw new WalletWifError(
      'signHash: cannot locate an ECDSA-secp256k1 signer in libauth (unsupported version)',
    );
  }

  /**
   * Cleanly tear down the cached Electrum provider socket.
   * Idempotent: safe to call multiple times.
   *
   * T23d: cashscript v0.13.2's `ElectrumNetworkProvider` defaults
   * `manualConnectionManagement: false`, which means it manages
   * connection lifecycle internally and rejects any external
   * `disconnect()` call with `Error: Manual connection management
   * is disabled`. Since we never opted into manual management,
   * the disconnect call always failed and spammed the log every
   * tick. Setting `this._provider = null` is sufficient: the next
   * tick's `_resolveDeps()` will build a fresh provider on demand.
   *
   * @returns {Promise<void>}
   */
  async close() {
    this._provider = null;
  }
}

/**
 * Convenience factory: read config + WIF, run `init()`, return a
 * ready-to-use wallet. Mostly for tests; the bot's main loop will
 * construct the wallet and call `init()` itself so it can hand the
 * same logger to other modules.
 *
 * @param {Object} opts
 * @param {Object} opts.cfg
 * @param {Object} [opts.logger]
 * @param {string} [opts.wif]
 * @param {string} [opts.wifFile]
 * @returns {Promise<LibAuthBchWallet>}
 */
export async function createWallet(opts) {
  const w = new LibAuthBchWallet(opts);
  await w.init();
  return w;
}
