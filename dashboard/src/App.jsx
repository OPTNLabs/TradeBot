// dashboard/src/App.jsx
//
// Top-level router for the TradeBot dashboard. Five routes:
//
//   /            → Dashboard   (overview, P&L chart, balance)
//   /portfolio   → Portfolio   (current positions + reasoning)
//   /setup       → Setup       (first-run wizard; auto-redirected to
//                                when GET /api/setup/status reports
//                                setup_required=true)
//   /settings    → Settings    (knobs)
//   /reasoning   → Reasoning   (entry decision audit trail)
//
// Plus a `<NavBar />` that stays visible across the non-setup views.
// When the wizard is in progress, the NavBar is hidden so the
// operator can't click into a half-configured dashboard.
//
// Heavy lifting (network + formatting) lives in `src/views/*.jsx`
// and `src/lib/*`; this file just wires the routing.

import React, { useCallback, useEffect, useState } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';

import { AppProviders, useApi } from './lib/api-context.jsx';
import NavBar from './components/NavBar.jsx';
import Dashboard from './views/Dashboard.jsx';
import Portfolio from './views/Portfolio.jsx';
import Reasoning from './views/Reasoning.jsx';
import Proposals from './views/Proposals.jsx';
import Bugs from './views/Bugs.jsx';
import TradeHistory from './views/TradeHistory.jsx';
import Settings from './views/Settings.jsx';
import Setup from './views/Setup.jsx';
import HealthBanner from './components/HealthBanner.jsx';

/**
 * Inner shell. Runs inside `<AppProviders>` so it can call the
 * `useApi()` hook. Polls `/api/setup/status` once on mount and
 * every 30 s after — when `setup_required=true` AND the user
 * hasn't reached the wizard yet, redirect to `/setup`.
 */
function AppShell() {
  const { api } = useApi();
  const navigate = useNavigate();
  const location = useLocation();

  const [setupRequired, setSetupRequired] = useState(null); // null = unknown yet

  const refreshSetupStatus = useCallback(async () => {
    try {
      const r = await api.setupStatus();
      if (r.ok && r.data && typeof r.data.setup_required === 'boolean') {
        setSetupRequired(r.data.setup_required);
        return r.data.setup_required;
      }
    } catch (_) {
      // Soft fail — leave setupRequired at its current value.
    }
    return null;
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    refreshSetupStatus().then((req) => {
      if (cancelled) return;
      if (req === true && !location.pathname.startsWith('/setup')) {
        navigate('/setup', { replace: true });
      }
    });
    const id = setInterval(() => { refreshSetupStatus(); }, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [refreshSetupStatus, navigate, location.pathname]);

  // While we don't yet know the setup status, render a tiny
  // splash so the UI doesn't flash the dashboard before the
  // redirect fires.
  if (setupRequired === null) {
    return (
      <div className="min-h-full bg-ink-950 text-ash-100">
        <main className="mx-auto max-w-7xl px-4 py-6">
          <div className="text-xs text-ash-400">checking setup status…</div>
        </main>
      </div>
    );
  }

  // During the wizard, suppress the NavBar so the operator
  // can't click into a half-configured dashboard.
  const onWizard = location.pathname.startsWith('/setup');
  const showNav = !onWizard;

  return (
    <div className="min-h-full bg-ink-950 text-ash-100">
      {showNav && <NavBar />}
      {showNav && <HealthBanner />}
      <main className="mx-auto max-w-7xl px-4 py-6">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/portfolio" element={<Portfolio />} />
          <Route path="/reasoning" element={<Reasoning />} />
          <Route path="/proposals" element={<Proposals />} />
          <Route path="/bugs" element={<Bugs />} />
          <Route path="/trades" element={<TradeHistory />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/setup" element={<Setup />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      {showNav && (
        <footer className="mx-auto max-w-7xl px-4 py-6 text-xs text-ash-400">
          <span className="num">TradeBot</span>
          <span> · </span>
          <span>read-only dashboard · talks to the T16 backend on <code className="num">/api/*</code></span>
        </footer>
      )}
    </div>
  );
}

export default function App() {
  return (
    <AppProviders>
      <AppShell />
    </AppProviders>
  );
}