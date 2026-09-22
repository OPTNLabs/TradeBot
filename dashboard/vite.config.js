// dashboard/vite.config.js
//
// Vite config for the TradeBot dashboard (T17).
//
// The dashboard is a pure-frontend SPA: it talks to the T16
// read-only HTTP backend (default 127.0.0.1:8787) over fetch. During
// `npm run dev` we proxy `/api/*` + `/healthz` to that backend so
// the React app can use relative paths in every environment.
//
// Build output lands in `dashboard/dist/`, which is gitignored. The
// dashboard backend serves the built bundle in production by
// pointing its `static_root` at `dashboard/dist/` (see
// `scripts/start-dashboard.mjs`).

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Default backend bind port — must match
// `dashboard.bind_port` in config/default.json.
const DEFAULT_BACKEND_PORT = 8787;

export default defineConfig(({ mode }) => {
  // Allow overriding the backend port via VITE_BACKEND_PORT at dev
  // time (handy when running multiple bots side-by-side). Default
  // matches config/default.json so `npm run dev` Just Works.
  const envPort = process.env.VITE_BACKEND_PORT;
  const backendPort = envPort && /^[0-9]+$/.test(envPort) ? parseInt(envPort, 10) : DEFAULT_BACKEND_PORT;

  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: false,
      proxy: {
        '/api': {
          target: `http://127.0.0.1:${backendPort}`,
          changeOrigin: false,
        },
        '/healthz': {
          target: `http://127.0.0.1:${backendPort}`,
          changeOrigin: false,
        },
      },
    },
    preview: {
      host: '127.0.0.1',
      port: 4173,
      strictPort: false,
    },
    build: {
      outDir: 'dist',
      sourcemap: mode !== 'production',
      target: 'es2022',
    },
    clearScreen: false,
  };
});