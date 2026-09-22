#!/usr/bin/env node
// tests/trader/dex-router.test.mjs
//
// T57-3 unit tests for `src/trader/dex-router.mjs` — the
// multi-DEX routing layer that picks the best adapter per
// (token, side, size) at trade time.
//
// Coverage:
//   • DexRouterError / DexRouterConfigError — shape sanity
//   • withTimeout — resolves / rejects on timeout / bad input
//   • adapterRateForSide — null / non-object / empty pools /
//                          bad shape / happy buy/sell / spotRates
//                          throwing / number + string rate
//                          coercion paths
//   • pickBestFromScorecards — empty / single / multi / tie-break
//   • pickBestAdapter — full envelope (ok/no_adapters/no_rates/
//                       adapter-missing-methods/timeout/thrown/
//                       per-call fast path) + bad-input throws
//
// Every external surface is mocked (no network, no real adapters).
// Run with:  node --test tests/trader/dex-router.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DexRouterError,
  DexRouterConfigError,
  withTimeout,
  adapterRateForSide,
  pickBestFromScorecards,
  pickBestAdapter,
} from '../../src/trader/dex-router.mjs';

// ─────────────────────────────────────────────────────────────────────
//  Pool fixtures — shapes the cauldron SDK's `spotRates()` accepts.
// ─────────────────────────────────────────────────────────────────────

/**
 * Build a minimal pool. `sats/tokens` gives the spot rate in sats
 * per token. With sats=100_000 tokens=100 → 1000 sats/token.
 *
 * IMPORTANT: sats + tokens must be Numbers (not BigInts) to match
 * what the cauldron indexer actually returns. The SDK's
 * `bestMarginalBuyRate` accumulates in a `Number` and checks
 * `Number.isFinite(best)`; when the rate itself is a BigInt
 * (from BigInt÷BigInt division), `Number.isFinite(1000n)` is `false`
 * and `bestMarginalBuyRate` silently returns `undefined`.
 */
function pool(sats, tokens) {
  return {
    pool_id: `${sats}${tokens}`.padStart(32, '0'),
    txid: '11'.repeat(32),
    tx_pos: 0,
    sats: Number(sats),   // Number — NOT BigInt (breaks bestMarginalBuyRate)
    tokens: Number(tokens), // Number — NOT BigInt
    owner_p2pkh_addr: 'bitcoincash:qfake',
  };
}

/** Pools priced at exactly 1000 sats/token. */
function pools1k() {
  return [pool(100_000, 100), pool(200_000, 200)];
}

/** Pools priced at 1200 sats/token — strictly worse than `pools1k()` for buy. */
function pools1200() {
  return [pool(120_000, 100), pool(240_000, 200)];
}

/** Build a fake adapter stub. */
function adapter(id, poolsAndMeta, opts = {}) {
  return {
    id,
    displayName: opts.displayName ?? id,
    safeMode: opts.safeMode === true,
    indexerUrl: opts.indexerUrl ?? `https://${id}.example`,
    async getPoolsAndMeta({ tokenId }) {
      if (typeof opts.getPoolsAndMetaImpl === 'function') {
        return opts.getPoolsAndMetaImpl({ tokenId });
      }
      return poolsAndMeta ?? { pools: pools1k(), tokenMeta: null };
    },
    prepareAndBuildSwap: async () => ({ txHex: 'aa' }),
    broadcastTx: async () => ({ txid: 'bb'.repeat(32) }),
    verifyTrade: async () => ({ ok: true }),
    constants: {},
  };
}

// ─────────────────────────────────────────────────────────────────────
//  DexRouterError / DexRouterConfigError — shape sanity
// ─────────────────────────────────────────────────────────────────────

test('DexRouterError: stores name + message + kind + cause', () => {
  const cause = new Error('underlying');
  const e = new DexRouterError('boom', { kind: 'test_kind', cause });
  assert.equal(e.name, 'DexRouterError');
  assert.equal(e.message, 'boom');
  assert.equal(e.kind, 'test_kind');
  assert.strictEqual(e.cause, cause);
  assert.ok(e instanceof Error);
});

test('DexRouterError: tolerates missing kind/cause', () => {
  const e = new DexRouterError('just-a-message');
  assert.equal(e.name, 'DexRouterError');
  assert.equal(e.message, 'just-a-message');
  assert.equal(e.kind, undefined);
  assert.equal(e.cause, undefined);
});

test('DexRouterConfigError: subclass with its own name', () => {
  const e = new DexRouterConfigError('bad config');
  assert.equal(e.name, 'DexRouterConfigError');
  assert.equal(e.message, 'bad config');
  assert.ok(e instanceof DexRouterError);
  assert.ok(e instanceof Error);
});

// ─────────────────────────────────────────────────────────────────────
//  withTimeout
// ─────────────────────────────────────────────────────────────────────

test('withTimeout: resolves with the inner promise value when it wins', async () => {
  const out = await withTimeout(Promise.resolve('ok'), 1000, 'label');
  assert.equal(out, 'ok');
});

test('withTimeout: rejects when the inner promise exceeds the timeout', async () => {
  // Inner promise that NEVER resolves. Use a never-resolving promise.
  const inner = new Promise(() => {});
  await assert.rejects(
    () => withTimeout(inner, 50, 'slow-promise'),
    (e) => {
      assert.ok(e instanceof DexRouterConfigError);
      assert.equal(e.kind, 'timeout');
      assert.match(e.message, /slow-promise timed out after 50ms/);
      return true;
    },
  );
});

test('withTimeout: clears the timer on resolve (no leak warning)', async () => {
  // We can't directly assert clearTimeout fired, but we can verify
  // the inner promise's value is delivered and the wrapper returns
  // cleanly without rejecting.
  const out = await withTimeout(Promise.resolve(42), 500, 'ok');
  assert.equal(out, 42);
});

test('withTimeout: rejects on bad input (non-promise)', async () => {
  await assert.rejects(
    () => withTimeout(123, 1000, 'x'),
    (e) => {
      assert.ok(e instanceof DexRouterConfigError);
      assert.match(e.message, /first arg must be a promise/);
      return true;
    },
  );
});

test('withTimeout: rejects on bad timeout (zero / negative / NaN)', async () => {
  for (const bad of [0, -1, NaN, Infinity, '100', null]) {
    await assert.rejects(
      () => withTimeout(Promise.resolve('ok'), bad, 'x'),
      (e) => {
        assert.ok(e instanceof DexRouterConfigError);
        return true;
      },
    );
  }
});

// ─────────────────────────────────────────────────────────────────────
//  adapterRateForSide
// ─────────────────────────────────────────────────────────────────────

test('adapterRateForSide: null / undefined / non-object → null', () => {
  assert.equal(adapterRateForSide(null, 'buy'), null);
  assert.equal(adapterRateForSide(undefined, 'buy'), null);
  assert.equal(adapterRateForSide('nope', 'buy'), null);
  assert.equal(adapterRateForSide(42, 'buy'), null);
});

test('adapterRateForSide: missing pools / non-array pools → null', () => {
  assert.equal(adapterRateForSide({}, 'buy'), null);
  assert.equal(adapterRateForSide({ pools: 'nope' }, 'buy'), null);
  assert.equal(adapterRateForSide({ pools: null }, 'buy'), null);
});

test('adapterRateForSide: empty pools → null', () => {
  assert.equal(adapterRateForSide({ pools: [] }, 'buy'), null);
  assert.equal(adapterRateForSide({ pools: [] }, 'sell'), null);
});

test('adapterRateForSide: returns the buySpot as a bigint', () => {
  // spotRates on pools1k() returns { buySpot: 1000, sellSpot: 1000 } (numbers).
  const r = adapterRateForSide({ pools: pools1k() }, 'buy');
  assert.equal(typeof r, 'bigint');
  assert.equal(r, 1000n);
});

test('adapterRateForSide: returns the sellSpot as a bigint', () => {
  const r = adapterRateForSide({ pools: pools1200() }, 'sell');
  assert.equal(typeof r, 'bigint');
  assert.equal(r, 1200n);
});

test('adapterRateForSide: spotRates throwing → null (no crash)', () => {
  // A pool shape that throws inside the SDK's spotRates. The SDK's
  // bestMarginalBuyRate dereferences `pool.sats` and `pool.tokens` —
  // passing a non-bigint (or missing) will throw.
  const bad = [{ pool_id: 'x', txid: '11'.repeat(32), tx_pos: 0, sats: 'not-a-bigint', tokens: null, owner_p2pkh_addr: 'bitcoincash:qfake' }];
  assert.equal(adapterRateForSide({ pools: bad }, 'buy'), null);
});

test('adapterRateForSide: tolerates spotRates returning null', () => {
  // spotRates won't return null in practice, but the helper should
  // tolerate it (defensive). Easiest way: pass an array whose first
  // pool has zero tokens AND zero sats so spotRates returns undefined
  // for the rate (which is `undefined` not a bigint/number).
  const degenerate = [pool(0, 0)];
  const r = adapterRateForSide({ pools: degenerate }, 'buy');
  // spotRates will either throw (caught → null) or return undefined (→ null).
  assert.equal(r, null);
});

// ─────────────────────────────────────────────────────────────────────
//  pickBestFromScorecards
// ─────────────────────────────────────────────────────────────────────

test('pickBestFromScorecards: empty / non-array → null', () => {
  assert.equal(pickBestFromScorecards([], 'buy'), null);
  assert.equal(pickBestFromScorecards(null, 'buy'), null);
  assert.equal(pickBestFromScorecards(undefined, 'buy'), null);
  assert.equal(pickBestFromScorecards('nope', 'buy'), null);
});

test('pickBestFromScorecards: single valid → that entry (no tie-break)', () => {
  const out = pickBestFromScorecards(
    [{ id: 'a', displayName: 'A', safeMode: false, rateSats: 100n }],
    'buy',
  );
  assert.deepEqual(out, {
    id: 'a', displayName: 'A', safeMode: false, rateSats: 100n, tieBroken: false,
  });
});

test('pickBestFromScorecards: BUY → lower rate wins', () => {
  const out = pickBestFromScorecards(
    [
      { id: 'a', displayName: 'A', safeMode: false, rateSats: 1200n },
      { id: 'b', displayName: 'B', safeMode: false, rateSats: 1000n },
      { id: 'c', displayName: 'C', safeMode: false, rateSats: 1100n },
    ],
    'buy',
  );
  assert.equal(out.id, 'b');
  assert.equal(out.rateSats, 1000n);
  assert.equal(out.tieBroken, false);
});

test('pickBestFromScorecards: SELL → higher rate wins', () => {
  const out = pickBestFromScorecards(
    [
      { id: 'a', displayName: 'A', safeMode: false, rateSats: 1000n },
      { id: 'b', displayName: 'B', safeMode: false, rateSats: 1200n },
      { id: 'c', displayName: 'C', safeMode: false, rateSats: 1100n },
    ],
    'sell',
  );
  assert.equal(out.id, 'b');
  assert.equal(out.rateSats, 1200n);
  assert.equal(out.tieBroken, false);
});

test('pickBestFromScorecards: tie on rate → alphabetical id wins; tieBroken:true', () => {
  const out = pickBestFromScorecards(
    [
      { id: 'zzz', displayName: 'Z', safeMode: false, rateSats: 1000n },
      { id: 'aaa', displayName: 'A', safeMode: false, rateSats: 1000n },
      { id: 'mmm', displayName: 'M', safeMode: false, rateSats: 1000n },
    ],
    'buy',
  );
  assert.equal(out.id, 'aaa');
  assert.equal(out.rateSats, 1000n);
  assert.equal(out.tieBroken, true);
});

test('pickBestFromScorecards: filters out entries without a bigint rateSats', () => {
  const out = pickBestFromScorecards(
    [
      { id: 'a', displayName: 'A', safeMode: false, rateSats: null },
      { id: 'b', displayName: 'B', safeMode: false, rateSats: 1000n },
      { id: 'c', displayName: 'C', safeMode: false }, // no rateSats at all
    ],
    'buy',
  );
  assert.equal(out.id, 'b');
});

test('pickBestFromScorecards: all entries invalid → null', () => {
  const out = pickBestFromScorecards(
    [
      { id: 'a', displayName: 'A', safeMode: false, rateSats: null },
      { id: 'b', displayName: 'B', safeMode: false, rateSats: 'not-a-bigint' },
    ],
    'buy',
  );
  assert.equal(out, null);
});

test('pickBestFromScorecards: safeMode flag is preserved on the winner', () => {
  const out = pickBestFromScorecards(
    [
      { id: 'a', displayName: 'A', safeMode: true, rateSats: 1000n },
      { id: 'b', displayName: 'B', safeMode: false, rateSats: 1100n },
    ],
    'buy',
  );
  assert.equal(out.id, 'a');
  assert.equal(out.safeMode, true);
});

// ─────────────────────────────────────────────────────────────────────
//  pickBestAdapter — typed envelope behavior
// ─────────────────────────────────────────────────────────────────────

test('pickBestAdapter: bad adapters arg → throws DexRouterConfigError', async () => {
  await assert.rejects(
    () => pickBestAdapter('nope', { tokenId: 'x', side: 'buy' }),
    DexRouterConfigError,
  );
  await assert.rejects(
    () => pickBestAdapter(null, { tokenId: 'x', side: 'buy' }),
    DexRouterConfigError,
  );
});

test('pickBestAdapter: bad opts → throws DexRouterConfigError', async () => {
  await assert.rejects(
    () => pickBestAdapter([], null),
    DexRouterConfigError,
  );
  await assert.rejects(
    () => pickBestAdapter([], undefined),
    DexRouterConfigError,
  );
});

test('pickBestAdapter: bad tokenId → throws DexRouterConfigError', async () => {
  await assert.rejects(
    () => pickBestAdapter([], { tokenId: '', side: 'buy' }),
    DexRouterConfigError,
  );
  await assert.rejects(
    () => pickBestAdapter([], { tokenId: null, side: 'buy' }),
    DexRouterConfigError,
  );
});

test('pickBestAdapter: bad side → throws DexRouterConfigError', async () => {
  await assert.rejects(
    () => pickBestAdapter([], { tokenId: 't', side: 'hold' }),
    DexRouterConfigError,
  );
  await assert.rejects(
    () => pickBestAdapter([], { tokenId: 't', side: null }),
    DexRouterConfigError,
  );
});

test('pickBestAdapter: empty adapter list → ok:false reason:no_adapters', async () => {
  const r = await pickBestAdapter([], { tokenId: 't', side: 'buy' });
  assert.equal(r.ok, false);
  assert.equal(r.adapter, null);
  assert.equal(r.adapterId, null);
  assert.equal(r.rateSats, null);
  assert.equal(r.reason, 'no_adapters');
  assert.deepEqual(r.scorecards, []);
  assert.equal(r.tieBroken, false);
});

test('pickBestAdapter: single adapter with rate → that adapter wins (no overhead)', async () => {
  const a = adapter('cauldron', { pools: pools1k() });
  const r = await pickBestAdapter([a], { tokenId: 't', side: 'buy' });
  assert.equal(r.ok, true);
  assert.equal(r.adapterId, 'cauldron');
  assert.strictEqual(r.adapter, a);
  assert.equal(r.rateSats, 1000n);
  assert.equal(r.tieBroken, false);
});

test('pickBestAdapter: multi-adapter BUY → picks the LOWER rate', async () => {
  const a = adapter('cauldron', { pools: pools1200() });
  const b = adapter('cauldron_safe_mode', { pools: pools1k() });
  const r = await pickBestAdapter([a, b], { tokenId: 't', side: 'buy' });
  assert.equal(r.ok, true);
  assert.equal(r.adapterId, 'cauldron_safe_mode');
  assert.equal(r.rateSats, 1000n);
});

test('pickBestAdapter: multi-adapter SELL → picks the HIGHER rate', async () => {
  const a = adapter('cauldron', { pools: pools1k() });
  const b = adapter('cauldron_safe_mode', { pools: pools1200() });
  const r = await pickBestAdapter([a, b], { tokenId: 't', side: 'sell' });
  assert.equal(r.ok, true);
  assert.equal(r.adapterId, 'cauldron_safe_mode');
  assert.equal(r.rateSats, 1200n);
});

test('pickBestAdapter: tie → alphabetical id wins, tieBroken:true', async () => {
  const z = adapter('zzz', { pools: pools1k() });
  const a = adapter('aaa', { pools: pools1k() });
  const r = await pickBestAdapter([z, a], { tokenId: 't', side: 'buy' });
  assert.equal(r.ok, true);
  assert.equal(r.adapterId, 'aaa');
  assert.equal(r.tieBroken, true);
});

test('pickBestAdapter: adapter with no pools → per-adapter miss in scorecards, others still picked', async () => {
  const empty = adapter('empty', { pools: [] });
  const good = adapter('cauldron', { pools: pools1k() });
  const r = await pickBestAdapter([empty, good], { tokenId: 't', side: 'buy' });
  assert.equal(r.ok, true);
  assert.equal(r.adapterId, 'cauldron');
  // Scorecards record the miss reason for the empty adapter.
  const emptyCard = r.scorecards.find((s) => s.id === 'empty');
  assert.equal(emptyCard.rateSats, null);
  assert.match(emptyCard.error, /no pools or zero-liquidity/);
});

test('pickBestAdapter: adapter throwing on getPoolsAndMeta → typed miss; others still picked', async () => {
  const broken = adapter('broken', null, {
    getPoolsAndMetaImpl: async () => { throw new Error('network down'); },
  });
  const good = adapter('cauldron', { pools: pools1k() });
  const r = await pickBestAdapter([broken, good], { tokenId: 't', side: 'buy' });
  assert.equal(r.ok, true);
  assert.equal(r.adapterId, 'cauldron');
  const brokenCard = r.scorecards.find((s) => s.id === 'broken');
  assert.match(brokenCard.error, /getPoolsAndMeta threw: network down/);
});

test('pickBestAdapter: adapter missing getPoolsAndMeta method → typed miss', async () => {
  const incomplete = {
    id: 'incomplete',
    displayName: 'Incomplete',
    safeMode: false,
    // No getPoolsAndMeta.
    prepareAndBuildSwap: async () => ({}),
    broadcastTx: async () => ({}),
    verifyTrade: async () => ({ ok: true }),
  };
  const good = adapter('cauldron', { pools: pools1k() });
  const r = await pickBestAdapter([incomplete, good], { tokenId: 't', side: 'buy' });
  assert.equal(r.ok, true);
  assert.equal(r.adapterId, 'cauldron');
  const incCard = r.scorecards.find((s) => s.id === 'incomplete');
  assert.match(incCard.error, /adapter missing getPoolsAndMeta/);
});

test('pickBestAdapter: all adapters fail → ok:false, reason populated with miss-reasons', async () => {
  const a = adapter('a', { pools: [] });
  const b = adapter('b', null, {
    getPoolsAndMetaImpl: async () => { throw new Error('boom'); },
  });
  const r = await pickBestAdapter([a, b], { tokenId: 't', side: 'buy' });
  assert.equal(r.ok, false);
  assert.equal(r.adapter, null);
  assert.match(r.reason, /no pools or zero-liquidity/);
  assert.match(r.reason, /getPoolsAndMeta threw: boom/);
});

test('pickBestAdapter: per-adapter timeout → typed miss', async () => {
  const slow = adapter('slow', null, {
    getPoolsAndMetaImpl: () => new Promise(() => {}), // never resolves
  });
  const good = adapter('cauldron', { pools: pools1k() });
  const r = await pickBestAdapter([slow, good], {
    tokenId: 't',
    side: 'buy',
    timeoutMs: 50,
  });
  assert.equal(r.ok, true);
  assert.equal(r.adapterId, 'cauldron');
  const slowCard = r.scorecards.find((s) => s.id === 'slow');
  assert.match(slowCard.error, /timed out after 50ms/);
});

test('pickBestAdapter: amountBase is informational; rate comparison unaffected', async () => {
  // Different amountBase values should NOT change the per-base-unit
  // rate comparison (router uses marginal rates).
  const a = adapter('cauldron', { pools: pools1200() });
  const b = adapter('cauldron_safe_mode', { pools: pools1k() });
  const r = await pickBestAdapter([a, b], {
    tokenId: 't',
    side: 'buy',
    amountBase: 123_456_789n,
  });
  assert.equal(r.adapterId, 'cauldron_safe_mode');
  assert.equal(r.rateSats, 1000n);
});

// ─────────────────────────────────────────────────────────────────────
//  pickBestAdapter — bad-input shape throws (DexRouterConfigError contract)
// ─────────────────────────────────────────────────────────────────────

test('pickBestAdapter: DexRouterConfigError carries a helpful message on bad adapters arg', async () => {
  try {
    await pickBestAdapter(42, { tokenId: 't', side: 'buy' });
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof DexRouterConfigError);
    assert.match(e.message, /adapters must be an array/);
  }
});

test('pickBestAdapter: DexRouterConfigError on bad side', async () => {
  try {
    await pickBestAdapter([], { tokenId: 't', side: 'short' });
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof DexRouterConfigError);
    assert.match(e.message, /side must be 'buy' or 'sell'/);
  }
});
