# TradeBot dashboard

React + Vite + Tailwind dashboard for [TradeBot](../README.md). Talks to
the read-only HTTP backend (default `127.0.0.1:8787`) over `fetch`; the
backend itself never holds the wallet key directly — the bot loop signs.

## Views

- **DASHBOARD** (`/`) — historical performance, P&L chart, win rate, fees
  paid, balance-over-time. Backed by `/api/summary`, `/api/snapshots`,
  `/api/history`, `/api/activity`.
- **PORTFOLIO** (`/portfolio`) — current open / pending / closing / closed
  positions, with each row expandable to show the **ENTRY REASONING** the
  bot stamped at open time. Backed by `/api/positions`.
- **REASONING** (`/reasoning`) — every entry decision + the rationale
  that motivated it (volume/volatility/TVL snapshot + score breakdown).
- **TRADES** (`/trades`) — full trade history.
- **PROPOSALS** (`/proposals`) — feature-research output (auto-generated
  improvement ideas, ordered by impact).
- **BUGS** (`/bugs`) — bug tracker.
- **SETTINGS** (`/settings`) — every knob that influences the bot
  (scoring weights, entry / exit / risk / loop / dashboard settings, plus
  the live circuit-breaker state). Read-only by default; write-enabled
  when an operator opens the page with `?token=<dashboard.api_token>`.
- **SETUP** (`/setup`) — **first-run wizard**. Shown automatically when
  `config/user.json` is absent or missing required fields (network +
  wallet). Walks through: network choice → wallet (paste WIF, paste
  mnemonic, or generate) → initial trading settings → write
  `config/user.json` and you're done. After the wizard finishes, the
  route still works for reconfiguration (it'll prompt for the existing
  API token to overwrite).

## Develop

```bash
cd dashboard
npm install      # only on first run — installs React, Vite, Tailwind, recharts
npm run dev      # Vite dev server on http://127.0.0.1:5173
```

The Vite dev server (`vite.config.js`) proxies `/api/*` + `/healthz` to
the backend on `127.0.0.1:8787`. To point the dev proxy at a different
backend port, set `VITE_BACKEND_PORT` before running `npm run dev`.

## Production build

```bash
npm run build    # writes dashboard/dist/
```

The dashboard backend (`scripts/start-dashboard.mjs`) serves the built
bundle by default; pass `--no-static` to disable and serve only the API.

## Token / auth

Write endpoints (`PUT /api/config`, `POST /api/risk/reset`,
`POST /api/setup`) require the `dashboard.api_token` from
`config/user.json`. Open `http://127.0.0.1:5173/settings?token=<token>`
once per session — the token is stored in `sessionStorage` and stripped
from the URL.