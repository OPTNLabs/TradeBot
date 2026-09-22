// Copied from LifestoneLabs/AI_Skills @ 5640eda484557b7af0105ed09ad3951620e39c17
// Original source: skills/cauldron/scripts/get_price.mjs
//
// Trimmed for in-process library use by TradeBot:
//   - shebang + main() + the CLI argv/stdout paths removed
//   - the indexer + symbol-resolution helpers are still exported (via
//     `getPoolsAndMeta`) so swap.mjs / the scoring engine can reuse them
//   - console.log calls removed
//
// Exports: parseArgs, fmtSats, effectiveBuyRate, effectiveSellRate,
// sumPoolReserves, LP_FEE_BPS, resolveSymbolToId, getPoolsAndMeta.

import {
  getCauldronPools,
  bestMarginalBuyRate,
  bestMarginalSellRate,
} from '@mr-zwets/cauldron-swap-sdk';

const INDEXER_DISCOVERY = 'https://indexer.riften.net/cauldron/tokens/list_cached';

// Cauldron's constant-product AMM charges a flat 0.3% LP fee on the trade
// value. For a marginal rate `m` (sats per token at the cheapest/richest
// pool, pre-fee), the user pays `m * 1000 / 997` for a buy (round UP from
// the LP's perspective — user pays MORE sats per token) and receives
// `m * 997 / 1000` for a sell (round DOWN — user receives FEWER sats per
// token). The `1000/997` and `997/1000` are the canonical AMM fee-math
// pair; they preserve the invariant `(1000 - 997) / 1000 = 0.003 = 0.3%`.
export const LP_FEE_BPS = 30; // 0.3% in basis points

export function effectiveBuyRate(marginalRateSats) {
  if (marginalRateSats === undefined || marginalRateSats === null) return undefined;
  return marginalRateSats * 1000 / 997;  // user pays more sats per token
}

export function effectiveSellRate(marginalRateSats) {
  if (marginalRateSats === undefined || marginalRateSats === null) return undefined;
  return marginalRateSats * 997 / 1000;  // user receives fewer sats per token
}

// Aggregate the reserves across all pools for a token. Returns
// `{ sats, tokens }` as BigInt. Pure (no I/O) — caller must pass the pool array.
export function sumPoolReserves(pools) {
  let sats = 0n;
  let tokens = 0n;
  for (const p of pools) {
    sats += BigInt(p.sats);
    tokens += BigInt(p.tokens);
  }
  return { sats, tokens };
}

export function parseArgs(argv) {
  const out = { positional: [], flags: {} };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq >= 0) out.flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      else out.flags[arg.slice(2)] = true;
    } else {
      out.positional.push(arg);
    }
  }
  return out;
}

export async function resolveSymbolToId(symbol, { fetchImpl = fetch } = {}) {
  const upper = symbol.toUpperCase();
  // Fetch a generous slice, then look for an exact symbol match.
  const r = await fetchImpl(`${INDEXER_DISCOVERY}?limit=100&by=tvl&order=desc`);
  if (!r.ok) throw new Error(`indexer ${r.status}`);
  const tokens = await r.json();
  const found = tokens.find((t) =>
    (t.display_symbol || '').toUpperCase() === upper ||
    (t.bcmr?.token?.symbol || '').toUpperCase() === upper,
  );
  if (!found) {
    throw new Error(`Token with symbol "${symbol}" not found in top-100 by TVL. Pass --token-id=<hex> instead.`);
  }
  return found;
}

export function fmtSats(n) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/**
 * One-call helper used by swap.mjs and the scoring engine:
 *   - resolves symbol → token_id if needed
 *   - fetches the active pool list
 *   - fetches the indexer's rich metadata record (best-effort)
 *   - returns the marginal + effective rates + aggregated reserves
 *
 * @param {Object} opts
 * @param {string} [opts.tokenId]
 * @param {string} [opts.symbol]
 * @param {(url: string, init?: any) => Promise<any>} [opts.fetchImpl=fetch]
 * @returns {Promise<{
 *   tokenId: string,
 *   pools: any[],
 *   tokenMeta: any|null,
 *   buySpot: bigint,
 *   sellSpot: bigint,
 *   effectiveBuy: bigint,
 *   effectiveSell: bigint,
 *   totalSats: bigint,
 *   totalTokens: bigint,
 * }>}
 */
export async function getPoolsAndMeta({ tokenId, symbol, fetchImpl = fetch } = {}) {
  if (!tokenId && !symbol) {
    throw new Error('getPoolsAndMeta: pass either tokenId or symbol');
  }
  let tokenMeta = null;
  if (!tokenId && symbol) {
    tokenMeta = await resolveSymbolToId(symbol, { fetchImpl });
    tokenId = tokenMeta.token_id;
  }
  const pools = await getCauldronPools(tokenId);
  if (pools.length === 0) {
    throw new Error(`No active Cauldron pools for token_id=${tokenId}`);
  }
  const buySpot = bestMarginalBuyRate(pools);
  const sellSpot = bestMarginalSellRate(pools);
  const effectiveBuy = effectiveBuyRate(buySpot);
  const effectiveSell = effectiveSellRate(sellSpot);
  const { sats: totalSats, tokens: totalTokens } = sumPoolReserves(pools);
  return {
    tokenId,
    pools,
    tokenMeta,
    buySpot,
    sellSpot,
    effectiveBuy,
    effectiveSell,
    totalSats,
    totalTokens,
  };
}

export const _internals = { INDEXER_DISCOVERY };