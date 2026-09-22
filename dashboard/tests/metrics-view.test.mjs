#!/usr/bin/env node
/**
 * dashboard/tests/metrics-view.test.mjs
 *
 * T79 subset 2 — unit tests for the pure helpers in
 * `dashboard/src/views/metrics-view-helpers.mjs`. Mirrors the
 * pattern used by `token-summary-view.test.mjs` / `fee-breakdown-view.test.mjs`:
 * 100% dependency-free (no React, no API), so all edge cases
 * are tested at the helper boundary.
 *
 * Run with:
 *   node --test dashboard/tests/metrics-view.test.mjs
 *
 * Coverage:
 *   1. parsePrometheusText — happy / empty / malformed lines / HELP / TYPE / samples
 *   2. parseLabelsString — happy / empty / escape / malformed
 *   3. summarizeMetricBlocks — happy / null / tradebot_up / tick_count
 *   4. groupByPrefix — sorts + groups + derives prefix
 *   5. deriveMetricPrefix — strips measurement suffixes
 *   6. isMetricsUnavailable — missing / empty / unparseable
 *   7. metricsErrorMessage — err / empty / `# ERROR` line / null
 *   8. metricsHelpText — empty / unparseable
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parsePrometheusText,
  parseLabelsString,
  summarizeMetricBlocks,
  groupByPrefix,
  deriveMetricPrefix,
  isMetricsUnavailable,
  metricsErrorMessage,
  metricsHelpText,
} from '../src/views/metrics-view-helpers.mjs';

// ─────────────────────────────────────────────────────────────────────
//  parsePrometheusText
// ─────────────────────────────────────────────────────────────────────
test('parsePrometheusText: returns empty array for non-string', () => {
  assert.deepEqual(parsePrometheusText(null), []);
  assert.deepEqual(parsePrometheusText(undefined), []);
  assert.deepEqual(parsePrometheusText(42), []);
});

test('parsePrometheusText: returns empty array for empty string', () => {
  assert.deepEqual(parsePrometheusText(''), []);
});

test('parsePrometheusText: parses a minimal single-sample body', () => {
  const text = [
    '# HELP tradebot_up Process is responsive (1=responding to /metrics, 0=not)',
    '# TYPE tradebot_up gauge',
    'tradebot_up 1',
  ].join('\n');
  const blocks = parsePrometheusText(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].name, 'tradebot_up');
  assert.equal(blocks[0].type, 'gauge');
  assert.match(blocks[0].help, /Process is responsive/);
  assert.equal(blocks[0].samples.length, 1);
  assert.deepEqual(blocks[0].samples[0], { labels: {}, value: '1' });
});

test('parsePrometheusText: parses sample with labels', () => {
  const text = [
    '# TYPE tradebot_token_entry_count_total counter',
    'tradebot_token_entry_count_total{token_id="aaa",symbol="TOK"} 5',
    'tradebot_token_entry_count_total{token_id="bbb",symbol="FOO"} 3',
  ].join('\n');
  const blocks = parsePrometheusText(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].samples.length, 2);
  assert.equal(blocks[0].samples[0].value, '5');
  assert.equal(blocks[0].samples[0].labels.token_id, 'aaa');
  assert.equal(blocks[0].samples[1].labels.symbol, 'FOO');
});

test('parsePrometheusText: ignores generic comment lines', () => {
  const text = [
    '# generic comment',
    'tradebot_up 1',
  ].join('\n');
  const blocks = parsePrometheusText(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].help, ''); // no HELP line emitted
});

test('parsePrometheusText: silently drops malformed sample lines', () => {
  const text = [
    'malformed_no_space_here',
    'also_no_space_value',
    'tradebot_up 1',
  ].join('\n');
  const blocks = parsePrometheusText(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].samples.length, 1);
});

test('parsePrometheusText: handles CRLF line endings', () => {
  const text = '# TYPE tradebot_up gauge\r\ntradebot_up 1\r\n';
  const blocks = parsePrometheusText(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].samples[0].value, '1');
});

test('parsePrometheusText: multiple samples accumulate per block', () => {
  const text = [
    '# TYPE tradebot_loop_tick_count_total counter',
    'tradebot_loop_tick_count_total{probe_status="ok"} 10',
    'tradebot_loop_tick_count_total{probe_status="degraded"} 5',
  ].join('\n');
  const blocks = parsePrometheusText(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].samples.length, 2);
});

// ─────────────────────────────────────────────────────────────────────
//  parseLabelsString
// ─────────────────────────────────────────────────────────────────────
test('parseLabelsString: returns empty for non-string', () => {
  assert.deepEqual(parseLabelsString(null), {});
  assert.deepEqual(parseLabelsString(undefined), {});
});

test('parseLabelsString: parses a single key=value pair', () => {
  assert.deepEqual(parseLabelsString('key="value"'), { key: 'value' });
});

test('parseLabelsString: parses multiple pairs', () => {
  assert.deepEqual(
    parseLabelsString('a="1",b="2",c="3"'),
    { a: '1', b: '2', c: '3' },
  );
});

test('parseLabelsString: handles whitespace', () => {
  assert.deepEqual(parseLabelsString('  a="1" , b="2"  '), { a: '1', b: '2' });
});

test('parseLabelsString: unescapes \\n, \\", \\\\ inside quoted values', () => {
  assert.deepEqual(parseLabelsString('a="line1\\nline2"'), { a: 'line1\nline2' });
  assert.deepEqual(parseLabelsString('a="say \\"hi\\""'), { a: 'say "hi"' });
  assert.deepEqual(parseLabelsString('a="back\\\\slash"'), { a: 'back\\slash' });
});

// ─────────────────────────────────────────────────────────────────────
//  summarizeMetricBlocks
// ─────────────────────────────────────────────────────────────────────
test('summarizeMetricBlocks: returns zeros for null', () => {
  const s = summarizeMetricBlocks(null);
  assert.deepEqual(s, { totalSeries: 0, totalSamples: 0, upValue: null, tickCount: null });
});

test('summarizeMetricBlocks: counts series + samples', () => {
  const blocks = [
    { name: 'tradebot_loop_running', type: 'gauge', help: '', samples: [{ labels: {}, value: '1' }] },
    { name: 'tradebot_loop_tick_count_total', type: 'counter', help: '', samples: [{ labels: { probe_status: 'ok' }, value: '42' }] },
    { name: 'tradebot_loop_entry_attempt_count_total', type: 'counter', help: '', samples: [{ labels: {}, value: '5' }] },
  ];
  const s = summarizeMetricBlocks(blocks);
  assert.equal(s.totalSeries, 3);
  assert.equal(s.totalSamples, 3);
});

test('summarizeMetricBlocks: extracts tradebot_up', () => {
  const blocks = [
    { name: 'tradebot_up', type: 'gauge', help: '', samples: [{ labels: {}, value: '1' }] },
  ];
  const s = summarizeMetricBlocks(blocks);
  assert.equal(s.upValue, 1);
});

test('summarizeMetricBlocks: extracts tick count', () => {
  const blocks = [
    { name: 'tradebot_loop_tick_count_total', type: 'counter', help: '', samples: [
      { labels: { probe_status: 'ok' }, value: '42' },
      { labels: { probe_status: 'degraded' }, value: '3' },
    ] },
  ];
  const s = summarizeMetricBlocks(blocks);
  assert.equal(s.tickCount, 45);
});

test('summarizeMetricBlocks: tolerates missing up + tick', () => {
  const s = summarizeMetricBlocks([
    { name: 'tradebot_loop_running', type: 'gauge', help: '', samples: [{ labels: {}, value: '1' }] },
  ]);
  assert.equal(s.upValue, null);
  assert.equal(s.tickCount, null);
});

// ─────────────────────────────────────────────────────────────────────
//  groupByPrefix
// ─────────────────────────────────────────────────────────────────────
test('groupByPrefix: returns empty array for null', () => {
  assert.deepEqual(groupByPrefix(null), []);
});

test('groupByPrefix: groups by namespace_topic', () => {
  const blocks = [
    { name: 'tradebot_loop_running', samples: [] },
    { name: 'tradebot_loop_tick_count_total', samples: [] },
    { name: 'tradebot_token_entry_count_total', samples: [] },
    { name: 'tradebot_token_realized_pnl_sats_total', samples: [] },
  ];
  const groups = groupByPrefix(blocks);
  assert.equal(groups.length, 2);
  // Sorted alphabetically by prefix.
  assert.equal(groups[0].prefix, 'tradebot_loop');
  assert.equal(groups[0].seriesCount, 2);
  assert.equal(groups[1].prefix, 'tradebot_token');
  assert.equal(groups[1].seriesCount, 2);
});

test('groupByPrefix: strips measurement suffixes', () => {
  // `tradebot_wallet_balance_bch` should land in `tradebot_wallet`
  // (since `bch` is a measurement suffix). `_running` should NOT
  // (it's a state, not a measurement suffix).
  const blocks = [
    { name: 'tradebot_wallet_balance_bch', samples: [] },
    { name: 'tradebot_wallet_utxo_count', samples: [] },
    { name: 'tradebot_loop_running', samples: [] },
  ];
  const groups = groupByPrefix(blocks);
  assert.equal(groups.length, 2);
  const wallet = groups.find((g) => g.prefix === 'tradebot_wallet');
  assert.ok(wallet);
  assert.equal(wallet.seriesCount, 2);
  const loop = groups.find((g) => g.prefix === 'tradebot_loop');
  assert.ok(loop);
  assert.equal(loop.seriesCount, 1);
});

// ─────────────────────────────────────────────────────────────────────
//  deriveMetricPrefix
// ─────────────────────────────────────────────────────────────────────
test('deriveMetricPrefix: strips _total', () => {
  assert.equal(deriveMetricPrefix('tradebot_token_entry_count_total'), 'tradebot_token');
});

test('deriveMetricPrefix: strips _ms', () => {
  // The leaf `ms` is stripped first, then we take the first
  // two segments — same convention as the rest of the
  // namespace. Names with more than 2 segments after stripping
  // collapse to their `<namespace>_<topic>` prefix.
  assert.equal(deriveMetricPrefix('tradebot_loop_tick_duration_last_ms'), 'tradebot_loop');
});

test('deriveMetricPrefix: keeps non-suffix leaf', () => {
  assert.equal(deriveMetricPrefix('tradebot_loop_running'), 'tradebot_loop');
});

test('deriveMetricPrefix: handles single-segment name', () => {
  assert.equal(deriveMetricPrefix('simple'), 'simple');
});

test('deriveMetricPrefix: handles non-string input', () => {
  assert.equal(deriveMetricPrefix(null), '');
  assert.equal(deriveMetricPrefix(undefined), '');
});

// ─────────────────────────────────────────────────────────────────────
//  isMetricsUnavailable
// ─────────────────────────────────────────────────────────────────────
test('isMetricsUnavailable: true for null / undefined / empty', () => {
  assert.equal(isMetricsUnavailable(null), true);
  assert.equal(isMetricsUnavailable(undefined), true);
  assert.equal(isMetricsUnavailable(''), true);
});

test('isMetricsUnavailable: true for non-parseable text', () => {
  // The parser is intentionally lenient (every line is parsed
  // defensively), so we use a string that contains ZERO lines
  // that look like `<word> <value>` to make sure it surfaces
  // as unavailable. Multiple space-separated words without a
  // newline break the parser.
  assert.equal(isMetricsUnavailable('# only a comment'), true);
  assert.equal(isMetricsUnavailable('just\nbroken\ngarbage\nlines\nwithout\nvalues'), true);
});

test('isMetricsUnavailable: false for parseable body', () => {
  const text = '# TYPE tradebot_up gauge\ntradebot_up 1';
  assert.equal(isMetricsUnavailable(text), false);
});

// ─────────────────────────────────────────────────────────────────────
//  metricsErrorMessage
// ─────────────────────────────────────────────────────────────────────
test('metricsErrorMessage: returns err when present', () => {
  assert.equal(metricsErrorMessage('request failed', ''), 'request failed');
  assert.equal(metricsErrorMessage('request failed', null), 'request failed');
});

test('metricsErrorMessage: extracts # ERROR comment from body', () => {
  const text = '# HELP tradebot_up ...\n# TYPE tradebot_up gauge\ntradebot_up{probe_status="degraded"} 0\n# ERROR builder_failed: disk full';
  assert.equal(metricsErrorMessage(null, text), 'builder_failed: disk full');
});

test('metricsErrorMessage: returns null when no error info', () => {
  assert.equal(metricsErrorMessage(null, ''), null);
  assert.equal(metricsErrorMessage(null, 'tradebot_up 1'), null);
});

// ─────────────────────────────────────────────────────────────────────
//  metricsHelpText
// ─────────────────────────────────────────────────────────────────────
test('metricsHelpText: returns bot-down message when body is empty', () => {
  const msg = metricsHelpText(null);
  assert.match(msg, /bot is running/);
});

test('metricsHelpText: returns parse-error message when body is unparseable', () => {
  const msg = metricsHelpText('garbage text');
  assert.match(msg, /did not parse/);
});
// ─── Regression: MetricsViewerCard rendering ───────────────────────────
//
// 2026-09-20 fixup: the previous MetricsViewerCard rendered one row per
// `group.series[i]` and accessed `s.labels` (which doesn't exist on a
// metric block — only on its samples). `Object.keys(undefined)` threw
// "TypeError: can't convert undefined to object" the moment the card
// rendered. The fix restructured the JSX to render one row per sample
// and pull labels from the sample (not the block). These tests lock in
// the shape: every series row exposes sample-level labels, and a
// defensive `(s.labels ?? {})` is no longer needed because the JSX
// never touches it.

test('metrics-view regression: blocks never expose a top-level labels field (the JSX would crash)', () => {
  const sample = [
    '# HELP tradebot_loop_running Whether the trader loop is currently running (1=yes, 0=no)',
    '# TYPE tradebot_loop_running gauge',
    'tradebot_loop_running{probe_status="unconfigured"} 0',
  ].join('\n');
  const blocks = parsePrometheusText(sample);
  assert.equal(blocks.length, 1);
  assert.equal(typeof blocks[0].labels, 'undefined',
    'blocks must NOT carry a top-level labels field — sample-level only. ' +
    'If this assertion fires, the parsing layer changed shape; double-check MetricsViewerCard.jsx');
  // Confirm sample-level labels work the way the JSX expects.
  assert.equal(blocks[0].samples[0].labels.probe_status, 'unconfigured');
});

test('metrics-view regression: per-sample rows carry the labels the JSX needs (no block-level labels access)', () => {
  const sample = [
    '# HELP tradebot_loop_tick_count_total Total ticks',
    '# TYPE tradebot_loop_tick_count_total counter',
    'tradebot_loop_tick_count_total{probe_status="ok"} 100',
    'tradebot_loop_tick_count_total{probe_status="degraded"} 5',
  ].join('\n');
  const blocks = parsePrometheusText(sample);
  // Group by prefix (matches the MetricsViewerCard rendering path).
  const groups = groupByPrefix(blocks);
  const flatRows = groups.flatMap((g) => g.series.flatMap((s) => s.samples));
  assert.equal(flatRows.length, 2);
  // Each row's labels are an object — the JSX iterates Object.entries()
  // on this object. If labels were missing or null, Object.entries
  // would still throw. Confirm both rows are safe.
  for (const row of flatRows) {
    assert.equal(typeof row.labels, 'object');
    assert.notEqual(row.labels, null);
  }
  // Confirm Object.entries works on every row's labels without throwing.
  const summary = flatRows.map((row) =>
    Object.entries(row.labels).map(([k, v]) => `${k}=${v}`).join(' '));
  assert.deepEqual(summary, ['probe_status=ok', 'probe_status=degraded']);
});
