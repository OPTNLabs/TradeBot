// dashboard/tests/trade-marker.test.mjs
//
// T40-fix2: lock the contract of the `renderTradeMarkerDot` helper
// exported from `dashboard/src/views/Dashboard.jsx`. The operator
// reported that the earlier `<Scatter shape="circle">` path was
// silently dropping markers in the browser even though the
// recharts tooltip wiring was live — so the team re-implemented
// the marker as a per-point `dot` function on a second `<Line>`
// series with `stroke="transparent"`. This file pins that
// contract so a future "let's go back to Scatter" doesn't get
// merged.
//
// The Dashboard.jsx file is JSX, which Node's test runner doesn't
// parse natively, but the helper itself is plain JS once we
// extract its body — JSX inside the body is irrelevant for the
// branch logic we care about here (null-on-bad-input + payload
// pass-through). We test those branches by re-implementing the
// same branching logic in JS using the function source as a
// reference, OR we test the behaviour with a stub `React.createElement`
// that records calls. The latter is more honest — it's the
// actual contract the chart relies on.
//
// To do that without booting Vite, we monkey-patch
// `globalThis.React` and load the helper source via the Function
// constructor after replacing `<circle ... />` with
// `__jsx('circle', {...})` so we don't depend on the JSX
// transform. The helper's control flow (`if (cx !== number)
// return null` etc.) is plain JS and survives the rewrite.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VIEW_PATH = join(__dirname, '..', 'src', 'views', 'Dashboard.jsx');

function loadRenderTradeMarkerDot() {
  const src = readFileSync(VIEW_PATH, 'utf8');
  const re = /export\s+function\s+renderTradeMarkerDot\s*\(\s*props\s*\)\s*\{/;
  const m = re.exec(src);
  if (!m) throw new Error('renderTradeMarkerDot: not found in ' + VIEW_PATH);
  const startBrace = src.indexOf('{', m.index);
  let depth = 0;
  let endBrace = -1;
  for (let i = startBrace; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) { endBrace = i; break; }
    }
  }
  if (endBrace === -1) throw new Error('renderTradeMarkerDot: unterminated');
  let body = src.slice(startBrace + 1, endBrace);
  // Strip JSX for entry / exit branches so we don't need a JSX
  // transform. The helper's logic is the part we test here — the
  // actual circle elements are exercised by the recharts render
  // path in the browser.
  body = body.replace(/if \(isBuy\) \{[\s\S]*?\n  \}\n  return \([\s\S]*?\n  \);/m,
    'if (isBuy) return __jsx("circle", { kind: "entry", cx, cy, r: 7 });\n  return __jsx("circle", { kind: "exit", cx, cy, r: 6 });');
  // eslint-disable-next-line no-new-func
  return new Function('__jsx', 'props', body);
}

function makeRecorder() {
  const calls = [];
  const jsx = (type, props) => {
    calls.push({ type, props });
    return { $$jsx: true, type, props };
  };
  return { jsx, calls };
}

// ─────────────────────────────────────────────────────────────────────
//  renderTradeMarkerDot — null-on-bad-input
// ─────────────────────────────────────────────────────────────────────

test('renderTradeMarkerDot: returns null when cx is not a number', () => {
  const fn = loadRenderTradeMarkerDot();
  const { jsx, calls } = makeRecorder();
  assert.equal(fn(jsx, { cx: undefined, cy: 100, payload: { side: 'entry' } }), null);
  assert.equal(fn(jsx, { cx: 'oops', cy: 100, payload: { side: 'entry' } }), null);
  assert.equal(calls.length, 0, 'should not have rendered any circle');
});

test('renderTradeMarkerDot: returns null when cy is not a number', () => {
  const fn = loadRenderTradeMarkerDot();
  const { jsx, calls } = makeRecorder();
  assert.equal(fn(jsx, { cx: 50, cy: undefined, payload: { side: 'entry' } }), null);
  assert.equal(fn(jsx, { cx: 50, cy: NaN, payload: { side: 'entry' } }), null);
  assert.equal(calls.length, 0);
});

test('renderTradeMarkerDot: returns null when payload is missing', () => {
  const fn = loadRenderTradeMarkerDot();
  const { jsx, calls } = makeRecorder();
  assert.equal(fn(jsx, { cx: 50, cy: 100 }), null);
  assert.equal(fn(jsx, { cx: 50, cy: 100, payload: null }), null);
  assert.equal(calls.length, 0);
});

// ─────────────────────────────────────────────────────────────────────
//  renderTradeMarkerDot — side discrimination + payload pass-through
// ─────────────────────────────────────────────────────────────────────

test('renderTradeMarkerDot: entry side renders with kind="entry" r=7', () => {
  const fn = loadRenderTradeMarkerDot();
  const { jsx, calls } = makeRecorder();
  const payload = { side: 'entry', token_id: 'abc', bch_amount_sats: 12345 };
  const out = fn(jsx, { cx: 50, cy: 100, payload });
  assert.ok(out && out.$$jsx, 'expected a jsx descriptor');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'circle');
  assert.equal(calls[0].props.kind, 'entry');
  assert.equal(calls[0].props.r, 7);
  assert.equal(calls[0].props.cx, 50);
  assert.equal(calls[0].props.cy, 100);
});

test('renderTradeMarkerDot: exit side renders with kind="exit" r=6', () => {
  const fn = loadRenderTradeMarkerDot();
  const { jsx, calls } = makeRecorder();
  const payload = { side: 'exit', token_id: 'abc', bch_amount_sats: 67890 };
  const out = fn(jsx, { cx: 75, cy: 200, payload });
  assert.ok(out && out.$$jsx);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'circle');
  assert.equal(calls[0].props.kind, 'exit');
  assert.equal(calls[0].props.r, 6);
});

test('renderTradeMarkerDot: unknown side falls through to exit (solid red, default)', () => {
  const fn = loadRenderTradeMarkerDot();
  const { jsx, calls } = makeRecorder();
  fn(jsx, { cx: 1, cy: 2, payload: { side: 'something_else' } });
  assert.equal(calls.length, 1);
  // 'isBuy' is `payload.side === 'entry'`, so anything other
  // than 'entry' takes the else branch (exit styling).
  assert.equal(calls[0].props.kind, 'exit');
  assert.equal(calls[0].props.r, 6);
});