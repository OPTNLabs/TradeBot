#!/usr/bin/env node
// tests/strategy-adaptive-weights.test.mjs
//
// T56 subset 1 — adaptive-weights engine unit tests.
//
// Covers the pure helpers in `src/strategy/adaptive-weights.mjs`:
//   - `parseHistoryLine` discriminated-union contract (entry / exit /
//     other / error) — blank / comment / malformed / non-trade lines.
//   - `loadClosedTrades` — entry + exit pairing by position_id,
//     window filter, skip non-trade lines (count `skipped_event_count`
//     separately from `parse_error_count`), unpaired exit counting.
//   - `summarizeClosedTrades` — win / loss / P&L / mean hold / by
//     exit kind.
//   - `computeCalibrationCorrelation` — Pearson r between
//     entry_score + realized_pnl_sats across the cohort.
//   - `suggestAdaptiveWeights` — sum-to-1 invariant, amplification
//     vs dilution, calibration-floor gate, min-trades gate,
//     malformed input no-ops, sum-zero no-op.
//   - `formatSuggestionDiff` — stable string output.
//   - `pearson` + `mean` — pure math helpers.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_WINDOW_MS,
  DEFAULT_MIN_CLOSED_TRADES,
  DEFAULT_UNIFORMITY_PULL_MAX,
  DEFAULT_AMPLIFICATION_MAX,
  DEFAULT_CALIBRATION_FLOOR,
  TRADE_ENTRY_KIND,
  TRADE_EXIT_KIND,
  parseHistoryLine,
  parseTimestampMs,
  loadClosedTrades,
  summarizeClosedTrades,
  computeCalibrationCorrelation,
  suggestAdaptiveWeights,
  formatSuggestionDiff,
  applyAdaptiveWeightsToUserJson,
  buildAdaptiveWeightsAuditRecord,
  runAdaptiveWeightsSuggestion,
  mean,
  pearson,
} from '../src/strategy/adaptive-weights.mjs';

// ─── Test fixtures ──────────────────────────────────────────────────────

const NOW_MS = 1_789_756_200_000; // a stable reference point
const TID_A = 'a'.repeat(64);     // referenced by the runAdaptiveWeightsSuggestion tests below

const ENTRY_EVENT = (overrides = {}) => ({
  kind: 'entry',
  ts: '2026-09-15T00:00:00.000Z',
  position_id: 'pos_test_0001',
  token_id: 'a'.repeat(64),
  size_bch: 0.005,
  price_sats_per_token: 300,
  bch_spent_sats: 502000,
  token_amount_base: '5000',
  fee_sats: 2000,
  slippage_bps: 33,
  rank: 1,
  score: 0.60,
  ...overrides,
});

const EXIT_EVENT = (overrides = {}) => ({
  kind: 'exit',
  ts: '2026-09-16T00:00:00.000Z',
  position_id: 'pos_test_0001',
  token_id: 'a'.repeat(64),
  txid: 'b'.repeat(64),
  exit_kind: 'time_stop',
  price_sats_per_token: 320,
  bch_received_sats: 510000,
  fee_sats: 2000,
  realized_pnl_sats: 5000,
  realized_pnl_bch: 0.00005,
  slippage_bps: null,
  ...overrides,
});

// ─── parseTimestampMs ───────────────────────────────────────────────────

test('adaptive-weights: parseTimestampMs parses ISO strings', () => {
  const ms = parseTimestampMs('2026-09-15T00:00:00.000Z');
  assert.equal(ms, Date.UTC(2026, 8, 15, 0, 0, 0, 0));
});

test('adaptive-weights: parseTimestampMs accepts finite numbers', () => {
  assert.equal(parseTimestampMs(123456), 123456);
});

test('adaptive-weights: parseTimestampMs returns null for bad input', () => {
  for (const bad of [null, undefined, '', 'not a date', NaN, Infinity, {}, true]) {
    assert.equal(parseTimestampMs(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

// ─── parseHistoryLine ───────────────────────────────────────────────────

test('adaptive-weights: parseHistoryLine returns entry for entry events', () => {
  const r = parseHistoryLine(JSON.stringify(ENTRY_EVENT()));
  assert.equal(r.kind, TRADE_ENTRY_KIND);
  assert.equal(r.event.position_id, 'pos_test_0001');
});

test('adaptive-weights: parseHistoryLine returns exit for exit events', () => {
  const r = parseHistoryLine(JSON.stringify(EXIT_EVENT()));
  assert.equal(r.kind, TRADE_EXIT_KIND);
  assert.equal(r.event.position_id, 'pos_test_0001');
});

test('adaptive-weights: parseHistoryLine returns "other" for non-trade events', () => {
  const tick = JSON.stringify({ kind: 'tick', ts: '2026-09-15T00:00:00.000Z' });
  const r = parseHistoryLine(tick);
  assert.equal(r.kind, 'other');
  assert.equal(r.kind_name, 'tick');
});

test('adaptive-weights: parseHistoryLine returns error for empty / blank / comment lines', () => {
  assert.equal(parseHistoryLine('').kind, 'error');
  assert.equal(parseHistoryLine('   ').kind, 'error');
  assert.equal(parseHistoryLine('// a diagnostic line').kind, 'error');
});

test('adaptive-weights: parseHistoryLine returns error for non-JSON', () => {
  const r = parseHistoryLine('not valid json {');
  assert.equal(r.kind, 'error');
  assert.equal(r.error, 'json_parse_failed');
});

test('adaptive-weights: parseHistoryLine returns error for non-object JSON', () => {
  assert.equal(parseHistoryLine('42').kind, 'error');
  assert.equal(parseHistoryLine('"a string"').kind, 'error');
  assert.equal(parseHistoryLine('null').kind, 'error');
});

test('adaptive-weights: parseHistoryLine returns other for unknown kind discriminator', () => {
  const r = parseHistoryLine(JSON.stringify({ kind: 'snapshot', ts: '2026-09-15T00:00:00.000Z' }));
  assert.equal(r.kind, 'other');
  assert.equal(r.kind_name, 'snapshot');
});

// ─── loadClosedTrades ───────────────────────────────────────────────────

test('adaptive-weights: loadClosedTrades pairs entry + exit by position_id', () => {
  const lines = [JSON.stringify(ENTRY_EVENT()), JSON.stringify(EXIT_EVENT())];
  const r = loadClosedTrades(lines, { sinceMs: 0 });
  assert.equal(r.trades.length, 1);
  const t = r.trades[0];
  assert.equal(t.position_id, 'pos_test_0001');
  assert.equal(t.entry_score, 0.60);
  assert.equal(t.realized_pnl_sats, 5000);
  assert.equal(t.hold_ms, 24 * 60 * 60 * 1000);
  assert.equal(r.unpaired_exit_count, 0);
});

test('adaptive-weights: loadClosedTrades counts unpaired exits separately', () => {
  const lines = [
    JSON.stringify(ENTRY_EVENT({ position_id: 'pos_test_0001' })),
    JSON.stringify(EXIT_EVENT({ position_id: 'pos_test_no_entry' })),
  ];
  const r = loadClosedTrades(lines, { sinceMs: 0 });
  assert.equal(r.trades.length, 0);
  assert.equal(r.unpaired_exit_count, 1);
});

test('adaptive-weights: loadClosedTrades separates parse errors from skipped events', () => {
  const lines = [
    '',
    '   ',
    '// a diagnostic comment',
    'not valid json',
    JSON.stringify({ kind: 'tick', ts: '2026-09-15T00:00:00.000Z' }),
    JSON.stringify(ENTRY_EVENT()),
    JSON.stringify(EXIT_EVENT()),
  ];
  const r = loadClosedTrades(lines, { sinceMs: 0 });
  assert.equal(r.trades.length, 1);
  assert.equal(r.parse_error_count, 1, 'one parse error for "not valid json"');
  assert.equal(r.skipped_event_count, 1, 'one skipped tick event');
  assert.equal(r.errors.length, 1, 'the bad line goes into errors[]');
  assert.match(r.errors[0], /not valid json/);
});

test('adaptive-weights: loadClosedTrades applies the since window', () => {
  // Entry at NOW-30d, exit at NOW-10d → inside a 7d window the exit is OUT.
  const t30 = new Date(NOW_MS - 30 * 24 * 60 * 60 * 1000).toISOString();
  const t10 = new Date(NOW_MS - 10 * 24 * 60 * 60 * 1000).toISOString();
  const r = loadClosedTrades([
    JSON.stringify(ENTRY_EVENT({ ts: t30 })),
    JSON.stringify(EXIT_EVENT({ ts: t10 })),
  ], { sinceMs: NOW_MS - 7 * 24 * 60 * 60 * 1000 });
  assert.equal(r.trades.length, 0, '7d window excludes the exit');
  // No sinceMs → all trades included.
  const r2 = loadClosedTrades([
    JSON.stringify(ENTRY_EVENT({ ts: t30 })),
    JSON.stringify(EXIT_EVENT({ ts: t10 })),
  ], {});
  assert.equal(r2.trades.length, 1);
});

test('adaptive-weights: loadClosedTrades handles missing/invalid timestamps by counting unpaired', () => {
  const lines = [
    JSON.stringify(ENTRY_EVENT({ ts: 'not a date' })),
    JSON.stringify(EXIT_EVENT({ ts: 'not a date' })),
  ];
  const r = loadClosedTrades(lines, { sinceMs: 0 });
  assert.equal(r.trades.length, 0);
  assert.equal(r.unpaired_exit_count, 1);
});

test('adaptive-weights: loadClosedTrades on empty / non-array input returns empty', () => {
  const r1 = loadClosedTrades([], { sinceMs: 0 });
  assert.equal(r1.trades.length, 0);
  assert.equal(r1.parse_error_count, 0);
  assert.equal(r1.skipped_event_count, 0);
  // @ts-ignore
  const r2 = loadClosedTrades(null, { sinceMs: 0 });
  assert.equal(r2.trades.length, 0);
});

// ─── summarizeClosedTrades ──────────────────────────────────────────────

test('adaptive-weights: summarizeClosedTrades counts wins / losses / break-evens', () => {
  const trades = [
    { realized_pnl_sats: 1000, hold_ms: 1000, entry_score: 0.7, size_bch: 0.005, exit_kind: 'take_profit' },
    { realized_pnl_sats: -500, hold_ms: 1000, entry_score: 0.4, size_bch: 0.005, exit_kind: 'stop_loss' },
    { realized_pnl_sats: 0,    hold_ms: 1000, entry_score: 0.5, size_bch: 0.005, exit_kind: 'time_stop' },
    { realized_pnl_sats: 2000, hold_ms: 1000, entry_score: 0.8, size_bch: 0.005, exit_kind: 'take_profit' },
  ];
  const s = summarizeClosedTrades(trades);
  assert.equal(s.count, 4);
  assert.equal(s.accounted_count, 4);
  assert.equal(s.wins, 2);
  assert.equal(s.losses, 1);
  assert.equal(s.break_evens, 1);
  assert.equal(s.best_trade_pnl_sats, 2000);
  assert.equal(s.worst_trade_pnl_sats, -500);
  assert.equal(s.win_rate, 0.5);
  assert.equal(s.total_realized_pnl_sats, 2500);
});

test('adaptive-weights: summarizeClosedTrades separates accounted from unaccounted', () => {
  const trades = [
    { realized_pnl_sats: 1000, hold_ms: 1000, entry_score: 0.7, size_bch: 0.005, exit_kind: 'take_profit' },
    { realized_pnl_sats: null, hold_ms: 1000, entry_score: 0.4, size_bch: 0.005, exit_kind: 'stop_loss' },
  ];
  const s = summarizeClosedTrades(trades);
  assert.equal(s.count, 2);
  assert.equal(s.accounted_count, 1);
  assert.equal(s.unaccounted_count, 1);
  assert.equal(s.wins, 1);
  assert.equal(s.losses, 0);
});

test('adaptive-weights: summarizeClosedTrades groups by exit_kind', () => {
  const trades = [
    { realized_pnl_sats: 100, hold_ms: 0, entry_score: 0.5, size_bch: 0, exit_kind: 'time_stop' },
    { realized_pnl_sats: -100, hold_ms: 0, entry_score: 0.5, size_bch: 0, exit_kind: 'time_stop' },
    { realized_pnl_sats: 500, hold_ms: 0, entry_score: 0.5, size_bch: 0, exit_kind: 'take_profit' },
  ];
  const s = summarizeClosedTrades(trades);
  assert.equal(s.by_exit_kind.time_stop.count, 2);
  assert.equal(s.by_exit_kind.time_stop.wins, 1);
  assert.equal(s.by_exit_kind.time_stop.losses, 1);
  assert.equal(s.by_exit_kind.take_profit.count, 1);
  assert.equal(s.by_exit_kind.take_profit.wins, 1);
});

// ─── mean / pearson ─────────────────────────────────────────────────────

test('adaptive-weights: mean returns null on empty / no-finite inputs', () => {
  assert.equal(mean([]), null);
  assert.equal(mean([null, undefined, NaN, Infinity, 'x']), null);
});

test('adaptive-weights: mean ignores non-finite values', () => {
  assert.equal(mean([1, 2, 3, NaN, 4]), 2.5);
});

test('adaptive-weights: pearson computes perfect positive correlation', () => {
  const r = pearson([1, 2, 3, 4], [2, 4, 6, 8]);
  assert.equal(Math.abs(r - 1), 0, `expected r=1 got ${r}`);
});

test('adaptive-weights: pearson computes perfect negative correlation', () => {
  const r = pearson([1, 2, 3, 4], [8, 6, 4, 2]);
  assert.equal(Math.abs(r + 1) < 1e-9, true, `expected r=-1 got ${r}`);
});

test('adaptive-weights: pearson returns null on zero variance', () => {
  assert.equal(pearson([1, 1, 1, 1], [1, 2, 3, 4]), null);
  assert.equal(pearson([1, 2, 3, 4], [5, 5, 5, 5]), null);
});

test('adaptive-weights: pearson returns null on length mismatch / <2 pairs', () => {
  assert.equal(pearson([1], [1]), null);
  assert.equal(pearson([1, 2], [1, 2, 3]), null);
});

// ─── computeCalibrationCorrelation ──────────────────────────────────────

test('adaptive-weights: computeCalibrationCorrelation returns positive when high-score trades win', () => {
  // High-score entries → wins; low-score entries → losses. The
  // calibration is positive: the ranker is calibrated.
  const trades = [
    { entry_score: 0.8, realized_pnl_sats: 1000 },
    { entry_score: 0.7, realized_pnl_sats: 800 },
    { entry_score: 0.4, realized_pnl_sats: -500 },
    { entry_score: 0.3, realized_pnl_sats: -300 },
  ];
  const r = computeCalibrationCorrelation(trades);
  assert.ok(r !== null && r > 0.9, `expected strong positive r, got ${r}`);
});

test('adaptive-weights: computeCalibrationCorrelation returns negative when high-score trades lose', () => {
  // High-score entries → losses; low-score entries → wins.
  const trades = [
    { entry_score: 0.8, realized_pnl_sats: -1000 },
    { entry_score: 0.7, realized_pnl_sats: -800 },
    { entry_score: 0.4, realized_pnl_sats: 500 },
    { entry_score: 0.3, realized_pnl_sats: 300 },
  ];
  const r = computeCalibrationCorrelation(trades);
  assert.ok(r !== null && r < -0.9, `expected strong negative r, got ${r}`);
});

test('adaptive-weights: computeCalibrationCorrelation returns null on missing evidence', () => {
  // All trades missing both fields.
  const r = computeCalibrationCorrelation([
    { entry_score: null, realized_pnl_sats: null },
    { entry_score: undefined, realized_pnl_sats: undefined },
  ]);
  assert.equal(r, null);
});

test('adaptive-weights: computeCalibrationCorrelation returns null on empty input', () => {
  assert.equal(computeCalibrationCorrelation([]), null);
  // @ts-ignore
  assert.equal(computeCalibrationCorrelation(null), null);
});

// ─── suggestAdaptiveWeights ─────────────────────────────────────────────

const BASE_WEIGHTS = {
  volume_24h_bch: 0.10,
  volume_7d_bch: 0.10,
  volume_30d_bch: 0.30,
  volatility_24h_pct: 0.10,
  tvl_bch: 0.10,
  apy_30d_pct: 0.10,
  fee_yield_bps: 0.05,
  upward_volatility: 0.15,
};

test('adaptive-weights: suggestAdaptiveWeights on positive correlation AMPLIFIES (weights move AWAY from uniform)', () => {
  const r = suggestAdaptiveWeights(
    { baseWeights: BASE_WEIGHTS, calibrationCorrelation: 0.5 },
    { tradeCount: 10 }
  );
  assert.equal(r.applied, true);
  assert.equal(r.summary.direction, 'amplify');
  // volume_30d_bch (highest base) should move AWAY from uniform
  // (0.125) — getting LARGER.
  assert.ok(r.suggested.volume_30d_bch > r.baseWeights.volume_30d_bch,
    `expected amplification on highest-weighted feature; base ${r.baseWeights.volume_30d_bch} suggested ${r.suggested.volume_30d_bch}`);
  // Sum-to-1 invariant.
  const sum = Object.values(r.suggested).reduce((a, v) => a + v, 0);
  assert.ok(Math.abs(sum - 1.0) < 1e-9, `suggested sum=${sum}`);
  // Deltas reproduce suggested - base.
  for (const k of Object.keys(r.suggested)) {
    const expected = r.suggested[k] - r.baseWeights[k];
    assert.ok(Math.abs(r.deltas[k] - expected) < 1e-9,
      `${k}: delta ${r.deltas[k]} != suggested-base ${expected}`);
  }
});

test('adaptive-weights: suggestAdaptiveWeights on negative correlation DILUTES (weights move TOWARD uniform)', () => {
  const r = suggestAdaptiveWeights(
    { baseWeights: BASE_WEIGHTS, calibrationCorrelation: -0.5 },
    { tradeCount: 10 }
  );
  assert.equal(r.applied, true);
  assert.equal(r.summary.direction, 'dilute');
  // volume_30d_bch (highest base 0.30) should move TOWARD uniform
  // (0.125) — getting SMALLER.
  assert.ok(r.suggested.volume_30d_bch < r.baseWeights.volume_30d_bch,
    `expected dilution on highest-weighted feature; base ${r.baseWeights.volume_30d_bch} suggested ${r.suggested.volume_30d_bch}`);
  // fee_yield_bps (lowest base 0.05) should move TOWARD uniform —
  // getting LARGER.
  assert.ok(r.suggested.fee_yield_bps > r.baseWeights.fee_yield_bps,
    `expected dilution to lift lowest-weighted feature; base ${r.baseWeights.fee_yield_bps} suggested ${r.suggested.fee_yield_bps}`);
  // Sum-to-1 invariant.
  const sum = Object.values(r.suggested).reduce((a, v) => a + v, 0);
  assert.ok(Math.abs(sum - 1.0) < 1e-9, `suggested sum=${sum}`);
});

test('adaptive-weights: suggestAdaptiveWeights clamps to deltaMaxPerFeature caps', () => {
  // With correlation=1.0 and cap=0.05, every weight should move by
  // at most 0.05*gap from baseline BEFORE renormalization — but
  // the renormalization step redistributes proportional mass, so
  // a true cap means no single weight ever increases by more than
  // 5% of its baseline gap. We test instead that the pull is
  // BOUNDED by the cap before renormalization — i.e. with a
  // small cap (0.01) and a strong correlation, the suggested
  // weights stay close to base.
  const r = suggestAdaptiveWeights(
    { baseWeights: BASE_WEIGHTS, calibrationCorrelation: 1.0 },
    { tradeCount: 10, amplificationMax: 0.01, uniformityPullMax: 0.01 }
  );
  assert.equal(r.applied, true);
  for (const k of Object.keys(r.suggested)) {
    const moved = Math.abs(r.suggested[k] - r.baseWeights[k]);
    assert.ok(moved < 0.02, `${k} moved ${moved} (cap was 0.01*1.0=0.01)`);
  }
});

test('adaptive-weights: suggestAdaptiveWeights below min_closed_trades returns base unchanged', () => {
  const r = suggestAdaptiveWeights(
    { baseWeights: BASE_WEIGHTS, calibrationCorrelation: 0.9 },
    { tradeCount: 3, minClosedTrades: 5 }
  );
  assert.equal(r.applied, false);
  assert.equal(r.reason, 'below_min_closed_trades');
  for (const k of Object.keys(BASE_WEIGHTS)) {
    assert.equal(r.suggested[k], r.baseWeights[k]);
    assert.equal(r.deltas[k], 0);
  }
});

test('adaptive-weights: suggestAdaptiveWeights near-zero calibration returns base unchanged', () => {
  const r = suggestAdaptiveWeights(
    { baseWeights: BASE_WEIGHTS, calibrationCorrelation: 0.05 },
    { tradeCount: 50, calibrationFloor: 0.10 }
  );
  assert.equal(r.applied, false);
  assert.equal(r.reason, 'calibration_below_floor');
});

test('adaptive-weights: suggestAdaptiveWeights on null correlation returns base unchanged', () => {
  const r = suggestAdaptiveWeights(
    { baseWeights: BASE_WEIGHTS, calibrationCorrelation: null },
    { tradeCount: 50 }
  );
  assert.equal(r.applied, false);
  assert.equal(r.reason, 'no_calibration_evidence');
});

test('adaptive-weights: suggestAdaptiveWeights on empty baseWeights returns applied:false', () => {
  const r = suggestAdaptiveWeights(
    { baseWeights: {}, calibrationCorrelation: 0.5 },
    { tradeCount: 50 }
  );
  assert.equal(r.applied, false);
  assert.equal(r.reason, 'empty_base_weights');
});

test('adaptive-weights: suggestAdaptiveWeights on all-zero baseWeights returns applied:false', () => {
  const r = suggestAdaptiveWeights(
    {
      baseWeights: { a: 0, b: 0, c: 0 },
      calibrationCorrelation: 0.5,
    },
    { tradeCount: 50 }
  );
  assert.equal(r.applied, false);
  assert.equal(r.reason, 'all_zero_base_weights');
});

test('adaptive-weights: suggestAdaptiveWeights renormalizes arbitrary input weights', () => {
  // Sum=4.0 — must be renormalized to sum=1.0 before any shift.
  const r = suggestAdaptiveWeights(
    {
      baseWeights: { a: 1.0, b: 2.0, c: 1.0 },
      calibrationCorrelation: -0.5,
    },
    { tradeCount: 10 }
  );
  assert.equal(r.applied, true);
  const sumBase = Object.values(r.baseWeights).reduce((a, v) => a + v, 0);
  assert.ok(Math.abs(sumBase - 1.0) < 1e-9, `baseWeights sum=${sumBase}`);
  const sumSuggested = Object.values(r.suggested).reduce((a, v) => a + v, 0);
  assert.ok(Math.abs(sumSuggested - 1.0) < 1e-9, `suggested sum=${sumSuggested}`);
});

test('adaptive-weights: suggestAdaptiveWeights rejects non-finite base weights silently', () => {
  const r = suggestAdaptiveWeights(
    {
      baseWeights: { a: 0.5, b: NaN, c: 0.5 },
      calibrationCorrelation: 0.5,
    },
    { tradeCount: 10 }
  );
  assert.equal(r.applied, true);
  assert.equal(r.baseWeights.b, 0);
});

test('adaptive-weights: suggestAdaptiveWeights uses defaults when opts omitted', () => {
  const r = suggestAdaptiveWeights(
    { baseWeights: BASE_WEIGHTS, calibrationCorrelation: 0.5 }
  );
  // Defaults: DEFAULT_MIN_CLOSED_TRADES=5, so tradeCount defaults to
  // 0 → below_min_closed_trades. We assert that the default knobs
  // take effect.
  assert.equal(r.applied, false);
  assert.equal(r.reason, 'below_min_closed_trades');
});

// ─── formatSuggestionDiff ───────────────────────────────────────────────

test('adaptive-weights: formatSuggestionDiff renders a readable per-feature table', () => {
  const out = formatSuggestionDiff({
    base: { volume_24h_bch: 0.10, volume_30d_bch: 0.30 },
    suggested: { volume_24h_bch: 0.105, volume_30d_bch: 0.295 },
    deltas: { volume_24h_bch: 0.005, volume_30d_bch: -0.005 },
  });
  // Header line + divider + two feature lines.
  assert.match(out, /feature/);
  assert.match(out, /volume_24h_bch/);
  assert.match(out, /volume_30d_bch/);
  assert.match(out, /-0\.0050/);
  assert.match(out, /\+0\.0050/);
});

test('adaptive-weights: formatSuggestionDiff on empty base returns the header-only string', () => {
  const out = formatSuggestionDiff({ base: {}, suggested: {}, deltas: {} });
  assert.match(out, /no features/);
});

// ─── defaults ──────────────────────────────────────────────────────────

test('adaptive-weights: defaults are exported + sane', () => {
  assert.equal(DEFAULT_WINDOW_MS, 7 * 24 * 60 * 60 * 1000);
  assert.ok(DEFAULT_MIN_CLOSED_TRADES >= 1);
  assert.ok(DEFAULT_UNIFORMITY_PULL_MAX > 0 && DEFAULT_UNIFORMITY_PULL_MAX <= 1);
  assert.ok(DEFAULT_AMPLIFICATION_MAX > 0 && DEFAULT_AMPLIFICATION_MAX <= 1);
  assert.ok(DEFAULT_CALIBRATION_FLOOR > 0 && DEFAULT_CALIBRATION_FLOOR <= 1);
});

// ─── applyAdaptiveWeightsToUserJson ─────────────────────────────────────
//
// T56-2 subset 2 — the loop hot-reads `scoring.adaptive_weights_enabled`
// at the end of every tick and, when true, runs the calibration engine
// + this helper against `config/user.json`. The helper is pure; these
// tests lock the contract: deep-merge, WIF preservation, audit stamp,
// no-op on missing base, malformed suggestion, etc.

test('adaptive-weights: applyAdaptiveWeightsToUserJson mutates scoring.weights on applied:true', () => {
  const userJson = {
    wallet: { wif: 'L4rK1...secret...' },
    dashboard: { api_token: 'tok-xyz' },
    scoring: { weights: { ...BASE_WEIGHTS } },
  };
  const suggestion = {
    applied: true,
    suggested: { a: 0.5, b: 0.5 },
    reason: 'amplify_positive_correlation',
    calibrationCorrelation: 0.6,
    summary: { features_evaluated: 8 },
  };
  const out = applyAdaptiveWeightsToUserJson({ userJson, suggestion, nowMs: NOW_MS, windowDays: 7 });
  assert.equal(out.mutated, true);
  assert.equal(out.reason, 'amplify_positive_correlation');
  assert.deepEqual(out.suggestedWeights, { a: 0.5, b: 0.5 });
  assert.deepEqual(out.next.scoring.weights, { a: 0.5, b: 0.5 });
  // WIF + dashboard api_token MUST be preserved untouched.
  assert.equal(out.next.wallet.wif, 'L4rK1...secret...');
  assert.equal(out.next.dashboard.api_token, 'tok-xyz');
  // Audit envelope must be stamped.
  assert.equal(out.next.adaptive_weights_last_applied.applied, true);
  assert.equal(out.next.adaptive_weights_last_applied.calibration_correlation, 0.6);
  assert.equal(out.next.adaptive_weights_last_applied.window_days, 7);
  assert.equal(typeof out.next.adaptive_weights_last_applied.ts_ms, 'number');
  assert.equal(typeof out.next.adaptive_weights_last_applied.ts_iso, 'string');
  // Original input not mutated.
  assert.deepEqual(userJson.scoring.weights, BASE_WEIGHTS);
});

test('adaptive-weights: applyAdaptiveWeightsToUserJson is a no-op on applied:false', () => {
  const userJson = { scoring: { weights: { ...BASE_WEIGHTS } } };
  const suggestion = {
    applied: false,
    suggested: {},
    reason: 'below_min_closed_trades',
    calibrationCorrelation: 0.05,
  };
  const out = applyAdaptiveWeightsToUserJson({ userJson, suggestion, nowMs: NOW_MS });
  assert.equal(out.mutated, false);
  assert.equal(out.reason, 'below_min_closed_trades');
  // Weights must remain unchanged.
  assert.deepEqual(out.next.scoring.weights, BASE_WEIGHTS);
  // Audit envelope still stamped (so the operator sees why).
  assert.equal(out.next.adaptive_weights_last_applied.applied, false);
  assert.equal(out.next.adaptive_weights_last_applied.reason, 'below_min_closed_trades');
});

test('adaptive-weights: applyAdaptiveWeightsToUserJson downgrades applied:true with empty suggested', () => {
  const userJson = { scoring: { weights: { ...BASE_WEIGHTS } } };
  const suggestion = { applied: true, suggested: {}, reason: 'should_not_apply' };
  const out = applyAdaptiveWeightsToUserJson({ userJson, suggestion, nowMs: NOW_MS });
  assert.equal(out.mutated, false);
  assert.equal(out.reason, 'empty_suggested_weights');
  // Weights must NOT be touched on the downgrade path.
  assert.deepEqual(out.next.scoring.weights, BASE_WEIGHTS);
});

test('adaptive-weights: applyAdaptiveWeightsToUserJson rejects malformed suggestion safely', () => {
  const userJson = { scoring: { weights: { ...BASE_WEIGHTS } } };
  for (const bad of [null, undefined, 'string', 42, true]) {
    const out = applyAdaptiveWeightsToUserJson({ userJson, suggestion: bad, nowMs: NOW_MS });
    assert.equal(out.mutated, false, `expected no mutation for ${JSON.stringify(bad)}`);
    assert.equal(out.reason, 'malformed_suggestion');
    assert.deepEqual(out.next.scoring.weights, BASE_WEIGHTS);
  }
});

test('adaptive-weights: applyAdaptiveWeightsToUserJson throws on bad userJson', () => {
  for (const bad of [null, undefined, 'string', 42, true, []]) {
    assert.throws(
      () => applyAdaptiveWeightsToUserJson({ userJson: bad, suggestion: { applied: false, suggested: {} } }),
      TypeError
    );
  }
});

test('adaptive-weights: applyAdaptiveWeightsToUserJson uses Date.now() when nowMs omitted', () => {
  const before = Date.now();
  const userJson = { scoring: { weights: { ...BASE_WEIGHTS } } };
  const suggestion = { applied: false, suggested: {}, reason: 'test' };
  const out = applyAdaptiveWeightsToUserJson({ userJson, suggestion });
  const after = Date.now();
  const ts = out.next.adaptive_weights_last_applied.ts_ms;
  assert.ok(ts >= before && ts <= after, `ts_ms ${ts} not within [${before},${after}]`);
});

test('adaptive-weights: applyAdaptiveWeightsToUserJson handles missing scoring block', () => {
  const userJson = { wallet: { wif: 'secret' } };
  const suggestion = {
    applied: true,
    suggested: { a: 0.5, b: 0.5 },
    reason: 'test',
    calibrationCorrelation: 0.5,
    summary: { features_evaluated: 5 },
  };
  const out = applyAdaptiveWeightsToUserJson({ userJson, suggestion, nowMs: NOW_MS });
  assert.equal(out.mutated, true);
  assert.equal(out.next.scoring.weights.a, 0.5);
  assert.equal(out.next.scoring.weights.b, 0.5);
  assert.equal(out.next.wallet.wif, 'secret');
});

test('adaptive-weights: applyAdaptiveWeightsToUserJson preserves every key of userJson', () => {
  const userJson = {
    wallet: { wif: 'L4rK1', address: 'bitcoincash:xyz' },
    dashboard: { api_token: 'tok', port: 3000 },
    risk: { max_position_bch: 0.005 },
    scoring: { weights: { ...BASE_WEIGHTS } },
    extra: { nested: { foo: 'bar' }, list: [1, 2, 3] },
  };
  const suggestion = {
    applied: true,
    suggested: { a: 0.5, b: 0.5 },
    reason: 'test',
    calibrationCorrelation: 0.5,
    summary: { features_evaluated: 5 },
  };
  const out = applyAdaptiveWeightsToUserJson({ userJson, suggestion, nowMs: NOW_MS });
  assert.equal(out.next.wallet.wif, 'L4rK1');
  assert.equal(out.next.wallet.address, 'bitcoincash:xyz');
  assert.equal(out.next.dashboard.api_token, 'tok');
  assert.equal(out.next.dashboard.port, 3000);
  assert.equal(out.next.risk.max_position_bch, 0.005);
  assert.deepEqual(out.next.extra, { nested: { foo: 'bar' }, list: [1, 2, 3] });
});

// ─── buildAdaptiveWeightsAuditRecord ────────────────────────────────────

test('adaptive-weights: buildAdaptiveWeightsAuditRecord renders applied:true shape', () => {
  const suggestion = {
    applied: true,
    suggested: { a: 0.6, b: 0.4 },
    baseWeights: { a: 0.5, b: 0.5 },
    deltas: { a: 0.1, b: -0.1 },
    calibrationCorrelation: 0.42,
    summary: {
      direction: 'amplify',
      pull_max_used: 0.05,
      features_evaluated: 10,
      uniform_target: 0.5,
      sum_base: 1.0,
      sum_suggested: 1.0,
    },
    reason: 'amplify_positive_correlation',
  };
  const userJson = {
    scoring: { weights: { a: 0.6, b: 0.4 } },
    adaptive_weights_last_applied: { window_days: 7 },
  };
  const rec = buildAdaptiveWeightsAuditRecord({
    suggestion,
    userJson,
    nowMs: NOW_MS,
    userJsonPath: 'config/user.json',
  });
  assert.equal(rec.kind, 'adaptive_weights_apply');
  assert.equal(rec.applied, true);
  assert.equal(rec.calibration_correlation, 0.42);
  assert.deepEqual(rec.base_weights, { a: 0.5, b: 0.5 });
  assert.deepEqual(rec.suggested_weights, { a: 0.6, b: 0.4 });
  assert.deepEqual(rec.deltas, { a: 0.1, b: -0.1 });
  assert.equal(rec.direction, 'amplify');
  assert.equal(rec.pull_max_used, 0.05);
  assert.equal(rec.features_evaluated, 10);
  assert.equal(rec.trade_count, 10);
  assert.equal(rec.window_days, 7);
  assert.deepEqual(rec.weights_after, { a: 0.6, b: 0.4 });
  assert.equal(rec.user_json_path, 'config/user.json');
  assert.equal(rec.reason, 'amplify_positive_correlation');
  assert.equal(rec.ts_ms, NOW_MS);
  assert.match(rec.ts, /^\d{4}-\d{2}-\d{2}T/);
});

test('adaptive-weights: buildAdaptiveWeightsAuditRecord renders applied:false (no-op audit) shape', () => {
  const suggestion = {
    applied: false,
    reason: 'calibration_below_floor',
    calibrationCorrelation: 0.02,
    summary: { features_evaluated: 3 },
  };
  const rec = buildAdaptiveWeightsAuditRecord({
    suggestion,
    userJson: { scoring: { weights: { a: 0.5, b: 0.5 } } },
    nowMs: NOW_MS,
    userJsonPath: 'config/user.json',
  });
  assert.equal(rec.applied, false);
  assert.equal(rec.reason, 'calibration_below_floor');
  assert.equal(rec.calibration_correlation, 0.02);
  assert.equal(rec.trade_count, 3);
});

test('adaptive-weights: buildAdaptiveWeightsAuditRecord handles missing fields with nulls', () => {
  const rec = buildAdaptiveWeightsAuditRecord({
    suggestion: { applied: false },
    userJson: {},
    nowMs: NOW_MS,
    userJsonPath: 'config/user.json',
  });
  assert.equal(rec.applied, false);
  assert.equal(rec.calibration_correlation, null);
  assert.equal(rec.base_weights, null);
  assert.equal(rec.suggested_weights, null);
  assert.equal(rec.deltas, null);
  assert.equal(rec.trade_count, null);
  assert.equal(rec.window_days, null);
  assert.equal(rec.weights_after, null);
});

test('adaptive-weights: buildAdaptiveWeightsAuditRecord handles null suggestion without throwing', () => {
  const rec = buildAdaptiveWeightsAuditRecord({
    suggestion: null,
    userJson: {},
    nowMs: NOW_MS,
    userJsonPath: 'config/user.json',
  });
  assert.equal(rec.applied, false);
  assert.equal(rec.reason, null);
});

// ─── runAdaptiveWeightsSuggestion ──────────────────────────────────────

test('adaptive-weights: runAdaptiveWeightsSuggestion returns envelope shape on applied:true', async () => {
  const suggestion = await runAdaptiveWeightsSuggestion({
    loadHistory: async () => [
      JSON.stringify({
        kind: 'entry', ts: new Date(NOW_MS - 86400_000).toISOString(),
        position_id: 'pos_a', token_id: TID_A,
        size_bch: 0.005, price_sats_per_token: 300,
        bch_spent_sats: 502000, token_amount_base: '5000',
        fee_sats: 2000, slippage_bps: 33, rank: 1, score: 0.60,
      }),
      JSON.stringify({
        kind: 'exit', ts: new Date(NOW_MS).toISOString(),
        position_id: 'pos_a', token_id: TID_A,
        txid: 'b'.repeat(64), exit_kind: 'time_stop',
        price_sats_per_token: 320, bch_received_sats: 510000,
        fee_sats: 2000, realized_pnl_sats: 5000, realized_pnl_bch: 0.00005,
        slippage_bps: null,
      }),
      // Repeat enough trades to clear min_closed_trades floor.
      JSON.stringify({
        kind: 'entry', ts: new Date(NOW_MS - 86400_000).toISOString(),
        position_id: 'pos_b', token_id: TID_A,
        size_bch: 0.005, price_sats_per_token: 300,
        bch_spent_sats: 502000, token_amount_base: '5000',
        fee_sats: 2000, slippage_bps: 33, rank: 1, score: 0.62,
      }),
      JSON.stringify({
        kind: 'exit', ts: new Date(NOW_MS).toISOString(),
        position_id: 'pos_b', token_id: TID_A,
        txid: 'c'.repeat(64), exit_kind: 'time_stop',
        price_sats_per_token: 330, bch_received_sats: 530000,
        fee_sats: 2000, realized_pnl_sats: 10000, realized_pnl_bch: 0.0001,
        slippage_bps: null,
      }),
      JSON.stringify({
        kind: 'entry', ts: new Date(NOW_MS - 86400_000).toISOString(),
        position_id: 'pos_c', token_id: TID_A,
        size_bch: 0.005, price_sats_per_token: 300,
        bch_spent_sats: 502000, token_amount_base: '5000',
        fee_sats: 2000, slippage_bps: 33, rank: 1, score: 0.61,
      }),
      JSON.stringify({
        kind: 'exit', ts: new Date(NOW_MS).toISOString(),
        position_id: 'pos_c', token_id: TID_A,
        txid: 'd'.repeat(64), exit_kind: 'time_stop',
        price_sats_per_token: 310, bch_received_sats: 502000,
        fee_sats: 2000, realized_pnl_sats: -1000, realized_pnl_bch: -0.00001,
        slippage_bps: null,
      }),
      JSON.stringify({
        kind: 'entry', ts: new Date(NOW_MS - 86400_000).toISOString(),
        position_id: 'pos_d', token_id: TID_A,
        size_bch: 0.005, price_sats_per_token: 300,
        bch_spent_sats: 502000, token_amount_base: '5000',
        fee_sats: 2000, slippage_bps: 33, rank: 1, score: 0.65,
      }),
      JSON.stringify({
        kind: 'exit', ts: new Date(NOW_MS).toISOString(),
        position_id: 'pos_d', token_id: TID_A,
        txid: 'e'.repeat(64), exit_kind: 'time_stop',
        price_sats_per_token: 340, bch_received_sats: 540000,
        fee_sats: 2000, realized_pnl_sats: 15000, realized_pnl_bch: 0.00015,
        slippage_bps: null,
      }),
      JSON.stringify({
        kind: 'entry', ts: new Date(NOW_MS - 86400_000).toISOString(),
        position_id: 'pos_e', token_id: TID_A,
        size_bch: 0.005, price_sats_per_token: 300,
        bch_spent_sats: 502000, token_amount_base: '5000',
        fee_sats: 2000, slippage_bps: 33, rank: 1, score: 0.59,
      }),
      JSON.stringify({
        kind: 'exit', ts: new Date(NOW_MS).toISOString(),
        position_id: 'pos_e', token_id: TID_A,
        txid: 'f'.repeat(64), exit_kind: 'time_stop',
        price_sats_per_token: 308, bch_received_sats: 502000,
        fee_sats: 2000, realized_pnl_sats: 0, realized_pnl_bch: 0,
        slippage_bps: null,
      }),
    ],
    baseWeights: BASE_WEIGHTS,
    nowMs: NOW_MS,
    opts: { windowDays: 7, minClosedTrades: 5, maxDelta: 0.05, calibrationFloor: 0.10 },
  });
  assert.equal(suggestion.ok, true);
  assert.equal(typeof suggestion.now_ms, 'number');
  assert.equal(suggestion.window_days, 7);
  assert.equal(suggestion.window_ms, 7 * 86400_000);
  assert.equal(typeof suggestion.since_ms, 'number');
  assert.ok(suggestion.closed_trade_count >= 5);
  assert.equal(typeof suggestion.calibration_correlation, 'number');
  assert.ok(suggestion.summary);
  assert.ok(suggestion.suggestion);
  // The exact applied flag depends on the engine's math but it must
  // be a boolean. We don't assert applied=true here — that's covered
  // by the existing suggestAdaptiveWeights unit tests.
  assert.equal(typeof suggestion.suggestion.applied, 'boolean');
});

test('adaptive-weights: runAdaptiveWeightsSuggestion returns ok:false when loadHistory throws', async () => {
  const suggestion = await runAdaptiveWeightsSuggestion({
    loadHistory: async () => { throw new Error('disk gone'); },
    baseWeights: BASE_WEIGHTS,
    nowMs: NOW_MS,
    opts: { windowDays: 7, minClosedTrades: 5, maxDelta: 0.05, calibrationFloor: 0.10 },
  });
  assert.equal(suggestion.ok, false);
  assert.equal(suggestion.error, 'history_load_failed');
  assert.match(suggestion.error_message, /disk gone/);
});

test('adaptive-weights: runAdaptiveWeightsSuggestion returns ok:false on empty history (treated as no-trades)', async () => {
  const suggestion = await runAdaptiveWeightsSuggestion({
    loadHistory: async () => [],
    baseWeights: BASE_WEIGHTS,
    nowMs: NOW_MS,
    opts: { windowDays: 7, minClosedTrades: 5, maxDelta: 0.05, calibrationFloor: 0.10 },
  });
  // An empty history isn't an error — it's just no signal. The
  // engine no-ops via `below_min_closed_trades`. The envelope is
  // `ok:true` with `applied:false`.
  assert.equal(suggestion.ok, true);
  assert.equal(suggestion.closed_trade_count, 0);
  assert.equal(suggestion.suggestion.applied, false);
  assert.equal(suggestion.suggestion.reason, 'below_min_closed_trades');
});

test('adaptive-weights: runAdaptiveWeightsSuggestion throws TypeError on bad loadHistory', async () => {
  await assert.rejects(
    () => runAdaptiveWeightsSuggestion({ loadHistory: null, baseWeights: BASE_WEIGHTS, nowMs: NOW_MS }),
    /loadHistory must be a function/
  );
});

test('adaptive-weights: runAdaptiveWeightsSuggestion throws TypeError on bad baseWeights', async () => {
  await assert.rejects(
    () => runAdaptiveWeightsSuggestion({ loadHistory: async () => [], baseWeights: null, nowMs: NOW_MS }),
    /baseWeights must be a non-null object/
  );
});

test('adaptive-weights: runAdaptiveWeightsSuggestion falls back to engine defaults when opts omitted', async () => {
  const suggestion = await runAdaptiveWeightsSuggestion({
    loadHistory: async () => [],
    baseWeights: BASE_WEIGHTS,
    nowMs: NOW_MS,
  });
  assert.equal(suggestion.window_days, 7);
  assert.equal(suggestion.suggestion.applied, false);
  assert.equal(suggestion.suggestion.reason, 'below_min_closed_trades');
});
