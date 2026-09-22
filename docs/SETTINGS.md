# TradeBot — Settings Reference

**Status:** Living doc. First cut shipped with T16 (2026-09-11). Every knob that
influences the bot is documented here. New settings must ship in
`config/default.json` *and* get an entry in this file in the same commit.

This is the human-readable companion to `config/default.json`. If they
disagree, `config/default.json` wins — the doc is descriptive prose; the
file is the authoritative schema.

---

## 1. How settings are loaded

```
config/default.json   ← committed, canonical schema, every default
        │
        ▼
config/user.json      ← gitignored, holds WIF + per-host overrides
        │
        ▼
util/config-loader.mjs::loadConfig() — deep-merges user-onto-default
        │
        ▼
runtime `cfg` object (immutable snapshot for the boot)
```

- `user.json` overrides `default.json` field-by-field. To override
  `entry.max_position_bch`, set `entry.max_position_bch` in `user.json`
  (not a nested "overrides" sub-object).
- The dashboard exposes `PUT /api/config` which writes back to
  `user.json`. That endpoint is auth-gated by `dashboard.api_token` —
  if unset, the endpoint refuses with HTTP 503.
- The structured logger (`src/util/logger.mjs`) reads `dashboard.log_level`
  for the dashboard process; the trader reads the bot-level equivalent
  from `cfg.entry.log_level` if present, otherwise defaults to `info`.

## 2. Top-level keys

| Key | Type | Default (small_balance_startup) | Purpose |
|---|---|---|---|
| `version` | int | `2` | Schema version of `default.json` itself |
| `tuning_preset` | string | `"small_balance_startup"` | Human label for the shipped preset. Purely informational — every other knob is the actual source of truth |
| `balance_aware` | bool | `true` | When `true`, `scripts/snapshot.mjs` reconciles on-chain balance vs recorded positions and surfaces drift |
| `notes` | string | (preset description) | Free-text operator notes. Ignored by the bot |

## 3. `scoring` — pool scoring engine

Controls how the fetcher's pool list is reduced to the
`top_k_candidates` that the entry logic actually evaluates. The scoring
function lives in `src/strategy/scoring.mjs`; tests in
`tests/scoring.test.mjs`.

| Knob | Type | Default | Effect |
|---|---|---|---|
| `scoring.weights.volume_24h_bch` | number 0..1 | `0.30` | Linear weight on `volume_24h_bch` |
| `scoring.weights.volume_7d_bch` | number 0..1 | `0.05` | Linear weight on 7-day volume. Reduced in T28c — indexer rarely surfaces 7d volume consistently; weight redistributed to `upward_volatility` |
| `scoring.weights.volatility_24h_pct` | number 0..1 | `0.25` | Linear weight on 24h price volatility |
| `scoring.weights.tvl_bch` | number 0..1 | `0.15` | Linear weight on TVL (depth) |
| `scoring.weights.apy_30d_pct` | number 0..1 | `0.05` | Linear weight on 30d APY. Reduced in T28c — APY alone doesn't capture "will the price ever reach take-profit?" |
| `scoring.weights.fee_yield_bps` | number 0..1 | `0.05` | Linear weight on fee yield (LP income) |
| `scoring.weights.upward_volatility` | number 0..1 | `0.15` | T28c: how often + how big the token's positive returns are in its 7-day price series. Tokens with zero upward activity in 7d score 0 on this arm; tokens with regular upward spikes + magnitude ≥ 5%/move score up to ~0.85. Forces the ranker to surface tokens that actually have a path to +5% take-profit |

Weights should sum to ~1.0 but the scoring function tolerates slight
drift. Higher `volume_24h_bch` + `volatility_24h_pct` weights tilt the
bot toward **trading-volume-heavy, high-variance** tokens; higher `tvl_bch`
weights tilt toward **deep, slow-moving** tokens. The `upward_volatility`
weight is the antidote to "lots of volume + lots of decline" — e.g.
FEW (Fewness) historically had strong 24h volume but a monotonically
declining 7d series, no realistic path to take-profit at +5%. With the
T28c weight + gate, FEW is now ineligible regardless of how high its
volume / APY / TVL score.

| Knob | Type | Default | Effect |
|---|---|---|---|
| `scoring.min_score` | number 0..1 | `0.35` | Hard floor — pools below this score are discarded before ranking |
| `scoring.min_volume_24h_bch` | BCH | `0.3` | Drop pools with sub-0.3 BCH 24h volume. Sized for a sub-$50 USD wallet — bigger wallets can raise this |
| `scoring.min_tvl_bch` | BCH | `0.25` | Drop pools with sub-0.25 BCH TVL. Protects against thin-pool slippage |
| `scoring.min_upward_volatility` | number 0..1 | `0.05` | T28c: hard gate — tokens with effectively no upward path in their 7-day price series are INELIGIBLE regardless of volume / TVL / APY. 0.05 ≈ "at least one small positive return in the window". Set to `0` to disable. HoneyBadgers scores ~0.18 (one small +0.88% spike) and passes; FEW scores 0 (monotonic decline 19.57 → 1.0) and fails |
| `scoring.max_pool_age_days` | days | `7` | T37: drop pools NEWER than this (was 90d / wrong-direction pre-T37). Freshly-launched pools carry wash-trade / seed-swap / rug-pull risk; the ranker drops tokens whose oldest active pool is younger than this many days. Match the entry-strategy `entry.min_pool_age_days` so both layers use the same threshold |
| `scoring.top_k_candidates` | int | `3` | Maximum tokens forwarded to entry evaluation per tick |
| `scoring.caps.volume_24h_bch` | BCH | `10.0` | Sigmoid-style cap on the raw `volume_24h_bch` value before weighting (prevents one mega-pool from dominating) |
| `scoring.caps.volume_7d_bch` | BCH | `50.0` | Same, for 7-day volume |
| `scoring.caps.tvl_bch` | BCH | `5.0` | Same, for TVL |
| `scoring.linear_caps.volatility_24h_pct` | % | `30.0` | Above 30% 24h volatility, the score contribution saturates |
| `scoring.linear_caps.apy_30d_pct` | % | `200.0` | Above 200% 30d APY, score contribution saturates |
| `scoring.linear_caps.fee_yield_bps` | bps | `500` | Above 500 bps fee yield, score contribution saturates |
| `scoring.fee_rate_bps` | bps | `30` | AMM fee rate (basis points). Used by the score formula to model LP income |

## 4. `entry` — position-opening policy

Controls how a `top_k_candidate` becomes a live trade.

| Knob | Type | Default | Effect |
|---|---|---|---|
| `entry.max_position_bch` | BCH | `0.005` | **Hard cap** on a single trade's BCH spend. Default ≈ $2.25 per trade on a $50 wallet. The bot NEVER spends more than this on a single trade, even if the wallet could afford it |
| `entry.max_total_exposure_bch` | BCH | `0.04` | **Hard cap** on aggregate open-position exposure. Default ≈ $18 |
| `entry.min_entry_gap_from_high_pct` | % | `2.0` | Don't enter if the token is currently within 2% of its 24h high (avoids buying the top) |
| `entry.slippage_tolerance_bps` | bps | `100` | Pre-flight reject if the simulated swap effective rate is worse than this. 100 bps = 1% (small AMM trades get worse execution than big ones; this is the right number for the small_balance_startup preset) |
| `entry.use_post_trade_check` | bool | `true` | Run `post_trade_check` after broadcast to verify on-chain effective rate matches the simulated rate. If the on-chain rate is worse than `slippage_tolerance_bps`, the position is auto-evicted (counted as a realized loss) |
| `entry.min_trade_size_bch` | BCH | `0.0005` | Skip trades smaller than this. At sub-0.0005 BCH the tx fees (≈ 1k sats) plus AMM slippage eat the entire position |
| `entry.max_indexer_vs_amm_ratio_x` | × | `1000` | **Pre-entry indexer-vs-AMM divergence guard** (T31). If the indexer's reference price (`stats.price_now_sats`, per DISPLAY unit) is more than this many times the AMM-implied spot rate (per BASE unit, computed from the active pools) — or less than 1/this-th of it — `shouldEnter` rejects the candidate with `kind:'indexer_vs_amm_divergence'` instead of entering. Without this guard the bot can open positions whose indexer reference price is wildly off the actual AMM rate (100,000,000× divergence was observed on QBTC 2026-09-14); take-profit then fires on the bogus indexer price on every subsequent tick and the swap layer's pre-flight slippage rejects every exit attempt until the 24h time-stop fires. The 1000× cap is wide enough that no legitimate 7d pump gets rejected, tight enough to cap the pathology-class failures. Guard is **skipped** when either side is missing (AMM probe failed, decimals unknown, indexer price is 0/NaN); the exit-side `max_price_vs_entry_ratio_x` (T28d) still catches the pathology post-entry. Implementation: `src/data/fetcher.mjs#bestAmmSpotSats` (pure reduction) + `src/trader/loop.mjs#_safeAmmSpotSats` (fetcher wrapper with statsIndex fast-path) |
| `entry.min_amm_total_depth_sats` | sats | `150_000_000` | **Pre-entry AMM depth floor** (T32). Reject the candidate when the total BCH-side reserves across the token's LIVE active pools (sum of `sats`) are below this floor. The existing `scoring.min_tvl_bch` ranker filter reads the indexer's cached `tvl_sats`, which can be stale or based on a different pool set than the one `prepareAndBuildSwap` actually routes through (QBTC 2026-09-14: indexer reported `tvl_bch=4.74` but live active pools summed to ~1.32 BCH — a 0.005 BCH buy consumed ~0.4% of pool liquidity). The T32 guard reads the LIVE pool totals directly. At the small-balance preset's `max_position_bch=0.005`, the 1.5 BCH floor means each trade consumes at most ~0.33% of pool depth. Set to `0` (or remove the knob) to disable. Guard is **skipped** when the AMM probe fails (returns `null`) — the existing `min_tvl_bch` ranker filter still screens the worst cases. Implementation: `src/data/fetcher.mjs#totalAmmSats` (pure reduction) + `src/trader/loop.mjs#_safeAmmTotalDepthSats` (fetcher wrapper with statsIndex fast-path) |
| `entry.max_position_concentration_pct` | % | `25.0` | **Position concentration cap** (T33). Wallet-relative per-trade ceiling — `position size = min(max_position_bch, walletBalanceBch * (pct / 100))`. Forces the bot to scale positions DOWN as the wallet shrinks: a single bad trade can no longer consume more than `pct%` of the current wallet balance. At the small-balance preset's `0.044 BCH` wallet and `25%` cap the per-trade ceiling is `0.011 BCH` — well above `max_position_bch=0.005`, so the cap is a no-op under normal conditions and only kicks in when the wallet shrinks below ~`0.02 BCH` (the intended safety net). Set to `0` / negative / `>100` to DISABLE (operator opts out, matches the `min_amm_total_depth_sats` opt-in pattern). Non-numeric values fall back to the default `25.0`. When the cap shrinks a position below the dust floor, `shouldEnter` rejects the candidate with `kind:'concentration_cap'` (distinct from the historical `kind:'size_zero'` dust-floor rejection so the operator can tell "wallet is too small for this cap" from "min_trade_size_bch swallowed the position"). Reasoning blob surfaces `max_position_concentration_pct` (configured) AND `concentration_cap_bch` (live, in BCH) so the operator audit trail shows both the knob AND the implied wallet-relative ceiling. Implementation: `src/strategy/entry.mjs#computeEntrySizeBch` (per-trade size reduction) + `shouldEnter` (NaN sentinel for cap-driven dust rejection) |
| `entry.volatility_sizing_target_pct` | % | `5.0` | **Volatility-adjusted sizing (Kelly-lite)** (T35). When the candidate's realized 24h volatility (`stats.volatility_24h_pct`) exceeds this target, the per-trade size is scaled DOWN by `target / realized` (linear, monotonic). E.g. target `5%` and realized `20%` → trade is quartered. We NEVER scale UP — Kelly-lite is asymmetric by design; the operator can raise `max_position_bch` themselves when they want more size on a calm token. At the default `5%` target, a QBTC-class entry (3.44% daily vol) gets the full `max_position_bch` ceiling, but a FEW-class entry (high-vol) gets a quartered position. Knob semantics: `0` / negative / `>100` / non-finite → guard DISABLED (operator opts out, matches T33). Missing / non-finite / negative `volatility_24h_pct` on the candidate → guard SKIPPED (conservative: don't shrink without data). Reasoning blob surfaces `vol_sizing_target_pct` (configured), `vol_sizing_realized_pct` (observed), AND `vol_sizing_scale` (effective — `1.0` = no-op, `<1.0` = guard reduced size). Implementation: `src/strategy/entry.mjs#computeEntrySizeBch` (new step 5 between T33 concentration cap and dust-floor flooring) |

**Safety invariant**: the bot will NEVER enter a trade if the wallet
balance is below `min_wallet_balance_bch + max_position_bch`. This
protects against tx-fee starvation.

## 5. `exit` — position-closing policy

Controls when an open position is converted back to BCH.

| Knob | Type | Default | Effect |
|---|---|---|---|
| `exit.take_profit_pct` | % | `5.0` | Close when current price ≥ entry × (1 + pct/100). Default: +5% |
| `exit.stop_loss_pct` | % | `3.0` | Close when current price ≤ entry × (1 − pct/100). Default: −3% |
| `exit.time_stop_hours` | hours | `24` | Close after this regardless of P&L. Default sized for sub-$50 wallets — bigger wallets can extend to 48–72h |
| `exit.time_stop_hours_synced` | hours | `6` | Shorter time-stop applied to **chain-synced positions** (`entry.source === 'on-chain-sync'`, e.g. imported by `scripts/sync-wallet-holdings.mjs`). These don't have a real entry price, so the regular TP/SL/trailing thresholds fall back to the HWM as the entry-price proxy; without a shorter cutoff they could sit burning exposure budget waiting for an unrealistic price recovery. Always clamped to `min(time_stop_hours, time_stop_hours_synced)` so a small `time_stop_hours` still wins |
| `exit.trailing_stop_pct` | % | `2.0` | After activation, trail the high-water mark by this percentage |
| `exit.trailing_stop_activation_pct` | % | `2.0` | Trailing stop doesn't engage until price has risen this % above entry |
| `exit.max_price_vs_entry_ratio_x` | × | `1000` | **Indexer-price sanity guard** (T28d). If the indexer's reported `price_now_sats` is more than this many times the position's entry price (or less than 1/this-th of it), the indexer price is treated as bogus and the position falls through to time-stop only. Prevents the "100,000,000× off" indexer pathology that bit QBTC 2026-09-14 from setting a wildly-off high-water mark and immediately triggering take-profit on every tick. Same helper (`src/util/price-sanity.mjs#isPricePlausibleVsEntry`) shared with `pnl.mjs` + `snapshots.mjs` so unrealized P&L also reflects the rejection |
| `exit.tp_vol_multiplier` | σ | `2.0` | **Dynamic take-profit multiplier** (T38). When the indexer's 29-point 7d price series is available for this token, TP is computed as `daily_vol_pct × tp_vol_multiplier` (a 2σ daily move) and clamped to `[tp_vol_floor_pct, tp_vol_ceiling_pct]`. Set to `0` (or negative / non-finite) to **disable** dynamic TP — the fixed `take_profit_pct` applies. The fixed 5% TP fires before any real move on high-vol tokens (~18% daily σ for FEW) and is unreachable on low-vol tokens (~0.2% daily σ for QBTC); the dynamic version fixes both |
| `exit.sl_vol_multiplier` | σ | `1.0` | **Dynamic stop-loss multiplier** (T38). Same pattern as `tp_vol_multiplier` — SL is computed as `daily_vol_pct × sl_vol_multiplier` (a 1σ daily move) and clamped to `[sl_vol_floor_pct, sl_vol_ceiling_pct]`. Set to `0` to **disable** — the fixed `stop_loss_pct` applies |
| `exit.tp_vol_floor_pct` | % | `2.0` | **Minimum dynamic TP%** (T38). Lower clamp — even if `daily_vol_pct × tp_vol_multiplier` is tiny, the dynamic TP will never be tighter than this. Keeps the bot from exiting on noise. Mirrors the original small-balance 5%/3% posture for ~5%-daily-vol tokens (TP at the floor = 2%; a 5%-vol token's natural TP would be 10%, so the floor only matters for sub-1%-vol tokens) |
| `exit.tp_vol_ceiling_pct` | % | `80.0` | **Maximum dynamic TP%** (T38). Upper clamp — a 100%+ TP is just "never take profit", which is a bug. Prevents runaway TP for crazy-volatile tokens |
| `exit.sl_vol_floor_pct` | % | `1.0` | **Minimum dynamic SL%** (T38). Lower clamp for the dynamic stop-loss. Tighter than the TP floor — a wide SL on a low-vol token is silently losing money every tick |
| `exit.sl_vol_ceiling_pct` | % | `50.0` | **Maximum dynamic SL%** (T38). Upper clamp for the dynamic stop-loss. Tighter than the TP ceiling — a 100%+ SL means "let it ride into the ground" |

The trailing stop is implemented as a soft exit that becomes a hard
exit once `current_price ≤ high_water_mark × (1 − trailing_stop_pct/100)`.
Before activation, the take-profit + stop-loss + time-stop paths fire
unchanged.

## 6. `risk` — circuit breakers + wallet floor

| Knob | Type | Default | Effect |
|---|---|---|---|
| `risk.max_daily_loss_bch` | BCH | `0.005` | If realized losses for the rolling 24h exceed this, halt all new entries for the rest of the window |
| `risk.max_consecutive_losses` | int | `3` | Three losses in a row → halt for `circuit_breaker_cooldown_hours` |
| `risk.circuit_breaker_cooldown_hours` | hours | `6` | Cooldown after a trip |
| `risk.min_wallet_balance_bch` | BCH | `0.005` | **Always keep this much in the wallet**, even with zero open positions. Protects against tx-fee starvation on the next trade |

**Hard invariants** enforced in code (see `src/strategy/risk/limits.mjs`):

- The bot will NOT enter a trade if `wallet_balance < min_wallet_balance_bch + max_position_bch`.
- The bot will NOT open a position if doing so would push total exposure above `max_total_exposure_bch`.
- The bot will NOT spend more than `max_position_bch` on a single trade, even if the wallet could afford it.

If any of these is violated, the bot raises `RiskViolationError` and
does NOT call `swap.execute`. A unit test in `tests/risk-limits.test.mjs`
fails loudly if any of these knobs is ignored.

## 7. `wallet` — bot's WIF + network identity

`user.json` is the only place `wallet.wif` lives. `default.json` ships
without a WIF; `init-wallet.mjs` (T15) generates it on first run.

| Knob | Type | Default | Effect |
|---|---|---|---|
| `wallet.backend` | string | `"external_wif"` | Tells the trader loop how to sign. `"external_wif"` = libauth signs directly with the WIF from `user.json`. Other backends (`paytaca_cli`) are planned but not used |
| `wallet.bip44_path` | string | `"m/44'/145'/0'/0/0"` | BIP44 derivation path. BCH uses coin type `145` |
| `wallet.network` | string | `"mainnet"` | `"mainnet"` or `"chipnet"`. Mainnet is the day-one default (user decision 2026-09-10 — no chipnet soak) |
| `wallet.address` | cashaddr | (set by `init-wallet.mjs`) | Derived cashaddr for the WIF. Echoed back in `GET /api/summary` so the operator can sanity-check |

`user.json` adds:

| Knob | Type | Default | Effect |
|---|---|---|---|
| `wallet.wif` | string | (generated) | The WIF. **NEVER** commit this — pre-commit hook blocks it |
| `wallet.mnemonic` | string | (generated) | The BIP39 mnemonic. **NEVER** commit this |
| `wallet.cashaddr` | string | (derived) | Derived from the WIF |
| `wallet.last_balance_check` | object | (set on every snapshot) | Most-recent chain-confirmed balance — `at`, `satoshis`, `bch`, `source`, `utxo_count`, `utxo` |

## 8. `loop` — main-loop timing

| Knob | Type | Default | Effect |
|---|---|---|---|
| `loop.poll_interval_seconds` | seconds | `60` | How often the trader re-evaluates entry/exit conditions |
| `loop.snapshot_interval_seconds` | seconds | `300` | How often a fresh `data/snapshots/<date>.jsonl` row is appended |
| `loop.history_retention_days` | days | `365` | History events older than this are evicted from the in-memory tail (the on-disk NDJSON keeps everything) |

Polling cadence matters because the indexer is poll-based (no
websocket). For a sub-$50 wallet, 60 s is the right cadence — going
faster doesn't help when individual trades are $2 each and the AMM fee
is 30 bps.

## 9. `data_sources` — indexer + Electrum

| Knob | Type | Default | Effect |
|---|---|---|---|
| `data_sources.cauldron_indexer_base_url` | URL | `"https://indexer.riften.net/cauldron"` | The cauldron REST endpoint. Swap to `https://indexer-chipnet.riften.net/cauldron` for chipnet testing |
| `data_sources.electrum_host` | host | `"electrum.imaginary.cash"` | Electrum server used by `cashscript.ElectrumNetworkProvider` for UTXO + balance queries |
| `data_sources.electrum_port` | port | `50004` | TLS port (not 50001 plain-text — TLS keeps tx broadcasts quiet on hostile networks) |
| `data_sources.user_agent` | string | `"TradeBot/0.1 (LifestoneLabs)"` | User-Agent for HTTP requests to the indexer |

## 10. `dashboard` — read-only HTTP backend

Controls `scripts/start-dashboard.mjs` and the read-only HTTP surface
at `src/dashboard/server.mjs`. The React UI (T17) reads from this.

| Knob | Type | Default | Effect |
|---|---|---|---|
| `dashboard.bind_host` | string | `"127.0.0.1"` | Bind host. Set to `"0.0.0.0"` to expose beyond localhost (NOT recommended — the dashboard is read-only by design) |
| `dashboard.bind_port` | port | `8787` | Bind port. Pick anything 1024..65535 |
| `dashboard.request_timeout_ms` | ms | `10000` | Per-request timeout. A stuck portfolio read returns HTTP 504 after this |
| `dashboard.cors_origin` | string\|null | `null` | `null` = same-origin only. `"*"` = wildcard. Any other string is echoed back verbatim |
| `dashboard.log_level` | level | `"info"` | Structured logger level for the dashboard process: `"debug"`, `"info"`, `"warn"`, `"error"` |
| `dashboard.api_token` | string\|null | `null` | **Belt-and-braces** write gate. If unset, `PUT /api/config` and `POST /api/risk/reset` return HTTP 503. Set in `user.json` (NEVER in `default.json`) |
| `dashboard.history_max_events` | int | `5000` | Tail cap for `GET /api/history?limit=N`. Defaults to 5000 if `?limit` is missing or unparseable |
| `dashboard.snapshots_max_records` | int | `2000` | Tail cap for `GET /api/snapshots?limit=N` |
| `dashboard.snapshot_default_range` | duration | `"30d"` | Default range for `GET /api/snapshots` (when no `?range=` is provided). Accepts `s`/`m`/`h`/`d`/`w`/`all` |
| `dashboard.history_default_range` | duration | `"7d"` | Default range for `GET /api/history` |
| `dashboard.positions_default_status` | status | `"open"` | Default status for `GET /api/positions`. One of `open` / `pending` / `closing` / `closed` / `all` |
| `dashboard.auth_header_name` | string | `"authorization"` | Header name for the bearer token. Override if you front the dashboard with a proxy that strips `Authorization` |
| `dashboard.research_runs_max_events` | int | `50` | Tail cap for `GET /api/research-runs?limit=N` (T30c). Defaults to 50 (≈5-6 days at the 12h rate-limit). Mirrors `history_max_events` for the research-cron-run feed. |
| `dashboard.reasoning_max_ticks` | int | `5` | Tail cap for `GET /api/reasoning?limit=N` (T25b). Defaults to 5 most recent ticks. |
| `dashboard.reasoning_decisions_per_tick` | int | `20` | Max decisions rendered per tick on the REASONING view (T25b). Larger values make the per-tick card larger but slow down the SPA. |

### 10.1 Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/healthz` | no | Liveness probe (`{ ok: true, ts, uptime_s }`) |
| `GET` | `/api/summary` | no | One-shot payload for the DASHBOARD view (balance + realized + unrealized + per-token) |
| `GET` | `/api/positions` | no | Open positions for the PORTFOLIO view (entry reasoning included) |
| `GET` | `/api/history` | no | Tick history events for the DASHBOARD charts. Supports `?range=7d&kind=entry&limit=N` |
| `GET` | `/api/snapshots` | no | Balance-over-time records. Supports `?range=30d&token_id=...&limit=N` |
| `GET` | `/api/research-runs` | no | Tail of `kind:'research_cron_run'` history events (T30c). Supports `?range=7d&limit=N`. Powers the "Recent cron runs" panel on the PROPOSALS view. |
| `GET` | `/api/config` | no | Effective config (every redactable field replaced with `[REDACTED]`) |
| `GET` | `/api/risk` | no | Circuit-breaker state. Returns `code: NO_BREAKER` if the dashboard is run standalone (no trader loop wired) |
| `GET` | `/api/activity` | no | Tail of history events + most-recent snapshot — powers the live "tick" indicator |
| `PUT` | `/api/config` | **yes** | Deep-merge JSON body onto `config/user.json` (atomic write) |
| `POST` | `/api/risk/reset` | **yes** | Manually clear the circuit breaker (audit-logged) |

### 10.2 Auth model

- The dashboard is **read-only by default**. Every `GET` route is open
  and read-only.
- The two write routes (`PUT /api/config`, `POST /api/risk/reset`)
  require `Authorization: Bearer <dashboard.api_token>`. The token is
  compared with `crypto.timingSafeEqual` to prevent timing attacks.
- If `dashboard.api_token` is unset (the `default.json` default), the
  write routes return **HTTP 503** with `code: AUTH_NOT_CONFIGURED` —
  the dashboard intentionally surfaces a *misconfiguration* rather than
  pretending the endpoint is locked.
- `PUT /api/config` rejects bodies containing `wif` / `mnemonic` /
  `xprv` / `seed` / `bip39` / `passphrase` / `private_key` keys (at any
  nesting depth). Even with a valid token, the dashboard will not
  persist a secret-looking field via this endpoint — those belong in
  `user.json` only.

## 11. `paths` — runtime file locations (all optional)

Every path knob in the bot is **optional** — when the operator leaves
it unset, the relevant module falls back to a hard-coded default
suitable for a normal workspace checkout. The convention is:

```
cfg.paths.<key>            ??  '<hard-coded default>'
```

This means every entry below is a *documentation* of where each
module stores its state — it does **not** have to be set in
`config/default.json`. The `paths.*` knobs exist primarily for
operator convenience: cluster deploys, CI sandboxes, and
containerized runs all benefit from being able to point every
runtime file at a single mount without grepping source code.

| Knob | Default fallback | Used by | Purpose |
|---|---|---|---|
| `paths.positions_file` | `data/positions.json` | `Positions` store, dashboard `/api/positions` | The bot's open/closed positions ledger |
| `paths.snapshots_dir` | `data/snapshots/` | `Snapshots` store, dashboard `/api/snapshots` | NDJSON balance + position snapshots (one file per snapshot) |
| `paths.history_file` | `data/history.ndjson` | `history` ring, dashboard `/api/history` | Per-event audit log (trades, ticks, reasoning, manual exits) |
| `paths.feature_ideas_file` | `data/feature-ideas.json` | `FeatureIdeasStore`, dashboard `/api/feature-ideas` | The operator-curated feature-ideas tab (T30) |
| `paths.todo_file` | `TODO.md` (workspace root) | `supervisor-bridge.appendApprovedIdeaToTodo` (T30) | The supervisor's TODO list — append target when an idea is approved |
| `paths.user` | `config/user.json` | dashboard `PUT /api/config` | Per-host overrides (WIF, mnemonic, api_token) |

The dashboard boot script (`scripts/start-dashboard.mjs`) logs the
resolved path for every store at boot, prefixed with the source
(`cli:`, `cfg.paths.`, or `default:`). No path knob is *required*
to be set; the bot is fully functional with every value left
unset.

## 12. Knobs that intentionally do NOT exist

These are deliberate omissions — adding them would break the safety model.

| Not-a-knob | Why |
|---|---|
| `trading.spend_all_balance` | The bot MUST cap spend via `entry.max_position_bch` |
| `trading.allow_secret_in_request_body` | The dashboard MUST refuse redactable keys |
| `trading.disable_post_trade_check` | The bot MUST verify on-chain effective rate |
| `trading.negative_min_wallet_balance_bch` | Negative floor would defeat the tx-fee starvation guard |
| `wallet.import_paytaca_keychain` | The bot's WIF stays isolated from the user's paytaca wallet slot |
| `dashboard.disable_cors_default` | CORS defaults to same-origin (the SAFE default); operator must explicitly opt into wildcard |

## 13. Changelog

| When | Change |
|---|---|
| 2026-09-10 | Initial schema shipped with T01 (`version: 1`) |
| 2026-09-10 | T03b retuned for `small_balance_startup` (max_position_bch=0.005, slippage 100 bps, time-stop 24h) |
| 2026-09-10 | T10 switched from paytaca-cli wrapper to direct libauth+cashscript (no `wallet.paytaca_cli_path` knob) |
| 2026-09-11 | T15 added `scripts/run-bot.mjs` + `scripts/init-wallet.mjs` + `scripts/snapshot.mjs` |
| 2026-09-11 | T16 added `dashboard.*` block (this doc + `src/dashboard/server.mjs`) — `version: 2` |
| 2026-09-12 | T23a fixed Electrum host parsing (now stored as bare hostname + port) |
| 2026-09-12 | T24 wired `--dry-run` through `TradingLoop` (dry-run skips broadcasts + on-disk position mutations) |
| 2026-09-12 | T26a/b/c dashboard green theme + tabbed history/activity widgets + Paytaca BCMR token enrichment |
| 2026-09-12 | T25b `history.append({kind:'tick_reasoning'})` event + dashboard REASONING widget |
| 2026-09-12 | T23b/c/d/e wallet socket lifecycle + WIF boot path + Electrum disconnect fix |
| 2026-09-13 | T26d added `cfg.scoring.excluded_tokens` + `cfg.scoring.stablecoins` (filter raw fetcher output before scoring) |
| 2026-09-13 | T27 fixed BUY-side `amountBch` confusion in `SwapExecutor.preFlightCheck` |
| 2026-09-13 | T27e added `/api/wallet/balance` + `scripts/sync-wallet-holdings.mjs` + `WalletSummaryCard` |
| 2026-09-13 | T27f migrated wallet to token-aware cashaddr (`bitcoincash:z…`) so swap sell-side can land |
| 2026-09-13 | T27g added `scripts/manual-test-trade.mjs` + `scripts/sweep-funds.mjs` |
| 2026-09-13 | T28 fixed latent BUY-side budget-vs-base-units mismatch in `SwapExecutor.execute()` |
| 2026-09-13 | T29 added `scripts/reconcile-position.mjs` (operator tool for off-band exits) |
| 2026-09-13 | T28b added `time_stop_hours_synced` + 6h time-stop for chain-synced positions (HWM-as-entry-proxy) |
| 2026-09-13 | T28c added `scoring.weights.upward_volatility` + `scoring.min_upward_volatility` gate (FEW-class tokens now ineligible) |
| 2026-09-14 | T28d fixed `shouldExit` indexer-price sanity guard (rejects 100M× off prices) |
| 2026-09-14 | T31 added `entry.max_indexer_vs_amm_ratio_x` pre-entry indexer-vs-AMM divergence guard (rejects entries where the indexer reference price is wildly off from the AMM-implied spot rate) |
| 2026-09-14 | T28e extracted `src/util/price-sanity.mjs` helper + shared with `pnl.mjs`, `snapshots.mjs`, `loop.mjs`, `server.mjs` (dashboard summary now respects the guard) |
| 2026-09-14 | T30 added `feature-ideas` subsystem: dashboard tab + research cron scaffold + approve→TODO bridge + `paths.feature_ideas_file` + `paths.todo_file` knobs |
| 2026-09-14 | T30b shipped `scripts/feature_researcher.mjs` (cron entry point) + curated catalog + dashboard PROPOSALS view + 46 templates |
| 2026-09-14 | T30c added `kind:'research_cron_run'` history event + `/api/research-runs` endpoint + `dashboard.research_runs_max_events` knob (default 50) + PROPOSALS "Recent cron runs" panel; added `--no-history` / `--history` flags to `feature_researcher.mjs`; documented `reasoning_max_ticks` + `reasoning_decisions_per_tick` knobs |
| 2026-09-15 | T32 added `entry.min_amm_total_depth_sats` (default `150_000_000` sats = 1.5 BCH) pre-entry AMM depth floor — rejects candidates whose LIVE active-pools depth is below the floor (QBTC 2026-09-14 had live ~1.32 BCH despite indexer `tvl_bch=4.74`). Reads from the active-pools endpoint, not from cached `tvl_sats`. Pair with T31 for full QBTC pathology coverage. New `src/data/fetcher.mjs#totalAmmSats` pure helper + `src/trader/loop.mjs#_safeAmmTotalDepthSats` fetcher wrapper with statsIndex fast-path |
| 2026-09-16 | T43 added the dashboard SETTINGS view — read-only knob catalog with description + restart-required badges, write-enabled via `?token=...` matching `dashboard.api_token` (catalog + `dashboard/src/lib/knob-explanations.mjs` + `dashboard/src/views/Settings.jsx`; `PUT /api/config` server-side validator rejects unknown knobs / secret-shaped keys / out-of-bounds values) |
| 2026-09-16 | T43b catalog-driven validation + per-knob search/filter: numeric `min` / `max` / `step` bounds on every numeric knob (50 knobs); inline `validateKnobValue` tooltip (below_min / above_max / nan / wrong_type / empty_text / not_integer); clamp-on-blur so out-of-range input snaps into the safe envelope; fuzzy per-knob search input at the top of the view (multi-token AND across label / key / group, score-ranked; per-panel hide-when-empty; `showing N / M` counter + `no knobs match` notice) |
| 2026-09-16 | T43c subset 1 (UI affordances): per-knob `?` help popover (pure CSS via `<details>`) showing the full KnobMeta entry (description, unit, kind, restart flag, min/max/step, baseline value, rangeHint) + `⤺` reset-to-default link that reads the pristine `config/default.json` baseline via the new `GET /api/config/defaults` endpoint and resets just that one knob without touching the others. Helpers: `defaultValueAtPath(defaultConfig, path)` (O(depth) lookup with typed `{found, reason}` errors), `formatJsonValue(value)` (compact renderer for booleans / numbers / strings / arrays / objects), `buildHelpPopover(meta, {defaultConfig})` (structured rows array the popover table renders). Disabled when `dashboard.api_token` is missing OR defaults fetch fails OR the path is missing from default.json (catalog drift) OR the current value already equals the baseline (no-op). Banner surfaces a `defaults unavailable: …` warning when the endpoint fails so the operator doesn't think the buttons are broken |
| 2026-09-15 | T33 added `entry.max_position_concentration_pct` (default `25.0`) wallet-relative position concentration cap. New `src/strategy/entry.mjs#computeEntrySizeBch` step reduces per-trade size to `min(max_position_bch, walletBalanceBch * pct/100)`; NaN sentinel returned when the cap shrinks a position below the dust floor; `shouldEnter` surfaces the rejection as `kind:'concentration_cap'` (distinct from the existing `kind:'size_zero'` dust-floor path). Disabled by setting `pct` to `0` / negative / `>100`. Reasoning blob surfaces both the configured percentage AND the live wallet-relative ceiling in BCH. `scripts/run-bot.mjs#resolveTradingKnobs` now exposes the knob in the boot banner |
| 2026-09-15 | T35 added `entry.volatility_sizing_target_pct` (default `5.0`%) Kelly-lite volatility-adjusted sizing — when the candidate's realized 24h volatility exceeds the target, the per-trade size is scaled DOWN by `target / realized` (never scaled UP). `shouldEnter` threads `candidate.stats.volatility_24h_pct` into `computeEntrySizeBch` step 5; reasoning blob surfaces `vol_sizing_target_pct` / `vol_sizing_realized_pct` / `vol_sizing_scale` for operator audit. `scripts/run-bot.mjs#resolveTradingKnobs` + boot banner expose the knob; dashboard Settings.jsx adds the new row. Disabled by setting `pct` to `0` / negative / `>100` |