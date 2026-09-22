// dashboard/src/views/Settings.jsx
//
// SETTINGS view — every knob that influences the bot. Read-only
// when `api_token` is absent; editable when the operator has set
// `dashboard.api_token` in `config/user.json` and passed it via
// `?token=***` or `sessionStorage`.
//
// Knob groups mirror the top-level keys in `config/default.json`:
//   scoring / entry / exit / risk / loop / dashboard
//
// Write requests go to `PUT /api/config` and are validated server-
// side. The response is surfaced as a success / error banner.

import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import { useApi, useRefresh } from '../lib/api-context.jsx';
import Panel from '../components/Panel.jsx';
import ErrorState from '../components/ErrorState.jsx';
import { formatBch, parseBchToSats, parseNumberOr, formatSatsBch } from '../lib/format.mjs';
import {
  lookupKnobMeta,
  summarizeKnobImpact,
  renderRestartBanner,
  validateKnobValue,
  clampKnobValue,
  searchKnobs,
  groupKnobsByPanel,
  renderRangeHint,
  defaultValueAtPath,
  buildHelpPopover,
} from '../lib/knob-explanations.mjs';
// T57-3: DEX-panel needs the list of registered adapter ids so the
// operator sees a checkbox per known adapter (cauldron,
// cauldron_safe_mode, guanaco, ...). The list comes from the
// shared `src/dex/adapter.mjs` registry — importing the helper
// directly keeps the dashboard's "what adapters are installed"
// list in lockstep with the bot's boot-time registry. We import
// from a dashboard-side mirror (src/lib/dex-adapters.mjs) instead
// of `src/dex/adapter.mjs` because the latter transitively pulls
// in server-only modules (node:fs / node:path) and breaks the
// Vite browser build. The mirror is a hand-maintained list; see
// the comment at the top of that file for the drift-control rule.
import { KNOWN_DEX_IDS as listKnownDexIds } from '../lib/dex-adapters.mjs';

// T43b: hardcoded per-panel knob-path lists so each panel can
// hide itself when the search query doesn't match any of its
// rows. Cheaper than scanning the rendered JSX for `path`
// attributes, and the lockstep between Settings.jsx (which
// renders the rows) and these arrays is enforced by the
// catalog-shape test ("every knob currently rendered in
// Settings.jsx is in the catalog"). If Settings.jsx adds a new
// knob, this list grows too — both edits are obvious.
const SCORING_PATHS = [
  ['scoring','weights','volume_24h_bch'], ['scoring','weights','volume_7d_bch'],
  ['scoring','weights','volatility_24h_pct'], ['scoring','weights','tvl_bch'],
  ['scoring','weights','apy_30d_pct'], ['scoring','weights','fee_yield_bps'],
  ['scoring','weights','upward_volatility'],
  ['scoring','min_score'], ['scoring','min_volume_7d_bch'],
  ['scoring','min_tvl_bch'], ['scoring','min_trade_count_24h'],
  ['scoring','max_pool_age_days'], ['scoring','top_k_candidates'],
  ['scoring','caps','volume_24h_bch'], ['scoring','caps','volume_7d_bch'],
  ['scoring','caps','tvl_bch'],
  ['scoring','linear_caps','volatility_24h_pct'], ['scoring','linear_caps','apy_30d_pct'],
  ['scoring','linear_caps','fee_yield_bps'],
];
const ENTRY_PATHS = [
  ['entry','min_trade_size_bch'], ['entry','max_position_bch'],
  ['entry','max_total_exposure_bch'], ['entry','slippage_tolerance_bps'],
  ['entry','entry_price_max_deviation_pct'], ['entry','min_amm_total_depth_sats'],
  ['entry','max_indexer_vs_amm_ratio_x'], ['entry','max_position_concentration_pct'],
  ['entry','volatility_sizing_target_pct'], ['entry','correlation_skip_threshold'],
  ['entry','min_pool_age_days'], ['entry','use_post_trade_check'],
];
const EXIT_PATHS = [
  ['exit','take_profit_pct'], ['exit','stop_loss_pct'],
  ['exit','time_stop_hours'], ['exit','time_stop_hours_synced'],
  ['exit','trailing_stop_pct'], ['exit','trailing_stop_activation_pct'],
  ['exit','max_price_vs_entry_ratio_x'],
  ['exit','tp_vol_multiplier'], ['exit','sl_vol_multiplier'],
  ['exit','tp_vol_floor_pct'], ['exit','tp_vol_ceiling_pct'],
  ['exit','sl_vol_floor_pct'], ['exit','sl_vol_ceiling_pct'],
];
const RISK_PATHS = [
  ['risk','max_daily_loss_bch'], ['risk','min_wallet_balance_bch'],
  ['risk','consecutive_loss_limit'], ['risk','loss_cooldown_minutes'],
];
const LOOP_PATHS = [
  ['loop','poll_interval_seconds'], ['loop','tick_timeout_seconds'],
];
const DASHBOARD_PATHS = [
  ['dashboard','bind_host'], ['dashboard','bind_port'],
  ['dashboard','request_timeout_ms'], ['dashboard','cors_origin'],
];
// T57-3: the DEX panel exposes `dex.safe_mode_active` (boolean
// toggle) + `dex.active` (array of adapter ids). Both rows are
// driven by the shared registry in `src/dex/adapter.mjs` so the
// Settings view + the bot's boot-time wiring stay in lockstep.
const DEX_PATHS = [
  ['dex','safe_mode_active'], ['dex','active'],
];

/**
 * T43b: return true when `visible` is non-null AND no path in
 * `paths` is in the visible set. Used by each panel to decide
 * whether to render itself when the operator's search query is
 * non-empty. Returns false when `visible` is null (= no search
 * active, always render).
 *
 * @param {ReadonlyArray<string[]>} paths
 * @param {Set<string>|null} visible
 * @returns {boolean}
 */
function panelHasNoVisible(paths, visible) {
  if (!visible) return false;
  for (const p of paths) if (visible.has(p.join('.'))) return false;
  return true;
}

export default function Settings() {
  const { api, token } = useApi();
  const { tick, trigger } = useRefresh();
  const canWrite = Boolean(token && token.length > 0);

  const [cfg, setCfg] = useState(/** @type {any} */ (null));
  const [risk, setRisk] = useState(/** @type {any} */ (null));
  const [cfgErr, setCfgErr] = useState(/** @type {string|null} */ (null));
  const [riskErr, setRiskErr] = useState(/** @type {string|null} */ (null));
  // T43c: pristine `config/default.json` (no user.json merge).
  // Populated once on mount via `api.getConfigDefaults()`. Used by
  // the per-knob reset-to-default link (reads the baseline value
  // at the knob's dotted path) and the help popover (shows the
  // baseline alongside description / unit / bounds). When the
  // defaults fetch fails or is missing, the UI gracefully degrades:
  // the reset link is disabled and the popover's baseline row
  // shows "unknown".
  const [defaultConfig, setDefaultConfig] = useState(/** @type {any} */ (null));
  const [defaultConfigErr, setDefaultConfigErr] = useState(/** @type {string|null} */ (null));
  const [banner, setBanner] = useState(/** @type {{ok:boolean,msg:string}|null} */ (null));
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(/** @type {Set<string>} */ (new Set()));
  // T43b: per-knob search/filter input. Empty = show all knobs
  // (preserves the original behaviour); non-empty = the visible
  // knobs are filtered through `searchKnobs(query)` and rendered
  // in score-ranked order.
  const [query, setQuery] = useState('');
  // T43b: visible Set — paths the search query lets through.
  // Null = no filter active (always visible). Each panel and
  // each KnobRow checks this before rendering.
  const visible = useMemo(() => {
    if (!query || query.trim().length === 0) return null;
    const matches = searchKnobs(query);
    return new Set(matches.map((k) => k.key));
  }, [query]);
  const visibleCount = visible ? visible.size : null;
  const totalKnobCount = useMemo(() => groupKnobsByPanel(
    // use the catalog via searchKnobs('') which returns the full
    // catalog — avoids importing KNOBS directly into the React tree.
    searchKnobs('')
  ).reduce((n, p) => n + p.knobs.length, 0), []);

  // local form state mirrors the config shape; starts as null
  // (waiting for the API) and is seeded from the fetched config.
  const [form, setForm] = useState(/** @type {any} */ (null));
  const formRef = useRef(/** @type {any} */ (null));

  // Fetch config + risk + defaults on every tick (so the operator
  // sees live values even without manual refresh).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [cr, rr, dr] = await Promise.all([
        api.getConfig(),
        api.getRisk(),
        // T43c: fetch pristine defaults once on first tick — the
        // data never mutates between ticks (no edit endpoint exists
        // for default.json), so subsequent ticks don't need to
        // re-fetch. The fetch is still gated by `tick` so a manual
        // `trigger()` from a future "reload defaults" button would
        // re-pull.
        api.getConfigDefaults(),
      ]);
      if (cancelled) return;
      if (cr.ok) {
        setCfg(cr.data?.config ?? null);
        setCfgErr(null);
        // Seed form on first load.
        if (formRef.current === null && cr.data?.config) {
          formRef.current = deepCopy(cr.data.config);
          setForm(deepCopy(cr.data.config));
        }
      } else {
        setCfgErr(cr.error || 'could not load config');
      }
      if (rr.ok) {
        setRisk(rr.data);
        setRiskErr(null);
      } else {
        setRiskErr(rr.error || 'risk state unavailable');
      }
      // T43c: drop the raw `defaults` object into state. Tolerant
      // of every shape the endpoint might return (missing file /
      // missing path / empty object / parsed-but-not-object) so a
      // future endpoint regression surfaces as a graceful
      // "reset-to-default disabled" rather than a crash.
      if (dr.ok && dr.data && typeof dr.data === 'object' && dr.data.defaults && typeof dr.data.defaults === 'object') {
        setDefaultConfig(dr.data.defaults);
        setDefaultConfigErr(null);
      } else {
        setDefaultConfig(null);
        setDefaultConfigErr((!dr.ok && dr.error) ? dr.error : 'defaults unavailable');
      }
    })();
    return () => { cancelled = true; };
  }, [api, tick]);

  const handleChange = useCallback((path, value) => {
    // e.g. path = ['scoring','weights','volume_24h_bch']
    setForm((prev) => {
      const next = deepCopy(prev);
      let cursor = next;
      for (let i = 0; i < path.length - 1; i++) {
        if (cursor[path[i]] === undefined) cursor[path[i]] = {};
        cursor = cursor[path[i]];
      }
      cursor[path[path.length - 1]] = value;
      return next;
    });
    setDirty((d) => { const nd = new Set(d); nd.add(path.join('.')); return nd; });
  }, []);

  const handleSave = useCallback(async () => {
    if (!canWrite || saving) return;
    setSaving(true);
    setBanner(null);
    const dirtyKeys = Array.from(dirty);
    const summary = summarizeKnobImpact(dirtyKeys);
    const r = await api.putConfig(form);
    setSaving(false);
    if (r.ok) {
      const bannerCopy = renderRestartBanner(summary);
      setBanner({
        ok: true,
        msg: bannerCopy.headline,
        detail: bannerCopy.detail,
        restartCount: summary.restartCount,
        nextTickCount: summary.nextTickCount,
      });
      setDirty(new Set());
      trigger();
    } else {
      setBanner({ ok: false, msg: r.error || 'save failed', detail: null, restartCount: 0, nextTickCount: 0 });
    }
  }, [api, canWrite, form, saving, trigger, dirty]);

  const handleReset = useCallback(() => {
    if (!cfg) return;
    formRef.current = deepCopy(cfg);
    setForm(deepCopy(cfg));
    setDirty(new Set());
    setBanner(null);
  }, [cfg]);

  // T43c: reset a single knob's form value to its pristine
  // config/default.json baseline. Reads the baseline through
  // `defaultValueAtPath(defaultConfig, path)` — same lookup the
  // dashboard's help popover uses, so the operator can't see a
  // baseline in the popover that the reset button ignores. When
  // the defaults aren't loaded (404 / 503 / parse-error), the
  // KnobRow disables the reset link and `path` never reaches this
  // function. When the path is missing from the defaults (catalog
  // vs default.json drift), the function is a no-op so the form
  // is left in the operator's intended dirty state.
  const handleResetKnob = useCallback((path) => {
    if (!Array.isArray(path) || path.length === 0) return;
    if (!defaultConfig || typeof defaultConfig !== 'object') return;
    const lookup = defaultValueAtPath(defaultConfig, path);
    if (!lookup || lookup.found !== true) return;
    handleChange(path, lookup.value);
  }, [defaultConfig, handleChange]);

  if (cfgErr && !cfg) return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Settings</h1>
      <ErrorState message={cfgErr} onRetry={trigger} />
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold">Settings</h1>
          <p className="text-sm text-ash-300">
            Every knob that influences the bot. Read-only unless you hold the dashboard API token. <span className="text-amber-200/80">All knobs require a bot restart to take effect</span> — config is loaded once at startup.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canWrite && dirty.size > 0 && (
            <>
              <button
                type="button"
                onClick={handleReset}
                className="rounded border border-ink-600 px-3 py-1.5 text-xs font-mono uppercase tracking-wider text-ash-200 hover:bg-ink-800"
              >
                discard
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="rounded bg-bch-600 px-4 py-1.5 text-xs font-mono uppercase tracking-wider text-ink-950 hover:bg-bch-400 disabled:opacity-50"
              >
                {saving ? 'saving…' : 'save'}
              </button>
            </>
          )}
          {!canWrite && (
            <span className="text-xs text-ash-400">
              no write token — set <code className="text-ash-200">?token=***</code> to edit
            </span>
          )}
        </div>
      </div>

      {banner && (
        <div className={`rounded border px-4 py-3 text-sm ${banner.ok
          ? 'border-emerald-700/60 bg-emerald-950/40 text-emerald-200'
          : 'border-amber-700/60 bg-amber-950/40 text-amber-200'}`}>
          <div className="flex items-center gap-2">
            <span>{banner.ok ? '✓' : '✗'}</span>
            <span>{banner.msg}</span>
            {banner.ok && banner.restartCount > 0 && (
              <span className="ml-2 inline-flex items-center gap-1 rounded-full border border-amber-700/60 bg-amber-950/40 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider text-amber-200" title="These knobs require a bot restart to take effect. config/user.json was written but scripts/run-bot.mjs reads config once at startup, so a hot reload is not possible.">
                restart required · {banner.restartCount}
              </span>
            )}
          </div>
          {banner.detail && (
            <div className="mt-2 text-xs font-mono text-ash-300">{banner.detail}</div>
          )}
        </div>
      )}

      {/* Persistent, mute header chip — surfaces restart-required
          count even before the operator clicks Save. */}
      {canWrite && dirty.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-ash-300">
          <span className="font-mono uppercase tracking-wider text-ash-400">
            {dirty.size === 1 ? '1 knob' : `${dirty.size} knobs`} modified
          </span>
          {(() => {
            const summary = summarizeKnobImpact(Array.from(dirty));
            if (summary.restartCount > 0) {
              return (
                <span className="inline-flex items-center gap-1 rounded-full border border-amber-700/60 bg-amber-950/40 px-2 py-0.5 font-mono uppercase tracking-wider text-amber-200">
                  restart required · {summary.restartCount}
                </span>
              );
            }
            return null;
          })()}
        </div>
      )}

      {cfgErr && <ErrorState message={cfgErr} onRetry={trigger} />}

      {riskErr && (
        <div className="rounded border border-amber-700/60 bg-amber-950/30 p-4 text-sm text-amber-200">
          risk state unavailable: {riskErr}
        </div>
      )}

      {form && (
        <div className="space-y-6">
          {/* T43b: per-knob search/filter input. Filters across
              label / key / group. Empty = full catalog visible
              (preserves the original behaviour). When non-empty,
              each panel hides itself if none of its knobs match;
              each KnobRow self-hides if its path doesn't match. */}
          <div className="flex flex-wrap items-center gap-3 rounded border border-ink-700 bg-ink-900/40 px-3 py-2">
            <label htmlFor="settings-search" className="text-xs font-mono uppercase tracking-wider text-ash-400">
              find knob
            </label>
            <input
              id="settings-search"
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="filter by label, key, or group (e.g. slippage, max_position_bch, exit)"
              className="min-w-[260px] flex-1 rounded border border-ink-700 bg-ink-800 px-2 py-1 font-mono text-xs text-ash-100 placeholder:text-ash-500 focus:border-bch-500 focus:outline-none focus:ring-1 focus:ring-bch-500"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="rounded border border-ink-600 px-2 py-1 text-[10px] font-mono uppercase tracking-wider text-ash-300 hover:bg-ink-800"
              >
                clear
              </button>
            )}
            {visibleCount !== null && (
              <span className="text-[10px] font-mono uppercase tracking-wider text-ash-400">
                showing {visibleCount} / {totalKnobCount}
              </span>
            )}
          </div>
          {visibleCount === 0 && (
            <div className="rounded border border-amber-700/60 bg-amber-950/30 p-3 text-sm text-amber-200">
              no knobs match <code className="font-mono">{query}</code>. try a shorter query (e.g. <code className="font-mono">slippage</code>, <code className="font-mono">max</code>, <code className="font-mono">tp</code>) or clear the filter.
            </div>
          )}
          {/* T43c: surface the reset-to-default + help-popover
              availability to the operator. When the defaults fetch
              failed (rare — server down or default.json missing)
              every per-knob ⤺ button is silently disabled and the
              popover's baseline row reads "unknown"; this banner
              explains that explicitly so the operator doesn't
              think the buttons are broken. */}
          {defaultConfigErr && (
            <div className="rounded border border-amber-700/60 bg-amber-950/30 p-3 text-xs text-amber-200">
              <span className="font-mono uppercase tracking-wider">defaults unavailable:</span> {defaultConfigErr}. the per-knob <span className="font-mono">⤺</span> reset link is disabled until the dashboard can read <code className="font-mono">config/default.json</code>.
            </div>
          )}
          <ScoringSettings form={form} onChange={handleChange} disabled={!canWrite} visible={visible} defaultConfig={defaultConfig} onResetKnob={handleResetKnob} />
          <EntrySettings form={form} onChange={handleChange} disabled={!canWrite} visible={visible} defaultConfig={defaultConfig} onResetKnob={handleResetKnob} />
          <ExitSettings form={form} onChange={handleChange} disabled={!canWrite} visible={visible} defaultConfig={defaultConfig} onResetKnob={handleResetKnob} />
          <RiskSettings form={form} onChange={handleChange} disabled={!canWrite} visible={visible} defaultConfig={defaultConfig} onResetKnob={handleResetKnob} />
          <LoopSettings form={form} onChange={handleChange} disabled={!canWrite} visible={visible} defaultConfig={defaultConfig} onResetKnob={handleResetKnob} />
          <DashboardSettings form={form} onChange={handleChange} disabled={!canWrite} visible={visible} defaultConfig={defaultConfig} onResetKnob={handleResetKnob} />
          <DexSettings form={form} onChange={handleChange} disabled={!canWrite} visible={visible} defaultConfig={defaultConfig} onResetKnob={handleResetKnob} />
          <CircuitBreakerPanel risk={risk} />
        </div>
      )}
    </div>
  );
}

// ─── Knob group components ───────────────────────────────────────────

function ScoringSettings(props) {
  const { form, onChange, disabled, visible, defaultConfig, onResetKnob } = props;
  if (visible && panelHasNoVisible(SCORING_PATHS, visible)) return null;
  const s = form.scoring || {};
  const w = s.weights || {};
  const caps = s.caps || {};
  const lc = s.linear_caps || {};
  return (
    <Panel title="scoring — pool scoring engine">
      <div className="space-y-4">
        <KnobSection label="weights (sum to ~1.0)">
          <KnobRow visible={visible} path={['scoring','weights','volume_24h_bch']}    label="volume_24h_bch"    value={w.volume_24h_bch}    onChange={onChange} disabled={disabled} type="number" step="0.01" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
          <KnobRow visible={visible} path={['scoring','weights','volume_7d_bch']}     label="volume_7d_bch"     value={w.volume_7d_bch}     onChange={onChange} disabled={disabled} type="number" step="0.01" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
          <KnobRow visible={visible} path={['scoring','weights','volatility_24h_pct']} label="volatility_24h_pct" value={w.volatility_24h_pct} onChange={onChange} disabled={disabled} type="number" step="0.01" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
          <KnobRow visible={visible} path={['scoring','weights','tvl_bch']}           label="tvl_bch"          value={w.tvl_bch}           onChange={onChange} disabled={disabled} type="number" step="0.01" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
          <KnobRow visible={visible} path={['scoring','weights','apy_30d_pct']}       label="apy_30d_pct"      value={w.apy_30d_pct}      onChange={onChange} disabled={disabled} type="number" step="0.01" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
          <KnobRow visible={visible} path={['scoring','weights','fee_yield_bps']}      label="fee_yield_bps"    value={w.fee_yield_bps}    onChange={onChange} disabled={disabled} type="number" step="0.01" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
          <KnobRow visible={visible} path={['scoring','weights','upward_volatility']}  label="upward_volatility" value={w.upward_volatility} onChange={onChange} disabled={disabled} type="number" step="0.01" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
        </KnobSection>
        <KnobSection label="filters">
          <KnobRow visible={visible} path={['scoring','min_score']}          label="min_score"          value={s.min_score}          onChange={onChange} disabled={disabled} type="number" step="0.01" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
          <KnobRow visible={visible} path={['scoring','min_volume_7d_bch']} label="min_volume_7d_bch" value={s.min_volume_7d_bch} onChange={onChange} disabled={disabled} type="number" step="0.001" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
          <KnobRow visible={visible} path={['scoring','min_tvl_bch']}        label="min_tvl_bch"        value={s.min_tvl_bch}        onChange={onChange} disabled={disabled} type="number" step="0.001" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
          <KnobRow visible={visible} path={['scoring','min_trade_count_24h']} label="min_trade_count_24h" value={s.min_trade_count_24h ?? 1} onChange={onChange} disabled={disabled} type="number" step="1" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
          <KnobRow visible={visible} path={['scoring','max_pool_age_days']}   label="max_pool_age_days"  value={s.max_pool_age_days}  onChange={onChange} disabled={disabled} type="number" step="1" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
          <KnobRow visible={visible} path={['scoring','top_k_candidates']}    label="top_k_candidates"   value={s.top_k_candidates}   onChange={onChange} disabled={disabled} type="number" step="1" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
        </KnobSection>
        <KnobSection label="caps (sigmoid-style)">
          <KnobRow visible={visible} path={['scoring','caps','volume_24h_bch']} label="volume_24h_bch cap (BCH)" value={caps.volume_24h_bch} onChange={onChange} disabled={disabled} type="number" step="0.1" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
          <KnobRow visible={visible} path={['scoring','caps','volume_7d_bch']}  label="volume_7d_bch cap (BCH)"  value={caps.volume_7d_bch}  onChange={onChange} disabled={disabled} type="number" step="0.1" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
          <KnobRow visible={visible} path={['scoring','caps','tvl_bch']}        label="tvl_bch cap (BCH)"         value={caps.tvl_bch}        onChange={onChange} disabled={disabled} type="number" step="0.1" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
          <KnobRow visible={visible} path={['scoring','linear_caps','volatility_24h_pct']} label="volatility_24h_pct cap (%)" value={lc.volatility_24h_pct} onChange={onChange} disabled={disabled} type="number" step="1" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
          <KnobRow visible={visible} path={['scoring','linear_caps','apy_30d_pct']}         label="apy_30d_pct cap (%)"         value={lc.apy_30d_pct}         onChange={onChange} disabled={disabled} type="number" step="1" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
          <KnobRow visible={visible} path={['scoring','linear_caps','fee_yield_bps']}       label="fee_yield_bps cap (bps)"     value={lc.fee_yield_bps}       onChange={onChange} disabled={disabled} type="number" step="1" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
        </KnobSection>
      </div>
    </Panel>
  );
}

function EntrySettings(props) {
  const { form, onChange, disabled, visible, defaultConfig, onResetKnob } = props;
  if (visible && panelHasNoVisible(ENTRY_PATHS, visible)) return null;
  const e = form.entry || {};
  return (
    <Panel title="entry — entry signal filters">
      <div className="space-y-3">
        <KnobRow visible={visible} path={['entry','min_trade_size_bch']}      label="min_trade_size_bch"      value={e.min_trade_size_bch}      onChange={onChange} disabled={disabled} type="number" step="0.0001" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
        <KnobRow visible={visible} path={['entry','max_position_bch']}         label="max_position_bch"         value={e.max_position_bch}         onChange={onChange} disabled={disabled} type="number" step="0.0001" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
        <KnobRow visible={visible} path={['entry','max_total_exposure_bch']}   label="max_total_exposure_bch"  value={e.max_total_exposure_bch}   onChange={onChange} disabled={disabled} type="number" step="0.0001" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
        <KnobRow visible={visible} path={['entry','slippage_tolerance_bps']}   label="slippage_tolerance_bps"  value={e.slippage_tolerance_bps}   onChange={onChange} disabled={disabled} type="number" step="1" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
        <KnobRow visible={visible} path={['entry','entry_price_max_deviation_pct']} label="entry_price_max_deviation_pct" value={e.entry_price_max_deviation_pct} onChange={onChange} disabled={disabled} type="number" step="0.1" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
        <KnobRow visible={visible}
          path={['entry','min_amm_total_depth_sats']}
          label="min_amm_total_depth_sats (T32)"
          value={e.min_amm_total_depth_sats}
          onChange={onChange}
          disabled={disabled}
          type="number"
          step="1000000"
          helper={formatSatsBch(e.min_amm_total_depth_sats)}
          defaultConfig={defaultConfig}
          onResetKnob={onResetKnob}
        />
        <KnobRow visible={visible} path={['entry','max_indexer_vs_amm_ratio_x']} label="max_indexer_vs_amm_ratio_x (T31)" value={e.max_indexer_vs_amm_ratio_x} onChange={onChange} disabled={disabled} type="number" step="1" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
        <KnobRow visible={visible} path={['entry','max_position_concentration_pct']} label="max_position_concentration_pct (T33, %)" value={e.max_position_concentration_pct} onChange={onChange} disabled={disabled} type="number" step="0.1" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
        <KnobRow visible={visible} path={['entry','volatility_sizing_target_pct']} label="volatility_sizing_target_pct (T35 Kelly-lite, %)" value={e.volatility_sizing_target_pct} onChange={onChange} disabled={disabled} type="number" step="0.1" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
        <KnobRow visible={visible} path={['entry','correlation_skip_threshold']} label="correlation_skip_threshold (T36, 0-1; -1=disabled)" value={e.correlation_skip_threshold} onChange={onChange} disabled={disabled} type="number" step="0.05" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
        <KnobRow visible={visible} path={['entry','min_pool_age_days']} label="min_pool_age_days (T37, days; -1=disabled)" value={e.min_pool_age_days} onChange={onChange} disabled={disabled} type="number" step="1" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
        <KnobToggle visible={visible}
          path={['entry','use_post_trade_check']}
          label="use_post_trade_check"
          value={e.use_post_trade_check}
          onChange={onChange}
          disabled={disabled}
          description="Run post_trade_check after broadcast to verify on-chain effective rate. Auto-evicts if worse than slippage_tolerance_bps."
          defaultConfig={defaultConfig}
          onResetKnob={onResetKnob}
        />
      </div>
    </Panel>
  );
}

function ExitSettings(props) {
  const { form, onChange, disabled, visible, defaultConfig, onResetKnob } = props;
  if (visible && panelHasNoVisible(EXIT_PATHS, visible)) return null;
  const ex = form.exit || {};
  return (
    <Panel title="exit — exit signal thresholds">
      <div className="space-y-3">
        <KnobRow visible={visible} path={['exit','take_profit_pct']}    label="take_profit_pct"     value={ex.take_profit_pct}    onChange={onChange} disabled={disabled} type="number" step="0.1" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
        <KnobRow visible={visible} path={['exit','stop_loss_pct']}      label="stop_loss_pct"       value={ex.stop_loss_pct}      onChange={onChange} disabled={disabled} type="number" step="0.1" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
        <KnobRow visible={visible} path={['exit','time_stop_hours']}    label="time_stop_hours"     value={ex.time_stop_hours}    onChange={onChange} disabled={disabled} type="number" step="1" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
        <KnobRow visible={visible} path={['exit','time_stop_hours_synced']} label="time_stop_hours_synced (chain-synced pos)" value={ex.time_stop_hours_synced} onChange={onChange} disabled={disabled} type="number" step="1" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
        <KnobRow visible={visible} path={['exit','trailing_stop_pct']}  label="trailing_stop_pct"   value={ex.trailing_stop_pct}  onChange={onChange} disabled={disabled} type="number" step="0.1" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
        <KnobRow visible={visible} path={['exit','trailing_stop_activation_pct']} label="trailing_stop_activation_pct" value={ex.trailing_stop_activation_pct} onChange={onChange} disabled={disabled} type="number" step="0.1" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
        <KnobRow visible={visible} path={['exit','max_price_vs_entry_ratio_x']} label="max_price_vs_entry_ratio_x (T28d)" value={ex.max_price_vs_entry_ratio_x} onChange={onChange} disabled={disabled} type="number" step="1" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
        {/* T38: dynamic TP/SL based on 7d realized volatility. Each
            knob has an "0 = disabled" semantic so operators can opt
            out by setting the multiplier to 0 (then the fixed TP/SL
            applies). */}
        <KnobRow visible={visible} path={['exit','tp_vol_multiplier']} label="tp_vol_multiplier (T38; σ; 0=disabled→fixed TP)" value={ex.tp_vol_multiplier} onChange={onChange} disabled={disabled} type="number" step="0.1" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
        <KnobRow visible={visible} path={['exit','sl_vol_multiplier']} label="sl_vol_multiplier (T38; σ; 0=disabled→fixed SL)" value={ex.sl_vol_multiplier} onChange={onChange} disabled={disabled} type="number" step="0.1" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
        <KnobRow visible={visible} path={['exit','tp_vol_floor_pct']} label="tp_vol_floor_pct (T38; minimum dynamic TP%)" value={ex.tp_vol_floor_pct} onChange={onChange} disabled={disabled} type="number" step="0.1" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
        <KnobRow visible={visible} path={['exit','tp_vol_ceiling_pct']} label="tp_vol_ceiling_pct (T38; maximum dynamic TP%)" value={ex.tp_vol_ceiling_pct} onChange={onChange} disabled={disabled} type="number" step="1" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
        <KnobRow visible={visible} path={['exit','sl_vol_floor_pct']} label="sl_vol_floor_pct (T38; minimum dynamic SL%)" value={ex.sl_vol_floor_pct} onChange={onChange} disabled={disabled} type="number" step="0.1" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
        <KnobRow visible={visible} path={['exit','sl_vol_ceiling_pct']} label="sl_vol_ceiling_pct (T38; maximum dynamic SL%)" value={ex.sl_vol_ceiling_pct} onChange={onChange} disabled={disabled} type="number" step="1" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
      </div>
    </Panel>
  );
}

function RiskSettings(props) {
  const { form, onChange, disabled, visible, defaultConfig, onResetKnob } = props;
  if (visible && panelHasNoVisible(RISK_PATHS, visible)) return null;
  const r = form.risk || {};
  return (
    <Panel title="risk — circuit breaker + wallet floor">
      <div className="space-y-3">
        <KnobRow visible={visible} path={['risk','max_daily_loss_bch']}       label="max_daily_loss_bch"       value={r.max_daily_loss_bch}       onChange={onChange} disabled={disabled} type="number" step="0.0001" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
        <KnobRow visible={visible} path={['risk','min_wallet_balance_bch']}    label="min_wallet_balance_bch"   value={r.min_wallet_balance_bch}   onChange={onChange} disabled={disabled} type="number" step="0.0001" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
        <KnobRow visible={visible} path={['risk','consecutive_loss_limit']}   label="consecutive_loss_limit"   value={r.consecutive_loss_limit}   onChange={onChange} disabled={disabled} type="number" step="1" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
        <KnobRow visible={visible} path={['risk','loss_cooldown_minutes']}    label="loss_cooldown_minutes (T34: pause entries N min after stop-loss; ≤0 disables)" value={r.loss_cooldown_minutes} onChange={onChange} disabled={disabled} type="number" step="1" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
      </div>
    </Panel>
  );
}

function LoopSettings(props) {
  const { form, onChange, disabled, visible, defaultConfig, onResetKnob } = props;
  if (visible && panelHasNoVisible(LOOP_PATHS, visible)) return null;
  const l = form.loop || {};
  return (
    <Panel title="loop — trading loop cadence">
      <div className="space-y-3">
        <KnobRow visible={visible} path={['loop','poll_interval_seconds']} label="poll_interval_seconds" value={l.poll_interval_seconds} onChange={onChange} disabled={disabled} type="number" step="1" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
        <KnobRow visible={visible} path={['loop','tick_timeout_seconds']}   label="tick_timeout_seconds"   value={l.tick_timeout_seconds}   onChange={onChange} disabled={disabled} type="number" step="1" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
      </div>
    </Panel>
  );
}

function DashboardSettings(props) {
  const { form, onChange, disabled, visible, defaultConfig, onResetKnob } = props;
  if (visible && panelHasNoVisible(DASHBOARD_PATHS, visible)) return null;
  const d = form.dashboard || {};
  return (
    <Panel title="dashboard — read-only HTTP backend (T16)">
      <div className="space-y-3">
        <KnobRow visible={visible} path={['dashboard','bind_host']}          label="bind_host"              value={d.bind_host}          onChange={onChange} disabled={disabled} type="text" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
        <KnobRow visible={visible} path={['dashboard','bind_port']}           label="bind_port"              value={d.bind_port}          onChange={onChange} disabled={disabled} type="number" step="1" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
        <KnobRow visible={visible} path={['dashboard','request_timeout_ms']} label="request_timeout_ms"     value={d.request_timeout_ms} onChange={onChange} disabled={disabled} type="number" step="100" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
        <KnobRow visible={visible} path={['dashboard','cors_origin']}         label="cors_origin (null=same)" value={d.cors_origin}        onChange={onChange} disabled={disabled} type="text" defaultConfig={defaultConfig} onResetKnob={onResetKnob} />
      </div>
    </Panel>
  );
}

// T57-3: DEX panel — multi-checkbox for the `dex.active` adapter
// list + a single boolean toggle for `dex.safe_mode_active`. The
// panel mirrors `RiskSettings` / `DashboardSettings` shape so it
// slots into the same scroll layout, but the `dex.active` row
// uses a custom `KnobActiveDexList` primitive because the typed
// catalog's number/boolean/text contract doesn't cover arrays of
// strings — the dashboard enforces the shape on the renderer
// side and `resolveDexConfig(cfg)` enforces it again on the
// backend at boot.
function DexSettings(props) {
  const { form, onChange, disabled, visible, defaultConfig, onResetKnob } = props;
  if (visible && panelHasNoVisible(DEX_PATHS, visible)) return null;
  const d = form.dex || {};
  return (
    <Panel title="DEX — active adapters + safe-mode backup">
      <div className="space-y-3">
        <KnobActiveDexList
          visible={visible}
          path={['dex','active']}
          label="dex.active"
          description="List of adapter ids the trader loop boots every tick. Add cauldron_safe_mode here OR toggle dex.safe_mode_active below — both paths add the backup adapter (the loop deduplicates when both are set)."
          value={Array.isArray(d.active) ? d.active : []}
          onChange={onChange}
          disabled={disabled}
          defaultConfig={defaultConfig}
          onResetKnob={onResetKnob}
        />
        <KnobToggle visible={visible}
          path={['dex','safe_mode_active']}
          label="dex.safe_mode_active"
          value={d.safe_mode_active}
          onChange={onChange}
          disabled={disabled}
          defaultConfig={defaultConfig}
          onResetKnob={onResetKnob}
        />
      </div>
    </Panel>
  );
}

function CircuitBreakerPanel(props) {
  const r = props.risk;
  if (!r || !r.state || typeof r.state !== 'object') {
    return (
      <Panel title="circuit breaker — risk state">
        <div className="text-sm text-ash-300">risk state not available — circuit breaker is owned by the trader loop</div>
      </Panel>
    );
  }
  const s = r.state;
  const isTripped = Boolean(s.tripped || s.open);
  return (
    <Panel title="circuit breaker — current state">
      <div className="space-y-3 text-sm">
        <div className="flex items-center gap-3">
          <div className={`h-3 w-3 rounded-full ${isTripped ? 'bg-pnl-loss' : 'bg-pnl-win'}`} />
          <span className={`font-mono uppercase tracking-wider ${isTripped ? 'text-pnl-loss' : 'text-pnl-win'}`}>
            {isTripped ? 'tripped / open' : 'armed'}
          </span>
        </div>
        {s.reason && <KnobDisplay label="reason" value={s.reason} />}
        {s.since && <KnobDisplay label="open since" value={new Date(s.since).toISOString()} />}
        {typeof s.losses_today === 'number' && <KnobDisplay label="losses today" value={String(s.losses_today)} />}
        {typeof s.loss_amount_today_bch === 'number' && <KnobDisplay label="loss amount today (BCH)" value={String(s.loss_amount_today_bch)} />}
        {typeof s.consecutive_losses === 'number' && <KnobDisplay label="consecutive losses" value={String(s.consecutive_losses)} />}
      </div>
    </Panel>
  );
}

// ─── Reusable knob primitives ────────────────────────────────────────

function KnobSection(props) {
  return (
    <div>
      <div className="label mb-2">{props.label}</div>
      <div className="space-y-2">{props.children}</div>
    </div>
  );
}

function KnobRow(props) {
  const { path, label, value, onChange, disabled, type, step, helper, visible, defaultConfig, onResetKnob } = props;
  // T43b: when a `visible` set is provided, the parent (Settings
  // view with the search input) is telling us this row should be
  // hidden. Render null and skip the rest.
  if (visible && !visible.has(path.join('.'))) return null;
  const id = `knob-${path.join('-')}`;
  const strVal = value === null || value === undefined ? '' : String(value);
  const displayVal = value === null || value === undefined ? '—' : String(value);
  const isNumeric = type === 'number';
  // T43: pull the catalog entry so we can show the human-readable
  // description + the restart-required badge inline. Unknown paths
  // (e.g. brand-new knobs the catalog hasn't been told about) get
  // a tolerant fallback — no crash, no badge, no description.
  const meta = lookupKnobMeta(path);
  const descriptionText = props.description ?? meta?.description ?? null;
  const restartRequired = meta ? meta.restart === true : false;
  // T43b: catalog-driven validation. `validateKnobValue` returns
  // `{ok, message, reason, ...}`; we surface the message inline so
  // the operator sees a red ⚠ + a one-liner explaining why the
  // value was rejected BEFORE clicking Save.
  const rawNumeric = isNumeric ? (typeof value === 'number' ? value : Number(value)) : value;
  const validation = isNumeric ? validateKnobValue(meta, rawNumeric) : { ok: true, message: null, reason: 'ok' };
  const rangeHintText = renderRangeHint(meta);
  const effectiveStep = (meta && Number.isFinite(meta.step)) ? meta.step : step;

  const handleChange = (e) => {
    if (disabled) return;
    if (isNumeric) {
      const n = parseFloat(e.target.value);
      onChange(path, isNaN(n) ? e.target.value : n);
    } else {
      onChange(path, e.target.value);
    }
  };

  // T43b: clamp to catalog bounds on blur so an out-of-range
  // value snaps back into the safe envelope instead of being
  // sent to the server. For booleans/text we re-emit the value
  // as-is so the `onBlur` doesn't lose user input.
  const handleBlur = () => {
    if (disabled) return;
    if (!isNumeric) return;
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return; // leave invalid input alone for the operator to fix
    const clamped = clampKnobValue(meta, n);
    if (clamped !== n) onChange(path, clamped);
  };

  const validationError = validation.ok ? null : validation.message;

  // T43c: reset-to-default availability + baseline tooltip.
  // `resetDisabled` is true when the operator can't use the link:
  //   - read-only mode (no ?token=...)
  //   - defaults fetch failed / not yet loaded
  //   - the path is missing from default.json (catalog drift)
  //   - the current value already equals the baseline (no-op)
  // The baseline value is also captured for the help popover so
  // both affordances show the SAME number — they can't drift.
  const resetDisabledReason = (() => {
    if (disabled) return 'read-only mode';
    if (!defaultConfig || typeof defaultConfig !== 'object') return 'defaults not loaded';
    const lookup = defaultValueAtPath(defaultConfig, path);
    if (!lookup || !lookup.found) return 'baseline missing in default.json';
    if (Object.is(lookup.value, value)) return 'already at baseline';
    return null;
  })();
  const resetBaselineTooltip = (() => {
    if (!defaultConfig || typeof defaultConfig !== 'object') return 'defaults not loaded';
    const lookup = defaultValueAtPath(defaultConfig, path);
    if (!lookup || !lookup.found) return 'baseline missing in default.json';
    return `reset to baseline: ${String(lookup.value)}`;
  })();

  // T43c: build the help popover payload once per render so the
  // table inside has fresh data (defaults + current value). The
  // helper is pure, so this is cheap.
  const helpPopover = buildHelpPopover(meta, { defaultConfig });

  return (
    <div className="space-y-1">
      <div className="grid grid-cols-12 items-center gap-3">
        <label htmlFor={id} className="col-span-4 flex items-center gap-1 truncate text-xs font-mono text-ash-200" title={label}>
          <span className="truncate">{label}</span>
          {restartRequired && (
            <span
              className="inline-flex shrink-0 items-center rounded border border-amber-700/60 bg-amber-950/40 px-1 text-[9px] font-mono uppercase tracking-wider text-amber-200"
              title="This knob requires a bot restart to take effect. scripts/run-bot.mjs loads config once at startup, so changes to config/user.json do NOT hot-reload the running loop."
            >
              restart
            </span>
          )}
        </label>
        <div className="col-span-5">
          <input
            id={id}
            type={type}
            step={effectiveStep}
            min={meta && Number.isFinite(meta.min) ? meta.min : undefined}
            max={meta && Number.isFinite(meta.max) ? meta.max : undefined}
            value={strVal}
            onChange={handleChange}
            onBlur={handleBlur}
            disabled={disabled}
            aria-invalid={validationError ? 'true' : 'false'}
            title={validationError || rangeHintText || undefined}
            className={`w-full rounded border bg-ink-800 px-2 py-1 font-mono text-xs text-ash-100 focus:outline-none focus:ring-1 disabled:opacity-50 ${
              validationError
                ? 'border-pnl-loss/70 focus:ring-pnl-loss/60'
                : 'border-ink-600 hover:border-ink-500 focus:ring-bch-500'
            } ${disabled ? 'border-ink-700' : ''}`}
          />
        </div>
        <div className="col-span-3 flex items-center justify-end gap-2 truncate text-right text-xs text-ash-400" title={displayVal}>
          {validationError && (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded border border-pnl-loss/60 bg-pnl-loss/10 px-1 text-[10px] font-mono uppercase tracking-wider text-pnl-loss"
              title={validationError}
            >
              ⚠ {validationError}
            </span>
          )}
          <span className="truncate">{displayVal}</span>
          {/* T43c: per-knob reset-to-default link. ⤺ glyph plus a
              hover tooltip explaining what the baseline is (or why
              the link is disabled). Clicking it calls
              `onResetKnob(path)`, which forwards through to
              `handleChange(path, defaultValue)`. */}
          <button
            type="button"
            onClick={() => { if (!resetDisabledReason && typeof onResetKnob === 'function') onResetKnob(path); }}
            disabled={Boolean(resetDisabledReason)}
            title={resetDisabledReason || resetBaselineTooltip}
            aria-label={`reset ${label} to default`}
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-ink-600 bg-ink-800 text-[11px] font-mono text-ash-300 transition-colors hover:border-amber-500 hover:text-amber-200 focus:outline-none focus:ring-1 focus:ring-amber-500 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-ink-600 disabled:hover:text-ash-300"
          >
            ⤺
          </button>
          {/* T43c: per-knob help popover. Pure CSS hover/focus open
              via a `<details>` element — no JS state, no React
              portal, no event listeners. Closes on the next
              outside-click because `<details>` natively does that
              when summary-click is the trigger. */}
          <KnobHelp meta={meta} popover={helpPopover} />
        </div>
      </div>
      {helper ? (
        <div className="grid grid-cols-12 gap-3">
          <div className="col-span-4" />
          <div className="col-span-8 text-[10px] font-mono uppercase tracking-wider text-ash-400">{helper}</div>
        </div>
      ) : null}
      {descriptionText ? (
        <div className="grid grid-cols-12 gap-3">
          <div className="col-span-4" />
          <div className="col-span-8 text-[11px] leading-snug text-ash-300">{descriptionText}</div>
        </div>
      ) : null}
    </div>
  );
}

function KnobToggle(props) {
  const { path, label, value, onChange, disabled, description, visible, defaultConfig, onResetKnob } = props;
  if (visible && !visible.has(path.join('.'))) return null;
  const id = `knob-${path.join('-')}`;
  const checked = Boolean(value);
  // T43: same catalog lookup as KnobRow so toggles also surface
  // a restart badge + the catalog's description.
  const meta = lookupKnobMeta(path);
  const descriptionText = description ?? meta?.description ?? null;
  const restartRequired = meta ? meta.restart === true : false;
  const handleChange = (e) => {
    if (disabled) return;
    onChange(path, e.target.checked);
  };
  // T43c: toggle-specific reset button + help popover. Identical
  // semantics to KnobRow's — disabled in read-only / no-defaults /
  // already-at-baseline / missing-from-defaults cases.
  const resetDisabledReason = (() => {
    if (disabled) return 'read-only mode';
    if (!defaultConfig || typeof defaultConfig !== 'object') return 'defaults not loaded';
    const lookup = defaultValueAtPath(defaultConfig, path);
    if (!lookup || !lookup.found) return 'baseline missing in default.json';
    if (Object.is(lookup.value, value)) return 'already at baseline';
    return null;
  })();
  const resetBaselineTooltip = (() => {
    if (!defaultConfig || typeof defaultConfig !== 'object') return 'defaults not loaded';
    const lookup = defaultValueAtPath(defaultConfig, path);
    if (!lookup || !lookup.found) return 'baseline missing in default.json';
    return `reset to baseline: ${String(lookup.value)}`;
  })();
  const helpPopover = buildHelpPopover(meta, { defaultConfig });
  return (
    <div className="grid grid-cols-12 items-start gap-3">
      <label htmlFor={id} className="col-span-4 flex items-center gap-1 truncate pt-1 text-xs font-mono text-ash-200" title={label}>
        <span className="truncate">{label}</span>
        {restartRequired && (
          <span
            className="inline-flex shrink-0 items-center rounded border border-amber-700/60 bg-amber-950/40 px-1 text-[9px] font-mono uppercase tracking-wider text-amber-200"
            title="This knob requires a bot restart to take effect."
          >
            restart
          </span>
        )}
      </label>
      <div className="col-span-5 flex items-center gap-2">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={handleChange}
          disabled={disabled}
          className={`h-4 w-4 rounded border bg-ink-800 text-bch-500 focus:ring-1 focus:ring-bch-500 disabled:opacity-50 ${
            disabled ? 'border-ink-700' : 'border-ink-600 hover:border-ink-500'
          }`}
        />
        <span className="font-mono text-xs uppercase tracking-wider text-ash-300">{checked ? 'on' : 'off'}</span>
      </div>
      <div className="col-span-3 flex items-center justify-end gap-2 truncate text-right text-xs text-ash-400">
        <button
          type="button"
          onClick={() => { if (!resetDisabledReason && typeof onResetKnob === 'function') onResetKnob(path); }}
          disabled={Boolean(resetDisabledReason)}
          title={resetDisabledReason || resetBaselineTooltip}
          aria-label={`reset ${label} to default`}
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-ink-600 bg-ink-800 text-[11px] font-mono text-ash-300 transition-colors hover:border-amber-500 hover:text-amber-200 focus:outline-none focus:ring-1 focus:ring-amber-500 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-ink-600 disabled:hover:text-ash-300"
        >
          ⤺
        </button>
        <KnobHelp meta={meta} popover={helpPopover} />
        <span className="truncate" title={checked ? 'on' : 'off'}>{checked ? 'on' : 'off'}</span>
      </div>
      {descriptionText ? (
        <div className="col-span-12 -mt-1 ml-[33.333%] text-[11px] leading-snug text-ash-300">{descriptionText}</div>
      ) : null}
    </div>
  );
}

// ─── T57-3: multi-checkbox knob primitive ────────────────────────────
//
// Special-purpose primitive for `dex.active` (an array of strings
// — one checkbox per known adapter id from
// `src/dex/adapter.mjs#KNOWN_DEX_IDS`). The standard catalog
// contract is number / boolean / text, so the existing KnobRow
// + KnobToggle primitives can't render this — we ship a focused
// helper that:
//   1. Renders one checkbox per known id, ticked when the id is
//      in `value`.
//   2. On toggle, replaces `value` with a NEW array containing
//      the toggled membership (so `onChange` writes the whole
//      array back into the form state — that's what
//      `resolveDexConfig` validates on the backend).
//   3. Hides itself when the panel's `visible` filter excludes
//      the row's path (same behaviour as KnobRow / KnobToggle).
//   4. Surfaces the catalog row for the path so the description +
//      restart-required badge come from the shared source.
//   5. Falls back gracefully when `value` is null / undefined /
//      not-an-array (the catalog guarantees an array, but the
//      dashboard must not crash if a future config shape omits
//      the key — it just shows an empty list).
//
// We deliberately don't add a knob-catalog entry for `dex.active`
// itself — arrays don't fit the typed validation contract. The
// shape is enforced at the backend in `src/dex/adapter.mjs#
// resolveDexConfig`, which is the layer the trader loop boots
// from anyway.
function KnobActiveDexList(props) {
  const { path, label, value, onChange, disabled, description, visible, defaultConfig, onResetKnob } = props;
  if (visible && !visible.has(path.join('.'))) return null;
  // `KNOWN_DEX_IDS` is imported as an alias `listKnownDexIds` for
  // readability (the catalog comment refers to it as a function).
  // It's actually a frozen array — calling it as a function
  // (`listKnownDexIds()`) was a regression that crashed the
  // Settings page with "TypeError: <arr> is not a function"
  // (minified: "gre is not a function"). Just reference the array
  // directly.
  const ids = listKnownDexIds;
  const selected = Array.isArray(value) ? new Set(value.filter((v) => typeof v === 'string')) : new Set();
  const handleToggle = (id, checked) => {
    if (disabled) return;
    const next = new Set(selected);
    if (checked) next.add(id);
    else next.delete(id);
    // Preserve catalog order (ids is the canonical order from the
    // frozen registry) so save payloads are stable across toggles.
    const nextArr = ids.filter((id) => next.has(id));
    onChange(path, nextArr);
  };
  // T43c parity: per-knob reset + help-popover support.
  const meta = lookupKnobMeta(path);
  const descriptionText = description ?? null;
  const restartRequired = false; // catalog has no entry for the array; restart hint surfaces via safe_mode_active
  const resetDisabledReason = (() => {
    if (disabled) return 'read-only mode';
    if (!defaultConfig || typeof defaultConfig !== 'object') return 'defaults not loaded';
    const lookup = defaultValueAtPath(defaultConfig, path);
    if (!lookup || !lookup.found) return 'baseline missing in default.json';
    const base = Array.isArray(lookup.value) ? lookup.value : [];
    const sameLen = base.length === selected.size;
    const sameSet = sameLen && base.every((v) => selected.has(v));
    if (sameSet) return 'already at baseline';
    return null;
  })();
  const resetBaselineTooltip = (() => {
    if (!defaultConfig || typeof defaultConfig !== 'object') return 'defaults not loaded';
    const lookup = defaultValueAtPath(defaultConfig, path);
    if (!lookup || !lookup.found) return 'baseline missing in default.json';
    return `reset to baseline: [${(Array.isArray(lookup.value) ? lookup.value : []).join(', ')}]`;
  })();
  return (
    <div className="grid grid-cols-12 items-start gap-3">
      <label className="col-span-4 flex items-center gap-1 truncate pt-1 text-xs font-mono text-ash-200" title={label}>
        <span className="truncate">{label}</span>
        {restartRequired && (
          <span className="inline-flex shrink-0 items-center rounded border border-amber-700/60 bg-amber-950/40 px-1 text-[9px] font-mono uppercase tracking-wider text-amber-200">restart</span>
        )}
      </label>
      <div className="col-span-5 flex flex-col gap-1">
        {ids.map((id) => (
          <label key={id} className="flex items-center gap-2 text-xs font-mono text-ash-200">
            <input
              type="checkbox"
              checked={selected.has(id)}
              onChange={(e) => handleToggle(id, e.target.checked)}
              disabled={disabled}
              className={`h-4 w-4 rounded border bg-ink-800 text-bch-500 focus:ring-1 focus:ring-bch-500 disabled:opacity-50 ${
                disabled ? 'border-ink-700' : 'border-ink-600 hover:border-ink-500'
              }`}
            />
            <span className="truncate" title={id}>{id}</span>
            <span className="text-[10px] uppercase tracking-wider text-ash-400">
              {selected.has(id) ? 'on' : 'off'}
            </span>
          </label>
        ))}
        {ids.length === 0 && (
          <span className="text-xs text-ash-400">no registered adapters</span>
        )}
      </div>
      <div className="col-span-3 flex items-center justify-end gap-2 truncate text-right text-xs text-ash-400">
        <button
          type="button"
          onClick={() => { if (!resetDisabledReason && typeof onResetKnob === 'function') onResetKnob(path); }}
          disabled={Boolean(resetDisabledReason)}
          title={resetDisabledReason || resetBaselineTooltip}
          aria-label={`reset ${label} to default`}
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-ink-600 bg-ink-800 text-[11px] font-mono text-ash-300 transition-colors hover:border-amber-500 hover:text-amber-200 focus:outline-none focus:ring-1 focus:ring-amber-500 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-ink-600 disabled:hover:text-ash-300"
        >
          ⤺
        </button>
        <span className="truncate" title={Array.from(selected).join(', ') || '—'}>
          {selected.size} of {ids.length}
        </span>
      </div>
      {descriptionText ? (
        <div className="col-span-12 -mt-1 ml-[33.333%] text-[11px] leading-snug text-ash-300">{descriptionText}</div>
      ) : null}
      {meta && meta.description && !descriptionText ? (
        <div className="col-span-12 -mt-1 ml-[33.333%] text-[11px] leading-snug text-ash-300">{meta.description}</div>
      ) : null}
    </div>
  );
}

// ─── T43c: per-knob help popover ──────────────────────────────────────
//
// Pure-CSS popover driven by a `<details>`/`<summary>` pair. No
// React state, no portal, no event listeners — the browser
// natively handles open/close on click and ESC-to-close. We pin
// the popover's open/close state inside the popover scope so
// toggling one knob's help never closes another.
//
// The popover body is a structured table built from the
// `popover.rows` array `buildHelpPopover` returned — every row is
// `{ label, value }` so the React layer just maps to JSX.
function KnobHelp(props) {
  const { meta, popover } = props;
  if (!meta || !popover || !Array.isArray(popover.rows) || popover.rows.length === 0) {
    // No catalog entry for this path → no help button at all
    // (keeps the Settings view tidy and matches the description
    // / restart-badge fallback behavior elsewhere).
    return null;
  }
  const description = meta.description ?? null;
  return (
    <details className="group relative inline-block shrink-0">
      <summary
        className="inline-flex h-5 w-5 cursor-help list-none items-center justify-center rounded-full border border-ink-600 bg-ink-800 text-[11px] font-mono text-ash-300 transition-colors hover:border-bch-500 hover:text-bch-200 focus:outline-none focus:ring-1 focus:ring-bch-500 [&::-webkit-details-marker]:hidden"
        title={`help for ${meta.label}`}
        aria-label={`help for ${meta.label}`}
      >
        ?
      </summary>
      <div
        role="tooltip"
        className="absolute right-0 top-6 z-20 w-72 max-w-[28rem] rounded border border-ink-700 bg-ink-900/95 p-3 text-xs text-ash-100 shadow-lg backdrop-blur-sm"
      >
        <div className="mb-2 flex items-center gap-2">
          <span className="font-mono text-[11px] uppercase tracking-wider text-ash-400">{meta.group}</span>
          <span className="text-ash-500">·</span>
          <span className="truncate font-mono text-[11px] text-ash-300" title={meta.key}>{meta.key}</span>
        </div>
        {description ? (
          <p className="mb-2 text-[11px] leading-snug text-ash-200">{description}</p>
        ) : null}
        <table className="w-full border-collapse text-[11px]">
          <tbody>
            {popover.rows.map((r) => (
              <tr key={r.label} className="border-t border-ink-700/60 first:border-t-0">
                <th scope="row" className="w-24 py-1 pr-2 text-left align-top font-mono uppercase tracking-wider text-ash-400">{r.label}</th>
                <td className="py-1 align-top font-mono text-ash-200">
                    <span className="break-words">{r.value}</span>
                  </td>
              </tr>
            ))}
          </tbody>
        </table>
        {meta.restart ? (
          <p className="mt-2 border-t border-ink-700/60 pt-2 text-[10px] leading-snug text-amber-300/90">
            Requires a bot restart. Changes to config/user.json do NOT hot-reload the running loop.
          </p>
        ) : null}
      </div>
    </details>
  );
}

function KnobDisplay(props) {
  return (
    <div className="flex items-center gap-3">
      <span className="label w-40 shrink-0">{props.label}</span>
      <span className="num text-sm text-ash-100">{props.value}</span>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────

/** Deep-copy a JSON-compatible object. */
function deepCopy(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(deepCopy);
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, deepCopy(v)]));
}