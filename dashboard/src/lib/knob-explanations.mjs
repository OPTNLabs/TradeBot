// dashboard/src/lib/knob-explanations.mjs
//
// T43 — Human-readable explanations for every knob the Settings
// view exposes, plus helpers that drive the "Save & Restart
// Required" warning banner.
//
// The catalog is intentionally framework-free (no React) so the
// dashboard test suite can lock its shape + helper behaviour with
// `node --test` without touching DOM globals — same pattern as
// `dashboard/src/lib/format.mjs` and `dashboard/src/views/*-helpers.mjs`.
//
// All knobs that the trading loop reads at boot time are flagged
// `restart: true` — `scripts/run-bot.mjs` calls `loadConfig()` once
// at startup (`src/util/config-loader.mjs`) and the live values are
// frozen in the `TradingLoop` instance for the lifetime of the
// process. Saving to `config/user.json` does NOT hot-reload the
// running loop. The Dashboard's own `bind_host` / `bind_port` etc.
// are also `restart: true` because the HTTP server is constructed
// once at boot.

/**
 * @typedef {Object} KnobMeta
 * @property {string} key          Dotted path (e.g. "scoring.weights.volume_24h_bch").
 * @property {string[]} path       Path segments (e.g. ["scoring","weights","volume_24h_bch"]).
 * @property {string} label        Operator-facing label (already in Settings.jsx today).
 * @property {string} unit         Human unit suffix: "BCH", "sats", "%", "bps", "h", "".
 * @property {boolean} restart     True if a bot restart is required for the new value to take effect.
 * @property {string} description  One-sentence explanation of what the knob does.
 * @property {string|null} [rangeHint] Optional "min..max / typical" hint string for the UI.
 * @property {string} group        Top-level config group ("scoring" | "entry" | "exit" | "risk" | "loop" | "dashboard").
 * @property {'number'|'boolean'|'text'} [kind='number'] Input type (drives validation + clamping).
 * @property {number} [min]        Inclusive lower bound (numeric only; absent = no lower bound).
 * @property {number} [max]        Inclusive upper bound (numeric only; absent = no upper bound).
 * @property {number} [step]       Optional step size used by the input + the validator. Falls back to the rendered `step` prop in Settings.jsx.
 */

/** @type {ReadonlyArray<KnobMeta>} */
export const KNOBS = Object.freeze([
  // ─── scoring.weights ───────────────────────────────────────────────
  { key: 'scoring.weights.volume_24h_bch',     path: ['scoring','weights','volume_24h_bch'],     label: 'volume_24h_bch',     unit: 'weight', restart: true, group: 'scoring',
    description: 'How much the 24-hour BCH volume contributes to a pool\'s score. Higher = the bot favours actively-traded pools.',
    kind: 'number', min: 0, max: 5, step: 0.01 },
  { key: 'scoring.weights.volume_7d_bch',      path: ['scoring','weights','volume_7d_bch'],      label: 'volume_7d_bch',      unit: 'weight', restart: true, group: 'scoring',
    description: 'How much the 7-day BCH volume contributes. Smooths out one-day spikes.',
    kind: 'number', min: 0, max: 5, step: 0.01 },
  { key: 'scoring.weights.volatility_24h_pct',  path: ['scoring','weights','volatility_24h_pct'], label: 'volatility_24h_pct', unit: 'weight', restart: true, group: 'scoring',
    description: 'Weight on 24h realised volatility. Higher = the bot chases volatile tokens (more risk + more upside).',
    kind: 'number', min: 0, max: 5, step: 0.01 },
  { key: 'scoring.weights.tvl_bch',            path: ['scoring','weights','tvl_bch'],            label: 'tvl_bch',           unit: 'weight', restart: true, group: 'scoring',
    description: 'Weight on TVL (total value locked). Rewards deeper pools that suffer less slippage on small trades.',
    kind: 'number', min: 0, max: 5, step: 0.01 },
  { key: 'scoring.weights.apy_30d_pct',        path: ['scoring','weights','apy_30d_pct'],        label: 'apy_30d_pct',       unit: 'weight', restart: true, group: 'scoring',
    description: 'Weight on the 30-day APY (fee yield). The bot is willing to pay a premium for high-yield pools.',
    kind: 'number', min: 0, max: 5, step: 0.01 },
  { key: 'scoring.weights.fee_yield_bps',      path: ['scoring','weights','fee_yield_bps'],      label: 'fee_yield_bps',     unit: 'weight', restart: true, group: 'scoring',
    description: 'Weight on the pool\'s fee yield in bps. Mirrors apy_30d_pct but at a finer resolution.',
    kind: 'number', min: 0, max: 5, step: 0.01 },
  { key: 'scoring.weights.upward_volatility',  path: ['scoring','weights','upward_volatility'],  label: 'upward_volatility', unit: 'weight', restart: true, group: 'scoring',
    description: 'Bonus weight on the "upward" component of 24h volatility (price went up). Rewards tokens whose 24h action was directionally positive.',
    kind: 'number', min: 0, max: 5, step: 0.01 },

  // ─── scoring.filters ──────────────────────────────────────────────
  { key: 'scoring.min_score',          path: ['scoring','min_score'],          label: 'min_score',          unit: '',        restart: true, group: 'scoring',
    description: 'Minimum score a pool must clear to enter the top-K shortlist. Raise to be pickier, lower to widen the universe.', rangeHint: '0..1 (typ. 0.2..0.5)',
    kind: 'number', min: 0, max: 1, step: 0.01 },
  { key: 'scoring.min_volume_7d_bch', path: ['scoring','min_volume_7d_bch'], label: 'min_volume_7d_bch', unit: 'BCH',      restart: true, group: 'scoring',
    description: 'T70-3 (operator 2026-09-20): hard floor on the trailing-7d BCH volume estimate. Pools below this are dropped before scoring. Replaces the broken `min_volume_24h_bch` gate (the Cauldron indexer doesn\'t expose a native 24h-volume field and the previous code silently read `trade_volume` — cumulative all-time — as 24h). The 7d volume is estimated from `price_series_7d` via `countPriceTransitions` (each transition × 1% of TVL). For a small BCH ecosystem that\'s still ramping, the 7d window is a fairer activity signal: gives a quiet token a chance to show a few trades over the week.',
    rangeHint: 'BCH (default: 0.05; small-balance startup: 0.05..0.3)',
    kind: 'number', min: 0, max: 10000, step: 0.001 },
  { key: 'scoring.min_volume_30d_bch', path: ['scoring','min_volume_30d_bch'], label: 'min_volume_30d_bch', unit: 'BCH',      restart: true, group: 'scoring',
    description: 'Hard floor on trailing-30d volume (proxy-derived from apy_30d_bp × tvl_sats / fee_rate_bps). Pools below this are dropped before scoring. T46b: primary volume gate (was min_volume_24h_bch). Set to 0 to disable.', rangeHint: 'BCH (small-balance default: 1.0)',
    kind: 'number', min: 0, max: 10000, step: 0.001 },
  { key: 'scoring.min_trade_count_24h', path: ['scoring','min_trade_count_24h'], label: 'min_trade_count_24h', unit: 'trades', restart: true, group: 'scoring',
    description: 'T44 staleness gate. Minimum 24h trade count a pool must have for the indexer\'s price_now_sats to be considered fresh. Tokens with fewer trades (including zero) are rejected before scoring. Defends against phantom-price entries like QBTC (trade_count=0 → price_now_sats=32.7B). Set to 0 to disable.', rangeHint: 'trades (small-balance default: 1)',
    kind: 'number', min: 0, max: 100000, step: 1 },
  { key: 'scoring.min_fee_yield_bps', path: ['scoring','min_fee_yield_bps'], label: 'min_fee_yield_bps', unit: 'bps/day', restart: true, group: 'scoring',
    description: 'T75 fee-yield floor. Minimum synthesized fee_yield_bps (trade_count × fee_rate_bps / max(tvl_sats, 1)) a pool must clear to be eligible. Pools below this drop before scoring. Catches low-fee-yield pools that have trade_count > min_trade_count_24h but aren\'t producing meaningful LP income relative to TVL. Set to 0 to disable.', rangeHint: 'bps/day (small-balance default: 10)',
    kind: 'number', min: 0, max: 10000, step: 0.1 },
  { key: 'scoring.min_tvl_bch',        path: ['scoring','min_tvl_bch'],        label: 'min_tvl_bch',        unit: 'BCH',      restart: true, group: 'scoring',
    description: 'Hard floor on pool TVL. Stops the bot from entering shallow pools where a single trade moves the price.', rangeHint: 'BCH (small-balance default: 0.25)',
    kind: 'number', min: 0, max: 10000, step: 0.001 },
  { key: 'scoring.max_pool_age_days',   path: ['scoring','max_pool_age_days'],   label: 'max_pool_age_days',  unit: 'days',     restart: true, group: 'scoring',
    description: 'Maximum age of the pool before the bot refuses to enter. Keeps the bot away from abandoned / rugged pools.', rangeHint: 'days (typ. 3..14)',
    kind: 'number', min: 1, max: 365, step: 1 },
  { key: 'scoring.top_k_candidates',    path: ['scoring','top_k_candidates'],    label: 'top_k_candidates',   unit: '',         restart: true, group: 'scoring',
    description: 'How many of the highest-scoring pools the loop evaluates per tick. Higher = more indexer load but more opportunities.', rangeHint: '1..10 (typ. 3..5)',
    kind: 'number', min: 1, max: 50, step: 1 },

  // ─── scoring.caps ────────────────────────────────────────────────
  { key: 'scoring.caps.volume_24h_bch', path: ['scoring','caps','volume_24h_bch'], label: 'volume_24h_bch cap', unit: 'BCH',  restart: true, group: 'scoring',
    description: 'Sigmoid cap on the volume_24h_bch contribution — past this BCH/day volume the term saturates.', rangeHint: 'BCH',
    kind: 'number', min: 0, max: 1000, step: 0.1 },
  { key: 'scoring.caps.volume_7d_bch',  path: ['scoring','caps','volume_7d_bch'],  label: 'volume_7d_bch cap',  unit: 'BCH',  restart: true, group: 'scoring',
    description: 'Sigmoid cap on the volume_7d_bch contribution.', rangeHint: 'BCH',
    kind: 'number', min: 0, max: 10000, step: 0.1 },
  { key: 'scoring.caps.tvl_bch',        path: ['scoring','caps','tvl_bch'],        label: 'tvl_bch cap',        unit: 'BCH',  restart: true, group: 'scoring',
    description: 'Sigmoid cap on the TVL contribution.', rangeHint: 'BCH',
    kind: 'number', min: 0, max: 1000, step: 0.1 },
  { key: 'scoring.linear_caps.volatility_24h_pct', path: ['scoring','linear_caps','volatility_24h_pct'], label: 'volatility_24h_pct cap', unit: '%',   restart: true, group: 'scoring',
    description: 'Linear cap on the volatility_24h_pct contribution (in %). Past this % the term saturates.', rangeHint: '% (typ. 20..50)',
    kind: 'number', min: 1, max: 500, step: 1 },
  { key: 'scoring.linear_caps.apy_30d_pct',         path: ['scoring','linear_caps','apy_30d_pct'],         label: 'apy_30d_pct cap',         unit: '%',   restart: true, group: 'scoring',
    description: 'Linear cap on the apy_30d_pct contribution (in %).', rangeHint: '% (typ. 100..300)',
    kind: 'number', min: 1, max: 5000, step: 1 },
  { key: 'scoring.linear_caps.fee_yield_bps',       path: ['scoring','linear_caps','fee_yield_bps'],       label: 'fee_yield_bps cap',       unit: 'bps', restart: true, group: 'scoring',
    description: 'Linear cap on the fee_yield_bps contribution (in bps).', rangeHint: 'bps',
    kind: 'number', min: 1, max: 10000, step: 1 },

  // ─── entry ──────────────────────────────────────────────────────
  { key: 'entry.min_trade_size_bch',             path: ['entry','min_trade_size_bch'],             label: 'min_trade_size_bch',         unit: 'BCH', restart: true, group: 'entry',
    description: 'Minimum BCH spent per trade. Skips dust trades that would not cover AMM fees.', rangeHint: 'BCH (typ. 0.0005..0.001)',
    kind: 'number', min: 0.00001, max: 0.01, step: 0.0001 },
  { key: 'entry.max_position_bch',               path: ['entry','max_position_bch'],               label: 'max_position_bch',           unit: 'BCH', restart: true, group: 'entry',
    description: 'Hard cap on BCH spent on a single position. The trader will NEVER spend more than this on one trade. Small-balance default: 0.005 BCH (≈10-12% of wallet).', rangeHint: 'BCH (small-balance default: 0.005 ≈ 10-12% of wallet)',
    kind: 'number', min: 0.0001, max: 1.0, step: 0.0001 },
  { key: 'entry.max_total_exposure_bch',         path: ['entry','max_total_exposure_bch'],         label: 'max_total_exposure_bch',     unit: 'BCH', restart: true, group: 'entry',
    description: 'Hard cap on the sum of BCH across ALL open positions. Prevents the bot from being fully deployed in many tiny positions.', rangeHint: 'BCH (small-balance default: 0.04)',
    kind: 'number', min: 0.001, max: 5.0, step: 0.0001 },
  { key: 'entry.slippage_tolerance_bps',         path: ['entry','slippage_tolerance_bps'],         label: 'slippage_tolerance_bps',     unit: 'bps', restart: true, group: 'entry',
    description: 'Max slippage (in bps) the bot tolerates between expected and actual fill. Trades worse than this are auto-evicted post-broadcast.', rangeHint: 'bps (small AMM: 100 = 1%)',
    kind: 'number', min: 10, max: 1000, step: 1 },
  { key: 'entry.entry_price_max_deviation_pct',  path: ['entry','entry_price_max_deviation_pct'],  label: 'entry_price_max_deviation_pct', unit: '%', restart: true, group: 'entry',
    description: 'Max %-deviation between indexer-reported price and the on-chain AMM spot price before the trade is rejected.', rangeHint: '% (typ. 1..5)',
    kind: 'number', min: 0.1, max: 50, step: 0.1 },
  { key: 'entry.min_amm_total_depth_sats',       path: ['entry','min_amm_total_depth_sats'],       label: 'min_amm_total_depth_sats',   unit: 'sats', restart: true, group: 'entry',
    description: 'Minimum combined AMM depth (in sats) required to enter. Pools shallower than this get skipped — your trade would dominate the price.', rangeHint: 'sats (typ. 100M..300M)',
    kind: 'number', min: 1000000, max: 10000000000, step: 1000000 },
  { key: 'entry.max_indexer_vs_amm_ratio_x',     path: ['entry','max_indexer_vs_amm_ratio_x'],     label: 'max_indexer_vs_amm_ratio_x', unit: 'x',   restart: true, group: 'entry',
    description: 'Max multiple by which the indexer-reported price may exceed the on-chain AMM price. Above this, the trade is treated as a stale-data red flag and skipped.', rangeHint: 'x (typ. 100..1000)',
    kind: 'number', min: 1, max: 100000, step: 1 },
  { key: 'entry.max_position_concentration_pct', path: ['entry','max_position_concentration_pct'], label: 'max_position_concentration_pct', unit: '%', restart: true, group: 'entry',
    description: 'Maximum % of the wallet the bot will commit to a single position. Caps concentration risk.', rangeHint: '% (typ. 10..50)',
    kind: 'number', min: 1, max: 100, step: 0.1 },
  { key: 'entry.volatility_sizing_target_pct',   path: ['entry','volatility_sizing_target_pct'],   label: 'volatility_sizing_target_pct', unit: '%', restart: true, group: 'entry',
    description: 'Kelly-lite position-sizing target: position size is set so the expected 24h volatility move roughly equals this % of wallet. Lower = more conservative.', rangeHint: '% (typ. 2..10)',
    kind: 'number', min: 0.1, max: 50, step: 0.1 },
  { key: 'entry.correlation_skip_threshold',     path: ['entry','correlation_skip_threshold'],     label: 'correlation_skip_threshold', unit: '',   restart: true, group: 'entry',
    description: 'Skip a candidate if its recent P&L correlation with currently-open positions exceeds this (0..1). -1 disables the gate.', rangeHint: '0..1 (typ. 0.7..0.9) or -1',
    kind: 'number', min: -1, max: 1, step: 0.05 },
  { key: 'entry.min_pool_age_days',              path: ['entry','min_pool_age_days'],              label: 'min_pool_age_days',         unit: 'days', restart: true, group: 'entry',
    description: 'Skip pools younger than this many days. Protects against brand-new / soft-launched rugs. -1 disables the gate.', rangeHint: 'days (typ. 1..7) or -1',
    kind: 'number', min: -1, max: 365, step: 1 },
  { key: 'entry.use_post_trade_check',           path: ['entry','use_post_trade_check'],           label: 'use_post_trade_check',      unit: '',   restart: true, group: 'entry',
    description: 'If true, run post_trade_check after every broadcast to verify the effective rate is within slippage_tolerance_bps. Auto-evicts positions that fail.', rangeHint: 'boolean',
    kind: 'boolean' },

  // ─── exit ──────────────────────────────────────────────────────
  { key: 'exit.take_profit_pct',                path: ['exit','take_profit_pct'],                label: 'take_profit_pct',                  unit: '%',   restart: true, group: 'exit',
    description: 'Sell when price rises this much above entry. Used as the FIXED TP unless tp_vol_multiplier > 0.', rangeHint: '% (typ. 3..10)',
    kind: 'number', min: 0.1, max: 100, step: 0.1 },
  { key: 'exit.stop_loss_pct',                  path: ['exit','stop_loss_pct'],                  label: 'stop_loss_pct',                    unit: '%',   restart: true, group: 'exit',
    description: 'Sell when price drops this much below entry. Used as the FIXED SL unless sl_vol_multiplier > 0.', rangeHint: '% (typ. 2..5)',
    kind: 'number', min: 0.1, max: 50, step: 0.1 },
  { key: 'exit.time_stop_hours',                path: ['exit','time_stop_hours'],                label: 'time_stop_hours',                  unit: 'h',   restart: true, group: 'exit',
    description: 'Force-close a position after this many hours if no TP/SL fired. Drives turnover for small wallets.', rangeHint: 'h (small-balance default: 24)',
    kind: 'number', min: 1, max: 720, step: 1 },
  { key: 'exit.time_stop_hours_synced',         path: ['exit','time_stop_hours_synced'],         label: 'time_stop_hours_synced',           unit: 'h',   restart: true, group: 'exit',
    description: 'Tighter time-stop applied to chain-synced positions (older, larger notional). Lower than time_stop_hours.', rangeHint: 'h (typ. 4..12)',
    kind: 'number', min: 1, max: 720, step: 1 },
  { key: 'exit.trailing_stop_pct',              path: ['exit','trailing_stop_pct'],              label: 'trailing_stop_pct',                unit: '%',   restart: true, group: 'exit',
    description: 'Once trailing_stop_activation_pct is hit, sell if price drops this % from the high water mark.', rangeHint: '% (typ. 1..3)',
    kind: 'number', min: 0.1, max: 50, step: 0.1 },
  { key: 'exit.trailing_stop_activation_pct',   path: ['exit','trailing_stop_activation_pct'],   label: 'trailing_stop_activation_pct',     unit: '%',   restart: true, group: 'exit',
    description: 'Trailing stop only arms after price has risen this much above entry.', rangeHint: '% (typ. 1..3)',
    kind: 'number', min: 0.1, max: 50, step: 0.1 },
  { key: 'exit.max_price_vs_entry_ratio_x',     path: ['exit','max_price_vs_entry_ratio_x'],     label: 'max_price_vs_entry_ratio_x',       unit: 'x',   restart: true, group: 'exit',
    description: 'Hard ceiling on the price-vs-entry ratio. A position whose price grew > this multiple auto-closes (anti-moonshot / oracle error guard).', rangeHint: 'x (typ. 50..1000)',
    kind: 'number', min: 1, max: 100000, step: 1 },
  { key: 'exit.tp_vol_multiplier',              path: ['exit','tp_vol_multiplier'],              label: 'tp_vol_multiplier',                unit: 'σ',   restart: true, group: 'exit',
    description: 'Multiplier on 7d realised volatility for the dynamic TP. TP = tp_vol_multiplier × σ7d, clamped by tp_vol_floor/ceiling. 0 disables (fixed TP).', rangeHint: 'σ (typ. 1.5..3.0) or 0',
    kind: 'number', min: 0, max: 10, step: 0.1 },
  { key: 'exit.sl_vol_multiplier',              path: ['exit','sl_vol_multiplier'],              label: 'sl_vol_multiplier',                unit: 'σ',   restart: true, group: 'exit',
    description: 'Multiplier on 7d realised volatility for the dynamic SL. 0 disables (fixed SL).', rangeHint: 'σ (typ. 1.0..2.0) or 0',
    kind: 'number', min: 0, max: 10, step: 0.1 },
  { key: 'exit.tp_vol_floor_pct',               path: ['exit','tp_vol_floor_pct'],               label: 'tp_vol_floor_pct',                 unit: '%',   restart: true, group: 'exit',
    description: 'Minimum dynamic TP — even if σ7d × tp_vol_multiplier is tiny, the TP will not be tighter than this.', rangeHint: '% (typ. 1..3)',
    kind: 'number', min: 0.1, max: 50, step: 0.1 },
  { key: 'exit.tp_vol_ceiling_pct',             path: ['exit','tp_vol_ceiling_pct'],             label: 'tp_vol_ceiling_pct',               unit: '%',   restart: true, group: 'exit',
    description: 'Maximum dynamic TP — even if σ7d × tp_vol_multiplier is huge, the TP will not be wider than this.', rangeHint: '% (typ. 50..100)',
    kind: 'number', min: 1, max: 500, step: 1 },
  { key: 'exit.sl_vol_floor_pct',               path: ['exit','sl_vol_floor_pct'],               label: 'sl_vol_floor_pct',                 unit: '%',   restart: true, group: 'exit',
    description: 'Minimum dynamic SL.', rangeHint: '% (typ. 1..2)',
    kind: 'number', min: 0.1, max: 50, step: 0.1 },
  { key: 'exit.sl_vol_ceiling_pct',             path: ['exit','sl_vol_ceiling_pct'],             label: 'sl_vol_ceiling_pct',               unit: '%',   restart: true, group: 'exit',
    description: 'Maximum dynamic SL.', rangeHint: '% (typ. 20..50)',
    kind: 'number', min: 1, max: 500, step: 1 },

  // ─── risk ──────────────────────────────────────────────────────
  { key: 'risk.max_daily_loss_bch',             path: ['risk','max_daily_loss_bch'],             label: 'max_daily_loss_bch',              unit: 'BCH', restart: true, group: 'risk',
    description: 'Hard circuit breaker — bot stops opening new positions once realized losses today exceed this BCH.', rangeHint: 'BCH (small-balance default: 0.005)',
    kind: 'number', min: 0, max: 1, step: 0.0001 },
  { key: 'risk.min_wallet_balance_bch',         path: ['risk','min_wallet_balance_bch'],         label: 'min_wallet_balance_bch',          unit: 'BCH', restart: true, group: 'risk',
    description: 'Always keep at least this much BCH in the wallet — protects against tx-fee starvation when prices are bad.', rangeHint: 'BCH (small-balance default: 0.005)',
    kind: 'number', min: 0, max: 0.1, step: 0.0001 },
  { key: 'risk.consecutive_loss_limit',         path: ['risk','consecutive_loss_limit'],         label: 'consecutive_loss_limit',          unit: '',   restart: true, group: 'risk',
    description: 'Open the circuit breaker after this many consecutive losing exits (not used in current build — see risk.max_consecutive_losses).', rangeHint: '1..10',
    kind: 'number', min: 1, max: 50, step: 1 },
  { key: 'risk.loss_cooldown_minutes',          path: ['risk','loss_cooldown_minutes'],          label: 'loss_cooldown_minutes',           unit: 'min', restart: true, group: 'risk',
    description: 'Pause opening NEW entries for this many minutes after a stop-loss fires. 0 disables the cooldown.', rangeHint: 'min (typ. 15..60) or 0',
    kind: 'number', min: 0, max: 1440, step: 1 },

  // ─── loop ──────────────────────────────────────────────────────
  { key: 'loop.poll_interval_seconds',          path: ['loop','poll_interval_seconds'],          label: 'poll_interval_seconds',           unit: 's',  restart: true, group: 'loop',
    description: 'Seconds between trading-loop ticks (discovery + entry + exit). Lower = more responsive but more indexer load.', rangeHint: 's (typ. 30..120)',
    kind: 'number', min: 5, max: 3600, step: 1 },
  { key: 'loop.tick_timeout_seconds',           path: ['loop','tick_timeout_seconds'],           label: 'tick_timeout_seconds',            unit: 's',  restart: true, group: 'loop',
    description: 'Hard timeout for a single tick. If exceeded, the tick is aborted and the loop sleeps until the next interval.', rangeHint: 's (typ. 30..120)',
    kind: 'number', min: 5, max: 600, step: 1 },

  // ─── dashboard ─────────────────────────────────────────────────
  { key: 'dashboard.bind_host',                 path: ['dashboard','bind_host'],                 label: 'bind_host',                       unit: '',   restart: true, group: 'dashboard',
    description: 'HTTP server bind host. 127.0.0.1 = local-only; 0.0.0.0 = exposed (combine with auth!).', rangeHint: 'IP / hostname',
    kind: 'text' },
  { key: 'dashboard.bind_port',                 path: ['dashboard','bind_port'],                 label: 'bind_port',                       unit: '',   restart: true, group: 'dashboard',
    description: 'HTTP server port. Make sure your firewall / reverse-proxy matches.', rangeHint: '1024..65535',
    kind: 'number', min: 1024, max: 65535, step: 1 },
  { key: 'dashboard.request_timeout_ms',        path: ['dashboard','request_timeout_ms'],        label: 'request_timeout_ms',              unit: 'ms', restart: true, group: 'dashboard',
    description: 'Per-request timeout for the dashboard backend. Prevents stale long-polls from holding a worker.', rangeHint: 'ms (typ. 5000..30000)',
    kind: 'number', min: 100, max: 60000, step: 100 },
  { key: 'dashboard.cors_origin',               path: ['dashboard','cors_origin'],               label: 'cors_origin',                     unit: '',   restart: true, group: 'dashboard',
    description: 'CORS origin allowlist (null = same-origin only). Use a full URL like "https://bot.example.com" to allow the SPA to be served cross-origin.', rangeHint: 'null or URL',
    kind: 'text' },

  // ─── dex (T57-3 Settings UI) ─────────────────────────────────────────
  // The dex.* knobs let the operator toggle which DEX adapters
  // the loop boots per tick. `dex.active` is an array of ids from
  // `listKnownDexIds()` (currently 'cauldron', 'cauldron_safe_mode',
  // 'guanaco'); the Settings view renders each one as a checkbox.
  // `dex.safe_mode_active` is a single boolean toggle for the
  // known-good offline backup adapter. Only `dex.safe_mode_active`
  // is registered as a typed knob here (boolean); the array shape
  // is enforced on the backend by `resolveDexConfig(cfg)`.
  { key: 'dex.safe_mode_active',                path: ['dex','safe_mode_active'],                label: 'dex.safe_mode_active',            unit: '',   restart: true, group: 'dex',
    description: 'T57-3. When true, the loop ALSO boots `cauldron_safe_mode` (a known-good offline backup) in addition to the adapters in `dex.active`. Safe-mode wins the tie-break on equal rates so the operator has a kill-switch back to the cached pool list when the live indexer is misbehaving. Default false.', rangeHint: 'boolean (default: false)',
    kind: 'boolean' },
]);

/**
 * Build a quick-lookup map from `path` array → KnobMeta.
 * @returns {ReadonlyMap<string, KnobMeta>}
 */
function buildPathIndex() {
  const m = new Map();
  for (const k of KNOBS) m.set(k.path.join('.'), k);
  return m;
}

const PATH_INDEX = buildPathIndex();

/**
 * Look up the knob metadata for a dotted-or-array path. Returns
 * `null` when no metadata is registered (e.g. for paths the
 * catalog hasn't been told about yet — should not happen for
 * Settings.jsx-rendered knobs but kept tolerant).
 *
 * @param {string|string[]} p
 * @returns {KnobMeta|null}
 */
export function lookupKnobMeta(p) {
  const key = Array.isArray(p) ? p.join('.') : p;
  return PATH_INDEX.get(key) ?? null;
}

/**
 * Return every knob key that requires a bot restart for changes
 * to take effect. Defaults to the full catalog when no `keys`
 * arg is given.
 *
 * @param {ReadonlyArray<string>} [keys]
 * @returns {string[]}
 */
export function knobsRequiringRestart(keys) {
  const out = [];
  for (const k of KNOBS) {
    if (!k.restart) continue;
    if (!keys || keys.includes(k.key)) out.push(k.key);
  }
  return out;
}

/**
 * Compute a structured summary of which dirty knobs require a
 * restart vs which would (hypothetically) take effect on the
 * next tick. Today every knob in the catalog is restart-gated,
 * so this is the source of truth that drives the banner copy.
 *
 * Output shape:
 *   { restartCount, nextTickCount, restartKeys, nextTickKeys,
 *     allRestart: boolean }
 *
 * @param {ReadonlyArray<string>} dirtyKeys
 * @returns {{
 *   restartCount:number,
 *   nextTickCount:number,
 *   restartKeys:string[],
 *   nextTickKeys:string[],
 *   allRestart:boolean
 * }}
 */
export function summarizeKnobImpact(dirtyKeys) {
  const restartKeys = [];
  const nextTickKeys = [];
  for (const k of dirtyKeys) {
    const meta = lookupKnobMeta(k);
    if (!meta) {
      // Unknown knob — preserve the conservative assumption: a
      // bot restart is required, since we can't prove otherwise.
      restartKeys.push(k);
      continue;
    }
    if (meta.restart) restartKeys.push(k);
    else nextTickKeys.push(k);
  }
  return {
    restartCount: restartKeys.length,
    nextTickCount: nextTickKeys.length,
    restartKeys,
    nextTickKeys,
    allRestart: nextTickKeys.length === 0 && restartKeys.length > 0,
  };
}

/**
 * Render the save-success banner copy. Returns a single line +
 * optional second-line "which knobs need restart" for the case
 * the operator wants to copy a checklist. The wording is
 * deliberately honest: today every Settings knob is restart-gated
 * because the bot loads config once at startup.
 *
 * @param {{restartCount:number, nextTickCount:number, allRestart:boolean}} summary
 * @param {Object} [opts]
 * @param {number} [opts.maxList=5] Cap the "Knobs needing restart" list to N entries.
 * @returns {{ headline:string, detail:string|null }}
 */
export function renderRestartBanner(summary, opts = {}) {
  const { restartCount, nextTickCount, allRestart } = summary;
  const maxList = Number.isFinite(opts.maxList) ? Math.max(0, opts.maxList | 0) : 5;

  if (restartCount === 0 && nextTickCount === 0) {
    return {
      headline: '✓ settings saved — no knobs changed.',
      detail: null,
    };
  }
  if (allRestart) {
    const headline = `✓ settings saved — ${restartCount === 1 ? '1 knob' : `${restartCount} knobs`} need a bot restart to take effect.`;
    if (restartCount <= maxList) {
      return {
        headline,
        detail: `Knobs needing restart: ${summary.restartKeys.join(', ')}`,
      };
    }
    const shown = summary.restartKeys.slice(0, maxList).join(', ');
    const remaining = restartCount - maxList;
    return {
      headline,
      detail: `Knobs needing restart: ${shown}, …and ${remaining} more.`,
    };
  }
  // Mixed (rare today; kept for forward-compat).
  const headline = `✓ settings saved — ${restartCount} need restart, ${nextTickCount} take effect next tick.`;
  return {
    headline,
    detail: null,
  };
}

// ─── T43b: Validation + search helpers ───────────────────────────────────────────────
//
// The catalog is the single source of truth for: which knobs are
// numeric / boolean / text, what their min/max bounds are, and
// what step they accept. Settings.jsx calls `validateKnobValue`
// on every keystroke so the operator sees a red ⚠ + a one-liner
// explaining why a value was rejected, BEFORE the server-side
// `PUT /api/config` 400 round-trip. `searchKnobs` powers the
// per-knob search/filter input at the top of the Settings view.
//
// All helpers are framework-free (no React) so the dashboard
// test suite locks their behaviour with `node --test` only —
// same pattern as `lookupKnobMeta` / `summarizeKnobImpact`.

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} ok           True iff the value passes all catalog-driven checks.
 * @property {*} normalized         The value coerced into the catalog-expected JS type. For `ok: true` it equals the original; for `ok: false` it equals `value` (kept as-is so the operator sees their input echoed back).
 * @property {string|null} message  Operator-facing one-liner explaining why the value was rejected (`null` when `ok` is true).
 * @property {'ok'|'below_min'|'above_max'|'nan'|'wrong_type'|'empty_text'|'not_integer'} reason  Machine-readable rejection reason.
 * @property {number|null} [min]    Echo of the meta's `min` (so the UI doesn't need to re-look it up).
 * @property {number|null} [max]    Echo of the meta's `max`.
 */

/**
 * Validate a form value against a knob's catalog metadata.
 *
 * Behaviour by `kind`:
 *   • number — accepts finite numbers; rejects NaN, Infinity,
 *     non-numbers. Honors min/max (inclusive). Honors `step`
 *     when the meta specifies one (loose: rejects values that
 *     don't sit on a `step`-sized grid within tolerance).
 *   • boolean — coerces truthy/falsy input; rejects strings that
 *     aren't 'true' / 'false'. Returns the coerced boolean in
 *     `normalized`.
 *   • text — rejects empty strings. No length cap.
 *
 * @param {KnobMeta|null} meta
 * @param {*} value
 * @returns {ValidationResult}
 */
export function validateKnobValue(meta, value) {
  if (!meta) {
    // Unknown knob — don't block the operator; we have no
    // bounds to check against. Pass it through with a generic
    // "ok" so the UI doesn't nag about catalog gaps.
    return { ok: true, normalized: value, message: null, reason: 'ok' };
  }
  const kind = meta.kind ?? 'number';
  if (kind === 'boolean') {
    if (typeof value === 'boolean') return { ok: true, normalized: value, message: null, reason: 'ok' };
    if (value === 'true')  return { ok: true, normalized: true,  message: null, reason: 'ok' };
    if (value === 'false') return { ok: true, normalized: false, message: null, reason: 'ok' };
    return {
      ok: false,
      normalized: value,
      message: 'value must be true or false',
      reason: 'wrong_type',
    };
  }
  if (kind === 'text') {
    if (typeof value === 'string') {
      if (value.length === 0) {
        return { ok: false, normalized: value, message: 'value cannot be empty', reason: 'empty_text' };
      }
      return { ok: true, normalized: value, message: null, reason: 'ok' };
    }
    return {
      ok: false,
      normalized: value,
      message: 'value must be a string',
      reason: 'wrong_type',
    };
  }
  // kind === 'number'
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    return {
      ok: false,
      normalized: value,
      message: 'value must be a number',
      reason: 'nan',
      min: Number.isFinite(meta.min) ? meta.min : null,
      max: Number.isFinite(meta.max) ? meta.max : null,
    };
  }
  if (Number.isFinite(meta.min) && n < meta.min) {
    return {
      ok: false,
      normalized: value,
      message: `value must be ≥ ${meta.min}`,
      reason: 'below_min',
      min: meta.min,
      max: Number.isFinite(meta.max) ? meta.max : null,
    };
  }
  if (Number.isFinite(meta.max) && n > meta.max) {
    return {
      ok: false,
      normalized: value,
      message: `value must be ≤ ${meta.max}`,
      reason: 'above_max',
      min: Number.isFinite(meta.min) ? meta.min : null,
      max: meta.max,
    };
  }
  // Loose step check: reject values that don't sit on a `step`-sized
  // grid within a 1e-9 relative tolerance (handles 0.0001 / 0.01 / 1).
  if (Number.isFinite(meta.step) && meta.step > 0 && Number.isFinite(meta.min)) {
    const offset = n - meta.min;
    const remainder = Math.abs(offset - Math.round(offset / meta.step) * meta.step);
    const tolerance = Math.max(1e-9, Math.abs(meta.step) * 1e-9);
    if (remainder > tolerance) {
      return {
        ok: false,
        normalized: value,
        message: `value must be a multiple of ${meta.step} (nearest: ${meta.min + Math.round(offset / meta.step) * meta.step})`,
        reason: 'not_integer',
        min: meta.min,
        max: Number.isFinite(meta.max) ? meta.max : null,
      };
    }
  }
  return {
    ok: true,
    normalized: n,
    message: null,
    reason: 'ok',
    min: Number.isFinite(meta.min) ? meta.min : null,
    max: Number.isFinite(meta.max) ? meta.max : null,
  };
}

/**
 * Clamp a numeric value to the catalog-driven min/max. Non-numeric
 * and unbounded values pass through unchanged. The Settings view
 * calls this on input blur so an out-of-range value snaps back
 * into the safe envelope instead of being sent to the server.
 *
 * @param {KnobMeta|null} meta
 * @param {number} value
 * @returns {number} The clamped value, or `value` unchanged when no bounds apply.
 */
export function clampKnobValue(meta, value) {
  if (!meta) return value;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return value;
  let out = n;
  if (Number.isFinite(meta.min) && out < meta.min) out = meta.min;
  if (Number.isFinite(meta.max) && out > meta.max) out = meta.max;
  return out;
}

/**
 * Build a one-line "safe range" hint for a knob. Falls back to the
 * catalog's `rangeHint` when the bounds are too wide to be useful.
 *
 * @param {KnobMeta} meta
 * @returns {string|null}
 */
export function renderRangeHint(meta) {
  if (!meta) return null;
  if (Number.isFinite(meta.min) && Number.isFinite(meta.max)) {
    return `range: ${meta.min} … ${meta.max}${meta.unit && meta.unit !== '' ? ` ${meta.unit}` : ''}`;
  }
  return meta.rangeHint ?? null;
}

/**
 * Normalize a search query by stripping whitespace + lowercasing
 * + splitting on non-word boundaries. Internal helper used by
 * `searchKnobs`.
 *
 * @param {string} q
 * @returns {string[]}
 */
function tokenizeQuery(q) {
  if (typeof q !== 'string') return [];
  return q.toLowerCase().split(/[\s,._/-]+/).map((t) => t.trim()).filter((t) => t.length > 0);
}

/**
 * Score how well a single knob matches a tokenised query. Returns
 * `null` when the knob doesn't match at all (caller drops it),
 * otherwise a non-negative score (higher = better match).
 *
 * Ranking (highest wins):
 *   100 — exact label match
 *   80  — label prefix match
 *   60  — label substring match
 *   50  — key suffix match (e.g. query "max_position_bch" → key "entry.max_position_bch")
 *   40  — key substring match
 *   30  — group exact match
 *   20  — group substring match
 *   10  — token appears anywhere in label/key/group concatenated
 *
 * Multi-token queries require EVERY token to match somewhere
 * across {label, key, group}; per-token scores are summed.
 *
 * @param {KnobMeta} knob
 * @param {string[]} tokens  Already-lowercased, non-empty query tokens.
 * @returns {number|null}
 */
function scoreKnob(knob, tokens) {
  if (tokens.length === 0) return 1; // empty query matches everything with neutral score
  const label = knob.label.toLowerCase();
  const key = knob.key.toLowerCase();
  const group = (knob.group || '').toLowerCase();
  const haystack = `${label} ${key} ${group}`;
  let total = 0;
  for (const t of tokens) {
    let best = null;
    if (label === t) best = 100;
    else if (label.startsWith(t)) best = Math.max(best ?? 0, 80);
    else if (label.includes(t)) best = Math.max(best ?? 0, 60);
    if (key.endsWith(`.${t}`) || key === t) best = Math.max(best ?? 0, 50);
    else if (key.includes(t)) best = Math.max(best ?? 0, 40);
    if (group === t) best = Math.max(best ?? 0, 30);
    else if (group.includes(t)) best = Math.max(best ?? 0, 20);
    if (best === null) {
      // Last-resort: token anywhere in the concatenated haystack
      // (still keeps multi-token semantics AND-only).
      if (haystack.includes(t)) best = 10;
      else return null; // token missing entirely → no match
    }
    total += best;
  }
  return total;
}

/**
 * Fuzzy-search the knob catalog. Returns the catalog entries that
 * match `query`, ordered by relevance (best match first, ties
 * broken by original catalog position so the operator sees a
 * stable ordering).
 *
 * Multi-token queries require every token to match somewhere
 * across `label` / `key` / `group` — there's no implicit AND vs
 * OR footgun. An empty query returns the full catalog in its
 * original order.
 *
 * @param {string} query
 * @param {ReadonlyArray<KnobMeta>} [knobs]  Defaults to the global catalog.
 * @returns {KnobMeta[]}
 */
export function searchKnobs(query, knobs) {
  const source = Array.isArray(knobs) ? knobs : KNOBS;
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return source.slice();
  const scored = [];
  for (let i = 0; i < source.length; i++) {
    const s = scoreKnob(source[i], tokens);
    if (s !== null) scored.push({ idx: i, score: s, knob: source[i] });
  }
  scored.sort((a, b) => (b.score - a.score) || (a.idx - b.idx));
  return scored.map((x) => x.knob);
}

/**
 * Group knobs by their `group` field, preserving the original
 * catalog order within each group. Used by the Settings view to
 * render the 7 panels (scoring / entry / exit / risk / loop /
 * dashboard / dex) with a stable order. The dex panel was added
 * in T57-3 (Settings UI toggle for the multi-DEX routing layer
 * shipped in `src/trader/dex-router.mjs` + `src/trader/loop.mjs`).
 *
 * @param {ReadonlyArray<KnobMeta>} knobs
 * @returns {Array<{group:string, knobs:KnobMeta[]}>}
 */
export function groupKnobsByPanel(knobs) {
  /** @type {Map<string, KnobMeta[]>} */
  const m = new Map();
  const KNOWN = new Set(['scoring', 'entry', 'exit', 'risk', 'loop', 'dashboard', 'dex']);
  for (const k of knobs) {
    const g = KNOWN.has(k.group) ? k.group : 'other';
    if (!m.has(g)) m.set(g, []);
    m.get(g).push(k);
  }
  return Array.from(m.entries()).map(([group, ks]) => ({ group, knobs: ks }));
}

// ─── T43c: default-value lookup + help popover payload ───────────
//
// The Settings view needs two new affordances per knob:
//   (a) a one-click "reset this knob to its config/default.json
//       baseline" link, and
//   (b) a hover/focus help popover that surfaces the FULL catalog
//       entry for the knob so the operator doesn't have to scroll
//       back to the catalog source.
//
// Both are pure helpers — no React, no fetch, no side effects. The
// Settings.jsx render path calls `defaultValueAtPath(defaultConfig,
// path)` to fetch the baseline and `buildHelpPopover(meta, opts)`
// to assemble the structured popover content. Tests lock every
// branch of both helpers so a future refactor can't silently drop
// them.

/**
 * Look up the canonical baseline value at a knob's path inside the
 * loaded `config/default.json` object. The Settings view passes the
 * JSON object (parsed once on app boot) so the lookup is O(depth)
 * and side-effect free.
 *
 * Behaviour:
 *   • Walks `path` segment-by-segment. Each segment must be a
 *     non-empty string; the lookup returns `{ found:false }` for
 *     the first missing/undefined segment so the caller can decide
 *     whether to disable the reset link (a missing default = the
 *     catalog and default.json are out of sync — surface that as a
 *     warning, don't crash).
 *   • Returns the *exact* JSON value (booleans stay booleans,
 *     numbers stay numbers, arrays stay arrays). Callers that need
 *     a display string should use `formatJsonValue(value)` below.
 *   • Rejects array indices (`["0"]`, `[1]`) with `{ found:false }`
 *     because the catalog's `path` field is always a string-keyed
 *     dotted path — never array-indexed.
 *
 * Pure. Exported for tests + for any future caller that needs to
 * know the baseline (e.g. an audit screen showing "operator value
 * vs baseline").
 *
 * @param {unknown} defaultConfig  The parsed `config/default.json` object.
 * @param {string[]|string} p      Path segments OR a dotted string.
 * @returns {{ found:true, value:unknown } | { found:false, reason:string }}
 */
export function defaultValueAtPath(defaultConfig, p) {
  if (defaultConfig === null || typeof defaultConfig !== 'object' || Array.isArray(defaultConfig)) {
    return { found: false, reason: 'default_config_not_an_object' };
  }
  const segments = Array.isArray(p)
    ? p
    : (typeof p === 'string' ? p.split('.') : []);
  const clean = [];
  for (const s of segments) {
    if (typeof s !== 'string' || s.length === 0) {
      return { found: false, reason: 'invalid_path_segment' };
    }
    if (/^\d+$/.test(s)) {
      // numeric string → array index; catalog paths are never
      // array-indexed so this is always a config-vs-catalog drift
      // signal rather than a real lookup.
      return { found: false, reason: 'array_index_not_supported' };
    }
    clean.push(s);
  }
  if (clean.length === 0) return { found: false, reason: 'empty_path' };
  let cursor = /** @type {any} */ (defaultConfig);
  for (const seg of clean) {
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) {
      return { found: false, reason: 'path_through_non_object' };
    }
    if (!Object.prototype.hasOwnProperty.call(cursor, seg)) {
      return { found: false, reason: 'segment_missing', segment: seg };
    }
    cursor = cursor[seg];
  }
  return { found: true, value: cursor };
}

/**
 * Render a JSON value as a short display string for the help
 * popover's "baseline" field. Keeps booleans as `true`/`false`,
 * numbers as-is, strings as double-quoted (with internal quotes
 * escaped), arrays and objects as compact JSON. `null` renders as
 * `null`. `undefined` renders as `undefined`. Long strings
 * (>60 chars) get ellipsis-truncated; long arrays/objects
 * collapse to `Array(N)` / `Object` once they exceed the cap so
 * the popover stays compact.
 *
 * Pure. Exported for tests + the React layer.
 *
 * @param {unknown} value
 * @param {Object} [opts]
 * @param {number} [opts.maxChars=60]
 * @returns {string}
 */
export function formatJsonValue(value, opts = {}) {
  const maxChars = Number.isFinite(opts.maxChars) && opts.maxChars > 0
    ? Math.floor(opts.maxChars)
    : 60;
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(/** @type {number} */ (value))) return String(value);
    return String(value);
  }
  if (t === 'string') {
    const json = JSON.stringify(value);
    if (json.length <= maxChars) return json;
    return json.slice(0, Math.max(1, maxChars - 1)) + '…';
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.length <= 3) {
      const inner = value.map((v) => formatJsonValue(v, { maxChars: 16 })).join(', ');
      return `[${inner}]`;
    }
    return `Array(${value.length})`;
  }
  if (t === 'object') {
    const keys = Object.keys(/** @type {object} */ (value));
    if (keys.length === 0) return '{}';
    if (keys.length <= 3) {
      const inner = keys
        .map((k) => `${k}: ${formatJsonValue((/** @type {any} */ (value))[k], { maxChars: 16 })}`)
        .join(', ');
      return `{${inner}}`;
    }
    return `Object(keys=${keys.length})`;
  }
  return String(value);
}

/**
 * Build the structured payload for a knob's help popover. Pulls
 * the FULL catalog entry (description, unit, restart-required
 * badge, min/max range hint, rangeHint, group, key) and folds in
 * the baseline value from `config/default.json` so the operator
 * can see the canonical default without leaving the Settings view.
 *
 * Output shape:
 *   {
 *     meta: KnobMeta,                       // the catalog entry
 *     default:                              // baseline lookup result
 *       | { found:true, value:unknown, display:string }
 *       | { found:false, reason:string, display:'unknown' },
 *     rangeHint: string|null,               // min..max or catalog.rangeHint
 *     rows: Array<{ label:string, value:string }>,
 *   }
 *
 * `rows` is a structured list the React layer renders as a small
 * table inside the popover — it keeps the JSX dumb (no string
 * concatenation, no order-coupling). Each row is a separate key
 * the popover can highlight on hover.
 *
 * Pure. Exported for tests + the React layer.
 *
 * @param {KnobMeta|null} meta
 * @param {Object} [opts]
 * @param {unknown} [opts.defaultConfig]     Parsed `config/default.json`.
 * @returns {{
 *   meta: KnobMeta|null,
 *   default: { found:boolean, value?:unknown, display:string, reason?:string },
 *   rangeHint: string|null,
 *   rows: Array<{ label:string, value:string }>,
 * }}
 */
export function buildHelpPopover(meta, opts = {}) {
  const empty = {
    meta: null,
    default: { found: false, reason: 'no_meta', display: 'unknown' },
    rangeHint: null,
    rows: [],
  };
  if (!meta) return empty;
  const defaultConfig = Object.prototype.hasOwnProperty.call(opts, 'defaultConfig')
    ? opts.defaultConfig
    : null;
  let defaultRow;
  if (defaultConfig === null || defaultConfig === undefined) {
    defaultRow = { found: false, reason: 'default_config_not_provided', display: 'unknown' };
  } else {
    const lookup = defaultValueAtPath(defaultConfig, meta.path);
    if (lookup.found) {
      defaultRow = { found: true, value: lookup.value, display: formatJsonValue(lookup.value) };
    } else {
      defaultRow = { found: false, reason: lookup.reason, display: 'unknown' };
    }
  }
  const rangeHint = renderRangeHint(meta);
  const rows = [
    { label: 'key',        value: meta.key },
    { label: 'group',      value: meta.group },
    { label: 'unit',       value: meta.unit || '—' },
    { label: 'kind',       value: meta.kind ?? 'number' },
    { label: 'restart',    value: meta.restart ? 'required' : 'live' },
    { label: 'min',        value: Number.isFinite(meta.min) ? String(meta.min) : '—' },
    { label: 'max',        value: Number.isFinite(meta.max) ? String(meta.max) : '—' },
    { label: 'step',       value: Number.isFinite(meta.step) ? String(meta.step) : '—' },
    { label: 'baseline',   value: defaultRow.display },
    { label: 'range hint', value: rangeHint ?? '—' },
  ];
  return {
    meta,
    default: defaultRow,
    rangeHint,
    rows,
  };
}