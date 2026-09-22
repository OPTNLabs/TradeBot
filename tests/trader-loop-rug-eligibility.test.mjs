#!/usr/bin/env node
/**
 * T76 subset 2b — Trader-loop live holders-based rug-pattern
 * eligibility gate.
 *
 * Closes the loop-side wiring of the rug-pattern detector. The
 * dashboard endpoint (subset 2a) already exposes
 * `/api/token/<id>/holders`; this test suite verifies the LOOP
 * also calls `resolveHoldersSnapshot` against the in-process
 * `HoldersScannerCache` per candidate and emits
 * `entry_skipped` with `kind:'rug_pattern_detected'` when the
 * live check fires.
 *
 * Defensive guards the loop must honor (mirrors the dashboard's
 * subset-2a posture):
 *   - `scoring.concentration_rug_enabled !== true` → entirely
 *     no-op (no per-tick fetch, no entry_skipped event).
 *   - Cache seam null + gate ON → pass-through + structured warn
 *     log line (`loop.rug_pattern.unwired`).
 *   - `error:'token_not_found'` → pass-through (unindexed tokens
 *     never flagged).
 *   - `error:'invalid_token_id'` → pass-through.
 *   - Resolver throws → pass-through + structured warn.
 *   - Other scanner errors → pass-through + structured warn.
 *
 * The stub `fetcher` lets each test simulate the upstream without
 * any network calls. Tests construct a `HoldersScannerCache`,
 * wire a stub fetcher, and assert on the per-tick entry_skipped
 * envelopes the loop emits to `historyAppend`.
 *
 * Run with: `node --test tests/trader-loop-rug-eligibility.test.mjs`
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TradingLoop } from '../src/trader/loop.mjs';
import {
  DEFAULT_RANKER_CONFIG,
} from '../src/strategy/ranker.mjs';
import {
  DEFAULT_ENTRY_CONFIG,
} from '../src/strategy/entry.mjs';
import {
  DEFAULT_EXIT_CONFIG,
} from '../src/strategy/exit.mjs';
import {
  DEFAULT_RISK_CONFIG,
} from '../src/risk/limits.mjs';
import {
  DEFAULT_LOOP_CONFIG,
} from '../src/trader/loop.mjs';
import { HoldersScannerCache } from '../src/strategy/holder-scanner-cache.mjs';
import { createLogger, createMemorySink } from '../src/util/logger.mjs';

// ─────────────────────────────────────────────────────────────────────
//  Fixtures
// ─────────────────────────────────────────────────────────────────────

const TID_A = 'a'.repeat(64);
const TID_B = 'b'.repeat(64);
const DESTINATION = 'bitcoincash:qqcp6q32dt4x4ddzrkdz28xmv6a3ev6wwq4t0m57ak';

function indexerRecord(overrides = {}) {
  return {
    token_id: TID_A,
    display_name: 'Token A',
    display_symbol: 'TKA',
    bcmr: {
      token: { symbol: 'TKA', name: 'Token A', decimals: 3 },
    },
    price_now_sats: 1234,
    price_now_usd: 0.5,
    price_24h_sats: 1200,
    price_7d_sats: 1000,
    change_24h_bp: -200,
    change_7d_bp: -500,
    trade_volume_sats: 5_000_000_000,    // 50 BCH 24h volume
    trade_count: 17,
    tvl_sats: 2_000_000_000,        // 20 BCH TVL
    tvl_tokens: 1_000_000n,
    apy_30d_bp: 150,
    score: 0.5,
    score_rank: 4,
    ...overrides,
  };
}

function baseConfig(overrides = {}) {
  return {
    scoring: { ...DEFAULT_RANKER_CONFIG },
    entry: { ...DEFAULT_ENTRY_CONFIG },
    exit: { ...DEFAULT_EXIT_CONFIG },
    risk: { ...DEFAULT_RISK_CONFIG },
    loop: { ...DEFAULT_LOOP_CONFIG },
    // Defensive default: scoring.concentration_rug_enabled:false
    // matches the production default — tests that exercise the live
    // check override this knob explicitly.
    ...overrides,
  };
}

function makeLogger() {
  const events = [];
  const log = (level) => (event, payload) => events.push({ level, event, payload });
  return {
    events,
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    debug: log('debug'),
  };
}

function fakeWallet({
  balanceSats = 4_435_967n,
  address = DESTINATION,
  utxos = [],
} = {}) {
  return {
    init: async () => null,
    getBalanceSats: async () => balanceSats,
    getAddress: () => address,
    getTokenAddress: () => address,
    close: async () => {},
    async listUtxos() { return utxos; },
  };
}

function fakeSwap({ result = null, onCall = null } = {}) {
  return {
    calls: [],
    async execute(req) {
      this.calls.push(req);
      if (typeof onCall === 'function') {
        const out = await onCall(req);
        if (out !== undefined) return out;
      }
      return result ?? defaultSwapResult(req);
    },
  };
}

function defaultSwapResult(req) {
  return {
    ok: true,
    side: req.side,
    tokenId: req.tokenId,
    amountBase: req.amountBase,
    effectiveRateSats: 1234n,
    expectedRateSats: req.expectedRateSats ?? 1234n,
    slippageBps: 10n,
    totalSatsInOrOut: req.side === 'buy' ? req.amountBase : req.amountBase / 2n,
    lpFeeSats: req.amountBase / 1000n,
    estNetworkFeeSats: 2000n,
    allocations: [],
    txid: (req.side === 'buy' ? 'bb' : 'cc').repeat(32),
    verification: null,
    walletBalanceAfterSats: req.side === 'buy' ? 4_435_967n - req.amountBase : 4_435_967n + req.amountBase / 2n,
    ts: new Date().toISOString(),
    tokenMeta: null,
  };
}

function fakePositions({ records = { open: [], pending: [], closing: [], closed: [] } } = {}) {
  return {
    records,
    async list(bucket) {
      if (bucket === 'all') return [...records.open, ...records.closed];
      if (bucket === 'closed') return [...(records.closed ?? [])];
      return [...records.open];
    },
    async open(args) {
      const position = {
        id: `pos_test_${Date.now()}`,
        token_id: args.tokenId,
        side: 'long_token',
        entry: { ...args.entry },
        reasoning: { ...args.reasoning },
        opened_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        status: args.initialStatus ?? 'open',
      };
      records.open.push(position);
      return { ...position };
    },
    async confirm(id) {
      const hit = records.open.find((p) => p.id === id);
      if (!hit) throw new Error(`confirm: position ${id} not found`);
      hit.status = 'open';
      return { ...hit };
    },
    async close(id, exit, realizedPnlSats) {
      const idx = records.open.findIndex((p) => p.id === id);
      if (idx === -1) throw new Error(`close: position ${id} not found`);
      const [hit] = records.open.splice(idx, 1);
      hit.status = 'closed';
      hit.exit = { ...exit, realized_pnl_sats: realizedPnlSats };
      records.closed.push(hit);
      return { ...hit };
    },
    async startClosing(id) {
      const hit = records.open.find((p) => p.id === id);
      if (hit) hit.status = 'closing';
      return { ...hit };
    },
    async updateHighWaterMark(id, hwm) {
      const hit = records.open.find((p) => p.id === id);
      if (hit) hit.high_water_mark_sats_per_token = String(hwm);
      return { ...hit };
    },
  };
}

function fakeSnapshots() {
  return {
    async maybeRecord() { return null; },
    async record() { return null; },
    async last() { return null; },
  };
}

function fakeBreaker({ allow = true } = {}) {
  return {
    async evaluate() { return { allow, kind: null, reason: null }; },
    recordResult() { return { recorded: true, pnlSats: 0n, tripped: false, tripKind: null }; },
  };
}

function fakeFetcher({ records = [] } = {}) {
  return {
    calls: [],
    async listTopTokens() { return records; },
    async listPools() { return []; },
    async getTokenStats() { return null; },
    async getBcmr() { return null; },
    stats() { return { requests: 0, cacheHits: 0, cacheMisses: 0 }; },
  };
}

function buildLoop(overrides = {}) {
  const records = overrides.indexerRecords ?? [indexerRecord()];
  const portfolioRecords = overrides.portfolioRecords ?? { open: [], pending: [], closing: [], closed: [] };
  const history = overrides.history ?? [];
  const swap = overrides.swap ?? fakeSwap();
  const positions = overrides.positions ?? fakePositions({ records: portfolioRecords });
  const snapshots = overrides.snapshots ?? fakeSnapshots();
  const fetcher = overrides.fetcher ?? fakeFetcher({ records });
  const wallet = overrides.wallet ?? fakeWallet();
  const cfg = overrides.cfg ?? baseConfig();
  const logger = overrides.logger ?? makeLogger();
  const clock = overrides.clock ?? (() => new Date(Date.UTC(2026, 8, 11, 0, 0, 0)));
  const scheduler = overrides.scheduler ?? (() => {});
  // Parse the JSON line before pushing so tests can filter on object properties
  // (e.g. `h.kind === 'entry_skipped'`). _safeHistoryAppend calls
  // historyAppend(line) where line = JSON.stringify(record).
  const historyAppend = overrides.historyAppend ?? (async (line) => {
    try { history.push(JSON.parse(line)); }
    catch { history.push(line); }
  });
  const ranker = overrides.ranker ?? ((stats, _cfg, opts) => {
    const candidates = (stats ?? []).map((s, i) => ({
      token_id: s.token_id,
      rank: i + 1,
      topK: 3,
      score: 0.7,
      eligible: true,
      stats: s,
      reasoning: { ts: opts?.nowMs ?? Date.now(), eligible_for_trade: true, score: 0.7, rank: i + 1, topK: 3, passed_filters: [], conditions: {} },
      notes: [],
      breakdown: { missing: [] },
    }));
    return { candidates, meta: { input_count: stats.length, returned: candidates.length, notes: [] } };
  });

  const loop = new TradingLoop({
    cfg,
    fetcher,
    wallet,
    swap,
    positions,
    snapshots,
    breaker: overrides.breaker ?? fakeBreaker(),
    historyAppend,
    logger,
    clock,
    scheduler,
    ranker,
    dryRun: overrides.dryRun === true,
    dexAdapters: [],
    pickBestAdapter: undefined,
    safeAlertDispatch: null,
    alertsAppend: null,
    orphanPositionDispatch: null,
    orphanAutoCloseExecute: null,
    adaptiveWeightsSuggest: null,
    adaptiveWeightsApply: null,
    adaptiveWeightsAuditBuilder: null,
    adaptiveWeightsLoadHistory: null,
    adaptiveWeightsLoadUserJson: null,
    adaptiveWeightsAuditAppend: null,
    adaptiveWeightsWriteUserJson: null,
    adaptiveWeightsLogPath: null,
    userJsonPath: null,
    stakingLockExecute: null,
    stakingUnlockExecute: null,
    stakingDispatch: null,
    stakingProvider: null,
    stakingGetBlockHeight: null,
    stakingWif: null,
    utxoConsolidationExecute: null,
    utxoConsolidationBroadcast: null,
    utxoConsolidationWif: null,
    // T76 subset 2b seams — defaults to null; tests inject.
    holdersScannerCache: overrides.holdersScannerCache ?? null,
    holdersScannerFetcher: overrides.holdersScannerFetcher ?? null,
    holdersScannerProviderUrl: overrides.holdersScannerProviderUrl ?? null,
    holdersScannerTimeoutMs: overrides.holdersScannerTimeoutMs ?? null,
  });
  return { loop, history, logger, swap, wallet, cfg, records, portfolioRecords };
}

// ─────────────────────────────────────────────────────────────────────
//  Helper: stub fetcher that returns a `resolveHoldersSnapshot` envelope.
// ─────────────────────────────────────────────────────────────────────

function makeStubFetcher({ holdersByTokenId = {}, errorsByTokenId = {} } = {}) {
  // holdersByTokenId: { [token_id]: [{address, balance}, ...] }
  //   → fetcher returns ok:true envelope (caller-side rug pattern determined
  //     by `isRugPatternByHolders` against `top_n=5, threshold_pct=80`).
  // errorsByTokenId: { [token_id]: { error, message } } → fetcher returns ok:false.
  const calls = [];
  const fetcher = async (url, init) => {
    const m = /\/api\/tokens\/([0-9a-f]{64})\/holders/.exec(url);
    const tokenId = m ? m[1] : null;
    calls.push({ url, init, tokenId });
    // IMPORTANT: for token-not-found (404), return ok:true + status:200 + just a
    // `message` field (no `holders`) to trigger fetchTokenHoldersFromTokenStork's
    // token_not_found path (it checks body.message without holders for 200 responses).
    // For other error codes (503 etc.), preserve ok:false + original status so the
    // http_error path fires (which also results in shouldSkip:false + warn).
    if (tokenId && errorsByTokenId[tokenId]) {
      const errStatus = errorsByTokenId[tokenId].status ?? 404;
      if (errStatus === 404) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ message: errorsByTokenId[tokenId].message ?? 'not available' }),
        };
      }
      return {
        ok: false,
        status: errStatus,
        statusText: errorsByTokenId[tokenId].statusText ?? 'Service Unavailable',
        json: async () => ({ message: errorsByTokenId[tokenId].message ?? 'unavailable' }),
      };
    }
    if (tokenId && holdersByTokenId[tokenId]) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          category: tokenId,
          holders: holdersByTokenId[tokenId],
          snapshotAt: 1700000000,
        }),
      };
    }
    return {
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: async () => ({ message: 'This token is not available.' }),
    };
  };
  // Attach a `calls` accessor so tests can inspect.
  Object.defineProperty(fetcher, 'calls', { value: calls, enumerable: true });
  return fetcher;
}

// Helper: build a "rug pattern" holders list (5 wallets × 100 supply each).
function rugHolders(seed = 'r') {
  const list = [];
  for (let i = 0; i < 5; i++) {
    list.push({
      address: `bitcoincash:q${seed}${i.toString(16)}`.padEnd(40, '0'),
      balance: '100',
      nftCount: 0,
      snapshotAt: 1700000000,
    });
  }
  return list;
}

// Helper: build a "well-distributed" holders list (20 wallets × 5 supply each).
function distributedHolders(seed = 'd') {
  const list = [];
  for (let i = 0; i < 20; i++) {
    list.push({
      address: `bitcoincash:q${seed}${i.toString(16)}`.padEnd(40, '0'),
      balance: '5',
      nftCount: 0,
      snapshotAt: 1700000000,
    });
  }
  return list;
}

// ─────────────────────────────────────────────────────────────────────
//  Helpers: gating-flag getters
// ─────────────────────────────────────────────────────────────────────

function getCfgWithRugEnabled({ enabled = true } = {}) {
  return baseConfig({
    scoring: {
      ...DEFAULT_RANKER_CONFIG,
      concentration_rug_enabled: enabled,
      concentration_rug_top_n: 5,
      concentration_rug_threshold_pct: 80,
      concentration_rug_epsilon_pct: 1.0,
      concentration_rug_provider_url: 'https://stub.invalid',
      concentration_rug_timeout_ms: 5000,
      concentration_rug_cache_ms: 60000,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────
//  Tests — gate disabled (default OFF behavior)
// ─────────────────────────────────────────────────────────────────────

test('rug gate: disabled by default — no per-tick fetch, no entry_skipped event', async () => {
  const fetcher = makeStubFetcher({ holdersByTokenId: { [TID_A]: rugHolders() } });
  const cache = new HoldersScannerCache({ cacheMs: 60000 });
  const history = [];
  const { loop } = buildLoop({
    history,
    cfg: baseConfig(), // concentration_rug_enabled:false (default)
    holdersScannerCache: cache,
    holdersScannerFetcher: fetcher,
  });
  const result = await loop.tick();
  // Entry succeeded (gate is off) → no entry_skipped rug_pattern event.
  const rugSkips = history.filter((h) => h && h.kind === 'entry_skipped' && h.skip_kind === 'rug_pattern_detected');
  assert.equal(rugSkips.length, 0);
  // Fetcher was NEVER called — the gate is OFF.
  assert.equal(fetcher.calls.length, 0);
  // Stats: gate disabled.
  const stats = loop.stats();
  assert.equal(stats.rug_pattern_gate.last_tick.enabled, false);
  assert.equal(stats.rug_pattern_gate.last_tick.checked_count, 0);
});

test('rug gate: disabled — cache stats untouched (no writes happen)', async () => {
  const fetcher = makeStubFetcher({ holdersByTokenId: { [TID_A]: rugHolders() } });
  const cache = new HoldersScannerCache({ cacheMs: 60000 });
  const { loop } = buildLoop({
    cfg: baseConfig(),
    holdersScannerCache: cache,
    holdersScannerFetcher: fetcher,
  });
  await loop.tick();
  const cacheStats = cache.stats();
  assert.equal(cacheStats.stores, 0);
  assert.equal(cacheStats.misses, 0);
  assert.equal(cacheStats.hits, 0);
});

// ─────────────────────────────────────────────────────────────────────
//  Tests — gate ON, rug detected
// ─────────────────────────────────────────────────────────────────────

test('rug gate: enabled + rug detected → entry_skipped with kind rug_pattern_detected', async () => {
  const fetcher = makeStubFetcher({ holdersByTokenId: { [TID_A]: rugHolders() } });
  const cache = new HoldersScannerCache({ cacheMs: 60000 });
  const history = [];
  const logger = makeLogger();
  const { loop, swap } = buildLoop({
    history,
    logger,
    cfg: getCfgWithRugEnabled({ enabled: true }),
    holdersScannerCache: cache,
    holdersScannerFetcher: fetcher,
  });
  const result = await loop.tick();
  // Resolver fired (gate is ON) → fetcher called at least once.
  assert.ok(fetcher.calls.length >= 1);
  // Loop should have flagged the entry as skipped → swap was NEVER called.
  assert.equal(swap.calls.length, 0);
  // Find the rug-pattern skip event.
  const rugSkips = history.filter((h) => h && h.kind === 'entry_skipped' && h.skip_kind === 'rug_pattern_detected');
  assert.equal(rugSkips.length, 1);
  const skip = rugSkips[0];
  assert.equal(skip.token_id, TID_A);
  assert.equal(skip.reason.includes('rug-pattern'), true);
  assert.equal(skip.reason.includes('80%'), true);
  // Reasoning blob carries the audit fields.
  const r = skip.reasoning;
  assert.equal(r.decision.kind, 'rug_pattern_detected');
  assert.equal(r.decision.is_rug_pattern, true);
  assert.ok(typeof r.decision.top_n_pct === 'number');
  assert.ok(r.decision.top_n_pct >= 80);
  assert.equal(r.decision.holders_count, 5);
  assert.equal(typeof r.decision.total_supply_base, 'string');
  assert.equal(r.decision.threshold_pct, 80);
  assert.equal(r.decision.top_n, 5);
  // Loop should have logged a structured warn line.
  const warnLines = logger.events.filter((e) => e.level === 'warn' && e.event === 'loop.rug_pattern.detected');
  assert.equal(warnLines.length, 1);
  // Stats reflect the rug detection.
  const stats = loop.stats();
  assert.equal(stats.rug_pattern_gate.last_tick.enabled, true);
  assert.equal(stats.rug_pattern_gate.last_tick.detected_count, 1);
  assert.equal(stats.rug_pattern_gate.last_tick.checked_count, 1);
  assert.equal(stats.rug_pattern_gate.last_tick.candidate_count, 1);
  // Cache was populated (successful upstream response).
  assert.equal(cache.stats().stores, 1);
});

test('rug gate: enabled + non-rug → swap.execute IS called (pass-through)', async () => {
  const fetcher = makeStubFetcher({ holdersByTokenId: { [TID_A]: distributedHolders() } });
  const cache = new HoldersScannerCache({ cacheMs: 60000 });
  const history = [];
  const { loop, swap } = buildLoop({
    history,
    cfg: getCfgWithRugEnabled({ enabled: true }),
    holdersScannerCache: cache,
    holdersScannerFetcher: fetcher,
  });
  await loop.tick();
  // Entry succeeded → swap was called.
  assert.ok(swap.calls.length >= 1);
  // No rug-pattern skip event.
  const rugSkips = history.filter((h) => h && h.kind === 'entry_skipped' && h.skip_kind === 'rug_pattern_detected');
  assert.equal(rugSkips.length, 0);
  // Stats: enabled, checked, NOT detected.
  const stats = loop.stats();
  assert.equal(stats.rug_pattern_gate.last_tick.enabled, true);
  assert.equal(stats.rug_pattern_gate.last_tick.checked_count, 1);
  assert.equal(stats.rug_pattern_gate.last_tick.detected_count, 0);
});

// ─────────────────────────────────────────────────────────────────────
//  Tests — defensive guards
// ─────────────────────────────────────────────────────────────────────

test('rug gate: enabled + token_not_found → pass-through (no false-positive)', async () => {
  const fetcher = makeStubFetcher({
    errorsByTokenId: { [TID_A]: { status: 404, message: 'This token is not available.' } },
  });
  const cache = new HoldersScannerCache({ cacheMs: 60000 });
  const history = [];
  const logger = makeLogger();
  const { loop, swap } = buildLoop({
    history,
    logger,
    cfg: getCfgWithRugEnabled({ enabled: true }),
    holdersScannerCache: cache,
    holdersScannerFetcher: fetcher,
  });
  await loop.tick();
  // Pass-through → swap was called.
  assert.ok(swap.calls.length >= 1);
  // No rug-pattern skip event.
  const rugSkips = history.filter((h) => h && h.kind === 'entry_skipped' && h.skip_kind === 'rug_pattern_detected');
  assert.equal(rugSkips.length, 0);
  // No scanner_error warn (token_not_found is the documented silent path).
  const errWarns = logger.events.filter((e) => e.level === 'warn' && e.event === 'loop.rug_pattern.scanner_error');
  assert.equal(errWarns.length, 0);
  // Stats: token_not_found count incremented.
  const stats = loop.stats();
  assert.equal(stats.rug_pattern_gate.last_tick.token_not_found_count, 1);
  assert.equal(stats.rug_pattern_gate.last_tick.detected_count, 0);
});

test('rug gate: enabled + cache null → fallback (subset 1 behavior, no false-positive)', async () => {
  const fetcher = makeStubFetcher({ holdersByTokenId: { [TID_A]: rugHolders() } });
  const history = [];
  const logger = makeLogger();
  const { loop, swap } = buildLoop({
    history,
    logger,
    cfg: getCfgWithRugEnabled({ enabled: true }),
    holdersScannerCache: null, // ← no cache seam wired
    holdersScannerFetcher: fetcher,
  });
  await loop.tick();
  // Pass-through (subset 1 fallback) → swap was called.
  assert.ok(swap.calls.length >= 1);
  // No rug-pattern skip event (defensive fallback).
  const rugSkips = history.filter((h) => h && h.kind === 'entry_skipped' && h.skip_kind === 'rug_pattern_detected');
  assert.equal(rugSkips.length, 0);
  // Fetcher NEVER called (we short-circuit before resolveHoldersSnapshot).
  assert.equal(fetcher.calls.length, 0);
  // Structured warn line fired exactly once.
  const unwiredWarns = logger.events.filter((e) => e.level === 'warn' && e.event === 'loop.rug_pattern.unwired');
  assert.equal(unwiredWarns.length, 1);
  // Stats: skipped_unwired_count incremented.
  const stats = loop.stats();
  assert.equal(stats.rug_pattern_gate.last_tick.skipped_unwired_count, 1);
  assert.equal(stats.rug_pattern_gate.last_tick.checked_count, 0);
});

test('rug gate: enabled + other scanner error → pass-through with warn', async () => {
  const fetcher = makeStubFetcher({
    errorsByTokenId: { [TID_A]: { status: 503, message: 'upstream timed out' } },
  });
  const cache = new HoldersScannerCache({ cacheMs: 60000 });
  const history = [];
  const logger = makeLogger();
  const { loop, swap } = buildLoop({
    history,
    logger,
    cfg: getCfgWithRugEnabled({ enabled: true }),
    holdersScannerCache: cache,
    holdersScannerFetcher: fetcher,
  });
  await loop.tick();
  // Pass-through → swap was called.
  assert.ok(swap.calls.length >= 1);
  // No rug-pattern skip event.
  const rugSkips = history.filter((h) => h && h.kind === 'entry_skipped' && h.skip_kind === 'rug_pattern_detected');
  assert.equal(rugSkips.length, 0);
  // scanner_error warn fired.
  const errWarns = logger.events.filter((e) => e.level === 'warn' && e.event === 'loop.rug_pattern.scanner_error');
  assert.equal(errWarns.length, 1);
  const stats = loop.stats();
  assert.equal(stats.rug_pattern_gate.last_tick.error_count, 1);
});

test('rug gate: enabled + fetcher throws → resolver wraps as scanner_error (defensive)', async () => {
  // T76 subset 2b follow-up: `fetchTokenHoldersFromTokenStork`
  // catches the fetcher throw and returns
  // `ok:false, error:'fetch_failed'`, which the resolver
  // surfaces as a `scanner_error` warn (NOT an
  // `unexpected_throw` warn — the resolver itself never throws
  // because the scanner module wraps the fetch). This test
  // documents that defensive posture: a fetcher-side
  // ECONNREFUSED / DNS failure becomes a scanner_error warn
  // and the entry proceeds (pass-through). Renamed from the
  // original "resolver throws" because the resolver itself is
  // designed to never throw (the loop's `try { ... } catch
  // (unexpected_throw)` block exists as a defensive belt-and-
  // suspenders net for a future refactor that might violate
  // that contract).
  const fetcher = async () => {
    throw new Error('unexpected fetch throw');
  };
  const cache = new HoldersScannerCache({ cacheMs: 60000 });
  const history = [];
  const logger = makeLogger();
  const { loop, swap } = buildLoop({
    history,
    logger,
    cfg: getCfgWithRugEnabled({ enabled: true }),
    holdersScannerCache: cache,
    holdersScannerFetcher: fetcher,
  });
  await loop.tick();
  // Pass-through → swap was called.
  assert.ok(swap.calls.length >= 1);
  // No rug-pattern skip event.
  const rugSkips = history.filter((h) => h && h.kind === 'entry_skipped' && h.skip_kind === 'rug_pattern_detected');
  assert.equal(rugSkips.length, 0);
  // scanner_error warn fired (NOT unexpected_throw — the resolver
  // wrapped the fetcher throw as a typed `ok:false, error:
  // 'fetch_failed'` envelope before the loop's catch block could
  // see it).
  const errWarns = logger.events.filter((e) => e.level === 'warn' && e.event === 'loop.rug_pattern.scanner_error');
  assert.equal(errWarns.length, 1);
  const throwWarns = logger.events.filter((e) => e.level === 'warn' && e.event === 'loop.rug_pattern.unexpected_throw');
  assert.equal(throwWarns.length, 0);
  // Stats: error_count incremented.
  const stats = loop.stats();
  assert.equal(stats.rug_pattern_gate.last_tick.error_count, 1);
});

test('rug gate: cache hit on second tick — fetcher NOT called twice', async () => {
  const fetcher = makeStubFetcher({ holdersByTokenId: { [TID_A]: rugHolders() } });
  const cache = new HoldersScannerCache({ cacheMs: 60000 });
  const cfg = getCfgWithRugEnabled({ enabled: true });
  const { loop } = buildLoop({
    cfg,
    holdersScannerCache: cache,
    holdersScannerFetcher: fetcher,
  });
  // Two ticks in a row. First tick: cache miss → fetcher called. Second
  // tick: cache hit → fetcher NOT called again.
  await loop.tick();
  const callsAfterFirst = fetcher.calls.length;
  assert.ok(callsAfterFirst >= 1);
  await loop.tick();
  const callsAfterSecond = fetcher.calls.length;
  assert.equal(callsAfterSecond, callsAfterFirst, 'fetcher should not be called on a cache hit');
  // Stats: cache_hit_count incremented on tick 2.
  const stats = loop.stats();
  assert.ok(stats.rug_pattern_gate.last_tick.cache_hit_count >= 1);
});

test('rug gate: enabled + provider_url + timeout_ms propagate to scanner opts', async () => {
  const fetcher = makeStubFetcher({ holdersByTokenId: { [TID_A]: distributedHolders() } });
  const cache = new HoldersScannerCache({ cacheMs: 60000 });
  const { loop } = buildLoop({
    cfg: getCfgWithRugEnabled({ enabled: true }),
    holdersScannerCache: cache,
    holdersScannerFetcher: fetcher,
    holdersScannerProviderUrl: 'https://custom-mirror.example/api',
    holdersScannerTimeoutMs: 1234,
  });
  await loop.tick();
  // Verify the fetcher was called with the custom URL prefix.
  const url = fetcher.calls[0]?.url ?? '';
  assert.equal(url.startsWith('https://custom-mirror.example/api'), true,
    `expected URL to start with custom provider, got: ${url}`);
});

test('rug gate: enabled + candidates list — checked_count mirrors candidate count', async () => {
  const fetcher = makeStubFetcher({
    holdersByTokenId: {
      [TID_A]: distributedHolders('a'),
      [TID_B]: distributedHolders('b'),
    },
  });
  const cache = new HoldersScannerCache({ cacheMs: 60000 });
  const cfg = getCfgWithRugEnabled({ enabled: true });
  const { loop } = buildLoop({
    cfg,
    holdersScannerCache: cache,
    holdersScannerFetcher: fetcher,
    indexerRecords: [
      indexerRecord({ token_id: TID_A }),
      indexerRecord({ token_id: TID_B, symbol: 'TKB', bcmr: { token: { symbol: 'TKB', name: 'Token B', decimals: 3 } } }),
    ],
  });
  await loop.tick();
  const stats = loop.stats();
  assert.equal(stats.rug_pattern_gate.last_tick.candidate_count, 2);
  assert.equal(stats.rug_pattern_gate.last_tick.checked_count, 2);
  assert.equal(stats.rug_pattern_gate.last_tick.detected_count, 0);
});

test('rug gate: live rug detection emits a remediation hint in the reasoning', async () => {
  const fetcher = makeStubFetcher({ holdersByTokenId: { [TID_A]: rugHolders() } });
  const cache = new HoldersScannerCache({ cacheMs: 60000 });
  const history = [];
  const { loop } = buildLoop({
    history,
    cfg: getCfgWithRugEnabled({ enabled: true }),
    holdersScannerCache: cache,
    holdersScannerFetcher: fetcher,
  });
  await loop.tick();
  const skip = history.find((h) => h && h.kind === 'entry_skipped' && h.skip_kind === 'rug_pattern_detected');
  assert.ok(skip);
  assert.ok(skip.reasoning.remediation);
  assert.ok(skip.reasoning.remediation.blacklist.includes('excluded_concentration_tokens'));
  assert.ok(skip.reasoning.remediation.disable_live_check.includes('concentration_rug_enabled'));
  assert.ok(skip.reasoning.remediation.audit_endpoint.includes('/api/token'));
});

// ─────────────────────────────────────────────────────────────────────
//  Tests — seam validation
// ─────────────────────────────────────────────────────────────────────

test('rug gate: holdersScannerCache seam accepts null (subset 1 fallback)', () => {
  // Construction should not throw.
  const { loop } = buildLoop({ holdersScannerCache: null });
  assert.equal(loop.stats().rug_pattern_gate.cache, null);
});

test('rug gate: holdersScannerCache seam rejects bad shapes (no get/set)', () => {
  // Cache shape must have `.get` + `.set`; an object missing them
  // is treated as null.
  const { loop } = buildLoop({ holdersScannerCache: { get: () => null } });
  assert.equal(loop.stats().rug_pattern_gate.cache, null);
});

test('rug gate: holdersScannerFetcher seam accepts non-function as null', () => {
  const fetcher = makeStubFetcher({ holdersByTokenId: { [TID_A]: distributedHolders() } });
  const cache = new HoldersScannerCache({ cacheMs: 60000 });
  const { loop } = buildLoop({
    cfg: getCfgWithRugEnabled({ enabled: true }),
    holdersScannerCache: cache,
    holdersScannerFetcher: 'not-a-function', // ← rejected, defaults to globalThis.fetch
  });
  // Should not throw on construction.
  assert.ok(loop);
});

test('rug gate: holdersScannerProviderUrl seam accepts string + null', () => {
  const { loop } = buildLoop({ holdersScannerProviderUrl: 'https://x.example/api' });
  assert.ok(loop);
  const { loop: loop2 } = buildLoop({ holdersScannerProviderUrl: '' });
  assert.ok(loop2);
});

test('rug gate: holdersScannerTimeoutMs seam accepts finite number + null', () => {
  const { loop } = buildLoop({ holdersScannerTimeoutMs: 2500 });
  assert.ok(loop);
  const { loop: loop2 } = buildLoop({ holdersScannerTimeoutMs: 'not-a-number' });
  assert.ok(loop2);
});

// ─────────────────────────────────────────────────────────────────────
//  Tests — gate fires AFTER canOpen (5c) and BEFORE swap.execute (5d)
// ─────────────────────────────────────────────────────────────────────

test('rug gate: rug detection short-circuits BEFORE swap.execute (no on-chain broadcast)', async () => {
  const fetcher = makeStubFetcher({ holdersByTokenId: { [TID_A]: rugHolders() } });
  const cache = new HoldersScannerCache({ cacheMs: 60000 });
  const history = [];
  const swap = fakeSwap();
  const { loop } = buildLoop({
    history,
    swap,
    cfg: getCfgWithRugEnabled({ enabled: true }),
    holdersScannerCache: cache,
    holdersScannerFetcher: fetcher,
  });
  const result = await loop.tick();
  // The candidate was eligible (ranker said YES) AND canOpen said
  // YES (no wallet-floor / second-position gates fired), but the
  // rug-pattern gate short-circuited the swap.
  assert.equal(swap.calls.length, 0);
  const rugSkips = history.filter((h) => h && h.kind === 'entry_skipped' && h.skip_kind === 'rug_pattern_detected');
  assert.equal(rugSkips.length, 1);
  // TickResult reflects the skip. NOTE: the loop reports per-
  // candidate decisions in `result.entries` (the entry-evaluation
  // pipeline), NOT `result.candidates` (which holds the raw
  // ranker output — pre-evaluation). Mirrors the dashboard's
  // `/healthz` payload shape.
  const entry = result.entries[0];
  assert.equal(entry?.decision, 'skipped');
  assert.equal(entry?.kind, 'rug_pattern_detected');
});
