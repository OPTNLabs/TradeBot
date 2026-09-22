// dashboard/src/views/Dashboard.jsx
//
// DASHBOARD view — headline KPIs, balance-over-time chart, recent
// history events, and a live activity tail. All read-only.
//
// Data sources:
//   /api/summary   — realized + unrealized P&L, win rate, fees
//   /api/snapshots — balance-over-time chart (range: 30d default)
//   /api/history   — recent trade events (range: 7d default)
//   /api/activity  — last snapshot + last events (live tail)

import React, { useEffect, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts';

import { useApi, useRefresh } from '../lib/api-context.jsx';
import Panel from '../components/Panel.jsx';
import StakingStatusCard from '../components/StakingStatusCard.jsx';
import TokenHoldersCard from '../components/TokenHoldersCard.jsx';
import DustPositionsCard from '../components/DustPositionsCard.jsx';
import SnapshotStatsCard from '../components/SnapshotStatsCard.jsx';
import TokenSummaryCard from '../components/TokenSummaryCard.jsx';
import WalletReceiveCard from '../components/WalletReceiveCard.jsx';
import FeeBreakdownCard from '../components/FeeBreakdownCard.jsx';
import MetricsViewerCard from '../components/MetricsViewerCard.jsx';
import Kpi from '../components/Kpi.jsx';
import ErrorState from '../components/ErrorState.jsx';
import TokenBadge from '../components/TokenBadge.jsx';
import ChartRangePicker from '../components/ChartRangePicker.jsx';
import { formatBch, formatPct, formatSats, formatLocal, truncate, sideClass } from '../lib/format.mjs';
import {
  exposureSeverity,
  dailyLossSeverity,
  drawdownSeverity,
  severityClass,
  severityBarClass,
  severityBarPct,
  formatBchAmount,
  formatSatsAmount,
  formatPctSigned,
  utilizationPct,
  relativeTimeAgo,
  circuitBreakerSummary,
} from './risk-panel-helpers.mjs';
import {
  buildCumulativePnlBreakdown,
  kindLabel,
  pnlSourceLabel,
  shortReason,
  formatSignedBch,
} from './pnl-breakdown-helpers.mjs';
import {
  DEFAULT_CHART_RANGE,
  resolveChartRange,
} from './dashboard-range-helpers.mjs';

export default function Dashboard() {
  const { api } = useApi();
  const { tick, trigger } = useRefresh();

  const [summary, setSummary] = useState(/** @type {any} */ (null));
  const [snapshots, setSnapshots] = useState(/** @type {any} */ (null));
  const [history, setHistory] = useState(/** @type {any} */ (null));
  const [positions, setPositions] = useState(/** @type {any} */ (null));
  const [activity, setActivity] = useState(/** @type {any} */ (null));
  const [pnl, setPnl] = useState(/** @type {any} */ (null));
  const [riskPanel, setRiskPanel] = useState(/** @type {any} */ (null));
  const [err, setErr] = useState(/** @type {string|null} */ (null));

  // T51: per-chart date-range state for the two DASHBOARD time
  // series ("cumulative realized P&L" + "balance over time"). Each
  // chart exposes its own chip-group picker in the Panel header;
  // the selected value drives both the API request
  // (`?range=...`) and the chart's "range:" label so the operator
  // sees a consistent window everywhere. Default '30d' matches the
  // server's `snapshot_default_range` / `pnl_timeseries_default_range`
  // — the dashboard's first paint shows the same window the rest
  // of the dashboard defaults to. Resolved through
  // `resolveChartRange` so a corrupted URL state can't strand the
  // chart on an invalid range.
  const [pnlRange, setPnlRange] = useState(() => resolveChartRange(DEFAULT_CHART_RANGE));
  const [balanceRange, setBalanceRange] = useState(() => resolveChartRange(DEFAULT_CHART_RANGE));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setErr(null);
      const [s, snap, h, pos, act, p, rk] = await Promise.all([
        api.summary(),
        // T51: snapshots range driven by the operator-selected chip;
        // falls through to DEFAULT_CHART_RANGE on first render.
        api.snapshots({ range: balanceRange, limit: 500 }),
        api.history({ range: '7d', limit: 100 }),
        // T40 fix: positions (open + closed) is the trade-event
        // source for the balance-chart markers. The history
        // endpoint caps at 100 events and gets swamped by tick
        // noise; positions is a small, complete list.
        api.positions('all'),
        api.activity(100),
        // T39 + T51: cumulative realized P&L chart. Range is
        // operator-selected so the chart can show a longer view
        // (e.g. 90d, all) without forcing the rest of the
        // dashboard to widen its window too. The endpoint is cheap
        // (pure file read + cumulative math over closed positions).
        api.pnlTimeseries({ range: pnlRange, limit: 500 }),
        // T41: live risk panel (exposure, daily loss, drawdown,
        // concentration, breaker pass-through). One extra cheap
        // file read — the dashboard already touches every
        // positions.json / snapshots / circuit-breaker surface.
        api.riskPanel(),
      ]);
      if (cancelled) return;
      const errs = [s, snap, h, pos, act, p, rk].filter((r) => !r.ok);
      if (errs.length > 0) {
        setErr(errs[0].error || 'unknown');
      }
      setSummary(s.ok ? s.data : null);
      setSnapshots(snap.ok ? snap.data : null);
      setHistory(h.ok ? h.data : null);
      setPositions(pos.ok ? pos.data : null);
      setActivity(act.ok ? act.data : null);
      setPnl(p.ok ? p.data : null);
      setRiskPanel(rk.ok ? rk.data : null);
    })();
    return () => { cancelled = true; };
    // T51: re-fetch when the operator switches either chart's range.
    // Both ranges are part of the dep array so a chip click triggers
    // a single Promise.all batch (no duplicate fetches per change).
  }, [api, tick, pnlRange, balanceRange]);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold">Dashboard</h1>
          <p className="text-sm text-ash-300">
            Historical performance, P&amp;L, win rate, fees paid, balance over time.
          </p>
        </div>
        <button
          type="button"
          onClick={trigger}
          className="rounded border border-ink-600 px-3 py-1.5 text-xs font-mono uppercase tracking-wider text-ash-200 hover:bg-ink-800"
        >
          refresh
        </button>
      </div>

      {err && <ErrorState message={err} onRetry={trigger} />}

      <KpiGrid summary={summary} />

      <Panel
        title="live risk"
        action={<span className="font-mono text-[10px] uppercase tracking-wider">exposure · daily loss · drawdown · concentration</span>}
      >
        <RiskPanel riskPanel={riskPanel} />
      </Panel>

      <StakingStatusCard />

      <WalletReceiveCard />

      <Panel
        title="cumulative realized P&L"
        right={
          // T51: chip-group picker so the operator can widen or
          // narrow the chart window. `ariaLabel` distinguishes this
          // picker from the balance-chart picker in screen-reader
          // output. `pnlRange` is the canonical state value (a
          // curated preset); the chart consumes the same value when
          // rendering its "range:" label so the chip + label never
          // disagree.
          <ChartRangePicker
            value={pnlRange}
            onChange={setPnlRange}
            ariaLabel="cumulative P&L date range"
          />
        }
      >
        <CumulativePnlChart pnl={pnl} selectedRange={pnlRange} />
      </Panel>

      <Panel
        title="balance over time"
        right={
          // T51: same picker, independent state from the P&L
          // chart — the operator can show a 7d P&L alongside a
          // 90d balance view without either resetting the other.
          <ChartRangePicker
            value={balanceRange}
            onChange={setBalanceRange}
            ariaLabel="balance chart date range"
          />
        }
      >
        <BalanceChart snapshots={snapshots} positions={positions} selectedRange={balanceRange} />
      </Panel>

      {/* T65: snapshot aggregate stats bar — renders below the balance
           chart so the operator sees min/max/mean/latest + drawdown
           without scrolling. Self-fetches via api.snapshotStats();
           the server-side TTL cache keeps polling cheap. */}
      <SnapshotStatsCard />

      {/* T68: per-token P&L attribution — consumes the
           /api/tokens/summary endpoint (shipped in T63 subset 1) so
           the operator can finally answer "what did the bot do with
           token X" without grepping data/history.jsonl. Rollup
           view by default; click a row to drill down to the
           per-token closed_trades[] + open_positions[] attribution. */}
      <TokenSummaryCard />

      {/* T71: per-token fee breakdown with LP / tx / slippage
           split. Consumes the /api/fees/breakdown endpoint shipped
           in T71 subset 1. The operator can finally see fee
           COMPOSITION (not just realized P&L net of fees): a
           per-token rollup with color-coded share pills
           (red > 50%, amber 25-50%, green < 25%) so the answer
           to "is my slippage cost eating my LP fees?" is at
           a glance. Click a row → drill-down into the
           per-trade attribution. */}
      <FeeBreakdownCard />

      {/* T79 subset 2: Prometheus-style `/metrics` viewer
           tile. Renders the most recent /metrics scrape as a
           collapsible grouped table (one section per metric
           prefix: `tradebot_loop_*`, `tradebot_token_*`, etc.)
           with a header chip showing total series / samples /
           `tradebot_up` / last-tick count. Subscribes to
           `useRefresh().tick` so the tile re-renders at the
           dashboard's 60s auto-refresh cadence. The raw
           Prometheus text is always accessible behind a
           toggle for grep-friendly inspection. */}
      <MetricsViewerCard />

      {/* T76 subset 2c: token holder-concentration tile. Consumes
           the /api/token/:tokenId/holders endpoint (subset 1 stub
           + subset 2a live wire + subset 2c ?refresh=true cache
           flush). The operator can now SEE the rug-pattern +
           top-N concentration + cache badge for any token —
           a paste-token_id + lookup lands them in the detail view
           with the header card (top-N % / rug pattern / source /
           cache age / total supply / total holders) + the
           per-holder table below. The "Refresh" button bypasses
           the scanner cache via ?refresh=true so the operator
           can audit upstream changes without waiting for TTL. */}
      <TokenHoldersCard />

      {/* T88: dust-position tile. Consumes /api/positions/dust
           (shipped in T88 subset 1) which runs the same
           findDustPositions math the trader loop uses on every
           tick. The tile surfaces (a) which open positions the
           bot WOULD auto-close if risk.dust_position_auto_close_enabled
           is on, (b) which were skipped (operator prevent_stop_loss
           override / on-chain-sync source / no live AMM price),
           (c) a copy-to-clipboard config snippet when the knob
           is off so the operator can flip it on without reading
           the docs. Subscribes to useRefresh().tick for the
           dashboard's 60s auto-refresh cadence. */}
      <DustPositionsCard />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Panel title="recent history (7d)">
          <HistoryTable history={history} />
        </Panel>
        <Panel title="live activity">
          <ActivityFeed activity={activity} />
        </Panel>
      </div>
    </div>
  );
}

function KpiGrid(props) {
  const s = props.summary;
  if (!s) return <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5"><KpiSkeleton /></div>;
  const r = s.realized || {};
  const b = s.balance || {};
  const u = s.unrealized || {};
  const c = s.config || {};
  const best = s.best_trade;
  const worst = s.worst_trade;
  // Build the best/worst card subtitle from the closed-trade
  // position record. `best.position_id` is the runtime id (e.g.
  // pos_tlbiuvh6_0002); `best.token_symbol` is the friendly
  // display label. Falls back to truncated token_id when no
  // symbol is on the position record.
  const tradeSub = (trade) => {
    if (!trade || !trade.position_id) return 'no closed trades yet';
    const sym = (typeof trade.token_symbol === 'string' && trade.token_symbol.length > 0)
      ? trade.token_symbol
      : (typeof trade.token_id === 'string' ? `${trade.token_id.slice(0, 6)}…${trade.token_id.slice(-4)}` : 'unknown token');
    const when = (typeof trade.closed_at === 'string') ? ` · ${formatLocal(trade.closed_at)}` : '';
    return `${sym} · ${trade.position_id}${when}`;
  };
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
      <Kpi
        label="balance (BCH)"
        value={b.bch_balance === null || b.bch_balance === undefined ? '—' : formatBch(b.bch_balance_sats ?? Math.round(b.bch_balance * 1e8))}
        sub={b.source ? `from ${b.source}${b.last_snapshot_ts ? ` · ${formatLocal(b.last_snapshot_ts)}` : ''}` : 'awaiting first snapshot'}
      />
      <Kpi
        label="realized P&L"
        value={formatBch(r.realized_pnl_sats ?? 0)}
        pct={typeof r.pct_return === 'number' ? r.pct_return * 100 : null}
        sub={`${r.wins ?? 0}W / ${r.losses ?? 0}L · ${(r.win_rate_pct ?? 0).toFixed(1)}% win rate`}
      />
      <Kpi
        label="unrealized P&L"
        value={u.total_unrealized_sats === null || u.total_unrealized_sats === undefined ? '—' : formatBch(u.total_unrealized_sats)}
        sub={`${u.open_position_count ?? 0} open · ${u.pending_count ?? 0} pending · ${u.closing_count ?? 0} closing`}
      />
      <Kpi
        label="best trade"
        value={best && best.pnl_sats !== null && best.pnl_sats !== undefined ? formatBch(best.pnl_sats) : '—'}
        sub={tradeSub(best)}
        valueClass={best && Number(best.pnl_sats) > 0 ? 'text-pnl-win' : (best && Number(best.pnl_sats) < 0 ? 'text-pnl-loss' : null)}
      />
      <Kpi
        label="worst trade"
        value={worst && worst.pnl_sats !== null && worst.pnl_sats !== undefined ? formatBch(worst.pnl_sats) : '—'}
        sub={tradeSub(worst)}
        valueClass={worst && Number(worst.pnl_sats) < 0 ? 'text-pnl-loss' : (worst && Number(worst.pnl_sats) > 0 ? 'text-pnl-win' : null)}
      />
      <Kpi
        label="fees paid"
        value={formatBch(r.total_fees_sats ?? 0)}
        sub={`${r.count ?? 0} closed trades · mean hold ${(r.mean_hold_ms ?? 0).toFixed(0)}ms`}
      />
      <Kpi
        label="max position"
        value={c.max_position_bch === null || c.max_position_bch === undefined ? '—' : `${c.max_position_bch} BCH`}
        sub={c.tuning_preset ? `preset: ${c.tuning_preset}` : ''}
      />
      <Kpi
        label="slippage tolerance"
        value={c.slippage_tolerance_bps === null || c.slippage_tolerance_bps === undefined ? '—' : `${c.slippage_tolerance_bps} bps`}
        sub=""
      />
      <Kpi
        label="profit floor"
        value={c.min_realized_pnl_sats === null || c.min_realized_pnl_sats === undefined ? '—' : formatBch(c.min_realized_pnl_sats)}
        sub={(c.min_realized_pnl_enabled === false)
          ? 'disabled (per-trade opt-out)'
          : `time_stop extends by ${c.time_stop_extension_hours ?? '—'}h once if below`}
        valueClass={(c.min_realized_pnl_enabled === false) ? 'text-ash-400' : 'text-bch-400'}
      />
      <Kpi
        label="wallet floor"
        value={c.min_wallet_balance_bch === null || c.min_wallet_balance_bch === undefined ? '—' : `${c.min_wallet_balance_bch} BCH`}
        sub="always reserved"
      />
      <Kpi
        label="poll interval"
        value={c.poll_interval_seconds === null || c.poll_interval_seconds === undefined ? '—' : `${c.poll_interval_seconds}s`}
        sub=""
      />
    </div>
  );
}

function KpiSkeleton() {
  return (
    <>
      {Array.from({ length: 11 }).map((_, i) => (
        <div key={i} className="panel animate-pulse p-4">
          <div className="h-3 w-20 rounded bg-ink-700" />
          <div className="mt-2 h-6 w-32 rounded bg-ink-700" />
          <div className="mt-2 h-3 w-24 rounded bg-ink-700" />
        </div>
      ))}
    </>
  );
}

/**
 * T41: live risk panel widget. Reads the wire envelope from
 * `/api/risk-panel` and renders four risk dimensions in a single
 * responsive grid: exposure vs `max_total_exposure_bch`, daily
 * loss vs `-max_daily_loss_bch`, drawdown over the last 30d, and
 * the top-5 open positions by BCH committed. The
 * circuit-breaker pass-through surfaces as a header chip at the
 * top of the panel ("tripped: daily_loss" / "idle").
 *
 * Pure formatting lives in `./risk-panel-helpers.mjs` so the
 * helpers can be unit-tested under `node --test`.
 */
export function RiskPanel(props) {
  const rp = props.riskPanel;
  if (!rp || typeof rp !== 'object') {
    return (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="panel animate-pulse p-4">
            <div className="h-3 w-24 rounded bg-ink-700" />
            <div className="mt-2 h-5 w-32 rounded bg-ink-700" />
            <div className="mt-2 h-3 w-20 rounded bg-ink-700" />
          </div>
        ))}
      </div>
    );
  }
  const exposure = rp.exposure || {};
  const dl = rp.daily_loss || {};
  const dd = rp.drawdown || {};
  const conc = rp.concentration || {};
  const cb = rp.circuit_breaker;
  const cbSummary = circuitBreakerSummary(cb);

  const expSev = exposureSeverity(exposure.utilization);
  const dlSev = dailyLossSeverity(dl.realized_pnl_sats, dl.threshold_bch, dl.limit_breached === true);
  const ddSev = drawdownSeverity(dd.drawdown_pct);
  // Concentration severity: top position's pct-of-wallet. >50% = critical.
  const topPctOfWallet = (conc.top_positions && conc.top_positions[0]
    && typeof conc.top_positions[0].pct_of_wallet === 'number')
    ? conc.top_positions[0].pct_of_wallet
    : null;
  let concSev = 'ok';
  if (topPctOfWallet === null) concSev = 'unknown';
  else if (topPctOfWallet >= 50) concSev = 'critical';
  else if (topPctOfWallet >= 25) concSev = 'warn';
  else if (topPctOfWallet >= 15) concSev = 'caution';

  const expPct = (typeof exposure.utilization === 'number') ? exposure.utilization * 100 : null;
  // Daily loss pct is "fraction of the threshold that we've used up"
  // — lossSats / thresholdSats. A 0% realized (profit) is 0%, a -100%
  // realized (matched the threshold) is 100%.
  let dlPct = 0;
  if (dl.realized_pnl_sats && dl.threshold_bch && dl.threshold_bch < 0) {
    try {
      const lossSats = -BigInt(typeof dl.realized_pnl_sats === 'string' ? dl.realized_pnl_sats : '0');
      const limitSats = BigInt(Math.round(-dl.threshold_bch * 100_000_000));
      if (limitSats > 0n) {
        dlPct = Math.min(100, Number((lossSats * 10000n) / limitSats) / 100);
      }
    } catch { dlPct = 0; }
  }

  return (
    <div className="space-y-4">
      <BreakerChip summary={cbSummary} />

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <RiskTile
          label="exposure"
          value={formatBchAmount(exposure.current_bch)}
          sub={exposure.max_bch === null
            ? `${exposure.open_position_count} open · no limit configured`
            : `${utilizationPct(exposure.utilization)} of ${formatBchAmount(exposure.max_bch)} (${exposure.open_position_count} open)`}
          severity={expSev}
          barPct={expPct}
        />
        <RiskTile
          label="daily loss"
          value={dl.realized_pnl_sats === null || dl.realized_pnl_sats === undefined
            ? '—'
            : formatSatsAmount(dl.realized_pnl_sats)}
          sub={dl.threshold_bch === null
            ? `${dl.contributing_positions ?? 0} closed in ${dl.lookback_hours ?? 24}h · no threshold`
            : `${dl.limit_breached ? 'BREACHED ' : ''}threshold ${formatBchAmount(dl.threshold_bch)} · ${dl.contributing_positions ?? 0} closed in ${dl.lookback_hours ?? 24}h`}
          severity={dlSev}
          barPct={dlPct}
        />
        <RiskTile
          label="drawdown"
          value={formatPctSigned(dd.drawdown_pct)}
          sub={dd.peak_balance_sats === '0'
            ? 'no snapshot history'
            : `peak ${formatSatsAmount(dd.peak_balance_sats)} · ${formatSatsAmount(dd.current_balance_sats)} now · ${dd.window_days ?? 30}d window`}
          severity={ddSev}
          barPct={dd.drawdown_pct}
        />
        <RiskTile
          label="concentration"
          value={conc.top_positions && conc.top_positions[0]
            ? (topPctOfWallet === null ? `${conc.top_positions[0].pct_of_exposure?.toFixed(1) ?? '—'}% of exposure` : `${topPctOfWallet.toFixed(1)}% of wallet`)
            : 'no open positions'}
          sub={conc.top_positions && conc.top_positions[0]
            ? `${conc.top_positions[0].token_symbol || (conc.top_positions[0].token_id || '').slice(0, 6) + '…'} · ${conc.hidden_position_count > 0 ? `+${conc.hidden_position_count} more` : `${conc.top_positions.length} top`}`
            : '—'}
          severity={concSev}
          barPct={topPctOfWallet}
        />
      </div>

      {conc.top_positions && conc.top_positions.length > 0 ? (
        <ConcentrationTable conc={conc} />
      ) : (
        <div className="rounded border border-dashed border-ink-700 p-3 text-xs text-ash-300">
          no open positions — concentration panel dormant until the bot enters a trade.
        </div>
      )}
    </div>
  );
}

/**
 * Single risk tile — label / big value / sub / severity bar.
 */
function RiskTile(props) {
  const sev = props.severity || 'unknown';
  const pct = severityBarPct(props.barPct);
  return (
    <div className="panel p-3">
      <div className="label">{props.label}</div>
      <div className={`num mt-1 text-lg font-semibold ${severityClass(sev)}`}>{props.value}</div>
      <div className="mt-1 text-[11px] text-ash-300">{props.sub}</div>
      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-ink-700">
        <div
          className={`h-full ${severityBarClass(sev)}`}
          style={{ width: `${pct}%` }}
          role="progressbar"
          aria-valuenow={Math.round(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>
    </div>
  );
}

/**
 * Header chip surfacing the circuit-breaker state ("idle" green or
 * "tripped: <kind> <reason>" red) when wired.
 */
function BreakerChip(props) {
  const s = props.summary;
  if (!s) {
    return (
      <div className="flex flex-wrap gap-2">
        <span className="rounded bg-ink-800 px-2 py-1 text-[11px] font-mono uppercase tracking-wider text-ash-300">
          circuit breaker: not wired
        </span>
      </div>
    );
  }
  if (s.status === 'tripped') {
    return (
      <div className="flex flex-wrap gap-2">
        <span className="rounded bg-pnl-loss/20 px-2 py-1 text-[11px] font-mono uppercase tracking-wider text-pnl-loss">
          circuit breaker: tripped · {s.kind}
        </span>
        <span className="rounded bg-ink-800 px-2 py-1 text-[11px] text-ash-200">{s.reason}</span>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-2">
      <span className="rounded bg-pnl-win/15 px-2 py-1 text-[11px] font-mono uppercase tracking-wider text-pnl-win">
        circuit breaker: idle
      </span>
    </div>
  );
}

/**
 * Per-token concentration table — renders the top-N positions
 * with their BCH spent, % of exposure, % of wallet, entry time.
 */
function ConcentrationTable(props) {
  const conc = props.conc;
  const rows = conc.top_positions || [];
  const totalExposure = (typeof conc.total_exposure_bch === 'number') ? conc.total_exposure_bch : 0;
  const walletBch = (typeof conc.wallet_balance_bch === 'number') ? conc.wallet_balance_bch : null;
  return (
    <div className="rounded border border-ink-700">
      <div className="flex items-center justify-between border-b border-ink-700 px-3 py-2 text-xs text-ash-300">
        <span className="font-mono uppercase tracking-wider">top open positions by bch spent</span>
        <span className="font-mono">
          total exposure {formatBchAmount(totalExposure)}
          {walletBch !== null ? ` · wallet ${formatBchAmount(walletBch)}` : ''}
          {conc.hidden_position_count > 0 ? ` · +${conc.hidden_position_count} more` : ''}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-ink-700 text-left text-[10px] uppercase tracking-wider text-ash-300">
              <th className="px-3 py-2">token</th>
              <th className="px-3 py-2">position</th>
              <th className="px-3 py-2 text-right">bch spent</th>
              <th className="px-3 py-2 text-right">% exposure</th>
              <th className="px-3 py-2 text-right">% wallet</th>
              <th className="px-3 py-2">opened</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => {
              const sym = (typeof row.token_symbol === 'string' && row.token_symbol.length > 0)
                ? row.token_symbol
                : (typeof row.token_id === 'string' ? `${row.token_id.slice(0, 6)}…${row.token_id.slice(-4)}` : 'unknown');
              const posId = typeof row.position_id === 'string' ? row.position_id : '—';
              const opened = relativeTimeAgo(row.entry_ts);
              return (
                <tr key={`${row.position_id ?? idx}`} className="border-b border-ink-700/50 last:border-b-0">
                  <td className="px-3 py-2"><TokenBadge symbol={sym} /></td>
                  <td className="px-3 py-2 font-mono text-ash-200">{truncate(posId, 18)}</td>
                  <td className="px-3 py-2 text-right font-mono">{formatBchAmount(row.bch_spent_bch)}</td>
                  <td className="px-3 py-2 text-right font-mono">{typeof row.pct_of_exposure === 'number' ? `${row.pct_of_exposure.toFixed(1)}%` : '—'}</td>
                  <td className="px-3 py-2 text-right font-mono">{typeof row.pct_of_wallet === 'number' ? `${row.pct_of_wallet.toFixed(1)}%` : '—'}</td>
                  <td className="px-3 py-2 text-ash-300">{opened ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BalanceChart(props) {
  // T51: surface the operator-selected range inside the chart so
  // the "range:" label always matches the picker chip — even
  // during the brief window between the click and the parent's
  // re-fetch resolving. Mirrors the same pattern used by
  // CumulativePnlChart.
  const selectedRange = (typeof props.selectedRange === 'string' && props.selectedRange.length > 0)
    ? props.selectedRange
    : null;
  const records = (props.snapshots && Array.isArray(props.snapshots.records)) ? props.snapshots.records : [];
  // T40 fix: source trade markers from `/api/positions` instead of
  // `/api/history`. The history endpoint caps at 100 events which
  // gets swamped by `tick` / `entry_skipped` / `exit_skipped`
  // events from the most recent ticks; the actual `entry` / `exit`
  // trades from prior days get pushed off the end. Positions is a
  // small, complete list (open + closed) with both entry + exit
  // timestamps, BCH spent/received, and token_id — everything the
  // markers need. Accepts either the envelope `{positions: [...]}`
  // or a bare array, same convention as `buildTradePoints`.
  const positions = props.positions;
  if (records.length === 0) {
    return <div className="py-8 text-center text-sm text-ash-300">no snapshots yet — bot has not recorded a balance snapshot</div>;
  }
  // Map to chart rows. Field is bch_balance_sats (string) or bch_balance (number).
  const rows = records.map((r) => ({
    ts: new Date(r.ts).getTime(),
    balance: typeof r.bch_balance_sats === 'string'
      ? Number(r.bch_balance_sats) / 1e8
      : (typeof r.bch_balance === 'number' ? r.bch_balance : null),
  })).filter((r) => typeof r.balance === 'number' && Number.isFinite(r.balance));

  if (rows.length === 0) {
    return <div className="py-8 text-center text-sm text-ash-300">no balance data on snapshots</div>;
  }

  // T40: build a Scatter overlay of buy (entry) / sell (exit)
  // events. Each scatter point is anchored at the nearest snapshot
  // balance ≤ trade_ts so the marker visually sits on the line.
  // Trades that fall before the first snapshot (no anchor) or whose
  // token_id is missing are dropped — keeps the overlay honest.
  const tradePoints = buildTradePoints(positions, rows);

  const minBalance = Math.min(...rows.map((r) => r.balance));
  const maxBalance = Math.max(...rows.map((r) => r.balance));
  const pad = Math.max((maxBalance - minBalance) * 0.1, 0.0001);

  // T40 fix: the legend used to live INSIDE the fixed-height
  // (height: 240) chart wrapper, so it was clipped behind the
  // recharts canvas. Pulling it OUT into its own div lets it render
  // below the chart.
  // T51: prefer the picker state over the server-echoed
  // `snapshots.range` so the in-flight window label matches the
  // highlighted chip (mirrors CumulativePnlChart).
  const range = selectedRange
    ?? ((props.snapshots && typeof props.snapshots.range === 'string') ? props.snapshots.range : 'all');
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-3 text-xs font-mono text-ash-300">
        <span>range: <span className="text-ash-100">{range}</span></span>
        <span>snapshots: <span className="text-ash-100">{rows.length}</span></span>
        <span className="ml-auto">
          min: <span className="text-ash-100">{(minBalance).toFixed(6)}</span>
          {' · '}
          max: <span className="text-ash-100">{(maxBalance).toFixed(6)}</span>
          {' '}<span className="text-ash-500">BCH</span>
        </span>
      </div>
      <div style={{ width: '100%', height: 240 }}>
        <ResponsiveContainer>
          <LineChart data={rows} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2632" />
            <XAxis
              dataKey="ts"
              type="number"
              domain={['dataMin', 'dataMax']}
              tickFormatter={(v) => {
                const d = new Date(v);
                return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${d.getUTCHours()}:${pad2(d.getUTCMinutes())}`;
              }}
              stroke="#7e8699"
              fontSize={11}
            />
            <YAxis
              domain={[minBalance - pad, maxBalance + pad]}
              tickFormatter={(v) => v.toFixed(6)}
              stroke="#7e8699"
              fontSize={11}
              width={80}
            />
            <Tooltip
              content={<BalanceChartTooltip />}
              cursor={{ stroke: '#3a4252', strokeDasharray: '3 3' }}
            />
            <ReferenceLine y={rows[0].balance} stroke="#3a4252" strokeDasharray="3 3" />
            <Line
              type="monotone"
              dataKey="balance"
              stroke="#10b981"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
            {tradePoints.length > 0 && (
              // T40-fix2: switched from `<Scatter shape="circle">`
              // (which renders via `<Symbols>` + d3-shape path math
              // and silently no-ops for tiny `r` values) to a
              // second `<Line>` series with a per-point custom
              // `dot` function — the same pattern the working
              // `CumulativePnlChart` uses for its win/loss dots.
              // Stroke is transparent so only the dots render;
              // `activeDot={false}` prevents recharts from
              // spawning its own hover dot on top of ours.
              <Line
                data={tradePoints}
                type="monotone"
                dataKey="balance"
                stroke="transparent"
                strokeWidth={0}
                dot={(dotProps) => renderTradeMarkerDot(dotProps)}
                activeDot={false}
                isAnimationActive={false}
                connectNulls={false}
                legendType="none"
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
      {tradePoints.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-3 text-[10px] text-ash-400">
          {/* T40-fix2: legend chips now match the on-chart marker
              shape (a hollow green ring for buys, a solid red dot
              for sells). The earlier CSS-border triangles didn't
              visually correlate with the rendered markers and the
              operator kept reporting "legend shows triangles,
              chart shows nothing" — the chips themselves were the
              only visible symbol. Inline SVG keeps the legend
              dependency-free. */}
          <span className="inline-flex items-center gap-1.5">
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <circle cx="7" cy="7" r="5.5" fill="#0a0c10" stroke="#10b981" strokeWidth="2" />
            </svg>
            <span>buy</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <circle cx="7" cy="7" r="5" fill="#e0596b" stroke="#0a0c10" strokeWidth="1" />
            </svg>
            <span>sell</span>
          </span>
          <span className="ml-auto">hover a marker for token + BCH details</span>
        </div>
      )}
    </div>
  );
}

// T40: pure transform — convert positions into recharts-ready
// scatter points for the balance chart.
//
//   positions  — the raw `/api/positions?status=all` envelope
//                (i.e. `{positions: [...]}`) or a bare array of
//                position objects. Both shapes accepted.
//   rows       — the snapshot rows used by the chart's line
//                series (each row: { ts: ms, balance: number })
//
// Each position expands into TWO points — one `entry` marker at
// the entry timestamp, and (when the position is closed) one
// `exit` marker at the exit timestamp. Open positions contribute
// only the entry marker. Trades before the first snapshot (no
// anchor) are dropped. Pure, exported for unit-tests.
export function buildTradePoints(positions, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const list = Array.isArray(positions?.positions) ? positions.positions
             : Array.isArray(positions) ? positions
             : [];
  if (list.length === 0) return [];
  // Sort the rows ascending by ts once; reused for the inner loop.
  const sorted = rows.slice().sort((a, b) => a.ts - b.ts);
  const out = [];
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    if (typeof p.token_id !== 'string' || p.token_id.length !== 64) continue;
    const entry = (p.entry && typeof p.entry === 'object') ? p.entry : null;
    const exit = (p.exit && typeof p.exit === 'object') ? p.exit : null;
    if (!entry) continue;
    const entryTs = Date.parse(typeof entry.ts === 'string' ? entry.ts : '');
    if (!Number.isFinite(entryTs)) continue;
    // Helper: anchor a marker at the latest snapshot ≤ trade ts.
    const anchorAt = (tsMs) => {
      let anchor = null;
      for (const r of sorted) {
        if (r.ts <= tsMs) anchor = r;
        else break;
      }
      return anchor;
    };
    const entryAnchor = anchorAt(entryTs);
    if (entryAnchor) {
      out.push({
        ts: entryTs,
        balance: entryAnchor.balance,
        side: 'entry',
        token_id: p.token_id,
        bch_amount_sats: (typeof entry.bch_spent_sats === 'string' || typeof entry.bch_spent_sats === 'number')
          ? entry.bch_spent_sats
          : null,
        exit_kind: null,
        realized_pnl_sats: null,
      });
    }
    if (exit) {
      const exitTs = Date.parse(typeof exit.ts === 'string' ? exit.ts : '');
      if (Number.isFinite(exitTs)) {
        const exitAnchor = anchorAt(exitTs);
        if (exitAnchor) {
          out.push({
            ts: exitTs,
            balance: exitAnchor.balance,
            side: 'exit',
            token_id: p.token_id,
            bch_amount_sats: (typeof exit.bch_received_sats === 'string' || typeof exit.bch_received_sats === 'number')
              ? exit.bch_received_sats
              : null,
            exit_kind: (typeof exit.kind === 'string') ? exit.kind
                      : (typeof exit.reason === 'string') ? exit.reason
                      : null,
            realized_pnl_sats: (typeof exit.realized_pnl_sats === 'string' || typeof exit.realized_pnl_sats === 'number')
              ? exit.realized_pnl_sats
              : null,
          });
        }
      }
    }
  }
  // Sort by ts asc so scatter rendering is stable + easy to reason
  // about in tests.
  out.sort((a, b) => a.ts - b.ts);
  return out;
}
// T40-fix2: render the trade marker as a per-point `dot` function
// for a second `<Line>` series with `stroke="transparent"`. This
// is the same pattern the cumulative-P&L chart uses for its
// win/loss dots, which the operator confirmed renders reliably.
// Earlier attempts via `<Scatter>` (custom-shape + built-in circle
// + per-point prop functions) all silently dropped the markers in
// the operator's browser, even though the legend (data-presence
// proof) and the recharts tooltip wiring both worked.
//
// `Line` with `stroke="transparent"` + `dot={fn}` renders exactly
// the custom marker at each (x, y) datapoint without drawing a
// line between them. `activeDot={false}` keeps recharts from
// spawning its default hover-dot overlay on top of ours.
//
// Pure — exported so the test suite can lock the shape contract
// (cx/cy fallback, side discrimination, payload pass-through).
//
//   entry → hollow green ring (r=7) — reads as "open ring" / buy
//   exit  → solid red filled circle (r=6) — stands out even when
//           overlapping the green balance line
export function renderTradeMarkerDot(props) {
  const { cx, cy, payload } = props;
  if (typeof cx !== 'number' || typeof cy !== 'number' || Number.isNaN(cx) || Number.isNaN(cy)) return null;
  if (!payload) return null;
  const isBuy = payload.side === 'entry';
  if (isBuy) {
    return (
      <circle
        cx={cx}
        cy={cy}
        r={7}
        fill="#0a0c10"
        stroke="#10b981"
        strokeWidth={2.5}
        style={{ pointerEvents: 'all' }}
      />
    );
  }
  return (
    <circle
      cx={cx}
      cy={cy}
      r={6}
      fill="#e0596b"
      stroke="#0a0c10"
      strokeWidth={1.5}
      style={{ pointerEvents: 'all' }}
    />
  );
}

// T40: custom tooltip for the balance chart. Recharts hands us
// the active payload; if the hovered item is a scatter (trade
// marker) we render a trade-flavoured card, otherwise the default
// balance-line tooltip.
function BalanceChartTooltip(props) {
  const { active, payload, label } = props;
  if (!active || !Array.isArray(payload) || payload.length === 0) return null;
  // Find the trade marker payload if any.
  const trade = payload.find((p) => p && p.payload && (p.payload.side === 'entry' || p.payload.side === 'exit'));
  if (trade) {
    const p = trade.payload;
    const isBuy = p.side === 'entry';
    const bchSats = p.bch_amount_sats;
    const bchBch = (typeof bchSats === 'string' || typeof bchSats === 'number') ? Number(bchSats) / 1e8 : null;
    return (
      <div className="rounded border border-ink-600 bg-ink-900 px-3 py-2 text-xs shadow-lg">
        <div className={`mb-1 font-mono uppercase tracking-wider ${isBuy ? 'text-bch-400' : 'text-pnl-loss'}`}>
          {isBuy ? 'buy' : 'sell'}
        </div>
        <div className="num text-ash-100">
          {bchBch !== null && Number.isFinite(bchBch) ? `${bchBch.toFixed(8)} BCH` : '—'}
        </div>
        <div className="mt-1.5">
          <TokenBadge tokenId={p.token_id} compact />
        </div>
        {p.exit_kind && (
          <div className="mt-1 text-[10px] text-ash-400">reason: {p.exit_kind}</div>
        )}
        {p.realized_pnl_sats !== null && (
          <div className="mt-1 text-[10px] text-ash-400">
            pnl: {formatBch(p.realized_pnl_sats)}
          </div>
        )}
        <div className="mt-1 text-[10px] text-ash-500 num">{formatLocal(label ?? p.ts)}</div>
      </div>
    );
  }
  // Default balance-line tooltip.
  const linePoint = payload.find((p) => p && typeof p.value === 'number');
  if (!linePoint) return null;
  return (
    <div className="rounded border border-ink-600 bg-ink-900 px-3 py-2 text-xs shadow-lg">
      <div className="num text-ash-100">{Number(linePoint.value).toFixed(8)} BCH</div>
      <div className="text-[10px] text-ash-400">balance</div>
      <div className="mt-1 text-[10px] text-ash-500 num">{formatLocal(label)}</div>
    </div>
  );
}

function pad2(n) { return n.toString().padStart(2, '0'); }

/**
 * T39: cumulative realized P&L line chart. Plots
 * `cumulative_realized_pnl_bch` (Number) vs `ts_ms` (Number) over
 * the rows the backend hands back from `/api/pnl-timeseries`. Each
 * row also gets a colored dot — green for wins, red for losses,
 * neutral for breakeven — so operators can see at a glance where
 * the run-up / drawdown came from.
 *
 * Renders three different empty states depending on why there's
 * no chart: (a) backend hasn't replied yet, (b) there are simply
 * no closed trades, (c) every closed trade was skipped (missing
 * `realized_pnl_sats` etc.). Keeps copy short so the dashboard
 * stays scannable.
 *
 * Pure render — the row transform (`rowsToChartPoints`) is
 * exported + unit-tested.
 */
export function CumulativePnlChart(props) {
  const p = props.pnl;
  // T51: the chart's "range:" label tracks the picker the
  // operator just clicked — not the `p.range` echoed back from
  // the server. During a switch the parent re-fetches but the
  // old response envelope is still in `p`; the picker chip has
  // already updated. Without this fallback the operator sees a
  // 7d-highlighted chip + a 30d label for the brief window
  // between the click and the new fetch resolving. The server
  // response still wins when present — this fallback is purely
  // for the in-flight switch.
  const selectedRange = (typeof props.selectedRange === 'string' && props.selectedRange.length > 0)
    ? props.selectedRange
    : null;
  if (!p) return <div className="py-8 text-center text-sm text-ash-300">loading…</div>;
  if (!Array.isArray(p.rows) || p.rows.length === 0) {
    const skipped = (typeof p.skipped === 'number') ? p.skipped : 0;
    const trades = (typeof p.trades_count === 'number') ? p.trades_count : 0;
    if (trades === 0 && skipped > 0) {
      return (
        <div className="py-8 text-center text-sm text-ash-300">
          no chartable closed trades — {skipped} trade{skipped === 1 ? '' : 's'} skipped
          (missing closed_at or realized_pnl_sats)
        </div>
      );
    }
    return <div className="py-8 text-center text-sm text-ash-300">no closed trades yet — chart will appear after the first exit</div>;
  }
  const points = rowsToChartPoints(p.rows);
  if (points.length === 0) {
    return <div className="py-8 text-center text-sm text-ash-300">no chartable rows after transform</div>;
  }
  const minVal = Math.min(...points.map((r) => r.cumulative_bch));
  const maxVal = Math.max(...points.map((r) => r.cumulative_bch));
  // Pad symmetrically so the line never hugs the chart edges.
  const absMax = Math.max(Math.abs(minVal), Math.abs(maxVal), 0.00001);
  const pad = absMax * 0.1;
  const totalSats = (typeof p.realized_total_sats === 'string') ? p.realized_total_sats : '0';
  const totalBch = (typeof p.realized_total_bch === 'number') ? p.realized_total_bch : 0;
  // T51: prefer the picker state over the server-echoed `p.range`
  // so the in-flight window label matches the highlighted chip.
  const range = selectedRange ?? ((typeof p.range === 'string') ? p.range : 'all');
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-3 text-xs font-mono text-ash-300">
        <span>range: <span className="text-ash-100">{range}</span></span>
        <span>trades: <span className="text-ash-100">{p.trades_count ?? points.length}</span></span>
        {(typeof p.skipped === 'number' && p.skipped > 0) && (
          <span>skipped: <span className="text-ash-100">{p.skipped}</span></span>
        )}
        <span className="ml-auto">
          total:{' '}
          <span className={totalBch > 0 ? 'text-pnl-win' : totalBch < 0 ? 'text-pnl-loss' : 'text-ash-100'}>
            {totalBch > 0 ? '+' : ''}{totalBch.toFixed(8)} BCH
          </span>
          {' '}<span className="text-ash-500">({totalSats} sat)</span>
        </span>
      </div>
      <div style={{ width: '100%', height: 220 }}>
        <ResponsiveContainer>
          <LineChart data={points} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2632" />
            <XAxis
              dataKey="ts_ms"
              type="number"
              domain={['dataMin', 'dataMax']}
              tickFormatter={(v) => {
                const d = new Date(v);
                return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${d.getUTCHours()}:${pad2(d.getUTCMinutes())}`;
              }}
              stroke="#7e8699"
              fontSize={11}
            />
            <YAxis
              domain={[-absMax - pad, absMax + pad]}
              tickFormatter={(v) => v.toFixed(8)}
              stroke="#7e8699"
              fontSize={11}
              width={90}
            />
            <Tooltip
              contentStyle={{ background: '#10141b', border: '1px solid #2a3140', borderRadius: 4 }}
              labelStyle={{ color: '#d6dbe3' }}
              labelFormatter={(v) => formatLocal(v)}
              formatter={(v, name) => {
                const n = (typeof v === 'number') ? v : Number(v);
                if (name === 'cumulative_bch') return [`${n.toFixed(8)} BCH`, 'cumulative'];
                if (name === 'trade_bch') return [`${n >= 0 ? '+' : ''}${n.toFixed(8)} BCH`, 'trade'];
                return [String(v), name];
              }}
            />
            <ReferenceLine y={0} stroke="#3a4252" strokeDasharray="3 3" />
            <Line type="monotone" dataKey="cumulative_bch" stroke="#e89a2b" strokeWidth={2} dot={{ r: 4, fill: '#e89a2b' }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      {/* B01: per-position breakdown — lets the operator verify the
          cumulative math themselves. Each row = one closed trade;
          sum of the pnl column must equal the "total" at the top
          (and /api/summary.realized.realized_pnl_sats). Rendered
          below the chart so the dashboard stays scannable but
          the audit trail is always one scroll away. */}
      <CumulativePnlBreakdownTable pnl={p} />
    </div>
  );
}

/**
 * B01: per-position breakdown table for the cumulative realized
 * P&L chart. Renders each closed trade as one row with: closed
 * timestamp, token symbol, side, this trade's P&L, the running
 * cumulative, exit reason, and `pnl_source` (computed vs stored).
 *
 * A green/red `match` chip at the top of the table lights up
 * when the sum of per-trade P&L equals the API's
 * `realized_total_sats` — this is the "trust the math" check the
 * operator couldn't do before B01, and the reason
 * `bug-cumulative-p-l-shows-wrong-total-20260916` was filed.
 *
 * Pure render — the breakdown shape comes from
 * `buildCumulativePnlBreakdown` so the table stays unit-testable
 * without booting React.
 */
export function CumulativePnlBreakdownTable(props) {
  const breakdown = buildCumulativePnlBreakdown(props.pnl);
  const total = breakdown.total_sats;
  const computed = breakdown.computed_sum_sats;
  const rows = breakdown.rows;
  return (
    <div className="mt-4 border-t border-ink-700 pt-3" data-testid="cumulative-pnl-breakdown">
      <div className="flex flex-wrap items-baseline gap-x-3 text-xs font-mono text-ash-300">
        <span className="uppercase tracking-wider text-ash-400">per-position breakdown</span>
        <span className="text-ash-500">·</span>
        <span>rows: <span className="text-ash-100">{rows.length}</span></span>
        <span>computed sum: <span className="text-ash-100">{formatSignedBch(computed)}</span></span>
        {total !== null && (
          <>
            <span>·</span>
            <span>api total: <span className="text-ash-100">{formatSignedBch(total)}</span></span>
            <span
              className={
                breakdown.match
                  ? 'rounded border border-pnl-win/40 bg-pnl-win/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-pnl-win'
                  : 'rounded border border-pnl-loss/40 bg-pnl-loss/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-pnl-loss'
              }
              title={breakdown.match
                ? 'per-trade sum equals api total — math is consistent'
                : 'per-trade sum differs from api total — investigate'}
              data-testid="cumulative-pnl-match-chip"
            >
              {breakdown.match ? 'match ✓' : 'mismatch ✗'}
            </span>
          </>
        )}
        {breakdown.skipped > 0 && (
          <>
            <span>·</span>
            <span>skipped: <span className="text-ash-100">{breakdown.skipped}</span></span>
          </>
        )}
        <span className="ml-auto text-[10px] text-ash-500 italic">
          sum of (exit.bch_received − entry.bch_spent − entry.fee − exit.fee) over every closed trade
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="py-3 text-center text-xs text-ash-400">no closed trades in the current window — total above reflects the API's `realized_total_sats`</div>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="min-w-full text-xs font-mono">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-ash-400">
                <th className="px-2 py-1">closed</th>
                <th className="px-2 py-1">token</th>
                <th className="px-2 py-1">side</th>
                <th className="px-2 py-1 text-right">pnl</th>
                <th className="px-2 py-1 text-right">cum</th>
                <th className="px-2 py-1">kind</th>
                <th className="px-2 py-1">source</th>
                <th className="px-2 py-1">reason</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.position_id}
                  className="border-t border-ink-800/60 hover:bg-ink-800/40"
                  data-testid="cumulative-pnl-breakdown-row"
                  data-position-id={r.position_id}
                >
                  <td className="px-2 py-1 text-ash-200 whitespace-nowrap">
                    {r.closed_at ? formatLocal(r.closed_at) : '—'}
                  </td>
                  <td className="px-2 py-1 text-ash-100 whitespace-nowrap">
                    {r.token_symbol || (r.token_id ? `${r.token_id.slice(0, 6)}…${r.token_id.slice(-4)}` : '—')}
                  </td>
                  <td className="px-2 py-1 text-ash-300 whitespace-nowrap">
                    {r.side || '—'}
                  </td>
                  <td
                    className={
                      r.pnl_sats > 0n
                        ? 'px-2 py-1 text-right text-pnl-win whitespace-nowrap'
                        : r.pnl_sats < 0n
                          ? 'px-2 py-1 text-right text-pnl-loss whitespace-nowrap'
                          : 'px-2 py-1 text-right text-ash-200 whitespace-nowrap'
                    }
                  >
                    {formatSignedBch(r.pnl_sats)}
                  </td>
                  <td
                    className={
                      r.cum_sats > 0n
                        ? 'px-2 py-1 text-right text-pnl-win whitespace-nowrap'
                        : r.cum_sats < 0n
                          ? 'px-2 py-1 text-right text-pnl-loss whitespace-nowrap'
                          : 'px-2 py-1 text-right text-ash-200 whitespace-nowrap'
                    }
                  >
                    {formatSignedBch(r.cum_sats)}
                  </td>
                  <td className="px-2 py-1 text-ash-300 whitespace-nowrap">{kindLabel(r.kind)}</td>
                  <td
                    className={
                      r.pnl_source === 'stored'
                        ? 'px-2 py-1 text-amber-300 whitespace-nowrap'
                        : 'px-2 py-1 text-ash-300 whitespace-nowrap'
                    }
                    title={r.pnl_source === 'stored'
                      ? 'P&L came from the on-disk exit.realized_pnl_sats field (orphan recovery row); the raw received−spent−fees value was unavailable'
                      : 'P&L was computed from raw received−spent−fees (matches /api/summary)'}
                  >
                    {pnlSourceLabel(r.pnl_source)}
                  </td>
                  <td className="px-2 py-1 text-ash-400 whitespace-nowrap" title={r.reason || ''}>
                    {shortReason(r.reason)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * T39: pure transform — convert the backend's row shape into the
 * shape recharts wants. Exported so the test suite can lock the
 * shape (Number coercion, missing-row tolerance, kind→marker
 * mapping) without booting React.
 *
 * @param {Array<any>} rows
 * @returns {Array<{ ts_ms: number, cumulative_bch: number, trade_bch: number, kind: string, position_id: string|null, token_id: string|null }>}
 */
export function rowsToChartPoints(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const tsMs = (typeof r.ts_ms === 'number' && Number.isFinite(r.ts_ms))
      ? r.ts_ms
      : (typeof r.ts === 'string' ? Date.parse(r.ts) : NaN);
    if (!Number.isFinite(tsMs)) continue;
    const cumBch = (typeof r.cumulative_realized_pnl_bch === 'number' && Number.isFinite(r.cumulative_realized_pnl_bch))
      ? r.cumulative_realized_pnl_bch
      : NaN;
    if (!Number.isFinite(cumBch)) continue;
    const tradeBch = (typeof r.realized_pnl_bch === 'number' && Number.isFinite(r.realized_pnl_bch))
      ? r.realized_pnl_bch
      : 0;
    out.push({
      ts_ms: tsMs,
      cumulative_bch: cumBch,
      trade_bch: tradeBch,
      kind: (typeof r.kind === 'string') ? r.kind : 'unknown',
      position_id: (typeof r.position_id === 'string') ? r.position_id : null,
      token_id: (typeof r.token_id === 'string') ? r.token_id : null,
    });
  }
  return out;
}

function HistoryTable(props) {
  const events = (props.history && Array.isArray(props.history.events)) ? props.history.events : [];
  const [limit, setLimit] = useState(25);
  if (events.length === 0) {
    return <div className="py-4 text-sm text-ash-300">no history events in the last 7 days</div>;
  }
  // Backend returned at most 100 events (the cap we set in the
  // fetch). Slice for display. The events array is in chronological
  // order; reverse for newest-first display, then slice.
  const visible = events.slice(-limit).reverse();
  const counts = countHistoryKinds(events);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
        <span className="font-mono uppercase tracking-wider text-ash-400 mr-1">show</span>
        {[10, 25, 50, 100].map((n) => (
          <DisplayTab key={n} active={limit === n} onClick={() => setLimit(n)}>
            {n === 100 ? `${n} (all)` : n}
          </DisplayTab>
        ))}
        <span className="font-mono text-[10px] text-ash-500 ml-auto">
          {counts.tick} tick · {counts.entry_executed + counts.entry_skipped + counts.entry_rejected} entry · {counts.exit_executed + counts.exit_skipped + counts.exit_rejected} exit
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-left text-xs font-mono uppercase tracking-wider text-ash-300">
              <th className="px-2 py-1">ts</th>
              <th className="px-2 py-1">kind</th>
              <th className="px-2 py-1">side</th>
              <th className="px-2 py-1">token</th>
              <th className="px-2 py-1 text-right">BCH</th>
              <th className="px-2 py-1 text-right">tokens</th>
              <th className="px-2 py-1 text-right">slippage</th>
              <th className="px-2 py-1">txid</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {visible.map((e, i) => (
              <tr key={i} className="border-t border-ink-700">
                <td className="px-2 py-1 text-ash-300">{formatLocal(e.ts || e.timestamp)}</td>
                <td className="px-2 py-1 text-ash-200">{e.kind || e.event || '—'}</td>
                <td className={`px-2 py-1 ${sideClass(e.side)}`}>{e.side || '—'}</td>
                <td className="px-2 py-1">
                  {e.token_id ? <TokenBadge tokenId={e.token_id} compact /> : <span className="text-ash-500">—</span>}
                </td>
                <td className="px-2 py-1 text-right">{formatBch(e.bch_in_or_out ?? e.bch_spent_sats ?? null)}</td>
                <td className="px-2 py-1 text-right">{typeof e.tokens_in_or_out === 'string' ? truncate(e.tokens_in_or_out, 16) : (e.tokens_in_or_out ?? '—')}</td>
                <td className="px-2 py-1 text-right">{typeof e.actual_slippage_bps === 'number' ? `${e.actual_slippage_bps} bps` : '—'}</td>
                <td className="px-2 py-1 text-ash-300">{truncate(e.txid, 12)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * T26a: tiny tab button used by HistoryTable + ActivityFeed.
 * Pure render — exported for tests.
 */
export function DisplayTab(props) {
  const { active, onClick, children, disabled } = props;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-active={active ? 'true' : 'false'}
      className={
        `px-2 py-0.5 rounded border text-[10px] font-mono uppercase tracking-wider transition-colors ` +
        (disabled
          ? 'bg-ink-900 text-ash-500 border-ink-800 cursor-not-allowed opacity-50'
          : active
            ? 'bg-bch-500 text-ink-950 border-bch-500'
            : 'bg-ink-800 text-ash-200 border-ink-600 hover:bg-ink-700 hover:text-ash-100')
      }
    >
      {children}
    </button>
  );
}

/**
 * T26a: bucket a list of history events by `kind` so we can
 * show a tiny "tick · entry · exit" counter next to the display
 * tabs. Pure.
 *
 * @param {Array<Object>} events
 * @returns {{ tick: number, entry_executed: number, entry_skipped: number, entry_rejected: number, exit_executed: number, exit_skipped: number, exit_rejected: number, other: number }}
 */
export function countHistoryKinds(events) {
  const out = { tick: 0, entry_executed: 0, entry_skipped: 0, entry_rejected: 0, exit_executed: 0, exit_skipped: 0, exit_rejected: 0, other: 0 };
  if (!Array.isArray(events)) return out;
  for (const e of events) {
    const k = typeof e?.kind === 'string' ? e.kind : '';
    if (k in out) out[k] += 1;
    else out.other += 1;
  }
  return out;
}

function ActivityFeed(props) {
  const a = props.activity;
  const [limit, setLimit] = useState(5);
  if (!a) return <div className="py-4 text-sm text-ash-300">loading…</div>;
  const events = Array.isArray(a.last_events) ? a.last_events.slice().reverse() : [];
  const visible = events.slice(0, limit);
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
        <span className="font-mono uppercase tracking-wider text-ash-400 mr-1">show</span>
        {[5, 15, 50, 100].map((n) => (
          <DisplayTab key={n} active={limit === n} onClick={() => setLimit(n)}>
            {n === 100 ? `${n} (all)` : n}
          </DisplayTab>
        ))}
        <span className="font-mono text-[10px] text-ash-500 ml-auto">{events.length} buffered</span>
      </div>
      {a.last_snapshot && (
        <div className="rounded border border-ink-700 bg-ink-800 p-3">
          <div className="label">last snapshot</div>
          <div className="num mt-1 text-ash-100">{formatLocal(a.last_snapshot.ts)}</div>
          <div className="num text-xs text-ash-300">
            balance: {formatBch(a.last_snapshot.bch_balance_sats ?? a.last_snapshot.bch_balance)} ·
            positions: {Array.isArray(a.last_snapshot.position_ids) ? a.last_snapshot.position_ids.length : 0}
          </div>
        </div>
      )}
      {events.length === 0 ? (
        <div className="text-ash-300">no recent events</div>
      ) : visible.map((e, i) => (
        <div key={i} className="rounded border border-ink-700 bg-ink-800 p-3">
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs uppercase tracking-wider text-ash-300">{e.kind || e.event || 'event'}</span>
            <span className="num text-xs text-ash-400">{formatLocal(e.ts || e.timestamp)}</span>
          </div>
          {e.token_id && (
            <div className="mt-1.5">
              <TokenBadge tokenId={e.token_id} compact />
            </div>
          )}
          {e.txid && <div className="num text-xs text-ash-400 mt-1">tx: {truncate(e.txid, 16)}</div>}
        </div>
      ))}
    </div>
  );
}