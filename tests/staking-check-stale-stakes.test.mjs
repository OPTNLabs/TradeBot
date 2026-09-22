// tests/staking-check-stale-stakes.test.mjs
//
// T58 subset 5 — CLI tests for `scripts/check-stale-stakes.mjs`.
//
// Mirrors the test pattern from `tests/alerts-orphan-position.test.mjs`:
//   - CLI arg parsing (`parseCheckStaleStakesArgs` /
//     `resolveCheckStaleStakesArgs`).
//   - `main()` orchestrator with stubbed wallet + provider + executor
//     + dispatcher seams (no real chain, no real disk writes).
//
// The helper `src/staking/find-mature-lock-nfts.mjs` is exercised
// independently in `tests/staking-find-mature-lock-nfts.test.mjs`;
// these tests focus on the CLI surface: config gate, exit codes,
// dispatch wiring, defensive guards.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCheckStaleStakesArgs,
  resolveCheckStaleStakesArgs,
  main,
} from '../scripts/check-stale-stakes.mjs';

// ─── Fixtures ────────────────────────────────────────────────────────────

const NOW_MS = 1_700_000_000_000;
const MASTER_CAT = 'd7ff0a63d5c1cbe1ced509314fe3caca563a73095be37734744c40dbce6e2f24';
const SAMPLE_USER_PKH = 'cd'.repeat(20);

function buildLockCommitment({ stakeBlocks = 1440, userPkhHex = SAMPLE_USER_PKH } = {}) {
  const userPkh = Buffer.from(userPkhHex, 'hex');
  const reserved = Buffer.alloc(18, 0);
  const stake = Buffer.from([(stakeBlocks >> 8) & 0xff, stakeBlocks & 0xff]);
  return Buffer.concat([userPkh, reserved, stake]).toString('hex');
}

function lockNftUtxo({ stakeBlocks = 1440, lockBlockHeight = 0, txidSuffix = '00' } = {}) {
  return {
    txid: ('aa'.repeat(31)) + txidSuffix,
    vout: 0,
    satoshis: 50000n,
    token: {
      tokenId: MASTER_CAT + '01',
      capability: '0x01',
      commitment: buildLockCommitment({ stakeBlocks }),
      amount: 1n,
    },
    lockBlockHeight,
  };
}

function bchOnlyUtxo(sats) {
  return { txid: 'bb'.repeat(32), vout: 0, satoshis: BigInt(sats) };
}

function defaultCfg(overrides = {}) {
  return {
    staking: {
      enabled: true,
      simulation_only: false,
      unlock_cron_enabled: true,
      unlock_cron_minutes: 15,
      lock_unlock_grace_seconds: 60,
      ...overrides,
    },
    network: 'mainnet',
    electrum_url: 'electrum.imaginary.cash:50004',
  };
}

// ─── parseCheckStaleStakesArgs ───────────────────────────────────────────

test('T58-5: parseCheckStaleStakesArgs defaults', () => {
  const { flags } = parseCheckStaleStakesArgs(['node', 'check-stale-stakes.mjs']);
  const args = resolveCheckStaleStakesArgs(flags);
  assert.equal(args.json, false);
  assert.equal(args.quiet, false);
  assert.equal(args.dryRun, false);
  assert.equal(args.noDispatch, false);
  assert.equal(args.maxUnlocks, 1);
  assert.equal(args.force, false);
  assert.equal(args.tipHeightOverride, null);
  assert.equal(args.help, false);
});

test('T58-5: parseCheckStaleStakesArgs flags (full surface)', () => {
  const { flags } = parseCheckStaleStakesArgs([
    'node', 'check-stale-stakes.mjs',
    '--json', '--quiet', '--dry-run', '--no-dispatch',
    '--max-unlocks=3', '--force', '--tip-height=12345',
  ]);
  const args = resolveCheckStaleStakesArgs(flags);
  assert.equal(args.json, true);
  assert.equal(args.quiet, true);
  assert.equal(args.dryRun, true);
  assert.equal(args.noDispatch, true);
  assert.equal(args.maxUnlocks, 3);
  assert.equal(args.force, true);
  assert.equal(args.tipHeightOverride, 12345);
});

test('T58-5: parseCheckStaleStakesArgs --help sets help=true', () => {
  const { flags } = parseCheckStaleStakesArgs(['node', 'check-stale-stakes.mjs', '--help']);
  assert.equal(resolveCheckStaleStakesArgs(flags).help, true);
});

test('T58-5: resolveCheckStaleStakesArgs rejects unknown flags', () => {
  const { flags } = parseCheckStaleStakesArgs(['node', 'check-stale-stakes.mjs', '--wat']);
  assert.throws(() => resolveCheckStaleStakesArgs(flags), /unknown flag --wat/);
});

test('T58-5: resolveCheckStaleStakesArgs rejects --max-unlocks out of range', () => {
  for (const bad of ['0', '-1', 'abc', '101']) {
    const { flags } = parseCheckStaleStakesArgs(['node', 'check-stale-stakes.mjs', `--max-unlocks=${bad}`]);
    assert.throws(() => resolveCheckStaleStakesArgs(flags), /max-unlocks/);
  }
});

test('T58-5: resolveCheckStaleStakesArgs rejects --tip-height out of range', () => {
  for (const bad of ['-1', 'abc']) {
    const { flags } = parseCheckStaleStakesArgs(['node', 'check-stale-stakes.mjs', `--tip-height=${bad}`]);
    assert.throws(() => resolveCheckStaleStakesArgs(flags), /tip-height/);
  }
});

// ─── main() — arg parsing ────────────────────────────────────────────────

test('T58-5: main() returns code=0 on --help', async () => {
  process.env.STALE_STAKES_HELP_QUIET = '1';
  try {
    const result = await main({ argv: ['node', 'check-stale-stakes.mjs', '--help'] });
    assert.equal(result.code, 0);
    assert.equal(result.ok, true);
    assert.equal(result.args.help, true);
  } finally {
    delete process.env.STALE_STAKES_HELP_QUIET;
  }
});

test('T58-5: main() returns code=3 on unknown flag', async () => {
  const result = await main({ argv: ['node', 'check-stale-stakes.mjs', '--unknown'] });
  assert.equal(result.code, 3);
  assert.equal(result.ok, false);
  assert.match(result.error, /unknown flag/);
});

// ─── main() — config gate ────────────────────────────────────────────────

test('T58-5: main() returns code=0 when unlock_cron_enabled=false (no --force)', async () => {
  const cfg = defaultCfg({ unlock_cron_enabled: false });
  const result = await main({
    argv: ['node', 'check-stale-stakes.mjs', '--json'],
    deps: {
      loadConfig: async () => cfg,
      nowMs: () => NOW_MS,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    },
  });
  assert.equal(result.code, 0);
  assert.equal(result.ok, true);
  assert.equal(result.report.config_disabled, true);
  assert.equal(result.report.mature.length, 0);
});

test('T58-5: main() --force bypasses unlock_cron_enabled gate', async () => {
  const cfg = defaultCfg({ unlock_cron_enabled: false });
  // Stub wallet returns zero lockNFTs, so the scan still finds
  // nothing — the test confirms --force doesn't crash on the gate.
  const wallet = {
    getUtxos: async () => [],
    getBlockHeight: async () => 0,
  };
  const result = await main({
    argv: ['node', 'check-stale-stakes.mjs', '--json', '--force'],
    deps: {
      loadConfig: async () => cfg,
      wallet,
      nowMs: () => NOW_MS,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    },
  });
  assert.equal(result.code, 0);
  assert.equal(result.report.config_disabled, false);
  assert.equal(result.report.forced, true);
  assert.equal(result.report.mature.length, 0);
});

// ─── main() — wallet / config error ──────────────────────────────────────

test('T58-5: main() returns code=2 when config load fails', async () => {
  const result = await main({
    argv: ['node', 'check-stale-stakes.mjs', '--json'],
    deps: {
      loadConfig: async () => { throw new Error('cfg-broken'); },
      nowMs: () => NOW_MS,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    },
  });
  assert.equal(result.code, 2);
  assert.equal(result.ok, false);
  assert.match(result.error, /cfg-broken/);
});

test('T58-5: main() returns code=2 when wallet.listUtxos throws (non-dry-run)', async () => {
  const wallet = {
    getUtxos: async () => { throw new Error('electrum-down'); },
    getBlockHeight: async () => 0,
  };
  const result = await main({
    argv: ['node', 'check-stale-stakes.mjs', '--json'],
    deps: {
      loadConfig: async () => defaultCfg(),
      wallet,
      nowMs: () => NOW_MS,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    },
  });
  assert.equal(result.code, 2);
  assert.equal(result.ok, false);
  assert.match(result.error, /electrum-down/);
});

test('T58-5: main() returns code=2 when wallet.getBlockHeight throws (non-dry-run)', async () => {
  const wallet = {
    getUtxos: async () => [bchOnlyUtxo(1_000_000n)],
    getBlockHeight: async () => { throw new Error('tip-down'); },
  };
  const result = await main({
    argv: ['node', 'check-stale-stakes.mjs', '--json'],
    deps: {
      loadConfig: async () => defaultCfg(),
      wallet,
      nowMs: () => NOW_MS,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    },
  });
  assert.equal(result.code, 2);
  assert.equal(result.ok, false);
  assert.match(result.error, /tip-down/);
});

// ─── main() — clean scan ─────────────────────────────────────────────────

test('T58-5: main() clean tree (no lockNFTs) returns code=0', async () => {
  const wallet = {
    getUtxos: async () => [bchOnlyUtxo(1_000_000n)],
    getBlockHeight: async () => 100_000,
  };
  const result = await main({
    argv: ['node', 'check-stale-stakes.mjs', '--json'],
    deps: {
      loadConfig: async () => defaultCfg(),
      wallet,
      nowMs: () => NOW_MS,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    },
  });
  assert.equal(result.code, 0);
  assert.equal(result.report.mature.length, 0);
  assert.equal(result.report.unlocked.length, 0);
  assert.equal(result.report.failed.length, 0);
});

test('T58-5: main() with lockNFTs but tips below grace returns code=0 (premature only)', async () => {
  const utxos = [
    bchOnlyUtxo(1_000_000n),
    lockNftUtxo({ lockBlockHeight: 100_000, stakeBlocks: 1440 }),
  ];
  const wallet = {
    getUtxos: async () => utxos,
    getBlockHeight: async () => 1000,
  };
  const result = await main({
    argv: ['node', 'check-stale-stakes.mjs', '--json'],
    deps: {
      loadConfig: async () => defaultCfg(),
      wallet,
      nowMs: () => NOW_MS,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    },
  });
  assert.equal(result.code, 0);
  assert.equal(result.report.mature.length, 0);
  assert.equal(result.report.premature.length, 1);
  assert.equal(result.report.unlocked.length, 0);
});

// ─── main() — happy path ─────────────────────────────────────────────────

test('T58-5: main() mature lock fires executeUnlock + dispatches alert (happy path)', async () => {
  const utxos = [
    bchOnlyUtxo(1_000_000n),
    lockNftUtxo({ lockBlockHeight: 100, stakeBlocks: 1440, txidSuffix: 'aa' }),
  ];
  const wallet = {
    getUtxos: async () => utxos,
    getBlockHeight: async () => 10_000,
    disconnect: async () => {},
  };
  const provider = { sendRawTransaction: async () => 'cc'.repeat(32) };
  const executor = async () => ({
    ok: true,
    txid: 'dd'.repeat(32),
    fee: '1000',
    amountSats: '50000',
  });
  let appendedEvents = [];
  let dispatchedEvents = [];
  const result = await main({
    argv: ['node', 'check-stale-stakes.mjs', '--json'],
    deps: {
      loadConfig: async () => defaultCfg(),
      wallet,
      provider,
      executeUnlock: executor,
      appender: async (e) => { appendedEvents.push(e); return { ok: true }; },
      dispatch: async (e) => { dispatchedEvents.push(e); return { ok: true, dispatched: 1, channels_ready: 1, errors: [] }; },
      nowMs: () => NOW_MS,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    },
  });
  assert.equal(result.code, 1, 'mature lock fires exit code 1 (dispatched)');
  assert.equal(result.report.mature.length, 1);
  assert.equal(result.report.unlocked.length, 1);
  assert.equal(result.report.unlocked[0].dispatch_txid, 'dd'.repeat(32));
  assert.equal(result.report.failed.length, 0);
  // Dispatch surface: 1 event persisted, 1 event routed.
  assert.equal(appendedEvents.length, 1);
  assert.equal(dispatchedEvents.length, 1);
  assert.equal(appendedEvents[0].kind, 'stake_unlock');
});

test('T58-5: main() --dry-run skips executeUnlock even when mature lock exists', async () => {
  const utxos = [lockNftUtxo({ lockBlockHeight: 100, stakeBlocks: 1440 })];
  const wallet = {
    getUtxos: async () => utxos,
    getBlockHeight: async () => 10_000,
  };
  let executorCalls = 0;
  const executor = async () => { executorCalls += 1; return { ok: true, txid: 'aa'.repeat(32) }; };
  const result = await main({
    argv: ['node', 'check-stale-stakes.mjs', '--json', '--dry-run'],
    deps: {
      loadConfig: async () => defaultCfg(),
      wallet,
      executeUnlock: executor,
      nowMs: () => NOW_MS,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    },
  });
  assert.equal(executorCalls, 0, 'dry-run must NOT call executeUnlock');
  assert.equal(result.code, 0, 'dry-run with mature lock still exits 0');
  assert.equal(result.report.mature.length, 1);
  assert.equal(result.report.unlocked.length, 0);
  assert.equal(result.report.dry_run, true);
});

test('T58-5: main() --no-dispatch fires executeUnlock but skips alert pipeline', async () => {
  const utxos = [lockNftUtxo({ lockBlockHeight: 100, stakeBlocks: 1440 })];
  const wallet = {
    getUtxos: async () => utxos,
    getBlockHeight: async () => 10_000,
    disconnect: async () => {},
  };
  let executorCalls = 0;
  const executor = async () => { executorCalls += 1; return { ok: true, txid: 'aa'.repeat(32) }; };
  let appenderCalls = 0;
  let dispatchCalls = 0;
  const result = await main({
    argv: ['node', 'check-stale-stakes.mjs', '--json', '--no-dispatch'],
    deps: {
      loadConfig: async () => defaultCfg(),
      wallet,
      executeUnlock: executor,
      appender: async () => { appenderCalls += 1; return { ok: true }; },
      dispatch: async () => { dispatchCalls += 1; return { ok: true }; },
      nowMs: () => NOW_MS,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    },
  });
  assert.equal(executorCalls, 1, 'no-dispatch still calls executeUnlock');
  assert.equal(appenderCalls, 0, 'no-dispatch skips the alerts NDJSON appender');
  assert.equal(dispatchCalls, 0, 'no-dispatch skips the channel router');
  assert.equal(result.code, 1);
  assert.equal(result.report.no_dispatch, true);
});

// ─── main() — failure paths ──────────────────────────────────────────────

test('T58-5: main() executeUnlock throws → tick survives, failed envelope dispatched', async () => {
  const utxos = [lockNftUtxo({ lockBlockHeight: 100, stakeBlocks: 1440, txidSuffix: 'aa' })];
  const wallet = {
    getUtxos: async () => utxos,
    getBlockHeight: async () => 10_000,
    disconnect: async () => {},
  };
  const executor = async () => { throw new Error('cashscript-crashed'); };
  let appendedEvents = [];
  const result = await main({
    argv: ['node', 'check-stale-stakes.mjs', '--json'],
    deps: {
      loadConfig: async () => defaultCfg(),
      wallet,
      executeUnlock: executor,
      appender: async (e) => { appendedEvents.push(e); return { ok: true }; },
      dispatch: async () => ({ ok: true, dispatched: 1 }),
      nowMs: () => NOW_MS,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    },
  });
  assert.equal(result.code, 1, 'failure still surfaces as exit code 1');
  assert.equal(result.report.failed.length, 1);
  assert.equal(result.report.failed[0].code, 'EXECUTE_THREW');
  assert.equal(appendedEvents.length, 1);
  assert.equal(appendedEvents[0].kind, 'stake_failed');
});

test('T58-5: main() executeUnlock returns ok:false (SIMULATE_VIOLATIONS) → recorded as failed', async () => {
  const utxos = [lockNftUtxo({ lockBlockHeight: 100, stakeBlocks: 1440 })];
  const wallet = {
    getUtxos: async () => utxos,
    getBlockHeight: async () => 10_000,
    disconnect: async () => {},
  };
  const executor = async () => ({
    ok: false,
    code: 'SIMULATE_VIOLATIONS',
    error: 'lockUtxo commitment mismatch',
    txid: null,
  });
  const result = await main({
    argv: ['node', 'check-stale-stakes.mjs', '--json'],
    deps: {
      loadConfig: async () => defaultCfg(),
      wallet,
      executeUnlock: executor,
      appender: async () => ({ ok: true }),
      dispatch: async () => ({ ok: true }),
      nowMs: () => NOW_MS,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    },
  });
  assert.equal(result.code, 1);
  assert.equal(result.report.failed.length, 1);
  assert.equal(result.report.failed[0].code, 'SIMULATE_VIOLATIONS');
});

test('T58-5: main() executeUnlock fails → cron stops (drain stops on first failure)', async () => {
  const utxos = [
    lockNftUtxo({ lockBlockHeight: 100, stakeBlocks: 1440, txidSuffix: '01' }),
    lockNftUtxo({ lockBlockHeight: 100, stakeBlocks: 1440, txidSuffix: '02' }),
    lockNftUtxo({ lockBlockHeight: 100, stakeBlocks: 1440, txidSuffix: '03' }),
  ];
  const wallet = {
    getUtxos: async () => utxos,
    getBlockHeight: async () => 10_000,
    disconnect: async () => {},
  };
  let executorCalls = 0;
  const executor = async () => {
    executorCalls += 1;
    if (executorCalls === 1) {
      return { ok: false, code: 'BROADCAST', error: 'electrum-down', txid: null };
    }
    return { ok: true, txid: 'aa'.repeat(32) };
  };
  const result = await main({
    argv: ['node', 'check-stale-stakes.mjs', '--json', '--max-unlocks=3'],
    deps: {
      loadConfig: async () => defaultCfg(),
      wallet,
      executeUnlock: executor,
      appender: async () => ({ ok: true }),
      dispatch: async () => ({ ok: true }),
      nowMs: () => NOW_MS,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    },
  });
  assert.equal(executorCalls, 1, 'drain stops on first failure');
  assert.equal(result.report.failed.length, 1);
  assert.equal(result.report.unlocked.length, 0);
  // skippedCap is set by maxPerRun cap (none in this test — all 3
  // pass through). The fail-fast break drops the remaining 2
  // locks; they're not counted by skippedCap because they're not
  // 'skipped by maxPerRun' — they're 'abandoned by drain stop'.
  assert.equal(result.report.skipped_cap, 0);
  assert.equal(result.report.mature.length, 3, 'scan found all 3 mature locks');
});

// ─── main() — max-unlocks knob ───────────────────────────────────────────

test('T58-5: main() --max-unlocks=2 drains two mature locks per run', async () => {
  const utxos = [
    lockNftUtxo({ lockBlockHeight: 100, stakeBlocks: 1440, txidSuffix: '01' }),
    lockNftUtxo({ lockBlockHeight: 100, stakeBlocks: 1440, txidSuffix: '02' }),
    lockNftUtxo({ lockBlockHeight: 100, stakeBlocks: 1440, txidSuffix: '03' }),
  ];
  const wallet = {
    getUtxos: async () => utxos,
    getBlockHeight: async () => 10_000,
    disconnect: async () => {},
  };
  let executorCalls = 0;
  const executor = async () => {
    executorCalls += 1;
    return { ok: true, txid: 'aa'.repeat(32) };
  };
  const result = await main({
    argv: ['node', 'check-stale-stakes.mjs', '--json', '--max-unlocks=2'],
    deps: {
      loadConfig: async () => defaultCfg(),
      wallet,
      executeUnlock: executor,
      appender: async () => ({ ok: true }),
      dispatch: async () => ({ ok: true }),
      nowMs: () => NOW_MS,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    },
  });
  assert.equal(executorCalls, 2);
  assert.equal(result.report.unlocked.length, 2);
  assert.equal(result.report.skipped_cap, 1, 'third lock is dropped by maxPerRun');
});

// ─── main() — tip-height override ────────────────────────────────────────

test('T58-5: main() --tip-height=N overrides wallet.getBlockHeight', async () => {
  const utxos = [lockNftUtxo({ lockBlockHeight: 100, stakeBlocks: 1440 })];
  const wallet = {
    getUtxos: async () => utxos,
    getBlockHeight: async () => { throw new Error('should not be called'); },
  };
  const executorCalls = { count: 0 };
  const executor = async () => { executorCalls.count += 1; return { ok: true, txid: 'aa'.repeat(32) }; };
  const result = await main({
    argv: ['node', 'check-stale-stakes.mjs', '--json', '--tip-height=10000'],
    deps: {
      loadConfig: async () => defaultCfg(),
      wallet,
      executeUnlock: executor,
      appender: async () => ({ ok: true }),
      dispatch: async () => ({ ok: true }),
      nowMs: () => NOW_MS,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    },
  });
  assert.equal(result.report.tip_height, 10000, 'tip-height override is used');
  assert.equal(executorCalls.count, 1, 'executeUnlock fired once (mature lock detected)');
  assert.equal(result.report.unlocked.length, 1);
});

// ─── main() — defensive guards ───────────────────────────────────────────

test('T58-5: main() cron_minutes knob out of range → warn line, scan continues', async () => {
  const wallet = {
    getUtxos: async () => [],
    getBlockHeight: async () => 0,
  };
  const warnLines = [];
  const result = await main({
    argv: ['node', 'check-stale-stakes.mjs', '--json'],
    deps: {
      loadConfig: async () => defaultCfg({ unlock_cron_minutes: 9999 }),
      wallet,
      nowMs: () => NOW_MS,
      logger: { info: () => {}, warn: (event, payload) => warnLines.push({ event, payload }), error: () => {} },
    },
  });
  assert.equal(result.code, 0);
  const warned = warnLines.find((w) => w.event === 'check_stale_stakes.cron_minutes.out_of_range');
  assert.ok(warned, 'cron_minutes out-of-range surfaces a warn');
});

test('T58-5: main() wallet.disconnect throws → tick completes anyway', async () => {
  const utxos = [];
  const wallet = {
    getUtxos: async () => utxos,
    getBlockHeight: async () => 0,
    disconnect: async () => { throw new Error('already-disconnected'); },
  };
  const result = await main({
    argv: ['node', 'check-stale-stakes.mjs', '--json'],
    deps: {
      loadConfig: async () => defaultCfg(),
      wallet,
      nowMs: () => NOW_MS,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    },
  });
  assert.equal(result.code, 0, 'disconnect throw is non-fatal');
});

test('T58-5: main() dispatch impl throws → tick completes (belt-and-suspenders)', async () => {
  const utxos = [lockNftUtxo({ lockBlockHeight: 100, stakeBlocks: 1440 })];
  const wallet = {
    getUtxos: async () => utxos,
    getBlockHeight: async () => 10_000,
    disconnect: async () => {},
  };
  const executor = async () => ({ ok: true, txid: 'aa'.repeat(32) });
  // Force dispatch to throw so the catch path fires.
  const dispatch = async () => { throw new Error('telegram-down'); };
  const result = await main({
    argv: ['node', 'check-stale-stakes.mjs', '--json'],
    deps: {
      loadConfig: async () => defaultCfg(),
      wallet,
      executeUnlock: executor,
      dispatchStakeAlert: async () => { throw new Error('telegram-down'); },
      dispatch,
      nowMs: () => NOW_MS,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    },
  });
  // The executeUnlock ran; dispatch threw and was swallowed.
  assert.equal(result.report.unlocked.length, 1);
});

test('T58-5: main() reason_counts surfaces premature reasons in report', async () => {
  const utxos = [
    lockNftUtxo({ lockBlockHeight: 100_000, stakeBlocks: 1440, txidSuffix: '01' }),
    lockNftUtxo({ lockBlockHeight: 100_000, stakeBlocks: 1440, txidSuffix: '02' }),
  ];
  const wallet = {
    getUtxos: async () => utxos,
    getBlockHeight: async () => 1000,
  };
  const result = await main({
    argv: ['node', 'check-stale-stakes.mjs', '--json'],
    deps: {
      loadConfig: async () => defaultCfg(),
      wallet,
      nowMs: () => NOW_MS,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    },
  });
  assert.equal(result.report.reason_counts?.timelock_not_elapsed, 2);
});
