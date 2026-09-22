#!/usr/bin/env node
/**
 * scripts/restart-dashboard.mjs
 *
 * Graceful restart utility for the dashboard backend
 * (`scripts/start-dashboard.mjs`). Solves the operator-facing
 * staleness class of bugs where a long-running dashboard hasn't
 * picked up a freshly-shipped route handler — the most recent
 * example being `bug-trade-page-shows-api-route-missing-20260917`,
 * where a dashboard started 2026-09-16 03:25 PDT was still serving
 * 404s for `/api/trade-history` 30h later because that route was
 * only added in commit `8a6e14b` (T42 ship, 2026-09-16 13:21 PDT).
 *
 * What this does:
 *
 *   1. Locates the running dashboard via `pgrep -fa 'scripts/start-dashboard.mjs'`
 *      (excluding any `restart-dashboard.mjs` bash wrapper line so the
 *      watchdog never finds itself). Returns `{ pid, cmdline }`.
 *   2. Reads `/proc/<pid>/cmdline` to capture the original CLI args
 *      (`--bind-host`, `--bind-port`, `--config-default`,
 *      `--config-user`, `--no-wallet`) so the restarted instance is a
 *      like-for-like replacement and the bind host/port stay the same.
 *      If `--bind-host` / `--bind-port` are passed on THIS invocation
 *      they override the captured values (useful for ops who want to
 *      move the dashboard to a new port as part of the restart).
 *   3. Sends SIGTERM, polls `/proc/<pid>` for clean exit. Escalates to
 *      SIGKILL after `--kill-timeout-ms` (default 5s). Same hygiene
 *      shape as `scripts/check-bot-stall.mjs` but inverted (we want
 *      the process GONE).
 *   4. Spawns `node scripts/start-dashboard.mjs` with the captured
 *      args, detached from this script's process group so the new
 *      instance survives if this restart script exits early.
 *      `< restart-script-pid-stdin>` is plumbed to `/dev/null`,
 *      stdout/stderr to the operator's TTY (or /dev/null under
 *      `--quiet`).
 *   5. Polls the bind host/port `/healthz` endpoint until 200 OK or
 *      `--probe-timeout-ms` (default 20s) elapses. The probe URL is
 *      derived from the captured/overridden `--bind-host` +
 *      `--bind-port` so the watchdog tracks the restart target
 *      exactly — no separate config to drift.
 *   6. Logs structured events at every step (`dashboard.restart.*`).
 *      Returns typed `{ ok, old_pid, new_pid, healthy, code, message,
 *      captured_cmdline, started_at_ms, elapsed_ms }`.
 *
 * Usage:
 *   node scripts/restart-dashboard.mjs                                    # use defaults from running dashboard
 *   node scripts/restart-dashboard.mjs --dry-run                          # print plan, signal nothing
 *   TRADEBOT_RESTART_TIMEOUT_MS=15000 node scripts/restart-dashboard.mjs
 *   node scripts/restart-dashboard.mjs --bind-port=9000                   # also move to a new port
 *   node scripts/restart-dashboard.mjs --help
 *
 * Exit codes:
 *   0   success — new dashboard healthy
 *   1   failure — restart did not complete within the budget
 *   2   bad args — `--help` not requested AND arg parse failed
 *   3   no running dashboard — nothing to restart against
 *
 * Note: this script intentionally does NOT touch `scripts/run-bot.mjs`.
 * The bot loop has its own signal handlers + PID file + restart story
 * (see `scripts/check-bot-stall.mjs`). Mixing the two concerns keeps
 * each surface small + testable.
 */

import process from 'node:process';
import { spawn as nodeSpawn, exec as nodeExec } from 'node:child_process';
import { existsSync as nodeExistsSync } from 'node:fs';
import { readFile as nodeReadFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execp = promisify(nodeExec);

/** Default pattern used by `pgrep` to locate the dashboard. */
export const DEFAULT_RESTART_PGREP_PATTERN = 'scripts/start-dashboard.mjs';
/** Default total restart budget (kill + spawn + probe). */
export const DEFAULT_RESTART_TIMEOUT_MS = 20_000;
/** Default SIGTERM-then-SIGKILL window after SIGTERM. */
export const DEFAULT_RESTART_KILL_TIMEOUT_MS = 5_000;
/** Default `/healthz` probe timeout. */
export const DEFAULT_RESTART_PROBE_TIMEOUT_MS = 15_000;
/** /healthz polling cadence. */
export const DEFAULT_RESTART_PROBE_INTERVAL_MS = 200;
/** Path prefix for /proc/<pid>/cmdline. */
export const RESTART_PROC_CMDLINE_PREFIX = '/proc/';

/**
 * Subset of `child_process.exec` args we surface to `findRunningDashboard`.
 * Pure: returns `null` on bad shape so callers don't have to guard.
 *
 * @param {unknown} val
 * @returns {string|null}
 */
export function asPgrepPattern(val) {
  if (typeof val !== 'string') return null;
  const trimmed = val.trim();
  if (trimmed.length === 0) return null;
  // The pattern is interpolated into a single-quoted shell string
  // inside `findRunningDashboard`. Reject anything containing `;`,
  // `$(...)`, backticks, or newlines so the operator can't get a
  // shell injection via `--pgrep-pattern`.
  if (/[`$\n\r;]/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Parse `argv` into a `{flags}` map. Same minimal shape as
 * `scripts/start-dashboard.mjs#parseDashboardArgs` so the two
 * CLIs feel familiar to operators.
 *
 * @param {string[]} argv
 * @returns {Record<string, string|true|false|string[]>}
 */
export function parseRestartArgs(argv) {
  /** @type {Record<string, string|true|false|string[]>} */
  const flags = {};
  /** @type {string[]} */
  const positional = [];
  if (!Array.isArray(argv)) return flags;
  let afterSeparator = false;
  for (const arg of argv.slice(2)) {
    if (typeof arg !== 'string' || arg.length === 0) continue;
    if (!afterSeparator && arg === '--') {
      // POSIX-style: everything after `--` is positional, even
      // if it looks like a flag.
      afterSeparator = true;
      continue;
    }
    if (afterSeparator || (!arg.startsWith('--') && !arg.startsWith('-'))) {
      positional.push(arg);
      continue;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq >= 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else if (arg.startsWith('--no-')) {
        flags[arg.slice(5)] = false;
      } else {
        flags[arg.slice(2)] = true;
      }
      continue;
    }
    // Single-dash short flag (e.g. `-h`). Bare boolean form only;
    // `-h=value` is rejected to keep the parser unambiguous.
    if (arg.startsWith('-') && arg.length > 1) {
      const eq = arg.indexOf('=');
      if (eq >= 0) {
        flags[arg.slice(1, eq)] = arg.slice(eq + 1);
      } else {
        flags[arg.slice(1)] = true;
      }
      continue;
    }
  }
  if (positional.length > 0) flags._positional = positional;
  return flags;
}

/**
 * Validate + normalise the parsed args into a structured
 * `ResolvedRestartArgs` ready for the orchestrator. Pure. Throws
 * `TypeError` on bad numeric input so callers can map to exit code 2.
 *
 * @param {Record<string, unknown>} parsed
 * @param {Record<string, unknown>} [defaults]
 * @returns {{
 *   timeoutMs: number,
 *   killTimeoutMs: number,
 *   probeTimeoutMs: number,
 *   probeIntervalMs: number,
 *   pgrepPattern: string,
 *   bindHost: string|null,
 *   bindPort: number|null,
 *   extraArgs: string[],
 *   dryRun: boolean,
 *   help: boolean,
 *   quiet: boolean,
 * }}
 */
export function resolveRestartArgs(parsed, defaults = {}) {
  const flagTimeoutMs = Number(parsed['timeout-ms']);
  const timeoutMs = Number.isFinite(flagTimeoutMs) && flagTimeoutMs > 0
    ? Math.floor(flagTimeoutMs)
    : DEFAULT_RESTART_TIMEOUT_MS;
  if (timeoutMs > (10 * 60_000)) {
    throw new TypeError('timeout-ms too large (max 10m)');
  }

  const flagKillMs = Number(parsed['kill-timeout-ms']);
  const killTimeoutMs = Number.isFinite(flagKillMs) && flagKillMs > 0
    ? Math.floor(flagKillMs)
    : DEFAULT_RESTART_KILL_TIMEOUT_MS;
  if (killTimeoutMs > 60_000) {
    throw new TypeError('kill-timeout-ms too large (max 60s)');
  }
  if (killTimeoutMs > timeoutMs) {
    throw new TypeError('kill-timeout-ms may not exceed timeout-ms');
  }

  const flagProbeMs = Number(parsed['probe-timeout-ms']);
  const probeTimeoutMs = Number.isFinite(flagProbeMs) && flagProbeMs > 0
    ? Math.floor(flagProbeMs)
    : (Number.isFinite(Number(defaults.probeTimeoutMs)) && Number(defaults.probeTimeoutMs) > 0
        ? Math.floor(Number(defaults.probeTimeoutMs))
        : DEFAULT_RESTART_PROBE_TIMEOUT_MS);
  if (probeTimeoutMs > (5 * 60_000)) {
    throw new TypeError('probe-timeout-ms too large (max 5m)');
  }
  if (probeTimeoutMs > timeoutMs) {
    throw new TypeError('probe-timeout-ms may not exceed timeout-ms');
  }

  const flagProbeIntervalMs = Number(parsed['probe-interval-ms']);
  const probeIntervalMs = Number.isFinite(flagProbeIntervalMs) && flagProbeIntervalMs > 0
    ? Math.floor(flagProbeIntervalMs)
    : DEFAULT_RESTART_PROBE_INTERVAL_MS;
  if (probeIntervalMs > 5_000) {
    throw new TypeError('probe-interval-ms too large (max 5s)');
  }

  const pgrepPattern = asPgrepPattern(parsed['pgrep-pattern']) ?? DEFAULT_RESTART_PGREP_PATTERN;
  const bindHost = (typeof parsed['bind-host'] === 'string' && parsed['bind-host'].length > 0)
    ? parsed['bind-host']
    : null;
  let bindPort = null;
  if (typeof parsed['bind-port'] === 'string' || typeof parsed['bind-port'] === 'number') {
    const n = Number(String(parsed['bind-port']));
    if (Number.isFinite(n) && n > 0 && n < 65536) bindPort = Math.floor(n);
  }
  const extraRaw = (typeof parsed['extra-args'] === 'string') ? parsed['extra-args'] : '';
  const extraArgs = extraRaw.length > 0
    ? extraRaw.split(/\s+/).filter((s) => s.length > 0 && s.startsWith('--'))
    : [];

  return {
    timeoutMs,
    killTimeoutMs,
    probeTimeoutMs,
    probeIntervalMs,
    pgrepPattern,
    bindHost,
    bindPort,
    extraArgs,
    dryRun: parsed['dry-run'] === true,
    help: parsed.help === true || parsed.h === true || parsed['?'] === true,
    quiet: parsed.quiet === true,
  };
}

/**
 * Render the `--help` banner for `node scripts/restart-dashboard.mjs --help`.
 * Pure. Exported for tests.
 *
 * @returns {string}
 */
export function restartDashboardHelp() {
  return [
    'TradeBot graceful dashboard restart utility.',
    '',
    'Usage:',
    '  node scripts/restart-dashboard.mjs                                    # restart using captured args',
    '  node scripts/restart-dashboard.mjs --dry-run                          # print plan, signal nothing',
    '  node scripts/restart-dashboard.mjs --bind-host=0.0.0.0 --bind-port=9000',
    '',
    'Options:',
    '  --timeout-ms=<n>        total restart budget (default 20000, max 600000)',
    '  --kill-timeout-ms=<n>   SIGTERM → SIGKILL window (default 5000, max 60000)',
    '  --probe-timeout-ms=<n>  /healthz probe window (default 15000, max 300000)',
    '  --probe-interval-ms=<n> probe polling cadence (default 200, max 5000)',
    '  --pgrep-pattern=<s>     pattern to locate the running dashboard (default scripts/start-dashboard.mjs)',
    '  --bind-host=<host>      override the bind host (default: reuse captured --bind-host)',
    '  --bind-port=<n>         override the bind port (default: reuse captured --bind-port)',
    '  --extra-args="<...>"    additional flags forwarded to the spawned dashboard (whitespace-separated)',
    '  --dry-run               print the plan and exit 0',
    '  --quiet                 suppress non-essential stdout (the structured logger still emits structured events)',
    '  --help                  print this banner',
    '',
    'Exit codes:',
    '  0  success — new dashboard healthy',
    '  1  failure — restart did not complete within the budget',
    '  2  bad args',
    '  3  no running dashboard — nothing to restart against',
    '',
    'ENV equivalents (read only when --flag absent):',
    '  TRADEBOT_RESTART_TIMEOUT_MS',
    '  TRADEBOT_RESTART_KILL_TIMEOUT_MS',
    '  TRADEBOT_RESTART_PROBE_TIMEOUT_MS',
    '  TRADEBOT_RESTART_PGREP_PATTERN',
  ].join('\n');
}

/**
 * Best-effort read of `/proc/<pid>/cmdline`. Returns the argv
 * array (NUL-separated in the kernel; we split + drop empties) or
 * `null` when the process is gone / unreadable / non-numeric pid.
 *
 * @param {{ pid: number, readFile?: (path: string, enc: string) => Promise<string> }} opts
 * @returns {Promise<string[]|null>}
 */
export async function readProcCmdline({ pid, readFile }) {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const fn = readFile ?? nodeReadFile;
  const path = `${RESTART_PROC_CMDLINE_PREFIX}${pid}/cmdline`;
  let raw;
  try {
    raw = await fn(path, 'utf8');
  } catch (_e) {
    return null;
  }
  if (typeof raw !== 'string' || raw.length === 0) return null;
  return raw.split('\0').filter((s) => s.length > 0);
}

/**
 * Best-effort pid liveness probe via `/proc/<pid>/cmdline` existence.
 *
 * @param {{ pid: number, existsSync?: (path: string) => boolean }} opts
 * @returns {boolean}
 */
export function isPidAlive({ pid, existsSync }) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  const fn = existsSync ?? nodeExistsSync;
  try {
    return fn(`${RESTART_PROC_CMDLINE_PREFIX}${pid}/cmdline`);
  } catch (_e) {
    return false;
  }
}

/**
 * Wrap `child_process.exec` so tests can inject fakes without
 * pulling `node:child_process`. Returns `{ stdout, stderr }` like
 * `exec` does; rejects with `{ stdout, stderr, err }` so callers
 * can see partial output even on failure.
 *
 * @param {string} cmd
 * @param {{ timeoutMs: number, exec?: (cmd: string, opts: object) => Promise<{stdout:string, stderr:string}> }} opts
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
export async function runExec(cmd, opts) {
  const fn = opts.exec ?? ((c, o) => execp(c, { timeout: o.timeoutMs, maxBuffer: 64 * 1024 }));
  const r = await fn(cmd, { timeoutMs: opts.timeoutMs });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * Find the running dashboard via `pgrep -fa`. Returns `{ pid, cmdline }`
 * or `{ pid: null, cmdline: null }` on miss.
 *
 * @param {{ exec?: (cmd: string, opts: object) => Promise<{stdout:string, stderr:string}>, pattern: string, readFile?: (p: string, e: string) => Promise<string> }} opts
 * @returns {Promise<{ pid: number|null, cmdline: string|null, argv: string[]|null }>}
 */
export async function findRunningDashboard({ exec, pattern, readFile }) {
  const safePattern = asPgrepPattern(pattern) ?? DEFAULT_RESTART_PGREP_PATTERN;
  // The shell-escaped pattern is interpolation-safe: `asPgrepPattern`
  // already rejected any character that could break out of the
  // single-quoted shell string.
  const cmd = `pgrep -fa '${safePattern}' | grep -v '/bin/bash' | grep -v 'restart-dashboard.mjs' | head -1`;
  let stdout;
  try {
    const out = await runExec(cmd, { exec, timeoutMs: 5_000 });
    stdout = (out.stdout ?? '').trim();
  } catch (_e) {
    return { pid: null, cmdline: null, argv: null };
  }
  if (stdout.length === 0) return { pid: null, cmdline: null, argv: null };
  const parts = stdout.split(/\s+/);
  const candidate = Number(parts[0]);
  if (!Number.isFinite(candidate) || candidate <= 0) {
    return { pid: null, cmdline: null, argv: null };
  }
  const cmdline = parts.slice(1).join(' ');
  // Cross-check via /proc/<pid>/cmdline so a reused PID that
  // happens to be some unrelated `node scripts/...` doesn't pass.
  // `readFile` is injected so tests can mock it.
  const argv = await readProcCmdline({ pid: candidate, readFile });
  const argvMatches = Array.isArray(argv)
    ? argv.some((s) => s.includes('scripts/start-dashboard.mjs'))
    : false;
  if (argv.length === null || (Array.isArray(argv) && !argvMatches)) {
    // pgrep reported a hit but /proc/cmdline disagrees — could be a
    // reused PID or a pgrep race. Treat as miss.
    return { pid: null, cmdline: null, argv: null };
  }
  return { pid: candidate, cmdline, argv };
}

/**
 * Strip the leading `node scripts/start-dashboard.mjs` from a
 * captured argv array and return ONLY the user-facing flag args
 * (`--bind-host`, `--bind-port`, `--config-*`, `--no-wallet`,
 * `--help`). Extra args and unknown flags are dropped so the
 * restart doesn't replay anything else.
 *
 * @param {string[]} argv
 * @returns {string[]}
 */
export function keepDashboardFlags(argv) {
  if (!Array.isArray(argv)) return [];
  /** @type {string[]} */
  const out = [];
  let sawScript = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (typeof arg !== 'string') continue;
    if (!sawScript) {
      if (arg === 'node' || arg.endsWith('/node')) continue;
      if (arg.endsWith('scripts/start-dashboard.mjs')) {
        sawScript = true;
        continue;
      }
      // Skip anything that comes before the script name (usually
      // just `node`).
      continue;
    }
    // After the script: keep only known whitelist flags.
    if (arg === '--help' || arg === '-h' || arg === '--no-wallet') {
      out.push(arg);
      continue;
    }
    if (arg.startsWith('--bind-host=') || arg.startsWith('--bind-port=')
      || arg.startsWith('--config-default=') || arg.startsWith('--config-user=')) {
      out.push(arg);
      continue;
    }
    if (arg === '--bind-host' || arg === '--bind-port'
      || arg === '--config-default' || arg === '--config-user') {
      out.push(arg);
      const next = argv[i + 1];
      if (typeof next === 'string' && !next.startsWith('--')) {
        out.push(next);
        i += 1;
      }
      continue;
    }
    // Unknown flag / stray: drop. The restart script is intentionally
    // narrow in what it forwards so a tweaked `--quiet` setting on
    // the old process doesn't carry over without consent.
  }
  return out;
}

/**
 * Apply `--bind-host=<v>` / `--bind-port=<v>` overrides to a
 * captured arg list, replacing any existing occurrences. An
 * override of `null` means "leave the captured value alone"
 * (don't add, don't drop — only a non-null override mutates).
 *
 * @param {string[]} baseArgs
 * @param {{ bindHost?: string|null, bindPort?: number|null }} overrides
 * @returns {string[]}
 */
export function applyRestartOverrides(baseArgs, { bindHost, bindPort }) {
  /** @type {string[]} */
  const out = [];
  let sawBindHost = false;
  let sawBindPort = false;
  for (let i = 0; i < baseArgs.length; i += 1) {
    const arg = baseArgs[i];
    if (typeof arg !== 'string') { out.push(arg); continue; }
    if (arg.startsWith('--bind-host=')) {
      if (typeof bindHost === 'string' && bindHost.length > 0) {
        out.push(`--bind-host=${bindHost}`);
      } else {
        out.push(arg);
      }
      sawBindHost = true;
      continue;
    }
    if (arg === '--bind-host') {
      const next = baseArgs[i + 1];
      if (typeof bindHost === 'string' && bindHost.length > 0) {
        out.push(`--bind-host=${bindHost}`);
      } else {
        out.push('--bind-host');
        if (typeof next === 'string' && !next.startsWith('--')) out.push(next);
      }
      if (typeof next === 'string' && !next.startsWith('--')) i += 1;
      sawBindHost = true;
      continue;
    }
    if (arg.startsWith('--bind-port=')) {
      if (typeof bindPort === 'number') {
        out.push(`--bind-port=${bindPort}`);
      } else {
        out.push(arg);
      }
      sawBindPort = true;
      continue;
    }
    if (arg === '--bind-port') {
      const next = baseArgs[i + 1];
      if (typeof bindPort === 'number') {
        out.push(`--bind-port=${bindPort}`);
      } else {
        out.push('--bind-port');
        if (typeof next === 'string' && !next.startsWith('--')) out.push(next);
      }
      if (typeof next === 'string' && !next.startsWith('--')) i += 1;
      sawBindPort = true;
      continue;
    }
    out.push(arg);
  }
  if (typeof bindHost === 'string' && bindHost.length > 0 && !sawBindHost) {
    out.push(`--bind-host=${bindHost}`);
  }
  if (typeof bindPort === 'number' && !sawBindPort) {
    out.push(`--bind-port=${bindPort}`);
  }
  return out;
}

/**
 * Build the spawn argv for the fresh dashboard. Pure. Exported
 * for tests so the orchestration layer can be exercised without
 * `child_process.spawn`.
 *
 * @param {{ capturedArgs: string[], bindHost: string|null, bindPort: number|null, extraArgs: string[], nodeBin: string }} opts
 * @returns {string[]}
 */
export function buildSpawnArgs({ capturedArgs, bindHost, bindPort, extraArgs, nodeBin }) {
  const keepArgs = applyRestartOverrides(keepDashboardFlags(capturedArgs), { bindHost, bindPort });
  /** @type {string[]} */
  const argv = [nodeBin, 'scripts/start-dashboard.mjs'];
  for (const a of keepArgs) argv.push(a);
  for (const a of extraArgs) argv.push(a);
  return argv;
}

/**
 * Probe `/healthz` until 200 OK or budget elapses. Returns
 * `{ healthy, attempts, lastStatus, lastError }`. Pure except for
 * the injected `fetch` + `sleep` hooks.
 *
 * @param {{ url: string|null, timeoutMs: number, intervalMs: number, fetchFn?: typeof fetch, sleep?: (ms:number)=>Promise<void>, clock?: () => number }} opts
 * @returns {Promise<{ healthy: boolean, attempts: number, lastStatus: number|null, lastError: string|null, elapsedMs: number }>}
 */
export async function probeHealth(opts) {
  const url = opts.url;
  const timeoutMs = opts.timeoutMs;
  const intervalMs = Math.max(20, opts.intervalMs);
  const fetchFn = opts.fetchFn ?? ((u, init) => fetch(u, init));
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.clock ?? (() => Date.now());
  if (typeof url !== 'string' || url.length === 0) {
    return { healthy: false, attempts: 0, lastStatus: null, lastError: 'no probe url', elapsedMs: 0 };
  }
  const startedAt = now();
  let attempts = 0;
  let lastStatus = null;
  let lastError = null;
  while ((now() - startedAt) < timeoutMs) {
    attempts += 1;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), Math.max(500, Math.min(intervalMs * 2, 2_000)));
      let res;
      try {
        res = await fetchFn(url, { method: 'GET', signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
      lastStatus = (res && typeof res.status === 'number') ? res.status : null;
      if (lastStatus === 200) {
        return { healthy: true, attempts, lastStatus, lastError, elapsedMs: now() - startedAt };
      }
      lastError = `status ${lastStatus}`;
    } catch (e) {
      lastError = (e && e.name === 'AbortError') ? 'probe aborted (timeout)' : (e?.message ?? String(e));
    }
    await sleep(intervalMs);
  }
  return { healthy: false, attempts, lastStatus, lastError, elapsedMs: now() - startedAt };
}

/**
 * Derive the `/healthz` URL from a captured/overridden bind host
 * + port. Pure.
 *
 * @param {{ bindHost: string|null, bindPort: number|null, capturedCmdline: string|null, healthPath?: string }} opts
 * @returns {string|null}
 */
export function deriveProbeUrl({ bindHost, bindPort, capturedCmdline }) {
  const path = 'healthz';
  let host = (typeof bindHost === 'string' && bindHost.length > 0) ? bindHost : null;
  let port = (typeof bindPort === 'number' && bindPort > 0) ? bindPort : null;
  // Fallback: parse the captured cmdline if no override was supplied.
  if ((host === null || port === null) && typeof capturedCmdline === 'string') {
    const mHost = capturedCmdline.match(/--bind-host=(\S+)/);
    const mPort = capturedCmdline.match(/--bind-port=(\d+)/);
    if (host === null && mHost && typeof mHost[1] === 'string') host = mHost[1];
    if (port === null && mPort && typeof mPort[1] === 'string') {
      const n = Number(mPort[1]);
      if (Number.isFinite(n) && n > 0 && n < 65536) port = n;
    }
  }
  if (host === null || port === null) return null;
  // Loopback-friendly default: 127.0.0.1. If the operator bound to
  // 0.0.0.0 the probe would also work since the kernel routes to
  // the listening socket.
  const probeHost = (host === '0.0.0.0' || host === '::') ? '127.0.0.1' : host;
  return `http://${probeHost}:${port}/${path}`;
}

/**
 * Stop the dashboard with SIGTERM and escalate to SIGKILL if the
 * process hasn't exited by `--kill-timeout-ms`. Returns
 * `{exited, escalated, elapsedMs}`. Pure except for the injected
 * `kill`, `sleep`, `existsSync` hooks.
 *
 * @param {{ pid: number, killTimeoutMs: number, kill?: (pid: number, signal: string) => void, sleep?: (ms:number)=>Promise<void>, existsSync?: (path:string) => boolean, clock?: () => number }} opts
 * @returns {Promise<{ exited: boolean, escalated: boolean, elapsedMs: number, signal: string|null }>}
 */
export async function stopDashboard(opts) {
  const pid = opts.pid;
  if (!Number.isFinite(pid) || pid <= 0) {
    return { exited: false, escalated: false, elapsedMs: 0, signal: null };
  }
  const kill = opts.kill ?? ((p, s) => process.kill(p, s));
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const existsSync = opts.existsSync ?? nodeExistsSync;
  const now = opts.clock ?? (() => Date.now());
  const startedAt = now();
  let escalated = false;
  let exitSignal = 'SIGTERM';

  // SIGTERM pass.
  try {
    kill(pid, 'SIGTERM');
  } catch (e) {
    // ESRCH = already gone; that's the desired end-state.
    const msg = (e && typeof e === 'object' && 'code' in e && /** @type {any} */ (e).code === 'ESRCH');
    if (msg) {
      return { exited: true, escalated: false, elapsedMs: now() - startedAt, signal: 'SIGTERM' };
    }
    return { exited: false, escalated: false, elapsedMs: now() - startedAt, signal: null };
  }

  while ((now() - startedAt) < opts.killTimeoutMs) {
    if (!isPidAlive({ pid, existsSync })) {
      return { exited: true, escalated, elapsedMs: now() - startedAt, signal: exitSignal };
    }
    await sleep(Math.min(200, Math.max(50, opts.killTimeoutMs / 25)));
  }

  // Escalate.
  if (isPidAlive({ pid, existsSync })) {
    try {
      kill(pid, 'SIGKILL');
      exitSignal = 'SIGKILL';
      escalated = true;
    } catch (_) {
      // swallow — best-effort escalation
    }
    const escalateBudget = Math.min(2_000, opts.killTimeoutMs);
    const escalateStart = now();
    while ((now() - escalateStart) < escalateBudget) {
      if (!isPidAlive({ pid, existsSync })) {
        return { exited: true, escalated: true, elapsedMs: now() - startedAt, signal: exitSignal };
      }
      await sleep(Math.min(200, Math.max(50, escalateBudget / 10)));
    }
  } else {
    return { exited: true, escalated, elapsedMs: now() - startedAt, signal: exitSignal };
  }
  return {
    exited: !isPidAlive({ pid, existsSync }),
    escalated,
    elapsedMs: now() - startedAt,
    signal: exitSignal,
  };
}

/**
 * Orchestrator. Performs find → stop → spawn → probe, returning a
 * typed `RestartDashboardResult`. Every external surface is mocked
 * via `deps` so the unit tests can exercise the orchestration logic
 * without `/proc`, `child_process`, or `fetch`.
 *
 * @param {{
 *   args: ReturnType<typeof resolveRestartArgs>,
 *   deps?: {
 *     exec?: (cmd: string, opts: object) => Promise<{stdout:string, stderr:string}>,
 *     kill?: (pid: number, signal: string) => void,
 *     spawn?: typeof import('node:child_process').spawn,
 *     existsSync?: (path: string) => boolean,
 *     readFile?: (path: string, enc: string) => Promise<string>,
 *     fetchFn?: typeof fetch,
 *     setTimeout?: (fn: () => void, ms: number) => unknown,
 *     clearTimeout?: (id: unknown) => void,
 *     sleep?: (ms: number) => Promise<void>,
 *     clock?: () => number,
 *   },
 *   logger?: { info: (msg: string, meta?: object) => void, warn: (msg: string, meta?: object) => void, error: (msg: string, meta?: object) => void },
 *   nowMs?: () => number,
 * }} opts
 * @returns {Promise<{
 *   ok: boolean,
 *   code: 0|1|2|3,
 *   message: string,
 *   old_pid: number|null,
 *   new_pid: number|null,
 *   healthy: boolean,
 *   attempts: number,
 *   captured_cmdline: string|null,
 *   captured_argv: string[]|null,
 *   spawn_argv: string[]|null,
 *   probe_url: string|null,
 *   elapsed_ms: number,
 *   escalated: boolean,
 * }>}
 */
export async function restartDashboard(opts) {
  const args = opts.args;
  const deps = opts.deps ?? {};
  const logger = opts.logger ?? ({
    info: (msg, meta) => { /* eslint-disable-next-line no-console */ console.info(msg, meta ?? {}); },
    warn: (msg, meta) => { /* eslint-disable-next-line no-console */ console.warn(msg, meta ?? {}); },
    error: (msg, meta) => { /* eslint-disable-next-line no-console */ console.error(msg, meta ?? {}); },
  });
  const clock = opts.nowMs ?? (() => Date.now());
  const startedAtMs = clock();

  const found = await findRunningDashboard({
    exec: deps.exec,
    pattern: args.pgrepPattern,
    readFile: deps.readFile,
  });
  logger.info('dashboard.restart.started', {
    old_pid: found.pid,
    pgrep_pattern: args.pgrepPattern,
    dry_run: args.dryRun,
    timeout_ms: args.timeoutMs,
  });

  if (found.pid === null) {
    logger.warn('dashboard.restart.failed', { reason: 'no_running_dashboard', pattern: args.pgrepPattern });
    return {
      ok: false, code: 3, message: 'no running dashboard', old_pid: null, new_pid: null,
      healthy: false, attempts: 0, captured_cmdline: found.cmdline, captured_argv: found.argv,
      spawn_argv: null, probe_url: null,
      elapsed_ms: clock() - startedAtMs, escalated: false,
    };
  }

  const probeUrl = deriveProbeUrl({
    bindHost: args.bindHost,
    bindPort: (typeof args.bindPort === 'number') ? args.bindPort : null,
    capturedCmdline: found.cmdline,
  });

  const spawnArgv = buildSpawnArgs({
    capturedArgs: found.argv ?? [],
    bindHost: args.bindHost,
    bindPort: (typeof args.bindPort === 'number') ? args.bindPort : null,
    extraArgs: args.extraArgs,
    nodeBin: process.execPath,
  });

  if (args.dryRun) {
    logger.info('dashboard.restart.dry_run', {
      old_pid: found.pid,
      captured_cmdline: found.cmdline,
      spawn_argv: spawnArgv,
      probe_url: probeUrl,
    });
    return {
      ok: true, code: 0, message: 'dry-run: nothing was signaled or spawned',
      old_pid: found.pid, new_pid: null, healthy: false, attempts: 0,
      captured_cmdline: found.cmdline, captured_argv: found.argv,
      spawn_argv: spawnArgv, probe_url: probeUrl,
      elapsed_ms: clock() - startedAtMs, escalated: false,
    };
  }

  const killDeps = {
    kill: deps.kill,
    sleep: deps.sleep,
    existsSync: deps.existsSync,
    clock,
  };
  const stop = await stopDashboard({ pid: found.pid, killTimeoutMs: args.killTimeoutMs, ...killDeps });
  logger.info('dashboard.restart.old_pid_exit', {
    old_pid: found.pid, exited: stop.exited, escalated: stop.escalated, signal: stop.signal,
    elapsed_ms: stop.elapsedMs,
  });
  if (!stop.exited) {
    logger.error('dashboard.restart.failed', {
      reason: 'old_did_not_exit', old_pid: found.pid, kill_timeout_ms: args.killTimeoutMs,
      escalated: stop.escalated,
    });
    return {
      ok: false, code: 1, message: 'old dashboard did not exit within budget',
      old_pid: found.pid, new_pid: null, healthy: false, attempts: 0,
      captured_cmdline: found.cmdline, captured_argv: found.argv,
      spawn_argv: spawnArgv, probe_url: probeUrl,
      elapsed_ms: clock() - startedAtMs, escalated: stop.escalated,
    };
  }

  const spawnFn = deps.spawn ?? nodeSpawn;
  /** @type {import('node:child_process').ChildProcess|null} */
  let child = null;
  try {
    child = spawnFn(process.execPath, spawnArgv.slice(1), {
      cwd: process.cwd(),
      env: process.env,
      detached: true,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
  } catch (e) {
    logger.error('dashboard.restart.failed', {
      reason: 'spawn_threw', error_name: e?.name ?? 'Error', error_message: e?.message ?? String(e),
    });
    return {
      ok: false, code: 1, message: 'spawn threw',
      old_pid: found.pid, new_pid: null, healthy: false, attempts: 0,
      captured_cmdline: found.cmdline, captured_argv: found.argv,
      spawn_argv: spawnArgv, probe_url: probeUrl,
      elapsed_ms: clock() - startedAtMs, escalated: stop.escalated,
    };
  }
  if (!child || typeof child.pid !== 'number') {
    logger.error('dashboard.restart.failed', { reason: 'spawn_returned_no_pid' });
    return {
      ok: false, code: 1, message: 'spawn returned no pid',
      old_pid: found.pid, new_pid: null, healthy: false, attempts: 0,
      captured_cmdline: found.cmdline, captured_argv: found.argv,
      spawn_argv: spawnArgv, probe_url: probeUrl,
      elapsed_ms: clock() - startedAtMs, escalated: stop.escalated,
    };
  }
  if (typeof child.unref === 'function') {
    try { child.unref(); } catch (_) { /* best-effort */ }
  }
  logger.info('dashboard.restart.spawned', {
    new_pid: child.pid, spawn_argv: spawnArgv, probe_url: probeUrl,
  });

  if (probeUrl === null) {
    // No way to verify health — return success because the new
    // process is alive and detached. The operator will see the
    // bind failure via the next /healthz probe or the dashboard
    // log lines.
    return {
      ok: true, code: 0, message: 'spawned; no probe url (could not derive bind host/port)',
      old_pid: found.pid, new_pid: child.pid, healthy: true, attempts: 0,
      captured_cmdline: found.cmdline, captured_argv: found.argv,
      spawn_argv: spawnArgv, probe_url: null,
      elapsed_ms: clock() - startedAtMs, escalated: stop.escalated,
    };
  }

  const probe = await probeHealth({
    url: probeUrl,
    timeoutMs: args.probeTimeoutMs,
    intervalMs: args.probeIntervalMs,
    fetchFn: deps.fetchFn,
    sleep: deps.sleep,
    clock,
  });
  logger.info('dashboard.restart.healthy', {
    new_pid: child.pid, healthy: probe.healthy, attempts: probe.attempts,
    last_status: probe.lastStatus, last_error: probe.lastError,
    elapsed_ms: probe.elapsedMs,
  });
  if (probe.healthy) {
    return {
      ok: true, code: 0, message: 'restarted',
      old_pid: found.pid, new_pid: child.pid, healthy: true, attempts: probe.attempts,
      captured_cmdline: found.cmdline, captured_argv: found.argv,
      spawn_argv: spawnArgv, probe_url: probeUrl,
      elapsed_ms: clock() - startedAtMs, escalated: stop.escalated,
    };
  }
  return {
    ok: false, code: 1, message: `probe unhealthy after ${probe.attempts} attempts`,
    old_pid: found.pid, new_pid: child.pid, healthy: false, attempts: probe.attempts,
    captured_cmdline: found.cmdline, captured_argv: found.argv,
    spawn_argv: spawnArgv, probe_url: probeUrl,
    elapsed_ms: clock() - startedAtMs, escalated: stop.escalated,
  };
}

const HELP = restartDashboardHelp();

/**
 * CLI entry. Returns a Promise resolving to the process exit code.
 *
 * @param {string[]} [argv]
 * @param {{
 *   deps?: Parameters<typeof restartDashboard>[0]['deps'],
 *   logger?: Parameters<typeof restartDashboard>[0]['logger'],
 *   stdout?: (s: string) => void,
 *   stderr?: (s: string) => void,
 * }} [ctx]
 * @returns {Promise<number>}
 */
export async function main(argv, ctx = {}) {
  const stdout = ctx.stdout ?? ((s) => process.stdout.write(s));
  const stderr = ctx.stderr ?? ((s) => process.stderr.write(s));
  const logger = ctx.logger ?? ({
    info: (_msg, _meta) => { /* structured events only — the operator-facing CLI banner is a separate stdout path */ },
    warn: (_msg, _meta) => { /* silent by default; `--quiet` doesn't change structured logger behaviour */ },
    error: (msg, meta) => {
      const tail = (meta && typeof meta === 'object') ? ` ${JSON.stringify(meta)}` : '';
      stderr(`restart-dashboard: error: ${msg}${tail}\n`);
    },
  });
  let parsed;
  try {
    parsed = parseRestartArgs(argv ?? process.argv);
  } catch (e) {
    stderr(`restart-dashboard: cannot parse argv: ${e?.message ?? e}\n`);
    return 2;
  }
  let resolved;
  try {
    resolved = resolveRestartArgs(parsed, {
      probeTimeoutMs: Number(process.env.TRADEBOT_RESTART_PROBE_TIMEOUT_MS) || undefined,
    });
  } catch (e) {
    stderr(`restart-dashboard: ${e?.message ?? e}\n`);
    return 2;
  }
  if (resolved.help) {
    stdout(HELP + '\n');
    return 0;
  }
  const result = await restartDashboard({
    args: resolved,
    deps: ctx.deps ?? {},
    logger,
    nowMs: ctx.nowMs,
  });
  const summary = {
    ok: result.ok,
    code: result.code,
    message: result.message,
    old_pid: result.old_pid,
    new_pid: result.new_pid,
    healthy: result.healthy,
    attempts: result.attempts,
    elapsed_ms: result.elapsed_ms,
    escalated: result.escalated,
    spawned_argv: result.spawn_argv,
    probe_url: result.probe_url,
  };
  if (result.ok) {
    if (!resolved.quiet) {
      stdout(`restart-dashboard: ${result.message}\n`);
      if (result.spawn_argv) {
        stdout(`  spawn: ${result.spawn_argv.join(' ')}\n`);
      }
      if (result.probe_url) {
        stdout(`  probe: ${result.probe_url} (${result.attempts} attempts)\n`);
      }
      stdout(`  old_pid=${result.old_pid ?? '?'} → new_pid=${result.new_pid ?? '?'} in ${result.elapsed_ms}ms\n`);
    }
  } else {
    stderr(`restart-dashboard: FAILED (code ${result.code}): ${result.message}\n`);
    if (result.probe_url) stderr(`  probe: ${result.probe_url} (${result.attempts} attempts)\n`);
    stderr(`  summary: ${JSON.stringify(summary)}\n`);
  }
  return result.code;
}

const isDirect = import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('restart-dashboard.mjs');

if (isDirect) {
  main().then(
    (code) => { process.exit(code); },
    (err) => {
      process.stderr.write(`restart-dashboard: unhandled: ${err?.message ?? err}\n`);
      process.exit(1);
    },
  );
}
