# TradeBot — Build Plan

The on-disk phased build plan the original development supervisor ticked
through (Phase 1 → Phase 7) is **not** part of this template. This repo
ships the working engine that emerged from that work, not the work
itself. The README + the per-file comments document the architecture.

## What shipped in the template fork

Everything the bot needs to run end-to-end:

- **Data layer** (`src/data/`) — cauldron indexer adapter, token stats,
  pool fetcher with rate-limiting + retry.
- **Strategy layer** (`src/strategy/`) — pool scoring, ranking, entry +
  exit condition evaluators, adaptive weights, holder-concentration rug
  check.
- **Trader layer** (`src/trader/`) — swap executor + the main trading
  loop. The loop integrates circuit-breaker, risk limits, fee tracking,
  and snapshot recording.
- **Risk layer** (`src/risk/`) — daily-loss + consecutive-loss circuit
  breakers + per-trade risk gates.
- **Wallet layer** (`src/wallet/`) — libauth-based WIF signer, Electrum
  provider, BIP44 derivation, UTXO consolidation helpers, wallet init.
- **Portfolio layer** (`src/portfolio/`) — positions store, P&L
  calculations, snapshots, per-token trade log, fee breakdown.
- **Reconcile layer** (`src/reconcile/`) — orphan-position auto-close,
  positions-vs-chain reconciliation.
- **Dashboard backend** (`src/dashboard/`) — read-only HTTP backend
  serving `/api/*` + `/healthz` + `/metrics`. Includes the first-run
  setup endpoint (`POST /api/setup`) used by the wizard.
- **Dashboard frontend** (`dashboard/src/`) — React + Vite SPA. Four
  routes: Dashboard, Portfolio, Settings, **Setup**. The Setup view is
  the first-run wizard; the App auto-redirects to it when the backend
  reports `setup_required=true`.
- **Scripts** (`scripts/`) — `run-bot`, `init-wallet`,
  `start-dashboard`, `snapshot`, plus the first-run helpers.
- **Tests** (`tests/`) — ~75 unit + integration tests covering the
  scoring engine, trader loop, dashboard server, risk panel, snapshot
  aggregator, per-token trade log, staking, wallet init, etc.

## What this template fork added on top of `LifestoneLabs/TradeBot`

The template's contribution is the **onboarding path** — the parts that
make a fresh checkout usable by someone who has never seen the repo:

1. **First-run dashboard wizard** (`/setup`). Collects: network
   (mainnet / chipnet), wallet (paste WIF / paste mnemonic / generate
   fresh), initial trading settings (max position, max exposure,
   slippage, take-profit, stop-loss), and optional API token. Validates
   each step, writes `config/user.json` atomically, then bounces the
   user back to the normal dashboard.
2. **Auto-redirect from `<App />`** to `/setup` when the backend reports
   that the operator config is incomplete. Reverses itself on the next
   successful response.
3. **`POST /api/setup` endpoint** on the dashboard backend. Validates
   the wizard's payload (WIF checksum, mnemonic word-list check,
   bounds on every knob), then deep-merges the new fields onto
   `config/user.json` via the existing `atomicWriteJson` helper.
4. **`scripts/init-wallet.mjs --from-setup`** mode that accepts a
   pre-generated wallet (no prompts) for the wizard's path. Pure CLI;
   no interactivity needed.
5. **Cleaned meta files**: no TODO backlog, no operator-specific data
   envelopes, no references to specific tokens / dates / trade
   incidents in the high-level docs.

## Where to look next

- `docs/ARCHITECTURE.md` — engine architecture (if shipped in your fork).
- `src/util/config-loader.mjs` — how `config/default.json` +
  `config/user.json` are deep-merged.
- `scripts/run-bot.mjs` — the bot's main entry point.
- `dashboard/src/views/Setup.jsx` — the first-run wizard.
- `src/dashboard/server.mjs` — the `POST /api/setup` endpoint.
- `SECURITY.md` — threat model + secret-handling rules.