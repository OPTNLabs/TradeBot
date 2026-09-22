#!/usr/bin/env node
// tests/integration/pipeline.test.mjs
//
// INTEGRATION TESTS — full trade-execution pipeline, mocked at the
// trust boundaries so NO mainnet swap / signing / network call ever
// happens during `node --test`. See ARCHITECTURE.md §4.1 for the
// pipeline shape; see RUNBOOK.md "Testing" for the test-fixture
// philosophy.
//
// What we wire together end-to-end:
//
//   indexer (mock) ──▶ Fetcher.listTopTokens ──┐
//                                              │
//   libauth wallet (mock) ──▶ TradingLoop ────┤──▶ ranker
//                                              │
//   cauldron-swap-sdk (mock) ──▶ SwapExecutor ─┤──▶ shouldEnter → canOpen → swap.execute
//                                              │
//                                              ├──▶ Positions.open / close  (real atomic-write I/O)
//                                              │
//                                              ├──▶ Snapshots.maybeRecord   (real atomic-append I/O)
//                                              │
//                                              └──▶ CircuitBreaker          (real state machine)
//
// What's real vs mocked:
//
//   REAL  : Positions, Snapshots, CircuitBreaker, rankPools,
//           shouldEnter, shouldExit, canOpen, realizedPnlSats,
//           atomicWriteJson, atomicAppendNdjson.
//   MOCK  : `fetcher`     → returns canned indexer payloads.
//           `wallet`      → returns canned balance/UTXO/address,
//                           records every signHash() call.
//           `swap`        → uses the production `SwapExecutor`
//                           constructor but injects deps.* mocks
//                           for every SDK touchpoint (getPoolsAndMeta,
//                           planTrade, prepareAndBuildSwap,
//                           broadcastTx, verifyTrade). This is
//                           what ARCHITECTURE.md calls a "chipnet
//                           mock" — the whole TradeBot→SDK→chain
//                           surface is replaced with deterministic
//                           in-process fixtures, so the test
//                           exercises every line of `SwapExecutor`
//                           + `TradingLoop` + `Positions` without
//                           ever broadcasting.
//
// Crash safety: every assertion that reads `positions.json` does so
// from disk via `Positions.list()` after the writes — that confirms
// the atomic-write contract holds end-to-end.
//
// Determinism: the test pins a fixed clock so the date stamp on
// `snapshots/YYYY-MM-DD.jsonl` is predictable, then asserts the
// file landed on disk with that exact filename.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { TradingLoop } from '../../src/trader/loop.mjs';
import { SwapExecutor } from '../../src/trader/swap.mjs';
import { Positions } from '../../src/portfolio/positions.mjs';
import { Snapshots } from '../../src/portfolio/snapshots.mjs';
import { CircuitBreaker } from '../../src/risk/circuit-breaker.mjs';
import { realizedPnlSats } from '../../src/portfolio/pnl.mjs';
import { rankPools } from '../../src/strategy/ranker.mjs';
import { DEFAULT_SCORING_CONFIG } from '../../src/strategy/scoring.mjs';
import { DEFAULT_RANKER_CONFIG } from '../../src/strategy/ranker.mjs';
import { DEFAULT_ENTRY_CONFIG } from '../../src/strategy/entry.mjs';
import { DEFAULT_EXIT_CONFIG } from '../../src/strategy/exit.mjs';
import { DEFAULT_RISK_CONFIG } from '../../src/risk/limits.mjs';
import { SATS_PER_BCH } from '../../src/data/types.mjs';
import { createLogger, createMemorySink } from '../../src/util/logger.mjs';

// ─────────────────────────────────────────────────────────────────────
//  Constants + fixtures
// ─────────────────────────────────────────────────────────────────────

/** 64-hex token_ids (lowercase). */
const TID_PUSD = 'a'.repeat(64);
const TID_SPICE = 'b'.repeat(64);
const TID_DEAD = 'c'.repeat(64);

/** Real user wallet (cashaddr). */
const DESTINATION = 'bitcoincash:qqcp6q32dt4x4ddzrkdz28xmv6a3ev6wwq4t0m57ak';

/** Trading wallet starting balance (matches last funding 2026-09-10). */
const START_BALANCE_SATS = 4_435_967n;
/** $20 USD ≈ 0.044 BCH ≈ 4_435_967 sats at the time the wallet was funded. */

/** Pinned clock — every snapshot filename + history ts derives from
 *  this so assertions can match the exact ISO day string. */
const FIXED_NOW = new Date(Date.UTC(2026, 8, 11, 16, 30, 0));
const FIXED_NOW_ISO = FIXED_NOW.toISOString();
const FIXED_TODAY = FIXED_NOW_ISO.slice(0, 10); // "2026-09-11"

/** Build a base config that matches config/default.json (small_balance_startup preset). */
function baseConfig(overrides = {}) {
  return {
    version: 2,
    tuning_preset: 'small_balance_startup',
    scoring: { ...DEFAULT_SCORING_CONFIG },
    entry: { ...DEFAULT_ENTRY_CONFIG },
    exit: { ...DEFAULT_EXIT_CONFIG },
    risk: { ...DEFAULT_RISK_CONFIG },
    loop: { poll_interval_seconds: 60, snapshot_interval_seconds: 60, history_retention_days: 365 },
    wallet: { backend: 'external_wif', address: DESTINATION, network: 'mainnet' },
    data_sources: { cauldron_indexer_base_url: 'https://indexer.riften.net/cauldron' },
    ...overrides,
  };
}

/** Build an indexer payload entry in the raw shape the fetcher emits. */
function indexerEntry(overrides = {}) {
  const {
    token_id = TID_PUSD,
    symbol = 'PUSD',
    name = 'PUSD',
    decimals = 3,
    price_now_sats = 1_000_000,        // 0.01 BCH per display token (1e3 base units)
    price_now_usd = 1.00,
    price_24h_sats,                    // auto-derived below if not set
    price_7d_sats = 1_000_000,
    trade_volume_sats = 5_000_000_000, // 50 BCH 24h
    trade_count = 17,
    tvl_sats = 2_000_000_000,          // 20 BCH TVL
    tvl_tokens = 2_000_000n,
    // T46b: default apy_30d_bp is now 30 so the default fixture
    // pool has a real trailing-30d volume estimate (≈1.6 BCH/30d,
    // derived from 30 bp × 20 BCH TVL at 30 bps fee rate) — enough
    // to clear the new `min_volume_30d_bch = 1.0` gate. Tests that
    // exercise the missing-volume gate can still pass `apy_30d_bp: 0`
    // explicitly to assert the rejection path.
    apy_30d_bp = 30,
    fee_yield_bps = 30,
    age_days = 30,
  } = overrides;
  // Default `price_24h_sats` to 2.5% ABOVE `price_now_sats` so the
  // entry strategy's "gap from 24h high" gate (`too_close_to_high`,
  // DEFAULT_ENTRY_CONFIG.min_entry_gap_from_high_pct=2.0) passes
  // automatically. Individual tests can still override both fields
  // to assert edge-case behavior (e.g. a token that's just printed
  // its 24h high).
  const effectivePrice24h = (typeof price_24h_sats === 'number' && Number.isFinite(price_24h_sats))
    ? price_24h_sats
    : Math.round(price_now_sats * 1.025);
  return {
    token_id,
    display_name: name,
    display_symbol: symbol,
    bcmr: { token: { symbol, name, decimals } },
    price_now_sats,
    price_now_usd,
    price_24h_sats: effectivePrice24h,
    price_7d_sats,
    change_24h_bp: ((price_now_sats - effectivePrice24h) * 10000) / effectivePrice24h,
    change_7d_bp: ((price_now_sats - price_7d_sats) * 10000) / price_7d_sats,
    trade_volume_sats,
    trade_count,
    tvl_sats,
    tvl_tokens: tvl_tokens.toString(),
    apy_30d_bp,
    fee_yield_bps,
    age_days,
    // T28c: 29-point healthy series with upward spikes — the
    // integration test pool fixtures should pass the new
    // `min_upward_volatility=0.05` gate by default. Without this
    // every test gets `upward_volatility:missing` and the ranker
    // returns 0 candidates. Tests that need to assert the missing-
    // series path can pass `price_series_7d: null` explicitly.
    price_series_7d: overrides.price_series_7d ?? [
      0.90, 0.92, 0.91, 0.93, 0.95, 0.94, 0.96, 0.98, 0.97, 0.99,
      1.00, 0.98, 0.96, 0.97, 0.99, 1.00, 0.99, 0.97, 0.98, 1.00,
      0.98, 0.97, 0.99, 1.00, 0.99, 0.98, 1.00, 0.99, 1.00,
    ],
  };
}

/** A stub fetcher that returns canned records from listTopTokens.
 *
 *  `recordsForCall` (optional): a function `(records, callIndex) =>
 *  Array<Record>` that lets a test return DIFFERENT records per
 *  call. Used by the circuit-breaker test to drop the price after
 *  the first tick so the stop-loss gate fires.
 */
function fakeFetcher({ records = [], recordsForCall = null } = {}) {
  let callIndex = 0;
  return {
    calls: [],
    async listTopTokens(opts = {}) {
      this.calls.push(opts);
      const idx = callIndex;
      callIndex += 1;
      return (typeof recordsForCall === 'function')
        ? recordsForCall(records, idx)
        : records;
    },
    async getTokenStats(tokenId) {
      // Use the most recent records snapshot (whatever listTopTokens
      // returned on the latest call) so a price-drop survives
      // between listTopTokens and a downstream getTokenStats call.
      const latest = (typeof recordsForCall === 'function')
        ? recordsForCall(records, Math.max(0, callIndex - 1))
        : records;
      const hit = latest.find((r) => r.token_id === tokenId);
      if (!hit) return null;
      return hit;
    },
    stats() { return { requests: this.calls.length, cacheHits: 0, cacheMisses: 0 }; },
  };
}

/** A stub wallet that returns the balance + records every signHash call. */
function fakeWallet({
  balanceSats = START_BALANCE_SATS,
  address = DESTINATION,
} = {}) {
  return {
    signCalls: [],
    init: async () => null,
    getBalanceSats: async () => balanceSats,
    getAddress: () => address,
    /**
     * Used by the swap executor; we don't go through the production
     * SwapExecutor's signing path (we inject deps.prepareAndBuildSwap
     * instead). But keep the surface consistent so a future refactor
     * that does invoke `wallet.signHash(...)` won't crash.
     */
    signHash: async (txHash, _key) => {
      this.signCalls.push(txHash);
      return new Uint8Array(64); // mocked sig
    },
  };
}

/** Construct a `SwapExecutor` whose every SDK touchpoint is mocked. */
function buildSwapExecutor({ cfg, wallet, behaviour = {} }) {
  const {
    poolSide = 'balanced',   // 'balanced' | 'worse_buy' | 'worse_sell'
    sellMultiplier = 0.5,    // sell side receives (amountBase * sellMultiplier) sats back
    buyMultiplier = 1.0,     // buy side spends amountBase * buyMultiplier sats
    feeSats = 2000n,         // per-swap network fee
    lpFeeSats = 1000n,       // per-swap LP fee
    broadcastShouldFail = false,
    verifyShouldFail = false,
    txidOverride = null,
  } = behaviour;

  // `effectiveRateSats` is a closure-scoped hint so both
  // `mockPlanTrade` and `mockPrepareAndBuild` can mirror the
  // production SDK's volume-weighted marginal rate. Production
  // derives this from the live pool reserves (`totalSupply /
  // amount` per-base). The mock previously derived it from the
  // caller's `request.expectedRateSats` (which the loop sets from
  // `price_now_sats`); B04 / bug-exit-failed-20260916 separated
  // the two layers, so the mock now ignores the hint and uses a
  // fixed per-base reference rate.
  //
  // The B04 FIX mock reference rates. After fixing the unit-conversion
  // direction in BOTH `displayRateToBaseRate` (now divides per-display by
  // 10^decimals) and `baseRateToDisplayRate` (now multiplies per-base by
  // 10^decimals), the mock per-base needs to align with what
  // production computes from `price_now_sats = 1_000_000 / 10^3 = 1_000n`.
  // We pick `MOCK_PER_BASE_RATE_SATS = 1_000n` so `expectedRate ≈ effectiveRate
  // ≈ 1_000n` when the buy/sell multipliers are 1.0 (which is the
  // base case for tests that don't simulate slippage). The mock now
  // actually exercises real slippage math (not just constant-zero
  // the way the buggy helper did).
  const MOCK_PER_BASE_RATE_SATS = 1_000n;
  let effectiveRateSats = null;

  // Single-source-of-truth for what `prepareAndBuildSwap` returns:
  // the production SwapExecutor expects `{ txHex }` (the signed tx
  // hex, ready for broadcast). The mock skips real signing +
  // broadcasting and synthesizes a deterministic stub hex; broadcast
  // ignores its contents and returns a deterministic txid.
  const mockPrepareAndBuild = async (req) => {
    if (broadcastShouldFail) {
      throw new Error('mock: broadcast failed');
    }
    // `swap.mjs` calls `prepFn({ ..., amount: amountBase })` with a
    // bigint `amount` — the production cauldron-swap-sdk uses the
    // same field name, so the mock mirrors that exactly. Accept a
    // few aliases for robustness against future swap.mjs refactors.
    const rawAmount = req?.amount ?? req?.amountSats ?? req?.amountBase ?? 0n;
    const amountBase = typeof rawAmount === 'bigint' ? rawAmount : BigInt(rawAmount);
    const totalSupply = req?.side === 'buy'
      ? BigInt(Math.round(Number(amountBase) * buyMultiplier))
      : BigInt(Math.round(Number(amountBase) * sellMultiplier));
    return {
      txHex: '00'.repeat(200),  // any non-empty string satisfies broadcastTx
      allocations: req?.allocations ?? [],
      effectiveRate: effectiveRateSats,  // set by mockPlanTrade before broadcast
    };
  };

  const mockBroadcast = async (tx) => {
    if (broadcastShouldFail) throw new Error('mock: broadcast threw');
    return txidOverride ?? ('bb'.repeat(32));
  };

  const mockVerify = async () => {
    if (verifyShouldFail) {
      return { ok: false, kind: 'mismatch', message: 'mock: verify failed' };
    }
    return { ok: true, kind: 'verified', message: 'mock: verified' };
  };

  const mockGetPoolsAndMeta = async ({ tokenId }) => {
    return {
      pools: [],  // unused by the mock prepare path
      tokenMeta: { token_id: tokenId, symbol: 'MOCK', name: 'Mock Token', decimals: 3 },
    };
  };

  const mockPlanTrade = ({ side, amount, pools, expectedRateSats }) => {
    const amountBase = typeof amount === 'bigint' ? amount : BigInt(amount);
    const totalSupply = side === 'buy'
      ? BigInt(Math.round(Number(amountBase) * buyMultiplier))
      : BigInt(Math.round(Number(amountBase) * sellMultiplier));
    // B04 / bug-exit-failed-20260916: production SDK ignores the
    // `expectedRateSats` hint when computing `effectiveRate` — the
    // rate comes from the pool reserves (`totalSupply / amount`).
    // The mock was originally deriving `effectiveRate` from the
    // caller's hint, but with the B04 fix the swap layer now
    // normalizes that hint to per-base-unit before the slippage
    // comparison (still passing the raw hint through to
    // `planTrade`, since the SDK contract is "ignores hint").
    // To keep the mock's deterministic test math consistent, we
    // ignore the hint too and use a fixed per-base reference
    // rate (`MOCK_PER_BASE_RATE_SATS`, 1_000n). This matches
    // production behavior exactly: `effectiveRate` is per-BASE
    // unit, derived from pool reserves, and the caller's hint is
    // used solely for slippage math at the swap boundary.
    const sideMult = (side === 'buy' ? buyMultiplier : sellMultiplier);
    const mockRateSats = amountBase > 0n
      ? BigInt(Math.round(Number(MOCK_PER_BASE_RATE_SATS) * sideMult))
      : 0n;
    effectiveRateSats = mockRateSats;
    return {
      side,
      amount: amountBase,
      totalSupply,
      totalFees: lpFeeSats,
      estNetworkFeeSats: feeSats,
      effectiveRate: mockRateSats,
      pools: pools ?? [],
      allocations: [],
    };
  };

  return new SwapExecutor({
    cfg,
    wallet,
    deps: {
      getPoolsAndMeta: mockGetPoolsAndMeta,
      planTrade: mockPlanTrade,
      prepareAndBuildSwap: mockPrepareAndBuild,
      broadcastTx: mockBroadcast,
      verifyTrade: mockVerify,
      // T28: 1:1 identity mock — the integration tests pass `amountBase`
      // through `mockPlanTrade`/`mockPrepareAndBuild` directly, so the
      // "BCH sats → token base units" conversion would otherwise
      // reject every test as `below_dust` (mock pool list is `[]`).
      maxTokensForBudget: (_pools, bchSats) => bchSats,
      openExposureBch: 0, // overridden per-tick by the loop's call site (which reads cfg.risk)
    },
  });
}

/** Build a TradingLoop with real Positions/Snapshots/CircuitBreaker
 *  + a real SwapExecutor (deps mocked) + a fake fetcher + fake wallet. */
async function buildPipeline(t, overrides = {}) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'tradebot-int-'));
  t.after(async () => {
    try { await rm(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  const cfg = overrides.cfg ?? baseConfig();
  const positionsFile = path.join(tmpDir, 'positions.json');
  const snapshotsDir = path.join(tmpDir, 'snapshots');
  const historyFile = path.join(tmpDir, 'history.jsonl');

  // Default clock is FIXED_NOW so position `opened_at` timestamps
  // are deterministic. Tests can override via overrides.clock.
  const fixtureClock = overrides.clock ?? (() => FIXED_NOW);
  const positions = overrides.positions ?? new Positions({ file: positionsFile, now: fixtureClock });
  const snapshots = overrides.snapshots ?? new Snapshots({ dir: snapshotsDir });
  const breaker = overrides.breaker ?? new CircuitBreaker({ cfg });
  const wallet = overrides.wallet ?? fakeWallet(overrides.walletOpts ?? {});
  const fetcher = overrides.fetcher ?? fakeFetcher({
    records: overrides.indexerRecords ?? [],
    recordsForCall: overrides.recordsForCall ?? null,
  });
  const swap = overrides.swap ?? buildSwapExecutor({ cfg, wallet, behaviour: overrides.swapBehaviour ?? {} });

  // History appender — write to a real file so we can verify the
  // atomic-append contract end-to-end too.
  const { createHistoryAppender } = await import('../../src/trader/loop.mjs');
  const historyAppend = overrides.historyAppend ?? createHistoryAppender({ file: historyFile });

  const loop = new TradingLoop({
    cfg,
    fetcher,
    wallet,
    swap,
    positions,
    snapshots,
    breaker,
    historyAppend,
    clock: overrides.clock ?? (() => FIXED_NOW),
  });

  return {
    cfg,
    loop,
    positions,
    snapshots,
    breaker,
    wallet,
    fetcher,
    swap,
    historyFile,
    snapshotsDir,
    positionsFile,
    tmpDir,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Tests
// ─────────────────────────────────────────────────────────────────────

test('integration: pipeline discovers 3 tokens, ranks top-K, enters 1', async (t) => {
  const records = [
    // Top candidate: high volume, high TVL, low volatility.
    indexerEntry({
      token_id: TID_PUSD,
      symbol: 'PUSD',
      trade_volume_sats: 50_000_000_000n, // 500 BCH volume (HUGE)
      tvl_sats: 100_000_000_000n,         // 1000 BCH TVL (HUGE)
      price_now_sats: 1_000_000,
      // price_24h_sats auto-derived as 1_025_000 so the strategy's
      // "too close to 24h high" gate passes by default.
      apy_30d_bp: 50,
      fee_yield_bps: 30,
    }),
    // Marginal: passes min_volume_24h + min_tvl but barely.
    indexerEntry({
      token_id: TID_SPICE,
      symbol: 'SPICE',
      trade_volume_sats: 50_000_000n,    // 0.5 BCH volume (just over min)
      tvl_sats: 30_000_000n,             // 0.3 BCH TVL (just over min)
      price_now_sats: 1_500_000,
      // price_24h_sats auto-derived as 1_537_500.
      apy_30d_bp: 0,
      fee_yield_bps: 30,
    }),
    // Dead: zero volume, zero TVL.
    indexerEntry({
      token_id: TID_DEAD,
      symbol: 'DEAD',
      trade_volume_sats: 0n,
      tvl_sats: 0n,
      price_now_sats: 0,
      price_24h_sats: 0,
      apy_30d_bp: 0,
      fee_yield_bps: 0,
    }),
  ];
  const swapBehaviour = {
    sellMultiplier: 0.55,    // 10% gain on exit (entry 1000 → exit 1100)
    buyMultiplier: 1.0,
    feeSats: 2000n,
    lpFeeSats: 1000n,
  };
  const fixture = await buildPipeline(t, {
    indexerRecords: records,
    swapBehaviour,
    cfg: baseConfig({ entry: { ...DEFAULT_ENTRY_CONFIG }, exit: { ...DEFAULT_EXIT_CONFIG, take_profit_pct: 5.0, stop_loss_pct: 3.0 } }),
  });

  // ── Sanity: ranker alone should pick PUSD as #1, drop DEAD ──
  const ranked = rankPools(records, fixture.cfg, { nowMs: FIXED_NOW.getTime() });
  assert.ok(Array.isArray(ranked.candidates), 'rankPools returns candidates');
  assert.ok(ranked.candidates.length >= 1, 'rankPools returned at least 1 candidate');
  const rankedIds = ranked.candidates.map((c) => c.token_id);
  assert.ok(!rankedIds.includes(TID_DEAD), 'zero-volume dead token was filtered out');
  assert.equal(rankedIds[0], TID_PUSD, 'PUSD ranked #1 (highest volume+TVL)');

  // ── Tick 1: enter PUSD ──
  const tick1 = await fixture.loop.tick();
  assert.equal(tick1.breakerTripped, false, 'tick1 not breaker-tripped');
  // We expect at least one entry executed (PUSD is the obvious pick).
  const tick1Entries = tick1.entries.filter((e) => e.decision === 'executed');
  assert.ok(tick1Entries.length >= 1, `tick1 entered ≥1 position; got ${tick1Entries.length}`);
  const pusdEntry = tick1Entries.find((e) => e.token_id === TID_PUSD);
  assert.ok(pusdEntry, 'PUSD entry executed');
  assert.equal(pusdEntry.size_bch, 0.005, 'entry size = max_position_bch (0.005 BCH)');
  assert.equal(typeof pusdEntry.txid, 'string', 'entry carries a txid');
  assert.equal(typeof pusdEntry.position_id, 'string', 'entry carries a position_id');

  // ── Positions file on disk reflects the open position(s) ──
  // (Both PUSD and SPICE pass the ranker's min-volume + min-TVL
  // gates; the `already_open` policy doesn't apply on tick 1 since
  // the portfolio starts empty. We assert that AT LEAST PUSD
  // entered, and that the open list reflects the executed entries.)
  const openList = await fixture.positions.list('open');
  assert.ok(openList.length >= 1, `positions.json has ≥1 open row; got ${openList.length}`);
  const openTokenIds = openList.map((p) => p.token_id);
  assert.ok(openTokenIds.includes(TID_PUSD), `PUSD is among open positions; got [${openTokenIds.join(',')}]`);
  const position = openList.find((p) => p.token_id === TID_PUSD);
  assert.equal(position.status, 'open');
  assert.ok(position.entry.bch_spent_sats > 0, 'entry.bch_spent_sats > 0');
  assert.ok(position.entry.token_amount_base && BigInt(position.entry.token_amount_base) > 0n, 'entry.token_amount_base > 0');
  assert.ok(position.reasoning, 'position carries reasoning block');
  assert.ok(position.entry.fee_sats >= 0, 'entry.fee_sats set');

  // ── Audit: history.jsonl captured the entry event with all required fields ──
  const historyText = await readFile(fixture.historyFile, 'utf8');
  const historyLines = historyText.split('\n').filter((l) => l.length > 0);
  const entryLines = historyLines
    .map((l) => JSON.parse(l))
    .filter((r) => r.kind === 'entry');
  assert.ok(entryLines.length >= 1, `history.jsonl has ≥1 entry event; got ${entryLines.length}`);
  const pusdHistoryEntry = entryLines.find((e) => e.token_id === TID_PUSD);
  assert.ok(pusdHistoryEntry, 'PUSD has a history entry event');
  const entry = pusdHistoryEntry;
  assert.ok(typeof entry.txid === 'string', 'history entry has txid');
  assert.ok(typeof entry.size_bch === 'number', 'history entry has size_bch');
  assert.ok(typeof entry.price_sats_per_token === 'number', 'history entry has price_sats_per_token');
  assert.ok(typeof entry.bch_spent_sats === 'number', 'history entry has bch_spent_sats');
  assert.ok(typeof entry.token_amount_base === 'string', 'history entry has token_amount_base');
  assert.ok(typeof entry.slippage_bps === 'string' || entry.slippage_bps === null, 'history entry has slippage_bps');

  // ── Snapshot file landed at the predictable daily path ──
  // The snapshot's open_position_count must reflect POST-entry
  // state (the loop refreshes positions after step 5/6, see
  // src/trader/loop.mjs step 6b) — not the pre-tick zero count.
  const snapFiles = await readdir(fixture.snapshotsDir);
  assert.deepEqual(snapFiles, [`${FIXED_TODAY}.jsonl`], 'snapshots/YYYY-MM-DD.jsonl exists');
  const snapText = await readFile(path.join(fixture.snapshotsDir, snapFiles[0]), 'utf8');
  const snapLines = snapText.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l));
  assert.equal(snapLines.length, 1, 'one snapshot recorded this tick (cadence=60s)');
  assert.equal(snapLines[0].ts, FIXED_NOW_ISO);
  assert.equal(snapLines[0].open_position_count, openList.length, 'snapshot open_position_count matches positions.json post-entry count');
  assert.equal(snapLines[0].bch_balance_sats, String(START_BALANCE_SATS));
});

test('integration: position survives a "restart" — fresh Positions instance reads same file', async (t) => {
  const records = [indexerEntry({ token_id: TID_PUSD, symbol: 'PUSD' })];
  const fixture = await buildPipeline(t, {
    indexerRecords: records,
    swapBehaviour: { sellMultiplier: 0.5 },
  });

  const tick1 = await fixture.loop.tick();
  assert.equal(tick1.entries.filter((e) => e.decision === 'executed').length, 1);

  // Simulate a restart: build a NEW Positions + Snapshots + CircuitBreaker
  // reading from the same files. The pipeline state must survive.
  const cfg = fixture.cfg;
  const positions2 = new Positions({ file: fixture.positionsFile });
  const snapshots2 = new Snapshots({ dir: fixture.snapshotsDir });
  const breaker2 = new CircuitBreaker({ cfg });
  // The previous loop saw the open position; the new loop must see it too.
  const openList = await positions2.list('open');
  assert.equal(openList.length, 1, 'restart: 1 open position recovered');
  assert.equal(openList[0].token_id, TID_PUSD, 'restart: same token');

  const loop2 = new TradingLoop({
    cfg,
    fetcher: fixture.fetcher,
    wallet: fixture.wallet,
    swap: fixture.swap,
    positions: positions2,
    snapshots: snapshots2,
    breaker: breaker2,
    historyAppend: fixture.loop.historyAppend ?? (async () => {}),
    clock: () => FIXED_NOW,
  });

  // Tick 2: the open position should NOT be re-entered (already in open[]).
  // And the exit decision should NOT fire because price_now_sats == entry price.
  const tick2 = await loop2.tick();
  const tick2Entries = tick2.entries.filter((e) => e.token_id === TID_PUSD && e.decision === 'executed');
  assert.equal(tick2Entries.length, 0, 'restart: did NOT re-enter the already-open position');
});

test('integration: exit fires when market price hits take_profit threshold', async (t) => {
  // Entry at 1_000_000 sats/token. We'll set exit.take_profit_pct=5.0
  // and price_now_sats=1_100_000 → 10% gain → take-profit fires.
  const cfg = baseConfig({
    entry: { ...DEFAULT_ENTRY_CONFIG },
    exit: { ...DEFAULT_EXIT_CONFIG, take_profit_pct: 5.0, stop_loss_pct: 3.0, time_stop_hours: 24 },
  });
  // Two-phase pricing: tick1 sees entry at 1_000_000, tick2 sees the
  // price moved up to 1_100_000 → 10% gain → take-profit fires.
  const records = [indexerEntry({
    token_id: TID_PUSD,
    symbol: 'PUSD',
    price_now_sats: 1_000_000,
  })];
  const recordsForCall = (recs, callIdx) => {
    // call 0 → entry price; call 1+ → +10% to trigger take-profit.
    if (callIdx === 0) return recs;
    return recs.map((r) => ({ ...r, price_now_sats: 1_100_000 }));
  };
  const fixture = await buildPipeline(t, {
    indexerRecords: records,
    recordsForCall,
    cfg,
    swapBehaviour: {
      // Mirror the indexer price on the sell side: receive 1.1x
      // of the entry sats so realizedPnlSats comes out positive.
      sellMultiplier: 1.1,
    },
  });

  // Tick 1: open.
  const tick1 = await fixture.loop.tick();
  assert.equal(tick1.entries.filter((e) => e.token_id === TID_PUSD && e.decision === 'executed').length, 1);

  // Tick 2: should exit on take-profit.
  // Bump clock so time_stop doesn't interfere.
  const exitClock = () => new Date(FIXED_NOW.getTime() + 60_000);
  const loop2 = new TradingLoop({
    cfg,
    fetcher: fixture.fetcher,
    wallet: fixture.wallet,
    swap: fixture.swap,
    positions: fixture.positions,
    snapshots: fixture.snapshots,
    breaker: fixture.breaker,
    historyAppend: fixture.loop.historyAppend,
    clock: exitClock,
  });
  const tick2 = await loop2.tick();
  const tpExits = tick2.exits.filter((e) => e.kind === 'take_profit' && e.decision === 'executed');
  assert.equal(tpExits.length, 1, 'tick2 fired take-profit exit');
  const tpExit = tpExits[0];
  assert.ok(typeof tpExit.txid === 'string', 'exit has txid');
  assert.ok(typeof tpExit.realized_pnl_sats === 'number', 'exit has realized_pnl_sats');
  assert.ok(tpExit.realized_pnl_sats > 0, `realized_pnl_sats > 0 (took profit); got ${tpExit.realized_pnl_sats}`);

  // Position should now be closed in the on-disk file.
  const closedList = await fixture.positions.list('closed');
  const openList = await fixture.positions.list('open');
  assert.equal(closedList.length, 1, 'positions.json closed[] grew by 1');
  assert.equal(openList.length, 0, 'positions.json open[] is empty');
  const closed = closedList[0];
  assert.equal(closed.exit.reason, 'take_profit');
  assert.ok(closed.exit.realized_pnl_sats > 0);
  assert.ok(closed.exit.bch_received_sats > 0);
});

test('integration: stop-loss exit fires on price drop', async (t) => {
  const cfg = baseConfig({
    entry: { ...DEFAULT_ENTRY_CONFIG },
    exit: { ...DEFAULT_EXIT_CONFIG, take_profit_pct: 5.0, stop_loss_pct: 3.0, time_stop_hours: 24 },
  });
  // Two-phase: tick1 sees entry at 1_000_000; tick2 sees -5% drop
  // (950_000 ≤ 970_000 = 1_000_000 × 0.97) → stop-loss fires.
  // Slippage on the exit sell is 500 bps (expected 950_000, mock receives
  // 902_500 = 950_000 × 0.95), so we widen the tolerance in this test
  // config to 600 bps (still realistic for small AMM trades).
  // NOTE: `slippage_tolerance_bps` lives under `cfg.entry` (where the
  // entry layer reads it) — `preFlightCheck` reads `entry.`
  // first then falls back to `risk.`. To override the test, we
  // must touch `cfg.entry`, NOT `cfg.risk`.
  cfg.entry = { ...cfg.entry, slippage_tolerance_bps: 600 };
  const records = [indexerEntry({
    token_id: TID_PUSD,
    symbol: 'PUSD',
    price_now_sats: 1_000_000,
  })];
  const recordsForCall = (recs, callIdx) => {
    if (callIdx === 0) return recs;
    return recs.map((r) => ({ ...r, price_now_sats: 950_000 }));
  };
  const fixture = await buildPipeline(t, {
    indexerRecords: records,
    recordsForCall,
    cfg,
    swapBehaviour: { sellMultiplier: 0.95 }, // -5% on exit
  });
  const tick1 = await fixture.loop.tick();
  assert.equal(tick1.entries.filter((e) => e.token_id === TID_PUSD && e.decision === 'executed').length, 1);

  const loop2 = new TradingLoop({
    cfg,
    fetcher: fixture.fetcher,
    wallet: fixture.wallet,
    swap: fixture.swap,
    positions: fixture.positions,
    snapshots: fixture.snapshots,
    breaker: fixture.breaker,
    historyAppend: fixture.loop.historyAppend,
    clock: () => new Date(FIXED_NOW.getTime() + 60_000),
  });
  const tick2 = await loop2.tick();
  const slExits = tick2.exits.filter((e) => e.kind === 'stop_loss' && e.decision === 'executed');
  assert.equal(slExits.length, 1, 'tick2 fired stop-loss exit');
  const closed = await fixture.positions.list('closed');
  assert.equal(closed.length, 1);
  assert.equal(closed[0].exit.reason, 'stop_loss');
  assert.ok(closed[0].exit.realized_pnl_sats < 0, 'stop_loss realized negative P&L');
});

test('integration: time-stop fires when position is held past time_stop_hours', async (t) => {
  const cfg = baseConfig({
    entry: { ...DEFAULT_ENTRY_CONFIG },
    exit: { ...DEFAULT_EXIT_CONFIG, take_profit_pct: 5.0, stop_loss_pct: 3.0, time_stop_hours: 1 },
  });
  const records = [indexerEntry({
    token_id: TID_PUSD,
    symbol: 'PUSD',
    price_now_sats: 1_000_000, // exactly entry price (no take-profit / no stop-loss)
  })];
  const fixture = await buildPipeline(t, {
    indexerRecords: records,
    cfg,
    swapBehaviour: { sellMultiplier: 1.0 }, // 0% change on exit (we just want time-stop)
  });
  const tick1 = await fixture.loop.tick();
  assert.equal(tick1.entries.filter((e) => e.token_id === TID_PUSD && e.decision === 'executed').length, 1);

  // Fast-forward 2 hours (well past time_stop_hours=1).
  const loop2 = new TradingLoop({
    cfg,
    fetcher: fixture.fetcher,
    wallet: fixture.wallet,
    swap: fixture.swap,
    positions: fixture.positions,
    snapshots: fixture.snapshots,
    breaker: fixture.breaker,
    historyAppend: fixture.loop.historyAppend,
    clock: () => new Date(FIXED_NOW.getTime() + 2 * 60 * 60 * 1000),
  });
  const tick2 = await loop2.tick();
  const tsExits = tick2.exits.filter((e) => e.kind === 'time_stop' && e.decision === 'executed');
  assert.equal(tsExits.length, 1, 'tick2 fired time-stop exit');
  const closed = await fixture.positions.list('closed');
  assert.equal(closed[0].exit.reason, 'time_stop');
});

test('integration: circuit breaker trips after max_consecutive_losses closes', async (t) => {
  const cfg = baseConfig({
    entry: { ...DEFAULT_ENTRY_CONFIG },
    exit: { ...DEFAULT_EXIT_CONFIG, take_profit_pct: 5.0, stop_loss_pct: 3.0, time_stop_hours: 24 },
    risk: { ...DEFAULT_RISK_CONFIG, max_consecutive_losses: 2, circuit_breaker_cooldown_hours: 1 },
  });
  // T34: disable the loss cooldown for this test — we explicitly want
  // to observe the bot re-entering after a stop-loss close so we can
  // observe the `max_consecutive_losses` trip on the SECOND loss.
  // The cooldown's behaviour is covered by the unit tests in
  // tests/risk-circuit-breaker.test.mjs.
  cfg.risk = { ...cfg.risk, loss_cooldown_minutes: -1 };
  // Slippage from sellMultiplier=0.5 is ~5000 bps (expected minus
  // realized is 50%); set a wide but still realistic tolerance.
  // NOTE: `slippage_tolerance_bps` lives under `cfg.entry` (where
  // the entry layer reads it); `preFlightCheck` reads `entry.`
  // first then falls back to `risk.`. Override here, NOT on
  // `cfg.risk`, otherwise the new tolerance is silently ignored.
  cfg.entry = { ...cfg.entry, slippage_tolerance_bps: 5500 };
  // Two stop-loss closes of -0.00256 BCH each (= -0.00512 total)
  // would trip the daily_loss circuit breaker before the consecutive-
  // losses check fires (the breaker evaluates `daily_loss` first).
  // Lift the daily cap so we can observe the `consecutive_losses`
  // trip we actually want to test.
  cfg.risk = { ...cfg.risk, max_daily_loss_bch: 0.05 };
  // Two-phase pricing: tick1 entry at 1_000_000; tick2 price drops to
  // 950_000 → stop-loss fires (950_000 < 970_000).
  const records = [indexerEntry({
    token_id: TID_PUSD,
    symbol: 'PUSD',
    price_now_sats: 1_000_000,
  })];
  const recordsForCall = (recs, callIdx) => {
    // Oscillate the price so each entry happens at 1_000_000 and
    // each subsequent exit sees a -5% drop that triggers stop-loss:
    //   call 0: 1_000_000 (entry #1 — at full price)
    //   call 1:   950_000 (exit #1 — stop-loss fires on -5% drop)
    //   call 2: 1_000_000 (entry #2 — full price recovered)
    //   call 3:   950_000 (exit #2 — stop-loss fires; 2 losses → trip)
    // Without this oscillation, tick3 would re-enter at 950_000 and
    // tick4 would not see any further drop, leaving the new position
    // open and the breaker still at 1 consecutive loss.
    if (callIdx === 0 || callIdx === 2) return recs;
    return recs.map((r) => ({ ...r, price_now_sats: 950_000 }));
  };
  const fixture = await buildPipeline(t, {
    indexerRecords: records,
    recordsForCall,
    cfg,
    swapBehaviour: { sellMultiplier: 0.5 }, // -50% on exit → big loss
  });

  // Helper: tick the loop up to `n` times, advancing the clock by
  // `msIncrement` each iteration. Returns the LAST tick's result
  // (so callers can inspect `result.exits` / `result.breakerTripped`
  // regardless of whether the breaker tripped mid-sequence) plus the
  // number of iterations that actually ran. If the breaker trips
  // mid-sequence we stop early but still return the trip's result.
  async function tickNTimes(loop, n, msIncrement = 60_000) {
    let i = 0;
    let lastResult = null;
    while (i < n) {
      const tickClock = () => new Date(FIXED_NOW.getTime() + (i + 1) * msIncrement);
      const l = new TradingLoop({
        cfg,
        fetcher: fixture.fetcher,
        wallet: fixture.wallet,
        swap: fixture.swap,
        positions: fixture.positions,
        snapshots: fixture.snapshots,
        breaker: fixture.breaker,
        historyAppend: fixture.loop.historyAppend,
        clock: tickClock,
      });
      lastResult = await l.tick();
      // If the loop was tripped, stop early (but still return the
      // trip's result so the caller can assert on it).
      if (lastResult.breakerTripped) {
        return { result: lastResult, iterations: i + 1 };
      }
      i += 1;
    }
    return { result: lastResult, iterations: i };
  }

  // Tick 1: open.
  const tick1 = await fixture.loop.tick();
  assert.equal(tick1.entries.filter((e) => e.token_id === TID_PUSD && e.decision === 'executed').length, 1);

  // Tick 2: exit (loss, because sellMultiplier=0.5 < entry price 1_000_000)
  //         + circuit breaker records 1 consecutive loss.
  const { result: tick2 } = await tickNTimes(fixture.loop, 1);
  const tick2LossExits = tick2.exits.filter((e) => e.kind === 'stop_loss' && e.decision === 'executed');
  assert.equal(tick2LossExits.length, 1, 'tick2 fired stop-loss');

  // Now we need a SECOND loss to hit max_consecutive_losses=2.
  // Open another position (re-enter since the previous one was closed),
  // then exit again with a loss.
  const tick3 = await fixture.loop.tick();
  const tick3Entries = tick3.entries.filter((e) => e.token_id === TID_PUSD && e.decision === 'executed');
  // Re-entry should happen because the previous position was closed.
  assert.ok(tick3Entries.length >= 1, 're-entered after stop-loss close');
  // Next tick: the new position's stop-loss fires again → 2 consecutive losses → trip.
  // The breaker trip is RECORDED inside step 6e of this tick (when
  // recordResult sees 2 consecutive losses). The `breakerTripped`
  // flag on the tick's RESULT, however, is set in step 1 from the
  // PRE-tick evaluate() call — which hasn't yet observed this
  // tick's own trade. So tick4's result will report `breakerTripped
  // = false` even though the trip was just recorded. We need one
  // more tick for the trip to surface on the result.
  const { result: tick4 } = await tickNTimes(fixture.loop, 1, 90_000);
  const tick4LossExits = tick4.exits.filter((e) => e.kind === 'stop_loss' && e.decision === 'executed');
  assert.equal(tick4LossExits.length, 1, 'tick4 fired stop-loss (2nd loss, trip recorded)');
  // Tick 5: breaker.evaluate() observes the trip → entries skipped.
  const { result: tick5 } = await tickNTimes(fixture.loop, 1, 180_000);
  assert.equal(tick5.breakerTripped, true, `breaker tripped after 2 consecutive losses; tick5=${JSON.stringify(tick5).slice(0, 200)}`);
  assert.equal(tick5.breakerKind, 'consecutive_losses');
});

test('integration: pre-flight refuses entry when wallet balance below min_floor + max_position', async (t) => {
  const records = [indexerEntry({
    token_id: TID_PUSD,
    symbol: 'PUSD',
    price_now_sats: 1_000_000,
  })];
  // Wallet has 0.001 BCH (100_000 sats). Need 0.005 (entry) + 0.005 (floor) = 0.010 BCH.
  // (100_000 sats == 0.001 BCH; the original test had 1_000_000n which
  // is actually 0.01 BCH and does NOT trip the floor gate — that was
  // an off-by-10x typo.)
  const fixture = await buildPipeline(t, {
    indexerRecords: records,
    walletOpts: { balanceSats: 100_000n }, // 0.001 BCH — below 0.005 floor
    cfg: baseConfig(),
  });
  const tick1 = await fixture.loop.tick();
  const belowFloor = tick1.entries.filter((e) => e.token_id === TID_PUSD && e.decision === 'rejected' && e.kind === 'below_floor');
  assert.ok(belowFloor.length >= 1, 'entry rejected: below_floor');
  // No position opened.
  const openList = await fixture.positions.list('open');
  assert.equal(openList.length, 0, 'positions.json open[] stays empty');
});

test('integration: pre-flight refuses entry when total exposure would exceed cap', async (t) => {
  // Force the existing portfolio to already be at max_total_exposure_bch (0.04 BCH)
  // so the next entry attempt breaches the cap.
  const cfg = baseConfig();
  const records = [indexerEntry({ token_id: TID_PUSD, symbol: 'PUSD' })];
  const fixture = await buildPipeline(t, {
    indexerRecords: records,
    cfg,
  });
  // Pre-seed a fake open position at 0.04 BCH (just under the 0.04 cap).
  await fixture.positions.open({
    tokenId: 'f'.repeat(64),
    tokenSymbol: 'X',
    tokenDecimals: 3,
    initialStatus: 'open',
    entry: {
      txid: '11'.repeat(32),
      price_sats_per_token: 1_000_000,
      bch_spent_sats: 4_000_000, // 0.04 BCH — sits AT the cap
      token_amount_base: '4000000',
      fee_sats: 2000,
      broadcast_ms: 0,
      ts: FIXED_NOW_ISO,
    },
    reasoning: { ts: FIXED_NOW.getTime(), token_id: 'f'.repeat(64), score: 0.5, rank: 1, eligible_for_trade: true },
  });
  // Tick: any new entry would push total exposure to 0.04 + 0.005 = 0.045 > 0.04.
  const tick1 = await fixture.loop.tick();
  // The strategy layer (`shouldEnter`) catches `openExposureBch >=
  // max_total_exposure_bch` during size computation and returns
  // `enter: false / kind: 'exposure_full'`, which the loop surfaces
  // as `decision: 'skipped'`. The risk layer (`canOpen`) would catch
  // the same breach and surface it as `decision: 'rejected' /
  // kind: 'exposure_full'`. Either is a correct exposure-cap refusal
  // — both are accepted here to keep the test resilient to internal
  // gate-ordering changes.
  const refused = tick1.entries.filter((e) => e.token_id === TID_PUSD
    && (e.decision === 'rejected' || e.decision === 'skipped'));
  assert.ok(refused.length >= 1, `entry refused due to exposure cap; decisions=${JSON.stringify(tick1.entries.map((e) => ({ id: e.token_id, d: e.decision, k: e.kind })))}`);
  const kind = refused[0].kind;
  assert.ok(
    kind === 'exposure_full' || kind === 'cap_exceeded' || kind === 'max_exposure',
    `refusal kind signals exposure cap; got "${kind}"`,
  );
});

test('integration: crash-safety — positions.json is never half-written (atomic contract)', async (t) => {
  // Run 5 ticks, each opening/closing positions, then read the file
  // raw from disk and verify it's parseable at every intermediate
  // step. The atomic-write contract guarantees the on-disk file is
  // either the OLD content or the NEW content, never a hybrid.
  const records = [indexerEntry({ token_id: TID_PUSD, symbol: 'PUSD' })];
  const fixture = await buildPipeline(t, {
    indexerRecords: records,
    cfg: baseConfig({
      entry: { ...DEFAULT_ENTRY_CONFIG },
      exit: { ...DEFAULT_ENTRY_CONFIG, take_profit_pct: 5.0, stop_loss_pct: 3.0 },
    }),
    swapBehaviour: { sellMultiplier: 1.1 },
  });

  for (let i = 0; i < 5; i += 1) {
    const tickClock = () => new Date(FIXED_NOW.getTime() + (i + 1) * 60_000);
    const l = new TradingLoop({
      cfg: fixture.cfg,
      fetcher: fixture.fetcher,
      wallet: fixture.wallet,
      swap: fixture.swap,
      positions: fixture.positions,
      snapshots: fixture.snapshots,
      breaker: fixture.breaker,
      historyAppend: fixture.loop.historyAppend,
      clock: tickClock,
    });
    await l.tick();
    // After every tick, the file must parse cleanly.
    const raw = await readFile(fixture.positionsFile, 'utf8');
    const parsed = JSON.parse(raw); // throws on half-written JSON
    assert.ok(parsed && typeof parsed === 'object', `tick ${i + 1}: positions.json parses`);
    assert.ok(Array.isArray(parsed.open) && Array.isArray(parsed.closed), `tick ${i + 1}: schema valid`);
    assert.equal(parsed.version, 1, `tick ${i + 1}: schema version`);
  }
  // Sanity: history.jsonl is also parseable.
  const historyRaw = await readFile(fixture.historyFile, 'utf8');
  const histLines = historyRaw.split('\n').filter((l) => l.length > 0);
  assert.ok(histLines.length > 0, 'history.jsonl has at least one line');
  for (const line of histLines) {
    JSON.parse(line); // throws on garbage
  }
});

test('integration: end-to-end summary — closed position feeds PnL summary', async (t) => {
  // Run a single entry→take-profit cycle and confirm `summarize()`
  // reflects the trade correctly.
  const { summarize } = await import('../../src/portfolio/pnl.mjs');
  const cfg = baseConfig({
    entry: { ...DEFAULT_ENTRY_CONFIG },
    exit: { ...DEFAULT_EXIT_CONFIG, take_profit_pct: 5.0, stop_loss_pct: 3.0 },
  });
  // Two-phase pricing: tick1 entry at 1_000_000; tick2 price moves to
  // 1_100_000 → take-profit fires (1_100_000 ≥ 1_050_000).
  const records = [indexerEntry({ token_id: TID_PUSD, symbol: 'PUSD', price_now_sats: 1_000_000 })];
  const recordsForCall = (recs, callIdx) => {
    if (callIdx === 0) return recs;
    return recs.map((r) => ({ ...r, price_now_sats: 1_100_000 }));
  };
  const fixture = await buildPipeline(t, {
    indexerRecords: records,
    recordsForCall,
    cfg,
    swapBehaviour: { sellMultiplier: 1.1 }, // 10% gain on exit
  });
  // Tick 1: open.
  const tick1 = await fixture.loop.tick();
  assert.equal(tick1.entries.filter((e) => e.token_id === TID_PUSD && e.decision === 'executed').length, 1);
  // Tick 2: take-profit exit.
  const loop2 = new TradingLoop({
    cfg,
    fetcher: fixture.fetcher,
    wallet: fixture.wallet,
    swap: fixture.swap,
    positions: fixture.positions,
    snapshots: fixture.snapshots,
    breaker: fixture.breaker,
    historyAppend: fixture.loop.historyAppend,
    clock: () => new Date(FIXED_NOW.getTime() + 60_000),
  });
  const tick2 = await loop2.tick();
  assert.equal(tick2.exits.filter((e) => e.kind === 'take_profit' && e.decision === 'executed').length, 1);

  const closed = await fixture.positions.list('closed');
  assert.equal(closed.length, 1);
  const summary = summarize(closed);
  assert.equal(summary.count, 1);
  assert.equal(summary.wins, 1, '1 win');
  assert.equal(summary.losses, 0);
  assert.equal(summary.breakeven, 0);
  assert.ok(summary.realized_pnl_sats > 0n, `realized P&L positive (${summary.realized_pnl_sats} sats)`);
  assert.ok(summary.total_fees_sats >= 0n, 'fees paid is recorded');
  assert.ok(summary.win_rate_pct === 100, `win rate 100%; got ${summary.win_rate_pct}`);
});

test('integration: snapshot cadence respected — fast loop still emits one snapshot per interval', async (t) => {
  // Three ticks in quick succession with snapshot_interval=300s.
  // First tick writes a snapshot (because no prior _lastTs).
  // Second tick <300s later → null.
  // Third tick >300s later → another snapshot.
  const records = [indexerEntry({ token_id: TID_PUSD, symbol: 'PUSD' })];
  const fixture = await buildPipeline(t, {
    indexerRecords: records,
    cfg: baseConfig({
      loop: { poll_interval_seconds: 60, snapshot_interval_seconds: 300, history_retention_days: 365 },
    }),
  });
  // Tick 1 at FIXED_NOW → first snapshot.
  const tick1 = await fixture.loop.tick();
  assert.equal(tick1.snapshotTaken, true, 'tick1 wrote a snapshot');

  // Tick 2 at FIXED_NOW+60s → cadence not met → null.
  const tick2Clock = () => new Date(FIXED_NOW.getTime() + 60_000);
  const loop2 = new TradingLoop({
    cfg: fixture.cfg,
    fetcher: fixture.fetcher,
    wallet: fixture.wallet,
    swap: fixture.swap,
    positions: fixture.positions,
    snapshots: fixture.snapshots,
    breaker: fixture.breaker,
    historyAppend: fixture.loop.historyAppend,
    clock: tick2Clock,
  });
  const tick2 = await loop2.tick();
  assert.equal(tick2.snapshotTaken, false, 'tick2 suppressed (cadence)');

  // Tick 3 at FIXED_NOW+400s → cadence met → snapshot.
  const tick3Clock = () => new Date(FIXED_NOW.getTime() + 400_000);
  const loop3 = new TradingLoop({
    cfg: fixture.cfg,
    fetcher: fixture.fetcher,
    wallet: fixture.wallet,
    swap: fixture.swap,
    positions: fixture.positions,
    snapshots: fixture.snapshots,
    breaker: fixture.breaker,
    historyAppend: fixture.loop.historyAppend,
    clock: tick3Clock,
  });
  const tick3 = await loop3.tick();
  assert.equal(tick3.snapshotTaken, true, 'tick3 wrote a snapshot');

  // Read all NDJSON back from disk: should have exactly 2 snapshots.
  const snapFiles = await readdir(fixture.snapshotsDir);
  const totalLines = (
    await Promise.all(snapFiles.map(async (f) => {
      const txt = await readFile(path.join(fixture.snapshotsDir, f), 'utf8');
      return txt.split('\n').filter((l) => l.length > 0).length;
    }))
  ).reduce((a, b) => a + b, 0);
  assert.equal(totalLines, 2, `2 snapshots on disk; got ${totalLines}`);
});
