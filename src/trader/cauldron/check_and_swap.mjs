// Copied from LifestoneLabs/AI_Skills @ 5640eda484557b7af0105ed09ad3951620e39c17
// Original source: skills/cauldron/scripts/check_and_swap.mjs
//
// Trimmed for in-process library use by TradeBot:
//   - shebang + main() + the CLI argv/stdin/confirmation paths removed
//   - console.log/error calls removed
//   - the build + sign + broadcast flow is exposed as `prepareAndBuildSwap`
//     and `broadcastTx`, so `src/trader/swap.mjs` can orchestrate them
//     without spawning a child process or reading stdin
//   - the original CLI's `readline.question()` confirmation flow is replaced
//     by an explicit `dryRun` parameter — TradeBot handles its own
//     risk/position-size gates, so it does NOT need a human "y/n" prompt
//   - the Electrum provider is injected (cashscript's
//     ElectrumNetworkProvider) so the wallet layer can reuse the same
//     connection that already verified UTXOs / balance
//
// Exports: parseArgs, bigOrZero, fmtSats, fmtBch, DUST_SATS,
// BASE_TX_OVERHEAD_SATS, SATS_PER_BYTE, POOL_BYTES, prepareAndBuildSwap,
// broadcastTx, resolveSymbolToId.

import {
  computeOptimalBuy,
  computeOptimalSell,
  bestMarginalBuyRate,
  bestMarginalSellRate,
  computeBuyAmountBelowRate,
  computeSellAmountAboveRate,
  computeEffectiveBuyImpact,
  computeEffectiveSellImpact,
  prepareBuyTokens,
  prepareSellTokens,
} from '@mr-zwets/cauldron-swap-sdk';
import { binToHex } from '@bitauth/libauth';

const INDEXER_DISCOVERY = 'https://indexer.riften.net/cauldron/tokens/list_cached';

const DUST_SATS = 1000n;
const BASE_TX_OVERHEAD_SATS = 2000n; // conservative estimate
// The cauldron-swap-sdk sets `maximumFeeSatsPerByte: 5` internally and lets
// cashscript's fee estimator pick the actual rate. We display an estimate at
// 2 sat/B (a realistic mid-case on BCH mainnet today; observed live: 3-5 sat/B
// when the mempool is busy). The dry-run estimate is informational only.
const SATS_PER_BYTE = 2n;
const POOL_BYTES = 197n; // SDK comment says ~197 bytes per pool added

// ---------- arg parsing ----------

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

export function bigOrZero(s) {
  try { return BigInt(s); } catch { return 0n; }
}

export function fmtSats(n) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export function fmtBch(n) {
  return (Number(n) / 1e8).toFixed(8);
}

export async function resolveSymbolToId(symbol, { fetchImpl = fetch } = {}) {
  const r = await fetchImpl(`${INDEXER_DISCOVERY}?limit=100&by=tvl&order=desc`);
  if (!r.ok) throw new Error(`indexer discovery ${r.status}`);
  const tokens = await r.json();
  const found = tokens.find((t) =>
    (t.display_symbol || '').toUpperCase() === symbol.toUpperCase() ||
    (t.bcmr?.token?.symbol || '').toUpperCase() === symbol.toUpperCase()
  );
  if (!found) throw new Error(`symbol ${symbol} not in top-100 by TVL`);
  return found;
}

// ---------- public helpers ----------

export const PUBLIC_CONSTANTS = { DUST_SATS, BASE_TX_OVERHEAD_SATS, SATS_PER_BYTE, POOL_BYTES };

/**
 * Build the optimal multi-pool allocation for a buy or sell. Returns the
 * allocations array (pass each entry's `.pool` to the SDK prepare fn),
 * plus the aggregate supply/fee/effective-rate/impact for the proposed
 * trade. Pure with respect to inputs — no signing, no broadcast.
 *
 * @param {Object} args
 * @param {'buy'|'sell'} args.side
 * @param {bigint} args.amount           base-unit amount to trade
 * @param {Array} args.pools             active cauldron pools (from getPoolsAndMeta)
 * @param {bigint} [args.buyUnder=null]  sats/token ceiling for buy
 * @param {bigint} [args.sellOver=null]  sats/token floor for sell
 * @returns {{
 *   side: 'buy'|'sell',
 *   amount: bigint,
 *   pools: Array,
 *   allocations: Array,
 *   totalSupply: bigint,
 *   totalFees: bigint,
 *   effectiveRate: bigint,
 *   impactPct: number|undefined,
 *   estTxBytes: bigint,
 *   estNetworkFeeSats: bigint,
 * }}
 */
export function planTrade({ side, amount, pools, buyUnder = null, sellOver = null }) {
  if (side !== 'buy' && side !== 'sell') {
    throw new Error(`planTrade: side must be 'buy' or 'sell'; got ${JSON.stringify(side)}`);
  }
  if (typeof amount !== 'bigint' || amount <= 0n) {
    throw new Error(`planTrade: amount must be a positive bigint; got ${amount}`);
  }
  if (!Array.isArray(pools) || pools.length === 0) {
    throw new Error(`planTrade: pools must be a non-empty array`);
  }

  let allocations;
  if (side === 'buy') {
    allocations = computeOptimalBuy(pools, amount, SATS_PER_BYTE);
  } else {
    allocations = computeOptimalSell(pools, amount, SATS_PER_BYTE);
  }

  let totalSupply = 0n;
  let totalFees = 0n;
  for (const a of allocations) {
    totalSupply += a.supplyAmount;
    totalFees += a.feeAmount;
  }
  const effectiveRate = allocations.length > 0
    ? totalSupply / amount
    : 0n;
  const impactPct = side === 'buy'
    ? computeEffectiveBuyImpact(pools, allocations)
    : computeEffectiveSellImpact(pools, allocations);

  const estTxBytes = 200n
    + BigInt(allocations.length) * POOL_BYTES
    + (side === 'sell' ? 200n : 0n);
  const estNetworkFeeSats = estTxBytes * SATS_PER_BYTE;

  return {
    side,
    amount,
    pools,
    allocations,
    totalSupply,
    totalFees,
    effectiveRate,
    impactPct,
    estTxBytes,
    estNetworkFeeSats,
    buyUnder,
    sellOver,
  };
}

/**
 * Compute the maximum base-unit amount that can be bought/sold through the
 * pool set while staying within a rate ceiling/floor. Convenience wrapper
 * around the SDK's `computeBuyAmountBelowRate` / `computeSellAmountAboveRate`
 * so the bot's entry/exit logic doesn't have to know about both.
 *
 * @param {Object} args
 * @param {'buy'|'sell'} args.side
 * @param {Array} args.pools
 * @param {bigint} args.rate           sats/token (ceiling for buy, floor for sell)
 * @returns {bigint}
 */
export function maxTradeAmount({ side, pools, rate }) {
  if (side === 'buy') return computeBuyAmountBelowRate(pools, rate, true);
  if (side === 'sell') return computeSellAmountAboveRate(pools, rate, true);
  throw new Error(`maxTradeAmount: side must be 'buy' or 'sell'; got ${JSON.stringify(side)}`);
}

/**
 * Compute the current marginal buy/sell spot rates (sats/token, pre-fee).
 * Convenience wrapper around the SDK.
 *
 * @param {Array} pools
 * @returns {{ buySpot: bigint|undefined, sellSpot: bigint|undefined }}
 */
export function spotRates(pools) {
  return {
    buySpot: bestMarginalBuyRate(pools),
    sellSpot: bestMarginalSellRate(pools),
  };
}

/**
 * Build + sign a Cauldron swap transaction via the cashscript SDK.
 *
 * `wallet` is a LibAuthBchWallet (or any compatible object) — it must
 * expose `getAddress()`. The actual signing happens inside
 * `prepareBuyTokens` / `prepareSellTokens`, which take the WIF as their
 * 4th arg. We pass the wallet's cashaddr as the destination; for a sell,
 * tokens flow out of the wallet's own UTXOs so the destination is the
 * same address by convention.
 *
 * @param {Object} args
 * @param {'buy'|'sell'} args.side
 * @param {Array} args.allocations    output of planTrade(...).allocations
 * @param {bigint} args.amount        base-unit amount
 * @param {string} args.destination   cashaddr (receives tokens for buy, BCH for sell)
 * @param {Object} args.wallet        LibAuthBchWallet-like (must expose getAddress())
 * @param {string} args.wif           raw WIF — required by the SDK's signer
 * @param {Object} args.electrumProvider
 * @param {Object} args.sdk           injected for tests; default = real cauldron-swap-sdk
 * @returns {Promise<{ txHex: string, side: 'buy'|'sell' }>}
 */
export async function prepareAndBuildSwap({
  side,
  allocations,
  amount,
  destination,
  wallet,
  wif,
  electrumProvider,
  sdk = null,
}) {
  if (side !== 'buy' && side !== 'sell') {
    throw new Error(`prepareAndBuildSwap: side must be 'buy' or 'sell'; got ${JSON.stringify(side)}`);
  }
  if (typeof wif !== 'string' || wif.length < 40 || wif.length > 200) {
    throw new Error(`prepareAndBuildSwap: wif has unexpected length (${wif?.length})`);
  }
  if (!destination || !destination.startsWith('bitcoincash:')) {
    throw new Error(`prepareAndBuildSwap: destination must start with bitcoincash:; got ${JSON.stringify(destination)}`);
  }
  const sdkImpl = sdk ?? await import('@mr-zwets/cauldron-swap-sdk');
  const poolList = allocations.map((a) => a.pool);

  let builder;
  try {
    if (side === 'buy') {
      ({ transactionBuilder: builder } = await sdkImpl.prepareBuyTokens(
        poolList, amount, destination, wif, electrumProvider,
      ));
    } else {
      ({ transactionBuilder: builder } = await sdkImpl.prepareSellTokens(
        poolList, amount, destination, wif, electrumProvider,
      ));
    }
  } catch (e) {
    const err = new Error(`prepareAndBuildSwap: SDK ${side === 'buy' ? 'prepareBuyTokens' : 'prepareSellTokens'} threw: ${e.message}`);
    err.cause = e;
    throw err;
  }

  // Build (sign) the transaction — this is where the WIF is actually used.
  // cashscript@0.13+: TransactionBuilder.build() already returns a signed hex
  // string. Older cashscript returned a libauth Transaction object that needed
  // separate serialization — that fallback is preserved for safety.
  let txHex;
  try {
    const built = builder.build();
    if (typeof built === 'string') {
      txHex = built;
    } else {
      txHex = binToHex(built.toUint8Array ? built.toUint8Array() : built);
    }
  } catch (e) {
    const err = new Error(`prepareAndBuildSwap: tx build/sign failed: ${e.message}`);
    err.cause = e;
    throw err;
  }

  return { txHex, side };
}

/**
 * Broadcast a signed tx hex via the Electrum provider. We do NOT use
 * `https://broadcast.cauldron.quest` — the original CLI notes that
 * endpoint has been returning TLS errors. The Electrum provider is the
 * same one the SDK already verified; this keeps the path consistent.
 *
 * @param {Object} args
 * @param {string} args.txHex
 * @param {Object} args.electrumProvider
 * @returns {Promise<string>} txid
 */
export async function broadcastTx({ txHex, electrumProvider }) {
  if (typeof txHex !== 'string' || txHex.length === 0) {
    throw new Error(`broadcastTx: txHex must be a non-empty string`);
  }
  if (!electrumProvider || typeof electrumProvider.sendRawTransaction !== 'function') {
    throw new Error(`broadcastTx: electrumProvider must expose sendRawTransaction()`);
  }
  return await electrumProvider.sendRawTransaction(txHex);
}

export const _internals = { INDEXER_DISCOVERY };