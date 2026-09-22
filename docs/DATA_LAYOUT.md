# TradeBot Data Layout

> How the data supervisor organises historical snapshots, token reports,
> and reusable pull scripts under the `data/` tree. This document is the
> **contract** between the data supervisor (read-only, indexer-only) and
> the strategy / dashboard / bot layers (consumers).

---

## Table of contents

1. [Directory tree](#directory-tree)
2. [File-by-file reference](#file-by-file-reference)
3. [Snapshot format & schema](#snapshot-format--schema)
4. [`top-tokens.json` schema](#top-tokensjson-schema)
5. [`history.ndjson` event schema](#historyndjson-event-schema)
6. [Composite-score formula](#composite-score-formula)
7. [Atomic-write pattern](#atomic-write-pattern)
8. [NDJSON append semantics](#ndjson-append-semantics)
9. [Token reports](#token-reports)
10. [How the trading bot consumes this data](#how-the-trading-bot-consumes-this-data)
11. [Snapshot cadence](#snapshot-cadence)
12. [Querying historical snapshots (code examples)](#querying-historical-snapshots-code-examples)
13. [Backtesting from `history.ndjson`](#backtesting-from-historyndjson)
14. [Re-running pulls on demand](#re-running-pulls-on-demand)
15. [Key constraints](#key-constraints)
16. [Test coverage](#test-coverage)
17. [Appendix: code surface](#appendix-code-surface)

---

## Directory tree

```
TradeBot/
├── data/                              # Gitignored — never commit secrets, snapshots, or positions
│   ├── .gitkeep                       # Keeps the dir in git when empty
│   ├── history.ndjson                 # Append-only: one JSON event per supervisor tick
│   ├── top-tokens.json                # Most-recent top-20 ranking snapshot
│   ├── positions.json                 # Portfolio positions (gitignored; written by trader)
│   └── snapshots/
│       └── <YYYY-MM-DD>/              # One folder per snapshot tick (one per hour at :00)
│           ├── pools.json             # Full listTopTokens() response (RawIndexerEntry[])
│           └── token-stats/
│               └── <token_id>.json    # getTokenStats(tokenId) per token seen that tick
│
├── docs/
│   ├── reports/                       # Committed — token fundamentals reports (one per top-20)
│   │   └── <symbol>.md
│   ├── DATA_LAYOUT.md                 # This file
│   ├── ARCHITECTURE.md                # System architecture (cross-references this file)
│   └── SETTINGS.md                    # Config reference (cross-references this file)
│
├── scripts/
│   ├── pull-data.mjs                  # Reusable data-pull CLI (--list-pools, --token-stats, --snapshot-all, --top20, --report)
│   └── data-tick.mjs                  # Per-tick orchestrator (spawns pull-data.mjs for snapshot + top20)
│
├── tests/data/                        # Data-layer tests (node --test)
│   ├── snapshots.test.mjs             # Atomic-write + layout invariants
│   ├── top20.test.mjs                 # Composite-score fixtures + ranking invariants
│   ├── pull-data.test.mjs             # CLI parser + command-dispatch tests
│   └── data-tick.test.mjs             # Tick-logic + spawn-boundary tests
│
├── src/data/                          # Shared read-side library (re-exported everywhere)
│   ├── fetcher.mjs                    # Cauldron indexer adapter
│   └── types.mjs                      # Token / Pool / PoolStats typedefs + pure helpers
│
└── DATA_TODO.md                       # This supervisor's working queue
```

> **Gitignored boundary.** Everything under `/data/` is gitignored
> (see the `.gitignore` repo root). Only `/docs/reports/` and this
> file (`/docs/DATA_LAYOUT.md`) are committed. `data/positions.json`
> lives next to the snapshots for convenience but is also gitignored.

---

## File-by-file reference

| Path | Purpose | Written by | Read by | Cadence |
|---|---|---|---|---|
| `data/snapshots/<date>/pools.json` | Full discovery list at one tick | `pull-data.mjs --snapshot-all` | Bot, backtest scripts, dashboard | 1×/hour (`:00`) |
| `data/snapshots/<date>/token-stats/<id>.json` | Per-token normalised stats | `pull-data.mjs --snapshot-all` | Bot, report generator | 1×/hour, per token seen |
| `data/top-tokens.json` | Most-recent composite top-20 | `pull-data.mjs --top20` | Bot (strategy filter), dashboard | 1×/hour (after snapshot) |
| `data/history.ndjson` | Append-only tick event log | `pull-data.mjs --snapshot-all`, `--top20` | Bot, audit, ops | 1-2 lines/hour |
| `data/positions.json` | Live portfolio state | `src/portfolio/*` (NOT this supervisor) | Bot, dashboard | on trade |
| `docs/reports/<symbol>.md` | Per-token fundamentals | `pull-data.mjs --report` | Bot (decision rationale), dashboard | one-shot + on-demand |
| `docs/DATA_LAYOUT.md` | This file | Data supervisor | Humans, CI doc-lint | when schema changes |

---

## Snapshot format & schema

### `data/snapshots/<YYYY-MM-DD>/pools.json`

The raw response from `Fetcher.listTopTokens({ by: 'tvl', order: 'desc', limit: 200 })`,
serialised with `JSON.stringify(..., null, 2)`. Up to 200 records per file.

```json
[
  {
    "token_id": "2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544",
    "display_name": "ParyonUSD",
    "display_symbol": "PUSD",
    "bcmr": {
      "token": { "symbol": "PUSD", "decimals": 2 },
      "name": "ParyonUSD"
    },
    "price_now": 438161.63,
    "price_now_usd": 1.000629,
    "price_24h": 419744.30,
    "price_7d": 398812.86,
    "change_24h_bp": 440,
    "change_24h_usd_bp": 39,
    "change_7d_bp": 986,
    "change_7d_usd_bp": 58,
    "trade_count": 0,
    "trade_volume": 244999051632,
    "tvl_sats": 52641285978,
    "tvl_tokens": 2900000,
    "apy_30d_bp": 952,
    "score": 0.82,
    "score_rank": 1
  }
]
```

**Schema:** `RawIndexerEntry[]` from `src/data/types.mjs`.
- Field names use the **raw indexer** convention (`price_now`, `price_24h`,
  `trade_volume`) — NOT the normalised `PoolStats` convention
  (`price_now_sats`, `trade_volume_sats`). This is intentional: the
  raw file is a verbatim copy of what the indexer returned, so any
  indexer-side schema drift is visible in the snapshot rather than
  silently masked.
- All numeric fields are nullable (a fresh / niche token may have
  no 24h volume, no APY, etc.).
- `token_id` is **always** lowercase 64-char hex (the indexer
  normalises; the supervisor does not re-normalise on write).

To consume this file, prefer `Fetcher.getTokenStats(tokenId)` over
re-parsing the raw shape — the fetcher normalises into `PoolStats`
and applies caching.

### `data/snapshots/<YYYY-MM-DD>/token-stats/<token_id>.json`

The normalised output of `Fetcher.getTokenStats(tokenId)` for one
token. Filename is the lowercase token_id + `.json`.

```json
{
  "token_id": "2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544",
  "name": "ParyonUSD",
  "symbol": "PUSD",
  "decimals": 2,
  "decimals_warn": null,
  "price_now_sats": 438161.63,
  "price_now_usd": 1.000629,
  "price_24h_sats": 419744.30,
  "price_7d_sats": 398812.86,
  "change_24h_bp": 440,
  "change_24h_usd_bp": 39,
  "change_7d_bp": 986,
  "change_7d_usd_bp": 58,
  "trade_count": 0,
  "trade_volume_sats": 244999051632,
  "tvl_sats": 52641285978,
  "tvl_tokens": 2900000,
  "apy_30d_bp": 952,
  "score": 0.82,
  "score_rank": 1
}
```

**Schema:** `PoolStats` from `src/data/types.mjs`. Validate with
`isValidPoolStats(obj)`. The two contract guarantees:

1. `token_id` is present and is the lowercase 64-char hex.
2. All other fields MAY be `null` (the indexer's "missing evidence"
   sentinel). Callers MUST treat `null` as "missing", not as 0.

**Important:** `price_now_sats` is per **DISPLAY** unit, not per
**BASE** unit. Multiply by `10^decimals` to get the per-base-unit rate.
If `decimals_warn` is non-null (e.g. `"no BCMR decimals — price_now_sats
is per display unit"`), the token does NOT have BCMR decimals — the
fetcher has flagged this so callers cannot silently trust the price as
a per-base-unit rate.

---

## `top-tokens.json` schema

Computed by `scripts/pull-data.mjs --top20` (and re-computed every tick
by `scripts/data-tick.mjs`).

```json
{
  "computed_at": "2026-09-11T13:05:33.567Z",
  "composite_formula": "volume_sats * tvl_sats * (1 + |change_24h_bp| / 10000)",
  "tokens": [
    {
      "rank": 1,
      "token_id": "2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544",
      "symbol": "PUSD",
      "name": "ParyonUSD",
      "composite_score": 1.3464536007516053e+22,
      "volume_24h_sats": 244999051632,
      "tvl_sats": 52641285978,
      "change_24h_bp": 440,
      "price_now_sats": 438161.63,
      "price_now_usd": 1.000629,
      "tvl_bch": 526.41285978,
      "volume_24h_bch": 2449.99051632,
      "apy_30d_bp": 952
    }
  ]
}
```

| Field | Type | Notes |
|---|---|---|
| `computed_at` | ISO timestamp | When `pull-data.mjs --top20` finished writing this file |
| `composite_formula` | string | Human-readable formula. The supervisor owns this string and the actual formula MUST stay byte-identical. |
| `tokens[]` | array, len ≤ 20 | Sorted by `composite_score` desc |
| `tokens[].rank` | int, 1-indexed | 1 = highest composite score |
| `tokens[].token_id` | 64-char hex | Lowercase |
| `tokens[].symbol` | string \| null | `display_symbol` fallback to `bcmr.token.symbol` |
| `tokens[].composite_score` | float | See [Composite-score formula](#composite-score-formula) |
| `tokens[].volume_24h_sats` | number \| null | 24h BCH-denominated volume |
| `tokens[].tvl_sats` | number \| null | Token-side TVL |
| `tokens[].change_24h_bp` | int \| null | 24h price delta, basis points (can be negative) |
| `tokens[].tvl_bch`, `tokens[].volume_24h_bch` | float \| null | Convenience denormalised fields (`sats / 1e8`) |
| `tokens[].apy_30d_bp` | int \| null | 30d LP APY, basis points |

---

## `history.ndjson` event schema

Append-only newline-delimited JSON. **One event record per line.** Never
truncate, never rewrite. New events are written via POSIX `O_APPEND`
(atomic for lines ≤ `PIPE_BUF` = 4096 bytes; supervisor lines are ≤512
bytes).

```jsonl
{"ts":"2026-09-11T13:05:12.692Z","source":"snapshot","type":"full-snapshot","date":"2026-09-11","pool_count":200,"top_token":"PUSD"}
{"ts":"2026-09-11T13:05:33.567Z","source":"top20","type":"top20-update","top_token":"PUSD"}
{"ts":"2026-09-11T14:05:08.211Z","source":"snapshot","type":"full-snapshot","date":"2026-09-11","pool_count":198,"top_token":"PUSD"}
```

### Event fields

| Field | Type | Required | Description |
|---|---|---|---|
| `ts` | ISO 8601 string | ✓ | When the event was emitted (UTC, ms precision) |
| `source` | enum | ✓ | One of `snapshot`, `top20`, `report`, `backfill` |
| `type` | enum | ✓ | See [Event types](#event-types) below |
| `date` | `YYYY-MM-DD` | when `type` ∈ snapshot events | The snapshot date the event describes |
| `pool_count` | int | when `type=full-snapshot` | How many pools were captured |
| `top_token` | string | when applicable | Symbol of the rank-1 token (or `unknown` fallback) |
| `token_id` | 64-char hex | when `type=report` | Which token's report was generated |
| `error` | string | optional | Error message (only on `type=error`) |

### Event types

| `source` | `type` | When emitted |
|---|---|---|
| `snapshot` | `full-snapshot` | `pull-data.mjs --snapshot-all` succeeded |
| `snapshot` | `partial-snapshot` | Some per-token fetches failed; partial file written |
| `snapshot` | `snapshot-error` | The whole snapshot failed (no pools.json written) |
| `top20` | `top20-update` | `pull-data.mjs --top20` recomputed the ranking |
| `top20` | `top20-error` | top20 phase failed (snapshots are still authoritative) |
| `report` | `report-generated` | `pull-data.mjs --report` wrote one `<symbol>.md` |
| `report` | `report-error` | report phase failed |
| `backfill` | `backfill-start` | a manual `--date=YYYY-MM-DD` backfill was triggered |
| `backfill` | `backfill-done` | a manual backfill completed |

To enumerate event types from code, grep the `scripts/pull-data.mjs`
source — every `appendHistory({...})` call site documents which fields
it sets.

---

## Composite-score formula

Defined in `scripts/pull-data.mjs → compositeScore()` and locked by
`tests/data/top20.test.mjs`. The bot's strategy filter MUST agree
with this formula exactly:

```
score = trade_volume_sats × tvl_sats × (1 + |change_24h_bp| / 10000)
```

Where:

- `trade_volume_sats` = 24h volume, BCH-denominated (sats)
- `tvl_sats` = token-side TVL (sats)
- `change_24h_bp` = 24h price delta in integer basis points; the
  absolute value is used so both pumps AND dumps score equally well
  (volatility = opportunity, not direction)
- `null` fields are treated as 0 in the multiplication (so a
  brand-new token with `trade_volume_sats=null` scores 0 on the
  volume leg — that's the desired behaviour)

Higher score = more attractive. The top-20 is the 20 highest-scoring
tokens from the latest top-200 discovery list. The bot should treat
`composite_score` as a *gate*, not a *signal* — being in the top-20
qualifies a token for the watchlist; the strategy layer decides
whether to actually trade it.

---

## Atomic-write pattern

All non-append writes under `data/` MUST use atomic write
(tmp-dir → rename) to avoid corruption if the process is killed
mid-write:

```js
import { writeFileSync, renameSync, mkdirSync, mkdtempSync } from 'node:fs';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';

function atomicWrite(filePath, content) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = mkdtempSync(tmpdir() + '/tradebot-');
  const tmpFile = tmp + '/file';
  writeFileSync(tmpFile, content, 'utf8');
  renameSync(tmpFile, filePath);
}
```

The same helper is implemented in `scripts/pull-data.mjs` (internal;
not exported) and mirrored in `tests/data/snapshots.test.mjs`. Any
deviation in behaviour (e.g. using `copyFile` instead of `rename`,
or skipping `mkdir -p`) is a regression that the test will catch.

**Files that MUST use atomic write:**
- `data/top-tokens.json`
- `data/snapshots/<date>/pools.json`
- `data/snapshots/<date>/token-stats/<id>.json`

**Files that MUST use append-only:**
- `data/history.ndjson`

---

## NDJSON append semantics

`history.ndjson` is append-only. The contract:

1. **Never truncate.** `writeFileSync('data/history.ndjson', '')`
   may be used to create the file *once* on the first append, but
   subsequent operations MUST be `appendFileSync`.
2. **One event per line.** Each line is a self-contained JSON object
   ending with `\n`. `JSON.stringify(obj)` is sufficient — Node's
   `JSON.stringify` produces no embedded newlines for typical event
   payloads (and the supervisor never puts strings with newlines in
   events).
3. **POSIX atomic append.** Linux guarantees atomic appends ≤
   `PIPE_BUF` (4096 bytes on most systems). Supervisor lines are
   ≤512 bytes, so concurrent ticks cannot tear writes.
4. **Read in stream mode.** The recommended reader is `readline` over
   `createReadStream`, NOT `readFileSync` — history grows unboundedly
   over the bot's lifetime.

---

## Token reports

`docs/reports/<symbol>.md` — one markdown file per top-20 token.
**Committed to git** (unlike the snapshot data).

Every report MUST include at minimum:

| Field | Source |
|---|---|
| Symbol + Name | `Fetcher.getBcmr(tokenId)` |
| Token ID (64-char hex) | `Fetcher.getTokenStats(tokenId).token_id` |
| Decimals | `Fetcher.getBcmr(tokenId).decimals` (or `null` + warning) |
| BCMR description excerpt | `Fetcher.getBcmr(tokenId).description` |
| Current price (BCH + sats) | `Fetcher.getTokenStats(tokenId).price_now_sats` |
| 24h volume (BCH + USD) | `trade_volume_sats` + USD equiv (BCH × BTC/USD × implied USD price) |
| 7d volume (BCH + USD) | derived from `price_7d_sats × tvl_tokens` (the indexer doesn't expose 7d volume directly — reports compute it via the price-7d snapshot) |
| 24h price-change % | `change_24h_bp / 100` |
| TVL (BCH) | `tvl_sats / 1e8` |
| 30d APY | `apy_30d_bp / 100` |
| Top-3 recent trade sizes | derived from `Fetcher.listPools(tokenId)` UTXO reserves |
| Live pool link | `https://cauldron.quest/token/<token_id>` |
| Fundamentals section | BCMR description + any `uris` links |
| Score rank | `score_rank` from indexer |

Reports are **regenerated on demand** via
`node scripts/pull-data.mjs --report <symbol-or-id>`. To regenerate
the full top-20 set after a new snapshot, run the script 20× in a
loop (the supervisor's DT11 dispatch handles this).

A sample report is at `docs/reports/pusd.md` and serves as the template.

---

## How the trading bot consumes this data

### Decision-flow contract

Before opening a position, the strategy layer should resolve context in
this order:

1. **Read** `data/top-tokens.json`. Reject any token NOT in the top-20
   (`tokens[].token_id`). This is the gate.
2. **Read** the latest `data/snapshots/<today>/pools.json` for current
   TVL, volume, and price-change. Compare against the same token in
   the **previous** tick's snapshot to detect momentum.
3. **Read** `docs/reports/<symbol>.md` (resolved via the `tokens[].symbol`
   field of `top-tokens.json`) for fundamentals context. Embed the
   report URL + the BCMR description excerpt in the trade-decision
   rationale so the audit log explains *why* the trade was made.
4. **Read** the most recent `data/history.ndjson` event of `type=full-snapshot`
   to confirm the snapshot is fresh (within the last 90 minutes).
   If the last snapshot is stale, REFUSE to enter — the supervisor's
   only "liveness" guarantee is that snapshots land on schedule.

### What the bot MUST NOT do

- **Do not write under `data/snapshots/`.** That namespace is owned
  by the supervisor. Writes belong under `data/positions.json`
  (and even that is gitignored).
- **Do not re-read the Cauldron indexer directly.** Always go
  through the supervisor's snapshot data. The indexer has rate limits
  and shape drift; the supervisor mediates both.
- **Do not assume the snapshot is fresh.** Always check
  `data/history.ndjson` for the most-recent tick's `ts` before
  trusting the data.

---

## Snapshot cadence

The data supervisor runs at `:00` every hour via the system cron
(`scripts/data-tick.mjs`). Each tick:

1. **Phase A (authoritative):** `pull-data.mjs --snapshot-all`
   writes `data/snapshots/<today>/{pools.json,token-stats/<id>.json}`
   and appends one `type=full-snapshot` event to `data/history.ndjson`.
   If this phase fails, the tick aborts with exit code 1 — no
   `top-tokens.json` is written.
2. **Phase B (derived):** `pull-data.mjs --top20` recomputes
   `data/top-tokens.json` and appends one `type=top20-update` event.
   If this phase fails, the supervisor logs a warning but the
   tick still returns 0 (snapshots are the authoritative record;
   `top20` is derived).
3. The script's structured log goes to stdout (NDJSON) via
   `src/util/logger.mjs`. The cron captures it to `logs/data-tick.log`
   for postmortem.

### Missed ticks

If the cron daemon is down for N hours, the next tick writes only
`<today>/` — the previous days' snapshots are NOT backfilled
automatically. To backfill, run manually:

```bash
node scripts/data-tick.mjs --date=2026-09-10
node scripts/data-tick.mjs --date=2026-09-09
```

This is the only supported backfill path. The script refuses to
overwrite an existing snapshot directory (each `<date>/` directory
is write-once-per-day by convention; if you really need to
re-snapshot, delete the directory first).

---

## Querying historical snapshots (code examples)

### Reading the latest snapshot for one token

```js
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isValidPoolStats } from '../src/data/types.mjs';

function readLatestTokenStats(tokenId, repoRoot = process.cwd()) {
  // Latest <date> directory = newest YYYY-MM-DD under data/snapshots/
  const dir = join(repoRoot, 'data', 'snapshots');
  const dates = require('node:fs').readdirSync(dir)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort()
    .reverse();
  if (dates.length === 0) throw new Error('no snapshots yet');

  const newest = dates[0];
  const path = join(dir, newest, 'token-stats', `${tokenId}.json`);
  const raw = readFileSync(path, 'utf8');
  const stats = JSON.parse(raw);
  if (!isValidPoolStats(stats)) {
    throw new Error(`malformed PoolStats at ${path}`);
  }
  return { date: newest, stats };
}
```

### Reading the current top-20

```js
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readTop20(repoRoot = process.cwd()) {
  const path = join(repoRoot, 'data', 'top-tokens.json');
  const raw = readFileSync(path, 'utf8');
  const doc = JSON.parse(raw);
  if (typeof doc.computed_at !== 'string') {
    throw new Error('malformed top-tokens.json (no computed_at)');
  }
  if (!Array.isArray(doc.tokens) || doc.tokens.length === 0) {
    throw new Error('top-tokens.json has no tokens');
  }
  return doc;
}
```

### Reading history.ndjson (last N events)

```js
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

async function* iterHistory(repoRoot = process.cwd()) {
  const path = join(repoRoot, 'data', 'history.ndjson');
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    yield JSON.parse(line);
  }
}

async function lastNHistoryEvents(n = 10) {
  const all = [];
  for await (const ev of iterHistory()) all.push(ev);
  return all.slice(-n);
}
```

---

## Backtesting from `history.ndjson`

The canonical backtest loop:

```js
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { compositeScore } from '../scripts/pull-data.mjs';
import { isValidPoolStats } from '../src/data/types.mjs';

async function backtest({ startDate, endDate, repoRoot = process.cwd() }) {
  const snapshotsDir = join(repoRoot, 'data', 'snapshots');
  const dates = readdirSync(snapshotsDir)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .filter((d) => d >= startDate && d <= endDate)
    .sort();

  /** @type {Array<{ date: string, top_token: string, pool_count: number, score: number }>} */
  const timeline = [];

  for (const date of dates) {
    const path = join(snapshotsDir, date, 'pools.json');
    if (!statSync(path).isFile()) continue;
    const pools = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(pools)) continue;

    // Re-score using the SAME formula the supervisor uses, so backtest
    // signals match live signals.
    const scored = pools
      .filter((p) => p && p.token_id)
      .map((p) => ({
        token_id: p.token_id,
        symbol: p.display_symbol ?? p.bcmr?.token?.symbol ?? null,
        score: compositeScore({
          token_id: p.token_id,
          trade_volume_sats: p.trade_volume,
          tvl_sats: p.tvl_sats,
          change_24h_bp: p.change_24h_bp,
        }),
      }))
      .sort((a, b) => b.score - a.score);

    timeline.push({
      date,
      top_token: scored[0]?.symbol ?? 'unknown',
      pool_count: pools.length,
      score: scored[0]?.score ?? 0,
    });
  }
  return timeline;
}
```

The point of using `compositeScore` from the supervisor's own code
is that a future change to the formula propagates to both live and
backtest paths atomically — there's no second formula to drift.

---

## Re-running pulls on demand

```bash
# Pull the current top-200 discovery list to stdout
node scripts/pull-data.mjs --list-pools

# Pull one token's full stats + BCMR
node scripts/pull-data.mjs --token-stats PUSD
node scripts/pull-data.mjs --token-stats 2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544

# Full snapshot for today (same as the cron tick)
node scripts/pull-data.mjs --snapshot-all

# Backfill a missed day
node scripts/pull-data.mjs --snapshot-all --date=2026-09-10

# Recompute the top-20 ranking
node scripts/pull-data.mjs --top20

# Regenerate a single token's report
node scripts/pull-data.mjs --report PUSD

# Tick wrapper (snapshot + top20 in one shot)
node scripts/data-tick.mjs                # today
node scripts/data-tick.mjs --date=2026-09-10  # backfill
node scripts/data-tick.mjs --dry-run      # log plan only
```

All scripts are read-only — they NEVER sign, NEVER broadcast, and
NEVER touch the WIF. The only network egress is GET requests to the
Cauldron indexer.

---

## Key constraints

- **No secrets** in any committed or gitignored file under `data/`
  or `docs/reports/`. The pre-commit key-scan hook
  (`scripts/git-hooks/pre-commit-key-scan.sh`) blocks obvious leaks.
- **No on-chain writes.** This supervisor is read-only (indexer only).
  All wallet operations belong to the trader layer.
- **Never truncate** existing snapshot files. Atomic write (tmp →
  rename) for everything except `history.ndjson`, which is
  append-only.
- **One logical change per commit.** Snapshot bookkeeping goes
  under `chore(data):`; new fetcher logic under `feat(data):`; new
  per-token reports under `docs(reports):`; new CLI surface under
  `feat(scripts):`.
- **All scripts under `scripts/`** have a matching test under
  `tests/data/` (see [Test coverage](#test-coverage)).
- **No console.log** in any `src/` or `scripts/` file. All logging
  goes through `src/util/logger.mjs` (NDJSON to stdout).

---

## Test coverage

The data-layer tests live under `tests/data/` and run with the
Node built-in test runner (`node --test`). No external deps.

| Test file | What it locks in |
|---|---|
| `tests/data/snapshots.test.mjs` (DT07) | Atomic-write helper; NDJSON append invariants; snapshot directory layout |
| `tests/data/top20.test.mjs` (DT08) | `compositeScore` formula against known fixtures; `rankTokens` ordering invariants |
| `tests/data/pull-data.test.mjs` | CLI parser; command-dispatch; error paths |
| `tests/data/data-tick.test.mjs` | Tick orchestration; spawn-boundary logging; failure-mode handling |

Run the data layer in isolation:

```bash
node --test tests/data/
```

---

## Appendix: code surface

The canonical imports for consumers:

```js
// Fetching live indexer data (with caching, retry, rate-limit)
import { createFetcher } from '../src/data/fetcher.mjs';

// Type contracts + pure helpers
import {
  isValidPool,
  isValidPoolStats,
  isValidToken,
  isValidTokenId,
  normalizeTokenId,
  bchFromSats,
  bpsToPct,
  SATS_PER_BCH,
} from '../src/data/types.mjs';

// Composite-score + ranking (shared by --top20 + backtest)
import { compositeScore, rankTokens } from '../scripts/pull-data.mjs';

// Structured NDJSON logger (NEVER use console.log in src/ or scripts/)
import { createLogger } from '../src/util/logger.mjs';
```

The data supervisor owns the contract; the strategy / trader / dashboard
layers consume it. If you find yourself reaching for the indexer directly
from the strategy layer, you're bypassing the supervisor — open a
DATA_TODO item (or, if it's a feature, a `T-prefix` TODO item for the
build supervisor) instead.

---

*Last updated: 2026-09-11 — DT13*