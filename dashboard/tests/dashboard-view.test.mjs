// dashboard/tests/dashboard-view.test.mjs
//
// T39: unit tests for the pure helpers exported by
// `src/views/Dashboard.jsx`. Recharts and React are NOT booted —
// the chart code path exports `rowsToChartPoints` as a pure
// transform so the dashboard's most important shape contracts
// (Number coercion, missing-row tolerance, kind→marker mapping,
// `ts_ms` parsing) stay locked.
//
// We import the .jsx file via a tiny inline read because Node's
// test runner doesn't speak JSX natively; the surface area we're
// testing is small enough that we extract the helper via a
// regex. The same approach is used elsewhere in the dashboard
// suite when we need to validate a .jsx export without bundling.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VIEW_PATH = join(__dirname, '..', 'src', 'views', 'Dashboard.jsx');

// Extract the source of `rowsToChartPoints` so we can exercise the
// pure transform without bundling JSX. The function lives in the
// Dashboard.jsx source between the comment block that starts with
// "T39: pure transform" and the next top-level export or
// function declaration. We use a deliberate, narrow regex so a
// future refactor that renames the helper (or breaks the
// signature) is caught here, not at runtime in the browser.
function extractHelper(name) {
  const src = readFileSync(VIEW_PATH, 'utf8');
  // Match `export function NAME(...) { ... }` with brace depth.
  const re = new RegExp(`export\\s+function\\s+${name}\\s*\\(([^)]*)\\)\\s*\\{`);
  const m = re.exec(src);
  if (!m) throw new Error(`rowsToChartPoints: could not locate helper ${name} in ${VIEW_PATH}`);
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
  if (endBrace === -1) throw new Error(`rowsToChartPoints: unterminated helper ${name}`);
  const body = src.slice(startBrace + 1, endBrace);
  const argsDecl = m[1].trim();
  // Build a callable. The function uses Array.isArray, Number.isFinite,
  // Date.parse, typeof — all available globally. We don't `eval`
  // (still permitted in node by default but flagged by some CSPs);
  // instead we synthesize a function via the Function constructor,
  // which keeps the code inert in the parsed-eval sense.
  // eslint-disable-next-line no-new-func
  return new Function(argsDecl, body);
}

const rowsToChartPoints = extractHelper('rowsToChartPoints');

// ─────────────────────────────────────────────────────────────────────
//  rowsToChartPoints
// ─────────────────────────────────────────────────────────────────────

test('dashboard: rowsToChartPoints returns [] for non-array', () => {
  assert.deepEqual(rowsToChartPoints(null), []);
  assert.deepEqual(rowsToChartPoints(undefined), []);
  assert.deepEqual(rowsToChartPoints({ rows: [] }), []);
  assert.deepEqual(rowsToChartPoints('not-an-array'), []);
});

test('dashboard: rowsToChartPoints drops rows missing ts_ms', () => {
  const out = rowsToChartPoints([
    { ts_ms: NaN, cumulative_realized_pnl_bch: 0.00001 },
    { ts: 'not-a-date', cumulative_realized_pnl_bch: 0.00002 },
    {},
    null,
  ]);
  assert.equal(out.length, 0);
});

test('dashboard: rowsToChartPoints drops rows missing cumulative_realized_pnl_bch', () => {
  const out = rowsToChartPoints([
    { ts_ms: 1_000, cumulative_realized_pnl_bch: NaN },
    { ts_ms: 2_000, cumulative_realized_pnl_bch: 'not-a-number' },
    { ts_ms: 3_000 /* missing */ },
  ]);
  assert.equal(out.length, 0);
});

test('dashboard: rowsToChartPoints maps each row to the chart shape', () => {
  const out = rowsToChartPoints([
    {
      ts_ms: 1_700_000_000_000,
      ts: '2023-11-14T22:13:20.000Z',
      cumulative_realized_pnl_sats: '5000',
      cumulative_realized_pnl_bch: 0.00005,
      realized_pnl_bch: 0.00002,
      kind: 'win',
      position_id: 'pos_a',
      token_id: 'a'.repeat(64),
    },
    {
      ts_ms: 1_700_000_060_000,
      ts: '2023-11-14T22:14:20.000Z',
      cumulative_realized_pnl_sats: '3000',
      cumulative_realized_pnl_bch: 0.00003,
      realized_pnl_bch: -0.000005,
      kind: 'loss',
      position_id: 'pos_b',
      token_id: 'b'.repeat(64),
    },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].ts_ms, 1_700_000_000_000);
  assert.equal(out[0].cumulative_bch, 0.00005);
  assert.equal(out[0].trade_bch, 0.00002);
  assert.equal(out[0].kind, 'win');
  assert.equal(out[0].position_id, 'pos_a');
  assert.equal(out[0].token_id, 'a'.repeat(64));
  assert.equal(out[1].kind, 'loss');
  assert.equal(out[1].trade_bch, -0.000005);
});

test('dashboard: rowsToChartPoints falls back to Date.parse when ts_ms missing', () => {
  const out = rowsToChartPoints([
    { ts: '2023-11-14T22:13:20.000Z', cumulative_realized_pnl_bch: 0.00001 },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].ts_ms, Date.parse('2023-11-14T22:13:20.000Z'));
  assert.equal(out[0].cumulative_bch, 0.00001);
});

test('dashboard: rowsToChartPoints defaults missing trade_bch to 0', () => {
  const out = rowsToChartPoints([
    { ts_ms: 1_000, cumulative_realized_pnl_bch: 0.0001 /* no realized_pnl_bch */ },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].trade_bch, 0);
});

test('dashboard: rowsToChartPoints tolerates kind=unknown', () => {
  const out = rowsToChartPoints([
    { ts_ms: 1_000, cumulative_realized_pnl_bch: 0.0001 /* kind missing */ },
  ]);
  assert.equal(out[0].kind, 'unknown');
});

test('dashboard: rowsToChartPoints preserves array order (backend already sorts asc)', () => {
  const out = rowsToChartPoints([
    { ts_ms: 1, cumulative_realized_pnl_bch: 0.1 },
    { ts_ms: 2, cumulative_realized_pnl_bch: 0.2 },
    { ts_ms: 3, cumulative_realized_pnl_bch: 0.3 },
  ]);
  assert.deepEqual(out.map((r) => r.ts_ms), [1, 2, 3]);
  assert.deepEqual(out.map((r) => r.cumulative_bch), [0.1, 0.2, 0.3]);
});

test('dashboard: rowsToChartPoints handles breakeven kind', () => {
  const out = rowsToChartPoints([
    { ts_ms: 1, cumulative_realized_pnl_bch: 0, realized_pnl_bch: 0, kind: 'breakeven' },
  ]);
  assert.equal(out[0].kind, 'breakeven');
  assert.equal(out[0].cumulative_bch, 0);
  assert.equal(out[0].trade_bch, 0);
});


// ───────────────────────────────────────────────────────────────────
//  buildTradePoints — T40 balance-chart trade markers
//
// Source switched in T40 fix: `/api/positions?status=all` instead
// of `/api/history`. Each position expands into TWO markers
// (entry + exit when closed); open positions contribute just the
// entry. Anchoring, ts sort, and shape match the new contract.
// ───────────────────────────────────────────────────────────────────

const buildTradePoints = extractHelper('buildTradePoints');

const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);
const TOKEN_C = 'c'.repeat(64);

test('dashboard: buildTradePoints returns [] for missing rows', () => {
  assert.deepEqual(buildTradePoints({ positions: [] }, null), []);
  assert.deepEqual(buildTradePoints({ positions: [] }, []), []);
});

test('dashboard: buildTradePoints returns [] for non-array positions', () => {
  assert.deepEqual(buildTradePoints(null, [{ ts: 1, balance: 0.01 }]), []);
  assert.deepEqual(buildTradePoints(undefined, [{ ts: 1, balance: 0.01 }]), []);
  assert.deepEqual(buildTradePoints('not-an-array', [{ ts: 1, balance: 0.01 }]), []);
  assert.deepEqual(buildTradePoints({}, [{ ts: 1, balance: 0.01 }]), []);
});

test('dashboard: buildTradePoints drops positions missing token_id', () => {
  const rows = [{ ts: 1_000, balance: 0.05 }];
  const out = buildTradePoints({
    positions: [
      { entry: { ts: '2026-09-15T00:00:00.500Z', bch_spent_sats: '497000' } },
      { token_id: 'short', entry: { ts: '2026-09-15T00:00:00.500Z', bch_spent_sats: '497000' } },
    ],
  }, rows);
  assert.equal(out.length, 0);
});

test('dashboard: buildTradePoints drops positions missing entry', () => {
  const rows = [{ ts: 1_000, balance: 0.05 }];
  const out = buildTradePoints({
    positions: [
      { token_id: TOKEN_A },
      { token_id: TOKEN_A, entry: null },
    ],
  }, rows);
  assert.equal(out.length, 0);
});

test('dashboard: buildTradePoints drops positions with unparseable entry ts', () => {
  const rows = [{ ts: 1_000, balance: 0.05 }];
  const out = buildTradePoints({
    positions: [
      { token_id: TOKEN_A, entry: { ts: 'not-a-date' } },
      { token_id: TOKEN_A, entry: { ts: 12345 } },
      { token_id: TOKEN_A, entry: {} },
    ],
  }, rows);
  assert.equal(out.length, 0);
});

test('dashboard: buildTradePoints drops positions that fall before the first snapshot', () => {
  const rows = [{ ts: 2_000, balance: 0.05 }];
  const out = buildTradePoints({
    positions: [
      { token_id: TOKEN_A, entry: { ts: '1970-01-01T00:00:01.000Z', bch_spent_sats: '497000' } },
    ],
  }, rows);
  assert.equal(out.length, 0);
});

test('dashboard: buildTradePoints expands an open position into one entry marker', () => {
  const rows = [{ ts: 1_000, balance: 0.05 }];
  const out = buildTradePoints({
    positions: [
      {
        token_id: TOKEN_A,
        entry: { ts: '1970-01-01T00:00:01.500Z', bch_spent_sats: '497000' },
      },
    ],
  }, rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].side, 'entry');
  assert.equal(out[0].balance, 0.05);
  assert.equal(out[0].token_id, TOKEN_A);
  assert.equal(out[0].bch_amount_sats, '497000');
  assert.equal(out[0].exit_kind, null);
  assert.equal(out[0].realized_pnl_sats, null);
});

test('dashboard: buildTradePoints expands a closed position into entry+exit markers', () => {
  const rows = [{ ts: 1_000, balance: 0.05 }];
  const out = buildTradePoints({
    positions: [
      {
        token_id: TOKEN_A,
        entry: { ts: '1970-01-01T00:00:01.500Z', bch_spent_sats: '497000' },
        exit: { ts: '1970-01-01T00:00:02.500Z', bch_received_sats: '492309', kind: 'time_stop', realized_pnl_sats: '-9499' },
      },
    ],
  }, rows);
  assert.equal(out.length, 2);
  assert.equal(out[0].side, 'entry');
  assert.equal(out[0].balance, 0.05);
  assert.equal(out[0].bch_amount_sats, '497000');
  assert.equal(out[1].side, 'exit');
  assert.equal(out[1].balance, 0.05);
  assert.equal(out[1].bch_amount_sats, '492309');
  assert.equal(out[1].exit_kind, 'time_stop');
  assert.equal(out[1].realized_pnl_sats, '-9499');
});

test('dashboard: buildTradePoints anchors each marker at the latest snapshot ≤ trade ts', () => {
  const T1 = '2026-09-15T00:00:00.000Z';
  const T2 = '2026-09-15T01:00:00.000Z';
  const T3 = '2026-09-15T02:00:00.000Z';
  const ROW_TS = [Date.parse(T1), Date.parse(T2), Date.parse(T3)];
  const rows = [
    { ts: ROW_TS[0], balance: 0.05 },
    { ts: ROW_TS[1], balance: 0.04 },
    { ts: ROW_TS[2], balance: 0.045 },
  ];
  const out = buildTradePoints({
    positions: [
      {
        token_id: TOKEN_A,
        entry: { ts: '2026-09-15T00:30:00.000Z', bch_spent_sats: '497000' },
        exit: { ts: '2026-09-15T01:30:00.000Z', bch_received_sats: '492309', kind: 'time_stop', realized_pnl_sats: '-9499' },
      },
    ],
  }, rows);
  assert.equal(out.length, 2);
  assert.equal(out[0].balance, 0.05);
  assert.equal(out[1].balance, 0.04);
});

test('dashboard: buildTradePoints accepts a bare positions array (not just the envelope)', () => {
  const rows = [{ ts: 1_000, balance: 0.01 }];
  const out = buildTradePoints([
    { token_id: TOKEN_A, entry: { ts: '1970-01-01T00:00:01.500Z', bch_spent_sats: '497000' } },
  ], rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].side, 'entry');
});

test('dashboard: buildTradePoints returns null bch_amount when entry/exit omits it', () => {
  const rows = [{ ts: 1_000, balance: 0.01 }];
  const out = buildTradePoints({
    positions: [
      {
        token_id: TOKEN_A,
        entry: { ts: '1970-01-01T00:00:01.500Z' },
        exit: { ts: '1970-01-01T00:00:02.500Z' },
      },
    ],
  }, rows);
  assert.equal(out.length, 2);
  assert.equal(out[0].bch_amount_sats, null);
  assert.equal(out[1].bch_amount_sats, null);
});

test('dashboard: buildTradePoints reads exit_kind from exit.kind (falls back to exit.reason)', () => {
  const rows = [{ ts: 1_000, balance: 0.01 }];
  const a = buildTradePoints({
    positions: [{
      token_id: TOKEN_A,
      entry: { ts: '1970-01-01T00:00:01.500Z' },
      exit: { ts: '1970-01-01T00:00:02.500Z', kind: 'take_profit' },
    }],
  }, rows);
  assert.equal(a[1].exit_kind, 'take_profit');
  const b = buildTradePoints({
    positions: [{
      token_id: TOKEN_A,
      entry: { ts: '1970-01-01T00:00:01.500Z' },
      exit: { ts: '1970-01-01T00:00:02.500Z', reason: 'time_stop' },
    }],
  }, rows);
  assert.equal(b[1].exit_kind, 'time_stop');
});

test('dashboard: buildTradePoints sorts the result by ts asc', () => {
  const rows = [{ ts: 1_000, balance: 0.01 }];
  const out = buildTradePoints({
    positions: [
      { token_id: TOKEN_C, entry: { ts: '1970-01-01T00:00:03.500Z' } },
      { token_id: TOKEN_A, entry: { ts: '1970-01-01T00:00:01.500Z' } },
      { token_id: TOKEN_B, entry: { ts: '1970-01-01T00:00:02.500Z' } },
    ],
  }, rows);
  assert.equal(out.length, 3);
  assert.equal(out[0].ts, 1_500);
  assert.equal(out[1].ts, 2_500);
  assert.equal(out[2].ts, 3_500);
});

test('dashboard: buildTradePoints sorts the anchor lookup by ts', () => {
  const rows = [
    { ts: 2_000, balance: 0.04 },
    { ts: 1_000, balance: 0.05 },
  ];
  const out = buildTradePoints({
    positions: [
      { token_id: TOKEN_A, entry: { ts: '1970-01-01T00:00:01.500Z' } },
    ],
  }, rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].balance, 0.05);
});

test('dashboard: buildTradePoints reproduces the live 6-trade dataset', () => {
  // End-to-end: feed in the production positions shape and confirm
  // all 9 markers (6 entries + 3 exits) come back, anchored to the
  // first snapshot row. Rows cover Sep 13 → Sep 15 so every trade
  // has an anchor.
  const rows = [
    { ts: Date.parse('2026-09-13T00:00:00.000Z'), balance: 0.044 },
    { ts: Date.parse('2026-09-14T00:00:00.000Z'), balance: 0.040 },
    { ts: Date.parse('2026-09-15T00:00:00.000Z'), balance: 0.034 },
  ];
  const out = buildTradePoints({
    positions: [
      { token_id: '7860a1632607f6354d01a0d638914011f92cae14db78b11c58511d72d002f42f',
        entry: { ts: '2026-09-13T19:44:52.878Z', bch_spent_sats: '752083' },
        exit:  { ts: '2026-09-13T21:13:15.963Z', bch_received_sats: '740091', kind: 'orphan_recovery' } },
      { token_id: '242f6ecedb404c743477e35b09733a56cacae34f3109d5cee1cbc1d5630affd7',
        entry: { ts: '2026-09-13T05:50:55.067Z', bch_spent_sats: '0' },
        exit:  { ts: '2026-09-14T06:18:08.953Z', bch_received_sats: '205215', kind: 'time_stop' } },
      { token_id: '7cc859b5650962a482ddd4e507da029c7463aa37e65aed9efbe8686145bd642f',
        entry: { ts: '2026-09-14T06:18:04.983Z', bch_spent_sats: '495669' },
        exit:  { ts: '2026-09-15T06:18:32.406Z', bch_received_sats: '492309', kind: 'time_stop', realized_pnl_sats: '-9499' } },
      { token_id: '7fa887fd4eac015478b95392c4984721fbe3060223c30b342d43cc06817f07f6',
        entry: { ts: '2026-09-14T23:54:05.027Z', bch_spent_sats: '497000' } },
      { token_id: 'd9ab24ed15a7846cc3d9e004aa5cb976860f13dac1ead05784ee4f4622af96ea',
        entry: { ts: '2026-09-15T00:13:23.684Z', bch_spent_sats: '496873' } },
      { token_id: '41b596d732634f7acac6f63c3064b82e1356e09f5b0a83759fb989dc93a2b35f',
        entry: { ts: '2026-09-15T05:33:09.811Z', bch_spent_sats: '497000' } },
    ],
  }, rows);
  assert.equal(out.length, 9);
  const entries = out.filter((p) => p.side === 'entry');
  const exits = out.filter((p) => p.side === 'exit');
  assert.equal(entries.length, 6);
  assert.equal(exits.length, 3);
  assert.equal(exits.find((p) => p.realized_pnl_sats === '-9499')?.exit_kind, 'time_stop');
});
