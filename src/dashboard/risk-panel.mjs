// src/dashboard/risk-panel.mjs
//
// Pure helpers for the Dashboard's "live risk panel" widget
// (TODO.md T41). Aggregates the four risk dimensions the operator
// needs to see at a glance before the bot trips a gate:
//
//   1. exposure   — total BCH currently locked in non-closed positions
//                   vs `cfg.entry.max_total_exposure_bch`.
//   2. daily_loss — sum of realized P&L from positions closed inside
//                   the daily-loss lookback window (default 24h),
//                   compared to `-cfg.risk.max_daily_loss_bch`.
//   3. drawdown   — peak balance in the lookback window vs current
//                   balance (from the latest snapshot, with the live
//                   wallet balance as a tiebreaker when wired).
//   4. concentration — top open positions ranked by BCH committed,
//                      with their share of total exposure AND of the
//                      current wallet balance so the operator can
//                      spot a single position about to swallow the
//                      whole wallet.
//
// Plus a pass-through of the circuit-breaker state (when wired)
// so the panel doubles as the "is the bot currently sidelined?"
// indicator.
//
// All entry points are PURE except for the `buildRiskPanel(ctx)`
// I/O wrapper at the bottom — the dashboard server feeds it the
// already-loaded positions / snapshots / risk / cfg, and it just
// calls the pure helpers and shapes the wire envelope.
//
// Wire shape (consumed by `dashboard/src/views/risk-panel-helpers.mjs`):
//
//   {
//     schema: 'tradebot.dashboard.risk-panel/v1',
//     ts: <iso>,
//     exposure: {
//       current_bch: <number>,
//       max_bch: <number|null>,
//       utilization: <0..1>,
//       open_position_count: <number>,
//       headroom_bch: <number>,
//     },
//     daily_loss: {
//       lookback_hours: <number>,
//       realized_pnl_sats: <bigint-as-string>,
//       realized_pnl_bch: <number>,
//       max_loss_bch: <number|null>,
//       threshold_bch: <number|null>,   // = -max_loss_bch when configured
//       limit_breached: <boolean>,
//     },
//     drawdown: {
//       window_days: <number>,
//       peak_balance_sats: <bigint-as-string>,
//       peak_balance_bch: <number>,
//       peak_ts: <iso|null>,
//       current_balance_sats: <bigint-as-string>,
//       current_balance_bch: <number>,
//       drawdown_sats: <bigint-as-string>,
//       drawdown_bch: <number>,
//       drawdown_pct: <number>,
//     },
//     concentration: {
//       total_exposure_bch: <number>,
//       wallet_balance_bch: <number|null>,
//       top_positions: [
//         {
//         position_id, token_id, token_symbol,
//         bch_spent_bch, pct_of_exposure, pct_of_wallet,
//         entry_ts, age_hours,
//         }
//       ],
//     },
//     circuit_breaker: { /* passthrough of risk.state() */ } | null,
//   }

import { computeOpenExposureBch, computeExposureByToken } from '../portfolio/positions.mjs';
import { SATS_PER_BCH } from '../data/types.mjs';
import { realizedPnlSats, toSats } from '../portfolio/pnl.mjs';

export class RiskPanelError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'RiskPanelError';
    if (opts.cause) this.cause = opts.cause;
  }
}

export class RiskPanelConfigError extends RiskPanelError {
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = 'RiskPanelConfigError';
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Pure helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Read a config value out of a possibly-nested config object,
 * tolerating undefined / null / non-numeric / non-finite. Used
 * by the `max_total_exposure_bch` / `max_daily_loss_bch` /
 * `min_wallet_balance_bch` reads — these knobs are operator-set
 * and may legitimately be missing during a bot restart in
 * mid-tick. When the value is missing or invalid we return
 * `null` (NOT 0 — the dashboard needs to know "no limit is
 * configured" vs "limit is configured at 0").
 *
 * @param {unknown} raw
 * @returns {number|null}
 */
export function readConfigNumber(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'bigint') return Number(raw);
  if (typeof raw === 'string' && raw.length > 0) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Compute the dashboard's "exposure" tile. Pure — exported for
 * tests.
 *
 * @param {Array<Object>} openPositions
 * @param {Object} cfg
 * @returns {{
 *   current_bch: number,
 *   max_bch: number|null,
 *   utilization: number,        // 0..1; null when max_bch === null
 *   open_position_count: number,
 *   headroom_bch: number|null,  // null when max_bch === null
 * }}
 */
export function buildExposure(openPositions, cfg) {
  const safePositions = Array.isArray(openPositions) ? openPositions : [];
  const currentBch = computeOpenExposureBch(safePositions);
  const maxBch = readConfigNumber(cfg?.entry?.max_total_exposure_bch);
  const utilization = (maxBch !== null && maxBch > 0)
    ? Math.min(1, Math.max(0, currentBch / maxBch))
    : null;
  const headroomBch = maxBch === null ? null : Math.max(0, maxBch - currentBch);
  return {
    current_bch: currentBch,
    max_bch: maxBch,
    utilization,
    open_position_count: safePositions.length,
    headroom_bch: headroomBch,
  };
}

/**
 * Compute the dashboard's "daily loss" tile. Sums the realized
 * P&L of every position that closed inside the lookback window
 * (default 24h). Pure — exported for tests.
 *
 * The position's `closed_at` field drives the window check; if
 * missing or unparseable, we fall back to the position's
 * `exit.ts` field. A position with neither field is skipped
 * (conservative — we can't tell whether it counts toward the
 * daily-loss budget or not).
 *
 * @param {Array<Object>} closedPositions
 * @param {Object} cfg
 * @param {number} [lookbackHours=24]
 * @param {number} [nowMs=Date.now()]
 * @returns {{
 *   lookback_hours: number,
 *   realized_pnl_sats: bigint,
 *   realized_pnl_bch: number,
 *   max_loss_bch: number|null,
 *   threshold_bch: number|null,    // = -max_loss_bch when configured
 *   limit_breached: boolean,
 *   contributing_positions: number,
 * }}
 */
export function buildDailyLoss(closedPositions, cfg, lookbackHours = 24, nowMs = Date.now()) {
  const safeClosed = Array.isArray(closedPositions) ? closedPositions : [];
  const lookbackMs = (Number.isFinite(lookbackHours) && lookbackHours > 0)
    ? Math.round(lookbackHours * 60 * 60 * 1000)
    : 24 * 60 * 60 * 1000;
  const cutoffMs = (Number.isFinite(nowMs) ? nowMs : Date.now()) - lookbackMs;

  let totalSats = 0n;
  let contributing = 0;
  for (const p of safeClosed) {
    if (!p || typeof p !== 'object') continue;
    const exitTs = Date.parse(p?.closed_at ?? '') || Date.parse(p?.exit?.ts ?? '');
    if (!Number.isFinite(exitTs)) continue;
    if (exitTs < cutoffMs) continue;
    const pnl = realizedPnlSats(p, p?.exit ?? {});
    if (pnl.net === null) continue;
    totalSats += pnl.net;
    contributing += 1;
  }
  const maxLossBch = readConfigNumber(cfg?.risk?.max_daily_loss_bch);
  // Threshold = -max_loss_bch. The T13 circuit breaker trips when
  // realizedDailyPnlSats < -max_daily_loss_bch, which is the same
  // arithmetic the dashboard now mirrors. Treat 0 / negative as
  // "operator opted out" (same opt-out pattern as T32/T33) so the
  // dashboard doesn't false-positive on a misconfigured zero.
  const thresholdBch = (maxLossBch !== null && maxLossBch > 0) ? -maxLossBch : null;
  const limitBreached = thresholdBch !== null
    && totalSats < BigInt(Math.round(thresholdBch * SATS_PER_BCH));
  return {
    lookback_hours: Math.round(lookbackMs / (60 * 60 * 1000)),
    realized_pnl_sats: totalSats,
    realized_pnl_bch: Number(totalSats) / SATS_PER_BCH,
    max_loss_bch: maxLossBch,
    threshold_bch: thresholdBch,
    limit_breached: limitBreached,
    contributing_positions: contributing,
  };
}

/**
 * Compute the dashboard's "drawdown" tile. Pure — exported for
 * tests. Scans the snapshot history backwards from `nowMs` for
 * `windowDays`, finds the peak balance, and subtracts the current
 * balance. If `currentBalanceSats` is omitted, the latest snapshot's
 * balance is used (which may be a few minutes stale but is the only
 * value available when the wallet isn't wired into the dashboard).
 *
 * @param {Array<Object>} snapshots          full snapshot list (asc by ts)
 * @param {Object} cfg
 * @param {number} [windowDays=30]
 * @param {number} [nowMs=Date.now()]
 * @param {bigint|number|null} [currentBalanceSats=null]  override (live wallet)
 * @returns {{
 *   window_days: number,
 *   peak_balance_sats: bigint,
 *   peak_balance_bch: number,
 *   peak_ts: string|null,
 *   current_balance_sats: bigint,
 *   current_balance_bch: number,
 *   drawdown_sats: bigint,
 *   drawdown_bch: number,
 *   drawdown_pct: number,
 * }}
 */
export function buildDrawdown(snapshots, cfg, windowDays = 30, nowMs = Date.now(), currentBalanceSats = null) {
  const safeSnapshots = Array.isArray(snapshots) ? snapshots : [];
  const safeNow = Number.isFinite(nowMs) ? nowMs : Date.now();
  const windowMs = (Number.isFinite(windowDays) && windowDays > 0)
    ? Math.round(windowDays * 24 * 60 * 60 * 1000)
    : 30 * 24 * 60 * 60 * 1000;
  const cutoffMs = safeNow - windowMs;

  let peakSats = 0n;
  let peakTs = null;
  /** @type {Array<Object>} */
  const inWindow = [];
  for (const s of safeSnapshots) {
    if (!s || typeof s !== 'object') continue;
    const ts = Date.parse(typeof s.ts === 'string' ? s.ts : '');
    if (!Number.isFinite(ts) || ts < cutoffMs) continue;
    inWindow.push(s);
    const bal = toSats(s?.bch_balance_sats);
    if (bal === null) continue;
    if (bal > peakSats || peakTs === null) {
      peakSats = bal;
      peakTs = s.ts ?? null;
    }
  }

  // Pick current balance: explicit override > latest snapshot > 0n.
  let currentSats;
  if (currentBalanceSats !== null && currentBalanceSats !== undefined) {
    currentSats = toSats(currentBalanceSats) ?? 0n;
  } else if (inWindow.length > 0) {
    const latest = inWindow[inWindow.length - 1];
    currentSats = toSats(latest?.bch_balance_sats) ?? 0n;
  } else {
    currentSats = 0n;
  }

  const drawdownSats = currentSats < peakSats ? peakSats - currentSats : 0n;
  const drawdownPct = peakSats > 0n
    ? (Number(drawdownSats) / Number(peakSats)) * 100
    : 0;
  return {
    window_days: Math.round(windowMs / (24 * 60 * 60 * 1000)),
    peak_balance_sats: peakSats,
    peak_balance_bch: Number(peakSats) / SATS_PER_BCH,
    peak_ts: peakTs,
    current_balance_sats: currentSats,
    current_balance_bch: Number(currentSats) / SATS_PER_BCH,
    drawdown_sats: drawdownSats,
    drawdown_bch: Number(drawdownSats) / SATS_PER_BCH,
    drawdown_pct: drawdownPct,
  };
}

/**
 * Compute the dashboard's "concentration" tile. Pure — exported
 * for tests. Ranks the open positions by `entry.bch_spent_sats`
 * descending, surfaces the top `topN` (default 5), and reports
 * each one's share of total exposure AND of the current wallet
 * balance (when provided).
 *
 * Positions with `entry.bch_spent_sats <= 0` (e.g. on-chain-synced
 * positions that bypassed `positions.open()`) are filtered out —
 * we can't compute a meaningful share without a cost basis.
 *
 * @param {Array<Object>} openPositions
 * @param {Object} cfg
 * @param {number} [topN=5]
 * @param {bigint|number|null} [walletBalanceSats=null]
 * @returns {{
 *   total_exposure_bch: number,
 *   wallet_balance_bch: number|null,
 *   top_positions: Array<{
 *     position_id: string|null,
 *     token_id: string|null,
 *     token_symbol: string|null,
 *     bch_spent_sats: bigint,
 *     bch_spent_bch: number,
 *     pct_of_exposure: number,
 *     pct_of_wallet: number|null,
 *     entry_ts: string|null,
 *     age_hours: number|null,
 *   }>,
 *   hidden_position_count: number,
 * }}
 */
export function buildConcentration(openPositions, cfg, topN = 5, walletBalanceSats = null) {
  const safePositions = Array.isArray(openPositions) ? openPositions : [];
  const safeTopN = (Number.isFinite(topN) && topN > 0) ? Math.floor(topN) : 5;
  const totalExposure = computeOpenExposureBch(safePositions);
  const totalSats = BigInt(Math.round(totalExposure * SATS_PER_BCH));
  const walletSats = toSats(walletBalanceSats);

  // Build a {token_id → exposure_bch} rollup so the concentration
  // tile can also show "FEW = X% of wallet" alongside the per-position
  // rows. Exported separately as `computeExposureByToken` but we
  // recompute here to avoid an extra import + to keep the module
  // self-contained for tests.
  const perToken = computeExposureByToken(safePositions);

  /** @type {Array<{ p: Object, sats: bigint }>} */
  const ranked = [];
  for (const p of safePositions) {
    if (!p || typeof p !== 'object') continue;
    const spent = toSats(p?.entry?.bch_spent_sats ?? p?.entry?.bch_spent);
    if (spent === null || spent <= 0n) continue;
    ranked.push({ p, sats: spent });
  }
  ranked.sort((a, b) => (b.sats > a.sats ? 1 : b.sats < a.sats ? -1 : 0));

  /** @type {ReturnType<typeof buildConcentration>['top_positions']} */
  const topPositions = [];
  let hiddenCount = 0;
  for (let i = 0; i < ranked.length; i += 1) {
    if (i >= safeTopN) { hiddenCount += 1; continue; }
    const { p, sats } = ranked[i];
    const pctOfExposure = totalSats > 0n
      ? (Number(sats) / Number(totalSats)) * 100
      : 0;
    const pctOfWallet = walletSats !== null && walletSats > 0n
      ? (Number(sats) / Number(walletSats)) * 100
      : null;
    const openedAt = typeof p?.opened_at === 'string' ? p.opened_at : null;
    const entryTs = typeof p?.entry?.ts === 'string' ? p.entry.ts : null;
    const tsStr = entryTs ?? openedAt;
    const tsMs = tsStr ? Date.parse(tsStr) : NaN;
    const ageHours = Number.isFinite(tsMs) ? (Date.now() - tsMs) / (60 * 60 * 1000) : null;
    topPositions.push({
      position_id: typeof p?.id === 'string' ? p.id : null,
      token_id: typeof p?.token_id === 'string' ? p.token_id : null,
      token_symbol: typeof p?.token_symbol === 'string' && p.token_symbol.length > 0 ? p.token_symbol : null,
      bch_spent_sats: sats,
      bch_spent_bch: Number(sats) / SATS_PER_BCH,
      pct_of_exposure: pctOfExposure,
      pct_of_wallet: pctOfWallet,
      entry_ts: tsStr,
      age_hours: ageHours,
    });
  }

  return {
    total_exposure_bch: totalExposure,
    wallet_balance_bch: walletSats === null ? null : Number(walletSats) / SATS_PER_BCH,
    top_positions: topPositions,
    hidden_position_count: hiddenCount,
    per_token_bch: perToken,
  };
}

/**
 * I/O wrapper. Reads positions + snapshots via the dashboard
 * server's already-wired `ctx.positions` / `ctx.snapshots` /
 * `ctx.wallet` / `ctx.risk` surfaces, then assembles the wire
 * envelope. Pure with respect to its inputs (no global state).
 *
 * @param {Object} ctx
 * @returns {Promise<Object>}
 */
export async function buildRiskPanel(ctx) {
  if (!ctx || typeof ctx !== 'object') {
    throw new RiskPanelConfigError('buildRiskPanel: ctx required');
  }
  const cfg = ctx.cfg ?? {};
  const nowMs = (typeof ctx.clock === 'function') ? ctx.clock() : Date.now();

  const openList = await ctx.positions.list('open');
  const pendingList = await ctx.positions.list('pending');
  const closingList = await ctx.positions.list('closing');
  const closedList = await ctx.positions.list('closed');
  const openPositions = [...openList, ...pendingList, ...closingList];

  // Pull the last 30d of snapshots for the drawdown tile. We use
  // a generous cap so the peak-detection has enough history on a
  // freshly-started bot (a single snapshot will return "drawdown
  // = 0", which is fine — no false alarms).
  const windowDays = 30;
  let snapshots = [];
  try {
    const { records } = await ctx.snapshots.readBack({ limit: 4000 });
    snapshots = records;
  } catch (e) {
    // Snapshot dir missing is normal on first run; we still build
    // the panel — the drawdown tile will read all-zeros.
    if (e && typeof e === 'object' && /** @type {any} */ (e).code !== 'ENOENT') {
      throw new RiskPanelError('buildRiskPanel: snapshot readBack failed', { cause: e });
    }
  }

  // Prefer the live wallet balance over the snapshot's balance
  // (right-now beats last-tick-by-several-minutes).
  let walletSats = null;
  if (ctx.wallet && typeof ctx.wallet.getBalanceSats === 'function') {
    try {
      walletSats = await ctx.wallet.getBalanceSats();
    } catch (e) {
      ctx.logger?.warn?.('dashboard.risk-panel.balance_failed', {
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
      });
    }
  }

  // Pass-through of the circuit-breaker state when wired (it's
  // optional — the trader loop owns the breaker, not the dashboard).
  let circuitBreaker = null;
  if (ctx.risk && typeof ctx.risk.state === 'function') {
    try {
      circuitBreaker = ctx.risk.state();
    } catch (e) {
      ctx.logger?.warn?.('dashboard.risk-panel.breaker_state_failed', {
        err_name: e?.name ?? 'Error',
        err_message: e?.message ?? String(e),
      });
    }
  }

  const exposure = buildExposure(openPositions, cfg);
  const dailyLoss = buildDailyLoss(closedList, cfg, 24, nowMs);
  const drawdown = buildDrawdown(snapshots, cfg, windowDays, nowMs, walletSats);
  const concentration = buildConcentration(openPositions, cfg, 5, walletSats);

  return {
    schema: 'tradebot.dashboard.risk-panel/v1',
    ts: new Date(nowMs).toISOString(),
    exposure,
    daily_loss: {
      lookback_hours: dailyLoss.lookback_hours,
      realized_pnl_sats: dailyLoss.realized_pnl_sats.toString(),
      realized_pnl_bch: dailyLoss.realized_pnl_bch,
      max_loss_bch: dailyLoss.max_loss_bch,
      threshold_bch: dailyLoss.threshold_bch,
      limit_breached: dailyLoss.limit_breached,
      contributing_positions: dailyLoss.contributing_positions,
    },
    drawdown: {
      window_days: drawdown.window_days,
      peak_balance_sats: drawdown.peak_balance_sats.toString(),
      peak_balance_bch: drawdown.peak_balance_bch,
      peak_ts: drawdown.peak_ts,
      current_balance_sats: drawdown.current_balance_sats.toString(),
      current_balance_bch: drawdown.current_balance_bch,
      drawdown_sats: drawdown.drawdown_sats.toString(),
      drawdown_bch: drawdown.drawdown_bch,
      drawdown_pct: drawdown.drawdown_pct,
    },
    concentration: {
      total_exposure_bch: concentration.total_exposure_bch,
      wallet_balance_bch: concentration.wallet_balance_bch,
      top_positions: concentration.top_positions.map((row) => ({
        position_id: row.position_id,
        token_id: row.token_id,
        token_symbol: row.token_symbol,
        bch_spent_sats: row.bch_spent_sats.toString(),
        bch_spent_bch: row.bch_spent_bch,
        pct_of_exposure: row.pct_of_exposure,
        pct_of_wallet: row.pct_of_wallet,
        entry_ts: row.entry_ts,
        age_hours: row.age_hours,
      })),
      hidden_position_count: concentration.hidden_position_count,
      per_token_bch: concentration.per_token_bch,
    },
    circuit_breaker: circuitBreaker,
  };
}

export const _internals = { readConfigNumber };