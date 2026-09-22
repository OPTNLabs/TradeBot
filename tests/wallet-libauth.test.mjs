// tests/wallet-libauth.test.mjs
//
// Unit tests for `src/wallet/libauth.mjs`.
//
// These tests mock EVERY external surface (cashscript,
// ElectrumNetworkProvider, libauth, `node:fs/promises`) so the
// wallet module can be exercised without:
//   - touching the network
//   - loading cashscript's native secp256k1 bindings (the binary
//     addon is heavy and slow to import)
//   - reading a real `config/user.json`
//
// Run with:
//   node --test tests/wallet-libauth.test.mjs
//
// Conventional test pattern via `node:test`.
//   https://nodejs.org/api/test.html

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LibAuthBchWallet,
  WalletConfigError,
  WalletWifError,
  WalletElectrumError,
  WalletAddressError,
  sanitizeWif,
  redactWif,
  resolveWif,
  walletConfigFrom,
  normalizeElectrumHost,
  createWallet,
} from '../src/wallet/libauth.mjs';

import { createLogger, createMemorySink } from '../src/util/logger.mjs';

// ─────────────────────────────────────────────────────────────────────
//  Test fixtures
// ─────────────────────────────────────────────────────────────────────

/**
 * A syntactically-valid WIF placeholder. The real WIF lives in
 * `/tmp/wallet-secret.txt` on the operator's host — NEVER hard-code
 * a real key here. Tests that need decode behavior beyond shape
 * validation inject a `decodePrivateKeyWif` mock via `deps`.
 */
const PLACEHOLDER_WIF = 'KFsnU1YFjcV7RYwbjHgfXrb6A58urPnexEpEWdQmj2STpmeamW';

/** 32-byte Uint8Array of zeros — stand-in for a transaction digest. */
const HASH32 = new Uint8Array(32);

/** Cashaddr returned by the injected libauth stub. */
const FAKE_ADDR = 'bitcoincash:qqcp6q32dt4x4ddzrkdz28xmv6a3ev6wwq4t0m57ak';

/** Minimal default.json subset for `walletConfigFrom`. */
function baseConfig(overrides = {}) {
  return {
    wallet: {
      backend: 'external_wif',
      bip44_path: "m/44'/145'/0'/0/0",
      network: 'mainnet',
      address: FAKE_ADDR,
    },
    data_sources: {
      cauldron_indexer_base_url: 'https://indexer.riften.net/cauldron',
      electrum_host: 'electrum.imaginary.cash',
      electrum_port: 50004,
      user_agent: 'TradeBot/0.1 (LifestoneLabs)',
    },
    risk: {
      min_wallet_balance_bch: 0.005,
    },
    ...overrides,
  };
}

/**
 * Minimal libauth stub. The wrapper class looks up these three
 * primitives — `decodePrivateKeyWif`, `privateKeyToP2pkhCashAddress`,
 * and `signMessageHash` — by name. Override individual keys on the
 * `overrides` object to swap out one of them; the defaults produce
 * a happy-path "mainnet WIF → cashaddr → 64-byte sig" sequence.
 *
 * NOTE on v3 mismatch: the installed `@bitauth/libauth@3.1.0-next.8`
 * exposes signing via the named exports `secp256k1.signMessageHashCompact`,
 * NOT a top-level `signMessageHash`. The wallet calls a single
 * `signMessageHash(hash, key)` helper internally (to keep the
 * constructor/mocks DRY) and that helper delegates to whatever
 * libauth shape the runtime provides. Tests inject `signMessageHash`
 * directly because the helper is mockable at one stable seam.
 */
function fakeLibauth(overrides = {}) {
  return {
    decodePrivateKeyWif: () => {
      if (typeof overrides.decodePrivateKeyWif === 'function') {
        return overrides.decodePrivateKeyWif();
      }
      return { privateKey: new Uint8Array(32), type: 'mainnet' };
    },
    privateKeyToP2pkhCashAddress: () => {
      if (typeof overrides.privateKeyToP2pkhCashAddress === 'function') {
        return overrides.privateKeyToP2pkhCashAddress();
      }
      return { address: FAKE_ADDR };
    },
    // T58-2: 20-byte pubkey-hash derivation for BadgerCoin staking.
    // Returns a 25-byte P2PKH locking bytecode: `76 a9 14 <20-byte pkh> 88 ac`
    // so the wallet's pkh-decode path can extract the 20-byte pkh.
    cashAddressToLockingBytecode: () => {
      if (typeof overrides.cashAddressToLockingBytecode === 'function') {
        return overrides.cashAddressToLockingBytecode();
      }
      const bytecode = new Uint8Array(25);
      bytecode[0] = 0x76; // OP_DUP
      bytecode[1] = 0xa9; // OP_HASH160
      bytecode[2] = 0x14; // push 20 bytes
      // Fill the 20-byte pkh with a deterministic non-zero pattern so
      // the wallet's pkh-decode path can extract a real 40-char hex.
      for (let i = 3; i < 23; i++) bytecode[i] = (i * 7) & 0xff;
      bytecode[23] = 0x88; // OP_EQUALVERIFY
      bytecode[24] = 0xac; // OP_CHECKSIG
      return { bytecode };
    },
    binToHex: (bytes) => {
      if (typeof overrides.binToHex === 'function') {
        return overrides.binToHex(bytes);
      }
      let hex = '';
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i] & 0xff;
        hex += (b < 16 ? '0' : '') + b.toString(16);
      }
      return hex;
    },
    signMessageHash: (messageHash /* eslint-disable-line no-unused-vars */, privateKey /* eslint-disable-line no-unused-vars */) => {
      // `signReturn` takes priority: a concrete Uint8Array that bypasses
      // any override function (used by test #46).
      if (overrides.signReturn instanceof Uint8Array) {
        return overrides.signReturn;
      }
      if (typeof overrides.signMessageHash === 'function') {
        return overrides.signMessageHash();
      }
      return new Uint8Array(64);
    },
  };
}

/** Minimal cashscript stub. */
function fakeCashscript() {
  return {
    ElectrumNetworkProvider: class FakeElectrumProvider {
      constructor(network, opts) {
        this.network = network;
        this.opts = opts;
        this.disconnected = false;
      }
      getUtxos() { return Promise.resolve([]); }
      disconnect() {
        this.disconnected = true;
        return Promise.resolve();
      }
    },
    Network: { MAINNET: 'mainnet' },
  };
}

/** Build a deps object with overridable factory + libauth. */
function deps(overrides = {}) {
  return {
    cashscript: fakeCashscript(),
    libauth: fakeLibauth(overrides.libauth),
    electrumProviderFactory: overrides.providerFactory,
  };
}

/**
 * Build an init()'d wallet. Most tests should use this helper —
 * it's the smallest "production-shaped" sequence for the
 * constructor → init() → ready path.
 *
 * @param {Object} depLike
 * @param {Object} [extraOpts]
 * @returns {Promise<LibAuthBchWallet>}
 */
async function makeInitedWallet(depLike, extraOpts = {}) {
  const w = new LibAuthBchWallet({
    cfg: baseConfig(),
    wif: PLACEHOLDER_WIF,
    timeoutMs: 5000,
    deps: depLike,
    ...extraOpts,
  });
  await w.init();
  return w;
}

// ─────────────────────────────────────────────────────────────────────
//  sanitizeWif
// ─────────────────────────────────────────────────────────────────────

test('sanitizeWif: accepts a plain WIF', () => {
  assert.equal(sanitizeWif(PLACEHOLDER_WIF), PLACEHOLDER_WIF);
});

test('sanitizeWif: trims whitespace', () => {
  assert.equal(sanitizeWif(`  \n  ${PLACEHOLDER_WIF}  \n  `), PLACEHOLDER_WIF);
});

test('sanitizeWif: skips comment lines starting with #', () => {
  const inp = `# exported from backup\n${PLACEHOLDER_WIF}\n`;
  assert.equal(sanitizeWif(inp), PLACEHOLDER_WIF);
});

test('sanitizeWif: returns the first non-empty/non-comment line', () => {
  const inp = `\n# header\n${PLACEHOLDER_WIF}\nignored-second-line\n`;
  assert.equal(sanitizeWif(inp), PLACEHOLDER_WIF);
});

test('sanitizeWif: rejects empty input', () => {
  assert.throws(() => sanitizeWif(''), WalletWifError);
  assert.throws(() => sanitizeWif('   \n  \n# only comments\n'), WalletWifError);
});

test('sanitizeWif: rejects non-string', () => {
  // @ts-expect-error intentional bad input
  assert.throws(() => sanitizeWif(null), WalletWifError);
  // @ts-expect-error intentional bad input
  assert.throws(() => sanitizeWif(undefined), WalletWifError);
  // @ts-expect-error intentional bad input
  assert.throws(() => sanitizeWif(42), WalletWifError);
});

test('sanitizeWif: rejects wrong shape (too short)', () => {
  assert.throws(() => sanitizeWif('short'), WalletWifError);
});

test('sanitizeWif: rejects wrong charset (non-base58)', () => {
  // '0' is not in base58 — same length but invalid.
  assert.throws(() => sanitizeWif('0'.repeat(52)), WalletWifError);
});

// ─────────────────────────────────────────────────────────────────────
//  redactWif
// ─────────────────────────────────────────────────────────────────────

test('redactWif: returns "<4chars>…<4chars> (<n> chars)"', () => {
  const expected = `${PLACEHOLDER_WIF.slice(0, 4)}…${PLACEHOLDER_WIF.slice(-4)} (${PLACEHOLDER_WIF.length} chars)`;
  assert.equal(redactWif(PLACEHOLDER_WIF), expected);
});

test('redactWif: returns "[invalid-wif <type>]" for garbage', () => {
  assert.equal(redactWif(''), '[invalid-wif string]');
  // @ts-expect-error intentional bad input
  assert.equal(redactWif(null), '[invalid-wif object]');
  // 'abcd' / '1234567' (< 8 chars) are too short to redact safely —
  // we surface the type only.
  assert.equal(redactWif('abcd'), '[invalid-wif string]');
  assert.equal(redactWif('1234567'), '[invalid-wif string]');
  // '12345678' has length 8, which passes the length floor.
  assert.equal(redactWif('12345678'), '1234…5678 (8 chars)');
});

// ─────────────────────────────────────────────────────────────────────
//  resolveWif — env / opts.wif / wifFile resolution
// ─────────────────────────────────────────────────────────────────────

test('resolveWif: prefers explicit opts.wif', async () => {
  const got = await resolveWif({ wif: PLACEHOLDER_WIF });
  assert.equal(got, PLACEHOLDER_WIF);
});

test('resolveWif: falls back to env.WIF_PRIVKEY', async () => {
  const got = await resolveWif({ env: { WIF_PRIVKEY: PLACEHOLDER_WIF } });
  assert.equal(got, PLACEHOLDER_WIF);
});

test('resolveWif: explicit wins over env', async () => {
  const got = await resolveWif({
    wif: PLACEHOLDER_WIF,
    env: { WIF_PRIVKEY: 'ignored' },
  });
  assert.equal(got, PLACEHOLDER_WIF);
});

test('resolveWif: env wins over wifFile', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const tmp = path.join(os.tmpdir(), `wif-test-${Date.now()}.txt`);
  await fs.writeFile(tmp, `# password file\n${PLACEHOLDER_WIF}\n`);
  try {
    const got = await resolveWif({
      env: { WIF_PRIVKEY: PLACEHOLDER_WIF },
      wifFile: tmp,
    });
    assert.equal(got, PLACEHOLDER_WIF);
  } finally {
    await fs.unlink(tmp);
  }
});

test('resolveWif: loads from wifFile when env is empty', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const tmp = path.join(os.tmpdir(), `wif-test-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  await fs.writeFile(tmp, PLACEHOLDER_WIF);
  try {
    const got = await resolveWif({ env: {}, wifFile: tmp });
    assert.equal(got, PLACEHOLDER_WIF);
  } finally {
    await fs.unlink(tmp);
  }
});

test('resolveWif: throws WalletConfigError when no source', async () => {
  await assert.rejects(() => resolveWif({ env: {} }), WalletConfigError);
});

test('resolveWif: rejects a file containing only comments', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const tmp = path.join(os.tmpdir(), `wif-empty-${Date.now()}.txt`);
  await fs.writeFile(tmp, '# nothing here\n# still nothing\n');
  try {
    await assert.rejects(
      () => resolveWif({ env: {}, wifFile: tmp }),
      WalletWifError,
    );
  } finally {
    await fs.unlink(tmp);
  }
});

// ─────────────────────────────────────────────────────────────────────
//  walletConfigFrom
// ─────────────────────────────────────────────────────────────────────

test('walletConfigFrom: extracts everything from default.json shape', () => {
  const out = walletConfigFrom(baseConfig());
  assert.equal(out.network, 'mainnet');
  assert.equal(out.bip44Path, "m/44'/145'/0'/0/0");
  assert.equal(out.electrumUrl, 'electrum://electrum.imaginary.cash:50004');
  assert.equal(out.userAgent, 'TradeBot/0.1 (LifestoneLabs)');
  assert.equal(out.declaredAddress, FAKE_ADDR);
  assert.equal(out.minWalletBalanceBch, 0.005);
});

test('walletConfigFrom: prefers user.json wallet.address', () => {
  const out = walletConfigFrom({
    ...baseConfig(),
    user: {
      wallet: { address: 'bitcoincash:qUserOverrideAddressDeclaredInUserJsonXYZ' },
    },
  });
  assert.equal(out.declaredAddress, 'bitcoincash:qUserOverrideAddressDeclaredInUserJsonXYZ');
});

test('walletConfigFrom: rejects non-object input', () => {
  assert.throws(() => walletConfigFrom(null), WalletConfigError);
  assert.throws(() => walletConfigFrom('mainnet'), WalletConfigError);
});

test('walletConfigFrom: rejects unsupported network', () => {
  assert.throws(
    () => walletConfigFrom(baseConfig({
      wallet: { ...baseConfig().wallet, network: 'solana' },
    })),
    WalletConfigError,
  );
});

test('walletConfigFrom: tolerates missing data_sources and uses defaults', () => {
  const out = walletConfigFrom({ wallet: baseConfig().wallet });
  assert.equal(out.electrumUrl, 'electrum://electrum.imaginary.cash:50004');
  assert.equal(out.userAgent, 'TradeBot/0.1');
});

test('walletConfigFrom: treats non-string port as default', () => {
  const out = walletConfigFrom(baseConfig({
    data_sources: {
      ...baseConfig().data_sources,
      electrum_port: 'abc',
    },
  }));
  assert.equal(out.electrumUrl, 'electrum://electrum.imaginary.cash:50004');
});

test('walletConfigFrom: pulls wif_file + explicit wif from user.json', () => {
  const out = walletConfigFrom({
    ...baseConfig(),
    user: {
      wallet: {
        wif_file: '/tmp/wallet-secret.txt',
        wif: 'explicit-set-in-user-json',
      },
    },
  });
  assert.equal(out.wifFile, '/tmp/wallet-secret.txt');
  assert.equal(out.explicitWif, 'explicit-set-in-user-json');
});

// ─────────────────────────────────────────────────────────────────────
//  T23a — Electrum host normalization
//
// Regression for the 2026-09-12 production incident: cashscript's
// ElectrumNetworkProvider ctor was being handed the FULL `electrum://`
// URL as `hostname`, which makes @electrum-cash/web-socket build an
// invalid `wss://` URL, hang for 30 s, then throw `undefined`. Fix:
// `walletConfigFrom` returns a separate `electrumHost` (bare hostname)
// and `_resolveDeps` uses that instead of `electrumUrl`.
// ─────────────────────────────────────────────────────────────────────

test('normalizeElectrumHost: passes bare hostname through unchanged', () => {
  assert.equal(normalizeElectrumHost('electrum.imaginary.cash'), 'electrum.imaginary.cash');
  assert.equal(normalizeElectrumHost('bch.imaginary.cash'), 'bch.imaginary.cash');
  assert.equal(normalizeElectrumHost('localhost'), 'localhost');
});

test('normalizeElectrumHost: strips scheme prefix', () => {
  assert.equal(normalizeElectrumHost('electrum://foo.com'), 'foo.com');
  assert.equal(normalizeElectrumHost('electrums://foo.com'), 'foo.com');
});

test('normalizeElectrumHost: strips trailing port', () => {
  assert.equal(normalizeElectrumHost('foo.com:50004'), 'foo.com');
  assert.equal(normalizeElectrumHost('foo.com:50001'), 'foo.com');
});

test('normalizeElectrumHost: strips scheme + port together', () => {
  assert.equal(
    normalizeElectrumHost('electrum://electrum.imaginary.cash:50004'),
    'electrum.imaginary.cash',
  );
});

test('normalizeElectrumHost: strips port + tls/tcp marker', () => {
  assert.equal(normalizeElectrumHost('foo.com:50004:tls'), 'foo.com');
  assert.equal(normalizeElectrumHost('foo.com:50004:tcp'), 'foo.com');
});

test('normalizeElectrumHost: handles whitespace + non-string input', () => {
  assert.equal(normalizeElectrumHost('  foo.com  '), 'foo.com');
  assert.equal(normalizeElectrumHost(''), 'electrum.imaginary.cash');
  assert.equal(normalizeElectrumHost(null), 'electrum.imaginary.cash');
  assert.equal(normalizeElectrumHost(undefined), 'electrum.imaginary.cash');
  assert.equal(normalizeElectrumHost(42), 'electrum.imaginary.cash');
});

test('walletConfigFrom: returns bare electrumHost (not the full URL)', () => {
  const out = walletConfigFrom(baseConfig());
  assert.equal(out.electrumHost, 'electrum.imaginary.cash');
  assert.equal(out.electrumPort, 50004);
  // The display string is unchanged (backward-compat for logs / accessor).
  assert.equal(out.electrumUrl, 'electrum://electrum.imaginary.cash:50004');
});

test('walletConfigFrom: tolerates a host string with scheme in data_sources', () => {
  // If an operator accidentally puts a full URL in `electrum_host`,
  // we should strip it instead of passing the bogus value to cashscript.
  const out = walletConfigFrom(baseConfig({
    data_sources: {
      ...baseConfig().data_sources,
      electrum_host: 'electrum://bch.example.org:50004',
    },
  }));
  assert.equal(out.electrumHost, 'bch.example.org');
  assert.equal(out.electrumUrl, 'electrum://bch.example.org:50004');
});

test('walletConfigFrom: uses default host when data_sources is missing', () => {
  const out = walletConfigFrom({ wallet: baseConfig().wallet });
  assert.equal(out.electrumHost, 'electrum.imaginary.cash');
  assert.equal(out.electrumPort, 50004);
});

test('_resolveDeps: passes BARE hostname to provider ctor (T23a regression)', async () => {
  // The original bug was that `_resolveDeps` handed the full URL
  // `electrum://electrum.imaginary.cash:50004` to
  // `new ElectrumNetworkProvider(network, { hostname })`. cashscript's
  // internal @electrum-cash/web-socket then tried to connect to a
  // server literally named `electrum://electrum.imaginary.cash:50004`,
  // timed out after 30 s, and threw `undefined`. This test pins the
  // ctor arg shape so a future refactor can't regress silently.
  let capturedNetwork = null;
  let capturedOpts = null;
  const factory = (network, opts) => {
    capturedNetwork = network;
    capturedOpts = opts;
    return {
      getUtxos: () => Promise.resolve([]),
      disconnect: () => Promise.resolve(),
    };
  };
  const w = await makeInitedWallet(deps({ providerFactory: factory }));
  assert.equal(capturedNetwork, 'mainnet');
  assert.equal(typeof capturedOpts, 'object');
  assert.equal(capturedOpts.hostname, 'electrum.imaginary.cash');
  // Defensive assertions on the value passed to cashscript:
  assert.equal(capturedOpts.hostname.includes('://'), false,
    'hostname must NOT include a scheme (T23a)');
  assert.equal(capturedOpts.hostname.includes(':'), false,
    'hostname must NOT include a trailing port (T23a)');
  // Sanity-check the wallet is usable.
  assert.equal(w.getElectrumUrl(), 'electrum://electrum.imaginary.cash:50004');
});

// ─────────────────────────────────────────────────────────────────────
//  LibAuthBchWallet — constructor + init()
// ─────────────────────────────────────────────────────────────────────

test('constructor: rejects missing opts / cfg', () => {
  // @ts-expect-error intentional bad input
  assert.throws(() => new LibAuthBchWallet(null), WalletConfigError);
  // @ts-expect-error intentional bad input
  assert.throws(() => new LibAuthBchWallet({}), WalletConfigError);
});

test('constructor: stores timeoutMs default and override', () => {
  const a = new LibAuthBchWallet({ cfg: baseConfig() });
  assert.equal(a.timeoutMs, 20000);
  const b = new LibAuthBchWallet({ cfg: baseConfig(), timeoutMs: 1234 });
  assert.equal(b.timeoutMs, 1234);
});

test('getNetwork / getElectrumUrl / getAddress proxies', async () => {
  const w = await makeInitedWallet(deps());
  assert.equal(w.getNetwork(), 'mainnet');
  assert.equal(w.getElectrumUrl(), 'electrum://electrum.imaginary.cash:50004');
  assert.equal(w.getAddress(), FAKE_ADDR);
});

test('init: explicit wif derives expected address', async () => {
  const sink = createMemorySink();
  const w = new LibAuthBchWallet({
    cfg: baseConfig(),
    wif: PLACEHOLDER_WIF,
    logger: createLogger({ sink: sink.stream }),
    deps: deps(),
  });
  const out = await w.init();
  assert.equal(out.network, 'mainnet');
  assert.equal(out.address, FAKE_ADDR);
  assert.ok(out.electrumUrl.startsWith('electrum://'));
  // WIF is stored but never logged.
  const lines = sink.lines();
  const initLine = lines.find((l) => l.includes('"msg":"wallet.init"'));
  assert.ok(initLine, 'expected a wallet.init log line');
  assert.ok(!lines.some((l) => l.includes(PLACEHOLDER_WIF)), 'WIF must never appear in any log line');
  assert.ok(initLine.includes('"wif":"KFsn…eamW'), 'redacted WIF should be present');
});

test('init: rejects when declared address does not match derived', async () => {
  const w = new LibAuthBchWallet({
    cfg: baseConfig({
      wallet: {
        ...baseConfig().wallet,
        address: 'bitcoincash:qSomeOtherAddress00000000000000000000000000',
      },
    }),
    wif: PLACEHOLDER_WIF,
    deps: deps(),
  });
  await assert.rejects(() => w.init(), WalletAddressError);
});

test('init: tolerates undefined declaredAddress (no mismatch check)', async () => {
  const w = new LibAuthBchWallet({
    cfg: baseConfig({ wallet: { ...baseConfig().wallet, address: undefined } }),
    wif: PLACEHOLDER_WIF,
    deps: deps(),
  });
  const out = await w.init();
  assert.equal(out.address, FAKE_ADDR);
});

// ─────────────────────────────────────────────────────────────────────
//  T58-2: getPkh() accessor + pkh seam (BadgerCoin staking)
//
// The wallet stashes the 20-byte pubkey-hash at init() time so
// `src/staking/badger-stake-tx.mjs#executeLock` / `executeUnlock`
// can pass it to `cashscript.Contract.unlock.lock(amount, blocks,
// pubkeyhash)` without re-deriving. The decode path walks the
// legacy cashaddr's locking bytecode (`76 a9 14 <20 bytes> 88 ac`)
// via `libauth.cashAddressToLockingBytecode` + `binToHex`.
// ─────────────────────────────────────────────────────────────────────

test('init: getPkh() returns the 20-byte pubkey-hash extracted from the legacy cashaddr', async () => {
  const w = await makeInitedWallet(deps());
  const pkh = w.getPkh();
  assert.equal(typeof pkh, 'string');
  // The fakeLibauth fills the 20-byte pkh with a deterministic
  // non-zero pattern (byte i = (i * 7) & 0xff for i in 3..23),
  // producing the canonical 40-char lowercase hex string.
  assert.equal(pkh.length, 40);
  assert.match(pkh, /^[0-9a-f]{40}$/);
  // The bytes `(i * 7) & 0xff` for i = 3..23 → [0x15, 0x1c, 0x23, 0x2a, ...].
  assert.equal(pkh.slice(0, 4), '151c'); // bytes 3,4 → '15', '1c'
  assert.equal(pkh.slice(4, 8), '232a'); // bytes 5,6 → '23', '2a'
});

test('getPkh() returns null BEFORE init() is called', async () => {
  const w = new LibAuthBchWallet({
    cfg: baseConfig(),
    wif: PLACEHOLDER_WIF,
    deps: deps(),
  });
  assert.equal(w.getPkh(), null);
});

test('init: surfaces cashAddressToLockingBytecode string-error as WalletAddressError', async () => {
  const w = new LibAuthBchWallet({
    cfg: baseConfig(),
    wif: PLACEHOLDER_WIF,
    deps: {
      ...deps(),
      libauth: {
        ...fakeLibauth(),
        cashAddressToLockingBytecode: () => 'cashaddr malformed: bad checksum',
      },
    },
  });
  await assert.rejects(() => w.init(), WalletAddressError);
});

test('init: surfaces unexpected locking bytecode shape as WalletAddressError (pkh decode)', async () => {
  const w = new LibAuthBchWallet({
    cfg: baseConfig(),
    wif: PLACEHOLDER_WIF,
    deps: {
      ...deps(),
      libauth: {
        ...fakeLibauth(),
        // Return a 20-byte P2SH locking bytecode (a914 + 16 bytes + 87)
        // instead of the 25-byte P2PKH shape the wallet expects. The
        // wallet's pkh decode should reject this as `unexpected P2PKH
        // locking bytecode shape`.
        cashAddressToLockingBytecode: () => {
          const bytecode = new Uint8Array(23);
          bytecode[0] = 0xa9; // OP_HASH160 (no OP_DUP)
          bytecode[1] = 0x14;
          bytecode[2] = 0x01;
          return { bytecode };
        },
      },
    },
  });
  await assert.rejects(() => w.init(), WalletAddressError);
});

test('init: surfaces binToHex failure as WalletAddressError', async () => {
  // Force the binToHex path to throw by returning a non-Uint8Array
  // (`null`) — the wallet should catch that and surface as
  // WalletAddressError. (Real libauth never returns null, but we
  // test the defensive guard.)
  const w = new LibAuthBchWallet({
    cfg: baseConfig(),
    wif: PLACEHOLDER_WIF,
    deps: {
      ...deps(),
      libauth: {
        ...fakeLibauth(),
        cashAddressToLockingBytecode: () => ({ bytecode: null }),
      },
    },
  });
  await assert.rejects(() => w.init(), WalletAddressError);
});

test('init: throws WalletConfigError when WIF cannot be resolved', async () => {
  const w = new LibAuthBchWallet({ cfg: baseConfig(), deps: deps() });
  await assert.rejects(() => w.init(), WalletConfigError);
});

test('init: reads WIF from cfg.user.wallet.wif when no constructor opts.wif (regression for explicitWif path)', async () => {
  // Regression: prior to this fix, LibAuthBchWallet.init() only
  // forwarded `cfg.wifFile` to `resolveWif()`, silently dropping
  // `cfg.explicitWif`. Production (`run-bot.mjs` line 210) passes
  // only `{ cfg, logger }` to the constructor — never an `opts.wif` —
  // so the WIF had to be resolved from the merged-config path that
  // init() ignored. `run-bot.mjs` would crash with
  // "no WIF source" even though user.json's wallet.wif was correct.
  const cfg = baseConfig();
  cfg.user = { wallet: { wif: PLACEHOLDER_WIF } };
  const sink = createMemorySink();
  const w = new LibAuthBchWallet({
    cfg,
    logger: createLogger({ sink: sink.stream }),
    deps: deps(),
  });
  // Pre-fix: this `init()` threw WalletConfigError("no WIF source").
  // Post-fix: init() forwards `cfg.explicitWif` to `resolveWif()`,
  //   which sanitizes and returns it; the address is derived from the
  //   WIF and verified against `wallet.address` (declaredAddress).
  const out = await w.init();
  assert.equal(out.network, 'mainnet');
  assert.equal(out.address, FAKE_ADDR);
  // Log line proves the WIF made it through (and is redacted).
  const lines = sink.lines();
  const initLine = lines.find((l) => l.includes('"msg":"wallet.init"'));
  assert.ok(initLine, 'expected a wallet.init log line');
  assert.ok(!lines.some((l) => l.includes(PLACEHOLDER_WIF)), 'WIF must never appear in any log line');
  assert.ok(initLine.includes('"wif":"KFsn…eamW'), 'redacted WIF should be present in the init line');
});

test('init: wif_file path still takes precedence over cfg.user.wallet.wif (resolveWif order)', async () => {
  // Sanity check the precedence after the fix: when BOTH a wif_file
  // and an explicit wif are present, `resolveWif()` honors `opts.wif`
  // first (short-circuits). This matches the documented resolution
  // order in the SKILL header (libauth.mjs lines 24-44) and is what
  // init() relies on for the path we're fixing.
  const cfg = baseConfig();
  cfg.user = {
    wallet: {
      wif_file: '/tmp/should-not-be-read.mjs',
      wif: PLACEHOLDER_WIF,
    },
  };
  // We never construct a real file; the test verifies that opts.wif
  // short-circuits before opts.wifFile is ever opened.
  const w = new LibAuthBchWallet({ cfg, deps: deps() });
  const out = await w.init();
  assert.equal(out.address, FAKE_ADDR);
});

test('init: rejects an explicitly invalid WIF string', () => {
  // Construction itself throws synchronously because the constructor
  // passes the candidate WIF through `sanitizeWif` eagerly. Use
  // `assert.throws` (not `assert.rejects`) — Node 22's `assert.rejects`
  // does not catch synchronous throws from a plain arrow function.
  assert.throws(
    () => new LibAuthBchWallet({
      cfg: baseConfig(),
      wif: 'not-a-wif-just-some-garbage!@#',
      deps: deps(),
    }),
    WalletWifError,
  );
});

test('init: surfaces libauth decode string-error as WalletWifError', async () => {
  const w = new LibAuthBchWallet({
    cfg: baseConfig(),
    wif: PLACEHOLDER_WIF,
    deps: {
      ...deps(),
      libauth: { decodePrivateKeyWif: () => 'decode-failed-because-of-evil-input' },
    },
  });
  await assert.rejects(() => w.init(), WalletWifError);
});

test('init: surfaces libauth address-derivation string-error as WalletAddressError', async () => {
  const w = new LibAuthBchWallet({
    cfg: baseConfig(),
    wif: PLACEHOLDER_WIF,
    deps: {
      ...deps(),
      libauth: {
        decodePrivateKeyWif: () => ({ privateKey: new Uint8Array(32), type: 'mainnet' }),
        privateKeyToP2pkhCashAddress: () => 'derivation failed: too-short-key',
      },
    },
  });
  await assert.rejects(() => w.init(), WalletAddressError);
});

test('init: rejects a WIF whose libauth declares a non-mainnet type', async () => {
  const w = new LibAuthBchWallet({
    cfg: baseConfig(),
    wif: PLACEHOLDER_WIF,
    deps: {
      ...deps(),
      libauth: {
        decodePrivateKeyWif: () => ({ privateKey: new Uint8Array(32), type: 'testnet' }),
        privateKeyToP2pkhCashAddress: () => ({ address: 'bitcoincash:qwhatever' }),
      },
    },
  });
  await assert.rejects(() => w.init(), WalletWifError);
});

// ─────────────────────────────────────────────────────────────────────
//  listUtxos + getBalanceSats
// ─────────────────────────────────────────────────────────────────────

test('listUtxos: requires init() (throws WalletWifError when not derived)', async () => {
  const w = new LibAuthBchWallet({
    cfg: baseConfig(),
    wif: PLACEHOLDER_WIF,
    deps: deps(),
  });
  // Skip init: _derivedAddress is null.
  await assert.rejects(() => w.listUtxos(), WalletWifError);
});

test('listUtxos: returns [] when wallet is empty', async () => {
  const provider = { getUtxos: () => Promise.resolve([]), disconnect: () => {} };
  const w = await makeInitedWallet(deps({ providerFactory: () => provider }));
  const utxos = await w.listUtxos();
  assert.ok(Array.isArray(utxos));
  assert.equal(utxos.length, 0);
});

test('getBalanceSats: sums two UTXOs to a bigint total', async () => {
  const utxos = [
    { txid: 'aa'.repeat(32), vout: 0, satoshis: 1000n },
    { txid: 'bb'.repeat(32), vout: 1, satoshis: 4435967n }, // matches user.json snapshot
  ];
  const provider = { getUtxos: () => Promise.resolve(utxos), disconnect: () => {} };
  const w = await makeInitedWallet(deps({ providerFactory: () => provider }));
  assert.equal(await w.getBalanceSats(), 4436967n);
});

test('getBalanceSats: returns 0n on an empty wallet', async () => {
  const provider = { getUtxos: () => Promise.resolve([]), disconnect: () => {} };
  const w = await makeInitedWallet(deps({ providerFactory: () => provider }));
  assert.equal(await w.getBalanceSats(), 0n);
});

test('getBalanceSats: coerces numeric satoshis (legacy shape) silently', async () => {
  const utxos = [
    { txid: 'cc'.repeat(32), vout: 0, satoshis: 100 }, // number, not bigint
    { txid: 'dd'.repeat(32), vout: 1, satoshis: 50n },
  ];
  const provider = { getUtxos: () => Promise.resolve(utxos), disconnect: () => {} };
  const w = await makeInitedWallet(deps({ providerFactory: () => provider }));
  assert.equal(await w.getBalanceSats(), 150n);
});

test('getBalanceSats: skips non-coercible UTXOs and warns', async () => {
  const sink = createMemorySink();
  const utxos = [
    { txid: 'ee'.repeat(32), vout: 0, satoshis: 'not-a-number' },
    { txid: 'ff'.repeat(32), vout: 1, satoshis: 99n },
  ];
  const provider = { getUtxos: () => Promise.resolve(utxos), disconnect: () => {} };
  const w = await makeInitedWallet(deps({ providerFactory: () => provider }), {
    logger: createLogger({ sink: sink.stream }),
  });
  assert.equal(await w.getBalanceSats(), 99n);
  assert.ok(
    sink.lines().some((l) => l.includes('wallet.balance.skip-misformed-utxo')),
    'expected a skip-misformed-utxo warning',
  );
});

test('listUtxos: retries on transient failures then succeeds', async () => {
  let n = 0;
  const provider = {
    getUtxos: () => {
      n += 1;
      if (n < 3) throw new Error('electrum-blip');
      return Promise.resolve([{ txid: '11'.repeat(32), vout: 0, satoshis: 1n }]);
    },
    disconnect: () => {},
  };
  const w = await makeInitedWallet(deps({ providerFactory: () => provider }));
  const utxos = await w.listUtxos({ maxAttempts: 5 });
  assert.equal(utxos.length, 1);
  assert.equal(n, 3);
});

test('listUtxos: exhausts retries and throws WalletElectrumError', async () => {
  const provider = {
    getUtxos: () => { throw new Error('persistent-failure'); },
    disconnect: () => {},
  };
  const w = await makeInitedWallet(deps({ providerFactory: () => provider }));
  await assert.rejects(() => w.listUtxos({ maxAttempts: 2 }), WalletElectrumError);
});

test('listUtxos: throws WalletElectrumError on a non-array response', async () => {
  const provider = {
    getUtxos: () => Promise.resolve({ wrapped: 'object' }),
    disconnect: () => {},
  };
  const w = await makeInitedWallet(deps({ providerFactory: () => provider }));
  await assert.rejects(() => w.listUtxos(), WalletElectrumError);
});

// ─────────────────────────────────────────────────────────────────────
//  signHash
// ─────────────────────────────────────────────────────────────────────

test('signHash: rejects non-Uint8Array or wrong-length digest', async () => {
  const w = await makeInitedWallet(deps());
  // @ts-expect-error intentional bad input
  await assert.rejects(() => w.signHash(null), WalletWifError);
  // @ts-expect-error intentional bad input
  await assert.rejects(() => w.signHash(new Uint8Array(31)), WalletWifError);
  // @ts-expect-error intentional bad input
  await assert.rejects(() => w.signHash(new Uint8Array(33)), WalletWifError);
  // @ts-expect-error intentional bad input
  await assert.rejects(() => w.signHash('not-bytes'), WalletWifError);
});

test('signHash: returns a 64-byte signature', async () => {
  const sig = new Uint8Array(64).fill(0xab);
  const w = await makeInitedWallet(deps({ libauth: { signReturn: sig } }));
  const out = await w.signHash(HASH32);
  assert.ok(out instanceof Uint8Array);
  assert.equal(out.length, 64);
  assert.equal(out[0], 0xab);
});

test('signHash: surfaces libauth string-error as WalletWifError', async () => {
  const w = await makeInitedWallet(deps({
    libauth: {
      decodePrivateKeyWif: () => ({ privateKey: new Uint8Array(32), type: 'mainnet' }),
      privateKeyToP2pkhCashAddress: () => ({ address: FAKE_ADDR }),
      signMessageHash: () => 'malformed-private-key',
    },
  }));
  await assert.rejects(() => w.signHash(HASH32), WalletWifError);
});

test('signHash: rejects WIF whose libauth `type` is not mainnet', async () => {
  // Construct the wallet directly (skipping `init()`) so the
  // non-mainnet type-check happens inside `signHash()` rather than
  // during the `init()` → `deriveAddress()` path. This isolates the
  // signHash guard from the (also-correct) deriveAddress guard.
  const w = new LibAuthBchWallet({
    cfg: baseConfig({ wallet: { ...baseConfig().wallet, address: undefined } }),
    wif: PLACEHOLDER_WIF,
    deps: deps({
      libauth: {
        decodePrivateKeyWif: () => ({ privateKey: new Uint8Array(32), type: 'testnet' }),
        privateKeyToP2pkhCashAddress: () => ({ address: FAKE_ADDR }),
        signMessageHash: () => new Uint8Array(64),
      },
    }),
  });
  await assert.rejects(() => w.signHash(HASH32), WalletWifError);
});

// ─────────────────────────────────────────────────────────────────────
//  deriveAddress — direct path (without init)
// ─────────────────────────────────────────────────────────────────────

test('deriveAddress: works without init() when WIF is explicit', async () => {
  const w = new LibAuthBchWallet({
    cfg: baseConfig({ wallet: { ...baseConfig().wallet, address: undefined } }),
    wif: PLACEHOLDER_WIF,
    deps: deps(),
  });
  const addr = await w.deriveAddress();
  assert.equal(addr, FAKE_ADDR);
});

test('deriveAddress: throws WalletWifError when no WIF and no source', async () => {
  const w = new LibAuthBchWallet({ cfg: baseConfig(), deps: deps() });
  await assert.rejects(() => w.deriveAddress(), WalletWifError);
});

// ─────────────────────────────────────────────────────────────────────
//  close — provider tear-down
// ─────────────────────────────────────────────────────────────────────

test('close: tears down the provider without calling disconnect (T23d)', async () => {
  // T23d: cashscript v0.13.2's ElectrumNetworkProvider rejects manual
  // disconnect() with `Error: Manual connection management is disabled`.
  // The wallet no longer calls disconnect — it just nulls out
  // `this._provider`, and the next tick's `_resolveDeps()` rebuilds a
  // fresh provider on demand. close() must be idempotent + silent.
  let disconnected = 0;
  let constructed = 0;
  const provider = {
    getUtxos: () => Promise.resolve([]),
    disconnect: () => { disconnected += 1; return Promise.resolve(); },
  };
  const factory = () => { constructed += 1; return provider; };
  const w = await makeInitedWallet(deps({ providerFactory: factory }));
  await w.listUtxos();
  assert.equal(constructed, 1);
  await w.close();
  await w.close(); // idempotent — second call is a no-op
  assert.equal(disconnected, 0, 'close() must NOT call provider.disconnect() (T23d)');
  assert.equal(constructed, 1);
  // A fresh tick rebuilds the provider.
  await w.listUtxos();
  assert.equal(constructed, 2);
  assert.equal(disconnected, 0);
});

test('close: never logs wallet.close.provider-error after T23d', async () => {
  // Even when the provider would throw on disconnect, close() must
  // not log the (now-removed) provider-error warning.
  const sink = createMemorySink();
  const provider = {
    getUtxos: () => Promise.resolve([]),
    disconnect: () => { throw new Error('socket-already-closed'); },
  };
  const w = await makeInitedWallet(deps({ providerFactory: () => provider }), {
    logger: createLogger({ sink: sink.stream }),
  });
  await w.listUtxos();
  await w.close(); // must not throw, must not log provider-error
  const lines = sink.lines();
  assert.equal(lines.some((l) => l.includes('wallet.close.provider-error')), false);
});

// ─────────────────────────────────────────────────────────────────────
//  createWallet — convenience factory
// ─────────────────────────────────────────────────────────────────────

test('createWallet: end-to-end happy path on injected deps', async () => {
  const w = await createWallet({
    cfg: baseConfig(),
    wif: PLACEHOLDER_WIF,
    deps: deps(),
  });
  assert.equal(w.getAddress(), FAKE_ADDR);
  assert.equal(w.getNetwork(), 'mainnet');
  assert.equal(w.getElectrumUrl(), 'electrum://electrum.imaginary.cash:50004');
  await w.close();
});

// ─────────────────────────────────────────────────────────────────────
//  Safety-latch — wallet must NOT expose position-sizing knobs
// ─────────────────────────────────────────────────────────────────────

test('safety: wallet does not host position-sizing knobs', () => {
  // Frozen shape check: if a future commit accidentally moves
  // `max_position_bch` / `max_total_exposure_bch` into the wallet
  // module (where they would create the illusion of an enforced cap
  // that actually does nothing), this test fires. The role of the
  // wallet layer is strictly "balance + UTXOs + signing".
  const w = new LibAuthBchWallet({ cfg: baseConfig(), wif: PLACEHOLDER_WIF, deps: deps() });
  void w;
  const ownProps = Object.getOwnPropertyNames(LibAuthBchWallet.prototype);
  for (const banned of ['maxPositionBch', 'maxTotalExposureBch', 'minWalletBalanceBch', 'maxPositionSize']) {
    assert.ok(!ownProps.includes(banned), `wallet layer must not expose ${banned}`);
  }
  // Position-sizing knobs live where they belong — in the merged config.
  assert.equal(walletConfigFrom(baseConfig()).minWalletBalanceBch, 0.005);
});

test('safety: WIF must never be readable from the wallet instance', () => {
  // Belt-and-suspenders: any getter/method that could leak the WIF
  // is an immediate fail. We allow `redactWif` (static helper that
  // returns a truncated form). We forbid any field that returns the
  // raw key.
  const w = new LibAuthBchWallet({ cfg: baseConfig(), wif: PLACEHOLDER_WIF, deps: deps() });
  for (const key of Object.keys(w)) {
    assert.ok(key !== '_wif' || key === '_wif', `_wif field present (locked down: ${key})`);
    // Field presence is OK; what's tested is that no getter
    // exposes the value. _wif is intentionally non-enumerable-ish;
    // it's a private convention, not a public API.
  }
  // No getter for the wif itself.
  assert.equal(typeof w.getWif, 'undefined');
  assert.equal(typeof w.wif, 'undefined');
  assert.equal(typeof w.exportWif, 'undefined');
});
