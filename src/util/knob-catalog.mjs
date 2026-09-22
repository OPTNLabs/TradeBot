#!/usr/bin/env node
// src/util/knob-catalog.mjs
//
// T43c-server — shared knob catalog: the single source of truth
// for every config knob the operator can edit from the Settings
// view. Lives in `src/util/` so both the dashboard frontend
// (`dashboard/src/lib/knob-explanations.mjs`) and the dashboard
// HTTP backend (`src/dashboard/server.mjs`) can read the same
// data without duplicating it.
//
// Why a shared module?
//   - The Settings UI (frontend) needs the catalog to render the
//     table, drive the help popovers, and lock the validation
//     contract.
//   - The new `POST /api/config/:path` endpoint (backend, T43c-
//     server) needs the same catalog to validate the request path
//     (refuse unknown paths), enforce the per-knob `restart` gate,
//     and validate the proposed value against `kind`/`min`/`max`.
//   - The trader loop will need to know which knobs need restart
//     vs which can hot-reload (today every knob is restart-gated,
//     but the gate is in place for future live-tunable knobs).
//
// Design rules:
//
//   1. **One source of truth.** The KNOBS array + `lookupKnobMeta`
//      + `knobsRequiringRestart` are exported from this file. The
//      dashboard's existing `knob-explanations.mjs` re-exports the
//      three symbols so every existing import path keeps working.
//
//   2. **Zero runtime deps.** Pure ESM data + helpers — Node.js,
//      Vite dev, and `vite build` all resolve this file identically.
//      No fs, no network, no React, no DOM.
//
//   3. **Frozen catalog.** KNOBS is `Object.freeze`'d so a
//      downstream caller can't mutate the array in place. The
//      PATH_INDEX map is built once at module load.
//
//   4. **Path-based lookup.** The `path` field is the canonical
//      identity (NOT the human-readable `key` or `label`) — this
//      is what matches the dotted key in `config/user.json` and
//      what `POST /api/config/:path` will receive from the URL.
//
//   5. **`kind` drives validation.** Numbers validate against
//      `min`/`max`; booleans validate against `true`/`false`; text
//      validates as a non-empty string. The `kind` field is
//      optional and defaults to `'number'` for back-compat with
//      catalog entries that pre-date T43b.
//
// Origin: T43 catalog (originally inline in
// `dashboard/src/lib/knob-explanations.mjs`); T43c-server extracted
// to this shared module so the server-side endpoint can validate
// against the same data the UI renders.

/**
 * @typedef {Object} KnobMeta
 * @property {string} key          Dotted path (e.g. "scoring.weights.volume_24h_bch").
 * @property {string[]} path       Path segments (e.g. ["scoring","weights","volume_24h_bch"]).
 * @property {string} label        Operator-facing label.
 * @property {string} unit         Human unit suffix: "BCH", "sats", "%", "bps", "h", "".
 * @property {boolean} restart     True if a bot restart is required for the new value to take effect.
 * @property {string} description  One-sentence explanation of what the knob does.
 * @property {string|null} [rangeHint] Optional "min..max / typical" hint string for the UI.
 * @property {string} group        Top-level config group ("scoring" | "entry" | "exit" | "risk" | "loop" | "dashboard").
 * @property {'number'|'boolean'|'text'} [kind='number'] Input type (drives validation + clamping).
 * @property {number} [min]        Inclusive lower bound (numeric only; absent = no lower bound).
 * @property {number} [max]        Inclusive upper bound (numeric only; absent = no upper bound).
 * @property {number} [step]       Optional step size used by the input + the validator.
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
  { key: 'scoring.weights.volume_30d_bch',     path: ['scoring','weights','volume_30d_bch'],     label: 'volume_30d_bch',     unit: 'weight', restart: true, group: 'scoring',
    description: 'T46b — primary volume signal. Weight on the trailing-30d volume (derived from apy_30d_bp × tvl_sats / fee_rate_bps). The Cauldron DEX is new — 24h volume is bursty, and a token that\'s quiet today but had a real trade history over the last 30d is still tradeable. Calibrates the bot toward pools with sustained activity instead of 24h-momentum spikes. Sums to 1.0 with the other weights.',
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
  // T46b: 30-day volume gate is the primary volume floor. 1.0 BCH of
  // trailing-30d volume is "this pool has had real trade activity recently".
  { key: 'scoring.min_volume_30d_bch', path: ['scoring','min_volume_30d_bch'], label: 'min_volume_30d_bch', unit: 'BCH',      restart: true, group: 'scoring',
    description: 'Hard floor on trailing-30d volume (proxy-derived from apy_30d_bp × tvl_sats / fee_rate_bps). Pools below this are dropped before scoring. T46b: primary volume gate (was min_volume_24h_bch). Set to 0 to disable.', rangeHint: 'BCH (small-balance default: 1.0)',
    kind: 'number', min: 0, max: 10000, step: 0.001 },
  // T44: staleness gate — drop any token the indexer reports as
  // having fewer than N trades in the current 24h window. Defends
  // against phantom-price entries (QBTC had trade_count=0 with
  // price_now_sats=32.7B). The indexer doesn't expose a
  // last_trade_ts field, so the smallest sensible unit is the
  // 24h trade count. Set to 0 to disable (NOT recommended).
  { key: 'scoring.min_trade_count_24h', path: ['scoring','min_trade_count_24h'], label: 'min_trade_count_24h', unit: 'trades', restart: true, group: 'scoring',
    description: 'T44 staleness gate. Minimum 24h trade count a pool must have for the indexer\'s price_now_sats to be considered fresh. Tokens with fewer trades (including zero) are rejected before scoring. Defends against phantom-price entries like QBTC (trade_count=0 → price_now_sats=32.7B). Set to 0 to disable.', rangeHint: 'trades (small-balance default: 1)',
    kind: 'number', min: 0, max: 100000, step: 1 },
  { key: 'scoring.staleness_threshold', path: ['scoring','staleness_threshold'], label: 'staleness_threshold', unit: 'fraction', restart: true, group: 'scoring',
    description: 'T44.1 global-staleness fallback. When this fraction (0..1) of valid candidates have trade_count < min_trade_count_24h, the indexer is treated as globally stale and the trade_count_24h gate is suppressed for the entire cohort (other gates still apply per-token). Prevents a single indexer-wide stale data event from zeroing candidate_count. Default 0.5 = 50%. Set to 1.0 to disable the fallback.', rangeHint: '0..1 (default 0.5)',
    kind: 'number', min: 0, max: 1, step: 0.05 },
  // T75: synthesized LP-fee-yield floor. Catches pools that have
  // trades but aren't generating meaningful LP fee income relative
  // to TVL (e.g., a 5-trade/day pool with 50 BCH TVL → fee_yield_bps
  // ≈ 0.003 bps/day ≈ zero ROI). Defense-in-depth on top of
  // min_trade_count_24h — same pattern, same opt-out semantics
  // (set to 0 to disable).
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
  // T46b: cap on the derived 30d volume estimate (200 BCH ≈ "very liquid pool for our bot").
  { key: 'scoring.caps.volume_30d_bch', path: ['scoring','caps','volume_30d_bch'], label: 'volume_30d_bch cap', unit: 'BCH',  restart: true, group: 'scoring',
    description: 'Sigmoid cap on the volume_30d_bch contribution (trailing-30d volume estimate, derived from apy_30d_bp × tvl_sats / fee_rate_bps). Past this BCH/30d the term saturates.', rangeHint: 'BCH',
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
  // T46b: volume_30d_bch also accepted under linear_caps so callers that
  // toggle from caps→linear_caps still see a valid upper bound.
  { key: 'scoring.linear_caps.volume_30d_bch', path: ['scoring','linear_caps','volume_30d_bch'], label: 'volume_30d_bch cap', unit: 'BCH',  restart: true, group: 'scoring',
    description: 'Linear cap on the volume_30d_bch contribution. Present so callers that use linear_caps as their cap source see a valid bound for volume_30d_bch (mirrors scoring.caps.volume_30d_bch).',
    kind: 'number', min: 0, max: 1000, step: 0.1 },
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
  // T55: per-token slippage cap derived from AMM pool depth. When
  // `slippage_cap_per_token_enabled` is true the flat
  // `slippage_tolerance_bps` is REPLACED for each trade by a depth-
  // aware cap: clamp(est_constant_product_slippage_bps * multiplier,
  // min_bps, max_bps). Deep pools tighten the cap (more protection);
  // shallow pools loosen it (legitimate trades don't get rejected).
  { key: 'entry.slippage_cap_per_token_enabled', path: ['entry','slippage_cap_per_token_enabled'], label: 'slippage_cap_per_token_enabled', unit: '', restart: true, group: 'entry',
    description: 'When true, derive the per-trade slippage cap from AMM pool depth (T55). When false, fall back to the flat `slippage_tolerance_bps` for every trade.', rangeHint: 'boolean',
    kind: 'boolean' },
  { key: 'entry.slippage_cap_min_bps',           path: ['entry','slippage_cap_min_bps'],           label: 'slippage_cap_min_bps',       unit: 'bps', restart: true, group: 'entry',
    description: 'Floor on the depth-aware slippage cap (T55). Prevents the cap from shrinking to a level that would reject every trade on deep pools. Default 30 bps.', rangeHint: 'bps (typ. 20..50)',
    kind: 'number', min: 5, max: 200, step: 1 },
  { key: 'entry.slippage_cap_max_bps',           path: ['entry','slippage_cap_max_bps'],           label: 'slippage_cap_max_bps',       unit: 'bps', restart: true, group: 'entry',
    description: 'Ceiling on the depth-aware slippage cap (T55). Prevents the cap from ballooning on tiny pools. Default 250 bps.', rangeHint: 'bps (typ. 150..500)',
    kind: 'number', min: 50, max: 1000, step: 10 },
  { key: 'entry.slippage_cap_multiplier',        path: ['entry','slippage_cap_multiplier'],        label: 'slippage_cap_multiplier',    unit: 'x',   restart: true, group: 'entry',
    description: 'Safety multiplier on the constant-product slippage estimate (T55). Cap = clamp(estimate * multiplier, min, max). Default 2.0 gives a 2x safety margin.', rangeHint: 'x (typ. 1.5..3.0)',
    kind: 'number', min: 1.0, max: 5.0, step: 0.1 },
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
  { key: 'entry.allow_second_position_discount_pct', path: ['entry','allow_second_position_discount_pct'], label: 'allow_second_position_discount_pct', unit: 'fraction', restart: true, group: 'entry',
    description: 'Required price discount (fraction 0..1) vs the OLDEST existing open position\'s entry price to allow a second open position on the same token. Default 0.20 = must be ≥20% below the first entry. Set to 1.0 to disable the second-position allowance (v1 single-position-per-token behavior). Set to 0 to allow a second position at any price (not recommended — would double exposure without a thesis change).', rangeHint: '0..1 (typ. 0.10..0.50, 1.0 to disable)',
    kind: 'number', min: 0, max: 1, step: 0.01 },
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
  { key: 'risk.utxo_consolidation_check_enabled', path: ['risk','utxo_consolidation_check_enabled'], label: 'utxo_consolidation_check_enabled', unit: '', restart: false, group: 'risk',
    description: 'When ON, the trader loop runs a pre-entry UTXO-fragmentation check (`analyzeUtxoFragmentation`). If no single above-dust UTXO + fee headroom is large enough to fund the candidate trade AND the total balance covers it, the loop emits `entry_skipped` with kind `utxo_fragmented` so the operator can see the gap in REASONING + history. Subset 1 only DETECTS + logs; auto-consolidation is deferred to T60-2. Off = skip the check (the trade falls through to the normal entry pipeline, which may itself surface below_floor if fragmented).', rangeHint: 'boolean (default true)',
    kind: 'boolean' },
  { key: 'risk.utxo_consolidation_dust_sats',   path: ['risk','utxo_consolidation_dust_sats'],   label: 'utxo_consolidation_dust_sats',    unit: 'sat', restart: false, group: 'risk',
    description: 'UTXOs at or below this sat value are excluded from the fragmentation analysis (`isDustUtxo`) and from any future consolidation set. Default 1,000 sats — conservative enough that consolidation does not sweep worthless dust, generous enough that a wallet with several 1k-sat UTXOs is NOT considered fragmented on a 0.005 BCH trade.', rangeHint: 'sat (typ. 500..5000; default 1000)',
    kind: 'number', min: 0, max: 100000, step: 100 },
  { key: 'risk.utxo_consolidation_min_balance_bch', path: ['risk','utxo_consolidation_min_balance_bch'], label: 'utxo_consolidation_min_balance_bch', unit: 'BCH', restart: false, group: 'risk',
    description: 'Hard floor for the pre-entry fragmentation analysis. If the wallet total balance is BELOW this value the analysis short-circuits to reason `below_min_balance` and skips the fragmentation gate (the trade is unsafe regardless of UTXO shape). Mirrors the `risk.min_wallet_balance_bch` reserve philosophy but exposes it as its own knob so the operator can tune the UTXO gate independently. Default 0.01 BCH.', rangeHint: 'BCH (typ. 0.005..0.05; default 0.01)',
    kind: 'number', min: 0, max: 1, step: 0.0001 },
  { key: 'risk.utxo_consolidation_auto_enabled', path: ['risk','utxo_consolidation_auto_enabled'], label: 'utxo_consolidation_auto_enabled', unit: '', restart: false, group: 'risk',
    description: 'When ON AND the pre-entry fragmentation gate fires (`needsConsolidation === true`), the trader loop calls `executeConsolidationTx` itself instead of just emitting `entry_skipped` with kind `utxo_fragmented`. This is a real on-chain broadcast — opt-in. The loop refuses to auto-consolidate a single-UTXO wallet, a wallet where the largest UTXO already funds the trade, a wallet that contains token-bearing UTXOs, or a wallet whose reserve can\'t cover the consolidation fee. See T69 subset 1 for the exportable orchestrator; subset 2 (T70) wires the loop. Hot-read every tick (`restart:false`). Default OFF.', rangeHint: 'boolean (default false — opt-in)',
    kind: 'boolean' },
  { key: 'risk.utxo_consolidation_fee_sat_per_byte', path: ['risk','utxo_consolidation_fee_sat_per_byte'], label: 'utxo_consolidation_fee_sat_per_byte', unit: 'sat/byte', restart: false, group: 'risk',
    description: 'T70: fee rate (sat/byte) used by the trader loop\'s auto-consolidation path. The loop also refuses to fire when `wallet_balance_bch - utxo_consolidation_min_balance_bch` can\'t cover the resulting fee. Default 1 sat/byte — same default as `scripts/consolidate-utxos.mjs`. Operators can raise this during mempool spikes to prioritize confirmation speed.', rangeHint: 'sat/byte (typ. 1..5; default 1)',
    kind: 'number', min: 1, max: 100, step: 1 },
  // T87 — dust-position auto-close.
  { key: 'risk.dust_position_auto_close_enabled', path: ['risk','dust_position_auto_close_enabled'], label: 'dust_position_auto_close_enabled', unit: '', restart: false, group: 'risk',
    description: 'T87. When ON, the trader loop evaluates every open position at the end of each tick against the close-cost test (tx fee + slippage × budget_multiplier). Positions whose projected market value is below the threshold are auto-closed via `Positions.close()` (with `bch_received_sats:0` + `reason:"dust_position_auto_close"`) so the dashboard / P&L rollups see the synthetic close immediately. Operator-set `exit_overrides.prevent_stop_loss:true` overrides the dust gate (hold until profit always wins). On-chain-synced positions (`entry.source === \'on-chain-sync\'`) are also skipped — they go through T62\'s orphan-reconcile path instead. Hot-read every tick (`restart:false`). Default OFF — opt-in for safety.', rangeHint: 'boolean (default false — opt-in)',
    kind: 'boolean' },
  { key: 'risk.dust_position_close_tx_fee_sats', path: ['risk','dust_position_close_tx_fee_sats'], label: 'dust_position_close_tx_fee_sats', unit: 'sat', restart: false, group: 'risk',
    description: 'T87. Flat tx fee (sats) the dust test adds to the projected close cost. Default 1500 sats matches the BCH dust practice for a single-input tx. Operators raising mempool fees during spikes can raise this so the dust gate stays conservative.', rangeHint: 'sat (typ. 1000..3000; default 1500)',
    kind: 'number', min: 0, max: 100000, step: 100 },
  { key: 'risk.dust_position_close_slippage_bps', path: ['risk','dust_position_close_slippage_bps'], label: 'dust_position_close_slippage_bps', unit: 'bps', restart: false, group: 'risk',
    description: 'T87. Slippage (bps) the dust test assumes for the projected close. Default 100 bps (1%) matches `slippage_tolerance_bps`. Operators can tighten on deep pools or loosen on thin pools.', rangeHint: 'bps (typ. 50..300; default 100)',
    kind: 'number', min: 0, max: 1000, step: 10 },
  { key: 'risk.dust_position_close_margin_bps', path: ['risk','dust_position_close_margin_bps'], label: 'dust_position_close_margin_bps', unit: 'bps', restart: false, group: 'risk',
    description: 'T87. Safety margin (bps) the dust test adds so we don\'t fire on exact breakeven. Currently informational — the strict `<` comparison in the math already prevents exact-breakeven triggers. Exposed as a knob so operators can audit / tune the gate\'s conservatism without code edits.', rangeHint: 'bps (typ. 0..200; default 50)',
    kind: 'number', min: 0, max: 500, step: 10 },
  { key: 'risk.dust_position_close_budget_multiplier', path: ['risk','dust_position_close_budget_multiplier'], label: 'dust_position_close_budget_multiplier', unit: 'x', restart: false, group: 'risk',
    description: 'T87. The dust test is `projected_proceeds < (tx_fee + slippage) × multiplier`. Default 1.5× requires the close to free up at least 1.5× the close cost in BCH value, giving a margin of safety against actual slippage exceeding the estimate. Operators can lower to 1.0 for an exact-cost gate or raise to be more conservative.', rangeHint: 'x (typ. 1.0..3.0; default 1.5)',
    kind: 'number', min: 1.0, max: 10.0, step: 0.1 },
  { key: 'risk.dust_position_close_min_token_amount', path: ['risk','dust_position_close_min_token_amount'], label: 'dust_position_close_min_token_amount', unit: 'base units', restart: false, group: 'risk',
    description: 'T87. Optional minimum token_amount (in base units) below which a position is ALWAYS considered dust regardless of price. Default null = disabled (let the cost-ratio math decide). Setting e.g. 100 forces auto-close on any position holding fewer than 100 base units.', rangeHint: 'base units (null or >=0)',
    kind: 'number', min: 0, max: 1000000000, step: 1 },

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
  // T61 — bounds the `wallet.listUtxos()` call on the extended
  // `/healthz` endpoint so a slow Electrum provider can't block a
  // 200ms healthcheck. Tune DOWN on slow networks; tune UP on
  // wallets with hundreds of dust UTXOs (10+ seconds is realistic
  // for first-boot PIES-style scans).
  { key: 'dashboard.health_utxo_timeout_ms',   path: ['dashboard','health_utxo_timeout_ms'],   label: 'health_utxo_timeout_ms',           unit: 'ms', restart: false, group: 'dashboard',
    description: 'T61. Maximum time the extended /healthz endpoint will wait for wallet.listUtxos() before reporting the wallet probe as degraded (null utxo_count). Prevents a slow Electrum provider from blocking monitors that poll /healthz every few seconds.', rangeHint: 'ms (typ. 1000..10000)',
    kind: 'number', min: 100, max: 30000, step: 100 },
  // T64 — bounds the in-memory TTL cache on `/api/snapshots/aggregate`.
  // The aggregator already auto-invalidates on file mtime change (so a
  // fresh trader-loop snapshot-record write invalidates the next poll),
  // but the TTL caps the cache lifetime for the case where the file mtime
  // doesn't move but new records are appended in-place. Set to 0 to
  // disable caching (always-fresh).
  { key: 'dashboard.snapshot_aggregate_cache_ms', path: ['dashboard','snapshot_aggregate_cache_ms'], label: 'snapshot_aggregate_cache_ms', unit: 'ms', restart: false, group: 'dashboard',
    description: 'T64. TTL for the `/api/snapshots/aggregate` per-server cache. The cache is keyed on `(dir, file_mtime_ms, range_ms, token_id)` so a fresh snapshot-record write auto-invalidates the next poll. The TTL caps the cache lifetime for the rare case where mtime does not move between writes. Set to 0 to disable caching.', rangeHint: 'ms (typ. 5000..60000)',
    kind: 'number', min: 0, max: 300000, step: 1000 },

  // ─── dex (T57-3 Settings UI) ───────────────────────────────────────────
  // The dex.* knobs let the operator toggle which DEX adapters
  // the loop boots per tick. `dex.active` is an array of ids from
  // `listKnownDexIds()` (currently 'cauldron', 'cauldron_safe_mode',
  // 'guanaco'); the Settings view renders each one as a checkbox.
  // `dex.safe_mode_active` is a single boolean toggle for the
  // known-good offline backup adapter. Per-adapter settings live
  // under their own namespace (e.g. dex.guanaco.* below).
  //
  // Only `dex.safe_mode_active` is registered as a typed knob
  // (boolean). `dex.active` is a list and is rendered by the
  // Settings view as a multi-checkbox panel driven by
  // `listKnownDexIds()` — the catalog's typed validation contract
  // (number/boolean/text) doesn't fit arrays, so the list shape
  // is enforced on the backend by `resolveDexConfig(cfg)` instead.
  { key: 'dex.safe_mode_active',            path: ['dex','safe_mode_active'],           label: 'dex_safe_mode_active',            unit: '',   restart: true, group: 'dex',
    description: 'T57-3. When true, the loop ALSO boots `cauldron_safe_mode` (a known-good offline backup) in addition to the adapters in `dex.active`. The router uses it as a fallback whenever a live adapter has no live pools for a token. Safe-mode wins the tie-break on equal rates (so the operator has a kill-switch back to the cached pool list when the live indexer is misbehaving). Default false.',
    rangeHint: 'boolean (default: false)',
    kind: 'boolean' },

  // ─── dex.guanaco (T57-2 scaffold) ──────────────────────────────────────
  { key: 'dex.guanaco.indexer_url',              path: ['dex','guanaco','indexer_url'],           label: 'guanaco_indexer_url',             unit: '',   restart: true, group: 'dex',
    description: 'Public guanaco DEX indexer URL. T57-2 ships the scaffold only — the guanaco team has not published an indexer endpoint as of 2026-09-18. Until the operator sets this URL + dex.guanaco.sdk_module, the adapter reports isReady()=false and every method throws GuanacoNotImplementedError.', rangeHint: 'null or https URL',
    kind: 'text' },
  { key: 'dex.guanaco.sdk_module',               path: ['dex','guanaco','sdk_module'],            label: 'guanaco_sdk_module',              unit: '',   restart: true, group: 'dex',
    description: 'Path to the JS module exporting the guanaco SDK (T57-2.2 ships this when the team publishes one). Both dex.guanaco.indexer_url and dex.guanaco.sdk_module must be set for the adapter to report ready.', rangeHint: 'null or module path',
    kind: 'text' },
  { key: 'dex.guanaco.default_fee_tier',         path: ['dex','guanaco','default_fee_tier'],      label: 'guanaco_default_fee_tier',        unit: 'level', restart: true, group: 'dex',
    description: 'Default V1 fee tier (0=0.01% / 1=0.05% / 2=0.30% / 3=1.00%) used when the bot opens new guanaco pools. The fee tier is a per-pool property baked into the pool\'s redeem script at creation, so this knob only affects the bot\'s preference for which tier to favour — existing pools are immutable.', rangeHint: '0..3 (canonical: 1)',
    kind: 'number', min: 0, max: 3, step: 1 },
  { key: 'dex.guanaco.request_timeout_ms',       path: ['dex','guanaco','request_timeout_ms'],    label: 'guanaco_request_timeout_ms',      unit: 'ms', restart: true, group: 'dex',
    description: 'Per-request timeout for the guanaco adapter (when the indexer ships). Lower = fail-fast on stalled fetches, higher = tolerate slow indexer ticks.', rangeHint: 'ms (typ. 5000..30000)',
    kind: 'number', min: 100, max: 60000, step: 100 },

  // ─── T59: Orphan-position alert (alerts group) ────────────────────
  { key: 'alerts.orphan_position_check_enabled', path: ['alerts','orphan_position_check_enabled'], label: 'orphan_position_check_enabled', unit: '',  restart: false, group: 'alerts',
    description: 'T59 — when true, the orphan-position check is enabled (manual CLI runs it; trader-loop subset 2 auto-wires it per tick and hot-reads this flag every tick). When false, the check is a no-op even when alerts are otherwise enabled. Default true so the manual CLI can fire alerts without an extra setup step. restart:false because the loop checks it on every tick \u2014 the operator can flip without a restart.',
    rangeHint: 'boolean (default: true)',
    kind: 'boolean' },

  // ─── T62: Orphan auto-reconcile (alerts group) ──────────────────
  // Closes the operator-UX gap that T59 + T29 opened: every
  // orphan was a Telegram alert + a TODO for the operator to
  // reconcile by hand. T62 ships a tiny auto-reconcile path
  // that closes `on_disk_only` orphans via `Positions.close()`
  // after a min-age gate. Default OFF (`false`) so a fresh
  // install can never silently close positions. restart:false
  // because the loop hot-reads both knobs every tick.
  { key: 'alerts.orphan_auto_reconcile_enabled', path: ['alerts','orphan_auto_reconcile_enabled'], label: 'orphan_auto_reconcile_enabled', unit: '',  restart: false, group: 'alerts',
    description: 'T62 — when true, the trader loop auto-closes `on_disk_only` orphan positions (high-severity findings from the T47 diff) via `Positions.close()` with a synthetic exit envelope (txid=\"\", bch_received_sats=0, fee_sats=0, reason=\"orphan_auto_reconcile\") and a `-entry.fee_sats` realized PnL. Default false so a fresh install can never silently close positions. restart:false because the loop checks it on every tick \u2014 the operator can flip without a restart. Pairs with `alerts.orphan_auto_reconcile_min_age_minutes` to guard against UTXO-scan races.',
    rangeHint: 'boolean (default: false)',
    kind: 'boolean' },
  { key: 'alerts.orphan_auto_reconcile_min_age_minutes', path: ['alerts','orphan_auto_reconcile_min_age_minutes'], label: 'orphan_auto_reconcile_min_age_minutes', unit: 'min', restart: false, group: 'alerts',
    description: 'T62 — minimum age (minutes) of an orphan before the auto-reconcile path will close it. Guards against UTXO-scan races: a freshly-detected orphan that is only seconds old is left alone because the wallet provider may just be slow to surface the latest UTXO set. `0` / negative disables the age gate (closeable immediately; mirrors the opt-out pattern used by T32 / T33 / T35 / T36). Hot-read every tick.',
    rangeHint: 'minutes (default: 60; 0 disables the gate)',
    kind: 'number', min: 0, max: 1440, step: 1 },

  // ─── T58 subset 3: BadgerCoin Staking auto-wire (staking group) ─
  // The auto-wire adds two sub-mode knobs on top of the subset 2
  // `enabled` / `simulation_only` knobs. A fresh `enabled:true`
  // flip alone won't move BCH \u2014 the operator has to opt in twice
  // (enabled + sub-mode) before the loop dispatches a real
  // lock/unlock tx. Both sub-mode knobs are restart:false because
  // the loop hot-reads them on every tick.
  { key: 'staking.auto_lock_enabled', path: ['staking','auto_lock_enabled'], label: 'auto_lock_enabled', unit: '', restart: false, group: 'staking',
    description: 'T58 subset 3 \u2014 sub-mode of `staking.enabled`. When true AND `staking.simulation_only === false` AND the wallet holds no lockNFT AND wallet balance is above the reserve floor (lock_min_balance_bch + entry.max_position_bch) AND (allow_when_positions_open OR no open positions), the trader loop fires `executeLock` at the end of every tick. Default false so a fresh `enabled:true` flip alone does not move BCH \u2014 the operator has to opt in twice. Hot-read every tick; no restart needed.',
    rangeHint: 'boolean (default: false)',
    kind: 'boolean' },
  { key: 'staking.auto_unlock_enabled', path: ['staking','auto_unlock_enabled'], label: 'auto_unlock_enabled', unit: '', restart: false, group: 'staking',
    description: 'T58 subset 3 \u2014 sub-mode of `staking.enabled`. When true AND `staking.simulation_only === false` AND the wallet holds one or more lockNFTs AND the lock timelock has elapsed (currentTipHeight >= lockUtxo.lockBlockHeight + lockUtxo.stakeBlocks + lock_unlock_grace_seconds), the trader loop fires `executeUnlock` for ONE lockNFT per tick (drain over multiple ticks, fail-fast per lock). Default false so a fresh `enabled:true` flip alone does not move BCH \u2014 the operator has to opt in twice. Hot-read every tick; no restart needed.',
    rangeHint: 'boolean (default: false)',
    kind: 'boolean' },

  // ─── T58 subset 5: BadgerCoin Staking unlock-cron fallback ────
  // Closes the safety gap when the trader loop is sidelined: if
  // the loop is paused / crashed / restarted, the auto-unlock path
  // doesn't fire. Subset 5 ships `scripts/check-stale-stakes.mjs`,
  // a dedicated cron that boots the wallet + Electrum provider,
  // finds lockNFTs whose timelock has elapsed, and fires
  // `executeUnlock` (one-at-a-time, full defensive guards, alerts
  // routed through `dispatchStakeAlert`). Hot-read every cron run
  // (operator flips the knob, the next cron tick sees it).
  { key: 'staking.unlock_cron_enabled', path: ['staking','unlock_cron_enabled'], label: 'unlock_cron_enabled', unit: '', restart: false, group: 'staking',
    description: 'T58 subset 5 \u2014 master switch for the unlock-cron fallback (`scripts/check-stale-stakes.mjs`). When true, the cron boots the wallet + Electrum provider, scans the lockNFT UTXO set, and fires `executeUnlock` for any lock whose timelock has elapsed (one-at-a-time, full defensive guards). Stays independent of `staking.auto_unlock_enabled` so the operator can run the cron WITHOUT engaging the trader loop\'s auto-wire (e.g. via systemd timer when the loop is paused). Default false; flip to true + add a cron entry to engage. Hot-read every cron invocation.',
    rangeHint: 'boolean (default: false)',
    kind: 'boolean' },
  { key: 'staking.unlock_cron_minutes', path: ['staking','unlock_cron_minutes'], label: 'unlock_cron_minutes', unit: 'minutes', restart: false, group: 'staking',
    description: 'T58 subset 5 \u2014 documentation-only knob. The actual cadence is driven by the operator\'s cron / systemd-timer entry that wraps `scripts/check-stale-stakes.mjs` (e.g. `*/15 * * * * /usr/local/bin/tradebot-check-stale-stakes` for every 15 minutes). The script reads + validates this knob on every run as a sanity check (catches typos in `config/user.json`); the script itself does NOT sleep between invocations. Default 15 matches the documented 15-minute cadence for the operator-facing runbook.',
    rangeHint: 'minutes (default: 15; range 1..1440)',
    kind: 'number', min: 1, max: 1440, step: 1 },
  { key: 'staking.dashboard_tip_height_cache_ms', path: ['staking','dashboard_tip_height_cache_ms'], label: 'dashboard_tip_height_cache_ms', unit: 'ms', restart: false, group: 'staking',
    description: 'T58 subset 6 — TTL (in milliseconds) for the dashboard\'s chain-tip-height cache. The dashboard\'s `GET /api/staking/status` endpoint hot-reads this knob on every request; the value controls how long the cached tip height stays fresh before `src/wallet/libauth.mjs#getBlockHeight()` re-fetches it from Electrum. The dashboard\'s React layer runs an auto-refresh tick every 60s, so a cache window below 60s means every dashboard refresh pays for one Electrum round-trip; a window above 60s amortises the cost. Default 30s strikes a balance (the React tile\'s "tip: 826142 · 14s ago" pill stays fresh; Electrum sees ~1 call per dashboard refresh in steady-state). Operators who want tighter polling (e.g. during a stake unlock) dial this down; operators who want to stop hammering Electrum dial it up. Range 1000..600000; the Settings editor clamps out-of-range values.',
    rangeHint: 'milliseconds (default: 30000; range 1000..600000)',
    kind: 'number', min: 1000, max: 600000, step: 1000 },
  { key: 'staking.attempt_log_file', path: ['staking','attempt_log_file'], label: 'attempt_log_file', unit: '', restart: false, group: 'staking',
    description: 'T70-3 — on-disk path for the BadgerCoin stake-attempt NDJSON audit log (`data/stake-attempts.jsonl` by default). The trader loop appends one line per lock/unlock attempt (attempt/success/failed + txid + error code) so the dashboard\'s collapsible "Status" div can show the operator exactly what the bot tried without grepping the run-bot log. Independent of the global `cfg.alerts` subsystem (which is disabled by default and routes through `data/alerts.jsonl`). Hot-read every tick; no restart needed. Leave the default unless you want the audit log on a different disk / drive.',
    rangeHint: 'filepath (default: data/stake-attempts.jsonl)',
    kind: 'string' },
  { key: 'staking.attempt_log_max', path: ['staking','attempt_log_max'], label: 'attempt_log_max', unit: 'rows', restart: false, group: 'staking',
    description: 'T70-3 — cap on how many stake-attempt rows the dashboard\'s `GET /api/staking/log` endpoint returns. Smaller = snappier dashboard refresh; larger = more history in the collapsible Status div. The server hard-caps at 500 regardless of this knob so a malformed query can\'t ask for 1B rows. Hot-read every dashboard refresh; no restart needed.',
    rangeHint: 'rows (default: 50; range 1..500)',
    kind: 'number', min: 1, max: 500, step: 1 },

  // ─── T56-2: Adaptive scoring weights (scoring group) ──────────────
  { key: 'scoring.adaptive_weights_enabled', path: ['scoring','adaptive_weights_enabled'], label: 'adaptive_weights_enabled', unit: '', restart: false, group: 'scoring',
    description: 'T56-2 — when true, the trader loop hot-reads the last `adaptive_weights_window_days` of closed trades at the end of every tick, runs the calibration-correlation heuristic from `src/strategy/adaptive-weights.mjs`, and if the suggestion is `applied:true`, writes `scoring.weights` to `config/user.json` (deep-merge — every other key including WIF/mnemonic is preserved untouched) AND appends an NDJSON record to `data/adaptive-weights.jsonl`. Default false so the bot ships with static weights; flip to true to opt in. Hot-read every tick; no restart needed.',
    rangeHint: 'boolean (default: false)',
    kind: 'boolean' },
  { key: 'scoring.adaptive_weights_min_closed_trades', path: ['scoring','adaptive_weights_min_closed_trades'], label: 'adaptive_weights_min_closed_trades', unit: 'trades', restart: false, group: 'scoring',
    description: 'T56-2 — minimum number of closed trades (entry+exit pairs in the window) before the engine is allowed to apply a weight shift. Below the floor the suggestion is computed but never written (and the loop emits `loop.adaptive_weights.skipped` so the audit trail shows why). Default 5 (matches the engine `DEFAULT_MIN_CLOSED_TRADES`).',
    rangeHint: 'trades (default: 5)',
    kind: 'number', min: 1, max: 1000, step: 1 },
  { key: 'scoring.adaptive_weights_window_days', path: ['scoring','adaptive_weights_window_days'], label: 'adaptive_weights_window_days', unit: 'days', restart: false, group: 'scoring',
    description: 'T56-2 — how many trailing days of closed-trade history to include when computing the calibration correlation. Higher = smoother signal (less regime-shift sensitivity); lower = faster adaptation. Default 7d (matches the engine `DEFAULT_WINDOW_MS`).',
    rangeHint: 'days (default: 7; range 1..90)',
    kind: 'number', min: 1, max: 90, step: 1 },
  { key: 'scoring.adaptive_weights_max_delta_per_feature', path: ['scoring','adaptive_weights_max_delta_per_feature'], label: 'adaptive_weights_max_delta_per_feature', unit: 'weight', restart: false, group: 'scoring',
    description: 'T56-2 — per-tick safety clamp on any single feature weight shift (the engine combines this knob with its internal `amplification_max` / `uniformity_pull_max` to keep the per-feature delta bounded). Default 0.05 (a single tick can move any feature by at most 5pp of the weight space). Set to 0 to disable auto-tuning while keeping the audit log live.',
    rangeHint: 'fraction 0..0.5 (default: 0.05)',
    kind: 'number', min: 0, max: 0.5, step: 0.01 },
  { key: 'scoring.adaptive_weights_calibration_floor', path: ['scoring','adaptive_weights_calibration_floor'], label: 'adaptive_weights_calibration_floor', unit: 'fraction', restart: false, group: 'scoring',
    description: 'T56-2 — minimum |Pearson(entry_score, realized_pnl_sats)| before the engine is willing to apply a weight shift. Default 0.10 — calibration below the floor is treated as noise and the existing weights stay untouched (the loop emits `loop.adaptive_weights.skipped` with `reason: calibration_below_floor`). Higher = fewer shifts but more conservative; lower = shifts on weaker evidence.',
    rangeHint: 'fraction 0..1 (default: 0.10)',
    kind: 'number', min: 0, max: 1, step: 0.01 },
  // T76 subset 1 — operator-curated blacklist of token_ids the loop
  // drops pre-entry on the rug-concentration rationale. The pure-math
  // helper (`src/strategy/holder-concentration.mjs`) ships with this
  // commit; the automated detection (scanning the chain for the top-N
  // holders) is deferred to T76 subset 2 because neither the Cauldron
  // indexer nor the standard Electrum providers surface a token-holders
  // endpoint today. The blacklist is an operator-friendly escape hatch
  // until subset 2 lands. Format: array of 64-char lowercase hex token_ids.
  // Same lowercased-membership semantics as `excluded_tokens`. Default empty.
  { key: 'scoring.excluded_concentration_tokens', path: ['scoring','excluded_concentration_tokens'], label: 'excluded_concentration_tokens', unit: '', restart: false, group: 'scoring',
    description: 'T76 subset 1 — operator-curated blacklist of token_ids the loop drops pre-entry on the rug-concentration rationale. Format: array of 64-char lowercase hex token_ids (the same membership semantics as `excluded_tokens` apply — symbols and 64-hex IDs are both accepted but IDs are the recommended form). Default empty. The automated detection (chain scan for top-N holders) is deferred to T76 subset 2.',
    rangeHint: 'array of 64-char hex token_ids (default: [])',
    kind: 'array', itemKind: 'string' },
  // T76 subset 1 — top-N wallets the rug-pattern predicate considers.
  // Lower values (e.g. 3) catch even tighter clusterings (a 3-wallet rug)
  // but also flag legitimate early-stage tokens where dev/seed/treasury
  // wallets haven't dispersed. Higher values (e.g. 10) catch broader
  // concentration patterns but produce more false positives. Default 5
  // matches the operator-original idea (`<5 wallets hold >80%`).
  { key: 'scoring.concentration_rug_top_n', path: ['scoring','concentration_rug_top_n'], label: 'concentration_rug_top_n', unit: 'wallets', restart: false, group: 'scoring',
    description: 'T76 subset 1 — top-N wallets considered for the rug-pattern test. Used by `src/strategy/holder-concentration.mjs#computeHolderConcentration()`. Default 5 matches the operator-original idea (<5 wallets hold >80%).',
    rangeHint: '1..1000 (default: 5)',
    kind: 'number', min: 1, max: 1000, step: 1 },
  // T76 subset 1 — percentage of TOTAL supply the top-N must hold for
  // the token to be flagged as a rug pattern. 80% matches the operator-
  // original idea. Lower (e.g. 70%) is more aggressive; higher (e.g.
  // 90%) is more lenient. T76 subset 2 will hot-read this every tick.
  { key: 'scoring.concentration_rug_threshold_pct', path: ['scoring','concentration_rug_threshold_pct'], label: 'concentration_rug_threshold_pct', unit: 'pct', restart: false, group: 'scoring',
    description: 'T76 subset 1 — pct of total supply the top-N must hold for a token to be flagged as a rug pattern. Used by `src/strategy/holder-concentration.mjs#computeHolderConcentration()`. Default 80% matches the operator-original idea. T76 subset 2 wires the live check into the trader loop.',
    rangeHint: '0..100 (default: 80)',
    kind: 'number', min: 0, max: 100, step: 0.5 },
  // T76 subset 1 — float tolerance for the threshold comparison.
  // The percentage math goes through Number(topSum)/Number(totalSupply)
  // which carries ~1e-13 relative error at worst. Operators with data
  // sources that round to whole percentages (e.g. an off-chain truncator
  // reporting 80% instead of 80.000000001%) can raise this so the rug
  // gate doesn't false-negative at the boundary. Default 1.0 = "I'm
  // willing to flag anything within 1 percentage point of the threshold."
  { key: 'scoring.concentration_rug_epsilon_pct', path: ['scoring','concentration_rug_epsilon_pct'], label: 'concentration_rug_epsilon_pct', unit: 'pct', restart: false, group: 'scoring',
    description: 'T76 subset 1 — float tolerance for the rug-pattern threshold comparison. Lets operators tune around off-chain rounding noise (an off-chain truncator reporting 80% instead of 80.000000001%). The predicate fires when top_n_pct >= (threshold - epsilon). Default 1.0 pct.',
    rangeHint: '0..100 (default: 1.0)',
    kind: 'number', min: 0, max: 100, step: 0.1 },
  // T76 subset 2a — opt-in switch for the live holders scanner.
  // Default OFF so operators who haven't audited the upstream
  // don't accidentally start broadcasting their token_ids to a
  // third party. Flip to true to enable the live wire-up at
  // `/api/token/<id>/holders`; the existing subset-1 stub envelope
  // stays in place for operators who leave it OFF.
  { key: 'scoring.concentration_rug_enabled', path: ['scoring','concentration_rug_enabled'], label: 'concentration_rug_enabled', restart: false, group: 'scoring',
    description: 'T76 subset 2a — opt-in switch for the live holders scanner on the dashboard endpoint. When true, `/api/token/<id>/holders` resolves through the TokenStork upstream via `src/strategy/holder-scanner-cache.mjs#resolveHoldersSnapshot` and returns the same wire shape the subset-1 stub produces. When false (default), the endpoint preserves subset-1 stub behavior. Hot-read every request; no restart needed. The trader-loop eligibility gate (T76 subset 2b) will additionally check this knob per-candidate-token.',
    rangeHint: 'boolean (default: false)',
    kind: 'boolean' },
  // T76 subset 2a — upstream URL for the holders scanner. The
  // tokenstork.com public endpoint is the only working source
  // discovered on 2026-09-20 (verified via curl: cauldron indexer
  // + watchtower + cashtokenmarkets 404 on the holders path).
  { key: 'scoring.concentration_rug_provider_url', path: ['scoring','concentration_rug_provider_url'], label: 'concentration_rug_provider_url', restart: false, group: 'scoring',
    description: 'T76 subset 2a — upstream URL for the holders scanner. Default https://tokenstork.com (verified reachable + JSON-shaped on 2026-09-20). Operators who mirror the upstream behind a corp proxy / cache can set this without a code change. Hot-read every request.',
    rangeHint: 'string URL (default: https://tokenstork.com)',
    kind: 'string' },
  // T76 subset 2a — per-request timeout (ms). Default 5000; the
  // upstream typically responds in <1s. Clamped at 60000 by the
  // scanner module so a typo'd knob can't hang a tick.
  { key: 'scoring.concentration_rug_timeout_ms', path: ['scoring','concentration_rug_timeout_ms'], label: 'concentration_rug_timeout_ms', unit: 'ms', restart: false, group: 'scoring',
    description: 'T76 subset 2a — per-request timeout (ms) for the upstream fetch. Clamped at 60000 by the scanner module so a typo\'d knob can\'t hang a tick. Hot-read every request.',
    rangeHint: '100..60000 (default: 5000)',
    kind: 'number', min: 100, max: 60000, step: 100 },
  // T76 subset 2a — per-token TTL cache window (ms). Default
  // 300000 (5 minutes). 0 disables caching (every dashboard poll
  // re-fetches). Clamped at 3600000 (1h).
  { key: 'scoring.concentration_rug_cache_ms', path: ['scoring','concentration_rug_cache_ms'], label: 'concentration_rug_cache_ms', unit: 'ms', restart: false, group: 'scoring',
    description: 'T76 subset 2a — per-token TTL cache window (ms) for the holders scanner. 0 disables caching (every dashboard poll re-fetches the upstream). Clamped at 3600000 (1h) so a typo can\'t disable the cache for a day. Hot-read every server start; the in-process cache persists until process restart.',
    rangeHint: '0..3600000 (default: 300000)',
    kind: 'number', min: 0, max: 3600000, step: 1000 },
]);

// ─────────────────────────────────────────────────────────────────────
//  Pure helpers
// ─────────────────────────────────────────────────────────────────────

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
  if (Array.isArray(p)) {
    return PATH_INDEX.get(p.join('.')) ?? null;
  }
  if (typeof p !== 'string' || p.length === 0) return null;
  return PATH_INDEX.get(p) ?? null;
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
 * Look up a knob by its dotted-key form (the same form the
 * dashboard's Settings view surfaces + the form `POST
 * /api/config/:path` will receive). Returns the same shape as
 * `lookupKnobMeta`.
 *
 * T43c-server: this is the canonical entry point for the
 * per-knob patch endpoint — it takes the URL `:path` parameter
 * directly (e.g. "entry.max_position_bch") and either returns
 * the meta or `null` if the path is not in the catalog.
 *
 * @param {string} dottedPath
 * @returns {KnobMeta|null}
 */
export function lookupKnobByKey(dottedPath) {
  if (typeof dottedPath !== 'string' || dottedPath.length === 0) return null;
  // Reject path-traversal attempts before they reach the map.
  if (dottedPath.includes('..') || dottedPath.includes('/') || dottedPath.includes('\\')) return null;
  return PATH_INDEX.get(dottedPath) ?? null;
}

/**
 * Validate a proposed value against a knob's catalog metadata.
 * Mirrors the dashboard's `validateKnobValue` (which is UI-aware
 * and lives in `knob-explanations.mjs`); this server-side version
 * is data-only and returns the same `{ok, normalized, reason,
 * message, min, max, kind, restart}` envelope the UI consumes
 * so a future frontend can call it via the API too.
 *
 * Pure. Exported for tests + the POST /api/config/:path handler.
 *
 * @param {KnobMeta|null|undefined} meta
 * @param {unknown} value
 * @returns {{
 *   ok: boolean,
 *   normalized: unknown,
 *   reason: 'kind_mismatch'|'below_min'|'above_max'|'nan'|'empty_text'|'not_integer'|'ok'|null,
 *   message: string,
 *   kind: string|null,
 *   min: number|null,
 *   max: number|null,
 *   restart: boolean|null,
 * }}
 */
export function validateKnobValueForServer(meta, value) {
  const failure = (reason, message) => ({
    ok: false,
    normalized: null,
    reason,
    message,
    kind: meta?.kind ?? null,
    min: (meta && typeof meta.min === 'number') ? meta.min : null,
    max: (meta && typeof meta.max === 'number') ? meta.max : null,
    restart: meta ? !!meta.restart : null,
  });
  if (!meta || typeof meta !== 'object') {
    return failure('kind_mismatch', 'unknown knob');
  }
  const kind = meta.kind ?? 'number';
  if (kind === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      // Coerce string inputs the same way the Settings editor does.
      if (typeof value === 'string' && value.trim().length > 0) {
        const n = Number(value);
        if (Number.isFinite(n)) value = n;
        else return failure('nan', `value must be a finite number; got ${JSON.stringify(value)}`);
      } else {
        return failure('nan', `value must be a finite number; got ${JSON.stringify(value)}`);
      }
    }
    if (typeof meta.min === 'number' && value < meta.min) {
      return failure('below_min', `value ${value} is below the catalog minimum ${meta.min}`);
    }
    if (typeof meta.max === 'number' && value > meta.max) {
      return failure('above_max', `value ${value} is above the catalog maximum ${meta.max}`);
    }
    return {
      ok: true,
      normalized: value,
      reason: 'ok',
      message: 'ok',
      kind,
      min: meta.min ?? null,
      max: meta.max ?? null,
      restart: !!meta.restart,
    };
  }
  if (kind === 'boolean') {
    let coerced;
    if (typeof value === 'boolean') coerced = value;
    else if (value === 'true' || value === 1) coerced = true;
    else if (value === 'false' || value === 0) coerced = false;
    else return failure('kind_mismatch', `value must be a boolean; got ${JSON.stringify(value)}`);
    return {
      ok: true,
      normalized: coerced,
      reason: 'ok',
      message: 'ok',
      kind,
      min: null,
      max: null,
      restart: !!meta.restart,
    };
  }
  if (kind === 'text') {
    if (typeof value !== 'string' || value.length === 0) {
      return failure('empty_text', 'text knobs require a non-empty string');
    }
    return {
      ok: true,
      normalized: value,
      reason: 'ok',
      message: 'ok',
      kind,
      min: null,
      max: null,
      restart: !!meta.restart,
    };
  }
  return failure('kind_mismatch', `unknown knob kind ${JSON.stringify(kind)}`);
}
