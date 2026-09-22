#!/usr/bin/env node
/**
 * scripts/start-dashboard.mjs
 *
 * Boot the TradeBot dashboard backend (T16).
 *
 * Usage:
 *   node scripts/start-dashboard.mjs                       # bind per config/default.json
 *   node scripts/start-dashboard.mjs --bind-host=0.0.0.0  # bind all interfaces
 *   node scripts/start-dashboard.mjs --bind-port=9000     # override the port
 *   node scripts/start-dashboard.mjs --config-default=... # override config paths
 *   node scripts/start-dashboard.mjs --help
 *
 * The script:
 *
 *   1. Loads `config/default.json` + `config/user.json` via the
 *      shared loader. `user.json` is where the operator sets
 *      `dashboard.api_token` to enable `PUT /api/config` +
 *      `POST /api/risk/reset`.
 *   2. Constructs a `Positions`, `Snapshots`, and `historyReader`
 *      against the standard on-disk locations.
 *   3. Optionally wires the live `wallet` (so `/api/summary` shows
 *      the right-now balance, not the last snapshot). Wiring the
 *      wallet means the WIF is loaded into this process — the
 *      operator can disable this with `--no-wallet` if they only
 *      want the read-only dashboard.
 *   4. Calls `start()` on the dashboard server and waits for SIGINT
 *      / SIGTERM to shut down cleanly.
 *
 * Design rules (also see docs/ARCHITECTURE.md §3):
 *
 *   - Read-only by default. The wallet is OPTIONAL via `--no-wallet`.
 *   - All knobs read from `cfg.dashboard` (deep-merged from
 *     default.json + user.json).
 *   - No `console.log` for bot logs. The CLI banner goes to
 *     stdout (operator-facing); bot logs go to stderr via the
 *     structured logger.
 *   - On SIGINT / SIGTERM, the server closes its listening socket
 *     cleanly so k8s / systemd don't think the process hung.
 */

import process from 'node:process';

import { createLogger } from '../src/util/logger.mjs';
import { loadConfig, summarizeConfig } from '../src/util/config-loader.mjs';
import { Positions } from '../src/portfolio/positions.mjs';
import { Snapshots } from '../src/portfolio/snapshots.mjs';
import { SwapExecutor } from '../src/trader/swap.mjs';
import { createHistoryAppender, DEFAULT_HISTORY_FILE } from '../src/trader/loop.mjs';
import {
  createDashboardServer,
  resolveDashboardConfig,
  createHistoryReader,
  DEFAULT_DASHBOARD_HISTORY_FILE,
} from '../src/dashboard/server.mjs';
import { createPaytacaBcmrClient } from '../src/dashboard/paytacaBcmr.mjs';
import { FeatureIdeasStore } from '../src/feature-ideas/store.mjs';
import { BugsStore } from '../src/bugs/store.mjs';

/**
 * Minimal arg parser — handles --flag, --key=value, --no-flag.
 *
 * @param {string[]} argv
 * @returns {{ flags: Record<string, string|true|false>, positional: string[] }}
 */
export function parseDashboardArgs(argv) {
  const flags = {};
  const positional = [];
  for (const arg of argv.slice(2)) {
    if (arg === '--') continue;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq >= 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else if (arg.startsWith('--no-')) {
        flags[arg.slice(5)] = false;
      } else {
        flags[arg.slice(2)] = true;
      }
    } else if (arg.startsWith('-') && arg.length > 1 && !arg.startsWith('--')) {
      // Single-dash short flags (-h, -?). Bare form only — short
      // flags with values are not supported by the dashboard CLI.
      flags[arg.slice(1)] = true;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

/**
 * Resolve the bind host + port from CLI flags, falling back to
 * `cfg.dashboard`. Pure. Exported for tests.
 *
 * @param {Object} flags
 * @param {Object} dashboardCfg
 * @returns {{ bindHost: string, bindPort: number, noWallet: boolean, help: boolean }}
 */
export function resolveBindArgs(flags, dashboardCfg) {
  const bindHost = (typeof flags['bind-host'] === 'string' && flags['bind-host'].length > 0)
    ? String(flags['bind-host'])
    : dashboardCfg.bind_host;
  const bindPort = (() => {
    if (typeof flags['bind-port'] === 'string' || typeof flags['bind-port'] === 'number') {
      const n = parseInt(String(flags['bind-port']), 10);
      if (Number.isFinite(n) && n > 0 && n < 65536) return n;
    }
    return dashboardCfg.bind_port;
  })();
  return {
    bindHost,
    bindPort,
    noWallet: flags.wallet === false,
    help: flags.help === true || flags.h === true || flags['?'] === true,
  };
}

const HELP = `
TradeBot dashboard backend (T16).

Usage:
  node scripts/start-dashboard.mjs                       # bind per config/default.json
  node scripts/start-dashboard.mjs --bind-host=0.0.0.0  # bind all interfaces
  node scripts/start-dashboard.mjs --bind-port=9000     # override the port
  node scripts/start-dashboard.mjs --no-wallet          # disable live wallet wiring
  node scripts/start-dashboard.mjs --config-default=<p> # override default.json path
  node scripts/start-dashboard.mjs --config-user=<p>    # override user.json path
  node scripts/start-dashboard.mjs --help

Notes:
  - The dashboard is read-only by design. The ONLY write endpoints
    are PUT /api/config and POST /api/risk/reset; both are gated by
    a bearer token configured via 'dashboard.api_token' in user.json.
    If the token is unset, write endpoints return HTTP 503.
  - The wallet is optional. With --no-wallet the dashboard reads
    balance from the latest snapshot record only.
  - All other knobs live in config/default.json → dashboard.
`.trim();

/**
 * @param {string[]} argv
 * @returns {Promise<number>}  process exit code
 */
export async function main(argv = process.argv) {
  const { flags, positional: _pos } = parseDashboardArgs(argv);
  if (flags.help || flags.h || flags['?'] === true) {
    process.stdout.write(HELP + '\n');
    return 0;
  }

  const cfg = await loadConfig({
    defaultPath: typeof flags['config-default'] === 'string' ? flags['config-default'] : undefined,
    userPath: typeof flags['config-user'] === 'string' ? flags['config-user'] : undefined,
  });
  if (!cfg || typeof cfg !== 'object') {
    process.stderr.write('start-dashboard: failed to load config (default.json missing?)\n');
    return 1;
  }
  const dashboardCfg = resolveDashboardConfig(cfg.dashboard);
  const summary = summarizeConfig(cfg, { redact: true });
  const bind = resolveBindArgs(flags, dashboardCfg);
  // Honor CLI overrides by re-resolving the dashboard block.
  const resolvedDashboardCfg = Object.freeze({
    ...dashboardCfg,
    bind_host: bind.bindHost,
    bind_port: bind.bindPort,
  });
  const cfgWithOverrides = {
    ...cfg,
    dashboard: resolvedDashboardCfg,
  };

  const log = createLogger({ component: 'start-dashboard', level: resolvedDashboardCfg.log_level ?? 'info' });

  log.info('start-dashboard.boot', {
    tuning_preset: summary.tuning_preset,
    network: summary.network,
    cashaddr: summary.cashaddr,
    bind_host: resolvedDashboardCfg.bind_host,
    bind_port: resolvedDashboardCfg.bind_port,
    auth_configured: !!(resolvedDashboardCfg.api_token && resolvedDashboardCfg.api_token.length > 0),
    no_wallet: bind.noWallet,
    static_root: resolvedDashboardCfg.static_root ?? null,
    config_paths: cfg.paths,
  });

  let wallet = null;
  if (!bind.noWallet) {
    try {
      // Lazy-import so the dashboard backend can run without
      // libauth/cashscript on disk. Wallet wiring is OPTIONAL — if
      // it fails (e.g. WIF missing from user.json), we proceed
      // read-only.
      const mod = await import('../src/wallet/libauth.mjs');
      const walletCfg = mod.walletConfigFrom(cfg);
      // T23a/T23b: the wallet-config shape renamed `wif` → `explicitWif`
      // (and added `wifFile`). Accept either — older configs and
      // tests still emit a top-level `wif`.
      const hasWifMaterial = !!(walletCfg && (walletCfg.explicitWif || walletCfg.wifFile || walletCfg.wif));
      if (hasWifMaterial) {
        // LibAuthBchWallet constructor takes `{cfg, wif, logger}`,
        // NOT the flat `walletCfg` shape that `walletConfigFrom`
        // returns. Construct the wallet with `cfg: cfg` (the full
        // merged config — same shape the trader loop uses) and let
        // the wallet module re-derive its config internally.
        wallet = await mod.createWallet({
          cfg,
          wif: walletCfg.explicitWif,
          logger: log.child('wallet'),
        });
        await wallet.init();
        log.info('start-dashboard.wallet.ready', {
          address: wallet.address ?? null,
          network: walletCfg.network ?? null,
        });
      } else {
        log.warn('start-dashboard.wallet.skip', { reason: 'no WIF in user.json — dashboard runs read-only (no live balance)' });
      }
    } catch (e) {
      log.warn('start-dashboard.wallet.skip', {
        reason: 'wallet init failed — dashboard runs read-only',
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
      });
    }
  }

  const positions = new Positions({
    file: cfg.paths?.positions_file ?? 'data/positions.json',
    logger: log.child('positions'),
  });
  const snapshots = new Snapshots({
    dir: cfg.paths?.snapshots_dir ?? 'data/snapshots',
    logger: log.child('snapshots'),
  });
  const historyReader = createHistoryReader({
    file: DEFAULT_DASHBOARD_HISTORY_FILE,
  });

  // T45: manual-trade endpoint needs `SwapExecutor` + a history
  // appender so it can both run swaps through the same risk-gated
  // pipeline the trader loop uses AND emit a `kind:'manual_trade'`
  // audit event. Both are optional — the route returns
  // SWAP_NOT_CONFIGURED / WALLET_NOT_CONFIGURED when missing — but
  // in production we wire them so the operator's clicks work
  // out-of-the-box.
  const swap = new SwapExecutor({
    cfg: cfgWithOverrides,
    wallet,
    logger: log.child('swap'),
  });
  const historyAppend = createHistoryAppender({
    file: cfg.paths?.history_file ?? DEFAULT_HISTORY_FILE,
    logger: log.child('history-append'),
  });

  // T26c: Paytaca BCMR client. Override base URL via the
  // `dashboard.bcmr_base_url` knob in user.json (handy for
  // air-gapped / staging environments). Default is the public
  // Paytaca endpoint.
  const bcmrBaseUrl = (typeof resolvedDashboardCfg.bcmr_base_url === 'string'
    && resolvedDashboardCfg.bcmr_base_url.length > 0)
      ? resolvedDashboardCfg.bcmr_base_url
      : null;
  const bcmrClient = (bcmrBaseUrl !== null)
    ? createPaytacaBcmrClient({
        baseUrl: bcmrBaseUrl,
        log: (msg, meta) => log.warn(msg, meta),
      })
    : createPaytacaBcmrClient({
        log: (msg, meta) => log.warn(msg, meta),
      });

  const server = createDashboardServer({
    cfg: cfgWithOverrides,
    positions,
    snapshots,
    historyReader,
    wallet,
    // T45: wire swap + historyAppend into the dashboard context so
    // `POST /api/trade/manual` can run a real SwapExecutor.execute()
    // and emit the matching audit event. Optional in createDashboardServer
    // (the route returns SWAP_NOT_CONFIGURED / WALLET_NOT_CONFIGURED
    // when missing) — wiring here is for production parity with the
    // CLI scripts.
    swap,
    historyAppend,
    bcmrClient,
    logger: log,
    // Feature-ideas tab: appends a TODO entry on approve. Path is
    // resolved from `paths.todo_file` if set, else the conventional
    // location at the workspace root.
    featureIdeasStore: new FeatureIdeasStore({
      file: cfg.paths?.feature_ideas_file ?? 'data/feature-ideas.json',
      logger: log.child('feature-ideas'),
    }),
    featureIdeasTodoPath: cfg.paths?.todo_file ?? 'TODO.md',
    // T44: bugs tab. Same wiring pattern as feature-ideas — the
    // store path resolves from `paths.bugs_file` if set, else the
    // conventional location at `data/bugs.json`. The store is
    // created on first write if the file is missing, so the
    // dashboard server boots cleanly on a fresh checkout.
    bugsStore: new BugsStore({
      file: cfg.paths?.bugs_file ?? 'data/bugs.json',
      logger: log.child('bugs'),
    }),
  });

  // Lifecycle: bind, then wait for SIGINT / SIGTERM.
  await server.start();
  const banner = `TradeBot dashboard listening on http://${resolvedDashboardCfg.bind_host}:${resolvedDashboardCfg.bind_port}`;
  process.stdout.write(banner + '\n');
  if (!resolvedDashboardCfg.api_token || resolvedDashboardCfg.api_token.length === 0) {
    process.stdout.write('  ⚠  dashboard.api_token not set — write endpoints (PUT /api/config, POST /api/risk/reset) are disabled.\n');
  }
  if (server.ctx && server.ctx.staticEnabled) {
    process.stdout.write(`  📦 static SPA served from ${server.ctx.staticRoot}\n`);
  } else if (resolvedDashboardCfg.static_root !== null) {
    process.stdout.write(`  ⚠  static_root="${resolvedDashboardCfg.static_root ?? ''}" not found on disk — SPA assets will not be served. Run \`cd dashboard && npm install && npm run build\` first.\n`);
  }

  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('start-dashboard.shutdown', { signal: sig });
    try {
      await server.stop();
    } catch (e) {
      log.error('start-dashboard.shutdown.error', { err_message: e?.message ?? String(e) });
    }
    if (wallet && typeof wallet.close === 'function') {
      try { await wallet.close(); } catch { /* swallow */ }
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // Park forever; SIGINT/SIGTERM will resolve the exit.
  await new Promise(() => {});
  return 0;
}

const isDirect = import.meta.url === `file://${process.argv[1]}` ||
                 process.argv[1]?.endsWith('start-dashboard.mjs');
if (isDirect) {
  main(process.argv).then(
    (rc) => process.exit(rc),
    (err) => {
      process.stderr.write(`start-dashboard: fatal: ${err?.message ?? err}\n`);
      process.exit(1);
    },
  );
}
