# TODO — TradeBot (clean template)

This is the **template** checkout. It has no operator-specific history and no
preset backlog. The on-disk T-numbered task queue that the development
supervisor ticks through lives in your own working copy of this repo — not
in the template.

Use this file as you like — a personal scratchpad, a roadmap, a release
log, whatever fits your workflow. Delete it, rename it, replace it.

## Conventions (suggested)

- `[ ]` open
- `[~]` in-flight
- `[x]` shipped
- One task per bullet; tag with a date or a commit hash when shipped so
  the audit trail stays useful.

## Where things live

- `config/default.json` — every knob the bot reads, with sane small-balance
  defaults so a fresh wallet with ~0.05 BCH is enough for a first run.
- `config/user.json` — your overrides (gitignored, chmod 600). Created by
  the first-run setup wizard or by `npm run init-wallet`.
- `data/` — runtime state (positions, history, snapshots, bugs, ideas).
  Tracked envelopes (`bugs.json`, `feature-ideas.json`) start empty; the
  rest is gitignored and created on demand.
- `docs/` — long-form docs.
- `src/`, `scripts/`, `tests/` — bot engine, CLI entry points, tests.
- `dashboard/` — React + Vite frontend.

## Getting to "running"

1. `npm install` (bot deps) and `cd dashboard && npm install` (UI deps).
2. Open `http://127.0.0.1:5173` after starting the dashboard — the first-run
   wizard will walk you through wallet + initial trading settings.
3. `npm start` to launch the bot loop.