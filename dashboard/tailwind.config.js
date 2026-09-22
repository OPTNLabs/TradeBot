// dashboard/tailwind.config.js
//
// Tailwind v3 config for the TradeBot dashboard. Kept deliberately
// small — the UI is a handful of panels (DASHBOARD / PORTFOLIO /
// SETTINGS) rendered against a dark "trading terminal" palette.
//
// Colors:
//   `ink`  — surface (panel background) tones, near-black to slate
//   `ash`  — body text + muted text
//   `bch`  — BCH-green accent (T26b: changed from orange to a
//            BCH-friendly emerald so the dashboard reads as a
//            BCH project, not a generic orange-on-dark theme)
//   `pnl`  — green/red tints for profit & loss, kept neutral so
//            colorblind operators still see the +/- suffix.
//            Both `win/loss` (semantic) and `pos/neg` (sign)
//            names are available — pick whichever reads better
//            in the JSX.
//
// Anything that needs to render dashboard data should reference
// these tokens via `className="bg-ink-900 text-ash-100 ..."`.

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,jsx,ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#0a0c10',
          900: '#10141b',
          800: '#171c25',
          700: '#1f2632',
          600: '#2a3140',
          500: '#3a4252',
        },
        ash: {
          50: '#f4f6f8',
          100: '#d6dbe3',
          200: '#aab2c0',
          300: '#7e8699',
          400: '#5a6275',
          500: '#3d4456',
        },
        bch: {
          // T26b: BCH-friendly emerald palette. 400 = highlight,
          // 500 = primary CTA / accent, 600 = hover/darker state.
          300: '#6ee7b7',
          400: '#34d399',
          500: '#10b981',
          600: '#059669',
          700: '#047857',
        },
        pnl: {
          // Both naming conventions resolve to the same hex so
          // existing code can use whichever reads more naturally
          // (e.g. Reasoning.jsx uses pos/neg, Settings.jsx uses
          // win/loss).
          win: '#3ec96a',
          pos: '#3ec96a',
          loss: '#e0596b',
          neg: '#e0596b',
          neutral: '#9aa3b3',
        },
      },
      fontFamily: {
        mono: [
          'JetBrains Mono',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Consolas',
          'monospace',
        ],
        sans: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
      },
      boxShadow: {
        panel: '0 1px 0 rgba(255,255,255,0.04) inset, 0 1px 2px rgba(0,0,0,0.4)',
      },
    },
  },
  plugins: [],
};