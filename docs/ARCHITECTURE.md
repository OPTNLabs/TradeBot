# TradeBot — Architecture

**Status:** Living doc. First cut shipped with T04 (2026-09-10). Update when a
new subsystem lands; keep sequence diagrams in sync with `src/trader/loop.mjs`.

---

## 1. Mission recap

A hot-wallet trading bot that monitors every pool on the [Cauldron DEX][cauldron]
on BCH, scores pools by recent volume + volatility + TVL, and — when the
scoring + entry conditions align — opens **BCH → token** positions on the
highest-scoring tokens and closes them again (**token → BCH**) when
take-profit, stop-loss, trailing-stop, or time-stop thresholds fire. Every
trade + every wallet balance snapshot is recorded to `data/` for a full
historical audit; the dashboard exposes DASHBOARD / PORTFOLIO / SETTINGS
views on top of that history.

[cauldron]: https://cauldron.quest/

## 2. System context

```
              ┌──────────────────────────────────────────────────┐
              │  Cauldron Indexer (third-party, trusted)          │
              │  https://indexer.riften.net/cauldron              │
              │    GET /tokens/list_cached?limit=N                │
              │    GET /pool/{token_id}?type=active                │
              │    GET /bcmr/token/{token_id}                     │
              │  + Electrum (wss) for tx broadcast + post-trade   │
              │    verification                                  │
              └──────────────┬───────────────────────────────────┘
                             │ HTTPS, poll every loop.poll_interval_seconds
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  TradeBot process (Node 20+, ESM, single host)                      │
│                                                                     │
│   ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐    │
│   │ src/data   │  │ src/       │  │ src/       │  │ src/       │    │
│   │ fetcher    │→ │ strategy/  │→ │ trader/    │→ │ portfolio/ │    │
│   │  (read)    │  │ scoring,   │  │ swap,      │  │ positions, │    │
│   │            │  │ entry,     │  │ loop       │  │ pnl,       │    │
│   │            │  │ exit       │  │            │  │ snapshots  │    │
│   └────────────┘  └────────────┘  └─────┬──────┘  └─────┬──────┘    │
│                                         │               │           │
│                                         ▼               ▼           │
│                              ┌─────────────────┐  ┌──────────────┐   │
│                              │ src/wallet/     │  │ data/        │   │
│                              │ paytaca.mjs     │  │ positions,   │   │
│                              │ (signing +      │  │ history,     │   │
│                              │  balance)       │  │ snapshots    │   │
│                              └────────┬────────┘  └──────┬───────┘   │
└───────────────────────────────────────┼──────────────────┼───────────┘
                                        │ spawn            │ read
                                        ▼                  ▼
                              ┌───────────────────┐  ┌────────────────┐
                              │ paytaca-cli       │  │ dashboard/     │
                              │ (local binary,    │  │ server.mjs     │
                              │  holds seed in    │  │ → React UI     │
                              │  OS keychain)     │  │                │
                              └────────┬──────────┘  └────────────────┘
                                       │
                                       ▼
                              ┌───────────────────┐
                              │ BCH mainnet /     │
                              │ chipnet           │
                              └───────────────────┘
```

**Trust boundaries** (dashed in diagrams, implicit here):

1. **Internet → indexer.** Untrusted third party. Responses are validated by
   shape (`src/data/types.mjs`) and never trusted for fields that affect
   *signing* (price/slippage) without a second `post_trade_check` pass.
2. **Bot process → `paytaca-cli`.** Local subprocess. WIF stays inside
   paytaca-cli's keychain — the bot never reads it. The bot's wrapper only
   talks to paytaca-cli via its CLI surface.
3. **Bot process → `data/` files.** Same UID. Atomic writes via
   `write-tmp + rename` so a SIGKILL mid-write can't corrupt state.
4. **Dashboard server → React UI.** Same host. Read-only. The server
   exposes **no** write endpoints except `PUT /api/config` (writes
   `config/user.json`, never touches wallet state).

## 3. Module / container view

```
TradeBot/
├── src/
│   ├── data/
│   │   ├── types.mjs           # JSDoc typedefs (Token, Pool, PoolStats)
│   │   └── fetcher.mjs         # indexer wrapper, cache, retry, rate-limit
│   ├── strategy/
│   │   ├── scoring.mjs         # pure: scorePool(stats, config) → { score, breakdown }
│   │   ├── ranker.mjs          # pure: rankPools(pools, config) → topK[]
│   │   ├── entry.mjs           # pure: shouldEnter(candidate, positionState, config)
│   │   └── exit.mjs            # pure: shouldExit(position, market, config)
│   ├── trader/
│   │   ├── swap.mjs            # wraps AI_Skills .../cauldron/scripts/check_and_swap.mjs
│   │   ├── fees.mjs            # fee accumulator (BCH + USD/CAD)
│   │   └── loop.mjs            # main loop: fetch → score → decide → swap → record
│   ├── wallet/
│   │   └── paytaca.mjs         # CLI wrapper: balance, getNewAddress, listutxos,
│   │                           #   send, signRawTransaction, decoderawtransaction
│   ├── portfolio/
│   │   ├── positions.mjs       # open positions CRUD (atomic file IO)
│   │   ├── pnl.mjs             # realized + unrealized P&L
│   │   └── snapshots.mjs       # periodic balance + position snapshots
│   ├── risk/
│   │   ├── limits.mjs          # per-trade + aggregate exposure gates
│   │   └── circuit-breaker.mjs # halt on consecutive losses / daily-loss cap
│   └── util/
│       ├── logger.mjs          # structured NDJSON logger (no console.log)
│       ├── config.mjs          # default.json + user.json merge
│       ├── atomic-write.mjs    # write .tmp + rename
│       └── retry.mjs           # exp-backoff with jitter + per-op timeout
├── scripts/
│   ├── run-bot.mjs             # boot the loop, SIGINT handler, state flush
│   ├── init-wallet.mjs         # generate/import the throwaway wallet WIF
│   ├── snapshot.mjs            # one-shot P&L snapshot for cron reporting
│   ├── pre-commit-key-scan.sh  # mirrors AI_Skills pre-commit hook
│   └── git-hooks/              # core.hooksPath target
├── dashboard/
│   ├── server.mjs              # Fastify read-only HTTP API
│   └── src/
│       ├── views/{Dashboard,Portfolio,Settings}.jsx
│       └── components/PositionCard.jsx
├── config/
│   ├── default.json            # canonical config schema (committed)
│   └── user.json               # gitignored: WIF + RPC overrides
├── data/                       # gitignored, runtime state
│   ├── positions.json
│   ├── history.jsonl
│   └── snapshots.jsonl
└── tests/                      # node --test, no extra deps
    ├── scoring.test.mjs
    ├── ranker.test.mjs
    ├── fetcher.test.mjs        # uses fixture responses (no network)
    ├── swap.test.mjs           # mocks AI_Skills cauldron CLIs
    ├── server.test.mjs         # supertest
    └── integration.test.mjs    # chipnet mock
```

### 3.1 Module dependency graph (one direction only)

```
util/*  ←  data/*  ←  strategy/*  ←  trader/*  ←  scripts/run-bot.mjs
                                ↖              ↖
                                 portfolio/*   risk/*
                                ↗
                wallet/paytaca.mjs  ←───  trader/swap.mjs
```

Pure helpers (`strategy/scoring`, `strategy/ranker`, `strategy/entry`,
`strategy/exit`, `portfolio/pnl`) take config as an argument and have **no
side effects**. Every impure module (the ones that touch indexer / wallet /
disk) lives below the pure layer and is the only thing that imports the
pure layer. This is what keeps the test suite pure-function-driven.

## 4. Sequence diagrams

### 4.1 Poll cycle (every `loop.poll_interval_seconds`)

```
loop.tick()
  │
  ├─→ fetcher.listPoolsCached()             ← cached for ttl=30s
  │     on 5xx: retry ×3 (exp-backoff); persist last-known cache; log warn
  │     on 4xx: rethrow → loop tick aborts, logger.error
  │
  ├─→ for each pool in cache:
  │     fetcher.getTokenStats(tokenId)
  │       cached for ttl=poll_interval
  │       failures isolated per-pool (one bad pool ≠ tick abort)
  │
  ├─→ strategy.ranker.rankPools(pools, config) → candidates[]
  │
  ├─→ snapshots.maybeSnapshot()              ← every snapshot_interval_seconds
  │     atomic-write positions.json + snapshots.jsonl
  │
  ├─→ for each candidate: trader.shouldEnter(candidate, openPositions, config)
  │     if yes:
  │       risk.limits.canOpen(...) → boolean
  │       if yes: swap.enterPosition(tokenId, bchAmount)
  │
  ├─→ for each open position: trader.shouldExit(position, market, config)
  │     if yes:
  │       swap.exitPosition(tokenId, tokenAmount)
  │
  └─→ wallet.paytaca.getBalance()            ← every N ticks (cheap)
        if balance < risk.min_wallet_balance_bch → circuit-breaker.halt
```

### 4.2 Entry decision (success path)

```
swap.enterPosition(tokenId, bchAmount)
  │
  ├─→ validate: amount > 0, amount ≤ config.entry.max_position_bch
  ├─→ validate: totalOpenExposure() + amount ≤ config.entry.max_total_exposure_bch
  │
  ├─→ risk.limits.canEnter(tokenId, side="buy")
  │     rejects if: recent loss for token, daily loss cap reached,
  │                  circuit-breaker tripped, blacklist
  │
  ├─→ swap.simulate(tokenId, side="buy", amount=bchAmount)
  │     calls cauldron-simulate-swap --accept-rate=<ceiling>
  │     non-zero exit ⇒ abort (slippage too high OR no active pool)
  │
  ├─→ swap.postTradeCheck(tokenId, expectedEffectiveRate)
  │     pre-flight sanity (expected rate still within tolerance)
  │
  ├─→ swap.execute(tokenId, side="buy", amount=bchAmount)
  │     spawns cauldron-check-and-swap --execute --wallet=paytaca
  │     stdin-piped "y" once the human-readable plan is confirmed sane
  │     returns: { txid, entryPrice, tokenAmount, feeSats, broadcastMs }
  │
  ├─→ positions.open({
  │       tokenId, txid, entryPrice, tokenAmount, bchSpent,
  │       feeSats, entryReason: { score, breakdown, conditions, ts },
  │       openedAt: now
  │     })
  │     atomic-write positions.json
  │
  └─→ history.append({ kind: "entry", ... })  → history.jsonl (NDJSON)
        logger.info({ event: "entry", ... })   → util/logger
```

**No state is written before the on-chain tx confirms.** The on-chain
result is the source of truth; in-memory caches are flushed on success.

### 4.3 Exit decision (take-profit / stop-loss / trailing / time-stop)

```
for each position in positions.listOpen():
  market = fetcher.getTokenStats(position.tokenId)
  pnl = pnl.compute(position, market)        # unrealized, BCH-denominated
  decision = exit.shouldExit(position, market, config)
    │
    ├─ take-profit: market.price ≥ position.entryPrice * (1 + take_profit_pct/100)
    ├─ stop-loss  : market.price ≤ position.entryPrice * (1 - stop_loss_pct/100)
    ├─ trailing   : high-water-mark tracked in position; trail once
    │               price has fallen trailing_stop_pct from HWM after
    │               trailing_stop_activation_pct gain
    └─ time-stop  : now - position.openedAt > exit.time_stop_hours
  if decision.exit:
    swap.exitPosition(tokenId, position.tokenAmount, exitReason=decision.reason)
      │
      ├─→ swap.simulate(side="sell", amount=tokenAmount)
      ├─→ swap.execute(side="sell", amount=tokenAmount)
      ├─→ positions.close(positionId, { exitTxid, exitPrice, bchReceived, pnl })
      ├─→ history.append({ kind: "exit", ... })
      └─→ circuit-breaker.recordResult(pnl)   # may trip on consecutive losses
```

### 4.4 Error handling (representative paths)

| Failure | Detection | Action |
|---|---|---|
| Indexer 5xx / timeout | `fetcher` exp-backoff retries 3× | Persist last cache; tick continues with stale data; `logger.warn` |
| Indexer 4xx | `fetcher` rethrows typed `IndexerError` | Skip this tick; **circuit-breaker does NOT trip** (indexer-side, not strategy) |
| `paytaca-cli` exit ≠ 0 | `wallet/paytaca.mjs` parses stderr | `logger.error`; skip this tick; do **not** retry blindly |
| `swap.execute` fails mid-build | cashscript throws pre-broadcast | `positions` untouched; record to `history.jsonl` as `kind:"entry_failed"` |
| `swap.execute` broadcasts but tx never confirms | `post_trade_check` after 60s | Mark position as `pending`; re-poll until confirmed or evicted after 30 min |
| Wallet balance < `min_wallet_balance_bch` | end of tick | `circuit-breaker.halt("low_balance")`; tick no longer opens new positions |
| `consecutive_losses ≥ max_consecutive_losses` | end of exit | `circuit-breaker.halt("loss_streak")`; cooldown `circuit_breaker_cooldown_hours` |
| Daily realized loss ≥ `max_daily_loss_bch` | end of exit | `circuit-breaker.halt("daily_loss_cap")`; resume next UTC day |
| Process SIGTERM | `run-bot.mjs` SIGINT handler | Flush pending in-memory state; atomic-write `positions.json`; exit 0 |
| Crash (SIGKILL / OOM) | next boot | `positions.json` last write was atomic; reconcile from on-chain txs via `wallet.listUtxos` for tokens + BCH |

## 5. Data model

### 5.1 `data/positions.json` (atomic, JSON)

```jsonc
{
  "version": 1,
  "updatedAt": "2026-09-10T17:01:23.456Z",
  "open": [
    {
      "id": "pos_01HZ...ULID",
      "tokenId": "2469acc5afa4b10cb5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544",
      "tokenSymbol": "PUSD",                      // resolved from BCMR; denormalized
      "side": "long_token",
      "entry": {
        "txid": "ab12...",
        "priceSatsPerToken": 14500,
        "bchSpent": 14587432,                     // sats
        "tokenAmountBase": 1000000,               // base units (decimals-applied)
        "feeSats": 43762,
        "broadcastMs": 1840,
        "ts": "2026-09-10T16:42:11.000Z"
      },
      "highWaterMarkSatsPerToken": 15200,         // for trailing stop
      "reasoning": {                              // ← surfaced in PORTFOLIO view
        "score": 0.82,
        "scoreBreakdown": {
          "volume_24h_bch": 0.91,
          "volume_7d_bch": 0.74,
          "volatility_24h_pct": 0.88,
          "tvl_bch": 0.62,
          "apy_30d_pct": 0.71,
          "fee_yield_bps": 0.40
        },
        "rank": 2,
        "topK": 5,
        "conditions": {
          "min_entry_gap_from_high_pct_met": true,
          "slippage_tolerance_bps": 50,
          "post_trade_check_passed": true,
          "expectedEffectiveRateSatsPerToken": 14587
        },
        "ts": "2026-09-10T16:42:10.500Z"
      },
      "openedAt": "2026-09-10T16:42:11.000Z",
      "status": "open"                            // open | closing | closed
    }
  ]
}
```

### 5.2 `data/history.jsonl` (append-only NDJSON)

One line per state-changing event. Schema is a tagged union on `kind`:

```
{ "kind": "entry",       "ts": "...", "positionId": "...", "tokenId": "...", "txid": "...", "bchSpent": ..., "tokenAmountBase": ..., "feeSats": ... }
{ "kind": "entry_failed","ts": "...", "tokenId": "...", "reason": "slippage_exceeded", "simulate": {...} }
{ "kind": "exit",        "ts": "...", "positionId": "...", "txid": "...", "bchReceived": ..., "realizedPnlSats": ..., "feeSats": ..., "exitReason": "take_profit" }
{ "kind": "exit_failed", "ts": "...", "positionId": "...", "reason": "..." }
{ "kind": "halt",        "ts": "...", "reason": "daily_loss_cap" }
{ "kind": "resume",      "ts": "...", "reason": "cooldown_elapsed" }
```

`history.jsonl` is the source of truth for DASHBOARD P&L charts and win-rate
calculations. It's append-only so the dashboard can replay it cheaply.

### 5.3 `data/snapshots.jsonl` (append-only NDJSON, every 5 min)

```
{ "ts": "...", "bchBalanceSats": ..., "openPositionCount": ..., "totalExposureSats": ..., "unrealizedPnlSats": ... }
```

Lightweight; used by the DASHBOARD "balance over time" chart.

### 5.4 Volatile state (in-memory only)

- Pool cache (TTL = `poll_interval_seconds`).
- Token-stats cache (TTL = `poll_interval_seconds`).
- Last tick timestamp, last error, last broadcast txid (for the dashboard's
  "last activity" indicator).

These are rebuildable on every restart from `fetcher.listPoolsCached()`.

## 6. Config flow

```
config/default.json        ← committed, canonical schema, all knobs
       │
       │  (copy on init, then edit)
       ▼
config/user.json           ← gitignored, holds WIF + per-host overrides
       │
       │  util/config.mjs loads both, deep-merges (user wins)
       ▼
runtime config (immutable snapshot for the boot)
       │
       │  scripts/run-bot.mjs / dashboard/server.mjs re-read on SIGHUP
       ▼
config consumer modules
```

- `default.json` is the **only** file the bot reads to discover available
  knobs. New settings must ship there first.
- `user.json` carries: `wallet.wif`, `wallet.paytaca_cli_path`,
  `data_sources.cauldron_indexer_base_url` (chipnet override),
  `dashboard.bind_host`, `dashboard.bind_port`.
- `dashboard/server.mjs` exposes `PUT /api/config` which writes back to
  `user.json`. The endpoint is auth-gated by `dashboard.api_token` (a
  user.json-only knob) — if unset, the endpoint refuses to start.
- All `dashboard` writes go through `util/atomic-write.mjs`.

### 6.1 Config → behaviour matrix (excerpt)

| Knob | Type | Default | Effect |
|---|---|---|---|
| `scoring.weights.volume_24h_bch` | number 0..1 | 0.30 | Linear weight in composite score |
| `scoring.min_score` | number 0..1 | 0.40 | Hard floor; below → not a candidate |
| `entry.max_position_bch` | BCH | 0.10 | Per-trade size cap |
| `entry.max_total_exposure_bch` | BCH | 0.50 | Aggregate cap across all open positions |
| `entry.slippage_tolerance_bps` | bps | 50 | Hard reject if `simulate-swap` effective rate worse than this |
| `exit.take_profit_pct` | % | 5.0 | Close when price ≥ entry × (1 + pct) |
| `exit.stop_loss_pct` | % | 3.0 | Close when price ≤ entry × (1 − pct) |
| `exit.time_stop_hours` | hours | 72 | Close after this regardless of P&L |
| `risk.max_consecutive_losses` | int | 3 | → circuit-breaker.halt("loss_streak") |
| `risk.circuit_breaker_cooldown_hours` | hours | 6 | After halt, no entries for this long |
| `loop.poll_interval_seconds` | s | 60 | Tick cadence |

## 7. Threat model (cross-ref `SECURITY.md`)

| Threat | Defence in this architecture |
|---|---|
| **Repo leak exposing WIF** | WIF lives only in `config/user.json` (gitignored); pre-commit key-scan hook blocks `K…`/`L…`/`PRIVATE_KEY=`/`WIF=` patterns; CI scans every PR. |
| **Host compromise reading `~/.paytaca/`** | Paytaca-cli holds the seed in OS keychain; the bot's wrapper never reads the WIF. Host compromise = burned wallet regardless. Runbook calls for monthly rotation. |
| **Process inspection** | The WIF stays inside paytaca-cli's keychain — the bot never has it in its address space. Local subprocess model only; no remote IPC. |
| **Dependency compromise** | All npm deps pinned to exact versions (`"8.0.0"`, no `^`). `npm audit` in CI. Lockfile committed. |
| **Replay / front-running** | All entry/exit prices are checked against `simulate-swap --accept-rate=<ceiling>` and the on-chain effective rate is verified via `post_trade_check` after broadcast. Slippage tolerance enforced as a hard reject, not a warning. |
| **Stale / malicious indexer** | Indexer is treated as **untrusted for prices**. The `simulate-swap` step recomputes the expected rate from the pool list the SDK fetches itself; the on-chain tx is the only ground truth. |
| **Dashboard compromise writing trades** | Dashboard is read-only by design. The only write endpoint is `PUT /api/config`, gated by an API token, and it can only modify `config/user.json` — never wallet state. |
| **Disk corruption mid-write** | All state writes are atomic (`.tmp` + `rename`). On boot the bot reconciles from on-chain UTXOs, so a corrupted `positions.json` is recoverable. |
| **Bot crash mid-trade** | `run-bot.mjs` SIGINT handler flushes pending state. On crash, `swap.execute` returns a txid only after broadcast — positions are only persisted on confirmed success. A broadcast that doesn't confirm within 30 min is evicted and the bot re-syncs from chain. |

## 8. Failure modes (runbook summary; full version in `docs/RUNBOOK.md`)

| Symptom | Likely cause | First action |
|---|---|---|
| Bot silent for >5 min | Indexer hung, or process OOM-killed | `systemctl status tradebot`; check `journalctl -u tradebot -n 200` |
| Trades opened but not exiting | Take-profit/stop config misconfigured; price feed stale | `GET /api/config`; verify `exit.*`; force a snapshot |
| `swap.execute` keeps timing out | Electrum provider down; paytaca-cli stuck | `paytaca-cli getbalance`; switch `data_sources.cauldron_indexer_base_url` to a mirror |
| Balance drift vs `positions.json` | Crash before write; race condition | `scripts/snapshot.mjs --reconcile` (T15) rebuilds from chain |
| Daily P&L shows wild swings | Indexer returning inconsistent prices | Toggle `entry.use_post_trade_check = true`; review `post_trade_check` deviations in `history.jsonl` |
| Circuit-breaker tripped | By design — check `risk.*` | `GET /api/positions` shows `halt: { reason, until }`; can `POST /api/risk/resume` once cause addressed |
| `data/positions.json` corrupt | Disk full / power loss | Bot refuses to start; manual: restore from last `snapshots.jsonl` + on-chain UTXO scan |

## 9. Testing strategy

- **Pure helpers** (`strategy/*`, `portfolio/pnl`): exhaustive unit tests in
  `tests/scoring.test.mjs`, `tests/ranker.test.mjs`, `tests/entry.test.mjs`,
  `tests/exit.test.mjs`, `tests/pnl.test.mjs`. No I/O.
- **Adapter layer** (`data/fetcher`, `wallet/paytaca`): unit tests with
  recorded fixtures (`tests/fixtures/indexer/*.json`). No network.
- **Trader executor** (`trader/swap`): unit tests with a stub CLIs child
  process so we never touch mainnet. Chipnet mock for integration.
- **Dashboard server**: `supertest` against an in-process Fastify instance.
- **End-to-end integration** (`tests/integration.test.mjs`): full loop with
  every external dependency mocked; runs in <5s. Marked chipnet-only.

`npm test` runs `node --test tests/` — no extra deps.

## 10. Open questions (resolve before T15)

- [ ] Exact paytaca-cli subcommand surface for `send` vs `signRawTransaction`
      vs `wallet.send` — re-confirm against current upstream docs at T10.
- [ ] BCMR decimals handling: confirm we always convert `tokenAmountBase`
      using the BCMR decimals for the token, not a global default.
- [ ] Indexer URL for chipnet: the SKILL.md points at the chipnet mirror as
      `indexer-chipnet.riften.net`; verify before T15.
- [ ] Dashboard auth: bearer token vs basic-auth vs same-origin only.

---

*This doc is the contract between the bot's subsystems. If you change how a
module behaves, update the matching sequence diagram here in the same
commit.*