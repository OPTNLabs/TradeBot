#!/usr/bin/env node
// scripts/check-orphan-positions.mjs
//
// T59 subset 1 — Orphan-position alert CLI.
//
// Why this exists
// ────────────────
// `src/reconcile/positions-vs-chain.mjs#diffPositionsVsChain`
// (shipped in T47) emits a `kind:'on_disk_only' severity:'high'`
// finding whenever an open position claims tokens the wallet does
// not hold. That is the canonical "orphan position" — the bot
// thinks it's holding tokens, but the on-chain receipt UTXO is gone
// (likely sold off-chain, lost during a partial sweep, or never
// confirmed after a failed broadcast).
//
// This CLI is the operator-facing wrapper that runs the diff on
// demand, fires an alert for every high-severity finding through
// the existing T53 alert pipeline (NDJSON persistence + console
// log + Telegram when enabled), and prints a structured summary to
// stdout. Subset 2 (deferred) auto-wires the same call site into
// the trader loop so the bot self-monitors without an external
// cron.
//
// Exit codes (chosen so cron / systemd can route on them):
//   0 — clean tree (no orphan-position findings; alerts disabled or
//       trivially empty).
//   1 — orphan-position findings present AND alerts were dispatched
//       (or would have been, in dry-run mode).
//   2 — wallet / config / Electrum error. The diff didn't run, or
//       ran against a stale UTXO set. Treat as "reconciliation
//       skipped" — surface to the operator.
//   3 — bad CLI args (unknown flag, missing --positions-file, ...).
//
// Usage:
//   node scripts/check-orphan-positions.mjs --help
//   node scripts/check-orphan-positions.mjs                            # human-friendly
//   node scripts/check-orphan-positions.mjs --json                     # machine-readable JSON
//   node scripts/check-orphan-positions.mjs --dry-run                  # skip wallet + alert dispatch
//   node scripts/check-orphan-positions.mjs --positions-file data/positions.json
//   node scripts/check-orphan-positions.mjs --quiet                    # exit-code only
//
// SAFETY: when run WITHOUT `--dry-run`, the script boots the real
// Electrum-backed wallet via LibAuthBchWallet (read-only
// `listUtxos()` call) AND appends AlertEvents to `data/alerts.jsonl`
// when alerts are enabled. It does NOT broadcast any transactions.
// Telegram channel send is gated by the operator's `alerts.channels`
// config (default = `['console']` only).

import { promises as fsp } from 'node:fs';
import process from 'node:process';

import { loadConfig } from '../src/util/config-loader.mjs';
import { createLogger } from '../src/util/logger.mjs';
import { Positions } from '../src/portfolio/positions.mjs';
import { LibAuthBchWallet, walletConfigFrom, resolveWif } from '../src/wallet/libauth.mjs';
import {
  diffPositionsVsChain,
} from '../src/reconcile/positions-vs-chain.mjs';
import {
  isOrphanFinding,
  mapFindingsToOrphanAlerts,
  dispatchOrphanAlerts,
  indexOpenPositionsById,
  pickOrphanPositions,
  ORPHAN_POSITION_ALERT_KIND,
} from '../src/alerts/orphan-position.mjs';
import { createAlertsAppender } from '../src/alerts/persist.mjs';

// ── arg parsing ──────────────────────────────────────────────────────────

/**
 * Parse argv into a `flags` object + `positional` array. Mirrors the
 * `parseXxxArgs` pattern used by the other operator scripts
 * (`scripts/reconcile-positions-vs-chain.mjs`,
 * `scripts/manual-test-trade.mjs`, ...). Supports both
 * `--key=value` and `--key value` forms.
 *
 * Exported so `tests/scripts.test.mjs` can exercise the parser in
 * isolation (no wallet / network calls).
 *
 * @param {string[]} argv
 * @returns {{ flags: Record<string, string|boolean>, positional: string[] }}
 */
export function parseCheckOrphanArgs(argv) {
  const flags = {};
  const positional = [];
  let afterSeparator = false;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a !== 'string') continue;
    if (!afterSeparator && a === '--') {
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
 * Validate parsed flags + apply defaults. Throws a typed error on
 * unsupported / unknown flags so the operator sees a one-liner
 * pointing at `--help` rather than a confusing crash later.
 *
 * @param {Record<string, string|boolean>} flags
 * @returns {{
 *   positionsFile: string,
 *   json: boolean,
 *   quiet: boolean,
 *   dryRun: boolean,
 *   noDispatch: boolean,
 *   help: boolean,
 * }}
 */
export function resolveCheckOrphanArgs(flags) {
  const allowed = new Set([
    'positions-file',
    'json',
    'quiet',
    'dry-run',
    'no-dispatch',
    'help',
  ]);
  for (const k of Object.keys(flags)) {
    if (!allowed.has(k)) {
      const err = new Error(`unknown flag --${k} (supported: --positions-file, --json, --quiet, --dry-run, --no-dispatch, --help)`);
      err.code = 'ORPHAN_CHECK_BAD_FLAG';
      throw err;
    }
  }
  return {
    positionsFile: (typeof flags['positions-file'] === 'string' && flags['positions-file'].length > 0)
      ? flags['positions-file']
      : 'data/positions.json',
    json: flags['json'] === true,
    quiet: flags['quiet'] === true,
    dryRun: flags['dry-run'] === true,
    noDispatch: flags['no-dispatch'] === true,
    help: flags['help'] === true,
  };
}

/**
 * Print the help banner. Mirrors the style of the other operator
 * scripts. Pure: writes to stdout when invoked directly.
 */
export function printOrphanCheckHelp() {
  const lines = [
    'check-orphan-positions — T59 subset 1',
    '',
    'Reads data/positions.json + queries the wallet\'s live UTXO set,',
    'then fires an alert for every orphan-position finding (a position',
    'that\'s recorded as open on disk but the wallet holds zero tokens for',
    'that token category).',
    '',
    'USAGE:',
    '  node scripts/check-orphan-positions.mjs [--positions-file=PATH]',
    '                                        [--json] [--quiet] [--dry-run]',
    '                                        [--no-dispatch]',
    '',
    'OPTIONS:',
    '  --positions-file=PATH   Position store to read (default data/positions.json).',
    '  --json                  Emit a structured JSON envelope on stdout.',
    '  --quiet                 Suppress the human-readable summary on stdout;',
    '                          exit-code only.',
    '  --dry-run               Skip wallet boot + alert dispatch entirely',
    '                          (no network, no data/alerts.jsonl writes).',
    '  --no-dispatch           Boot the wallet + run the diff, but skip the',
    '                          alert dispatch (persistence + Telegram).',
    '                          Useful when validating the diff shape alone.',
    '  --help, -h              Show this banner.',
    '',
    'EXIT CODES:',
    '  0  clean tree (no orphan-position findings).',
    '  1  orphan-position findings present; alerts dispatched (or would',
    '     have been, in dry-run / no-dispatch mode).',
    '  2  wallet / config error.',
    '  3  bad CLI args.',
    '',
  ];
  // eslint-disable-next-line no-console
  if (!process.env.ORPHAN_CHECK_HELP_QUIET) console.log(lines.join('\n'));
}

// ── main orchestrator ────────────────────────────────────────────────────

/**
 * The pure orchestrator. Exported for the test suite so
 * `tests/scripts.test.mjs` can exercise every code path with
 * stubbed deps (no wallet boot, no network, no disk writes).
 *
 * @param {Object} opts
 * @param {string[]} [opts.argv=process.argv]   Parsed via parseCheckOrphanArgs.
 * @param {Object} [opts.deps]                  Injected dependencies.
 * @param {typeof loadConfig} [opts.deps.loadConfig]       Config loader seam.
 * @param {Object} [opts.deps.positions]         Positions store seam.
 * @param {{diffPositionsVsChain: Function}} [opts.deps.reconcile]  Pure-diff seam.
 * @param {{getUtxos: Function}} [opts.deps.walletProvider]         Wallet UTXO-fetch seam.
 * @param {Function} [opts.deps.appender]        Alerts NDJSON appender seam.
 * @param {{dispatch: Function}|null} [opts.deps.router]            Alert router seam.
 * @param {Object} [opts.deps.logger]            Logger seam.
 * @param {() => number} [opts.deps.nowMs]       Clock seam.
 * @returns {Promise<{
 *   ok: boolean,
 *   code: number,
 *   args?: Object,
 *   help?: string,
 *   error?: string,
 *   report?: {
 *     version: number,
 *     generated_at: string|null,
 *     summary: Object,
 *     findings: Array,
 *     orphans: Array,
 *     alerts_dispatched: number,
 *     alerts_persisted: number,
 *     alerts_failed: number,
 *     dry_run: boolean,
 *   },
 * }>}
 */
export async function main(opts = {}) {
  const argv = Array.isArray(opts.argv) ? opts.argv : process.argv;
  const { flags } = parseCheckOrphanArgs(argv);
  let args;
  try {
    args = resolveCheckOrphanArgs(flags);
  } catch (e) {
    return { ok: false, code: 3, help: printOrphanCheckHelp.toString().slice(0, 256), error: e?.message ?? String(e) };
  }
  if (args.help) {
    printOrphanCheckHelp();
    return { ok: true, code: 0, args };
  }

  const deps = (opts && typeof opts === 'object' && opts.deps && typeof opts.deps === 'object')
    ? opts.deps
    : {};
  const now = (typeof deps.nowMs === 'function') ? deps.nowMs() : Date.now();
  const logger = (deps.logger && typeof deps.logger === 'object')
    ? deps.logger
    : createLogger({ sink: process.stderr, component: 'check-orphan-positions' });

  // 1. Load positions.json. Positions is the production class
  //    (`src/portfolio/positions.mjs#Positions`) — it exposes
  //    `load()` + `list('open')`. Tests inject a fake via
  //    `deps.positions` that mimics the surface; the production
  //    path uses the real class.
  let positionsHandle;
  try {
    const PositionsCtor = deps.positions || Positions;
    positionsHandle = new PositionsCtor({ file: args.positionsFile });
  } catch (e) {
    const msg = e?.message ?? String(e);
    logger.error('check_orphan_positions.positions_ctor.failed', {
      event: 'check_orphan_positions.positions_ctor',
      positions_file: args.positionsFile,
      error: msg,
    });
    return { ok: false, code: 2, args, error: `positions constructor failed: ${msg}` };
  }
  let openPositions;
  try {
    if (typeof positionsHandle.init === 'function') {
      // Test seam — caller injected a fake with an `init()` hook.
      await positionsHandle.init();
      const allPositions = (typeof positionsHandle.all === 'function')
        ? positionsHandle.all()
        : (positionsHandle._data?.positions ?? []);
      openPositions = allPositions.filter((p) => p && p.status === 'open');
    } else {
      // Production path — real `Positions.load()` + `Positions.list('open')`.
      await positionsHandle.load();
      openPositions = await positionsHandle.list('open');
    }
  } catch (e) {
    const msg = e?.message ?? String(e);
    logger.error('check_orphan_positions.positions_load.failed', {
      event: 'check_orphan_positions.positions_load',
      positions_file: args.positionsFile,
      error: msg,
    });
    return { ok: false, code: 2, args, error: `positions load failed: ${msg}` };
  }

  // 2. Run the diff. In dry-run / stubbed-wallet mode, we still
  //    want a useful report — fall back to an "unverified" empty
  //    findings array so the operator can see "script ran but
  //    wallet was not consulted".
  let utxos = [];
  let walletError = null;
  let reconciliationSeam = deps.reconcile;
  if (!reconciliationSeam || typeof reconciliationSeam.diffPositionsVsChain !== 'function') {
    try {
      const reconcileMod = await import('../src/reconcile/positions-vs-chain.mjs');
      reconciliationSeam = reconcileMod;
    } catch (e) {
      return { ok: false, code: 2, args, error: `reconcile import failed: ${e?.message ?? String(e)}` };
    }
  }

  if (args.dryRun) {
    logger.info('check_orphan_positions.dry_run.skipping_wallet', {
      event: 'check_orphan_positions.dry_run',
      open_positions: openPositions.length,
    });
  } else if (typeof deps.walletProvider === 'object' && deps.walletProvider && typeof deps.walletProvider.getUtxos === 'function') {
    // Test seam: caller injected a fake wallet provider.
    try {
      utxos = await deps.walletProvider.getUtxos();
    } catch (e) {
      walletError = e?.message ?? String(e);
      logger.error('check_orphan_positions.wallet.failed', {
        event: 'check_orphan_positions.wallet',
        error: walletError,
      });
    }
  } else {
    // Real path: boot LibAuthBchWallet and read the UTXO set.
    try {
      const cfg = (typeof deps.loadConfig === 'function')
        ? await deps.loadConfig({ repoRoot: process.cwd() })
        : await loadConfig({ repoRoot: process.cwd() });
      if (cfg && cfg.alerts && cfg.alerts.orphan_position_check_enabled === false) {
        logger.info('check_orphan_positions.disabled_via_config', {
          event: 'check_orphan_positions.disabled',
          knob: 'alerts.orphan_position_check_enabled',
        });
        return {
          ok: true,
          code: 0,
          args,
          report: {
            version: reconciliationSeam.RECONCILE_REPORT_VERSION ?? 1,
            generated_at: new Date(now).toISOString(),
            summary: { open_positions: openPositions.length, on_chain_tokens: 0, findings: 0, high: 0, medium: 0, low: 0 },
            findings: [],
            orphans: [],
            alerts_dispatched: 0,
            alerts_persisted: 0,
            alerts_failed: 0,
            dry_run: !!args.dryRun,
            disabled_via_config: true,
          },
        };
      }
      const walletCfg = walletConfigFrom(cfg);
      const wif = resolveWif(cfg);
      const wallet = new LibAuthBchWallet({ cfg: walletCfg, wif, logger: (record) => logger.info(record?.event ?? 'wallet', record) });
      await wallet.init();
      utxos = await wallet.listUtxos({ maxAttempts: 1 });
    } catch (e) {
      walletError = e?.message ?? String(e);
      logger.error('check_orphan_positions.wallet.failed', {
        event: 'check_orphan_positions.wallet',
        error: walletError,
      });
    }
  }

  if (walletError && !args.dryRun) {
    return { ok: false, code: 2, args, error: `wallet error: ${walletError}` };
  }

  // 3. Run the pure diff.
  const generatedAt = new Date(now).toISOString();
  const report = reconciliationSeam.diffPositionsVsChain(openPositions, utxos, { generatedAt });

  // 4. Filter to orphan findings + dispatch.
  const orphanFindings = (Array.isArray(report.findings) ? report.findings : []).filter(isOrphanFinding);
  const orphanPositions = pickOrphanPositions(orphanFindings, openPositions);
  const orphanEvents = mapFindingsToOrphanAlerts(orphanFindings, {
    nowMs: now,
    positionIndex: indexOpenPositionsById(openPositions),
  });

  let alertsDispatched = 0;
  let alertsPersisted = 0;
  let alertsFailed = 0;
  let dispatchErrors = [];

  if (!args.noDispatch && !args.dryRun && orphanEvents.length > 0) {
    let appender = deps.appender;
    let router = deps.router ?? null;
    if (typeof appender !== 'function') {
      try {
        appender = createAlertsAppender({ logger: (record) => logger.warn(record?.event ?? 'alerts', record) });
      } catch (e) {
        logger.warn('check_orphan_positions.appender_init.failed', {
          event: 'check_orphan_positions.appender_init',
          error: e?.message ?? String(e),
        });
        appender = null;
      }
    }
    try {
      const result = await dispatchOrphanAlerts({
        router,
        appender,
        findings: orphanFindings,
        nowMs: now,
        positionIndex: indexOpenPositionsById(openPositions),
        logger,
      });
      alertsDispatched = result.dispatched;
      alertsPersisted = result.persisted;
      alertsFailed = result.failed;
      dispatchErrors = result.errors;
    } catch (e) {
      // dispatchOrphanAlerts NEVER throws by contract; this is a
      // belt-and-suspenders guard in case a future refactor breaks
      // that contract.
      logger.error('check_orphan_positions.dispatch.unexpected_throw', {
        event: 'check_orphan_positions.dispatch',
        error: e?.message ?? String(e),
      });
      alertsFailed += 1;
    }
  }

  logger.info('check_orphan_positions.done', {
    event: 'check_orphan_positions.done',
    open_positions: openPositions.length,
    orphan_findings: orphanFindings.length,
    orphan_positions: orphanPositions.length,
    alerts_dispatched: alertsDispatched,
    alerts_persisted: alertsPersisted,
    alerts_failed: alertsFailed,
    dry_run: !!args.dryRun,
    no_dispatch: !!args.noDispatch,
  });

  const orphanSummary = {
    findings: orphanFindings,
    positions: orphanPositions.map((p) => ({
      id: p.id,
      token_id: p.token_id,
      token_symbol: p.token_symbol,
      entry_ts: p?.entry?.ts ?? null,
    })),
    events: orphanEvents,
  };

  const enrichedReport = {
    version: report.version ?? 1,
    generated_at: report.generated_at ?? generatedAt,
    summary: report.summary ?? null,
    findings: report.findings ?? [],
    orphans: orphanSummary,
    alerts_dispatched: alertsDispatched,
    alerts_persisted: alertsPersisted,
    alerts_failed: alertsFailed,
    dispatch_errors: dispatchErrors,
    dry_run: !!args.dryRun,
    no_dispatch: !!args.noDispatch,
    alert_kind: ORPHAN_POSITION_ALERT_KIND,
  };

  const code = orphanFindings.length > 0 ? 1 : 0;
  return { ok: (code === 0), code, args, report: enrichedReport };
}

// ── CLI entry ────────────────────────────────────────────────────────────

// Only run when invoked directly. When imported by
// `tests/scripts.test.mjs`, the body short-circuits so the test
// suite can call `main(...)` without a real wallet boot.
const isDirect = import.meta.url === `file://${process.argv[1]}` ||
                 process.argv[1]?.endsWith('check-orphan-positions.mjs');

if (isDirect) {
  main().then((result) => {
    if (!result || typeof result !== 'object') {
      // eslint-disable-next-line no-console
      console.error('check-orphan-positions: no result returned');
      process.exit(2);
    }
    if (result.code === 3 && result.error) {
      // eslint-disable-next-line no-console
      console.error(`check-orphan-positions: ${result.error}`);
      // eslint-disable-next-line no-console
      console.error('Run with --help for usage.');
      process.exit(3);
    }
    if (result.code === 2 && result.error) {
      // eslint-disable-next-line no-console
      console.error(`check-orphan-positions: ${result.error}`);
      process.exit(2);
    }
    const args = result.args || {};
    const report = result.report;
    if (args.json && report) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(report, null, 2));
    } else if (!args.quiet && report) {
      const lines = [
        `orphan-position check @ ${report.generated_at}`,
        `open positions: ${report.summary?.open_positions ?? '?'}`,
        `orphan findings: ${report.orphans.findings.length}`,
        `alerts dispatched: ${report.alerts_dispatched}`,
        `alerts persisted: ${report.alerts_persisted}`,
        `alerts failed: ${report.alerts_failed}`,
        `dry_run: ${report.dry_run}`,
      ];
      if (report.orphans.findings.length > 0) {
        lines.push('');
        lines.push('Orphan findings:');
        for (const f of report.orphans.findings) {
          lines.push(`  - ${f.position_id} [${f.token_symbol ?? (f.token_id ? f.token_id.slice(0, 8) + '…' : '?')}] severity=${f.severity}`);
          if (f.summary) lines.push(`      ${f.summary}`);
        }
        lines.push('');
        lines.push('Recommended action: scripts/reconcile-position.mjs --position-id <id>');
        lines.push('                    or scripts/reconcile-stuck-position.mjs --position-id <id>');
      }
      // eslint-disable-next-line no-console
      console.log(lines.join('\n'));
    }
    process.exit(result.code ?? 0);
  }).catch((e) => {
    // eslint-disable-next-line no-console
    console.error('check-orphan-positions: unexpected error:', e?.message ?? String(e));
    if (process.env.DEBUG) {
      // eslint-disable-next-line no-console
      console.error(e?.stack ?? '');
    }
    process.exit(2);
  });
}
