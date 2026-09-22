# TradeBot — Operations Runbook

**Status:** Living doc. First cut shipped with T18 (2026-09-11). Owner: operator.
Update when entry procedures, monitoring surfaces, or the incident playbook
change. The companion technical write-up is `docs/ARCHITECTURE.md`; the
settings reference is `docs/SETTINGS.md`; the on-disk data format is
`docs/DATA_LAYOUT.md`. **When in doubt, those three win — this doc is the
operator-facing view.**

---

## Table of contents

1. [What this bot is, in one paragraph](#1-what-this-bot-is-in-one-paragraph)
2. [Host + Node requirements](#2-host--node-requirements)
3. [First-time install](#3-first-time-install)
4. [Wallet provisioning & funding](#4-wallet-provisioning--funding)
5. [Pre-flight checklist before going live](#5-pre-flight-checklist-before-going-live)
6. [Day-to-day operations](#6-day-to-day-operations)
7. [Dry-runs and one-shots](#7-dry-runs-and-one-shots)
8. [Dashboard operations](#8-dashboard-operations)
9. [Monitoring & alerts](#9-monitoring--alerts)
10. [Incident playbook](#10-incident-playbook)
11. [Manual interventions](#11-manual-interventions)
12. [Backups, restores, and migrations](#12-backups-restores-and-migrations)
13. [Upgrades & schema migrations](#13-upgrades--schema-migrations)
14. [Key rotation & emergency shutdown](#14-key-rotation--emergency-shutdown)
15. [Appendix A — CLI quick reference](#appendix-a--cli-quick-reference)
16. [Appendix B — Log & data file locations](#appendix-b--log--data-file-locations)
17. [Appendix C — Common error messages](#appendix-c--common-error-messages)

---

## 1. What this bot is, in one paragraph

TradeBot is a **mainnet, hot-wallet** BCH trading bot that monitors every
pool on the [Cauldron DEX][cauldron], scores them by recent volume +
volatility + TVL, opens `BCH → token` positions on the highest-scoring
candidates, and closes them again on take-profit / stop-loss / trailing /
time-stop thresholds. Every trade is logged atomically to `data/positions.json`
+ `data/history.ndjson`; every balance snapshot lands in
`data/snapshots/<date>/`. A read-only Node HTTP backend plus a React SPA
expose DASHBOARD / PORTFOLIO / SETTINGS views. The bot is restart-safe and
the wallet is **isolated from paytaca-cli**: it signs with libauth directly
using the WIF kept in `config/user.json`.

[cauldron]: https://cauldron.quest/

---

## 2. Host + Node requirements

- **Node.js 20 LTS or newer** (the script uses `node:test`, `node:fs/promises`,
  `node:http`, `node:timers/promises`). No npm dependencies at runtime —
  `cauldron-swap-sdk` is pre-installed in `/home/ai/.npm-global/`.
- **Outbound HTTPS** to `https://indexer.riften.net/cauldron`.
- **Outbound WSS / TCP** to the configured Electrum server
  (`electrum.imaginary.cash:50004` by default).
- **~500 MB disk** for `data/snapshots/` (1 year of hourly snapshots is
  ≈ 2.5 MB/day at default cadence).
- **Linux x64** is the only tested host. Mac x64 / arm64 should work — no
  platform-specific code. Windows is **not** supported (the libauth wasm
  loader has had edge cases there historically).
- **No root required.** Run as the user that owns `config/user.json` (the
  WIF file is `chmod 600`). Never run as root with the WIF mounted wide-open.

---

## 3. First-time install

```bash
cd /home/ai/.openclaw/workspace/TradeBot/

# 1. Confirm Node version
node --version    # must be v20.x or newer

# 2. Make sure pre-commit key-scan hook is wired
git config core.hooksPath scripts/git-hooks
ls scripts/git-hooks/pre-commit          # should exist

# 3. Confirm config files exist + perms correct
ls -la config/
# default.json   ← committed, readable
# user.json      ← gitignored, chmod 600, you own it

# 4. Confirm the WIF is REDACTED in any logs you tail
node scripts/snapshot.mjs --once --json | head -5
# ^ should produce JSON; the address field must show but WIF/mnemonic must NOT.

# 5. Smoke-test the test suite
node --test tests/*.test.mjs
# ~750 tests, all green.

# 6. (Optional) Boot the dashboard in dev mode
node scripts/start-dashboard.mjs --help
node scripts/start-dashboard.mjs --bind-host=127.0.0.1 --bind-port=8787
```

If step 5 fails: do NOT go to step 6 with a live WIF. Diagnose the test
failure first — the suite is your safety net.

---

## 4. Wallet provisioning & funding

This is the **most dangerous section**. Read it twice.

The bot's hot wallet is **separate** from your normal paytaca wallet. The
private key lives **only** in `config/user.json` (BIP39 mnemonic + WIF for
m/44'/145'/0'/0/0). The bot **never** imports it into paytaca-cli.

### 4.1 Generating a new wallet (cold start)

```bash
# Generates a fresh BIP39 mnemonic + WIF, writes to config/user.json (chmod 600).
node scripts/init-wallet.mjs

# Confirm the address printed matches what you expect:
jq -r '.wallet.address' config/user.json
```

The mnemonic is printed **once** and written to `config/user.json`. Back it
up OFFLINE (paper, hardware wallet seed plate, password manager). If you
lose it, the BCH is unrecoverable. Nobody — not LifestoneLabs, not you
in six months — can recover a BIP39 mnemonic that was never written down.

### 4.2 Using an existing wallet (already funded)

If the wallet already exists, skip the generator entirely. Just make sure
`config/user.json` contains the correct WIF + cashaddr:

```bash
chmod 600 config/user.json
jq '{cashaddr: .wallet.address, wif_present: (.wallet.wif | length > 0), mnemonic_present: (.wallet.mnemonic | length > 0)}' \
    config/user.json
```

### 4.3 Funding

Send a **small, expendable amount** of BCH to the cashaddr. The shipped
"small_balance_startup" preset assumes ≤ 0.05 BCH. Confirm the receipt by
running the snapshot:

```bash
node scripts/snapshot.mjs --json | jq '.summary.balance_bch'
# Should match what you sent, minus the miner fee.
```

A mismatch is normal for ~1 block (the indexer is eventually consistent).
Two blocks later it should reconcile.

### 4.4 Funding hard rules

- **Never** send more than you can afford to lose in a hot-wallet exploit.
  Treat this as a tip jar, not a vault.
- **Never** send the bot's cashaddr to an exchange — many exchanges
  blacklist cashaddr sends. Use `bitcoincash:` prefix only when funding
  from a wallet that supports it; otherwise convert to legacy `1...` form
  first.
- **Never** commit `config/user.json`. The pre-commit key-scan hook will
  block the commit, but if you bypass it with `--no-verify` you've
  bricked your security posture.

---

## 5. Pre-flight checklist before going live

```text
[ ] config/user.json has chmod 600; you own it; WIF is present
[ ] config/default.json tuned to your risk tolerance (see §11 of
    docs/SETTINGS.md — small_balance_startup is sub-$50 USD)
[ ] Pre-commit key-scan hook installed (git config core.hooksPath)
[ ] Outbound HTTPS to indexer.riften.net works (curl -fsI once)
[ ] Outbound TCP to electrum.imaginary.cash:50004 works (nc -vz once)
[ ] node --test tests/*.test.mjs is green
[ ] Dry-run completes without errors (see §7) — node scripts/run-bot.mjs --dry-run
[ ] Dashboard renders DASHBOARD / PORTFOLIO / SETTINGS (see §8)
[ ] Snapshot.mjs round-trips: balance matches on-chain
[ ] Cron / supervisor is configured to restart on crash with backoff
[ ] Backup of config/user.json is in offline storage (NOT in this repo)
[ ] You have NOT pasted the WIF into any chat / issue tracker / doc
```

If **any** item is unchecked, do not skip straight to `node scripts/run-bot.mjs`.
Run `--dry-run` repeatedly until you're confident.

---

## 6. Day-to-day operations

### 6.1 Lifecycle

The bot has exactly **three** running modes:

| Mode | Command | What it does |
|---|---|---|
| Steady-state | `node scripts/run-bot.mjs` | Loops forever. Default. Reads `cfg.loop.poll_interval_seconds` for tick cadence. |
| Single tick, real | `node scripts/run-bot.mjs --once` | Runs ONE tick (fetch + score + maybe enter + maybe exit + snapshots) and exits 0. Cron-friendly. |
| Single tick, dry | `node scripts/run-bot.mjs --dry-run` | Same as `--once` but `swap.execute` never broadcasts. Read-only against the indexer + UTXO set. |

### 6.2 Recommended supervisor

Use systemd, supervisord, or a simple shell loop. **Do not** use nohup
alone — the bot must be restarted on crash with exponential backoff so it
doesn't spam the indexer.

Example systemd unit (illustrative — adjust paths):

```ini
[Unit]
Description=TradeBot BCH trading bot
After=network-online.target

[Service]
Type=simple
User=tradebot
WorkingDirectory=/home/ai/.openclaw/workspace/TradeBot
ExecStart=/usr/bin/node scripts/run-bot.mjs
Restart=on-failure
RestartSec=10
StartLimitBurst=5
StartLimitIntervalSec=300
Environment=NODE_ENV=production

# Hardening: drop capabilities, protect config, no new privs
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/home/ai/.openclaw/workspace/TradeBot/data
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

### 6.3 Graceful shutdown

The bot handles `SIGINT` and `SIGTERM` by letting the in-flight tick
complete, snapshotting balance, then exiting 0. **Do not** `kill -9`
during a tick that has already started a swap — wait at least one full
`poll_interval_seconds + 5s` before escalating.

### 6.4 Reading logs

All bot logs are line-delimited JSON to **stderr** (structured logger,
`src/util/logger.mjs`). Filter with `jq`:

```bash
journalctl -u tradebot -n 200 -o cat | jq -c 'select(.level=="error")'
```

Typical events:

| Event | Level | When |
|---|---|---|
| `tick.start` | info | Top of each polling iteration |
| `tick.done` | info | Bottom of each polling iteration |
| `trade.entry` | info | `SwapExecutor.execute` returned a successful entry |
| `trade.exit` | info | Successful exit (take-profit / stop-loss / time-stop / etc.) |
| `swap.skipped` | info | Pre-flight declined (slippage, limits, exposure, dust) |
| `circuit_breaker.tripped` | warn | Daily-loss or consecutive-loss trip — bot paused for cooldown |
| `risk.rejected` | warn | Entry or exit failed a risk gate; check reason |
| `wallet.error` | error | Electrum / libauth failure; check healthz |
| `indexer.error` | error | Cauldron indexer unreachable; bot will retry next tick |

### 6.5 Reading positions + history

```bash
# Pretty-print current positions
jq '.' data/positions.json

# Tail the trade history
tail -f data/history.ndjson | jq -c

# Query only trades in the last 24h
jq -c "select(.ts > (now - 86400 | todate))" data/history.ndjson

# Sum of fees paid across all entries+exits
jq -c 'select(.event=="trade.entry" or .event=="trade.exit") | .fees_bch // 0' \
   data/history.ndjson | jq -s 'add'
```

---

## 7. Dry-runs and one-shots

### 7.1 `--dry-run` is the safe go-to

`--dry-run` performs the **full pipeline** — fetch indexer, score, fetch
UTXOs, evaluate every entry/exit condition — except the actual `broadcast`
call. Use it aggressively during tuning:

```bash
# Single dry tick, dump positions.json after
node scripts/run-bot.mjs --dry-run
jq '.open | length' data/positions.json   # should be 0 if you started clean
```

If `--dry-run` writes a position record at all (it shouldn't — there is no
swap that can succeed in dry mode), investigate immediately.

### 7.2 Manual tick after a config change

```bash
# Edit config/user.json (or use dashboard PUT /api/config), then:
node scripts/run-bot.mjs --once
```

### 7.3 Read-only snapshot

```bash
# Markdown summary to stdout
node scripts/snapshot.mjs

# Raw JSON, pipeable
node scripts/snapshot.mjs --json | jq .summary

# Append a balance snapshot to data/snapshots/<date>/<ts>.jsonl
node scripts/snapshot.mjs --snapshot-record
```

---

## 8. Dashboard operations

```bash
# Production
node scripts/start-dashboard.mjs                    # binds 127.0.0.1:8787 by default
node scripts/start-dashboard.mjs --bind-host=0.0.0.0 --bind-port=8787

# Disable live wallet read (read-only mode — useful for demos)
node scripts/start-dashboard.mjs --no-wallet
```

### 8.1 Enabling writes (PUT /api/config, POST /api/risk/reset)

The dashboard is **read-only by default**. To enable writes:

```bash
# Generate a token (any 32+ char random string)
openssl rand -hex 32

# Set it in user.json:
jq '.dashboard.api_token = "PASTE_TOKEN_HERE"' config/user.json > tmp && mv tmp config/user.json
chmod 600 config/user.json
```

Then the SPA reads `?token=<TOKEN>` from the URL to enable the write
surfaces in SETTINGS. **Treat this token like a password** — anyone with
it can change your trading knobs and reset your circuit breaker.

### 8.2 Frontend dev (Vite)

```bash
cd dashboard/
npm install
npm run dev          # http://localhost:5173 — proxies to the backend on 8787
npm run build        # outputs dashboard/dist/
```

`dashboard/README.md` documents the full dev/build/test flow.

---

## 9. Monitoring & alerts

### 9.1 What to alert on

Wire these into your alerting system (Telegram bot, email, Slack, etc.).
Each corresponds to a log line or a health probe the bot already emits.

| Symptom | Source | Action |
|---|---|---|
| `tick.done` missing for > 2 × `poll_interval_seconds` | `journalctl` | Inspect — bot may have crashed silently. |
| `circuit_breaker.tripped` | log | Read cooldown window in §10.1. |
| `wallet.error` repeated | log | Check Electrum reachability (§10.3). |
| `indexer.error` repeated | log | Check indexer.riften.net/health; bot will retry. |
| `balance_after` trending down over many ticks | `data/history.ndjson` / dashboard | May indicate consistent stop-loss hits; review SETTINGS. |
| `data/positions.json` age > 5 minutes | `find data -mmin +5` | Either bot is paused OR disk write failing. |
| Disk usage > 80% on `data/` | `df` | Triage snapshot retention (§13.2). |

### 9.2 Health probes

The dashboard exposes `GET /healthz`:

```bash
curl -fsS http://127.0.0.1:8787/healthz
# {"status":"ok","uptime_s":...}
```

Wire this into your external uptime monitor. A non-200 means **either** the
backend is down **or** it's wedged (no `tick.done` for a long time).

---

## 10. Incident playbook

### 10.1 Circuit breaker tripped

**Symptom:** `circuit_breaker.tripped` log line; `trading_halted` flag set on
`/api/risk`.

**Cause:** Either:

1. Daily realized loss exceeded `risk.max_daily_loss_bch` (default 0.005 BCH), OR
2. Consecutive losses exceeded `risk.max_consecutive_losses` (default 3).

**Resolution:**

1. Read `/api/positions` and `/api/risk` to see which positions are open.
2. **Let positions run to their normal exits** unless manual override is
   required — the breaker only gates NEW entries, not in-flight positions.
3. After cooldown (`risk.circuit_breaker_cooldown_hours`, default 6h), the
   breaker re-arms automatically **if** the trip reason (daily-loss) has
   rolled over to a new day. For consecutive-loss: it re-arms on a win.
4. To **force** reset (e.g. for operator intervention):

   ```bash
   curl -X POST -H "X-API-Token: $TOKEN" \
        http://127.0.0.1:8787/api/risk/reset
   ```

   Document why you did this. The bot will trade on the next tick.

### 10.2 Balance drift

**Symptom:** `snapshot.mjs` reports `drift_bch` non-zero (the
`balance_aware` mode is on by default). The recorded balance no longer
matches the on-chain balance.

**Common causes:**

- A UTXO arrived via an external transfer to the same address.
- A position's "balance_after" record is stale.
- A swap was successful on-chain but the bot crashed before recording it.
- The Electrum server is lagging.

**Resolution:**

1. Run `node scripts/snapshot.mjs --json` and inspect `summary.drift_bch`
   and `summary.drift_detail`.
2. Cross-check the on-chain balance via any block explorer that knows the
   cashaddr.
3. If drift is within one block height of normal Electrum lag, wait one
   block and re-snapshot. Drift under 0.0001 BCH (dust) can usually be
   ignored.
4. If drift is large and persistent, check `/api/positions` against the
   on-chain UTXO set. A position that exists in the bot's record but not
   on chain means the swap never broadcast — close the stale position
   via §11.2.

### 10.3 Indexer down

**Symptom:** repeated `indexer.error` log lines.

**Resolution:**

1. `curl -fsI https://indexer.riften.net/cauldron/tokens/list_cached?limit=1`
2. If the indexer is down, the bot will retry every tick. It will not
   open new trades because `listTopTokens` returns `[]`. Already-open
   positions ARE still managed (exits rely on a smaller price-only fetch
   that has its own fallback).
3. If the indexer is down > 1 hour, consider manual interventions
   (close positions manually) — see §11.
4. Do **not** swap in a backup indexer URL by hand; the bot's fetcher has
   its own retry/backoff and may produce inconsistent snapshots if you
   mix indexes.

### 10.4 Stuck position

**Symptom:** A position is `OPEN` for > 2 × `exit.time_stop_hours` (default
48h with the 24h preset doubled). The bot has not exited it.

**Common causes:**

- Tokens transferred out of the address (yield farm? airdrop claim? the
  position's tokens are no longer in the wallet, so exit can't compose a
  swap).
- The exit function's precondition check is failing silently — check
  `data/history.ndjson` for the last exit attempt and its reason.
- A config drift: `exit.time_stop_hours` was bumped.
- **T28d — Indexer-vs-AMM price pathology.** The indexer's `price_now_sats` is wildly divergent from the AMM-implied rate (100,000,000× off was observed on QBTC 2026-09-14). Without T31 the bot will still ENTER such a position; with T31 installed the entry is rejected. After T28d the exit-side guard ignores the bogus indexer price and waits for the time-stop. If you see `current_price_rejected: true` snapshots, expect a stuck position until the 24h time-stop fires. See §11.2 for force-close.
- **T32 — Live AMM depth too shallow.** A position that lands in a token whose LIVE active-pools depth is below `entry.min_amm_total_depth_sats` (default 1.5 BCH) cannot be exited without massive slippage. With T32 installed, `shouldEnter` rejects such candidates up front (`kind:'below_min_amm_depth'`). Without T32, the bot would enter a position the swap layer can only exit at catastrophic loss. Symptom in history: `entry_skipped` with `skip_kind:'below_min_amm_depth'`. Resolution: bump the floor via `user.json`, or wait for the next pool deposit on the token. The QBTC 2026-09-14 incident is the canonical example — indexer `tvl_bch=4.74` but live active-pools depth was only ~1.32 BCH (the indexer was reading a stale pool set).
- **T33 — Position concentration cap rejected.** `shouldEnter` returned `kind:'concentration_cap'` — the wallet-relative cap (`entry.max_position_concentration_pct`, default `25%` of `walletBalanceBch`) shrunk the position below the `min_trade_size_bch` dust floor. Symptom in history: `entry_skipped` with `skip_kind:'concentration_cap'` and a reason like `position concentration cap 25% of wallet = 0.00025000 BCH would round to 0 below min_trade_size_bch 0.0005`. The bot is alerting you that the wallet is too small for the configured cap to be expressible as a viable trade. Resolution: (a) top up the wallet so `walletBalanceBch > 4 × min_trade_size_bch / (pct/100)` (e.g. for default `25%` cap + `0.0005 BCH` dust floor, wallet needs to be > `0.008 BCH`); (b) loosen the cap via `user.json` (`max_position_concentration_pct: 50` widens the per-trade ceiling); or (c) disable the guard entirely (`max_position_concentration_pct: 0` — matches the `min_amm_total_depth_sats` opt-in pattern). At the small-balance preset's ~`0.044 BCH` wallet + `25%` default cap, this rejection is impossible (the cap is `0.011 BCH`, well above the dust floor) — so the symptom appearing in history means the wallet has meaningfully shrunk, which is itself worth investigating.
- **T35 — Volatility-adjusted sizing shrunk a position.** `shouldEnter` returned a `size_bch` smaller than `max_position_bch` because `candidate.stats.volatility_24h_pct > entry.volatility_sizing_target_pct` (default `5%`). The reasoning blob's `decision.vol_sizing_scale` (1.0 = no-op, `<1.0` = guard reduced size) tells you how much was shaved. Symptom in history: `entry_executed` (the trade still went through) with `reasoning.decision.vol_sizing_scale` < 1.0 — the bot is being CONSERVATIVE, not skipping. Resolution: this is the intended behavior on high-vol tokens; leave it alone unless you want to (a) tighten the target via `user.json` (`volatility_sizing_target_pct: 10` makes the guard fire only on >10% daily vol), or (b) disable the guard (`volatility_sizing_target_pct: 0`) for a backtest pass. QBTC-class entries (~3.44% daily vol) won't fire the guard at the default 5% target; FEW-class entries (very high vol) will. If the audit log shows the guard firing on tokens you'd call "calm", the ranker may have a stale `volatility_24h_pct` — re-check `data/history.ndjson` for `loop.entry.amm_spot.error` or `loop.entry.amm_total_depth.error` patterns that could indicate the upstream feed is degraded.

**Resolution:**

1. `jq '.open' data/positions.json` — copy the position id.
2. Check `data/history.ndjson` for the most recent `trade.exit.skipped`
   event for that token_id.
3. If the tokens really are not in the wallet, the position is unrecoverable
   on-chain. Force-close it (§11.2).
4. Otherwise, nudge a tick: `node scripts/run-bot.mjs --once` and watch
   what happens.

### 10.5 Stuck UTXO / dust accumulation

**Symptom:** wallet balance plateaus despite recent successful sales; the
bot starts refusing trades with "insufficient funds for fees".

**Cause:** The wallet accumulates many tiny UTXOs (very common in small-
balance startup mode — each trade adds a "change" UTXO). At ~1000 sats/B
fees, ~50 UTXOs can eat the entire trade budget.

**Resolution:**

1. Check `wallet.listUtxos()` via the libauth adapter — count UTXOs.
2. If UTXO count > 20 with most < 0.001 BCH, consider **consolidating**
   by sending the entire balance to yourself, outside the bot. A single
   consolidation tx reduces future tx cost dramatically.
3. Do **not** automate consolidation inside the bot — out of scope for
   the current code, and you'd risk signing while another trade is in
   flight.

### 10.6 Suspected key compromise

If you suspect `config/user.json` has been read by an unauthorized party
(any reason — accidental git push, machine stolen, malware):

1. **IMMEDIATELY** stop the bot: `systemctl stop tradebot` (or kill the
   loop if running interactively).
2. Sweep the wallet to a fresh key with `bitcoincash:qprh...` → some new
   address you control. Use any tool that has the WIF — paytaca-cli, a
   hardware wallet that imports WIFs, etc.
3. The mnemonic in `config/user.json` is the **root** of the WIF (m/44'/145'/0'/0/0).
   If that mnemonic leaks, the entire BIP44 tree is compromised.
4. Generate a new wallet (§4.1), update `config/user.json`, restart bot
   **only after** confirming the old wallet has been swept.
5. Audit `data/history.ndjson` and `data/positions.json` for any activity
   you don't recognize.

---

## 11. Manual interventions

### 11.1 When to intervene

The bot is autonomous but the **operator** is the ultimate risk manager.
Intervene when:

- The bot has been silent for > 30 minutes without a `tick.done` log.
- A position has drifted > 20% against your intent AND the stop-loss
  hasn't fired.
- The indexer is down AND you have open positions in pools that are
  obviously bleeding value.
- The circuit breaker has tripped repeatedly (3+ times in 24h) — usually
  a sign the strategy is wrong, not a transient.

### 11.2 Manually closing a position

If you need to bail out of a position the bot isn't exiting:

1. Get the token id + amount from `data/positions.json`.
2. Use the same libauth wallet to construct a `token → BCH` swap directly
   via the `src/trader/cauldron/` scripts. **Or** use paytaca-cli with your
   OWN wallet (do NOT import the bot's WIF into paytaca — see §4).
3. Once the swap confirms on-chain, **edit** `data/positions.json` to mark
   the position as `closed` with the actual exit txid. Keep the file
   atomic: write to `positions.json.tmp`, then `mv` over the original.
4. Append a manual event to `data/history.ndjson` so the dashboard / P&L
   reflects reality:

   ```json
   {"ts":"2026-09-11T15:50:00Z","event":"trade.exit.manual",
    "token_id":"...","reason":"operator_unwind",
    "txid":"...","bch_out":0.0048}
   ```

### 11.3 Adjusting a knob mid-flight

Knobs live in `config/default.json` (committed) or `config/user.json`
(gitignored, hot-override). For an immediate change:

1. Edit `config/user.json` directly, OR use `PUT /api/config` (auth-gated).
2. The new knobs take effect on the **next tick**. Already-in-flight
   ticks continue with the old snapshot.
3. State files are atomic, so a `kill -9` in the middle of a tick does
   not leave a half-written positions file.

Knobs that should NOT be tuned blindly:

- `scoring.min_score`, `scoring.top_k_candidates` — turning these to 0
  floods the entry logic with garbage and eats indexer quota.
- `risk.min_wallet_balance_bch` — setting this below the tx-fee floor
  (≈0.0001 BCH) leaves the wallet unable to pay for its next swap.
- `risk.max_daily_loss_bch` — only raise this with explicit user intent;
  the default (0.005) is the daily kill switch.

---

## 12. Backups, restores, and migrations

### 12.1 What to back up

**Critical (must have):**

- `config/user.json` — the WIF + mnemonic. Back this up OFFLINE. If you
  lose it, you lose the wallet. No exceptions.

**Important (would hurt to lose):**

- `data/positions.json` — current portfolio state.
- `data/history.ndjson` — full trade history. Append-only; rebuildable
  from on-chain only with significant effort.
- `data/snapshots/` — historical balance snapshots.
- `config/default.json` — already in git. Back up the **specific commit
  SHA** you're running against.

**Optional:**

- `data/top-tokens.json`, `data/pools/`, `data/token-stats/` — these
  have scripts that can replay them from the indexer.

### 12.2 Backup cadence

- **Daily**: snapshot `data/` to off-host cold storage. `tar -czf` is fine.
- **Per release**: tag + archive the commit SHA.
- **Never**: copy `config/user.json` to a chat, email, or remote git
  server.

### 12.3 Restoring

```bash
# 1. Restore config/user.json (chmod 600 immediately!)
chmod 600 config/user.json

# 2. Restore data/
tar -xzf backup-YYYY-MM-DD.tar.gz -C /restore/path/

# 3. Verify on-chain balance matches snapshot.mjs output
node scripts/snapshot.mjs --json | jq .summary.balance_bch

# 4. Dry-run once before live
node scripts/run-bot.mjs --dry-run

# 5. Resume
node scripts/run-bot.mjs
```

### 12.4 Migration scenarios

- **New host**: install Node 20+, clone repo, drop `config/user.json`,
  restore `data/`, run `--dry-run`, then start.
- **Same host, new bot version**: `git pull`, run `node --test
  tests/*.test.mjs`, run `--dry-run`, restart via supervisor.
- **Schema change** (`default.json` has bumped `version` field): see
  §13.1.

---

## 13. Upgrades & schema migrations

### 13.1 `config/default.json` schema versions

The top-level `version` field is the schema version of the file itself.
When it changes, look for migration notes in the commit message and
`docs/SETTINGS.md`. The bot is generally forward-compatible: unknown
keys are ignored, missing keys fall back to defaults.

Common migrations to expect:

| Change | Action |
|---|---|
| New required key | Edit `user.json` (or `default.json`) to add it. Restart. |
| Removed key | No action — old key is silently ignored. |
| Renamed key | Bot will warn on startup; update `user.json`. |
| Type change (e.g. int → float) | Update `user.json`. The loader coerces where reasonable. |

### 13.2 Data layout migrations

`data/snapshots/` schema changes are rare; when they happen the loader
auto-detects legacy vs new fields. The dashboard gracefully degrades:
missing fields render as "—", not errors.

### 13.3 Dependency upgrades

TradeBot has **zero runtime npm dependencies**. Library code lives in
`/home/ai/.npm-global/`. When upgrading Node (`nvm install 20.x`), or
when the host package manager updates a system module libauth depends on,
re-run the full test suite:

```bash
node --test tests/*.test.mjs
```

If anything fails post-upgrade, hold the version and report.

---

## 14. Key rotation & emergency shutdown

### 14.1 Routine key rotation (every 6-12 months)

1. Generate a new wallet (`scripts/init-wallet.mjs`).
2. Fund it from the old wallet manually (outside the bot).
3. Update `config/user.json` with the new WIF.
4. Restart the bot.
5. Let the old wallet's remaining balance (if any) age out before
   sweeping or destroying it.

### 14.2 Suspected compromise

See §10.6. Short version: stop the bot, sweep the wallet, generate a
new key, restore from backup.

### 14.3 Discontinuation

1. Close all open positions manually (§11.2).
2. Sweep the wallet to cold storage.
3. Disable the supervisor (`systemctl disable --now tradebot`).
4. Remove `config/user.json` from the host, retaining only an OFFLINE
   encrypted backup of the mnemonic.
5. The repo + `data/` history can stay on disk — historical performance
   is useful even after the bot is no longer running.

---

## Appendix A — CLI quick reference

| Command | Purpose |
|---|---|
| `node scripts/run-bot.mjs` | Run forever (production) |
| `node scripts/run-bot.mjs --once` | Single tick, real |
| `node scripts/run-bot.mjs --dry-run` | Single tick, no broadcasts |
| `node scripts/run-bot.mjs --no-snapshot-record` | Skip periodic snapshots this tick |
| `node scripts/run-bot.mjs --config-default=PATH` | Use a custom default.json |
| `node scripts/snapshot.mjs` | Human-readable summary to stdout |
| `node scripts/snapshot.mjs --json` | Raw JSON to stdout |
| `node scripts/snapshot.mjs --out=FILE` | Write JSON to a file |
| `node scripts/snapshot.mjs --snapshot-record` | Also append a balance snapshot |
| `node scripts/init-wallet.mjs` | Generate a fresh wallet into `config/user.json` |
| `node scripts/start-dashboard.mjs` | Boot the HTTP dashboard |
| `node scripts/start-dashboard.mjs --no-wallet` | Read-only dashboard (no WIF in process) |
| `node scripts/data-tick.mjs` | Pull a fresh data snapshot from the indexer |
| `node scripts/pull-data.mjs` | Replay all data snapshots for a date range |
| `node --test tests/*.test.mjs` | Run the full test suite |
| `node scripts/lint.mjs` | Lint (TODO: T21) |
| `git config core.hooksPath scripts/git-hooks` | Install the pre-commit key-scan hook |

---

## Appendix B — Log & data file locations

| Path | Purpose | Backup? |
|---|---|---|
| `config/default.json` | Canonical config schema | In git |
| `config/user.json` | WIF + per-host overrides + last balance check | OFFLINE, encrypted |
| `data/positions.json` | Open + closed positions | Yes (daily) |
| `data/history.ndjson` | Append-only event log | Yes (daily) |
| `data/snapshots/<date>/<ts>.jsonl` | Per-tick balance + position snapshot | Yes (daily) |
| `data/top-tokens.json` | Most-recent top-20 indexer ranking | No (rebuildable) |
| `data/pools/<token_id>.json` | Cached indexer pool data | No |
| `data/token-stats/<token_id>.json` | Cached indexer token stats | No |
| `docs/reports/<symbol>.md` | Human-written token reports | In git |
| `dashboard/dist/` | Built Vite SPA (after `npm run build`) | No |
| `scripts/git-hooks/pre-commit` | Pre-commit key-scan hook | In git |
| `package.json` | Run / test / lint scripts | In git |

---

## Appendix C — Common error messages

| Log message | Cause | Fix |
|---|---|---|
| `config.user.json not found` | user.json missing or wrong path | Re-run `init-wallet.mjs` or restore from backup |
| `WIF length unexpected` | WIF was edited by hand / truncated | Re-export WIF from the original source |
| `ElectrumNetworkProvider connection refused` | Electrum host/port wrong or firewalled | Check `cfg.data_sources.electrum_host` + `nc -vz` |
| `indexer returned 5xx` | Cauldron indexer hiccup | Auto-retries; check `indexer.riften.net/health` if persistent |
| `circuit_breaker.tripped` | Daily loss or consecutive losses exceeded | See §10.1 |
| `pre_flight: insufficient bch in wallet` | Wallet floor + trade size exceeds balance | Top up the wallet, OR reduce `entry.max_position_bch` |
| `pre_flight: total exposure exceeded` | Sum of `positions.open` exceeds max | Wait for an exit, OR close a position manually |
| `post_trade_check: expected_slippage_bps > tolerance` | Market moved; quote is stale | Bot will retry next tick |
| `sign: transaction output value < dust threshold` | Change < 1000 sats | Sweep dust manually (§10.5); increase position size |
| `data/positions.json: file not json` | Corrupted atomic write (shouldn't happen) | Restore from backup; investigate why `fs.rename` failed mid-tick |
| `wallet not loaded` (start-dashboard.mjs) | `config.user.json` missing WIF | Re-run `init-wallet.mjs` or restore |
| `dashboard.api_token unset; writes refused` | Token not configured | See §8.1 |

---

**If a recipe here disagrees with the code, the code is the source of
truth — open a PR to fix the runbook.** Treat this doc as a living
artifact: stale runbooks are worse than no runbooks.
