#!/usr/bin/env node
/**
 * scripts/check-bot-stall.mjs
 *
 * Watchdog for the trading bot. Pure exit-code semantics so it can
 * be run from any scheduler (cron, systemd, OpenClaw agent turn,
 * manual). No Telegram bot token in here — the wrapper that
 * schedules this script decides how to alert.
 *
 * What it checks:
 *   1. The trading-bot process is alive (matching `scripts/run-bot.mjs`).
 *   2. `data/history.jsonl` was written within `STALL_THRESHOLD_MS`
 *      (default 5 min, override via env var).
 *
 * Exit codes:
 *   0  healthy — process alive AND history fresh
 *   1  stall    — process alive BUT history stale (the dangerous case:
 *                 the bot's main thread is wedged but the OS doesn't
 *                 know. Same class as the 2026-09-16 incident where
 *                 the loop logged `loop.tick.excluded_tokens` at
 *                 16:09:08 PDT and then nothing for 3h40m).
 *   2  gone     — bot process not running at all (cron can treat as
 *                 "needs restart" without alerting "stall").
 *
 * Usage:
 *   node scripts/check-bot-stall.mjs
 *   TRADEBOT_REPO=/path/to/repo STALL_THRESHOLD_MS=300000 node scripts/check-bot-stall.mjs
 *   node scripts/check-bot-stall.mjs --check-fn '{"ageMs":700000,"pid":29001}'  # for tests
 *
 * When called with `--check-fn '<json>'` the watchdog runs in TEST
 * mode: it skips the actual filesystem + process checks and just
 * evaluates the supplied {ageMs, pid, deadPid?} against the
 * threshold rules. Keeps the rule logic unit-testable without
 * needing `/proc` or writable fs.
 */

import { stat, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';

const execp = promisify(execCb);

/**
 * Pure predicate. Given the current observation {ageMs, pid, deadPid?},
 * return {code, message}. This is the rule the watchdog enforces and
 * is exported so tests can hit it without touching the filesystem.
 *
 * - code 0: healthy
 * - code 1: process alive but no heartbeat in STALL_THRESHOLD_MS
 * - code 2: no process
 *
 * @param {{ageMs: number|null, pid: number|null, deadPid?: boolean}} obs
 * @param {{stallMs: number}} cfg
 * @returns {{code: 0|1|2, message: string}}
 */
export function evaluateStall(obs, cfg) {
  const stallMs = (cfg && typeof cfg === 'object') ? (cfg.stallMs ?? 5 * 60_000) : 5 * 60_000;
  if (obs.deadPid === true || obs.pid === null || obs.pid === undefined) {
    return { code: 2, message: 'bot process not running' };
  }
  if (obs.ageMs === null || obs.ageMs === undefined) {
    return { code: 2, message: 'no history file yet' };
  }
  if (obs.ageMs > stallMs) {
    const ageSec = Math.round(obs.ageMs / 1000);
    const threshSec = Math.round(stallMs / 1000);
    return {
      code: 1,
      message: `history ${ageSec}s old (>${threshSec}s threshold); bot PID ${obs.pid} still alive \u2014 likely wedged`,
    };
  }
  return { code: 0, message: `healthy (last history ${Math.round(obs.ageMs / 1000)}s ago, pid ${obs.pid})` };
}

/**
 * Live-observation helper. Reads process state via /proc + file mtimes.
 * Returns the same shape `evaluateStall` consumes.
 *
 * @param {string} repoDir
 * @returns {Promise<{ageMs: number|null, pid: number|null, deadPid?: boolean}>}
 */
async function observeBotState(repoDir) {
  const historyFile = join(repoDir, 'data', 'history.jsonl');
  let ageMs = null;
  if (existsSync(historyFile)) {
    try {
      const st = await stat(historyFile);
      ageMs = Date.now() - st.mtimeMs;
    } catch (e) {
      ageMs = null;
    }
  } else {
    ageMs = null;
  }

  // Find the bot's PID. Prefer the recorded PID file if it exists,
  // fall back to pgrep. Either way, validate against /proc/<pid>/cmdline
  // so a reused PID that happens to be some other process doesn't
  // accidentally register as "bot alive".
  let pid = null;
  let deadPid = false;
  const pidFile = join(repoDir, 'data', 'run-bot.pid');
  if (existsSync(pidFile)) {
    try {
      const raw = (await readFile(pidFile, 'utf8')).trim();
      const candidate = Number(raw);
      if (Number.isFinite(candidate) && candidate > 0) {
        if (await isBotProcess(candidate)) {
          pid = candidate;
        } else {
          pid = candidate;
          deadPid = true;
        }
      }
    } catch (_) {
      // ignore — fall through to pgrep
    }
  }
  if (pid === null) {
    try {
      const { stdout } = await execp(
        "pgrep -fa 'node scripts/run-bot.mjs' | grep -v '/bin/bash' | head -1",
        { timeout: 5000 },
      );
      const line = stdout.trim().split(/\s+/);
      if (line.length > 0) {
        const candidate = Number(line[0]);
        if (Number.isFinite(candidate) && candidate > 0 && await isBotProcess(candidate)) {
          pid = candidate;
        }
      }
    } catch (_) {
      // pgrep exit 1 = no match; treat as gone
    }
  }

  return ageMs === null && pid === null
    ? { ageMs: null, pid: null, deadPid: true }
    : { ageMs, pid, deadPid };
}

/**
 * Verify pid resolves to a process whose cmdline points back at
 * `scripts/run-bot.mjs` (defends against PID reuse after a crash).
 *
 * @param {number} pid
 * @returns {Promise<boolean>}
 */
async function isBotProcess(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  const cmdlinePath = `/proc/${pid}/cmdline`;
  if (!existsSync(cmdlinePath)) return false;
  try {
    const raw = await readFile(cmdlinePath, 'utf8');
    // /proc/<pid>/cmdline is NUL-separated. Replace NULs to make it grep-able.
    return raw.includes('scripts/run-bot.mjs');
  } catch (_) {
    return false;
  }
}

const isDirect = import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('check-bot-stall.mjs');

if (isDirect) {
  const args = process.argv.slice(2);
  const testIdx = args.indexOf('--check-fn');
  const stallMs = Number(process.env.STALL_THRESHOLD_MS) || 5 * 60_000;

  let obs;
  if (testIdx !== -1) {
    // Test mode: synthesize the observation from JSON, skip fs/proc reads.
    obs = JSON.parse(args[testIdx + 1]);
  } else {
    const repoDir = process.env.TRADEBOT_REPO || process.cwd();
    obs = await observeBotState(repoDir);
  }

  const result = evaluateStall(obs, { stallMs });
  const envelope = {
    code: result.code,
    message: result.message,
    observation: {
      pid: obs.pid,
      deadPid: obs.deadPid === true,
      ageMs: obs.ageMs === null ? null : Math.round(obs.ageMs / 1000) * 1000,
    },
    threshold_ms: stallMs,
    checked_at: new Date().toISOString(),
  };
  process.stdout.write(JSON.stringify(envelope) + '\n');
  process.exit(result.code);
}

// not exported when imported as a library (keeps the test-only API clean)
export { isBotProcess, observeBotState };
