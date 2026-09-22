// dashboard/src/components/TokenBadge.jsx
//
// T26c — TokenBadge component.
//
// Renders a token as icon + name + symbol (when Paytaca BCMR
// metadata is available) or a token_id prefix fallback while the
// network fetch is in flight or when the lookup fails.
//
// One component, three modes:
//   - `loading`   — fetching metadata, show token_id prefix + spinner hint
//   - `ok`        — render icon + name + symbol
//   - `fallback`  — metadata not available (404 / network err) or
//                   invalid token id, show token_id prefix only
//
// Memoized via React.memo so a long list (e.g. reasoning with
// 20 rows) doesn't trigger 20 individual fetches — the parent
// should pre-warm via `TokenMetadataContext` for that case. The
// component is also designed to be a leaf (no children) so it
// composes cleanly inside table cells, list rows, and inline spans.
//
// Caching note: the backend has its own in-memory cache (1h TTL
// by default). On the frontend, we don't add a second cache layer
// here — React's mount lifecycle + the backend cache already
// cover the cases that matter (single render = single fetch,
// subsequent renders hit the backend cache).

import React, { useEffect, useState } from 'react';

import { useApi } from '../lib/api-context.jsx';

/**
 * T26c: render a token identifier with Paytaca BCMR metadata
 * enrichment. Pure render component — fetches on mount, never
 * refreshes (caller can `key={tokenId}` to force a refetch).
 *
 * @param {Object} props
 * @param {string} props.tokenId     64-hex category id (required)
 * @param {boolean} [props.compact]  smaller layout (single line)
 * @param {string}  [props.className]  extra classes for the root <span>
 */
function TokenBadgeImpl(props) {
  const { tokenId, compact = false, className = '' } = props;
  const { api } = useApi();
  const [state, setState] = useState(/** @type {'idle'|'loading'|'ok'|'fallback'} */ ('idle'));
  const [meta, setMeta] = useState(/** @type {any} */ (null));

  useEffect(() => {
    if (typeof tokenId !== 'string' || tokenId.length === 0) {
      setState('fallback');
      return;
    }
    let cancelled = false;
    setState('loading');
    setMeta(null);
    (async () => {
      const r = await api.tokenMetadata(tokenId);
      if (cancelled) return;
      if (r && r.ok && r.data && r.data.ok && r.data.record) {
        setMeta(r.data.record);
        setState('ok');
      } else {
        setMeta(null);
        setState('fallback');
      }
    })();
    return () => { cancelled = true; };
    // tokenId is the only meaningful dep; api is memoized via context.
  }, [tokenId, api]);

  if (!tokenId) {
    return <span className={`text-ash-500 font-mono text-xs ${className}`}>—</span>;
  }

  if (state === 'ok' && meta) {
    const showIcon = typeof meta.icon_url === 'string' && meta.icon_url.length > 0;
    return (
      <span
        className={`inline-flex items-center gap-1.5 ${className}`}
        data-testid="token-badge"
        data-state="ok"
        title={meta.description || meta.name || tokenId}
      >
        {showIcon ? (
          // eslint-disable-next-line jsx-a11y/alt-text
          <img
            src={meta.icon_url}
            alt=""
            className={`${compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} rounded-full bg-ink-800 object-cover flex-shrink-0`}
            onError={(e) => { e.currentTarget.style.display = 'none'; }}
          />
        ) : (
          <span
            className={`${compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} rounded-full bg-bch-500 flex-shrink-0 ring-1 ring-bch-700/40`}
            aria-hidden="true"
          />
        )}
        {compact ? (
          <span className="font-mono text-xs text-bch-400">{meta.symbol || meta.name || `${tokenId.slice(0, 8)}…`}</span>
        ) : (
          <span className="flex flex-col leading-tight">
            <span className="font-medium text-ash-100 text-xs">{meta.name || meta.symbol || `${tokenId.slice(0, 8)}…`}</span>
            {meta.symbol && meta.name && meta.name !== meta.symbol && (
              <span className="font-mono text-[10px] text-bch-400">{meta.symbol}</span>
            )}
          </span>
        )}
      </span>
    );
  }

  // Loading OR fallback — render a token_id prefix so the UI
  // doesn't shift when metadata arrives.
  if (state === 'loading') {
    return (
      <span
        className={`inline-flex items-center gap-1.5 ${className}`}
        data-testid="token-badge"
        data-state="loading"
      >
        <span className={`${compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} rounded-full bg-ink-700 animate-pulse flex-shrink-0`} aria-hidden="true" />
        <span className="font-mono text-[10px] text-ash-400">{tokenId.slice(0, 8)}…</span>
      </span>
    );
  }

  // Fallback (metadata not found / network err / invalid id).
  return (
    <span
      className={`inline-flex items-center gap-1.5 ${className}`}
      data-testid="token-badge"
      data-state="fallback"
      title={tokenId}
    >
      <span className={`${compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} rounded-full bg-ink-700 flex-shrink-0`} aria-hidden="true" />
      <span className="font-mono text-[10px] text-ash-400">{tokenId.slice(0, 8)}…</span>
    </span>
  );
}

const TokenBadge = React.memo(TokenBadgeImpl);
export default TokenBadge;

/**
 * Pure helper: did the BCMR lookup return a usable record? Useful
 * for unit-testing the render branches without mounting React.
 *
 * @param {{ ok: boolean, data?: { ok: boolean, record?: any }, error?: string }} result
 * @returns {boolean}
 */
export function isTokenMetadataOk(result) {
  return !!(result && result.ok && result.data && result.data.ok && result.data.record);
}
