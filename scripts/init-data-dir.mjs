#!/usr/bin/env node
/**
 * scripts/init-data-dir.mjs
 *
 * One-shot bootstrap for the trading bot's runtime state directory.
 *
 * The bot writes three files under `data/` while running:
 *
 *   - `data/positions.json`       (live portfolio state; JSON envelope)
 *   - `data/snapshots/<date>.jsonl`  (balance + position snapshots; NDJSON)
 *   - `data/history.jsonl`        (append-only trader tick log; NDJSON)
 *
 * The bot auto-creates all three on first read, so a fresh checkout
 * works without any operator setup. This script exists for the cases
 * where an operator WANTS to pre-create the files explicitly — CI
 * smoke tests, first-boot confidence, or a fresh deployment that's
 * about to point the dashboard at `data/positions.json` before the
 * bot has had a chance to run.
 *
 * Idempotent by default: if the runtime files already exist, the
 * script leaves them alone (so running it twice is safe). Pass
 * `--force` to overwrite `data/positions.json` with the empty
 * envelope (DESTRUCTIVE — only do this for a clean slate). NDJSON
 * files are NEVER touched — `history.jsonl` is append-only by
 * contract; `snapshots/<date>.jsonl` is also append-only.
 *
 * The script does NOT touch the data supervisor's files
 * (`history.ndjson`, `top-tokens.json`, `snapshots/<date>/pools.json`,
 * `snapshots/<date>/token-stats/<id>.json`) — those are owned by a
 * separate cron. See `docs/DATA_LAYOUT.md` for the side-by-side map.
 *
 * Usage:
 *   node scripts/init-data-dir.mjs                       # idempotent — skip existing
 *   node scripts/init-data-dir.mjs --force               # overwrite positions.json (DESTRUCTIVE)
 *   node scripts/init-data-dir.mjs --quiet               # suppress stdout summary
 *   node scripts/init-data-dir.mjs --positions-file=<p>  # override positions.json path
 *   node scripts/init-data-dir.mjs --snapshots-dir=<d>   # override snapshots dir path
 *   node scripts/init-data-dir.mjs --history-file=<f>    # override history file path
 *   node scripts/init-data-dir.mjs --config-default=<p>  # read cfg.paths from default.json
 *   node scripts/init-data-dir.mjs --config-user=<p>     # read cfg.paths from user.json
 *   node scripts/init-data-dir.mjs --help                # print help + exit 0
 *
 * Exit codes:
 *   0  success (files created, skipped, or already-exists; no work is an OK outcome)
 *   1  I/O error (mkdir / writeFile failed)
 *   2  bad CLI args
 *   3  positions.json exists but is unparseable (refusing to overwrite corrupt data)
 *
 * Origin: original code for TradeBot (T20). Mirrors
 * `docs/RUNTIME_STATE.md` (The contract / Empty-state contract /
 * Bootstrap sections).
 */

import process from 'node:process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { createLogger } from '../src/util/logger.mjs';
import { loadConfig } from '../src/util/config-loader.mjs';
import { atomicWriteJson } from '../src/util/atomic-write.mjs';
import { pathExists } from '../src/util/fs-helpers.mjs';
import { DEFAULT_POSITIONS_FILE, POSITIONS_VERSION } from '../src/portfolio/positions.mjs';
import { DEFAULT_SNAPSHOTS_DIR } from '../src/portfolio/snapshots.mjs';
import { DEFAULT_HISTORY_FILE } from '../src/trader/loop.mjs';

// ─── Logger ────────────────────────────────────────────────────────────────

const log = createLogger({ component: 'init-data-dir', sink: process.stderr });

// ─── CLI ────────────────────────────────────────────────────────────────────

const HELP = `
TradeBot data-dir bootstrap — pre-create the runtime state files
that the trading bot auto-creates on first read. Idempotent by
default; pass --force to overwrite positions.json.

Usage:
  node scripts/init-data-dir.mjs                       # skip existing, create missing
  node scripts/init-data-dir.mjs --force               # overwrite positions.json (DESTRUCTIVE)
  node scripts/init-data-dir.mjs --quiet               # suppress stdout summary
  node scripts/init-data-dir.mjs --positions-file=<p>  # override positions.json path
  node scripts/init-data-dir.mjs --snapshots-dir=<d>   # override snapshots dir path
  node scripts/init-data-dir.mjs --history-file=<f>    # override history file path
  node scripts/init-data-dir.mjs --config-default=<p>  # read cfg.paths from default.json
  node scripts/init-data-dir.mjs --config-user=<p>     # read cfg.paths from user.json
  node scripts/init-data-dir.mjs --help                # this help

Created files (when missing):
  data/positions.json       empty envelope (version=1, open=[], closed=[])
  data/snapshots/           directory (the .jsonl files inside are lazy-created)

NOT touched:
  data/history.jsonl        append-only — created on first tick by the loop
  data/snapshots/<date>.jsonl  append-only — created on first record()
  data/*.ndjson / top-tokens.json  owned by the data supervisor cron
`.trim();

/**
 * Minimal arg parser — handles --flag, --key=value, -h, -?.
 *
 * @param {string[]} argv
 * @returns {{ flags: Record<string, string|true>, positional: string[] }}
 */
export function parseInitDataDirArgs(argv) {
  const flags = {};
  const positional = [];
  for (const arg of argv.slice(2)) {
    if (arg === '--') continue;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        flags[arg.slice(2)] = true;
      }
      continue;
    }
    // Short flags — -h / -? map to flags.h / flags['?']
    if (arg.startsWith('-') && arg.length === 2) {
      flags[arg.slice(1)] = true;
      continue;
    }
    positional.push(arg);
  }
  return { flags, positional };
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

/**
 * Return an ISO timestamp suitable for the empty `positions.json`
 * envelope's `updated_at` / `meta.created_at` fields. Pulled out so
 * tests can pin the clock without monkey-patching Date globally.
 *
 * @param {Date|number|string} [now]
 * @returns {string}
 */
export function nowIso(now) {
  const d = now === undefined ? new Date() : new Date(now);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`nowIso: invalid date input ${String(now)}`);
  }
  return d.toISOString();
}

/**
 * Build the empty `positions.json` envelope. Mirrors
 * `Positions.load()`'s lazy-create shape (see
 * `src/portfolio/positions.mjs:load`). Bumping `POSITIONS_VERSION`
 * automatically propagates here — we read it from the positions
 * module rather than hard-coding `1` so the two never drift.
 *
 * @param {{ now?: Date|number|string }} [opts]
 * @returns {{
 *   version: number,
 *   updated_at: string,
 *   open: Array<unknown>,
 *   closed: Array<unknown>,
 *   meta: { total_opened: number, total_closed: number, created_at: string }
 * }}
 */
export function buildEmptyPositionsFile(opts = {}) {
  const ts = nowIso(opts.now);
  return {
    version: POSITIONS_VERSION,
    updated_at: ts,
    open: [],
    closed: [],
    meta: {
      total_opened: 0,
      total_closed: 0,
      created_at: ts,
    },
  };
}

/**
 * Resolve the three runtime paths, honoring CLI overrides first,
 * then `cfg.paths.*`, then the module-level defaults. CLI overrides
 * always win — operator intent is sacred.
 *
 * @param {{
 *   flags?: Record<string, string|true>,
 *   cfg?: { paths?: { positions_file?: string, snapshots_dir?: string, history_file?: string } } | null,
 *   fallback?: {
 *     positions_file?: string,
 *     snapshots_dir?: string,
 *     history_file?: string,
 *   },
 * }} opts
 * @returns {{ positionsFile: string, snapshotsDir: string, historyFile: string, sources: Record<string, string> }}
 */
export function resolveInitDataDirPaths(opts = {}) {
  const f = opts.flags ?? {};
  const cfg = opts.cfg ?? null;
  const cfgPaths = cfg && typeof cfg.paths === 'object' && cfg.paths !== null ? cfg.paths : null;
  const fb = opts.fallback ?? {};

  /** @param {string} key @param {string} cliKey @param {string} cfgKey @param {string} defKey @param {string} defaultValue */
  const pick = (cliKey, cfgKey, defKey, defaultValue) => {
    // 1) CLI override
    const cliVal = typeof f[cliKey] === 'string' ? f[cliKey] : undefined;
    if (cliVal !== undefined) {
      return { value: cliVal, source: `cli:${cliKey}` };
    }
    // 2) cfg.paths override
    const cfgVal = cfgPaths && typeof cfgPaths[cfgKey] === 'string' ? cfgPaths[cfgKey] : undefined;
    if (cfgVal !== undefined) {
      return { value: cfgVal, source: `cfg.paths.${cfgKey}` };
    }
    // 3) explicit fallback (tests inject this)
    const fbVal = typeof fb[defKey] === 'string' ? fb[defKey] : undefined;
    if (fbVal !== undefined) {
      return { value: fbVal, source: `fallback.${defKey}` };
    }
    // 4) module default
    return { value: defaultValue, source: `default:${defKey}` };
  };

  const positionsFile = pick('positions-file', 'positions_file', 'positions_file', DEFAULT_POSITIONS_FILE);
  const snapshotsDir = pick('snapshots-dir', 'snapshots_dir', 'snapshots_dir', DEFAULT_SNAPSHOTS_DIR);
  const historyFile = pick('history-file', 'history_file', 'history_file', DEFAULT_HISTORY_FILE);

  return {
    positionsFile: positionsFile.value,
    snapshotsDir: snapshotsDir.value,
    historyFile: historyFile.value,
    sources: {
      positions_file: positionsFile.source,
      snapshots_dir: snapshotsDir.source,
      history_file: historyFile.source,
    },
  };
}

/**
 * @typedef {Object} InitDataDirPlanEntry
 * @property {'positions_file'|'snapshots_dir'|'history_file'} target
 * @property {'create'|'skip'|'overwrite'} action
 * @property {string} reason
 * @property {string} path
 */

/**
 * Compute a side-effect plan without touching the filesystem. The
 * `exists` map is injected so tests can simulate any on-disk state
 * (missing / present / corrupt).
 *
 * @param {{
 *   paths: { positionsFile: string, snapshotsDir: string, historyFile: string },
 *   exists: { positionsFile: boolean, snapshotsDir: boolean, historyFile: boolean },
 *   force: boolean,
 * }} opts
 * @returns {{ actions: InitDataDirPlanEntry[], summary: { created: number, skipped: number, overwritten: number } }}
 */
export function planInitDataDir({ paths, exists, force = false }) {
  /** @type {InitDataDirPlanEntry[]} */
  const actions = [];

  // 1) positions.json — the only file we ever overwrite (and only with --force).
  if (exists.positionsFile) {
    if (force) {
      actions.push({
        target: 'positions_file',
        action: 'overwrite',
        reason: 'exists but --force was passed (DESTRUCTIVE: previous portfolio state is lost)',
        path: paths.positionsFile,
      });
    } else {
      actions.push({
        target: 'positions_file',
        action: 'skip',
        reason: 'already exists (pass --force to overwrite)',
        path: paths.positionsFile,
      });
    }
  } else {
    actions.push({
      target: 'positions_file',
      action: 'create',
      reason: 'file does not exist',
      path: paths.positionsFile,
    });
  }

  // 2) snapshots/ directory — idempotent mkdir -p.
  if (exists.snapshotsDir) {
    actions.push({
      target: 'snapshots_dir',
      action: 'skip',
      reason: 'already exists',
      path: paths.snapshotsDir,
    });
  } else {
    actions.push({
      target: 'snapshots_dir',
      action: 'create',
      reason: 'directory does not exist',
      path: paths.snapshotsDir,
    });
  }

  // 3) history.jsonl — append-only; NEVER created by the bootstrap.
  actions.push({
    target: 'history_file',
    action: 'skip',
    reason: 'append-only NDJSON; lazy-created by the trading loop on first tick',
    path: paths.historyFile,
  });

  const summary = {
    created: actions.filter((a) => a.action === 'create').length,
    skipped: actions.filter((a) => a.action === 'skip').length,
    overwritten: actions.filter((a) => a.action === 'overwrite').length,
  };
  return { actions, summary };
}

/**
 * Execute a plan produced by `planInitDataDir`. `fs` is injectable
 * for tests; defaults to `node:fs/promises`.
 *
 * @param {{
 *   plan: { actions: InitDataDirPlanEntry[] },
 *   paths: { positionsFile: string, snapshotsDir: string, historyFile: string },
 *   fs?: typeof import('node:fs/promises'),
 *   now?: Date|number|string,
 * }} opts
 * @returns {Promise<{ applied: InitDataDirPlanEntry[], envelope?: object }>}
 */
export async function applyInitDataDirPlan({ plan, paths, fs = fsp, now }) {
  /** @type {InitDataDirPlanEntry[]} */
  const applied = [];
  /** @type {object|undefined} */
  let envelope;

  for (const entry of plan.actions) {
    if (entry.action === 'skip') {
      applied.push(entry);
      continue;
    }
    if (entry.target === 'positions_file') {
      const value = buildEmptyPositionsFile({ now });
      await atomicWriteJson(entry.path, value, fs);
      envelope = value;
      applied.push(entry);
      continue;
    }
    if (entry.target === 'snapshots_dir') {
      // mkdir -p the snapshots directory itself; no files written inside.
      await fs.mkdir(entry.path, { recursive: true });
      applied.push(entry);
      continue;
    }
    // Defensive — should be unreachable because the planner only
    // emits skip / create / overwrite for the two targets we act on.
    throw new Error(`applyInitDataDirPlan: unhandled action ${entry.action} for ${entry.target}`);
  }

  // Silence the unused `paths` param warning when callers pass it for
  // symmetry with the plan function. Cheap and keeps the call shape
  // uniform.
  void paths;
  return { applied, envelope };
}

/**
 * Top-level orchestrator. Reads CLI args, optionally loads config,
 * resolves paths, builds the plan, applies it, and emits a structured
 * result.
 *
 * @param {{
 *   argv?: string[],
 *   fs?: typeof import('node:fs/promises'),
 *   loadConfigFn?: typeof loadConfig,
 *   now?: Date|number|string,
 *   stdout?: { write: (s: string) => void },
 * }} opts
 * @returns {Promise<{
 *   ok: boolean,
 *   mode: string,
 *   written: boolean,
 *   plan?: { actions: InitDataDirPlanEntry[], summary: { created: number, skipped: number, overwritten: number } },
 *   paths?: { positionsFile: string, snapshotsDir: string, historyFile: string, sources: Record<string, string> },
 *   envelope?: object,
 *   error?: string,
 * }>}
 */
export async function runInitDataDir(opts = {}) {
  const argv = opts.argv ?? process.argv;
  const fs = opts.fs ?? fsp;
  const loadConfigFn = opts.loadConfigFn ?? loadConfig;
  const stdout = opts.stdout ?? process.stdout;

  const parsed = parseInitDataDirArgs(argv);

  if (parsed.flags.help === true || parsed.flags['?'] === true || parsed.flags.h === true) {
    return { ok: true, mode: 'help', written: false };
  }

  const force = parsed.flags.force === true;
  const quiet = parsed.flags.quiet === true;

  /** @type {object|null} */
  let cfg = null;
  try {
    const cfgDefaultPath = typeof parsed.flags['config-default'] === 'string'
      ? parsed.flags['config-default']
      : undefined;
    const cfgUserPath = typeof parsed.flags['config-user'] === 'string'
      ? parsed.flags['config-user']
      : undefined;
    if (cfgDefaultPath !== undefined || cfgUserPath !== undefined) {
      cfg = await loadConfigFn({ defaultPath: cfgDefaultPath, userPath: cfgUserPath });
    }
  } catch (e) {
    log.error('init-data-dir.config-load-failed', {
      err_name: e?.name ?? 'Error',
      err_message: e?.message ?? String(e),
    });
    return { ok: false, mode: 'config', written: false, error: `config: ${e?.message ?? e}` };
  }

  const resolved = resolveInitDataDirPaths({ flags: parsed.flags, cfg });

  // Detect what exists. We read positions.json as text first; if it
  // exists but is unparseable JSON we refuse to overwrite (corrupt
  // data is a stronger signal than "missing").
  /** @type {boolean} */
  let positionsFileExists = false;
  /** @type {boolean} */
  let positionsFileUnparseable = false;
  try {
    positionsFileExists = await pathExists(resolved.positionsFile, fs);
  } catch (e) {
    log.error('init-data-dir.exists-check-failed', {
      path: resolved.positionsFile,
      err_name: e?.name ?? 'Error',
      err_message: e?.message ?? String(e),
    });
    return { ok: false, mode: 'exists-check', written: false, error: `exists-check: ${e?.message ?? e}` };
  }
  if (positionsFileExists) {
    try {
      const raw = await fs.readFile(resolved.positionsFile, 'utf8');
      if (raw.trim().length > 0) {
        const parsedJson = JSON.parse(raw);
        if (parsedJson === null || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
          positionsFileUnparseable = true;
        }
      }
    } catch {
      positionsFileUnparseable = true;
    }
  }

  if (positionsFileUnparseable && !force) {
    const msg = `init-data-dir: ${resolved.positionsFile} exists but is not a valid JSON object. `
      + `Refusing to overwrite (use --force to overwrite anyway — DESTRUCTIVE).`;
    log.error('init-data-dir.positions-unparseable', { path: resolved.positionsFile });
    process.stderr.write(msg + '\n');
    return { ok: false, mode: 'unparseable', written: false, error: msg };
  }

  const snapshotsDirExists = await pathExists(resolved.snapshotsDir, fs);

  const plan = planInitDataDir({
    paths: {
      positionsFile: resolved.positionsFile,
      snapshotsDir: resolved.snapshotsDir,
      historyFile: resolved.historyFile,
    },
    exists: {
      positionsFile: positionsFileExists,
      snapshotsDir: snapshotsDirExists,
      historyFile: false, // history.jsonl is append-only; never detected as "exists needs action"
    },
    force,
  });

  /** @type {{ applied: InitDataDirPlanEntry[], envelope?: object }} */
  let applyResult;
  try {
    applyResult = await applyInitDataDirPlan({
      plan,
      paths: {
        positionsFile: resolved.positionsFile,
        snapshotsDir: resolved.snapshotsDir,
        historyFile: resolved.historyFile,
      },
      fs,
      now: opts.now,
    });
  } catch (e) {
    log.error('init-data-dir.apply-failed', {
      err_name: e?.name ?? 'Error',
      err_message: e?.message ?? String(e),
    });
    return { ok: false, mode: 'apply', written: false, plan, error: `apply: ${e?.message ?? e}` };
  }

  // Optional human-readable summary on stdout (skip when --quiet).
  if (!quiet) {
    const lines = ['TradeBot data-dir bootstrap:', ''];
    for (const entry of applyResult.applied) {
      const tag =
        entry.action === 'create' ? '[CREATE]   '
        : entry.action === 'overwrite' ? '[OVERWRITE]'
        : '[SKIP]     ';
      lines.push(`  ${tag} ${entry.target.padEnd(16)} ${entry.path}`);
      lines.push(`             ${entry.reason}`);
    }
    lines.push('');
    lines.push(`Summary: ${plan.summary.created} created, ${plan.summary.skipped} skipped, ${plan.summary.overwritten} overwritten.`);
    stdout.write(lines.join('\n') + '\n');
  }

  return {
    ok: true,
    mode: 'apply',
    written: plan.summary.created + plan.summary.overwritten > 0,
    plan,
    paths: resolved,
    envelope: applyResult.envelope,
  };
}

/**
 * @param {string[]} argv
 * @returns {Promise<{ ok: boolean, mode: string, written: boolean, plan?: object, paths?: object, envelope?: object, error?: string }>}
 */
export async function main(argv = process.argv) {
  const result = await runInitDataDir({ argv });
  if (!result.ok) {
    process.stderr.write(`init-data-dir: ${result.error ?? 'unknown error'}\n`);
  }
  return result;
}

// Direct invocation
const isDirect = import.meta.url === `file://${process.argv[1]}` ||
                 process.argv[1]?.endsWith('init-data-dir.mjs');
if (isDirect) {
  main(process.argv).then((r) => process.exit(r.ok ? 0 : (r.mode === 'unparseable' ? 3 : 1)));
}

// ─── Internal exports for tests ────────────────────────────────────────────
//
// `path` is used by the helpers but not exported; this is the cleanest
// place to keep the reference (vs `import 'node:path'` then never use it
// in the module body).
void path;
