// dashboard/src/components/WalletReceiveCard.jsx
//
// T72 — "Wallet Receive" dashboard card.
//
// Purpose: surface the bot's BCH cashaddr + a QR code so the
// operator can fund the trading wallet by sending BCH to it
// (the canonical "deposit" UX). Mounts below the StakingStatusCard
// on Dashboard.jsx.
//
// Behavior:
//   1. Reads `/api/wallet/balance` (already returns `{ok, address,
//      network, ...}` — no new backend endpoint).
//   2. Generates a QR code (base64 PNG data URL) via the
//      `qrcode` npm package, rendered to <img>.
//   3. Renders the cashaddr as a monospace, copy-to-clipboard-
//      clickable block. Copy uses `navigator.clipboard.writeText`
//      when available (secure context), falls back to a hidden
//      textarea + execCommand('copy') otherwise.
//   4. Subscribes to useRefresh().tick so the data refreshes at
//      the dashboard's 60s auto-refresh cadence.
//
// Failure model: every API call returns `{ok, data, error}`.
// On `ok:false` the card renders an "unavailable" pill with the
// underlying error message (same shape as the staking tile).

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useApi, useRefresh } from '../lib/api-context.jsx';
import Panel from './Panel.jsx';
import {
  deriveReceiveCardState,
  deriveReceiveHint,
  buildQrDataUrl,
  chunkAddress,
  receiveHintClass,
} from '../views/wallet-receive-helpers.mjs';
import { buildExplorerAddressUrl } from '../lib/explorer-urls.mjs';

const COPY_FEEDBACK_MS = 1500;

async function copyToClipboard(text) {
  // Modern path: clipboard API requires a secure context (HTTPS or
  // localhost). On a LAN deployment via plain HTTP the API throws.
  if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_e) {
      // fall through to legacy
    }
  }
  // Legacy fallback: hidden textarea + execCommand('copy').
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'absolute';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (_e) {
    return false;
  }
}

export default function WalletReceiveCard() {
  // useApi() returns the wrapper context { api, token, setToken } —
  // destructure `api` so we get the createApiClient result directly.
  // (Calling api.walletBalance() on the wrapper would TypeError.)
  const { api } = useApi();

  const [envelope, setEnvelope] = useState(null);
  const [qrDataUrl, setQrDataUrl] = useState(null);
  const [qrError, setQrError] = useState(null);
  const [copyState, setCopyState] = useState('idle'); // 'idle' | 'copied' | 'failed'
  // Manual-refresh nonce: bumped by the on-screen "↻ refresh" button.
  // The card deliberately DOES NOT subscribe to useRefresh().tick
  // because the bot address is set in config/user.json at wallet-init
  // time and only changes on (rare) wallet re-init or hand-edit —
  // re-fetching every 60s is pure waste. The user asked for this
  // behavior change; see git log for context.
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const copyTimerRef = useRef(null);

  // Fetch + regenerate QR on mount, when api changes (rare),
  // and on manual refresh. Does NOT subscribe to the 60s tick.
  useEffect(() => {
    let cancelled = false;
    setEnvelope(null);
    setQrDataUrl(null);
    setQrError(null);
    (async () => {
      const r = await api.walletBalance();
      if (cancelled) return;
      if (r?.ok === false) {
        setEnvelope({ ok: false, error: r.error || 'fetch_failed' });
        return;
      }
      const env = r?.data ?? r;
      setEnvelope(env);
      const state = deriveReceiveCardState(env);
      if (state.ok && state.address) {
        try {
          const url = await buildQrDataUrl(state.address);
          if (!cancelled) {
            setQrDataUrl(url);
            setQrError(null);
          }
        } catch (e) {
          if (!cancelled) {
            setQrError(e?.message || 'qr_generation_failed');
            setQrDataUrl(null);
          }
        }
      }
    })();
    return () => { cancelled = true; };
  }, [api, refreshNonce]);

  // Cleanup the copy-feedback timer on unmount.
  useEffect(() => () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
  }, []);

  const onCopy = useCallback(async () => {
    const addr = envelope?.address;
    if (typeof addr !== 'string' || addr.length === 0) return;
    const ok = await copyToClipboard(addr);
    setCopyState(ok ? 'copied' : 'failed');
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopyState('idle'), COPY_FEEDBACK_MS);
  }, [envelope]);

  const state = deriveReceiveCardState(envelope);
  const hint = deriveReceiveHint(state);
  const chunks = state.ok ? chunkAddress(state.address, 12) : [];
  const explorerHref = state.ok ? buildExplorerAddressUrl(state.address) : null;

  return (
    <Panel
      title="wallet · receive BCH"
      action={
        <span className={`font-mono text-[10px] uppercase tracking-wider ${receiveHintClass(hint)}`}>
          {state.ok ? (state.network || 'unknown network') : 'unavailable'}
        </span>
      }
    >
      <div className="grid grid-cols-1 md:grid-cols-[auto_1fr] gap-4 items-start">
        {/* QR code */}
        <div className="flex items-center justify-center">
          {state.ok && qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt={`QR for BCH cashaddr ${state.address}`}
              width={220}
              height={220}
              className="rounded bg-white p-1"
              data-testid="wallet-receive-qr"
            />
          ) : state.ok ? (
            <div className="w-[220px] h-[220px] flex items-center justify-center text-xs text-slate-500 border border-dashed border-slate-700 rounded">
              {qrError ? `QR error: ${qrError}` : 'generating QR…'}
            </div>
          ) : (
            <div className="w-[220px] h-[220px] flex items-center justify-center text-xs text-slate-500 border border-dashed border-slate-700 rounded">
              unavailable
            </div>
          )}
        </div>

        {/* Address + controls */}
        <div className="min-w-0 space-y-3">
          <div className="text-xs text-slate-400">{hint.message}</div>
          {state.ok ? (
            <>
              <div className="font-mono text-[11px] leading-5 break-all bg-slate-900/60 border border-slate-700 rounded px-3 py-2 select-all" data-testid="wallet-receive-address">
                {chunks.map((chunk, i) => (
                  <React.Fragment key={i}>
                    {i > 0 && ' '}
                    {chunk}
                  </React.Fragment>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={onCopy}
                  className="text-xs px-2.5 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-100 disabled:opacity-50"
                  data-testid="wallet-receive-copy"
                >
                  {copyState === 'copied' ? '✓ copied' : copyState === 'failed' ? 'copy failed' : 'copy address'}
                </button>
                {explorerHref && (
                  <a
                    href={explorerHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
                    data-testid="wallet-receive-explorer"
                  >
                    view on explorer ↗
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => {
                    if (refreshing) return;
                    setRefreshing(true);
                    setRefreshNonce((n) => n + 1);
                    // brief visual feedback — the effect re-runs the
                    // fetch, but clearing the indicator after a tick
                    // gives the user something to look at.
                    setTimeout(() => setRefreshing(false), 600);
                  }}
                  className="text-xs px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
                  title="Re-fetch the wallet address + regenerate the QR code"
                  data-testid="wallet-receive-refresh"
                >
                  {refreshing ? '↻ refreshing…' : '↻ refresh'}
                </button>
                <span className="text-[10px] text-slate-500 ml-auto">
                  loaded: {envelope?.ts ? new Date(envelope.ts).toLocaleTimeString() : '—'}
                </span>
              </div>
            </>
          ) : (
            <div className="text-xs text-slate-400 font-mono">
              {state.error || 'unknown error'}
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}
