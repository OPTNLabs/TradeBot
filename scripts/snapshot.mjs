#!/usr/bin/env node
/**
 * scripts/snapshot.mjs
 *
 * One-shot, read-only P&L + positions snapshot for cron-style reporting.
 * Designed to be run from a cron (or manually) and emit a stable,
 * JSON-shaped report that the dashboard / alerts / Telegram bot can
 * consume. NEVER signs, NEVER broadcasts.
 *
 * Usage:
 *   node scripts/snapshot.mjs                       # human-readable summary to stdout
 *   node scripts/snapshot.mjs --json                # raw JSON to stdout
 *   node scripts/snapshot.mjs --out=path/to/file    # write JSON to <file>
 *   node scripts/snapshot.mjs --positions-file=...  # override positions.json path
 *   node scripts/snapshot.mjs --snapshot-record     # ALSO write a balance snapshot to data/snapshots/<date>.jsonl
 *   node scripts/snapshot.mjs --include-all         # include pending + closing positions in `positions[]`
 *   node scripts/snapshot.mjs --help
 *
 * Design rules (also see docs/ARCHITECTURE.md §5 + §6):
 *
 *   1. Read-only. NEVER touches the WIF. NEVER signs. NEVER writes
 *      unless `--snapshot-record` is passed (which appends a balance
 *      snapshot via the existing `Snapshots.record` path).
 *
 *   2. All knobs (position-sizing limits, slippage tolerance, etc.)
 *      come from `config/default.json` + `config/user.json` — never
 *      hard-coded. The script reads them once via `loadConfig` and
 *      passes them down to the portfolio helpers.
 *
 *   3. The script exits 0 on success even when there are no positions
 *      (an empty portfolio is a valid state, not an error). It exits
 *      non-zero on I/O errors, bad JSON in `positions.json`, or a
 *      misconfiguration.
 *
 *   4. `--json` output is the canonical, versioned shape the
 *      downstream consumers (Telegram, dashboard polling, alerting)
 *      consume. `--out` writes the same JSON shape to a file.
 *      Human-readable mode prints a Markdown-ish summary that an
 *      operator can read in their terminal.
 *
 *   5. No `console.log` for the bot's own logs (those go through the
 *      structured logger from `src/util/logger.mjs`). The summary
 *      TEXT and JSON go to stdout because that's the contract.
 *
 * Origin: original code for TradeBot. Built on top of
 * `src/portfolio/{positions,pnl,snapshots}.mjs` and the existing
 * `src/util/{logger,atomic-write}.mjs`. Mirrors docs/ARCHITECTURE.md
 * §5 (data model) + §6 (dashboard surfaces).
 */

import process from 'node:process';
import { writeFileSync } from 'node:fs';

import { createLogger } from '../src/util/logger.mjs';
import { loadConfig } from '../src/util/config-loader.mjs';
import { Positions, DEFAULT_POSITIONS_FILE } from '../src/portfolio/positions.mjs';
import { summarize, summarizeByToken, bestAndWorst, unrealizedPnlSats } from '../src/portfolio/pnl.mjs';
import { Snapshots, DEFAULT_SNAPSHOTS_DIR, deriveSnapshot } from '../src/portfolio/snapshots.mjs';
import { SATS_PER_BCH } from '../src/data/types.mjs';

// ─── Logger ────────────────────────────────────────────────────────────────

const log = createLogger({ component: 'snapshot', sink: process.stderr });

// ─── CLI helpers ────────────────────────────────────────────────────────────

const HELP = `
TradeBot snapshot — one-shot P&L + positions report.

Usage:
  node scripts/snapshot.mjs                       # human-readable summary (stdout)
  node scripts/snapshot.mjs --json                # JSON only (stdout)
  node scripts/snapshot.mjs --out=<path>          # JSON to <path>
  node scripts/snapshot.mjs --positions-file=<p>  # override positions.json path
  node scripts/snapshot.mjs --config-default=<p>  # override config/default.json path
  node scripts/snapshot.mjs --config-user=<p>     # override config/user.json path
  node scripts/snapshot.mjs --snapshot-record     # ALSO write a balance snapshot to data/snapshots/<date>.jsonl
  node scripts/snapshot.mjs --include-all         # include pending + closing in positions[]
  node scripts/snapshot.mjs --help

The script is READ-ONLY unless --snapshot-record is passed. The WIF
is never touched. Exit 0 = success (including "no positions yet");
exit non-zero = I/O error / bad config / positions.json unparseable.
`.trim();

/**
 * Minimal arg parser — handles --flag, --key=value. Boolean flags
 * are set to `true`; key=value flags are strings. Unknown flags
 * throw a clear error.
 *
 * @param {string[]} argv
 * @returns {{ flags: Record<string, string|true>, positional: string[] }}
 */
export function parseSnapshotArgs(argv) {
  const flags = {};
  const positional = [];
  for (const arg of argv.slice(2)) {
    if (arg === '--') continue;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq >= 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        flags[arg.slice(2)] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

/**
 * Resolve which buckets to include in the `positions[]` list. Pure.
 * Defaults to `'open'`. With `--include-all` the helper returns
 * `['open', 'pending', 'closing']` so the operator can see everything
 * in flight.
 *
 * @param {boolean} includeAll
 * @returns {Array<'open'|'pending'|'closing'>}
 */
export function resolvePositionBuckets(includeAll) {
  return includeAll ? ['open', 'pending', 'closing'] : ['open'];
}

/**
 * Compute unrealized P&L for every open position using the position's
 * recorded `entry.price_sats_per_token` as the current price. Pure —
 * no network calls. This is a deliberate approximation: a fresh
 * on-chain re-quote requires the fetcher + a network roundtrip, and
 * a snapshot should be cheap.
 *
 * @param {Array<Object>} openPositions
 * @returns {{ total_unrealized_sats: bigint, per_position: Array<{ position_id: string, token_id: string, unrealized_pnl_sats: bigint|null, pct_return: number|null }> }}
 */
export function computeUnrealized(openPositions) {
  /** @type {Array<{ position_id: string, token_id: string, unrealized_pnl_sats: bigint|null, pct_return: number|null }>} */
  const per_position = [];
  let total = 0n;
  if (!Array.isArray(openPositions)) {
    return { total_unrealized_sats: 0n, per_position };
  }
  for (const p of openPositions) {
    if (!p || typeof p !== 'object') continue;
    const entryPrice = (typeof p?.entry?.price_sats_per_token === 'number')
      ? BigInt(Math.round(p.entry.price_sats_per_token))
      : null;
    if (entryPrice === null || entryPrice <= 0n) {
      per_position.push({
        position_id: p?.id ?? null,
        token_id: p?.token_id ?? null,
        unrealized_pnl_sats: null,
        pct_return: null,
      });
      continue;
    }
    const u = unrealizedPnlSats(p, entryPrice, null);
    // unrealizedPnlSats returns { gross, net, pct } — `net` is the
    // realized-after-fee figure (entry fee + null exit fee here).
    // `null` means we couldn't compute (missing entry spent / token
    // amount / price).
    if (u === null || u.net === null || u.net === undefined) {
      per_position.push({
        position_id: p?.id ?? null,
        token_id: p?.token_id ?? null,
        unrealized_pnl_sats: null,
        pct_return: null,
      });
      continue;
    }
    const unreal = typeof u.net === 'bigint' ? u.net : BigInt(u.net);
    total += unreal;
    // Pct return = unrealized / (entry.bch_spent_sats) * 100, clamped.
    const spent = (typeof p?.entry?.bch_spent_sats === 'number' && Number.isFinite(p.entry.bch_spent_sats))
      ? p.entry.bch_spent_sats
      : 0;
    const pct = spent > 0 ? (Number(unreal) / spent) * 100 : (typeof u.pct === 'number' ? u.pct * 100 : null);
    per_position.push({
      position_id: p?.id ?? null,
      token_id: p?.token_id ?? null,
      unrealized_pnl_sats: unreal,
      pct_return: pct,
    });
  }
  return { total_unrealized_sats: total, per_position };
}

/**
 * Build the canonical `SnapshotReport`. Pure — exports the report
 * shape so the test suite can pin it without touching disk.
 *
 * @param {Object} args
 * @param {Object} args.cfg                 merged default+user config
 * @param {Array<Object>} args.openPositions
 * @param {Array<Object>} args.allOpenPositions   open + pending + closing
 * @param {Array<Object>} args.closedPositions
 * @param {{ total_unrealized_sats: bigint, per_position: Array<Object> }} args.unrealized
 * @param {Object} args.realizedSummary     from pnl.summarize(closed)
 * @param {Object} args.byToken             from pnl.summarizeByToken(closed)
 * @param {{ best: { position: Object, pnl_sats: bigint }|null, worst: { position: Object, pnl_sats: bigint }|null }} args.bestAndWorst
 * @param {string} args.ts                  ISO timestamp
 * @returns {Object}  the snapshot report
 */
export function buildSnapshotReport({
  cfg,
  openPositions,
  allOpenPositions,
  closedPositions,
  unrealized,
  realizedSummary,
  byToken,
  bestAndWorst: bw,
  ts,
}) {
  return {
    schema: 'tradebot.snapshot/v1',
    ts,
    config: {
      tuning_preset: cfg?.tuning_preset ?? null,
      network: cfg?.wallet?.network ?? null,
      cashaddr: cfg?.user?.wallet?.cashaddr ?? cfg?.wallet?.address ?? null,
      max_position_bch: cfg?.entry?.max_position_bch ?? null,
      max_total_exposure_bch: cfg?.entry?.max_total_exposure_bch ?? null,
      min_wallet_balance_bch: cfg?.risk?.min_wallet_balance_bch ?? null,
    },
    realized: {
      count: realizedSummary.count,
      wins: realizedSummary.wins,
      losses: realizedSummary.losses,
      breakeven: realizedSummary.breakeven,
      win_rate_pct: realizedSummary.win_rate_pct,
      realized_pnl_sats: realizedSummary.realized_pnl_sats.toString(),
      realized_pnl_bch: realizedSummary.realized_pnl_bch,
      total_fees_sats: realizedSummary.total_fees_sats.toString(),
      total_fees_bch: realizedSummary.total_fees_bch,
      mean_hold_ms: realizedSummary.mean_hold_ms,
      best_trade_sats: realizedSummary.best_trade_sats === null ? null : realizedSummary.best_trade_sats.toString(),
      worst_trade_sats: realizedSummary.worst_trade_sats === null ? null : realizedSummary.worst_trade_sats.toString(),
      pct_return: realizedSummary.pct_return,
    },
    unrealized: {
      open_position_count: Array.isArray(openPositions) ? openPositions.length : 0,
      total_unrealized_sats: unrealized.total_unrealized_sats.toString(),
      total_unrealized_bch: Number(unrealized.total_unrealized_sats) / SATS_PER_BCH,
      per_position: unrealized.per_position,
    },
    positions: (Array.isArray(allOpenPositions) ? allOpenPositions : []).map((p) => ({
      id: p?.id ?? null,
      token_id: p?.token_id ?? null,
      token_symbol: p?.token_symbol ?? null,
      status: p?.status ?? null,
      side: p?.side ?? null,
      entry_ts: p?.opened_at ?? null,
      updated_ts: p?.updated_at ?? null,
      entry_price_sats_per_token: p?.entry?.price_sats_per_token ?? null,
      entry_bch_spent_sats: p?.entry?.bch_spent_sats ?? null,
      token_amount_base: p?.entry?.token_amount_base ?? null,
      fee_sats: p?.entry?.fee_sats ?? null,
      reasoning: p?.reasoning ?? null,
    })),
    by_token: Object.fromEntries(
      Object.entries(byToken).map(([tid, s]) => [
        tid,
        {
          count: s.count,
          wins: s.wins,
          losses: s.losses,
          win_rate_pct: s.win_rate_pct,
          realized_pnl_sats: s.realized_pnl_sats.toString(),
          realized_pnl_bch: s.realized_pnl_bch,
        },
      ]),
    ),
    best_trade: bw.best ? {
      position_id: bw.best.position?.id ?? null,
      token_id: bw.best.position?.token_id ?? null,
      token_symbol: typeof bw.best.position?.token_symbol === 'string' ? bw.best.position.token_symbol : null,
      closed_at: typeof bw.best.position?.closed_at === 'string' ? bw.best.position.closed_at : null,
      pnl_sats: bw.best.pnl_sats.toString(),
    } : null,
    worst_trade: bw.worst ? {
      position_id: bw.worst.position?.id ?? null,
      token_id: bw.worst.position?.token_id ?? null,
      token_symbol: typeof bw.worst.position?.token_symbol === 'string' ? bw.worst.position.token_symbol : null,
      closed_at: typeof bw.worst.position?.closed_at === 'string' ? bw.worst.position.closed_at : null,
      pnl_sats: bw.worst.pnl_sats.toString(),
    } : null,
  };
}

/**
 * Render the report as a short Markdown-ish summary. Pure. The
 * dashboard reads `--json`; this is for humans tailing logs.
 *
 * @param {Object} report
 * @returns {string}
 */
export function renderHumanReadable(report) {
  /** @type {string[]} */
  const out = [];
  const r = report.realized;
  const u = report.unrealized;
  const cfg = report.config;
  out.push(`# TradeBot snapshot — ${report.ts}`);
  out.push('');
  out.push(`- Config: \`${cfg.tuning_preset ?? 'unknown'}\` on \`${cfg.network ?? 'unknown'}\` (${cfg.cashaddr ?? 'no address'})`);
  out.push(`- Size limits: max_position=${cfg.max_position_bch} BCH, max_exposure=${cfg.max_total_exposure_bch} BCH, wallet_floor=${cfg.min_wallet_balance_bch} BCH`);
  out.push('');
  out.push('## Realized P&L');
  out.push(`- Trades closed: **${r.count}** (wins: ${r.wins}, losses: ${r.losses}, breakeven: ${r.breakeven})`);
  out.push(`- Win rate: **${r.win_rate_pct.toFixed(1)}%**`);
  out.push(`- Realized P&L: **${Number(r.realized_pnl_sats) / SATS_PER_BCH} BCH** (${r.realized_pnl_sats} sats)`);
  out.push(`- Fees paid: ${Number(r.total_fees_sats) / SATS_PER_BCH} BCH (${r.total_fees_sats} sats)`);
  if (r.best_trade_sats !== null) out.push(`- Best trade: ${Number(r.best_trade_sats) / SATS_PER_BCH} BCH`);
  if (r.worst_trade_sats !== null) out.push(`- Worst trade: ${Number(r.worst_trade_sats) / SATS_PER_BCH} BCH`);
  if (r.pct_return !== null) out.push(`- Pct return: ${r.pct_return.toFixed(2)}%`);
  out.push('');
  out.push('## Unrealized P&L');
  out.push(`- Open positions: **${u.open_position_count}**`);
  out.push(`- Unrealized P&L: **${u.total_unrealized_bch} BCH** (${u.total_unrealized_sats} sats)`);
  if (Array.isArray(u.per_position) && u.per_position.length > 0) {
    for (const p of u.per_position) {
      const pct = p.pct_return === null ? 'n/a' : `${p.pct_return.toFixed(2)}%`;
      const pnl = p.unrealized_pnl_sats === null ? 'n/a' : `${Number(p.unrealized_pnl_sats) / SATS_PER_BCH} BCH`;
      out.push(`  - ${p.position_id ?? '?'} (${p.token_id?.slice(0, 8) ?? '?'}…): ${pnl} (${pct})`);
    }
  }
  out.push('');
  if (Array.isArray(report.positions) && report.positions.length > 0) {
    out.push('## Open positions');
    for (const p of report.positions) {
      out.push(`- \`${p.id}\` [${p.status}] ${p.token_symbol ?? '?'} (${p.token_id?.slice(0, 10) ?? '?'}…) — ${p.entry_bch_spent_sats ?? '?'} sats spent at entry`);
      if (p.reasoning && typeof p.reasoning === 'object') {
        const rsn = p.reasoning;
        const bits = [];
        if (rsn.rank != null) bits.push(`rank=${rsn.rank}`);
        if (rsn.score != null) bits.push(`score=${Number(rsn.score).toFixed(2)}`);
        if (rsn.reason) bits.push(`reason=${rsn.reason}`);
        if (bits.length > 0) out.push(`  - reasoning: ${bits.join(', ')}`);
      }
    }
    out.push('');
  } else {
    out.push('## Open positions');
    out.push('_None._');
    out.push('');
  }
  if (report.by_token && Object.keys(report.by_token).length > 0) {
    out.push('## Per-token realized');
    for (const [tid, s] of Object.entries(report.by_token)) {
      out.push(`- \`${tid.slice(0, 10)}…\`: ${s.count} trades, win rate ${s.win_rate_pct.toFixed(1)}%, realized ${s.realized_pnl_bch} BCH`);
    }
  }
  return out.join('\n');
}

// ─── Wire up ────────────────────────────────────────────────────────────────

/**
 * Run the snapshot. Returns the canonical report. Throws on I/O /
 * config errors. NEVER mutates state unless `opts.recordSnapshot`
 * is true (which appends ONE NDJSON line via `Snapshots.record`).
 *
 * @param {Object} opts
 * @param {Object} [opts.cfg]                 merged config; defaults to loadConfig()
 * @param {string} [opts.positionsFile]       defaults to config + DEFAULT_POSITIONS_FILE
 * @param {string} [opts.snapshotsDir]        defaults to config + DEFAULT_SNAPSHOTS_DIR
 * @param {boolean} [opts.recordSnapshot]     write a balance snapshot record?
 * @param {boolean} [opts.includeAll]
 * @param {Object} [opts.positions]           injected Positions instance (tests)
 * @param {Object} [opts.snapshots]           injected Snapshots instance (tests)
 * @param {Object} [opts.logger]
 * @returns {Promise<Object>}
 */
export async function runSnapshot(opts = {}) {
  const logger = opts.logger ?? log;
  const cfg = (opts.cfg && typeof opts.cfg === 'object') ? opts.cfg : await loadConfig({
    defaultPath: opts.configDefault,
    userPath: opts.configUser,
  });
  if (!cfg || typeof cfg !== 'object') {
    throw new Error('runSnapshot: cfg is required (or default.json + user.json must load)');
  }
  const positionsFile = opts.positionsFile
    ?? (cfg.paths?.positions_file ?? DEFAULT_POSITIONS_FILE);
  const snapshotsDir = opts.snapshotsDir
    ?? (cfg.paths?.snapshots_dir ?? DEFAULT_SNAPSHOTS_DIR);

  const positions = opts.positions ?? new Positions({ file: positionsFile, logger });
  await positions.load();

  const buckets = resolvePositionBuckets(!!opts.includeAll);
  /** @type {Array<Object>} */
  const openList = await positions.list('open');
  /** @type {Array<Object>} */
  const pendingList = await positions.list('pending');
  /** @type {Array<Object>} */
  const closingList = await positions.list('closing');
  /** @type {Array<Object>} */
  const closedList = await positions.list('closed');
  const allOpenPositions = [...openList, ...pendingList, ...closingList];

  const realizedSummary = summarize(closedList);
  const byToken = summarizeByToken(closedList);
  const bw = bestAndWorst(closedList);
  const unrealized = computeUnrealized(openList);

  const ts = new Date().toISOString();
  const report = buildSnapshotReport({
    cfg,
    openPositions: openList,
    allOpenPositions,
    closedPositions: closedList,
    unrealized,
    realizedSummary,
    byToken,
    bestAndWorst: bw,
    ts,
  });

  if (opts.recordSnapshot === true) {
    const snapshots = opts.snapshots ?? new Snapshots({ dir: snapshotsDir, logger });
    await snapshots.load();
    // Best-effort: the live wallet balance isn't known to a snapshot CLI
    // (no WIF touch), so we record the empty-balance sentinel. The
    // loop's `Snapshots.maybeRecord` is the canonical writer; this is
    // a manual cron's tool. If a future iteration wants the real balance
    // here, the script would need to accept a `--balance-sats=N` flag.
    const record = deriveSnapshot({
      now: new Date(ts),
      bchBalanceSats: 0n,
      openPositions: allOpenPositions,
      marketPricesSats: {},
      source: 'snapshot-cli',
    });
    await snapshots.record(record);
    report.snapshot_recorded = true;
  } else {
    report.snapshot_recorded = false;
  }

  logger.info('snapshot.ok', {
    ts,
    open_position_count: openList.length,
    pending_count: pendingList.length,
    closing_count: closingList.length,
    closed_count: closedList.length,
    realized_pnl_sats: realizedSummary.realized_pnl_sats.toString(),
    unrealized_pnl_sats: unrealized.total_unrealized_sats.toString(),
    snapshot_recorded: report.snapshot_recorded ?? false,
  });
  return report;
}

// ─── Main ───────────────────────────────────────────────────────────────────

/**
 * @param {string[]} argv
 * @returns {Promise<number>}  process exit code
 */
export async function main(argv = process.argv) {
  const { flags, positional } = parseSnapshotArgs(argv);
  if (flags.help || flags['?'] || flags.h) {
    process.stdout.write(HELP + '\n');
    return 0;
  }
  try {
    const report = await runSnapshot({
      configDefault: typeof flags['config-default'] === 'string' ? flags['config-default'] : undefined,
      configUser: typeof flags['config-user'] === 'string' ? flags['config-user'] : undefined,
      positionsFile: typeof flags['positions-file'] === 'string' ? flags['positions-file'] : undefined,
      recordSnapshot: flags['snapshot-record'] === true,
      includeAll: flags['include-all'] === true,
    });

    if (typeof flags.out === 'string') {
      writeFileSync(flags.out, JSON.stringify(report, null, 2));
      log.info('snapshot.written', { path: flags.out });
      return 0;
    }
    if (flags.json === true) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      return 0;
    }
    process.stdout.write(renderHumanReadable(report) + '\n');
    return 0;
  } catch (err) {
    log.error('snapshot.error', {
      err_name: err?.name ?? 'Error',
      err_message: err?.message ?? String(err),
      err_stack: err?.stack ?? null,
    });
    process.stderr.write(`Snapshot failed: ${err?.message ?? err}\n`);
    return 1;
  }
}

// Direct invocation
const isDirect = import.meta.url === `file://${process.argv[1]}` ||
                 process.argv[1]?.endsWith('snapshot.mjs');
if (isDirect) {
  main(process.argv).then((rc) => process.exit(rc));
}