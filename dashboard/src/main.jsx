// dashboard/src/main.jsx
//
// React 18 entry point for the TradeBot dashboard. Mounts the
// `<App />` tree into `#root` and imports the global Tailwind CSS.

import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import App from './App.jsx';
import './index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('dashboard: #root element not found in index.html');
}

createRoot(container).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);