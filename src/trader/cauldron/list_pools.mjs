// Copied from LifestoneLabs/AI_Skills @ 5640eda484557b7af0105ed09ad3951620e39c17
// Original source: skills/cauldron/scripts/list_pools.mjs
//
// Trimmed for in-process library use by TradeBot:
//   - shebang removed
//   - main() + the CLI argv/stdout paths removed (the bot calls the pure
//     helpers directly; the CLI surface is not useful from a loop)
//   - module-level INDEXER_DISCOVERY + POOL_ENDPOINT constants preserved
//
// The remaining exports (parseArgs, fmtSats, fmtPct, fmtUsd,
// poolSortBySpotRate) are all pure. The I/O helpers (listTopTokens,
// listPoolsForToken) are kept and exported so the scoring engine can call
// them via dependency injection.

import { getCauldronPools } from '@mr-zwets/cauldron-swap-sdk';

const INDEXER_DISCOVERY = 'https://indexer.riften.net/cauldron/tokens/list_cached';
const POOL_ENDPOINT = (tokenId) =>
  `https://indexer.cauldron.quest/cauldron/pool/active?token=${encodeURIComponent(tokenId)}`;

export function parseArgs(argv) {
  const out = { positional: [], flags: {} };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq >= 0) {
        out.flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        out.flags[arg.slice(2)] = true;
      }
    } else {
      out.positional.push(arg);
    }
  }
  return out;
}

export function fmtSats(n) {
  return Number(n).toLocaleString('en-US');
}

export function fmtPct(bp) {
  return `${(Number(bp) / 100).toFixed(2)}%`;
}

export function fmtUsd(usd) {
  const v = Number(usd);
  if (v < 0.0001) return `$${v.toExponential(2)}`;
  if (v < 1) return `$${v.toFixed(6)}`;
  return `$${v.toFixed(2)}`;
}

// Spot-buy-rate comparator: cheapest pool first. A pool's spot-buy rate is
// `sats / tokens` — lower rate = token is cheaper in BCH terms = better
// spot-buy. Pure: no I/O, only the two pool objects are read.
export function poolSortBySpotRate(a, b) {
  const ra = a.tokens > 0 ? a.sats / a.tokens : Infinity;
  const rb = b.tokens > 0 ? b.sats / b.tokens : Infinity;
  return ra - rb;
}

export async function listTopTokens({ by = 'tvl', order = 'desc', limit = 10, fetchImpl = fetch }) {
  const url = `${INDEXER_DISCOVERY}?limit=${limit}&by=${by}&order=${order}`;
  const r = await fetchImpl(url);
  if (!r.ok) throw new Error(`indexer ${r.status}: ${await r.text()}`);
  const tokens = await r.json();
  return tokens;
}

export async function listPoolsForToken(tokenId, limit, { sdkFetch = getCauldronPools } = {}) {
  const pools = await sdkFetch(tokenId);
  // Sort by sats-per-token (cheapest pool first = best spot buy rate)
  pools.sort(poolSortBySpotRate);
  return pools.slice(0, limit || pools.length);
}

export const _internals = { INDEXER_DISCOVERY, POOL_ENDPOINT };