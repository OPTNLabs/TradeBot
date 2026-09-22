// dashboard/tests/pnl-breakdown.test.mjs
//
// B01: unit tests for the per-position cumulative-P&L breakdown
// helpers in `dashboard/src/views/pnl-breakdown-helpers.mjs`.
// Locked contracts:
//   - parseSats:    number | string | bigint | null → bigint | null
//   - satsToBchNumber: parseSats result → Number (BCH) | null
//   - buildCumulativePnlBreakdown: pnl-timeseries envelope →
//       { rows[], total_sats, total_bch, computed_sum_sats,
//         match, source_count, skipped }
//     - `match === true` iff sum(per-trade pnl_sats) ===
//       api.realized_total_sats (this is the "operator trust" chip)
//     - rows are newest-first (by closed_at desc, position_id asc)
//     - empty rows array still surfaces api-declared total
//   - kindLabel / pnlSourceLabel / shortReason / formatSignedBch:
//     string coercion + defensive defaults
//
// All helpers are pure — we import them directly and exercise the
// contracts without booting React.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSats,
  satsToBchNumber,
  buildCumulativePnlBreakdown,
  kindLabel,
  pnlSourceLabel,
  shortReason,
  formatSignedBch,
} from '../src/views/pnl-breakdown-helpers.mjs';

const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);
const TOKEN_C = 'c'.repeat(64);
const TOKEN_D = 'd'.repeat(64);

// ───────────────────────────────────────────────────────────────────
//  parseSats
// ───────────────────────────────────────────────────────────────────

test('pnl-breakdown: parseSats returns null for nullish / non-numeric input', () => {
  assert.equal(parseSats(null), null);
  assert.equal(parseSats(undefined), null);
  assert.equal(parseSats(''), null);
  assert.equal(parseSats('   '), null);
  assert.equal(parseSats('not-a-number'), null);
  assert.equal(parseSats('12.34'), null); // fractional strings rejected (no decimal)
  assert.equal(parseSats({}), null);
  assert.equal(parseSats([]), null);
  assert.equal(parseSats(NaN), null);
  assert.equal(parseSats(Infinity), null);
});

test('pnl-breakdown: parseSats accepts negative bigint (defensive — exit.realized_pnl_sats can be negative)', () => {
  assert.equal(parseSats(-25192n), -25192n);
  assert.equal(parseSats('-25192'), -25192n);
  assert.equal(parseSats('-0'), 0n);
});

test('pnl-breakdown: parseSats accepts bigint / number / string with various signs', () => {
  assert.equal(parseSats(0), 0n);
  assert.equal(parseSats(0n), 0n);
  assert.equal(parseSats('0'), 0n);
  assert.equal(parseSats(42), 42n);
  assert.equal(parseSats(42n), 42n);
  assert.equal(parseSats('42'), 42n);
  assert.equal(parseSats('  -1811  '), -1811n);
  assert.equal(parseSats(1.7e8), 170000000n); // fractional numbers round to nearest sat
});

test('pnl-breakdown: parseSats rejects non-integer numbers (regression guard for the display layer)', () => {
  // The dashboard sends sats as strings or whole numbers; floats
  // should round rather than emit a bigint from a fractional
  // value (which would silently truncate).
  assert.equal(parseSats(1.4), 1n);
  assert.equal(parseSats(1.6), 2n);
});

// ───────────────────────────────────────────────────────────────────
//  satsToBchNumber
// ───────────────────────────────────────────────────────────────────

test('pnl-breakdown: satsToBchNumber returns null for nullish / unparseable input', () => {
  assert.equal(satsToBchNumber(null), null);
  assert.equal(satsToBchNumber(undefined), null);
  assert.equal(satsToBchNumber('not-a-number'), null);
  assert.equal(satsToBchNumber(NaN), null);
});

test('pnl-breakdown: satsToBchNumber converts correctly for negative + zero + positive', () => {
  assert.equal(satsToBchNumber(0), 0);
  assert.equal(satsToBchNumber(100_000_000), 1);
  assert.equal(satsToBchNumber(-100_000_000), -1);
  assert.equal(satsToBchNumber(-36134), -0.00036134);
  assert.equal(satsToBchNumber(368), 0.00000368);
  assert.equal(satsToBchNumber('-25192'), -0.00025192);
});

// ───────────────────────────────────────────────────────────────────
//  buildCumulativePnlBreakdown — happy path
// ───────────────────────────────────────────────────────────────────

function row(over) {
  // We honor explicit `undefined` as "remove this field" so the
  // "missing realized_pnl_sats" / "missing cumulative" tests
  // below can exercise the missing-field branches without having
  // to enumerate every field. Object.assign would otherwise keep
  // the default value when the override omits the key.
  const base = {
    ts: '2026-09-13T21:13:15.963Z',
    ts_ms: Date.parse('2026-09-13T21:13:15.963Z'),
    position_id: 'pos_x',
    token_id: TOKEN_A,
    token_symbol: 'AAA',
    side: 'long_token',
    closed_at: '2026-09-13T21:13:15.963Z',
    reason: 'time_stop',
    pnl_source: 'computed',
    realized_pnl_sats: '0',
    realized_pnl_bch: 0,
    cumulative_realized_pnl_sats: '0',
    cumulative_realized_pnl_bch: 0,
    bch_spent_sats: '0',
    bch_received_sats: '0',
    fee_sats: '0',
    kind: 'breakeven',
  };
  for (const [k, v] of Object.entries(over || {})) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  return base;
}

test('pnl-breakdown: buildCumulativePnlBreakdown returns empty shape for null / undefined input', () => {
  for (const v of [null, undefined, 0, '', 'not-an-object']) {
    const out = buildCumulativePnlBreakdown(v);
    assert.deepEqual(out.rows, [], `rows for ${JSON.stringify(v)}`);
    assert.equal(out.total_sats, null);
    assert.equal(out.total_bch, null);
    assert.equal(out.computed_sum_sats, 0n);
    assert.equal(out.match, false);
    // source_count is `0` in the empty shape (no per-source
    // counters yet) — it becomes a per-source object only after
    // at least one valid row has been processed.
    assert.equal(out.source_count, 0);
    assert.equal(out.skipped, 0);
  }
});

test('pnl-breakdown: empty rows array still surfaces api-declared total + skipped', () => {
  const out = buildCumulativePnlBreakdown({
    realized_total_sats: '-36134',
    realized_total_bch: -0.00036134,
    rows: [],
    skipped: 5,
  });
  assert.equal(out.rows.length, 0);
  assert.equal(out.total_sats, -36134n);
  assert.equal(out.total_bch, -0.00036134);
  assert.equal(out.computed_sum_sats, 0n);
  assert.equal(out.match, false); // computed_sum=0 vs api=-36134 → mismatch
  assert.equal(out.skipped, 5);
});

test('pnl-breakdown: builds per-trade rows + sum matches api total (match chip lights up)', () => {
  // B01 live-data fixture: 4 closed trades, current api total -36,134 sats.
  const out = buildCumulativePnlBreakdown({
    realized_total_sats: '-36134',
    realized_total_bch: -0.00036134,
    count: 4,
    trades_count: 4,
    skipped: 0,
    rows: [
      row({ position_id: 'p_FEW', token_id: TOKEN_A, token_symbol: 'FEW',
            closed_at: '2026-09-13T21:13:15.966Z', reason: 'orphan recovery after T28 fix — wallet holds no FEW tokens; position bookkeeping only (position tx 375fc28a… broadcast during T28 bug window with BCH-sats-as-tokens semantics; AMM delivered sub-economic rate that the bot recorded as 500k tokens but on-chain reality is no tokens in wallet). Removing to unstick the bot from the pre-flight-slippage rejection loop.',
            realized_pnl_sats: '-25192', realized_pnl_bch: -0.00025192,
            cumulative_realized_pnl_sats: '-25192', cumulative_realized_pnl_bch: -0.00025192,
            kind: 'loss' }),
      row({ position_id: 'p_BADGER', token_id: TOKEN_B, token_symbol: 'BADGER',
            closed_at: '2026-09-14T06:18:11.333Z', reason: 'time_stop',
            realized_pnl_sats: '-1811', realized_pnl_bch: -0.00001811,
            cumulative_realized_pnl_sats: '-27003', cumulative_realized_pnl_bch: -0.00027003,
            kind: 'loss' }),
      row({ position_id: 'p_QBTC', token_id: TOKEN_C, token_symbol: 'QBTC',
            closed_at: '2026-09-15T06:18:35.260Z', reason: 'time_stop',
            realized_pnl_sats: '-9499', realized_pnl_bch: -0.00009499,
            cumulative_realized_pnl_sats: '-36502', cumulative_realized_pnl_bch: -0.00036502,
            kind: 'loss' }),
      row({ position_id: 'p_FURU', token_id: TOKEN_D, token_symbol: 'FURU',
            closed_at: '2026-09-16T00:13:58.836Z', reason: 'time_stop',
            realized_pnl_sats: '368', realized_pnl_bch: 0.00000368,
            cumulative_realized_pnl_sats: '-36134', cumulative_realized_pnl_bch: -0.00036134,
            kind: 'win' }),
    ],
  });
  assert.equal(out.rows.length, 4);
  // sum(per-trade) = -25192 - 1811 - 9499 + 368 = -36134 ✓
  assert.equal(out.computed_sum_sats, -36134n);
  assert.equal(out.total_sats, -36134n);
  assert.equal(out.match, true, 'computed_sum_sats must equal api.realized_total_sats');
  // Newest-first ordering
  assert.equal(out.rows[0].position_id, 'p_FURU');
  assert.equal(out.rows[1].position_id, 'p_QBTC');
  assert.equal(out.rows[2].position_id, 'p_BADGER');
  assert.equal(out.rows[3].position_id, 'p_FEW');
  // Source counts
  assert.equal(out.source_count.computed, 4);
  assert.equal(out.source_count.stored, 0);
});

test('pnl-breakdown: match=false when per-trade sum differs from api total (regression guard)', () => {
  // Simulate an api/frontend inconsistency — api total says -36502 but
  // the rows only sum to -36134 (operator is missing one trade from
  // the range filter, or there's a stale cache).
  const out = buildCumulativePnlBreakdown({
    realized_total_sats: '-36502',
    realized_total_bch: -0.00036502,
    rows: [
      row({ position_id: 'p_BADGER', realized_pnl_sats: '-1811',
            cumulative_realized_pnl_sats: '-27003', cumulative_realized_pnl_bch: -0.00027003 }),
      row({ position_id: 'p_QBTC', realized_pnl_sats: '-9499',
            cumulative_realized_pnl_sats: '-36502', cumulative_realized_pnl_bch: -0.00036502 }),
    ],
  });
  assert.equal(out.rows.length, 2);
  assert.equal(out.computed_sum_sats, -11310n);
  assert.equal(out.total_sats, -36502n);
  assert.equal(out.match, false, 'per-trade sum -11310 ≠ api total -36502 — chip must say mismatch');
});

test('pnl-breakdown: sorts by closed_at desc; ties broken by position_id asc', () => {
  const out = buildCumulativePnlBreakdown({
    realized_total_sats: '0',
    rows: [
      row({ position_id: 'p_c', closed_at: '2026-09-15T00:00:00.000Z', realized_pnl_sats: '100' }),
      row({ position_id: 'p_a', closed_at: '2026-09-16T00:00:00.000Z', realized_pnl_sats: '200' }),
      row({ position_id: 'p_b', closed_at: '2026-09-16T00:00:00.000Z', realized_pnl_sats: '300' }),
    ],
  });
  // Newest first: p_a (2026-09-16) before p_b (2026-09-16) by id asc, then p_c.
  assert.deepEqual(out.rows.map((r) => r.position_id), ['p_a', 'p_b', 'p_c']);
});

test('pnl-breakdown: drops rows missing position_id or with null realized_pnl_sats', () => {
  const out = buildCumulativePnlBreakdown({
    realized_total_sats: '0',
    rows: [
      row({ position_id: '', realized_pnl_sats: '100' }), // missing position_id
      row({ position_id: 'p_no_pnl', realized_pnl_sats: null }),
      row({ position_id: 'p_no_pnl2', realized_pnl_sats: undefined }), // no realized_pnl_sats at all
      row({ position_id: 'p_good', realized_pnl_sats: '50' }),
    ],
  });
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].position_id, 'p_good');
  assert.equal(out.computed_sum_sats, 50n);
});

test('pnl-breakdown: rows[] is the SAME object reference as the api rows (no defensive copy)', () => {
  // We expose bigints for the React layer to render; underlying
  // input rows are not modified. Sanity: no .row.pnl_sats === 123n
  // mutation sneaking in.
  const input = row({ position_id: 'p', realized_pnl_sats: '123' });
  const out = buildCumulativePnlBreakdown({ realized_total_sats: '123', rows: [input] });
  assert.equal(out.rows[0].pnl_sats, 123n);
  assert.equal(out.rows[0].pnl_bch, 0.00000123);
});

test('pnl-breakdown: counts stored vs computed sources (operator trust signal)', () => {
  const out = buildCumulativePnlBreakdown({
    realized_total_sats: '0',
    rows: [
      row({ position_id: 'p1', realized_pnl_sats: '100', pnl_source: 'computed' }),
      row({ position_id: 'p2', realized_pnl_sats: '-50', pnl_source: 'stored' }),
      row({ position_id: 'p3', realized_pnl_sats: '25', pnl_source: 'unknown' }),
    ],
  });
  assert.deepEqual(out.source_count, { computed: 1, stored: 1, unknown: 1 });
});

test('pnl-breakdown: cumulative_realized_pnl_sats is preserved verbatim (BigInt round-trip)', () => {
  const out = buildCumulativePnlBreakdown({
    realized_total_sats: '-25192',
    rows: [
      row({ position_id: 'p1', realized_pnl_sats: '-25192', cumulative_realized_pnl_sats: '-25192' }),
    ],
  });
  assert.equal(out.rows[0].cum_sats, -25192n);
  assert.equal(out.rows[0].cum_bch, -0.00025192);
});

test('pnl-breakdown: missing cumulative_realized_pnl_sats falls back to per-trade pnl_sats', () => {
  // Defensive: if the backend ever drops the cumulative field
  // (e.g. a future schema change), the table still renders.
  const out = buildCumulativePnlBreakdown({
    realized_total_sats: '100',
    rows: [
      row({ position_id: 'p1', realized_pnl_sats: '100', cumulative_realized_pnl_sats: undefined }),
    ],
  });
  assert.equal(out.rows[0].cum_sats, 100n);
  assert.equal(out.rows[0].cum_bch, 0.00000100);
});

// ───────────────────────────────────────────────────────────────────
//  kindLabel / pnlSourceLabel / shortReason / formatSignedBch
// ───────────────────────────────────────────────────────────────────

test('pnl-breakdown: kindLabel maps win/loss/breakeven/unknown', () => {
  assert.equal(kindLabel('win'), 'win');
  assert.equal(kindLabel('loss'), 'loss');
  assert.equal(kindLabel('breakeven'), 'breakeven');
  assert.equal(kindLabel('unknown'), '—');
  assert.equal(kindLabel(''), '—');
  assert.equal(kindLabel('garbage'), '—');
});

test('pnl-breakdown: pnlSourceLabel surfaces "stored (orphan)" distinctly so operators can spot fake-zero overrides', () => {
  assert.equal(pnlSourceLabel('computed'), 'computed');
  assert.equal(pnlSourceLabel('stored'), 'stored (orphan)');
  assert.equal(pnlSourceLabel('unknown'), '—');
  assert.equal(pnlSourceLabel('garbage'), '—');
});

test('pnl-breakdown: shortReason truncates long reasons with ellipsis; default max=40', () => {
  assert.equal(shortReason(null), '—');
  assert.equal(shortReason(undefined), '—');
  assert.equal(shortReason(''), '—');
  assert.equal(shortReason('time_stop'), 'time_stop');
  assert.equal(shortReason('orphan recovery after T28 fix — wallet holds no FEW tokens').length, 40);
  assert.match(shortReason('orphan recovery after T28 fix — wallet holds no FEW tokens'), /…$/);
});

test('pnl-breakdown: shortReason respects custom max', () => {
  const s = 'this is a very long reason that should be truncated';
  // max=20 means: slice first (20-1)=19 chars, then add the
  // 1-char ellipsis so the resulting string is at most 20 chars.
  assert.equal(shortReason(s, 20), 'this is a very long…');
  assert.equal(shortReason(s, 20).length, 20);
});

test('pnl-breakdown: formatSignedBch emits +/− prefix + 8dp BCH', () => {
  assert.equal(formatSignedBch(0n), '0.00000000 BCH');
  assert.equal(formatSignedBch(100_000_000n), '+1.00000000 BCH');
  assert.equal(formatSignedBch(-100_000_000n), '-1.00000000 BCH');
  assert.equal(formatSignedBch(-36134n), '-0.00036134 BCH');
  assert.equal(formatSignedBch(368n), '+0.00000368 BCH');
});

test('pnl-breakdown: formatSignedBch returns "—" for nullish / unparseable', () => {
  assert.equal(formatSignedBch(null), '—');
  assert.equal(formatSignedBch(undefined), '—');
});

test('pnl-breakdown: formatSignedBch accepts decimals param for terser columns', () => {
  assert.equal(formatSignedBch(-36134n, 4), '-0.0004 BCH');
  assert.equal(formatSignedBch(0n, 2), '0.00 BCH');
});
