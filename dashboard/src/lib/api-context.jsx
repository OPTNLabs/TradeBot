// dashboard/src/lib/api-context.jsx
//
// React Context wrapper around `createApiClient`. The dashboard
// needs a single client instance per page (so the optional bearer
// token is shared across every view) and a single refresh tick so
// all three views update in unison.
//
// Two contexts:
//   - `ApiContext`     — the api client + the current auth token
//   - `RefreshContext` — auto-refresh interval + manual trigger
//
// Components use the `useApi()` and `useRefresh()` hooks (see
// below) instead of touching React directly. The contexts are
// intentionally split so a panel that only needs the API doesn't
// re-render on every refresh tick.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createApiClient } from './api.mjs';

/** @type {React.Context<any>} */
const ApiContext = createContext(null);
/** @type {React.Context<any>} */
const RefreshContext = createContext(null);

/**
 * Parse `?token=...` from the page URL so operators can set the
 * bearer token without rebuilding the bundle. Token is also stashed
 * in `sessionStorage` (NOT localStorage — clears when the tab
 * closes) under the key `tradebot.api_token`.
 *
 * @returns {string}
 */
function readTokenFromBrowser() {
  try {
    const params = new URLSearchParams(window.location.search);
    const q = params.get('token');
    if (q && q.length > 0) {
      window.sessionStorage.setItem('tradebot.api_token', q);
      // Strip the token from the URL so it doesn't leak into
      // browser history / referer headers.
      params.delete('token');
      const rest = params.toString();
      const clean = `${window.location.pathname}${rest.length > 0 ? `?${rest}` : ''}${window.location.hash}`;
      window.history.replaceState({}, '', clean);
      return q;
    }
  } catch (_) {
    // Window not available (SSR, tests) — fall through.
  }
  try {
    const stored = window.sessionStorage.getItem('tradebot.api_token');
    return stored || '';
  } catch (_) {
    return '';
  }
}

/**
 * Top-level provider. Mounts at `<App />`. Reads the optional
 * bearer token from the URL / sessionStorage, builds a single API
 * client, and owns the auto-refresh tick.
 *
 * @param {Object} props
 * @param {React.ReactNode} props.children
 * @param {number} [props.refreshMs=60000]   auto-refresh interval
 *                                            (60s avoids browser
 *                                            throttling on background
 *                                            / Telegram in-app tabs)
 * @param {string} [props.baseUrl]           explicit backend base URL (testing)
 */
export function AppProviders(props) {
  const children = props.children;
  const refreshMs = (typeof props.refreshMs === 'number' && props.refreshMs > 0)
    ? Math.floor(props.refreshMs)
    : 60_000;

  const [token, setToken] = useState(() => readTokenFromBrowser());
  const api = useMemo(() => createApiClient({ token, timeoutMs: 10_000 }), [token]);

  // The refresh tick is intentionally decoupled from React state:
  // components subscribe via `useRefresh()` and decide for
  // themselves when to re-fetch. We just expose the current tick
  // counter + a manual trigger.
  const [tick, setTick] = useState(0);
  const timerRef = useRef(/** @type {any} */ (null));
  useEffect(() => {
    if (refreshMs <= 0) return undefined;
    timerRef.current = setInterval(() => {
      setTick((n) => n + 1);
    }, refreshMs);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [refreshMs]);

  const trigger = useCallback(() => setTick((n) => n + 1), []);

  const apiValue = useMemo(() => ({ api, token, setToken }), [api, token]);
  const refreshValue = useMemo(() => ({ tick, trigger, refreshMs }), [tick, trigger, refreshMs]);

  return (
    <ApiContext.Provider value={apiValue}>
      <RefreshContext.Provider value={refreshValue}>
        {children}
      </RefreshContext.Provider>
    </ApiContext.Provider>
  );
}

/** @returns {{ api: ReturnType<typeof createApiClient>, token: string, setToken: (t: string) => void }} */
export function useApi() {
  const ctx = useContext(ApiContext);
  if (!ctx) throw new Error('useApi must be used inside <AppProviders>');
  return ctx;
}

/** @returns {{ tick: number, trigger: () => void, refreshMs: number }} */
export function useRefresh() {
  const ctx = useContext(RefreshContext);
  if (!ctx) throw new Error('useRefresh must be used inside <AppProviders>');
  return ctx;
}