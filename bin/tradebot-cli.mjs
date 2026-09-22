#!/usr/bin/env node
// bin/tradebot-cli.mjs
//
// TradeBot operator-facing CLI orchestrator. One entry point for
// every common first-run + day-2 task so the README quickstart can
// collapse to a handful of commands instead of a wall of npm
// install / cd / build / start fragments.
//
// Subcommands:
//
//   setup        One-shot first-run install. Installs root + dashboard
//                deps (the dashboard `postinstall` hook rebuilds the
//                SPA bundle), prints the wizard URL + next-steps
//                cheat-sheet, and exits 0. Operator then runs
//                `npm run dashboard` (or `npm run bot`).
//
//   dashboard    Start the dashboard backend (`scripts/start-dashboard.mjs`).
//                Defaults to bind on 127.0.0.1:8787 (LAN-routable via
//                `--bind-host=0.0.0.0`).
//
//   bot          Start the trader loop (`scripts/run-bot.mjs`).
//
//   doctor       Quick health print: node version, git status, the 4
//                gateway files (default.json + user.json + dashboard
//                bundle + libauth wasm) all present and sane.
//
//   --help       Print this help.
//
// Why this exists:
//
//   The README quickstart previously required:
//
//     npm install
//     cd dashboard && npm install && npm run build   <-- 3 steps the
//                                                       quickstart
//                                                       kept forgetting
//     cd ..
//     node scripts/start-dashboard.mjs
//
//   …which is fragile (operator runs out of the dashboard dir, or
//   forgets the build, or hits the wizard against a stale bundle).
//   `setup` collapses the 3 install steps into 1, then hands off
//   to `dashboard` / `bot`.
//
// Usage examples:
//
//   npx tradebot setup            # default subcommand if invoked
//                                   via `npm run setup` (no args)
//   node bin/tradebot-cli.mjs    # prints help
//   npm run setup -- --quiet      # suppress the cheat-sheet
//
// Exit codes:
//
//   0  - OK
//   1  - required dep missing (Node version, install failed)
//   2  - setup stage failed (root install / dashboard install / build)
//   3  - dashboard boot failed
//   4  - bot boot failed
//   64 - usage error (unknown subcommand, etc.) [matches sysexits.h]

import { existsSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

// Cross-platform repo-root discovery. `fileURLToPath` handles
// Windows correctly (e.g. `file:///C:/...` \u2192 `C:\\...`),
// whereas `new URL(import.meta.url).pathname` returns `/C:/...`
// (with a leading slash + `/`-separated path) and breaks on
// Windows. The basename `bin/tradebot-cli.mjs` is enforced so the
// discovery doesn't accidentally match an unrelated file that
// happens to import this module.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const PKG = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

function log(msg) {
  // eslint-disable-next-line no-console
  console.log(msg);
}
function info(msg) {
  log(`[tradebot] ${msg}`);
}
function warn(msg) {
  // eslint-disable-next-line no-console
  console.error(`[tradebot] WARN: ${msg}`);
}
function fail(msg, code = 1) {
  // eslint-disable-next-line no-console
  console.error(`[tradebot] ERROR: ${msg}`);
  process.exit(code);
}

/**
 * Resolve a command name to the appropriate executable for the
 * current platform. On Windows, `npm` / `node` are usually
 * shimmed via `npm.cmd` / `node.cmd`; bare `spawnSync('npm', ...)`
 * fails with ENOENT. We append `.cmd` (the most common shim
 * extension) when running on Windows.
 *
 * Pure. Exported for tests.
 *
 * @param {string} cmd  e.g. 'npm', 'node'
 * @returns {string}    e.g. 'npm' on POSIX, 'npm.cmd' on Windows
 */
export function resolveCmd(cmd) {
  if (process.platform !== 'win32') return cmd;
  if (cmd.endsWith('.cmd') || cmd.endsWith('.exe') || cmd.endsWith('.bat')) return cmd;
  return `${cmd}.cmd`;
}

/**
 * Run a sub-process and capture BOTH stdout + stderr. On non-zero
 * exit, append a useful tail of stderr to the error message so the
 * operator doesn't have to scroll back through npm's noisy log
 * to find the actual failure.
 *
 * @param {string} label     human-readable step name (e.g. 'root npm install')
 * @param {string} cmd       executable (resolved via PATH; on Windows
 *                           .cmd is auto-tried for npm/node etc.)
 * @param {string[]} args
 * @param {string} cwd
 * @param {number} exitCode  exit code to use on failure
 * @returns {number}         exit code (0 = ok)
 */
function runOrFail(label, cmd, args, cwd, exitCode) {
  const resolved = resolveCmd(cmd);
  const r = spawnSync(resolved, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    // On Windows, npm/node exist as both `npm.exe` (real binary)
    // and `npm.cmd` (shim). `resolveCmd` picks the right extension
    // above. `shell: false` keeps argv intact so the cmd can read
    // its own arguments (a quoted `%PATH%`-style shim has its own
    // quoting rules).
    shell: false,
    windowsHide: true,
    env: process.env,
  });
  if (r.status === 0) return 0;
  const stderrTail = String(r.stderr ?? '').trim().split(/\r?\n/).slice(-12).join('\n');
  const stdoutTail = String(r.stdout ?? '').trim().split(/\r?\n/).slice(-12).join('\n');
  const enoentHint = (r.error && /ENOENT/.test(String(r.error)))
    ? `\n  HINT: spawn ENOENT \u2014 '${resolved}' not found on PATH.\n`
      + `    On Windows this usually means ${cmd}.cmd is missing or PATH is empty.\n`
      + `    Try: \`where ${cmd}.cmd\` from a fresh cmd.exe.\n`
    : '';
  const diagnostic = [
    ``,
    `  ${label} failed (status=${r.status ?? -1}, signal=${r.signal ?? 'none'})`,
    enoentHint,
    stderrTail ? `  --- last 12 stderr lines ---` : '',
    stderrTail,
    stdoutTail ? `  --- last 12 stdout lines ---` : '',
    stdoutTail,
  ].filter(Boolean).join('\n');
  fail(label + diagnostic, exitCode);
  return r.status ?? 1;
}

function usage() {
  log(`
Usage: tradebot <subcommand> [options]

Subcommands:
  setup        First-run install (root + dashboard deps + bundle build)
  dashboard    Start the dashboard backend (default: 127.0.0.1:8787)
  bot          Start the trader loop
  doctor       Print environment + config-file health
  --help, -h   Print this help

Examples:
  npm run setup            # same as: tradebot setup
  npm run dashboard        # same as: tradebot dashboard
  tradebot setup --quiet
  tradebot dashboard --bind-host=0.0.0.0

Default behavior: if invoked with no subcommand, runs 'setup' (the
one-shot first-run install).
`);
}

// ─────────────────────────────────────────────────────────────────────
//  Subcommand: setup
// ─────────────────────────────────────────────────────────────────────

function runSetup(opts) {
  info('TradeBot first-run setup');
  log('');

  // Step 0: node version sanity.
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) {
    fail(`Node >= 20 required (got ${process.versions.node}). Try \`nvm use 20\` or installing Node 20 LTS.`, 1);
  }
  info(`Node ${process.versions.node} \u2713`);

  // Step 1: install root deps (only if missing).
  if (!existsSync(path.join(REPO_ROOT, 'node_modules'))) {
    info('Installing root dependencies (npm install)...');
    log('');
    runOrFail('root `npm install`', 'npm',
      ['install', '--no-audit', '--no-fund', '--loglevel=error'],
      REPO_ROOT, 2);
  } else {
    info('Root deps already installed (skipping `npm install` of root)');
  }

  // Step 2: install dashboard deps + trigger postinstall (vite build).
  if (!existsSync(path.join(REPO_ROOT, 'dashboard', 'node_modules'))) {
    info('Installing dashboard dependencies (npm install --prefix dashboard)...');
    log('');
    // The dashboard `postinstall` hook auto-runs `npm run build`,
    // so a single `npm install --prefix dashboard` covers both.
    runOrFail('dashboard `npm install`', 'npm',
      ['install', '--no-audit', '--no-fund', '--loglevel=error'],
      path.join(REPO_ROOT, 'dashboard'), 2);
  } else {
    info('Dashboard deps already installed (skipping `npm install` of dashboard)');
    // Still try to build the bundle (idempotent, ~1s on warm cache).
    const r = spawnSync(resolveCmd('npm'), ['run', 'build'], {
      cwd: path.join(REPO_ROOT, 'dashboard'),
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true,
    });
    if (r.status === 0) info('Dashboard bundle rebuilt OK');
  }

  // Step 3: verify the bundle exists.
  const indexHtml = path.join(REPO_ROOT, 'dashboard', 'dist', 'index.html');
  if (!existsSync(indexHtml)) {
    warn('Dashboard bundle missing at dashboard/dist/index.html.');
    warn('  Run `npm run dashboard:build` to rebuild it, then re-run setup.');
    warn('  Dashboard will still launch but the wizard page will 404.');
  } else {
    info('Dashboard bundle OK \u2713');
  }

  // Step 4: verify config/default.json exists + is parseable.
  const defaultJson = path.join(REPO_ROOT, 'config', 'default.json');
  if (!existsSync(defaultJson)) {
    fail(`config/default.json missing at ${defaultJson}. This repo is broken.`, 1);
  }
  try {
    JSON.parse(readFileSync(defaultJson, 'utf8'));
  } catch (e) {
    fail(`config/default.json is not valid JSON: ${e?.message ?? e}`, 1);
  }
  info('config/default.json OK \u2713');

  // Step 5: print the cheat-sheet (unless --quiet).
  if (!opts.quiet) {
    log('');
    log('============================================================');
    log('  SETUP COMPLETE');
    log('============================================================');
    log('');
    log('  Next: start the dashboard backend.');
    log('    npm run dashboard    # 127.0.0.1:8787 by default');
    log('');
    log('  The first time you open http://127.0.0.1:8787 the');
    log('  SETUP wizard will appear. It walks you through:');
    log('    - Network choice (mainnet / chipnet)');
    log('    - Wallet setup (paste WIF / paste mnemonic / generate)');
    log('    - Initial trading settings (small-balance defaults are');
    log('      already filled in \u2014 just confirm)');
    log('    - Optional API token (auto-generated if blank)');
    log('');
    log('  Wizard writes config/user.json (chmod 600, gitignored).');
    log('');
    log('  After the wizard finishes:');
    log('    npm run bot          # starts the trader loop');
    log('    npm run init-wallet  # re-run wallet setup if needed');
    log('    npm run doctor       # environment + config health');
    log('');
  }
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────
//  Subcommand: dashboard
// ─────────────────────────────────────────────────────────────────────

function runDashboard(opts) {
  const args = [];
  if (opts.bindHost) args.push(`--bind-host=${opts.bindHost}`);
  if (opts.bindPort) args.push(`--bind-port=${opts.bindPort}`);
  if (opts.configDefault) args.push(`--config-default=${opts.configDefault}`);
  if (opts.noWallet) args.push('--no-wallet');

  info(`Starting dashboard backend (node scripts/start-dashboard.mjs ${args.join(' ')})`);
  if (!opts.quiet) {
    log('');
    log('  WIZARD:   http://127.0.0.1:8787/setup  (first-run only;');
    log('                                   auto-redirects when config is incomplete)');
    log('  HEALTH:   http://127.0.0.1:8787/healthz');
    log('');
    log('  Press Ctrl-C to stop.');
    log('');
  }
  const r = spawnSync('node', [path.join(REPO_ROOT, 'scripts', 'start-dashboard.mjs'), ...args], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (r.status !== 0 && r.status !== null) fail(`dashboard exited with code ${r.status}`, 3);
  process.exit(r.status ?? 0);
}

// ─────────────────────────────────────────────────────────────────────
//  Subcommand: bot
// ─────────────────────────────────────────────────────────────────────

function runBot(opts) {
  info('Starting trader loop (node scripts/run-bot.mjs)');
  if (!opts.quiet) {
    log('');
    log('  Loop ticks every ~60s. Press Ctrl-C to stop.');
    log('  Trade history appended to data/history.jsonl.');
    log('  Positions stored to data/positions.json.');
    log('');
  }
  const r = spawnSync('node', [path.join(REPO_ROOT, 'scripts', 'run-bot.mjs')], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (r.status !== 0 && r.status !== null) fail(`bot exited with code ${r.status}`, 4);
  process.exit(r.status ?? 0);
}

// ─────────────────────────────────────────────────────────────────────
//  Subcommand: doctor
// ─────────────────────────────────────────────────────────────────────

function runDoctor() {
  log('=== TradeBot doctor ===');
  log('');
  log(`Node:                  ${process.versions.node}`);
  log(`Platform:              ${process.platform} ${process.arch}`);
  log(`Repo root:             ${REPO_ROOT}`);
  log(`Version:               ${PKG.version}`);
  log('');

  // node_modules / dashboard deps
  const rootNm = path.join(REPO_ROOT, 'node_modules');
  const dashNm = path.join(REPO_ROOT, 'dashboard', 'node_modules');
  log(`root node_modules:     ${existsSync(rootNm) ? 'present' : 'MISSING \u2014 run `npm install`'}`);
  log(`dashboard node_modules: ${existsSync(dashNm) ? 'present' : 'MISSING \u2014 run `npm run dashboard:install`'}`);

  // bundle
  const indexHtml = path.join(REPO_ROOT, 'dashboard', 'dist', 'index.html');
  let bundleSize = 'MISSING \u2014 run `npm run dashboard:build`';
  if (existsSync(indexHtml)) {
    try { bundleSize = `${statSync(indexHtml).size} bytes (index.html)`; } catch {}
  }
  log(`dashboard bundle:      ${bundleSize}`);

  // config files
  const defaultJson = path.join(REPO_ROOT, 'config', 'default.json');
  const userJson = path.join(REPO_ROOT, 'config', 'user.json');
  log(`config/default.json:   ${existsSync(defaultJson) ? 'present' : 'MISSING \u2014 broken repo'}`);
  if (existsSync(userJson)) {
    try {
      const stat = statSync(userJson);
      const modeStr = (stat.mode & 0o777).toString(8);
      const fix = modeStr !== '600' ? ` (mode ${modeStr} \u2014 recommend chmod 600)` : '';
      log(`config/user.json:      present (${stat.size} bytes${fix})`);
    } catch {}
  } else {
    log(`config/user.json:      not yet created \u2014 the wizard will create it on first dashboard start`);
  }

  // libauth wasm (libauth ships wasm files under build/lib/ in 3.x)
  const libauthWasm = path.join(REPO_ROOT, 'node_modules', '@bitauth', 'libauth', 'build', 'lib');
  const libauthPresent = existsSync(libauthWasm);
  let libauthWasmCount = 0;
  if (libauthPresent) {
    try {
      libauthWasmCount = readdirSync(libauthWasm).length;
    } catch {}
  }
  log(`libauth wasm:          ${libauthPresent ? `present (${libauthWasmCount} subfiles)` : 'MISSING \u2014 broken install'}`);

  // git state
  try {
    const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' });
    const branch = r.stdout?.trim() || 'unknown';
    const r2 = spawnSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
    const dirty = (r2.stdout ?? '').trim().length > 0 ? 'dirty' : 'clean';
    log(`git branch:            ${branch} (${dirty})`);
  } catch {
    log('git:                  not a git repo');
  }

  log('');
  log('If anything is MISSING above, the relevant fix is shown next to it.');
  log('Re-run `tradebot setup` to repair.');
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────
//  CLI dispatcher
// ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    subcommand: null,
    quiet: false,
    bindHost: undefined,
    bindPort: undefined,
    configDefault: undefined,
    noWallet: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      usage();
      process.exit(0);
    } else if (a === '--quiet' || a === '-q') {
      opts.quiet = true;
    } else if (a.startsWith('--bind-host=')) {
      opts.bindHost = a.slice('--bind-host='.length);
    } else if (a === '--bind-host') {
      opts.bindHost = argv[++i];
    } else if (a.startsWith('--bind-port=')) {
      opts.bindPort = Number(a.slice('--bind-port='.length));
    } else if (a === '--bind-port') {
      opts.bindPort = Number(argv[++i]);
    } else if (a.startsWith('--config-default=')) {
      opts.configDefault = a.slice('--config-default='.length);
    } else if (a === '--no-wallet') {
      opts.noWallet = true;
    } else if (a.startsWith('-')) {
      fail(`unknown option: ${a}\n\n${usage()}`, 64);
    } else {
      positional.push(a);
    }
  }
  opts.subcommand = positional[0] || 'setup';
  opts.subcommandArgs = positional.slice(1);
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  switch (opts.subcommand) {
    case 'setup':      return runSetup(opts);
    case 'dashboard':  return runDashboard(opts);
    case 'bot':        return runBot(opts);
    case 'doctor':     return runDoctor();
    default:
      fail(`unknown subcommand: ${opts.subcommand}\n\n${usage()}`, 64);
  }
}

// Gate the auto-run on "executed as the entry script" so the
// module can be imported for tests without spawning the bot.
// The standard ESM idiom is `import.meta.url === pathToFileURL(argv[1])`.
import { pathToFileURL } from 'node:url';
const isDirect = (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href);

if (isDirect) main();