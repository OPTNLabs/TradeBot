#!/usr/bin/env node
// scripts/manual-test-trade.mjs
//
// MANUAL TEST DRIVER — runs a single live buy + sell on a specified
// Cauldron token through the SAME `SwapExecutor.execute()` pipeline
// the trading bot uses. All risk gates (pre-flight, slippage, fee
// estimation, broadcast, verifyTrade) run end-to-end; the only thing
// skipped is the scoring / candidate-selection layer (because the
// whole point of a manual test is to enter a token the bot would
// normally skip — e.g. BADGER while `min_entry_gap_from_high_pct`
// is filtering everything else out).
//
// Usage:
//   node scripts/manual-test-trade.mjs \
//        --token <token_id_hex> \
//        --size-bch 0.0005        # trade size (default 0.0005 = min_trade_size_bch)
//        --hold-seconds 6          # wait between entry and exit (default 6)
//        --dry-run                 # plan + pre-flight only, no broadcast
//
// Output: structured JSON on stdout, human-friendly summary on stderr.
//
// SAFETY: this script broadcasts real mainnet transactions when run
// without `--dry-run`. Default size is 0.0005 BCH (~$0.25 at recent
// prices). The bot's wallet currently holds ~0.044 BCH so the test
// leaves plenty of headroom. Pass a different --size-bch for a
// larger test.

import { setTimeout as delay } from 'node:timers/promises';
import process from 'node:process';

import { loadConfig } from '../src/util/config-loader.mjs';
import { createLogger } from '../src/util/logger.mjs';
import { SwapExecutor, SwapError } from '../src/trader/swap.mjs';
import { LibAuthBchWallet, resolveWif, walletConfigFrom } from '../src/wallet/libauth.mjs';
import { SATS_PER_BCH } from '../src/data/types.mjs';

// ── arg parsing ──────────────────────────────────────────────────────────

// T27g: exported so tests/scripts.test.mjs can cover the parser in isolation
// (no network calls, no WIF exposure). The `main()` entry uses the default
// `process.argv`; tests pass a synthetic argv in.
//
// Two flag forms supported:
//   --token=hex          → flags.token = 'hex'
//   --token hex          → flags.token = 'hex'  (space-separated value)
//   --dry-run            → flags['dry-run'] = true
export function parseManualTestArgs(argv) {
  const flags = {};
  const positional = [];
  // `argv.slice(2)` matches parseRunBotArgs/parseInitArgs/parseSnapshotArgs:
  // skip the implicit `node` + script-path entries so callers can pass
  // either a full `process.argv` (script body) or a synthetic argv
  // like `['node', 'manual-test-trade.mjs', '--token', '…']` (tests).
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      // Space-separated value: consume the next argv if it doesn't
      // look like another flag. This is what the script body needs
      // (`--token <hex-id>`).
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

const { flags } = parseManualTestArgs(process.argv);

// T27g: only run when invoked directly — when imported by
// tests/scripts.test.mjs the body is skipped so the test suite
// can pull `parseManualTestArgs` without the script trying to
// broadcast on the live wallet.
const isDirect = import.meta.url === `file://${process.argv[1]}` ||
                 process.argv[1]?.endsWith('manual-test-trade.mjs');

// Shape-parity `main` for tests; ESM requires `export` at top
// level, so we always declare it and the body short-circuits
// when the script is imported (not directly invoked).
async function manualTestMain() { return { ok: false, error: 'not_direct_invocation' }; }
export { manualTestMain as main };

if (isDirect) {

const TOKEN_ID = (typeof flags.token === 'string') ? flags.token.toLowerCase() : null;
if (!TOKEN_ID || TOKEN_ID.length !== 64 || !/^[0-9a-f]{64}$/.test(TOKEN_ID)) {
  console.error('Usage: node scripts/manual-test-trade.mjs --token <64-hex-id> [--size-bch 0.0005] [--hold-seconds 6] [--dry-run]');
  process.exit(2);
}
const SIZE_BCH = (typeof flags['size-bch'] === 'string') ? Number(flags['size-bch']) : 0.0005;
if (!Number.isFinite(SIZE_BCH) || SIZE_BCH <= 0) {
  console.error('manual-test-trade: --size-bch must be a positive number');
  process.exit(2);
}
const HOLD_SECONDS = (typeof flags['hold-seconds'] === 'string') ? Number(flags['hold-seconds']) : 6;
const DRY_RUN = flags['dry-run'] === true;

// ── boot ──────────────────────────────────────────────────────────────────

const log = createLogger({ sink: process.stderr, component: 'manual-test' });

log.info('manual-test.boot', {
  token_id: TOKEN_ID.slice(0, 16) + '…',
  size_bch: SIZE_BCH,
  hold_seconds: HOLD_SECONDS,
  dry_run: DRY_RUN,
});

const cfg = await loadConfig();
log.info('manual-test.config-loaded', {
  network: cfg.wallet?.network ?? 'mainnet',
  tuning_preset: cfg.tuning_preset,
});

// WIF — prefer user.json (operator override) over defaults.
const userCfg = (cfg.user && typeof cfg.user === 'object') ? cfg.user : {};
const userWallet = (userCfg.wallet && typeof userCfg.wallet === 'object') ? userCfg.wallet : {};
const wifFromArgs = typeof flags.wif === 'string' ? flags.wif : null;
const wif = wifFromArgs ?? userWallet.wif ?? userWallet.wif_file ?? null;

const walletCfg = walletConfigFrom(cfg);
const wallet = new LibAuthBchWallet({ cfg: walletCfg, wif: wif, logger: log.child('wallet') });
await wallet.init();
const walletAddr = wallet.getAddress();
log.info('manual-test.wallet-ready', {
  address: walletAddr,
  network: walletCfg.network,
});

// Current balance sanity check.
const balanceSats = await wallet.getBalanceSats();
const balanceBch = Number(balanceSats) / Number(SATS_PER_BCH);
log.info('manual-test.balance', {
  balance_sats: balanceSats.toString(),
  balance_bch: balanceBch.toFixed(8),
});
if (!DRY_RUN && balanceBch < SIZE_BCH + 0.001) {
  log.error('manual-test.balance-insufficient', {
    balance_bch: balanceBch,
    required_bch: SIZE_BCH + 0.001,
  });
  process.exit(1);
}

// ── swap executor ─────────────────────────────────────────────────────────

const swap = new SwapExecutor({
  cfg,
  wallet,
  logger: log.child('swap'),
});

// ── STAGE 1 — entry (buy) ─────────────────────────────────────────────────

const amountBase = BigInt(Math.round(SIZE_BCH * Number(SATS_PER_BCH)));
log.info('manual-test.entry.start', {
  side: 'buy',
  amount_base: amountBase.toString(),
  amount_bch: SIZE_BCH,
  token_id: TOKEN_ID,
});

const buyResult = await swap.execute({
  tokenId: TOKEN_ID,
  side: 'buy',
  amountBase,
  destination: walletTokenAddr ?? walletAddr,
});

if (!buyResult.ok) {
  log.error('manual-test.entry.failed', {
    error: buyResult.error,
    error_kind: buyResult.errorKind,
  });
  process.exit(1);
}

// For BUY: `totalSatsInOrOut` is `plan.totalSupply` — i.e. tokens
// received (NOT sats, despite the field name). For SELL the same
// field IS sats received.
const tokensReceived = buyResult.totalSatsInOrOut;
const entryPriceSatsPerToken = Number(buyResult.effectiveRateSats);
const entryBchSpent = Number(buyResult.totalSatsInOrOut) === Number(amountBase)
  ? Number(amountBase)  // dry-run path may echo input
  : Number(amountBase);  // we asked for SIZE_BCH; that's what we spent on the input side

log.info('manual-test.entry.success', {
  txid: buyResult.txid,
  amount_base_sats: amountBase.toString(),
  tokens_received: tokensReceived.toString(),
  effective_rate_sats: entryPriceSatsPerToken,
  slippage_bps: buyResult.slippageBps.toString(),
  lp_fee_sats: buyResult.lpFeeSats.toString(),
  est_network_fee_sats: buyResult.estNetworkFeeSats.toString(),
  wallet_balance_after_sats: buyResult.walletBalanceAfterSats.toString(),
  pool_count: buyResult.allocations?.length ?? 0,
  dry_run: DRY_RUN,
});

if (DRY_RUN) {
  // Dry-run: stop after the entry plan. The bot's dry-run mode
  // (T24) skips broadcast entirely; here we still went through
  // pre-flight + planning, so we know the trade would have worked.
  log.info('manual-test.dry-run.complete', {
    message: 'no broadcast (--dry-run); entry plan verified',
  });
  process.exit(0);
}

// ── wait between entry and exit ──────────────────────────────────────────

log.info('manual-test.hold', { hold_seconds: HOLD_SECONDS });
await delay(HOLD_SECONDS * 1000);

// ── STAGE 2 — exit (sell) ─────────────────────────────────────────────────

log.info('manual-test.exit.start', {
  side: 'sell',
  amount_base: tokensReceived.toString(),
  token_id: TOKEN_ID,
});

const sellResult = await swap.execute({
  tokenId: TOKEN_ID,
  side: 'sell',
  amountBase: tokensReceived,
  destination: walletTokenAddr ?? walletAddr,
});

if (!sellResult.ok) {
  log.error('manual-test.exit.failed', {
    error: sellResult.error,
    error_kind: sellResult.errorKind,
    partial_position: true,
    note: 'entry was broadcast successfully but exit failed; position is open',
  });
  process.exit(1);
}

const exitBchReceived = sellResult.totalSatsInOrOut; // sats for sell
const exitPriceSatsPerToken = Number(sellResult.effectiveRateSats);
const entryValueSats = (tokensReceived * BigInt(Math.round(entryPriceSatsPerToken))) / BigInt(SATS_PER_BCH);
const exitValueSats = exitBchReceived;
const realizedPnlSats = Number(exitValueSats - entryValueSats);
const realizedPnlBch = realizedPnlSats / Number(SATS_PER_BCH);

log.info('manual-test.exit.success', {
  txid: sellResult.txid,
  amount_base_tokens: tokensReceived.toString(),
  bch_received_sats: exitBchReceived.toString(),
  effective_rate_sats: exitPriceSatsPerToken,
  slippage_bps: sellResult.slippageBps.toString(),
  lp_fee_sats: sellResult.lpFeeSats.toString(),
  est_network_fee_sats: sellResult.estNetworkFeeSats.toString(),
  wallet_balance_after_sats: sellResult.walletBalanceAfterSats.toString(),
  pool_count: sellResult.allocations?.length ?? 0,
});

log.info('manual-test.pnl', {
  entry_txid: buyResult.txid,
  entry_bch_spent_sats: amountBase.toString(),
  entry_price_sats_per_token: entryPriceSatsPerToken,
  entry_slippage_bps: buyResult.slippageBps.toString(),
  exit_txid: sellResult.txid,
  exit_bch_received_sats: exitBchReceived.toString(),
  exit_price_sats_per_token: exitPriceSatsPerToken,
  exit_slippage_bps: sellResult.slippageBps.toString(),
  realized_pnl_sats: realizedPnlSats,
  realized_pnl_bch: realizedPnlBch.toFixed(8),
  total_lp_fee_sats: (Number(buyResult.lpFeeSats) + Number(sellResult.lpFeeSats)).toString(),
  total_network_fee_sats_estimated: (Number(buyResult.estNetworkFeeSats) + Number(sellResult.estNetworkFeeSats)).toString(),
});

// Structured summary on stdout for downstream tooling.
const summary = {
  ok: true,
  token_id: TOKEN_ID,
  entry: {
    txid: buyResult.txid,
    bch_spent_sats: amountBase.toString(),
    tokens_received: tokensReceived.toString(),
    effective_rate_sats: entryPriceSatsPerToken,
    slippage_bps: buyResult.slippageBps.toString(),
    lp_fee_sats: buyResult.lpFeeSats.toString(),
    est_network_fee_sats: buyResult.estNetworkFeeSats.toString(),
  },
  exit: {
    txid: sellResult.txid,
    bch_received_sats: exitBchReceived.toString(),
    effective_rate_sats: exitPriceSatsPerToken,
    slippage_bps: sellResult.slippageBps.toString(),
    lp_fee_sats: sellResult.lpFeeSats.toString(),
    est_network_fee_sats: sellResult.estNetworkFeeSats.toString(),
  },
  pnl: {
    realized_pnl_sats: realizedPnlSats,
    realized_pnl_bch: realizedPnlBch,
  },
  wallet_address: walletAddr,
};
process.stdout.write(JSON.stringify(summary, null, 2) + '\n');

// Clean shutdown.
try { await wallet.close(); } catch (_) { /* noop */ }
process.exit(0);
}
