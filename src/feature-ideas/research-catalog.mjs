#!/usr/bin/env node
// src/feature-ideas/research-catalog.mjs
//
// Curated catalog of feature-idea templates that the research
// cron (`scripts/feature_researcher.mjs`) rotates through. Every
// template is hand-authored from known TradeBot edge cases +
// improvement opportunities. The cron picks 1-3 templates per
// run that haven't yet generated an idea in the on-disk store,
// and emits a concrete idea per template.
//
// Adding new templates: drop another object into the array below.
// Each template must:
//   - have a stable `template_id` (the dedupe key; the researcher
//     skips any template whose id already appears in the store,
//     regardless of status)
//   - target one of `edge-case-protection`, `decision-logic`,
//     `dashboard`, `observability`, or `performance` (the same
//     five categories `schema.mjs` accepts)
//   - declare effort (S/M/L) and impact (low/medium/high)
//   - include a 1-3 sentence `rationale_template` + concrete
//     `evidence_template` so the dashboard card has substance
//
// The cron stamps each generated idea with:
//   - id: `idea_<template_id>_<YYYYMMDD>` (deterministic + sortable)
//   - source: 'research-cron'
//   - status: 'pending'
//   - timestamps at append time
//
// When the catalog is exhausted (every template has at least one
// idea in the store), the researcher logs "no new templates
// available" and exits 0. The supervisor can grow the catalog
// over time by appending new entries — no schema bump required.

import {
  FEATURE_IDEAS_CATEGORIES,
  FEATURE_IDEAS_EFFORTS,
  FEATURE_IDEAS_IMPACTS,
} from './schema.mjs';

/**
 * @typedef {Object} ResearchTemplate
 * @property {string} template_id
 * @property {string} title
 * @property {'edge-case-protection'|'decision-logic'|'dashboard'|'observability'|'performance'} category
 * @property {'S'|'M'|'L'} effort
 * @property {'low'|'medium'|'high'} impact
 * @property {string} rationale_template
 * @property {string} evidence_template
 * @property {string[]} category_tags
 */

/**
 * @type {ResearchTemplate[]}
 */
export const RESEARCH_CATALOG = Object.freeze([
  // ─── edge-case-protection (12) ────────────────────────────────────
  {
    template_id: 'pre_entry_indexer_price_check',
    title: 'Pre-flight: reject entry when indexer price diverges from AMM spot rate by >1000x',
    category: 'edge-case-protection',
    effort: 'M',
    impact: 'high',
    rationale_template:
      'shouldExit already rejects wildly-off indexer prices at EXIT time (T28d). ' +
      'A pre-entry sanity check would prevent opening positions on tokens whose indexer ' +
      'reference price is unrelated to the AMM-implied spot rate — currently we discover ' +
      'this only after the position is opened.',
    evidence_template:
      'Live observed case: indexer reports 32.6 BCH/token when the AMM spot rate is ~326 ' +
      'sats/token (100,000,000x off). Bot enters on the bogus number, then every exit attempt ' +
      'spams exit_failed until the time-stop fires.',
    category_tags: ['indexer', 'data-quality', 'pre-flight', 't28d-follow-up'],
  },
  {
    template_id: 'pre_entry_liquidity_floor',
    title: 'Pre-entry: minimum total AMM sats across all active pools per token',
    category: 'edge-case-protection',
    effort: 'M',
    impact: 'medium',
    rationale_template:
      'min_tvl_bch currently uses the indexer\'s TVL number, which can be stale or pool-set ' +
      'mismatched. A "total sats across every active pool for this token" floor would prevent ' +
      'entering tokens where the bot cannot actually exit at any meaningful size.',
    evidence_template:
      'Tokens with 10 pools of ~1.32 BCH combined TVL are still scored as ~5 BCH by the ' +
      'indexer. A 0.005 BCH buy consumes ~0.4% of true depth, but a similar sell faces ' +
      'massive slippage because there\'s no exit-side depth.',
    category_tags: ['liquidity', 'pre-flight', 't08-follow-up'],
  },
  {
    template_id: 'position_concentration_cap',
    title: 'Position concentration cap: max % of total BCH in one open position',
    category: 'edge-case-protection',
    effort: 'S',
    impact: 'medium',
    rationale_template:
      'With a 0.04 BCH wallet and max_position_bch=0.005, up to 8 simultaneous positions are ' +
      'allowed. One bad trade can consume 12% of the wallet. A "no single open position > 25% ' +
      'of total BCH" gate would force the bot to scale down when wallet is small or close the ' +
      'biggest loser before opening new positions.',
    evidence_template:
      'Even a single 0.005 BCH stop-loss consumes 12% of the current 0.04 BCH wallet. ' +
      'Concentration cap would prevent the wallet from being concentrated in a single ' +
      'high-volatility token overnight.',
    category_tags: ['risk', 'position-sizing', 't06-follow-up'],
  },
  {
    template_id: 'loss_cooldown',
    title: 'Loss cooldown: pause new entries for N minutes after a stop-loss exit',
    category: 'edge-case-protection',
    effort: 'S',
    impact: 'medium',
    rationale_template:
      'After a stop-loss exit, the market conditions that triggered the exit may still be ' +
      'present. The circuit breaker trips after max_consecutive_losses (default 3) but means ' +
      'up to 3 stop-losses back-to-back at full position size. A 30-min "no new entries after ' +
      'a stop-loss" cooldown dampens drawdowns without locking the bot out.',
    evidence_template:
      'Circuit breaker caps at 3 consecutive losses = 0.015 BCH gone in minutes during a ' +
      'choppy regime. A per-loss cooldown would force the bot to slow down after each loss.',
    category_tags: ['risk', 'circuit-breaker', 't17-follow-up'],
  },
  {
    template_id: 'utxo_consolidation_pre_trade',
    title: 'Auto-consolidate fragmented BCH UTXOs before trades above a size threshold',
    category: 'edge-case-protection',
    effort: 'M',
    impact: 'low',
    rationale_template:
      'A wallet spread across many dust UTXOs may not be able to fund a target-position-size ' +
      'buy because no single UTXO + fee fits. The bot currently surfaces this as below_floor ' +
      'and skips. Pre-trade consolidation when the spread exceeds a threshold would prevent ' +
      'spurious insufficient-funds rejections.',
    evidence_template:
      'After multiple sweep cycles, the wallet likely has several small BCH UTXOs. Each ' +
      'consumes one input on every buy, growing the tx size and fees until the position-size ' +
      'floor trips.',
    category_tags: ['wallet', 'utxo-management'],
  },
  {
    template_id: 'indexer_stale_flag',
    title: 'Indexer stale-data flag: reject token if trade_count=0 for >7d',
    category: 'edge-case-protection',
    effort: 'M',
    impact: 'high',
    rationale_template:
      'The Cauldron indexer\'s price_now_sats is a stale fallback when a token has no recent ' +
      'trades. A per-token staleness flag computed from now - last_trade_ts would let the ' +
      'scorer and pre-flight explicitly skip tokens whose reference price is suspect.',
    evidence_template:
      'QBTC and HoneyBadgers both have trade_count=0 with stale price_now_sats. QBTC\'s ' +
      '100,000,000x phantom price caused T28d. Staleness flag would surface this BEFORE the ' +
      'position is opened, not at exit.',
    category_tags: ['indexer', 'data-quality', 'scoring'],
  },
  {
    template_id: 'dust_position_auto_close',
    title: 'Auto-close dust positions (positions smaller than exit-fee + slippage budget)',
    category: 'edge-case-protection',
    effort: 'M',
    impact: 'medium',
    rationale_template:
      'A position whose token_amount is so small the exit fee + expected slippage exceeds ' +
      'the position value can never profitably close. The bot holds these indefinitely and ' +
      'they clutter the dashboard. Auto-close at "below breakeven" would free up mental and ' +
      'on-chain capital.',
    evidence_template:
      'The current min_trade_size_bch (0.0005) only filters new entries, not exits. A position ' +
      'opened before that threshold was applied can become un-exitable if the token moons ' +
      '(token_amount grows but stays dust-equivalent in BCH terms).',
    category_tags: ['dust', 'position-management'],
  },
  {
    template_id: 'circuit_breaker_daily_reset',
    title: 'Circuit breaker daily reset: clear consecutive_losses at UTC midnight',
    category: 'edge-case-protection',
    effort: 'S',
    impact: 'low',
    rationale_template:
      'A 3-loss cooldown can lock the bot out for the full cooldown window even if losses ' +
      'happened 23 hours ago. A daily reset would let the bot trade normally the next day ' +
      'instead of waiting hours past the natural "day boundary".',
    evidence_template:
      'Current cooldown_hours=6 means a bot that tripped at 23:00 can\'t trade until 05:00 ' +
      'the next day. Daily reset would put the bot back online at 00:00 UTC.',
    category_tags: ['risk', 'circuit-breaker'],
  },
  {
    template_id: 'slippage_cap_per_token',
    title: 'Per-token slippage cap based on pool depth (deeper pool = lower cap)',
    category: 'edge-case-protection',
    effort: 'M',
    impact: 'high',
    rationale_template:
      'A flat 100bps slippage_tolerance_bps is too loose for shallow pools (allows massive ' +
      'real slippage) and too tight for deep pools (rejects profitable trades). Per-token ' +
      'slippage cap derived from min(pool depth, total position size) would balance both.',
    evidence_template:
      'A 0.005 BCH buy in a 0.5 BCH pool = 1% of depth, with realistic AMM slippage ~150bps ' +
      '(not the configured cap). A 0.005 BCH buy in a 5 BCH pool = 0.1% of depth, realistic ' +
      'slippage <20bps — current 100bps cap overestimates by 5x.',
    category_tags: ['slippage', 'pre-flight', 't11-follow-up'],
  },
  {
    template_id: 'orphan_position_alert',
    title: 'Orphan-position alert: notify operator when a position has no on-chain movement >N hours',
    category: 'edge-case-protection',
    effort: 'S',
    impact: 'medium',
    rationale_template:
      'A position whose token UTXO never gets spent in N hours is likely stuck (wrong token ' +
      'address, lost UTXO, or a bot bug). An alert would surface the stuck position before ' +
      'the operator notices via the dashboard.',
    evidence_template:
      'pos_tlbiuvh6_0002 (FEW) was stuck for hours before the operator noticed the ' +
      'swap.preflight.reject spam. A simple alert would have surfaced it within minutes.',
    category_tags: ['monitoring', 'position-management', 't29-follow-up'],
  },
  {
    template_id: 'reconcile_position_in_loop',
    title: 'Auto-reconcile orphan positions when wallet UTXO sweep detects them',
    category: 'edge-case-protection',
    effort: 'M',
    impact: 'medium',
    rationale_template:
      'scripts/reconcile-position.mjs is a manual operator tool. The same logic could run ' +
      'automatically when sync-wallet-holdings.mjs finds an unexpected on-chain token ' +
      'holding — closing the manual-loop gap.',
    evidence_template:
      'Every manual reconcile is a UX friction. Automating the same detection would let the ' +
      'operator focus on approving ideas instead of babysitting orphan positions.',
    category_tags: ['reconciliation', 't29-follow-up', 'automation'],
  },
  {
    template_id: 'sdk_version_pin',
    title: 'Pin cauldron-swap-sdk + cashscript versions in package-lock + CI',
    category: 'edge-case-protection',
    effort: 'S',
    impact: 'medium',
    rationale_template:
      'A new SDK version with a breaking change in prepareAndBuildSwap would silently break ' +
      'every swap the bot attempts. Pinning the SDK + cashscript versions and running a CI ' +
      'integration test on every package.json change would surface breaking changes before ' +
      'they reach production.',
    evidence_template:
      'cauldron-swap-sdk is at ^0.1.9, cashscript is at ^0.13.2. Both are 0.x — semver-major ' +
      'changes can land in minor versions. A silent SDK change would be a critical regression.',
    category_tags: ['supply-chain', 'ci', 'sdk-management'],
  },

  // ─── decision-logic (12) ─────────────────────────────────────────
  {
    template_id: 'volatility_adjusted_position_size',
    title: 'Volatility-adjusted position sizing (Kelly-lite)',
    category: 'decision-logic',
    effort: 'M',
    impact: 'high',
    rationale_template:
      'size_bch is a fixed fraction of max_position_bch. High-volatility tokens (more ' +
      'TP/SL chance of firing) deserve smaller positions, low-vol tokens can be sized up. ' +
      'A volatility-adjusted sizing model would scale size_bch with the inverse of realized ' +
      'volatility.',
    evidence_template:
      'Currently size_bch ignores volatility_24h_pct from scoring. High-vol tokens get the ' +
      'same 0.005 BCH as low-vol tokens, even though their TP/SL firing probabilities differ ' +
      'by an order of magnitude.',
    category_tags: ['position-sizing', 'kelly', 'risk-management'],
  },
  {
    template_id: 'correlation_aware_entries',
    title: 'Correlation-aware entries: skip token highly correlated with existing positions',
    category: 'decision-logic',
    effort: 'L',
    impact: 'medium',
    rationale_template:
      'Multiple positions in tokens that move together aren\'t diversifying — they\'re a ' +
      'concentrated bet. The bot currently ranks each token independently. A pairwise ' +
      'correlation check against the open portfolio would reject highly-correlated entries.',
    evidence_template:
      'Two tokens that share a single creator or a single underlying collateral are de-facto ' +
      'the same position. Correlation check would force true diversification.',
    category_tags: ['portfolio-construction', 'correlation'],
  },
  {
    template_id: 'pool_age_filter',
    title: 'Skip tokens where the primary AMM pool was created <7d ago',
    category: 'decision-logic',
    effort: 'S',
    impact: 'medium',
    rationale_template:
      'Newly-created pools often have wash-trade volume, suspicious price_now_sats from a ' +
      'single seed swap, or a creator holding a large bag. A minimum pool age filter would ' +
      'exclude fresh rugs.',
    evidence_template:
      'max_pool_age_days currently filters on the OLDEST pool, not whether all active pools ' +
      'are old. A token with 9 ancient pools + 1 fresh pool still passes.',
    category_tags: ['rug-protection', 'pool-age', 't09-follow-up'],
  },
  {
    template_id: 'tp_sl_dynamic_from_volatility',
    title: 'Dynamic take-profit / stop-loss based on 7d realized volatility',
    category: 'decision-logic',
    effort: 'M',
    impact: 'high',
    rationale_template:
      'Fixed 5% TP / 3% SL is appropriate for some tokens but too tight for high-vol (TP ' +
      'fires before any real move) or too loose for low-vol (never fires). Per-token dynamic ' +
      'thresholds from 7d standard deviation would set TP at entry * (1 + 2σ) and SL at ' +
      'entry * (1 - 1σ).',
    evidence_template:
      'Tokens with 18% 7d std fire a 5% TP too early (every bounce). Tokens with 0.2% 7d ' +
      'std never fire the 5% TP in any reasonable timeframe. Both are held until time-stop.',
    category_tags: ['exit-logic', 'volatility-targeting', 't28-follow-up'],
  },
  {
    template_id: 'trailing_stop_multi_tier',
    title: 'Multi-tier trailing stop (lock in profit at 1%, 2%, 3% levels)',
    category: 'decision-logic',
    effort: 'M',
    impact: 'medium',
    rationale_template:
      'A single trailing_stop_pct fires only when the position reverses. A multi-tier stop ' +
      '(1% stop after 1% profit, 2% stop after 2% profit, etc.) locks in incremental gains ' +
      'and lets winners run further.',
    evidence_template:
      'Many positions reverse exactly at the trailing stop, leaving 0% gains. Multi-tier ' +
      'would have banked some profit on those.',
    category_tags: ['exit-logic', 'profit-locking'],
  },
  {
    template_id: 'entry_only_increasing_volume',
    title: 'Enter only when 1h volume is increasing (momentum filter)',
    category: 'decision-logic',
    effort: 'M',
    impact: 'medium',
    rationale_template:
      'Currently entries are taken on any token that passes the static scoring gates. A ' +
      'momentum filter ("1h volume > 24h-avg volume") would skip tokens whose volume is ' +
      'fading — common precursor to a price drop.',
    evidence_template:
      'Most losing entries are on tokens whose 1h volume was below the 24h average at the ' +
      'time of entry. Momentum check would have skipped many of these.',
    category_tags: ['entry-logic', 'momentum', 't07-follow-up'],
  },
  {
    template_id: 'token_creator_history_check',
    title: 'Skip tokens whose creator address has launched >5 tokens in last 30d (rug pattern)',
    category: 'decision-logic',
    effort: 'L',
    impact: 'high',
    rationale_template:
      'Serial-launcher creators are a known rug-pull pattern. Looking up the creator ' +
      'address\'s history (other tokens, ages) and rejecting tokens from serial launchers ' +
      'would cut rug exposure.',
    evidence_template:
      'Several rug pulls on Cauldron follow this pattern. A creator-history lookup would ' +
      'have flagged most of them before entry.',
    category_tags: ['rug-protection', 'creator-history'],
  },
  {
    template_id: 'fee_yield_threshold',
    title: 'Add fee_yield_bps >10 floor (rejects tokens where LP fees can\'t cover risk)',
    category: 'decision-logic',
    effort: 'S',
    impact: 'low',
    rationale_template:
      'A token with fee_yield_bps <10 isn\'t generating enough LP fees to justify the ' +
      'position\'s risk profile. Adding a floor would clean up the candidate list.',
    evidence_template:
      'Several low-volume tokens have fee_yield_bps=0 (no recent trades). They\'re scored ' +
      'above the floor on volume alone but aren\'t producing any LP income.',
    category_tags: ['scoring', 'fee-yield'],
  },
  {
    template_id: 'position_hold_min_duration',
    title: 'Minimum hold duration before exit (don\'t flip-flop in <15 min)',
    category: 'decision-logic',
    effort: 'S',
    impact: 'medium',
    rationale_template:
      'A position opened 5 minutes ago can\'t have "moved enough" to warrant a TP/SL exit ' +
      '— the price move is just noise. A minimum-hold-duration gate (15 min) would prevent ' +
      'flip-flop exits that pay fees but no profit.',
    evidence_template:
      'Several recent entries exited within minutes at tiny losses (round-trip fees ate ' +
      'the position). A hold floor would have kept the position open until real signal.',
    category_tags: ['exit-logic', 'flip-flop-prevention'],
  },
  {
    template_id: 'macro_bch_price_signal',
    title: 'Pull BCH/USD price feed and factor into position sizing',
    category: 'decision-logic',
    effort: 'L',
    impact: 'medium',
    rationale_template:
      'In a BCH-bull-market, the bot can take more risk (BCH is appreciating, so the wallet ' +
      'is too). In a BCH-bear-market, position sizes should shrink. A BCH/USD feed from a ' +
      'public API (CoinGecko, etc.) would let the bot scale position sizes with macro.',
    evidence_template:
      'Currently position sizes are flat regardless of BCH/USD. A simple 30-day BCH/USD ' +
      'moving average would tell the bot when to scale up vs down.',
    category_tags: ['macro', 'risk-management'],
  },
  {
    template_id: 'token_holders_distribution',
    title: 'Reject tokens where >80% of supply is held by <5 wallets (rug pattern)',
    category: 'decision-logic',
    effort: 'L',
    impact: 'high',
    rationale_template:
      'A token where 80% of supply sits in 5 wallets is one coordinated sale away from ' +
      'crashing. Looking up token holder distribution via the indexer and rejecting ' +
      'high-concentration tokens would prevent entries into easily-dumped tokens.',
    evidence_template:
      'Several rug-pull tokens on Cauldron fit this pattern. Holder-distribution check ' +
      'would have flagged them.',
    category_tags: ['rug-protection', 'holder-distribution'],
  },
  {
    template_id: 'adaptive_score_weights',
    title: 'Adaptive scoring weights (tune weights based on last 7d closed-trade performance)',
    category: 'decision-logic',
    effort: 'L',
    impact: 'high',
    rationale_template:
      'Scoring weights are static. If the last 7 days\' winning trades came mostly from ' +
      'high-volatility tokens, the volatility_24h_pct weight should go up; if they came ' +
      'from low-vol, it should go down. Adaptive weights would tune the scorer to recent ' +
      'performance.',
    evidence_template:
      'Static weights assume the scoring-function/edge ratio is stable across market ' +
      'regimes. It usually isn\'t. Adaptive weights would track the regime.',
    category_tags: ['scoring', 'adaptive', 't07-follow-up'],
  },

  // ─── dashboard (8) ───────────────────────────────────────────────
  {
    template_id: 'dashboard_pnl_over_time',
    title: 'Dashboard: cumulative P&L chart over time',
    category: 'dashboard',
    effort: 'S',
    impact: 'high',
    rationale_template:
      'Operators currently have to mentally aggregate per-trade P&L from history. A line ' +
      'chart of realized_pnl_sats cumulated over time (with closed-position markers) would ' +
      'make the bot\'s actual performance legible at a glance.',
    evidence_template:
      'Portfolio view shows open positions but no closed-trade summary. The data is already ' +
      'in positions.json (closed array) and data/snapshots/ — needs a roll-up.',
    category_tags: ['ui', 'visualization', 'pnl'],
  },
  {
    template_id: 'dashboard_decision_trace',
    title: 'Dashboard: decision trace (why did the bot enter / skip / reject each candidate)',
    category: 'dashboard',
    effort: 'M',
    impact: 'high',
    rationale_template:
      'Currently loop.tick logs every decision but there\'s no UI to inspect them. A ' +
      '"Decision trace" tab showing the last N ticks\' scored candidates, why each was ' +
      'accepted/rejected/skipped, and the full reasoning blob would make the bot\'s logic ' +
      'auditable without reading the logs.',
    evidence_template:
      'loop.tick.excluded_tokens already includes scoring breakdown; just no UI for it. ' +
      'Reasoning.jsx (T25b) covers part of this but not all tick types.',
    category_tags: ['ui', 'observability', 'auditability'],
  },
  {
    template_id: 'dashboard_risk_panel',
    title: 'Dashboard: live risk panel (concentration, exposure, drawdown)',
    category: 'dashboard',
    effort: 'M',
    impact: 'medium',
    rationale_template:
      'The bot has position-level and wallet-level risk gates in pre-flight but the ' +
      'dashboard doesn\'t surface current exposure vs max_exposure, current drawdown vs ' +
      'max_daily_loss, or concentration per token. A live risk panel would let the operator ' +
      'see how close the bot is to tripping a gate before it actually trips.',
    evidence_template:
      'Portfolio view shows current open positions but not aggregate risk. positions.json ' +
      'has all the data; needs a roll-up panel.',
    category_tags: ['ui', 'risk', 'observability'],
  },
  {
    template_id: 'dashboard_trade_history_filters',
    title: 'Dashboard: trade history with filters (token, side, date range, P&L)',
    category: 'dashboard',
    effort: 'M',
    impact: 'medium',
    rationale_template:
      'The current ActivityFeed is a flat recent-events list. A dedicated trade history ' +
      'view with filters (by token, side, date range, P&L outcome) would make it easy to ' +
      'audit "what did the bot do with X last month".',
    evidence_template:
      'history.jsonl has every entry; needs a proper table view.',
    category_tags: ['ui', 'history', 'auditability'],
  },
  {
    template_id: 'dashboard_settings_editor',
    title: 'Dashboard: live settings editor (knobs with explanations)',
    category: 'dashboard',
    effort: 'L',
    impact: 'medium',
    rationale_template:
      'Changing a config knob today requires SSH + vi + restart. A settings panel in the ' +
      'dashboard with human-readable explanations for each knob + a "Save & Restart ' +
      'Required" warning would lower the operational friction dramatically.',
    evidence_template:
      'Settings.jsx exists but is read-only. Write-endpoint PUT /api/config is already ' +
      'wired. Need a UI.',
    category_tags: ['ui', 'config', 'operations'],
  },
  {
    template_id: 'dashboard_manual_trade_ui',
    title: 'Dashboard: manual BUY/SELL trigger (operator override)',
    category: 'dashboard',
    effort: 'L',
    impact: 'medium',
    rationale_template:
      'For edge cases the bot\'s scoring misses (e.g., a token the operator has done ' +
      'research on), a manual trade button that goes through the same SwapExecutor.execute() ' +
      'pipeline would let the operator intervene without skipping slippage / wallet-floor ' +
      'gates.',
    evidence_template:
      'scripts/manual-test-trade.mjs already does this for buy→sell, but it\'s CLI-only.',
    category_tags: ['ui', 'manual-control', 'override'],
  },
  {
    template_id: 'dashboard_fee_breakdown',
    title: 'Dashboard: fee breakdown by token (LP fees, tx fees, slippage cost)',
    category: 'dashboard',
    effort: 'M',
    impact: 'low',
    rationale_template:
      'Today\'s P&L numbers are net of fees but the operator can\'t see fee composition. ' +
      'A breakdown ("LP fees 60%, tx fees 25%, slippage 15%") per token would let the ' +
      'operator identify which tokens are eating fees the most.',
    evidence_template:
      'Currently pnl.fees_paid_sats is a single number per position. Splitting by fee ' +
      'type requires the swap audit events to record more detail (already partially there).',
    category_tags: ['ui', 'fees', 'cost-analysis'],
  },
  {
    template_id: 'dashboard_feature_proposals',
    title: 'Dashboard: feature proposals tab (approve/reject ideas generated by research cron)',
    category: 'dashboard',
    effort: 'M',
    impact: 'high',
    rationale_template:
      'The research cron generates ideas but there\'s no UI to review them. A ' +
      '"Proposals" tab showing pending ideas with category, effort, impact, rationale, ' +
      'evidence + an approve/reject button would close the loop. Approve → appends a TODO ' +
      'entry so the supervisor picks it up.',
    evidence_template:
      'Backend routes are already built (/api/feature-ideas/*); only the React view + nav ' +
      'tab are missing.',
    category_tags: ['ui', 'proposals', 'feature-management'],
  },

  // ─── observability (8) ──────────────────────────────────────────
  {
    template_id: 'structured_alerts',
    title: 'Structured alerts (Telegram push on risk thresholds, slippage spikes, AMM divergence)',
    category: 'observability',
    effort: 'M',
    impact: 'high',
    rationale_template:
      'Operators learn about issues only when the dashboard is open. Critical events ' +
      '(slippage >500bps sustained, AMM divergence >10x sustained, wallet below min_floor ' +
      'for >N minutes, exchange RPC failures) should push to Telegram immediately.',
    evidence_template:
      'Telegram delivery has been failing lately (cron supervisor OutboundDeliveryError). ' +
      'Even when working, alerts only fire on cron summaries, not real-time events.',
    category_tags: ['alerts', 'telegram', 'monitoring'],
  },
  {
    template_id: 'per_token_pnl_attribution',
    title: 'Per-token trade log with FIFO/LIFO P&L attribution',
    category: 'observability',
    effort: 'L',
    impact: 'medium',
    rationale_template:
      'For tokens with multiple entries/exits, the running P&L should be attributed to ' +
      'each trade. Currently positions.json only tracks the current open position; history ' +
      'shows all trades but no per-trade P&L roll-up.',
    evidence_template:
      'positions.json has entry.txid, entry.bch_spent_sats, exit.txid, exit.bch_received_sats ' +
      '— but no FIFO/LIFO cost basis tracking.',
    category_tags: ['observability', 'pnl', 'cost-basis'],
  },
  {
    template_id: 'tick_latency_histogram',
    title: 'Per-tick latency histogram in dashboard',
    category: 'observability',
    effort: 'S',
    impact: 'low',
    rationale_template:
      'Currently loop.tick logs total duration but the operator can\'t see latency ' +
      'distribution. A histogram of recent tick durations would surface performance ' +
      'regressions (e.g., when the indexer gets slow) at a glance.',
    evidence_template:
      'history.jsonl already records tick duration; needs aggregation + UI.',
    category_tags: ['observability', 'performance', 'dashboard'],
  },
  {
    template_id: 'swap_audit_trail_ui',
    title: 'Per-swap audit trail with full input/output breakdown',
    category: 'observability',
    effort: 'M',
    impact: 'medium',
    rationale_template:
      'Every swap writes a structured audit event but the dashboard doesn\'t surface the ' +
      'full per-swap breakdown (inputs, outputs, change, fee, slippage actual vs expected). ' +
      'A dedicated per-position audit trail tab would let the operator drill into any ' +
      'historical trade.',
    evidence_template:
      'history events already carry all the fields; needs a UI component that renders them ' +
      'in a structured view.',
    category_tags: ['observability', 'auditability'],
  },
  {
    template_id: 'wallet_balance_reconciliation',
    title: 'Wallet balance reconciliation: alert if positions vs on-chain differ',
    category: 'observability',
    effort: 'M',
    impact: 'high',
    rationale_template:
      'The bot\'s on-disk positions might not match the wallet\'s actual on-chain state ' +
      '(orphan positions, missed exits, bugs). A nightly reconciliation pass that compares ' +
      'positions.json vs wallet.listUtxos() and alerts on mismatches would surface ' +
      'integrity issues.',
    evidence_template:
      'pos_tlbiuvh6_0002 (FEW) was a real example — the position file thought it was open ' +
      'but the tokens were already sold. Reconciliation would have caught it within hours.',
    category_tags: ['observability', 'integrity', 't29-follow-up'],
  },
  {
    template_id: 'metric_export',
    title: 'Prometheus-style metric export for external monitoring',
    category: 'observability',
    effort: 'L',
    impact: 'medium',
    rationale_template:
      'External monitoring systems (Grafana, Datadog, etc.) want Prometheus / OpenMetrics ' +
      'format. Adding a /metrics endpoint exposing key counters (tick_count, entry_count, ' +
      'exit_count, error_count, bch_balance) would let the operator integrate with their ' +
      'existing monitoring stack.',
    evidence_template:
      'All the counters are already logged; need a thin text formatter for the ' +
      'Prometheus text format.',
    category_tags: ['observability', 'prometheus', 'integration'],
  },
  {
    template_id: 'log_rotation',
    title: 'Log rotation (compress history.jsonl when >N MB)',
    category: 'observability',
    effort: 'S',
    impact: 'low',
    rationale_template:
      'history.jsonl grows unbounded. At ~10 events/min, that\'s ~50MB/year — not huge, but ' +
      'a log-rotation policy (compress when >100MB, keep last 12 months) would prevent ' +
      'disk-fill surprises on small VPS.',
    evidence_template:
      'history.jsonl is currently 1.9 MB after 4 days of testing. At this rate it\'ll ' +
      'hit 100MB in ~7 months.',
    category_tags: ['observability', 'log-management'],
  },
  {
    template_id: 'health_endpoint_extended',
    title: 'Extended /healthz: bot liveness + last-tick age + wallet-utxo count',
    category: 'observability',
    effort: 'S',
    impact: 'medium',
    rationale_template:
      'Currently /healthz returns a static "ok" string. An expanded health endpoint ' +
      'reporting last-tick age, current open position count, wallet UTXO count, and ' +
      'circuit-breaker state would let external monitors detect stuck-bot conditions ' +
      'without scraping the dashboard.',
    evidence_template:
      'All the data is already in process memory; needs to be exposed via the existing ' +
      '/healthz route.',
    category_tags: ['observability', 'monitoring', 'healthz'],
  },

  // ─── performance (6) ────────────────────────────────────────────
  {
    template_id: 'cache_pool_discovery',
    title: 'Cache listTopTokens results for 30s to reduce indexer load',
    category: 'performance',
    effort: 'S',
    impact: 'low',
    rationale_template:
      'Every loop tick (~60s) hits the indexer for token discovery + per-token pool data. ' +
      'With 250+ tokens the indexer does ~500 HTTP requests per minute. A 30s in-memory ' +
      'cache would cut that to ~20/min, reducing indexer load and bot latency.',
    evidence_template:
      'fetcher.listTopTokens() and fetcher.listPools(tokenId) are uncached. Each tick ' +
      're-fetches everything.',
    category_tags: ['performance', 'caching', 't10-follow-up'],
  },
  {
    template_id: 'parallel_pool_fetches',
    title: 'Parallelize per-pool fetches with bounded concurrency',
    category: 'performance',
    effort: 'M',
    impact: 'medium',
    rationale_template:
      'Currently fetcher.listPools(tokenId) is awaited serially in the loop. With 10+ ' +
      'tokens per tick and ~3 pools each, that\'s 30 sequential HTTP requests. Bounded ' +
      'parallelism (e.g., 5 concurrent) would cut the discovery phase from 30s to 6s.',
    evidence_template:
      'Tick duration observations show fetcher phase dominating ~50% of total tick time.',
    category_tags: ['performance', 'parallelism', 't10-follow-up'],
  },
  {
    template_id: 'history_jsonl_compact',
    title: 'Compact history.jsonl by removing debug events older than 7d',
    category: 'performance',
    effort: 'S',
    impact: 'low',
    rationale_template:
      'history.jsonl contains high-frequency debug events (loop.tick, fetch.success) that ' +
      'age out of operator interest after a few days. A compaction pass that drops ' +
      'debug events older than 7d would keep the file lean without losing audit data.',
    evidence_template:
      '~80% of history.jsonl volume is loop.tick events; only the last few hundred are ' +
      'ever queried.',
    category_tags: ['performance', 'compaction'],
  },
  {
    template_id: 'snapshot_lazy_aggregate',
    title: 'Snapshot aggregation: compute P&L summaries in-memory instead of re-reading file',
    category: 'performance',
    effort: 'M',
    impact: 'medium',
    rationale_template:
      'The dashboard reads snapshots.jsonl every refresh to aggregate P&L. With 1000+ ' +
      'snapshots, that\'s a 50ms+ parse every refresh. Pre-computing rollups (1m, 5m, 1h, ' +
      '24h) in memory and only re-parsing new snapshots would cut the dashboard\'s render ' +
      'cost significantly.',
    evidence_template:
      'Dashboard refresh takes 200-400ms when snapshots is large; could be <50ms with ' +
      'incremental updates.',
    category_tags: ['performance', 'caching', 'dashboard'],
  },
  {
    template_id: 'reduce_indexer_payload',
    title: 'Indexer: only fetch fields the bot actually uses',
    category: 'performance',
    effort: 'S',
    impact: 'low',
    rationale_template:
      'The Cauldron indexer returns more fields than the bot uses (description, icon_url, ' +
      'social links). Filtering the response at the fetcher level would cut payload size ' +
      'and parse cost.',
    evidence_template:
      'listPools payload is ~5KB/token × 250 tokens = 1.25 MB per fetch. Filtering unused ' +
      'fields could cut that in half.',
    category_tags: ['performance', 'indexer'],
  },
  {
    template_id: 'snapshot_throttle_on_no_change',
    title: 'Skip snapshot writes when nothing changed (balance + positions identical)',
    category: 'performance',
    effort: 'S',
    impact: 'low',
    rationale_template:
      'Currently a snapshot is written every snapshot_interval_seconds (300s) regardless ' +
      'of whether anything changed. Skipping the write when balance + position count are ' +
      'identical would cut disk writes by ~80% in idle periods.',
    evidence_template:
      'In a typical day the bot may have <5 actual events but writes 288 snapshots. ' +
      '~280 of them are no-ops.',
    category_tags: ['performance', 'snapshots'],
  },
]);

/**
 * Validate every catalog entry at module load. Pure — runs once
 * at import; throws on the first malformed entry. Catches typos
 * at boot rather than at cron-time.
 */
function validateCatalog() {
  for (const t of RESEARCH_CATALOG) {
    if (typeof t.template_id !== 'string' || t.template_id.length === 0) {
      throw new Error(`catalog: template_id required (got ${JSON.stringify(t)})`);
    }
    if (typeof t.title !== 'string' || t.title.length === 0) {
      throw new Error(`catalog[${t.template_id}]: title required`);
    }
    if (!FEATURE_IDEAS_CATEGORIES.includes(t.category)) {
      throw new Error(`catalog[${t.template_id}]: bad category ${t.category}`);
    }
    if (!FEATURE_IDEAS_EFFORTS.includes(t.effort)) {
      throw new Error(`catalog[${t.template_id}]: bad effort ${t.effort}`);
    }
    if (!FEATURE_IDEAS_IMPACTS.includes(t.impact)) {
      throw new Error(`catalog[${t.template_id}]: bad impact ${t.impact}`);
    }
    if (typeof t.rationale_template !== 'string' || t.rationale_template.length === 0) {
      throw new Error(`catalog[${t.template_id}]: rationale_template required`);
    }
    if (typeof t.evidence_template !== 'string') {
      throw new Error(`catalog[${t.template_id}]: evidence_template must be string`);
    }
    if (!Array.isArray(t.category_tags)) {
      throw new Error(`catalog[${t.template_id}]: category_tags must be array`);
    }
  }
  // Dedupe template_ids — silently impossible to have duplicates
  // in source, but the dedupe check is cheap insurance.
  const ids = new Set();
  for (const t of RESEARCH_CATALOG) {
    if (ids.has(t.template_id)) {
      throw new Error(`catalog: duplicate template_id ${t.template_id}`);
    }
    ids.add(t.template_id);
  }
}
validateCatalog();