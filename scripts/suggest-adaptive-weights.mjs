#!/usr/bin/env node
// scripts/suggest-adaptive-weights.mjs
//
// T56 subset 1 — Adaptive scoring-weights suggestion CLI.
//
// Why this exists
// ────────────────
// `src/strategy/scoring.mjs` ships static weights. The static
// weights work in the regime they were tuned for, but a regime
// shift (meme rotation → quiet accumulation → meme rotation
// again) can leave the ranker anti-correlated with P&L for days
// at a time. Adaptive weights tune the scorer to recent
// closed-trade performance.
//
// The pure-function engine (`src/strategy/adaptive-weights.mjs`)
// computes a single calibration signal — the Pearson
// correlation between entry_score and realized_pnl_sats across
// the closed cohort — and emits a suggested `scoring.weights`
// map. This CLI is the operator-facing wrapper.
//
// Exit codes (chosen so cron / systemd can route on them):
//   0 — suggestion computed (or no-op below the evidence floor).
//   1 — apply succeeded (only when --apply was supplied).
//   2 — read / config error. Run failed before the engine fired.
//   3 — bad CLI args (unknown flag, missing required knob, ...).
//
// Usage:
//   node scripts/suggest-adaptive-weights.mjs                        # human-friendly, dry-run
//   node scripts/suggest-adaptive-weights.mjs --days 14               # wider window
//   node scripts/suggest-adaptive-weights.mjs --json                  # machine-readable
//   node scripts/suggest-adaptive-weights.mjs --apply                 # write config/user.json
//   node scripts/suggest-adaptive-weights.mjs --help
//
// SAFETY: when run WITHOUT `--apply`, the script reads
// `data/history.jsonl` + `config/default.json` and prints a
// suggestion to stdout. The WIF / mnemonic in `config/user.json`
// are NEVER touched, and `config/user.json` is NEVER rewritten
// without `--apply`. With `--apply`, only `scoring.weights` is
// mutated; every other key in `user.json` is preserved untouched.

import { promises as fsp } from 'node:fs';
import process from 'node:process';

import { loadConfig } from '../src/util/config-loader.mjs';
import {
  loadClosedTrades,
  summarizeClosedTrades,
  computeCalibrationCorrelation,
  suggestAdaptiveWeights,
  formatSuggestionDiff,
  DEFAULT_WINDOW_MS,
  DEFAULT_MIN_CLOSED_TRADES,
  DEFAULT_UNIFORMITY_PULL_MAX,
  DEFAULT_AMPLIFICATION_MAX,
  DEFAULT_CALIBRATION_FLOOR,
} from '../src/strategy/adaptive-weights.mjs';

// ── arg parsing ──────────────────────────────────────────────────────────

/**
 * Parse argv into a `flags` object + `positional` array. Mirrors the
 * `parseXxxArgs` pattern used by the other operator scripts.
 * Supports both `--key=value` and `--key value` forms. Boolean
 * flags (`--apply`, `--dry-run`, `--json`, `--help`) are recorded
 * as `flags[name] = true`.
 *
 * Exported so `tests/scripts.test.mjs` can exercise the parser in
 * isolation (no file / network calls).
 *
 * @param {string[]} argv
 * @returns {{ flags: Record<string, string|boolean>, positional: string[] }}
 */
export function parseSuggestAdaptiveArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a !== 'string') continue;
    if (a === '--') { /* separator — ignore */ continue; }
    if (a.startsWith('--')) {
      const body = a.slice(2);
      const eq = body.indexOf('=');
      let key;
      let val;
      if (eq >= 0) {
        key = body.slice(0, eq);
        val = body.slice(eq + 1);
      } else {
        key = body;
        const next = argv[i + 1];
        // Treat the next token as a value when it's NOT another
        // flag-shaped string. Boolean flags with no value land
        // here as `true`.
        if (typeof next === 'string' && !next.startsWith('--')) {
          val = next;
          i += 1;
        } else {
          val = true;
        }
      }
      if (typeof key === 'string' && key.length > 0) flags[key] = val;
      continue;
    }
    positional.push(a);
  }
  return { flags, positional };
}

/**
 * Convert the parsed flags into a normalized, defaults-filled
 * options object. Rejects unrecognized flags. Pure.
 *
 * @param {Record<string, string|boolean>} flags
 * @returns {{ ok: true, opts: Object } | { ok: false, error: string, field: string }}
 */
export function normalizeSuggestFlags(flags) {
  const out = {
    days: 7,
    windowMs: DEFAULT_WINDOW_MS,
    minClosedTrades: DEFAULT_MIN_CLOSED_TRADES,
    uniformityPullMax: DEFAULT_UNIFORMITY_PULL_MAX,
    amplificationMax: DEFAULT_AMPLIFICATION_MAX,
    calibrationFloor: DEFAULT_CALIBRATION_FLOOR,
    apply: false,
    dryRun: true, // default
    json: false,
    help: false,
    historyFile: 'data/history.jsonl',
    userJsonPath: 'config/user.json',
    defaultJsonPath: 'config/default.json',
  };
  const knownString = new Set(['days', 'history-file', 'user-json', 'default-json']);
  const knownBool = new Set(['apply', 'dry-run', 'json', 'help']);

  for (const k of Object.keys(flags)) {
    if (knownString.has(k)) {
      const v = flags[k];
      // Accept strings (from CLI argv parsing) + numbers (when
      // tests pass typed values directly). Booleans are reserved
      // for the boolean-flag bucket below.
      if (typeof v === 'boolean') return { ok: false, error: `flag --${k} requires a value`, field: k };
      if (k === 'days') {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0 || n > 365) {
          return { ok: false, error: `--days must be a positive number between 1 and 365 (got "${v}")`, field: k };
        }
        out.days = Math.floor(n);
        out.windowMs = Math.floor(n) * 24 * 60 * 60 * 1000;
      } else if (k === 'history-file') {
        out.historyFile = v;
      } else if (k === 'user-json') {
        out.userJsonPath = v;
      } else if (k === 'default-json') {
        out.defaultJsonPath = v;
      }
      continue;
    }
    if (knownBool.has(k)) {
      const v = flags[k];
      out[k === 'apply' ? 'apply' : k === 'dry-run' ? 'dryRun' : k] = (v === true || v === 'true' || v === '1');
      continue;
    }
    return { ok: false, error: `unknown flag --${k}`, field: k };
  }
  // --apply and --dry-run are mutually exclusive — --apply wins.
  if (out.apply && out.dryRun) out.dryRun = false;
  return { ok: true, opts: out };
}

/**
 * Print the canonical `--help` text. Pure.
 *
 * @returns {string}
 */
export function formatSuggestHelp() {
  return [
    'Usage: node scripts/suggest-adaptive-weights.mjs [options]',
    '',
    'Options:',
    '  --days N             Rolling-window length in days (default 7, 1..365).',
    '  --history-file PATH  Path to NDJSON history (default data/history.jsonl).',
    '  --user-json PATH     Path to user config (default config/user.json, used with --apply).',
    '  --default-json PATH  Path to default config (default config/default.json).',
    '  --apply              Write the suggestion into <user-json> under scoring.weights.',
    '                       Default is dry-run (no file mutation).',
    '  --dry-run            Force dry-run mode (this is the default; --apply overrides it).',
    '  --json               Emit machine-readable JSON instead of a human-friendly table.',
    '  --help               Print this help text and exit 0.',
    '',
    'Exit codes: 0=ok (suggested or no-op), 1=apply succeeded, 2=read/config error, 3=bad args.',
    '',
    'See src/strategy/adaptive-weights.mjs for the engine contract.',
  ].join('\n');
}

// ── main ─────────────────────────────────────────────────────────────────

/**
 * Pure main. Loads the parsed args + config + history + runs the
 * suggester + (optionally) writes the user JSON. Tested via
 * `tests/scripts.test.mjs#suggest-adaptive-weights`.
 *
 * @param {Object} deps
 * @param {string[]} deps.argv
 * @param {(path: string) => Promise<string>} [deps.readFile]
 * @param {(path: string, content: string) => Promise<void>} [deps.writeFile]
 * @param {(path: string) => Promise<boolean>} [deps.fileExists]
 * @param {() => number} [deps.nowMs]
 * @returns {Promise<{
 *   exitCode: 0|1|2|3,
 *   output: string,
 *   summary: Object|null,
 * }>}
 */
export async function main(deps = {}) {
  const argv = Array.isArray(deps.argv) ? deps.argv : process.argv;
  const readFile = deps.readFile || (async (p) => fsp.readFile(p, 'utf8'));
  const writeFile = deps.writeFile || (async (p, c) => fsp.writeFile(p, c, 'utf8'));
  const fileExists = deps.fileExists || (async (p) => {
    try { await fsp.access(p); return true; } catch { return false; }
  });
  const nowMs = (typeof deps.nowMs === 'function') ? deps.nowMs : (() => Date.now());

  const parsed = parseSuggestAdaptiveArgs(argv);
  const normResult = normalizeSuggestFlags(parsed.flags);
  if (!normResult.ok) {
    return {
      exitCode: 3,
      output: `error: ${normResult.error}\n\n${formatSuggestHelp()}`,
      summary: null,
    };
  }
  const opts = normResult.opts;
  if (opts.help) {
    return { exitCode: 0, output: formatSuggestHelp(), summary: null };
  }

  // Load default config (required) and user config (optional).
  let defaultCfg;
  try {
    defaultCfg = await loadConfig({
      defaultPath: opts.defaultJsonPath,
      userPath: opts.userJsonPath,
      // The CLI doesn't need the WIF / indexer / data_sources
      // section — only `scoring` matters. We still load the full
      // merged config so the fallback weights reflect user.json
      // overrides.
    });
  } catch (err) {
    const message = (err && typeof err === 'object' && /** @type {any} */(err).message)
      ? /** @type {any} */(err).message : String(err);
    return {
      exitCode: 2,
      output: `error: failed to load default config from ${opts.defaultJsonPath}: ${message}`,
      summary: null,
    };
  }
  const baseWeights = (defaultCfg && defaultCfg.scoring && typeof defaultCfg.scoring === 'object'
    && defaultCfg.scoring.weights && typeof defaultCfg.scoring.weights === 'object')
    ? defaultCfg.scoring.weights : null;
  if (!baseWeights) {
    return {
      exitCode: 2,
      output: 'error: config/default.json is missing scoring.weights',
      summary: null,
    };
  }

  // Read history NDJSON.
  let historyText;
  try {
    historyText = await readFile(opts.historyFile);
  } catch (err) {
    const message = (err && typeof err === 'object' && /** @type {any} */(err).message)
      ? /** @type {any} */(err).message : String(err);
    return {
      exitCode: 2,
      output: `error: failed to read history at ${opts.historyFile}: ${message}`,
      summary: null,
    };
  }
  const lines = historyText.split(/\r?\n/).filter((l) => l.length > 0);
  const sinceMs = nowMs() - opts.windowMs;
  const loadResult = loadClosedTrades(lines, { sinceMs });
  const summary = summarizeClosedTrades(loadResult.trades);
  const calibration = computeCalibrationCorrelation(loadResult.trades);
  const suggestion = suggestAdaptiveWeights(
    { baseWeights, calibrationCorrelation: calibration },
    {
      uniformityPullMax: opts.uniformityPullMax,
      amplificationMax: opts.amplificationMax,
      calibrationFloor: opts.calibrationFloor,
      minClosedTrades: opts.minClosedTrades,
      tradeCount: loadResult.trades.length,
    }
  );

  const envelope = {
    ok: true,
    now_ms: nowMs(),
    window_days: opts.days,
    window_ms: opts.windowMs,
    since_ms: sinceMs,
    history_file: opts.historyFile,
    user_json_path: opts.userJsonPath,
    calibration_correlation: calibration,
    closed_trade_count: loadResult.trades.length,
    unpaired_exit_count: loadResult.unpaired_exit_count,
    parse_error_count: loadResult.errors.length,
    summary: {
      accounted_count: summary.accounted_count,
      wins: summary.wins,
      losses: summary.losses,
      win_rate: summary.win_rate,
      total_realized_pnl_sats: summary.total_realized_pnl_sats,
      mean_hold_ms: summary.mean_hold_ms,
      mean_entry_score: summary.mean_entry_score,
    },
    suggestion: {
      applied: suggestion.applied,
      reason: suggestion.reason,
      base_weights: suggestion.baseWeights,
      suggested_weights: suggestion.suggested,
      deltas: suggestion.deltas,
      direction: suggestion.summary.direction,
      pull_max_used: suggestion.summary.pull_max_used,
      features_evaluated: suggestion.summary.features_evaluated,
      uniform_target: suggestion.summary.uniform_target,
      sum_base: suggestion.summary.sum_base,
      sum_suggested: suggestion.summary.sum_suggested,
    },
    knobs: {
      uniformity_pull_max: opts.uniformityPullMax,
      amplification_max: opts.amplificationMax,
      calibration_floor: opts.calibrationFloor,
      min_closed_trades: opts.minClosedTrades,
    },
  };

  // Apply: write the new weights into user.json (preserve every
  // other key verbatim). Skip when --apply was not requested.
  let applyStatus = 'skipped_dry_run';
  if (opts.apply) {
    try {
      let userJson = {};
      if (await fileExists(opts.userJsonPath)) {
        try {
          const text = await readFile(opts.userJsonPath);
          userJson = text.trim().length > 0 ? JSON.parse(text) : {};
        } catch {
          // Corrupt user.json: refuse to overwrite silently. The
          // operator must inspect / fix it manually.
          return {
            exitCode: 2,
            output: `error: ${opts.userJsonPath} exists but is not valid JSON; refusing to overwrite. Inspect + fix manually.`,
            summary: envelope,
          };
        }
      }
      // Deep-set scoring.weights = suggestion.suggested without
      // disturbing any sibling keys.
      const next = { ...userJson };
      const scoring = (next.scoring && typeof next.scoring === 'object') ? { ...next.scoring } : {};
      scoring.weights = { ...suggestion.suggested };
      next.scoring = scoring;
      // Stamp the change so the operator can audit the timeline
      // without scraping the file.
      next.adaptive_weights_last_applied = {
        ts_iso: new Date(nowMs()).toISOString(),
        ts_ms: nowMs(),
        applied: suggestion.applied,
        reason: suggestion.reason,
        calibration_correlation: calibration,
        closed_trade_count: loadResult.trades.length,
        window_days: opts.days,
      };
      const serialized = JSON.stringify(next, null, 2) + '\n';
      await writeFile(opts.userJsonPath, serialized);
      applyStatus = 'applied';
    } catch (err) {
      const message = (err && typeof err === 'object' && /** @type {any} */(err).message)
        ? /** @type {any} */(err).message : String(err);
      return {
        exitCode: 2,
        output: `error: failed to write ${opts.userJsonPath}: ${message}`,
        summary: envelope,
      };
    }
  }

  envelope.apply_status = applyStatus;

  if (opts.json) {
    return {
      exitCode: (opts.apply && suggestion.applied) ? 1 : 0,
      output: JSON.stringify(envelope, null, 2),
      summary: envelope,
    };
  }

  // Human-friendly text output.
  const lines2 = [];
  lines2.push('T56 Adaptive scoring weights — suggestion');
  lines2.push('========================================');
  lines2.push(`window:              ${opts.days}d (${opts.windowMs} ms since ${new Date(sinceMs).toISOString()})`);
  lines2.push(`history file:        ${opts.historyFile}`);
  lines2.push(`closed trades:       ${loadResult.trades.length} (${summary.accounted_count} with P&L evidence; ${loadResult.unpaired_exit_count} unpaired exits; ${loadResult.errors.length} parse errors)`);
  if (calibration === null) {
    lines2.push(`calibration corr:    <insufficient evidence>`);
  } else {
    lines2.push(`calibration corr:    ${calibration.toFixed(4)}  (entry_score vs realized_pnl_sats)`);
  }
  lines2.push(`wins:                ${summary.wins} / ${summary.accounted_count} (win_rate ${(summary.win_rate * 100).toFixed(2)}%)`);
  lines2.push(`total realized P&L:  ${summary.total_realized_pnl_sats} sats`);
  lines2.push('');
  if (suggestion.applied) {
    lines2.push(`direction:           ${suggestion.summary.direction} (pullMax=${suggestion.summary.pull_max_used.toFixed(3)}; uniform=${suggestion.summary.uniform_target.toFixed(4)}; features=${suggestion.summary.features_evaluated})`);
    lines2.push('');
    lines2.push(formatSuggestionDiff({
      base: suggestion.baseWeights,
      suggested: suggestion.suggested,
      deltas: suggestion.deltas,
    }));
    lines2.push('');
    lines2.push(`apply:               ${applyStatus}`);
  } else {
    lines2.push(`no-op (${suggestion.reason}) — base weights unchanged.`);
    lines2.push('');
    lines2.push(`apply:               ${applyStatus}`);
  }
  return {
    exitCode: (opts.apply && suggestion.applied) ? 1 : 0,
    output: lines2.join('\n'),
    summary: envelope,
  };
}

// CLI entrypoint. Guarded so `tests/scripts.test.mjs` can import
// `main()` without side effects on load.
const isEntrypoint = (() => {
  if (!Array.isArray(process.argv) || process.argv.length < 2) return false;
  try {
    const url = new URL(import.meta.url);
    const entryPath = url.pathname;
    const argv1 = process.argv[1] ? new URL('file://' + process.argv[1]).pathname : null;
    return argv1 === entryPath;
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  main({}).then((res) => {
    process.stdout.write(res.output + '\n');
    process.exit(res.exitCode);
  }).catch((err) => {
    const message = (err && typeof err === 'object' && /** @type {any} */(err).message)
      ? /** @type {any} */(err).message : String(err);
    process.stderr.write(`fatal: ${message}\n`);
    process.exit(2);
  });
}
