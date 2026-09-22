// dashboard/src/components/NavBar.jsx
//
// Persistent top navigation bar. Three links (Dashboard /
// Portfolio / Settings) plus a small status pill that shows
// whether `/healthz` is reachable. The bar stays mounted across
// route changes so the polling state survives navigation.

import React from 'react';
import { NavLink } from 'react-router-dom';

import { useApi } from '../lib/api-context.jsx';

const TABS = [
  { to: '/',          label: 'DASHBOARD',  exact: true },
  { to: '/portfolio', label: 'PORTFOLIO',  exact: false },
  { to: '/reasoning', label: 'REASONING',  exact: false },
  { to: '/trades',    label: 'TRADES',     exact: false },
  { to: '/proposals', label: 'PROPOSALS',  exact: false },
  { to: '/bugs',      label: 'BUGS',       exact: false },
  { to: '/settings',  label: 'SETTINGS',   exact: false },
];

export default function NavBar() {
  const { api } = useApi();

  return (
    <header className="border-b border-ink-700 bg-ink-900/60 backdrop-blur sticky top-0 z-20">
      <div className="mx-auto flex max-w-7xl items-center gap-6 px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="h-2 w-2 rounded-full bg-bch-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]" />
          <span className="num text-sm font-semibold tracking-wide text-ash-100">TradeBot</span>
          <span className="label text-ash-400 hidden sm:inline">cauldron.quest BCH trader</span>
        </div>
        <nav className="flex items-center gap-1">
          {TABS.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              end={t.exact}
              className={({ isActive }) =>
                `rounded px-3 py-1.5 text-xs font-mono uppercase tracking-wider transition-colors ` +
                (isActive
                  ? 'bg-ink-700 text-bch-400'
                  : 'text-ash-300 hover:bg-ink-800 hover:text-ash-100')
              }
            >
              {t.label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2 text-xs">
          <a
            href={`${api.baseUrl || ''}/healthz`}
            target="_blank"
            rel="noreferrer"
            className="text-ash-400 hover:text-ash-100"
            title="Open /healthz in a new tab"
          >
            /healthz ↗
          </a>
        </div>
      </div>
    </header>
  );
}