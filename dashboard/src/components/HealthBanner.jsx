// dashboard/src/components/HealthBanner.jsx
//
// Tiny "is the backend reachable?" indicator. Polls /healthz on
// the same refresh cadence as everything else. Surfaces failures
// as a yellow banner above the main content — never blocks the
// UI (a bot that's offline should still show its last known
// positions).

import React, { useEffect, useState } from 'react';

import { useApi, useRefresh } from '../lib/api-context.jsx';

export default function HealthBanner() {
  const { api } = useApi();
  const { tick } = useRefresh();
  const [state, setState] = useState(/** @type {{ok: boolean, message: string, ts: number|null}} */ ({
    ok: true, message: 'checking…', ts: null,
  }));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await api.healthz();
      if (cancelled) return;
      if (r.ok) {
        setState({ ok: true, message: 'backend reachable', ts: Date.now() });
      } else {
        setState({ ok: false, message: r.error || 'unreachable', ts: Date.now() });
      }
    })();
    return () => { cancelled = true; };
  }, [api, tick]);

  if (state.ok) return null;
  return (
    <div className="border-b border-amber-700/60 bg-amber-950/40 text-amber-200">
      <div className="mx-auto max-w-7xl px-4 py-2 text-xs">
        <span className="font-mono uppercase tracking-wider">backend offline —</span>{' '}
        <span>{state.message}</span>
        <span className="ml-2 text-amber-400/70">(showing last cached data)</span>
      </div>
    </div>
  );
}