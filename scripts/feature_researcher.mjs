#!/usr/bin/env node
// scripts/feature_researcher.mjs
//
// Cron entry point. Loads the feature-ideas store, asks the
// researcher what to append, persists the new ideas, stamps
// last_research_at, and (T30c) appends a structured
// `kind:'research_cron_run'` history event so the dashboard can
// show "last 5 cron runs" + "since last research" without reading
// the script logs.
//
// Usage (called by the `feature_researcher` OpenClaw cron, or by
// the operator for manual / off-cycle research runs):
//
//   node scripts/feature_researcher.mjs                        # normal run
//   node scripts/feature_researcher.mjs --dry-run              # print, don't write (also skips history)
//   node scripts/feature_researcher.mjs --dry-run --history    # preview run, but DO write a history event
//   node scripts/feature_researcher.mjs --no-history           # real run, but DON'T write a history event
//   node scripts/feature_researcher.mjs --force                # skip rate-limit
//   node scripts/feature_researcher.mjs --file=<path>          # override store path
//   node scripts/feature_researcher.mjs --history-file=<path> # override history NDJSON path
//   node scripts/feature_researcher.mjs --max-per-run=N        # cap on new ideas (default 3)
//   node scripts/feature_researcher.mjs --min-interval-hours=N # rate-limit window (default 12)
//
// Exit codes:
//   0 = success (ran or correctly skipped)
//   1 = network / filesystem error
//   2 = bad usage
//   3 = rate-limited (last research was recent; use --force to override)

import process from 'node:process';

import { createLogger } from '../src/util/logger.mjs';
import { atomicAppendNdjson } from '../src/util/atomic-write.mjs';
import { FeatureIdeasStore } from '../src/feature-ideas/store.mjs';
import { RESEARCH_CATALOG } from '../src/feature-ideas/research-catalog.mjs';
import {
  pickIdeas,
  shouldRunResearch,
} from '../src/feature-ideas/researcher.mjs';

/**
 * @typedef {Object} ResearcherArgs
 * @property {boolean} dryRun             don't mutate the store
 * @property {boolean} force              skip rate-limit
 * @property {boolean} noHistory          skip history event write (operator override)
 * @property {boolean} withHistory        even on a dry-run, write a history event
 * @property {string}  file               feature-ideas JSON file
 * @property {string}  historyFile        NDJSON file for `kind:'research_cron_run'` events
 * @property {number}  maxPerRun          cap on new ideas per pass
 * @property {number}  minIntervalHours   rate-limit window
 */

/**
 * Parse argv. Behavior:
 *   --dry-run                → store + history writes both suppressed
 *   --dry-run --history      → store write suppressed, but history event written
 *   --no-history             → store written, but history event suppressed
 *   --dry-run --no-history   → same as --dry-run alone (dry-run already suppresses history)
 *   --no-history --history   → --history wins (last flag)
 *
 * @param {string[]} argv
 * @returns {ResearcherArgs}
 */
export function parseResearcherArgs(argv) {
  const out = {
    dryRun: false,
    force: false,
    noHistory: false,
    withHistory: false,
    file: 'data/feature-ideas.json',
    historyFile: 'data/history.ndjson',
    maxPerRun: 3,
    minIntervalHours: 12,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--force') out.force = true;
    else if (a === '--no-history') { out.noHistory = true; out.withHistory = false; }
    else if (a === '--history') { out.withHistory = true; out.noHistory = false; }
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'Usage: node scripts/feature_researcher.mjs [--dry-run] [--force] ' +
        '[--no-history] [--history] [--file=<path>] [--history-file=<path>] ' +
        '[--max-per-run=N] [--min-interval-hours=N]\n',
      );
      process.exit(0);
    } else if (a.startsWith('--file=')) out.file = a.slice('--file='.length);
    else if (a.startsWith('--history-file=')) out.historyFile = a.slice('--history-file='.length);
    else if (a.startsWith('--max-per-run=')) {
      const n = parseInt(a.slice('--max-per-run='.length), 10);
      if (!Number.isFinite(n) || n < 0) {
        process.stderr.write(`feature_researcher: bad --max-per-run=${a}\n`);
        process.exit(2);
      }
      out.maxPerRun = n;
    } else if (a.startsWith('--min-interval-hours=')) {
      const n = parseFloat(a.slice('--min-interval-hours='.length));
      if (!Number.isFinite(n) || n < 0) {
        process.stderr.write(`feature_researcher: bad --min-interval-hours=${a}\n`);
        process.exit(2);
      }
      out.minIntervalHours = n;
    } else {
      process.stderr.write(`feature_researcher: unknown flag ${a}\n`);
      process.exit(2);
    }
  }
  return out;
}

/**
 * Build the structured history event for a research cron run. Pure —
 * the caller decides whether to actually append it (driven by
 * `--dry-run` and `--no-history` semantics).
 *
 * @param {Object} opts
 * @param {Date}   opts.now
 * @param {Object} opts.result           the result returned by mainFeatureResearcher
 * @param {boolean} opts.dryRun
 * @param {boolean} opts.rateLimited     true iff the gate prevented the run
 * @param {boolean} opts.forced          true iff --force was passed
 * @param {string}  opts.file            feature-ideas JSON path (for the audit)
 * @param {string}  opts.source          'feature-researcher' (constant)
 * @returns {Object}                     the event shape that lands in data/history.ndjson
 */
export function buildResearchCronRunEvent(opts) {
  if (!opts || typeof opts !== 'object') {
    throw new Error('buildResearchCronRunEvent: opts required');
  }
  const result = opts.result ?? {};
  const ideas = Array.isArray(result.ideas) ? result.ideas : [];
  return {
    ts: (opts.now instanceof Date ? opts.now : new Date()).toISOString(),
    kind: 'research_cron_run',
    source: typeof opts.source === 'string' ? opts.source : 'feature-researcher',
    dry_run: !!opts.dryRun,
    forced: !!opts.forced,
    rate_limited: !!opts.rateLimited,
    ran: result.ran === true,
    added: Number.isFinite(result.added) ? result.added : 0,
    skipped: Number.isFinite(result.skipped) ? result.skipped : 0,
    available: Number.isFinite(result.available) ? result.available : 0,
    spent: Number.isFinite(result.spent) ? result.spent : 0,
    hours_since_last_run: Number.isFinite(result.hoursSinceLastRun) ? result.hoursSinceLastRun : null,
    ideas_added: ideas.map((i) => ({
      id: typeof i?.id === 'string' ? i.id : null,
      title: typeof i?.title === 'string' ? i.title : null,
    })),
    file: typeof opts.file === 'string' ? opts.file : null,
  };
}

/**
 * Append a research-cron-run history event to the NDJSON file.
 * Errors are NOT thrown — the cron caller is the production caller
 * and a history-append failure must NEVER mask the store mutation
 * result. Errors are returned to the caller so they can be logged
 * via the structured logger.
 *
 * @param {Object} opts
 * @param {string} opts.historyFile
 * @param {Object} opts.event              from buildResearchCronRunEvent
 * @param {typeof import('node:fs/promises')} [opts.fs]
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function appendResearchCronRunEvent({ historyFile, event, fs }) {
  if (typeof historyFile !== 'string' || historyFile.length === 0) {
    return { ok: false, error: 'historyFile required' };
  }
  if (!event || typeof event !== 'object') {
    return { ok: false, error: 'event required' };
  }
  const line = JSON.stringify(event);
  try {
    await atomicAppendNdjson(historyFile, line, fs);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/**
 * Should we write a history event for THIS run? Combines the four
 * flag inputs:
 *
 *   - dryRun=true   → skip history (default for dry-run)
 *   - noHistory=true → skip history (operator override)
 *   - withHistory=true → write history even on dry-run
 *   - otherwise     → write history
 *
 * Effective decision: write iff (!dryRun || withHistory) && !noHistory.
 *
 * Pure. Exported for tests.
 *
 * @param {{ dryRun?: boolean, noHistory?: boolean, withHistory?: boolean }} opts
 * @returns {boolean}
 */
export function shouldWriteResearchCronHistory(opts) {
  if (!opts || typeof opts !== 'object') return false;
  const dryRun = !!opts.dryRun;
  const noHistory = !!opts.noHistory;
  const withHistory = !!opts.withHistory;
  if (noHistory) return false;
  if (dryRun && !withHistory) return false;
  return true;
}

/**
 * @param {Object} opts
 * @param {boolean} opts.dryRun
 * @param {boolean} opts.force
 * @param {boolean} [opts.noHistory]
 * @param {string}  opts.file
 * @param {string}  [opts.historyFile]
 * @param {number}  opts.maxPerRun
 * @param {number}  opts.minIntervalHours
 * @param {Object}  [opts.logger]
 * @param {Console} [opts.console]
 * @param {typeof import('node:fs/promises')} [opts.fs]   fs seam for tests
 * @returns {Promise<{
 *   ran: boolean,
 *   added: number,
 *   skipped: number,
 *   available: number,
 *   spent: number,
 *   hoursSinceLastRun: number|null,
 *   ideas: Array<{id: string, title: string}>,
 *   historyWritten: boolean,
 *   historyError: string|null,
 * }>}
 */
export async function mainFeatureResearcher(opts) {
  const log = (opts.logger) ?? createLogger({ component: 'feature-researcher', sink: process.stderr });
  const file = opts.file;
  const historyFile = (typeof opts.historyFile === 'string' && opts.historyFile.length > 0)
    ? opts.historyFile
    : 'data/history.ndjson';
  const dryRun = !!opts.dryRun;
  const force = !!opts.force;
  const noHistory = !!opts.noHistory;
  const withHistory = !!opts.withHistory;
  const maxPerRun = opts.maxPerRun;
  const minIntervalHours = opts.minIntervalHours;
  const now = new Date();

  const store = new FeatureIdeasStore({ file, logger: log });
  const fileState = await store.load();
  const gate = shouldRunResearch({ lastResearchAt: fileState.meta.last_research_at, now, minIntervalHours });
  if (!gate.shouldRun && !force) {
    log.info('feature-researcher.rate-limited', {
      hours_since_last_run: gate.hoursSinceLastRun,
      min_interval_hours: minIntervalHours,
    });
    const result = {
      ran: false,
      added: 0,
      skipped: 0,
      available: 0,
      spent: fileState.ideas.length,
      hoursSinceLastRun: gate.hoursSinceLastRun,
      ideas: [],
    };
    const writeHist = shouldWriteResearchCronHistory({ dryRun, noHistory, withHistory });
    let historyWritten = false;
    let historyError = null;
    if (writeHist) {
      const event = buildResearchCronRunEvent({
        now, result, dryRun, rateLimited: true, forced: force, file, source: 'feature-researcher',
      });
      const r = await appendResearchCronRunEvent({ historyFile, event, fs: opts.fs });
      historyWritten = r.ok;
      historyError = r.ok ? null : r.error;
      if (!r.ok) {
        log.error('feature-researcher.history.append-failed', { err: r.error, historyFile });
      } else {
        log.info('feature-researcher.history.appended', { historyFile, kind: 'research_cron_run' });
      }
    }
    return {
      ...result,
      historyWritten,
      historyError,
    };
  }

  const pick = pickIdeas({
    catalog: RESEARCH_CATALOG,
    existingIdeas: fileState.ideas,
    maxPerRun,
    now,
  });

  let storeAdded = 0;
  let storeSkipped = 0;
  let ideasAdded = [];
  let finalAvailable = pick.available;
  let finalSpent = pick.spent;

  if (dryRun) {
    log.info('feature-researcher.dry-run', {
      available: pick.available,
      would_append: pick.toAppend.length,
      skipped: pick.skipped,
      spent: pick.spent,
      file,
    });
    ideasAdded = pick.toAppend.map((i) => ({ id: i.id, title: i.title }));
  } else {
    const appendResult = await store.addIdeas(pick.toAppend, { source: 'research-cron' });
    await store.stampLastResearch(now);
    storeAdded = appendResult.added;
    storeSkipped = appendResult.skipped;
    // After the write, recompute spent from the post-write file so the
    // event surfaces truth, not the pre-write estimate.
    const postFile = appendResult.file;
    finalSpent = postFile.ideas.length;
    finalAvailable = Math.max(0, RESEARCH_CATALOG.length - finalSpent);
    ideasAdded = postFile.ideas.slice(-storeAdded).map((i) => ({ id: i.id, title: i.title }));

    log.info('feature-researcher.complete', {
      added: storeAdded,
      skipped: storeSkipped,
      available: finalAvailable,
      spent: finalSpent,
      file,
    });
  }

  const result = {
    ran: true,
    added: storeAdded,
    skipped: storeSkipped,
    available: finalAvailable,
    spent: finalSpent,
    hoursSinceLastRun: gate.hoursSinceLastRun,
    ideas: ideasAdded,
  };

  // Write the structured history event (unless suppressed by --dry-run
  // or --no-history; --history overrides --dry-run for the audit trail).
  const writeHist = shouldWriteResearchCronHistory({ dryRun, noHistory, withHistory });
  let historyWritten = false;
  let historyError = null;
  if (writeHist) {
    const event = buildResearchCronRunEvent({
      now, result, dryRun, rateLimited: false, forced: force, file, source: 'feature-researcher',
    });
    const r = await appendResearchCronRunEvent({ historyFile, event, fs: opts.fs });
    historyWritten = r.ok;
    historyError = r.ok ? null : r.error;
    if (!r.ok) {
      log.error('feature-researcher.history.append-failed', { err: r.error, historyFile });
    } else {
      log.info('feature-researcher.history.appended', { historyFile, kind: 'research_cron_run' });
    }
  }

  return {
    ...result,
    historyWritten,
    historyError,
  };
}

const isDirect = import.meta.url === `file://${process.argv[1]}` ||
                 process.argv[1]?.endsWith('feature_researcher.mjs');
if (isDirect) {
  const args = parseResearcherArgs(process.argv);
  mainFeatureResearcher(args).then(
    (result) => {
      // Operator-facing summary on stdout (Telegram-friendly
      // single-line text when --dry-run is set).
      const summary = {
        ran: result.ran,
        added: result.added,
        available: result.available,
        spent: result.spent,
        hours_since_last_run: result.hoursSinceLastRun,
        ideas: result.ideas,
        history_written: result.historyWritten,
        history_error: result.historyError,
      };
      process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
      // Exit 3 when the gate prevented the run; exit 0 on success
      // OR on dry-run (which is itself a successful no-op).
      if (!result.ran) process.exit(3);
      process.exit(0);
    },
    (err) => {
      process.stderr.write(`feature_researcher: fatal: ${err?.stack ?? err}\n`);
      process.exit(1);
    },
  );
}

export { mainFeatureResearcher as main };
