// Copied from LifestoneLabs/AI_Skills @ 5640eda484557b7af0105ed09ad3951620e39c17
// Original source: skills/cauldron/scripts/post_trade_check.mjs
//
// Trimmed for in-process library use by TradeBot:
//   - shebang + main() + the CLI usage / exit-code paths removed
//   - console.log/error calls removed
//   - the Electrum provider is injected (`electrumProvider`) so swap.mjs
//     can call `verifyTrade` against the same provider it just used to
//     broadcast — no second TCP connection
//   - fetchImpl is injected for indexer lookups
//
// Exports: parseArgs, bigOrZero, fmtSats, fmtPct, TXID_RE, OUTPOINT_RE,
// INDEXER_DISCOVERY, DEVIATION_WARN_PCT_DEFAULT, bytecodeToAddress,
// decodeRawTx, findPoolInputs, fetchActivePools, verifyTrade.

import { decodeTransaction, hexToBin, lockingBytecodeToCashAddress, binToHex } from '@bitauth/libauth';

export const INDEXER_DISCOVERY = 'https://indexer.riften.net/cauldron/tokens/list_cached';
export const DEVIATION_WARN_PCT_DEFAULT = 5;

export const TXID_RE = /^[0-9a-fA-F]{64}$/;
export const OUTPOINT_RE = /^([0-9a-fA-F]{64}):(\d+)$/;

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

export function fmtPct(f) {
  if (f === undefined || f === null || !Number.isFinite(f)) return 'n/a';
  return `${(f * 100).toFixed(4)}%`;
}

// ---------- network ----------

export async function resolveSymbolToId(symbol, { fetchImpl = fetch } = {}) {
  const r = await fetchImpl(`${INDEXER_DISCOVERY}?limit=100&by=tvl&order=desc`);
  if (!r.ok) throw new Error(`indexer discovery ${r.status}`);
  const tokens = await r.json();
  const upper = symbol.toUpperCase();
  const found = tokens.find((t) =>
    (t.display_symbol || '').toUpperCase() === upper ||
    (t.bcmr?.token?.symbol || '').toUpperCase() === upper,
  );
  if (!found) {
    throw new Error(`Token with symbol "${symbol}" not found in top-100 by TVL.`);
  }
  return found;
}

// Fetch active pools for the given token_id from the indexer. Uses the same
// SDK endpoint that ships with `get_price.mjs`.
export async function fetchActivePools(tokenId, { network = 'mainnet', fetchImpl = fetch } = {}) {
  // Dynamic import — keeps this file's load cost tiny for tests that don't
  // touch the SDK.
  const sdk = await import('@mr-zwets/cauldron-swap-sdk');
  const url = `${sdk.CAULDRON_INDEXER_URLS[network]}/pool/active?token=${tokenId}`;
  const r = await fetchImpl(url);
  if (!r.ok) throw new Error(`indexer ${r.status} for token=${tokenId}`);
  const data = await r.json();
  return data.active || [];
}

// Convert a locking bytecode to its cashaddr (best-effort; returns 'unknown'
// when the bytecode doesn't match a standard pattern).
export function bytecodeToAddress(bytecode, prefix) {
  // CashTokens-aware flag — true lets the encoder pick p2pkhWithTokens /
  // p2shWithTokens when applicable, which is the correct version byte for
  // any output that originally held (or might receive) CashTokens.
  const result = lockingBytecodeToCashAddress({
    bytecode,
    prefix,
    tokenSupport: true,
  });
  if (typeof result === 'string') return 'unknown';
  return result.address;
}

// Decode the raw tx; throw on libauth error.
export function decodeRawTx(hex) {
  const tx = decodeTransaction(hexToBin(hex));
  if (typeof tx === 'string') throw new Error(`decodeTransaction: ${tx}`);
  return tx;
}

// Find the pool input(s) by matching input outpoints against the active pool list.
// Returns [{ inputIndex, pool }] or [].
export function findPoolInputs({ tx, pools, expectedPoolInput }) {
  const out = [];
  if (expectedPoolInput) {
    const m = OUTPOINT_RE.exec(expectedPoolInput);
    if (!m) {
      throw { __usage: true, message: `--expected-pool-input must be '<64hex>:<vout>': ${expectedPoolInput}` };
    }
    const wantTxid = m[1].toLowerCase();
    const wantVout = Number(m[2]);
    const poolMap = new Map();
    for (const pool of pools) {
      poolMap.set(`${pool.txid.toLowerCase()}:${pool.tx_pos}`, pool);
    }
    for (let i = 0; i < tx.inputs.length; i++) {
      const inp = tx.inputs[i];
      const inpTxid = binToHex(inp.outpointTransactionHash).toLowerCase();
      if (inpTxid === wantTxid && inp.outpointIndex === wantVout) {
        const pool = poolMap.get(`${wantTxid}:${wantVout}`) || null;
        out.push({ inputIndex: i, pool });
      }
    }
    return out;
  }
  const poolMap = new Map();
  for (const pool of pools) {
    poolMap.set(`${pool.txid.toLowerCase()}:${pool.tx_pos}`, pool);
  }
  for (let i = 0; i < tx.inputs.length; i++) {
    const inp = tx.inputs[i];
    const inpTxid = binToHex(inp.outpointTransactionHash).toLowerCase();
    const key = `${inpTxid}:${inp.outpointIndex}`;
    const pool = poolMap.get(key);
    if (pool) out.push({ inputIndex: i, pool });
  }
  return out;
}

// ---------- top-level helper ----------

/**
 * Verify a freshly-broadcast Cauldron swap against the expected effective
 * rate. Returns `{ ok, kind, txid, rates, maxAbsDeviationPct, verdict, ... }`.
 *
 * The bot calls this right after broadcasting, on the same Electrum
 * provider instance it just used, so no second TCP connection is opened.
 *
 * @param {Object} args
 * @param {string} args.txid
 * @param {string} [args.tokenId]
 * @param {string} [args.expectedPoolInput]   `<txid>:<vout>`
 * @param {bigint} [args.expectedEffectiveRate]
 * @param {string} [args.userAddress]
 * @param {number} [args.deviationWarnPct=0.05]
 * @param {Object} args.electrumProvider
 * @param {(url: string, init?: any) => Promise<any>} [args.fetchImpl=fetch]
 * @param {'mainnet'|'chipnet'} [args.network='mainnet']
 * @returns {Promise<{
 *   ok: boolean,
 *   kind: string,
 *   txid: string,
 *   network: string,
 *   tokenId: string|null,
 *   poolInputs: Array<{ inputIndex: number, outpoint: string, pool: any }>,
 *   rates: Array<{ inputIndex: number, side: 'buy'|'sell', effectiveRate: bigint, dSats: number, dTokens: number }>,
 *   maxAbsDeviationPct: number|null,
 *   verdict: string,
 * }>}
 */
export async function verifyTrade({
  txid,
  tokenId = null,
  expectedPoolInput = null,
  expectedEffectiveRate = null,
  userAddress = null,
  deviationWarnPct = DEVIATION_WARN_PCT_DEFAULT / 100,
  electrumProvider,
  fetchImpl = fetch,
  network = 'mainnet',
}) {
  if (typeof txid !== 'string' || !TXID_RE.test(txid)) {
    throw new Error(`verifyTrade: txid must be 64 lowercase hex; got ${JSON.stringify(txid)}`);
  }
  const txidLower = txid.toLowerCase();
  const prefix = network === 'chipnet' ? 'bchtest' : 'bitcoincash';

  const txHex = await electrumProvider.getRawTransaction(txidLower);
  const tx = decodeRawTx(txHex);

  const outputs = tx.outputs.map((o) => ({
    index: undefined,
    value: typeof o.valueSatoshis === "bigint" ? o.valueSatoshis : BigInt(o.valueSatoshis),
    token: o.token && o.token.amount !== undefined ? {
      category: binToHex(o.token.category),
      amount: typeof o.token.amount === 'bigint' ? o.token.amount : BigInt(o.token.amount),
      nft: o.token.nft ? {
        capability: o.token.nft.capability,
        commitment: binToHex(o.token.nft.commitment),
      } : undefined,
    } : null,
    address: bytecodeToAddress(o.lockingBytecode, prefix),
  })).map((o, i) => ({ ...o, index: i }));

  const inputs = tx.inputs.map((inp, i) => ({
    index: i,
    outpointTxid: binToHex(inp.outpointTransactionHash).toLowerCase(),
    outpointIndex: inp.outpointIndex,
    sequenceNumber: Number(inp.sequenceNumber),
  }));

  let pools = [];
  if (tokenId) {
    pools = await fetchActivePools(tokenId, { network, fetchImpl });
  }
  const poolMatches = findPoolInputs({ tx, pools, expectedPoolInput });

  let verdict = 'ok';
  if (poolMatches.length === 0) {
    return {
      ok: false,
      kind: 'no_pool_input_detected',
      txid: txidLower,
      network,
      tokenId,
      poolInputs: [],
      rates: [],
      maxAbsDeviationPct: null,
      verdict: 'no_pool_input_detected',
      inputs,
      outputs,
    };
  }

  const rateRows = [];
  let anyPoolHasPreState = false;
  for (const m of poolMatches) {
    const o = outputs[m.inputIndex];
    if (!m.pool) continue;
    anyPoolHasPreState = true;
    const preSats = m.pool.sats;
    const preTokens = m.pool.tokens;
    const postSats = Number(o.value);
    const postTokens = Number(o.token ? o.token.amount : 0n);
    const dSats = postSats - preSats;
    const dTokens = postTokens - preTokens;
    if (dTokens === 0) continue;
    const userSideSats = Math.abs(dSats);
    const userSideTokens = Math.abs(dTokens);
    const effectiveRate = userSideTokens > 0 ? BigInt(Math.floor(userSideSats / userSideTokens)) : 0n;
    const side = dSats > 0 ? 'buy' : 'sell';
    rateRows.push({
      inputIndex: m.inputIndex,
      side,
      poolTxid: m.pool.txid,
      poolTxPos: m.pool.tx_pos,
      preSats, postSats, dSats,
      preTokens, postTokens, dTokens,
      effectiveRate,
    });
  }

  let maxAbsDev = 0;
  if (expectedEffectiveRate !== null && expectedEffectiveRate > 0n && rateRows.length > 0) {
    for (const r of rateRows) {
      const dr = Number(r.effectiveRate) - Number(expectedEffectiveRate);
      const devPct = Math.abs(dr) / Number(expectedEffectiveRate);
      if (devPct > maxAbsDev) maxAbsDev = devPct;
      if (devPct > deviationWarnPct) verdict = 'deviation_exceeded';
    }
  }

  return {
    ok: verdict === 'ok',
    kind: verdict,
    txid: txidLower,
    network,
    tokenId,
    poolInputs: poolMatches.map((m) => ({
      inputIndex: m.inputIndex,
      outpoint: `${inputs[m.inputIndex].outpointTxid}:${inputs[m.inputIndex].outpointIndex}`,
      pool: m.pool ? {
        txid: m.pool.txid,
        tx_pos: m.pool.tx_pos,
        sats: m.pool.sats,
        tokens: m.pool.tokens,
        owner_pkh: m.pool.owner_pkh,
      } : null,
    })),
    rates: rateRows,
    maxAbsDeviationPct: Number.isFinite(maxAbsDev) ? maxAbsDev : null,
    verdict,
    inputs,
    outputs,
  };
}