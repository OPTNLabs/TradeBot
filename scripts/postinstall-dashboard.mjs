#!/usr/bin/env node
// scripts/postinstall-dashboard.mjs
//
// `dashboard/package.json:postinstall` hook. Tries to rebuild the
// SPA bundle after every `npm install --prefix dashboard` so that
// downstream consumers (the dashboard backend in
// `scripts/start-dashboard.mjs`, which serves `dashboard/dist/`)
// always get a fresh bundle.
//
// Why this exists:
//
//   Most TradeBot setups are dev-machine installs where `npm install`
//   happens once and then `npm run dashboard` kicks off a long
//   process. Without a postinstall build, a new clone needs:
//
//     npm install
//     (cd dashboard && npm install)
//     (cd dashboard && npm run build)   <-- THIS IS WHAT THE QUICKSTART
//                                          MISSED BEFORE THIS SCRIPT
//
//   The hook collapses the third step into step 2.
//
// Tolerates:
//   - `npm install --production` (no devDependencies, so `vite` is
//     absent). The script logs a warning and exits 0; the bundle will
//     be built next time someone runs `npm run dashboard:build`
//     explicitly (i.e. CI / Docker / prod paths where the bundle is
//     baked in separately).
//   - `NODE_ENV=production` (same — no devDeps).
//   - Fresh repo where `dashboard/node_modules` exists but the user
//     hasn't yet installed the root deps (we still try to build
//     using only the dashboard's own deps).
//
// Doesn't tolerate (and intentionally fails-on-call but exits 0):
//   - Missing `vite` after a fresh install. The user's `npm install`
//     shouldn't brick because of a build issue. They can rerun
//     `npm run dashboard:build` once the upstream error is fixed.

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(HERE, '..');
const DASHBOARD_DIR = path.resolve(REPO_ROOT, 'dashboard');
// npm may invoke this script from the dashboard dir (when run as
// `postinstall` from dashboard/package.json) or from the repo
// root (when run via `npm run dashboard:build`). Trust process.cwd()
// for the dashboard dir, since `npm --prefix dashboard install`
// sets it that way.
const CWD_DASHBOARD_GUESS = path.resolve(process.cwd());
const CWD_DASHBOARD = (CWD_DASHBOARD_GUESS.endsWith(`${path.sep}dashboard`)
  || CWD_DASHBOARD_GUESS === path.resolve(REPO_ROOT, 'dashboard'))
  ? CWD_DASHBOARD_GUESS
  : DASHBOARD_DIR;

function log(msg) {
  // eslint-disable-next-line no-console
  console.log(`[dashboard:postinstall] ${msg}`);
}

if (!existsSync(CWD_DASHBOARD)) {
  log(`dashboard/ not found at ${CWD_DASHBOARD} - skipping`);
  process.exit(0);
}
if (!existsSync(path.join(CWD_DASHBOARD, 'node_modules', 'vite'))) {
  log(`vite not installed at ${CWD_DASHBOARD}/node_modules/vite`);
  log('  Skipping bundle build. Run `npm run dashboard:build` explicitly');
  log('  (this is normal for `npm install --production` / CI-only flows)');
  process.exit(0);
}

log('Building dashboard bundle (vite build)...');
// On Windows, `npm` is a .cmd shim; bare spawnSync('npm') fails
// with ENOENT. Append the right extension when on win32.
const npmCmd = (process.platform === 'win32') ? 'npm.cmd' : 'npm';
const result = spawnSync(npmCmd, ['run', 'build'], {
  cwd: CWD_DASHBOARD,
  stdio: 'inherit',
  env: process.env,
  windowsHide: true,
});

if (result.status !== 0) {
  log('Bundle build FAILED - see vite output above.');
  log('Workaround: run `npm run dashboard:build` from the repo root after fixing the failure.');
  // Don't fail the install \u2014 the user's npm install shouldn't
  // brick because of a build issue.
  process.exit(0);
}

log('Dashboard bundle built OK.');
process.exit(0);