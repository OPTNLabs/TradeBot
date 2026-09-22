#!/usr/bin/env node
// src/alerts/index.mjs
//
// T53.1 — barrel + factory for the alerts subsystem. Mirrors
// `src/dex/index.mjs` shape (since the operator's "consistency
// across the typed-envelope subsystems" convention is the same).
//
// Re-exports the public surface of:
//   - `router.mjs`        — AlertRouter + normalize + severity helpers
//   - `channels/noop.mjs`     — noop adapter
//   - `channels/console.mjs`  — structured-log adapter
//   - `channels/telegram.mjs` — Telegram Bot API adapter
//   - `persist.mjs`       — NDJSON writer + factory + noop (T53.2)
//
// Also exposes `createConfiguredAlertRouter(cfg, deps?)` — the
// production-shape factory the trader loop will call in T53.2:
// it reads `alerts.*` config knobs (via `resolveAlertsConfig`) and
// wires the channels accordingly.
//
// Origin: T53 (operator-filed via
// `data/feature-ideas.json#idea_seed_structured_alerts`).

export {
  createAlertRouter,
  getDefaultAlertRouter,
  resolveAlertsConfig,
  normalizeAlertEvent,
  buildDedupeKey,
  compareSeverity,
  isValidSeverity,
  _resetDefaultAlertRouter,
} from './router.mjs';

export { createNoopChannel } from './channels/noop.mjs';
export { createConsoleChannel } from './channels/console.mjs';
export {
  createTelegramChannel,
  formatTelegramMessage,
  escapeMarkdownV2,
} from './channels/telegram.mjs';

export {
  ORPHAN_POSITION_ALERT_KIND,
  ORPHAN_FINDING_KIND,
  ORPHAN_FINDING_SEVERITY,
  isOrphanFinding,
  computeOrphanAgeMs,
  buildOrphanAlertEvent,
  mapFindingsToOrphanAlerts,
  dispatchOrphanAlerts,
  indexOpenPositionsById,
  pickOrphanPositions,
} from './orphan-position.mjs';

export {
  appendAlertEvent,
  createAlertsAppender,
  createNoopAlertsAppender,
  readAlertsLog,
  DEFAULT_ALERTS_LOG_FILE,
} from './persist.mjs';

import { createAlertRouter, resolveAlertsConfig } from './router.mjs';
import { createConsoleChannel } from './channels/console.mjs';
import { createNoopChannel } from './channels/noop.mjs';
import { createTelegramChannel } from './channels/telegram.mjs';

/**
 * @typedef {Object} CreateConfiguredAlertRouterOpts
 * @property {Object} [deps]            Injected overrides; tests pass mocks here.
 * @property {typeof globalThis.fetch} [deps.fetchImpl]            Network impl for telegram.
 * @property {{write: (s: string) => boolean}} [deps.sink]          Sink for the console channel.
 * @property {() => number} [deps.nowMs]                            Clock seam (tests).
 * @property {(record: Object) => void} [deps.logger]              Router logger seam (tests).
 */

/**
 * Build an AlertRouter pre-wired from the operator's `alerts.*`
 * config block. `cfg` may be the full TradeBot config or just the
 * `alerts` block — we resolve via `resolveAlertsConfig` either way.
 *
 * Default behavior (no overrides): when `alerts.enabled === false`
 * (the shipped default) the router is constructed with a single
 * noop channel so the trader loop's `dispatch()` calls are
 * guaranteed cheap + side-effect-free until the operator opts in.
 *
 * @param {Object} cfg
 * @param {CreateConfiguredAlertRouterOpts} [opts]
 */
export function createConfiguredAlertRouter(cfg, opts = {}) {
  const alertsCfg = resolveAlertsConfig(cfg);
  const channels = [];
  const requested = Array.isArray(alertsCfg.channels) ? alertsCfg.channels : ['console'];
  const deps = (opts && typeof opts === 'object') ? opts.deps || {} : {};
  for (const id of requested) {
    if (id === 'console') {
      channels.push(createConsoleChannel({
        sink: deps.sink || null,
        min_severity: alertsCfg.console_min_severity,
      }));
    } else if (id === 'telegram') {
      const telegramCfg = (cfg && typeof cfg === 'object' && cfg.telegram) || {};
      channels.push(createTelegramChannel({
        bot_token: telegramCfg.bot_token ?? null,
        chat_id: alertsCfg.telegram_chat_id,
        min_severity: alertsCfg.telegram_min_severity,
        fetchImpl: deps.fetchImpl,
        nowMs: deps.nowMs,
      }));
    } else if (id === 'noop') {
      channels.push(createNoopChannel({ min_severity: alertsCfg.noop_min_severity }));
    } else {
      // Unknown channel id — skip silently. The router tolerates
      // misconfiguration: a typo in `alerts.channels` shouldn't
      // crash the loop. ResolveAlertsConfig already filters non-
      // strings, so this only fires on typo'd strings.
    }
  }
  // If `alerts.enabled === false`, prepend a single noop channel
  // so dispatched events become deterministic no-ops with zero
  // network or stdout writes.
  if (alertsCfg.enabled === false) {
    // Reset any channels we built — the operator has explicitly
    // disabled alerts and we want dispatch() to be a true noop.
    channels.length = 0;
    channels.push(createNoopChannel({ min_severity: 'info', id: 'noop-disabled' }));
  }
  return createAlertRouter({
    channels,
    dedup_window_ms: alertsCfg.dedup_window_ms,
    nowMs: deps.nowMs,
    logger: deps.logger,
  });
}
