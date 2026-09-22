// dashboard/src/components/TokenHoldersCard.jsx
//
// T76 subset 2c — Dashboard tile that consumes
// `/api/token/:tokenId/holders` (shipped in T76 subset 1 + subset
// 2a + subset 2c). The tile mounts below the FeeBreakdownCard on
// Dashboard.jsx and renders two views:
//
//   1. **Empty/landing state** (default when no `tokenId` has been
//      looked up): a "paste a token_id →" input + a "Lookup"
//      button that fetches `/api/token/<id>/holders` on submit.
//      Result populates the detail view.
//
//   2. **Detail view**: header card with token_id (truncated +
//      copy-to-clipboard), top-N % (large numeric, color-coded),
//      rug-pattern pill (RUG / ok / unknown), source badge
//      (TokenStork / fixture / cache), cache age, holders-count
//      + total-supply-human, a `?refresh=true` "Refresh" button
//      that re-fetches with `cache_flushed:true`, and the holders
//      table below.
//
// Failure model: every API call returns `{ok, data, error}`. On
// `ok:false` the tile renders a typed error pill
// (token_not_found / scanner_cache_not_wired / scanner_failed /
// fixture_parse_failed) with the underlying message. The subset-1
// stub envelope (error: 'scanner_not_implemented') renders an
// amber pill with the "use ?holders=<json>" remediation hint.
//
// The card subscribes to `useRefresh().tick` ONLY for the
// cache-age countdown (so the "cached 47s ago" label refreshes
// every 60s); the detail-fetch itself is on-demand (operator
// clicks Lookup or Refresh).

import React, { useCallback, useEffect, useState } from 'react';
import { useApi, useRefresh } from '../lib/api-context.jsx';
import {
  buildHolderRow,
  buildHolderHeader,
  isHoldersUnavailable,
  isHoldersStub,
  isHoldersFixture,
  holderErrorKey,
  holderErrorHint,
} from '../views/token-holders-helpers.mjs';

export default function TokenHoldersCard() {
  const { api } = useApi();
  const { tick } = useRefresh();
  const [tokenInput, setTokenInput] = useState('');
  const [activeToken, setActiveToken] = useState(null);
  const [fixtureInput, setFixtureInput] = useState('');
  const [showFixtureInput, setShowFixtureInput] = useState(false);
  const [env, setEnv] = useState(/** @type {any} */ (null));
  const [err, setErr] = useState(/** @type {string|null} */ (null));
  const [loading, setLoading] = useState(false);
  const [refreshed, setRefreshed] = useState(false);
  const [copyHint, setCopyHint] = useState('');

  const lookup = useCallback(async (tokenId, { refresh = false, fixture = null } = {}) => {
    if (typeof tokenId !== 'string' || tokenId.length === 0) return;
    const trimmed = tokenId.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(trimmed)) {
      setErr('token_id must be a 64-char lowercase hex string');
      setEnv(null);
      setActiveToken(tokenId);
      return;
    }
    setActiveToken(trimmed);
    setLoading(true);
    setErr(null);
    setRefreshed(refresh === true);
    try {
      const r = await api.tokenHolders({
        tokenId: trimmed,
        ...(refresh === true ? { refresh: true } : {}),
        ...(typeof fixture === 'string' && fixture.length > 0 ? { fixture } : {}),
      });
      if (!r.ok) {
        setErr(r.error || 'request failed');
        setEnv(null);
      } else {
        setEnv(r.data);
        setErr(null);
      }
    } catch (e) {
      setErr(String(e && e.message ? e.message : 'unknown error'));
      setEnv(null);
    } finally {
      setLoading(false);
    }
  }, [api]);

  const onLookupClick = useCallback(() => {
    lookup(tokenInput, {});
  }, [lookup, tokenInput]);

  const onRefreshClick = useCallback(() => {
    if (typeof activeToken === 'string' && activeToken.length > 0) {
      lookup(activeToken, { refresh: true });
    }
  }, [lookup, activeToken]);

  const onFixtureSubmit = useCallback(() => {
    if (typeof activeToken !== 'string' || activeToken.length === 0) return;
    if (typeof fixtureInput !== 'string' || fixtureInput.trim().length === 0) return;
    lookup(activeToken, { fixture: fixtureInput.trim() });
  }, [lookup, activeToken, fixtureInput]);

  const onCopyTokenId = useCallback(async () => {
    if (typeof activeToken !== 'string' || activeToken.length === 0) return;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(activeToken);
      } else {
        const ta = document.createElement('textarea');
        ta.value = activeToken;
        ta.setAttribute('readonly', '');
        ta.style.position = 'absolute';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopyHint('copied');
      setTimeout(() => setCopyHint(''), 1500);
    } catch (e) {
      setCopyHint('copy failed');
      setTimeout(() => setCopyHint(''), 1500);
    }
  }, [activeToken]);

  // Re-render the cache-age countdown when the dashboard's auto-refresh
  // tick fires (every 60s by default). The envelope itself is NOT
  // re-fetched — that only happens on operator action.
  useEffect(() => {
    // The tick subscription is captured implicitly via the
    // re-render below; this effect exists so we can show a
    // fresh "cached Xs ago" label without re-fetching.
  }, [tick]);

  const header = buildHolderHeader(env);
  const unavailable = isHoldersUnavailable(env);
  const isStub = isHoldersStub(env);
  const isFixture = isHoldersFixture(env);
  const errorKey = holderErrorKey(env);
  const errorHint = holderErrorHint(errorKey);
  const holderRows = (env && Array.isArray(env.holders))
    ? env.holders.map(buildHolderRow)
    : [];

  // ── Landing state ────────────────────────────────────────────
  if (!activeToken) {
    return (
      <div className="rounded border border-ink-700 bg-ink-900/30 p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span className="text-[11px] font-mono uppercase tracking-wider text-ash-300">
            token holders
          </span>
          <span className="text-[10px] font-mono uppercase tracking-wider text-ash-500">
            rug-pattern · concentration · cache
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="paste 64-char token_id"
            spellCheck={false}
            className="min-w-0 flex-1 rounded border border-ink-700 bg-ink-900 px-2 py-1 font-mono text-[11px] text-ash-100 placeholder:text-ash-600 focus:border-ink-500 focus:outline-none"
            onKeyDown={(e) => {
              if (e.key === 'Enter') onLookupClick();
            }}
          />
          <button
            type="button"
            onClick={onLookupClick}
            disabled={loading || typeof tokenInput !== 'string' || tokenInput.trim().length === 0}
            className="rounded border border-ink-600 bg-ink-800 px-3 py-1 text-[11px] font-mono uppercase tracking-wider text-ash-200 hover:bg-ink-700 disabled:opacity-50"
          >
            {loading ? 'looking up…' : 'lookup'}
          </button>
        </div>
        {err && (
          <div className="mt-2 rounded border border-rose-700/40 bg-rose-950/20 px-3 py-2 text-xs text-rose-300">
            {err}
          </div>
        )}
        <div className="mt-2 text-[10px] text-ash-500">
          paste a cashaddr-token_id (32-byte hex / 64 chars) and click lookup. the dashboard will fetch
          {' '}<span className="font-mono text-ash-400">/api/token/&lt;id&gt;/holders</span> and surface
          the rug-pattern + concentration envelope.
        </div>
      </div>
    );
  }

  // ── Detail view ──────────────────────────────────────────────
  return (
    <div className="rounded border border-ink-700 bg-ink-900/30 p-3">
      {/* Header */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setActiveToken(null);
              setEnv(null);
              setErr(null);
              setRefreshed(false);
            }}
            className="rounded border border-ink-600 bg-ink-800 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider text-ash-300 hover:bg-ink-700"
          >
            ← new lookup
          </button>
          <span className="text-[11px] font-mono uppercase tracking-wider text-ash-300">
            token holders · {header.token_id_short}
          </span>
          {typeof activeToken === 'string' && activeToken.length > 0 && (
            <button
              type="button"
              onClick={onCopyTokenId}
              className="rounded border border-ink-700 px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider text-ash-500 hover:border-ink-500"
              title="copy token_id to clipboard"
            >
              {copyHint || 'copy id'}
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {loading && (
            <span className="text-[10px] font-mono text-ash-500">loading…</span>
          )}
          {!loading && activeToken && !unavailable && (
            <button
              type="button"
              onClick={onRefreshClick}
              className="rounded border border-ink-600 bg-ink-800 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider text-ash-200 hover:bg-ink-700"
              title="force-refresh: bypass the scanner cache"
            >
              refresh
            </button>
          )}
        </div>
      </div>

      {/* Error / unavailable state */}
      {err && (
        <div className="rounded border border-rose-700/40 bg-rose-950/20 px-3 py-2 text-xs text-rose-300">
          <div className="font-mono text-[10px] uppercase tracking-wider">{err}</div>
        </div>
      )}
      {!err && unavailable && (
        <div className="rounded border border-amber-700/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-300">
          <div className="font-mono text-[10px] uppercase tracking-wider">
            {errorKey}
          </div>
          {errorHint && (
            <div className="mt-1 text-[11px]">{errorHint}</div>
          )}
        </div>
      )}

      {/* Header card */}
      {!unavailable && !err && (
        <div className="mb-3 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
          {[
            { label: 'top-N %', value: header.top_n_pct_display, className: header.top_n_pct_class, pill: header.top_n_pct_pill_class, big: true },
            { label: 'rug pattern', value: header.rug_label, className: header.rug_class, pill: header.rug_pill_class },
            { label: 'source', value: header.source_label, className: 'text-ash-200', pill: header.cache_badge_class },
            { label: 'cache', value: header.cache_badge_text, className: 'text-ash-200', pill: header.cache_badge_class },
            { label: 'holders', value: header.total_holders === null ? '—' : String(header.total_holders) },
            { label: 'total supply', value: header.total_supply_human },
            { label: 'top N', value: header.top_n === null ? '—' : String(header.top_n) },
            {
              label: 'flushed',
              value: refreshed ? 'manually refreshed' : (header.cache_flushed ? 'this tick' : 'no'),
              className: refreshed || header.cache_flushed ? 'text-emerald-400' : 'text-ash-500',
            },
          ].map((line) => (
            <div
              key={line.label}
              className={
                line.pill
                  ? `rounded border px-2 py-1 ${line.pill}`
                  : 'flex items-baseline justify-between gap-2'
              }
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className={`text-[10px] font-mono uppercase tracking-wider ${line.pill ? 'opacity-80' : 'text-ash-500'}`}>
                  {line.label}
                </span>
                <span className={`font-mono tabular-nums ${line.big ? 'text-base' : 'text-[11px]'} ${line.className || ''}`}>
                  {line.value}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Stub hint (subset-1 era) */}
      {isStub && !unavailable && (
        <div className="mb-3 rounded border border-amber-700/40 bg-amber-950/20 px-3 py-2 text-[11px] text-amber-300">
          scanner not yet implemented — flip <span className="font-mono">scoring.concentration_rug_enabled=true</span> after auditing the upstream, or paste a JSON array below to test the math against a fixture.
        </div>
      )}

      {/* Fixture toggle */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setShowFixtureInput((v) => !v)}
          className="rounded border border-ink-700 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider text-ash-400 hover:border-ink-500"
        >
          {showFixtureInput ? 'hide fixture input' : 'test fixture (?holders=...)'}
        </button>
        {isFixture && (
          <span className="rounded border border-ink-700 bg-ink-900/40 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider text-ash-400">
            fixture mode active
          </span>
        )}
      </div>
      {showFixtureInput && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={fixtureInput}
            onChange={(e) => setFixtureInput(e.target.value)}
            placeholder='[{"address":"bitcoincash:q...","balance":"100"}, ...]'
            spellCheck={false}
            className="min-w-0 flex-1 rounded border border-ink-700 bg-ink-900 px-2 py-1 font-mono text-[11px] text-ash-100 placeholder:text-ash-600 focus:border-ink-500 focus:outline-none"
            onKeyDown={(e) => {
              if (e.key === 'Enter') onFixtureSubmit();
            }}
          />
          <button
            type="button"
            onClick={onFixtureSubmit}
            disabled={typeof fixtureInput !== 'string' || fixtureInput.trim().length === 0}
            className="rounded border border-ink-600 bg-ink-800 px-3 py-1 text-[11px] font-mono uppercase tracking-wider text-ash-200 hover:bg-ink-700 disabled:opacity-50"
          >
            run fixture
          </button>
        </div>
      )}

      {/* Holders table */}
      {!unavailable && !err && holderRows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-ash-500 font-mono uppercase tracking-wider text-[9px]">
                <th className="text-left font-normal pb-1 pr-2">address</th>
                <th className="text-right font-normal pb-1 pr-2">balance</th>
                <th className="text-right font-normal pb-1 pr-2">pct of supply</th>
                <th className="text-right font-normal pb-1 pr-2">nfts</th>
                <th className="text-left font-normal pb-1 pr-2">top-N</th>
              </tr>
            </thead>
            <tbody>
              {holderRows.map((r, i) => (
                <tr key={r.address + ':' + i} className="border-t border-ink-800/60">
                  <td className="py-1 pr-2 font-mono text-ash-300">{r.address_short}</td>
                  <td className="py-1 pr-2 text-right font-mono tabular-nums text-ash-200">{r.balance_human}</td>
                  <td className={`py-1 pr-2 text-right font-mono tabular-nums ${r.pct_class}`}>{r.pct_display}</td>
                  <td className="py-1 pr-2 text-right font-mono tabular-nums text-ash-400">{r.nft_count}</td>
                  <td className="py-1 pr-2 font-mono text-ash-500">{r.is_top_n ? '✓' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!unavailable && !err && holderRows.length === 0 && (
        <div className="px-1 py-2 text-[11px] text-ash-500">
          no holders in envelope
        </div>
      )}
    </div>
  );
}
