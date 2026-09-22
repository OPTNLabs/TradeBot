#!/usr/bin/env node
// scripts/file-bug.mjs
//
// T49b: Operator-facing CLI for the bugs subsystem. Files a bug
// directly into `data/bugs.json` without going through the
// dashboard, so the operator can triage from SSH. Mirrors the
// `scripts/manual-test-trade.mjs` / `scripts/reconcile-position.mjs`
// shape (`parseArgs → resolveArgs → main → isDirect guard → exported
// parser + main for the test suite).
//
// The script is a thin wrapper around the existing
// `BugsStore.addOperatorBug()` API — same validation, same
// priority rules, same slug-id generation — so a bug filed via
// the CLI is byte-for-byte the same envelope a bug filed via the
// dashboard's Bugs view would produce. The supervisor-bridge's
// `pickNextBug()` will surface CLI-filed bugs alongside
// dashboard-filed bugs the next time it ticks.
//
// Usage:
//   node scripts/file-bug.mjs \
//        --title "Cumulative P&L shows wrong total" \
//        --description "The cumulative total on the dashboard..." \
//        --category data            # one of: ui|data|logic|performance|config|wallet|other (default: other)
//        --severity high            # one of: low|medium|high|critical (default: medium)
//        --author "operator"        # optional author tag for the initial note
//        --bugs-file data/bugs.json # optional override (default: data/bugs.json)
//        --dry-run                  # print, don't write
//
// Exit codes:
//   0 = bug filed (or --dry-run preview printed)
//   1 = bug filing failed (validation, IO, schema rejection)
//   2 = bad usage (missing required flags, unknown enum value, …)
//
// SAFETY:
//   - Read-only against the chain. The script never broadcasts.
//   - Writes go through the same `atomicWriteJson` path the
//     dashboard uses, so a crash mid-write can't corrupt
//     `data/bugs.json`.
//   - Idempotent on `--title` only when the operator deletes the
//     bug between runs (the slug id is a function of title + ts).
//   - All input strings are trimmed before they hit the schema,
//     so trailing whitespace from a copy-pasted commit message
//     doesn't sneak through.

import process from 'node:process';

import { createLogger } from '../src/util/logger.mjs';
import { BugsStore } from '../src/bugs/store.mjs';
import {
  BUGS_CATEGORIES,
  BUGS_SEVERITIES,
} from '../src/bugs/schema.mjs';

// ── arg parsing ──────────────────────────────────────────────────────────

// T49b: exported so tests/scripts.test.mjs can cover the parser in
// isolation (no `data/bugs.json` writes, no schema validation).
// Mirrors the parser shape used by parseReconcilePositionArgs /
// parseManualTestArgs / parseSyncWalletHoldingsArgs so the operator's
// mental model stays uniform across scripts.
//
// Two flag forms supported:
//   --title "X"        → flags.title = 'X'
//   --title=X          → flags.title = 'X'  (key=value form)
//   --dry-run          → flags['dry-run'] = true
export function parseFileBugArgs(argv) {
  const flags = {};
  const positional = [];
  // `argv.slice(2)` matches every other script parser in the repo:
  // skip the implicit `node` + script-path entries so callers can
  // pass either a full `process.argv` (script body) or a synthetic
  // argv like `['node', 'file-bug.mjs', '--title', 'X']` (tests).
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue;
    if (typeof a !== 'string') continue;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      // Space-separated value: consume the next argv if it doesn't
      // look like another flag. Keeps `--title "X"` working
      // without forcing the operator to type `--title=X`.
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

// ── arg validation ───────────────────────────────────────────────────────

/**
 * Resolve + validate the parsed flags into a typed `FileBugArgs`
 * object. Pure — no I/O. Throws on missing/invalid inputs so the
 * script body can short-circuit cleanly.
 *
 * Defaults:
 *   - category: 'other' (matches schema default)
 *   - severity: 'medium' (matches DEFAULT_BUG_SEVERITY)
 *   - bugsFile: 'data/bugs.json' (matches paths.bugs_file default)
 *   - author:   null (no initial note)
 *   - dryRun:   false
 *
 * @param {Record<string, unknown>} flags
 * @param {{ bugsFile?: string }} [opts]
 * @returns {{
 *   title: string,
 *   description: string,
 *   category: string,
 *   severity: string,
 *   author: string|null,
 *   bugsFile: string,
 *   dryRun: boolean,
 * }}
 */
export function resolveFileBugArgs(flags, opts = {}) {
  const titleRaw = (typeof flags.title === 'string') ? flags.title.trim() : '';
  if (titleRaw.length === 0) {
    throw new Error('--title is required (e.g. --title "Cumulative P&L shows wrong total")');
  }
  // 280 chars is the same line budget the dashboard's React form
  // caps at; anything longer is almost always a copy-paste of a
  // multi-line commit message that the operator forgot to shorten.
  if (titleRaw.length > 280) {
    throw new Error(`--title is ${titleRaw.length} chars; max 280 (one-line summary)`);
  }

  const descRaw = (typeof flags.description === 'string') ? flags.description.trim() : '';
  if (descRaw.length === 0) {
    throw new Error('--description is required (one paragraph: what\'s wrong + repro + expected)');
  }

  const categoryRaw = (typeof flags.category === 'string') ? flags.category.trim() : '';
  let category = 'other';
  if (categoryRaw.length > 0) {
    if (!BUGS_CATEGORIES.includes(categoryRaw)) {
      throw new Error(
        `--category must be one of ${BUGS_CATEGORIES.join('|')}; got "${categoryRaw}"`,
      );
    }
    category = categoryRaw;
  }

  const severityRaw = (typeof flags.severity === 'string') ? flags.severity.trim() : '';
  let severity = 'medium';
  if (severityRaw.length > 0) {
    if (!BUGS_SEVERITIES.includes(severityRaw)) {
      throw new Error(
        `--severity must be one of ${BUGS_SEVERITIES.join('|')}; got "${severityRaw}"`,
      );
    }
    severity = severityRaw;
  }

  const author = (typeof flags.author === 'string' && flags.author.trim().length > 0)
    ? flags.author.trim()
    : null;

  // --bugs-file: optional override; if absent, fall back to the
  // opts-passed value (which the script body fills from
  // cfg.paths.bugs_file when no explicit override was given), then
  // to the hard-coded default. Same precedence the dashboard's
  // /api/bugs routes follow.
  const flagBugsFile = (typeof flags['bugs-file'] === 'string')
    ? flags['bugs-file'].trim()
    : '';
  const bugsFile = flagBugsFile.length > 0
    ? flagBugsFile
    : (typeof opts.bugsFile === 'string' && opts.bugsFile.length > 0)
      ? opts.bugsFile
      : 'data/bugs.json';

  return {
    title: titleRaw,
    description: descRaw,
    category,
    severity,
    author,
    bugsFile,
    dryRun: flags['dry-run'] === true,
  };
}

// ── main entry ───────────────────────────────────────────────────────────

/**
 * Pure-ish orchestrator: load the store, call addOperatorBug, log
 * the outcome. Exported for tests so the test suite can inject a
 * real BugsStore pointed at a temp file and assert the envelope
 * shape without booting the whole script body.
 *
 * @param {{
 *   args: ReturnType<typeof resolveFileBugArgs>,
 *   bugsStore?: BugsStore,
 *   logger?: Object,
 *   fs?: typeof import('node:fs/promises'),
 * }} input
 * @returns {Promise<{
 *   ok: boolean,
 *   bug?: Object,
 *   preview?: Object,
 *   error?: string,
 *   code?: string,
 * }>}
 */
export async function fileBugMain(input) {
  const args = input.args;
  const log = input.logger ?? null;

  // --dry-run short-circuit: render the envelope that *would* be
  // written so the operator can sanity-check the inputs before
  // touching disk. We DON'T compute the slug id (it depends on
  // `new Date()`), so the preview uses a placeholder id and a
  // hand-picked priority; the real addOperatorBug call computes
  // both correctly when the operator drops --dry-run.
  if (args.dryRun) {
    const preview = {
      ok: true,
      preview: {
        title: args.title,
        description: args.description,
        category: args.category,
        severity: args.severity,
        status: 'open',
        author: args.author,
        bugs_file: args.bugsFile,
        note: 'dry-run: no file written; slug id + priority computed by addOperatorBug() at real run',
      },
    };
    if (log) log.info('file-bug.dry-run', preview.preview);
    return preview;
  }

  if (!input.bugsStore) {
    // Defensive: every well-formed call passes a BugsStore
    // (either the script body's real one or the test suite's
    // temp-file fixture). Refuse to fall back to a default
    // because a silent "the file wasn't actually written" would
    // be the worst possible failure mode.
    const e = new Error('fileBugMain: bugsStore required for real (non --dry-run) runs');
    e.code = 'FILE_BUG_NO_STORE';
    throw e;
  }

  try {
    const bug = await input.bugsStore.addOperatorBug({
      title: args.title,
      description: args.description,
      category: args.category,
      severity: args.severity,
      author: args.author ?? undefined,
    });
    if (log) log.info('file-bug.created', { bug_id: bug.id, priority: bug.priority });
    return { ok: true, bug };
  } catch (e) {
    const code = (e && typeof e === 'object' && /** @type {any} */ (e).code) || 'FILE_BUG_UNKNOWN';
    if (log) log.error('file-bug.failed', { code, message: e && e.message ? String(e.message) : String(e) });
    return { ok: false, error: e && e.message ? String(e.message) : String(e), code };
  }
}

// ── direct-invocation body ───────────────────────────────────────────────

// T49b: only run when invoked directly — when imported by
// tests/scripts.test.mjs the body is skipped so the test suite
// can pull `parseFileBugArgs` / `resolveFileBugArgs` / `fileBugMain`
// without the script trying to write data/bugs.json.
const isDirect = import.meta.url === `file://${process.argv[1]}` ||
                 process.argv[1]?.endsWith('file-bug.mjs');

// Shape-parity `main` for tests; ESM requires `export` at top
// level, so we always declare it and the body short-circuits
// when the script is imported (not directly invoked).
async function fileBugScriptMain() { return { ok: false, error: 'not_direct_invocation' }; }
export { fileBugScriptMain as main };

if (isDirect) {
  const log = createLogger({ sink: process.stderr, component: 'file-bug' });

  // --help short-circuit, mirrors the other operator scripts so the
  // operator can `node scripts/file-bug.mjs --help` and copy/paste
  // a usable template.
  const argv2 = process.argv.slice(2);
  if (argv2.includes('--help') || argv2.includes('-h') || argv2.includes('-?')) {
    process.stdout.write(
      [
        'Usage: node scripts/file-bug.mjs \\',
        '     --title "<one-line summary>" \\',
        "     --description \"<what's wrong + repro + expected>\" \\",
        '     [--category <ui|data|logic|performance|config|wallet|other>] \\',
        '     [--severity <low|medium|high|critical>] \\',
        '     [--author "<operator tag>"] \\',
        '     [--bugs-file <path>] \\',
        '     [--dry-run]',
        '',
        'Defaults:',
        '  --category   other   (one of: ' + BUGS_CATEGORIES.join('|') + ')',
        '  --severity   medium  (one of: ' + BUGS_SEVERITIES.join('|') + ')',
        '  --bugs-file  data/bugs.json',
        '',
        'Examples:',
        '  node scripts/file-bug.mjs --title "Cumulative P&L shows wrong total" \\',
        '       --description "Expected -0.00036502 BCH; dashboard shows -0.00036134 BCH. Diff comes from..." \\',
        '       --category data --severity high --author operator',
        '  node scripts/file-bug.mjs --title "Test bug" --description "test" --dry-run',
        '',
      ].join('\n'),
    );
    process.exit(0);
  }

  const { flags } = parseFileBugArgs(process.argv);

  let args;
  try {
    args = resolveFileBugArgs(flags);
  } catch (e) {
    process.stderr.write(`file-bug: ${e && e.message ? e.message : String(e)}\n`);
    process.stderr.write('Try --help for usage.\n');
    process.exit(2);
  }

  log.info('file-bug.boot', {
    title: args.title,
    category: args.category,
    severity: args.severity,
    bugs_file: args.bugsFile,
    dry_run: args.dryRun,
  });

  // Real (non --dry-run) runs need a BugsStore. Default to the
  // operator-canonical data/bugs.json; --bugs-file overrides it.
  let bugsStore;
  if (!args.dryRun) {
    bugsStore = new BugsStore({ file: args.bugsFile, logger: log.child('bugs') });
  }

  const result = await fileBugMain({
    args,
    bugsStore,
    logger: log,
  });

  if (!result.ok) {
    process.stderr.write(`file-bug: failed (${result.code ?? 'unknown'}): ${result.error ?? 'unknown error'}\n`);
    process.exit(1);
  }

  // Pretty-print the outcome. For real runs we surface the slug id
  // + priority so the operator can verify the new bug shows up at
  // the top of the bugs list in the dashboard; for dry-runs we
  // surface the preview envelope.
  if (args.dryRun) {
    process.stdout.write(JSON.stringify(result.preview, null, 2) + '\n');
  } else if (result.bug) {
    process.stdout.write(JSON.stringify(result.bug, null, 2) + '\n');
  }

  process.exit(0);
}
