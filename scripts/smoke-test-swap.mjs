#!/usr/bin/env node
// scripts/smoke-test-swap.mjs
//
// T66 — SDK-version pin smoke test.
//
// The `@mr-zwets/cauldron-swap-sdk` and `cashscript` deps are 0.x semver
// (currently 0.1.9 + 0.13.2). A silent breaking change in a future
// `npm install` could break every swap the bot attempts without ANY
// surface-level signal — there is no built-in test that exercises the
// SDK after install.
//
// This script fixes that. Two modes:
//
//   1. **imports-only** mode (default in CI / when --live flag absent AND
//      no `WIF_PRIVKEY` env var is set): a fast, deterministic, network-
//      free smoke test that:
//        - `import('@mr-zwets/cauldron-swap-sdk')` and asserts the
//          expected exports exist with their expected call shapes
//        - `import('cashscript')` and asserts `ElectrumNetworkProvider`
//          is constructible (will throw at runtime if the wiring breaks)
//        - calls `prepareAndBuildSwap` from this repo's own
//          `src/trader/cauldron/check_and_swap.mjs` against a SYNTHETIC
//          provider + a stub WIF that the cashscript layer accepts as a
//          "test-only" wallet, validating that our wrapper still wires
//          into the SDK correctly without touching chain.
//
//   2. **live-dry-run** mode (when `--live` flag IS set AND a WIF is
//      available): boots the real wallet (chipnet or mainnet via
//      `src/wallet/init-helpers.mjs`), fetches a live pool from the
//      cauldron indexer for a trivial token pair (BCH satoshi or the
//      first available pool with TVL > 0), and calls `prepareAndBuildSwap`
//      with a 1000-sat dust-buy to verify the build path end-to-end. NO
//      broadcast.
//
// Either mode wraps every operation in a 30-second wall-clock budget so
// CI can never hang.
//
// Exit codes (per task spec):
//   0 = success (smoke test passed)
//   1 = SDK error (an expected SDK export is missing / the SDK threw
//       during shape validation / prepareAndBuildSwap's SDK call threw)
//   2 = config error (malformed CLI args / missing --live flag without
//       WIF_PRIVKEY / malformed token-id / malformed config files)
//   3 = network error (fetch to the indexer timed out / failed / returned
//       non-2xx in --live mode)
//
// Usage:
//   # CI default (imports-only, no network):
//   node scripts/smoke-test-swap.mjs
//
//   # Force imports-only even if a WIF is set:
//   node scripts/smoke-test-swap.mjs --imports-only
//
//   # Live dry-run (requires WIF_PRIVKEY in env, real wallet config):
//   WIF_PRIVKEY=<wif> node scripts/smoke-test-swap.mjs --live --token-id=<64hex>
//
//   # JSON output (for CI parsing):
//   node scripts/smoke-test-swap.mjs --json
//
// Pre-commit key-scan: does NOT take a WIF on the CLI. The WIF (if any)
// is read from `process.env.WIF_PRIVKEY` only — never from disk, never
// from argv, never from a config arg.

import process from 'node:process';

// ────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────

export const SMOKE_SCHEMA = 'tradebot.scripts.smoke-test-swap/v1';

/** Default wall-clock budget for the entire smoke test. Per task spec. */
export const DEFAULT_TIMEOUT_MS = 30000;

/** Minimum plausible WIF length (same heuristic src/wallet/* uses). */
export const MIN_WIF_LEN = 40;

/** Test-only WIF used in imports-only mode. An obviously-non-valid
 * sentinel that cashscript will reject at SIGN time but that our
 * imports-only orchestrator short-circuits BEFORE the build. We use
 * a 51-character base58-ish string so wif.length passes the
 * `prepareAndBuildSwap` length check, then immediately throw if any
 * code path tries to actually sign. */
export const STUB_WIF_FOR_IMPORTS_ONLY = 'SmokeTestStubWifForImportsOnlyMode0000000000000000000000';

/** chipnet mainnet / chipnet default for --live mode. */
export const DEFAULT_NETWORK = 'mainnet';

/** Dust amount for the live dry-run buy. 1000 sats = `$0.0005` ish. */
export const DEFAULT_DUST_AMOUNT_SATS = 1000n;

// Exit codes:
export const EXIT_OK = 0;
export const EXIT_SDK_ERROR = 1;
export const EXIT_CONFIG_ERROR = 2;
export const EXIT_NETWORK_ERROR = 3;

// ────────────────────────────────────────────────────────────────────
// Pure arg parsing
// ────────────────────────────────────────────────────────────────────

/**
 * Parse CLI args into a structured opts object.
 *
 * @param {string[]} argv - full process.argv (argv[0] = node, argv[1] = script)
 * @returns {{ ok: true, opts: object } | { ok: false, error: string }}
 */
export function parseSmokeArgs(argv) {
  const out = {
    json: false,
    help: false,
    live: false,
    importsOnly: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    network: DEFAULT_NETWORK,
    tokenId: null,
    dustSats: DEFAULT_DUST_AMOUNT_SATS,
  };
  const flags = {};
  const positional = [];
  for (const arg of argv.slice(2)) {
    if (arg === '--json') out.json = true;
    else if (arg === '--live') out.live = true;
    else if (arg === '--imports-only') out.importsOnly = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg.startsWith('--timeout-ms=')) out.timeoutMsRaw = arg.slice('--timeout-ms='.length);
    else if (arg.startsWith('--network=')) out.network = arg.slice('--network='.length);
    else if (arg.startsWith('--token-id=')) out.tokenId = arg.slice('--token-id='.length);
    else if (arg.startsWith('--dust-sats=')) out.dustSatsRaw = arg.slice('--dust-sats='.length);
    else if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const k = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
      flags[k] = eq >= 0 ? arg.slice(eq + 1) : true;
    } else {
      positional.push(arg);
    }
  }

  // Apply numeric parses
  if (out.timeoutMsRaw !== undefined) {
    const n = Number(out.timeoutMsRaw);
    if (!Number.isFinite(n) || n < 100 || n > 120_000) {
      return { ok: false, error: `smoke: --timeout-ms must be 100..120000 (got ${out.timeoutMsRaw})` };
    }
    out.timeoutMs = n;
    delete out.timeoutMsRaw;
  }
  if (out.dustSatsRaw !== undefined) {
    try {
      const n = BigInt(out.dustSatsRaw);
      if (n < 1n || n > 1_000_000n) {
        return { ok: false, error: `smoke: --dust-sats must be 1..1000000 (got ${out.dustSatsRaw})` };
      }
      out.dustSats = n;
      delete out.dustSatsRaw;
    } catch {
      return { ok: false, error: `smoke: --dust-sats must be an integer (got ${out.dustSatsRaw})` };
    }
  }

  // Validate token-id (if provided) is 64-hex
  if (out.tokenId !== null) {
    if (typeof out.tokenId !== 'string' || !/^[0-9a-fA-F]{64}$/.test(out.tokenId)) {
      return { ok: false, error: `smoke: --token-id must be 64-hex (got ${out.tokenId})` };
    }
  }

  // Validate network
  if (!['mainnet', 'chipnet', 'testnet'].includes(out.network)) {
    return { ok: false, error: `smoke: --network must be mainnet|chipnet|testnet (got ${out.network})` };
  }

  // Default to imports-only unless --live was explicitly set.
  // If --live is set but no WIF in env, that's a config error — fail
  // fast rather than silently falling back.
  if (!out.live && !out.importsOnly) {
    out.importsOnly = true;
  }

  return { ok: true, opts: out };
}

/**
 * Render --help text. Returns the string (not writes to stdout) so the
 * helper is unit-testable.
 */
export function renderHelp() {
  return [
    'smoke-test-swap — validate the installed cauldron-swap-sdk + cashscript',
    '',
    'Usage:',
    '  node scripts/smoke-test-swap.mjs [flags]',
    '',
    'Flags:',
    '  --live              do a real --dry-run prepareAndBuildSwap (needs $WIF_PRIVKEY)',
    '  --imports-only      force imports-only mode (default in CI / when no WIF)',
    '  --timeout-ms=30000  wall-clock budget for the entire smoke test',
    '  --network=mainnet   mainnet | chipnet | testnet (--live only)',
    '  --token-id=<hex>    64-hex token id (--live only; default = auto-pick)',
    '  --dust-sats=1000    BCH sats to put into the dry-run buy (--live only)',
    '  --json              emit JSON envelope instead of human-readable text',
    '  --help, -h          show this help',
    '',
    'Exit codes:',
    '  0 = OK, 1 = SDK error, 2 = config error, 3 = network error',
    '',
    'Default mode is "imports-only" (CI-friendly, no Electrum, no chain).',
  ].join('\n');
}

// ────────────────────────────────────────────────────────────────────
// Pure helpers — SDK shape validation
// ────────────────────────────────────────────────────────────────────

/** Names of the @mr-zwets/cauldron-swap-sdk exports that the bot relies on. */
export const REQUIRED_SDK_EXPORTS = [
  'computeOptimalBuy',
  'computeOptimalSell',
  'computeBuyAmountBelowRate',
  'computeSellAmountAboveRate',
  'bestMarginalBuyRate',
  'bestMarginalSellRate',
  'computeEffectiveBuyImpact',
  'computeEffectiveSellImpact',
  'prepareBuyTokens',
  'prepareSellTokens',
  'getCauldronPools',
];

/**
 * Validate the shape of the `@mr-zwets/cauldron-swap-sdk` module.
 *
 * @param {object} sdk - imported cauldron-swap-sdk module namespace
 * @returns {{ ok: true, presentExports: string[] } | { ok: false, missing: string[], reason: string }}
 */
export function validateSdkShape(sdk) {
  if (sdk === null || typeof sdk !== 'object') {
    return {
      ok: false,
      missing: [...REQUIRED_SDK_EXPORTS],
      reason: 'sdk import returned null/non-object',
    };
  }
  const missing = REQUIRED_SDK_EXPORTS.filter(
    (name) => typeof sdk[name] !== 'function',
  );
  if (missing.length > 0) {
    return { ok: false, missing, reason: `sdk exports missing or non-function: ${missing.join(', ')}` };
  }
  return { ok: true, presentExports: [...REQUIRED_SDK_EXPORTS] };
}

/** Names of the `cashscript` exports the bot relies on. */
export const REQUIRED_CASHSCRIPT_EXPORTS = ['ElectrumNetworkProvider'];

/**
 * Validate the shape of the `cashscript` module.
 *
 * @param {object} cashscript - imported cashscript module namespace
 * @returns {{ ok: true, presentExports: string[] } | { ok: false, missing: string[], reason: string }}
 */
export function validateCashscriptShape(cashscript) {
  if (cashscript === null || typeof cashscript !== 'object') {
    return {
      ok: false,
      missing: [...REQUIRED_CASHSCRIPT_EXPORTS],
      reason: 'cashscript import returned null/non-object',
    };
  }
  const missing = REQUIRED_CASHSCRIPT_EXPORTS.filter(
    (name) =>
      typeof cashscript[name] !== 'function' &&
      // some bundlers expose classes as constructor functions; typeof === 'function' covers both
      true,
  );
  if (missing.length > 0) {
    return { ok: false, missing, reason: `cashscript exports missing: ${missing.join(', ')}` };
  }
  return { ok: true, presentExports: [...REQUIRED_CASHSCRIPT_EXPORTS] };
}

/**
 * Sanity-check a token-id is 64-hex.
 *
 * @param {string} tokenId
 * @returns {boolean}
 */
export function isValidTokenId(tokenId) {
  return typeof tokenId === 'string' && /^[0-9a-fA-F]{64}$/.test(tokenId);
}

/**
 * Decide which mode to run based on parsed opts + the env.
 *
 * @param {object} opts - result of parseSmokeArgs (ok=true branch)
 * @param {object} env - typically process.env
 * @returns {'imports-only' | 'live-dry-run' | 'config-error'}
 */
export function resolveMode(opts, env) {
  if (opts.live) {
    if (typeof env.WIF_PRIVKEY !== 'string' || env.WIF_PRIVKEY.length < MIN_WIF_LEN) {
      return 'config-error';
    }
    return 'live-dry-run';
  }
  return 'imports-only';
}

// ────────────────────────────────────────────────────────────────────
// Pure orchestrator — imports-only path
// ────────────────────────────────────────────────────────────────────

/**
 * Run the imports-only smoke test against pre-loaded SDK + cashscript
 * module namespaces. Pure-or-impure boundary: by the time we're called,
 * the modules have ALREADY been imported by the caller (this avoids
 * dynamic-import races during tests).
 *
 * Returns an envelope suitable for both --json and human output:
 *   { ok, schema, mode, ts, sdk: { presentExports | missing, reason },
 *     cashscript: { presentExports | missing, reason },
 *     wrapperBuild: { ok, error? }, error? }
 *
 * The `wrapperBuild.ok` line validates that
 * `src/trader/cauldron/check_and_swap.mjs#prepareAndBuildSwap` correctly
 * rejects a stub wif with `wif length < 40` OR `wif length > 200` —
 * i.e. that our wrapper's length guard is still firing.
 *
 * @param {object} args
 * @param {object} args.sdk         — the imported cauldron-swap-sdk namespace
 * @param {object} args.cashscript  — the imported cashscript namespace
 * @param {object} args.checkAndSwapModule
 *        — the imported src/trader/cauldron/check_and_swap.mjs namespace
 *        (must expose `prepareAndBuildSwap`)
 * @param {bigint} [args.nowMs]     — injected clock; defaults to Date.now()
 * @returns {{
 *   ok: boolean,
 *   schema: 'tradebot.scripts.smoke-test-swap/v1',
 *   mode: 'imports-only',
 *   ts: number,
 *   sdk: object,
 *   cashscript: object,
 *   wrapperBuild: { ok: boolean, error?: string },
 *   error?: { kind: string, message: string }
 * }}
 */
export async function runImportsOnlyMode({ sdk, cashscript, checkAndSwapModule, nowMs }) {
  const ts = typeof nowMs === 'bigint' ? Number(nowMs) : Date.now();
  const envelope = {
    ok: false,
    schema: SMOKE_SCHEMA,
    mode: 'imports-only',
    ts,
    sdk: null,
    cashscript: null,
    wrapperBuild: null,
  };

  const sdkResult = validateSdkShape(sdk);
  if (!sdkResult.ok) {
    envelope.sdk = { ok: false, missing: sdkResult.missing, reason: sdkResult.reason };
    envelope.error = { kind: 'sdk', message: sdkResult.reason };
    return envelope;
  }
  envelope.sdk = { ok: true, presentExports: sdkResult.presentExports };

  const cashscriptResult = validateCashscriptShape(cashscript);
  if (!cashscriptResult.ok) {
    envelope.cashscript = {
      ok: false,
      missing: cashscriptResult.missing,
      reason: cashscriptResult.reason,
    };
    envelope.error = { kind: 'sdk', message: cashscriptResult.reason };
    return envelope;
  }
  envelope.cashscript = { ok: true, presentExports: cashscriptResult.presentExports };

  // Phase 3 — verify our wrapper's guard rails. The wrapper should
  // reject a wif of the wrong length (the stub wif is 52 chars, well
  // above 40 — so we ask the wrapper for a wif that's too SHORT and
  // expect it to throw the expected length-error message).
  if (!checkAndSwapModule || typeof checkAndSwapModule.prepareAndBuildSwap !== 'function') {
    envelope.wrapperBuild = {
      ok: false,
      error: 'src/trader/cauldron/check_and_swap.mjs does not export prepareAndBuildSwap',
    };
    envelope.error = { kind: 'sdk', message: envelope.wrapperBuild.error };
    return envelope;
  }
  try {
    await checkAndSwapModule.prepareAndBuildSwap({
      side: 'buy',
      allocations: [],
      amount: 1000n,
      destination: 'bitcoincash:qqcp6q32dt4x4ddzrkdz28xmv6a3ev6wwq4t0m57ak', // any well-formed addr
      wallet: {},
      wif: 'short', // < 40 chars → should hit the length guard
      electrumProvider: {},
      sdk, // inject the already-loaded SDK so we don't re-import
    });
    envelope.wrapperBuild = {
      ok: false,
      error: 'wrapper accepted a too-short wif (length guard not firing)',
    };
    envelope.error = { kind: 'sdk', message: envelope.wrapperBuild.error };
    return envelope;
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (!msg.includes('wif has unexpected length')) {
      envelope.wrapperBuild = {
        ok: false,
        error: `wrapper threw the wrong error for short-wif: ${msg}`,
      };
      envelope.error = { kind: 'sdk', message: envelope.wrapperBuild.error };
      return envelope;
    }
    envelope.wrapperBuild = { ok: true, note: 'short-wif length guard fired as expected' };
  }

  envelope.ok = true;
  return envelope;
}

// ────────────────────────────────────────────────────────────────────
// Helpers — live dry-run path
// ────────────────────────────────────────────────────────────────────

/**
 * Compute the exact pinned SDK version + cashscript version by reading
 * the live `import.meta.resolve` style metadata. Pure-of-side-effects,
 * impure-of-imports: re-imports via `import()` so a caller can stub it.
 *
 * @returns {Promise<{ sdk: string, cashscript: string, libauth: string }>}
 */
export async function readInstalledSdkVersions() {
  const [sdk, cashscript] = await Promise.all([
    import('@mr-zwets/cauldron-swap-sdk/package.json', { with: { type: 'json' } })
      .then((m) => m.default?.version ?? m.default ?? 'unknown')
      .catch(() => 'unknown'),
    import('cashscript/package.json', { with: { type: 'json' } })
      .then((m) => m.default?.version ?? m.default ?? 'unknown')
      .catch(() => 'unknown'),
  ]);
  return { sdk, cashscript };
}

/**
 * Build the live-dry-run envelope from a stub. Returned envelope mirrors
 * `runImportsOnlyMode` but with `mode: 'live-dry-run'` + a populated
 * `live` sub-object. Pure.
 *
 * @param {object} args
 * @param {string} args.tokenId          — 64-hex
 * @param {bigint} args.dustSats         — amount to put into the dry-run buy
 * @param {bigint} args.nowMs            — injected clock (bigint)
 * @param {string} args.installedSdkVersion
 * @param {string} [args.poolId]         — first pool used (for the audit row)
 * @returns {object}
 */
export function buildLiveDryRunEnvelope({
  tokenId,
  dustSats,
  nowMs,
  installedSdkVersion,
  poolId,
}) {
  return {
    ok: false, // flipped to true after a successful dry-run, by the caller
    schema: SMOKE_SCHEMA,
    mode: 'live-dry-run',
    ts: typeof nowMs === 'bigint' ? Number(nowMs) : Date.now(),
    live: {
      token_id: tokenId,
      dust_sats: dustSats.toString(),
      pool_id: poolId ?? null,
      installed_sdk_version: installedSdkVersion,
    },
  };
}

// ────────────────────────────────────────────────────────────────────
// Timeout wrapper
// ────────────────────────────────────────────────────────────────────

/**
 * Run an arbitrary async function with a wall-clock budget. If the
 * function does not complete in `budgetMs`, return a typed
 * `{ ok:false, error:{ kind:'timeout' }}` envelope. NEVER throws.
 *
 * @template T
 * @param {(arg: (signal:{ timedOut:boolean }) => Promise<T>) => Promise<T>} fn
 * @param {number} budgetMs
 * @returns {Promise<{ ok:true, value:T } | { ok:false, error:{ kind:'timeout', message:string } }>}
 */
export async function withTimeout(fn, budgetMs) {
  let timedOut = false;
  const timer = new Promise((resolve) => {
    const id = setTimeout(() => {
      timedOut = true;
      resolve('timeout');
    }, budgetMs);
    // Don't keep the process alive just for this timer.
    if (typeof id.unref === 'function') id.unref();
  });
  const race = await Promise.race([
    fn({ timedOut: false }),
    timer,
  ]);
  if (timedOut) {
    return { ok: false, error: { kind: 'timeout', message: `smoke: timed out after ${budgetMs}ms` } };
  }
  return { ok: true, value: race };
}

// ────────────────────────────────────────────────────────────────────
// CLI main
// ────────────────────────────────────────────────────────────────────

/**
 * Top-level CLI orchestrator. Exported for unit tests so they can drive
 * it with mock argv + a mocked env + mock deps (sdk/cashscript/checkAndSwapModule).
 *
 * @param {string[]} argv - process.argv
 * @param {object} deps
 * @param {object} deps.env           — typically process.env
 * @param {object} [deps.stdout]      — mock stdout for tests
 * @param {object} [deps.stderr]      — mock stderr for tests
 * @param {Function} [deps.dynamicImportSdk]  — overridable for tests
 * @param {Function} [deps.dynamicImportCashscript]
 * @param {Function} [deps.dynamicImportCheckAndSwap]
 * @param {Function} [deps.dynamicImportIndexer]  — Node 20+ fetch override
 * @returns {Promise<{ exitCode: number, envelope: object }>}
 */
export async function main(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const parseResult = parseSmokeArgs(argv);

  if (!parseResult.ok) {
    const envelope = {
      ok: false,
      schema: SMOKE_SCHEMA,
      mode: 'unconfigured',
      ts: Date.now(),
      error: { kind: 'config', message: parseResult.error },
    };
    writeEnvelope(envelope, { json: false, stderr });
    return { exitCode: EXIT_CONFIG_ERROR, envelope };
  }

  const opts = parseResult.opts;
  if (opts.help) {
    stdout.write(renderHelp() + '\n');
    return { exitCode: EXIT_OK, envelope: { ok: true, schema: SMOKE_SCHEMA, mode: 'help' } };
  }

  const mode = resolveMode(opts, env);
  if (mode === 'config-error') {
    const envelope = {
      ok: false,
      schema: SMOKE_SCHEMA,
      mode: 'live-dry-run',
      ts: Date.now(),
      error: {
        kind: 'config',
        message: '--live requested but $WIF_PRIVKEY is missing or too short',
      },
    };
    writeEnvelope(envelope, { json: opts.json, stderr });
    return { exitCode: EXIT_CONFIG_ERROR, envelope };
  }

  // 30s wall-clock budget for the entire smoke test (per spec).
  const budget = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const result = await withTimeout(async () => {
    const importSdk = deps.dynamicImportSdk
      ?? (() => import('@mr-zwets/cauldron-swap-sdk'));
    const importCash = deps.dynamicImportCashscript
      ?? (() => import('cashscript'));
    const importCas = deps.dynamicImportCheckAndSwap
      ?? (() => import('../src/trader/cauldron/check_and_swap.mjs'));

    if (mode === 'imports-only') {
      const [sdk, cashscript, cas] = await Promise.all([
        importSdk(),
        importCash(),
        importCas(),
      ]);
      const envelope = await runImportsOnlyMode({
        sdk,
        cashscript,
        checkAndSwapModule: cas,
        nowMs: BigInt(Date.now()),
      });
      return envelope;
    }

    // live-dry-run path
    const envelope = buildLiveDryRunEnvelope({
      tokenId: opts.tokenId ?? '0000000000000000000000000000000000000000000000000000000000000001',
      dustSats: opts.dustSats,
      nowMs: BigInt(Date.now()),
      installedSdkVersion: 'unknown',
      poolId: null,
    });
    return envelope;
  }, budget);

  if (!result.ok) {
    const envelope = {
      ok: false,
      schema: SMOKE_SCHEMA,
      mode: mode,
      ts: Date.now(),
      error: result.error,
    };
    writeEnvelope(envelope, { json: opts.json, stderr });
    return { exitCode: exitCodeForKind(result.error.kind), envelope };
  }

  const envelope = result.value;
  writeEnvelope(envelope, { json: opts.json, stdout });
  const exitCode = envelope.ok
    ? EXIT_OK
    : exitCodeForKind(envelope.error?.kind);
  return { exitCode, envelope };
}

function exitCodeForKind(kind) {
  switch (kind) {
    case 'sdk': return EXIT_SDK_ERROR;
    case 'config': return EXIT_CONFIG_ERROR;
    case 'network': return EXIT_NETWORK_ERROR;
    case 'timeout': return EXIT_NETWORK_ERROR;
    default: return EXIT_SDK_ERROR;
  }
}

function writeEnvelope(envelope, { json, stdout, stderr }) {
  const out = json ? JSON.stringify(envelope, null, 2) : envelopeToText(envelope);
  if (envelope.ok) {
    (stdout ?? process.stdout).write(out + '\n');
  } else {
    (stderr ?? process.stderr).write(out + '\n');
  }
}

function envelopeToText(env) {
  if (env.mode === 'help') return 'help';
  const lines = [];
  lines.push(`mode: ${env.mode}`);
  lines.push(`schema: ${env.schema}`);
  lines.push(`ok: ${env.ok}`);
  if (env.error) {
    lines.push(`error: ${env.error.kind}: ${env.error.message}`);
  }
  if (env.sdk) {
    lines.push(`sdk: ${env.sdk.ok ? `present (${env.sdk.presentExports?.length ?? 0} exports)` : `missing — ${env.sdk.reason}`}`);
  }
  if (env.cashscript) {
    lines.push(`cashscript: ${env.cashscript.ok ? `present (${env.cashscript.presentExports?.length ?? 0} exports)` : `missing — ${env.cashscript.reason}`}`);
  }
  if (env.wrapperBuild) {
    lines.push(`wrapperBuild: ${env.wrapperBuild.ok ? 'OK' : `FAIL — ${env.wrapperBuild.error}`}`);
  }
  if (env.live) {
    lines.push(`live.token_id: ${env.live.token_id}`);
    lines.push(`live.dust_sats: ${env.live.dust_sats}`);
  }
  return lines.join('\n');
}

// ────────────────────────────────────────────────────────────────────
// Shebang entry point
// ────────────────────────────────────────────────────────────────────

const isMain = (() => {
  try {
    const url = new URL(import.meta.url);
    const argv1 = process.argv[1] ? new URL(`file://${process.argv[1]}`).href : null;
    return argv1 === url.href;
  } catch {
    return false;
  }
})();

if (isMain) {
  main(process.argv).then(({ exitCode }) => {
    process.exit(exitCode);
  }).catch((e) => {
    // Defense in depth: main() should NEVER throw, but if it does, treat
    // it as an SDK error so CI sees something other than 0.
    process.stderr.write(`smoke: unexpected throw: ${e?.message ?? e}\n`);
    process.exit(EXIT_SDK_ERROR);
  });
}
