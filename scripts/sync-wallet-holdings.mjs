#!/usr/bin/env node
// scripts/sync-wallet-holdings.mjs
//
// T27e: Reconcile the bot's positions store with the wallet's
// actual on-chain state. Runs after a manual trade (or any time a
// position could exist on-chain without being recorded), scans the
// wallet's UTXO set for fungible-token (FT) outputs, and opens or
// closes positions in `data/positions.json` to match.
//
// Use cases:
//   - After `scripts/manual-test-trade.mjs` (which bypasses
//     positions.open / positions.close by design — that script is
//     a pipeline smoke-test, not a bot-driven trade).
//   - After any third-party spend that moves tokens in/out of the
//     wallet without going through the trading loop.
//
// SAFETY:
//   - Read-only against the chain (no broadcasts).
//   - Writes to `data/positions.json` ONLY for tokens that have
//     on-chain UTXOs at the wallet — i.e. you can't accidentally
//     invent positions. The bot's existing positions are preserved
//     (only ADDED to, never modified in-place unless the on-chain
//     state explicitly demands it).
//   - Idempotent: running twice produces the same positions store.
//
// Output: structured summary on stdout + structured logs on stderr.

import process from 'node:process';

import { ElectrumNetworkProvider } from 'cashscript';

import { loadConfig } from '../src/util/config-loader.mjs';
import { createLogger } from '../src/util/logger.mjs';
import { Positions } from '../src/portfolio/positions.mjs';
import { LibAuthBchWallet, walletConfigFrom } from '../src/wallet/libauth.mjs';

const log = createLogger({ sink: process.stderr, component: 'sync-holdings' });

// T27e: exported so tests/scripts.test.mjs can cover the parser in isolation
// (no UTXO traversal, no WIF exposure). The script body uses the default
// `process.argv`; tests pass a synthetic argv in.
export function parseSyncWalletHoldingsArgs(argv) {
  const flags = {};
  // `argv.slice(2)` matches parseRunBotArgs/parseInitArgs/parseSnapshotArgs:
  // skip the implicit `node` + script-path entries so callers can pass
  // either a full `process.argv` (script body) or a synthetic argv
  // like `['node', 'sync-wallet-holdings.mjs', '--dry-run']` (tests).
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a !== 'string' || a === '--') continue;
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq >= 0) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      flags[a.slice(2)] = true;
    }
  }
  return flags;
}

const SYNC_FLAGS = parseSyncWalletHoldingsArgs(process.argv);

// T27e: only run when invoked directly — when imported by
// tests/scripts.test.mjs the body is skipped so the test suite
// can pull `parseSyncWalletHoldingsArgs` without the script
// trying to talk to Electrum / mutate positions.json.
const isDirect = import.meta.url === `file://${process.argv[1]}` ||
                 process.argv[1]?.endsWith('sync-wallet-holdings.mjs');

// Shape-parity `main` for tests; ESM requires `export` at top
// level, so we always declare it and the body short-circuits
// when the script is imported (not directly invoked).
async function syncWalletHoldingsMain() { return { ok: false, error: 'not_direct_invocation' }; }
export { syncWalletHoldingsMain as main };

if (!isDirect) {
  log.info('sync.imported-skip', { reason: 'not_direct_invocation' });
}
if (isDirect) {
  log.info('sync.boot', { flags: SYNC_FLAGS });

const cfg = await loadConfig();
const userCfg = (cfg.user?.wallet && typeof cfg.user.wallet === 'object') ? cfg.user.wallet : {};
const wif = userCfg.wif ?? null;
if (!wif) {
  log.error('sync.no-wif');
  process.exit(2);
}
const walletCfg = walletConfigFrom(cfg);
const wallet = new LibAuthBchWallet({ cfg: walletCfg, wif, logger: log.child('wallet') });
await wallet.init();
const walletAddr = wallet.getAddress();
log.info('sync.wallet', { address: walletAddr, network: walletCfg.network });

const ds = (cfg.data_sources ?? {});
const provider = new ElectrumNetworkProvider(walletCfg.network || 'mainnet', {
  hostname: ds.electrum_host ?? 'electrum.imaginary.cash',
  port: Number(ds.electrum_port) || 50004,
  protocol: 'tls',
});

// Scan wallet for fungible-token UTXOs.
const utxos = await provider.getUtxos(walletAddr);
const bchUtxos = utxos.filter((u) => !u.token);
const ftUtxos = utxos.filter((u) => !!u.token);
const liveBchSats = bchUtxos.reduce(
  (s, u) => s + (typeof u.satoshis === 'bigint' ? u.satoshis : BigInt(u.satoshis)),
  0n,
);
log.info('sync.scan', {
  total_utxos: utxos.length,
  bch_utxos: bchUtxos.length,
  bch_balance_sats: liveBchSats.toString(),
  ft_utxos: ftUtxos.length,
});

// Aggregate fungible-token UTXOs by category (a single token can
// have multiple UTXOs; the bot's positions store treats each token
// as a single position, so we merge here).
const byCategory = new Map();
for (const u of ftUtxos) {
  const cat = String(u.token.category ?? '').toLowerCase();
  if (cat.length === 0) continue;
  const amt = (typeof u.token.amount === 'bigint') ? u.token.amount : BigInt(u.token.amount ?? 0);
  if (!byCategory.has(cat)) {
    byCategory.set(cat, { category: cat, total_amount: 0n, utxo_count: 0, utxos: [] });
  }
  const e = byCategory.get(cat);
  e.total_amount += amt;
  e.utxo_count += 1;
  e.utxos.push({ txid: u.txid, vout: u.vout, amount: amt.toString() });
}
log.info('sync.tokens', {
  category_count: byCategory.size,
  tokens: [...byCategory.values()].map((t) => ({
    category: t.category.slice(0, 16) + '…',
    total_amount: t.total_amount.toString(),
    utxos: t.utxo_count,
  })),
});

// Reconcile with positions store.
const positions = new Positions({
  file: cfg.paths?.positions_file ?? 'data/positions.json',
  logger: log.child('positions'),
});
await positions.load();
const openBefore = await positions.list('open');

const actions = [];
// 1. For each token with on-chain balance, ensure an open position
//    exists. If not, open one with a synthetic ID + a "synced"
//    reasoning field so the operator knows this came from a chain
//    scan, not a bot-driven entry.
for (const t of byCategory.values()) {
  const existing = openBefore.find((p) => p.token_id === t.category);
  if (existing) {
    actions.push({ kind: 'kept', token_id: t.category, position_id: existing.id });
    continue;
  }
  // Pull current spot price from the indexer so the position has
  // a sane `entry price` for PnL math. Fallback to 0 if the indexer
  // is unreachable.
  let spotPriceSatsPerToken = 0;
  try {
    const indexerBase = (cfg.data_sources?.cauldron_indexer_base_url) ?? 'https://indexer.riften.net/cauldron';
    const r = await fetch(`${indexerBase}/tokens/list_cached?limit=1&by=tvl&order=desc`);
    if (r.ok) {
      const list = await r.json();
      const found = Array.isArray(list) ? list.find((x) => String(x.token_id ?? '').toLowerCase() === t.category) : null;
      if (found && Number.isFinite(found.price_now)) {
        // price_now is sats per display unit. We don't know the
        // decimals here, so take the spot as-is; the operator can
        // correct it via the bot's normal flow if it deviates.
        spotPriceSatsPerToken = Math.round(found.price_now);
      }
    }
  } catch (_) { /* soft-fail — leave price at 0 */ }

  // Conservative bch_spent estimate: total_amount × spot. This is
  // a SYNTHETIC entry so the PnL math has something to chew on.
  const bchSpentSats = (spotPriceSatsPerToken > 0 && t.total_amount > 0n)
    ? Number((t.total_amount * BigInt(spotPriceSatsPerToken)) / 100_000_000n)
    : 0;

  const id = `sync-${t.category.slice(0, 8)}-${Date.now().toString(36)}`;
  const position = await positions.open({
    tokenId: t.category,
    tokenSymbol: null,
    entry: {
      txid: t.utxos[0]?.txid ?? '',
      price_sats_per_token: spotPriceSatsPerToken,
      bch_spent_sats: bchSpentSats,
      token_amount_base: t.total_amount.toString(),
      fee_sats: 0,
      broadcast_ms: 0,
      ts: new Date().toISOString(),
      slippage_bps: null,
      source: 'on-chain-sync',
    },
    reasoning: {
      ts: new Date().toISOString(),
      token_id: t.category,
      rank: null,
      score: null,
      reason: `Synced from on-chain state via scripts/sync-wallet-holdings.mjs. UTXO count: ${t.utxo_count}; total amount: ${t.total_amount.toString()}. No bot-driven entry — the bot will take over from this point.`,
      decision: 'synced',
      kind: 'chain-sync',
      candidate: null,
      cfg: null,
    },
    initialStatus: 'open',
    id, // Override the auto-generated id with our deterministic one.
  });
  actions.push({
    kind: 'opened',
    token_id: t.category,
    position_id: position.id,
    token_amount_base: t.total_amount.toString(),
    bch_spent_sats: bchSpentSats,
  });
  log.info('sync.position-opened', {
    token_id: t.category,
    position_id: position.id,
    amount: t.total_amount.toString(),
    spot_price_sats_per_token: spotPriceSatsPerToken,
  });
}

// 2. For each existing open position with NO on-chain UTXO backing,
//    leave it alone (the bot may have a temporary negative UTXO set
//    during a swap exit). We deliberately do NOT auto-close — closing
//    is a wallet-impacting decision the operator should make.

const summary = {
  ok: true,
  wallet: walletAddr,
  live_bch_sats: liveBchSats.toString(),
  live_bch_bch: Number(liveBchSats) / 1e8,
  ft_categories: [...byCategory.values()].map((t) => ({
    token_id: t.category,
    total_amount: t.total_amount.toString(),
    utxo_count: t.utxo_count,
  })),
  actions,
  positions_file: positions.file,
};
process.stdout.write(JSON.stringify(summary, null, 2) + '\n');

try { await wallet.close(); } catch (_) { /* noop */ }
process.exit(0);
}
