// dashboard/src/views/ManualTradePanel.jsx
//
// T45b: the click-to-fire surface for `POST /api/trade/manual`. A
// "Manual Trade" button on the Portfolio view (and a similar
// button on the Trades view header) opens an inline panel with
// the form fields the operator needs:
//
//   - side           buy | sell (radio)
//   - token          autocomplete from `GET /api/pools/top` (the
//                    indexer's TVL-ranked discovery list) + a
//                    free-text paste slot for tokens the
//                    autocomplete doesn't surface
//   - amount_bch     number input (positive finite)
//   - expected_rate  optional, positive finite; pre-filled from the
//                    indexer's spot rate when available
//   - dry_run        boolean toggle; defaults ON so a new operator
//                    can't fire a real swap until they've clicked
//                    "Preview quote" at least once
//
// Submit pipeline:
//   1. "Preview quote"  → POST with `dry_run: true`   → render the
//      `formatManualQuote(result,side)` card under the form so the
//      operator sees slippage / lpFee / networkFee / balance-after
//      BEFORE they fire a real swap.
//   2. "Execute trade"  → POST with the draft's `dry_run` flag
//      → render a result toast with the txid (with a chipnet
//      explorer link when dry-run; otherwise mainnet via the
//      canonical operator-picked BCH explorer at
//      https://explorer.salemkode.com/tx/<txid> — see
//      `src/lib/explorer-urls.mjs` for the URL builder).
//
// Same auth + risk gates as the backend: write endpoints require
// `dashboard.api_token` to be set in `user.json`. The panel
// surfaces the 503 "AUTH_NOT_CONFIGURED" error inline so the
// operator can tell why their click didn't fire.
//
// Design notes:
//   - State is held in the parent (`Portfolio.jsx` / `Trades.jsx`)
//     so the panel stays a pure presentational component — every
//     helper lives in `manual-trade-helpers.mjs` and is unit-tested
//     under `node --test`.
//   - The autocomplete uses a plain `<input list="...">` + a
//     `<datalist>` of normalized options rather than a custom
//     dropdown: this keeps the markup small, gives the operator
//     keyboard navigation + paste-anywhere behavior for free, and
//     doesn't require a click-to-open affordance.
//   - The "result toast" lives in a state slot on the parent (the
//     `lastResult` prop). When the operator navigates away and
//     back, the toast clears on the next load.

import React, { useCallback, useEffect, useMemo, useState } from 'react';

import {
  emptyManualDraft,
  validateManualDraft,
  buildManualTradeBody,
  filterPoolOptions,
  poolOptionLabel,
  poolOptionHint,
  formatManualQuote,
  canExecuteManualTrade,
  normalizeManualTokenId,
  formatSatsShort,
} from './manual-trade-helpers.mjs';
import { buildExplorerTxUrl } from '../lib/explorer-urls.mjs';

/**
 * @param {Object} props
 * @param {Object} props.api               createApiClient instance from useApi()
 * @param {number} [props.refreshMs=30000] poll interval for /api/pools/top
 * @param {Object|null} [props.lastResult] latest trade result envelope (parent state)
 * @param {Function} [props.onResult]      callback to lift the result into parent state
 * @param {Function} [props.onBusy]        callback to expose busy state to the parent
 */
export default function ManualTradePanel(props) {
  const api = props.api;
  const refreshMs = (typeof props.refreshMs === 'number' && props.refreshMs > 0)
    ? Math.floor(props.refreshMs) : 30_000;
  const lastResult = props.lastResult ?? null;
  const onResult = props.onResult || (() => {});
  const onBusy = props.onBusy || (() => {});

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => emptyManualDraft());
  const [pools, setPools] = useState(/** @type {any[]} */ ([]));
  const [poolsErr, setPoolsErr] = useState(/** @type {string|null} */ (null));
  const [poolQuery, setPoolQuery] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState(/** @type {string|null} */ (null));
  const [quote, setQuote] = useState(/** @type {any} */ (null));
  const [quoteDryRun, setQuoteDryRun] = useState(true);

  // Pull the indexer pool list once + every refreshMs. The list is
  // cheap (capped at 50 by the backend) and powers the
  // autocomplete, so we keep it warm even when the panel is
  // collapsed — the open() click shouldn't trigger a network
  // round-trip.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const r = await api.poolsTop({ limit: 50 });
      if (cancelled) return;
      if (!r.ok) {
        setPoolsErr(r.error || 'unavailable');
        setPools([]);
        return;
      }
      setPoolsErr(null);
      const list = (r.data && Array.isArray(r.data.pools)) ? r.data.pools : [];
      setPools(list);
    };
    load();
    const id = setInterval(load, refreshMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [api, refreshMs]);

  const filteredPools = useMemo(() => filterPoolOptions(pools, poolQuery), [pools, poolQuery]);

  const validationErrs = useMemo(() => validateManualDraft(draft), [draft]);
  const canExecute = canExecuteManualTrade(draft);

  const updateDraft = useCallback((patch) => {
    setDraft((prev) => ({ ...prev, ...patch }));
    // Clear the quote whenever the draft changes — a stale quote
    // is worse than no quote because it shows pre-flight numbers
    // that no longer match the operator's inputs.
    setQuote(null);
  }, []);

  const onSelectPool = useCallback((opt) => {
    if (!opt || typeof opt !== 'object') return;
    updateDraft({
      tokenIdInput: String(opt.token_id || ''),
      selectedPool: opt,
    });
  }, [updateDraft]);

  const onReset = useCallback(() => {
    setDraft(emptyManualDraft());
    setQuote(null);
    setSubmitErr(null);
    setPoolQuery('');
  }, []);

  const fireTrade = useCallback(async (dryRun) => {
    const body = buildManualTradeBody({ ...draft, dryRun });
    if (!body) {
      setSubmitErr('draft has validation errors — fix them and try again');
      return;
    }
    setSubmitting(true);
    onBusy(true);
    setSubmitErr(null);
    try {
      const r = await api.tradeManual(body);
      if (!r.ok) {
        const msg = r.error || 'trade failed';
        setSubmitErr(msg);
        // Lift a failure envelope into parent state so the toast
        // (rendered by the parent) shows it on next paint.
        onResult({
          ok: false,
          side: body.side,
          token_id: body.token_id,
          amount_bch: body.amount_bch,
          dry_run: body.dry_run,
          error: msg,
          errorKind: r.code || 'HTTP_ERROR',
          ts: new Date().toISOString(),
        });
        return;
      }
      const envelope = r.data;
      onResult(envelope);
      // For dry-run previews we render the quote inline (so the
      // operator sees slippage + fees before they commit); for
      // real runs the parent surfaces the result toast.
      if (dryRun) {
        const swap = envelope && envelope.swap;
        setQuote(swap);
        setQuoteDryRun(true);
      } else {
        setQuote(null);
      }
    } catch (e) {
      const msg = (e && typeof e === 'object' && e.message) || String(e);
      setSubmitErr(`unexpected error: ${msg}`);
    } finally {
      setSubmitting(false);
      onBusy(false);
    }
  }, [api, draft, onResult, onBusy]);

  const renderResultToast = () => {
    if (!lastResult) return null;
    const txid = (lastResult.swap && typeof lastResult.swap.txid === 'string') ? lastResult.swap.txid : null;
    const explorerHref = buildExplorerTxUrl(txid);
    const isDry = lastResult.dry_run === true;
    return (
      <div
        data-testid="manual-trade-result"
        className={`mt-3 rounded border px-3 py-2 text-xs font-mono ${
          lastResult.ok
            ? 'border-bch-500/60 text-bch-200 bg-bch-500/10'
            : 'border-pnl-loss/60 text-pnl-loss bg-pnl-loss/10'
        }`}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span>
            {lastResult.ok
              ? (isDry ? '✓ preview ok' : '✓ trade submitted')
              : `✗ ${lastResult.errorKind || 'failed'}`}
          </span>
          <span className="text-ash-400">{lastResult.side} · {formatSatsShort(Number(lastResult.amount_bch) * 1e8)}</span>
        </div>
        {!lastResult.ok && lastResult.error && (
          <div className="mt-1 text-ash-300 break-all">{lastResult.error}</div>
        )}
        {lastResult.ok && txid && (
          <div className="mt-1 text-ash-200 break-all">
            <span className="text-ash-400">txid: </span>
            {explorerHref ? (
              <a className="underline text-bch-300 hover:text-bch-200" href={explorerHref} target="_blank" rel="noreferrer">
                {txid}
              </a>
            ) : txid}
          </div>
        )}
        <button
          type="button"
          data-testid="manual-trade-dismiss"
          onClick={() => onResult(null)}
          className="mt-2 rounded border border-ink-700 px-2 py-0.5 text-[10px] uppercase tracking-wider text-ash-300 hover:bg-ink-800"
        >
          dismiss
        </button>
      </div>
    );
  };

  const renderQuote = () => {
    if (!quote) return null;
    const q = formatManualQuote(quote, draft.side);
    return (
      <div
        data-testid="manual-trade-quote"
        className="mt-3 rounded border border-ink-700 bg-ink-900/60 p-3 text-xs"
      >
        <div className="mb-2 flex items-baseline justify-between">
          <span className="font-mono uppercase tracking-wider text-bch-400 text-[10px]">
            preview quote {quoteDryRun ? '(dry-run)' : ''}
          </span>
          {q.slippageLabel && (
            <span className="font-mono num text-ash-200">slippage {q.slippageLabel}</span>
          )}
        </div>
        <dl className="grid grid-cols-2 gap-y-1 sm:grid-cols-3">
          <QuoteRow label="effective rate" value={q.rateLabel} />
          <QuoteRow label="amount" value={q.amountLabel} />
          <QuoteRow label="LP fee" value={q.lpFeeLabel} />
          <QuoteRow label="network fee" value={q.networkFeeLabel} />
          <QuoteRow label="balance after" value={q.balanceAfterLabel} />
        </dl>
      </div>
    );
  };

  return (
    <section data-testid="manual-trade-panel" className="rounded border border-bch-700/40 bg-bch-500/5">
      <header className="flex items-center justify-between gap-2 border-b border-bch-700/40 px-4 py-2">
        <div className="min-w-0">
          <h3 className="panel-title border-0 px-0 py-0 text-bch-300">Manual Trade</h3>
          <p className="mt-0.5 text-[11px] text-ash-400 leading-snug">
            operator override — runs the same risk gates + slippage check as the bot's loop.
          </p>
        </div>
        <button
          type="button"
          data-testid="manual-trade-toggle"
          onClick={() => setOpen(!open)}
          className="rounded border border-bch-500/60 px-3 py-1 text-xs font-mono uppercase tracking-wider text-bch-300 hover:bg-bch-500/10"
        >
          {open ? 'collapse' : 'open'}
        </button>
      </header>
      {open && (
        <div className="p-4 space-y-3">
          {poolsErr && (
            <div className="text-[11px] text-ash-400">
              pool list unavailable ({poolsErr}) — paste a token_id manually
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="side">
              <div className="flex gap-2">
                {(['buy', 'sell']).map((s) => (
                  <button
                    key={s}
                    type="button"
                    data-testid={`manual-trade-side-${s}`}
                    onClick={() => updateDraft({ side: s })}
                    className={`flex-1 rounded border px-3 py-1.5 text-xs font-mono uppercase tracking-wider transition-colors ${
                      draft.side === s
                        ? 'border-bch-500 bg-bch-500/10 text-bch-300'
                        : 'border-ink-700 text-ash-200 hover:bg-ink-800'
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="amount (BCH)">
              <input
                type="number"
                step="0.0001"
                min="0"
                data-testid="manual-trade-amount"
                value={draft.amountBch}
                onChange={(e) => updateDraft({ amountBch: e.target.value })}
                placeholder="0.005"
                className="w-full rounded border border-ink-700 bg-ink-950 px-2 py-1.5 text-sm text-ash-100 focus:outline-none focus:border-bch-500"
              />
            </Field>
          </div>
          <Field label="token (paste id or pick from list)">
            <input
              type="text"
              list="manual-trade-pools"
              data-testid="manual-trade-token-input"
              value={draft.tokenIdInput}
              onChange={(e) => {
                const v = e.target.value;
                updateDraft({ tokenIdInput: v, selectedPool: null });
                setPoolQuery(v);
              }}
              placeholder={poolsErr ? '64-hex token category id' : 'search by symbol or paste id'}
              className="w-full rounded border border-ink-700 bg-ink-950 px-2 py-1.5 text-xs text-ash-100 focus:outline-none focus:border-bch-500 font-mono"
            />
            <datalist id="manual-trade-pools">
              {filteredPools.map((opt) => (
                <option key={opt.token_id} value={opt.token_id}>
                  {poolOptionLabel(opt)} — {poolOptionHint(opt)}
                </option>
              ))}
            </datalist>
            {draft.selectedPool && (
              <div className="mt-1 text-[10px] text-ash-400">
                selected: {poolOptionLabel(draft.selectedPool)} ({poolOptionHint(draft.selectedPool)})
              </div>
            )}
          </Field>
          <Field label="expected rate (sat/token, optional)">
            <input
              type="number"
              step="0.01"
              min="0"
              data-testid="manual-trade-rate"
              value={draft.expectedRate}
              onChange={(e) => updateDraft({ expectedRate: e.target.value })}
              placeholder="leave blank for indexer spot rate"
              className="w-full rounded border border-ink-700 bg-ink-950 px-2 py-1.5 text-xs text-ash-100 focus:outline-none focus:border-bch-500 font-mono"
            />
          </Field>
          <Field label="dry-run">
            <label className="inline-flex items-center gap-2 text-xs text-ash-200">
              <input
                type="checkbox"
                data-testid="manual-trade-dryrun"
                checked={draft.dryRun === true}
                onChange={(e) => updateDraft({ dryRun: e.target.checked })}
                className="rounded border border-ink-700 bg-ink-950"
              />
              <span>
                preview only (no broadcast) — leave ON until you've seen the quote.
              </span>
            </label>
          </Field>

          {validationErrs.length > 0 && (
            <ul data-testid="manual-trade-errs" className="text-[11px] text-pnl-loss list-disc pl-5">
              {validationErrs.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          )}
          {submitErr && (
            <div data-testid="manual-trade-submit-err" className="text-[11px] text-pnl-loss">{submitErr}</div>
          )}

          {renderQuote()}

          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              data-testid="manual-trade-preview"
              onClick={() => fireTrade(true)}
              disabled={submitting || !canExecute}
              className="rounded border border-ink-600 px-3 py-1.5 text-xs font-mono uppercase tracking-wider text-ash-200 hover:bg-ink-800 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? 'previewing…' : 'preview quote'}
            </button>
            <button
              type="button"
              data-testid="manual-trade-execute"
              onClick={() => fireTrade(draft.dryRun === true)}
              disabled={submitting || !canExecute}
              className="rounded border border-bch-500/60 px-3 py-1.5 text-xs font-mono uppercase tracking-wider text-bch-300 hover:bg-bch-500/10 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? 'submitting…' : (draft.dryRun ? 'execute (dry-run)' : 'execute trade')}
            </button>
            <button
              type="button"
              data-testid="manual-trade-reset"
              onClick={onReset}
              className="rounded border border-ink-700 px-3 py-1.5 text-xs font-mono uppercase tracking-wider text-ash-300 hover:bg-ink-800"
            >
              reset
            </button>
          </div>

          {renderResultToast()}
        </div>
      )}
    </section>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="block text-[10px] font-mono uppercase tracking-wider text-ash-400 mb-1">{label}</span>
      {children}
    </label>
  );
}

function QuoteRow({ label, value }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <>
      <dt className="text-[10px] font-mono uppercase tracking-wider text-ash-400">{label}</dt>
      <dd className="col-span-2 sm:col-span-2 font-mono num text-ash-100">{value}</dd>
    </>
  );
}

// Exported so test suites can hit the internal helpers without
// re-implementing the wrapper. Keeps the public surface tight:
// parent components import ManualTradePanel; tests import the
// helpers directly from manual-trade-helpers.mjs.
export { normalizeManualTokenId };
