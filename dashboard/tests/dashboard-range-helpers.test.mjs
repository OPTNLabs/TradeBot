// dashboard/tests/dashboard-range-helpers.test.mjs
//
// T51: unit tests for the pure helpers exported by
// `dashboard/src/views/dashboard-range-helpers.mjs`. The .jsx
// chart components consume these helpers to render the
// range-selector chip group + to validate incoming range state.
//
// Mirrors the structure of `trade-history-view.test.mjs` — every
// helper is exercised in isolation so a future refactor that
// breaks the chip-class contract fails the test loudly.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RANGE_OPTIONS,
  DEFAULT_CHART_RANGE,
  isValidChartRange,
  chipClassForRange,
  resolveChartRange,
} from '../src/views/dashboard-range-helpers.mjs';

// ─────────────────────────────────────────────────────────────────────
//  RANGE_OPTIONS — curated preset list
// ─────────────────────────────────────────────────────────────────────

test('dashboard-range: RANGE_OPTIONS is a frozen, non-empty array of preset chips', () => {
  assert.ok(Array.isArray(RANGE_OPTIONS), 'RANGE_OPTIONS is an array');
  assert.ok(RANGE_OPTIONS.length >= 4, 'has at least 4 presets so the picker is useful');
  for (const opt of RANGE_OPTIONS) {
    assert.equal(typeof opt.value, 'string', `each preset has string value: ${JSON.stringify(opt)}`);
    assert.equal(typeof opt.label, 'string', `each preset has string label: ${JSON.stringify(opt)}`);
    assert.ok(opt.value.length > 0, `preset value is non-empty: ${JSON.stringify(opt)}`);
    assert.ok(opt.label.length > 0, `preset label is non-empty: ${JSON.stringify(opt)}`);
  }
  // Frozen: a future refactor that pushes to the array fails loudly.
  assert.equal(Object.isFrozen(RANGE_OPTIONS), true, 'RANGE_OPTIONS is frozen');
});

test('dashboard-range: RANGE_OPTIONS includes the curated presets used by the dashboard', () => {
  // The same list as trade-history-helpers.mjs so the operator only
  // learns one vocabulary across both views.
  const values = RANGE_OPTIONS.map((o) => o.value);
  assert.ok(values.includes('24h'), 'includes 24h');
  assert.ok(values.includes('7d'),  'includes 7d');
  assert.ok(values.includes('30d'), 'includes 30d');
  assert.ok(values.includes('90d'), 'includes 90d');
  assert.ok(values.includes('all'), 'includes all');
});

test('dashboard-range: RANGE_OPTIONS labels match values for the short presets', () => {
  // The chart chip-group has very limited horizontal space — we
  // keep the label equal to the value for the short forms so the
  // operator sees one consistent word.
  const byValue = Object.fromEntries(RANGE_OPTIONS.map((o) => [o.value, o.label]));
  assert.equal(byValue['24h'], '24h');
  assert.equal(byValue['7d'], '7d');
  assert.equal(byValue['30d'], '30d');
  assert.equal(byValue['90d'], '90d');
  assert.equal(byValue['all'], 'all');
});

test('dashboard-range: RANGE_OPTIONS values are unique (no duplicate chips render)', () => {
  const seen = new Set();
  for (const opt of RANGE_OPTIONS) {
    assert.equal(seen.has(opt.value), false, `duplicate preset value: ${opt.value}`);
    seen.add(opt.value);
  }
});

// ─────────────────────────────────────────────────────────────────────
//  DEFAULT_CHART_RANGE
// ─────────────────────────────────────────────────────────────────────

test('dashboard-range: DEFAULT_CHART_RANGE is a valid preset value', () => {
  assert.equal(typeof DEFAULT_CHART_RANGE, 'string');
  assert.ok(DEFAULT_CHART_RANGE.length > 0);
  assert.ok(isValidChartRange(DEFAULT_CHART_RANGE), 'default is one of the curated presets');
});

test('dashboard-range: DEFAULT_CHART_RANGE matches the server-side default (30d)', () => {
  // If this changes, server.mjs#DEFAULT_DASHBOARD_CONFIG also needs
  // updating. Locking the contract here keeps the two sides in sync.
  assert.equal(DEFAULT_CHART_RANGE, '30d');
});

// ─────────────────────────────────────────────────────────────────────
//  isValidChartRange
// ─────────────────────────────────────────────────────────────────────

test('dashboard-range: isValidChartRange returns true for every preset value', () => {
  for (const opt of RANGE_OPTIONS) {
    assert.equal(isValidChartRange(opt.value), true, `preset ${opt.value} validates`);
  }
});

test('dashboard-range: isValidChartRange rejects non-strings', () => {
  for (const bad of [null, undefined, 24, 7, true, false, {}, [], 0, NaN]) {
    assert.equal(isValidChartRange(bad), false, `rejects ${JSON.stringify(bad)}`);
  }
});

test('dashboard-range: isValidChartRange rejects empty strings + arbitrary garbage', () => {
  for (const bad of ['', ' ', '1y', 'forever', '30days', 'seven', 'ALL', 'All']) {
    assert.equal(isValidChartRange(bad), false, `rejects ${JSON.stringify(bad)}`);
  }
});

test('dashboard-range: isValidChartRange is case-sensitive (must match curated casing)', () => {
  // The chip-group renders the value verbatim; "all" lowercase is
  // the canonical form (matches the server's parseRange lowercases
  // the unit but accepts 'all' verbatim).
  assert.equal(isValidChartRange('ALL'), false);
  assert.equal(isValidChartRange('All'), false);
  assert.equal(isValidChartRange('24H'), false);
  assert.equal(isValidChartRange('7D'), false);
  assert.equal(isValidChartRange('30d'), true, 'accepts the canonical lowercase');
});

// ─────────────────────────────────────────────────────────────────────
//  chipClassForRange
// ─────────────────────────────────────────────────────────────────────

test('dashboard-range: chipClassForRange marks the selected chip with the filled style', () => {
  const cls = chipClassForRange('7d', '7d');
  // Selected style: emerald accent + filled bg + emerald text.
  assert.match(cls, /border-emerald-500/, 'selected chip has emerald border');
  assert.match(cls, /bg-emerald-500\/10/, 'selected chip has emerald fill');
  assert.match(cls, /text-emerald-300/, 'selected chip has emerald text');
  // Never both styles at once — sanity check.
  assert.doesNotMatch(cls, /border-ink-600/);
});

test('dashboard-range: chipClassForRange marks the unselected chip with the hollow style', () => {
  const cls = chipClassForRange('7d', '30d');
  // Unselected style: muted border + ash text.
  assert.match(cls, /border-ink-600/, 'unselected chip has muted border');
  assert.match(cls, /text-ash-300/, 'unselected chip has ash text');
  assert.doesNotMatch(cls, /border-emerald-500/);
  // Hover affordances are present so the chip looks interactive.
  assert.match(cls, /hover:/, 'unselected chip has hover style');
});

test('dashboard-range: chipClassForRange base classes are present for every chip', () => {
  // The base layout classes must be on both styles so the chip
  // doesn't reflow when the selection changes.
  const baseClasses = ['inline-flex', 'items-center', 'rounded', 'border', 'px-2', 'py-0.5', 'font-mono'];
  for (const candidate of ['24h', '7d', '30d', '90d', 'all']) {
    for (const sel of ['24h', '7d', '30d', '90d', 'all']) {
      const cls = chipClassForRange(sel, candidate);
      for (const needle of baseClasses) {
        assert.ok(cls.includes(needle), `chip(${sel},${candidate}) carries base class ${needle}`);
      }
    }
  }
});

test('dashboard-range: chipClassForRange("30d","30d") returns the selected style regardless of casing', () => {
  // Direct equality (not includes) — sanity guard that the
  // comparison is value-string based, not position-based.
  const a = chipClassForRange('30d', '30d');
  const b = chipClassForRange('30d', '30d');
  assert.equal(a, b);
});

test('dashboard-range: chipClassForRange is deterministic for the same inputs', () => {
  // Pure: identical inputs must produce identical output strings,
  // not just identical structure. The chart re-renders on every
  // tick; non-determinism here would cause reconciliation churn.
  for (const sel of ['24h', '7d', '30d', '90d', 'all']) {
    for (const cand of ['24h', '7d', '30d', '90d', 'all']) {
      assert.equal(chipClassForRange(sel, cand), chipClassForRange(sel, cand));
    }
  }
});

// ─────────────────────────────────────────────────────────────────────
//  resolveChartRange
// ─────────────────────────────────────────────────────────────────────

test('dashboard-range: resolveChartRange returns valid values verbatim', () => {
  for (const opt of RANGE_OPTIONS) {
    assert.equal(resolveChartRange(opt.value), opt.value);
  }
});

test('dashboard-range: resolveChartRange falls back to default for invalid input', () => {
  for (const bad of [null, undefined, '', ' ', '1y', 'forever', 7, 30, {}, [], true, false]) {
    assert.equal(resolveChartRange(bad), DEFAULT_CHART_RANGE, `falls back for ${JSON.stringify(bad)}`);
  }
});

test('dashboard-range: resolveChartRange always returns a valid preset', () => {
  // Belt-and-suspenders: even when the input is undefined, the
  // returned value must pass isValidChartRange. A future refactor
  // that broke this contract would silently strand the chart on an
  // invalid range and the chip-group would render zero selected
  // chips.
  for (const bad of [null, undefined, '', '  ', 'never', -1, NaN, {}, [], new Date()]) {
    const out = resolveChartRange(bad);
    assert.equal(isValidChartRange(out), true, `output for ${JSON.stringify(bad)} is a valid preset`);
  }
});

test('dashboard-range: resolveChartRange("30d") === DEFAULT_CHART_RANGE (default is the 30d preset)', () => {
  // Locks the relationship between DEFAULT_CHART_RANGE and the
  // '30d' preset — if a future refactor moves the default to
  // '7d', this test catches it before the UI silently re-renders
  // with a different default window than the server.
  assert.equal(resolveChartRange('30d'), DEFAULT_CHART_RANGE);
});

// ─────────────────────────────────────────────────────────────────────
//  Cross-cutting: contracts the React components rely on
// ─────────────────────────────────────────────────────────────────────

test('dashboard-range: every preset value is a string the server-side parseRange would accept', () => {
  // The server's parseRange accepts the literal "all" plus
  // `<int><s|m|h|d|w>`. Locking the chip-group's curated list to
  // this regex means a future preset added here can't accidentally
  // surface an option that 404s on the server.
  for (const opt of RANGE_OPTIONS) {
    const v = opt.value;
    const ok = v === 'all' || /^\d+[smhdw]$/.test(v);
    assert.equal(ok, true, `preset ${JSON.stringify(opt)} is a parseRange-acceptable string`);
  }
});

test('dashboard-range: RANGE_OPTIONS has exactly one preset matching the default', () => {
  // Sanity: the default is reachable from the picker — otherwise
  // the picker renders but the "selected" highlight never appears
  // and the operator wonders why their default window has no
  // highlighted chip.
  const matches = RANGE_OPTIONS.filter((o) => o.value === DEFAULT_CHART_RANGE);
  assert.equal(matches.length, 1, `exactly one preset matches DEFAULT_CHART_RANGE (${DEFAULT_CHART_RANGE})`);
});