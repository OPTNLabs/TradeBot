#!/usr/bin/env node
// src/feature-ideas/seed.mjs
//
// Initial seed ideas for the feature-ideas tab. Each idea is
// hand-curated from the live bot's known edge cases + known
// improvement opportunities. The research cron (added later) will
// add MORE ideas on top of these on a weekly cadence — the seed
// just ensures the dashboard tab is useful from the very first
// page-load.
//
// Every idea here has:
//   - a stable `id` (so re-runs are idempotent — the store's
//     `addIdeas` skips existing ids)
//   - a title + rationale + evidence the operator can act on
//   - effort / impact / category tags
//
// IDs use the `idea_seed_<slug>` namespace so the cron can use
// `idea_<ulid>` without collision.

/**
 * @typedef {Object} SeedIdea
 * @property {string} id
 * @property {string} title
 * @property {string} category
 * @property {string} rationale
 * @property {string} evidence
 * @property {'S'|'M'|'L'} effort
 * @property {'low'|'medium'|'high'} impact
 * @property {string[]} category_tags
 */

/** @type {SeedIdea[]} */
export const SEED_FEATURE_IDEAS = [
  // ─── edge-case-protection ────────────────────────────────────────
  {
    id: 'idea_seed_indexer_price_pre_entry_check',
    title: 'Pre-flight: reject entry when indexer price is wildly divergent from AMM spot rate',
    category: 'edge-case-protection',
    rationale: 'T28d catches indexer-vs-AMM divergence at EXIT time, but we still open positions whose indexer reference price is 1000x+ off from the actual AMM-implied rate. A pre-entry sanity check (compute AMM spot rate, compare to market.price_now_sats, reject if |ratio| > 1000x) would prevent entering tokens we cannot reasonably exit at the reference price.',
    evidence: 'QBTC 2026-09-14: indexer reported 326 BCH/QBTC, AMM rate was 326 sats/QBTC. Bot entered for 0.005 BCH, then spammed exit_failed every minute because TP fired on the bogus 32.7B figure. Net: position sat stuck ~24h.',
    effort: 'M',
    impact: 'high',
    category_tags: ['indexer', 'data-quality', 'pre-flight', 't28d-follow-up'],
  },
  {
    id: 'idea_seed_pre_entry_liquidity_floor',
    title: 'Pre-entry: minimum total AMM sats per token (illiquidity guard)',
    category: 'edge-case-protection',
    rationale: 'The bot currently uses `tvl_bch` from the indexer, which can be stale or based on a different pool set than the one `prepareAndBuildSwap` actually routes through. Adding a "minimum total sats across all active pools for this token" gate would prevent entries where the bot cannot actually exit at any meaningful size.',
    evidence: 'QBTC has 10 pools with combined ~1.32 BCH TVL. A 0.005 BCH buy consumed ~0.4% of pool liquidity. A similar sell would face massive slippage. The current `min_tvl_bch=0.25` floor uses indexer TVL (~4.74 BCH) which overstates true depth.',
    effort: 'M',
    impact: 'medium',
    category_tags: ['liquidity', 'pre-flight', 't08-follow-up'],
  },
  {
    id: 'idea_seed_position_concentration_cap',
    title: 'Position concentration cap: max % of total BCH in one open position',
    category: 'edge-case-protection',
    rationale: 'With a 0.04 BCH wallet, max_position_bch=0.005 allows up to 8 simultaneous positions. Combined with the 0.005 BCH per-trade size, one bad trade can consume 12% of the wallet. A concentration cap ("no single open position > 25% of total BCH") would force the bot to scale down when wallet is small or close the biggest loser.',
    evidence: 'Today\'s bot has 0.04 BCH wallet, 1 open QBTC position consuming ~495k sats = 12% of wallet. If that one position blows up to a 100% loss, the wallet is gone.',
    effort: 'S',
    impact: 'medium',
    category_tags: ['risk', 'position-sizing', 't06-follow-up'],
  },
  {
    id: 'idea_seed_loss_cooldown',
    title: 'Loss cooldown: pause new entries for N minutes after a stop-loss exit',
    category: 'edge-case-protection',
    rationale: 'After a stop-loss exit, the market conditions that triggered the exit may still be present. The bot\'s current "circuit breaker" trips after `max_consecutive_losses`, but that means up to 3 stop-losses back-to-back at full position size. A cooldown ("no new entries for 30 minutes after a stop-loss") dampens drawdowns without locking out the bot entirely.',
    evidence: 'T17 circuit breaker caps at max_consecutive_losses=3. Three 0.005 BCH stop-losses in a row = 0.015 BCH gone in minutes during a choppy regime.',
    effort: 'S',
    impact: 'medium',
    category_tags: ['risk', 'circuit-breaker', 't17-follow-up'],
  },
  {
    id: 'idea_seed_utxo_consolidation_pre_trade',
    title: 'Auto-consolidate fragmented BCH UTXOs before large trades',
    category: 'edge-case-protection',
    rationale: 'A 0.04 BCH wallet spread across 8+ dust UTXOs (e.g., from many small `sweep-funds` runs) may not be able to fund a 0.005 BCH buy because no single UTXO + fee fits. The bot currently surfaces this as `below_floor` and skips. Pre-trade consolidation (move all BCH UTXOs > dust into one) would prevent spurious "insufficient funds" rejections.',
    evidence: 'After several T27 sweep cycles the wallet likely has multiple small BCH UTXOs. Each consumes one input on every buy. With many UTXOs, the tx size grows and fees eat the position.',
    effort: 'M',
    impact: 'low',
    category_tags: ['wallet', 'utxo-management'],
  },
  {
    id: 'idea_seed_indexer_stale_flag',
    title: 'Indexer stale-data flag: reject token if `trade_count` is 0 for >7d',
    category: 'edge-case-protection',
    rationale: 'The Cauldron indexer\'s `price_now_sats` is a stale fallback when a token has no recent trades. QBTC\'s `trade_count=0` correlates with its 32.7B phantom price. A per-token staleness flag (computed from `now - last_trade_ts`) would let the scorer and pre-flight explicitly skip tokens whose reference price is suspect.',
    evidence: 'QBTC trade_count=0, price_now_sats=32.7B. HoneyBadgers trade_count=0 too, but its HWM-based heuristics happen to be safe because entry_price was correctly recorded.',
    effort: 'M',
    impact: 'high',
    category_tags: ['indexer', 'data-quality', 'scoring'],
  },
  // ─── decision-logic ─────────────────────────────────────────────
  {
    id: 'idea_seed_volatility_adjusted_position_size',
    title: 'Volatility-adjusted position sizing (Kelly-lite)',
    category: 'decision-logic',
    rationale: 'Currently `size_bch` is a fixed fraction of max_position_bch. For a high-volatility token (where TP/SL is more likely to fire correctly) the position should be SMALLER (more conservative). For low-volatility tokens it can be larger (more time to be right). A volatility-adjusted sizing model would tune `size_bch` to `max_position_bch * (target_vol / realized_vol)`.',
    evidence: 'Current `size_bch` ignores `volatility_24h_pct` from scoring. QBTC has 3.44% daily vol; FEW has much higher. Both get the same 0.005 BCH per trade.',
    effort: 'M',
    impact: 'high',
    category_tags: ['position-sizing', 'kelly', 'risk-management'],
  },
  {
    id: 'idea_seed_correlation_check',
    title: 'Correlation-aware entries: skip token if highly correlated with an existing position',
    category: 'decision-logic',
    rationale: 'Multiple positions in tokens that move together aren\'t diversifying — they\'re a concentrated bet. The bot currently ranks each token independently. Adding a pairwise-correlation check against the open portfolio (using rolling 24h returns) would reject highly correlated entries, forcing true diversification.',
    evidence: 'Two BADGER-like tokens both being held would double exposure to the same risk factor.',
    effort: 'L',
    impact: 'medium',
    category_tags: ['portfolio-construction', 'correlation'],
  },
  {
    id: 'idea_seed_pool_age_filter',
    title: 'Skip tokens where the primary AMM pool was created < 7d ago',
    category: 'decision-logic',
    rationale: 'Newly-created pools often have wash-trade volume, suspicious "price_now_sats" from a single seed swap, or a creator holding a large bag. A minimum pool age filter would exclude fresh rugs.',
    evidence: 'No current filter exists. `max_pool_age_days` only filters on the OLDEST pool, not on whether all active pools are old.',
    effort: 'S',
    impact: 'medium',
    category_tags: ['rug-protection', 'pool-age', 't09-follow-up'],
  },
  {
    id: 'idea_seed_tp_sl_dynamic_from_volatility',
    title: 'Dynamic take-profit / stop-loss based on 7d realized volatility',
    category: 'decision-logic',
    rationale: 'Fixed 5% TP / 3% SL is appropriate for some tokens but too tight for high-vol (TP fires before any real move) or too loose for low-vol (never fires). Per-token dynamic thresholds computed from the 7d standard deviation would set TP at `entry * (1 + 2σ)` and SL at `entry * (1 - 1σ)`.',
    evidence: 'FEW: 7d std ≈ 0.18 (18%). Current 5% TP fires way too early for that kind of volatility. QBTC: 7d std ≈ 0.002 (0.2%). 5% TP is unreachable in any reasonable timeframe.',
    effort: 'M',
    impact: 'high',
    category_tags: ['exit-logic', 'volatility-targeting', 't28-follow-up'],
  },
  // ─── dashboard ──────────────────────────────────────────────────
  {
    id: 'idea_seed_dashboard_pnl_over_time',
    title: 'Dashboard: cumulative P&L chart over time',
    category: 'dashboard',
    rationale: 'Operators currently have to mentally aggregate per-trade P&L from history. A simple line chart of "realized_pnl_sats" cumulated over time (with closed-position markers) would make the bot\'s actual performance legible at a glance.',
    evidence: 'Dashboard.jsx Portfolio view shows open positions but no closed-trade summary. The data is already in `positions.json` (closed array) and `data/snapshots/`.',
    effort: 'S',
    impact: 'high',
    category_tags: ['ui', 'visualization', 'pnl'],
  },
  {
    id: 'idea_seed_dashboard_decision_trace',
    title: 'Dashboard: decision trace (why did the bot enter / skip / reject each candidate)',
    category: 'dashboard',
    rationale: 'Currently `loop.tick` logs every decision but there\'s no UI to inspect them. A "Decision trace" tab showing the last N ticks\' scored candidates, why each was accepted/rejected/skipped, and the full reasoning blob would make the bot\'s logic auditable without reading the logs.',
    evidence: '`loop.tick.excluded_tokens` already includes scoring breakdown; just no UI for it.',
    effort: 'M',
    impact: 'high',
    category_tags: ['ui', 'observability', 'auditability'],
  },
  {
    id: 'idea_seed_dashboard_risk_panel',
    title: 'Dashboard: live risk panel (concentration, exposure, drawdown)',
    category: 'dashboard',
    rationale: 'The bot has position-level and wallet-level risk gates in pre-flight but the dashboard doesn\'t surface current exposure vs max_exposure, current drawdown vs max_daily_loss, or concentration per token. A live risk panel would let the operator see how close the bot is to tripping a gate before it actually trips.',
    evidence: 'Portfolio view shows current open positions but not the aggregate risk metrics. `positions.json` has all the data; needs a roll-up panel.',
    effort: 'M',
    impact: 'medium',
    category_tags: ['ui', 'risk', 'observability'],
  },
  {
    id: 'idea_seed_dashboard_trade_history_filters',
    title: 'Dashboard: trade history with filters (token, side, date range, P&L)',
    category: 'dashboard',
    rationale: 'The current ActivityFeed is a flat recent-events list. A dedicated trade history view with filters (by token, side, date range, P&L outcome) would make it easy to audit "what did the bot do with X last month".',
    evidence: 'History.jsonl has all entries; need a proper table view.',
    effort: 'M',
    impact: 'medium',
    category_tags: ['ui', 'history', 'auditability'],
  },
  {
    id: 'idea_seed_dashboard_settings_editor',
    title: 'Dashboard: live settings editor (knobs with explanations)',
    category: 'dashboard',
    rationale: 'Today, changing a config knob requires SSH + `vi TODO.md` + restart. A settings panel in the dashboard with human-readable explanations for each knob + a "Save & Restart Required" warning would lower the operational friction dramatically.',
    evidence: 'Settings.jsx already exists but is read-only.',
    effort: 'L',
    impact: 'medium',
    category_tags: ['ui', 'config', 'operations'],
  },
  {
    id: 'idea_seed_dashboard_manual_trade_ui',
    title: 'Dashboard: manual BUY/SELL trigger (operator override)',
    category: 'dashboard',
    rationale: 'For edge cases the bot\'s scoring misses (e.g., a token the operator has done research on), a manual trade button that goes through the same `SwapExecutor.execute()` pipeline would let the operator intervene without skipping the slippage / wallet-floor gates.',
    evidence: '`scripts/manual-test-trade.mjs` already does this for the buy→sell cycle, but it\'s CLI-only.',
    effort: 'L',
    impact: 'medium',
    category_tags: ['ui', 'manual-control', 'override'],
  },
  // ─── observability ──────────────────────────────────────────────
  {
    id: 'idea_seed_structured_alerts',
    title: 'Structured alerts (Telegram push on risk thresholds, slippage spikes, AMM divergence)',
    category: 'observability',
    rationale: 'Operators learn about issues only when the dashboard is open. Critical events (slippage > 500 bps sustained, AMM divergence > 10x sustained, wallet below min_floor for > N minutes, exchange RPC failures) should push to Telegram immediately.',
    evidence: 'Telegram delivery has been failing lately (cron supervisor OutboundDeliveryError). Even when it works, alerts only fire on cron summaries, not on real-time events.',
    effort: 'M',
    impact: 'high',
    category_tags: ['alerts', 'telegram', 'monitoring'],
  },
  {
    id: 'idea_seed_per_token_trade_log',
    title: 'Per-token trade log with P&L attribution (which entries / exits contributed to current position P&L)',
    category: 'observability',
    rationale: 'For tokens with multiple entries / exits, the running P&L should be attributed to each trade. Currently `positions.json` only tracks the current open position; history events show all trades but no per-trade P&L roll-up.',
    evidence: 'positions.json has `entry.txid`, `entry.bch_spent_sats`, `exit.txid`, `exit.bch_received_sats` — but no FIFO/LIFO cost basis tracking.',
    effort: 'L',
    impact: 'medium',
    category_tags: ['observability', 'pnl', 'cost-basis'],
  },
  // ─── performance ────────────────────────────────────────────────
  {
    id: 'idea_seed_cache_pool_discovery',
    title: 'Cache `listTopTokens` results for 30s to reduce indexer load',
    category: 'performance',
    rationale: 'Every loop tick (every ~60s) hits the indexer for token discovery + per-token pool data. With 250+ tokens the indexer does ~500 HTTP requests per minute. A 30s in-memory cache would cut that to ~20/min, reducing both indexer load and bot latency.',
    evidence: '`fetcher.listTopTokens()` and `fetcher.listPools(tokenId)` are uncached. Each tick re-fetches everything.',
    effort: 'S',
    impact: 'low',
    category_tags: ['performance', 'caching', 't10-follow-up'],
  },
];
