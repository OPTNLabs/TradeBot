#!/usr/bin/env node
/**
 * scripts/data-tick.mjs (DT12)
 *
 * Thin per-tick orchestrator for the DATA supervisor. One invocation
 * = one supervised tick of the read-only data layer:
 *
 *   1. Run `scripts/pull-data.mjs --snapshot-all [--date=YYYY-MM-DD]`
 *      → writes `data/snapshots/<date>/pools.json` + per-token stats,
 *      → appends one event line to `data/history.ndjson`.
 *
 *   2. Run `scripts/pull-data.mjs --top20`
 *      → recomputes `data/top-tokens.json` (composite top-20 ranking).
 *
 *   3. Log elapsed time + counts through `src/util/logger.mjs`.
 *
 * This is the script the DATA supervisor's cron invoke-cron-tick calls
 * at every hour on the `:00` mark. It is read-only end-to-end — it
 * only spawns child processes that themselves only talk to the
 * Cauldron indexer (never to the wallet, never signs, never
 * broadcasts).
 *
 * Design rules:
 *   - Calls live network only via the spawn boundary. When a `runPullData`
 *     override is injected (tests), no network calls happen.
 *   - Errors never silently swallowed: every spawn failure + every
 *     non-zero child exit is logged through structured JSON.
 *   - Snapshot failure aborts the tick (returns non-zero). `top20`
 *     failure is downgraded to a warning — the snapshots are the
 *     authoritative record; top20 is derived.
 *
 * Usage:
 *   node scripts/data-tick.mjs                   # default tick (today)
 *   node scripts/data-tick.mjs --date=2026-09-11 # backfill a specific date
 *   node scripts/data-tick.mjs --skip-top20      # snapshot-only
 *   node scripts/data-tick.mjs --dry-run         # log plan, no spawn
 *   node scripts/data-tick.mjs --help
 *
 * Exit codes:
 *   0  success (both phases ran, or snapshot-only)
 *   1  snapshot-all failed (authoritative record incomplete)
 *   2  usage error (bad date format, etc.)
 */

import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve as resolvePath } from 'node:path';

import { createLogger } from '../src/util/logger.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname, '..');
const PULL_DATA_PATH = join(__dirname, 'pull-data.mjs');

const log = createLogger({ component: 'data-tick' });

// ─── CLI helpers ────────────────────────────────────────────────────────────

const HELP = `
TradeBot data-tick — one supervised tick of the read-only data layer.

Usage:
  node scripts/data-tick.mjs                       # snapshot-all + top20 (today)
  node scripts/data-tick.mjs --date=YYYY-MM-DD     # backfill a specific date
  node scripts/data-tick.mjs --skip-top20          # snapshot-only
  node scripts/data-tick.mjs --dry-run             # log the plan, no network
  node scripts/data-tick.mjs --help

Read-only end-to-end. Never touches the WIF. Spawns pull-data.mjs as a
child process — both phases hit the Cauldron indexer only.

Exit codes:
  0  success (both phases ran, or --skip-top20 succeeded)
  1  snapshot-all failed (or top20 failed when --skip-top20 not set + --strict)
  2  usage error
`.trim();

/**
 * Minimal arg parser for the data-tick wrapper itself. Mirrors the
 * helpers in `scripts/pull-data.mjs` so the surface is consistent.
 *
 * @param {string[]} argv
 * @returns {{ flags: Record<string, string|true>, positional: string[] }}
 */
export function parseDataTickArgs(argv) {
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

/**
 * Validate a `--date=YYYY-MM-DD` value. Returns the canonical form
 * or throws `TypeError`. Pure — no Date conversion, just regex.
 *
 * @param {string} raw
 * @returns {string}
 */
export function validateDateString(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new TypeError(
      `data-tick: --date must be YYYY-MM-DD (got ${JSON.stringify(raw)})`,
    );
  }
  // Extra sanity: round-trip via Date to reject Feb 30, etc.
  const [y, m, d] = raw.split('-').map((n) => Number(n));
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new TypeError(`data-tick: --date is not a real calendar date (${raw})`);
  }
  return raw;
}

// ─── Spawn helper (overridable for tests) ──────────────────────────────────

/**
 * Default child-process spawner. Logs every non-zero exit + spawn
 * failure. Returns the child's exit code (we don't reject on non-zero
 * because the caller wants to react to specific codes, not throw).
 *
 * @param {string[]} args   args to pass to pull-data.mjs
 * @param {{ logger?: import('../src/util/logger.mjs').Logger }} [opts]
 * @returns {Promise<number>}
 */
export async function defaultRunPullData(args, opts = {}) {
  const logger = opts.logger ?? log;
  return new Promise((resolve) => {
    let stderr = '';
    let stdout = '';
    let child;
    try {
      child = spawn(process.execPath, [PULL_DATA_PATH, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      logger.error('data-tick.spawn-failed', {
        args,
        err_name: err?.name ?? 'Error',
        err_message: err?.message ?? String(err),
      });
      resolve(2);
      return;
    }
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => {
      logger.error('data-tick.child-error', {
        args,
        err_name: err?.name ?? 'Error',
        err_message: err?.message ?? String(err),
      });
      resolve(2);
    });
    child.on('close', (code) => {
      const trimmedStderr = stderr.slice(-1000); // keep tail — long histories overflow
      if (code === 0) {
        logger.info('data-tick.child-ok', {
          args,
          stdout_tail: stdout.slice(-200),
        });
      } else {
        logger.error('data-tick.child-failed', {
          args,
          code,
          stderr_tail: trimmedStderr,
        });
      }
      resolve(code ?? 1);
    });
  });
}

// ─── Pure orchestration (exported for tests) ───────────────────────────────

/**
 * Compose one supervisor tick. Returns the resolved exit code.
 * Each call internally tracks structured-log breadcrumbs so the
 * cron can reconstruct a tick timeline from logs alone.
 *
 * @param {Object} [opts]
 * @param {string} [opts.date]            YYYY-MM-DD for --snapshot-all
 * @param {boolean} [opts.skipTop20]
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.strict]         when true, top20 failure also aborts
 * @param {(args: string[], spawnOpts?: object) => Promise<number>} [opts.runPullData]
 * @param {import('../src/util/logger.mjs').Logger} [opts.logger]
 * @returns {Promise<{ rc: number, snapshot_rc: number, top20_rc: number|null, elapsed_ms: number }>}
 */
export async function runDataTick(opts = {}) {
  const {
    date,
    skipTop20 = false,
    dryRun = false,
    strict = false,
    runPullData = defaultRunPullData,
    logger = log,
  } = opts;

  const startedAt = Date.now();
  const ts = new Date(startedAt).toISOString();

  // 1. Build --snapshot-all args
  const snapArgs = ['--snapshot-all'];
  if (typeof date === 'string' && date) {
    try {
      validateDateString(date);
    } catch (e) {
      logger.error('data-tick.bad-date', { date, message: e?.message });
      return { rc: 2, snapshot_rc: 2, top20_rc: null, elapsed_ms: 0 };
    }
    snapArgs.push(`--date=${date}`);
  }

  // 2. Optional --top20 args
  const top20Args = ['--top20'];

  if (dryRun) {
    logger.info('data-tick.dry-run', {
      ts,
      snap_args: snapArgs,
      top20_args: top20Args,
      skip_top20: skipTop20,
      strict,
    });
    return { rc: 0, snapshot_rc: 0, top20_rc: skipTop20 ? null : 0, elapsed_ms: 0 };
  }

  logger.info('data-tick.start', {
    ts,
    date: date ?? null,
    skip_top20: skipTop20,
    strict,
  });

  // 3. Phase A: --snapshot-all (authoritative)
  const snapshot_rc = await runPullData(snapArgs, { logger });
  if (snapshot_rc !== 0) {
    logger.error('data-tick.snapshot-failed', {
      rc: snapshot_rc,
      args: snapArgs,
      elapsed_ms: Date.now() - startedAt,
    });
    return { rc: 1, snapshot_rc, top20_rc: null, elapsed_ms: Date.now() - startedAt };
  }

  // 4. Phase B: --top20 (derived; downgrade to warn unless --strict)
  let top20_rc = null;
  if (!skipTop20) {
    top20_rc = await runPullData(top20Args, { logger });
    if (top20_rc !== 0) {
      if (strict) {
        logger.error('data-tick.top20-failed-strict', {
          rc: top20_rc,
          elapsed_ms: Date.now() - startedAt,
        });
        return { rc: 1, snapshot_rc, top20_rc, elapsed_ms: Date.now() - startedAt };
      }
      logger.warn('data-tick.top20-failed-non-strict', {
        rc: top20_rc,
        elapsed_ms: Date.now() - startedAt,
      });
    }
  }

  const elapsed_ms = Date.now() - startedAt;
  logger.info('data-tick.done', {
    ts,
    snapshot_rc,
    top20_rc,
    elapsed_ms,
  });
  return { rc: 0, snapshot_rc, top20_rc, elapsed_ms };
}

// ─── CLI entry ──────────────────────────────────────────────────────────────

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv = process.argv) {
  const { flags, positional } = parseDataTickArgs(argv);

  if (flags.help || flags.h || flags['?']) {
    process.stdout.write(HELP + '\n');
    return 0;
  }

  let date;
  try {
    if (typeof flags.date === 'string') {
      date = validateDateString(flags.date);
    }
  } catch (e) {
    if (e instanceof TypeError) {
      log.error('data-tick.bad-cli-date', { message: e.message, value: flags.date });
      process.stderr.write(`${e.message}\n`);
      return 2;
    }
    throw e;
  }

  const result = await runDataTick({
    date,
    skipTop20: flags['skip-top20'] === true,
    dryRun: flags['dry-run'] === true,
    strict: flags.strict === true,
  });

  if (result.rc !== 0) {
    process.stderr.write(
      `data-tick failed: rc=${result.rc} snapshot_rc=${result.snapshot_rc}` +
      ` top20_rc=${result.top20_rc ?? 'n/a'} (elapsed=${result.elapsed_ms}ms)\n`,
    );
  } else {
    process.stdout.write(
      `data-tick ok: snapshot_rc=${result.snapshot_rc}` +
      ` top20_rc=${result.top20_rc ?? 'n/a'} (elapsed=${result.elapsed_ms}ms)\n`,
    );
  }
  return result.rc;
}

const isDirect = import.meta.url === `file://${process.argv[1]}` ||
                 process.argv[1]?.endsWith('data-tick.mjs');
if (isDirect) {
  main(process.argv).then(
    (rc) => process.exit(rc),
    (err) => {
      log.error('data-tick.unexpected-error', {
        err_name: err?.name ?? 'Error',
        err_message: err?.message ?? String(err),
        stack: err?.stack ?? null,
      });
      process.exit(1);
    },
  );
}
