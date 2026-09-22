#!/usr/bin/env node
// src/dex/cauldron.mjs
//
// Cauldron DEX adapter — the live adapter that wraps the existing
// `src/trader/cauldron/*.mjs` library functions behind the
// `src/dex/adapter.mjs` contract.
//
// This is the production DEX the bot trades against today. The
// adapter surface is intentionally identical to the wrapper calls
// swap.mjs / loop.mjs already make:
//
//   - getPoolsAndMeta  → src/trader/cauldron/get_price.mjs#getPoolsAndMeta
//   - getTokenStats    → src/trader/cauldron/get_token_stats.mjs#fetchStatsRecords
//   - listPools        → src/trader/cauldron/list_pools.mjs (default pool shape)
//   - getBcmr          → src/trader/cauldron/get_bcmr.mjs#resolveBcmr
//   - prepareAndBuildSwap → src/trader/cauldron/check_and_swap.mjs#prepareAndBuildSwap
//   - broadcastTx      → src/trader/cauldron/check_and_swap.mjs#broadcastTx
//   - verifyTrade      → src/trader/cauldron/post_trade_check.mjs#verifyTrade
//
// `isReady()` is always true — the adapter assumes network access
// for every call. Failure modes are deferred to the per-call
// surface; the trader loop's call sites already log structured
// errors on fetch failures.

import { getPoolsAndMeta as cauldronGetPoolsAndMeta } from '../trader/cauldron/get_price.mjs';
import { fetchStatsRecords as cauldronFetchStatsRecords, _internals as getTokenStatsInternals } from '../trader/cauldron/get_token_stats.mjs';
import { listPoolsForToken as cauldronListPoolsForToken } from '../trader/cauldron/list_pools.mjs';
import { resolveBcmr as cauldronResolveBcmr } from '../trader/cauldron/get_bcmr.mjs';
import {
  prepareAndBuildSwap as cauldronPrepareAndBuildSwap,
  broadcastTx as cauldronBroadcastTx,
  PUBLIC_CONSTANTS,
} from '../trader/cauldron/check_and_swap.mjs';
import { verifyTrade as cauldronVerifyTrade } from '../trader/cauldron/post_trade_check.mjs';

/**
 * Build the live cauldron adapter.
 *
 * @param {object} [_config]   — cauldron takes no extra config today
 * @param {object} [_deps]     — cauldron takes no injected deps today
 * @returns {{
 *   id: string,
 *   displayName: string,
 *   safeMode: boolean,
 *   indexerUrl: string,
 *   isReady: () => Promise<boolean>,
 *   getPoolsAndMeta: (opts: object) => Promise<object>,
 *   getTokenStats: (opts: object) => Promise<object|null>,
 *   listPools: (opts: object) => Promise<object[]>,
 *   getBcmr: (opts: object) => Promise<object|null>,
 *   prepareAndBuildSwap: (opts: object) => Promise<object>,
 *   broadcastTx: (opts: object) => Promise<object>,
 *   verifyTrade: (opts: object) => Promise<object>,
 *   constants: object,
 * }}
 */
export function createCauldronAdapter(_config = {}, _deps = {}) {
  return Object.freeze({
    id: 'cauldron',
    displayName: 'Cauldron',
    safeMode: false,
    indexerUrl: getTokenStatsInternals.INDEXER_DISCOVERY,
    isReady: async () => true,
    getPoolsAndMeta: cauldronGetPoolsAndMeta,
    getTokenStats: async (opts = {}) => {
      const records = await cauldronFetchStatsRecords(opts);
      return records && records.length > 0 ? records[0] : null;
    },
    listPools: (opts = {}) => {
      const tokenId = opts && opts.tokenId;
      if (typeof tokenId !== 'string' || tokenId.length === 0) {
        return Promise.resolve([]);
      }
      return cauldronListPoolsForToken(tokenId, opts.limit ?? 10, opts);
    },
    getBcmr: cauldronResolveBcmr,
    prepareAndBuildSwap: cauldronPrepareAndBuildSwap,
    broadcastTx: cauldronBroadcastTx,
    verifyTrade: cauldronVerifyTrade,
    constants: PUBLIC_CONSTANTS,
  });
}
