# TradeBot

**A Bitcoin Cash (BCH) trading bot that monitors [cauldron.quest](https://cauldron.quest) AMM pools and tries to grow a wallet's BCH balance via volatility-driven entry/exit.**

---

This is the **template checkout** of TradeBot — a clean, no-personal-data
fork intended for new operators. It contains the full trading engine,
dashboard, scripts, and tests, with:

- No wallet keys, mnemonics, WIFs, or cashaddr
- No trade history, positions, snapshots, or P&L records
- No operator-specific TODO / bug / feature-idea backlog
- A **first-run setup wizard** that walks you through the minimum
  configuration to get the bot running

## What this is

TradeBot is an always-on app that:

1. **Watches** the cauldron.quest token pools (the live BCH AMM DEX).
2. **Scores** every pool by recent volume + volatility + TVL — surfacing the tokens most likely to be profitably tradeable over short horizons.
3. **Enters** a position on the highest-scoring tokens (BCH → token swap) when conditions match the configured tolerances.
4. **Exits** the position (token → BCH swap) when the position is profitable above the take-profit threshold, or when the stop-loss threshold is breached.
5. **Tracks** every trade, every P&L snapshot, every wallet balance change for a full historical performance audit.
6. **Shows** all of that through four views:
   - **Dashboard** — historical P&L charts, win rate, fees paid, BCH balance over time
   - **Portfolio** — current open positions with the entry reasoning + strategy rationale
   - **Settings** — every knob that influences the bot's decisions (position size, take-profit, stop-loss, slippage tolerance, score weights, polling cadence, etc.)
   - **Setup** — first-run wizard that initializes your wallet + initial trading settings (you'll see this on first launch; it's hidden once your `config/user.json` is filled in)

## Status

🚧 **Pre-alpha.** Trading engine is real (entry/exit/loop wired up); UI is
production-quality but the strategy defaults are tuned for **small-balance
startup** (max 0.005 BCH per trade, 0.04 BCH total exposure) so a fresh
wallet with ~0.05 BCH is enough to start. **Mainnet-only by design.** The
bot runs against cauldron.quest mainnet from day one (no chipnet soak
phase).

## Quick start

```bash
git clone https://github.com/LifestoneLabs/TradeBot-Template.git
cd TradeBot-Template

# One-shot install (root deps + dashboard deps + dashboard bundle).
# Idempotent — safe to re-run.
npm run setup

# Start the dashboard backend. Default bind: 127.0.0.1:8787.
npm run dashboard
```

Open http://127.0.0.1:8787/ in a browser. The first-run wizard appears
(auto-redirects to `/setup` when `config/user.json` is missing). Walk
through the 5 steps:

1. **Network** — mainnet (live BCH) or chipnet (BCH testnet).
2. **Wallet** — paste WIF, paste BIP39 mnemonic, or generate fresh.
3. **Trading** — initial position size, exposure cap, slippage, take-profit, stop-loss. Defaults are pre-filled for small-balance startup.
4. **API token** — auto-generated if blank (random 64-hex string).
5. **Review** + apply.

Once the wizard finishes, the wizard page redirects you to the
dashboard. The bot loop is a separate process:

```bash
# In a second terminal (or use a process manager)
npm run bot
```

`npm run setup` only needs to be run once on a fresh checkout. After that,
pull-newer-bundles-on-restart is automatic (`scripts/start-dashboard.mjs`
serves `dashboard/dist/` straight off disk).

### Why `npm run dashboard` (not `npm run dev`)?

`scripts/start-dashboard.mjs` runs the read-only HTTP backend on
**port 8787** AND serves the pre-built SPA bundle from `dashboard/dist/`.
That's the production-shape deploy: one URL (http://127.0.0.1:8787),
no separate Vite dev server, no HMR. The dashboard you see at 8787 is
identical to what a real operator runs in production.

If you want Vite HMR (live reload while you edit `dashboard/src/*.jsx`),
use `npm run dashboard:dev` instead. That runs Vite on 5173 with HMR
and proxies `/api/*` to 8787.

## CLI orchestrator

The `bin/tradebot-cli.mjs` orchestrator handles the common commands:

```bash
npx tradebot setup                # alias for `npm run setup`
npx tradebot dashboard            # alias for `npm run dashboard` (LAN-bind via --bind-host=0.0.0.0)
npx tradebot bot                  # alias for `npm run bot`
npx tradebot doctor               # environment + bundle + config health print
```

Exit codes: `0` OK, `1` missing dep, `2` setup failed, `3` dashboard boot
failed, `4` bot boot failed, `64` usage error. Run `npx tradebot --help`
for full reference.

## Skipping the wizard

You can skip the wizard and set up manually:

```bash
# Option A: paste an existing WIF (no mnemonic stored)
node scripts/init-wallet.mjs --wif "L...<your mainnet WIF>..."

# Option B: import a BIP39 mnemonic
node scripts/init-wallet.mjs --import "<12 or 24 words>"

# Option C: generate a fresh wallet (mnemonic printed once, also saved to user.json)
node scripts/init-wallet.mjs --generate
```

Then edit `config/user.json` to tune the initial knobs (`max_position_bch`,
`max_total_exposure_bch`, `slippage_tolerance_bps`, etc.) or change them
through the Settings view.

## What the first-run wizard collects

The wizard asks for:

| Field | Why |
|---|---|
| **Network** | `mainnet` (live) or `chipnet` (BCH testnet — for dry runs only). Mainnet is the default. |
| **Wallet input** | One of: paste a WIF, paste a mnemonic, or generate a fresh wallet. The WIF + mnemonic are written to `config/user.json` with chmod 600 — never to git. |
| **Max position size (BCH)** | How much BCH the bot will spend on a single trade. Default: 0.005. |
| **Max total exposure (BCH)** | Hard ceiling on open-position BCH sum. Default: 0.04. |
| **Slippage tolerance (bps)** | How much price drift the bot tolerates between decision and broadcast. Default: 100. |
| **Take-profit / Stop-loss (%)** | Exit thresholds. Defaults: 5% / 3%. |
| **Optional API token** | A token that gates `PUT /api/config` and `POST /api/risk/reset` so the Settings view can be opened in write mode. Auto-filled if you leave it blank (random 64-hex string). |

Everything else stays at the `config/default.json` defaults. You can
re-tune any of it later through the Settings view (or by editing
`config/user.json` directly).

## Architecture

```
        ┌───────────────────────────────────────┐
        │  Cauldron Indexer (indexer.riften.net)│
        │  /cauldron/tokens/list_cached         │
        │  /cauldron/pool/{token_id}            │
        └─────────────┬─────────────────────────┘
                      │ poll every N sec
                      ▼
   ┌──────────────────────────────────────────────┐
   │  src/data/fetcher.mjs                        │
   │  - cached token list + per-pool stats        │
   │  - rate-limited, retries on 5xx              │
   └──────────────────┬───────────────────────────┘
                      │
                      ▼
   ┌──────────────────────────────────────────────┐
   │  src/strategy/scoring.mjs                    │
   │  - scores = w1·volume + w2·volatility        │
   │         + w3·liquidity + w4·fee_yield        │
   │  - top-K tokens above min score = candidates │
   └──────────────────┬───────────────────────────┘
                      │
                      ▼
   ┌──────────────────────────────────────────────┐
   │  src/trader/loop.mjs                         │
   │  - for each candidate:                       │
   │      - check price vs target entry zone      │
   │      - if entry triggered:                   │
   │          simulate_swap → post_trade_check    │
   │          → check_and_swap → record position  │
   │      - for each open position:               │
   │          check price vs take-profit/stop-loss│
   │          if triggered: exit position         │
   └──────────────────┬───────────────────────────┘
                      │
                      ▼
   ┌──────────────────────────────────────────────┐
   │  src/wallet/libauth.mjs                      │
   │  - signs swaps with the bot's WIF            │
   │  - broadcasts to BCH mainnet via Electrum    │
   └──────────────────────────────────────────────┘
                      │
                      ▼
   ┌──────────────────────────────────────────────┐
   │  data/positions.json + data/history.jsonl    │
   │  dashboard/server serves this to the React UI │
   └──────────────────────────────────────────────┘
```

## Repo layout

| Path | Purpose |
|---|---|
| `src/` | Trading engine (Node.js, ESM) |
| `dashboard/` | React + Vite frontend (4 views, including Setup) |
| `scripts/` | CLI entry points (`run-bot`, `init-wallet`, `start-dashboard`, …) |
| `config/` | `default.json` (canonical config) + `user.json` (gitignored, chmod 600) |
| `data/` | Runtime state — `positions.json`, `history.jsonl`, `snapshots/` are gitignored. `bugs.json` + `feature-ideas.json` are tracked envelopes that start empty. |
| `tests/` | Unit + integration tests |
| `docs/` | Long-form documentation (architecture, strategy, runbook) |

## Security

⚠️ **Never commit wallet seeds, WIFs, or any private key material to this repo.** The `.gitignore` excludes `config/user.json` and the entire runtime `data/` directory. A pre-commit key-scan hook (mirroring the `LifestoneLabs/AI_Skills/scripts/pre-commit-key-scan.sh`) blocks accidental leaks.

The bot's wallet is **separate from your personal BCH wallet**. Don't reuse seeds. Don't move personal funds into the bot's address — only what you can afford to lose.

See `SECURITY.md` for the full threat model + secret-handling rules.

## License

MIT.