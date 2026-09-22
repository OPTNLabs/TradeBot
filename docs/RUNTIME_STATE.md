# TradeBot Runtime State

> The on-disk state the trading bot READS / WRITES while running.
> Schema reference + lifecycle + reset / replay instructions.
>
> **Related docs:**
> - `docs/ARCHITECTURE.md` — system design (where these files live in the data flow).
> - `docs/DATA_LAYOUT.md` — the **data supervisor's** side (`data/snapshots/<date>/pools.json`,
>   `data/top-tokens.json`, `data/history.ndjson`, `docs/reports/*.md`). This doc covers
>   the **trader bot's** side. They share the `data/` tree but write disjoint files —
>   see [Side-by-side map](#side-by-side-map) below.
> - `docs/RUNBOOK.md` — operator procedures (start / stop / restart / inspect).

---

## Table of contents

1. [The contract](#the-contract)
2. [Files the bot writes](#files-the-bot-writes)
3. [`data/positions.json`](#datapositionsjson)
4. [`data/snapshots/<YYYY-MM-DD>.jsonl`](#datasnapshotsyyyy-mm-ddjsonl)
5. [`data/history.jsonl`](#datahistoryjsonl)
6. [The empty-state contract](#the-empty-state-contract)
7. [Atomic-write contract](#atomic-write-contract)
8. [Lifecycle](#lifecycle)
9. [Reset / replay / audit](#reset--replay--audit)
10. [Side-by-side map (trader vs data-supervisor)](#side-by-side-map-trader-vs-data-supervisor)
11. [How to bootstrap a fresh checkout](#how-to-bootstrap-a-fresh-checkout)
12. [Test coverage](#test-coverage)
13. [Appendix: code surface](#appendix-code-surface)

---

## The contract

Every file under `data/` that the trading bot writes follows three rules:

1. **Gitignored.** The entire `/data/` tree is gitignored (`.gitignore` blocks `/data/`,
   `/data/positions.json`, `/data/history.jsonl`, `/data/snapshots/`, `/data/*.json`,
   `/data/*.jsonl`). A `data/.gitkeep` placeholder keeps the directory present in fresh
   checkouts, but NO runtime state is ever committed.
2. **Atomic.** Every write goes through `src/util/atomic-write.mjs` — write-tmp + rename
   for JSON, append-only NDJSON for log files. The bot is killable at any moment;
   partial writes cannot leave a half-written file on disk.
3. **Self-bootstrapping.** Each module creates its own file on first read if the file is
   missing (see [Empty-state contract](#the-empty-state-contract)). Operators do not
   have to pre-create any file for the bot to start — EXCEPT `data/positions.json` is
   initialised with a version-1 envelope by `Positions.load()` on first read.

If a runtime state file is corrupted or has the wrong shape, the bot will refuse to
boot rather than silently overwrite it (see "Defensive reads" in `src/util/atomic-write.mjs`).

---

## Files the bot writes

| Path | Writer | Format | Lifetime | Purpose |
|---|---|---|---|---|
| `data/positions.json` | `Positions.open/close/confirm/startClosing` | JSON (envelope) | persistent (overwritten in place) | Live portfolio state |
| `data/snapshots/<YYYY-MM-DD>.jsonl` | `Snapshots.record` | NDJSON | append-only, one file per UTC day | Balance + position snapshots for the dashboard chart |
| `data/history.jsonl` | `loop.historyAppend` (trader tick events) | NDJSON | append-only, never rotated by the bot | Trader tick log (entries, exits, errors) |

The data supervisor (separate cron) writes a disjoint set of files into the same tree —
see [Side-by-side map](#side-by-side-map).

All three paths are configurable via `config/default.json`:

```json
{
  "paths": {
    "positions_file": "data/positions.json",
    "snapshots_dir":   "data/snapshots",
    "history_file":    "data/history.jsonl"
  }
}
```

Default `config/default.json` ships the values above. Override per-deployment
(via `config/user.json` or env-style overrides) for operators who want to point the
bot at a USB stick, second disk, or per-test sandbox.

---

## `data/positions.json`

**Shape** (JSON object):

```jsonc
{
  "version": 1,                 // schema version (POSITIONS_VERSION in src/portfolio/positions.mjs)
  "updated_at": "2026-09-11T12:21:29.303Z",   // last write timestamp (ISO 8601)
  "open":    [ /* PositionEntry, … */ ],     // status ∈ { "open", "pending", "closing" }
  "closed":  [ /* PositionEntry, … */ ],     // status === "closed"
  "meta": {
    "total_opened":  0,                       // monotonic counter
    "total_closed":  0,                       // monotonic counter
    "created_at":    "2026-09-11T12:21:29.304Z"
  }
}
```

**`PositionEntry`** (full shape — see `src/portfolio/positions.mjs:130` for the canonical typedef):

```jsonc
{
  "id":   "pos_2026-09-11_0001",        // ULID-ish; monotonic via Positions._newPositionId()
  "token_id":  "2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544",
  "token_symbol":  "PUSD",                // resolved from BCMR at open time; may be undefined
  "token_decimals": 2,                    // resolved from BCMR at open time; may be undefined
  "side":  "long_token",                  // v1 only: long_token (BCH → token)
  "status": "open",                       // "pending" | "open" | "closing" | "closed"
  "entry": {
    "txid":                   "ab12…",   // on-chain entry txid (lowercase hex)
    "ts":                     "2026-09-11T12:30:00.000Z",
    "price_sats_per_token":   1000,      // sats per 1 base-unit of the token
    "bch_spent_sats":         500_000,   // gross BCH spent (incl. fees)
    "token_amount_base":      "500000",  // bigint as decimal string
    "fee_sats":               3000,      // LP fee + network fee the bot paid
    "score":                  0.5539,    // composite score at the entry tick (audit)
    "rank":                   1          // rank at the entry tick (audit)
  },
  "opened_at":  "2026-09-11T12:30:00.000Z",
  "high_water_mark_sats_per_token": 1050,  // highest price seen since open; updated each tick
  "exit": {                                // only present after close() lands
    "txid":        "cd34…",
    "ts":          "2026-09-11T14:30:00.000Z",
    "price_sats_per_token": 1050,
    "bch_received_sats":    525_000,
    "fee_sats":             3000,
    "realized_pnl_sats":    22_000,        // signed; + = profit, − = loss
    "realized_pnl_bch":     0.00022,
    "reason":               "take_profit", // take_profit | stop_loss | trailing_stop | time_stop | manual
    "kind":                 "take_profit"
  }
}
```

**Lifecycle for one position** (state machine — see `src/portfolio/positions.mjs:574`):

```
(open)            ← Positions.open() inserts here
  ↓ tx confirms
(pending → open)  ← Positions.confirm() flips status once tx is on chain
  ↓ price moves
(open → closing)  ← Positions.startClosing() flips status when a sell is broadcast
  ↓ sell tx confirms
(closing → closed) ← Positions.close() inserts the exit envelope + moves to `closed`
```

The on-disk `open` array contains BOTH `open` and `pending` rows (so a kill between
`open()` and `confirm()` doesn't lose the position). The dashboard / strategy layer
treats them differently (pending is "not yet on chain").

---

## `data/snapshots/<YYYY-MM-DD>.jsonl`

**Format:** NDJSON — one JSON object per line, one line per snapshot tick. Newline-delimited
means the bot can `cat data/snapshots/2026-09-11.jsonl | head -5` and read humans.

**Path derivation** (see `src/portfolio/snapshots.mjs:snapshotFilePath`):

```js
const date = new Date().toISOString().slice(0, 10);   // "2026-09-11"
const file = `${snapshots_dir}/${date}.jsonl`;
```

So a tick that crosses UTC midnight splits the line into two files (one per UTC day).
This is intentional — keeps each file bounded to ~86400 seconds of activity, easy to
archive / prune.

**Shape of one line** (see `src/portfolio/snapshots.mjs:deriveSnapshot`):

```jsonc
{
  "v": 1,                                       // SNAPSHOT_VERSION
  "ts": "2026-09-11T16:30:00.000Z",             // snapshot timestamp
  "bch_balance_sats": "4435967",                // wallet BCH balance in sats
  "open_position_count": 1,                    // pending + open + closing rows
  "total_exposure_sats": "500000",              // sum of open-position bch_spent_sats
  "unrealized_pnl_sats": "499999497000",        // null when no priced positions
  "meta": { "source": "loop" },                 // producer (loop, snapshot script, …)
  "token_id": null                              // present for per-token snapshots (rare)
}
```

**Why NDJSON?** Append-only — the bot never reads-then-rewrites the file. If the bot
is killed mid-write, the trailing partial line will fail `JSON.parse` on read but the
previous lines are intact. The dashboard's `/api/snapshots` endpoint skips unparseable
lines.

---

## `data/history.jsonl`

**Format:** NDJSON — one JSON object per trader tick event. The bot appends to this
file every loop tick (`trader/loop.mjs:historyAppend`).

**Shape** (one line per event — see the loop's audit block in `src/trader/loop.mjs`):
The bot emits different `event` shapes depending on the tick phase:

```jsonc
// Entry fill (from src/trader/swap.mjs)
{"event":"trade.entry","ts":"…","token_id":"…","side":"buy","bch_in_or_out":"-500000",
 "tokens_in_or_out":"+500000","entry_price":"1000000","expected_price":"1000000",
 "actual_slippage_bps":"0","txid":"…","balance_after":"4435967", …}

// Exit fill
{"event":"trade.exit","ts":"…","token_id":"…","side":"sell","bch_in_or_out":"+550000",
 "tokens_in_or_out":"-500000","entry_price":"1000000","expected_price":"1100000",
 "actual_slippage_bps":"100","txid":"…","balance_after":"4435967", …}

// Position state transitions (from src/portfolio/positions.mjs)
{"event":"positions.open","ts":"…","position_id":"pos_…","token_id":"…","status":"open", …}
{"event":"positions.close","ts":"…","position_id":"pos_…","exit_reason":"take_profit",
 "realized_pnl_sats":22000,"realized_pnl_bch":0.00022, …}

// Snapshot write (from src/portfolio/snapshots.mjs)
{"event":"snapshots.record","ts":"…","file":"data/snapshots/2026-09-11.jsonl", …}

// Tick summary (from src/trader/loop.mjs)
{"event":"loop.tick","ts":"…","entries_attempted":2,"entries_succeeded":1,
 "exits_attempted":1,"exits_succeeded":1,"wallet_balance_sats":"4435967",
 "open_position_count":0,"breaker_tripped":false, …}
```

**The bot does not rotate this file.** It grows unbounded. Operators who care about
disk usage should rotate externally (cron job: `gzip data/history.jsonl.YYYY-MM-DD`
on day rollover). The bot will APPEND to the same file next tick regardless of
existing size — this is intentional for audit traceability.

---

## The empty-state contract

Every runtime state file has a well-defined empty shape. The bot's modules initialise
the file on first read so a fresh checkout works without any operator setup.

| File | Empty shape (initial) | Created by |
|---|---|---|
| `data/positions.json` | `{version:1, updated_at:<now>, open:[], closed:[], meta:{total_opened:0, total_closed:0, created_at:<now>}}` | `Positions.load()` on first read |
| `data/snapshots/<YYYY-MM-DD>.jsonl` | file does not exist; first line written by `Snapshots.record()` on the first tick that crosses `snapshot_interval_seconds` (default 60s) | `Snapshots.maybeRecord()` |
| `data/history.jsonl` | file does not exist; first line written by the first tick that has any event to log | `loop.historyAppend` |

**No file pre-creation is needed for a fresh clone.** The bot's first `TradingLoop.tick()`
will create whichever files it writes to.

> **`data/` directory itself** is NOT auto-created by the bot. A fresh checkout has
> `data/.gitkeep` committed so the directory exists in git. If you delete the entire
> `data/` directory (`rm -rf data`), the bot will refuse to start because `ensureDirForFile`
> is called by `Positions.load()` BEFORE the first write — verify by deleting it
> intentionally: the bot WILL recreate the directory. To pre-create the empty files
> explicitly (e.g. for a CI smoke test), run `scripts/init-data-dir.mjs` (see
> [Bootstrap](#how-to-bootstrap-a-fresh-checkout)).

---

## Atomic-write contract

Every JSON write goes through `atomicWriteJson(file, value, fs)` in
`src/util/atomic-write.mjs`. Every NDJSON append goes through `atomicAppendNdjson(file,
line, fs)`. Both are:

- **Crash-safe.** JSON: write `<file>.tmp.<hex8>` (unique suffix) → `fsync` → rename
  to `<file>`. NDJSON: read-modify-write of the whole file under a tmp + rename
  (the append is small so this is acceptable).
- **Mode 0600 on write.** The tmp file is opened with `mode: 0o600` so a partially-
  written file is not world-readable (the bot's wallet WIF lives in `config/user.json`,
  not here, but we keep the habit).
- **No torn writes.** A kill at any point leaves either the OLD file intact or the
  NEW file fully renamed. There is never a `<file>` whose contents are neither.

The 8-hex-char random suffix on `<file>.tmp.<hex8>` (added in T19) means concurrent
writers don't race on the same tmp path.

---

## Lifecycle

```
fresh checkout
   │
   ▼
(trader bot first start)
   │
   ├── Positions.load()        →  creates data/positions.json (empty envelope)
   ├── Snapshots.load()        →  no file yet (lazy-create on first record())
   ├── TradingLoop.tick() #1   →  no entry/exit, no snapshots yet
   ├── TradingLoop.tick() #2   →  maybe history.jsonl first line (tick summary)
   ├── TradingLoop.tick() #N   →  first snapshot.jsonl line after 60s
   │
   ▼
(running; positions.json + history.jsonl + snapshots/<date>.jsonl all growing)
   │
   ▼
(trader bot restart — SIGTERM / SIGKILL / power loss)
   │
   ▼
(next start)
   │
   ├── Positions.load()        →  reads existing positions.json, defensive fills
   ├── Snapshots.load()        →  reads existing snapshots dir, picks up last_ts
   ├── TradingLoop.tick() #1   →  resumes where it left off (positions preserved)
   │
   ▼
(running again; state is continuous)
```

**Restart safety is enforced by:**
- `Positions.load()` defensive fills (`Array.isArray` checks, default meta)
- `Positions._withFile` retries on `ENOENT` from concurrent writes
- `atomicWriteJson` unique tmp suffix (no race on `<file>.tmp`)
- `Snapshots.shouldRecord` cadence-aware (won't re-emit at every restart)
- `atomicAppendNdjson` on `history.jsonl` (never overwrites prior events)

---

## Reset / replay / audit

### Reset everything (DESTRUCTIVE — use only for clean slate)
```bash
rm -f data/positions.json
rm -rf data/snapshots/
rm -f data/history.jsonl
rm -f data/top-tokens.json         # data supervisor's top-20 ranking
rm -f data/history.ndjson          # data supervisor's pull-side log
rm -rf data/snapshots/             # data supervisor's per-tick snapshot tree
node scripts/init-data-dir.mjs     # recreate empty positions.json + dirs
```

### Reset just positions (keep audit trail)
```bash
node scripts/run-bot.mjs --reset-positions
# OR (manual):
echo '{"version":1,"updated_at":"'$(date -u +%Y-%m-%dT%H:%M:%S.000Z)'","open":[],"closed":[],"meta":{"total_opened":0,"total_closed":0,"created_at":"'$(date -u +%Y-%m-%dT%H:%M:%S.000Z)'"}}' > data/positions.json
```

### Audit / query
```bash
# What positions are open right now?
jq '.open | map({id, token_id, token_symbol, entry_price_sats_per_token: .entry.price_sats_per_token, opened_at})' data/positions.json

# How many ticks ran today?
wc -l data/snapshots/$(date -u +%Y-%m-%d).jsonl

# What was the wallet balance 6 hours ago?
jq -r 'select(.ts >= "2026-09-11T10:00:00Z" and .ts < "2026-09-11T11:00:00Z") | .bch_balance_sats' \
   data/snapshots/$(date -u +%Y-%m-%d).jsonl | head -1

# All trades the bot has ever executed (entry + exit)
jq -r 'select(.event == "trade.entry" or .event == "trade.exit")' data/history.jsonl

# Total fees paid
jq -s 'map(select(.event == "trade.entry" or .event == "trade.exit") | .fee_sats // 0) | add' data/history.jsonl

# Realized P&L (sum of all closes)
jq -s 'map(select(.event == "positions.close") | .realized_pnl_sats // 0) | add' data/history.jsonl
```

### Replay (backtest)
The bot does not yet ship a backtest harness. The data is laid out so a backtest
script can:
1. Read `data/snapshots/<date>/pools.json` for one tick's pool state
2. Read `data/snapshots/<date>/token-stats/<id>.json` for per-token detail
3. Apply the strategy's scoring + entry/exit logic to the historical state
4. Compare to the bot's actual decisions in `data/history.jsonl`

See `docs/ARCHITECTURE.md §6` for the backtest surface plan.

---

## Side-by-side map (trader vs data-supervisor)

The `data/` tree is shared between TWO supervisors:
- **Trader bot** (this doc) — owns `positions.json`, `history.jsonl`, `snapshots/<date>.jsonl` (flat NDJSON).
- **Data supervisor** (separate cron, see `DATA_TODO.md` and `docs/DATA_LAYOUT.md`) —
  owns `history.ndjson` (pull-side log), `top-tokens.json`, `snapshots/<date>/pools.json` (per-tick tree).

The two write to DIFFERENT files inside `data/snapshots/`:

| Path | Writer | Format |
|---|---|---|
| `data/snapshots/<date>.jsonl` | **trader** (Snapshots.record) | flat NDJSON (one file per UTC day) |
| `data/snapshots/<date>/pools.json` | **data-supervisor** (pull-data.mjs) | directory tree (one dir per UTC day, pools.json inside) |
| `data/snapshots/<date>/token-stats/<id>.json` | **data-supervisor** | per-token stats inside the day dir |
| `data/history.jsonl` | **trader** (loop.historyAppend) | trader tick events |
| `data/history.ndjson` | **data-supervisor** (pull-data.mjs) | pull-side tick events |
| `data/top-tokens.json` | **data-supervisor** | composite top-20 ranking |
| `data/positions.json` | **trader** (Positions) | live portfolio state |

**There is no collision** — the file paths differ in extension (`.jsonl` vs `.json`),
in parent path (`snapshots/<date>.jsonl` vs `snapshots/<date>/pools.json`), and in
name (`history.jsonl` vs `history.ndjson`).

---

## How to bootstrap a fresh checkout

A fresh clone has `data/.gitkeep` and nothing else under `data/`. The bot will
auto-create the runtime files on first start. To pre-create them explicitly
(useful for CI, smoke tests, or first-boot confidence):

```bash
node scripts/init-data-dir.mjs
# → creates data/positions.json with the empty envelope
# → ensures data/snapshots/ exists
# → does NOT touch history.jsonl or snapshots/*.jsonl (append-only; created on first write)
```

Optional flags:
- `--force` — overwrite `data/positions.json` even if it exists (DESTRUCTIVE)
- `--quiet` — suppress the stdout summary

The script is idempotent — running it twice is safe; the second run reports
"already exists, skipping" for each file.

---

## Test coverage

The runtime-state surface is exercised by:
- `tests/portfolio-positions.test.mjs` — open / close / confirm / startClosing lifecycle, crash safety
- `tests/portfolio-snapshots.test.mjs` — derive, cadence, NDJSON append, date rollover
- `tests/util-atomic-write.test.mjs` — atomic-write JSON + NDJSON, unique tmp suffix
- `tests/scripts.test.mjs` — `init-data-dir.mjs` bootstrap (T20) + the existing scripts
- `tests/integration/pipeline.test.mjs` — end-to-end: positions survive a "restart"
  (fresh Positions instance reads same file), crash-safety contract holds

The atomic-write + restart-safety contract is the **most** tested surface in the
repo — both because it's the primary crash-safety mechanism and because every other
module depends on it.

---

## Appendix: code surface

| Surface | File | Lines |
|---|---|---|
| `Positions` class (load, open, close, confirm, startClosing) | `src/portfolio/positions.mjs` | ~700 |
| `Snapshots` class (load, record, derive) | `src/portfolio/snapshots.mjs` | ~470 |
| `createHistoryAppender` (trader tick log) | `src/trader/loop.mjs` (line 297) | ~25 |
| `atomicWriteJson` / `atomicAppendNdjson` | `src/util/atomic-write.mjs` | ~430 |
| `init-data-dir.mjs` script | `scripts/init-data-dir.mjs` | T20 |
| `positions.json` schema doc | this file | — |
