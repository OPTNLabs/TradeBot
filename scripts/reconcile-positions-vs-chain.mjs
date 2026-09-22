#!/usr/bin/env node
// scripts/reconcile-positions-vs-chain.mjs
//
// T47: operator-side CLI for the positions-vs-chain reconciliation.
//
// Boots the wallet, reads `data/positions.json`, fetches the live
// UTXO set, runs the pure diff from `src/reconcile/positions-vs-chain.mjs`,
// and prints a structured report to stdout. NEVER writes to
// `data/positions.json` — the operator decides what to do with the
// findings and runs the existing `scripts/reconcile-position.mjs` /
// `scripts/reconcile-stuck-position.mjs` / `scripts/sync-wallet-holdings.mjs`
// scripts to remediate.
//
// Exit codes (chosen so cron can route on them):
//   0 — clean tree (no `high`/`medium` findings; `consensus` + `note`
//       only).
//   1 — `high` severity finding present (on_disk_only / malformed).
//       Action required: positions disagree with the chain on existence.
//   2 — `medium` severity finding present (on_chain_only /
//       quantity_mismatch). Informational; positions agree in spirit
//       but disagree on details.
//   3 — wallet / config error (LibAuthBchWallet threw). The diff
//       didn't run; treat as "reconciliation skipped".
//
// Usage:
//   node scripts/reconcile-positions-vs-chain.mjs --help
//   node scripts/reconcile-positions-vs-chain.mjs            # human-readable
//   node scripts/reconcile-positions-vs-chain.mjs --json     # machine-readable JSON
//   node scripts/reconcile-positions-vs-chain.mjs --positions-file data/positions.json
//   node scripts/reconcile-positions-vs-chain.mjs --quiet     # exit-code only

import process from 'node:process';

import { loadConfig } from '../src/util/config-loader.mjs';
import { createLogger } from '../src/util/logger.mjs';
import { Positions } from '../src/portfolio/positions.mjs';
import { LibAuthBchWallet, walletConfigFrom } from '../src/wallet/libauth.mjs';
import { resolveWif } from '../src/wallet/libauth.mjs';
import {
  diffPositionsVsChain,
} from '../src/reconcile/positions-vs-chain.mjs';

const log = createLogger({ sink: process.stderr, component: 'reconcile-pvc' });

// ── arg parsing ─────────────────────────────────────────────────────────

/**
 * Parse argv into a `flags` object. Mirrors the parseXxxArgs pattern
 * the other operator scripts use (skip `node` + script-path via
 * `argv.slice(2)`, `--key=value` and `--key value` forms).
 *
 * Exported for the test suite so the parser is exercised without
 * touching the filesystem or the wallet.
 *
 * @param {string[]} argv
 * @returns {{ flags: Record<string, string|boolean>, positional: string[] }}
 */
export function parseReconcilePvcArgs(argv) {
  const flags = {};
  const positional = [];
  let afterSeparator = false;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a !== 'string') continue;
    if (!afterSeparator && a === '--') {
      // POSIX-style: everything after `--` is a positional arg,
      // even if it looks like a flag.
      afterSeparator = true;
      continue;
    }
    if (afterSeparator || !a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq >= 0) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      flags[a.slice(2)] = true;
    }
  }
  return { flags, positional };
}

/**
 * Resolve parsed flags into a typed args object with defaults. Throws
 * `ReconcileConfigError` on unsupported flags so the operator sees a
 * one-liner pointing at `--help` rather than a confusing crash later.
 *
 * @param {Record<string, string|boolean>} flags
 * @returns {{ positionsFile: string, json: boolean, quiet: boolean }}
 */
export function resolveReconcilePvcArgs(flags) {
  const allowed = new Set(['positions-file', 'json', 'quiet', 'help']);
  for (const k of Object.keys(flags)) {
    if (!allowed.has(k)) {
      const err = new Error(`unknown flag --${k} (supported: --positions-file, --json, --quiet, --help)`);
      err.code = 'RECONCILE_PVC_BAD_FLAG';
      throw err;
    }
  }
  return {
    positionsFile: typeof flags['positions-file'] === 'string' && flags['positions-file'].length > 0
      ? flags['positions-file']
      : 'data/positions.json',
    json: flags.json === true,
    quiet: flags.quiet === true,
  };
}

// ── result types ────────────────────────────────────────────────────────

/**
 * @typedef {Object} ReconcilePvcResult
 * @property {number} exit_code  — 0/1/2/3 (see top-of-file contract).
 * @property {Object} report     — the structured diff report.
 * @property {string|null} error — human-readable failure reason (null
 *                                  on success).
 */

// ── main orchestration (testable) ──────────────────────────────────────

/**
 * Run the reconciliation end-to-end. Pure-ish: every external surface
 * (wallet, positions, logger, clock) is injected via `opts` so the
 * test suite can mock them.
 *
 * @param {Object} opts
 * @param {{ list: (bucket?: string) => Promise<Array> }} opts.positions
 * @param {{ listUtxos: () => Promise<Array> }} opts.wallet
 * @param {Object} [opts.logger]
 * @param {() => string} [opts.now] — clock seam (defaults to () => new Date().toISOString())
 * @returns {Promise<ReconcilePvcResult>}
 */
export async function reconcilePvcMain(opts) {
  if (!opts || typeof opts !== 'object') {
    throw new TypeError('reconcilePvcMain: opts required');
  }
  const { positions, wallet } = opts;
  if (!positions || typeof positions.list !== 'function') {
    const err = new Error('reconcilePvcMain: opts.positions.list is required');
    err.code = 'RECONCILE_PVC_NO_POSITIONS';
    throw err;
  }
  if (!wallet || typeof wallet.listUtxos !== 'function') {
    const err = new Error('reconcilePvcMain: opts.wallet.listUtxos is required');
    err.code = 'RECONCILE_PVC_NO_WALLET';
    throw err;
  }
  const logger = opts.logger ?? log;
  const now = opts.now ?? (() => new Date().toISOString());

  let openPositions;
  try {
    openPositions = await positions.list('open');
  } catch (e) {
    logger.error('reconcile.pvc.positions.failed', {
      err_name: e?.name ?? 'Error',
      err_message: e?.message ?? String(e),
    });
    return {
      exit_code: 3,
      report: null,
      error: `failed to read positions: ${e?.message ?? String(e)}`,
    };
  }

  let utxos;
  try {
    utxos = await wallet.listUtxos();
  } catch (e) {
    logger.error('reconcile.pvc.wallet.failed', {
      err_name: e?.name ?? 'Error',
      err_message: e?.message ?? String(e),
    });
    return {
      exit_code: 3,
      report: null,
      error: `wallet.listUtxos failed: ${e?.message ?? String(e)}`,
    };
  }

  const report = diffPositionsVsChain(openPositions, utxos, { generatedAt: now() });

  let exitCode = 0;
  if (report.summary.high > 0) exitCode = 1;
  else if (report.summary.medium > 0) exitCode = 2;

  logger.info('reconcile.pvc.done', {
    open_positions: report.summary.open_positions,
    on_chain_tokens: report.summary.on_chain_tokens,
    findings: report.summary.findings,
    high: report.summary.high,
    medium: report.summary.medium,
    low: report.summary.low,
    exit_code: exitCode,
  });

  return { exit_code: exitCode, report, error: null };
}

// ── rendering ───────────────────────────────────────────────────────────

/**
 * Render the report as a human-readable string for stdout. Pure.
 *
 * @param {Object} report
 * @returns {string}
 */
export function renderReconcilePvcReport(report) {
  if (!report || typeof report !== 'object') return '<no report>';
  const lines = [];
  lines.push('=== TradeBot — positions-vs-chain reconciliation ===');
  lines.push(`generated_at: ${report.generated_at ?? '<no clock>'}`);
  lines.push(`version: ${report.version}`);
  lines.push('');
  lines.push('Summary:');
  lines.push(`  open positions:   ${report.summary.open_positions}`);
  lines.push(`  on-chain tokens:  ${report.summary.on_chain_tokens}`);
  lines.push(`  findings:         ${report.summary.findings}`);
  lines.push(`    high:           ${report.summary.high}`);
  lines.push(`    medium:         ${report.summary.medium}`);
  lines.push(`    low:            ${report.summary.low}`);
  lines.push('');
  if (!report.findings || report.findings.length === 0) {
    lines.push('No findings.');
    return lines.join('\n');
  }
  lines.push('Findings:');
  for (const f of report.findings) {
    const sev = `[${(f.severity ?? '?').toUpperCase().padEnd(7)}]`;
    const kind = (f.kind ?? '?').padEnd(18);
    lines.push(`  ${sev} ${kind} ${f.summary ?? ''}`);
    if (f.recommended_action) {
      lines.push(`           → ${f.recommended_action}`);
    }
  }
  return lines.join('\n');
}

// ── script body ─────────────────────────────────────────────────────────

/**
 * Render a one-line --help summary. Pure.
 * @returns {string}
 */
export function reconcilePvcHelp() {
  return [
    'Usage: node scripts/reconcile-positions-vs-chain.mjs [flags]',
    '',
    'Flags:',
    '  --positions-file <path>  Override positions.json path (default: data/positions.json)',
    '  --json                  Emit JSON envelope on stdout (machine-readable)',
    '  --quiet                 Suppress human-readable output (exit code only)',
    '  --help                  Show this help',
    '',
    'Exit codes:',
    '  0  clean (no high/medium findings)',
    '  1  at least one HIGH-severity finding (positions disagree with chain)',
    '  2  at least one MEDIUM-severity finding (untracked token or quantity mismatch)',
    '  3  wallet/config error (reconciliation skipped)',
    '',
    'Does NOT write to data/positions.json. To remediate a finding,',
    'run the suggested script (reconcile-position.mjs /',
    'sync-wallet-holdings.mjs / reconcile-stuck-position.mjs).',
  ].join('\n');
}

const isDirect = import.meta.url === `file://${process.argv[1]}` ||
                 process.argv[1]?.endsWith('reconcile-positions-vs-chain.mjs');

if (!isDirect) {
  log.info('reconcile.pvc.imported-skip', { reason: 'not_direct_invocation' });
}

if (isDirect) {
  // Top-level async IIFE so we can await on the wallet / positions
  // boot without making the whole module a top-level await (which
  // would break the test import path).
  (async () => {
    try {
      const { flags, positional } = parseReconcilePvcArgs(process.argv);
      if (flags.help === true || positional.includes('help')) {
        process.stdout.write(reconcilePvcHelp() + '\n');
        process.exit(0);
      }
      const args = resolveReconcilePvcArgs(flags);
      const cfg = await loadConfig();
      const logger = log.child('boot');

      // Wire the positions store. Read-only path: we only call .list().
      const positions = new Positions({ file: args.positionsFile, logger });
      await positions.load();

      // Wire the wallet. We need `getTokenAddress()` (for the
      // provider's `getUtxos(tokenAddr)` call the trading loop uses)
      // and `listUtxos()` directly. We deliberately do NOT call
      // `init()` against a real WIF in the script — we want a
      // read-only scan, not a signing-capable wallet.
      const wcfg = walletConfigFrom(cfg);
      const wif = await resolveWif({ wifFile: wcfg.wifFile ?? cfg.user?.wallet?.wif_file, explicitWif: wcfg.explicitWif });
      const wallet = new LibAuthBchWallet({
        cfg,
        logger: logger.child('wallet'),
        wif,
      });
      await wallet.init();

      const result = await reconcilePvcMain({ positions, wallet, logger, now: () => new Date().toISOString() });
      if (!args.quiet) {
        if (args.json) {
          process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        } else {
          process.stdout.write(renderReconcilePvcReport(result.report) + '\n');
        }
      }
      process.exit(result.exit_code);
    } catch (e) {
      log.error('reconcile.pvc.boot.failed', {
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
      });
      process.stderr.write(`reconcile-positions-vs-chain: ${e?.message ?? String(e)}\n`);
      process.exit(3);
    }
  })();
}
